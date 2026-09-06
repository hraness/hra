import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { ProviderAccountAuthority } from "./provider-accounts";
import {
  createClaudeQuotaUsageComponent,
  providerUsageDigest,
  providerUsageQuotaComponentSchema,
  type CodexQuotaUsage,
} from "./provider-usage";
import {
  AUTO_RATE_LIMIT_RESET_USED_PERCENT,
  automaticRateLimitResetDecision,
  CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES,
  USAGE_EXHAUSTION_USED_PERCENT,
} from "./usage-metrics";
import {
  automaticUsageDecision,
  automaticUsagePolicyConfigurationSchema,
  automaticUsageResetGateSchema,
  classifyProviderUsageAccount,
  followSettledAutomaticPointerMoves,
  initialAutomaticUsagePolicyConfiguration,
  resolveAutomaticUsagePolicy,
  settledAutomaticPointerMoveSchema,
  usageObservationFreshness,
  type AutomaticUsageDecisionInput,
  type AutomaticUsageManagedSession,
  type AutomaticUsageQuotaEvidence,
  type SettledAutomaticPointerMove,
  type UsagePolicyAccount,
} from "./usage-policy";

const now = 1_800_000_000_000;
const hour = 60 * 60_000;
const week = CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES;
const digest = "a".repeat(64);
const accountId = (id: number): string => `acct_${id.toString(16).padStart(32, "0")}`;
const authorityFor = (id: number): ProviderAccountAuthority => ({
  provider: "codex",
  providerAccountId: accountId(id),
  profileId: accountId(id),
  bindingGeneration: 2,
  processGeneration: 4,
});
const window = (usedPercent: number, resetsAtMs = now + hour, windowDurationMins = week) => ({
  usedPercent, resetsAtMs, windowDurationMins,
});
const limit = (usedPercent: number): CodexQuotaUsage["limits"][number] => ({
  id: "legacy:primary",
  limitId: null,
  limitName: null,
  planType: null,
  rateLimitReachedType: null,
  primary: window(usedPercent),
  secondary: null,
});

function account(id: number, usedPercent: number, options: Readonly<{
  limits?: CodexQuotaUsage["limits"];
  receivedAt?: number;
  observedAt?: number;
  credits?: number;
  revision?: number;
}> = {}): UsagePolicyAccount {
  const authority = authorityFor(id);
  const unsigned = {
    version: 2 as const,
    component: "quota" as const,
    authority,
    source: "codex_app_server" as const,
    turn: null,
    observationRevision: options.revision ?? 12,
    idempotencyKey: digest,
    sourceEventDigest: digest,
    observedAt: options.observedAt ?? now,
    receivedAt: options.receivedAt ?? now,
    quota: {
      format: "codex_v1" as const,
      resetCreditsAvailable: options.credits ?? 0,
      limits: options.limits ?? [limit(usedPercent)],
    },
  };
  return {
    authority,
    readiness: "signed_in",
    authorityMode: "mutation_authoritative",
    quota: { ...unsigned, componentDigest: providerUsageDigest(unsigned) },
  };
}

const classify = (value: unknown, evaluatedAt = now) => classifyProviderUsageAccount({ account: value, now: evaluatedAt });

function evidence(value: UsagePolicyAccount): AutomaticUsageQuotaEvidence {
  const classification = classify(value);
  if (classification.state !== "available" && classification.state !== "exhausted") {
    throw new Error("Expected an authoritative test observation.");
  }
  return classification.evidence;
}

function decisionInput(accounts = [account(1, 99), account(2, 20)]): AutomaticUsageDecisionInput {
  const first = accounts[0];
  if (first === undefined) throw new Error("Test needs a source account.");
  return {
    provider: "codex",
    now,
    configuration: initialAutomaticUsagePolicyConfiguration(),
    observedSource: first.authority,
    order: accounts.map((entry) => entry.authority.providerAccountId),
    orderRevision: 3,
    activeProviderAccountId: first.authority.providerAccountId,
    pointerRevision: 5,
    resetPolicyRevision: 7,
    accounts,
    resetGate: {
      authority: first.authority,
      quotaObservationRevision: 12,
      resetPolicyRevision: 7,
      resetBoundary: now + hour,
      state: "not_eligible",
      reason: "credits_unavailable",
    },
    nativeFallback: "unavailable",
  };
}

function move(from: number, to: number, revision: number): SettledAutomaticPointerMove {
  const input = decisionInput([account(from, 99), account(to, 20)]);
  const decision = automaticUsageDecision({ ...input, pointerRevision: revision });
  if (decision.action !== "propose_pointer_move") throw new Error("Expected a test proposal.");
  return settledAutomaticPointerMoveSchema.parse({
    version: 1,
    kind: "settled_automatic_pointer_move",
    moveId: revision.toString(16).padStart(40, "0"),
    authority: decision.authority,
    target: decision.target,
    toPointerRevision: revision + 1,
    settledAt: now,
  });
}

function managedSession(): AutomaticUsageManagedSession {
  return {
    sessionId: "sess_00000000000000000000000000000001",
    sessionRevision: 8,
    sessionAuthorityRevision: 3,
    authority: authorityFor(1),
    routingProvenance: "managed",
    appliedPointerRevision: 5,
    turnId: null,
  };
}

const follow = (moves: readonly SettledAutomaticPointerMove[], throughPointerRevision = 7) =>
  followSettledAutomaticPointerMoves({
    session: managedSession(),
    configuration: initialAutomaticUsagePolicyConfiguration(),
    throughPointerRevision,
    moves,
  });

describe("automatic usage policy configuration", () => {
  test("defaults to enabled with independently inherited provider overrides at revision one", () => {
    const initial = initialAutomaticUsagePolicyConfiguration();
    expect(initial).toEqual({ version: 1, defaultEnabled: true, overrides: { codex: "inherit", claude: "inherit" }, automaticPolicyRevision: 1 });
    for (const defaultEnabled of [false, true]) {
      for (const override of ["inherit", "on", "off"] as const) {
        for (const provider of ["codex", "claude"] as const) {
          const configuration = { ...initial, defaultEnabled, overrides: { ...initial.overrides, [provider]: override } };
          expect(resolveAutomaticUsagePolicy({ configuration, provider })).toEqual({
            provider,
            enabled: override === "inherit" ? defaultEnabled : override === "on",
            source: override === "inherit" ? "default" : "override",
            automaticPolicyRevision: 1,
          });
        }
      }
    }
    expect(automaticUsagePolicyConfigurationSchema.safeParse({ ...initial, resetPolicyRevision: 1 }).success).toBe(false);
    expect(automaticUsagePolicyConfigurationSchema.safeParse({ ...initial, overrides: { codex: "auto", claude: "inherit" } }).success).toBe(false);
  });

  test("returns a new initial configuration so callers cannot mutate another default", () => {
    const initial = initialAutomaticUsagePolicyConfiguration();
    initial.overrides.codex = "off";
    expect(initialAutomaticUsagePolicyConfiguration().overrides.codex).toBe("inherit");
  });
});

describe("provider usage classification", () => {
  test("keeps the established 99 percent threshold and accepts 98.99 below it", () => {
    expect(USAGE_EXHAUSTION_USED_PERCENT).toBe(99);
    expect(USAGE_EXHAUSTION_USED_PERCENT).toBe(AUTO_RATE_LIMIT_RESET_USED_PERCENT);
    for (const used of [0, 98.99, 99, 100]) {
      expect(classify(account(1, used)).state).toBe(used < 99 ? "available" : "exhausted");
    }
  });

  test("freshness uses received time inclusively and rejects a future receive time", () => {
    expect(usageObservationFreshness({ receivedAt: now - 90_000, now })).toBe("fresh");
    expect(usageObservationFreshness({ receivedAt: now - 90_001, now })).toBe("stale");
    expect(usageObservationFreshness({ receivedAt: now + 1, now })).toBe("future");
    expect(classify(account(1, 10, { receivedAt: now - 90_000, observedAt: now - 1_000_000 })).state).toBe("available");
    expect(classify(account(1, 10, { receivedAt: now - 90_001 }))).toEqual({ state: "unknown", reason: "stale_observation" });
    expect(classify(account(1, 100, { receivedAt: now + 1 }))).toEqual({ state: "unknown", reason: "future_observation" });
  });

  test("keeps stale exhaustion only through each blocking window's own reset", () => {
    const value = account(1, 99, {
      receivedAt: now - 90_001,
      limits: [{ ...limit(99), primary: window(99, now + 1), secondary: window(100, now + 2) }],
    });
    expect(classify(value)).toMatchObject({ state: "exhausted", freshness: "stale", recheckAt: now + 2 });
    expect(classify(value, now + 1)).toMatchObject({ state: "exhausted", freshness: "stale", windows: [{ id: "secondary" }], recheckAt: now + 2 });
    expect(classify(value, now + 2)).toEqual({ state: "unknown", reason: "window_reset" });
  });

  test("any exhausted primary or secondary blocks, while null slots do not", () => {
    for (const limits of [
      [{ ...limit(20), secondary: window(99) }],
      [{ ...limit(99), secondary: window(20) }],
      [{ ...limit(20), primary: null, secondary: window(100) }],
    ]) expect(classify(account(1, 20, { limits })).state).toBe("exhausted");
    expect(classify(account(1, 0, { limits: [{ ...limit(0), primary: null }] }))).toEqual({ state: "unknown", reason: "no_windows" });
  });

  test("keyed Codex takes precedence and missing, mislabeled, or duplicate keyed identity is inert", () => {
    const keyed = { ...limit(99), id: "limit:codex", limitId: "codex" };
    expect(classify(account(1, 0, { limits: [limit(0), keyed] })).state).toBe("exhausted");
    expect(classify(account(1, 99, { limits: [limit(99), { ...keyed, primary: window(0) }] })).state).toBe("available");
    for (const limits of [
      [limit(0), { ...keyed, id: "limit:other", limitId: "other" }],
      [limit(0), { ...keyed, limitId: "other" }],
      [limit(0), { ...keyed, id: "unknown" }],
      [keyed, { ...keyed, id: "limit:other" }],
      [keyed, keyed],
      [limit(0), limit(0)],
    ]) expect(classify(account(1, 0, { limits })).state).toBe("unknown");
    expect(classify(account(1, 0, { limits: [{ ...limit(0), limitId: "other" }] })).state).toBe("unknown");
  });

  test("malformed present windows make the whole quota non-authoritative", () => {
    for (const invalid of [
      { usedPercent: Number.NaN }, { usedPercent: -1 }, { usedPercent: 101 },
      { windowDurationMins: null }, { windowDurationMins: -1 }, { windowDurationMins: 0 },
      { windowDurationMins: Number.MAX_SAFE_INTEGER }, { resetsAtMs: null },
      { resetsAtMs: now + (week * 60_000) + 1 },
    ]) {
      const altered = { ...window(20), ...invalid };
      // Malformed foreign JSON must not become available through its other valid slot.
      const value = account(1, 99);
      const quota = providerUsageQuotaComponentSchema.parse(value.quota);
      if (quota.quota.format !== "codex_v1") throw new Error("Expected Codex fixture.");
      const unsigned = { ...quota, quota: { ...quota.quota, limits: [{ ...limit(99), secondary: altered }] } };
      const body = Object.fromEntries(Object.entries(unsigned)
        .filter(([key]) => key !== "componentDigest"));
      const malformed = { ...body, componentDigest: Number.isNaN(altered.usedPercent) ? digest : providerUsageDigest(body) };
      expect(classify({ ...value, quota: malformed }).state).toBe("unknown");
    }
  });

  test("a reached assertion conflicts with below-threshold numbers but never overrides numeric exhaustion", () => {
    expect(classify(account(1, 10, { limits: [{ ...limit(10), rateLimitReachedType: "provider_reason" }] }))).toEqual({ state: "reconciliation_required", reason: "reached_type_conflict" });
    expect(classify(account(1, 99, { limits: [{ ...limit(99), rateLimitReachedType: "unknown_future_provider_reason" }] })).state).toBe("exhausted");
  });

  test("requires exact provider, account, credential and process authority plus a valid digest", () => {
    const value = account(1, 20);
    for (const authority of [authorityFor(2), { ...value.authority, bindingGeneration: 3 }, { ...value.authority, processGeneration: 5 }]) {
      expect(classify({ ...value, authority })).toEqual({ state: "unknown", reason: "authority_mismatch" });
    }
    for (const readiness of ["unverified", "signed_out", "login_pending", "recovery_required", "removed"]) {
      expect(classify({ ...value, readiness })).toEqual({ state: "unknown", reason: "account_not_ready" });
    }
    expect(classify({ ...value, authorityMode: "compatibility_display_only" })).toEqual({ state: "unknown", reason: "display_only" });
    const quota = providerUsageQuotaComponentSchema.parse(value.quota);
    expect(classify({ ...value, quota: { ...quota, componentDigest: "b".repeat(64) } })).toEqual({ state: "unknown", reason: "invalid_quota" });
  });

  test("Claude blocked observations expire and never authorize account or model movement", () => {
    const authority: ProviderAccountAuthority = { ...authorityFor(1), provider: "claude", providerAccountId: `pact_${"1".repeat(32)}` };
    const quota = createClaudeQuotaUsageComponent({
      authority,
      sessionId: "sess_00000000000000000000000000000001",
      turnId: "turn-1",
      sourceEventId: "00000000-0000-4000-8000-000000000001",
      sourceEventDigest: digest,
      observationRevision: 2,
      observedAt: now,
      receivedAt: now,
      quota: {
        status: { state: "known", value: "blocked" },
        rateLimitType: "unified",
        resetsAtMs: now + 1,
        overageStatus: null,
        overageDisabledReason: null,
        isUsingOverage: null,
        windows: [],
      },
    });
    // This is the real admitted readiness of an explicitly started Claude
    // session when auth status cannot prove a signed-in account identity.
    const value = { authority, readiness: "unverified", authorityMode: "mutation_authoritative", quota };
    expect(classify(value)).toMatchObject({ state: "observe_only", exhausted: true, recheckAt: now + 1 });
    expect(classify({ ...value, readiness: "signed_in" })).toEqual(classify(value));
    for (const readiness of ["signed_out", "recovery_required", "removed"]) {
      expect(classify({ ...value, readiness })).toEqual({ state: "unknown", reason: "account_not_ready" });
    }
    expect(classify({ ...account(1, 20), readiness: "unverified" }))
      .toEqual({ state: "unknown", reason: "account_not_ready" });
    expect(classify(value, now + 1)).toMatchObject({ state: "observe_only", exhausted: null, recheckAt: null });
    expect(classify({ ...value, quota: { ...quota, accounting: { totalCostUsd: 1_000_000 } } }).state).toBe("unknown");
    const input = { ...decisionInput(), provider: "claude", observedSource: authority, accounts: [value], order: [authority.providerAccountId], activeProviderAccountId: authority.providerAccountId, resetGate: null };
    expect(automaticUsageDecision({ ...input, nativeFallback: "armed" })).toEqual({ action: "observe_only", reason: "claude_native_fallback_armed", recheckAt: null });
    expect(automaticUsageDecision(input)).toEqual({ action: "observe_only", reason: "claude_automation_unavailable", recheckAt: null });
  });
});

describe("automatic usage selector", () => {
  test("binds one pointer proposal to exact quota, policy, order and pointer evidence", () => {
    const input = decisionInput();
    expect(automaticUsageDecision(input)).toEqual({
      action: "propose_pointer_move", reason: "next_available_account",
      authority: {
        source: evidence(account(1, 99)), orderRevision: 3, pointerRevision: 5,
        automaticPolicyRevision: 1, resetPolicyRevision: 7, resetBoundary: now + hour, evaluatedAt: now,
      },
      target: evidence(account(2, 20)),
    });
    expect(settledAutomaticPointerMoveSchema.safeParse(automaticUsageDecision(input)).success).toBe(false);
  });

  test("weekly credit eligibility always precedes a fresh account target", () => {
    const input = decisionInput([account(1, 99, { credits: 1 }), account(2, 0)]);
    const gate = input.resetGate;
    if (gate === null) throw new Error("Missing test gate.");
    expect(automaticUsageDecision({ ...input, resetGate: { ...gate, state: "eligible", reason: undefined } }).action).toBe("reconciliation_required");
    const eligible = { authority: gate.authority, quotaObservationRevision: 12, resetPolicyRevision: 7, resetBoundary: now + hour, state: "eligible" };
    expect(automaticUsageDecision({ ...input, resetGate: eligible }).action).toBe("reset");
    expect(automaticUsageDecision({ ...input, resetGate: { ...eligible, state: "pending", reason: "reread_required" } })).toEqual({ action: "observe_only", reason: "reset_pending", recheckAt: null });
    const settled = {
      ...eligible, state: "settled", outcome: "reset",
      resetIdempotencyKey: "00000000-0000-4000-8000-000000000001",
      attemptQuotaObservationRevision: 11,
      settledAt: now,
    };
    expect(automaticUsageDecision({ ...input, resetGate: settled }).action).toBe("propose_pointer_move");
    for (const outcome of ["reset", "alreadyRedeemed", "noCredit", "nothingToReset"]) {
      expect(automaticUsageResetGateSchema.safeParse({ ...settled, outcome, attemptQuotaObservationRevision: 12 }).success).toBe(false);
      expect(automaticUsageDecision({ ...input, resetGate: { ...settled, outcome, settledAt: now + 1 } })).toEqual({ action: "reconciliation_required", reason: "reset_gate_mismatch" });
      expect(automaticUsageResetGateSchema.safeParse({ ...eligible, state: "settled", outcome }).success).toBe(false);
    }
  });

  test("retains the existing raw-v1 empty-keyed reset fallback and does not infer settlement from v2", () => {
    const rawWindow = { usedPercent: 99, windowDurationMins: week, resetsAt: (now + hour) / 1_000 };
    const rawLimit = { limitId: null, primary: rawWindow, secondary: null };
    for (const byLimitId of [null, {}, { codex: rawLimit }]) {
      expect(automaticRateLimitResetDecision({ now, providerPayload: { rateLimits: { primary: rawLimit, byLimitId, resetCreditsAvailable: 1 } } })).toMatchObject({ eligible: true, weeklyWindowResetsAt: now + hour });
    }
    expect(automaticUsageDecision({ ...decisionInput(), resetGate: null })).toEqual({ action: "reconciliation_required", reason: "reset_gate_mismatch" });
  });

  test("rejects stale reset evidence and pending or ambiguous reset state", () => {
    const input = decisionInput();
    const gate = input.resetGate;
    if (gate === null) throw new Error("Missing test gate.");
    for (const patch of [
      { authority: authorityFor(2) }, { quotaObservationRevision: 11 }, { resetPolicyRevision: 6 }, { resetBoundary: now + 1 },
    ]) expect(automaticUsageDecision({ ...input, resetGate: { ...gate, ...patch } })).toEqual({ action: "reconciliation_required", reason: "reset_gate_mismatch" });
    const base = {
      authority: gate.authority,
      quotaObservationRevision: gate.quotaObservationRevision,
      resetPolicyRevision: gate.resetPolicyRevision,
      resetBoundary: gate.resetBoundary,
    };
    expect(automaticUsageDecision({ ...input, resetGate: { ...base, state: "reconciliation_required" } })).toEqual({ action: "reconciliation_required", reason: "reset_reconciliation_required" });
    expect(automaticUsageDecision({ ...input, resetGate: { ...base, state: "pending", reason: "recovery_pending" } }).action).toBe("observe_only");
  });

  test("an observation on a non-active account cannot move the cursor", () => {
    const input = decisionInput();
    expect(automaticUsageDecision({ ...input, observedSource: authorityFor(2) })).toEqual({ action: "observe_only", reason: "not_active_source", recheckAt: null });
    expect(automaticUsageDecision({ ...input, observedSource: { ...input.observedSource, bindingGeneration: 3 } })).toEqual({ action: "reconciliation_required", reason: "source_conflict" });
  });

  test("wraps once in persisted order independent of account input order", () => {
    const input = decisionInput([account(3, 99), account(2, 20), account(1, 10)]);
    const ordered = { ...input, order: [accountId(1), accountId(2), accountId(3)] };
    fc.assert(fc.property(fc.shuffledSubarray(ordered.accounts, { minLength: 3, maxLength: 3 }), (accounts) => {
      const decision = automaticUsageDecision({ ...ordered, accounts });
      expect(decision.action).toBe("propose_pointer_move");
      if (decision.action === "propose_pointer_move") expect(decision.target.authority.providerAccountId).toBe(accountId(1));
    }));
  });

  test("never selects unknown, stale, signed-out or compatibility-only targets", () => {
    for (const candidate of [
      { ...account(2, 0), quota: null },
      account(2, 0, { receivedAt: now - 90_001 }),
      { ...account(2, 0), readiness: "signed_out" },
      { ...account(2, 0), authorityMode: "compatibility_display_only" },
      { ...account(2, 0), quota: { unexpected: true } },
    ]) expect(automaticUsageDecision({ ...decisionInput(), accounts: [account(1, 99), candidate] }).action).toBe("wait");
    expect(automaticUsageDecision(decisionInput([account(1, 99, { receivedAt: now - 90_001 }), account(2, 0)]))).toEqual({ action: "observe_only", reason: "source_stale", recheckAt: now + hour });
  });

  test("waits for all blocking windows per account, then the earliest account recheck", () => {
    const input = decisionInput([
      account(1, 99, { limits: [{ ...limit(99), primary: window(99, now + hour), secondary: window(100, now + 3 * hour, 300) }] }),
      account(2, 99, { limits: [{ ...limit(99), primary: window(99, now + 2 * hour), secondary: window(20, now + hour, 300) }] }),
    ]);
    expect(automaticUsageDecision(input)).toMatchObject({ action: "wait", recheckAt: now + 2 * hour });
    expect(automaticUsageDecision(decisionInput([account(1, 99)]))).toMatchObject({ action: "wait", recheckAt: now + hour });
  });

  test("rereads the whole limit after a weekly reset rather than assuming availability", () => {
    const source = account(1, 0, { credits: 1, limits: [{ ...limit(0), secondary: window(99, now + 2 * hour, 300) }] });
    const input = decisionInput([source, account(2, 20)]);
    const gate = input.resetGate;
    if (gate === null) throw new Error("Missing gate.");
    expect(automaticUsageDecision({ ...input, resetGate: { ...gate, reason: "below_threshold" } }).action).toBe("propose_pointer_move");
    expect(automaticUsageDecision(decisionInput([account(1, 0), account(2, 20)]))).toMatchObject({ action: "continue", reason: "below_threshold" });
  });

  test("invalid order and disabled policy are closed decisions", () => {
    const input = decisionInput();
    for (const order of [[accountId(1)], [accountId(1), accountId(1)], [accountId(1), accountId(3)]]) {
      expect(automaticUsageDecision({ ...input, order })).toEqual({ action: "reconciliation_required", reason: "account_order_conflict" });
    }
    expect(automaticUsageDecision({ ...input, configuration: { ...input.configuration, defaultEnabled: false } })).toEqual({ action: "disabled", reason: "policy_disabled", automaticPolicyRevision: 1 });
  });

  test("foreign JSON is total and cannot manufacture a mutating result", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(automaticUsageDecision(value).action).toBe("reconciliation_required");
      expect(classify(value).state).toBe("unknown");
    }));
  });
});

describe("following settled automatic pointer moves", () => {
  test("follows the named A-to-B-to-C chain and binds the session revisions", () => {
    const result = follow([move(2, 3, 6), move(1, 2, 5)]);
    expect(result).toEqual({
      action: "follow_pointer_moves", session: managedSession(),
      moveIds: ["5".padStart(40, "0"), "6".padStart(40, "0")],
      target: authorityFor(3), toPointerRevision: 7, automaticPolicyRevision: 1,
    });
  });

  test("A-to-B-to-A only advances the applied revision without switching providers", () => {
    expect(follow([move(1, 2, 5), move(2, 1, 6)])).toMatchObject({ action: "advance_pointer_revision", target: authorityFor(1), toPointerRevision: 7 });
    const last = move(2, 1, 6);
    const newerProcess = settledAutomaticPointerMoveSchema.parse({ ...last, target: { ...last.target, authority: { ...last.target.authority, processGeneration: 5 } } });
    expect(follow([move(1, 2, 5), newerProcess])).toMatchObject({ action: "advance_pointer_revision", target: authorityFor(1) });
  });

  test("explicit and Claude sessions stay pinned and current policy can disable following", () => {
    const input = { session: managedSession(), configuration: initialAutomaticUsagePolicyConfiguration(), throughPointerRevision: 7, moves: [move(1, 2, 5), move(2, 3, 6)] };
    expect(followSettledAutomaticPointerMoves({ ...input, session: { ...input.session, routingProvenance: "explicit", appliedPointerRevision: null } })).toEqual({ action: "stay", reason: "explicit_session" });
    expect(followSettledAutomaticPointerMoves({ ...input, configuration: { ...input.configuration, defaultEnabled: false } })).toEqual({ action: "disabled", reason: "policy_disabled" });
    expect(follow([], 5)).toEqual({ action: "stay", reason: "already_applied" });
  });

  test("gaps, branches, duplicate identity, resets and substituted bindings reconcile", () => {
    for (const moves of [[move(2, 3, 6)], [move(1, 2, 5)], [move(1, 2, 5), move(1, 3, 5)], [move(1, 2, 5), move(1, 3, 6)]]) {
      expect(follow(moves).action).toBe("reconciliation_required");
    }
    expect(follow([], 4)).toEqual({ action: "reconciliation_required", reason: "lineage_gap" });
    const second = move(2, 3, 6);
    const changed = settledAutomaticPointerMoveSchema.parse({ ...second, authority: { ...second.authority, source: { ...second.authority.source, authority: { ...second.authority.source.authority, bindingGeneration: 3 } } } });
    expect(follow([move(1, 2, 5), changed])).toEqual({ action: "reconciliation_required", reason: "lineage_authority_mismatch" });
  });

  test("settled schema rejects proposals, expired evidence and noncontiguous revisions", () => {
    const original = move(1, 2, 5);
    for (const patch of [
      { toPointerRevision: 7 }, { kind: "propose_pointer_move" },
      { settledAt: now + 90_001 }, { settledAt: now - 1 },
      { target: { ...original.target, firstResetAt: now } },
      { target: { ...original.target, receivedAt: now + 1 } },
    ]) expect(settledAutomaticPointerMoveSchema.safeParse({ ...original, ...patch }).success).toBe(false);
    expect(settledAutomaticPointerMoveSchema.safeParse({ ...original, settledAt: now + 90_000 }).success).toBe(true);
  });

  test("rejects future policy authority, decreasing order revisions and impossible settlement order", () => {
    const first = move(1, 2, 5);
    const second = move(2, 3, 6);
    for (const authority of [
      { ...second.authority, automaticPolicyRevision: 2 },
      { ...second.authority, orderRevision: 2 },
      { ...second.authority, evaluatedAt: now - 1, source: { ...second.authority.source, receivedAt: now - 1 } },
    ]) {
      const amended = { ...second, authority, target: { ...second.target, receivedAt: now - 1 } };
      expect(follow([first, settledAutomaticPointerMoveSchema.parse(amended)])).toEqual({ action: "reconciliation_required", reason: "invalid_lineage" });
    }
  });
});
