import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";

import { decodeMutationEvidence, historicalEffectEvidenceFormatSchema } from "./effect-evidence-reader";
import {
  applyEffectEvidenceProvenance, assertEffectEvidenceProvenanceSchema, auditEffectEvidenceProvenance,
  EFFECT_EVIDENCE_PROVENANCE_MAX_RAW_BYTES, EFFECT_EVIDENCE_PROVENANCE_TABLES_BY_SCOPE,
  insertJoinedMutationEffectEvidence, insertJoinedQueueEffectEvidence,
  readMutationEffectEvidenceProvenance, readQueueEffectEvidenceProvenance,
  type EffectEvidenceOpaqueReason,
} from "./effect-evidence-provenance";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const error = "EFFECT_EVIDENCE_PROVENANCE_CORRUPT";
const hash = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");
const attempt = (index = 1) => `attempt_${index.toString(16).padStart(32, "0")}`;
const queue = (index = 1) => `queue_${index.toString(16).padStart(32, "0")}`;
const sessionId = `sess_${"a".repeat(32)}`;
const profileId = `acct_${"b".repeat(32)}`;
const baseline = () => ({ providerUpdatedAt: null, status: "idle", activeTurnId: null });
const runtime = () => ({ profileId, processGeneration: 1, observedAt: 100,
  preset: "fable-max", model: "claude-fable-5-1", reasoningEffort: "max", claudeVersion: "2.1.260",
  permissionMode: "default", isolatedConfigDir: true, outputFormat: "stream-json", inputFormat: "stream-json" });
const stop = () => ({ kind: "session.stop", providerThreadId: "retained-thread", baseline: baseline(), activeTurnId: null });
const queueEvidence = (index = 1) => ({ kind: "queue.dispatch", queueId: queue(index), sessionId,
  providerThreadId: "retained-thread", profileGeneration: 1, baseline: baseline(), clientMessageId: "client-message",
  messageDigest: "c".repeat(64), runtimeProfile: runtime() });

// A synthetic component fixture with the exact fields/constraints consumed by
// provenance. These are not archived provider effects or a StateStore upgrade.
function fixture(path = ":memory:"): Database {
  const database = new Database(path, { strict: true }); databases.push(database);
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,provider_thread_id TEXT,profile_generation INTEGER) STRICT;
    CREATE TABLE mutation_attempts(id TEXT PRIMARY KEY,kind TEXT NOT NULL,
      authority_id TEXT NOT NULL,authority_generation INTEGER NOT NULL CHECK(authority_generation>=0)) STRICT;
    CREATE TABLE queue_entries(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id)) STRICT;
    CREATE TABLE mutation_effect_evidence(attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
      kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
      evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
      evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),recorded_at INTEGER NOT NULL CHECK(recorded_at>=0)) STRICT;
    CREATE TABLE queue_effect_evidence(queue_id TEXT PRIMARY KEY REFERENCES queue_entries(id),
      evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
      evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),recorded_at INTEGER NOT NULL CHECK(recorded_at>=0)) STRICT;
    CREATE TABLE mutation_resolutions(attempt_id TEXT PRIMARY KEY,resolution_kind TEXT,evidence_json TEXT) STRICT;
    CREATE TABLE queue_effect_resolutions(queue_id TEXT PRIMARY KEY,resolution_kind TEXT,evidence_json TEXT) STRICT;`);
  for (const table of ["mutation_effect_evidence", "queue_effect_evidence", "mutation_resolutions", "queue_effect_resolutions"]) {
    for (const verb of ["UPDATE", "DELETE"]) database.exec(`CREATE TRIGGER ${table}_immutable_${verb.toLowerCase()}
      BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(ABORT,'original evidence immutable'); END;`);
  }
  database.query("INSERT INTO sessions VALUES(?,'retained-thread',1)").run(sessionId);
  return database;
}
function mutationParent(database: Database, kind = "session.stop", index = 1): void {
  database.query("INSERT INTO mutation_attempts VALUES(?,?,?,1)").run(attempt(index), kind, sessionId);
}
function queueParent(database: Database, index = 1): void {
  database.query("INSERT INTO queue_entries VALUES(?,?)").run(queue(index), sessionId);
}
function retainMutation(database: Database, json = JSON.stringify(stop()), index = 1,
  storedDigest = hash(json), kind = "session.stop", parentKind = kind): void {
  mutationParent(database, parentKind, index);
  database.query("INSERT INTO mutation_effect_evidence VALUES(?,?,CAST(? AS TEXT),?,100)")
    .run(attempt(index), kind, Buffer.from(json), storedDigest);
}
function retainQueue(database: Database, json = JSON.stringify(queueEvidence()), index = 1, storedDigest = hash(json)): void {
  queueParent(database, index);
  database.query("INSERT INTO queue_effect_evidence VALUES(?,CAST(? AS TEXT),?,100)").run(queue(index), Buffer.from(json), storedDigest);
}
function install(database: Database, format: Parameters<typeof applyEffectEvidenceProvenance>[1] = "combined49_v1"): void {
  database.transaction(() => { applyEffectEvidenceProvenance(database, format); }).immediate();
}
function audit(database: Database): void { database.transaction(() => { auditEffectEvidenceProvenance(database); }).deferred(); }
function snapshot(database: Database): unknown {
  const names = database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return { schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(),
    rows: names.map(({ name }) => ({ name, rows: database.query(`SELECT * FROM ${name} ORDER BY rowid`).all() })),
    changes: database.query("SELECT total_changes() AS changes").get() };
}
function originalEvidence(database: Database): unknown {
  return {
    mutations: database.query("SELECT attempt_id,kind,hex(CAST(evidence_json AS BLOB)) AS bytes,evidence_digest,CAST(recorded_at AS TEXT) AS time FROM mutation_effect_evidence ORDER BY attempt_id").all(),
    queues: database.query("SELECT queue_id,hex(CAST(evidence_json AS BLOB)) AS bytes,evidence_digest,CAST(recorded_at AS TEXT) AS time FROM queue_effect_evidence ORDER BY queue_id").all(),
    mutationResolutions: database.query("SELECT * FROM mutation_resolutions ORDER BY attempt_id").all(),
    queueResolutions: database.query("SELECT * FROM queue_effect_resolutions ORDER BY queue_id").all(),
  };
}
function corrupt(database: Database, operation: () => void): void {
  const triggers = database.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as { name: string; sql: string }[];
  database.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
  database.transaction(() => {
    for (const trigger of triggers) database.exec(`DROP TRIGGER ${trigger.name}`);
    operation();
    for (const trigger of triggers) database.exec(trigger.sql);
  }).immediate();
  database.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
  assertEffectEvidenceProvenanceSchema(database);
}

describe("source-selected immutable effect evidence provenance", () => {
  test("Sol43 preset fields retain their selected dialect without accepting later actors", () => {
    const json = '{"kind":"session.start","projectId":"proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clientMessageId":null,"messageDigest":null,"presetContract":1}';
    const actor = { kind: "session.steer", providerThreadId: "thread", baseline: baseline(),
      activeTurnId: null, clientMessageId: "message", messageDigest: "a".repeat(64), messageActor: "human" };
    const database = fixture();
    retainMutation(database, json, 1, hash(json), "session.start");
    retainMutation(database, JSON.stringify(actor), 2, hash(JSON.stringify(actor)), "session.steer");
    const original = originalEvidence(database);
    install(database, "canonical_sol43_v1");
    const before = snapshot(database);
    expect(readMutationEffectEvidenceProvenance(database, attempt(1))).toMatchObject({
      kind: "parsed", format: "canonical_sol43_v1", canonicalJson: json, digest: hash(json),
    });
    expect(readMutationEffectEvidenceProvenance(database, attempt(2))).toEqual({
      kind: "opaque", format: "canonical_sol43_v1", reason: "invalid_shape",
    });
    audit(database);
    expect(snapshot(database)).toEqual(before);
    expect(originalEvidence(database)).toEqual(original);
  });

  test("every historical format binds both scopes and leaves original effects/resolutions unchanged", () => {
    for (const format of historicalEffectEvidenceFormatSchema.options) {
      const database = fixture(); retainMutation(database); retainQueue(database);
      database.query("INSERT INTO mutation_resolutions VALUES(?,'abandoned','{}')").run(attempt());
      database.query("INSERT INTO queue_effect_resolutions VALUES(?,'abandoned','{}')").run(queue());
      const original = originalEvidence(database);
      install(database, format);
      expect(originalEvidence(database)).toEqual(original);
      const before = snapshot(database);
      expect(readMutationEffectEvidenceProvenance(database, attempt())).toMatchObject({ kind: "parsed", format, digest: hash(JSON.stringify(stop())), recordedAt: 100 });
      expect(readQueueEffectEvidenceProvenance(database, queue())).toMatchObject({ kind: "parsed", format, digest: hash(JSON.stringify(queueEvidence())), recordedAt: 100 });
      audit(database);
      expect(snapshot(database)).toEqual(before);
    }
  });

  test("all eleven mutation kinds receive explicit provenance, including retired decode without effect authority", () => {
    const values = [
      { kind: "session.send", providerThreadId: "thread", baseline: baseline(), clientMessageId: "message", messageDigest: "a".repeat(64) },
      { kind: "session.steer", providerThreadId: "thread", baseline: baseline(), activeTurnId: null, clientMessageId: "message", messageDigest: "a".repeat(64) },
      stop(), { kind: "session.rename", providerThreadId: "thread", baseline: baseline(), requestedName: "Title" },
      { kind: "session.start", projectId: `proj_${"a".repeat(32)}`, clientMessageId: null, messageDigest: null },
      { kind: "session.switch", requestedAccountId: null, requestedPreset: null, sourceProfileId: profileId,
        sourceProcessGeneration: 1, sourceProvider: "codex", sourceProviderThreadId: "source", sourcePreset: "high",
        targetProfileId: profileId, targetProcessGeneration: 1, targetProvider: "claude", targetPreset: "fable-max",
        transcriptDigest: "c".repeat(64), seedDigest: "d".repeat(64), seedIncludedRecords: 1, seedOmittedRecords: 0, runtimeProfile: runtime() },
      { kind: "account.login", method: "browser" }, { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
      { kind: "account.devin-login", provider: "devin", baselineSignedIn: false }, { kind: "account.logout", baselineSignedIn: true },
      { kind: "account.login-cancel", loginId: "login-one" },
    ];
    const database = fixture();
    for (const [index, value] of values.entries()) retainMutation(database, JSON.stringify(value), index + 1, hash(JSON.stringify(value)), value.kind);
    install(database);
    for (let index = 1; index <= values.length; index++) expect(readMutationEffectEvidenceProvenance(database, attempt(index)).kind).toBe("parsed");
    expect(database.query("SELECT COUNT(*) AS count FROM mutation_effect_evidence_provenance").get()).toEqual({ count: 11 });
  });

  test("a selected old format never probes a newer timestamp or actor codec", () => {
    const value = { kind: "session.stop", providerThreadId: "thread", providerTimestampUnit: "unix_milliseconds_v1", baseline: baseline(), activeTurnId: null };
    for (const [format, expected] of [["combined49_v1", "opaque"], ["canonical49_v1", "parsed"]] as const) {
      const database = fixture(); retainMutation(database, JSON.stringify(value)); install(database, format);
      expect(readMutationEffectEvidenceProvenance(database, attempt()).kind).toBe(expected);
      if (expected === "opaque") expect(database.query("SELECT projection_json,opaque_reason FROM mutation_effect_evidence_provenance").get())
        .toEqual({ projection_json: null, opaque_reason: "invalid_shape" });
    }
  });

  test("closed opaque reasons preserve invalid JSON/shape/digest/kinds and never store a projection", () => {
    const canonical = JSON.stringify(stop());
    const scenarios: readonly { json: string; digest: string; kind?: string;
      parentKind?: string; reason: EffectEvidenceOpaqueReason }[] = [
      { json: "{?", digest: hash("{?"), reason: "invalid_json" },
      { json: "{}", digest: hash("{}"), reason: "invalid_shape" },
      { json: canonical, digest: "Z".repeat(64), reason: "invalid_digest" },
      { json: canonical, digest: "e".repeat(64), reason: "digest_mismatch" },
      { json: canonical, digest: hash(canonical), kind: "session.rename", reason: "kind_mismatch" },
      { json: canonical, digest: hash(canonical), parentKind: "session.rename", reason: "kind_mismatch" },
      { json: " " + canonical, digest: hash(canonical), reason: "noncanonical_json" },
      { json: JSON.stringify(stop(), null, 2), digest: hash(canonical), reason: "noncanonical_json" },
    ];
    for (const scenario of scenarios) {
      const database = fixture(); retainMutation(database, scenario.json, 1, scenario.digest, scenario.kind, scenario.parentKind);
      const original = originalEvidence(database); install(database);
      expect(readMutationEffectEvidenceProvenance(database, attempt())).toEqual({ kind: "opaque", format: "combined49_v1", reason: scenario.reason });
      expect(database.query("SELECT projection_json,raw_sha256,raw_byte_length FROM mutation_effect_evidence_provenance").get())
        .toEqual({ projection_json: null, raw_sha256: hash(scenario.json), raw_byte_length: Buffer.byteLength(scenario.json) });
      expect(originalEvidence(database)).toEqual(original);
      const before = snapshot(database); audit(database); expect(snapshot(database)).toEqual(before);
    }
  });

  test("duplicate first/last key disagreement cannot acquire a canonical SQL projection", () => {
    const canonical = JSON.stringify(stop());
    const duplicate = '{"kind":"account.logout",' + canonical.slice(1);
    const database = fixture(); retainMutation(database, duplicate, 1, hash(canonical));
    expect(JSON.parse(duplicate)).toEqual(stop());
    expect(database.query("SELECT json_extract(evidence_json,'$.kind') AS kind FROM mutation_effect_evidence").get()).toEqual({ kind: "account.logout" });
    install(database);
    expect(readMutationEffectEvidenceProvenance(database, attempt())).toEqual({ kind: "opaque", format: "combined49_v1", reason: "noncanonical_json" });
    expect(database.query("SELECT projection_json FROM mutation_effect_evidence_provenance").get()).toEqual({ projection_json: null });
  });

  test("raw BLOB hashing/fatal UTF8 preserves malformed bytes rather than replacement decoding", () => {
    const database = fixture(); mutationParent(database);
    const placeholder = JSON.stringify({ ...stop(), providerThreadId: "PLACEHOLDER" });
    const [before, after] = placeholder.split("PLACEHOLDER");
    if (before === undefined || after === undefined) throw new Error("Missing synthetic UTF8 placeholder.");
    const raw = Buffer.concat([Buffer.from(before), Uint8Array.from([0xff]), Buffer.from(after)]);
    expect(decodeMutationEvidence({ format: "combined49_v1", json: new TextDecoder().decode(raw) }).kind).toBe("parsed");
    database.query("INSERT INTO mutation_effect_evidence VALUES(?,'session.stop',CAST(? AS TEXT),?,100)").run(attempt(), raw, "z".repeat(64));
    const original = originalEvidence(database); install(database);
    expect(readMutationEffectEvidenceProvenance(database, attempt())).toEqual({ kind: "opaque", format: "combined49_v1", reason: "invalid_utf8" });
    expect(database.query("SELECT raw_sha256,raw_byte_length,projection_json FROM mutation_effect_evidence_provenance").get())
      .toEqual({ raw_sha256: hash(raw), raw_byte_length: raw.length, projection_json: null });
    expect(originalEvidence(database)).toEqual(original);
    audit(database);
  });

  test("schema-valid unsafe SQLite integer metadata is bound exactly and remains opaque", () => {
    for (const column of ["recorded_at", "authority_generation"]) {
      const database = fixture(); retainMutation(database);
      if (column === "recorded_at") {
        database.exec("DROP TRIGGER mutation_effect_evidence_immutable_update");
        database.exec("UPDATE mutation_effect_evidence SET recorded_at=9223372036854775807");
        database.exec("CREATE TRIGGER mutation_effect_evidence_immutable_update BEFORE UPDATE ON mutation_effect_evidence BEGIN SELECT RAISE(ABORT,'original evidence immutable'); END");
      } else database.exec("UPDATE mutation_attempts SET authority_generation=9007199254740993");
      const original = originalEvidence(database); install(database);
      expect(readMutationEffectEvidenceProvenance(database, attempt())).toEqual({ kind: "opaque", format: "combined49_v1", reason: "invalid_parent_metadata" });
      expect(database.query(`SELECT ${column === "recorded_at" ? "recorded_at_decimal" : "parent_authority_generation_decimal"} AS value FROM mutation_effect_evidence_provenance`).get())
        .toEqual({ value: column === "recorded_at" ? "9223372036854775807" : "9007199254740993" });
      expect(originalEvidence(database)).toEqual(original); audit(database);
    }
  });

  test("queue parent means retained queue/session identity, never an invented current generation/thread", () => {
    for (const field of ["queueId", "sessionId"] as const) {
      const database = fixture();
      const value = { ...queueEvidence(), [field]: field === "queueId" ? queue(2) : `sess_${"f".repeat(32)}` };
      retainQueue(database, JSON.stringify(value)); install(database);
      expect(readQueueEffectEvidenceProvenance(database, queue())).toEqual({ kind: "opaque", format: "combined49_v1", reason: "parent_mismatch" });
    }
    const database = fixture(); retainQueue(database); install(database);
    database.exec("UPDATE sessions SET provider_thread_id='different-now',profile_generation=900");
    expect(readQueueEffectEvidenceProvenance(database, queue()).kind).toBe("parsed");
    expect(database.query("SELECT parent_authority_id,parent_authority_generation_decimal FROM queue_effect_evidence_provenance").get())
      .toEqual({ parent_authority_id: sessionId, parent_authority_generation_decimal: null });
  });

  test("joined writers canonicalize detached inputs and atomically install proof/anchor/evidence", () => {
    const database = fixture(); install(database); mutationParent(database); queueParent(database);
    const evidence = Object.fromEntries(Object.entries(stop()).reverse());
    const result = database.transaction(() => insertJoinedMutationEffectEvidence(database,
      { attemptId: attempt(), evidence, recordedAt: 123 })).immediate();
    expect(result.canonicalJson).toBe(JSON.stringify(stop()));
    expect(result.digest).toBe(hash(JSON.stringify(stop())));
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(result.evidence).not.toBe(evidence); expect(Object.isFrozen(evidence)).toBe(false);
    evidence.kind = "changed";
    expect(result.evidence.kind).toBe("session.stop");
    database.transaction(() => insertJoinedQueueEffectEvidence(database, { queueId: queue(), evidence: queueEvidence(), recordedAt: 124 })).immediate();
    expect(readMutationEffectEvidenceProvenance(database, attempt())).toMatchObject({ kind: "parsed", format: "joined_v1", recordedAt: 123 });
    expect(readQueueEffectEvidenceProvenance(database, queue())).toMatchObject({ kind: "parsed", format: "joined_v1", recordedAt: 124 });
    audit(database);
    expect(() => install(database)).toThrow(error);
    expect(() => insertJoinedMutationEffectEvidence(database, { attemptId: attempt(), evidence: stop(), recordedAt: 123 })).toThrow(error);
  });

  test("joined automation send and steer retain the canonical49 actor field without historical fallback", () => {
    for (const kind of ["session.send", "session.steer"] as const) {
      const value = { kind, providerThreadId: "retained-thread", baseline: baseline(),
        ...(kind === "session.steer" ? { activeTurnId: null } : {}), clientMessageId: "automation-message",
        messageDigest: "a".repeat(64), messageActor: "automation" };
      const database = fixture(); install(database); mutationParent(database, kind);
      const result = database.transaction(() => insertJoinedMutationEffectEvidence(database,
        { attemptId: attempt(), evidence: value, recordedAt: 100 })).immediate();
      expect(result.canonicalJson).toBe(JSON.stringify(value));
      expect(readMutationEffectEvidenceProvenance(database, attempt())).toMatchObject({
        kind: "parsed", format: "joined_v1", evidence: { kind, messageActor: "automation" },
      });
      const historical = fixture(); retainMutation(historical, JSON.stringify(value), 1, hash(JSON.stringify(value)), kind);
      install(historical, "canonical43_v1");
      expect(readMutationEffectEvidenceProvenance(historical, attempt())).toEqual({ kind: "opaque", format: "canonical43_v1", reason: "invalid_shape" });
    }
  });

  test("joined writer failures and late SQL failures leave no partial evidence/proof", () => {
    const database = fixture(); install(database); mutationParent(database); queueParent(database);
    for (const input of [
      { attemptId: attempt(), evidence: { kind: "future" }, recordedAt: 100 },
      { attemptId: attempt(), evidence: { kind: "account.logout", baselineSignedIn: false }, recordedAt: 100 },
      { attemptId: attempt(2), evidence: stop(), recordedAt: 100 },
      { attemptId: attempt(), evidence: stop(), recordedAt: Number.MAX_SAFE_INTEGER + 1 },
      { attemptId: attempt(), evidence: stop(), recordedAt: 100, format: "combined49_v1" },
    ]) expect(() => database.transaction(() => insertJoinedMutationEffectEvidence(database, input)).immediate()).toThrow(error);
    database.exec("CREATE TRIGGER reject_late BEFORE INSERT ON mutation_effect_evidence BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END");
    expect(() => database.transaction(() => insertJoinedMutationEffectEvidence(database,
      { attemptId: attempt(), evidence: stop(), recordedAt: 100 })).immediate()).toThrow();
    for (const table of ["mutation_effect_evidence", "mutation_effect_evidence_provenance", "mutation_effect_evidence_provenance_anchors"]) {
      expect(database.query(`SELECT * FROM ${table}`).all()).toHaveLength(0);
    }
    expect(() => database.transaction(() => insertJoinedQueueEffectEvidence(database,
      { queueId: queue(), evidence: { ...queueEvidence(), sessionId: `sess_${"f".repeat(32)}` }, recordedAt: 100 })).immediate()).toThrow(error);
  });

  test("direct evidence insertion and historical/projection swaps cannot bypass current guards", () => {
    const database = fixture(); install(database); mutationParent(database);
    expect(() => database.query("INSERT INTO mutation_effect_evidence VALUES(?,'session.stop',?,?,100)")
      .run(attempt(), JSON.stringify(stop()), hash(JSON.stringify(stop())))).toThrow(error);
    database.transaction(() => insertJoinedMutationEffectEvidence(database, { attemptId: attempt(), evidence: stop(), recordedAt: 100 })).immediate();
    for (const table of ["mutation_effect_evidence_provenance", "mutation_effect_evidence_provenance_anchors"]) {
      expect(() => database.exec(`UPDATE ${table} SET provenance_digest='${"e".repeat(64)}'`)).toThrow(error);
      expect(() => database.exec(`DELETE FROM ${table}`)).toThrow(error);
    }
    expect(() => database.exec("UPDATE mutation_effect_evidence_provenance SET format='combined49_v1'")).toThrow(error);
  });

  test("reads/audits refuse missing or conflicting provenance, anchors, parents and original bytes without writes", () => {
    for (const sql of [
      "DELETE FROM mutation_effect_evidence_provenance", "DELETE FROM mutation_effect_evidence_provenance_anchors",
      "UPDATE mutation_effect_evidence_provenance SET format='canonical49_v1'",
      "UPDATE mutation_effect_evidence_provenance SET projection_json=NULL,opaque_reason='invalid_shape'",
      "UPDATE mutation_effect_evidence_provenance SET raw_sha256='" + "e".repeat(64) + "'",
      "UPDATE mutation_effect_evidence_provenance_anchors SET provenance_digest='" + "e".repeat(64) + "'",
      "UPDATE mutation_attempts SET authority_generation=2", "UPDATE mutation_attempts SET authority_id='different-parent'",
      "UPDATE mutation_effect_evidence SET evidence_json='{}'", "UPDATE mutation_effect_evidence SET recorded_at=101",
      "UPDATE mutation_effect_evidence SET evidence_digest='" + "z".repeat(64) + "'",
    ]) {
      const database = fixture(); retainMutation(database); install(database);
      corrupt(database, () => database.exec(sql));
      const before = snapshot(database);
      expect(() => readMutationEffectEvidenceProvenance(database, attempt())).toThrow(error);
      expect(() => audit(database)).toThrow(error);
      expect(snapshot(database)).toEqual(before);
    }
  });

  test("schema and inverse audits reject extra/missing objects and orphan evidence counterparts", () => {
    for (const scenario of ["schema", "trigger", "orphan", "queue-anchor"] as const) {
      const database = fixture(); retainMutation(database); retainQueue(database); install(database);
      if (scenario === "schema") database.exec("CREATE TRIGGER extra_provenance BEFORE INSERT ON mutation_effect_evidence_provenance BEGIN SELECT 1; END");
      if (scenario === "trigger") database.exec("DROP TRIGGER mutation_effect_evidence_provenance_insert");
      if (scenario === "orphan") corrupt(database, () => database.exec("DELETE FROM mutation_effect_evidence"));
      if (scenario === "queue-anchor") corrupt(database, () => database.exec("DELETE FROM queue_effect_evidence_provenance_anchors"));
      const before = snapshot(database); expect(() => audit(database)).toThrow(error); expect(snapshot(database)).toEqual(before);
    }
  });

  test("immutable anchor detects correlated payload and parent-metadata swaps that preserve classification", () => {
    for (const change of ["raw", "parent", "time", "stored-digest"] as const) {
      const database = fixture(); retainMutation(database, "{?"); install(database);
      expect(readMutationEffectEvidenceProvenance(database, attempt())).toEqual({ kind: "opaque", format: "combined49_v1", reason: "invalid_json" });
      corrupt(database, () => {
        if (change === "raw") {
          database.query("UPDATE mutation_effect_evidence SET evidence_json=?").run("{!");
          database.query("UPDATE mutation_effect_evidence_provenance SET raw_sha256=?").run(hash("{!"));
        } else if (change === "parent") {
          database.exec("UPDATE mutation_attempts SET authority_generation=2");
          database.exec("UPDATE mutation_effect_evidence_provenance SET parent_authority_generation_decimal='2'");
        } else if (change === "time") {
          database.exec("UPDATE mutation_effect_evidence SET recorded_at=101");
          database.exec("UPDATE mutation_effect_evidence_provenance SET recorded_at_decimal='101'");
        } else {
          database.query("UPDATE mutation_effect_evidence SET evidence_digest=?").run("z".repeat(64));
          database.query("UPDATE mutation_effect_evidence_provenance SET stored_digest=?").run("z".repeat(64));
        }
      });
      const before = snapshot(database);
      expect(() => readMutationEffectEvidenceProvenance(database, attempt())).toThrow(error);
      expect(() => audit(database)).toThrow(error);
      expect(snapshot(database)).toEqual(before);
    }
  });

  test("raw-byte cap preserves a maximal opaque row; overbounds refuse admission atomically", () => {
    const database = fixture();
    const json = JSON.stringify(stop()) + " ".repeat(EFFECT_EVIDENCE_PROVENANCE_MAX_RAW_BYTES - Buffer.byteLength(JSON.stringify(stop())));
    retainMutation(database, json, 1, hash(JSON.stringify(stop())));
    install(database);
    expect(readMutationEffectEvidenceProvenance(database, attempt())).toEqual({ kind: "opaque", format: "combined49_v1", reason: "noncanonical_json" });
    expect(database.query("SELECT raw_byte_length FROM mutation_effect_evidence_provenance").get()).toEqual({ raw_byte_length: 262144 });
    const oversized = fixture(); mutationParent(oversized);
    oversized.exec("PRAGMA ignore_check_constraints=ON");
    oversized.query("INSERT INTO mutation_effect_evidence VALUES(?,'session.stop',?,?,100)").run(attempt(), json + " ", "a".repeat(64));
    oversized.exec("PRAGMA ignore_check_constraints=OFF");
    expect(() => install(oversized)).toThrow("EFFECT_EVIDENCE_PROVENANCE_LIMIT");
    expect(oversized.query("SELECT name FROM sqlite_master WHERE name LIKE '%provenance%'").all()).toEqual([]);
  });

  test("zero/one-byte malformed historical rows remain opaque without relaxing the frozen evidence DDL", () => {
    for (const json of ["", "0", "x"]) {
      const database = fixture(); mutationParent(database); queueParent(database);
      // Frozen generic evidence DDL has a two-byte floor. These deliberately
      // corrupted retained rows still need provenance, not a rewrite/deletion.
      database.exec("PRAGMA ignore_check_constraints=ON");
      database.query("INSERT INTO mutation_effect_evidence VALUES(?,'session.stop',?,?,100)").run(attempt(), json, hash(json));
      database.query("INSERT INTO queue_effect_evidence VALUES(?,?,?,100)").run(queue(), json, hash(json));
      database.exec("PRAGMA ignore_check_constraints=OFF");
      const original = originalEvidence(database); install(database);
      const reason = json === "0" ? "invalid_shape" : "invalid_json";
      expect(readMutationEffectEvidenceProvenance(database, attempt())).toEqual({ kind: "opaque", format: "combined49_v1", reason });
      expect(readQueueEffectEvidenceProvenance(database, queue())).toEqual({ kind: "opaque", format: "combined49_v1", reason });
      expect(database.query("SELECT raw_byte_length,projection_json FROM mutation_effect_evidence_provenance").get())
        .toEqual({ raw_byte_length: json.length, projection_json: null });
      expect(originalEvidence(database)).toEqual(original);
      audit(database);
    }
  });

  test("all exported boundaries redact unexpected SQL/metadata errors with no retained raw cause", () => {
    const sentinel = "SYNTHETIC_PRIVATE_DIAGNOSTIC";
    const capture = (operation: () => unknown, expected = error) => {
      let cause: unknown;
      try { operation(); } catch (value) { cause = value; }
      expect(cause).toBeInstanceOf(Error);
      if (!(cause instanceof Error)) throw new Error("Missing sanitized failure.");
      expect(cause.constructor).toBe(Error);
      expect(cause.message).toBe(expected);
      expect(cause).not.toHaveProperty("cause");
      expect(JSON.stringify(cause)).not.toContain(sentinel);
      expect(String(cause)).not.toContain(sentinel);
    };
    const missing = new Database(":memory:", { strict: true }); databases.push(missing);
    capture(() => readMutationEffectEvidenceProvenance(missing, attempt()));
    capture(() => readQueueEffectEvidenceProvenance(missing, queue()));
    capture(() => assertEffectEvidenceProvenanceSchema(missing));
    capture(() => missing.transaction(() => auditEffectEvidenceProvenance(missing)).deferred());
    capture(() => missing.transaction(() => applyEffectEvidenceProvenance(missing, "combined49_v1")).immediate());
    const malformed = fixture(); retainMutation(malformed);
    malformed.exec("PRAGMA ignore_check_constraints=ON");
    malformed.exec("UPDATE mutation_attempts SET authority_generation=-1");
    malformed.exec("PRAGMA ignore_check_constraints=OFF");
    capture(() => install(malformed));
    const database = fixture(); install(database); mutationParent(database); queueParent(database);
    for (const table of ["mutation_effect_evidence", "queue_effect_evidence"]) database.exec(`CREATE TRIGGER ${table}_private_failure
      BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'${sentinel}'); END;`);
    capture(() => database.transaction(() => insertJoinedMutationEffectEvidence(database,
      { attemptId: attempt(), evidence: stop(), recordedAt: 100 })).immediate());
    capture(() => database.transaction(() => insertJoinedQueueEffectEvidence(database,
      { queueId: queue(), evidence: queueEvidence(), recordedAt: 100 })).immediate());
    capture(() => readMutationEffectEvidenceProvenance(database, "a".repeat(161)), "EFFECT_EVIDENCE_PROVENANCE_LIMIT");
  });

  test("complete keyset paging includes opaque rows and unchanged read-only reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hra-effect-provenance-")); directories.push(directory);
    const path = join(directory, "state.sqlite"); const database = fixture(path);
    for (let index = 201; index >= 1; index--) retainMutation(database, index % 2 === 0 ? "{}" : JSON.stringify(stop()), index);
    install(database);
    expect(database.query("SELECT COUNT(*) AS count FROM mutation_effect_evidence_provenance").get()).toEqual({ count: 201 });
    const readonly = new Database(path, { readonly: true, strict: true }); databases.push(readonly);
    const before = snapshot(readonly); audit(readonly); expect(snapshot(readonly)).toEqual(before);
    expect(readMutationEffectEvidenceProvenance(readonly, attempt(200)).kind).toBe("opaque");
    expect(EFFECT_EVIDENCE_PROVENANCE_TABLES_BY_SCOPE.queue.id).toBe("queue_id");
  });

  test("foreign input traps do not run getters or create evidence", () => {
    const database = fixture(); install(database); mutationParent(database);
    let getters = 0;
    const getter = { attemptId: attempt(), evidence: stop(), recordedAt: 100 };
    Object.defineProperty(getter, "evidence", { enumerable: true, get() { getters++; return stop(); } });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const input of [getter, cyclic, undefined, NaN, 1n, new Proxy({}, { ownKeys() { throw new Error("private trap"); } })]) {
      expect(() => database.transaction(() => insertJoinedMutationEffectEvidence(database, input)).immediate()).toThrow(error);
    }
    expect(getters).toBe(0); expect(database.query("SELECT * FROM mutation_effect_evidence").all()).toHaveLength(0);
  });

  test("seeded selected-format round trips preserve canonical bytes and detached frozen parsed output", () => {
    const database = fixture(); install(database); mutationParent(database);
    const rollback = new Error("rollback generated fixture");
    fc.assert(fc.property(fc.record({ at: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      thread: fc.stringMatching(/^[a-z]{1,20}$/u), active: fc.option(fc.stringMatching(/^[a-z]{1,20}$/u), { nil: null }) }),
    ({ at, thread, active }) => {
      const value = { ...stop(), providerThreadId: thread, activeTurnId: active };
      const candidate = Object.fromEntries(Object.entries(value).reverse());
      expect(() => database.transaction(() => {
        const result = insertJoinedMutationEffectEvidence(database, { attemptId: attempt(), evidence: candidate, recordedAt: at });
        expect(result.canonicalJson).toBe(JSON.stringify(value)); expect(result.evidence).not.toBe(candidate);
        expect(Object.isFrozen(result.evidence)).toBe(true); expect(Object.isFrozen(candidate)).toBe(false);
        candidate.providerThreadId = "mutated";
        const read = readMutationEffectEvidenceProvenance(database, attempt());
        expect(read).toMatchObject({ kind: "parsed", canonicalJson: JSON.stringify(value), recordedAt: at });
        auditEffectEvidenceProvenance(database); throw rollback;
      }).immediate()).toThrow(rollback);
    }), { seed: 951003, numRuns: 80 });
  });

  test("seeded unknown JSON writer boundary is total without assuming all generated shapes are invalid", () => {
    const database = fixture(); install(database); mutationParent(database);
    const rollback = new Error("rollback arbitrary fixture");
    fc.assert(fc.property(fc.jsonValue(), (evidence) => {
      let outcome: unknown;
      try {
        database.transaction(() => {
          try { outcome = insertJoinedMutationEffectEvidence(database, { attemptId: attempt(), evidence, recordedAt: 100 }); }
          catch (cause) { outcome = cause; }
          throw rollback;
        }).immediate();
      } catch (cause) { expect(cause).toBe(rollback); }
      if (outcome instanceof Error) expect(outcome.message).toBe(error);
      else expect(outcome).toHaveProperty("canonicalJson");
    }), { seed: 400288, numRuns: 120 });
  });
});
