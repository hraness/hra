import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  applyRetiredProviderAdmissionGuards,
  auditRetiredProviderAdmissionGuards,
  RETIRED_PROVIDER_ADMISSION_GUARDS,
} from "./retired-provider-admission";

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(false); });
const refusal = "RETIRED_PROVIDER_ADMISSION_REFUSED";
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Deliberately minimal projections of the real parent columns referenced by
// these additive guards. This proves each guard's SQL predicate, not the full
// StateStore DDL, migration admission, or an authentic archived producer.
const tables = {
  profiles: "id TEXT PRIMARY KEY,state TEXT,process_generation INTEGER,created_at INTEGER,updated_at INTEGER",
  provider_accounts: "id TEXT PRIMARY KEY,profile_id TEXT,provider TEXT,readiness TEXT,binding_generation INTEGER,process_generation INTEGER,order_position INTEGER,readiness_observed_at INTEGER,provider_email TEXT,provider_plan TEXT,created_at INTEGER,updated_at INTEGER",
  provider_account_states: "provider TEXT PRIMARY KEY,order_revision INTEGER,pointer_revision INTEGER,active_provider_account_id TEXT,updated_at INTEGER",
  sessions: "id TEXT PRIMARY KEY,provider_v39 TEXT,profile_id TEXT,provider_thread_id TEXT,state TEXT",
  session_provider_authorities: "session_id TEXT PRIMARY KEY,provider TEXT,process_generation INTEGER",
  session_provider_account_authorities: "session_id TEXT PRIMARY KEY,provider TEXT,account_key TEXT",
  session_provider_authority_successors: "id TEXT PRIMARY KEY,from_provider TEXT,to_provider TEXT",
  session_start_attempts: "id TEXT PRIMARY KEY,session_id TEXT",
  mutation_attempts: "id TEXT PRIMARY KEY,kind TEXT,authority_id TEXT,state TEXT",
  mutation_provider_authorities: "attempt_id TEXT PRIMARY KEY,provider TEXT",
  mutation_effect_evidence: "attempt_id TEXT PRIMARY KEY,kind TEXT,evidence_json TEXT",
  mutation_resolutions: "attempt_id TEXT PRIMARY KEY,resolution_kind TEXT",
  session_send_owners: "attempt_id TEXT PRIMARY KEY,session_id TEXT,owner_json TEXT",
  session_send_execution_claims: "attempt_id TEXT PRIMARY KEY,claim_json TEXT",
  session_send_owner_outcomes: "attempt_id TEXT PRIMARY KEY,outcome_json TEXT",
  attachment_custody_sets: "id TEXT PRIMARY KEY,origin_json TEXT",
  attachment_custody_anchors: "id TEXT PRIMARY KEY,kind TEXT,attempt_id TEXT,proof_json TEXT",
  attachment_custody_dispositions: "id TEXT PRIMARY KEY,kind TEXT,attempt_id TEXT,custody_id TEXT",
  queue_entries: "id TEXT PRIMARY KEY,session_id TEXT,state TEXT",
  queue_provider_authorities: "queue_id TEXT PRIMARY KEY,provider TEXT",
  queue_attachment_identities: "queue_id TEXT PRIMARY KEY,identity_json TEXT",
  queue_effect_evidence: "queue_id TEXT PRIMARY KEY",
  queue_effect_resolutions: "queue_id TEXT PRIMARY KEY,resolution_kind TEXT",
  session_switch_attempts: "attempt_id TEXT PRIMARY KEY,source_provider TEXT,target_provider TEXT,phase TEXT",
  interaction_provider_authorities: "public_id TEXT PRIMARY KEY,provider TEXT",
  provider_interactions: "public_id TEXT PRIMARY KEY,session_id TEXT,method TEXT,state TEXT",
  devin_joined_close_intents: "id TEXT PRIMARY KEY",
  devin_joined_close_snapshots: "id TEXT PRIMARY KEY",
  devin_joined_close_receipts: "id TEXT PRIMARY KEY",
  devin_joined_close_consumptions: "id TEXT PRIMARY KEY",
  devin_joined_close_anchors: "id TEXT PRIMARY KEY",
} as const;
const snapshot = (db: Database) => Object.keys(tables).map((table) => ({ table,
  rows: db.query(`SELECT * FROM ${quote(table)}`).all().map((row) => JSON.stringify(row)).sort() }));

function fixture(install = true) {
  const db = new Database(":memory:", { strict: true });
  databases.push(db);
  for (const [table, columns] of Object.entries(tables)) db.exec(`CREATE TABLE ${table}(${columns}) STRICT`);
  for (const provider of ["codex", "claude", "devin"]) {
    db.query("INSERT INTO profiles VALUES(?,?,?,?,?)").run(provider, "signed_in", 7, 10, 30);
    db.query("INSERT INTO provider_accounts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(provider, provider, provider, "signed_in", 4, 7, 1, 20, null, null, 10, 30);
    db.query("INSERT INTO provider_account_states VALUES(?,?,?,?,?)").run(provider, 8, 3, provider, 30);
    db.query("INSERT INTO sessions VALUES(?,?,?,?,?)").run(provider, provider, provider, `thread-${provider}`, "idle");
    db.query("INSERT INTO session_provider_authorities VALUES(?,?,?)").run(provider, provider, 7);
    db.query("INSERT INTO session_provider_account_authorities VALUES(?,?,?)").run(provider, provider, `key-${provider}`);
    db.query("INSERT INTO mutation_attempts VALUES(?,?,?,?)").run(provider, "session.send", provider, "prepared");
    db.query("INSERT INTO mutation_provider_authorities VALUES(?,?)").run(provider, provider);
    db.query("INSERT INTO session_send_owners VALUES(?,?,?)").run(provider, provider, JSON.stringify({ sourceAuthority: { provider } }));
    db.query("INSERT INTO attachment_custody_sets VALUES(?,?)").run(provider,
      JSON.stringify({ input: { sessionId: provider, authority: { provider } } }));
    db.query("INSERT INTO queue_entries VALUES(?,?,?)").run(provider, provider, "pending");
    db.query("INSERT INTO queue_provider_authorities VALUES(?,?)").run(provider, provider);
    db.query("INSERT INTO session_switch_attempts VALUES(?,?,?,?)").run(provider, provider, "codex", "prepared");
    db.query("INSERT INTO provider_interactions VALUES(?,?,?,?)").run(provider, provider,
      provider === "devin" ? "devin/session/request_permission" : "item/tool/requestUserInput", "pending");
    db.query("INSERT INTO interaction_provider_authorities VALUES(?,?)").run(provider, provider);
  }
  for (const suffix of ["intents", "snapshots", "receipts", "consumptions", "anchors"]) {
    db.exec(`INSERT INTO devin_joined_close_${suffix} VALUES('historical')`);
  }
  db.exec("INSERT INTO profiles VALUES('bootstrap','signed_out',0,40,40)");
  if (install) applyRetiredProviderAdmissionGuards(db);
  return db;
}

type Case = Readonly<{ name: string; run: (db: Database, provider: "codex" | "devin") => void }>;
const cases: readonly Case[] = [
  { name: "session insert", run: (db, p) => { db.query("INSERT INTO sessions VALUES('new',?,?,'new-thread','idle')").run(p, p); } },
  { name: "session rebind", run: (db, p) => { db.query("UPDATE sessions SET provider_thread_id='replacement' WHERE id=?").run(p); } },
  { name: "captured authority insert", run: (db, p) => { db.query("INSERT INTO session_provider_authorities VALUES('new',?,7)").run(p); } },
  { name: "captured authority rebind", run: (db, p) => { db.query("UPDATE session_provider_authorities SET process_generation=8 WHERE session_id=?").run(p); } },
  { name: "account binding insert", run: (db, p) => { db.query("INSERT INTO session_provider_account_authorities VALUES('new',?,'new-key')").run(p); } },
  { name: "account binding rebind", run: (db, p) => { db.query("UPDATE session_provider_account_authorities SET account_key='replacement' WHERE session_id=?").run(p); } },
  { name: "successor source", run: (db, p) => { db.query("INSERT INTO session_provider_authority_successors VALUES('new',?,'claude')").run(p); } },
  { name: "successor target", run: (db, p) => { db.query("INSERT INTO session_provider_authority_successors VALUES('new','claude',?)").run(p); } },
  { name: "start attempt", run: (db, p) => { db.query("INSERT INTO session_start_attempts VALUES('new',?)").run(p); } },
  { name: "effect-started mutation insert", run: (db, p) => { db.query("INSERT INTO mutation_attempts VALUES('new','session.send',?,'effect_started')").run(p); } },
  { name: "prepared mutation begin", run: (db, p) => { db.query("UPDATE mutation_attempts SET state='effect_started' WHERE id=?").run(p); } },
  { name: "effect evidence parent", run: (db, p) => { db.query("INSERT INTO mutation_effect_evidence VALUES(?,'session.send','{}')").run(p); } },
  { name: "effect evidence switch target", run: (db, p) => { db.query("INSERT INTO mutation_effect_evidence VALUES('new','session.switch',?)").run(JSON.stringify({ targetProvider: p })); } },
  { name: "effect evidence switch source", run: (db, p) => { db.query("INSERT INTO mutation_effect_evidence VALUES('new','session.switch',?)").run(JSON.stringify({ sourceProvider: p })); } },
  { name: "owner source session", run: (db, p) => { db.query("INSERT INTO session_send_owners VALUES('new',?,'{}')").run(p); } },
  { name: "owner source document", run: (db, p) => { db.query("INSERT INTO session_send_owners VALUES('new','codex',?)").run(JSON.stringify({ sourceAuthority: { provider: p } })); } },
  { name: "claim parent", run: (db, p) => { db.query("INSERT INTO session_send_execution_claims VALUES(?,'{}')").run(p); } },
  { name: "claim document", run: (db, p) => { db.query("INSERT INTO session_send_execution_claims VALUES('new',?)").run(JSON.stringify({ executionAuthority: { provider: p } })); } },
  { name: "custody document", run: (db, p) => { db.query("INSERT INTO attachment_custody_sets VALUES('new',?)").run(JSON.stringify({ input: { authority: { provider: p }, sessionId: "codex" } })); } },
  { name: "custody source session", run: (db, p) => { db.query("INSERT INTO attachment_custody_sets VALUES('new',?)").run(JSON.stringify({ input: { authority: { provider: "codex" }, sessionId: p } })); } },
  { name: "empty input parent", run: (db, p) => { db.query("INSERT INTO attachment_custody_anchors VALUES('new','empty_input_v1',?,'{}')").run(p); } },
  { name: "custody adoption", run: (db, p) => { db.query("INSERT INTO attachment_custody_dispositions VALUES('new','mutation_owned',?,?)").run(p, p); } },
  { name: "custody queue transfer", run: (db, p) => { db.query("INSERT INTO attachment_custody_dispositions VALUES('new','queue_transferred',NULL,?)").run(p); } },
  { name: "queue insert", run: (db, p) => { db.query("INSERT INTO queue_entries VALUES('new',?,'pending')").run(p); } },
  { name: "queue dispatch", run: (db, p) => { db.query("UPDATE queue_entries SET state='dispatching' WHERE id=?").run(p); } },
  { name: "queue authority", run: (db, p) => { db.query("INSERT INTO queue_provider_authorities VALUES('new',?)").run(p); } },
  { name: "queue identity parent", run: (db, p) => { db.query("INSERT INTO queue_attachment_identities VALUES(?,'{}')").run(p); } },
  { name: "queue identity document", run: (db, p) => { db.query("INSERT INTO queue_attachment_identities VALUES('new',?)").run(JSON.stringify({ authority: { provider: p } })); } },
  { name: "queue effect", run: (db, p) => { db.query("INSERT INTO queue_effect_evidence VALUES(?)").run(p); } },
  { name: "switch source", run: (db, p) => { db.query("INSERT INTO session_switch_attempts VALUES('new',?,'claude','prepared')").run(p); } },
  { name: "switch target", run: (db, p) => { db.query("INSERT INTO session_switch_attempts VALUES('new','claude',?,'prepared')").run(p); } },
  { name: "switch begin", run: (db, p) => { db.query("UPDATE session_switch_attempts SET phase='target_starting' WHERE attempt_id=?").run(p); } },
  { name: "interaction authority", run: (db, p) => { db.query("INSERT INTO interaction_provider_authorities VALUES('new',?)").run(p); } },
  { name: "interaction source", run: (db, p) => { db.query("INSERT INTO provider_interactions VALUES('new',?,'item/tool/requestUserInput','pending')").run(p); } },
  { name: "interaction response", run: (db, p) => { db.query("UPDATE provider_interactions SET state='response_prepared' WHERE public_id=?").run(p); } },
];

describe("additive retired provider SQL admission", () => {
  test("installation and exact schema audit preserve historical rows and are idempotent", () => {
    const db = fixture(false);
    const before = snapshot(db);
    applyRetiredProviderAdmissionGuards(db);
    expect(snapshot(db)).toEqual(before);
    expect(() => auditRetiredProviderAdmissionGuards(db)).not.toThrow();
    const schema = db.query("SELECT * FROM sqlite_master ORDER BY name").all();
    applyRetiredProviderAdmissionGuards(db);
    expect(db.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(snapshot(db)).toEqual(before);
    expect(Object.isFrozen(RETIRED_PROVIDER_ADMISSION_GUARDS)).toBe(true);
    expect(RETIRED_PROVIDER_ADMISSION_GUARDS.every(Object.isFrozen)).toBe(true);
  });

  for (const scenario of cases) test(`${scenario.name}: supported control succeeds, retired admission is inert`, () => {
    const control = fixture();
    expect(() => scenario.run(control, "codex")).not.toThrow();
    const db = fixture();
    const before = snapshot(db);
    expect(() => scenario.run(db, "devin")).toThrow(refusal);
    expect(snapshot(db)).toEqual(before);
  });

  test.each(["intents", "snapshots", "receipts", "consumptions", "anchors"])("no new joined-close %s", (suffix) => {
    const db = fixture();
    const before = snapshot(db);
    expect(() => db.exec(`INSERT INTO devin_joined_close_${suffix} VALUES('new')`)).toThrow(refusal);
    expect(snapshot(db)).toEqual(before);
  });

  test("only inert new profile bootstrap metadata is admitted", () => {
    const db = fixture();
    const insert = (readiness: string, generation: number, binding: number, email: string | null, observed: number | null) =>
      db.query("INSERT INTO provider_accounts VALUES('new','bootstrap','devin',?,?,?,2,?,?,NULL,40,40)")
        .run(readiness, binding, generation, observed, email);
    const before = snapshot(db);
    for (const [readiness, generation, binding, email, observed] of [
      ["signed_in", 0, 1, null, null], ["unverified", 1, 1, null, null],
      ["unverified", 0, 2, null, null], ["unverified", 0, 1, "identity", null],
      ["unverified", 0, 1, null, 40],
    ] as const) {
      expect(() => insert(readiness, generation, binding, email, observed)).toThrow(refusal);
      expect(snapshot(db)).toEqual(before);
    }
    expect(() => insert("unverified", 0, 1, null, null)).not.toThrow();
  });

  test("authority fields are frozen while inert ordering and exact profile retirement remain possible", () => {
    const db = fixture();
    const before = snapshot(db);
    for (const change of ["readiness='unverified'", "process_generation=8", "binding_generation=5",
      "readiness_observed_at=31", "provider_email='identity'", "provider_plan='plan'", "provider='claude'"]) {
      expect(() => db.exec(`UPDATE provider_accounts SET ${change} WHERE id='devin'`)).toThrow(refusal);
      expect(snapshot(db)).toEqual(before);
    }
    expect(() => db.exec("UPDATE provider_accounts SET order_position=201,updated_at=31 WHERE id='devin'"))
      .not.toThrow();
    expect(() => db.exec("UPDATE provider_account_states SET order_revision=9,pointer_revision=4,active_provider_account_id=NULL WHERE provider='devin'"))
      .not.toThrow();
    const removal = "UPDATE provider_accounts SET readiness='removed',binding_generation=5,order_position=NULL,readiness_observed_at=41,provider_email=NULL,provider_plan=NULL,updated_at=41 WHERE id='devin'";
    expect(() => db.exec(removal)).toThrow(refusal);
    db.exec("UPDATE profiles SET state='removed',updated_at=41 WHERE id='devin'");
    expect(() => db.exec(removal.replace("binding_generation=5", "binding_generation=6"))).toThrow(refusal);
    expect(() => db.exec(removal.replace("updated_at=41", "updated_at=42"))).toThrow(refusal);
    expect(() => db.exec(removal)).not.toThrow();
    expect(db.query("SELECT readiness,process_generation,binding_generation,order_position FROM provider_accounts WHERE id='devin'").get())
      .toEqual({ readiness: "removed", process_generation: 7, binding_generation: 5, order_position: null });
  });

  test("login and profile-scoped permission methods cannot bypass session joins", () => {
    const db = fixture();
    const before = snapshot(db);
    expect(() => db.exec("INSERT INTO mutation_attempts VALUES('new','account.devin-login','devin','prepared')")).toThrow(refusal);
    expect(() => db.exec("INSERT INTO provider_interactions VALUES('new',NULL,'devin/session/request_permission','pending')")).toThrow(refusal);
    expect(snapshot(db)).toEqual(before);
  });

  test("terminal receipts, cancellations, local abandonment and custody cleanup are not execution admission", () => {
    const db = fixture();
    db.exec("INSERT INTO mutation_attempts VALUES('tombstone','session.send','devin','prepared')");
    db.exec("UPDATE mutation_attempts SET state='cancelled' WHERE id='tombstone'");
    db.exec("UPDATE mutation_attempts SET state='applied' WHERE id='devin'");
    db.exec("INSERT INTO mutation_resolutions VALUES('devin','abandoned')");
    db.exec("INSERT INTO session_send_owner_outcomes VALUES('devin','{\"kind\":\"abandoned\"}')");
    db.exec("UPDATE queue_entries SET state='cancelled' WHERE id='devin'");
    db.exec("INSERT INTO queue_effect_resolutions VALUES('devin','abandoned')");
    db.exec("UPDATE provider_interactions SET state='resolution_unknown' WHERE public_id='devin'");
    db.exec("UPDATE session_switch_attempts SET phase='reconciliation_required' WHERE attempt_id='devin'");
    db.exec("UPDATE session_switch_attempts SET phase='abandoned' WHERE attempt_id='devin'");
    db.exec("UPDATE sessions SET state='terminal' WHERE id='devin'");
    for (const kind of ["released", "boot_retired", "terminal"]) {
      db.query("INSERT INTO attachment_custody_dispositions VALUES(?,?,?,?)").run(kind, kind, "devin", "devin");
    }
    expect(db.query("SELECT process_generation FROM provider_accounts WHERE id='devin'").get()).toEqual({ process_generation: 7 });
    expect(() => auditRetiredProviderAdmissionGuards(db)).not.toThrow();
  });

  test("schema audit refuses missing, replaced and unexpected guards without repairing them", () => {
    for (const corruption of ["missing", "changed", "extra"] as const) {
      const db = fixture();
      const first = RETIRED_PROVIDER_ADMISSION_GUARDS[0];
      if (first === undefined) throw new Error("Expected guard definitions.");
      if (corruption !== "extra") db.exec(`DROP TRIGGER ${first.name}`);
      if (corruption === "changed") db.exec(first.sql.replace(refusal, "altered refusal"));
      if (corruption === "extra") db.exec("CREATE TRIGGER retired_provider_extra BEFORE INSERT ON profiles BEGIN SELECT 1; END");
      const before = db.query("SELECT * FROM sqlite_master ORDER BY name").all();
      expect(() => auditRetiredProviderAdmissionGuards(db)).toThrow("RETIRED_PROVIDER_ADMISSION_SCHEMA_INVALID");
      expect(db.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
      if (corruption !== "missing") {
        expect(() => applyRetiredProviderAdmissionGuards(db)).toThrow("RETIRED_PROVIDER_ADMISSION_SCHEMA_INVALID");
        expect(db.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
      }
    }
  });
});
