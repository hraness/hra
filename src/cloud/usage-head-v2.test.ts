import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { PROVIDER_ACCOUNT_LIST_MAX_COUNT } from "../domain/provider-account-list";
import { AUTOMATIC_USAGE_ACCOUNT_LIMIT } from "../domain/usage-policy";
import {
  USAGE_COMPONENTS_V2_CLAUDE_MAX_JSON_BYTES,
  USAGE_COMPONENTS_V2_CODEX_MAX_JSON_BYTES,
} from "./usage-components-v2";
import {
  USAGE_DISPLAY_V2_CLAUDE_MAX_JSON_BYTES,
  USAGE_DISPLAY_V2_CODEX_MAX_JSON_BYTES,
} from "./usage-display-v2";
import {
  parseUsageHeadV2,
  USAGE_HEAD_V2_CLAUDE_MAX_JSON_BYTES,
  USAGE_HEAD_V2_CODEX_MAX_JSON_BYTES,
  USAGE_HEAD_V2_MAX_JSON_BYTES,
} from "./usage-head-v2";

// Synthetic public heads, not encrypted envelopes, authenticated identities,
// coherent store snapshots or proof that a reducer/provider actually ran.
type Provider = "codex" | "claude";
const unavailable = (reason = "runtime_not_integrated") => ({ state: "unavailable", reason });
const policy = (defaultEnabled = true, override = "inherit") => ({ state: "configured", revision: 1, defaultEnabled, override });
const advisory = (decision: unknown, evaluatedAt = 100) => ({ state: "advisory", evaluatedAt, decision });
const invalidInput = () => advisory({ action: "reconciliation_required", reason: "invalid_input" });
const disabled = () => advisory({ action: "disabled", reason: "policy_disabled" });
const order = (accountCount = 2, active = true, orderPosition = 1) => ({
  state: "cached", orderRevision: 1, pointerRevision: 1, orderPosition, accountCount, active,
});
const context = (provider: Provider = "codex") => ({
  apiOrigin: "https://example.com", userPublicId: "user_12345678", sourceDevicePublicId: "device_12345678",
  provider, sourcePublicId: `usrc2_${"a".repeat(64)}`, sourceRevision: 1, keyVersion: 1,
});
const components = (provider: Provider) => ({
  provider, quota: unavailable("not_observed"),
  accounting: unavailable(provider === "codex" ? "not_projected" : "not_observed"),
  readiness: { state: "cached", value: "signed_in", observedAt: null }, automaticPolicy: policy(),
});
const display = (provider: Provider, nextAction: unknown = unavailable()) => ({
  provider,
  reset: provider === "codex" ? {
    state: "cached", currentIdentity: { state: "known", policy: { state: "active" }, lastAttempt: null },
    pending: { state: "none" },
  } : unavailable("provider_unsupported"),
  nextAction,
});
function head(provider: Provider = "codex", nextAction: unknown = unavailable()) {
  const expected = context(provider);
  return {
    version: 2, userPublicId: expected.userPublicId, sourceDevicePublicId: expected.sourceDevicePublicId,
    provider, sourcePublicId: expected.sourcePublicId, sourceRevision: expected.sourceRevision,
    keyVersion: expected.keyVersion, codexAccountMatchPublicId: null,
    order: order(), components: components(provider), display: display(provider, nextAction),
  };
}
function rawEqual(actual: unknown, expected: unknown): void { expect(actual).toEqual(expected); }
function replaceAt(input: unknown, path: readonly string[], replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  const record = input as Record<string, unknown>;
  const key = path[0] as string;
  return { ...record, [key]: replaceAt(record[key], path.slice(1), replacement) };
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
  }
  return value;
}
function references(value: unknown, result = new Set<object>()): Set<object> {
  if (value !== null && typeof value === "object") {
    result.add(value);
    for (const child of Object.values(value)) references(child, result);
  }
  return result;
}
function assertDetached(input: unknown, expectedContext: unknown): void {
  const candidate = reverseKeys(input);
  const candidateContext = reverseKeys(expectedContext);
  const before = JSON.stringify(candidate);
  const beforeContext = JSON.stringify(candidateContext);
  const inputReferences = references(candidate);
  const parsed = parseUsageHeadV2(candidate, candidateContext);
  expect(parsed).not.toBeNull();
  rawEqual(parsed, input);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
  expect(JSON.stringify(parseUsageHeadV2(parsed, candidateContext))).toBe(JSON.stringify(input));
  expect(JSON.stringify(candidate)).toBe(before);
  expect(JSON.stringify(candidateContext)).toBe(beforeContext);
  for (const reference of inputReferences) expect(Object.isFrozen(reference)).toBe(false);
  expect(Object.isFrozen(candidateContext)).toBe(false);
  for (const reference of references(parsed)) {
    expect(Object.isFrozen(reference)).toBe(true);
    expect(inputReferences.has(reference)).toBe(false);
    expect(reference).not.toBe(candidateContext);
  }
  const mutable = candidate as Record<string, unknown>;
  (mutable.order as Record<string, unknown>).state = "caller_changed";
  ((mutable.components as Record<string, unknown>).readiness as Record<string, unknown>).state = "caller_changed";
  mutable.sourceRevision = 123_456;
  (candidateContext as Record<string, unknown>).sourceRevision = 654_321;
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
}
const codexDecisions = [
  { action: "disabled", reason: "policy_disabled" },
  ...["not_active_source", "source_unknown", "reset_pending"].map((reason) => ({ action: "observe_only", reason, recheckAt: null })),
  { action: "observe_only", reason: "source_stale", recheckAt: 101 },
  ...["invalid_input", "account_order_conflict", "source_conflict", "reached_type_conflict", "reset_gate_mismatch", "reset_reconciliation_required"]
    .map((reason) => ({ action: "reconciliation_required", reason })),
  { action: "continue", reason: "below_threshold" }, { action: "reset", reason: "weekly_reset_eligible" },
  { action: "propose_pointer_move", reason: "next_available_account" },
  { action: "wait", reason: "no_fresh_target", recheckAt: 101 },
];
const claudeDecisions = [
  { action: "disabled", reason: "policy_disabled" }, { action: "reconciliation_required", reason: "invalid_input" },
  ...["claude_native_fallback_armed", "claude_automation_unavailable"].map((reason) => ({ action: "observe_only", reason, recheckAt: null })),
];

function observedCodexQuota() {
  return { state: "observed", source: "codex_app_server", observedAt: 700, receivedAt: 2,
    data: { resetCreditsAvailable: null, limits: [
      { id: "a", rateLimitReachedType: null, primary: { usedPercent: 0, windowDurationMins: null, resetsAtMs: null }, secondary: null },
      { id: "b", rateLimitReachedType: null, primary: null, secondary: null },
    ] } };
}
const tokens = (value: number | null) => ({ inputTokens: value, cacheReadInputTokens: value,
  cacheCreationInputTokens: value, outputTokens: value, thinkingTokens: value });
function widestComponents(provider: Provider) {
  const t = Number.MAX_SAFE_INTEGER;
  const number = 0.0000010000000000000002; // 24-byte JSON scalar witness.
  const common = { readiness: { state: "cached", value: "recovery_required", observedAt: t },
    automaticPolicy: { state: "configured", revision: t, defaultEnabled: false, override: "inherit" } };
  if (provider === "codex") {
    const window = () => ({ usedPercent: number, windowDurationMins: number, resetsAtMs: t });
    return { provider, quota: { state: "observed", source: "codex_app_server", observedAt: t, receivedAt: t,
      data: { resetCreditsAvailable: t, limits: Array.from({ length: 101 }, (_, index) => ({
        id: String(index).padStart(256, "a"), rateLimitReachedType: "a".repeat(128), primary: window(), secondary: window(),
      })) } }, accounting: unavailable("not_projected"), ...common };
  }
  return { provider, quota: { state: "observed", source: "claude_rate_limit_event", observedAt: t, receivedAt: t,
    data: { status: { state: "unknown", value: "a".repeat(128) }, rateLimitType: "a".repeat(128), resetsAtMs: t,
      overageStatus: "a".repeat(128), overageDisabledReason: "a".repeat(128), isUsingOverage: false,
      windows: Array.from({ length: 16 }, (_, index) => ({ id: String(index).padStart(128, "a"), scope: "account", usedPercent: number, resetsAtMs: t })) } },
    accounting: { state: "observed", source: "claude_result", observedAt: t, receivedAt: t,
      data: { totalCostUsd: number, ...tokens(t), models: Array.from({ length: 32 }, (_, index) => ({
        model: String(index).padStart(128, "a"), costUsd: number, ...tokens(t), contextWindow: t, maxOutputTokens: t,
      })) } }, ...common };
}

describe("usage head v2 composed plaintext contract", () => {
  test("requires exact context agreement and canonical head/order keys for both providers", () => {
    for (const provider of ["codex", "claude"] as const) {
      assertDetached(head(provider), context(provider));
      const parsed = parseUsageHeadV2(head(provider), context(provider));
      expect(Object.keys(parsed ?? {})).toEqual(["version", "userPublicId", "sourceDevicePublicId", "provider", "sourcePublicId", "sourceRevision", "keyVersion", "codexAccountMatchPublicId", "order", "components", "display"]);
      expect(Object.keys(parsed?.order ?? {})).toEqual(["state", "orderRevision", "pointerRevision", "orderPosition", "accountCount", "active"]);
      for (const reason of ["snapshot_conflict", "representation_limit"]) {
        assertDetached({ ...head(provider), order: unavailable(reason) }, context(provider));
      }
    }
  });

  test("refuses each mismatched repeated context field and cross-provider block", () => {
    const changes: Record<string, unknown> = { userPublicId: "user_changed", sourceDevicePublicId: "device_changed",
      provider: "claude", sourcePublicId: `usrc2_${"b".repeat(64)}`, sourceRevision: 2, keyVersion: 2 };
    for (const [field, changed] of Object.entries(changes)) {
      expect(parseUsageHeadV2({ ...head(), [field]: changed }, context())).toBeNull();
      expect(parseUsageHeadV2(head(), { ...context(), [field]: changed })).toBeNull();
    }
    for (const provider of ["codex", "claude"] as const) {
      const other = provider === "codex" ? "claude" : "codex";
      expect(parseUsageHeadV2({ ...head(provider), components: components(other) }, context(provider))).toBeNull();
      expect(parseUsageHeadV2({ ...head(provider), display: display(other) }, context(provider))).toBeNull();
    }
  });

  test("requires external origin/context while keeping origin out of plaintext and authentication out of this parser", () => {
    for (const apiOrigin of ["HTTPS://EXAMPLE.COM:443/", "http://localhost:3000", "https://another.example.com"]) {
      rawEqual(parseUsageHeadV2(head(), { ...context(), apiOrigin }), head());
    }
    for (const expected of [undefined, null, {}, { ...context(), apiOrigin: "http://remote.example.com" },
      { ...context(), apiOrigin: "https://example.com/private" }, { ...context(), private: true }]) {
      expect(parseUsageHeadV2(head(), expected)).toBeNull();
    }
    expect(parseUsageHeadV2({ ...head(), apiOrigin: "https://example.com" }, context())).toBeNull();
  });

  test("captures context before inspecting payload and retains that snapshot if payload traps mutate its caller", () => {
    let payloadInspections = 0;
    const unread = new Proxy(head(), { ownKeys(target) { payloadInspections += 1; return Reflect.ownKeys(target); } });
    expect(parseUsageHeadV2(unread, { ...context(), keyVersion: 0 })).toBeNull();
    expect(payloadInspections).toBe(0);

    const expected = context();
    const input = head();
    const payload = new Proxy(input, { ownKeys(target) { expected.sourceRevision = 2; return Reflect.ownKeys(target); } });
    rawEqual(parseUsageHeadV2(payload, expected), input);
    expect(expected.sourceRevision).toBe(2);

    const laterPayload = head();
    const contextTarget = { ...context(), sourceRevision: 2 };
    const earlierContext = new Proxy(contextTarget, { ownKeys(target) {
      laterPayload.sourceRevision = 2;
      return Reflect.ownKeys(target);
    } });
    const parsed = parseUsageHeadV2(laterPayload, earlierContext);
    expect(parsed?.sourceRevision).toBe(2);
    expect(parsed).not.toBe(laterPayload);
  });

  test("validates root/order closed keys and all context scalar grammars without repairing values", () => {
    for (const provider of ["codex", "claude"] as const) {
      for (const input of [head(provider), { ...head(provider), order: unavailable("representation_limit") }]) {
        for (const field of Object.keys(input)) {
          expect(parseUsageHeadV2(Object.fromEntries(Object.entries(input).filter(([key]) => key !== field)), context(provider))).toBeNull();
        }
        for (const field of Object.keys(input.order)) {
          const missing = Object.fromEntries(Object.entries(input.order).filter(([key]) => key !== field));
          expect(parseUsageHeadV2({ ...input, order: missing }, context(provider))).toBeNull();
        }
        for (const value of [true, undefined]) {
          expect(parseUsageHeadV2({ ...input, future: value }, context(provider))).toBeNull();
          expect(parseUsageHeadV2({ ...input, order: { ...input.order, future: value } }, context(provider))).toBeNull();
        }
      }
    }
    for (const version of [1, 3, "2", null, undefined]) expect(parseUsageHeadV2({ ...head(), version }, context())).toBeNull();
    for (const field of ["sourceRevision", "keyVersion"]) for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null]) {
      expect(parseUsageHeadV2({ ...head(), [field]: value }, { ...context(), [field]: value })).toBeNull();
    }
    for (const field of ["userPublicId", "sourceDevicePublicId"]) {
      for (const value of ["x".repeat(7), "x".repeat(97), "contains space", "é".repeat(8), null]) {
        expect(parseUsageHeadV2({ ...head(), [field]: value }, { ...context(), [field]: value })).toBeNull();
      }
      for (const value of ["x".repeat(8), "x".repeat(96)]) {
        expect(parseUsageHeadV2({ ...head(), [field]: value }, { ...context(), [field]: value })).not.toBeNull();
      }
    }
  });

  test("the legacy Codex match link is optional, provider-specific and not a substitute for a source identity", () => {
    const link = `codex_${"a".repeat(48)}`;
    for (const value of [null, link]) expect(parseUsageHeadV2({ ...head(), codexAccountMatchPublicId: value }, context())).not.toBeNull();
    for (const value of ["codex_", `codex_${"a".repeat(47)}`, `codex_${"a".repeat(49)}`, `codex_${"A".repeat(48)}`, context().sourcePublicId, "acct_" + "a".repeat(32), undefined]) {
      expect(parseUsageHeadV2({ ...head(), codexAccountMatchPublicId: value }, context())).toBeNull();
    }
    expect(parseUsageHeadV2({ ...head("claude"), codexAccountMatchPublicId: link }, context("claude"))).toBeNull();
    const identityUnknown = replaceAt(head(), ["display", "reset", "currentIdentity"], unavailable("identity_unavailable"));
    expect(parseUsageHeadV2(identityUnknown, context())).not.toBeNull();
    expect(parseUsageHeadV2(replaceAt(identityUnknown, ["codexAccountMatchPublicId"], link), context())).toBeNull();
    const snapshotConflict = replaceAt(replaceAt(head(), ["display", "reset", "currentIdentity"], unavailable("snapshot_conflict")),
      ["display", "nextAction"], unavailable("snapshot_conflict"));
    expect(parseUsageHeadV2(replaceAt(snapshotConflict, ["codexAccountMatchPublicId"], link), context())).not.toBeNull();
    // Literal identity unavailability alone does not prove a newly captured
    // quota component invalid; the producer must bind its private provenance.
    expect(parseUsageHeadV2(replaceAt(identityUnknown, ["components", "quota"], observedCodexQuota()), context())).not.toBeNull();
  });

  test("policy agreement preserves invalid-input-before-policy and explicit overrides", () => {
    for (const provider of ["codex", "claude"] as const) {
      const decisions = provider === "codex" ? codexDecisions : claudeDecisions;
      for (const defaultEnabled of [false, true]) for (const override of ["inherit", "on", "off"]) {
        const enabled = override === "inherit" ? defaultEnabled : override === "on";
        for (const decision of decisions) {
          const input = { ...head(provider, advisory(decision)), order: unavailable("representation_limit"),
            components: { ...components(provider), automaticPolicy: policy(defaultEnabled, override) } };
          const allowed = decision.reason === "invalid_input" || (enabled ? decision.action !== "disabled" : decision.action === "disabled");
          if (allowed) expect(parseUsageHeadV2(input, context(provider))).not.toBeNull();
          else expect(parseUsageHeadV2(input, context(provider))).toBeNull();
        }
      }
      for (const decision of decisions) {
        const input = { ...head(provider, advisory(decision)), order: unavailable("snapshot_conflict"),
          components: { ...components(provider), automaticPolicy: unavailable("configuration_unavailable") } };
        if (decision.reason === "invalid_input") expect(parseUsageHeadV2(input, context(provider))).not.toBeNull();
        else expect(parseUsageHeadV2(input, context(provider))).toBeNull();
      }
    }
  });

  test("non-advisory unknowns and independently retained recovery survive off, unavailable policy and oversized reducer counts", () => {
    for (const automaticPolicy of [policy(false), unavailable("configuration_unavailable")]) {
      for (const accountCount of [1, 1_001, 10_000]) {
        const input = { ...head(), order: order(accountCount), components: { ...components("codex"), automaticPolicy } };
        for (const reason of ["runtime_not_integrated", "inputs_unavailable", "snapshot_conflict"]) {
          expect(parseUsageHeadV2(replaceAt(input, ["display", "nextAction"], unavailable(reason)), context())).not.toBeNull();
        }
        const recovery = replaceAt(replaceAt(input, ["display", "reset", "pending"],
          { state: "recovery_pending", weeklyWindowResetsAt: 1, identityRelation: "current" }),
        ["display", "nextAction"], { state: "blocked", reason: "reset_outcome_unknown" });
        expect(parseUsageHeadV2(recovery, context())).not.toBeNull();
        expect(parseUsageHeadV2(replaceAt(recovery, ["display", "nextAction"], disabled()), context())).toBeNull();
      }
    }
  });

  test("cached Codex active-source checks respect earlier diagnostics while Claude bypasses that branch", () => {
    for (const provider of ["codex", "claude"] as const) {
      for (const active of [false, true]) for (const decision of provider === "codex" ? codexDecisions : claudeDecisions) {
        const input = { ...head(provider, advisory(decision)), order: order(2, active),
          components: { ...components(provider), automaticPolicy: policy(decision.action !== "disabled") } };
        const beforeActive = ["policy_disabled", "invalid_input", "account_order_conflict"].includes(decision.reason);
        const allowed = provider === "claude" || beforeActive || (decision.reason === "not_active_source" ? !active : active);
        if (allowed) expect(parseUsageHeadV2(input, context(provider))).not.toBeNull();
        else expect(parseUsageHeadV2(input, context(provider))).toBeNull();
      }
    }
  });

  test("complete cached count distinguishes listing and reducer capacity at 999, 1000, 1001 and 10000", () => {
    expect(AUTOMATIC_USAGE_ACCOUNT_LIMIT).toBe(1_000);
    expect(PROVIDER_ACCOUNT_LIST_MAX_COUNT).toBe(10_000);
    for (const provider of ["codex", "claude"] as const) {
      for (const accountCount of [999, 1_000, 1_001, 10_000]) {
        for (const decision of provider === "codex" ? codexDecisions : claudeDecisions) {
          const input = { ...head(provider, advisory(decision)), order: order(accountCount, decision.reason !== "not_active_source", accountCount),
            components: { ...components(provider), automaticPolicy: policy(decision.action !== "disabled") } };
          if (accountCount <= 1_000 || decision.reason === "invalid_input") expect(parseUsageHeadV2(input, context(provider))).not.toBeNull();
          else expect(parseUsageHeadV2(input, context(provider))).toBeNull();
        }
      }
      expect(parseUsageHeadV2({ ...head(provider), order: order(1, true) }, context(provider))).not.toBeNull();
      expect(parseUsageHeadV2({ ...head(provider), order: order(1, false) }, context(provider))).toBeNull();
    }
    for (const field of ["orderRevision", "pointerRevision", "orderPosition", "accountCount"]) {
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null, undefined]) {
        expect(parseUsageHeadV2(replaceAt(head(), ["order", field], value), context())).toBeNull();
      }
    }
    for (const field of ["orderRevision", "pointerRevision"]) {
      expect(parseUsageHeadV2(replaceAt(head(), ["order", field], Number.MAX_SAFE_INTEGER), context())).not.toBeNull();
    }
    for (const input of [order(10_001), order(2, true, 3), order(10_000, true, 10_001), { ...order(), active: 1 }]) {
      expect(parseUsageHeadV2({ ...head(), order: input }, context())).toBeNull();
    }
  });

  test("composition preserves independent quota/readiness/history clocks and does not manufacture reducer evidence", () => {
    let input: unknown = replaceAt(head(), ["components", "quota"], observedCodexQuota());
    input = replaceAt(input, ["components", "readiness"], { state: "cached", value: "signed_out", observedAt: Number.MAX_SAFE_INTEGER });
    input = replaceAt(input, ["display", "reset", "currentIdentity"], { state: "known",
      policy: { state: "window_suppressed", weeklyWindowResetsAt: 7 },
      lastAttempt: { state: "closed", reason: "account_identity_changed", weeklyWindowResetsAt: 3 } });
    input = replaceAt(input, ["display", "reset", "pending"], { state: "prepared", weeklyWindowResetsAt: 900, identityRelation: "current" });
    assertDetached(input, context());
    const rowOrder = replaceAt(input, ["components", "quota", "data", "limits"], [...observedCodexQuota().data.limits].reverse());
    expect(JSON.stringify(parseUsageHeadV2(rowOrder, context()))).toBe(JSON.stringify(parseUsageHeadV2(input, context())));
    // Missing public quota is not itself a proof that omitted private reducer
    // evidence was invalid. This codec checks public consistency, not authority.
    expect(parseUsageHeadV2(head("codex", advisory({ action: "continue", reason: "below_threshold" })), context())).not.toBeNull();
    const claudeInput = { ...head("claude"), components: { ...components("claude"),
      quota: { state: "observed", source: "claude_rate_limit_event", observedAt: 900, receivedAt: 900,
        data: { status: { state: "known", value: "warning" }, rateLimitType: null, resetsAtMs: 0, overageStatus: null,
          overageDisabledReason: null, isUsingOverage: null, windows: [] } },
      accounting: { state: "observed", source: "claude_result", observedAt: 1, receivedAt: 1,
        data: { totalCostUsd: null, ...tokens(null), models: [] } } } };
    assertDetached(claudeInput, context("claude"));
    expect(parseUsageHeadV2(replaceAt(claudeInput, ["components", "quota", "receivedAt"], 899), context("claude"))).toBeNull();
  });

  test("whole-head foreign snapshot rejects cross-block aliases, getters, cycles and poisoned graphs without getter execution", () => {
    let getters = 0;
    const shared = unavailable("snapshot_conflict");
    const aliased = { ...head(), order: shared, display: { provider: "codex", reset: shared, nextAction: shared } };
    expect(parseUsageHeadV2(JSON.parse(JSON.stringify(aliased)) as unknown, context())).not.toBeNull();
    expect(parseUsageHeadV2(aliased, context())).toBeNull();
    const accessor = head();
    Object.defineProperty(accessor.components, "quota", { enumerable: true, get() { getters += 1; throw new Error("private getter"); } });
    const contextAccessor = context();
    Object.defineProperty(contextAccessor, "sourceRevision", { enumerable: true, get() { getters += 1; throw new Error("private context"); } });
    expect(parseUsageHeadV2(head(), contextAccessor)).toBeNull();
    const cycle: Record<string, unknown> = head(); cycle.loop = cycle;
    const sparse: unknown[] = []; sparse.length = 1;
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const hidden = head(); Object.defineProperty(hidden, "private", { value: true, enumerable: false });
    for (const input of [undefined, null, true, 1, "head", 1n, Symbol("private"), () => 1, [], sparse, new Date(), new Map(),
      accessor, cycle, revoked.proxy, hidden, { ...head(), [Symbol("private")]: true },
      new Proxy({}, { ownKeys() { throw new Error("private proxy"); } }),
      Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, head()),
      { ...head(), toJSON() { getters += 1; throw new Error("private coercion"); } },
    ]) expect(parseUsageHeadV2(input, context())).toBeNull();
    expect(getters).toBe(0);
    const plain = Object.assign(Object.create(null) as Record<string, unknown>, head());
    rawEqual(parseUsageHeadV2(plain, context()), head());
    expect(Object.isFrozen(plain)).toBe(false);
  });

  test("independent field arithmetic proves conservative plaintext ceilings and valid full-width heads fit", () => {
    const t = Number.MAX_SAFE_INTEGER;
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(USAGE_HEAD_V2_CODEX_MAX_JSON_BYTES).toBe(69_961);
    expect(USAGE_HEAD_V2_CLAUDE_MAX_JSON_BYTES).toBe(19_477);
    expect(USAGE_HEAD_V2_MAX_JSON_BYTES).toBe(69_961);
    expect([USAGE_COMPONENTS_V2_CODEX_MAX_JSON_BYTES, USAGE_COMPONENTS_V2_CLAUDE_MAX_JSON_BYTES,
      USAGE_DISPLAY_V2_CODEX_MAX_JSON_BYTES, USAGE_DISPLAY_V2_CLAUDE_MAX_JSON_BYTES]).toEqual([68_738, 18_598, 538, 245]);
    for (const provider of ["codex", "claude"] as const) {
      const expected = { ...context(provider), userPublicId: "u".repeat(96), sourceDevicePublicId: "d".repeat(96), sourceRevision: t, keyVersion: t };
      const wideOrder = { state: "cached", orderRevision: t, pointerRevision: t, orderPosition: 10_000, accountCount: 10_000, active: false };
      const skeleton = { ...head(provider), userPublicId: expected.userPublicId, sourceDevicePublicId: expected.sourceDevicePublicId,
        sourceRevision: t, keyVersion: t, codexAccountMatchPublicId: provider === "codex" ? `codex_${"b".repeat(48)}` : null,
        order: wideOrder, components: null, display: null };
      expect(bytes(wideOrder)).toBe(144);
      const keyBytes = Object.keys(skeleton).reduce((sum, key) => sum + bytes(key) + 1, 0);
      const scalarBytes = Object.entries(skeleton).filter(([key]) => key !== "components" && key !== "display")
        .reduce((sum, [, value]) => sum + bytes(value), 0);
      const punctuation = Object.keys(skeleton).length + 1;
      expect(keyBytes).toBe(165);
      expect(punctuation).toBe(12);
      expect(scalarBytes).toBe(provider === "codex" ? 508 : 457);
      const framing = keyBytes + scalarBytes + punctuation;
      expect(bytes(skeleton) - 8).toBe(framing);
      const componentBound = provider === "codex" ? 68_738 : 18_598;
      const displayBound = provider === "codex" ? 538 : 245;
      const maximum = provider === "codex" ? 69_961 : 19_477;
      expect(framing + componentBound + displayBound).toBe(maximum);
      const wide = { ...skeleton, components: widestComponents(provider), display: display(provider, invalidInput()) };
      expect(bytes(wide.components)).toBe(componentBound);
      const parsed = parseUsageHeadV2(wide, expected);
      expect(parsed).not.toBeNull();
      expect(bytes(parsed)).toBeLessThan(maximum); // Independent maxima need not coexist.
      if (provider === "codex") expect(bytes(parsed)).toBeGreaterThan(65_536);
      expect(parseUsageHeadV2({ ...wide, order: { ...wideOrder, accountCount: 10_001 } }, expected)).toBeNull();
    }
  });

  test("seeded arbitrary input/context totality does not assume every generated JSON value is invalid", () => {
    const foreign = fc.oneof(fc.jsonValue(), fc.constant(undefined), fc.constant(NaN), fc.bigInt());
    fc.assert(fc.property(foreign, fc.oneof(foreign, fc.constant(context())), (input, expected) => {
      const parsed = parseUsageHeadV2(input, expected);
      if (parsed !== null) {
        expect(parseUsageHeadV2(parsed, expected)).toEqual(parsed);
        for (const reference of references(parsed)) expect(Object.isFrozen(reference)).toBe(true);
      }
    }), { numRuns: 150, seed: 68_301 });
  });

  test("seeded accepted heads preserve context binding, canonical order and detached freeze across policy/count variants", () => {
    const arbitrary = fc.record({ provider: fc.constantFrom<Provider>("codex", "claude"),
      count: fc.integer({ min: 1, max: 10_000 }), positionSeed: fc.nat(10_000), suffix: fc.nat(1_000_000),
      revision: fc.integer({ min: 1, max: 1_000_000 }), keyVersion: fc.integer({ min: 1, max: 1_000_000 }),
      defaultEnabled: fc.boolean(), override: fc.constantFrom("inherit", "on", "off"),
      kind: fc.constantFrom("unavailable", "invalid_input", "evaluated"), active: fc.boolean() });
    fc.assert(fc.property(arbitrary, (generated) => {
      const expected = { ...context(generated.provider), userPublicId: `user_${generated.suffix.toString().padStart(8, "0")}`,
        sourceRevision: generated.revision, keyVersion: generated.keyVersion };
      const enabled = generated.override === "inherit" ? generated.defaultEnabled : generated.override === "on";
      const active = generated.count === 1 || generated.active;
      const nextAction = generated.kind === "unavailable" ? unavailable()
        : generated.kind === "invalid_input" || generated.count > 1_000 ? invalidInput()
          : !enabled ? disabled() : generated.provider === "claude"
            ? advisory({ action: "observe_only", reason: "claude_native_fallback_armed", recheckAt: null })
            : active ? advisory({ action: "continue", reason: "below_threshold" })
              : advisory({ action: "observe_only", reason: "not_active_source", recheckAt: null });
      const input = { ...head(generated.provider, nextAction), userPublicId: expected.userPublicId,
        sourceRevision: expected.sourceRevision, keyVersion: expected.keyVersion,
        order: order(generated.count, active, generated.positionSeed % generated.count + 1),
        components: { ...components(generated.provider), automaticPolicy: policy(generated.defaultEnabled, generated.override) } };
      assertDetached(input, expected);
      expect(parseUsageHeadV2(input, { ...expected, sourceRevision: expected.sourceRevision + 1 })).toBeNull();
    }), { numRuns: 150, seed: 68_302 });
  });

  test("bundles only the browser-safe head graph in memory without native storage or provider code", async () => {
    const build = await Bun.build({ entrypoints: [`${import.meta.dir}/usage-head-v2.ts`], target: "browser" });
    expect(build.success).toBe(true);
    expect(build.logs).toEqual([]);
    expect(build.outputs).toHaveLength(1);
    const output = await build.outputs[0]?.text();
    expect(output).toContain("parseUsageHeadV2");
    expect(output).not.toMatch(/(?:node:|bun:sqlite|StateStore|randomUUID|createHash)/u);
  });
});
