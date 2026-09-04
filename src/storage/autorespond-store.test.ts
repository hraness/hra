import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const profile = store.createProfile("Personal");
  const session = store.createSession({ profileId: profile.id, title: "Autorespond", preset: "high", fastEnabled: false });
  return { store, sessionId: session.id, clock };
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

  test("counts consecutive autoresponses until a human reset and windows evidence by hour and day", async () => {
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
    clock.now += 2 * 60 * 60 * 1_000;
    record("accepted");
    record("refused");
    const budgets = store.readAutorespondBudgets(sessionId);
    expect(budgets.lastHour).toBe(1);
    expect(budgets.lastDay).toBe(2);
    expect(store.countAutorespondEvidence({ sessionId })).toEqual({ accepted: 2, refused: 1 });
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
    // A sent prose reply spends the same per-session budget as a protocol accept.
    expect(store.readAutorespondBudgets(sessionId)).toMatchObject({ lastDay: 1, lastHour: 1 });
    expect(store.countAutorespondEvidence({ sessionId })).toEqual({ accepted: 1, refused: 1 });
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
