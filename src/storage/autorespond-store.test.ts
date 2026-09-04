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
