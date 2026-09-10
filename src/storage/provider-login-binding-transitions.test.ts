import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import { canonicalAuthBudgetDatabaseBytes, canonicalAuthBudgetFixtures } from "../../scripts/fixtures/canonical-auth-budget";
import { attemptIdSchema, profileIdSchema } from "../domain/values";
import { readMutationEffectEvidenceProvenance, type EffectEvidenceProvenanceFormat } from "./effect-evidence-provenance";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { assertProviderLoginBindingTransitionSchema, auditProviderLoginBindingTransitions, prepareProviderLoginBindingTransition,
  readProviderLoginBindingAuthority } from "./provider-login-binding-transitions";
import { StateStore } from "./state-store";

const stores: StateStore[] = [];
const roots: string[] = [];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshot = (db: Database) => ({
  schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
  rows: db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => ({ name, digest: hash(db.query(`SELECT * FROM ${quote(name)}`).all()
      .map((row) => JSON.stringify(row)).sort()) })),
});
const inspect = (path: string) => {
  const db = new Database(path, { strict: true });
  db.exec("PRAGMA foreign_keys=ON");
  return db;
};
// Deliberately corrupt this owned synthetic fixture, then restore the exact
// observed guards before exercising the real reader or a new SQL transition.
const corrupt = (db: Database, table: string, edit: () => void) => {
  const guards = db.query<{ name: string; sql: string }, [string]>(
    "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name",
  ).all(table);
  db.transaction(() => {
    for (const guard of guards) db.exec(`DROP TRIGGER ${quote(guard.name)}`);
    edit();
    for (const guard of guards) db.exec(guard.sql);
  }).immediate();
  expect(db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table))
    .toEqual(guards);
};
const corruptTables = (db: Database, tables: readonly string[], edit: () => void): void => {
  const [table, ...rest] = tables;
  if (table === undefined) edit();
  else corrupt(db, table, () => corruptTables(db, rest, edit));
};
type FixtureRow = Record<string, string | number | null>;
function cloneFixtureRow(db: Database, table: string, key: string, source: string, target: string,
  changes: FixtureRow = {}) {
  const row = db.query<FixtureRow, [string]>(`SELECT * FROM ${quote(table)} WHERE ${quote(key)}=?`).get(source);
  if (row === null) throw new Error("Missing clone fixture row.");
  const next = { ...row, [key]: target, ...changes };
  db.query(`INSERT INTO ${quote(table)}(${Object.keys(next).map(quote).join(",")})
    VALUES(${Object.keys(next).map(() => "?").join(",")})`).run(...Object.values(next));
}
// Deliberate test corruption of both immutable witnesses, not historical source
// admission. Recompute the documented preimage so the selected codec still
// independently parses the unchanged raw effect; the login reader must reject
// the wrong dialect or ambiguous identity instead of relying on a stale hash.
function replaceFixtureProvenance(db: Database, id: string, format: EffectEvidenceProvenanceFormat) {
  const meta = db.query<FixtureRow, [string]>(`SELECT attempt_id AS row_id,parent_kind,parent_authority_id,
    parent_authority_generation_decimal,evidence_kind,stored_digest,recorded_at_decimal,raw_sha256,raw_byte_length
    FROM mutation_effect_evidence_provenance WHERE attempt_id=?`).get(id);
  const value = db.query<{ projection_json: string; opaque_reason: null }, [string]>(
    "SELECT projection_json,opaque_reason FROM mutation_effect_evidence_provenance WHERE attempt_id=?",
  ).get(id);
  if (meta === null || value === null) throw new Error("Missing provenance fixture.");
  const digest = hash({ domain: "hra:effect-evidence-provenance:v1", scope: "mutation", ...meta, format, ...value });
  db.query("UPDATE mutation_effect_evidence_provenance SET format=?,provenance_digest=? WHERE attempt_id=?").run(format, digest, id);
  db.query("UPDATE mutation_effect_evidence_provenance_anchors SET provenance_digest=? WHERE attempt_id=?").run(digest, id);
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Real StateStore state machines with synthetic provider receipts. No provider
// process runs, and these current rows are not historical capture evidence.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-login-binding-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  let now = 1_800_000_000_000;
  const store = new StateStore(paths, { now: () => now++, resolveMachineTimeZone: () => "UTC" });
  stores.push(store);
  const profile = store.createProfile("Pending recovery");
  const loginKey = randomUUID();
  const login = store.prepareMutation({ kind: "account.login", authorityId: profile.id,
    authorityGeneration: 1, request: { deviceCode: true }, idempotencyKey: loginKey });
  const work = store.createWorkStore(1, () => "unused-login-cursor", {
    issue: () => `hrac1_${"A".repeat(43)}`, verify: () => true,
  });
  for (const runtimeScope of ["personal", "managed"] as const) {
    const begun = store.beginProviderRuntimeAccountRevocation({ profileId: profile.id,
      expectedGeneration: 0, provider: "codex", runtimeScope, currentAccountKey: null, workStore: work });
    store.completeProviderRuntimeAccountRevocation({ profileId: profile.id, expectedGeneration: 0,
      provider: "codex", runtimeScope, expectedRevision: begun.revocation.revision });
  }
  store.beginAccountMutationEffect({ providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
    attemptId: login.id, profileId: profile.id, profileGeneration: 1,
    evidence: { kind: "account.login", method: "device_code" } });
  const loginId = "pending-binding-login";
  store.completeAccountLoginMutation({ attemptId: login.id, profileId: profile.id, processGeneration: 1,
    receipt: { status: "pending", loginId } });
  const cancel = () => {
    const authority = store.requireProviderAccountAuthority(profile.id, "codex");
    const key = randomUUID();
    const attempt = store.prepareMutation({ kind: "account.login-cancel", authorityId: profile.id,
      authorityGeneration: authority.processGeneration, request: { loginId }, idempotencyKey: key });
    store.beginLoginCancelMutationEffect({ providerAuthority: authority, attemptId: attempt.id,
      profileId: profile.id, processGeneration: authority.processGeneration, loginId });
    return { key, attempt };
  };
  const reboot = (index: number) => store.nextDaemonGeneration(`boot_${String(index).padStart(32, "0")}`);
  return { store, profile, paths, login, loginKey, loginId, cancel, reboot };
}

// Authentic source-produced v45 input, with synthetic provider receipts already
// captured by that source. All subsequent operations are explicitly current
// integration behavior, never evidence of an old binding-transition writer.
async function historical45Fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-login-binding-auth45-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonicalAuthBudgetDatabaseBytes(45);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(canonicalAuthBudgetFixtures[45].databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  const captured = canonicalAuthBudgetFixtures[45].retained;
  const profileId = profileIdSchema.parse(captured.loginProfile.id);
  const cancelId = attemptIdSchema.parse(captured.cancellation.id);
  const db = inspect(paths.database);
  try {
    const raw = db.query<{ attempt_id: string }, [string]>(
      "SELECT attempt_id FROM provider_login_authorities WHERE profile_id=? AND state='active'",
    ).get(profileId);
    const loginId = attemptIdSchema.parse(raw?.attempt_id);
    const original = () => ({
      login: db.query("SELECT id,request_digest,authority_generation,result_json FROM mutation_attempts WHERE id=?").get(loginId),
      cancel: db.query("SELECT id,request_digest,authority_generation FROM mutation_attempts WHERE id=?").get(cancelId),
      effects: db.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id IN (?,?) ORDER BY attempt_id").all(loginId, cancelId),
    });
    const before = original();
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 45 });
    for (const table of ["session_mutation_authority_rebinds", "session_mutation_authority_rebinds_v39"]) {
      expect(db.query(`SELECT * FROM ${table} WHERE attempt_id=?`).all(loginId)).toEqual([]);
    }
    expect(db.query("SELECT from_generation,to_generation FROM account_mutation_authority_rebinds WHERE attempt_id=?").all(cancelId))
      .toEqual([{ from_generation: 1, to_generation: 2 }]);
    let now = 51_000;
    const store = new StateStore(paths, { now: () => now++, resolveMachineTimeZone: () => "UTC" });
    stores.push(store);
    expect(original()).toEqual(before);
    expect(db.query("SELECT * FROM provider_login_binding_transitions").all()).toEqual([]);
    expect(db.query("SELECT format FROM mutation_effect_evidence_provenance WHERE attempt_id IN (?,?) ORDER BY attempt_id").all(loginId, cancelId))
      .toEqual([{ format: "canonical_sol43_v1" }, { format: "canonical_sol43_v1" }]);
    expect(db.query("SELECT binding_generation,process_generation,provenance FROM account_scoped_provider_authorities WHERE scope_kind='provider_login' AND scope_id=?").get(loginId))
      .toEqual({ binding_generation: 1, process_generation: 2, provenance: "legacy_codex_compatibility" });
    return { store, paths, profileId, cancelId, loginId, captured, before };
  } finally { db.close(false); }
}

describe("pending login binding transition witnesses", () => {
  test("dedicated cancellation recovery preserves the independent explicit quarantine refusal", async () => {
    const f = await fixture();
    const cancellation = f.cancel();
    const authority = f.store.requireProviderAccountAuthority(f.profile.id, "codex");
    expect(f.store.readAccountRecoveryMutation(authority)?.id).toBe(cancellation.attempt.id);
    const db = inspect(f.paths.database);
    try {
      db.query(`INSERT INTO legacy_provider_authority_quarantines(scope_kind,scope_id,reason,recorded_at)
        VALUES('mutation',?,'unsettled_provider_authority_unproved',1800000000100)`).run(cancellation.attempt.id);
      const before = snapshot(db);
      expect(() => f.store.readAccountRecoveryMutation(authority)).toThrow("MUTATION_RECOVERY_PROVIDER_AUTHORITY_MISMATCH");
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(false); }
  });

  test("another readable selected dialect cannot substitute for the exact imported login or cancellation source", async () => {
    const f = await historical45Fixture();
    const db = inspect(f.paths.database);
    try {
      const before = snapshot(db);
      for (const id of [f.loginId, f.cancelId]) {
        for (const format of ["canonical41_v1", "canonical49_v1", "combined49_v1", "joined_v1"] as const) {
          corruptTables(db, ["mutation_effect_evidence_provenance", "mutation_effect_evidence_provenance_anchors"],
            () => replaceFixtureProvenance(db, id, format));
          expect(readMutationEffectEvidenceProvenance(db, id)).toMatchObject({ kind: "parsed", format });
          const bad = snapshot(db);
          expect(() => f.store.readPendingLoginAuthority(f.profileId, 2)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
          expect(snapshot(db)).toEqual(bad);
          corruptTables(db, ["mutation_effect_evidence_provenance", "mutation_effect_evidence_provenance_anchors"],
            () => replaceFixtureProvenance(db, id, "canonical_sol43_v1"));
          expect(f.store.readPendingLoginAuthority(f.profileId, 2)?.attemptId).toBe(f.loginId);
          expect(snapshot(db)).toEqual(before);
        }
      }
    } finally { db.close(false); }
  });

  test("two fully parsed synthetic historical cancellation candidates never choose a baseline winner", async () => {
    const f = await historical45Fixture();
    const db = inspect(f.paths.database);
    try {
      const duplicate = attemptIdSchema.parse(`attempt_${"e".repeat(32)}`);
      const tables = ["mutation_attempts", "mutation_effect_evidence", "mutation_provider_authorities",
        "account_mutation_authority_rebinds", "mutation_effect_evidence_provenance", "mutation_effect_evidence_provenance_anchors"];
      corruptTables(db, tables, () => {
        for (const table of tables) cloneFixtureRow(db, table, table === "mutation_attempts" ? "id" : "attempt_id",
          f.cancelId, duplicate, table === "mutation_attempts" ? { idempotency_key: randomUUID() } : {});
        replaceFixtureProvenance(db, duplicate, "canonical_sol43_v1");
      });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const id of [f.cancelId, duplicate]) {
        expect(readMutationEffectEvidenceProvenance(db, id)).toMatchObject({ kind: "parsed", format: "canonical_sol43_v1" });
        expect(db.query("SELECT from_generation,to_generation FROM account_mutation_authority_rebinds WHERE attempt_id=?").all(id))
          .toEqual([{ from_generation: 1, to_generation: 2 }]);
      }
      const before = snapshot(db);
      expect(() => f.store.readPendingLoginAuthority(f.profileId, 2)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(false); }
  });

  test("raw SQL cannot hide a malformed other-login candidate behind missing selected proof", async () => {
    const f = await historical45Fixture();
    const db = inspect(f.paths.database);
    try {
      f.store.resolveLoginCancelMutation({ attemptId: f.cancelId, expectedOriginalState: "ambiguous",
        expectedProviderAuthority: f.store.requireProviderAccountAuthority(f.profileId, "codex"), provider: { signedIn: false } });
      let intent: FixtureRow | null = null;
      expect(() => db.transaction(() => {
        prepareProviderLoginBindingTransition(db, { profileId: f.profileId, cancellationAttemptId: f.cancelId,
          cause: "cancellation_reconciled_pending", recordedAt: 52_000 });
        intent = db.query<FixtureRow, []>("SELECT * FROM provider_login_binding_transitions").get();
        throw new Error("valid intent rollback");
      }).immediate()).toThrow("valid intent rollback");
      const duplicate = attemptIdSchema.parse(`attempt_${"e".repeat(32)}`);
      corruptTables(db, ["mutation_attempts", "mutation_effect_evidence"], () => {
        cloneFixtureRow(db, "mutation_attempts", "id", f.cancelId, duplicate, { idempotency_key: randomUUID() });
        const evidence = JSON.stringify({ kind: "account.login-cancel", loginId: "another-login" });
        cloneFixtureRow(db, "mutation_effect_evidence", "attempt_id", f.cancelId, duplicate,
          { evidence_json: evidence, evidence_digest: createHash("sha256").update(evidence).digest("hex") });
      });
      const before = snapshot(db);
      expect(() => f.store.readPendingLoginAuthority(f.profileId, 2)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
      expect(() => db.transaction(() => {
        if (intent === null) throw new Error("Missing captured intent.");
        db.query(`INSERT INTO provider_login_binding_transitions(${Object.keys(intent).map(quote).join(",")})
          VALUES(${Object.keys(intent).map(() => "?").join(",")})`).run(...Object.values(intent));
      }).immediate()).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(false); }
  });

  test("schema audit bounds SQL before fetching and rejects missing or temp-shadowed metadata without writes", async () => {
    const f = await fixture();
    const db = inspect(f.paths.database);
    try {
      const name = "provider_login_binding_profile_update_guard";
      const guard = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name=?").get(name);
      if (guard === null) throw new Error("Missing fixture guard.");
      const before = snapshot(db);
      const attacks = [
        () => { db.exec(`DROP TRIGGER ${name}`); },
        () => { db.exec(`CREATE TEMP TRIGGER ${name} BEFORE UPDATE ON main.profiles BEGIN SELECT 1; END`); },
        () => { db.exec(`DROP TRIGGER ${name}`); db.exec(guard.sql.replace("BEFORE UPDATE", `/*${"x".repeat(131_072)}*/ BEFORE UPDATE`)); },
      ];
      for (const attack of attacks) {
        expect(() => db.transaction(() => {
          attack();
          const bad = snapshot(db);
          expect(() => assertProviderLoginBindingTransitionSchema(db)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
          expect(snapshot(db)).toEqual(bad);
          throw new Error("restore fixture metadata");
        }).immediate()).toThrow("restore fixture metadata");
        expect(snapshot(db)).toEqual(before);
        expect(db.query("SELECT name FROM sqlite_temp_master").all()).toEqual([]);
      }
    } finally { db.close(false); }
  });

  test.each(["wrong_scope_provenance", "missing_cancel_prefix", "changed_binding", "receipt", "missing_post_import_login_edge"] as const)(
    "refuses %s on a deliberately corrupted v45-derived fixture, retaining all rejected-read evidence", async (kind) => {
      const f = await historical45Fixture();
      const db = inspect(f.paths.database);
      try {
        let generation = 2;
        if (kind === "wrong_scope_provenance") corrupt(db, "account_scoped_provider_authorities", () => {
          db.query("UPDATE account_scoped_provider_authorities SET provenance='provider_login' WHERE scope_kind='provider_login' AND scope_id=?").run(f.loginId);
        });
        else if (kind === "missing_cancel_prefix") corrupt(db, "account_mutation_authority_rebinds", () => {
          db.query("DELETE FROM account_mutation_authority_rebinds WHERE attempt_id=? AND from_generation=1").run(f.cancelId);
        });
        else if (kind === "changed_binding") corrupt(db, "provider_accounts", () => {
          db.query("UPDATE provider_accounts SET binding_generation=3 WHERE id=?").run(f.profileId);
        });
        else if (kind === "receipt") corrupt(db, "mutation_attempts", () => {
          db.query("UPDATE mutation_attempts SET result_json=? WHERE id=?").run(JSON.stringify({ status: "pending", loginId: "different" }), f.loginId);
        });
        else {
          f.store.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
          generation = 3;
          corrupt(db, "session_mutation_authority_rebinds_v39", () => {
            db.query("DELETE FROM session_mutation_authority_rebinds_v39 WHERE attempt_id=? AND from_generation=2").run(f.loginId);
          });
        }
        const before = snapshot(db);
        expect(() => f.store.readPendingLoginAuthority(f.profileId, generation)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
        expect(() => f.store.readAccountRecoveryMutation(f.store.requireProviderAccountAuthority(f.profileId, "codex"))).toThrow();
        expect(snapshot(db)).toEqual(before);
      } finally { db.close(false); }
    },
  );

  test("fixed-seed imported scope generations never invent the missing historical login prefix", async () => {
    const f = await historical45Fixture();
    const db = inspect(f.paths.database);
    try {
      const before = snapshot(db);
      fc.assert(fc.property(fc.oneof(fc.constant(1), fc.integer({ min: 3, max: 50 }),
        fc.constant(Number.MAX_SAFE_INTEGER)), (generation) => {
        corrupt(db, "account_scoped_provider_authorities", () => {
          db.query("UPDATE account_scoped_provider_authorities SET process_generation=? WHERE scope_kind='provider_login' AND scope_id=?").run(generation, f.loginId);
        });
        const invalidRows = snapshot(db);
        expect(() => f.store.readPendingLoginAuthority(f.profileId, 2)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
        expect(snapshot(db)).toEqual(invalidRows);
        corrupt(db, "account_scoped_provider_authorities", () => {
          db.query("UPDATE account_scoped_provider_authorities SET process_generation=2 WHERE scope_kind='provider_login' AND scope_id=?").run(f.loginId);
        });
        expect(f.store.readPendingLoginAuthority(f.profileId, 2)?.attemptId).toBe(f.loginId);
        expect(snapshot(db)).toEqual(before);
      }), { seed: 0x45cafe, numRuns: 12 });
    } finally { db.close(false); }
  });

  test("imports the exact v45 cancellation baseline without inventing login successors or a quarantine edge", async () => {
    const f = await historical45Fixture();
    const db = inspect(f.paths.database);
    try {
      const current = () => f.store.requireProviderAccountAuthority(f.profileId, "codex");
      const assertPending = (generation: number) => {
        expect(f.store.readPendingLoginAuthority(f.profileId, generation))
          .toMatchObject({ attemptId: f.loginId, processGeneration: generation, loginId: f.captured.loginId });
      };
      const start = snapshot(db);
      assertPending(2);
      expect(f.store.readAccountRecoveryMutation(current())?.id).toBe(f.cancelId);
      expect(snapshot(db)).toEqual(start);
      expect(current()).toMatchObject({ bindingGeneration: 1, processGeneration: 2 });
      f.store.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
      assertPending(3);
      expect(f.store.recoverEffectStartedMutations().unresolved).toEqual([]);
      f.store.resolveLoginCancelMutation({ attemptId: f.cancelId, expectedOriginalState: "ambiguous",
        expectedProviderAuthority: current(), provider: { signedIn: false } });
      const cancellationChain = db.query("SELECT * FROM account_mutation_authority_rebinds WHERE attempt_id=? ORDER BY from_generation").all(f.cancelId);
      const resolution = db.query("SELECT * FROM mutation_resolutions WHERE attempt_id=?").get(f.cancelId);
      // Durable resolution followed by a process restart before restoration.
      f.store.nextDaemonGeneration(`boot_${"c".repeat(32)}`);
      assertPending(4);
      expect(db.query("SELECT * FROM provider_login_binding_transitions").all()).toEqual([]);
      f.store.reconcileProfileRecoveryFromAccountRead({ profileId: f.profileId, expectedGeneration: 4,
        expectedProviderAuthority: current(), provider: { signedIn: false } });
      assertPending(4);
      expect(current()).toMatchObject({ bindingGeneration: 2, processGeneration: 4 });
      expect(db.query("SELECT from_binding_generation,to_binding_generation,cause FROM provider_login_binding_transitions").all())
        .toEqual([{ from_binding_generation: 1, to_binding_generation: 2, cause: "cancellation_reconciled_pending" }]);
      // A later same-process cancellation is joined data, not a second imported
      // baseline candidate. It must acquire its own genuine quarantine witness.
      const key = randomUUID();
      const next = f.store.prepareMutation({ kind: "account.login-cancel", authorityId: f.profileId,
        authorityGeneration: 4, request: { loginId: f.captured.loginId }, idempotencyKey: key });
      f.store.beginLoginCancelMutationEffect({ providerAuthority: current(), attemptId: next.id,
        profileId: f.profileId, processGeneration: 4, loginId: f.captured.loginId });
      f.store.nextDaemonGeneration(`boot_${"d".repeat(32)}`);
      expect(f.store.recoverEffectStartedMutations().unresolved).toEqual([]);
      assertPending(5);
      expect(current()).toMatchObject({ bindingGeneration: 3, processGeneration: 5 });
      for (const table of ["session_mutation_authority_rebinds", "session_mutation_authority_rebinds_v39"]) {
        expect(db.query(`SELECT from_generation,to_generation FROM ${table} WHERE attempt_id=? ORDER BY from_generation`).all(f.loginId))
          .toEqual([2, 3, 4].map((from) => ({ from_generation: from, to_generation: from + 1 })));
      }
      expect(db.query("SELECT * FROM account_mutation_authority_rebinds WHERE attempt_id=? ORDER BY from_generation").all(f.cancelId))
        .toEqual(cancellationChain);
      expect(db.query("SELECT * FROM mutation_resolutions WHERE attempt_id=?").get(f.cancelId)).toEqual(resolution);
      expect(db.query("SELECT id,request_digest,authority_generation,result_json FROM mutation_attempts WHERE id=?").get(f.loginId))
        .toEqual(f.before.login);
      expect(db.query("SELECT id,request_digest,authority_generation FROM mutation_attempts WHERE id=?").get(f.cancelId))
        .toEqual(f.before.cancel);
      expect(db.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id IN (?,?) ORDER BY attempt_id").all(f.loginId, f.cancelId))
        .toEqual(f.before.effects);
      const stable = snapshot(db);
      for (const readonly of [true, false]) {
        const reopened = new StateStore(f.paths, { readonly, now: () => 55_000, resolveMachineTimeZone: () => "UTC" });
        try { expect(reopened.readPendingLoginAuthority(f.profileId, 5)?.attemptId).toBe(f.loginId); }
        finally { reopened.close(); }
      }
      expect(snapshot(db)).toEqual(stable);
    } finally { db.close(false); }
  });

  test("preserves an applied pending login across cancellation quarantine and three restarts", async () => {
    const f = await fixture();
    const cancellation = f.cancel();
    const db = new Database(f.paths.database, { readonly: true, strict: true });
    try {
      const original = db.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence ORDER BY attempt_id").all();
      for (let index = 1; index <= 3; index += 1) {
        f.reboot(index);
        expect(f.store.recoverEffectStartedMutations().unresolved).toEqual([]);
      }
      expect(f.store.readPendingLoginAuthority(f.profile.id, 4)).toMatchObject({
        attemptId: f.login.id, processGeneration: 4, loginId: f.loginId,
      });
      expect(f.store.readMutation(cancellation.key)?.state).toBe("ambiguous");
      expect(db.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence ORDER BY attempt_id").all())
        .toEqual(original);
    } finally { db.close(false); }
  });

  test("retains original bytes through resolve/crash/restart/restoration and a second distinct cancellation", async () => {
    const f = await fixture();
    const db = inspect(f.paths.database);
    try {
      const loginBytes = db.query("SELECT request_digest,result_json FROM mutation_attempts WHERE id=?").get(f.login.id);
      const loginEffect = db.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(f.login.id);
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const cancel = f.cancel();
        const original = db.query("SELECT request_digest,authority_generation FROM mutation_attempts WHERE id=?").get(cancel.attempt.id);
        const effect = db.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(cancel.attempt.id);
        f.reboot(cycle * 2 + 1);
        expect(f.store.recoverEffectStartedMutations().unresolved).toEqual([]);
        // The ordinary effect_started -> ambiguous transition records its
        // DAEMON_RESTART diagnostic; it is not an immutable provider receipt.
        const recoveryDiagnostic = db.query("SELECT result_json FROM mutation_attempts WHERE id=?").get(cancel.attempt.id);
        const current = () => f.store.requireProviderAccountAuthority(f.profile.id, "codex");
        f.store.resolveLoginCancelMutation({ attemptId: cancel.attempt.id, expectedOriginalState: "ambiguous",
          expectedProviderAuthority: current(), provider: { signedIn: false } });
        const resolution = db.query("SELECT * FROM mutation_resolutions WHERE attempt_id=?").get(cancel.attempt.id);
        const cancelChain = db.query("SELECT * FROM account_mutation_authority_rebinds WHERE attempt_id=? ORDER BY from_generation").all(cancel.attempt.id);
        // Crash after durable resolution but before the cached account reread.
        f.reboot(cycle * 2 + 2);
        expect(f.store.recoverEffectStartedMutations().unresolved).toEqual([]);
        expect(db.query("SELECT * FROM account_mutation_authority_rebinds WHERE attempt_id=? ORDER BY from_generation").all(cancel.attempt.id))
          .toEqual(cancelChain);
        f.store.reconcileProfileRecoveryFromAccountRead({ profileId: f.profile.id,
          expectedGeneration: current().processGeneration, expectedProviderAuthority: current(), provider: { signedIn: false } });
        expect(current()).toMatchObject({ bindingGeneration: 4 + cycle * 2, processGeneration: 3 + cycle * 2 });
        expect(f.store.readPendingLoginAuthority(f.profile.id, current().processGeneration)?.attemptId).toBe(f.login.id);
        expect(db.query("SELECT * FROM mutation_resolutions WHERE attempt_id=?").get(cancel.attempt.id)).toEqual(resolution);
        expect(db.query("SELECT request_digest,authority_generation FROM mutation_attempts WHERE id=?").get(cancel.attempt.id))
          .toEqual(original);
        expect(db.query("SELECT result_json FROM mutation_attempts WHERE id=?").get(cancel.attempt.id)).toEqual(recoveryDiagnostic);
        expect(db.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(cancel.attempt.id)).toEqual(effect);
      }
      expect(db.query("SELECT request_digest,result_json FROM mutation_attempts WHERE id=?").get(f.login.id)).toEqual(loginBytes);
      expect(db.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(f.login.id)).toEqual(loginEffect);
      expect(db.query("SELECT from_binding_generation,to_binding_generation,cause FROM provider_login_binding_transitions ORDER BY from_binding_generation").all())
        .toEqual([2, 3, 4, 5].map((from, index) => ({ from_binding_generation: from, to_binding_generation: from + 1,
          cause: index % 2 === 0 ? "cancellation_quarantined" : "cancellation_reconciled_pending" })));
      for (const table of ["session_mutation_authority_rebinds", "session_mutation_authority_rebinds_v39"]) {
        expect(db.query(`SELECT from_generation,to_generation FROM ${table} WHERE attempt_id=? ORDER BY from_generation`).all(f.login.id))
          .toEqual([1, 2, 3, 4].map((from) => ({ from_generation: from, to_generation: from + 1 })));
      }
      const before = snapshot(db);
      db.transaction(() => auditProviderLoginBindingTransitions(db)).deferred();
      expect(snapshot(db)).toEqual(before);
      for (const readonly of [true, false]) {
        const reopened = new StateStore(f.paths, { readonly, now: () => 1_900_000_000_000, resolveMachineTimeZone: () => "UTC" });
        try { expect(reopened.readPendingLoginAuthority(f.profile.id, 5)?.loginId).toBe(f.loginId); }
        finally { reopened.close(); }
      }
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(false); }
  });

  test("intent cannot commit alone or be anchored after an out-of-order or intermediate account transition", async () => {
    const f = await fixture();
    const cancel = f.cancel();
    const db = inspect(f.paths.database);
    try {
      const before = snapshot(db);
      const prepare = () => prepareProviderLoginBindingTransition(db, { profileId: f.profile.id,
        cancellationAttemptId: cancel.attempt.id, cause: "cancellation_quarantined", recordedAt: 1_800_000_000_100 });
      const anchor = () => db.exec(`INSERT INTO provider_login_binding_transition_anchors
        SELECT login_attempt_id,from_binding_generation,transition_digest FROM provider_login_binding_transitions`);
      const profile = () => db.query("UPDATE profiles SET state='recovery_required' WHERE id=?").run(f.profile.id);
      const account = () => db.query("UPDATE provider_accounts SET readiness='recovery_required',binding_generation=binding_generation+1 WHERE id=?").run(f.profile.id);
      const attacks = [
        () => { prepare(); },
        () => { prepare(); anchor(); },
        () => { prepare(); account(); profile(); anchor(); },
        () => { prepare(); db.query("UPDATE profiles SET state='signed_out' WHERE id=?").run(f.profile.id); profile(); account(); },
        () => { prepare(); db.query("UPDATE profiles SET process_generation=process_generation+1 WHERE id=?").run(f.profile.id); },
        () => { prepare(); profile(); db.query("UPDATE provider_accounts SET readiness='signed_out',binding_generation=binding_generation+1 WHERE id=?").run(f.profile.id); },
        () => { prepare(); profile(); account(); anchor(); },
      ];
      for (const attack of attacks) {
        expect(() => db.transaction(attack).immediate()).toThrow();
        expect(snapshot(db)).toEqual(before);
      }
      // A genuine ordered update anchors automatically; a forced outer failure
      // restores the profile, account, intent, anchor and every other row.
      expect(() => db.transaction(() => {
        prepare(); profile(); account();
        expect(db.query("SELECT count(*) AS n FROM provider_login_binding_transition_anchors").get()).toEqual({ n: 1 });
        expect(readProviderLoginBindingAuthority(db, f.profile.id, 1)?.pendingCancellationId).toBe(cancel.attempt.id);
        throw new Error("fixture outer rollback");
      }).immediate()).toThrow("fixture outer rollback");
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(false); }
  });

  test("rejects foreign cancellation identities and causes without retaining an intent", async () => {
    const f = await fixture();
    const cancel = f.cancel();
    const otherProfile = f.store.createProfile("Other binding");
    const db = inspect(f.paths.database);
    try {
      const before = snapshot(db);
      for (const input of [
        { profileId: otherProfile.id, cancellationAttemptId: cancel.attempt.id, cause: "cancellation_quarantined" as const },
        { profileId: f.profile.id, cancellationAttemptId: f.login.id, cause: "cancellation_quarantined" as const },
        { profileId: f.profile.id, cancellationAttemptId: cancel.attempt.id, cause: "cancellation_reconciled_pending" as const },
      ]) {
        expect(() => db.transaction(() => prepareProviderLoginBindingTransition(db, { ...input, recordedAt: 100 })).immediate())
          .toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
        expect(snapshot(db)).toEqual(before);
      }
      expect(() => prepareProviderLoginBindingTransition(db, { profileId: f.profile.id,
        cancellationAttemptId: cancel.attempt.id, cause: "cancellation_quarantined", recordedAt: 100 }))
        .toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(false); }
  });

  test("fixed-seed transition timestamps accept safe values and refuse invalid values atomically", async () => {
    const f = await fixture();
    const cancel = f.cancel();
    const db = inspect(f.paths.database);
    try {
      const before = snapshot(db);
      fc.assert(fc.property(fc.oneof(fc.integer({ min: 0, max: 1_000_000 }),
        fc.constant(Number.MAX_SAFE_INTEGER), fc.constant(-1), fc.constant(0.5),
        fc.constant(Number.MAX_SAFE_INTEGER + 1)), (recordedAt) => {
        const valid = Number.isSafeInteger(recordedAt) && recordedAt >= 0;
        expect(() => db.transaction(() => {
          prepareProviderLoginBindingTransition(db, { profileId: f.profile.id,
            cancellationAttemptId: cancel.attempt.id, cause: "cancellation_quarantined", recordedAt });
          db.query("UPDATE profiles SET state='recovery_required' WHERE id=?").run(f.profile.id);
          db.query("UPDATE provider_accounts SET readiness='recovery_required',binding_generation=binding_generation+1 WHERE id=?").run(f.profile.id);
          expect(db.query("SELECT recorded_at FROM provider_login_binding_transitions").get()).toEqual({ recorded_at: recordedAt });
          throw new Error("valid property rollback");
        }).immediate()).toThrow(valid ? "valid property rollback" : "PROVIDER_LOGIN_BINDING_PROOF_INVALID");
        expect(snapshot(db)).toEqual(before);
      }), { seed: 0x41cafe, numRuns: 24 });
    } finally { db.close(false); }
  });

  test.each(["receipt", "effect", "login_sidecar", "login_process", "cancel_process"] as const)(
    "rejects %s corruption through the selected origin reader without changing evidence", async (kind) => {
      const f = await fixture();
      const cancel = f.cancel();
      f.reboot(1);
      f.store.recoverEffectStartedMutations();
      f.reboot(2);
      const db = inspect(f.paths.database);
      try {
        if (kind === "receipt") corrupt(db, "mutation_attempts", () => {
          db.query("UPDATE mutation_attempts SET result_json=? WHERE id=?")
            .run(JSON.stringify({ status: "pending", loginId: "another-login" }), f.login.id);
        });
        else if (kind === "effect") corrupt(db, "mutation_effect_evidence", () => {
          db.query("UPDATE mutation_effect_evidence SET evidence_json=? WHERE attempt_id=?")
            .run(JSON.stringify({ kind: "account.login", method: "browser" }), f.login.id);
        });
        else if (kind === "login_sidecar") corrupt(db, "account_scoped_provider_authorities", () => {
          db.query("UPDATE account_scoped_provider_authorities SET binding_generation=binding_generation+1 WHERE scope_kind='provider_login' AND scope_id=?")
            .run(f.login.id);
        });
        else if (kind === "login_process") corrupt(db, "session_mutation_authority_rebinds", () => {
          db.query("DELETE FROM session_mutation_authority_rebinds WHERE attempt_id=? AND from_generation=1").run(f.login.id);
        });
        else corrupt(db, "account_mutation_authority_rebinds", () => {
          db.query("DELETE FROM account_mutation_authority_rebinds WHERE attempt_id=? AND from_generation=1").run(cancel.attempt.id);
        });
        const before = snapshot(db);
        expect(() => f.store.readPendingLoginAuthority(f.profile.id, 3)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
        expect(() => f.store.resolveLoginCancelMutation({ attemptId: cancel.attempt.id,
          expectedOriginalState: "ambiguous", expectedProviderAuthority: f.store.requireProviderAccountAuthority(f.profile.id, "codex"),
          provider: { signedIn: false } })).toThrow();
        expect(snapshot(db)).toEqual(before);
      } finally { db.close(false); }
    },
  );

  test("raw SQL cannot grant a changed-binding successor after the original pending receipt loses correspondence", async () => {
    const f = await fixture();
    f.cancel(); f.reboot(1); f.store.recoverEffectStartedMutations();
    const db = inspect(f.paths.database);
    try {
      // Positive control reaches the new changed-binding SQL exception, then
      // rolls back so both bad-proof attempts use the identical predecessor.
      expect(() => db.transaction(() => {
        for (const table of ["session_mutation_authority_rebinds_v39", "session_mutation_authority_rebinds"]) {
          db.query(`INSERT INTO ${table}(attempt_id,profile_id,provider,from_generation,to_generation,recorded_at)
            VALUES (?,?,'codex',2,3,1800000000200)`).run(f.login.id, f.profile.id);
        }
        throw new Error("positive SQL rollback");
      }).immediate()).toThrow("positive SQL rollback");
      corrupt(db, "mutation_attempts", () => {
        db.query("UPDATE mutation_attempts SET result_json=? WHERE id=?")
          .run(JSON.stringify({ status: "pending", loginId: "different-login" }), f.login.id);
      });
      const before = snapshot(db);
      for (const table of ["session_mutation_authority_rebinds_v39", "session_mutation_authority_rebinds"]) {
        expect(() => db.query(`INSERT INTO ${table}(attempt_id,profile_id,provider,from_generation,to_generation,recorded_at)
          VALUES (?,?,'codex',2,3,1800000000200)`).run(f.login.id, f.profile.id))
          .toThrow("session mutation provider successor authority mismatch");
        expect(snapshot(db)).toEqual(before);
      }
    } finally { db.close(false); }
  });

  test("signed-in cancellation resolution cannot be reused as a pending-binding restoration", async () => {
    const f = await fixture();
    const cancel = f.cancel(); f.reboot(1); f.store.recoverEffectStartedMutations();
    const authority = () => f.store.requireProviderAccountAuthority(f.profile.id, "codex");
    f.store.resolveLoginCancelMutation({ attemptId: cancel.attempt.id, expectedOriginalState: "ambiguous",
      expectedProviderAuthority: authority(), provider: { signedIn: true } });
    const db = inspect(f.paths.database);
    try {
      const before = snapshot(db);
      expect(() => f.store.reconcileProfileRecoveryFromAccountRead({ profileId: f.profile.id,
        expectedGeneration: 2, expectedProviderAuthority: authority(), provider: { signedIn: false } }))
        .toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
      expect(snapshot(db)).toEqual(before);
      f.store.reconcileProfileRecoveryFromAccountRead({ profileId: f.profile.id,
        expectedGeneration: 2, expectedProviderAuthority: authority(), provider: { signedIn: true, email: "synthetic@example.com" } });
      expect(f.store.readPendingLoginAuthority(f.profile.id, 2)).toBeNull();
      expect(db.query("SELECT count(*) AS n FROM provider_login_binding_transitions").get()).toEqual({ n: 1 });
      db.transaction(() => auditProviderLoginBindingTransitions(db)).deferred();
    } finally { db.close(false); }
  });

  test("a new cancellation cannot borrow a previous cancellation's completed restoration", async () => {
    const f = await fixture();
    const first = f.cancel(); f.reboot(1); f.store.recoverEffectStartedMutations();
    const current = () => f.store.requireProviderAccountAuthority(f.profile.id, "codex");
    f.store.resolveLoginCancelMutation({ attemptId: first.attempt.id, expectedOriginalState: "ambiguous",
      expectedProviderAuthority: current(), provider: { signedIn: false } });
    f.store.reconcileProfileRecoveryFromAccountRead({ profileId: f.profile.id, expectedGeneration: 2,
      expectedProviderAuthority: current(), provider: { signedIn: false } });
    const second = f.cancel();
    expect(second.key).not.toBe(first.key);
    const db = inspect(f.paths.database);
    try {
      const before = snapshot(db);
      for (const [cancellationAttemptId, cause] of [
        [first.attempt.id, "cancellation_quarantined"],
        [first.attempt.id, "cancellation_reconciled_pending"],
        [second.attempt.id, "cancellation_reconciled_pending"],
      ] as const) {
        expect(() => db.transaction(() => prepareProviderLoginBindingTransition(db, {
          profileId: f.profile.id, cancellationAttemptId, cause, recordedAt: 1_800_000_000_500,
        })).immediate()).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
        expect(snapshot(db)).toEqual(before);
      }
      f.reboot(2); f.store.recoverEffectStartedMutations();
      const quarantined = snapshot(db);
      expect(() => db.transaction(() => prepareProviderLoginBindingTransition(db, {
        profileId: f.profile.id, cancellationAttemptId: first.attempt.id,
        cause: "cancellation_reconciled_pending", recordedAt: 1_800_000_000_600,
      })).immediate()).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
      expect(snapshot(db)).toEqual(quarantined);
    } finally { db.close(false); }
  });

  test("two unrelated binding changes never substitute for a cancellation witness", async () => {
    const f = await fixture();
    expect(f.store.setProfileState(f.profile.id, 1, "login_pending", { email: "temporary@example.com" })).toBe(true);
    expect(f.store.setProfileState(f.profile.id, 1, "login_pending")).toBe(true);
    expect(f.store.requireProviderAccountAuthority(f.profile.id, "codex").bindingGeneration).toBe(4);
    const db = inspect(f.paths.database);
    try {
      const before = snapshot(db);
      expect(() => f.store.readPendingLoginAuthority(f.profile.id, 1)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
      expect(() => f.reboot(1)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
      expect(snapshot(db)).toEqual(before);
      expect(db.query("SELECT count(*) AS n FROM provider_login_binding_transitions").get()).toEqual({ n: 0 });
    } finally { db.close(false); }
  });
});
