import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateSecurityScrubRequiredError, StateStore } from "./state-store";
import { ATTACHMENT_CUSTODY_SCHEMA_OBJECTS, readAttachmentParent } from "./attachment-custody";
import { joinedAttachmentTerminalGuardSql } from "./joined-attachment-terminal-guard";
import { assertTerminalAttachmentAcknowledgmentSchema, auditTerminalAttachmentAcknowledgments,
  readTerminalAttachmentAcknowledgment } from "./attachment-terminal-acknowledgments";

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const INVALID = "ATTACHMENT_TERMINAL_ACKNOWLEDGMENT_INVALID";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function inspect<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { strict: true });
  try { return read(db); } finally { db.close(false); }
}
function snapshot(path: string) {
  return inspect(path, (db) => ({
    schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    rows: db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(({ name }) => ({ name, rows: db.query(`SELECT * FROM ${quote(name)}`).all() })),
  }));
}
function immutable(path: string) {
  return inspect(path, (db) => ({
    effects: db.query("SELECT * FROM mutation_effect_evidence ORDER BY attempt_id").all(),
    provenance: db.query("SELECT * FROM mutation_effect_evidence_provenance ORDER BY attempt_id").all(),
    resolutions: db.query("SELECT * FROM mutation_resolutions ORDER BY attempt_id").all(),
    attempts: db.query("SELECT id,kind,authority_id,authority_generation,request_digest,state,result_json,transcript_intent_json FROM mutation_attempts ORDER BY id").all(),
    sessions: db.query("SELECT * FROM sessions ORDER BY id").all(),
    events: db.query("SELECT * FROM session_events ORDER BY session_id,sequence").all(),
  }));
}

// Explicit current corruption only: intact immutable SQL must reject the same
// edit first. Commit the targeted damage with the exact original guards restored
// before the other StateStore connection or either open mode observes it.
function corrupt(path: string, tables: readonly string[], change: (db: Database) => void) {
  inspect(path, (db) => {
    db.exec("PRAGMA foreign_keys=ON");
    expect(() => db.transaction(() => change(db)).immediate()).toThrow();
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const triggers = tables.flatMap((table) => db.query<{ name: string; sql: string }, [string]>(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table));
    db.exec("PRAGMA foreign_keys=OFF");
    db.transaction(() => {
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
      change(db);
      for (const trigger of triggers) db.exec(trigger.sql);
    }).immediate();
    db.exec("PRAGMA foreign_keys=ON");
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schema);
  });
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-terminal-ack-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  let now = 1_800_000_000_000;
  const store = new StateStore(paths, { now: () => now, resolveMachineTimeZone: () => "UTC",
    securityScrubCheckpoint: { busyTimeoutMs: 1, attempts: 1, backoffMs: 0 } });
  stores.push(store);
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemon = { bootId, daemonGeneration: store.nextDaemonGeneration(bootId) };
  const profile = store.nextProfileGeneration(store.createProfile("Terminal acknowledgment").id);
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: "terminal-ack@example.com", plan: "Plus" })).toBe(true);
  const authority = store.requireProviderAccountAuthority(profile.id, "codex");
  const session = store.upsertProviderSession({ profileId: profile.id, provider: "codex", providerAuthority: authority,
    providerAccountKey: `v1:codex:${hash("terminal-ack@example.com")}`, providerThreadId: "terminal-ack-thread",
    title: "Terminal acknowledgment", preset: "high", fastEnabled: false, state: "active", activeTurnId: "terminal-ack-turn" });
  const attachment = { byteLength: 4, digest: "a".repeat(64), mediaType: "text/plain" as const, name: "proof.txt" };
  const add = (referenceCount = 1, target = session) => {
    const references = Array.from({ length: referenceCount }, (_, index) => ({ ...attachment,
      name: referenceCount === 1 ? attachment.name : `proof-${String(index)}.txt` }));
    const input = { ...daemon, kind: "session.steer" as const, sessionId: target.id, providerAuthority: authority,
      idempotencyKey: randomUUID(), message: "Retained input", attachments: references };
    const reservation = store.reserveAttachmentIngress(input);
    if (reservation.kind !== "reserved") throw new Error("Expected a real reservation.");
    const prepared = store.prepareSessionInputMutation({ ...input, reservation });
    if (prepared.custody.kind !== "mutation_owned") throw new Error("Expected owned custody.");
    const stored = references.map((reference) => ({ ...reference, canonicalMediaType: reference.mediaType }));
    if (target.providerThreadId === undefined) throw new Error("Expected a native target thread.");
    store.beginSessionMutationEffect({ ...daemon, attemptId: prepared.attempt.id, sessionId: target.id,
      providerAuthority: authority, profileGeneration: authority.processGeneration, message: input.message,
      attachments: stored, custody: { custodyId: prepared.custody.custodyId, custodyDigest: prepared.custody.custodyDigest },
      transcript: { accountId: profile.id, providerGeneration: authority.processGeneration, providerConnectionId: randomUUID(),
        actor: "human", message: input.message, attachments: references, storedAttachments: stored },
      evidence: { kind: "session.steer", providerThreadId: target.providerThreadId,
        baseline: { providerUpdatedAt: null, status: "active", activeTurnId: "terminal-ack-turn" },
        activeTurnId: "terminal-ack-turn", clientMessageId: prepared.attempt.id, messageDigest: hash(input.message), messageActor: "human" } });
    return prepared.attempt;
  };
  const terminalize = (source: "provider_thread_deleted" | "provider_transport_lost" = "provider_thread_deleted", target = session) => {
    now++;
    return store.terminalizeSessionFromProviderDeletion({ accountId: profile.id, providerGeneration: authority.processGeneration,
      providerAuthority: authority, providerConnectionId: null, sessionId: target.id, source });
  };
  const acknowledge = () => store.acknowledgeTerminalSessionInputCustody({ sessionId: session.id,
    expectedRevision: store.requireSession(session.id).revision });
  return { store, paths, session, authority, daemon, attachment, add, terminalize, acknowledge, setNow: (value: number) => { now = value; } };
}

describe("explicit terminal attachment acknowledgments", () => {
  for (const source of ["provider_thread_deleted", "provider_transport_lost"] as const) {
    test(`${source} retains uncertainty until explicit acknowledgment, then releases exactly once`, async () => {
      const f = await fixture();
      const attempt = f.add();
      f.terminalize(source);
      expect(f.store.messageAttachmentManifest(f.session.id, attempt.id)).toEqual([f.attachment]);
      expect(f.store.attachmentCustody(f.attachment.digest)).toMatchObject({ referenceCount: 1 });
      expect(inspect(f.paths.database, (db) => readTerminalAttachmentAcknowledgment(db, attempt.id))).toBeNull();
      const original = immutable(f.paths.database);
      expect(f.acknowledge()).toMatchObject({ releasedInputCount: 1, alreadyAcknowledgedInputCount: 0 });
      expect(immutable(f.paths.database)).toEqual(original);
      expect(f.store.messageAttachmentManifest(f.session.id, attempt.id)).toEqual([]);
      expect(f.store.attachmentCustody(f.attachment.digest)).toMatchObject({ referenceCount: 0 });
      const ack = inspect(f.paths.database, (db) => readTerminalAttachmentAcknowledgment(db, attempt.id));
      expect(ack?.record).toMatchObject({ action: "user_abandon_local_attachment_custody", providerAuthority: f.authority,
        providerEffectRetried: false, providerStateDeleted: false, providerOutcomeKnown: false, resolutionJson: JSON.stringify({ source }) });
      expect(Object.isFrozen(ack?.record.providerAuthority)).toBe(true);
      expect(inspect(f.paths.database, (db) => readAttachmentParent(db, attempt.id).custody?.releasedBy)).not.toBeNull();
      const after = snapshot(f.paths.database);
      expect(f.acknowledge()).toMatchObject({ releasedInputCount: 0, alreadyAcknowledgedInputCount: 1 });
      expect(snapshot(f.paths.database)).toEqual(after);
    });
  }

  test("invalid revisions, nonterminal input, and regressed clocks leave the entire database unchanged", async () => {
    const f = await fixture();
    f.add();
    const live = snapshot(f.paths.database);
    expect(f.acknowledge).toThrow(INVALID);
    expect(snapshot(f.paths.database)).toEqual(live);
    f.terminalize();
    const terminal = snapshot(f.paths.database);
    expect(() => f.store.acknowledgeTerminalSessionInputCustody({ sessionId: f.session.id, expectedRevision: 999 })).toThrow(INVALID);
    f.setNow(1_800_000_000_000);
    expect(f.acknowledge).toThrow(INVALID);
    expect(snapshot(f.paths.database)).toEqual(terminal);
  });

  for (const unsupported of ["original owner", "invocation only"] as const) {
    test(`mixed supported and ${unsupported} custody refuses the complete batch without silent omission`, async () => {
      const f = await fixture();
      f.add();
      if (unsupported === "original owner") {
        const owner = f.store.prepareOwnedSessionSendWithCustody({ ...f.daemon,
          request: { kind: "session.send", session: f.session.id, idempotencyKey: randomUUID(),
            message: "An independent original owner", attachments: [f.attachment] } });
        expect(owner.custody.kind).toBe("mutation_owned");
      } else {
        expect(f.store.reserveAttachmentIngress({ ...f.daemon, kind: "session.steer", sessionId: f.session.id,
          providerAuthority: f.authority, message: "An unfinished invocation", attachments: [f.attachment],
          idempotencyKey: randomUUID() }).kind).toBe("reserved");
      }
      f.terminalize();
      const before = snapshot(f.paths.database);
      expect(f.acknowledge).toThrow(INVALID);
      expect(snapshot(f.paths.database)).toEqual(before);
      expect(inspect(f.paths.database, (db) => db.query("SELECT count(*) AS n FROM attachment_terminal_acknowledgments").get())).toEqual({ n: 0 });
    });
  }

  test("a late second-manifest fault rolls back acknowledgment, release, and accounting", async () => {
    const f = await fixture();
    f.add(2);
    f.terminalize();
    inspect(f.paths.database, (db) => db.exec(`CREATE TRIGGER reject_second_ack_manifest BEFORE DELETE ON message_attachments
      WHEN (SELECT count(*) FROM message_attachments)=1 BEGIN SELECT RAISE(ABORT,'synthetic late manifest fault'); END;`));
    const before = snapshot(f.paths.database);
    expect(f.acknowledge).toThrow(INVALID);
    expect(snapshot(f.paths.database)).toEqual(before);
    inspect(f.paths.database, (db) => db.exec("DROP TRIGGER reject_second_ack_manifest"));
    expect(f.acknowledge()).toMatchObject({ releasedInputCount: 1, alreadyAcknowledgedInputCount: 0 });
  });

  test("a pinned reader preserves the postcommit scrub error and the already-committed release", async () => {
    const f = await fixture();
    const attempt = f.add();
    f.terminalize();
    const original = immutable(f.paths.database);
    const reader = new Database(f.paths.database, { readonly: true, strict: true });
    reader.exec("BEGIN");
    expect(reader.query("SELECT count(*) AS n FROM message_attachments").get()).toEqual({ n: 1 });
    try {
      let failure: unknown;
      try { f.acknowledge(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(StateSecurityScrubRequiredError);
      expect(failure).toMatchObject({ operationCommitted: true, message: "STATE_SECURITY_SCRUB_REQUIRED" });
      expect(f.store.messageAttachmentManifest(f.session.id, attempt.id)).toEqual([]);
      expect(inspect(f.paths.database, (db) => readTerminalAttachmentAcknowledgment(db, attempt.id))).not.toBeNull();
      expect(immutable(f.paths.database)).toEqual(original);
    } finally { reader.exec("ROLLBACK"); reader.close(false); }
    expect(f.acknowledge()).toMatchObject({ releasedInputCount: 0, alreadyAcknowledgedInputCount: 1 });
    expect(inspect(f.paths.database, (db) => db.query("SELECT * FROM queue_message_scrub_authority").all())).toEqual([]);
  });

  test("current read-only and writable reopens preserve both unacknowledged and released evidence", async () => {
    const f = await fixture();
    f.add();
    f.terminalize();
    const reopen = () => {
      const before = snapshot(f.paths.database);
      for (const readonly of [true, false]) {
        const reopened = new StateStore(f.paths, { readonly, now: () => 1_800_000_000_010 });
        reopened.close();
        expect(snapshot(f.paths.database)).toEqual(before);
      }
    };
    reopen();
    f.acknowledge();
    reopen();
  });

  test("another session's independent reference keeps a shared blob pinned", async () => {
    const f = await fixture();
    const first = f.add();
    const other = f.store.upsertProviderSession({ profileId: f.authority.profileId, provider: "codex", providerAuthority: f.authority,
      providerAccountKey: `v1:codex:${hash("terminal-ack@example.com")}`, providerThreadId: "other-terminal-ack-thread",
      title: "Independent reference", preset: "high", fastEnabled: false, state: "active", activeTurnId: "terminal-ack-turn" });
    const second = f.add(1, other);
    f.terminalize();
    expect(f.store.attachmentCustody(f.attachment.digest)).toMatchObject({ referenceCount: 2 });
    const original = immutable(f.paths.database);
    expect(f.acknowledge()).toMatchObject({ releasedInputCount: 1 });
    expect(immutable(f.paths.database)).toEqual(original);
    expect(f.store.messageAttachmentManifest(f.session.id, first.id)).toEqual([]);
    expect(f.store.messageAttachmentManifest(other.id, second.id)).toEqual([f.attachment]);
    expect(f.store.attachmentCustody(f.attachment.digest)).toMatchObject({ referenceCount: 1 });
    expect(inspect(f.paths.database, (db) => readAttachmentParent(db, second.id).custody?.releasedBy)).toBeNull();
  });

  test("current writable and read-only opens refuse a missing or reverted acknowledgment successor without writes", async () => {
    const f = await fixture();
    f.add();
    f.terminalize();
    const guard = "attachment_terminal_projection_guard";
    const predecessor = ATTACHMENT_CUSTODY_SCHEMA_OBJECTS.find((object) => object.name === guard);
    if (predecessor === undefined) throw new Error("Expected the frozen guard definition.");
    const original = inspect(f.paths.database, (db) => db.query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE name=?").get(guard));
    if (original === null) throw new Error("Expected the installed current guard.");
    for (const replacement of [null, joinedAttachmentTerminalGuardSql(predecessor.sql)]) {
      inspect(f.paths.database, (db) => db.transaction(() => {
        db.exec(`DROP TRIGGER ${quote(guard)}`);
        if (replacement !== null) db.exec(replacement);
      }).immediate());
      const before = snapshot(f.paths.database);
      try {
        for (const readonly of [false, true]) {
          expect(() => {
            const opened = new StateStore(f.paths, { readonly });
            opened.close();
          }).toThrow("ATTACHMENT_CUSTODY_TERMINAL_GUARD_INVALID");
          expect(snapshot(f.paths.database)).toEqual(before);
        }
      } finally {
        inspect(f.paths.database, (db) => db.transaction(() => {
          if (replacement !== null) db.exec(`DROP TRIGGER ${quote(guard)}`);
          db.exec(original.sql);
        }).immediate());
      }
    }
  });

  test("SQL rejects missing and duplicate fields instead of letting NULL or first-key semantics grant a release", async () => {
    const f = await fixture();
    const attempt = f.add();
    f.terminalize();
    const image = inspect(f.paths.database, (db) => db.serialize());
    f.acknowledge();
    const retained = inspect(f.paths.database, (db) => db.query<{ acknowledgment_json: string; acknowledgment_digest: string }, []>(
      "SELECT acknowledgment_json,acknowledgment_digest FROM attachment_terminal_acknowledgments").get());
    if (retained === null) throw new Error("Expected the acknowledged row.");
    const record: Record<string, unknown> = JSON.parse(retained.acknowledgment_json) as Record<string, unknown>;
    const missingOutcome = { ...record };
    delete missingOutcome.providerOutcomeKnown;
    const missingDigest = { ...record };
    delete missingDigest.resolutionDigest;
    const invalid = [JSON.stringify(missingOutcome), JSON.stringify(missingDigest),
      retained.acknowledgment_json.replace('"providerOutcomeKnown":false', '"providerOutcomeKnown":false,"providerOutcomeKnown":true'),
      JSON.stringify({ ...record, providerOutcomeKnown: true })];
    const clonePath = `${f.paths.database}.ack-sql`;
    await writeFile(clonePath, image, { mode: 0o600 });
    const db = new Database(clonePath, { strict: true });
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const insert = (raw: string) => db.query("INSERT INTO attachment_terminal_acknowledgments VALUES(?,?,?)")
        .run(attempt.id, raw, retained.acknowledgment_digest);
      for (const raw of invalid) {
        expect(() => db.transaction(() => insert(raw)).immediate()).toThrow(INVALID);
        expect(readTerminalAttachmentAcknowledgment(db, attempt.id)).toBeNull();
      }
      // Independent seeded clock campaign exercises both accepted equal/ordered
      // pairs and rejected regressions through the real SQL and typed reader.
      fc.assert(fc.property(fc.integer({ min: -30, max: 30 }), (delta) => {
        const changed = { ...record, createdAt: 1_800_000_000_001 + delta };
        const raw = JSON.stringify(changed);
        const digest = hash(`oompa:attachment-terminal-acknowledgment:v1\0${raw}`);
        const rollback = new Error("rollback accepted control");
        expect(() => db.transaction(() => {
          db.query("INSERT INTO attachment_terminal_acknowledgments VALUES(?,?,?)").run(attempt.id, raw, digest);
          db.query("INSERT INTO attachment_terminal_acknowledgment_anchors VALUES(?,?,?)").run(attempt.id, raw, digest);
          expect(readTerminalAttachmentAcknowledgment(db, attempt.id)?.record.createdAt).toBe(changed.createdAt);
          throw rollback;
        }).immediate()).toThrow(delta < 0 ? INVALID : rollback.message);
        expect(readTerminalAttachmentAcknowledgment(db, attempt.id)).toBeNull();
      }), { seed: 0x51a9b3, numRuns: 100 });
    } finally { db.close(false); }
  });

  test("missing, oversized, and temporary-shadow schema metadata is refused without rewriting it", async () => {
    const f = await fixture();
    inspect(f.paths.database, (db) => {
      assertTerminalAttachmentAcknowledgmentSchema(db);
      const name = "attachment_terminal_acknowledgments_insert_guard";
      const original = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name=?").get(name);
      if (original === null) throw new Error("Expected acknowledgment guard.");
      for (const variant of ["missing", "oversized", "shadow"] as const) {
        const rollback = new Error("schema fixture rollback");
        expect(() => db.transaction(() => {
          if (variant === "shadow") db.exec(`CREATE TEMP TABLE ${quote(name)}(value TEXT)`);
          else {
            db.exec(`DROP TRIGGER ${quote(name)}`);
            if (variant === "oversized") db.exec(`CREATE TRIGGER ${quote(name)} BEFORE INSERT ON attachment_terminal_acknowledgments
              BEGIN SELECT '${"x".repeat(131073)}'; END;`);
          }
          expect(() => assertTerminalAttachmentAcknowledgmentSchema(db)).toThrow(INVALID);
          throw rollback;
        }).immediate()).toThrow(rollback.message);
        expect(db.query("SELECT sql FROM sqlite_master WHERE name=?").get(name)).toEqual(original);
        assertTerminalAttachmentAcknowledgmentSchema(db);
      }
    });
  });

  const wrongRecordFields = [
    ["sessionId", "sess_" + "e".repeat(32)],
    ["providerAuthority.providerAccountId", "acct_" + "e".repeat(32)],
    ["providerAuthority.profileId", "acct_" + "e".repeat(32)],
    ["providerAuthority.provider", "claude"],
    ["providerAuthority.bindingGeneration", 2],
    ["providerAuthority.processGeneration", 2],
    ["requestDigest", "e".repeat(64)],
    ["effectDigest", "e".repeat(64)],
    ["resolutionJson", '{"source":"provider_transport_lost"}'],
    ["custodyDigest", "e".repeat(64)],
  ] as const;
  for (const [field, replacement] of wrongRecordFields) {
    test(`a rehashed acknowledgment with wrong ${field} cannot replace captured source authority`, async () => {
      const f = await fixture();
      const attempt = f.add();
      f.terminalize();
      f.acknowledge();
      const retained = inspect(f.paths.database, (db) => readTerminalAttachmentAcknowledgment(db, attempt.id));
      if (retained === null) throw new Error("Expected retained acknowledgment.");
      const record: Record<string, unknown> = { ...retained.record, providerAuthority: { ...retained.record.providerAuthority } };
      if (field.startsWith("providerAuthority.")) {
        const authority = record.providerAuthority as Record<string, unknown>;
        const key = field.slice("providerAuthority.".length);
        const original = authority[key];
        authority[key] = typeof original === "number" ? original + 1 : replacement;
        expect(authority[key]).not.toBe(original);
      } else record[field] = replacement;
      const raw = JSON.stringify(record);
      const digest = hash(`oompa:attachment-terminal-acknowledgment:v1\0${raw}`);
      corrupt(f.paths.database, ["attachment_terminal_acknowledgments", "attachment_terminal_acknowledgment_anchors"], (db) => {
        for (const name of ["attachment_terminal_acknowledgments", "attachment_terminal_acknowledgment_anchors"]) {
          expect(db.query(`UPDATE ${name} SET acknowledgment_json=?,acknowledgment_digest=? WHERE attempt_id=?`)
            .run(raw, digest, attempt.id).changes).toBe(1);
        }
      });
      const before = snapshot(f.paths.database);
      expect(() => inspect(f.paths.database, (db) => readTerminalAttachmentAcknowledgment(db, attempt.id))).toThrow(INVALID);
      for (const readonly of [false, true]) {
        expect(() => { const opened = new StateStore(f.paths, { readonly }); opened.close(); }).toThrow();
        expect(snapshot(f.paths.database)).toEqual(before);
      }
    });
  }

  for (const source of ["effect", "resolution", "custody", "primary", "anchor"] as const) {
    test(`missing or altered original ${source} proof refuses readback and both current open modes without writes`, async () => {
      const f = await fixture();
      const attempt = f.add();
      f.terminalize();
      f.acknowledge();
      const table = source === "effect" ? "mutation_effect_evidence"
        : source === "resolution" ? "mutation_resolutions"
        : source === "custody" ? "attachment_custody_sets"
        : source === "primary" ? "attachment_terminal_acknowledgments" : "attachment_terminal_acknowledgment_anchors";
      corrupt(f.paths.database, [table], (db) => {
        const changed = source === "effect" ? db.query("UPDATE mutation_effect_evidence SET evidence_digest=? WHERE attempt_id=?").run("e".repeat(64), attempt.id)
          : source === "resolution" ? db.query("UPDATE mutation_resolutions SET evidence_json=? WHERE attempt_id=?").run('{"source":"provider_transport_lost"}', attempt.id)
          : source === "custody" ? db.query("UPDATE attachment_custody_sets SET origin_json=? WHERE id=(SELECT attachment_custody_id FROM mutation_attempts WHERE id=?)").run("{}", attempt.id)
          : db.query(`DELETE FROM ${table} WHERE attempt_id=?`).run(attempt.id);
        expect(changed.changes).toBe(1);
      });
      const before = snapshot(f.paths.database);
      expect(() => inspect(f.paths.database, (db) => readTerminalAttachmentAcknowledgment(db, attempt.id))).toThrow(INVALID);
      for (const readonly of [false, true]) {
        expect(() => { const opened = new StateStore(f.paths, { readonly }); opened.close(); }).toThrow();
        expect(snapshot(f.paths.database)).toEqual(before);
      }
    });
  }

  test("the keyset audit visits a missing anchor on the 101st real current acknowledgment", async () => {
    const f = await fixture();
    // Independent sessions satisfy the real one-unsettled-input-per-session
    // rule; each release occurs before reserving the next global custody slot.
    for (let index = 0; index < 101; index++) {
      const target = index === 0 ? f.session : f.store.upsertProviderSession({
        profileId: f.authority.profileId, provider: "codex", providerAuthority: f.authority,
        providerAccountKey: `v1:codex:${hash("terminal-ack@example.com")}`,
        providerThreadId: `ack-page-${String(index)}`, title: "Independent audit page source",
        preset: "high", fastEnabled: false, state: "active", activeTurnId: "terminal-ack-turn" });
      f.add(1, target);
      f.terminalize("provider_thread_deleted", target);
      expect(f.store.acknowledgeTerminalSessionInputCustody({ sessionId: target.id,
        expectedRevision: f.store.requireSession(target.id).revision }).releasedInputCount).toBe(1);
    }
    const ids = inspect(f.paths.database, (db) => {
      db.transaction(() => auditTerminalAttachmentAcknowledgments(db)).deferred();
      return db.query<{ attempt_id: string }, []>("SELECT attempt_id FROM attachment_terminal_acknowledgments ORDER BY attempt_id").all();
    });
    expect(ids.length).toBe(101);
    const last = ids[100];
    if (last === undefined) throw new Error("Expected a second audit page.");
    corrupt(f.paths.database, ["attachment_terminal_acknowledgment_anchors"], (db) => {
      expect(db.query("DELETE FROM attachment_terminal_acknowledgment_anchors WHERE attempt_id=?").run(last.attempt_id).changes).toBe(1);
    });
    const before = snapshot(f.paths.database);
    inspect(f.paths.database, (db) => {
      for (const row of ids.slice(0, 100)) expect(readTerminalAttachmentAcknowledgment(db, row.attempt_id)).not.toBeNull();
      expect(() => db.transaction(() => auditTerminalAttachmentAcknowledgments(db)).deferred()).toThrow(INVALID);
    });
    expect(snapshot(f.paths.database)).toEqual(before);
  }, 60_000);
});
