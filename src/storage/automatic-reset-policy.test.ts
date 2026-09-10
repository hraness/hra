import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const stores: StateStore[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(state: "prepared" | "retryable" | "ambiguous") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-reset-policy-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  const now = 1_800_000_000_000;
  const store = new StateStore(paths, { now: () => now, resolveMachineTimeZone: () => "UTC" });
  stores.push(store);
  // Open both genuine connections before the attempt; neither reopen recovery
  // nor fixture-only SQL may substitute for a concurrently committed policy.
  const writer = new StateStore(paths, { now: () => now, resolveMachineTimeZone: () => "UTC" });
  stores.push(writer);
  const current = store.nextProfileGeneration(store.createProfile("Reset policy").id);
  const email = "reset-policy@example.com";
  expect(store.setProfileState(current.id, current.processGeneration, "signed_in", { email, plan: "Plus" })).toBe(true);
  const profile = store.requireProfileById(current.id);
  const fingerprint = createHash("sha256").update(email).digest("hex");
  const input = { profileId: profile.id, processGeneration: profile.processGeneration,
    accountFingerprint: fingerprint, weeklyWindowResetsAt: now + 86_400_000, observedUsedPercent: 99 };
  expect(store.authorizeAccountRateLimitResetPolicy({ ...input, weeklyWindowDurationMinutes: 10_080 }).decision).toBe("allow");
  const attempt = store.prepareAccountRateLimitReset(input);
  const authority = store.requireProviderAccountAuthority(profile.id, "codex");
  if (state !== "prepared") {
    store.beginAccountRateLimitReset(attempt.idempotencyKey, authority);
    store.deferAccountRateLimitReset(attempt.idempotencyKey, state);
  }
  const configure = (change: Parameters<StateStore["updateAutomaticUsagePolicyConfiguration"]>[0]["change"]) =>
    writer.updateAutomaticUsagePolicyConfiguration({ idempotencyKey: randomUUID(),
      expectedAutomaticPolicyRevision: writer.readAutomaticUsagePolicyConfiguration().automaticPolicyRevision, change });
  const snapshot = () => {
    const db = new Database(paths.database, { readonly: true, strict: true });
    try {
      const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      return {
        version: db.query("PRAGMA user_version").get(),
        schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        tables: names.map(({ name }) => ({ name,
          rows: db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })),
      };
    } finally { db.close(false); }
  };
  return { store, writer, profile, fingerprint, attempt, authority, configure, snapshot };
}

describe("automatic policy reset transaction admission", () => {
  for (const state of ["prepared", "retryable", "ambiguous"] as const) {
    test(`refuses ${state} begin after second-connection disable without any write`, async () => {
      const value = await fixture(state);
      expect(value.store.readAutomaticUsagePolicyConfiguration()).toMatchObject({ defaultEnabled: true, automaticPolicyRevision: 1 });
      value.configure({ kind: "set_override", provider: "codex", override: "off" });
      const before = value.snapshot();
      expect(() => value.store.beginAccountRateLimitReset(value.attempt.idempotencyKey, value.authority))
        .toThrow("ACCOUNT_RATE_LIMIT_RESET_AUTOMATIC_POLICY_DISABLED");
      expect(value.snapshot()).toEqual(before);
      expect(value.writer.readRecoverableAccountRateLimitReset(value.profile.id, value.fingerprint))
        .toMatchObject({ idempotencyKey: value.attempt.idempotencyKey, state, outcome: null, localResolution: null });
      value.configure({ kind: "set_override", provider: "codex", override: "on" });
      expect(value.store.beginAccountRateLimitReset(value.attempt.idempotencyKey, value.authority))
        .toMatchObject({ idempotencyKey: value.attempt.idempotencyKey, state: "effect_started" });
    });
  }

  test("allows Codex on despite default off and Claude off at the begin boundary", async () => {
    const value = await fixture("prepared");
    value.configure({ kind: "set_default", enabled: false });
    value.configure({ kind: "set_override", provider: "codex", override: "on" });
    value.configure({ kind: "set_override", provider: "claude", override: "off" });
    expect(value.store.beginAccountRateLimitReset(value.attempt.idempotencyKey, value.authority))
      .toMatchObject({ idempotencyKey: value.attempt.idempotencyKey, state: "effect_started" });
  });
});
