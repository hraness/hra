import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { syntheticAdoption36SchemaFixture, syntheticAdoption36SchemaObjects } from "./synthetic-adoption36-schema";

// Supplemental SQL contract evidence only. These deterministic rows were NOT
// emitted by an adoption-v36 writer. No original capture is modified and no
// provider, native process, runtime profile, turn, or outcome receipt is made.
export const syntheticAdoption36 = {
  kind: "synthetic_adoption_v36_recognizer_contract",
  historicalWriterProvenance: false,
  fixedTime: 1_000,
  migratedAt: 2_000,
  launchProfileId: `acct_${"1".repeat(32)}`,
  invalidProfileId: `acct_${"2".repeat(32)}`,
  unaffectedProfileId: `acct_${"3".repeat(32)}`,
  projectId: `proj_${"4".repeat(32)}`,
  launchSessionId: `sess_${"5".repeat(32)}`,
  malformedSessionId: `sess_${"6".repeat(32)}`,
  revokedSessionId: `sess_${"7".repeat(32)}`,
  unaffectedSessionId: `sess_${"8".repeat(32)}`,
  launchId: "00000000-0000-4000-8000-000000000036",
  queueId: `queue_${"9".repeat(32)}`,
  mutationId: `attempt_${"a".repeat(32)}`,
  mutationKey: "00000000-0000-4000-8000-000000000136",
  taskId: `stask_${"b".repeat(32)}`,
  interactionId: "00000000-0000-4000-8000-000000000236",
  connectionId: "00000000-0000-4000-8000-000000000336",
  accountKey: `v1:claude:${"c".repeat(64)}`,
  candidateThread: "synthetic-adoption36-retained-candidate",
  candidateTitle: "Synthetic adoption36 candidate",
  sourceProcessIdentity: { pid: 41_036, pidDomain: "darwin", procStart: "synthetic-adoption36-process" },
  queueMessage: "Synthetic contract queued message",
  renameRequest: { name: "Synthetic contract prepared rename" },
  taskPrompt: "Synthetic pending work; never dispatch it.",
  display: {
    kind: "command_approval", summary: "Synthetic contract approval", reason: null,
    commandClass: "test", workingDirectory: null, availableDecisions: ["once", "decline", "cancel"],
  },
} as const;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const syntheticAdoption36CandidateFingerprint = digest(JSON.stringify({
  provider: "claude", providerThreadId: syntheticAdoption36.candidateThread, projectId: null,
  title: syntheticAdoption36.candidateTitle, providerState: "terminal", activeTurnId: null,
  providerUpdatedAt: 10, sourceProcessIdentity: syntheticAdoption36.sourceProcessIdentity,
}));

export function installSyntheticAdoption36Fixture(database: Database, scenario: "launch" | "quarantine"): void {
  assert.deepEqual(database.query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all(), []);
  assert.deepEqual(database.query("PRAGMA user_version").get(), { user_version: 0 });
  database.exec("PRAGMA foreign_keys=ON");
  const objects = syntheticAdoption36SchemaObjects();
  // Preserve the frozen SQLite declaration/ALTER spelling; only the order of
  // creation is grouped so all referenced tables precede indexes and triggers.
  for (const type of ["table", "index", "trigger"] as const) {
    for (const object of objects.filter((object) => object.type === type)) database.exec(object.sql);
  }
  const schema = database.query(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
  ).all();
  assert.equal(digest(JSON.stringify(schema)), syntheticAdoption36SchemaFixture.schemaSha256);
  database.transaction(() => {
    database.query("INSERT INTO daemon_state(singleton,generation) VALUES(1,0)").run();
    database.query("INSERT INTO desktop_switch_authority(singleton,current_generation) VALUES(1,0)").run();
    database.query("INSERT INTO work_clock(singleton,logical_time) VALUES(1,0)").run();
    database.query("INSERT INTO queue_sequence_authority(singleton,next_sequence) VALUES(1,?)")
      .run(scenario === "quarantine" ? 2 : 1);
    // This ledger is a synthetic recognizer input, not an archived history.
    for (let version = 1; version <= 36; version++) {
      database.query("INSERT INTO migrations(version,applied_at) VALUES(?,?)")
        .run(version, syntheticAdoption36.fixedTime);
    }
    database.query("INSERT INTO projects(id,label,label_key,root_path,is_default,created_at,updated_at) VALUES(?,?,?, ?,1,?,?)")
      .run(syntheticAdoption36.projectId, "synthetic adoption36", "synthetic adoption36",
        "/opt/hra-fixtures/adoption36", syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime);
    const profile = (id: string, label: string, signedIn: boolean): void => {
      const email = signedIn ? `${label.replaceAll(" ", "-")}@example.com` : null;
      database.query(`INSERT INTO profiles(id,label,label_key,state,process_generation,provider_email,
        provider_plan,created_at,updated_at,codex_account_key) VALUES(?,?,?,?,1,?,?,?,?,?)`)
        .run(id, label, label, signedIn ? "signed_in" : "signed_out", email, signedIn ? "Plus" : null,
          syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime, email === null ? null : `v1:codex:${digest(email)}`);
      database.query(`INSERT INTO account_rate_limit_reset_policies(
        profile_id,state,account_fingerprint,weekly_window_resets_at,revision,created_at,updated_at)
        VALUES(?,'active_unbound',NULL,NULL,1,?,?)`)
        .run(id, syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime);
      database.query("INSERT INTO usage_revision_authority(profile_id,next_revision) VALUES(?,0)").run(id);
    };
    const session = (id: string, profileId: string, thread: string): void => {
      database.query(`INSERT INTO sessions(id,profile_id,project_id,provider_thread_id,title,provider,preset,
        fast_enabled,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,'claude','ultra',0,'idle',1,?,?)`)
        .run(id, profileId, syntheticAdoption36.projectId, thread, thread,
          syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime);
      // A syntactically valid legacy key models only the old recognizer's row
      // contract. There is deliberately no immutable runtime-profile witness.
      database.query(`INSERT INTO session_provider_account_authorities(
        session_id,provider,runtime_scope,account_key,recorded_at) VALUES(?,'claude','managed',?,?)`)
        .run(id, syntheticAdoption36.accountKey, syntheticAdoption36.fixedTime);
    };
    if (scenario === "launch") {
      profile(syntheticAdoption36.launchProfileId, "synthetic launch", true);
      session(syntheticAdoption36.launchSessionId, syntheticAdoption36.launchProfileId, "synthetic-adoption36-launch");
      database.query(`INSERT INTO session_claude_process_launch_intents(intent_id,provider_thread_id,
        profile_id,profile_generation,runtime_scope,provider_account_key,session_id,revision,staged_at,updated_at)
        VALUES(?,?,?,1,'managed',?,?,1,?,?)`)
        .run(syntheticAdoption36.launchId, "synthetic-adoption36-launch", syntheticAdoption36.launchProfileId,
          syntheticAdoption36.accountKey, syntheticAdoption36.launchSessionId,
          syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime);
    } else {
      profile(syntheticAdoption36.invalidProfileId, "synthetic invalid", true);
      profile(syntheticAdoption36.unaffectedProfileId, "synthetic unaffected", false);
      session(syntheticAdoption36.malformedSessionId, syntheticAdoption36.invalidProfileId, "synthetic-adoption36-malformed");
      session(syntheticAdoption36.revokedSessionId, syntheticAdoption36.invalidProfileId, "synthetic-adoption36-revoked");
      session(syntheticAdoption36.unaffectedSessionId, syntheticAdoption36.unaffectedProfileId, "synthetic-adoption36-unaffected");
      database.query(`INSERT INTO queue_entries(id,session_id,message,state,created_at,updated_at,enqueue_sequence)
        VALUES(?,?,?,'pending',?,?,1)`)
        .run(syntheticAdoption36.queueId, syntheticAdoption36.malformedSessionId, syntheticAdoption36.queueMessage,
          syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime);
      database.query(`INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,
        request_digest,state,created_at,updated_at) VALUES(?,?,'session.rename',?,1,?,'prepared',?,?)`)
        .run(syntheticAdoption36.mutationId, syntheticAdoption36.mutationKey, syntheticAdoption36.malformedSessionId,
          digest(JSON.stringify(syntheticAdoption36.renameRequest)), syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime);
      database.query(`INSERT INTO session_tasks(id,session_id,name,prompt,schedule_kind,interval_minutes,
        status,revision,next_due_at,created_at,updated_at) VALUES(?,?,?,?,'interval_minutes',15,'active',1,?,?,?)`)
        .run(syntheticAdoption36.taskId, syntheticAdoption36.malformedSessionId, "synthetic active task",
          syntheticAdoption36.taskPrompt, syntheticAdoption36.fixedTime + 900_000,
          syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime);
      database.query(`INSERT INTO provider_interactions(public_id,session_id,profile_id,process_generation,
        connection_id,request_id_type,request_id_text,method,request_digest,thread_id,turn_id,item_id,
        kind,state,revision,blocking,display_json,requested_at,updated_at,deadline_at)
        VALUES(?,?,?,1,?,'string','synthetic-adoption36-request','claude/control_request/can_use_tool',
        ?,'synthetic-adoption36-malformed','synthetic-turn','synthetic-item','command_approval','pending',1,1,?,?,?,?)`)
        .run(syntheticAdoption36.interactionId, syntheticAdoption36.malformedSessionId, syntheticAdoption36.invalidProfileId,
          syntheticAdoption36.connectionId, digest("synthetic-adoption36-request"), JSON.stringify(syntheticAdoption36.display),
          syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime + 900_000);
    }
    database.query(`INSERT INTO session_adoption_candidates(provider,provider_thread_id,title,provider_state,
      provider_updated_at,liveness,source_pid,source_pid_domain,source_proc_start,claim_status,candidate_fingerprint,
      revision,first_discovered_at,last_observed_at,last_changed_at)
      VALUES('claude',?,?,'terminal',10,'live',?,'darwin',?,'pending',?,1,?,?,?)`)
      .run(syntheticAdoption36.candidateThread, syntheticAdoption36.candidateTitle,
        syntheticAdoption36.sourceProcessIdentity.pid, syntheticAdoption36.sourceProcessIdentity.procStart,
        syntheticAdoption36CandidateFingerprint, syntheticAdoption36.fixedTime,
        syntheticAdoption36.fixedTime, syntheticAdoption36.fixedTime);
    database.exec("PRAGMA user_version=36");
  }).immediate();
  assert.deepEqual(database.query("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(database.query("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
  for (const table of ["session_runtime_profiles", "mutation_effect_evidence", "queue_effect_evidence",
    "session_claude_process_authorities", "session_personal_runtime_bindings"]) {
    assert.deepEqual(database.query(`SELECT * FROM ${table}`).all(), []);
  }
}
