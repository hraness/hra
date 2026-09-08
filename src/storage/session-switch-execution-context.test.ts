import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";

import {
  applySessionSwitchExecutionContexts,
  assertSessionSwitchExecutionContextSchema,
  auditSessionSwitchExecutionContexts,
  insertSessionSwitchExecutionContext,
  readSessionSwitchExecutionContext,
  SESSION_SWITCH_EXECUTION_CONTEXT_DDL,
  SESSION_SWITCH_EXECUTION_CONTEXT_GUARDS,
  type SessionSwitchExecutionContext,
} from "./session-switch-execution-context";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const error = "SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT";
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const caps = () => ({ preambleVersion: 1, preambleDigest: "a".repeat(64), manifestVersion: 1, manifestDigest: "b".repeat(64) });
const profileId = `acct_${"c".repeat(32)}`;
function sample(format: 1 | 2 = 2, provider: "codex" | "claude" | "devin" = "codex", index = 1) {
  const raw = format === 1 ? { session: "session-one", provider, account: null, preset: null }
    : { version: 2, session: "session-one", provider, account: null, preset: null, presetContract: null };
  const rawJson = JSON.stringify(raw);
  const authority = { profileId, bindingGeneration: 4, processGeneration: 5, provider,
    providerAccountId: `${provider === "codex" ? "acct" : provider === "claude" ? "pact" : "dact"}_${"c".repeat(32)}` };
  const common = { attemptId: `attempt_${index.toString(16).padStart(32, "0")}`,
    requestDigest: digest(rawJson), planDigest: "d".repeat(64), targetAuthority: authority, createdAt: 100 };
  const context: SessionSwitchExecutionContext = format === 1
    ? { attemptId: common.attemptId, requestFormat: 1, requestDigest: common.requestDigest,
      planDigest: common.planDigest, targetAuthority: authority, createdAt: 100,
      rendererVersion: 1, targetPresetContract: 2, targetHostCapabilities: null }
    : { attemptId: common.attemptId, requestFormat: 2, requestDigest: common.requestDigest,
      planDigest: common.planDigest, targetAuthority: authority, createdAt: 100,
      rendererVersion: 2, targetPresetContract: 2, targetHostCapabilities: caps() };
  return { context, rawJson };
}

// This is the exact set of parent columns queried by the sidecar, not a claim
// that the small synthetic fixture is an authentic StateStore migration.
function fixture(path = ":memory:"): Database {
  const database = new Database(path, { strict: true });
  databases.push(database);
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE session_switch_attempts (
      journal_sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL, raw_request_json TEXT NOT NULL,
      target_provider_account_id TEXT NOT NULL, target_profile_id TEXT NOT NULL, target_provider TEXT NOT NULL,
      target_binding_generation INTEGER NOT NULL, target_process_generation INTEGER NOT NULL,
      renderer_version INTEGER NOT NULL, created_at INTEGER NOT NULL, phase TEXT NOT NULL,
      target_preset_contract INTEGER NOT NULL CHECK(target_preset_contract=2)
    ) STRICT;
    CREATE TABLE session_switch_plan_anchors (
      attempt_id TEXT PRIMARY KEY REFERENCES session_switch_attempts(attempt_id),
      plan_digest TEXT NOT NULL, recorded_at INTEGER NOT NULL
    ) STRICT;`);
  return database;
}
function parent(database: Database, value = sample()): void {
  const c = value.context;
  database.query("INSERT INTO session_switch_attempts VALUES(NULL,?,?,?,?,?,?,?,?,?,?,'prepared',2)").run(
    c.attemptId, c.requestDigest, value.rawJson, c.targetAuthority.providerAccountId,
    c.targetAuthority.profileId, c.targetAuthority.provider, c.targetAuthority.bindingGeneration,
    c.targetAuthority.processGeneration, c.rendererVersion, c.createdAt,
  );
}
function plan(database: Database, value = sample()): void {
  database.query("INSERT INTO session_switch_plan_anchors VALUES(?,?,?)").run(
    value.context.attemptId, value.context.planDigest, value.context.createdAt,
  );
}
function install(database: Database): void {
  database.transaction(() => { applySessionSwitchExecutionContexts(database); }).immediate();
}
function prepare(database: Database, value = sample()): void {
  database.transaction(() => {
    insertSessionSwitchExecutionContext(database, value.context);
    parent(database, value);
    plan(database, value);
  }).immediate();
}
function audit(database: Database): void {
  database.transaction(() => { auditSessionSwitchExecutionContexts(database); }).deferred();
}
function snapshot(database: Database) {
  const tables = database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return {
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(),
    rows: tables.map(({ name }) => ({ name, rows: database.query(`SELECT * FROM ${name} ORDER BY rowid`).all() })),
    changes: database.query("SELECT total_changes() AS changes").get(),
  };
}
function corrupt(database: Database, operation: () => void): void {
  database.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
  const guards = database.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as { name: string; sql: string }[];
  database.transaction(() => {
    for (const guard of guards) database.exec(`DROP TRIGGER ${guard.name}`);
    operation();
    for (const guard of guards) database.exec(guard.sql);
  }).immediate();
  database.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
  assertSessionSwitchExecutionContextSchema(database);
}

describe("dedicated switch execution context", () => {
  test("seals the resolved current preset contract independently of the frozen journal shadow", () => {
    for (const contract of [1, 2] as const) {
      for (const explicit of [false, true]) {
        const database = fixture(); install(database);
        const value = sample();
        const rawJson = JSON.stringify({ ...JSON.parse(value.rawJson), presetContract: explicit ? contract : null });
        const context = { ...value.context, requestFormat: 2 as const, rendererVersion: 2 as const,
          targetHostCapabilities: caps(), targetPresetContract: contract, requestDigest: digest(rawJson) };
        prepare(database, { context, rawJson });
        expect(readSessionSwitchExecutionContext(database, context.attemptId)).toEqual(context);
        expect(database.query("SELECT target_preset_contract FROM session_switch_attempts").get())
          .toEqual({ target_preset_contract: 2 });
        expect(database.query("SELECT target_preset_contract FROM session_switch_execution_contexts").get())
          .toEqual({ target_preset_contract: contract });
        const before = snapshot(database);
        audit(database);
        expect(snapshot(database)).toEqual(before);
      }
    }
  });

  test("refuses an explicit request contract that disagrees with its immutable context before admission", () => {
    for (const contract of [1, 2] as const) {
      const database = fixture(); install(database);
      const value = sample();
      const rawJson = JSON.stringify({ ...JSON.parse(value.rawJson), presetContract: contract === 1 ? 2 : 1 });
      const context = { ...value.context, requestFormat: 2 as const, rendererVersion: 2 as const,
        targetHostCapabilities: caps(), targetPresetContract: contract, requestDigest: digest(rawJson) };
      const before = snapshot(database);
      expect(() => prepare(database, { context, rawJson })).toThrow(error);
      // total_changes also counts rolled-back inserts; the durable tree must not change.
      expect({ ...snapshot(database), changes: null }).toEqual({ ...before, changes: null });
    }
  });

  test("binds complete current provider tuples, canonical caps and a distinct immutable plan preimage", () => {
    for (const provider of ["codex", "claude"] as const) {
      const database = fixture();
      install(database);
      const value = sample(2, provider);
      prepare(database, value);
      const before = snapshot(database);
      const output = readSessionSwitchExecutionContext(database, value.context.attemptId);
      expect(output).toEqual(value.context);
      expect(Object.isFrozen(output)).toBe(true);
      expect(Object.isFrozen(output.targetAuthority)).toBe(true);
      expect(Object.isFrozen(output.targetHostCapabilities)).toBe(true);
      expect(output).not.toBe(value.context);
      expect(output.targetAuthority).not.toBe(value.context.targetAuthority);
      expect(database.query("SELECT context_digest FROM session_switch_execution_contexts").get()).toEqual({
        context_digest: digest(JSON.stringify({ domain: "hra:session-switch-execution-context:v2", ...value.context })),
      });
      audit(database);
      expect(snapshot(database)).toEqual(before);
    }
  });

  test("explicit migration retains historical renderer1/null caps including retired provider decode only", () => {
    const database = fixture();
    const values = [sample(1, "codex", 1), sample(1, "claude", 2), sample(1, "devin", 3)];
    for (const value of values) { parent(database, value); plan(database, value); }
    const historical = database.query("SELECT * FROM session_switch_attempts ORDER BY attempt_id").all();
    install(database);
    expect(database.query("SELECT * FROM session_switch_attempts ORDER BY attempt_id").all()).toEqual(historical);
    for (const value of values) expect(readSessionSwitchExecutionContext(database, value.context.attemptId)).toEqual(value.context);
    audit(database);
    const before = snapshot(database);
    expect(() => install(database)).toThrow(error);
    expect(snapshot(database)).toEqual(before);
    expect(() => database.transaction(() => { insertSessionSwitchExecutionContext(database, sample(1).context); }).immediate()).toThrow(error);
    expect(() => prepare(database, sample(2, "devin", 4))).toThrow(error);
  });

  test("does not probe formats or admit renderer/capability defaults during migration", () => {
    for (const value of [sample(2), { ...sample(1), context: { ...sample(1).context, rendererVersion: 2 } },
      { ...sample(1), rawJson: JSON.stringify({ ...JSON.parse(sample(1).rawJson), version: 1 }) },
      { ...sample(1), rawJson: ` ${sample(1).rawJson}` }]) {
      const database = fixture();
      parent(database, value as ReturnType<typeof sample>); plan(database, value as ReturnType<typeof sample>);
      const before = snapshot(database);
      expect(() => install(database)).toThrow();
      expect(snapshot(database)).toEqual(before);
    }
  });

  test("requires parent and both anchors in one transaction and rejects insert-after-parent", () => {
    const database = fixture(); install(database);
    const value = sample();
    expect(() => insertSessionSwitchExecutionContext(database, value.context)).toThrow(error);
    expect(() => parent(database, value)).toThrow(error);
    expect(() => database.transaction(() => { insertSessionSwitchExecutionContext(database, value.context); }).immediate()).toThrow();
    expect(database.query("SELECT * FROM session_switch_execution_contexts").all()).toHaveLength(0);
    expect(() => database.transaction(() => {
      insertSessionSwitchExecutionContext(database, value.context); parent(database, value);
    }).immediate()).toThrow("FOREIGN KEY constraint failed");
    expect(database.query("SELECT * FROM session_switch_attempts").all()).toHaveLength(0);
    prepare(database, value);
    expect(() => database.transaction(() => { insertSessionSwitchExecutionContext(database, value.context); }).immediate()).toThrow(error);
  });

  test("SQL fences parent tuple, renderer, raw shape and exact plan before effects", () => {
    const mutations: ((value: ReturnType<typeof sample>) => ReturnType<typeof sample>)[] = [
      (v) => ({ ...v, context: { ...v.context, requestDigest: "e".repeat(64) } }),
      (v) => ({ ...v, context: { ...v.context, targetAuthority: { ...v.context.targetAuthority, processGeneration: 6 } } }),
      (v) => ({ ...v, context: { ...v.context, targetAuthority: { ...v.context.targetAuthority, bindingGeneration: 6 } } }),
      (v) => ({ ...v, context: { ...v.context, createdAt: 101 } }),
      (v) => ({ ...v, rawJson: JSON.stringify({ ...JSON.parse(v.rawJson), extra: true }) }),
      (v) => ({ ...v, rawJson: JSON.stringify({ ...JSON.parse(v.rawJson), session: 1 }) }),
      (v) => ({ ...v, rawJson: JSON.stringify({ ...JSON.parse(v.rawJson), provider: "claude" }) }),
      (v) => ({ ...v, rawJson: JSON.stringify({ ...JSON.parse(v.rawJson), presetContract: 3 }) }),
    ];
    for (const mutate of mutations) {
      const database = fixture(); install(database);
      expect(() => database.transaction(() => {
        insertSessionSwitchExecutionContext(database, sample().context);
        parent(database, mutate(sample()));
      }).immediate()).toThrow(error);
      expect(database.query("SELECT * FROM session_switch_attempts").all()).toHaveLength(0);
    }
    const database = fixture(); install(database);
    expect(() => database.transaction(() => {
      insertSessionSwitchExecutionContext(database, sample().context); parent(database);
      plan(database, { ...sample(), context: { ...sample().context, planDigest: "e".repeat(64) } });
    }).immediate()).toThrow(error);
    prepare(database);
    database.query("UPDATE session_switch_attempts SET phase='target_starting'").run();
    expect(() => database.query("UPDATE session_switch_attempts SET phase='target_started',target_process_generation=6").run()).toThrow(error);
  });

  test("SQL rejects closed capability and downgrade attempts even outside the typed writer", () => {
    for (const bad of [null, {}, { ...caps(), extra: true }, { ...caps(), manifestVersion: 0 },
      { ...caps(), preambleVersion: 1.5 }, { ...caps(), manifestDigest: "A".repeat(64) }]) {
      const database = fixture(); install(database);
      expect(() => database.transaction(() => {
        database.query("INSERT INTO session_switch_execution_contexts VALUES(?,2,?,?,?,?,?,?,?,2,2,?,100,?)").run(
          sample().context.attemptId, sample().context.requestDigest, "d".repeat(64), profileId, profileId,
          "codex", 4, 5, bad === null ? null : JSON.stringify(bad), "e".repeat(64),
        );
      }).immediate()).toThrow();
    }
    const database = fixture(); install(database); prepare(database);
    for (const table of ["session_switch_execution_contexts", "session_switch_execution_context_anchors"]) {
      expect(() => database.exec(`UPDATE ${table} SET context_digest='${"f".repeat(64)}'`)).toThrow(error);
      expect(() => database.exec(`DELETE FROM ${table}`)).toThrow(error);
    }
    expect(() => database.exec("UPDATE session_switch_execution_contexts SET request_format=1,renderer_version=1,target_host_capabilities_json=NULL")).toThrow(error);
  });

  test("reads and audits reject missing, conflicting, oversized and recanonicalized evidence without writes", () => {
    for (const sql of [
      "DELETE FROM session_switch_execution_contexts",
      "DELETE FROM session_switch_execution_context_anchors",
      "DELETE FROM session_switch_plan_anchors",
      "UPDATE session_switch_execution_context_anchors SET context_digest='" + "e".repeat(64) + "'",
      "UPDATE session_switch_execution_contexts SET target_binding_generation=9",
      "UPDATE session_switch_execution_contexts SET target_process_generation=9",
      "UPDATE session_switch_execution_contexts SET target_preset_contract=1",
      "UPDATE session_switch_execution_contexts SET plan_digest='" + "e".repeat(64) + "'",
      "UPDATE session_switch_execution_contexts SET created_at=101",
      "UPDATE session_switch_execution_contexts SET target_host_capabilities_json='{}'",
      "UPDATE session_switch_execution_contexts SET target_host_capabilities_json=printf('%01000d',1)",
      "UPDATE session_switch_attempts SET raw_request_json=' '||raw_request_json",
      "UPDATE session_switch_attempts SET raw_request_json=printf('%03000d',1)",
      "UPDATE session_switch_attempts SET renderer_version=1",
      "UPDATE session_switch_plan_anchors SET recorded_at=101",
    ]) {
      const database = fixture(); install(database); prepare(database);
      corrupt(database, () => database.exec(sql));
      const before = snapshot(database);
      expect(() => readSessionSwitchExecutionContext(database, sample().context.attemptId)).toThrow(error);
      expect(() => audit(database)).toThrow(error);
      expect(snapshot(database)).toEqual(before);
    }
  });

  test("audits exact schema and both inverse directions, not only joined survivors", () => {
    for (const scenario of ["extra", "missing", "orphan"] as const) {
      const database = fixture(); install(database); prepare(database);
      if (scenario === "extra") database.exec("CREATE TRIGGER extra_execution_trigger BEFORE INSERT ON session_switch_execution_contexts BEGIN SELECT 1; END");
      if (scenario === "missing") database.exec("DROP TRIGGER session_switch_execution_contexts_update");
      if (scenario === "orphan") corrupt(database, () => database.exec("DELETE FROM session_switch_attempts"));
      const before = snapshot(database);
      expect(() => audit(database)).toThrow(error);
      expect(snapshot(database)).toEqual(before);
    }
  });

  test("exclusions require exact caller admission and remain non-dispatchable opaque history", () => {
    const database = fixture();
    const value = sample(1); parent(database, value); plan(database, value);
    database.query("UPDATE session_switch_attempts SET raw_request_json='malformed'").run();
    const sequences: number[] = [];
    const options = { excludedMalformedJournalSequences: new Set([1]), onExcludedJournalSequence: (sequence: number) => { sequences.push(sequence); } };
    database.transaction(() => { applySessionSwitchExecutionContexts(database, options); }).immediate();
    expect(sequences).toEqual([1]);
    expect(() => audit(database)).toThrow(error);
    expect(() => readSessionSwitchExecutionContext(database, value.context.attemptId)).toThrow(error);
    expect(() => database.query("UPDATE session_switch_attempts SET phase='target_starting'").run()).toThrow();
    const before = snapshot(database);
    database.transaction(() => { auditSessionSwitchExecutionContexts(database, options); }).deferred();
    expect(snapshot(database)).toEqual(before);
    expect(sequences).toEqual([1, 1]);
    expect(() => database.transaction(() => auditSessionSwitchExecutionContexts(database, {
      excludedMalformedJournalSequences: new Set([2]),
    })).deferred()).toThrow(error);
  });

  test("proved journal sequences quarantine malformed identifiers without parsing or rewriting them", () => {
    for (const malformedId of ["", "broken-attempt", "x".repeat(40), "\0".repeat(40), "oversized".repeat(4096)]) {
      const database = fixture();
      const bad = sample(1); parent(database, bad);
      database.query("UPDATE session_switch_attempts SET attempt_id=?,raw_request_json='malformed' WHERE journal_sequence=1")
        .run(malformedId);
      const good = sample(1, "claude", 2); parent(database, good); plan(database, good);
      const retained = database.query("SELECT * FROM session_switch_attempts ORDER BY journal_sequence").all();
      const before = snapshot(database);
      expect(() => install(database)).toThrow(error);
      expect(snapshot(database)).toEqual(before);
      const sequences: number[] = [];
      const options = { excludedMalformedJournalSequences: new Set([1]),
        onExcludedJournalSequence: (sequence: number) => { sequences.push(sequence); } };
      database.transaction(() => applySessionSwitchExecutionContexts(database, options)).immediate();
      expect(sequences).toEqual([1]);
      expect(database.query("SELECT * FROM session_switch_attempts ORDER BY journal_sequence").all()).toEqual(retained);
      expect(readSessionSwitchExecutionContext(database, good.context.attemptId)).toEqual(good.context);
      const admitted = snapshot(database);
      database.transaction(() => auditSessionSwitchExecutionContexts(database, options)).deferred();
      expect(snapshot(database)).toEqual(admitted);
      expect(sequences).toEqual([1, 1]);
      expect(() => audit(database)).toThrow(error);
      expect(() => readSessionSwitchExecutionContext(database, malformedId)).toThrow(error);
      expect(database.query("SELECT COUNT(*) AS count FROM session_switch_execution_contexts").get()).toEqual({ count: 1 });
    }
  });

  test("a proved excluded sequence cannot conceal either partial or complete execution context", () => {
    for (const retained of ["both", "context", "anchor"] as const) {
      const database = fixture(); install(database); prepare(database);
      if (retained !== "both") corrupt(database, () => {
        database.exec(retained === "context"
          ? "DELETE FROM session_switch_execution_context_anchors"
          : "DELETE FROM session_switch_execution_contexts");
      });
      let notifications = 0;
      const before = snapshot(database);
      expect(() => database.transaction(() => auditSessionSwitchExecutionContexts(database, {
        excludedMalformedJournalSequences: new Set([1]), onExcludedJournalSequence: () => { notifications += 1; },
      })).deferred()).toThrow(error);
      expect(notifications).toBe(0);
      expect(snapshot(database)).toEqual(before);
    }
  });

  test("sequence exclusions require safe positive exact coverage", () => {
    const database = fixture(); install(database);
    for (const sequence of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1]) {
      const before = snapshot(database);
      expect(() => database.transaction(() => auditSessionSwitchExecutionContexts(database, {
        excludedMalformedJournalSequences: new Set([sequence]),
      })).deferred()).toThrow(error);
      expect(snapshot(database)).toEqual(before);
    }
  });

  test("seeded safe journal locators never turn malformed IDs into dispatchable context", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), (sequence) => {
      const database = fixture(); parent(database, sample(1));
      database.query("UPDATE session_switch_attempts SET journal_sequence=?,attempt_id=?,raw_request_json='malformed'")
        .run(sequence, `malformed-${sequence}`);
      const options = { excludedMalformedJournalSequences: new Set([sequence]) };
      database.transaction(() => applySessionSwitchExecutionContexts(database, options)).immediate();
      const before = snapshot(database);
      database.transaction(() => auditSessionSwitchExecutionContexts(database, options)).deferred();
      expect(snapshot(database)).toEqual(before);
      expect(() => readSessionSwitchExecutionContext(database, `malformed-${sequence}`)).toThrow(error);
      expect(database.query("SELECT COUNT(*) AS count FROM session_switch_execution_contexts").get()).toEqual({ count: 0 });
    }), { seed: 46_002, numRuns: 50 });
  });

  test("keyset audits cover more than one page without changing historical rows", () => {
    const database = fixture();
    for (let index = 201; index >= 1; index--) { const value = sample(1, "codex", index); parent(database, value); plan(database, value); }
    install(database);
    const before = snapshot(database);
    audit(database);
    expect(database.query("SELECT COUNT(*) AS count FROM session_switch_execution_contexts").get()).toEqual({ count: 201 });
    expect(snapshot(database)).toEqual(before);
    corrupt(database, () => database.query("DELETE FROM session_switch_execution_context_anchors WHERE attempt_id=?").run(sample(1, "codex", 101).context.attemptId));
    expect(() => audit(database)).toThrow(error);
  });

  test("read-only reopen preserves all schema, rows and change counters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hra-switch-context-")); directories.push(directory);
    const path = join(directory, "state.sqlite");
    const database = fixture(path); install(database); prepare(database);
    const readonly = new Database(path, { readonly: true, strict: true }); databases.push(readonly);
    const before = snapshot(readonly);
    audit(readonly);
    expect(readSessionSwitchExecutionContext(readonly, sample().context.attemptId)).toEqual(sample().context);
    expect(snapshot(readonly)).toEqual(before);
    expect(SESSION_SWITCH_EXECUTION_CONTEXT_DDL).toContain(") STRICT;");
    expect(SESSION_SWITCH_EXECUTION_CONTEXT_GUARDS).not.toContain("DROP ");
  });

  test("retains exact safe-integer boundaries without applying current clock or capability defaults", () => {
    const database = fixture(); install(database);
    const value = sample(2, "claude");
    if (value.context.requestFormat !== 2) throw new Error("Expected current context fixture");
    const context = { ...value.context, targetAuthority: { ...value.context.targetAuthority,
      processGeneration: Number.MAX_SAFE_INTEGER, bindingGeneration: Number.MAX_SAFE_INTEGER },
    createdAt: Number.MAX_SAFE_INTEGER, targetHostCapabilities: { ...caps(),
      preambleVersion: Number.MAX_SAFE_INTEGER, manifestVersion: Number.MAX_SAFE_INTEGER } };
    prepare(database, { ...value, context });
    expect(readSessionSwitchExecutionContext(database, context.attemptId)).toEqual(context);
    audit(database);
    for (const candidate of [
      { ...context, createdAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...context, targetAuthority: { ...context.targetAuthority, bindingGeneration: 0 } },
      { ...context, targetHostCapabilities: { ...context.targetHostCapabilities, manifestVersion: Number.MAX_SAFE_INTEGER + 1 } },
    ]) expect(() => database.transaction(() => { insertSessionSwitchExecutionContext(database, candidate); }).immediate()).toThrow(error);
  });

  test("foreign context graphs refuse before getter execution or partial writes", () => {
    const database = fixture(); install(database);
    let getters = 0;
    const getter = { ...sample().context };
    Object.defineProperty(getter, "requestFormat", { enumerable: true, get() { getters++; return 2; } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const alias = { ...sample().context, extra: sample().context.targetAuthority };
    const proxy = new Proxy({}, { ownKeys() { throw new Error("private trap"); } });
    const before = snapshot(database);
    for (const bad of [getter, cycle, alias, proxy, undefined, NaN, 1n,
      { ...sample().context, extra: undefined }, { ...sample().context, rendererVersion: 1 },
      { ...sample().context, targetHostCapabilities: null }]) {
      expect(() => database.transaction(() => { insertSessionSwitchExecutionContext(database, bad); }).immediate()).toThrow(error);
    }
    expect(getters).toBe(0);
    expect(snapshot(database)).toEqual(before);
  });

  test("seeded valid tuples preserve canonical key order, detachment and immutable historical clocks", () => {
    const database = fixture(); install(database);
    const rollback = new Error("rollback fixture");
    fc.assert(fc.property(fc.record({
      provider: fc.constantFrom("codex" as const, "claude" as const),
      generation: fc.integer({ min: 0, max: 100000 }), binding: fc.integer({ min: 1, max: 100000 }),
      createdAt: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      version: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    }), ({ provider, generation, binding, createdAt, version }) => {
      const value = sample(2, provider);
      if (value.context.requestFormat !== 2) throw new Error("Expected current context fixture");
      const context = { ...value.context, targetAuthority: { ...value.context.targetAuthority,
        processGeneration: generation, bindingGeneration: binding }, createdAt,
      targetHostCapabilities: { ...caps(), preambleVersion: version } };
      const candidate = Object.fromEntries(Object.entries(context).reverse());
      expect(() => database.transaction(() => {
        insertSessionSwitchExecutionContext(database, candidate);
        parent(database, { ...value, context }); plan(database, { ...value, context });
        const parsed = readSessionSwitchExecutionContext(database, context.attemptId);
        expect(parsed).toEqual(context);
        expect(Object.keys(parsed)).toEqual(Object.keys(sample().context));
        expect(parsed).not.toBe(candidate);
        expect(parsed.targetAuthority).not.toBe(context.targetAuthority);
        expect(Object.isFrozen(candidate)).toBe(false);
        candidate.createdAt = -1;
        expect(parsed.createdAt).toBe(createdAt);
        auditSessionSwitchExecutionContexts(database);
        throw rollback;
      }).immediate()).toThrow(rollback);
    }), { seed: 680192, numRuns: 80 });
  });

  test("seeded unknown JSON is total without assuming every generated shape is invalid", () => {
    const database = fixture(); install(database);
    const rollback = new Error("rollback foreign fixture");
    fc.assert(fc.property(fc.jsonValue(), (input) => {
      let result: unknown;
      try {
        database.transaction(() => {
          try { insertSessionSwitchExecutionContext(database, input); result = "accepted"; }
          catch (cause) { result = cause; }
          throw rollback;
        }).immediate();
      } catch (cause) { expect(cause).toBe(rollback); }
      if (result !== "accepted") {
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toBe(error);
      }
    }), { seed: 471991, numRuns: 120 });
  });
});
