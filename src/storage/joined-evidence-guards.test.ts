import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import fc from "fast-check";

import { ATTACHMENT_CUSTODY_SCHEMA_OBJECTS } from "./attachment-custody";
import { ATTACHMENT_CUSTODY_COLUMNS } from "./attachment-custody-schema";
import { applyEffectEvidenceProvenance, readMutationEffectEvidenceProvenance, readQueueEffectEvidenceProvenance } from "./effect-evidence-provenance";
import { mutationEvidenceCanonical49Schema, queueEvidenceCanonicalSchema } from "./historical-effect-evidence-codecs";
import { applyJoinedEvidenceGuards, auditJoinedEvidenceGuards, JOINED_EVIDENCE_GUARDS, JOINED_EVIDENCE_PREDECESSOR_GUARDS } from "./joined-evidence-guards";
import { QUEUE_ATTACHMENT_SCHEMA_OBJECTS } from "./queue-attachment-identity";
import { normalizeSchemaSql } from "./schema-cohort";
import { SESSION_SEND_OWNER_SCHEMA_OBJECTS, SESSION_SEND_REQUEST_FORMAT } from "./session-send-owner";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const id = (prefix: string, digit = "a") => `${prefix}_${digit.repeat(32)}`;
const session = id("sess"), profile = id("acct"), attempt = id("attempt"), queue = id("queue");
const key = "00000000-0000-4000-8000-000000000001";
const epoch = "00000000-0000-4000-8000-000000000002";
const failure = "JOINED_EVIDENCE_BOUNDARY_REFUSED";
const source = readFileSync(new URL("./state-store.ts", import.meta.url), "utf8");
// Execute actual frozen target/evidence/authority table DDL and original guards
// without importing StateStore. The cancellation alternative also needs the
// real owner/custody/queue artifact tables, even for a non-cancellation row:
// SQLite resolves its whole predicate before selecting a cleanup proof.
// Unrelated dependencies below are declared minimal projections. This is neither
// a complete migration nor an archived producer capture. Values are synthetic;
// provenance uses the real codec/hash.
function table(name: string): string {
  const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  if (start < 0) throw new Error(`missing real table ${name}`);
  const end = source.indexOf(") STRICT;", start);
  if (end < 0) throw new Error(`missing table terminator ${name}`);
  const sql = source.slice(start, end + ") STRICT;".length)
    .replaceAll("${SESSION_EVENT_MAX_BYTES}", "65536");
  if (sql.includes("${")) throw new Error(`unresolved table template ${name}`);
  return sql;
}
function trigger(name: string): string {
  const match = source.match(new RegExp(`CREATE TRIGGER(?: IF NOT EXISTS)? ${name}\\n[\\s\\S]*?\\nBEGIN SELECT RAISE[^\\n]*END;`));
  if (!match) throw new Error(`missing real trigger ${name}`);
  return match[0];
}
const cancellationArtifactTables = [
  "session_send_owners", "session_send_execution_claims", "session_send_owner_outcomes", "session_send_owner_anchors",
  "attachment_custody_sets", "attachment_custody_anchors", "attachment_custody_dispositions", "attachment_legacy_cleanup_blockers",
  "queue_attachment_identities", "queue_attachment_identity_anchors",
] as const;
const artifactSchemaObjects = [...SESSION_SEND_OWNER_SCHEMA_OBJECTS, ...ATTACHMENT_CUSTODY_SCHEMA_OBJECTS, ...QUEUE_ATTACHMENT_SCHEMA_OBJECTS];
const runtime = { profileId: profile, processGeneration: 1, observedAt: 100, preset: "high",
  model: "gpt-5.6-sol", reasoningEffort: "max", serviceTier: null, fast: false, approvalPolicy: "on-request",
  reviewMode: "auto_review", permissionProfile: ":workspace", computerUse: true, pluginCapability: true, enabledApps: [] };
const baseline = { providerUpdatedAt: 100, status: "active", activeTurnId: "raw-turn" };
type Kind = "send" | "steer" | "queue" | "stop" | "rename";
function fixture(options: { kind?: Kind; actor?: "human" | "peer_session"; format?: Parameters<typeof applyEffectEvidenceProvenance>[1];
  badDigest?: boolean; mutateJson?: (json: string) => string; install?: boolean; generation?: number } = {}) {
  const db = new Database(":memory:", { strict: true }); databases.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE profiles(id TEXT PRIMARY KEY,state TEXT,process_generation INTEGER) STRICT;
    CREATE TABLE provider_accounts(id TEXT PRIMARY KEY,profile_id TEXT,provider TEXT,binding_generation INTEGER,process_generation INTEGER,readiness TEXT) STRICT;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,profile_id TEXT,provider_v39 TEXT,provider_thread_id TEXT,title TEXT,provider_updated_at INTEGER,active_turn_id TEXT) STRICT;
    CREATE TABLE queue_entries(id TEXT PRIMARY KEY,session_id TEXT,state TEXT,transcript_intent_json TEXT,transcript_status TEXT,message_actor TEXT) STRICT;
    CREATE TABLE autorespond_message_sources(session_id TEXT,source_id TEXT) STRICT;
    CREATE TABLE peer_session_actions(id TEXT PRIMARY KEY,idempotency_key TEXT,target_session_id TEXT,delivery TEXT) STRICT;
    CREATE TABLE work_prepared_effects(instruction_json TEXT) STRICT;
    CREATE TABLE interaction_provider_authorities(public_id TEXT,provider_account_id TEXT,profile_id TEXT,provider TEXT,binding_generation INTEGER,process_generation INTEGER) STRICT;
    CREATE TABLE session_runtime_profiles(session_id TEXT,revision INTEGER,source_kind TEXT,source_id TEXT,profile_id TEXT,process_generation INTEGER,profile_json TEXT,PRIMARY KEY(session_id,revision)) STRICT;
    CREATE TABLE session_turn_runtime_profiles(session_id TEXT,turn_id TEXT,source_kind TEXT,source_id TEXT,profile_json TEXT) STRICT;`);
  for (const name of ["mutation_attempts", "mutation_effect_evidence", "queue_effect_evidence", "mutation_resolutions", "queue_effect_resolutions",
    "session_provider_authorities", "mutation_provider_authorities", "queue_provider_authorities",
    "runtime_profile_provider_authorities", "session_event_streams", "session_events", "session_event_provider_authorities",
    "session_message_event_sources", "peer_session_direct_message_sources", "session_provider_authority_successors"]) db.exec(table(name));
  // Actual additive transcript and request-format declarations, plus the
  // exported custody declarations. Leave all optional custody values absent;
  // this fixture does not fabricate an owned send or a cancellation receipt.
  for (const column of [
    "transcript_finalized INTEGER NOT NULL DEFAULT 0 CHECK(transcript_finalized IN (0,1))",
    "transcript_status TEXT NOT NULL DEFAULT 'none' CHECK(transcript_status IN ('none','pending','finalized','unavailable','abandoned'))",
    "transcript_intent_json TEXT CHECK(transcript_intent_json IS NULL OR (json_valid(transcript_intent_json) AND length(CAST(transcript_intent_json AS BLOB))<=65536))",
    `request_format TEXT CHECK(request_format IS NULL OR request_format='${SESSION_SEND_REQUEST_FORMAT}')`,
    ...ATTACHMENT_CUSTODY_COLUMNS,
  ]) db.exec(`ALTER TABLE mutation_attempts ADD COLUMN ${column}`);
  for (const name of cancellationArtifactTables) {
    const object = artifactSchemaObjects.find((candidate) => candidate.type === "table" && candidate.name === name);
    if (object === undefined) throw new Error(`missing real cancellation artifact table ${name}`);
    db.exec(object.sql);
  }
  db.exec("ALTER TABLE session_events ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 2");
  for (const old of JOINED_EVIDENCE_PREDECESSOR_GUARDS) db.exec(old.sql);
  for (const name of ["peer_session_direct_message_source_delete_guard", "session_message_event_source_insert_guard",
    "queue_provider_authorities_insert_guard"]) db.exec(trigger(name));
  const gen = options.generation ?? 1;
  db.query("INSERT INTO profiles VALUES(?,'signed_in',?)").run(profile, gen);
  db.query("INSERT INTO provider_accounts VALUES(?,?,'codex',1,?,'signed_in')").run(profile, profile, gen);
  db.query("INSERT INTO sessions VALUES(?,?,'codex','native-thread','renamed',200,NULL)").run(session, profile);
  db.query("INSERT INTO session_provider_authorities VALUES(?,?,?,'codex',1,?,1,'explicit',NULL,100)").run(session, profile, profile, gen);
  db.query("INSERT INTO session_event_streams VALUES(?,?,1,1,0,0,0,NULL,100,100)").run(session, epoch);
  const kind = options.kind ?? "send", actor = options.actor ?? "human";
  const intent = JSON.stringify({ version: 1, accountId: profile, providerGeneration: 1, providerConnectionId: null,
    actor, text: "synthetic message", omittedCharacters: 0 });
  let raw: string;
  if (kind === "queue") {
    db.query("INSERT INTO queue_entries VALUES(?,?,'applied',?,'pending',?)").run(queue, session, intent, actor);
    raw = JSON.stringify(queueEvidenceCanonicalSchema.parse({ kind: "queue.dispatch", queueId: queue, sessionId: session,
      providerThreadId: "native-thread", profileGeneration: 1, baseline, clientMessageId: queue, messageDigest: hash("synthetic message"), runtimeProfile: runtime }));
    raw = options.mutateJson?.(raw) ?? raw;
    db.query("INSERT INTO queue_effect_evidence VALUES(?,?,?,100)").run(queue, raw, options.badDigest ? "0".repeat(64) : hash(raw));
    db.query("INSERT INTO queue_provider_authorities VALUES(?,?,?,'codex',1,1,'queue_prepare',100)").run(queue, profile, profile);
  } else {
    db.query(`INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,
      state,result_json,created_at,updated_at,transcript_intent_json,transcript_status)
      VALUES(?,?,?, ?,1,?,'applied',?,100,100,?,'pending')`).run(attempt, key, `session.${kind}`, session, hash("request"),
      JSON.stringify(kind === "steer" ? { activeTurnId: "raw-turn" } : { turnId: "raw-turn" }), intent);
    const evidence = kind === "send" ? { kind: "session.send", providerThreadId: "native-thread", baseline,
      clientMessageId: attempt, messageDigest: hash("synthetic message"), runtimeProfile: runtime, messageActor: actor }
      : kind === "steer" ? { kind: "session.steer", providerThreadId: "native-thread", baseline, activeTurnId: "raw-turn",
        clientMessageId: attempt, messageDigest: hash("synthetic message"), messageActor: actor }
        : { kind: `session.${kind}`, providerThreadId: "native-thread", providerTimestampUnit: "unix_milliseconds_v1", baseline,
          ...(kind === "stop" ? { activeTurnId: "raw-turn" } : { requestedName: "renamed" }) };
    raw = JSON.stringify(mutationEvidenceCanonical49Schema.parse(evidence));
    raw = options.mutateJson?.(raw) ?? raw;
    db.query("INSERT INTO mutation_effect_evidence VALUES(?,?,?,?,100)").run(attempt, `session.${kind}`, raw, options.badDigest ? "0".repeat(64) : hash(raw));
    db.query("INSERT INTO mutation_provider_authorities VALUES(?,'primary',?,?,'codex',1,1,'synthetic',100)").run(attempt, profile, profile);
  }
  if (kind === "send" || kind === "queue") {
    const sourceKind = kind === "send" ? "turn_start" : "queue_start", sourceId = kind === "send" ? attempt : queue;
    const parsed = kind === "queue" ? queueEvidenceCanonicalSchema.parse(JSON.parse(raw) as unknown)
      : mutationEvidenceCanonical49Schema.parse(JSON.parse(raw) as unknown);
    if (!("runtimeProfile" in parsed)) throw new Error("fixture runtime missing");
    const canonicalRuntime = JSON.stringify(parsed.runtimeProfile);
    db.query("INSERT INTO session_runtime_profiles VALUES(?,1,?,?,?,1,?)").run(session, sourceKind, sourceId, profile, canonicalRuntime);
    db.query("INSERT INTO session_turn_runtime_profiles VALUES(?,'raw-turn',?,?,?)").run(session, sourceKind, sourceId, canonicalRuntime);
    db.query("INSERT INTO runtime_profile_provider_authorities VALUES(?,1,?,?,'codex',1,1,'runtime_profile',100)").run(session, profile, profile);
  }
  if (actor === "peer_session") db.query(`INSERT INTO peer_session_direct_message_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,100)`)
    .run(key, id("peer"), id("sess", "b"), hash("turn"), id("proj"), session, 1, "send", hash("request"), hash("synthetic message"), hash("reason"));
  db.transaction(() => applyEffectEvidenceProvenance(db, options.format ?? "canonical49_v1")).immediate();
  if (options.install !== false) applyJoinedEvidenceGuards(db);
  return { db, kind, actor, raw };
}
function snapshot(db: Database) {
  const names = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return { schema: db.query("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all(),
    rows: names.map(({ name }) => ({ name, rows: db.query(`SELECT * FROM ${name} ORDER BY rowid`).all() })) };
}
function restart(db: Database, steps: readonly number[] = [1, 2]) {
  let gen = 1, revision = 1;
  for (const step of steps) {
    db.query(`INSERT INTO session_provider_authority_successors VALUES(?,?,?,?,?,? ,1,?,'explicit',NULL,?,?,?,1,?,'explicit',NULL,'provider_restart','synthetic-restart',200)`)
      .run(session, revision, revision + 1, profile, profile, "codex", gen, profile, profile, "codex", gen + step);
    revision += 1; gen += step;
  }
  db.query("UPDATE profiles SET process_generation=? WHERE id=?").run(gen, profile);
  db.query("UPDATE provider_accounts SET process_generation=? WHERE id=?").run(gen, profile);
  db.query("UPDATE session_provider_authorities SET process_generation=?,authority_revision=? WHERE session_id=?").run(gen, revision, session);
}
function eventBody(kind: Kind = "send", actor = "human") {
  return { version: 1, sessionId: session, streamEpoch: epoch, sequence: 1, recordedAt: 300,
    accountId: profile, providerGeneration: 1, providerConnectionId: null,
    body: { type: "user_message", actor, sourceId: kind === "queue" ? queue : key,
      turnId: "public-turn-alias", text: "synthetic message", omittedCharacters: 0 } };
}
function append(db: Database, kind: Kind = "send", actor = "human", historical = true, value = eventBody(kind, actor)) {
  db.transaction(() => {
    const json = JSON.stringify(value);
    db.query("INSERT INTO session_events VALUES(?,?,1,300,?,1,NULL,?,?,2)").run(session, epoch, profile, json, Buffer.byteLength(json));
    db.query("INSERT INTO session_event_provider_authorities VALUES(?,1,?,?,'codex',1,1,?,300)")
      .run(session, profile, profile, historical ? "settled_source" : "session_event");
    db.query(`UPDATE ${kind === "queue" ? "queue_entries" : "mutation_attempts"} SET transcript_status='finalized',transcript_intent_json=? WHERE id=?`)
      .run(JSON.stringify({ version: 1, actor, hadAttachments: false }), kind === "queue" ? queue : attempt);
    db.query("INSERT INTO session_message_event_sources VALUES(?,?,?,?,?,?,1,300)")
      .run(kind === "queue" ? queue : attempt, kind === "queue" ? "queue" : "mutation", session, actor, hash(JSON.stringify(value.body)), epoch);
  }).immediate();
}

describe("joined source-selected SQL evidence boundaries", () => {
  test("frozen predecessor literals match source; exact installation is idempotent and row-preserving", () => {
    for (const old of JOINED_EVIDENCE_PREDECESSOR_GUARDS) expect(source).toContain(old.sql);
    const { db } = fixture({ install: false }); const before = snapshot(db).rows;
    applyJoinedEvidenceGuards(db); expect(snapshot(db).rows).toEqual(before);
    const installed = snapshot(db); applyJoinedEvidenceGuards(db); expect(snapshot(db)).toEqual(installed);
    expect(() => auditJoinedEvidenceGuards(db)).not.toThrow();
    expect(JOINED_EVIDENCE_GUARDS.every(Object.isFrozen)).toBe(true);
  });

  test.each(["missing", "changed", "mixed", "extra"] as const)("refuses %s predecessor state without partial replacement", (mode) => {
    const { db } = fixture({ install: false });
    const first = JOINED_EVIDENCE_PREDECESSOR_GUARDS[0]; if (!first) throw new Error("fixture guard missing");
    if (mode !== "extra") db.exec(`DROP TRIGGER ${first.name}`);
    if (mode === "changed") db.exec(first.sql.replace("a.process_generation=NEW.provider_generation", "1=1"));
    if (mode === "mixed") db.exec(JOINED_EVIDENCE_GUARDS[0]?.sql ?? "");
    if (mode === "extra") db.exec("CREATE TRIGGER joined_evidence_boundary_foreign BEFORE INSERT ON sessions BEGIN SELECT 1; END");
    const before = snapshot(db); expect(() => applyJoinedEvidenceGuards(db)).toThrow("JOINED_EVIDENCE_BOUNDARY_SCHEMA_INVALID");
    expect(snapshot(db)).toEqual(before);
  });

  test.each(["send", "steer", "queue"] as const)("allows current and exact restart-only historical %s source without rewriting its tuple", (kind) => {
    const current = fixture({ kind }); expect(() => append(current.db, kind, "human", false)).not.toThrow();
    const old = fixture({ kind, install: false }); restart(old.db);
    expect(() => append(old.db, kind)).toThrow("session event account authority mismatch");
    const f = fixture({ kind }); restart(f.db);
    const evidence = f.db.query(`SELECT * FROM ${kind === "queue" ? "queue" : "mutation"}_effect_evidence`).all();
    expect(() => append(f.db, kind)).not.toThrow();
    expect(f.db.query("SELECT provider_generation FROM session_events").get()).toEqual({ provider_generation: 1 });
    expect(f.db.query("SELECT process_generation,provenance FROM session_event_provider_authorities").get())
      .toEqual({ process_generation: 1, provenance: "settled_source" });
    expect(f.db.query(`SELECT * FROM ${kind === "queue" ? "queue" : "mutation"}_effect_evidence`).all()).toEqual(evidence);
  });

  test.each(["gap", "switch", "delta", "binding", "routing", "pointer", "thread", "current", "runtime", "turn", "receipt", "actor", "source", "header"] as const)(
    "refuses historical %s mismatch atomically", (mode) => {
      const f = fixture(); restart(f.db); const db = f.db; const value = eventBody();
      if (mode === "gap") db.exec("DELETE FROM session_provider_authority_successors WHERE from_authority_revision=1");
      if (mode === "switch") db.exec("UPDATE session_provider_authority_successors SET transition_kind='session_switch' WHERE from_authority_revision=1");
      if (mode === "delta") db.exec("UPDATE session_provider_authority_successors SET from_process_generation=0 WHERE from_authority_revision=2");
      if (mode === "binding") db.exec("UPDATE session_provider_authority_successors SET from_binding_generation=2 WHERE from_authority_revision=1");
      if (mode === "routing") db.exec("UPDATE session_provider_authority_successors SET from_routing_provenance='managed' WHERE from_authority_revision=1");
      if (mode === "pointer") db.exec("UPDATE session_provider_authority_successors SET from_applied_pointer_revision=1 WHERE from_authority_revision=1");
      if (mode === "thread") db.exec("UPDATE sessions SET provider_thread_id='other-thread'");
      if (mode === "current") db.exec("UPDATE provider_accounts SET process_generation=5");
      if (mode === "runtime") db.exec("UPDATE runtime_profile_provider_authorities SET binding_generation=2");
      if (mode === "turn") db.exec("UPDATE session_turn_runtime_profiles SET source_id='other-source'");
      if (mode === "receipt") db.exec(`UPDATE mutation_attempts SET result_json='{"turnId":"other"}'`);
      if (mode === "actor") value.body.actor = "peer_session";
      if (mode === "source") value.body.sourceId = "foreign-key";
      if (mode === "header") value.providerGeneration = 2;
      const before = snapshot(db); expect(() => append(db, "send", "human", true, value)).toThrow(failure); expect(snapshot(db)).toEqual(before);
    });

  test.each(["wrong-format", "digest", "duplicate"] as const)("raw actor %s cannot replace retained peer custody", (mode) => {
    const options = { actor: "peer_session" as const, format: mode === "wrong-format" ? "combined49_v1" as const : "canonical49_v1" as const,
      badDigest: mode === "digest", ...(mode === "duplicate" ? { mutateJson: (json: string) => '{"messageActor":"peer_session",' + json.slice(1) } : {}) };
    const old = fixture({ ...options, install: false });
    expect(() => old.db.query("DELETE FROM peer_session_direct_message_sources WHERE idempotency_key=?").run(key)).not.toThrow();
    const f = fixture(options); expect(readMutationEffectEvidenceProvenance(f.db, attempt).kind).toBe("opaque");
    const before = snapshot(f.db); expect(() => f.db.query("DELETE FROM peer_session_direct_message_sources WHERE idempotency_key=?").run(key)).toThrow(failure);
    expect(snapshot(f.db)).toEqual(before);
  });

  test.each(["parsed", "failed", "cancelled", "abandoned", "event"] as const)("preserves independent peer cleanup: %s", (mode) => {
    const f = fixture({ actor: "peer_session", format: mode === "parsed" ? "canonical49_v1" : "combined49_v1", install: mode !== "event" });
    if (mode === "failed" || mode === "cancelled") f.db.query("UPDATE mutation_attempts SET state=? WHERE id=?").run(mode, attempt);
    if (mode === "abandoned") f.db.query("INSERT INTO mutation_resolutions VALUES(?,'abandoned','{}',NULL,200)").run(attempt);
    if (mode === "event") {
      // A genuinely retained pre-join marker is an independent cleanup proof;
      // the old-format collision stays opaque and cannot satisfy parsed proof.
      append(f.db, "send", "peer_session", false);
      expect(readMutationEffectEvidenceProvenance(f.db, attempt).kind).toBe("opaque");
      applyJoinedEvidenceGuards(f.db);
    }
    const before = snapshot(f.db);
    expect(f.db.query("DELETE FROM peer_session_direct_message_sources WHERE idempotency_key=?").run(key).changes).toBe(1);
    expect(snapshot(f.db)).toEqual({ ...before, rows: before.rows.map((table) => table.name === "peer_session_direct_message_sources"
      ? { ...table, rows: [] } : table) });
  });

  test.each(["send", "queue"] as const)("source marker cannot use opaque %s evidence despite matching current scalar/event tuple", (kind) => {
    const f = fixture({ kind, badDigest: true });
    const before = snapshot(f.db); expect(() => append(f.db, kind, "human", false)).toThrow(failure); expect(snapshot(f.db)).toEqual(before);
  });

  test.each(["send", "queue"] as const)("%s authority requires its exact retained provenance anchor and metadata", (kind) => {
    for (const mutation of ["missing-anchor", "metadata"] as const) {
      const f = fixture({ kind });
      const scope = kind === "queue" ? "queue" : "mutation";
      const tableName = `${scope}_effect_evidence_provenance${mutation === "missing-anchor" ? "_anchors" : ""}`;
      const guardName = `${tableName}_${mutation === "missing-anchor" ? "delete" : "update"}`;
      const guard = f.db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name=?").get(guardName);
      if (guard === null) throw new Error("fixture immutable guard missing");
      const schema = snapshot(f.db).schema;
      // Commit deliberate corruption and restore the exact admission guards
      // before either selected reader or authority write sees the fixture.
      f.db.exec("PRAGMA foreign_keys=OFF");
      f.db.transaction(() => {
        f.db.exec(`DROP TRIGGER ${guardName}`);
        if (mutation === "missing-anchor") f.db.exec(`DELETE FROM ${tableName}`);
        else f.db.exec(`UPDATE ${tableName} SET recorded_at_decimal='101'`);
        f.db.exec(guard.sql);
      }).immediate();
      f.db.exec("PRAGMA foreign_keys=ON");
      expect(snapshot(f.db).schema).toEqual(schema);
      expect(f.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(() => kind === "queue" ? readQueueEffectEvidenceProvenance(f.db, queue)
        : readMutationEffectEvidenceProvenance(f.db, attempt)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
      const before = snapshot(f.db);
      expect(() => append(f.db, kind, "human", false)).toThrow(failure);
      expect(snapshot(f.db)).toEqual(before);
    }
  });

  test.each(["runtime", "turn"] as const)("new historical projection refuses noncanonical %s runtime bytes without rewriting readable history", (kind) => {
    const f = fixture(); restart(f.db);
    const name = kind === "runtime" ? "session_runtime_profiles" : "session_turn_runtime_profiles";
    const row = f.db.query<{ profile_json: string }, []>(`SELECT profile_json FROM ${name}`).get();
    if (row === null) throw new Error("fixture runtime missing");
    const spaced = JSON.stringify(JSON.parse(row.profile_json) as unknown, null, 2);
    expect(JSON.parse(spaced) as unknown).toEqual(JSON.parse(row.profile_json) as unknown);
    f.db.query(`UPDATE ${name} SET profile_json=?`).run(spaced);
    const before = snapshot(f.db);
    expect(() => append(f.db)).toThrow(failure);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("queue resolution pins a receipt turn while normal applied queue needs no fabricated receipt", () => {
    for (const turnId of ["raw-turn", "wrong-turn"]) {
      const f = fixture({ kind: "queue" }); restart(f.db);
      f.db.query("UPDATE queue_entries SET state='ambiguous' WHERE id=?").run(queue);
      f.db.query("INSERT INTO queue_effect_resolutions VALUES(?,'proven_applied','{}',?,200)")
        .run(queue, JSON.stringify({ turnId }));
      const before = snapshot(f.db);
      if (turnId === "raw-turn") expect(() => append(f.db, "queue")).not.toThrow();
      else { expect(() => append(f.db, "queue")).toThrow(failure); expect(snapshot(f.db)).toEqual(before); }
    }
  });

  test("queue runtime sidecar requires parsed provenance but queue_prepare remains independent", () => {
    for (const badDigest of [false, true]) {
      const f = fixture({ kind: "queue", badDigest });
      f.db.query("DELETE FROM queue_provider_authorities WHERE queue_id=?").run(queue);
      expect(readQueueEffectEvidenceProvenance(f.db, queue).kind).toBe(badDigest ? "opaque" : "parsed");
      const insert = (provenance: string) => f.db.query("INSERT INTO queue_provider_authorities VALUES(?,?,?,'codex',1,1,?,100)").run(queue, profile, profile, provenance);
      if (badDigest) { const before = snapshot(f.db); expect(() => insert("legacy_queue_runtime")).toThrow(failure); expect(snapshot(f.db)).toEqual(before); }
      else expect(() => insert("queue_runtime")).not.toThrow();
      if (badDigest) expect(() => insert("queue_prepare")).not.toThrow();
    }
  });

  test.each(["stop", "rename"] as const)("timestamp %s proof respects historical format selection", (kind) => {
    for (const format of ["canonical41_v1", "canonical_sol43_v1", "canonical49_v1", "combined49_v1"] as const) {
      const f = fixture({ kind, format });
      const start = source.indexOf("const timestampMutationResolutionGuard = `");
      const end = source.indexOf("`;", start);
      f.db.exec(source.slice(start + "const timestampMutationResolutionGuard = `".length, end));
      const evidence = { kind: `session.${kind}`, providerThreadId: "native-thread", providerTimestampUnit: "unix_milliseconds_v1",
        providerUpdatedAt: 200, ...(kind === "stop" ? { activeTurnId: "raw-turn", observedStatus: "completed" } : { requestedName: "renamed" }) };
      const receipt = kind === "stop" ? { stopped: true, activeTurnId: "raw-turn" } : { renamed: true };
      const insert = () => f.db.query("INSERT INTO mutation_resolutions VALUES(?,'proven_applied',?,?,200)").run(attempt, JSON.stringify(evidence), JSON.stringify(receipt));
      if (format === "combined49_v1") { const before = snapshot(f.db); expect(() => insert()).toThrow(failure); expect(snapshot(f.db)).toEqual(before); }
      else expect(() => insert()).not.toThrow();
    }
  });

  test("seeded finite restart chains retain exact authority and reject a causal middle switch", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(1, 2), { minLength: 1, maxLength: 8 }), (steps) => {
      const f = fixture({ kind: "steer" }); restart(f.db, steps);
      expect(() => append(f.db, "steer")).not.toThrow();
      const bad = fixture({ kind: "steer" }); restart(bad.db, steps);
      bad.db.query("UPDATE session_provider_authority_successors SET transition_kind='legacy_switch' WHERE from_authority_revision=?").run(Math.ceil(steps.length / 2));
      const before = snapshot(bad.db); expect(() => append(bad.db, "steer")).toThrow(failure); expect(snapshot(bad.db)).toEqual(before);
    }), { seed: 91107, numRuns: 12 });
  });

  test("audit detects foreign appended guard definitions", () => {
    const f = fixture(); const guard = JOINED_EVIDENCE_GUARDS.at(-1); if (!guard) throw new Error("fixture guard missing");
    expect(normalizeSchemaSql(guard.sql)).not.toBe("");
    f.db.exec(`DROP TRIGGER ${guard.name}`);
    f.db.exec(`CREATE TRIGGER ${guard.name} BEFORE INSERT ON mutation_resolutions BEGIN SELECT 1; END`);
    expect(() => auditJoinedEvidenceGuards(f.db)).toThrow("JOINED_EVIDENCE_BOUNDARY_SCHEMA_INVALID");
  });
});
