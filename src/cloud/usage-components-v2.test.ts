import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

import {
  parseUsageComponentsV2,
  USAGE_COMPONENTS_V2_CLAUDE_MAX_JSON_BYTES,
  USAGE_COMPONENTS_V2_CODEX_MAX_JSON_BYTES,
  USAGE_COMPONENTS_V2_MAX_JSON_BYTES,
} from "./usage-components-v2";

// Synthetic public components, not captured provider responses, source proofs
// or a producer contract. Every factory allocates independent JSON objects.
const policy = () => ({ state: "configured", revision: 1, defaultEnabled: false, override: "on" });
const readiness = () => ({ state: "cached", value: "signed_in", observedAt: null });
const tokens = (value: number | null = null) => ({
  inputTokens: value, cacheReadInputTokens: value, cacheCreationInputTokens: value,
  outputTokens: value, thinkingTokens: value,
});
const codexWindow = () => ({ usedPercent: 0, windowDurationMins: null, resetsAtMs: null });
const codex = () => ({
  provider: "codex",
  quota: {
    state: "observed", source: "codex_app_server", observedAt: 200, receivedAt: 100,
    data: {
      resetCreditsAvailable: null,
      limits: [{ id: "legacy:primary", rateLimitReachedType: null, primary: codexWindow(), secondary: null }],
    },
  },
  accounting: { state: "unavailable", reason: "not_projected" },
  readiness: readiness(), automaticPolicy: policy(),
});
const claude = () => ({
  provider: "claude",
  quota: {
    state: "observed", source: "claude_rate_limit_event", observedAt: 100, receivedAt: 100,
    data: {
      status: { state: "known", value: "warning" }, rateLimitType: null, resetsAtMs: null,
      overageStatus: null, overageDisabledReason: null, isUsingOverage: null,
      windows: [{ id: "five_hour", scope: "account", usedPercent: 0, resetsAtMs: 1_000 }],
    },
  },
  accounting: {
    state: "observed", source: "claude_result", observedAt: 200, receivedAt: 200,
    data: {
      totalCostUsd: null, ...tokens(),
      models: [{ model: "claude-fable-5-1", costUsd: null, ...tokens(), contextWindow: null, maxOutputTokens: null }],
    },
  },
  readiness: readiness(), automaticPolicy: policy(),
});

function replaceAt(input: unknown, path: string, replacement: unknown): unknown {
  const result = structuredClone(input) as Record<string, unknown>;
  const parts = path.split(".");
  let parent = result;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  parent[parts.at(-1) as string] = replacement;
  return result;
}

// Foreign fixtures intentionally have unknown or widened fields. Compare the
// raw values without asserting that those fixtures already satisfy the parser.
function expectRawEqual(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
  }
  return value;
}

function expectFrozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) expectFrozen(child);
  }
}

function permuteJson(value: unknown, offset: number): unknown {
  if (Array.isArray(value)) {
    const rows = value.map((row) => permuteJson(row, offset));
    const start = rows.length === 0 ? 0 : offset % rows.length;
    return [...rows.slice(start), ...rows.slice(0, start)].reverse();
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse()
      .map(([key, child]) => [key, permuteJson(child, offset)]));
  }
  return value;
}

function objectReferences(value: unknown, references = new Set<object>()): Set<object> {
  if (value !== null && typeof value === "object") {
    references.add(value);
    for (const child of Object.values(value)) objectReferences(child, references);
  }
  return references;
}

const nullableCounterArbitrary = fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: null });
const nullableAmountArbitrary = fc.option(fc.double({ min: 0, max: 1_000_000, noNaN: true }), { nil: null });
const tokenArbitrary = fc.record({
  inputTokens: nullableCounterArbitrary,
  cacheReadInputTokens: nullableCounterArbitrary,
  cacheCreationInputTokens: nullableCounterArbitrary,
  outputTokens: nullableCounterArbitrary,
  thinkingTokens: nullableCounterArbitrary,
});
const validComponentsArbitrary = fc.record({
  provider: fc.constantFrom("codex", "claude"),
  quotaTime: fc.integer({ min: 0, max: 1_000_000 }),
  otherTime: fc.integer({ min: 0, max: 1_000_000 }),
  readinessTime: nullableCounterArbitrary,
  readinessValue: fc.constantFrom("unverified", "signed_out", "login_pending", "signed_in", "recovery_required"),
  revision: fc.integer({ min: 1, max: 1_000_000 }),
  defaultEnabled: fc.boolean(),
  override: fc.constantFrom("inherit", "on", "off"),
  credits: nullableCounterArbitrary,
  code: fc.option(fc.constantFrom("allowed", "overage_enabled", "future.status+1"), { nil: null }),
  overage: fc.option(fc.boolean(), { nil: null }),
  resetTime: nullableCounterArbitrary,
  totalCost: nullableAmountArbitrary,
  tokens: tokenArbitrary,
  rows: fc.uniqueArray(fc.record({
    id: fc.integer({ min: 0, max: 1_000 }),
    usedPercent: fc.double({ min: 0, max: 100, noNaN: true }),
    duration: nullableAmountArbitrary,
    resetTime: nullableCounterArbitrary,
    primary: fc.boolean(), secondary: fc.boolean(),
    cost: nullableAmountArbitrary,
    tokens: tokenArbitrary,
    contextWindow: nullableCounterArbitrary,
    maxOutputTokens: nullableCounterArbitrary,
  }), { maxLength: 5, selector: (row) => row.id }),
}).map((generated) => {
  const common = {
    readiness: { ...readiness(), value: generated.readinessValue, observedAt: generated.readinessTime },
    automaticPolicy: { ...policy(), revision: generated.revision, defaultEnabled: generated.defaultEnabled, override: generated.override },
  };
  if (generated.provider === "codex") {
    const base = codex();
    return {
      ...base, ...common,
      quota: {
        ...base.quota, observedAt: generated.quotaTime, receivedAt: generated.otherTime,
        data: {
          resetCreditsAvailable: generated.credits,
          limits: generated.rows.map((row) => {
            const window = () => ({ usedPercent: row.usedPercent, windowDurationMins: row.duration, resetsAtMs: row.resetTime });
            return { id: `limit:${row.id}`, rateLimitReachedType: generated.code,
              primary: row.primary ? window() : null, secondary: row.secondary ? window() : null };
          }),
        },
      },
    };
  }
  const base = claude();
  return {
    ...base, ...common,
    quota: {
      ...base.quota, observedAt: generated.quotaTime, receivedAt: generated.quotaTime,
      data: {
        ...base.quota.data, rateLimitType: generated.code, resetsAtMs: generated.resetTime,
        overageStatus: generated.code, overageDisabledReason: generated.code, isUsingOverage: generated.overage,
        windows: generated.rows.map((row) => ({ id: `window:${row.id}`, scope: "account", usedPercent: row.usedPercent, resetsAtMs: generated.quotaTime })),
      },
    },
    accounting: {
      ...base.accounting, observedAt: generated.otherTime, receivedAt: generated.otherTime,
      data: {
        totalCostUsd: generated.totalCost, ...generated.tokens,
        models: generated.rows.map((row) => ({ model: `model/${row.id}`, costUsd: row.cost,
          ...row.tokens, contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens })),
      },
    },
  };
});

// A finite nonnegative number whose JSON encoding occupies all 24 allowed
// bytes. With complete full-width rows it makes both symbolic maxima reachable.
const maximumNumberJsonWitness = 0.0000010000000000000002;

function maximumCodex() {
  const window = () => ({
    usedPercent: maximumNumberJsonWitness,
    windowDurationMins: maximumNumberJsonWitness,
    resetsAtMs: Number.MAX_SAFE_INTEGER,
  });
  return {
    ...codex(),
    quota: {
      state: "observed", source: "codex_app_server",
      observedAt: Number.MAX_SAFE_INTEGER, receivedAt: Number.MAX_SAFE_INTEGER,
      data: {
        resetCreditsAvailable: Number.MAX_SAFE_INTEGER,
        limits: Array.from({ length: 101 }, (_, index) => ({
          id: String(index).padStart(256, "a"), rateLimitReachedType: "a".repeat(128),
          primary: window(), secondary: window(),
        })),
      },
    },
    readiness: { state: "cached", value: "recovery_required", observedAt: Number.MAX_SAFE_INTEGER },
    automaticPolicy: { state: "configured", revision: Number.MAX_SAFE_INTEGER, defaultEnabled: false, override: "inherit" },
  };
}

function maximumClaude() {
  return {
    ...claude(),
    quota: {
      state: "observed", source: "claude_rate_limit_event",
      observedAt: Number.MAX_SAFE_INTEGER, receivedAt: Number.MAX_SAFE_INTEGER,
      data: {
        status: { state: "unknown", value: "a".repeat(128) }, rateLimitType: "a".repeat(128),
        resetsAtMs: Number.MAX_SAFE_INTEGER, overageStatus: "a".repeat(128),
        overageDisabledReason: "a".repeat(128), isUsingOverage: false,
        windows: Array.from({ length: 16 }, (_, index) => ({
          id: String(index).padStart(128, "a"), scope: "account",
          usedPercent: maximumNumberJsonWitness, resetsAtMs: Number.MAX_SAFE_INTEGER,
        })),
      },
    },
    accounting: {
      state: "observed", source: "claude_result",
      observedAt: Number.MAX_SAFE_INTEGER, receivedAt: Number.MAX_SAFE_INTEGER,
      data: {
        totalCostUsd: maximumNumberJsonWitness, ...tokens(Number.MAX_SAFE_INTEGER),
        models: Array.from({ length: 32 }, (_, index) => ({
          model: String(index).padStart(128, "a"), costUsd: maximumNumberJsonWitness,
          ...tokens(Number.MAX_SAFE_INTEGER), contextWindow: Number.MAX_SAFE_INTEGER,
          maxOutputTokens: Number.MAX_SAFE_INTEGER,
        })),
      },
    },
    readiness: { state: "cached", value: "recovery_required", observedAt: Number.MAX_SAFE_INTEGER },
    automaticPolicy: { state: "configured", revision: Number.MAX_SAFE_INTEGER, defaultEnabled: false, override: "inherit" },
  };
}

describe("standalone usage components v2", () => {
  test("keeps null, observed zero and unavailable separate without defaults", () => {
    for (const input of [codex(), claude()]) expectRawEqual(parseUsageComponentsV2(input), input);
    const zero = replaceAt(codex(), "quota.data.resetCreditsAvailable", 0);
    expectRawEqual(parseUsageComponentsV2(zero), zero);
    expect(JSON.stringify(parseUsageComponentsV2(zero))).not.toBe(JSON.stringify(parseUsageComponentsV2(codex())));
    for (const reason of ["not_observed", "identity_unavailable", "source_unavailable", "representation_limit"]) {
      for (const input of [codex(), claude()]) {
        const absent = replaceAt(input, "quota", { state: "unavailable", reason });
        expectRawEqual(parseUsageComponentsV2(absent), absent);
      }
      const absent = replaceAt(claude(), "accounting", { state: "unavailable", reason });
      expectRawEqual(parseUsageComponentsV2(absent), absent);
    }
    for (const [path, value] of [
      ["readiness", { state: "unavailable", reason: "source_unavailable" }],
      ["automaticPolicy", { state: "unavailable", reason: "configuration_unavailable" }],
      ["quota.data.limits", []],
    ] as const) {
      const input = replaceAt(codex(), path, value);
      expectRawEqual(parseUsageComponentsV2(input), input);
    }
    for (const path of ["quota.data.resetCreditsAvailable", "readiness.observedAt", "automaticPolicy.revision"]) {
      expect(parseUsageComponentsV2(replaceAt(codex(), path, undefined))).toBeNull();
    }
    for (const path of ["accounting.data.totalCostUsd", "accounting.data.inputTokens", "accounting.data.models.0.costUsd"]) {
      const input = replaceAt(claude(), path, 0);
      expectRawEqual(parseUsageComponentsV2(input), input);
    }
  });

  test("couples provider and source but preserves independent component clocks", () => {
    const before = parseUsageComponentsV2(claude());
    const next = claude();
    next.accounting.observedAt = 5_000;
    next.accounting.receivedAt = 5_000;
    next.automaticPolicy.revision = 20;
    expect(parseUsageComponentsV2(next)?.quota).toEqual(before?.quota);
    expect(parseUsageComponentsV2(codex())).not.toBeNull(); // receive clock can be behind observed clock
    for (const path of ["quota.observedAt", "quota.receivedAt", "accounting.observedAt", "accounting.receivedAt"]) {
      expect(parseUsageComponentsV2(replaceAt(claude(), path, 999))).toBeNull();
    }
    for (const [input, path, replacement] of [
      [codex(), "provider", "claude"], [claude(), "provider", "codex"],
      [codex(), "quota.source", "claude_rate_limit_event"], [claude(), "quota.source", "codex_app_server"],
      [claude(), "accounting.source", "claude_rate_limit_event"],
      [codex(), "accounting", claude().accounting],
      [codex(), "accounting.reason", "not_observed"], [claude(), "provider", "devin"],
    ] as const) expect(parseUsageComponentsV2(replaceAt(input, path, replacement))).toBeNull();
  });

  test("accepts only the closed readiness, policy and status alternatives", () => {
    for (const value of ["unverified", "signed_out", "login_pending", "signed_in", "recovery_required"]) {
      expect(parseUsageComponentsV2(replaceAt(codex(), "readiness.value", value))).not.toBeNull();
    }
    for (const override of ["inherit", "on", "off"]) for (const defaultEnabled of [true, false]) {
      const input = replaceAt(codex(), "automaticPolicy", { state: "configured", revision: 1, defaultEnabled, override });
      expectRawEqual(parseUsageComponentsV2(input), input);
    }
    for (const value of ["allowed", "warning", "blocked", "denied", "rejected"]) {
      expect(parseUsageComponentsV2(replaceAt(claude(), "quota.data.status.value", value))).not.toBeNull();
    }
    const unknown = replaceAt(claude(), "quota.data.status", { state: "unknown", value: "future.status+1" });
    expectRawEqual(parseUsageComponentsV2(unknown), unknown);
    for (const [input, path, value] of [
      [codex(), "readiness.value", "removed"], [codex(), "automaticPolicy.override", "enabled"],
      [claude(), "quota.data.status.value", "future"], [claude(), "quota.data.windows.0.scope", "model"],
      [claude(), "quota.data.isUsingOverage", 0], [codex(), "automaticPolicy.defaultEnabled", 1],
    ] as const) expect(parseUsageComponentsV2(replaceAt(input, path, value))).toBeNull();
  });

  test("rejects private, authority, history and future fields at every nesting level", () => {
    const paths = [
      "localProfileId", "version", "sourceId", "headRevision", "executionAuthority",
      "quota.authority", "quota.turn", "quota.observationRevision", "quota.componentDigest",
      "quota.data.credits", "quota.data.limits.0.limitId", "quota.data.limits.0.limitName",
      "quota.data.limits.0.planType", "quota.data.limits.0.unlimited", "quota.data.limits.0.primary.fresh",
      "accounting.daily", "readiness.profileId", "readiness.receivedAt",
      "automaticPolicy.updatedAt", "automaticPolicy.enabled", "automaticPolicy.resetPolicyRevision",
    ];
    for (const path of paths) expect(parseUsageComponentsV2(replaceAt(codex(), path, "private"))).toBeNull();
    for (const path of ["quota.data.status.reason", "quota.data.windows.0.model", "accounting.data.turnId", "accounting.data.models.0.quota"]) {
      expect(parseUsageComponentsV2(replaceAt(claude(), path, "private"))).toBeNull();
    }
  });

  test("rejects invalid numbers without clamping, truncation or invented zeros", () => {
    for (const input of [codex(), claude()]) {
      for (const path of ["quota.observedAt", "quota.receivedAt", "readiness.observedAt", "automaticPolicy.revision"]) {
        for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1"]) {
          expect(parseUsageComponentsV2(replaceAt(input, path, bad))).toBeNull();
        }
      }
    }
    expect(parseUsageComponentsV2(replaceAt(codex(), "automaticPolicy.revision", 0))).toBeNull();
    for (const bad of [-1, 100.000001, NaN, Infinity, null, "0"]) {
      expect(parseUsageComponentsV2(replaceAt(codex(), "quota.data.limits.0.primary.usedPercent", bad))).toBeNull();
      expect(parseUsageComponentsV2(replaceAt(claude(), "quota.data.windows.0.usedPercent", bad))).toBeNull();
    }
    for (const value of [0, 0.5, Number.MAX_VALUE, null]) {
      expect(parseUsageComponentsV2(replaceAt(codex(), "quota.data.limits.0.primary.windowDurationMins", value))).not.toBeNull();
    }
    for (const path of ["accounting.data.totalCostUsd", "accounting.data.models.0.costUsd"]) {
      for (const bad of [-1, Number.MAX_VALUE, NaN, Infinity, "0"]) {
        expect(parseUsageComponentsV2(replaceAt(claude(), path, bad))).toBeNull();
      }
    }
    for (const path of ["accounting.data.inputTokens", "accounting.data.models.0.maxOutputTokens", "quota.data.resetCreditsAvailable"]) {
      const input = path.startsWith("accounting") ? claude() : codex();
      for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "0"]) {
        expect(parseUsageComponentsV2(replaceAt(input, path, bad))).toBeNull();
      }
    }
  });

  test("rejects all canonical secret families and unsafe public codes without redaction", () => {
    const credentialShapes = [
      ["sk", "_", "a".repeat(12)].join(""), ["SK", "_", "a".repeat(12)].join(""),
      ["sk", "-proj-", "a".repeat(12)].join(""), ["ghp", "_", "a".repeat(12)].join(""),
      ["github", "_pat_", "a".repeat(12)].join(""), ["xoxb", "-", "a".repeat(12)].join(""),
      ["AK", "IA", "A".repeat(12)].join(""), ["glpat", "-", "a".repeat(20)].join(""),
      ["hf", "_", "a".repeat(30)].join(""), ["npm", "_", "a".repeat(36)].join(""),
      ["AI", "za", "a".repeat(35)].join(""), ["A", "a", "1", "b".repeat(37)].join(""),
      ["ey", "J", "a".repeat(12), ".", "b".repeat(12)].join(""),
      ["api", "_key:", "value"].join(""), ["Authorization", ":", "value"].join(""),
    ];
    const badCodes = [...credentialShapes, "", "a".repeat(257), "spaces here", "é", "a\n", "/private/data", "prefix:/private/data", "C:/private/data", "../private/data", "a\\b", "a\"b", "a\u202eb"];
    for (const code of badCodes) {
      expect(parseUsageComponentsV2(replaceAt(codex(), "quota.data.limits.0.id", code))).toBeNull();
      for (const path of ["quota.data.rateLimitType", "quota.data.overageStatus", "quota.data.overageDisabledReason", "quota.data.windows.0.id", "accounting.data.models.0.model"]) {
        expect(parseUsageComponentsV2(replaceAt(claude(), path, code))).toBeNull();
      }
    }
    for (const code of ["a".repeat(129), ...credentialShapes]) {
      expect(parseUsageComponentsV2(replaceAt(codex(), "quota.data.limits.0.rateLimitReachedType", code))).toBeNull();
      expect(parseUsageComponentsV2(replaceAt(claude(), "quota.data.status", { state: "unknown", value: code }))).toBeNull();
    }
    for (const code of ["model/v1", "A", "+x", "limit:codex", "a.b-c_1"]) {
      expect(parseUsageComponentsV2(replaceAt(codex(), "quota.data.limits.0.id", code))).not.toBeNull();
    }
  });

  test("keeps complete collections and rejects duplicates, overflow and malformed members", () => {
    const cases = [
      { input: maximumCodex(), path: "quota.data.limits", rows: maximumCodex().quota.data.limits },
      { input: maximumClaude(), path: "quota.data.windows", rows: maximumClaude().quota.data.windows },
      { input: maximumClaude(), path: "accounting.data.models", rows: maximumClaude().accounting.data.models },
    ];
    for (const { input, path, rows } of cases) {
      expect(parseUsageComponentsV2(input)).not.toBeNull();
      expect(parseUsageComponentsV2(replaceAt(input, path, [...rows, structuredClone(rows[0])]))).toBeNull();
      expect(parseUsageComponentsV2(replaceAt(input, path, [structuredClone(rows[0]), structuredClone(rows[0])]))).toBeNull();
      expect(parseUsageComponentsV2(replaceAt(input, `${path}.0`, null))).toBeNull();
      expect(parseUsageComponentsV2(replaceAt(input, path, []))).not.toBeNull();
    }
  });

  test("rejects unique count overflow independently of row validation and JSON byte limits", () => {
    const cases = [
      {
        input: codex(), path: "quota.data.limits", limit: 101,
        bytes: USAGE_COMPONENTS_V2_CODEX_MAX_JSON_BYTES,
        rows: Array.from({ length: 102 }, (_, index) => ({
          id: `limit:${index}`, rateLimitReachedType: null, primary: null, secondary: null,
        })),
      },
      {
        input: claude(), path: "quota.data.windows", limit: 16,
        bytes: USAGE_COMPONENTS_V2_CLAUDE_MAX_JSON_BYTES,
        rows: Array.from({ length: 17 }, (_, index) => ({
          id: `window:${index}`, scope: "account", usedPercent: 0, resetsAtMs: 0,
        })),
      },
      {
        input: claude(), path: "accounting.data.models", limit: 32,
        bytes: USAGE_COMPONENTS_V2_CLAUDE_MAX_JSON_BYTES,
        rows: Array.from({ length: 33 }, (_, index) => ({
          model: `model:${index}`, costUsd: null, ...tokens(), contextWindow: null, maxOutputTokens: null,
        })),
      },
    ];
    for (const { input, path, limit, bytes, rows } of cases) {
      expect(rows).toHaveLength(limit + 1);
      expect(new Set(rows.map((row) => "id" in row ? row.id : row.model)).size).toBe(limit + 1);
      // Each row independently passes; no duplicate, malformed member, shared
      // object alias or oversized encoding can explain the final refusal.
      for (const row of rows) expect(parseUsageComponentsV2(replaceAt(input, path, [row]))).not.toBeNull();
      expect(parseUsageComponentsV2(replaceAt(input, path, rows.slice(0, limit)))).not.toBeNull();
      const overflow = replaceAt(input, path, rows);
      expect(new TextEncoder().encode(JSON.stringify(overflow)).byteLength).toBeLessThan(bytes);
      expect(parseUsageComponentsV2(overflow)).toBeNull();
    }
  });

  test("canonicalizes key and ID order into detached deeply frozen output", () => {
    for (const input of [maximumCodex(), maximumClaude()]) {
      const canonical = parseUsageComponentsV2(input);
      expect(canonical).not.toBeNull();
      expectFrozen(canonical);
      expect(JSON.stringify(parseUsageComponentsV2(reverseKeys(input)))).toBe(JSON.stringify(canonical));
      const permuted = structuredClone(input);
      if ("limits" in permuted.quota.data) permuted.quota.data.limits.reverse();
      else permuted.quota.data.windows.reverse();
      if ("data" in permuted.accounting) permuted.accounting.data.models.reverse();
      expect(JSON.stringify(parseUsageComponentsV2(permuted))).toBe(JSON.stringify(canonical));
      permuted.automaticPolicy.revision = 2;
      expectRawEqual(canonical?.automaticPolicy, input.automaticPolicy);
      expect(parseUsageComponentsV2(canonical)).toEqual(canonical);
    }
    const input = codex();
    input.quota.data.limits = ["a", "_", "A", "+x"].map((id) => ({
      id, rateLimitReachedType: null, primary: codexWindow(), secondary: null,
    }));
    const result = parseUsageComponentsV2(input);
    if (result?.provider !== "codex" || result.quota.state !== "observed") throw new Error("Expected Codex data");
    expect(result.quota.data.limits.map((row) => row.id)).toEqual(["+x", "A", "_", "a"]);
    expect(input.quota.data.limits.map((row) => row.id)).toEqual(["a", "_", "A", "+x"]);
  });

  test("is total over malformed graphs without invoking accessors", () => {
    let getterCalls = 0;
    const getter = codex();
    Object.defineProperty(getter, "quota", { enumerable: true, get() { getterCalls += 1; throw new Error("must not read"); } });
    const nestedGetter = codex();
    Object.defineProperty(nestedGetter.quota.data.limits[0], "id", { enumerable: true, get() { getterCalls += 1; return "bad"; } });
    const sparse = codex();
    sparse.quota.data.limits.length = 2;
    const alias = codex();
    const repeatedWindow = codexWindow();
    const aliased = replaceAt(alias, "quota.data.limits.0", { id: "x", rateLimitReachedType: null, primary: repeatedWindow, secondary: repeatedWindow });
    const cyclic: Record<string, unknown> = { ...codex() };
    cyclic.cycle = cyclic;
    const hidden = codex();
    Object.defineProperty(hidden, "private", { value: "hidden", enumerable: false });
    const symbol = { ...codex(), [Symbol("private")]: 1 };
    const exotic = Object.setPrototypeOf(codex(), { inherited: true }) as unknown;
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("no prototype"); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const input of [undefined, null, true, 0, "{}", [], new Date(), new Map(), 1n, () => 0,
      getter, nestedGetter, sparse, aliased, cyclic, hidden, symbol, exotic, proxy, revoked.proxy]) {
      expect(() => parseUsageComponentsV2(input)).not.toThrow();
      expect(parseUsageComponentsV2(input)).toBeNull();
    }
    expect(getterCalls).toBe(0);
    const plain = Object.assign(Object.create(null) as Record<string, unknown>, codex());
    expectRawEqual(parseUsageComponentsV2(plain), codex());
  });

  test("seeded foreign JSON and non-JSON primitives never escape the closed parser", () => {
    const foreign = fc.oneof(
      fc.jsonValue({ maxDepth: 3 }),
      fc.bigInt({ min: -1_000n, max: 1_000n }),
      fc.constantFrom(undefined, NaN, Infinity, -Infinity, Symbol("foreign"), () => 0),
    );
    fc.assert(fc.property(foreign, (value) => {
      expect(() => parseUsageComponentsV2(value)).not.toThrow();
      const parsed = parseUsageComponentsV2(value);
      if (parsed !== null) {
        expect(parseUsageComponentsV2(parsed)).toEqual(parsed);
        expectFrozen(parsed);
      }
      expect(() => parseUsageComponentsV2(replaceAt(codex(), "quota.data.limits.0.primary", value))).not.toThrow();
    }), { numRuns: 200, seed: 68_021 });
  });

  test("seeded valid components preserve canonical bytes, detachment and freezing under permutations", () => {
    fc.assert(fc.property(validComponentsArbitrary, fc.integer({ min: 0, max: 100 }), (generated, offset) => {
      // Keep the generator's value intact for reproducible shrinking while
      // exercising mutation of the caller-owned parser input below.
      const input = structuredClone(generated);
      const original = JSON.stringify(input);
      const parsed = parseUsageComponentsV2(input);
      expect(parsed).not.toBeNull();
      if (parsed === null) throw new Error("Generated component must be valid");
      const canonical = JSON.stringify(parsed);
      expect(JSON.stringify(input)).toBe(original);
      expect(JSON.stringify(parseUsageComponentsV2(parsed))).toBe(canonical);
      expect(JSON.stringify(parseUsageComponentsV2(JSON.parse(canonical) as unknown))).toBe(canonical);
      expect(JSON.stringify(parseUsageComponentsV2(permuteJson(input, offset)))).toBe(canonical);
      expectFrozen(parsed);
      const inputObjects = objectReferences(input);
      for (const outputObject of objectReferences(parsed)) expect(inputObjects.has(outputObject)).toBe(false);
      input.quota.source = "caller-mutated";
      expect(JSON.stringify(parsed)).toBe(canonical);
      expect(Object.isFrozen(input.quota)).toBe(false);
    }), { numRuns: 200, seed: 68_022 });
  });

  test("pins conservative symbolic JSON bounds and measures full-width complete fixtures", () => {
    expect(JSON.stringify(maximumNumberJsonWitness)).toHaveLength(24);
    const literal = (value: string) => JSON.stringify(value).length;
    const object = (fields: Record<string, number>) => 2 + Object.entries(fields)
      .reduce((sum, [key, value]) => sum + literal(key) + 1 + value, 0) + Object.keys(fields).length - 1;
    const array = (count: number, item: number) => 2 + count * item + count - 1;
    const observed = (source: string, data: number) => object({ state: literal("observed"), source: literal(source), observedAt: 16, receivedAt: 16, data });
    const window = object({ usedPercent: 24, windowDurationMins: 24, resetsAtMs: 16 });
    const limit = object({ id: 258, rateLimitReachedType: 130, primary: window, secondary: window });
    expect(limit).toBe(675);
    const quota = object({ resetCreditsAvailable: 16, limits: array(101, limit) });
    const claudeQuota = object({
      status: object({ state: literal("unknown"), value: 130 }), rateLimitType: 130, resetsAtMs: 16,
      overageStatus: 130, overageDisabledReason: 130, isUsingOverage: 5,
      windows: array(16, object({ id: 130, scope: literal("account"), usedPercent: 24, resetsAtMs: 16 })),
    });
    expect(claudeQuota).toBe(4_283);
    const tokenBounds = tokens(16) as Record<string, number>;
    const model = object({ model: 130, costUsd: 24, ...tokenBounds, contextWindow: 16, maxOutputTokens: 16 });
    const accounting = object({ totalCostUsd: 24, ...tokenBounds, models: array(32, model) });
    expect(accounting).toBe(13_833);
    const common = {
      readiness: object({ state: literal("cached"), value: literal("recovery_required"), observedAt: 16 }),
      automaticPolicy: object({ state: literal("configured"), revision: 16, defaultEnabled: 5, override: literal("inherit") }),
    };
    const codexBound = object({ provider: literal("codex"), quota: observed("codex_app_server", quota),
      accounting: object({ state: literal("unavailable"), reason: literal("not_projected") }), ...common });
    const claudeBound = object({ provider: literal("claude"), quota: observed("claude_rate_limit_event", claudeQuota),
      accounting: observed("claude_result", accounting), ...common });
    expect(codexBound).toBe(68_738);
    expect(claudeBound).toBe(18_598);
    expect(USAGE_COMPONENTS_V2_CODEX_MAX_JSON_BYTES).toBe(codexBound);
    expect(USAGE_COMPONENTS_V2_CLAUDE_MAX_JSON_BYTES).toBe(claudeBound);
    expect(USAGE_COMPONENTS_V2_MAX_JSON_BYTES).toBe(codexBound);
    for (const [input, maximum] of [[maximumCodex(), codexBound], [maximumClaude(), claudeBound]] as const) {
      const parsed = parseUsageComponentsV2(input);
      expect(parsed).not.toBeNull();
      const bytes = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
      expect(bytes).toBe(maximum);
    }
  });

  test("bundles for a browser in memory without native or provider dependencies", async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./usage-components-v2.ts", import.meta.url))],
      // Bun 1.3.14 keeps outputs in memory when outdir is omitted.
      target: "browser",
    });
    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    expect(result.outputs).toHaveLength(1);
    const bundle = await result.outputs[0]?.text();
    expect(bundle).toContain("parseUsageComponentsV2");
    expect(bundle).not.toMatch(/(?:node:|bun:sqlite|StateStore|createHash|randomUUID)/u);
  });
});
