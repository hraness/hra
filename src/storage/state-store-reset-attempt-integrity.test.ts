import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

type Attempt = ReturnType<StateStore["prepareAccountRateLimitReset"]>;
type Variant = Readonly<{
  state: Attempt["state"];
  outcome?: NonNullable<Attempt["outcome"]>;
  localResolution?: NonNullable<Attempt["localResolution"]>;
}>;
type RowPatch = Partial<{
  origin_process_generation: number;
  current_process_generation: number;
  created_at: number;
  updated_at: number;
  state: Attempt["state"];
  outcome: Attempt["outcome"];
  local_resolution: Attempt["localResolution"];
}>;

const roots: string[] = [];
const stores: StateStore[] = [];
const inspectors: Database[] = [];
const invalidShape = "ACCOUNT_RATE_LIMIT_RESET_ATTEMPT_SHAPE_INVALID";
afterEach(async () => {
  for (const inspector of inspectors.splice(0)) inspector.close(false);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(initialNow = 1_000) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-reset-attempt-integrity-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  let now = initialNow;
  const store = new StateStore(paths, { now: () => now, resolveMachineTimeZone: () => "UTC" });
  stores.push(store);
  const inspector = new Database(paths.database, { strict: true });
  inspectors.push(inspector);
  const schema = () => inspector.query(
    "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
  ).all();
  const snapshot = () => {
    const tables = inspector.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all();
    const hash = createHash("sha256");
    for (const { name } of tables) {
      hash.update(name).update(JSON.stringify(inspector.query(
        `SELECT * FROM "${name.replaceAll('"', '""')}"`,
      ).all()));
    }
    return { rows: hash.digest("hex"), schema: schema(),
      version: inspector.query("PRAGMA user_version").get(),
      schemaVersion: inspector.query("PRAGMA schema_version").get(),
      dataVersion: inspector.query("PRAGMA data_version").get() };
  };
  // Corruption exists only in this disposable database. Restore the exact
  // installed triggers and CHECK enforcement before any product API runs.
  const patch = (attempt: Attempt, changes: RowPatch) => {
    const beforeSchema = schema();
    inspector.exec("PRAGMA ignore_check_constraints=ON");
    try {
      inspector.transaction(() => {
        const triggers = inspector.query<{ name: string; sql: string }, []>(
          "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='account_rate_limit_reset_attempts' ORDER BY name",
        ).all();
        for (const trigger of triggers) inspector.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
        const entries = Object.entries(changes);
        const changed = inspector.query(
          `UPDATE account_rate_limit_reset_attempts SET ${entries.map(([name]) => `"${name}"=?`).join(",")} WHERE idempotency_key=?`,
        ).run(...entries.map(([, value]) => value), attempt.idempotencyKey);
        expect(changed.changes).toBe(1);
        for (const trigger of triggers) inspector.exec(trigger.sql);
        expect(schema()).toEqual(beforeSchema);
      }).immediate();
    } finally {
      inspector.exec("PRAGMA ignore_check_constraints=OFF");
    }
    expect(inspector.query("PRAGMA ignore_check_constraints").get()).toEqual({ ignore_check_constraints: 0 });
  };
  let sourceIndex = 0;
  const create = (variant: Variant = { state: "prepared" }) => {
    sourceIndex += 1;
    const email = `reset-integrity-${sourceIndex}@example.com`;
    const profile = store.nextProfileGeneration(store.createProfile(`Reset integrity ${sourceIndex}`).id);
    expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email, plan: "Plus" })).toBe(true);
    const input = { profileId: profile.id, processGeneration: profile.processGeneration,
      accountFingerprint: createHash("sha256").update(email).digest("hex"),
      weeklyWindowResetsAt: Math.min(Number.MAX_SAFE_INTEGER, now + 10_000), observedUsedPercent: 99 };
    expect(store.authorizeAccountRateLimitResetPolicy({ ...input, weeklyWindowDurationMinutes: 10_080 }).decision).toBe("allow");
    let attempt = store.prepareAccountRateLimitReset(input);
    if (variant.state === "closed") {
      attempt = store.closeAccountRateLimitReset(attempt.idempotencyKey, variant.localResolution!);
    } else if (variant.state !== "prepared") {
      attempt = store.beginAccountRateLimitReset(attempt.idempotencyKey, store.requireProviderAccountAuthority(profile.id, "codex"));
      if (variant.state === "retryable" || variant.state === "ambiguous") {
        attempt = store.deferAccountRateLimitReset(attempt.idempotencyKey, variant.state);
      } else if (variant.state === "settled") {
        attempt = store.settleAccountRateLimitReset(attempt.idempotencyKey, variant.outcome!);
      }
    }
    return { attempt, input, email };
  };
  const rawAttempt = (attempt: Attempt) => inspector.query(
    "SELECT * FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
  ).get(attempt.idempotencyKey);
  return { store, create, patch, snapshot, rawAttempt, setNow: (value: number) => { now = value; } };
}

const variants: readonly Variant[] = [
  { state: "prepared" }, { state: "effect_started" }, { state: "ambiguous" }, { state: "retryable" },
  ...(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"] as const).map((outcome) => ({ state: "settled" as const, outcome })),
  ...(["weekly_window_changed", "account_identity_changed"] as const).map((localResolution) => ({ state: "closed" as const, localResolution })),
];

describe("reset attempt historical row integrity", () => {
  test("reads all six legal states, all outcomes and both local resolutions without altering evidence", async () => {
    const value = await fixture();
    for (const variant of variants) {
      const { attempt, input } = value.create(variant);
      expect(attempt.currentProcessGeneration).toBe(attempt.originProcessGeneration);
      expect(attempt.updatedAt).toBe(attempt.createdAt);
      const before = value.snapshot();
      expect(value.store.latestAccountRateLimitResetAttempt(input.profileId, input.accountFingerprint)).toEqual(attempt);
      expect(value.store.readRecoverableAccountRateLimitReset(input.profileId, input.accountFingerprint))
        .toEqual(variant.state === "settled" || variant.state === "closed" ? null : attempt);
      expect(value.snapshot()).toEqual(before);
      // noCredit intentionally permits another attempt; it is not a replay latch.
      if (variant.outcome !== "noCredit") {
        expect(value.store.prepareAccountRateLimitReset(input)).toEqual(attempt);
        expect(value.snapshot()).toEqual(before);
      }
    }
  });

  test("keeps genuine generation rebinds and monotone clock extremes readable", async () => {
    const value = await fixture(0);
    const { attempt, input, email } = value.create();
    const next = value.store.nextProfileGeneration(input.profileId);
    expect(value.store.setProfileState(next.id, next.processGeneration, "signed_in", { email, plan: "Plus" })).toBe(true);
    const rebound = value.store.rebindAccountRateLimitReset({ idempotencyKey: attempt.idempotencyKey,
      expectedCurrentProcessGeneration: attempt.currentProcessGeneration,
      nextProcessGeneration: next.processGeneration, accountFingerprint: input.accountFingerprint });
    expect(rebound.currentProcessGeneration).toBeGreaterThan(rebound.originProcessGeneration);
    expect(rebound.createdAt).toBe(0);
    value.setNow(Number.MAX_SAFE_INTEGER);
    const closed = value.store.closeAccountRateLimitReset(attempt.idempotencyKey, "weekly_window_changed");
    expect(closed).toMatchObject({ createdAt: 0, updatedAt: Number.MAX_SAFE_INTEGER });
    const before = value.snapshot();
    expect(value.store.latestAccountRateLimitResetAttempt(input.profileId, input.accountFingerprint)).toEqual(closed);
    expect(value.store.readRecoverableAccountRateLimitReset(input.profileId, input.accountFingerprint)).toBeNull();
    expect(value.snapshot()).toEqual(before);
  });

  const corruptions: readonly Readonly<{ name: string; original: Variant; patch: RowPatch }>[] = [
    { name: "current generation below origin", original: { state: "prepared" }, patch: { origin_process_generation: 2 } },
    { name: "update time below creation", original: { state: "prepared" }, patch: { updated_at: 999 } },
    ...(["prepared", "effect_started", "ambiguous", "retryable"] as const).flatMap((state) => [
      { name: `${state} with provider outcome`, original: { state }, patch: { outcome: "reset" as const } },
      { name: `${state} with local resolution`, original: { state }, patch: { local_resolution: "weekly_window_changed" as const } },
    ]),
    { name: "settled without provider outcome", original: { state: "settled", outcome: "reset" }, patch: { outcome: null } },
    { name: "settled with local resolution", original: { state: "settled", outcome: "reset" }, patch: { local_resolution: "account_identity_changed" } },
    { name: "closed without local resolution", original: { state: "closed", localResolution: "weekly_window_changed" }, patch: { local_resolution: null } },
    { name: "closed with provider outcome", original: { state: "closed", localResolution: "account_identity_changed" }, patch: { outcome: "reset" } },
  ];
  for (const corruption of corruptions) {
    test(`rejects ${corruption.name} in selected reads and prepare replay`, async () => {
      const value = await fixture();
      const { attempt, input } = value.create(corruption.original);
      value.patch(attempt, corruption.patch);
      expect(value.rawAttempt(attempt)).toMatchObject(corruption.patch);
      const before = value.snapshot();
      const operations = [
        () => value.store.latestAccountRateLimitResetAttempt(input.profileId, input.accountFingerprint),
        ...(corruption.original.state === "settled" || corruption.original.state === "closed" ? [] : [
          () => value.store.readRecoverableAccountRateLimitReset(input.profileId, input.accountFingerprint),
        ]),
        () => value.store.prepareAccountRateLimitReset(input),
      ];
      // Invoke every selected path before asserting so RED identifies both
      // unsafe reads and response-loss replay, rather than only its first read.
      const errors = operations.map((operation) => {
        try { operation(); return null; }
        catch (error: unknown) { return error instanceof Error ? error.message : "non-Error refusal"; }
      });
      expect(errors).toEqual(operations.map(() => invalidShape));
      expect(value.snapshot()).toEqual(before);
    });
  }

  test("distinguishes seeded legal and contradictory inequalities at the database reader boundary", async () => {
    const value = await fixture();
    const { attempt, input } = value.create();
    fc.assert(fc.property(
      fc.tuple(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER })),
      fc.tuple(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })),
      (generations, times) => {
        const origin = Math.min(...generations);
        const current = Math.max(...generations);
        const createdAt = Math.min(...times);
        const updatedAt = Math.max(...times);
        value.patch(attempt, { origin_process_generation: origin, current_process_generation: current,
          created_at: createdAt, updated_at: updatedAt });
        const before = value.snapshot();
        const expected = { ...attempt, originProcessGeneration: origin,
          currentProcessGeneration: current, createdAt, updatedAt };
        expect(value.store.latestAccountRateLimitResetAttempt(input.profileId, input.accountFingerprint)).toEqual(expected);
        expect(value.store.readRecoverableAccountRateLimitReset(input.profileId, input.accountFingerprint)).toEqual(expected);
        expect(value.snapshot()).toEqual(before);
        // These are isolated historical row-shape checks, not claims that the
        // synthetic generations have current provider dispatch authority.
        for (const invalid of [
          { origin_process_generation: current > origin ? current : 2,
            current_process_generation: current > origin ? origin : 1,
            created_at: createdAt, updated_at: updatedAt },
          { origin_process_generation: origin, current_process_generation: current,
            created_at: updatedAt > createdAt ? updatedAt : 1,
            updated_at: updatedAt > createdAt ? createdAt : 0 },
        ]) {
          value.patch(attempt, invalid);
          expect(value.rawAttempt(attempt)).toMatchObject(invalid);
          const invalidBefore = value.snapshot();
          expect(() => value.store.latestAccountRateLimitResetAttempt(input.profileId, input.accountFingerprint)).toThrow(invalidShape);
          expect(() => value.store.readRecoverableAccountRateLimitReset(input.profileId, input.accountFingerprint)).toThrow(invalidShape);
          expect(value.snapshot()).toEqual(invalidBefore);
        }
      },
    ), { seed: 68_701, numRuns: 32 });
  });
});
