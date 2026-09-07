import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { AUTORESPOND_DAY_MS, AUTORESPOND_HOUR_MS } from "../domain/autorespond-budget";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const stores: StateStore[] = [];

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

function protocolSource(store: StateStore, sessionId: string): string {
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
      availableDecisions: ["once", "decline", "cancel"],
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
    predecessor.exec(`
      DROP TRIGGER sessions_autorespond_budget_history;
      DROP TABLE autorespond_budget_history;
      DROP TABLE autorespond_budget_reservations;
      DELETE FROM migrations WHERE version=44;
      PRAGMA user_version=43;
    `);
    predecessor.close(false);
    expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:43:44");
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
    damaged.exec("DELETE FROM migrations WHERE version=44; PRAGMA user_version=43");
    expect(damaged.query("SELECT available_at FROM autorespond_budget_history WHERE session_id=?").get(sessionId))
      .toEqual({ available_at: 0 });
    damaged.close(false);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_V44_AUTORESPOND_BUDGET_PREDECESSOR_COLLISION");
  });

  test("never applies pre-release v43 trigger-repair allowances to canonical v44", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const damaged = new Database(paths.database);
    damaged.exec("DROP TRIGGER queue_transcript_cancellation_settlement");
    damaged.close(false);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_V43_QUEUE_CANCELLATION_GUARD_INVALID");
    const inspector = new Database(paths.database, { readonly: true });
    try {
      expect(inspector.query("SELECT 1 FROM sqlite_master WHERE name='queue_transcript_cancellation_settlement'").get()).toBeNull();
    } finally { inspector.close(false); }
  });
});
