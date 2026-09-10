import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fc from "fast-check";

import { historicalEffectEvidenceFormatSchema, type HistoricalEffectEvidenceFormat } from "./effect-evidence-reader";
import { readHistoricalRuntimeProfileAuthorityRows } from "./historical-runtime-profile-authority";

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const profileId = `acct_${"a".repeat(32)}`;
const otherProfileId = `acct_${"b".repeat(32)}`;
const sessionId = `sess_${"c".repeat(32)}`;
const claude = (generation = 41, observedAt = 100) => ({
  profileId, processGeneration: generation, observedAt, preset: "fable-max", model: "claude-fable-5-1",
  reasoningEffort: "max", claudeVersion: "2.1.260", permissionMode: "default", configHome: "isolated",
  outputFormat: "stream-json", inputFormat: "stream-json",
});
const legacyClaude = () => {
  const profile = claude();
  const fields = Object.fromEntries(Object.entries(profile)
    .filter(([key]) => !["configHome", "outputFormat", "inputFormat"].includes(key)));
  return { ...fields, isolatedConfigDir: true, outputFormat: profile.outputFormat, inputFormat: profile.inputFormat };
};
const codex = () => ({ profileId, processGeneration: 41, observedAt: 100, preset: "high", model: "gpt-5.6-sol",
  reasoningEffort: "max", serviceTier: null, fast: false, approvalPolicy: "on-request", reviewMode: "auto_review",
  permissionProfile: ":workspace", computerUse: true, pluginCapability: true, enabledApps: [] });
const devin = () => ({ profileId, processGeneration: 41, observedAt: 100, preset: "astra", model: "gpt-6-astra",
  reasoningEffort: "provider-default", devinVersion: "3000.6.14", protocolVersion: 1, isolatedHome: true });

// Literal frozen schemaVersion6 at canonical 7ab347813f8d7e4f31e9584752c801dd1ca0cda0.
// Synthetic rows exercise real historical DDL, not a captured producer database
// or StateStore migration/provider acceptance. Parent tables contain queried fields.
const historicalRuntimeDdl = `
CREATE TABLE IF NOT EXISTS session_runtime_profiles (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('session_start','turn_start','queue_start')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  profile_json TEXT NOT NULL CHECK(length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 262144),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(session_id, revision),
  UNIQUE(source_kind, source_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS session_runtime_profile_authority_guard
BEFORE INSERT ON session_runtime_profiles
WHEN NOT EXISTS(
  SELECT 1 FROM sessions s
  WHERE s.id=NEW.session_id AND s.profile_id=NEW.profile_id
)
BEGIN SELECT RAISE(ABORT, 'runtime profile session authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS session_runtime_profiles_immutable_update
BEFORE UPDATE ON session_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'session runtime profile is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_runtime_profiles_immutable_delete
BEFORE DELETE ON session_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'session runtime profile is immutable'); END;
`;
function fixture(): Database {
  const database = new Database(":memory:", { strict: true }); databases.push(database);
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE profiles(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,profile_id TEXT) STRICT;`);
  database.query("INSERT INTO profiles VALUES(?),(?)").run(profileId, otherProfileId);
  database.query("INSERT INTO sessions VALUES(?,?)").run(sessionId, profileId);
  database.exec(historicalRuntimeDdl);
  return database;
}
function insert(database: Database, json: string | Uint8Array, options: {
  session?: string; revision?: number; generation?: number; observedAt?: number; recordedAt?: number;
} = {}): void {
  const revision = options.revision ?? 1;
  const session = options.session ?? sessionId;
  database.query(`INSERT INTO session_runtime_profiles VALUES(?,?,'session_start',?,?,?, ?,CAST(? AS TEXT),?)`)
    .run(session, revision, `${session}:${revision}`, profileId, options.generation ?? 41,
      options.observedAt ?? 100, typeof json === "string" ? new TextEncoder().encode(json) : json, options.recordedAt ?? 100);
}
function read(database: Database, format: HistoricalEffectEvidenceFormat = "canonical_sol43_v1") {
  return database.transaction(() => [...readHistoricalRuntimeProfileAuthorityRows(database, format)]).deferred();
}
function snapshot(database: Database): unknown {
  return { schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(),
    rows: database.query(`SELECT session_id,revision,source_kind,source_id,profile_id,process_generation,observed_at,
      hex(CAST(profile_json AS BLOB)) AS raw_hex,recorded_at FROM session_runtime_profiles ORDER BY session_id,revision`).all(),
    changes: database.query("SELECT total_changes() AS changes").get() };
}
function expectEqual(actual: unknown, expected: unknown): void { expect(actual).toEqual(expected); }

describe("selected historical raw runtime authority", () => {
  test.each(historicalEffectEvidenceFormatSchema.options)("uses only the selected %s runtime dialect", (format) => {
    const database = fixture();
    const fallback = { model: "claude-opus-5", reason: "live_acceptance_required", status: "unavailable" };
    const cases = [
      { profile: claude(), accepted: format !== "private_task48_v1" },
      { profile: { ...claude(), configHome: "personal" }, accepted: format !== "private_task48_v1" },
      { profile: legacyClaude(), accepted: true },
      { profile: { ...legacyClaude(), nativeFallback: fallback }, accepted: format === "private_task48_v1" || format === "combined49_v1" },
      { profile: { ...claude(), nativeFallback: fallback }, accepted: format === "combined49_v1" },
      { profile: { ...legacyClaude(), nativeFallback: { evidenceDigest: "a".repeat(64), model: "claude-opus-5", status: "armed" } },
        accepted: format === "private_task48_v1" || format === "combined49_v1" },
      { profile: codex(), accepted: true }, { profile: devin(), accepted: true },
    ];
    cases.forEach(({ profile }, index) => insert(database, JSON.stringify(profile), { revision: index + 1 }));
    const before = snapshot(database);
    const result = read(database, format);
    expect(result).toHaveLength(cases.length);
    cases.forEach(({ profile, accepted }, index) => {
      expectEqual(result[index], accepted
        ? { sessionId, revision: index + 1, kind: "parsed", profile, recordedAt: 100 }
        : { sessionId, revision: index + 1, kind: "opaque" });
    });
    expect(snapshot(database)).toEqual(before);
  });

  test("refuses normalization, duplicate-key and invalid UTF-8 authority while preserving every byte", () => {
    const database = fixture();
    const json = JSON.stringify(claude());
    const invalidUtf8 = Buffer.concat([Buffer.from('{"model":"'), Buffer.from([255]), Buffer.from('",'+json.slice(1))]);
    // A permissive TEXT read and last-key JSON parser both accept this value;
    // rejection therefore requires the original-byte authority boundary.
    expectEqual(JSON.parse(new TextDecoder().decode(invalidUtf8)) as unknown, claude());
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(invalidUtf8)).toThrow();
    const values = [
      JSON.stringify(Object.fromEntries(Object.entries(claude()).reverse())),
      JSON.stringify(claude(), null, 2), '{"processGeneration":1,'+json.slice(1), invalidUtf8,
      Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(json)]),
      JSON.stringify({ ...claude(), model: " claude-fable-5-1 " }),
      JSON.stringify({ ...claude(), profileId: otherProfileId }),
      JSON.stringify({ ...claude(), extra: "not admitted" }), "{}", "[]", "null",
    ];
    values.forEach((value, index) => insert(database, value, { revision: index + 1 }));
    const before = snapshot(database);
    expectEqual(read(database), values.map((_, index) => ({ sessionId, revision: index + 1, kind: "opaque" })));
    expect(snapshot(database)).toEqual(before);
  });

  test("all metadata must agree and be safe, without inventing observation/recording clock order", () => {
    const database = fixture();
    const json = JSON.stringify(claude());
    for (const [index, options] of [
      { generation: 42 }, { observedAt: 101 }, { generation: Number.MAX_SAFE_INTEGER + 1 },
      { observedAt: Number.MAX_SAFE_INTEGER + 1 }, { recordedAt: Number.MAX_SAFE_INTEGER + 1 },
    ].entries()) insert(database, json, { ...options, revision: index + 1 });
    const boundary = claude(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    insert(database, JSON.stringify(boundary), { revision: 6, generation: Number.MAX_SAFE_INTEGER,
      observedAt: Number.MAX_SAFE_INTEGER, recordedAt: 0 });
    const before = snapshot(database);
    expectEqual(read(database), [
      ...Array.from({ length: 5 }, (_, index) => ({ sessionId, revision: index + 1, kind: "opaque" })),
      { sessionId, revision: 6, kind: "parsed", profile: boundary, recordedAt: 0 },
    ]);
    expect(snapshot(database)).toEqual(before);
  });

  test("out-of-bound raw text remains opaque before JavaScript materialization without schema repair", () => {
    const database = fixture();
    // Deliberate isolated CHECK corruption: the installed historical guards and
    // schema are retained exactly. This is not a schema-admitted producer row.
    database.exec("PRAGMA ignore_check_constraints=ON");
    try { insert(database, " ".repeat(262145)); insert(database, "x", { revision: 2 }); }
    finally { database.exec("PRAGMA ignore_check_constraints=OFF"); }
    const before = snapshot(database);
    expect(database.query("SELECT length(CAST(profile_json AS BLOB)) AS size FROM session_runtime_profiles ORDER BY revision").all())
      .toEqual([{ size: 262145 }, { size: 1 }]);
    expectEqual(read(database), [{ sessionId, revision: 1, kind: "opaque" }, { sessionId, revision: 2, kind: "opaque" }]);
    expect(snapshot(database)).toEqual(before);
  });

  test("keyset pages retain all 201 rows in primary-key order without a lifetime cap or writes", () => {
    const database = fixture();
    const sessions = [0, 1, 2].map((index) => `sess_${index.toString().repeat(32)}`);
    for (const session of sessions) database.query("INSERT INTO sessions VALUES(?,?)").run(session, profileId);
    for (let index = 201; index >= 1; index--) insert(database, JSON.stringify(claude(index)), {
      session: `sess_${Math.floor((index - 1) / 67).toString().repeat(32)}`, revision: (index - 1) % 67 + 1, generation: index,
    });
    const before = snapshot(database);
    expect(read(database).map((row) => [row.sessionId, row.revision, row.kind])).toEqual(
      sessions.flatMap((session) => Array.from({ length: 67 }, (_, index) => [session, index + 1, "parsed"])),
    );
    expect(snapshot(database)).toEqual(before);
  });

  test("unaddressable unsafe locators and absent transaction refuse without partial row changes", () => {
    const database = fixture(); insert(database, JSON.stringify(claude()), { revision: Number.MAX_SAFE_INTEGER + 1 });
    const before = snapshot(database);
    expect(() => [...readHistoricalRuntimeProfileAuthorityRows(database, "canonical49_v1")])
      .toThrow("HISTORICAL_RUNTIME_PROFILE_AUTHORITY_CORRUPT");
    expect(() => read(database)).toThrow("HISTORICAL_RUNTIME_PROFILE_AUTHORITY_CORRUPT");
    expect(snapshot(database)).toEqual(before);
  });

  test("a suspended page cannot yield another row after its owning transaction ends", () => {
    const database = fixture();
    insert(database, JSON.stringify(claude())); insert(database, JSON.stringify(claude()), { revision: 2 });
    const iterator = readHistoricalRuntimeProfileAuthorityRows(database, "canonical49_v1");
    const before = snapshot(database);
    database.transaction(() => { expect(iterator.next().value).toMatchObject({ kind: "parsed", revision: 1 }); }).deferred();
    expect(() => iterator.next()).toThrow("HISTORICAL_RUNTIME_PROFILE_AUTHORITY_CORRUPT");
    expect(snapshot(database)).toEqual(before);
  });

  test("seeded coherent originals are admitted while single-fault raw witnesses remain opaque", () => {
    const database = fixture(); const rollback = new Error("rollback synthetic runtime fixture");
    fc.assert(fc.property(fc.record({
      generation: fc.integer({ min: 0, max: 100000 }), observedAt: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      recordedAt: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      fault: fc.constantFrom("generation", "observation", "profile", "order", "duplicate", "fallback"),
    }), ({ generation, observedAt, recordedAt, fault }) => {
      expect(() => database.transaction(() => {
        const profile = claude(generation, observedAt); const json = JSON.stringify(profile);
        insert(database, json, { generation, observedAt, recordedAt });
        const bad = fault === "profile" ? JSON.stringify({ ...profile, profileId: otherProfileId })
          : fault === "order" ? JSON.stringify(Object.fromEntries(Object.entries(profile).reverse()))
            : fault === "duplicate" ? '{"processGeneration":0,'+json.slice(1)
              : fault === "fallback" ? JSON.stringify({ ...profile,
                nativeFallback: { model: "claude-opus-5", reason: "live_acceptance_required", status: "unavailable" } }) : json;
        insert(database, bad, { revision: 2, generation: fault === "generation" ? generation + 1 : generation,
          observedAt: fault === "observation" ? observedAt === 0 ? 1 : 0 : observedAt, recordedAt });
        const before = snapshot(database);
        expectEqual([...readHistoricalRuntimeProfileAuthorityRows(database, "canonical_sol43_v1")], [
          { sessionId, revision: 1, kind: "parsed", profile, recordedAt }, { sessionId, revision: 2, kind: "opaque" },
        ]);
        expect(snapshot(database)).toEqual(before);
        throw rollback;
      }).immediate()).toThrow(rollback);
    }), { seed: 51_060, numRuns: 100 });
  });
});
