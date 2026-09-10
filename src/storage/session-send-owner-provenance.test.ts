import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import fc from "fast-check";
import { z } from "zod";

import { fingerprintSessionSendRequest } from "../domain/session-send-request";
import {
  applyEffectEvidenceProvenance, auditEffectEvidenceProvenance, readMutationEffectEvidenceProvenance,
} from "./effect-evidence-provenance";
import {
  appendSessionSendOutcome, applySessionSendOwnerSchema, assertLegacyMutationOwnership,
  assertSessionSendOwnerSchema, assertUnsettledSessionSendOwners, auditSessionSendOwners,
  classifySessionSendOwnership, insertSessionSendExecutionClaim, insertSessionSendOwner,
  requireSessionSendOwner, sessionSendExecutionClaimSchema, sessionSendOwnerSchema,
  type SessionSendExecutionClaim, type SessionSendOwnerHistory,
} from "./session-send-owner";
import { backfillSessionUserMessageFinalizations } from "./session-user-message-backfill";

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const ownerHash = (kind: string, value: unknown): string => hash(JSON.stringify({ domain: `oompa.session-send.${kind}.v1`, value }));
const attemptId = `attempt_${"a".repeat(32)}`;
const sessionId = `sess_${"b".repeat(32)}`;
const profileId = `acct_${"c".repeat(32)}`;
const providerAccountId = `pact_${"d".repeat(32)}`;
const idempotencyKey = "00000000-0000-4000-8000-000000000001";
const bootId = `boot_${"e".repeat(32)}`;
const corrupt = "SESSION_SEND_OWNER_CORRUPT";

// Synthetic component tables contain the actual columns consumed by the real
// owner/provenance guards. No StateStore, provider process, schema-version stamp,
// or authentic installed-database migration is represented by this fixture.
function fixture(provider: "codex" | "claude" = "claude"): Database {
  const database = new Database(":memory:", { strict: true }); databases.push(database);
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,revision INTEGER,state TEXT,active_turn_id TEXT,provider_thread_id TEXT) STRICT;
    CREATE TABLE provider_accounts(id TEXT PRIMARY KEY,profile_id TEXT,provider TEXT,binding_generation INTEGER,process_generation INTEGER,readiness TEXT) STRICT;
    CREATE TABLE session_provider_authorities(session_id TEXT PRIMARY KEY,provider_account_id TEXT,profile_id TEXT,provider TEXT,
      binding_generation INTEGER,process_generation INTEGER,authority_revision INTEGER,routing_provenance TEXT) STRICT;
    CREATE TABLE daemon_state(singleton INTEGER PRIMARY KEY,generation INTEGER,boot_id TEXT,stopped_at INTEGER) STRICT;
    CREATE TABLE provider_interactions(public_id TEXT PRIMARY KEY,state TEXT,session_id TEXT,thread_id TEXT,profile_id TEXT) STRICT;
    CREATE TABLE interaction_provider_authorities(public_id TEXT PRIMARY KEY,provider_account_id TEXT,profile_id TEXT,provider TEXT,
      binding_generation INTEGER,process_generation INTEGER) STRICT;
    CREATE TABLE mutation_attempts(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,kind TEXT NOT NULL,
      authority_id TEXT NOT NULL,authority_generation INTEGER NOT NULL,request_digest TEXT,state TEXT,result_json TEXT,
      created_at INTEGER,updated_at INTEGER) STRICT;
    CREATE TABLE mutation_provider_authorities(attempt_id TEXT REFERENCES mutation_attempts(id),role TEXT,provider_account_id TEXT,
      profile_id TEXT,provider TEXT,binding_generation INTEGER,process_generation INTEGER,provenance TEXT,recorded_at INTEGER) STRICT;
    CREATE TABLE mutation_effect_evidence(attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),kind TEXT NOT NULL,
      evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
      evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),recorded_at INTEGER NOT NULL) STRICT;
    CREATE TABLE mutation_resolutions(attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),resolution_kind TEXT,
      evidence_json TEXT,receipt_json TEXT,created_at INTEGER) STRICT;
    CREATE TABLE session_runtime_profiles(source_id TEXT) STRICT;
    CREATE TABLE session_turn_runtime_profiles(source_id TEXT) STRICT;
    CREATE TABLE queue_entries(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id)) STRICT;
    CREATE TABLE queue_effect_evidence(queue_id TEXT PRIMARY KEY REFERENCES queue_entries(id),evidence_json TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,recorded_at INTEGER NOT NULL) STRICT;`);
  for (const verb of ["UPDATE", "DELETE"]) database.exec(`CREATE TRIGGER original_effect_${verb.toLowerCase()}
    BEFORE ${verb} ON mutation_effect_evidence BEGIN SELECT RAISE(ABORT,'original evidence immutable'); END;`);
  database.query("INSERT INTO sessions VALUES(?,1,'idle',NULL,'thread')").run(sessionId);
  const accountId = provider === "codex" ? profileId : providerAccountId;
  database.query("INSERT INTO provider_accounts VALUES(?,?,?,2,3,'signed_in')").run(accountId, profileId, provider);
  database.query("INSERT INTO session_provider_authorities VALUES(?,?,?,?,2,3,4,'explicit')").run(sessionId, accountId, profileId, provider);
  database.query("INSERT INTO daemon_state VALUES(1,5,?,NULL)").run(bootId);
  applySessionSendOwnerSchema(database);
  return database;
}
function install(database: Database): void {
  database.transaction(() => { applyEffectEvidenceProvenance(database, "combined49_v1"); }).immediate();
}
function prepare(database: Database, message = "synthetic original message", provider: "codex" | "claude" = "claude"): SessionSendOwnerHistory {
  const owner = sessionSendOwnerSchema.parse({ version: 1, attemptId, idempotencyKey, sessionId,
    fingerprint: fingerprintSessionSendRequest({ kind: "session.send", session: sessionId, message, idempotencyKey }),
    sourceAuthority: { provider, providerAccountId: provider === "codex" ? profileId : providerAccountId,
      profileId, bindingGeneration: 2, processGeneration: 3 },
    sourceThreadId: "thread", sourceSessionRevision: 1, sourceAuthorityRevision: 4,
    routingProvenance: "explicit", appliedPointerRevision: null, createdAt: 100 });
  return database.transaction(() => insertSessionSendOwner(database, owner)).immediate();
}
function claimFor(history: SessionSendOwnerHistory, observedAt = 90): SessionSendExecutionClaim {
  const evidence = { kind: "session.send", providerThreadId: "thread",
    baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null }, clientMessageId: attemptId,
    messageDigest: history.owner.fingerprint.inputDigest,
    runtimeProfile: history.owner.sourceAuthority.provider === "codex"
      ? { profileId, processGeneration: 3, observedAt, preset: "ultra", model: "gpt-5.6-sol", reasoningEffort: "ultra",
        serviceTier: "priority", fast: true, approvalPolicy: "on-request", reviewMode: "auto_review",
        permissionProfile: ":workspace", computerUse: true, pluginCapability: true, enabledApps: [] }
      : { profileId, processGeneration: 3, observedAt, preset: "fable-max", model: "claude-fable-5-1",
      reasoningEffort: "max", claudeVersion: "2.1.260", permissionMode: "default", isolatedConfigDir: true,
      outputFormat: "stream-json", inputFormat: "stream-json" } };
  return sessionSendExecutionClaimSchema.parse({ version: 1, mode: "direct", attemptId,
    ownerDigest: ownerHash("owner", history.owner), daemonGeneration: 5, bootId,
    executionAuthority: history.owner.sourceAuthority, sessionRevision: 1, sessionAuthorityRevision: 4,
    providerThreadId: "thread", clientMessageId: attemptId, evidence, evidenceDigest: hash(JSON.stringify(evidence)), createdAt: 101 });
}
function begin(database: Database, history: SessionSendOwnerHistory, claim = claimFor(history)): SessionSendOwnerHistory {
  return database.transaction(() => insertSessionSendExecutionClaim(database, history, claim)).immediate();
}
// This is the frozen four-statement owner writer shape from usage 8f05930,
// before the provenance bridge. Its real owner guards remain installed.
function retainHistoricalClaim(database: Database, history: SessionSendOwnerHistory, claim = claimFor(history)): void {
  database.transaction(() => {
    const digest = ownerHash("claim", claim);
    database.query("INSERT INTO session_send_execution_claims VALUES(?,?,?,?)")
      .run(attemptId, idempotencyKey, JSON.stringify(claim), digest);
    database.query("INSERT INTO session_send_owner_anchors VALUES(?,?,'claim',?)").run(attemptId, idempotencyKey, digest);
    database.query("INSERT INTO mutation_effect_evidence VALUES(?,'session.send',?,?,?)")
      .run(attemptId, JSON.stringify(claim.evidence), claim.evidenceDigest, claim.createdAt);
    database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'").run(claim.createdAt, attemptId);
  }).immediate();
}
function rows(database: Database): unknown {
  const tables = database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: database.query(`SELECT * FROM ${name} ORDER BY rowid`).all() }));
}
function snapshot(database: Database): unknown {
  return { rows: rows(database), schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(),
    changes: database.query("SELECT total_changes() AS changes").get() };
}
function addTranscriptFixtureColumns(database: Database): void {
  database.exec(`
    ALTER TABLE mutation_attempts ADD COLUMN transcript_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE mutation_attempts ADD COLUMN transcript_finalized INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE mutation_attempts ADD COLUMN transcript_intent_json TEXT DEFAULT '{"message":"retained synthetic prose"}';
    ALTER TABLE mutation_attempts ADD COLUMN custody_marker TEXT DEFAULT 'retained custody';
    ALTER TABLE mutation_attempts ADD COLUMN "odd""column" TEXT DEFAULT 'retained quoted column';
    ALTER TABLE mutation_attempts ADD COLUMN folded_marker TEXT COLLATE NOCASE DEFAULT 'Retained';
    ALTER TABLE queue_entries ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE queue_entries ADD COLUMN transcript_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE queue_entries ADD COLUMN transcript_finalized INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE session_events(session_id TEXT,event_json TEXT) STRICT;`);
}
const schemaRows = (database: Database): unknown => database.query(
  "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name",
).all();
const immutableMutationRows = (database: Database): unknown => z.record(z.string(), z.unknown()).array()
  .parse(database.query("SELECT * FROM mutation_attempts ORDER BY id").all())
  .map((row) => Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== "transcript_status" && key !== "transcript_finalized")));
const backfillError = "STATE_SCHEMA_V43_TRANSCRIPT_BACKFILL_INVALID";
function retainedTranscriptFixture(): Database {
  const database = fixture(); const history = prepare(database); retainHistoricalClaim(database, history);
  addTranscriptFixtureColumns(database);
  return database;
}
function canonicalTranscriptFixture(): Database {
  const database = new Database(":memory:", { strict: true }); databases.push(database);
  database.exec(`CREATE TABLE mutation_attempts(id TEXT,idempotency_key TEXT,kind TEXT,authority_id TEXT,state TEXT,
      transcript_status TEXT,transcript_finalized INTEGER,transcript_intent_json TEXT) STRICT;
    CREATE TABLE queue_entries(id TEXT,session_id TEXT,state TEXT,transcript_status TEXT,transcript_finalized INTEGER) STRICT;
    CREATE TABLE session_events(session_id TEXT,event_json TEXT) STRICT;`);
  return database;
}
function legacyBytes(database: Database): unknown {
  return ["mutation_attempts", "session_send_owners", "session_send_execution_claims", "session_send_owner_anchors",
    "session_send_owner_outcomes", "mutation_effect_evidence", "mutation_provider_authorities", "mutation_resolutions"]
    .map((name) => ({ name, rows: database.query(`SELECT * FROM ${name} ORDER BY rowid`).all() }));
}
function corruptProof(database: Database, table: "mutation_effect_evidence_provenance" | "mutation_effect_evidence_provenance_anchors",
  sql: string): void {
  const triggers = database.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name")
    .all(table) as { name: string; sql: string }[];
  const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  database.exec("PRAGMA foreign_keys=OFF");
  try {
    database.transaction(() => {
      for (const trigger of triggers) database.exec(`DROP TRIGGER ${trigger.name}`);
      database.exec(sql);
      for (const trigger of triggers) database.exec(trigger.sql);
    }).immediate();
  } finally { database.exec("PRAGMA foreign_keys=ON"); }
  expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
}

describe("owned direct-send selected effect provenance", () => {
  test.each([false, true])("retained owner transcript backfill changes only metadata and restores the exact live guard (event=%s)", (event) => {
    const database = retainedTranscriptFixture();
    database.query("INSERT INTO queue_entries(id,session_id,state) VALUES('queue-source',?,'dispatching')").run(sessionId);
    if (event) for (const sourceId of [idempotencyKey, "queue-source"]) database.query("INSERT INTO session_events VALUES(?,?)")
      .run(sessionId, JSON.stringify({ body: { type: "user_message", sourceId } }));
    const schema = schemaRows(database);
    const owner = database.query("SELECT * FROM session_send_execution_claims").all();
    const immutable = immutableMutationRows(database);
    expect(() => database.transaction(() => backfillSessionUserMessageFinalizations(database, "retained_usage")).immediate())
      .not.toThrow();
    expect(database.query("SELECT transcript_status,transcript_finalized FROM mutation_attempts").get())
      .toEqual({ transcript_status: event ? "finalized" : "unavailable", transcript_finalized: event ? 1 : 0 });
    expect(database.query("SELECT transcript_status,transcript_finalized FROM queue_entries").get())
      .toEqual({ transcript_status: event ? "finalized" : "unavailable", transcript_finalized: event ? 1 : 0 });
    expect(immutableMutationRows(database)).toEqual(immutable);
    expect(database.query("SELECT * FROM session_send_execution_claims").all()).toEqual(owner);
    expect(schemaRows(database)).toEqual(schema);
    const before = snapshot(database);
    expect(() => database.query("UPDATE mutation_attempts SET transcript_status='none'").run())
      .toThrow("SESSION_SEND_OWNED_API_REQUIRED");
    expect(snapshot(database)).toEqual(before);
  });

  test.each(["transcript_intent_json", "custody_marker", 'odd"column', "request_format", "folded_marker"])(
    "retained backfill fences every observed nonmetadata column: %s", (column) => {
      const database = retainedTranscriptFixture();
      const quotedColumn = `"${column.replaceAll('"', '""')}"`;
      // The no-op control proves this nested-trigger path is actually reached
      // and allowed when every nonmetadata byte remains unchanged.
      database.exec(`CREATE TRIGGER backfill_nested_fixture AFTER UPDATE OF transcript_status ON mutation_attempts
        BEGIN UPDATE mutation_attempts SET ${quotedColumn}=${quotedColumn} WHERE id=NEW.id; END;`);
      expect(() => database.transaction(() => backfillSessionUserMessageFinalizations(database, "retained_usage")).immediate())
        .not.toThrow();
      database.exec("DROP TRIGGER backfill_nested_fixture");
      database.exec(`CREATE TRIGGER backfill_nested_fixture AFTER UPDATE OF transcript_status ON mutation_attempts
        BEGIN UPDATE mutation_attempts SET ${quotedColumn}=${column === "folded_marker" ? "'retained'" : "NULL"} WHERE id=NEW.id; END;`);
      const beforeRows = rows(database); const beforeSchema = schemaRows(database);
      expect(() => database.transaction(() => backfillSessionUserMessageFinalizations(database, "retained_usage")).immediate())
        .toThrow(backfillError);
      expect(rows(database)).toEqual(beforeRows);
      expect(schemaRows(database)).toEqual(beforeSchema);
    },
  );

  test("retained backfill restores its guard and both tables when the second update fails, even if caught", () => {
    const database = retainedTranscriptFixture();
    database.query("INSERT INTO queue_entries(id,session_id,state) VALUES('queue-source',?,'dispatching')").run(sessionId);
    database.exec(`CREATE TRIGGER backfill_queue_fault BEFORE UPDATE ON queue_entries
      BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END;`);
    const beforeRows = rows(database); const beforeSchema = schemaRows(database);
    database.transaction(() => {
      expect(() => backfillSessionUserMessageFinalizations(database, "retained_usage")).toThrow(backfillError);
      expect(rows(database)).toEqual(beforeRows);
      expect(schemaRows(database)).toEqual(beforeSchema);
    }).immediate();
    expect(rows(database)).toEqual(beforeRows);
    expect(schemaRows(database)).toEqual(beforeSchema);
  });

  test("a later outer migration failure rolls back successful transcript metadata without changing the guard", () => {
    const database = retainedTranscriptFixture();
    const beforeRows = rows(database); const beforeSchema = schemaRows(database);
    expect(() => database.transaction(() => {
      backfillSessionUserMessageFinalizations(database, "retained_usage");
      expect(database.query("SELECT transcript_status FROM mutation_attempts").get()).toEqual({ transcript_status: "unavailable" });
      expect(schemaRows(database)).toEqual(beforeSchema);
      throw new Error("later migration failure");
    }).immediate()).toThrow("later migration failure");
    expect(rows(database)).toEqual(beforeRows);
    expect(schemaRows(database)).toEqual(beforeSchema);
  });

  test.each(["missing", "modified", "colliding_table", "mixed_temp", "canonical", "no_transaction"] as const)(
    "transcript backfill refuses %s guard admission without writes", (mode) => {
      const database = retainedTranscriptFixture();
      if (mode === "missing" || mode === "modified" || mode === "colliding_table") {
        database.exec("DROP TRIGGER session_send_mutation_guard");
        if (mode === "modified") database.exec(`CREATE TRIGGER session_send_mutation_guard BEFORE UPDATE ON mutation_attempts
          BEGIN SELECT RAISE(ABORT,'different guard'); END;`);
        if (mode === "colliding_table") database.exec("CREATE TABLE session_send_mutation_guard(value TEXT) STRICT");
      }
      if (mode === "mixed_temp") database.exec(`CREATE TEMP TRIGGER session_send_mutation_guard BEFORE UPDATE ON main.mutation_attempts
        BEGIN SELECT RAISE(ABORT,'shadow guard'); END;`);
      const before = snapshot(database);
      const run = () => backfillSessionUserMessageFinalizations(database, mode === "canonical" ? "canonical" : "retained_usage");
      expect(mode === "no_transaction" ? run : () => database.transaction(run).immediate()).toThrow(backfillError);
      expect(snapshot(database)).toEqual(before);
    },
  );

  test("seeded canonical backfill preserves the original source-state/event mapping and all other fields", () => {
    const database = canonicalTranscriptFixture();
    const rollback = new Error("rollback canonical fixture");
    fc.assert(fc.property(fc.record({
      kind: fc.constantFrom("session.send", "session.steer", "session.rename"),
      state: fc.constantFrom("prepared", "effect_started", "applied", "ambiguous", "failed", "cancelled"),
      queueState: fc.constantFrom("pending", "dispatching", "applied", "ambiguous", "failed", "cancelled"),
      event: fc.boolean(), intent: fc.string({ maxLength: 80 }),
    }), ({ kind, state, queueState, event, intent }) => {
      expect(() => database.transaction(() => {
        database.query("INSERT INTO mutation_attempts VALUES(?,?,?,?,?,'none',0,?)")
          .run(attemptId, idempotencyKey, kind, sessionId, state, intent);
        database.query("INSERT INTO queue_entries VALUES('queue-source',?,?,'none',0)").run(sessionId, queueState);
        if (event) for (const sourceId of [idempotencyKey, "queue-source"]) database.query("INSERT INTO session_events VALUES(?,?)")
          .run(sessionId, JSON.stringify({ body: { type: "user_message", sourceId } }));
        const immutable = immutableMutationRows(database); const schema = schemaRows(database);
        backfillSessionUserMessageFinalizations(database, "canonical");
        const mutationEligible = kind !== "session.rename" && ["effect_started", "applied", "ambiguous"].includes(state);
        const queueEligible = ["dispatching", "applied", "ambiguous"].includes(queueState);
        for (const [table, eligible] of [["mutation_attempts", mutationEligible], ["queue_entries", queueEligible]] as const) {
          expect(database.query(`SELECT transcript_status,transcript_finalized FROM ${table}`).get()).toEqual({
            transcript_status: eligible ? event ? "finalized" : "unavailable" : "none",
            transcript_finalized: eligible && event ? 1 : 0,
          });
        }
        expect(immutableMutationRows(database)).toEqual(immutable);
        expect(schemaRows(database)).toEqual(schema);
        throw rollback;
      }).immediate()).toThrow(rollback);
    }), { seed: 43_060, numRuns: 100 });
  });

  test("current writer adds joined provenance without changing the original owner, claim or effect preimages", () => {
    const database = fixture(); install(database);
    const history = prepare(database); const claim = claimFor(history);
    const ownerBefore = database.query("SELECT * FROM session_send_owners").all();
    const started = begin(database, history, claim);
    expect(started.state).toBe("effect_started");
    expect(started.claim).toEqual(claim);
    expect(started.claimDigest).toBe(ownerHash("claim", claim));
    expect(database.query("SELECT * FROM session_send_owners").all()).toEqual(ownerBefore);
    expect(database.query("SELECT claim_json,claim_digest FROM session_send_execution_claims").get())
      .toEqual({ claim_json: JSON.stringify(claim), claim_digest: ownerHash("claim", claim) });
    expect(database.query("SELECT * FROM mutation_effect_evidence").get()).toEqual({ attempt_id: attemptId,
      kind: "session.send", evidence_json: JSON.stringify(claim.evidence), evidence_digest: hash(JSON.stringify(claim.evidence)), recorded_at: 101 });
    const selected = readMutationEffectEvidenceProvenance(database, attemptId);
    expect(selected.kind).toBe("parsed"); expect(selected.format).toBe("joined_v1");
    const before = snapshot(database);
    auditSessionSendOwners(database);
    database.transaction(() => { auditEffectEvidenceProvenance(database); }).deferred();
    expect(snapshot(database)).toEqual(before);
  });

  test("historical audit alone admits exact retained bytes; runtime never infers a missing provenance format", () => {
    const database = fixture(); const history = prepare(database); retainHistoricalClaim(database, history);
    const before = snapshot(database);
    auditSessionSendOwners(database, { kind: "historical", format: "combined49_v1" });
    for (const read of [
      () => auditSessionSendOwners(database),
      () => classifySessionSendOwnership(database, { attemptId }),
      () => requireSessionSendOwner(database, { idempotencyKey }),
      () => assertLegacyMutationOwnership(database, { attemptId }),
      () => assertUnsettledSessionSendOwners(database, sessionId),
    ]) expect(read).toThrow(corrupt);
    expect(snapshot(database)).toEqual(before);
    const original = legacyBytes(database); install(database);
    expect(legacyBytes(database)).toEqual(original);
    expect(requireSessionSendOwner(database, { attemptId }).state).toBe("effect_started");
    expect(readMutationEffectEvidenceProvenance(database, attemptId).format).toBe("combined49_v1");
  });

  test("Codex text-only claims retain their original runtime proof through accepted completion", () => {
    const database = fixture("codex"); install(database);
    const history = prepare(database, "Codex message", "codex");
    const claim = claimFor(history); const started = begin(database, history, claim);
    const accepted = database.transaction(() => appendSessionSendOutcome(database, started, { kind: "accepted", receipt: {
      turnId: "turn", status: "completed", sourceId: attemptId, effectiveRuntimeProfile: claim.evidence.runtimeProfile,
    } }, 102)).immediate();
    expect(accepted.state).toBe("accepted");
    expect(accepted.claimDigest).toBe(ownerHash("claim", claim));
    const before = snapshot(database);
    expect(requireSessionSendOwner(database, { attemptId })).toEqual(accepted);
    expect(() => assertLegacyMutationOwnership(database, { attemptId })).toThrow("SESSION_SEND_OWNED_API_REQUIRED");
    auditSessionSendOwners(database);
    expect(snapshot(database)).toEqual(before);
  });

  test.each(["armed", "unavailable"] as const)("retains historical Claude %s fallback bytes without promoting another format", (status) => {
    const database = fixture(); const history = prepare(database); const base = claimFor(history);
    const runtimeProfile = { ...base.evidence.runtimeProfile, nativeFallback: status === "armed"
      ? { evidenceDigest: "f".repeat(64), model: "claude-opus-5", status }
      : { model: "claude-opus-5", reason: "live_acceptance_required", status } };
    const evidence = { ...base.evidence, runtimeProfile };
    const claim = sessionSendExecutionClaimSchema.parse({ ...base, evidence, evidenceDigest: hash(JSON.stringify(evidence)) });
    retainHistoricalClaim(database, history, claim);
    const before = snapshot(database);
    expect(() => auditSessionSendOwners(database, { kind: "historical", format: "canonical40_v1" })).toThrow(corrupt);
    auditSessionSendOwners(database, { kind: "historical", format: "combined49_v1" });
    expect(snapshot(database)).toEqual(before);
    const original = legacyBytes(database); install(database);
    expect(requireSessionSendOwner(database, { attemptId }).claim).toEqual(claim);
    expect(legacyBytes(database)).toEqual(original);
  });

  test("a deliberately wrong selected format stays opaque, never decoded again as joined", () => {
    const database = fixture(); const history = prepare(database); const base = claimFor(history);
    const evidence = { ...base.evidence, runtimeProfile: { ...base.evidence.runtimeProfile,
      nativeFallback: { model: "claude-opus-5", reason: "live_acceptance_required", status: "unavailable" } } };
    const claim = sessionSendExecutionClaimSchema.parse({ ...base, evidence, evidenceDigest: hash(JSON.stringify(evidence)) });
    retainHistoricalClaim(database, history, claim);
    // Deliberately wrong source selection is a component adversary, not an
    // admissible migration: the outer historical owner audit above rejects it.
    database.transaction(() => { applyEffectEvidenceProvenance(database, "canonical40_v1"); }).immediate();
    expect(readMutationEffectEvidenceProvenance(database, attemptId)).toEqual({ kind: "opaque", format: "canonical40_v1", reason: "invalid_shape" });
    const before = snapshot(database);
    expect(() => requireSessionSendOwner(database, { attemptId })).toThrow(corrupt);
    expect(snapshot(database)).toEqual(before);
  });

  test.each([
    ["mutation_effect_evidence_provenance", "DELETE FROM mutation_effect_evidence_provenance"],
    ["mutation_effect_evidence_provenance_anchors", "DELETE FROM mutation_effect_evidence_provenance_anchors"],
    ["mutation_effect_evidence_provenance", "UPDATE mutation_effect_evidence_provenance SET format='combined49_v1'"],
    ["mutation_effect_evidence_provenance", "UPDATE mutation_effect_evidence_provenance SET raw_sha256=printf('%064d',0)"],
    ["mutation_effect_evidence_provenance_anchors", "UPDATE mutation_effect_evidence_provenance_anchors SET provenance_digest=printf('%064d',0)"],
  ] as const)("rejects retained selected-proof corruption in %s: %s", (table, sql) => {
    const database = fixture(); install(database); begin(database, prepare(database));
    const original = legacyBytes(database); corruptProof(database, table, sql);
    const before = snapshot(database);
    for (const read of [() => auditSessionSendOwners(database),
      () => classifySessionSendOwnership(database, { attemptId }),
      () => assertLegacyMutationOwnership(database, { attemptId }),
      () => assertUnsettledSessionSendOwners(database, sessionId)]) expect(read).toThrow(corrupt);
    expect(snapshot(database)).toEqual(before); expect(legacyBytes(database)).toEqual(original);
  });

  test("late state-CAS failure rolls back claim, evidence and both provenance rows", () => {
    const database = fixture(); install(database); const history = prepare(database);
    database.exec(`CREATE TRIGGER test_late_claim_failure BEFORE UPDATE OF state ON mutation_attempts
      WHEN NEW.state='effect_started' BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END;`);
    const before = rows(database);
    expect(() => begin(database, history)).toThrow("synthetic late failure");
    // total_changes counts rolled-back writes; the durable rows, not that
    // connection statistic, are the atomicity oracle.
    expect(rows(database)).toEqual(before);
    database.exec("DROP TRIGGER test_late_claim_failure");
    expect(begin(database, history).state).toBe("effect_started");
  });

  test("missing provenance schema refuses the new writer and rolls back its earlier claim writes", () => {
    const database = fixture(); const history = prepare(database); const before = rows(database);
    expect(() => begin(database, history)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
    expect(rows(database)).toEqual(before); assertSessionSendOwnerSchema(database);
    install(database); expect(begin(database, history).state).toBe("effect_started");
  });

  test("a standalone claim call refuses before any owner, evidence or provenance write", () => {
    const database = fixture(); install(database); const history = prepare(database);
    const before = snapshot(database);
    expect(() => insertSessionSendExecutionClaim(database, history, claimFor(history))).toThrow("SESSION_SEND_CLAIM_CONFLICT");
    expect(snapshot(database)).toEqual(before);
    expect(begin(database, history).state).toBe("effect_started");
  });

  test("seeded valid claim preimages remain stable through selected reads and ambiguous same-owner recovery", () => {
    const database = fixture(); install(database);
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }).filter((value) => value.trim().length > 0),
      fc.integer({ min: 0, max: 10000 }), (message, observedAt) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const history = prepare(database, message); const claim = claimFor(history, observedAt);
          const started = begin(database, history, claim);
          expect(started.claimDigest).toBe(ownerHash("claim", claim));
          expect(started.claim?.evidenceDigest).toBe(hash(JSON.stringify(claim.evidence)));
          const pending = appendSessionSendOutcome(database, started, { kind: "ambiguous", reason: "provider_outcome_unknown" }, 102);
          const final = appendSessionSendOutcome(database, pending, { kind: "abandoned", acknowledgeOutcomeUnknown: true }, 103);
          expect(final.state).toBe("abandoned");
          const before = snapshot(database);
          expect(requireSessionSendOwner(database, { idempotencyKey })).toEqual(final);
          auditSessionSendOwners(database);
          expect(snapshot(database)).toEqual(before);
        } finally { database.exec("ROLLBACK"); }
      }), { seed: 814763, numRuns: 80 });
  });
});
