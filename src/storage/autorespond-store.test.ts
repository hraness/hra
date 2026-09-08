import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";

import { AUTORESPOND_DAY_MS, AUTORESPOND_HOUR_MS } from "../domain/autorespond-budget";

import { deriveLegacySessionProfileKey } from "./canonical-profile-storage";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const stores: StateStore[] = [];

// These current-source shapers reproduce the v43-v49 authority surfaces they
// exercise; they are not untouched databases captured from historical source.
const canonicalProfileTables = ["sessions", "work_routes", "work_tasks", "work_attempts"] as const;
const dropCanonicalProfileSchema = (database: Database): void => {
  for (const name of [
    "canonical_profile_session_insert_guard",
    "canonical_profile_session_update_guard",
    "canonical_profile_session_live_attempt_guard",
    "canonical_profile_work_route_insert_guard",
    "canonical_profile_work_task_insert_guard",
    "canonical_profile_work_attempt_insert_guard",
    "canonical_profile_work_attempt_immutable_guard",
  ] as const) database.exec(`DROP TRIGGER ${name}`);
  for (const table of canonicalProfileTables) {
    database.exec(`ALTER TABLE ${table} DROP COLUMN canonical_profile_key`);
    expect(database.query(
      `SELECT name FROM pragma_table_xinfo('${table}') WHERE name='canonical_profile_key' COLLATE NOCASE`,
    ).all()).toEqual([]);
  }
};

const readRows = (database: Database, sql: string): Record<string, unknown>[] => {
  // A fresh statement observes the added column after another connection's
  // migration; a cached SELECT * can retain its predecessor column metadata.
  const statement = database.prepare(sql);
  try { return z.record(z.string(), z.unknown()).array().parse(statement.all()); }
  finally { statement.finalize(); }
};

const databaseSnapshot = (database: Database): string => {
  const schema = readRows(database, "SELECT * FROM sqlite_master ORDER BY type,name");
  const rows = schema.filter((row) => row.type === "table").map((row) => {
    const name = z.string().regex(/^[A-Za-z0-9_]+$/u).parse(row.name);
    return { name, rows: readRows(database, `SELECT * FROM "${name}"`) };
  });
  return JSON.stringify({ schema, rows, version: readRows(database, "PRAGMA user_version") });
};

const dropHostedMemorySchema = (database: Database): void => {
  const hostedObjects = z.object({
    name: z.string().regex(/^[a-z0-9_]+$/u),
    type: z.enum(["index", "trigger"]),
  }).strict().array().parse(database.query(`
    SELECT name,type FROM sqlite_master
    WHERE type IN ('index','trigger') AND (
      name LIKE 'project_memory_hosted_%'
      OR name LIKE 'project_memory_sync_%'
      OR name LIKE 'project_memory_portable_adoption_%'
      OR name='canonical_memory_sync_share_fence'
    )
    ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END,name
  `).all());
  for (const object of hostedObjects) {
    database.exec(`DROP ${object.type.toUpperCase()} IF EXISTS "${object.name}"`);
  }
  database.exec(`
    DROP TABLE IF EXISTS project_memory_sync_spool;
    DROP TABLE IF EXISTS project_memory_sync_intents;
    DROP TABLE IF EXISTS project_memory_hosted_create_intents;
    DROP TABLE IF EXISTS project_memory_portable_adoption_proofs;
    DROP TABLE IF EXISTS project_memory_hosted_attachments;
  `);
};

const dropPeerAndHostedMemorySchema = (database: Database): void => {
  dropHostedMemorySchema(database);
  const featureObjects = z.object({
    name: z.string().regex(/^[a-z0-9_]+$/u),
    type: z.enum(["index", "trigger"]),
  }).strict().array().parse(database.query(`
    SELECT name,type FROM sqlite_master
    WHERE type IN ('index','trigger') AND (
      name LIKE 'peer_session_%'
      OR name LIKE 'session_peer_%'
      OR name LIKE 'session_message_event_source%'
      OR name LIKE 'session_host_capability%'
      OR name LIKE 'project_memory_%'
      OR name LIKE 'memory_%'
      OR name LIKE 'queue_peer_%'
      OR name IN (
        'session_provider_switch_authority_immutable',
        'session_provider_switch_transition_guard',
        'session_provider_switch_seed_transition_guard',
        'session_provider_switch_session_update_guard',
        'session_provider_switch_session_delete_guard',
        'session_provider_switch_delete_guard',
        'session_provider_switch_v40_authority_guard',
        'session_provider_switch_v40_authority_immutable'
      )
    )
    ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END,name
  `).all());
  for (const object of featureObjects) {
    database.exec(`DROP ${object.type.toUpperCase()} IF EXISTS "${object.name}"`);
  }
  database.exec(`
    DROP TABLE IF EXISTS memory_page_attestation_refs;
    DROP TABLE IF EXISTS memory_working_attestation_forks;
    DROP TABLE IF EXISTS memory_working_attestation_heads;
    DROP TABLE IF EXISTS memory_page_attestations;
    DROP TABLE IF EXISTS memory_submissions;
    DROP TABLE IF EXISTS project_memory_authorities;
    DROP TABLE IF EXISTS session_provider_switches;
    DROP TABLE IF EXISTS peer_session_direct_message_sources;
    DROP TABLE IF EXISTS peer_session_turn_origins;
    DROP TABLE IF EXISTS peer_session_action_roots;
    DROP TABLE IF EXISTS peer_session_action_visits;
    DROP TABLE IF EXISTS peer_session_action_parents;
    DROP TABLE IF EXISTS peer_session_actions;
    DROP TABLE IF EXISTS session_peer_policies;
    DROP TABLE IF EXISTS session_message_event_sources;
    DROP TABLE IF EXISTS session_host_capability_bindings;
  `);
  if (database.query(
    "SELECT 1 FROM pragma_table_info('queue_entries') WHERE name='peer_action_id'",
  ).get() !== null) database.exec("ALTER TABLE queue_entries DROP COLUMN peer_action_id");
  if (database.query(
    "SELECT 1 FROM pragma_table_info('queue_entries') WHERE name='message_actor'",
  ).get() !== null) database.exec("ALTER TABLE queue_entries DROP COLUMN message_actor");
};

function dropAfterHoursSchema(database: Database): void {
  database.exec(`
    DROP TRIGGER IF EXISTS work_session_project_authority_guard;
    DROP TRIGGER sessions_autorespond_after_hours_history;
    DROP TABLE autorespond_after_hours_history;
    DROP TABLE autorespond_after_hours_policy;
    DELETE FROM migrations WHERE version>=46;
    PRAGMA user_version=45;
  `);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture(): Promise<{ store: StateStore; sessionId: string; clock: { now: number } }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-autorespond-store-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const clock = { now: 1_000_000 };
  const store = new StateStore(paths, { now: () => clock.now });
  stores.push(store);
  const profile = store.nextProfileGeneration(store.createProfile("Personal").id);
  store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: "autorespond@example.com" });
  const session = provenSession(store, profile.id, "Autorespond");
  return { store, sessionId: session.id, clock };
}

function provenSession(store: StateStore, profileId: string, title: string) {
  const email = store.requireProfile(profileId).providerEmail;
  if (email === undefined) throw new Error("missing fixture account authority");
  return store.upsertProviderSession({
    profileId, title, provider: "codex", providerThreadId: `thread-${crypto.randomUUID()}`,
    providerAccountKey: `v1:codex:${createHash("sha256").update(email).digest("hex")}`,
    preset: "high", fastEnabled: false, state: "idle",
  });
}

function protocolSource(store: StateStore, sessionId: string, hasOnce = true): string {
  const session = store.requireSession(sessionId);
  const profile = store.requireProfile(session.profileId);
  const publicId = crypto.randomUUID();
  store.admitInteraction({
    publicId,
    sessionId,
    authority: {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId: "44000000-0000-4000-8000-999999999999",
      requestId: { type: "string", value: publicId },
      method: "item/commandExecution/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: session.providerThreadId ?? null,
      turnId: null,
      itemId: null,
      approvalId: null,
    },
    kind: "command_approval",
    blocking: true,
    display: {
      kind: "command_approval",
      summary: "Review command",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: hasOnce ? ["once", "decline", "cancel"] : ["decline", "cancel"],
    },
  });
  return publicId;
}

function reserveProtocol(store: StateStore, sessionId: string, sourceId = protocolSource(store, sessionId)) {
  return store.reserveAutorespondBudget({ sessionId, sourceId, sourceKind: "protocol", expectedMode: "auto:all" });
}

describe("autorespond store", () => {
  test("defaults to auto:all, supports session overrides, and clears them", async () => {
    const { store, sessionId } = await fixture();
    expect(store.readDefaultApprovalMode()).toBe("auto:all");
    expect(store.readSessionApprovalMode(sessionId)).toEqual({ mode: "auto:all", source: "default" });
    store.setSessionApprovalMode(sessionId, "manual");
    expect(store.readSessionApprovalMode(sessionId)).toEqual({ mode: "manual", source: "session" });
    store.setDefaultApprovalMode("auto:workspace");
    expect(store.readSessionApprovalMode(sessionId)).toEqual({ mode: "manual", source: "session" });
    store.setSessionApprovalMode(sessionId, null);
    expect(store.readSessionApprovalMode(sessionId)).toEqual({ mode: "auto:workspace", source: "default" });
    expect(() => store.setSessionApprovalMode("sess_00000000000000000000000000000000", "manual")).toThrow();
  });

  test("counts consecutive admission until a human reset and windows reservations independently of evidence", async () => {
    const { store, sessionId, clock } = await fixture();
    expect(store.bumpAutorespondCounter(sessionId)).toBe(1);
    expect(store.bumpAutorespondCounter(sessionId)).toBe(2);
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(2);
    store.resetAutorespondCounter(sessionId);
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(0);

    const record = (outcome: "accepted" | "refused") => store.recordAutorespondEvidence({
      approvalClass: "command:bun test",
      decision: outcome === "accepted" ? "once" : "hourly_budget",
      interactionId: crypto.randomUUID(),
      kind: "command_approval",
      latencyMs: 12,
      mode: "auto:all",
      outcome,
      sessionId,
      subagent: false,
    });
    record("accepted");
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    clock.now += 2 * 60 * 60 * 1_000;
    record("accepted");
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    record("refused");
    const budgets = store.readAutorespondBudgets(sessionId);
    expect(budgets.lastHour).toBe(1);
    expect(budgets.lastDay).toBe(2);
    expect(store.countAutorespondEvidence({ sessionId })).toEqual({ accepted: 2, refused: 1, unknown: 0 });
    const recent = store.listAutorespondEvidence({ sessionId, limit: 2 });
    expect(recent).toHaveLength(2);
    expect(recent[0]?.outcome).toBe("refused");
    expect(recent[0]?.approvalClass).toBe("command:bun test");
    expect(store.listAutorespondEvidence({ limit: 5 })).toHaveLength(3);
  });
});

describe("prose autorespond evidence", () => {
  test("records prose rows with the rule, the model, and a bounded gate outcome", async () => {
    const { store, sessionId, clock } = await fixture();
    store.recordProseAutorespondEvidence({
      decision: "send",
      latencyMs: 41,
      mode: "auto:all",
      model: "openai/gpt-5-nano",
      outcome: "sent",
      rule: "approval_cue",
      sessionId,
    });
    clock.now += 1_000;
    store.recordProseAutorespondEvidence({
      decision: "refuse",
      latencyMs: 3,
      mode: "auto:all",
      model: null,
      outcome: "gate_failed:human_action_cue",
      rule: "approval_cue",
      sessionId,
    });

    const rows = store.listAutorespondEvidence({ sessionId, limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      decision: "refuse",
      interactionId: null,
      kind: "prose_approval",
      model: null,
      outcome: "gate_failed:human_action_cue",
      path: "prose",
      rule: "approval_cue",
    });
    expect(rows[1]).toMatchObject({
      kind: "prose_approval",
      model: "openai/gpt-5-nano",
      outcome: "sent",
      path: "prose",
    });
    // Display evidence has no admission authority. Actual sends reserve first.
    expect(store.readAutorespondBudgets(sessionId)).toMatchObject({ lastDay: 0, lastHour: 0 });
    expect(store.countAutorespondEvidence({ sessionId })).toEqual({ accepted: 1, refused: 1, unknown: 0 });
  });

  test("refuses an outcome outside the closed vocabulary", async () => {
    const { store, sessionId } = await fixture();
    expect(() => store.recordProseAutorespondEvidence({
      decision: "send",
      latencyMs: 1,
      mode: "auto:all",
      model: null,
      outcome: "gate_failed:NOT ALLOWED" as never,
      rule: "approval_cue",
      sessionId,
    })).toThrow();
    expect(store.listAutorespondEvidence({ sessionId })).toHaveLength(0);
  });

  test("labels autorespond-authored message sources per session", async () => {
    const { store, sessionId } = await fixture();
    expect(store.isAutorespondMessageSource(sessionId, "attempt_one")).toBe(false);
    store.recordAutorespondMessageSource(sessionId, "attempt_one");
    store.recordAutorespondMessageSource(sessionId, "attempt_one");
    expect(store.isAutorespondMessageSource(sessionId, "attempt_one")).toBe(true);
    expect(store.isAutorespondMessageSource(sessionId, "attempt_two")).toBe(false);
    expect(store.isAutorespondMessageSource(sessionId, "")).toBe(false);
  });
});

describe("durable autorespond admission", () => {
  test("serializes competing stores and exact-key replay before any success is recorded", async () => {
    const { store, sessionId, clock } = await fixture();
    const other = new StateStore(store.paths, { now: () => clock.now });
    stores.push(other);
    const sourceId = protocolSource(store, sessionId);
    expect(reserveProtocol(store, sessionId, sourceId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(other, sessionId, sourceId)).toEqual({ state: "existing" });
    expect(reserveProtocol(other, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(other, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 3, lastHour: 3, lastDay: 3 });
  });

  test("rechecks mode and source authority without charging refusals", async () => {
    const { store, sessionId } = await fixture();
    const sourceId = protocolSource(store, sessionId);
    store.setSessionApprovalMode(sessionId, "manual");
    expect(reserveProtocol(store, sessionId, sourceId)).toEqual({ state: "refused", code: "manual_mode" });
    store.setSessionApprovalMode(sessionId, "auto:workspace");
    expect(reserveProtocol(store, sessionId, sourceId)).toEqual({ state: "refused", code: "policy_changed" });
    store.setSessionApprovalMode(sessionId, "auto:all");
    expect(() => reserveProtocol(store, sessionId, crypto.randomUUID())).toThrow("AUTORESPOND_BUDGET_SOURCE_AUTHORITY_INVALID");
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 0, lastHour: 0, lastDay: 0 });
  });

  test("refusal churn and unknown outcomes cannot erase charged rolling budgets", async () => {
    const { store, sessionId, clock } = await fixture();
    for (let index = 0; index < 10; index += 1) {
      store.resetAutorespondCounter(sessionId);
      expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    }
    store.resetAutorespondCounter(sessionId);
    for (let index = 0; index < 501; index += 1) {
      store.recordAutorespondEvidence({
        sessionId, interactionId: crypto.randomUUID(), kind: "command_approval",
        approvalClass: "command:test", mode: "auto:all", decision: "unavailable",
        outcome: index === 500 ? "unknown" : "refused", latencyMs: 0, subagent: false,
      });
    }
    expect(store.countAutorespondEvidence({ sessionId })).toEqual({ accepted: 0, refused: 499, unknown: 1 });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "hourly_budget" });
    clock.now += AUTORESPOND_HOUR_MS;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "hourly_budget" });
    clock.now += 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 1, lastHour: 1, lastDay: 11 });
  });

  test("enforces the shared daily ceiling and releases only expired rolling reservations", async () => {
    const { store, sessionId, clock } = await fixture();
    const start = clock.now;
    for (let hour = 0; hour < 4; hour += 1) {
      clock.now = start + hour * (AUTORESPOND_HOUR_MS + 1);
      for (let index = 0; index < 10; index += 1) {
        store.resetAutorespondCounter(sessionId);
        expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
      }
    }
    clock.now += AUTORESPOND_HOUR_MS + 1;
    store.resetAutorespondCounter(sessionId);
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "daily_budget" });
    clock.now = start + AUTORESPOND_DAY_MS;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "daily_budget" });
    clock.now += 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(store.readAutorespondBudgets(sessionId).lastDay).toBe(31);
    const inspector = new Database(store.paths.database, { readonly: true });
    try {
      expect(inspector.query("SELECT COUNT(*) AS total FROM autorespond_budget_reservations").get()).toEqual({ total: 31 });
    } finally { inspector.close(false); }
  });

  test("clock rewind cannot reopen spend after a successful or refused retention attempt", async () => {
    const { store, sessionId, clock } = await fixture();
    const start = clock.now;
    for (let index = 0; index < 10; index += 1) {
      store.resetAutorespondCounter(sessionId);
      expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    }
    store.bumpAutorespondCounter(sessionId);
    store.bumpAutorespondCounter(sessionId);
    clock.now += AUTORESPOND_DAY_MS + 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    clock.now = start;
    store.resetAutorespondCounter(sessionId);
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "hourly_budget" });
    clock.now += AUTORESPOND_DAY_MS + 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    clock.now = start;
    store.resetAutorespondCounter(sessionId);
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "history_unavailable" });
  });

  test("holds only preexisting sessions for a full day after v43 migration and keeps the hold on reopen", async () => {
    const { store, sessionId, clock } = await fixture();
    const paths = store.paths;
    const sessionProfile = store.requireSession(sessionId).profileId;
    const alreadyLimited = provenSession(store, sessionProfile, "Already limited");
    for (let count = 0; count < 4; count += 1) store.bumpAutorespondCounter(alreadyLimited.id);
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const predecessor = new Database(paths.database);
    dropCanonicalProfileSchema(predecessor);
    dropPeerAndHostedMemorySchema(predecessor);
    // Reproduce the actual v31->v43 table spelling: SQLite quotes a table name
    // after ALTER TABLE RENAME, even when the original CREATE was unquoted.
    const evidenceSql = (predecessor.query(
      "SELECT sql FROM sqlite_master WHERE name='autorespond_evidence'",
    ).get() as { sql: string }).sql
      .replace("autorespond_evidence", "autorespond_evidence_next")
      .replace("'refused','unknown'", "'refused'");
    predecessor.exec("DROP TABLE autorespond_evidence");
    predecessor.exec(evidenceSql);
    predecessor.exec("ALTER TABLE autorespond_evidence_next RENAME TO autorespond_evidence");
    dropAfterHoursSchema(predecessor);
    predecessor.exec(`
      DROP TRIGGER sessions_autorespond_budget_history;
      DROP TABLE autorespond_budget_history;
      DROP TABLE autorespond_budget_reservations;
      DROP TABLE account_mutation_authority_rebinds;
      DELETE FROM migrations WHERE version>=44;
      PRAGMA user_version=43;
    `);
    predecessor.close(false);
    expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:43:50");
    const migrated = new StateStore(paths, { now: () => clock.now });
    stores.push(migrated);
    const availableAt = clock.now + AUTORESPOND_DAY_MS;
    expect(migrated.readAutorespondBudgets(sessionId).consecutive).toBe(3);
    expect(migrated.readAutorespondBudgets(alreadyLimited.id).consecutive).toBe(4);
    expect(migrated.readAutorespondBudgetHistoryAvailableAt(sessionId)).toBe(availableAt);
    expect(reserveProtocol(migrated, sessionId)).toEqual({ state: "refused", code: "history_unavailable" });
    const session = migrated.requireSession(sessionId);
    const fresh = provenSession(migrated, session.profileId, "New after migration");
    expect(migrated.readAutorespondBudgetHistoryAvailableAt(fresh.id)).toBeNull();
    expect(reserveProtocol(migrated, fresh.id)).toEqual({ state: "reserved" });
    // The normal human-message reset may happen during the hold. Reopening
    // must not reinstall the migration floor after that reset.
    migrated.resetAutorespondCounter(sessionId);
    clock.now = availableAt - 1;
    const reopened = new StateStore(paths, { now: () => clock.now });
    stores.push(reopened);
    expect(reopened.readAutorespondBudgets(sessionId).consecutive).toBe(0);
    expect(reopened.readAutorespondBudgetHistoryAvailableAt(sessionId)).toBe(availableAt);
    expect(reserveProtocol(reopened, sessionId)).toEqual({ state: "refused", code: "history_unavailable" });
    clock.now = availableAt;
    expect(reopened.readAutorespondBudgetHistoryAvailableAt(sessionId)).toBeNull();
    expect(reserveProtocol(reopened, sessionId)).toEqual({ state: "reserved" });
  });

  test("rejects a current-version missing admission guard without repairing it", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const damaged = new Database(paths.database);
    damaged.exec("DROP TRIGGER autorespond_budget_reservations_immutable");
    damaged.close(false);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_V44_AUTORESPOND_BUDGET_AUTHORITY_INVALID");
    expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_V44_AUTORESPOND_BUDGET_AUTHORITY_INVALID");
  });

  test("rejects predecessor budget-object collisions instead of blessing zero history holds", async () => {
    const { store, sessionId } = await fixture();
    const paths = store.paths;
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const damaged = new Database(paths.database);
    dropCanonicalProfileSchema(damaged);
    dropPeerAndHostedMemorySchema(damaged);
    damaged.exec("DROP TRIGGER work_session_project_authority_guard; DROP TABLE account_mutation_authority_rebinds; DELETE FROM migrations WHERE version>=44; PRAGMA user_version=43");
    expect(damaged.query("SELECT available_at FROM autorespond_budget_history WHERE session_id=?").get(sessionId))
      .toEqual({ available_at: 0 });
    damaged.close(false);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_V44_AUTORESPOND_BUDGET_PREDECESSOR_COLLISION");
  });

  for (const version of [44, 45, 46, 47, 48, 49, 50]) test(`never applies pre-release v43 trigger-repair allowances to canonical v${String(version)}`, async () => {
    const { store } = await fixture();
    const paths = store.paths;
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const damaged = new Database(paths.database);
    if (version < 50) dropCanonicalProfileSchema(damaged);
    if (version < 49) damaged.exec("DROP TRIGGER work_session_project_authority_guard");
    if (version <= 45) {
      dropPeerAndHostedMemorySchema(damaged);
      dropAfterHoursSchema(damaged);
    } else if (version === 46) dropPeerAndHostedMemorySchema(damaged);
    else if (version === 47) dropHostedMemorySchema(damaged);
    if (version === 44) damaged.exec("DROP TABLE account_mutation_authority_rebinds");
    damaged.query("DELETE FROM migrations WHERE version>?").run(version);
    damaged.exec(`PRAGMA user_version=${String(version)}`);
    damaged.exec("DROP TRIGGER queue_transcript_cancellation_settlement");
    const before = databaseSnapshot(damaged);
    damaged.close(false);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_V43_QUEUE_CANCELLATION_GUARD_INVALID");
    const inspector = new Database(paths.database, { readonly: true });
    try {
      expect(inspector.query("SELECT 1 FROM sqlite_master WHERE name='queue_transcript_cancellation_settlement'").get()).toBeNull();
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: version });
      expect(databaseSnapshot(inspector)).toBe(before);
    } finally { inspector.close(false); }
  });
});

function enableAfterHours(store: StateStore): void {
  const hours = store.readNotificationHours();
  store.updateNotificationHours({
    version: 1, startMinute: 480, endMinute: 1080, timeZone: "UTC", expectedRevision: hours.revision,
  });
  const policy = store.readAutorespondAfterHoursPolicy();
  store.updateAutorespondAfterHoursPolicy({ enabled: true, expectedRevision: policy.revision });
}

function provisional(store: StateStore, sessionId: string) {
  return store.readAutorespondAfterHoursSelection(sessionId, "protocol", "eligible");
}

function finishQueueSource(store: StateStore, sessionId: string, actor: "human" | "autorespond" | "automation" | "provider_switch" = "human") {
  const session = store.requireSession(sessionId);
  const profile = store.requireProfile(session.profileId);
  const queued = store.enqueueIdempotent({
    sessionId, profileGeneration: profile.processGeneration, message: "Synthetic approved continuation", actor,
  });
  expect(store.transitionQueue(queued.id, "pending", "dispatching")).toBe(true);
  expect(store.transitionQueue(queued.id, "dispatching", "applied")).toBe(true);
  return () => store.finalizeSessionUserMessageSource({ sessionId, sourceKind: "queue", sourceId: queued.id, turnId: "synthetic-turn" });
}

async function legacyAfterHoursFixture(beforeMigration?: (store: StateStore, sessionId: string) => void) {
  const fixtureValue = await fixture();
  const { store, sessionId, clock } = fixtureValue;
  beforeMigration?.(store, sessionId);
  const paths = store.paths;
  // This exact v45 predecessor models the immutable positive v44 migration
  // marker after its rolling hold has expired, including a possible old reset.
  stores.splice(stores.indexOf(store), 1);
  store.close();
  const predecessor = new Database(paths.database);
  dropCanonicalProfileSchema(predecessor);
  dropPeerAndHostedMemorySchema(predecessor);
  dropAfterHoursSchema(predecessor);
  const guard = (predecessor.query("SELECT sql FROM sqlite_master WHERE name='autorespond_budget_history_immutable'").get() as { sql: string }).sql;
  predecessor.exec("DROP TRIGGER autorespond_budget_history_immutable");
  predecessor.query("UPDATE autorespond_budget_history SET available_at=1 WHERE session_id=?").run(sessionId);
  predecessor.exec(guard);
  predecessor.close(false);
  const migrated = new StateStore(paths, { now: () => clock.now });
  stores.push(migrated);
  enableAfterHours(migrated);
  return { ...fixtureValue, store: migrated };
}

describe("after-hours autorespond storage authority", () => {
  test("migrates exact v45 without changing predecessor objects, rows, counters, or reservation history", async () => {
    const { store, sessionId, clock } = await fixture();
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    const paths = store.paths;
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const inspector = new Database(paths.database);
    dropCanonicalProfileSchema(inspector);
    dropPeerAndHostedMemorySchema(inspector);
    dropAfterHoursSchema(inspector);
    const schema = readRows(inspector, "SELECT name,sql,type FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name");
    const columns = Object.fromEntries(canonicalProfileTables.map((table) => [table,
      readRows(inspector, `PRAGMA table_xinfo('${table}')`),
    ]));
    const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
    const rows = ["sessions", "profiles", "autorespond_budget_history", "autorespond_budget_reservations", "session_autorespond_counters", "account_mutation_authority_rebinds"]
      .map((name) => ({ name, rows: readRows(inspector, `SELECT * FROM ${name}`) }));
    expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:45:50");
    const migrated = new StateStore(paths, { now: () => clock.now });
    stores.push(migrated);
    expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 50 });
    const migratedSchema = readRows(inspector,
      "SELECT name,sql,type FROM sqlite_master WHERE sql IS NOT NULL AND name!='queue_entries' ORDER BY name",
    );
    for (const row of schema.filter((entry) => entry.name !== "queue_entries")) {
      if (row.type === "table" && canonicalProfileTables.some((table) => table === row.name)) {
        const after = migratedSchema.find((entry) => entry.name === row.name && entry.type === row.type);
        const sql = z.string().parse(after?.sql);
        const addition = ", canonical_profile_key TEXT";
        expect(sql.split(addition)).toHaveLength(2);
        expect({ ...after, sql: sql.replace(addition, "") })
          .toEqual({ ...row, sql: z.string().parse(row.sql) });
      } else expect(migratedSchema).toContainEqual(row);
    }
    for (const table of canonicalProfileTables) {
      const after = readRows(inspector, `PRAGMA table_xinfo('${table}')`);
      const previous = columns[table];
      if (previous === undefined) throw new Error("Missing predecessor column metadata.");
      expect(after.filter((column) => column.name !== "canonical_profile_key")).toEqual(previous);
      expect(after.filter((column) => column.name === "canonical_profile_key")).toHaveLength(1);
    }
    expect(inspector.query("SELECT * FROM migrations WHERE version<46 ORDER BY version").all()).toEqual(ledger);
    for (const row of rows) {
      const expected = row.name === "sessions" ? row.rows.map((session) => {
        const key = deriveLegacySessionProfileKey(session.provider_v39, session.preset, session.preset_contract);
        expect(key).not.toBeNull();
        return { ...session, canonical_profile_key: key };
      }) : row.rows;
      expect(readRows(inspector, `SELECT * FROM ${row.name}`)).toEqual(expected);
    }
    enableAfterHours(migrated);
    expect(provisional(migrated, sessionId).tier).toBe("after_hours");
    expect(migrated.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 1, lastHour: 1, lastDay: 1 });
    const fresh = provenSession(migrated, migrated.requireSession(sessionId).profileId, "Fresh after v46");
    expect(provisional(migrated, fresh.id).tier).toBe("after_hours");
    inspector.close(false);
  });

  test("rejects missing v45 history or predecessor ledger and rolls failed v46 migration back without partial authority", async () => {
    for (const damage of ["missing_history", "predecessor_ledger", "ledger_failure"] as const) {
      const { store, sessionId, clock } = await fixture();
      const paths = store.paths;
      stores.splice(stores.indexOf(store), 1);
      store.close();
      const inspector = new Database(paths.database);
      dropCanonicalProfileSchema(inspector);
      dropPeerAndHostedMemorySchema(inspector);
      dropAfterHoursSchema(inspector);
      if (damage === "missing_history") inspector.query("DELETE FROM autorespond_budget_history WHERE session_id=?").run(sessionId);
      else if (damage === "predecessor_ledger") inspector.exec("DELETE FROM migrations WHERE version=45");
      else inspector.exec(`CREATE TRIGGER reject_v46_ledger BEFORE INSERT ON migrations WHEN NEW.version=46
        BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END;`);
      const schema = inspector.query("SELECT * FROM sqlite_master ORDER BY type,name").all();
      const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      const before = databaseSnapshot(inspector);
      expect(() => new StateStore(paths, { now: () => clock.now })).toThrow(damage === "missing_history"
        ? "STATE_SCHEMA_V46_AUTORESPOND_BUDGET_HISTORY_INVALID"
        : damage === "predecessor_ledger" ? "STATE_SCHEMA_V45_MIGRATION_LEDGER_INVALID" : "synthetic migration failure");
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 45 });
      expect(inspector.query("SELECT * FROM sqlite_master ORDER BY type,name").all()).toEqual(schema);
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledger);
      expect(databaseSnapshot(inspector)).toBe(before);
      inspector.close(false);
    }
  });

  test.each([
    "collision", "missing_guard", "weak_guard", "extra_trigger", "extra_index",
    "missing_policy", "bad_policy", "missing_barrier", "missing_ledger", "future_ledger",
  ] as const)(
    "rejects predecessor collisions and damaged current authority without repair on writable or readonly reopen: %s",
    async (damage) => {
      const { store, sessionId } = await fixture();
      const paths = store.paths;
      stores.splice(stores.indexOf(store), 1);
      store.close();
      const inspector = new Database(paths.database);
      if (damage === "collision") {
        dropCanonicalProfileSchema(inspector);
        dropPeerAndHostedMemorySchema(inspector);
        inspector.exec("DROP TRIGGER work_session_project_authority_guard");
        inspector.exec("DELETE FROM migrations WHERE version>=46; PRAGMA user_version=45");
      } else if (damage === "missing_guard" || damage === "weak_guard") {
        inspector.exec("DROP TRIGGER autorespond_after_hours_history_update_guard");
        if (damage === "weak_guard") inspector.exec(`CREATE TRIGGER autorespond_after_hours_history_update_guard
          BEFORE UPDATE ON autorespond_after_hours_history BEGIN SELECT 1; END;`);
      } else if (damage === "extra_trigger") {
        inspector.exec("CREATE TRIGGER unrelated_name AFTER UPDATE ON autorespond_after_hours_policy BEGIN SELECT 1; END");
      } else if (damage === "extra_index") {
        inspector.exec("CREATE INDEX unrelated_name ON autorespond_after_hours_history(human_reset_required)");
      } else if (damage === "missing_policy") {
        const sql = (inspector.query("SELECT sql FROM sqlite_master WHERE name='autorespond_after_hours_policy_delete_guard'").get() as { sql: string }).sql;
        inspector.exec("DROP TRIGGER autorespond_after_hours_policy_delete_guard; DELETE FROM autorespond_after_hours_policy");
        inspector.exec(sql);
      } else if (damage === "bad_policy") {
        const sql = (inspector.query("SELECT sql FROM sqlite_master WHERE name='autorespond_after_hours_policy_update_guard'").get() as { sql: string }).sql;
        inspector.exec("DROP TRIGGER autorespond_after_hours_policy_update_guard; PRAGMA ignore_check_constraints=ON; UPDATE autorespond_after_hours_policy SET enabled=2; PRAGMA ignore_check_constraints=OFF");
        inspector.exec(sql);
      } else if (damage === "missing_barrier") {
        const sql = (inspector.query("SELECT sql FROM sqlite_master WHERE name='autorespond_after_hours_history_delete_guard'").get() as { sql: string }).sql;
        inspector.exec("DROP TRIGGER autorespond_after_hours_history_delete_guard");
        inspector.query("DELETE FROM autorespond_after_hours_history WHERE session_id=?").run(sessionId);
        inspector.exec(sql);
      } else if (damage === "missing_ledger") inspector.exec("DELETE FROM migrations WHERE version=46");
      else inspector.exec("INSERT INTO migrations(version,applied_at) VALUES (51,1000000)");
      const before = inspector.query("SELECT * FROM sqlite_master ORDER BY type,name").all();
      const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      for (const readonly of [true, false]) {
        expect(() => new StateStore(paths, { readonly })).toThrow();
        expect(inspector.query("SELECT * FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
        expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledger);
      }
      inspector.close(false);
    },
  );

  test("guards replacement, unproved barrier clearing and exhausted consent revision", async () => {
    const { store, sessionId } = await legacyAfterHoursFixture();
    const inspector = new Database(store.paths.database);
    expect(() => inspector.exec("INSERT OR REPLACE INTO autorespond_after_hours_policy VALUES (1,'autorespond_after_hours',1,1,0,0,0)")).toThrow();
    expect(() => inspector.query("INSERT OR REPLACE INTO autorespond_after_hours_history(session_id,human_reset_required) VALUES (?,0)").run(sessionId)).toThrow();
    expect(() => inspector.query("UPDATE autorespond_after_hours_history SET human_reset_required=0 WHERE session_id=?").run(sessionId)).toThrow();
    const guard = (inspector.query("SELECT sql FROM sqlite_master WHERE name='autorespond_after_hours_policy_update_guard'").get() as { sql: string }).sql;
    inspector.exec("DROP TRIGGER autorespond_after_hours_policy_update_guard");
    inspector.query("UPDATE autorespond_after_hours_policy SET revision=?").run(Number.MAX_SAFE_INTEGER);
    inspector.exec(guard);
    expect(() => store.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: Number.MAX_SAFE_INTEGER }))
      .toThrow("AUTORESPOND_AFTER_HOURS_REVISION_EXHAUSTED");
    expect(store.readAutorespondAfterHoursPolicy()).toMatchObject({ revision: Number.MAX_SAFE_INTEGER, enabled: true });
    inspector.close(false);
  });

  test("keeps strict default-off consent independent of notification consent and schedule revision", async () => {
    const { store, sessionId, clock } = await fixture();
    const original = store.readAutorespondAfterHoursPolicy();
    expect(original).toEqual({ kind: "autorespond_after_hours", version: 1, revision: 1, enabled: false });
    expect(Object.isFrozen(original)).toBe(true);
    const notification = store.readNotificationEmailPolicy();
    store.updateNotificationEmailPolicy({ enabled: true, expectedRevision: notification.revision });
    expect(provisional(store, sessionId).reason).toBe("policy_disabled");
    expect(store.readAutorespondAfterHoursPolicy()).toEqual(original);
    const hours = store.readNotificationHours();
    const email = store.readNotificationEmailPolicy();
    const other = new StateStore(store.paths, { now: () => clock.now });
    stores.push(other);
    expect(other.updateAutorespondAfterHoursPolicy({ enabled: true, expectedRevision: 1 })).toMatchObject({ revision: 2, enabled: true });
    expect(() => store.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: 1 }))
      .toThrow("AUTORESPOND_AFTER_HOURS_POLICY_CONFLICT");
    expect(() => store.updateAutorespondAfterHoursPolicy({ enabled: 1, expectedRevision: 2 } as never)).toThrow();
    expect(() => store.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: 2, limits: 999 } as never)).toThrow();
    expect(store.readNotificationHours()).toEqual(hours);
    expect(store.readNotificationEmailPolicy()).toEqual(email);
    expect(original.enabled).toBe(false);
    const readonly = new StateStore(store.paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.readAutorespondAfterHoursPolicy()).toMatchObject({ revision: 2, enabled: true });
  });

  test("selects one coherent snapshot despite a concurrent schedule and consent writer", async () => {
    const { store, sessionId, clock } = await fixture();
    enableAfterHours(store);
    const other = new StateStore(store.paths, { now: () => clock.now });
    stores.push(other);
    const original = store.readAutorespondAfterHoursPolicy.bind(store);
    store.readAutorespondAfterHoursPolicy = () => {
      const policy = original();
      other.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: policy.revision });
      const hours = other.readNotificationHours();
      other.updateNotificationHours({ version: 1, startMinute: 0, endMinute: 60, timeZone: "UTC", expectedRevision: hours.revision });
      return policy;
    };
    const selected = provisional(store, sessionId);
    store.readAutorespondAfterHoursPolicy = original;
    expect(selected).toMatchObject({ tier: "after_hours", snapshot: { policy: { revision: 2, enabled: true }, schedule: { startMinute: 480, endMinute: 1080 } } });
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "policy_disabled" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 0, lastHour: 0, lastDay: 0 });
  });

  test("reserves six protocol admissions across stores and never resets spend at a schedule crossing", async () => {
    const { store, sessionId, clock } = await fixture();
    enableAfterHours(store);
    clock.now = 9 * AUTORESPOND_HOUR_MS;
    for (let count = 0; count < 3; count += 1) expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    clock.now = 18 * AUTORESPOND_HOUR_MS;
    const other = new StateStore(store.paths, { now: () => clock.now });
    stores.push(other);
    for (let count = 0; count < 3; count += 1) expect(reserveProtocol(other, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    clock.now = 32 * AUTORESPOND_HOUR_MS;
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "within_hours" });
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(6);
    expect(reserveProtocol(other, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
  });

  test("enforces elevated rolling 20/80 ceilings and returns to baseline without refund", async () => {
    const { store, sessionId, clock } = await fixture();
    enableAfterHours(store);
    const start = clock.now;
    for (let hour = 0; hour < 4; hour += 1) {
      clock.now = start + hour * (AUTORESPOND_HOUR_MS + 1);
      for (let count = 0; count < 20; count += 1) {
        store.resetAutorespondCounter(sessionId);
        expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
      }
      store.resetAutorespondCounter(sessionId);
      expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "hourly_budget" });
    }
    clock.now += AUTORESPOND_HOUR_MS + 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "daily_budget" });
    const policy = store.readAutorespondAfterHoursPolicy();
    store.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: policy.revision });
    expect(store.readAutorespondBudgets(sessionId).lastDay).toBe(80);
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "daily_budget" });
  });

  test("rederives protocol eligibility from stored display and current mode, not a provisional eligible flag", async () => {
    const { store, sessionId } = await fixture();
    enableAfterHours(store);
    expect(provisional(store, sessionId).tier).toBe("after_hours");
    const sourceId = protocolSource(store, sessionId);
    store.setSessionApprovalMode(sessionId, "auto:workspace");
    expect(store.reserveAutorespondBudget({ sessionId, sourceId, sourceKind: "protocol", expectedMode: "auto:workspace" }))
      .toEqual({ state: "refused", code: "protected_authority_required" });
    store.setSessionApprovalMode(sessionId, "auto:all");
    const unavailable = protocolSource(store, sessionId, false);
    expect(reserveProtocol(store, sessionId, unavailable)).toEqual({ state: "refused", code: "decision_unavailable" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 0, lastHour: 0, lastDay: 0 });
  });

  test("keeps prose at baseline and refuses invalid accounting clocks instead of using fallback limits", async () => {
    const { store, sessionId, clock } = await fixture();
    enableAfterHours(store);
    expect(store.readAutorespondAfterHoursSelection(sessionId, "prose", "eligible")).toMatchObject({ tier: "baseline", reason: "prose_baseline", limits: { consecutive: 3, lastHour: 10, lastDay: 40 } });
    expect(store.readAutorespondAfterHoursSelection(sessionId, "protocol", "eligible", Number.NaN)).toMatchObject({ tier: "baseline" });
    const sourceId = protocolSource(store, sessionId);
    for (const invalidTime of [Number.NaN, Number.POSITIVE_INFINITY, -1, 8_640_000_000_000_001]) {
      clock.now = invalidTime;
      expect(() => reserveProtocol(store, sessionId, sourceId)).toThrow();
    }
    clock.now = 1_000_000;
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 0, lastHour: 0, lastDay: 0 });
    expect(reserveProtocol(store, sessionId, sourceId)).toEqual({ state: "reserved" });
    clock.now -= 1;
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "history_unproven" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "history_unavailable" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 1, lastHour: 1, lastDay: 1 });
  });

  test("charges prose against the lower tier even when protocol is enabled outside hours", async () => {
    const { store, sessionId } = await fixture();
    enableAfterHours(store);
    for (let count = 0; count < 3; count += 1) expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    const session = store.requireSession(sessionId);
    const profile = store.requireProfile(session.profileId);
    const sourceId = crypto.randomUUID();
    const message = "Synthetic approved continuation";
    const attempt = store.prepareMutation({ kind: "session.send", authorityId: sessionId,
      authorityGeneration: profile.processGeneration, request: { message }, idempotencyKey: sourceId });
    store.recordAutorespondMessageSource(sessionId, attempt.id);
    store.beginSessionMutationEffect({
      attemptId: attempt.id, sessionId, profileGeneration: profile.processGeneration, message,
      transcript: { accountId: profile.id, providerGeneration: profile.processGeneration,
        providerConnectionId: "46000000-0000-4000-8000-000000000001", actor: "autorespond" as const, message },
      evidence: { kind: "session.send", providerThreadId: session.providerThreadId ?? "",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id, messageDigest: createHash("sha256").update(message).digest("hex") },
    });
    expect(store.reserveAutorespondBudget({ sessionId, sourceId, sourceKind: "prose", expectedMode: "auto:all" }))
      .toEqual({ state: "refused", code: "consecutive_limit" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 4, lastHour: 4, lastDay: 4 });
  });

  test("schedule read failure selects baseline but missing policy or barrier cannot become approval authority", async () => {
    const { store, sessionId } = await fixture();
    enableAfterHours(store);
    const readHours = store.readNotificationHours.bind(store);
    store.readNotificationHours = () => { throw new Error("Synthetic schedule read failure"); };
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "schedule_invalid" });
    for (let count = 0; count < 3; count += 1) expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    store.readNotificationHours = readHours;
    const inspector = new Database(store.paths.database);
    inspector.exec("PRAGMA ignore_check_constraints=ON");
    inspector.query("UPDATE notification_hours SET revision=revision+1,end_minute=start_minute").run();
    inspector.query("UPDATE attention_email_policy SET revision=revision+1").run();
    inspector.exec("PRAGMA ignore_check_constraints=OFF");
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "schedule_invalid" });
    const readPolicy = store.readAutorespondAfterHoursPolicy.bind(store);
    store.readAutorespondAfterHoursPolicy = () => { throw new Error("Synthetic missing approval consent"); };
    expect(() => provisional(store, sessionId)).toThrow("Synthetic missing approval consent");
    expect(() => reserveProtocol(store, sessionId)).toThrow("Synthetic missing approval consent");
    store.readAutorespondAfterHoursPolicy = readPolicy;
    inspector.exec("DROP TRIGGER autorespond_after_hours_history_delete_guard");
    inspector.query("DELETE FROM autorespond_after_hours_history WHERE session_id=?").run(sessionId);
    expect(() => provisional(store, sessionId)).toThrow();
    expect(() => reserveProtocol(store, sessionId)).toThrow();
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 3, lastHour: 3, lastDay: 3 });
    inspector.close(false);
  });

  test("neither historical human replay nor its exact old receipt clears a newly migrated barrier", async () => {
    let historicalSourceId = "";
    const { store, sessionId } = await legacyAfterHoursFixture((predecessor, id) => {
      const event = finishQueueSource(predecessor, id)();
      if (event?.body.type !== "user_message" || event.body.sourceId === undefined) throw new Error("missing fixture human source");
      historicalSourceId = event.body.sourceId;
    });
    expect(store.finalizeSessionUserMessageSource({ sessionId, sourceKind: "queue", sourceId: historicalSourceId, turnId: "synthetic-turn" })).toBeNull();
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
    const inspector = new Database(store.paths.database);
    expect(() => inspector.query(`UPDATE autorespond_after_hours_history
      SET human_reset_required=0,reset_source_kind='queue',reset_source_id=? WHERE session_id=?`)
      .run(historicalSourceId, sessionId)).toThrow("autorespond after-hours history requires exact human finalization");
    inspector.close(false);
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
  });

  test("legacy positive history requires a new human finalization, not clock expiry, generic reset, or autorespond", async () => {
    const { store, sessionId, clock } = await legacyAfterHoursFixture();
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "human_reset_required" });
    store.resetAutorespondCounter(sessionId);
    finishQueueSource(store, sessionId, "autorespond")();
    finishQueueSource(store, sessionId, "automation")();
    finishQueueSource(store, sessionId, "provider_switch")();
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
    for (let count = 0; count < 2; count += 1) expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    const humanFinalize = finishQueueSource(store, sessionId);
    expect(humanFinalize()?.body).toMatchObject({ type: "user_message", actor: "human" });
    expect(provisional(store, sessionId).tier).toBe("after_hours");
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(0);
    expect(humanFinalize()).toBeNull();
    // Cleared history is durable proof, not a foreign key to retained events.
    store.maintainSessionEventRetention(sessionId, clock.now + 365 * AUTORESPOND_DAY_MS);
    expect(store.listSessionEvents({ sessionId, afterSequence: 0 }).events).toHaveLength(0);
    const reopened = new StateStore(store.paths, { now: () => clock.now });
    stores.push(reopened);
    expect(provisional(reopened, sessionId).tier).toBe("after_hours");
  });

  test("clears a legacy barrier on exact direct human mutation finalization", async () => {
    const { store, sessionId } = await legacyAfterHoursFixture();
    const session = store.requireSession(sessionId);
    const profile = store.requireProfile(session.profileId);
    const sourceId = crypto.randomUUID();
    const message = "Synthetic human reset";
    const attempt = store.prepareMutation({ kind: "session.send", authorityId: sessionId,
      authorityGeneration: profile.processGeneration, request: { message }, idempotencyKey: sourceId });
    store.beginSessionMutationEffect({
      attemptId: attempt.id, sessionId, profileGeneration: profile.processGeneration, message,
      transcript: { accountId: profile.id, providerGeneration: profile.processGeneration,
        providerConnectionId: "46000000-0000-4000-8000-000000000002", actor: "human" as const, message },
      evidence: { kind: "session.send", providerThreadId: session.providerThreadId ?? "",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id, messageDigest: createHash("sha256").update(message).digest("hex") },
    });
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
    expect(store.transitionMutation(attempt.id, "effect_started", "applied", { turnId: "synthetic-human-turn" })).toBe(true);
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
    expect(store.finalizeSessionUserMessageSource({ sessionId, sourceKind: "mutation", sourceId, turnId: "synthetic-human-turn" })?.body)
      .toMatchObject({ type: "user_message", actor: "human" });
    expect(provisional(store, sessionId).tier).toBe("after_hours");
  });

  test("rolls barrier, counter, source and event back if finalization fails after the human reset", async () => {
    const { store, sessionId } = await legacyAfterHoursFixture();
    store.bumpAutorespondCounter(sessionId);
    const finalize = finishQueueSource(store, sessionId);
    const inspector = new Database(store.paths.database);
    inspector.exec(`CREATE TRIGGER reject_after_hours_stream_advance BEFORE UPDATE OF next_sequence ON session_event_streams
      BEGIN SELECT RAISE(ABORT,'synthetic stream failure'); END;`);
    expect(finalize).toThrow("synthetic stream failure");
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(1);
    expect(store.listSessionEvents({ sessionId, afterSequence: 0 }).events).toHaveLength(0);
    inspector.exec("DROP TRIGGER reject_after_hours_stream_advance");
    expect(finalize()?.body).toMatchObject({ actor: "human" });
    expect(provisional(store, sessionId).tier).toBe("after_hours");
    inspector.close(false);
  });
});
