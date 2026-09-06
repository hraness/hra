import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { automaticPointerMoveCapsuleDigest, type AutomaticPointerMoveRequest } from "../domain/automatic-pointer-move";
import { codexProviderAccountAuthoritySchema } from "../domain/provider-accounts";
import { createStoredAccountUsageSnapshot } from "../domain/usage-metrics";
import { type ProfileId } from "../domain/values";
import { ATTACHMENT_CUSTODY_SCHEMA_OBJECTS } from "./attachment-custody";
import { ATTACHMENT_CUSTODY_COLUMNS } from "./attachment-custody-schema";
import { AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS } from "./automatic-pointer-move";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { QUEUE_ATTACHMENT_SCHEMA_OBJECTS } from "./queue-attachment-identity";
import { StateStore } from "./state-store";

const stores = new Set<StateStore>();
const homes: string[] = [];
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-pointer-move-")));
  homes.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  let time = 1_800_000_000_000;
  const open = (readonly = false) => {
    const store = new StateStore(paths, { readonly, now: () => time, resolveMachineTimeZone: () => "UTC" });
    stores.add(store); return store;
  };
  const store = open();
  const bootId = `boot_${"a".repeat(32)}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const profile = (label: string) => {
    const value = store.nextProfileGeneration(store.createProfile(label).id);
    expect(store.setProfileState(value.id, value.processGeneration, "signed_in", { email: `${label}@example.com`, plan: "Plus" })).toBe(true);
    return store.requireProfile(value.id);
  };
  const source = profile("source");
  const target = profile("target");
  const writeQuota = (profileId: ProfileId, usedPercent: number, credits = 0, observedAt = time) => {
    const authority = store.requireProviderAccountAuthority(profileId, "codex");
    const sourceSequence = (store.latestUsage(profileId)?.sourceRevision ?? 0) + 1;
    const email = store.requireProfile(profileId).providerEmail;
    if (email === undefined) throw new Error("Fixture account email missing");
    const snapshot = createStoredAccountUsageSnapshot({
      accountFingerprint: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),
      daemonGeneration, providerGeneration: authority.processGeneration, sourceSequence,
      observedAt, receivedAt: observedAt, previousPayload: null,
      providerPayload: {
        usage: { summary: { lifetimeTokens: 1234, peakDailyTokens: null, longestRunningTurnSec: null,
          currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null },
        rateLimits: { primary: { limitId: null, limitName: null, planType: null, rateLimitReachedType: null,
          primary: { usedPercent, windowDurationMins: 10080, resetsAt: Math.floor((time + 3_600_000) / 1000) }, secondary: null },
          byLimitId: null, resetCreditsAvailable: credits },
      },
    });
    store.recordUsage(profileId, sourceSequence, observedAt, snapshot, authority);
  };
  writeQuota(source.id, 99); writeQuota(target.id, 20);
  const request = (): AutomaticPointerMoveRequest => {
    const pointer = store.readProviderAccountState("codex");
    const authority = codexProviderAccountAuthoritySchema.parse(store.requireProviderAccountAuthority(source.id, "codex"));
    const quota = store.latestProviderUsage(authority.providerAccountId)?.quota;
    if (quota === undefined || quota === null) throw new Error("Fixture quota missing");
    return { idempotencyKey: randomUUID(), provider: "codex", daemonGeneration, bootId, expectedSourceAuthority: authority,
      expectedSourceQuotaObservationRevision: quota.observationRevision, expectedSourceQuotaComponentDigest: quota.componentDigest,
      expectedResetPolicyRevision: store.requireAccountRateLimitResetPolicy(source.id).revision,
      expectedAutomaticPolicyRevision: store.readAutomaticUsagePolicyConfiguration().automaticPolicyRevision,
      expectedOrderRevision: pointer.orderRevision, expectedPointerRevision: pointer.pointerRevision };
  };
  const inspect = () => new Database(paths.database, { strict: true });
  return { store, paths, source, target, open, inspect, request, writeQuota, profile, advanceTime: (ms: number) => { time += ms; } };
}

describe("automatic pointer-only storage", () => {
  test("commits one pointer CAS with quota-only canonical history and no provider/session effect", async () => {
    const value = await fixture();
    const request = value.request();
    const before = value.store.requireProfile(value.source.id);
    const result = value.store.settleAutomaticPointerMove(request);
    expect(result.replayed).toBe(false);
    expect(result.move.target.authority.profileId).toBe(value.target.id);
    expect(result.capsuleDigest).toBe(automaticPointerMoveCapsuleDigest(result.capsule));
    expect(value.store.readProviderAccountState("codex").pointerRevision).toBe(request.expectedPointerRevision + 1);
    expect(value.store.requireProfile(value.source.id)).toEqual(before);
    expect(value.store.settleAutomaticPointerMove(request)).toEqual({ ...result, replayed: true });
    expect(value.open(true).readAutomaticPointerMove(request.idempotencyKey)?.move).toEqual(result.move);
    const db = value.inspect();
    try {
      for (const table of ["sessions", "mutation_effect_evidence", "mutation_provider_authorities", "mutation_resolutions", "account_rate_limit_reset_attempts"]) {
        expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      const stored = db.query("SELECT capsule_json FROM automatic_pointer_moves").get() as { capsule_json: string };
      expect(stored.capsule_json).not.toContain("lifetimeTokens");
      expect(stored.capsule_json).not.toContain("providerPayload");
    } finally { db.close(false); }
  });

  test.each([false, true])("different keys cannot duplicate the pointer CAS across connections (reverse=%s)", async (reverse) => {
    const value = await fixture();
    const other = value.open();
    const first = value.request(); const second = { ...first, idempotencyKey: randomUUID() };
    const [winner, loser] = reverse ? [other, value.store] : [value.store, other];
    winner.settleAutomaticPointerMove(first);
    expect(() => loser.settleAutomaticPointerMove(second)).toThrow("AUTOMATIC_POINTER_MOVE_CAS_CONFLICT");
    expect(loser.readAutomaticPointerMove(second.idempotencyKey)).toBeNull();
  });

  test.each(["daemon", "boot", "quota", "binding", "order", "policy", "reset"] as const)("refuses a stale %s fence without committing the key", async (field) => {
    const value = await fixture(); const request = value.request();
    if (field === "daemon") request.daemonGeneration++;
    if (field === "boot") request.bootId = `boot_${"b".repeat(32)}`;
    if (field === "quota") value.writeQuota(value.source.id, 99);
    if (field === "binding") request.expectedSourceAuthority.bindingGeneration++;
    if (field === "order") request.expectedOrderRevision++;
    if (field === "policy") request.expectedAutomaticPolicyRevision++;
    if (field === "reset") request.expectedResetPolicyRevision++;
    expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_CAS_CONFLICT");
    expect(value.store.readAutomaticPointerMove(request.idempotencyKey)).toBeNull();
  });

  test.each(["reset_required", "source_below", "target_stale", "disabled"] as const)("%s is an inert non-admission", async (condition) => {
    const value = await fixture();
    if (condition === "reset_required") value.writeQuota(value.source.id, 99, 1);
    if (condition === "source_below") value.writeQuota(value.source.id, 98);
    if (condition === "target_stale") { value.advanceTime(300_001); value.writeQuota(value.source.id, 99); }
    if (condition === "disabled") value.store.updateAutomaticUsagePolicyConfiguration({ idempotencyKey: randomUUID(), expectedAutomaticPolicyRevision: 1,
      change: { kind: "set_default", enabled: false } });
    const request = value.request();
    expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_NOT_ADMITTED");
    expect(value.store.readAutomaticPointerMove(request.idempotencyKey)).toBeNull();
  });

  test("a last-step trigger failure rolls back mutation, capsule, anchor and pointer together", async () => {
    const value = await fixture(); const request = value.request(); const db = value.inspect();
    try {
      db.exec("CREATE TRIGGER fail_pointer AFTER UPDATE OF active_provider_account_id ON provider_account_states BEGIN SELECT RAISE(ABORT,'injected_pointer_failure'); END");
      expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("injected_pointer_failure");
      for (const table of ["automatic_pointer_moves", "automatic_pointer_move_anchors", "mutation_attempts"]) {
        expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(value.store.readProviderAccountState("codex").pointerRevision).toBe(request.expectedPointerRevision);
      db.exec("DROP TRIGGER fail_pointer");
      expect(value.store.settleAutomaticPointerMove(request).replayed).toBe(false);
    } finally { db.close(false); }
  });

  test("the SQL receipt guard rejects null instead of accepting an unknown comparison", async () => {
    const value = await fixture(); const request = value.request(); const db = value.inspect();
    try {
      db.exec(`CREATE TRIGGER inject_null_pointer_receipt AFTER UPDATE OF state ON mutation_attempts
        WHEN NEW.kind='usage.pointer.move' AND NEW.state='effect_started'
        BEGIN UPDATE mutation_attempts SET state='applied',result_json=NULL WHERE id=NEW.id; END`);
      expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_CLOSED_API_REQUIRED");
      for (const table of ["mutation_attempts", "automatic_pointer_moves", "automatic_pointer_move_anchors"]) {
        expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(value.store.readProviderAccountState("codex").pointerRevision).toBe(request.expectedPointerRevision);
    } finally { db.close(false); }
  });

  test.each(["automatic_pointer_moves", "automatic_pointer_move_anchors", "mutation_attempts"] as const)("sparse %s deletion refuses hot head and both reopen modes", async (table) => {
    const value = await fixture(); const request = value.request(); value.store.settleAutomaticPointerMove(request);
    const db = value.inspect();
    try {
      db.exec("PRAGMA foreign_keys=OFF");
      const guards = AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS.filter((object) => object.type === "trigger" && object.table === table && object.sql.includes("BEFORE DELETE"));
      for (const guard of guards) db.exec(`DROP TRIGGER ${guard.name}`);
      db.query(`DELETE FROM ${table}`).run();
      for (const guard of guards) db.exec(guard.sql);
      expect(() => value.store.readProviderAccountState("codex")).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      expect(() => value.store.readAutomaticPointerMove(request.idempotencyKey)).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      for (const readonly of [false, true]) expect(() => value.open(readonly)).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
    } finally { db.close(false); }
  });

  test.each([
    ["source", "intact"], ["target", "intact"], ["source", "missing"], ["target", "missing"],
    ["source", "replaced"], ["target", "replaced"],
  ] as const)("unresolved %s logout blocks even with %s primary sidecar", async (endpoint, corruption) => {
    const value = await fixture(); const request = value.request();
    const profile = value[endpoint];
    const authority = value.store.requireProviderAccountAuthority(profile.id, "codex");
    const attempt = value.store.prepareMutation({ kind: "account.logout", authorityId: profile.id, authorityGeneration: authority.processGeneration,
      request: {}, providerAuthorities: [{ role: "primary", authority, provenance: "account_logout" }] });
    value.store.beginAccountMutationEffect({ attemptId: attempt.id, profileId: profile.id, profileGeneration: authority.processGeneration,
      providerAuthority: authority, evidence: { kind: "account.logout", baselineSignedIn: true } });
    const db = value.inspect();
    try {
      if (corruption !== "intact") {
        const name = `mutation_provider_authorities_immutable_${corruption === "missing" ? "delete" : "update"}`;
        const guard = db.query("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string };
        db.exec(`DROP TRIGGER ${name}`);
        if (corruption === "missing") db.query("DELETE FROM mutation_provider_authorities WHERE attempt_id=?").run(attempt.id);
        else db.query("UPDATE mutation_provider_authorities SET process_generation=process_generation+1 WHERE attempt_id=?").run(attempt.id);
        db.exec(guard.sql);
      }
      expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_NOT_ADMITTED");
      expect(db.query("SELECT COUNT(*) AS count FROM automatic_pointer_moves").get()).toEqual({ count: 0 });
      expect(value.store.readAutomaticPointerMove(request.idempotencyKey)).toBeNull();
    } finally { db.close(false); }
  });

  test.each(["claude", "devin"] as const)("a sibling %s login does not block the selected Codex pointer", async (provider) => {
    const value = await fixture(); const request = value.request();
    const authority = value.store.requireProviderAccountAuthority(value.source.id, provider);
    value.store.prepareMutation({ kind: `account.${provider}-login`, authorityId: value.source.id, authorityGeneration: authority.processGeneration,
      request: {}, providerAuthorities: [{ role: "primary", authority, provenance: `account_${provider}_login` }] });
    expect(value.store.settleAutomaticPointerMove(request).move.target.authority.profileId).toBe(value.target.id);
  });

  test.each([["source", false], ["target", false], ["source", true]] as const)("%s reset ownership (settled=%s) refuses without guessing a quota baseline", async (endpoint, settled) => {
    const value = await fixture(); const profile = value[endpoint];
    const authority = value.store.requireProviderAccountAuthority(profile.id, "codex");
    const email = value.store.requireProfile(profile.id).providerEmail;
    if (email === undefined) throw new Error("Missing reset email");
    const accountFingerprint = createHash("sha256").update(email).digest("hex");
    const weeklyWindowResetsAt = 1_800_003_600_000;
    expect(value.store.authorizeAccountRateLimitResetPolicy({ profileId: profile.id, processGeneration: authority.processGeneration,
      accountFingerprint, weeklyWindowDurationMinutes: 10080, weeklyWindowResetsAt }).decision).toBe("allow");
    const reset = value.store.prepareAccountRateLimitReset({ profileId: profile.id, processGeneration: authority.processGeneration,
      accountFingerprint, weeklyWindowResetsAt, observedUsedPercent: 99 });
    if (settled) {
      value.store.beginAccountRateLimitReset(reset.idempotencyKey, authority);
      value.store.settleAccountRateLimitReset(reset.idempotencyKey, "noCredit");
    }
    const request = value.request();
    expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_NOT_ADMITTED");
    expect(value.store.readAutomaticPointerMove(request.idempotencyKey)).toBeNull();
  });

  test("upgrades actual v45 additively and refuses a missing current-format guard before repair", async () => {
    const value = await fixture(); const db = value.inspect();
    try {
      db.exec("PRAGMA foreign_keys=OFF");
      for (const type of ["trigger", "index"] as const) {
        for (const object of [...ATTACHMENT_CUSTODY_SCHEMA_OBJECTS].reverse()) {
          if (object.type === type) db.exec(`DROP ${type.toUpperCase()} ${object.name}`);
        }
      }
      for (const definition of [...ATTACHMENT_CUSTODY_COLUMNS].reverse()) {
        db.exec(`ALTER TABLE mutation_attempts DROP COLUMN ${definition.slice(0, definition.indexOf(" "))}`);
      }
      for (const object of [...ATTACHMENT_CUSTODY_SCHEMA_OBJECTS].reverse()) {
        if (object.type === "table") db.exec(`DROP TABLE ${object.name}`);
      }
      for (const object of QUEUE_ATTACHMENT_SCHEMA_OBJECTS) {
        if (object.type === "trigger") db.exec(`DROP TRIGGER ${object.name}`);
      }
      db.exec("ALTER TABLE queue_entries DROP COLUMN enqueue_identity_attempt_id");
      db.exec("ALTER TABLE queue_entries DROP COLUMN enqueue_identity_format");
      for (const type of ["index", "table"] as const) {
        for (const object of [...QUEUE_ATTACHMENT_SCHEMA_OBJECTS].reverse()) {
          if (object.type === type) db.exec(`DROP ${type.toUpperCase()} ${object.name}`);
        }
      }
      for (const type of ["trigger", "index", "table"] as const) {
        for (const object of [...AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS].reverse()) {
          if (object.type === type) db.exec(`DROP ${type.toUpperCase()} ${object.name}`);
        }
      }
      db.exec("DELETE FROM migrations WHERE version IN (46,47,48); PRAGMA user_version=45; PRAGMA foreign_keys=ON");
      expect(db.query("SELECT version FROM migrations WHERE version>45").all()).toEqual([]);
      expect(db.query("SELECT name FROM pragma_table_info('queue_entries') WHERE name IN ('enqueue_identity_format','enqueue_identity_attempt_id')").all()).toEqual([]);
      expect(db.query("SELECT name FROM pragma_table_info('mutation_attempts') WHERE name LIKE 'attachment_%'").all()).toEqual([]);
      const upgraded = value.open();
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 48 });
      expect(db.query("SELECT version FROM migrations WHERE version>45 ORDER BY version").all()).toEqual([{ version: 46 }, { version: 47 }, { version: 48 }]);
      expect(upgraded.requireProfile(value.source.id)).toEqual(value.store.requireProfile(value.source.id));
      upgraded.settleAutomaticPointerMove(value.request());
      db.exec("DROP TRIGGER automatic_pointer_move_anchor_insert_guard");
      for (const readonly of [false, true]) expect(() => value.open(readonly)).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name='automatic_pointer_move_anchor_insert_guard'").get()).toBeNull();
    } finally { db.close(false); }
  });

  test("hot anchored digest tampering refuses even an empty lineage read", async () => {
    const value = await fixture(); const request = value.request(); value.store.settleAutomaticPointerMove(request);
    const db = value.inspect();
    try {
      const guard = AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS.find((object) => object.name === "automatic_pointer_move_anchors_immutable_update");
      if (guard === undefined) throw new Error("Missing anchor guard");
      db.exec(`DROP TRIGGER ${guard.name}`);
      db.exec("UPDATE automatic_pointer_move_anchors SET capsule_digest=printf('%064d',0)");
      db.exec(guard.sql);
      expect(() => value.store.readProviderAccountState("codex")).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      expect(() => value.store.readAutomaticPointerMoveLineage({ fromPointerRevision: request.expectedPointerRevision + 1,
        throughPointerRevision: request.expectedPointerRevision + 1 })).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
    } finally { db.close(false); }
  });
});
