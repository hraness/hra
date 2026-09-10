import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import { applyJoinedQueueTranscriptGuard, assertJoinedQueueTranscriptGuard, joinedQueueTranscriptGuardSql } from "./joined-queue-transcript-guard";
import { normalizeSchemaSql } from "./schema-cohort";

const source = readFileSync(new URL("./state-store.ts", import.meta.url), "utf8");
const marker = "CREATE TRIGGER IF NOT EXISTS queue_transcript_finalization_guard";
const start = source.indexOf(marker), end = source.indexOf("END;", start);
if (start < 0 || end < 0) throw new Error("Frozen queue guard missing");
const predecessor = source.slice(start, end + 4);
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const failure = "JOINED_QUEUE_TRANSCRIPT_GUARD_INVALID";
const intent = (change: Record<string, unknown> = {}) => JSON.stringify({ version: 1,
  accountId: "profile", providerGeneration: 3, providerConnectionId: null,
  actor: "peer_session", text: "message", omittedCharacters: 0, ...change });
// Real frozen trigger, minimal strict projections of its independently guarded
// tables. The StateStore peer tests cover the complete joined schema/call path.
function fixture(initialIntent = intent()) {
  const db = new Database(":memory:", { strict: true }); databases.push(db);
  db.exec(`CREATE TABLE profiles(id TEXT PRIMARY KEY,process_generation INTEGER,state TEXT) STRICT;
    CREATE TABLE provider_accounts(id TEXT PRIMARY KEY,profile_id TEXT,provider TEXT,binding_generation INTEGER,process_generation INTEGER,readiness TEXT) STRICT;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,profile_id TEXT,provider_v39 TEXT) STRICT;
    CREATE TABLE session_provider_authorities(session_id TEXT PRIMARY KEY,provider_account_id TEXT,profile_id TEXT,provider TEXT,binding_generation INTEGER,process_generation INTEGER) STRICT;
    CREATE TABLE queue_provider_authorities(queue_id TEXT PRIMARY KEY,provider_account_id TEXT,profile_id TEXT,provider TEXT,binding_generation INTEGER,process_generation INTEGER) STRICT;
    CREATE TABLE queue_entries(id TEXT PRIMARY KEY,session_id TEXT,state TEXT,transcript_status TEXT,transcript_finalized INTEGER,transcript_intent_json TEXT) STRICT;
    INSERT INTO profiles VALUES('profile',1,'signed_in');
    INSERT INTO provider_accounts VALUES('claude-account','profile','claude',2,3,'unverified');
    INSERT INTO sessions VALUES('session','profile','claude');
    INSERT INTO session_provider_authorities VALUES('session','claude-account','profile','claude',2,3);
    INSERT INTO queue_provider_authorities VALUES('queue','claude-account','profile','claude',2,3);`);
  db.query("INSERT INTO queue_entries VALUES('queue','session','pending','pending',0,?)").run(initialIntent);
  db.exec(predecessor);
  const snapshot = () => ({ schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(),
    rows: ["profiles", "provider_accounts", "sessions", "session_provider_authorities", "queue_provider_authorities", "queue_entries"]
      .map((table) => db.query(`SELECT * FROM ${table}`).all()) });
  const install = () => db.transaction(() => applyJoinedQueueTranscriptGuard(db, predecessor)).immediate();
  const update = (json = intent({ providerConnectionId: "00000000-0000-4000-8000-000000000001" })) =>
    db.query("UPDATE queue_entries SET transcript_intent_json=? WHERE id='queue'").run(json);
  return { db, snapshot, install, update };
}

describe("joined queue transcript provider authority guard", () => {
  test("frozen generation mismatch is causal; joined connection capture keeps the full original Claude tuple", () => {
    const f = fixture(); const before = f.snapshot();
    expect(f.update).toThrow("queue transcript intent/status transition invalid");
    expect(f.snapshot()).toEqual(before);
    f.install(); expect(f.update().changes).toBe(1);
    const stored = f.db.query<{ json: string }, []>("SELECT transcript_intent_json AS json FROM queue_entries").get();
    if (stored === null) throw new Error("Missing queue intent");
    expect(JSON.parse(stored.json))
      .toEqual(JSON.parse(intent({ providerConnectionId: "00000000-0000-4000-8000-000000000001" })));
    const settled = f.snapshot(); f.install(); expect(f.snapshot()).toEqual(settled);
    expect(() => assertJoinedQueueTranscriptGuard(f.db, predecessor)).not.toThrow();
  });
  test.each([
    "DELETE FROM queue_provider_authorities",
    "UPDATE queue_provider_authorities SET binding_generation=1",
    "UPDATE queue_provider_authorities SET process_generation=1",
    "UPDATE queue_provider_authorities SET provider_account_id='other'",
    "UPDATE session_provider_authorities SET process_generation=4",
    "UPDATE session_provider_authorities SET binding_generation=3",
    "UPDATE provider_accounts SET process_generation=4",
    "UPDATE provider_accounts SET provider='codex'",
    "UPDATE sessions SET provider_v39='codex'",
    "UPDATE profiles SET state='removed'",
  ])("missing or changed captured/current tuple refuses atomically: %s", (sql) => {
    const f = fixture(); f.install(); f.db.exec(sql); const before = f.snapshot();
    expect(f.update).toThrow("queue transcript intent/status transition invalid");
    expect(f.snapshot()).toEqual(before);
  });
  test.each([{ accountId: "other" }, { providerGeneration: 1 }, { actor: "human" }, { text: "different" }])(
    "connection capture cannot replace original authority or content: %j", (change) => {
      const f = fixture(); f.install(); const before = f.snapshot();
      expect(() => f.update(intent(change))).toThrow("queue transcript intent/status transition invalid");
      expect(f.snapshot()).toEqual(before);
    });
  test.each([{ accountId: "other" }, { providerGeneration: 1 }])(
    "a wrong original intent tuple cannot be repaired into current authority: %j", (change) => {
      // Deliberately malformed retained projection; not a valid enqueue claim.
      const f = fixture(intent(change)); f.install(); const before = f.snapshot();
      expect(f.update).toThrow("queue transcript intent/status transition invalid");
      expect(f.snapshot()).toEqual(before);
    });
  test("original terminal clauses and all non-authority text are unchanged", () => {
    const after = joinedQueueTranscriptGuardSql(predecessor);
    const terminal = "  OR (OLD.transcript_status='pending' AND OLD.transcript_finalized=0\n    AND NEW.transcript_status='finalized'";
    expect(after.slice(after.indexOf(terminal))).toBe(predecessor.slice(predecessor.indexOf(terminal)));
    const f = fixture(); f.install();
    // Independent terminal settlement does not need live authority.
    f.db.exec("DELETE FROM queue_provider_authorities");
    expect(f.db.query("UPDATE queue_entries SET transcript_status='abandoned',transcript_intent_json=? WHERE id='queue'")
      .run(JSON.stringify({ version: 1, actor: "peer_session", hadAttachments: false })).changes).toBe(1);
  });
  test("installer refuses absent, changed, oversized and temporary guard collisions without writes", () => {
    for (const variant of ["missing", "changed", "oversized", "temporary"] as const) {
      const f = fixture();
      if (variant === "temporary") f.db.exec("CREATE TEMP TRIGGER queue_transcript_finalization_guard AFTER UPDATE ON main.queue_entries BEGIN SELECT 1; END;");
      else {
        f.db.exec("DROP TRIGGER queue_transcript_finalization_guard");
        if (variant !== "missing") f.db.exec(predecessor.replace("BEGIN SELECT RAISE", `${variant === "oversized" ? `/*${"x".repeat(131_073)}*/` : ""}BEGIN SELECT RAISE`)
          .replace("queue transcript intent/status transition invalid", "foreign guard"));
      }
      const before = f.snapshot(); expect(f.install).toThrow(failure); expect(f.snapshot()).toEqual(before);
    }
  });
  test("late installer rollback restores exact predecessor; no out-of-transaction replacement", () => {
    const f = fixture(); const before = f.snapshot();
    expect(() => applyJoinedQueueTranscriptGuard(f.db, predecessor)).toThrow(failure);
    expect(() => f.db.transaction(() => { applyJoinedQueueTranscriptGuard(f.db, predecessor); throw new Error("late failure"); }).immediate()).toThrow("late failure");
    expect(f.snapshot()).toEqual(before);
    expect(normalizeSchemaSql(predecessor)).not.toBe(normalizeSchemaSql(joinedQueueTranscriptGuardSql(predecessor)));
  });
});
