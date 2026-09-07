import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  parseUsageDisplayV2,
  USAGE_DISPLAY_V2_CLAUDE_MAX_JSON_BYTES,
  USAGE_DISPLAY_V2_CODEX_MAX_JSON_BYTES,
  USAGE_DISPLAY_V2_MAX_JSON_BYTES,
} from "./usage-display-v2";

// Synthetic display facts, not provider evidence or permission to execute an
// action. Historical receipts deliberately need not describe retained pending.
const unavailable = (reason = "runtime_not_integrated") => ({ state: "unavailable", reason });
const advisory = (decision: unknown, evaluatedAt = 100) => ({ state: "advisory", evaluatedAt, decision });
const disabled = () => advisory({ action: "disabled", reason: "policy_disabled" });
const blocked = () => ({ state: "blocked", reason: "reset_outcome_unknown" });
const known = (policy: unknown = { state: "active" }, lastAttempt: unknown = null) => ({ state: "known", policy, lastAttempt });
const pending = (state = "prepared", identityRelation = "current", weeklyWindowResetsAt = 200) => ({
  state, weeklyWindowResetsAt, identityRelation,
});
const codex = (
  nextAction: unknown = unavailable(),
  retained: unknown = { state: "none" },
  currentIdentity: unknown = known(),
) => ({ provider: "codex", reset: { state: "cached", currentIdentity, pending: retained }, nextAction });
const claude = (nextAction: unknown = unavailable()) => ({
  provider: "claude", reset: unavailable("provider_unsupported"), nextAction,
});

function rawEqual(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
  }
  return value;
}

function replaceAt(input: unknown, path: readonly string[], replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  const record = input as Record<string, unknown>;
  const first = path[0] as string;
  return { ...record, [first]: replaceAt(record[first], path.slice(1), replacement) };
}

function objectPaths(value: unknown, prefix: readonly string[] = []): readonly (readonly string[])[] {
  if (value === null || typeof value !== "object") return [];
  return [prefix, ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...prefix, key]))];
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((parent, key) => (parent as Record<string, unknown>)[key], value);
}

function references(value: unknown, result = new Set<object>()): Set<object> {
  if (value !== null && typeof value === "object") {
    result.add(value);
    for (const child of Object.values(value)) references(child, result);
  }
  return result;
}

function assertCanonicalDetached(input: unknown): void {
  const candidate = reverseKeys(input);
  const before = JSON.stringify(candidate);
  const inputReferences = references(candidate);
  const parsed = parseUsageDisplayV2(candidate);
  expect(parsed).not.toBeNull();
  rawEqual(parsed, input);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
  expect(JSON.stringify(parseUsageDisplayV2(parsed))).toBe(JSON.stringify(input));
  expect(JSON.stringify(candidate)).toBe(before);
  for (const reference of inputReferences) expect(Object.isFrozen(reference)).toBe(false);
  for (const reference of references(parsed)) {
    expect(inputReferences.has(reference)).toBe(false);
    expect(Object.isFrozen(reference)).toBe(true);
  }
  const mutable = candidate as Record<string, unknown>;
  const reset = mutable.reset as Record<string, unknown>;
  reset.state = "caller_changed";
  mutable.provider = "caller_changed";
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
}

const codexDecisions = [
  { action: "disabled", reason: "policy_disabled" },
  ...["not_active_source", "source_unknown", "reset_pending"].map((reason) => ({ action: "observe_only", reason, recheckAt: null })),
  { action: "observe_only", reason: "source_stale", recheckAt: 101 },
  ...["invalid_input", "account_order_conflict", "source_conflict", "reached_type_conflict", "reset_gate_mismatch", "reset_reconciliation_required"]
    .map((reason) => ({ action: "reconciliation_required", reason })),
  { action: "continue", reason: "below_threshold" },
  { action: "reset", reason: "weekly_reset_eligible" },
  { action: "propose_pointer_move", reason: "next_available_account" },
  { action: "wait", reason: "no_fresh_target", recheckAt: 101 },
];
const claudeDecisions = [
  { action: "disabled", reason: "policy_disabled" },
  { action: "reconciliation_required", reason: "invalid_input" },
  ...["claude_native_fallback_armed", "claude_automation_unavailable"].map((reason) => ({ action: "observe_only", reason, recheckAt: null })),
];
const lastAttempts = [
  ...["prepared", "retry_pending", "recovery_pending"].map((state) => ({ state, weeklyWindowResetsAt: 1 })),
  ...["reset", "alreadyRedeemed", "nothingToReset", "noCredit"].map((outcome) => ({ state: "settled", outcome, weeklyWindowResetsAt: 1 })),
  ...["weekly_window_changed", "account_identity_changed"].map((reason) => ({ state: "closed", reason, weeklyWindowResetsAt: 1 })),
];
const policies = [
  { state: "active" }, { state: "reconciliation_required" }, { state: "window_suppressed", weeklyWindowResetsAt: 300 },
];

function validVariants(): unknown[] {
  return [
    ...codexDecisions.map((decision) => codex(advisory(structuredClone(decision)))),
    ...claudeDecisions.map((decision) => claude(advisory(structuredClone(decision)))),
    ...["runtime_not_integrated", "inputs_unavailable", "snapshot_conflict"]
      .flatMap((reason) => [codex(unavailable(reason)), claude(unavailable(reason))]),
    ...policies.map((policy) => codex(unavailable(), { state: "none" }, known(structuredClone(policy)))),
    ...lastAttempts.map((attempt) => codex(unavailable(), { state: "none" }, known({ state: "active" }, structuredClone(attempt)))),
    ...["prepared", "retry_pending"].flatMap((state) => [
      codex(disabled(), pending(state)),
      codex(disabled(), pending(state, "different")),
      codex(advisory({ action: "continue", reason: "below_threshold" }), pending(state)),
      codex(advisory({ action: "reconciliation_required", reason: "reset_reconciliation_required" }), pending(state, "different")),
      codex(unavailable(), pending(state, "unavailable"), unavailable("identity_unavailable")),
    ]),
    ...["current", "different"].map((relation) => codex(blocked(), pending("recovery_pending", relation))),
    codex(blocked(), pending("recovery_pending", "unavailable"), unavailable("identity_unavailable")),
    ...["current", "different", "unavailable"].flatMap((relation) => [
      codex(blocked(), pending("recovery_pending", relation), unavailable("snapshot_conflict")),
      codex(unavailable("snapshot_conflict"), pending("prepared", relation), unavailable("snapshot_conflict")),
    ]),
    codex(unavailable("snapshot_conflict"), unavailable("snapshot_conflict")),
    codex(unavailable("snapshot_conflict"), { state: "none" }, unavailable("snapshot_conflict")),
    codex(disabled(), { state: "none" }, unavailable("identity_unavailable")),
    { provider: "codex", reset: unavailable("snapshot_conflict"), nextAction: unavailable("snapshot_conflict") },
  ];
}

describe("usage display v2 standalone contract", () => {
  test("accepts every closed display branch with stable canonical keys and detached frozen output", () => {
    for (const input of validVariants()) assertCanonicalDetached(input);
    const input = codex(disabled());
    expect(JSON.stringify(parseUsageDisplayV2(input))).toBe(
      '{"provider":"codex","reset":{"state":"cached","currentIdentity":{"state":"known","policy":{"state":"active"},"lastAttempt":null},"pending":{"state":"none"}},"nextAction":{"state":"advisory","evaluatedAt":100,"decision":{"action":"disabled","reason":"policy_disabled"}}}',
    );
  });

  test("rejects missing and extra keys recursively rather than inventing defaults or accepting authority fields", () => {
    for (const input of validVariants()) {
      for (const path of objectPaths(input)) {
        const object = valueAt(input, path) as Record<string, unknown>;
        expect(parseUsageDisplayV2(replaceAt(input, path, { ...object, future: undefined }))).toBeNull();
        expect(parseUsageDisplayV2(replaceAt(input, path, { ...object, future: true }))).toBeNull();
        for (const key of Object.keys(object)) {
          const missing = Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
          expect(parseUsageDisplayV2(replaceAt(input, path, missing))).toBeNull();
          const original = object[key];
          if (original === null || typeof original !== "object") {
            const replacement = typeof original === "string" ? "unrecognized_variant" : "not_a_scalar";
            expect(parseUsageDisplayV2(replaceAt(input, [...path, key], replacement))).toBeNull();
            expect(parseUsageDisplayV2(replaceAt(input, [...path, key], []))).toBeNull();
          }
        }
      }
    }
    for (const key of ["accountId", "fingerprint", "idempotencyKey", "sourceRevision", "automaticPolicy", "targetAccountId"]) {
      expect(parseUsageDisplayV2({ ...codex(), [key]: "private" })).toBeNull();
    }
  });

  test("keeps known recovery blocked even without a readable current identity or policy", () => {
    for (const { currentIdentity, relations } of [
      { currentIdentity: known(), relations: ["current", "different"] },
      { currentIdentity: unavailable("identity_unavailable"), relations: ["unavailable"] },
      { currentIdentity: unavailable("snapshot_conflict"), relations: ["current", "different", "unavailable"] },
    ]) {
      for (const relation of relations) {
        const retained = pending("recovery_pending", relation);
        rawEqual(parseUsageDisplayV2(codex(blocked(), retained, currentIdentity)), codex(blocked(), retained, currentIdentity));
        for (const nextAction of [disabled(), unavailable(), unavailable("snapshot_conflict"), advisory({ action: "continue", reason: "below_threshold" })]) {
          expect(parseUsageDisplayV2(codex(nextAction, retained, currentIdentity))).toBeNull();
        }
      }
    }
    for (const retained of [{ state: "none" }, pending(), pending("retry_pending"), unavailable("snapshot_conflict")]) {
      expect(parseUsageDisplayV2(codex(blocked(), retained))).toBeNull();
    }
  });

  test("preserves unavailable pending and policy snapshots without disguising them as a usable evaluation", () => {
    const conflicts = [
      { provider: "codex", reset: unavailable("snapshot_conflict"), nextAction: unavailable("snapshot_conflict") },
      codex(unavailable("snapshot_conflict"), unavailable("snapshot_conflict")),
      codex(unavailable("snapshot_conflict"), { state: "none" }, unavailable("snapshot_conflict")),
    ];
    for (const input of conflicts) {
      expect(parseUsageDisplayV2(input)).not.toBeNull();
      for (const nextAction of [disabled(), unavailable(), unavailable("inputs_unavailable"), blocked()]) {
        expect(parseUsageDisplayV2({ ...input, nextAction })).toBeNull();
      }
    }
    for (const relation of ["current", "different"]) {
      expect(parseUsageDisplayV2(codex(unavailable(), pending("prepared", relation), unavailable("identity_unavailable")))).toBeNull();
      expect(parseUsageDisplayV2(codex(unavailable("snapshot_conflict"), pending("prepared", relation), unavailable("snapshot_conflict")))).not.toBeNull();
    }
    expect(parseUsageDisplayV2(codex(unavailable(), pending("prepared", "unavailable")))).toBeNull();
    for (const action of ["continue", "reset", "propose_pointer_move", "wait"]) {
      const decision = codexDecisions.find((row) => row.action === action);
      expect(parseUsageDisplayV2(codex(advisory(decision), { state: "none" }, unavailable("identity_unavailable")))).toBeNull();
    }
  });

  test("current prepared or retryable permits continue before the gate but not a new reset, move or wait", () => {
    for (const state of ["prepared", "retry_pending"]) {
      for (const decision of codexDecisions) {
        const input = codex(advisory(decision), pending(state));
        if (["reset", "propose_pointer_move", "wait"].includes(decision.action)) expect(parseUsageDisplayV2(input)).toBeNull();
        else expect(parseUsageDisplayV2(input)).not.toBeNull();
      }
    }
  });

  test("different-identity prepared or retryable keeps its warning beside off or reset reconciliation only", () => {
    for (const state of ["prepared", "retry_pending"]) {
      for (const decision of codexDecisions) {
        const input = codex(advisory(decision), pending(state, "different"));
        const allowed = decision.action === "disabled"
          || (decision.action === "reconciliation_required" && decision.reason === "reset_reconciliation_required");
        if (allowed) expect(parseUsageDisplayV2(input)).not.toBeNull();
        else expect(parseUsageDisplayV2(input)).toBeNull();
      }
      for (const reason of ["runtime_not_integrated", "inputs_unavailable", "snapshot_conflict"]) {
        expect(parseUsageDisplayV2(codex(unavailable(reason), pending(state, "different")))).not.toBeNull();
      }
    }
  });

  test("does not equate historical current-identity receipts or policy windows with independently retained pending", () => {
    for (const policy of policies) for (const lastAttempt of lastAttempts) {
      for (const retained of [{ state: "none" }, pending("prepared", "current", 700), pending("retry_pending", "different", 900)]) {
        const input = codex(unavailable(), retained, known(policy, lastAttempt));
        rawEqual(parseUsageDisplayV2(input), input);
      }
    }
    // A historical recovery receipt alone is not proof that an effect remains
    // uncertain now; only the independently read pending branch can block.
    expect(parseUsageDisplayV2(codex(disabled(), { state: "none" }, known({ state: "active" }, lastAttempts[2])))).not.toBeNull();
  });

  test("rejects cross-provider, unreachable and unknown decision or reset variants", () => {
    for (const decision of codexDecisions.filter((row) => !claudeDecisions.some((other) => JSON.stringify(other) === JSON.stringify(row)))) {
      expect(parseUsageDisplayV2(claude(advisory(decision)))).toBeNull();
    }
    for (const decision of claudeDecisions.filter((row) => row.action === "observe_only")) {
      expect(parseUsageDisplayV2(codex(advisory(decision)))).toBeNull();
    }
    for (const input of [
      { ...codex(), provider: "devin" }, { ...claude(), reset: codex().reset }, claude(blocked()),
      codex(advisory({ action: "observe_only", reason: "no_target", recheckAt: null })),
      codex(unavailable("not_evaluated")), codex(unavailable("provider_unsupported")),
      codex(advisory({ action: "move_pointer", reason: "next_available_account" })),
      codex(unavailable(), { state: "invalid_state" }),
      codex(unavailable(), pending("ambiguous")), codex(unavailable(), pending("retryable")),
      codex(unavailable(), { state: "none" }, known({ state: "active_unbound" })),
    ]) expect(parseUsageDisplayV2(input)).toBeNull();
  });

  test("bounds every timestamp and requires only the declared future recheck relationship", () => {
    const base = codex(advisory({ action: "observe_only", reason: "source_stale", recheckAt: 101 }), pending(),
      known({ state: "window_suppressed", weeklyWindowResetsAt: 1 }, { state: "settled", outcome: "reset", weeklyWindowResetsAt: 0 }));
    const paths = [
      ["reset", "currentIdentity", "policy", "weeklyWindowResetsAt"],
      ["reset", "currentIdentity", "lastAttempt", "weeklyWindowResetsAt"],
      ["reset", "pending", "weeklyWindowResetsAt"], ["nextAction", "evaluatedAt"],
    ];
    for (const path of paths) {
      for (const value of [null, undefined, "100", true, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(parseUsageDisplayV2(replaceAt(base, path, value))).toBeNull();
      }
      for (const value of [0, Number.MAX_SAFE_INTEGER]) {
        const input = replaceAt(codex(disabled(), pending(), known({ state: "window_suppressed", weeklyWindowResetsAt: 1 },
          { state: "settled", outcome: "reset", weeklyWindowResetsAt: 0 })), path, value);
        expect(parseUsageDisplayV2(input)).not.toBeNull();
      }
    }
    for (const action of ["source_stale", "wait"]) {
      for (const recheckAt of [null, undefined, 0, 99, 100, 100.5, Number.MAX_SAFE_INTEGER + 1]) {
        const decision = action === "wait" ? { action, reason: "no_fresh_target", recheckAt }
          : { action: "observe_only", reason: action, recheckAt };
        expect(parseUsageDisplayV2(codex(advisory(decision)))).toBeNull();
      }
      for (const recheckAt of [101, Number.MAX_SAFE_INTEGER]) {
        const decision = action === "wait" ? { action, reason: "no_fresh_target", recheckAt }
          : { action: "observe_only", reason: action, recheckAt };
        expect(parseUsageDisplayV2(codex(advisory(decision)))).not.toBeNull();
      }
    }
    for (const decision of [...codexDecisions, ...claudeDecisions].filter((row) => row.action === "observe_only" && row.reason !== "source_stale")) {
      const input = decision.reason.startsWith("claude_") ? claude(advisory({ ...decision, recheckAt: 101 })) : codex(advisory({ ...decision, recheckAt: 101 }));
      expect(parseUsageDisplayV2(input)).toBeNull();
    }
  });

  test("foreign graphs are rejected without evaluating getters or coercion hooks", () => {
    let calls = 0;
    const accessed = codex();
    Object.defineProperty(accessed.reset, "currentIdentity", { enumerable: true, get() { calls += 1; throw new Error("private getter"); } });
    const symbolKeyed = { ...codex(), [Symbol("private")]: true };
    const nonEnumerable = codex();
    Object.defineProperty(nonEnumerable.reset, "private", { value: true, enumerable: false });
    const cycle: Record<string, unknown> = codex();
    cycle.loop = cycle;
    // These three independent records form an accepted conflict display. The
    // shared-reference version has the same JSON values but is not a JSON tree.
    const shared = unavailable("snapshot_conflict");
    const alias = codex(shared, shared, shared);
    expect(parseUsageDisplayV2(JSON.parse(JSON.stringify(alias)) as unknown)).not.toBeNull();
    const sparse: unknown[] = [];
    sparse.length = 1;
    const throwing = new Proxy({}, { ownKeys() { throw new Error("private proxy"); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const nullPrototype: unknown = Object.assign(Object.create(null) as Record<string, unknown>, codex());
    for (const input of [undefined, null, true, 1, "codex", 1n, Symbol("private"), () => 1,
      [], sparse, new Date(), new Map(), accessed, symbolKeyed, nonEnumerable, cycle,
      alias, throwing, revoked.proxy,
      Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, codex()),
      { ...codex(), toJSON() { calls += 1; throw new Error("private coercion"); } },
    ]) expect(parseUsageDisplayV2(input)).toBeNull();
    // The shared foreign-JSON boundary admits plain null-prototype records;
    // they still become newly allocated ordinary canonical output objects.
    const parsedNullPrototype = parseUsageDisplayV2(nullPrototype);
    rawEqual(parsedNullPrototype, codex());
    expect(parsedNullPrototype).not.toBe(nullPrototype);
    expect(Object.isFrozen(nullPrototype)).toBe(false);
    expect(calls).toBe(0);
  });

  test("symbolic provider ceilings bound the display block without asserting an impossible combined maximum", () => {
    const time = Number.MAX_SAFE_INTEGER;
    const policy = { state: "window_suppressed", weeklyWindowResetsAt: time };
    const attempt = { state: "closed", reason: "account_identity_changed", weeklyWindowResetsAt: time };
    const currentIdentity = known(policy, attempt);
    const retained = pending("recovery_pending", "unavailable", time);
    const reset = { state: "cached", currentIdentity, pending: retained };
    const decision = { action: "observe_only", reason: "source_stale", recheckAt: time };
    const nextAction = advisory(decision, time);
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect([policy, attempt, currentIdentity, retained, reset, decision, nextAction].map(bytes)).toEqual([69, 94, 205, 101, 354, 78, 141]);
    // Branchwise maxima are intentionally incompatible: current identity is
    // known, pending relation is unavailable, recovery is not blocked, and the
    // recheck equals evaluation. This is arithmetic, not an accepted witness.
    const symbolic = { provider: "codex", reset, nextAction };
    expect(bytes(symbolic)).toBe(538);
    expect(parseUsageDisplayV2(symbolic)).toBeNull();
    expect(USAGE_DISPLAY_V2_CODEX_MAX_JSON_BYTES).toBe(538);
    expect(USAGE_DISPLAY_V2_CLAUDE_MAX_JSON_BYTES).toBe(245);
    expect(USAGE_DISPLAY_V2_MAX_JSON_BYTES).toBe(538);
    const wide = [
      codex(advisory({ action: "observe_only", reason: "source_stale", recheckAt: time }, time - 1), pending("prepared", "current", time), known(policy, attempt)),
      codex(blocked(), pending("recovery_pending", "different", time), known(policy, attempt)),
      claude(advisory({ action: "observe_only", reason: "claude_automation_unavailable", recheckAt: null }, time)),
    ];
    for (const input of wide) {
      const parsed = parseUsageDisplayV2(input);
      expect(parsed).not.toBeNull();
      expect(bytes(parsed)).toBeLessThanOrEqual(input.provider === "codex" ? 538 : 245);
    }
  });

  test("seeded foreign-value totality permits valid generated values without assuming every arbitrary is invalid", () => {
    const foreign = fc.oneof(fc.jsonValue(), fc.constant(undefined), fc.constant(NaN), fc.constant(Infinity), fc.bigInt());
    fc.assert(fc.property(foreign, (input) => {
      const parsed = parseUsageDisplayV2(input);
      if (parsed !== null) {
        expect(parseUsageDisplayV2(parsed)).toEqual(parsed);
        for (const reference of references(parsed)) expect(Object.isFrozen(reference)).toBe(true);
      }
    }), { numRuns: 150, seed: 68_201 });
  });

  test("seeded accepted variants retain canonical ordering, historical independence and deep detached freezing", () => {
    const variants = validVariants();
    const arbitrary = fc.record({
      index: fc.integer({ min: 0, max: variants.length - 1 }),
      time: fc.integer({ min: 0, max: 1_000_000 }),
      delta: fc.integer({ min: 1, max: 1_000_000 }),
    });
    fc.assert(fc.property(arbitrary, ({ index, time, delta }) => {
      function changeTimes(value: unknown): unknown {
        if (value === null || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
          key === "evaluatedAt" ? time : key === "weeklyWindowResetsAt" ? delta
            : key === "recheckAt" && child !== null ? time + delta : changeTimes(child)]));
      }
      const input = changeTimes(variants[index]);
      assertCanonicalDetached(input);
      const parsed = parseUsageDisplayV2(input);
      const cap = parsed?.provider === "claude" ? 245 : 538;
      expect(new TextEncoder().encode(JSON.stringify(parsed)).byteLength).toBeLessThanOrEqual(cap);
    }), { numRuns: 150, seed: 68_202 });
  });

  test("bundles the display parser for browsers in memory with no native or execution dependencies", async () => {
    const build = await Bun.build({ entrypoints: [`${import.meta.dir}/usage-display-v2.ts`], target: "browser" });
    expect(build.success).toBe(true);
    expect(build.logs).toEqual([]);
    expect(build.outputs).toHaveLength(1);
    const output = await build.outputs[0]?.text();
    expect(output).toContain("parseUsageDisplayV2");
    expect(output).not.toMatch(/(?:node:|bun:sqlite|StateStore|randomUUID|createHash)/u);
  });
});
