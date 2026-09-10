import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { ATTACHMENT_CUSTODY_SCHEMA_OBJECTS, attachmentTerminalProof } from "./attachment-custody";
import { applyEffectEvidenceProvenance, insertJoinedMutationEffectEvidence } from "./effect-evidence-provenance";
import { assertJoinedAttachmentTerminalGuard, installJoinedAttachmentTerminalGuard } from "./joined-attachment-terminal-guard";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const attemptId = `attempt_${"a".repeat(32)}`;
const sessionId = `sess_${"b".repeat(32)}`;
const profileId = `acct_${"c".repeat(32)}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const predecessor = (() => {
  const guard = ATTACHMENT_CUSTODY_SCHEMA_OBJECTS.find((entry) => entry.name === "attachment_terminal_projection_guard");
  if (guard === undefined) throw new Error("Missing frozen attachment guard");
  return guard.sql;
})();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const snapshot = (db: Database) => ({
  schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(),
  rows: db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => ({ name, rows: db.query(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all() })),
});

// Synthetic component tables expose exactly the columns consumed by the real
// frozen terminal guard, joined replacement and provenance reader/writer. This
// is not an archived database, installed StateStore migration or native effect.
function fixture(kind: "session.send" | "session.steer" = "session.send") {
  const db = new Database(":memory:", { strict: true }); databases.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE mutation_attempts(id TEXT PRIMARY KEY,idempotency_key TEXT,kind TEXT,authority_id TEXT,
      authority_generation INTEGER,request_digest TEXT,request_format TEXT,state TEXT,result_json TEXT,updated_at INTEGER,
      transcript_intent_json TEXT,attachment_cleanup_terminal_digest TEXT) STRICT;
    CREATE TABLE mutation_effect_evidence(attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),kind TEXT,
      evidence_json TEXT,evidence_digest TEXT,recorded_at INTEGER) STRICT;
    CREATE TABLE mutation_provider_authorities(attempt_id TEXT,role TEXT,provider_account_id TEXT,profile_id TEXT,
      provider TEXT,binding_generation INTEGER,process_generation INTEGER) STRICT;
    CREATE TABLE mutation_resolutions(attempt_id TEXT PRIMARY KEY,resolution_kind TEXT,evidence_json TEXT,receipt_json TEXT,created_at INTEGER) STRICT;
    CREATE TABLE queue_entries(id TEXT PRIMARY KEY,session_id TEXT) STRICT;
    CREATE TABLE queue_effect_evidence(queue_id TEXT PRIMARY KEY REFERENCES queue_entries(id),evidence_json TEXT,evidence_digest TEXT,recorded_at INTEGER) STRICT;
    CREATE TABLE session_send_owner_outcomes(attempt_id TEXT,ordinal INTEGER,original_key TEXT,outcome_json TEXT,outcome_digest TEXT) STRICT;
    CREATE TABLE session_send_owner_anchors(attempt_id TEXT,kind TEXT,original_key TEXT,digest TEXT) STRICT;
    CREATE TABLE session_send_owners(attempt_id TEXT,original_key TEXT,owner_digest TEXT) STRICT;
    CREATE TABLE session_send_execution_claims(attempt_id TEXT,original_key TEXT,claim_digest TEXT,claim_json TEXT) STRICT;`);
  const receipt = kind === "session.send" ? { turnId: "turn", sourceId: attemptId } : { steered: true, activeTurnId: "turn" };
  db.query("INSERT INTO mutation_attempts VALUES(?, 'key', ?, ?, 1, ?, NULL, 'applied', ?, 100, ?, NULL)")
    .run(attemptId, kind, sessionId, hash("request"), JSON.stringify(receipt), JSON.stringify({ actor: "human" }));
  db.query("INSERT INTO mutation_provider_authorities VALUES(?,'primary',?,?,'codex',1,1)").run(attemptId, profileId, profileId);
  db.exec(predecessor);
  const evidence = { kind, providerThreadId: "thread", baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
    clientMessageId: attemptId, messageDigest: hash("message"), ...(kind === "session.steer" ? { activeTurnId: "turn" } : {}) };
  const install = () => db.transaction(() => installJoinedAttachmentTerminalGuard(db, predecessor)).immediate();
  const project = () => db.query("UPDATE mutation_attempts SET attachment_cleanup_terminal_digest=? WHERE id=?").run(hash("terminal"), attemptId);
  const joined = (actor = "human") => db.transaction(() => {
    applyEffectEvidenceProvenance(db, "combined49_v1");
    insertJoinedMutationEffectEvidence(db, { attemptId, evidence: { ...evidence, messageActor: actor }, recordedAt: 100 });
  }).immediate();
  return { db, evidence, install, project, joined };
}
function corrupt(db: Database, table: string, operation: () => void): void {
  const guards = db.query<{ name: string; sql: string }, [string]>(
    "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name",
  ).all(table);
  db.transaction(() => {
    for (const guard of guards) db.exec(`DROP TRIGGER ${quote(guard.name)}`);
    operation();
    for (const guard of guards) db.exec(guard.sql);
  }).immediate();
  expect(db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table)).toEqual(guards);
}

describe("joined attachment terminal proof guard", () => {
  for (const kind of ["session.send", "session.steer"] as const) {
    test(`${kind} actor-bearing terminal proof requires the exact joined replacement`, () => {
      const f = fixture(kind); f.joined();
      const before = snapshot(f.db);
      expect(attachmentTerminalProof(f.db, attemptId)).toMatch(/^[a-f0-9]{64}$/u);
      expect(f.project).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
      expect(snapshot(f.db)).toEqual(before);
      f.install();
      expect(f.project).not.toThrow();
      const installed = snapshot(f.db); f.install();
      expect(snapshot(f.db)).toEqual(installed);
      expect(() => assertJoinedAttachmentTerminalGuard(f.db, predecessor)).not.toThrow();
    });
  }

  test("retains actor-free historical and effect-free cancellation alternatives", () => {
    // Literal frozen49 send key order, with no runtime or actor; this is a
    // synthetic historical-codec control, not an archived native observation.
    const historical = `{"kind":"session.send","providerThreadId":"thread","baseline":{"providerUpdatedAt":null,"status":"idle","activeTurnId":null},"clientMessageId":"${attemptId}","messageDigest":"${hash("message")}"}`;
    const g = fixture();
    g.db.query("INSERT INTO mutation_effect_evidence VALUES(?,'session.send',?,?,100)").run(attemptId, historical, hash(historical));
    g.db.transaction(() => applyEffectEvidenceProvenance(g.db, "combined49_v1")).immediate();
    expect(attachmentTerminalProof(g.db, attemptId)).toMatch(/^[a-f0-9]{64}$/u);
    g.install(); expect(g.project).not.toThrow();
    const cancelled = fixture();
    cancelled.db.query("UPDATE mutation_attempts SET state='cancelled',result_json=NULL WHERE id=?").run(attemptId);
    cancelled.db.transaction(() => applyEffectEvidenceProvenance(cancelled.db, "combined49_v1")).immediate();
    cancelled.install(); expect(cancelled.project).not.toThrow();
  });

  for (const variant of ["missing_anchor", "wrong_anchor", "raw_mismatch", "parent_mismatch", "wrong_actor", "wrong_shape", "opaque"] as const) {
    test(`${variant} cannot project terminality or alter any row`, () => {
      const f = fixture();
      if (variant === "opaque") {
        const json = JSON.stringify({ ...f.evidence, unexpected: true });
        f.db.query("INSERT INTO mutation_effect_evidence VALUES(?,'session.send',?,?,100)").run(attemptId, json, hash(json));
        f.db.transaction(() => applyEffectEvidenceProvenance(f.db, "combined49_v1")).immediate();
      } else f.joined(variant === "wrong_actor" ? "autorespond" : "human");
      f.install();
      if (variant === "missing_anchor" || variant === "wrong_anchor") {
        // Deliberately violate a retained anchor under restored exact guards;
        // foreign keys are restored before the runtime read or projection.
        f.db.exec("PRAGMA foreign_keys=OFF");
        corrupt(f.db, "mutation_effect_evidence_provenance_anchors", () => {
          f.db.exec(variant === "missing_anchor" ? "DELETE FROM mutation_effect_evidence_provenance_anchors"
            : `UPDATE mutation_effect_evidence_provenance_anchors SET provenance_digest='${"d".repeat(64)}'`);
        });
        f.db.exec("PRAGMA foreign_keys=ON");
      } else if (variant === "raw_mismatch" || variant === "wrong_shape") {
        corrupt(f.db, "mutation_effect_evidence", () => f.db.query("UPDATE mutation_effect_evidence SET evidence_json=?")
          .run(variant === "wrong_shape" ? "{}" : JSON.stringify({ ...f.evidence, messageActor: "autorespond" })));
      } else if (variant === "parent_mismatch") f.db.exec("UPDATE mutation_attempts SET authority_generation=2");
      const before = snapshot(f.db);
      expect(attachmentTerminalProof(f.db, attemptId)).toBeNull();
      expect(f.project).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
      expect(snapshot(f.db)).toEqual(before);
    });
  }

  test("requires an exact predecessor and enclosing transaction, and rolls installation back", () => {
    const f = fixture(); f.joined();
    const before = snapshot(f.db);
    expect(() => installJoinedAttachmentTerminalGuard(f.db, predecessor)).toThrow("ATTACHMENT_CUSTODY_TERMINAL_GUARD_INVALID");
    expect(() => f.db.transaction(() => {
      installJoinedAttachmentTerminalGuard(f.db, predecessor); throw new Error("late rollback");
    }).immediate()).toThrow("late rollback");
    expect(snapshot(f.db)).toEqual(before);
    f.db.exec("DROP TRIGGER attachment_terminal_projection_guard");
    f.db.exec(predecessor.replace("ATTACHMENT_CUSTODY_UNPROVED", "changed refusal"));
    const changed = snapshot(f.db);
    expect(f.install).toThrow("ATTACHMENT_CUSTODY_TERMINAL_GUARD_INVALID");
    expect(snapshot(f.db)).toEqual(changed);
  });

  test("refuses a temporary same-name guard without replacing either body", () => {
    const f = fixture();
    f.db.exec("CREATE TEMP TRIGGER attachment_terminal_projection_guard BEFORE UPDATE ON main.mutation_attempts BEGIN SELECT 1; END");
    const before = snapshot(f.db);
    const temporary = f.db.query("SELECT * FROM sqlite_temp_master").all();
    expect(f.install).toThrow("ATTACHMENT_CUSTODY_TERMINAL_GUARD_INVALID");
    expect(snapshot(f.db)).toEqual(before);
    expect(f.db.query("SELECT * FROM sqlite_temp_master").all()).toEqual(temporary);
  });

  test("refuses oversized stored trigger SQL through the bounded schema projection", () => {
    const f = fixture();
    f.db.exec("DROP TRIGGER attachment_terminal_projection_guard");
    f.db.exec(`CREATE TRIGGER attachment_terminal_projection_guard BEFORE UPDATE ON mutation_attempts
      BEGIN SELECT '${"x".repeat(131_072)}'; END`);
    expect(f.db.query("SELECT length(CAST(sql AS BLOB))>131072 AS oversized FROM sqlite_master WHERE name='attachment_terminal_projection_guard'").get())
      .toEqual({ oversized: 1 });
    const before = snapshot(f.db);
    expect(f.install).toThrow("ATTACHMENT_CUSTODY_TERMINAL_GUARD_INVALID");
    expect(() => assertJoinedAttachmentTerminalGuard(f.db, predecessor)).toThrow("ATTACHMENT_CUSTODY_TERMINAL_GUARD_INVALID");
    expect(snapshot(f.db)).toEqual(before);
  });
});
