import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { localCommandSchema } from "./contracts";
import {
  PROVIDER_ACCOUNT_LIST_MAX_BYTES,
  PROVIDER_ACCOUNT_LIST_MAX_COUNT,
  providerAccountListResultSchema,
} from "./provider-account-list";
import type { UsageProvider } from "./provider-usage";
import { utf8Bytes } from "./values";

function fixture(provider: UsageProvider = "codex", count = 2) {
  const accounts = Array.from({ length: count }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(32, "0");
    return { id: `${provider === "codex" ? "acct" : "pact"}_${suffix}`, profileId: `acct_${suffix}`,
      label: `Account ${String(index + 1)}`, readiness: "signed_in" as const,
      readinessObservedAt: index === 0 ? null : 1_900_000_000_000,
      orderPosition: index + 1, active: index === 0 };
  });
  return { version: 1 as const, provider, orderRevision: 3, pointerRevision: 4,
    activeProviderAccountId: accounts[0]?.id ?? null, accounts };
}

describe("cached provider account list contract", () => {
  test("keeps the unqualified command unchanged and closes the provider-qualified grammar", () => {
    expect(localCommandSchema.parse({ kind: "account.list" })).toEqual({ kind: "account.list" });
    for (const provider of ["codex", "claude"] as const) {
      expect(localCommandSchema.parse({ kind: "account.list", provider })).toEqual({ kind: "account.list", provider });
    }
    for (const extra of [
      { provider: "devin" }, { provider: "unknown" }, { provider: null }, { refresh: true },
      { provider: "codex", idempotencyKey: "00000000-0000-4000-8000-000000000001" },
      { provider: "claude", authority: {} },
    ]) expect(localCommandSchema.safeParse({ kind: "account.list", ...extra }).success).toBe(false);
  });

  test("parses detached deeply readonly empty and populated results for each provider", () => {
    for (const provider of ["codex", "claude"] as const) {
      for (const count of [0, 2]) {
        const source = fixture(provider, count);
        const result = providerAccountListResultSchema.parse(source);
        expect(result).toEqual(source);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.accounts)).toBe(true);
        const original = result.accounts[0];
        const mutable = source.accounts[0];
        if (original !== undefined && mutable !== undefined) {
          expect(Object.isFrozen(original)).toBe(true);
          mutable.label = "Changed after parsing";
          expect(original.label).toBe("Account 1");
          source.accounts.reverse();
          expect(result.accounts[0]).toEqual(original);
        }
      }
    }
  });

  test("rejects foreign/private fields, wrong identities, non-total order and mismatched default", () => {
    const source = fixture();
    const first = source.accounts[0];
    const second = source.accounts[1];
    if (first === undefined || second === undefined) throw new Error("Missing fixture accounts.");
    const variants = [
      { ...source, version: 2 }, { ...source, provider: "claude" }, { ...source, provider: "devin" },
      { ...source, providerEmail: "private@example.com" }, { ...source, raw: {} },
      { ...source, orderRevision: 0 }, { ...source, pointerRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...source, activeProviderAccountId: null },
      { ...source, activeProviderAccountId: "acct_ffffffffffffffffffffffffffffffff" },
      { ...fixture("codex", 0), activeProviderAccountId: first.id },
      { ...source, accounts: [first, first] }, { ...source, accounts: source.accounts.toReversed() },
      ...[
        { ...first, id: "pact_00000000000000000000000000000001" },
        { ...first, profileId: second.profileId }, { ...first, orderPosition: 0 },
        { ...first, active: false }, { ...first, readiness: "removed" },
        { ...first, readinessObservedAt: -1 }, { ...first, readinessObservedAt: 0.5 },
        { ...first, readinessObservedAt: Number.MAX_SAFE_INTEGER + 1 },
        { ...first, readinessObservedAt: undefined }, { ...first, label: " Account 1 " },
        { ...first, label: "" }, { ...first, label: "é".repeat(81) },
        { ...first, label: second.label.toUpperCase() },
        { ...first, providerEmail: "private@example.com" }, { ...first, processGeneration: 10 },
      ].map((account) => ({ ...source, accounts: [account, second] })),
    ];
    for (const value of variants) expect(providerAccountListResultSchema.safeParse(value).success).toBe(false);
    const claude = fixture("claude");
    expect(providerAccountListResultSchema.safeParse({ ...claude,
      accounts: claude.accounts.map((account) => ({ ...account, profileId: first.profileId })),
    }).success).toBe(false);
  });

  test("preserves display Unicode, control scalars and nullable or clock-skewed observation times", () => {
    for (const label of ["Ａccount", "é", "e\u0301", "a\u001bb", "name@example.com"]) {
      const source = fixture("claude", 1);
      const first = source.accounts[0];
      if (first === undefined) throw new Error("Missing fixture account.");
      first.label = label;
      first.readinessObservedAt = Number.MAX_SAFE_INTEGER;
      expect(providerAccountListResultSchema.parse(source)).toEqual(source);
      first.readinessObservedAt = null;
      expect(providerAccountListResultSchema.parse(source).accounts[0]?.readinessObservedAt).toBeNull();
    }
    const source = fixture("claude");
    expect(providerAccountListResultSchema.safeParse({ ...source,
      accounts: source.accounts.map((account, index) => ({ ...account, label: index === 0 ? "Ａccount" : "account" })),
    }).success).toBe(false);
  });

  test("bounds count and actual canonical JSON bytes without truncating a result", () => {
    const largestCount = fixture("codex", PROVIDER_ACCOUNT_LIST_MAX_COUNT);
    expect(providerAccountListResultSchema.parse(largestCount).accounts).toHaveLength(PROVIDER_ACCOUNT_LIST_MAX_COUNT);
    expect(providerAccountListResultSchema.safeParse(fixture("codex", PROVIDER_ACCOUNT_LIST_MAX_COUNT + 1)).success).toBe(false);
    const escaped = { ...largestCount, accounts: largestCount.accounts.map((account, index) => ({
      ...account, label: `${String(index).padStart(5, "0")}${"\\".repeat(155)}`,
    })) };
    expect(escaped.accounts.every((account) => utf8Bytes(account.label) === 160)).toBe(true);
    expect(utf8Bytes(JSON.stringify(escaped))).toBeGreaterThan(PROVIDER_ACCOUNT_LIST_MAX_BYTES);
    expect(providerAccountListResultSchema.safeParse(escaped).success).toBe(false);
    expect(escaped.accounts).toHaveLength(PROVIDER_ACCOUNT_LIST_MAX_COUNT);
  });

  test("foreign JSON and continuable bound errors return closed failures without throwing", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(() => providerAccountListResultSchema.safeParse(value)).not.toThrow();
    }), { numRuns: 100, seed: 6701 });
    fc.assert(fc.property(fc.integer({ min: -100, max: 0 }), (revision) => {
      expect(() => providerAccountListResultSchema.safeParse({ ...fixture(), pointerRevision: revision })).not.toThrow();
      expect(providerAccountListResultSchema.safeParse({ ...fixture(), pointerRevision: revision }).success).toBe(false);
    }), { numRuns: 50, seed: 6702 });
  });

  test("valid ordered provider snapshots round-trip without choosing another default", () => {
    fc.assert(fc.property(fc.constantFrom("codex" as const, "claude" as const), fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 0, max: 19 }), (provider, count, offset) => {
        const source = fixture(provider, count);
        const selected = source.accounts[offset % count];
        if (selected === undefined) throw new Error("Missing generated account.");
        source.activeProviderAccountId = selected.id;
        for (const account of source.accounts) account.active = account.id === selected.id;
        const parsed = providerAccountListResultSchema.parse(source);
        expect(providerAccountListResultSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
        expect(parsed.accounts.filter((account) => account.active).map((account) => account.id)).toEqual([selected.id]);
      }), { numRuns: 100, seed: 6703 });
  });
});
