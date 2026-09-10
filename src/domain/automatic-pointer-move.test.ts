import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  AUTOMATIC_POINTER_MOVE_CAPSULE_MAX_BYTES,
  AutomaticPointerMoveCapsuleError,
  automaticPointerMoveCapsuleDigest,
  automaticPointerMoveRequestDigest,
  createAutomaticPointerMoveCapsule,
  verifyAutomaticPointerMoveCapsule,
  type AutomaticPointerMoveAccount,
  type AutomaticPointerMoveCapsule,
  type AutomaticPointerMoveCapsuleInput,
} from "./automatic-pointer-move";
import { computedProviderUsageComponentDigest, providerUsageDigest, type CodexQuotaUsage } from "./provider-usage";
import { CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES } from "./usage-metrics";
import { initialAutomaticUsagePolicyConfiguration } from "./usage-policy";
import { utf8Bytes } from "./values";

const now = 1_800_000_000_000;
const boundary = now + 3_600_000;
const id = (value: number) => `acct_${value.toString(16).padStart(32, "0")}`;
const hex = "a".repeat(64);
const limit = (usedPercent: number): CodexQuotaUsage["limits"][number] => ({
  id: "legacy:primary", limitId: null, limitName: null, planType: null, rateLimitReachedType: null,
  primary: { usedPercent, windowDurationMins: CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES, resetsAtMs: boundary }, secondary: null,
});
function account(value: number, usedPercent = 20, limits = [limit(usedPercent)], credits = 0): AutomaticPointerMoveAccount {
  const authority = { provider: "codex" as const, providerAccountId: id(value), profileId: id(value), bindingGeneration: 2, processGeneration: 3 };
  const unsigned = {
    version: 2 as const, component: "quota" as const, source: "codex_app_server" as const, turn: null,
    authority, observationRevision: 12, idempotencyKey: hex, sourceEventDigest: hex, observedAt: now, receivedAt: now,
    quota: { format: "codex_v1" as const, resetCreditsAvailable: credits, limits },
  };
  return { authority, readiness: "signed_in", authorityMode: "mutation_authoritative",
    quota: { kind: "observed", component: { ...unsigned, componentDigest: providerUsageDigest(unsigned) } } };
}
function input(accounts = [account(1, 99), account(2)]): AutomaticPointerMoveCapsuleInput {
  const source = accounts[0];
  if (source === undefined || source.quota.kind !== "observed") throw new Error("Missing test source.");
  return {
    request: {
      idempotencyKey: "00000000-0000-4000-8000-000000000001", provider: "codex", daemonGeneration: 3, bootId: `boot_${"a".repeat(32)}`,
      expectedSourceAuthority: source.authority, expectedSourceQuotaObservationRevision: 12,
      expectedSourceQuotaComponentDigest: source.quota.component.componentDigest,
      expectedResetPolicyRevision: 7, expectedAutomaticPolicyRevision: 1, expectedOrderRevision: 3, expectedPointerRevision: 5,
    },
    moveId: "b".repeat(40), evaluatedAt: now, settledAt: now,
    configuration: initialAutomaticUsagePolicyConfiguration(), orderRevision: 3, pointerRevision: 5,
    activeProviderAccountId: source.authority.providerAccountId,
    order: accounts.map((entry) => entry.authority.providerAccountId), accounts,
    resetProof: { kind: "not_eligible", sourceAccountFingerprint: hex,
      policy: { profileId: source.authority.profileId, state: "active_unbound", accountFingerprint: null,
        weeklyWindowResetsAt: null, revision: 7, createdAt: now - 1, updatedAt: now - 1 },
      unresolvedAttemptCount: 0, sameWindowTerminalAttempt: null,
      gate: { authority: source.authority, quotaObservationRevision: 12, resetPolicyRevision: 7,
        resetBoundary: boundary, state: "not_eligible", reason: "credits_unavailable" },
    },
  };
}
function created(value: unknown) {
  const result = createAutomaticPointerMoveCapsule(value);
  if (result.status !== "created") throw new Error(`Expected capsule: ${result.reason}`);
  return result;
}
function editedAccount(original: AutomaticPointerMoveAccount, edit: (component: NonNullable<Extract<AutomaticPointerMoveAccount["quota"], { kind: "observed" }>["component"]>) => void): AutomaticPointerMoveAccount {
  const clone = structuredClone(original);
  if (clone.quota.kind !== "observed") throw new Error("Missing test component.");
  edit(clone.quota.component);
  clone.quota.component.componentDigest = computedProviderUsageComponentDigest(clone.quota.component);
  return clone;
}

describe("automatic pointer move decision capsule", () => {
  test("freezes a deterministic first-available move and verifies without mutable heads", () => {
    const value = input([account(1, 99), account(2, 100), account(3), account(4)]);
    const first = created(value);
    expect(first.capsule.move.target.authority.providerAccountId).toBe(id(3));
    expect(first.capsule.move.toPointerRevision).toBe(6);
    expect(first.utf8Bytes).toBe(utf8Bytes(first.canonicalJson));
    expect(first.digest).toBe(automaticPointerMoveCapsuleDigest(first.capsule));
    expect(created(value)).toEqual(first);
    // JSON alone is sufficient for historical consistency; DB seal verification
    // remains a separate storage obligation and is not asserted by this test.
    value.accounts.splice(0);
    value.configuration.defaultEnabled = false;
    expect(verifyAutomaticPointerMoveCapsule(JSON.parse(first.canonicalJson) as unknown)).toEqual(first.capsule);
  });

  test("keeps exact ordered membership and rejects a later target presented as first", () => {
    const result = created(input([account(1, 99), account(2), account(3)]));
    const forged = structuredClone(result.capsule);
    forged.move.target.authority = account(3).authority;
    expect(() => verifyAutomaticPointerMoveCapsule(forged)).toThrow(AutomaticPointerMoveCapsuleError);
    const reordered = input([account(1, 99), account(3), account(2)]);
    expect(created(reordered).capsule.move.target.authority.providerAccountId).toBe(id(3));
    reordered.order.reverse();
    expect(createAutomaticPointerMoveCapsule(reordered)).toEqual({ status: "refused", reason: "invalid_input" });
    expect(createAutomaticPointerMoveCapsule(input([account(1, 99), account(2), account(2)]))).toMatchObject({ status: "refused" });
  });

  test("explicit absence and bounded refusal remain unselectable without retaining foreign quota", () => {
    const absent = { ...account(2), quota: { kind: "absent" as const } };
    const refused = { ...account(3), quota: { kind: "refused" as const, reason: "invalid_quota" as const, sourceRevision: 11, sourceDigest: hex } };
    const result = created(input([account(1, 99), absent, refused, account(4)]));
    expect(result.capsule.move.target.authority.providerAccountId).toBe(id(4));
    for (const quota of [null, { private: "do not persist", nested: { unknown: true } }, { ...refused.quota, raw: "do not persist" }]) {
      const candidate = { ...absent, quota };
      expect(createAutomaticPointerMoveCapsule({ ...input(), accounts: [account(1, 99), candidate] })).toEqual({ status: "refused", reason: "invalid_input" });
    }
  });

  test("rejects accounting, foreign providers, component digest tampering and extra receipt fields", () => {
    const original = created(input()).capsule;
    const edits: ((value: AutomaticPointerMoveCapsule) => unknown)[] = [
      (value) => ({ ...value, rawInput: "private" }),
      (value) => ({ ...value, request: { ...value.request, provider: "claude" } }),
      (value) => ({ ...value, accounts: value.accounts.map((entry) => ({ ...entry, accounting: {} })) }),
      (value) => ({ ...value, accounts: value.accounts.map((entry) => ({ ...entry, authority: { ...entry.authority, provider: "devin" } })) }),
      (value) => ({ ...value, accounts: value.accounts.map((entry) => ({ ...entry, quota: { kind: "observed", component: { component: "accounting" } } })) }),
    ];
    for (const edit of edits) expect(() => verifyAutomaticPointerMoveCapsule(edit(original))).toThrow(AutomaticPointerMoveCapsuleError);
    const corrupted = structuredClone(original);
    const target = corrupted.accounts[1];
    if (target?.quota.kind !== "observed") throw new Error("Missing test target.");
    target.quota.component.componentDigest = "0".repeat(64);
    expect(() => verifyAutomaticPointerMoveCapsule(corrupted)).toThrow(AutomaticPointerMoveCapsuleError);
  });

  test("binds request fingerprints to every authority, observation and revision fence", () => {
    const request = input().request;
    const original = automaticPointerMoveRequestDigest(request);
    const changes = [
      { daemonGeneration: 4 }, { bootId: `boot_${"b".repeat(32)}` },
      { expectedSourceAuthority: { ...request.expectedSourceAuthority, processGeneration: 4 } },
      { expectedSourceQuotaObservationRevision: 13 }, { expectedSourceQuotaComponentDigest: "b".repeat(64) },
      { expectedResetPolicyRevision: 8 }, { expectedAutomaticPolicyRevision: 2 }, { expectedOrderRevision: 4 }, { expectedPointerRevision: 6 },
    ];
    for (const change of changes) expect(automaticPointerMoveRequestDigest({ ...request, ...change })).not.toBe(original);
    expect(automaticPointerMoveRequestDigest({ ...request, idempotencyKey: "00000000-0000-4000-8000-000000000002" })).toBe(original);
    const one = created(input());
    const two = created({ ...input(), request: { ...request, idempotencyKey: "00000000-0000-4000-8000-000000000002" } });
    expect(one.digest).not.toBe(two.digest);
  });

  test("rejects changed or non-active source callbacks and request/capsule fence disagreement", () => {
    const value = input();
    for (const change of [
      { expectedSourceAuthority: account(2).authority },
      { expectedSourceAuthority: { ...value.request.expectedSourceAuthority, bindingGeneration: 3 } },
      { expectedSourceQuotaObservationRevision: 13 }, { expectedSourceQuotaComponentDigest: "b".repeat(64) },
      { expectedResetPolicyRevision: 8 }, { expectedAutomaticPolicyRevision: 2 }, { expectedOrderRevision: 4 }, { expectedPointerRevision: 6 },
    ]) expect(createAutomaticPointerMoveCapsule({ ...value, request: { ...value.request, ...change } })).toMatchObject({ status: "refused" });
    expect(createAutomaticPointerMoveCapsule({ ...value, request: { ...value.request, daemonGeneration: 0 } })).toMatchObject({ status: "refused" });
    expect(createAutomaticPointerMoveCapsule({ ...value, request: { ...value.request, bootId: "unproved" } })).toMatchObject({ status: "refused" });
  });

  test("uses exact keyed Codex weekly selection rather than the exhausted legacy bucket", () => {
    const source = account(1, 100, [limit(100), { ...limit(20), id: "limit:codex", limitId: "codex",
      secondary: { usedPercent: 99, windowDurationMins: 60, resetsAtMs: boundary } }], 1);
    const value = input([source, account(2)]);
    value.resetProof.gate = { ...value.resetProof.gate, state: "not_eligible", reason: "below_threshold" };
    expect(created(value).capsule.move.target.authority.providerAccountId).toBe(id(2));
    const eligible = input([account(1, 100, [limit(100)], 1), account(2)]);
    expect(createAutomaticPointerMoveCapsule(eligible)).toEqual({ status: "refused", reason: "reset_proof_invalid" });
    const withoutExact = input([account(1, 100, [limit(100), { ...limit(10), id: "limit:other", limitId: "other" }]), account(2)]);
    withoutExact.resetProof.gate = { ...withoutExact.resetProof.gate, state: "not_eligible", resetBoundary: null, reason: "weekly_window_unavailable" };
    expect(createAutomaticPointerMoveCapsule(withoutExact)).toMatchObject({ status: "refused" });
  });

  test("admits absent weekly capacity only when exact short-window exhaustion still proves movement", () => {
    const source = account(1, 99, [{ ...limit(99), primary: { usedPercent: 99, windowDurationMins: 60, resetsAtMs: boundary } }]);
    const value = input([source, account(2)]);
    value.resetProof.gate = { ...value.resetProof.gate, state: "not_eligible", resetBoundary: null, reason: "weekly_window_unavailable" };
    expect(created(value).capsule.move.target.authority.providerAccountId).toBe(id(2));
    value.resetProof.policy = { ...value.resetProof.policy, state: "active_bound", accountFingerprint: hex, weeklyWindowResetsAt: boundary };
    expect(createAutomaticPointerMoveCapsule(value)).toEqual({ status: "refused", reason: "reset_proof_invalid" });
  });

  test("does not invent reset settlement, identity or policy proof", () => {
    const original = input();
    const valid = structuredClone(original);
    valid.resetProof.policy = { ...valid.resetProof.policy, state: "active_bound", accountFingerprint: hex, weeklyWindowResetsAt: boundary };
    expect(created(valid).capsule.resetProof).toEqual(valid.resetProof);
    const invalid = [
      { ...original.resetProof, unresolvedAttemptCount: 1 },
      { ...original.resetProof, sameWindowTerminalAttempt: { outcome: "reset" } },
      { ...original.resetProof, kind: "settled" },
      ...["reconciliation_required", "window_suppressed"].map((state) => ({ ...original.resetProof, policy: { ...original.resetProof.policy, state } })),
      { ...valid.resetProof, sourceAccountFingerprint: "b".repeat(64) },
      { ...valid.resetProof, policy: { ...valid.resetProof.policy, weeklyWindowResetsAt: boundary + 1 } },
      { ...valid.resetProof, policy: { ...valid.resetProof.policy, profileId: id(2) } },
      { ...valid.resetProof, policy: { ...valid.resetProof.policy, updatedAt: now + 1 } },
      { ...original.resetProof, gate: { ...original.resetProof.gate, quotaObservationRevision: 13 } },
      { ...original.resetProof, gate: { ...original.resetProof.gate, resetBoundary: boundary + 1 } },
    ];
    for (const resetProof of invalid) expect(createAutomaticPointerMoveCapsule({ ...original, resetProof })).toMatchObject({ status: "refused" });
  });

  test("rejects fractional protocol reset seconds without rounding canonical milliseconds", () => {
    const source = account(1, 99, [{ ...limit(99), primary: { usedPercent: 99, windowDurationMins: 10_080, resetsAtMs: boundary + 1 } }]);
    const value = input([source, account(2)]);
    value.resetProof.gate = { ...value.resetProof.gate, resetBoundary: boundary + 1 };
    expect(createAutomaticPointerMoveCapsule(value)).toEqual({ status: "refused", reason: "reset_proof_invalid" });
  });

  test("expires exact source/target evidence at settlement and rejects target generation zero", () => {
    expect(createAutomaticPointerMoveCapsule({ ...input(), settledAt: now - 1 })).toMatchObject({ status: "refused" });
    expect(created({ ...input(), settledAt: now + 90_000 }).capsule.move.settledAt).toBe(now + 90_000);
    expect(createAutomaticPointerMoveCapsule({ ...input(), settledAt: now + 90_001 })).toMatchObject({ status: "refused" });
    expect(createAutomaticPointerMoveCapsule({ ...input(), evaluatedAt: boundary, settledAt: boundary })).toMatchObject({ status: "refused" });
    const future = editedAccount(account(2), (component) => { component.receivedAt = now + 1; });
    expect(createAutomaticPointerMoveCapsule(input([account(1, 99), future]))).toMatchObject({ status: "refused" });
    const stale = editedAccount(account(2), (component) => { component.receivedAt = now - 90_001; });
    expect(createAutomaticPointerMoveCapsule(input([account(1, 99), stale]))).toMatchObject({ status: "refused" });
    const zero = editedAccount(account(2), (component) => { component.authority.processGeneration = 0; });
    zero.authority.processGeneration = 0;
    expect(createAutomaticPointerMoveCapsule(input([account(1, 99), zero]))).toMatchObject({ status: "refused" });
  });

  test("disabled, available-source and no-target decisions never manufacture a move", () => {
    expect(createAutomaticPointerMoveCapsule({ ...input(), configuration: { ...initialAutomaticUsagePolicyConfiguration(), defaultEnabled: false } })).toEqual({ status: "refused", reason: "decision_not_move" });
    expect(createAutomaticPointerMoveCapsule(input([account(1, 20), account(2)]))).toEqual({ status: "refused", reason: "decision_not_move" });
    expect(createAutomaticPointerMoveCapsule(input([account(1, 99), account(2, 99)]))).toEqual({ status: "refused", reason: "decision_not_move" });
  });

  test("admits 1000 accounts but refuses count overflow without truncating candidates", () => {
    const accounts = [account(1, 99), ...Array.from({ length: 999 }, (_, index) => ({ ...account(index + 2), quota: { kind: "absent" as const } }))];
    accounts[999] = account(1000);
    expect(created(input(accounts)).capsule.move.target.authority.providerAccountId).toBe(id(1000));
    expect(createAutomaticPointerMoveCapsule(input([...accounts, account(1001)]))).toEqual({ status: "refused", reason: "invalid_input" });
  });

  test("caps complete serialized UTF-8 bytes, not characters or per-account array counts", () => {
    const limits = [limit(100), ...Array.from({ length: 100 }, (_, index) => ({ ...limit(100), id: `limit:${index}`, limitId: `${index}`,
      limitName: "界".repeat(256), planType: "界".repeat(128), rateLimitReachedType: "界".repeat(128) }))];
    const accounts = [account(1, 99), account(2), ...Array.from({ length: 32 }, (_, index) => account(index + 3, 100, limits))];
    const value = input(accounts);
    const serialized = JSON.stringify(value);
    expect(serialized.length).toBeLessThan(AUTOMATIC_POINTER_MOVE_CAPSULE_MAX_BYTES);
    expect(utf8Bytes(serialized)).toBeGreaterThan(AUTOMATIC_POINTER_MOVE_CAPSULE_MAX_BYTES);
    expect(createAutomaticPointerMoveCapsule(value)).toEqual({ status: "refused", reason: "evidence_overflow" });
  });

  test("parser is total over bounded foreign JSON and no rejection reflects raw input", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const result = createAutomaticPointerMoveCapsule(value);
      expect(result).toMatchObject({ status: "refused" });
      expect(Object.keys(result).sort()).toEqual(["reason", "status"]);
    }), { numRuns: 100 });
  });
});
