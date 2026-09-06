import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";

import { insertClaudeProcessCustody } from "./claude-process-custody";
import type { SessionSwitchAdoptionOrigin } from "./session-switch-adoption";
import {
  applySessionSwitchAdoption,
  auditSessionSwitchAdoption,
  auditSessionSwitchAdoptionBeforeContainment,
  insertSessionSwitchAdoption,
  readSessionSwitchAdoption,
} from "./session-switch-adoption";

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const sourceId = `acct_${"a".repeat(32)}`;
const targetId = `acct_${"b".repeat(32)}`;
const sessionId = `sess_${"c".repeat(32)}`;
const sourceKey = `v1:codex:${"d".repeat(64)}`;
const targetKey = `v1:codex:${"e".repeat(64)}`;
const origin = (index = 1): SessionSwitchAdoptionOrigin => ({
  attemptId: `attempt_${index.toString(16).padStart(32, "0")}`,
  sessionId,
  requestDigest: "f".repeat(64),
  sourceAuthority: { profileId: sourceId, bindingGeneration: 2, processGeneration: 3,
    provider: "codex", providerAccountId: sourceId },
  targetAuthority: { profileId: targetId, bindingGeneration: 4, processGeneration: 5,
    provider: "codex", providerAccountId: targetId },
  sourceProviderThreadId: "source-thread", originalSessionRevision: 6,
  originalAuthorityRevision: 7, createdAt: 100,
});

// The unit fixture contains the real boundary's queried fields. The StateStore
// integration suite additionally proves these guards with the complete schema.
function fixture(personal = false): Database {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE profiles(id TEXT PRIMARY KEY,process_generation INTEGER,state TEXT,codex_account_key TEXT) STRICT;
    CREATE TABLE provider_accounts(id TEXT PRIMARY KEY,profile_id TEXT,provider TEXT,binding_generation INTEGER,process_generation INTEGER,readiness TEXT) STRICT;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,profile_id TEXT,provider_v39 TEXT,provider_thread_id TEXT,revision INTEGER,state TEXT,active_turn_id TEXT) STRICT;
    CREATE TABLE session_provider_authorities(session_id TEXT PRIMARY KEY,profile_id TEXT,provider TEXT,provider_account_id TEXT,binding_generation INTEGER,process_generation INTEGER,authority_revision INTEGER) STRICT;
    CREATE TABLE session_provider_account_authorities(session_id TEXT PRIMARY KEY,provider TEXT,runtime_scope TEXT,account_key TEXT) STRICT;
    CREATE TABLE session_personal_runtime_bindings(session_id TEXT PRIMARY KEY,provider TEXT,provider_thread_id TEXT,state TEXT,revision INTEGER) STRICT;
    CREATE TABLE provider_runtime_account_revocations(profile_id TEXT,profile_generation INTEGER,provider TEXT,runtime_scope TEXT,state TEXT,current_account_key TEXT) STRICT;
    CREATE TABLE session_claude_process_authorities(session_id TEXT,profile_id TEXT,provider_thread_id TEXT,runtime_scope TEXT,state TEXT,provider_authority_digest TEXT) STRICT;
    CREATE TABLE session_claude_process_provider_authorities(digest TEXT PRIMARY KEY,proof_json TEXT) STRICT;
    CREATE TABLE session_switch_target_start_receipts(attempt_id TEXT PRIMARY KEY,provider_thread_id TEXT,state TEXT,active_turn_id TEXT) STRICT;
    CREATE TABLE session_switch_source_release_receipts(attempt_id TEXT PRIMARY KEY,provider_thread_id TEXT) STRICT;
    CREATE TABLE session_switch_rebind_receipts(attempt_id TEXT PRIMARY KEY,session_revision INTEGER,authority_revision INTEGER) STRICT;
    CREATE TABLE session_switch_attempts(journal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT UNIQUE,request_key TEXT,session_id TEXT,request_digest TEXT,
      source_profile_id TEXT,source_provider_account_id TEXT,source_provider TEXT,source_binding_generation INTEGER,source_process_generation INTEGER,
      target_profile_id TEXT,target_provider_account_id TEXT,target_provider TEXT,target_binding_generation INTEGER,target_process_generation INTEGER,
      source_provider_thread_id TEXT,original_session_revision INTEGER,original_authority_revision INTEGER,created_at INTEGER,phase TEXT,
      diagnostic_code TEXT,updated_at INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE mutation_attempts(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,kind TEXT,
      authority_id TEXT,authority_generation INTEGER,request_digest TEXT,state TEXT,created_at INTEGER,updated_at INTEGER,result_json TEXT) STRICT;
    CREATE TABLE mutation_provider_authorities(attempt_id TEXT,role TEXT,profile_id TEXT,provider_account_id TEXT,
      provider TEXT,binding_generation INTEGER,process_generation INTEGER,provenance TEXT,recorded_at INTEGER) STRICT;
    CREATE TABLE session_switch_malformed_dispositions(journal_sequence INTEGER PRIMARY KEY,mutation_request_key TEXT,
      session_id TEXT,from_phase TEXT,terminal_phase TEXT,diagnostic_code TEXT,evidence_depth INTEGER,recorded_at INTEGER) STRICT;`);
  for (const table of [
    "rebind_receipts", "seed_authorities", "seed_receipts", "no_effect_receipts", "reconciliation_receipts", "abandon_receipts",
    "target_start_anchors", "source_release_anchors", "rebind_anchors", "seed_anchors", "no_effect_anchors", "reconciliation_anchors", "abandon_anchors",
  ]) database.exec(`CREATE TABLE IF NOT EXISTS session_switch_${table}(attempt_id TEXT PRIMARY KEY) STRICT`);
  database.query("INSERT INTO profiles VALUES(?,?,?,?)").run(sourceId, 3, "signed_in", sourceKey);
  database.query("INSERT INTO profiles VALUES(?,?,?,?)").run(targetId, 5, "signed_in", targetKey);
  database.query("INSERT INTO provider_accounts VALUES(?,?,?,?,?,?)").run(sourceId, sourceId, "codex", 2, 3, "signed_in");
  database.query("INSERT INTO provider_accounts VALUES(?,?,?,?,?,?)").run(targetId, targetId, "codex", 4, 5, "signed_in");
  database.query("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)").run(sessionId, sourceId, "codex", "source-thread", 6, "idle", null);
  database.query("INSERT INTO session_provider_authorities VALUES(?,?,?,?,?,?,?)").run(sessionId, sourceId, "codex", sourceId, 2, 3, 7);
  database.query("INSERT INTO session_provider_account_authorities VALUES(?,?,?,?)").run(sessionId, "codex", personal ? "personal" : "managed", sourceKey);
  if (personal) database.query("INSERT INTO session_personal_runtime_bindings VALUES(?,?,?,?,?)")
    .run(sessionId, "codex", "source-thread", "active", 8);
  return database;
}

function parent(database: Database, value = origin()): void {
  database.query(`INSERT INTO session_switch_attempts(attempt_id,session_id,request_digest,
    source_profile_id,source_provider_account_id,source_provider,source_binding_generation,source_process_generation,
    target_profile_id,target_provider_account_id,target_provider,target_binding_generation,target_process_generation,
    source_provider_thread_id,original_session_revision,original_authority_revision,created_at,phase)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared')`).run(value.attemptId, value.sessionId,
    value.requestDigest, value.sourceAuthority.profileId, value.sourceAuthority.providerAccountId,
    value.sourceAuthority.provider, value.sourceAuthority.bindingGeneration, value.sourceAuthority.processGeneration,
    value.targetAuthority.profileId, value.targetAuthority.providerAccountId, value.targetAuthority.provider,
    value.targetAuthority.bindingGeneration, value.targetAuthority.processGeneration, value.sourceProviderThreadId,
    value.originalSessionRevision, value.originalAuthorityRevision, value.createdAt);
}

function install(database: Database): void {
  database.transaction(() => applySessionSwitchAdoption(database)).immediate();
}
function prepare(database: Database, value = origin()): void {
  database.transaction(() => {
    insertSessionSwitchAdoption(database, { origin: value, targetAccountKey: targetKey });
    parent(database, value);
  }).immediate();
}

function containmentFixture(phase: "prepared" | "target_starting" = "prepared") {
  const database = fixture();
  const value = origin();
  const requestKey = "10000000-0000-4000-8000-000000000001";
  install(database);
  prepare(database, value);
  database.query("UPDATE session_switch_attempts SET request_key=?,phase=?,updated_at=100")
    .run(requestKey, phase);
  database.query("INSERT INTO mutation_attempts VALUES(?,?,'session.switch',?,?,?, ?,100,100,NULL)")
    .run(value.attemptId, requestKey, value.sessionId, value.targetAuthority.processGeneration,
      value.requestDigest, phase === "prepared" ? "prepared" : "effect_started");
  for (const side of ["source", "target"] as const) {
    const authority = value[`${side}Authority`];
    database.query("INSERT INTO mutation_provider_authorities VALUES(?,?,?,?,?,?,?,?,100)")
      .run(value.attemptId, side, authority.profileId, authority.providerAccountId,
        authority.provider, authority.bindingGeneration, authority.processGeneration, `session_switch_${side}`);
  }
  const guard = z.object({ sql: z.string() }).strict().parse(database.query(
    "SELECT sql FROM sqlite_master WHERE name='session_switch_adoption_parent_update'",
  ).get()).sql;
  database.exec("DROP TRIGGER session_switch_adoption_parent_update");
  database.query("UPDATE session_switch_attempts SET source_process_generation=source_process_generation+1").run();
  database.exec(guard);
  const disposition = (terminal: "cancelled" | "reconciliation_required") => database.query(
    "INSERT INTO session_switch_malformed_dispositions VALUES(1,?,?,?,?,'MALFORMED_SWITCH_RECORD',0,200)",
  ).run(requestKey, value.sessionId, phase, terminal);
  return { database, value, disposition };
}

function claudeSourceFixture(runtimeScope: "managed" | "personal"): Readonly<{
  database: Database; value: SessionSwitchAdoptionOrigin; processDigest: string;
}> {
  const database = fixture(runtimeScope === "personal");
  const value = origin();
  const claudeId = `pact_${"1".repeat(32)}`;
  const claudeKey = `v1:claude:${"d".repeat(64)}`;
  value.sourceAuthority = { ...value.sourceAuthority, provider: "claude", providerAccountId: claudeId };
  database.query("UPDATE provider_accounts SET id=?,provider='claude',readiness='unverified' WHERE id=?")
    .run(claudeId, sourceId);
  database.query("UPDATE sessions SET provider_v39='claude'").run();
  database.query("UPDATE session_provider_authorities SET provider='claude',provider_account_id=?").run(claudeId);
  database.query("UPDATE session_provider_account_authorities SET provider='claude',account_key=?").run(claudeKey);
  database.query("UPDATE session_personal_runtime_bindings SET provider='claude'").run();
  // Source admission reads the real canonical process proof and its exact
  // parent identity, not the small target-only projection used below.
  database.exec(`ALTER TABLE session_claude_process_authorities ADD COLUMN profile_generation INTEGER;
    ALTER TABLE session_claude_process_authorities ADD COLUMN pid INTEGER;
    ALTER TABLE session_claude_process_authorities ADD COLUMN pid_domain TEXT;
    ALTER TABLE session_claude_process_authorities ADD COLUMN proc_start TEXT;
    ALTER TABLE session_claude_process_authorities ADD COLUMN recorded_at INTEGER;`);
  const processDigest = insertClaudeProcessCustody(database, {
    version: 1, kind: "exact_provider_v1", parentKind: "process",
    profileId: sourceId, profileGeneration: 3, providerThreadId: "source-thread", runtimeScope,
    originAt: 100, intentId: null, identity: { pid: 1234, pidDomain: "darwin", procStart: "fixture-start" },
    authority: value.sourceAuthority, launchDigest: null, previousDigest: null,
    claimRevision: 1, launchContext: null,
  });
  database.query(`INSERT INTO session_claude_process_authorities(
    session_id,profile_id,provider_thread_id,runtime_scope,state,provider_authority_digest,
    profile_generation,pid,pid_domain,proc_start,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sessionId, sourceId, "source-thread", runtimeScope, "bound", processDigest,
      3, 1234, "darwin", "fixture-start", 100);
  install(database);
  return { database, value, processDigest };
}

describe("switch adoption authority capsule", () => {
  test("admits an exact personal Claude source without authenticating its managed home", () => {
    const { database, value, processDigest } = claudeSourceFixture("personal");
    prepare(database, value);
    expect(readSessionSwitchAdoption(database, value.attemptId)).toMatchObject({
      sourceRuntimeScope: "personal", sourcePersonalBindingRevision: 8,
      sourceClaudeProcessDigest: processDigest,
    });
    database.query("UPDATE session_switch_attempts SET phase='source_released'").run();
    database.query("UPDATE session_claude_process_authorities SET state='released'").run();
    database.query("INSERT INTO session_switch_target_start_receipts VALUES(?,?,?,?)")
      .run(value.attemptId, "target-thread", "idle", null);
    database.query("INSERT INTO session_switch_source_release_receipts VALUES(?,?)")
      .run(value.attemptId, "source-thread");
    expect(() => database.query("INSERT INTO session_switch_rebind_receipts VALUES(?,?,?)")
      .run(value.attemptId, 7, 8)).not.toThrow();
    expect(database.query("SELECT readiness FROM provider_accounts WHERE id=?")
      .get(value.sourceAuthority.providerAccountId)).toEqual({ readiness: "unverified" });
    expect(() => auditSessionSwitchAdoption(database)).not.toThrow();
  });

  test("does not extend personal Claude source readiness to managed homes or signed-out sources", () => {
    for (const scenario of [
      { scope: "managed", readiness: "unverified" },
      { scope: "personal", readiness: "signed_out" },
      { scope: "personal", readiness: "recovery_required" },
    ] as const) {
      const { database, value } = claudeSourceFixture(scenario.scope);
      database.query("UPDATE provider_accounts SET readiness=? WHERE id=?")
        .run(scenario.readiness, value.sourceAuthority.providerAccountId);
      expect(() => prepare(database, value)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
      expect(database.query("SELECT * FROM session_switch_adoption_capsules").all()).toHaveLength(0);
      expect(database.query("SELECT * FROM session_switch_attempts").all()).toHaveLength(0);
    }
  });

  test("requires a signed-in target even for an exact personal Claude source", () => {
    for (const provider of ["codex", "claude"] as const) {
      const { database, value } = claudeSourceFixture("personal");
      const targetAccountId = provider === "claude" ? `pact_${"2".repeat(32)}` : targetId;
      value.targetAuthority = { ...value.targetAuthority, provider, providerAccountId: targetAccountId };
      database.query("UPDATE provider_accounts SET id=?,provider=?,readiness='unverified' WHERE id=?")
        .run(targetAccountId, provider, targetId);
      const attempt = (): void => { database.transaction(() => {
        insertSessionSwitchAdoption(database, { origin: value, targetAccountKey: `v1:${provider}:${"e".repeat(64)}` });
        parent(database, value);
      }).immediate(); };
      expect(attempt).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
      expect(database.query("SELECT * FROM session_switch_adoption_capsules").all()).toHaveLength(0);
      expect(database.query("SELECT * FROM session_switch_attempts").all()).toHaveLength(0);
    }
  });

  test("an unverified personal Claude source still requires exact live binding and process custody", () => {
    for (const mutation of [
      "UPDATE session_personal_runtime_bindings SET state='detached'",
      "UPDATE session_personal_runtime_bindings SET provider_thread_id='substituted-thread'",
      "UPDATE session_claude_process_authorities SET state='released'",
      "UPDATE session_claude_process_authorities SET proc_start='substituted-start'",
      "DELETE FROM session_claude_process_provider_authorities",
    ]) {
      const { database, value } = claudeSourceFixture("personal");
      database.exec(mutation);
      expect(() => prepare(database, value)).toThrow();
      expect(database.query("SELECT * FROM session_switch_adoption_capsules").all()).toHaveLength(0);
      expect(database.query("SELECT * FROM session_switch_attempts").all()).toHaveLength(0);
    }
  });

  test("raw SQL rejects open or incorrectly typed authority capsules atomically", () => {
    const valid = fixture();
    install(valid);
    prepare(valid);
    const row = z.object({ attempt_id: z.string(), digest: z.string(),
      origin_json: z.string(), capsule_json: z.string() }).parse(valid.query(
        "SELECT * FROM session_switch_adoption_capsules",
      ).get());
    const changes: readonly Readonly<{ field: "origin_json" | "capsule_json"; mutate: (value: string) => string }>[] = [
      { field: "origin_json", mutate: (value) => value.replace('{', '{"unreviewed":true,') },
      { field: "origin_json", mutate: (value) => value.replace('"createdAt":100', '"createdAt":"100"') },
      { field: "origin_json", mutate: (value) => value.replace('"createdAt":100', '"createdAt":100.5') },
      { field: "origin_json", mutate: (value) => value.replace('"createdAt":100', '"createdAt":9007199254740992') },
      { field: "origin_json", mutate: (value) => value.replace('"bindingGeneration":2', '"bindingGeneration":"2"') },
      { field: "origin_json", mutate: (value) => value.replace('"processGeneration":3', '"processGeneration":3,"processGeneration":3') },
      { field: "capsule_json", mutate: (value) => value.replace('{', '{"unreviewed":true,') },
      { field: "capsule_json", mutate: (value) => value.replace('"version":1', '"version":1.0') },
      { field: "capsule_json", mutate: (value) => value.replace('"sourceProfileGeneration":3', '"sourceProfileGeneration":"3"') },
      { field: "capsule_json", mutate: (value) => value.replace('"sourcePersonalBindingRevision":null', '"sourcePersonalBindingRevision":0') },
      { field: "capsule_json", mutate: (value) => value.replace(targetKey, `v1:claude:${"e".repeat(64)}`) },
      { field: "capsule_json", mutate: (value) => value.replace('"sourceClaudeProcessDigest":null', '"sourceClaudeProcessDigest":"unproved"') },
    ];
    for (const change of changes) {
      const database = fixture();
      install(database);
      const altered = { ...row, [change.field]: change.mutate(row[change.field]) };
      expect(() => database.transaction(() => {
        database.query("INSERT INTO session_switch_adoption_capsules(attempt_id,digest,kind,origin_json,capsule_json) VALUES(?,?,'exact_v1',?,?)")
          .run(altered.attempt_id, altered.digest, altered.origin_json, altered.capsule_json);
        database.query("INSERT INTO session_switch_adoption_anchors VALUES(?,?)")
          .run(altered.attempt_id, altered.digest);
        parent(database);
      }).immediate()).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
      expect(database.query("SELECT COUNT(*) AS count FROM session_switch_attempts").get()).toEqual({ count: 0 });
      expect(database.query("SELECT COUNT(*) AS count FROM session_switch_adoption_capsules").get()).toEqual({ count: 0 });
    }
  });

  test("joins the full tuple, source scope, and target identity in one transaction", () => {
    const database = fixture();
    install(database);
    prepare(database);
    expect(readSessionSwitchAdoption(database, origin().attemptId)).toEqual({
      version: 1, sourceRuntimeScope: "managed", sourceAccountKey: sourceKey,
      sourcePersonalBindingRevision: null, sourceProfileGeneration: 3,
      sourceClaudeProcessDigest: null, targetAccountKey: targetKey, targetProfileGeneration: 5,
    });
    expect(() => auditSessionSwitchAdoption(database)).not.toThrow();
    database.query("UPDATE profiles SET codex_account_key=? WHERE id=?").run(sourceKey, targetId);
    // A later account change never rewrites the admitted historical capsule.
    expect(readSessionSwitchAdoption(database, origin().attemptId)?.targetAccountKey).toBe(targetKey);
    expect(() => database.query("UPDATE session_switch_attempts SET target_binding_generation=9 WHERE attempt_id=?")
      .run(origin().attemptId)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
  });

  test("refuses unproved raw parents and uncommitted orphan proofs atomically", () => {
    const database = fixture();
    install(database);
    expect(() => parent(database)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    expect(() => database.transaction(() => {
      insertSessionSwitchAdoption(database, { origin: origin(), targetAccountKey: targetKey });
    }).immediate()).toThrow();
    expect(database.query("SELECT * FROM session_switch_adoption_capsules").all()).toHaveLength(0);
    expect(database.query("SELECT * FROM session_switch_adoption_anchors").all()).toHaveLength(0);
  });

  test("rejects stale binding, source scope, target identity, and revocation", () => {
    const database = fixture();
    install(database);
    expect(() => prepare(database, { ...origin(), sourceAuthority: {
      ...origin().sourceAuthority, bindingGeneration: 1,
    } })).toThrow();
    expect(() => database.transaction(() => {
      insertSessionSwitchAdoption(database, { origin: origin(), targetAccountKey: sourceKey });
      parent(database);
    }).immediate()).toThrow();
    database.query("INSERT INTO session_personal_runtime_bindings VALUES(?,?,?,?,?)")
      .run(sessionId, "codex", "source-thread", "active", 1);
    expect(() => prepare(database)).toThrow();
    database.query("DELETE FROM session_personal_runtime_bindings").run();
    database.query("INSERT INTO provider_runtime_account_revocations VALUES(?,?,?,?,?,?)")
      .run(targetId, 5, "codex", "managed", "releasing", targetKey);
    expect(() => prepare(database)).toThrow();
    expect(database.query("SELECT * FROM session_switch_attempts").all()).toHaveLength(0);
  });

  test("captures the exact personal binding revision", () => {
    const database = fixture(true);
    install(database);
    prepare(database);
    expect(readSessionSwitchAdoption(database, origin().attemptId)).toMatchObject({
      sourceRuntimeScope: "personal", sourcePersonalBindingRevision: 8,
    });
    expect(() => auditSessionSwitchAdoption(database)).not.toThrow();
  });

  test("active switch freezes source home and requires a joined rebind receipt", () => {
    const database = fixture(true);
    install(database);
    prepare(database);
    expect(() => database.query("DELETE FROM session_provider_account_authorities WHERE session_id=?")
      .run(sessionId)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    expect(() => database.query("UPDATE session_personal_runtime_bindings SET state='detached',revision=revision+1 WHERE session_id=?")
      .run(sessionId)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    expect(() => database.query("DELETE FROM session_personal_runtime_bindings WHERE session_id=?")
      .run(sessionId)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    expect(() => database.query("INSERT INTO session_switch_rebind_receipts VALUES(?,?,?)")
      .run(origin().attemptId, 7, 8)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    expect(database.query("SELECT runtime_scope FROM session_provider_account_authorities").get()).toEqual({ runtime_scope: "personal" });
    expect(database.query("SELECT state,revision FROM session_personal_runtime_bindings").get()).toEqual({ state: "active", revision: 8 });
  });

  test("admits exact personal-to-managed rebind and rejects a substituted target key", () => {
    const database = fixture(true);
    install(database);
    prepare(database);
    // Unit-only parent phases; StateStore integration owns the real phase,
    // anchor, runtime-profile and event receipts around this same boundary.
    database.query("UPDATE session_switch_attempts SET phase='source_released'").run();
    database.query("INSERT INTO session_switch_target_start_receipts VALUES(?,?,?,?)")
      .run(origin().attemptId, "target-thread", "idle", null);
    expect(() => database.query("INSERT INTO session_switch_rebind_receipts VALUES(?,?,?)")
      .run(origin().attemptId, 7, 8)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    database.query("INSERT INTO session_switch_source_release_receipts VALUES(?,?)")
      .run(origin().attemptId, "source-thread");
    database.transaction(() => {
      database.query("INSERT INTO session_switch_rebind_receipts VALUES(?,?,?)")
        .run(origin().attemptId, 7, 8);
      database.query("UPDATE session_personal_runtime_bindings SET state='detached',revision=revision+1 WHERE session_id=?")
        .run(sessionId);
      database.query("DELETE FROM session_provider_account_authorities WHERE session_id=?").run(sessionId);
      database.query("UPDATE sessions SET profile_id=?,provider_thread_id='target-thread',revision=7 WHERE id=?")
        .run(targetId, sessionId);
      database.query("UPDATE session_provider_authorities SET profile_id=?,provider_account_id=?,binding_generation=4,process_generation=5,authority_revision=8 WHERE session_id=?")
        .run(targetId, targetId, sessionId);
      expect(() => database.query("INSERT INTO session_provider_account_authorities VALUES(?,'codex','managed',?)")
        .run(sessionId, sourceKey)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
      database.query("INSERT INTO session_provider_account_authorities VALUES(?,'codex','managed',?)")
        .run(sessionId, targetKey);
      database.query("UPDATE session_switch_attempts SET phase='rebound'").run();
    }).immediate();
    expect(database.query("SELECT runtime_scope,account_key FROM session_provider_account_authorities").get())
      .toEqual({ runtime_scope: "managed", account_key: targetKey });
    expect(database.query("SELECT state,revision FROM session_personal_runtime_bindings").get())
      .toEqual({ state: "detached", revision: 9 });
    expect(() => auditSessionSwitchAdoption(database)).not.toThrow();
  });

  test("Claude rebind keeps its own tuple after a sibling Codex counter changes", () => {
    const database = fixture();
    const claudeId = `pact_${"1".repeat(32)}`;
    const claudeKey = `v1:claude:${"e".repeat(64)}`;
    const value = origin();
    value.targetAuthority = { ...value.targetAuthority, provider: "claude", providerAccountId: claudeId };
    database.query("UPDATE provider_accounts SET id=?,provider='claude' WHERE id=?").run(claudeId, targetId);
    install(database);
    database.transaction(() => {
      insertSessionSwitchAdoption(database, { origin: value, targetAccountKey: claudeKey });
      parent(database, value);
    }).immediate();
    database.query("UPDATE session_switch_attempts SET phase='source_released'").run();
    database.query("INSERT INTO session_switch_target_start_receipts VALUES(?,?,?,?)")
      .run(value.attemptId, "target-thread", "idle", null);
    database.query("INSERT INTO session_switch_source_release_receipts VALUES(?,?)")
      .run(value.attemptId, "source-thread");
    // Only the queried proof projection is modelled here. The process-custody
    // suite validates real immutable roots and their admission/disposition.
    const processDigest = "2".repeat(64);
    const launchDigest = "3".repeat(64);
    database.query("INSERT INTO session_claude_process_authorities VALUES(?,?,?,?,?,?)")
      .run(sessionId, targetId, "target-thread", "managed", "claimed", processDigest);
    database.query("INSERT INTO session_claude_process_provider_authorities VALUES(?,?)")
      .run(processDigest, JSON.stringify({ kind: "exact_provider_v1", authority: value.targetAuthority, launchDigest }));
    database.query("INSERT INTO session_claude_process_provider_authorities VALUES(?,?)")
      .run(launchDigest, JSON.stringify({ launchContext: { sessionId, switchAttemptId: value.attemptId, accountKey: claudeKey } }));
    database.query("UPDATE profiles SET process_generation=6 WHERE id=?").run(targetId);
    expect(readSessionSwitchAdoption(database, value.attemptId)?.targetProfileGeneration).toBe(5);
    // A scoped Claude revocation retains its original shared-counter metadata.
    // Advancing only Codex must not make the independent Claude fence vanish.
    database.query("INSERT INTO provider_runtime_account_revocations VALUES(?,?,?,?,?,?)")
      .run(targetId, 5, "claude", "managed", "releasing", claudeKey);
    expect(() => database.query("INSERT INTO session_switch_rebind_receipts VALUES(?,?,?)")
      .run(value.attemptId, 7, 8)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    expect(database.query("SELECT * FROM session_switch_rebind_receipts").all()).toHaveLength(0);
    database.query("UPDATE provider_runtime_account_revocations SET state='completed',current_account_key=?")
      .run(`v1:claude:${"9".repeat(64)}`);
    expect(() => database.query("INSERT INTO session_switch_rebind_receipts VALUES(?,?,?)")
      .run(value.attemptId, 7, 8)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    database.query("DELETE FROM provider_runtime_account_revocations").run();
    database.query("UPDATE provider_accounts SET process_generation=6 WHERE id=?").run(claudeId);
    expect(() => database.query("INSERT INTO session_switch_rebind_receipts VALUES(?,?,?)")
      .run(value.attemptId, 7, 8)).toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    database.query("UPDATE provider_accounts SET process_generation=5 WHERE id=?").run(claudeId);
    expect(() => database.query("INSERT INTO session_switch_rebind_receipts VALUES(?,?,?)")
      .run(value.attemptId, 7, 8)).not.toThrow();
  });

  test("explicitly classifies historical attempts without granting new effects", () => {
    const database = fixture();
    parent(database);
    install(database);
    expect(readSessionSwitchAdoption(database, origin().attemptId)).toBeNull();
    expect(() => database.query("UPDATE session_switch_attempts SET phase='target_starting'").run())
      .toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    database.query("UPDATE session_switch_attempts SET phase='cancelled'").run();
    expect(() => auditSessionSwitchAdoption(database)).not.toThrow();
    expect(() => install(database)).toThrow("SESSION_SWITCH_ADOPTION_CUSTODY_CORRUPT");
  });

  test("cannot mistake lost capsule plus anchor for historical authority", () => {
    const database = fixture();
    install(database);
    prepare(database);
    expect(() => database.query("DELETE FROM session_switch_adoption_capsules").run()).toThrow();
    database.exec(`DROP TRIGGER session_switch_adoption_capsules_delete;
      DROP TRIGGER session_switch_adoption_anchors_delete;`);
    database.transaction(() => {
      database.query("DELETE FROM session_switch_adoption_capsules").run();
      database.query("DELETE FROM session_switch_adoption_anchors").run();
    }).immediate();
    expect(() => readSessionSwitchAdoption(database, origin().attemptId)).toThrow();
    expect(() => auditSessionSwitchAdoption(database)).toThrow();
  });
});

describe("switch adoption terminal containment", () => {
  test("recognition never permits execution and cancellation preserves the independent origin", () => {
    const { database, value, disposition } = containmentFixture();
    const proof = database.query("SELECT * FROM session_switch_adoption_capsules").all();
    const anchor = database.query("SELECT * FROM session_switch_adoption_anchors").all();
    expect(() => auditSessionSwitchAdoptionBeforeContainment(database)).not.toThrow();
    expect(() => auditSessionSwitchAdoption(database)).toThrow();
    expect(() => readSessionSwitchAdoption(database, value.attemptId)).toThrow();
    disposition("cancelled");
    expect(() => database.query("UPDATE session_switch_attempts SET phase='target_starting',updated_at=200").run())
      .toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    database.transaction(() => {
      database.query("UPDATE session_switch_attempts SET phase='cancelled',diagnostic_code='MALFORMED_SWITCH_RECORD',updated_at=200").run();
      database.query("UPDATE mutation_attempts SET state='cancelled',updated_at=200").run();
    }).immediate();
    expect(() => auditSessionSwitchAdoption(database)).not.toThrow();
    expect(() => readSessionSwitchAdoption(database, value.attemptId)).toThrow();
    expect(database.query("SELECT * FROM session_switch_adoption_capsules").all()).toEqual(proof);
    expect(database.query("SELECT * FROM session_switch_adoption_anchors").all()).toEqual(anchor);
  });

  test.each(["effect_started", "effect_receipt", "orphan_effect_anchor"] as const)(
    "cannot cancel malformed prepared custody with %s evidence", (scenario) => {
      const { database, value, disposition } = containmentFixture();
      if (scenario === "effect_started") database.query("UPDATE mutation_attempts SET state='effect_started'").run();
      else database.query(scenario === "effect_receipt"
        ? "INSERT INTO session_switch_target_start_receipts VALUES(?,'target','idle',NULL)"
        : "INSERT INTO session_switch_target_start_anchors VALUES(?)").run(value.attemptId);
      disposition("cancelled");
      const before = database.query("SELECT * FROM session_switch_attempts").all();
      expect(() => database.query("UPDATE session_switch_attempts SET phase='cancelled',diagnostic_code='MALFORMED_SWITCH_RECORD',updated_at=200").run())
        .toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
      expect(database.query("SELECT * FROM session_switch_attempts").all()).toEqual(before);
      expect(() => auditSessionSwitchAdoption(database)).toThrow();
    },
  );

  test("requires the original session fence before reconciliation and keeps it on final audit", () => {
    const { database, disposition } = containmentFixture("target_starting");
    disposition("reconciliation_required");
    expect(() => database.query("UPDATE session_switch_attempts SET phase='reconciliation_required',diagnostic_code='MALFORMED_SWITCH_RECORD',updated_at=200").run())
      .toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    database.query("UPDATE sessions SET state='recovery_required',active_turn_id='still-active'").run();
    expect(() => database.query("UPDATE session_switch_attempts SET phase='reconciliation_required',diagnostic_code='MALFORMED_SWITCH_RECORD',updated_at=200").run())
      .toThrow("SESSION_SWITCH_ADOPTION_UNPROVED");
    database.query("UPDATE sessions SET active_turn_id=NULL").run();
    database.query("UPDATE session_switch_attempts SET phase='reconciliation_required',diagnostic_code='MALFORMED_SWITCH_RECORD',updated_at=200").run();
    database.query(`UPDATE mutation_attempts SET state='ambiguous',updated_at=200,
      result_json='{"code":"MALFORMED_SWITCH_RECORD"}'`).run();
    expect(() => auditSessionSwitchAdoption(database)).not.toThrow();
    database.query("UPDATE mutation_attempts SET result_json='{}'").run();
    expect(() => auditSessionSwitchAdoption(database)).toThrow();
    database.query(`UPDATE mutation_attempts SET result_json='{"code":"MALFORMED_SWITCH_RECORD"}',updated_at=100`).run();
    expect(() => auditSessionSwitchAdoption(database)).toThrow();
    database.query("UPDATE mutation_attempts SET updated_at=200").run();
    expect(() => auditSessionSwitchAdoption(database)).not.toThrow();
    database.query("UPDATE sessions SET state='idle'").run();
    expect(() => auditSessionSwitchAdoptionBeforeContainment(database)).toThrow();
    expect(() => auditSessionSwitchAdoption(database)).toThrow();
  });
});
