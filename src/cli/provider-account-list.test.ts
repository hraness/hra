import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  PROVIDER_ACCOUNT_LIST_MAX_BYTES,
  PROVIDER_ACCOUNT_LIST_MAX_COUNT,
} from "../domain/provider-account-list";
import { CliUsageError, parseCli, usage, usageForGroup } from "./parser";
import { InvalidCommandResponseError, renderSuccess, type Output } from "./render";

const profileA = `acct_${"1".repeat(32)}`;
const profileB = `acct_${"2".repeat(32)}`;
const key = "11111111-1111-4111-8111-111111111111";
const fixture = (provider: "codex" | "claude" = "codex") => {
  const id = provider === "codex" ? profileA : `pact_${"a".repeat(32)}`;
  return {
    version: 1 as const, provider, orderRevision: 3, pointerRevision: 4, activeProviderAccountId: id,
    accounts: [
      { id, profileId: profileA, label: "Personal", readiness: "signed_in" as const,
        readinessObservedAt: 1_700_000_000_000, orderPosition: 1, active: true },
      { id: provider === "codex" ? profileB : `pact_${"b".repeat(32)}`, profileId: profileB,
        label: "Work", readiness: "unverified" as const, readinessObservedAt: null, orderPosition: 2, active: false },
    ],
  };
};
const capture = (): { output: Output; stdout: string[]; stderr: string[] } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, output: {
    writeStdout: (value) => { stdout.push(value); },
    writeStderr: (value) => { stderr.push(value); },
  } };
};
const expectedData = (provider: "codex" | "claude"): string => {
  const idA = provider === "codex" ? profileA : `pact_${"a".repeat(32)}`;
  const idB = provider === "codex" ? profileB : `pact_${"b".repeat(32)}`;
  return `{"version":1,"provider":"${provider}","orderRevision":3,"pointerRevision":4,"activeProviderAccountId":"${idA}","accounts":[{"id":"${idA}","profileId":"${profileA}","label":"Personal","readiness":"signed_in","readinessObservedAt":1700000000000,"orderPosition":1,"active":true},{"id":"${idB}","profileId":"${profileB}","label":"Work","readiness":"unverified","readinessObservedAt":null,"orderPosition":2,"active":false}]}`;
};

describe("cached provider account listing CLI contract", () => {
  test("parses qualified providers and preserves the exact unqualified command", () => {
    for (const json of [false, true]) {
      const flags = json ? ["--json"] : [];
      expect(parseCli(["account", "list", ...flags])).toEqual({ kind: "command", json, command: { kind: "account.list" } });
      // Preserve the legacy empty-delimiter behavior only on the bare path.
      expect(parseCli(["account", "list", ...flags, "--"])).toEqual({ kind: "command", json, command: { kind: "account.list" } });
      for (const provider of ["codex", "claude"] as const) {
        for (const args of [
          ["account", "list", "--provider", provider, ...flags],
          [...flags, "account", "list", "--provider", provider],
        ]) expect(parseCli(args)).toEqual({ kind: "command", json, command: { kind: "account.list", provider } });
      }
    }
  });

  test("rejects unsupported providers, mutations, refreshes and ambiguous grammar", () => {
    const invalid = [
      ["--provider"], ["--provider", ""], ["--provider", "devin"], ["--provider", "CODEX"],
      ["--provider", "codex", "--provider", "claude"], ["--provider=codex"],
      ["codex"], ["--refresh"], ["--provider", "codex", "--refresh"],
      ["--provider", "claude", "--activate"], ["--provider", "codex", "extra"],
      ["--provider", "codex", "--"], ["--provider", "codex", "--", "extra"],
      ["--", "--provider", "codex"], ["--provider", "codex", "--json", "--json"],
      ["--provider", "codex", "--jsonl"], ["--provider", "claude", "--follow"],
      ["--provider", "codex", "--idempotency-key", key], ["--idempotency-key", key],
      ["--provider", "claude", "--revision", "1"], ["--provider", "codex", "--attach", "private.txt"],
    ];
    for (const args of invalid) expect(() => parseCli(["account", "list", ...args])).toThrow(CliUsageError);
  });

  test("help documents the cached-only boundary and both provider examples", () => {
    expect(usage).toContain("hra account list --provider codex|claude");
    const help = usageForGroup("account");
    expect(help).toContain("hra account list [--provider <codex|claude>] [--json]");
    expect(help).toContain("hra account list --provider codex");
    expect(help).toContain("hra account list --provider claude --json");
    expect(help).toContain("not current usage or quota");
    expect(help).toContain("does not refresh providers, sign in, or change the active account");
    expect(help).toContain("Without --provider");
  });

  for (const provider of ["codex", "claude"] as const) {
    test(`prints the exact ${provider} public JSON schema in one write`, () => {
      const sink = capture();
      renderSuccess({ kind: "account.list", provider }, fixture(provider), true, sink.output);
      expect(sink.stdout).toEqual([`{"ok":true,"version":1,"command":"account.list","data":${expectedData(provider)}}\n`]);
      expect(sink.stderr).toEqual([]);
    });

    test(`renders an empty ${provider} result without inventing an active account`, () => {
      const result = { version: 1, provider, orderRevision: 1, pointerRevision: 1, activeProviderAccountId: null, accounts: [] };
      const json = capture();
      renderSuccess({ kind: "account.list", provider }, result, true, json.output);
      expect(json.stdout).toEqual([`{"ok":true,"version":1,"command":"account.list","data":{"version":1,"provider":"${provider}","orderRevision":1,"pointerRevision":1,"activeProviderAccountId":null,"accounts":[]}}\n`]);
      expect(json.stderr).toEqual([]);
      const human = capture();
      renderSuccess({ kind: "account.list", provider }, result, false, human.output);
      expect(human.stdout).toEqual([
        `Provider accounts: ${provider} (cached).\n`
        + "Readiness is last observed state, not current usage or quota. No provider refresh was requested.\n"
        + "Order revision: 1. Pointer revision: 1.\nActive provider account: none.\nNo results.\n",
      ]);
      expect(human.stderr).toEqual([]);
    });
  }

  test("labels observed, missing and unrenderable timestamps without claiming freshness", () => {
    const result = fixture("claude");
    const sink = capture();
    renderSuccess({ kind: "account.list", provider: "claude" }, result, false, sink.output);
    expect(sink.stdout).toHaveLength(1);
    const text = sink.stdout.join("");
    expect(text).toContain("Provider accounts: claude (cached).");
    expect(text).toContain("not current usage or quota");
    expect(text).toContain("2023-11-14T22:13:20.000Z");
    expect(text).toContain("unknown");
    expect(text).toContain("Order revision: 3. Pointer revision: 4.");
    expect(text).toContain(`Active provider account: ${result.activeProviderAccountId}.`);
    expect(text.indexOf("Personal")).toBeLessThan(text.indexOf("Work"));
    expect(sink.stderr).toEqual([]);
    const distant = capture();
    renderSuccess({ kind: "account.list", provider: "claude" }, {
      ...result, accounts: result.accounts.map((row) => ({ ...row, readinessObservedAt: Number.MAX_SAFE_INTEGER })),
    }, false, distant.output);
    expect(distant.stdout.join("")).toContain("unknown time");
    expect(distant.stderr).toEqual([]);
  });

  test("preserves bare profile JSON and text rather than projecting a provider result", () => {
    const result = { accounts: [{ label: "Work", state: "signed_in", providerPlan: "Plus", id: profileA }] };
    const json = capture();
    renderSuccess({ kind: "account.list" }, result, true, json.output);
    expect(json.stdout).toEqual([`{"ok":true,"version":1,"command":"account.list","data":{"accounts":[{"label":"Work","state":"signed_in","providerPlan":"Plus","id":"${profileA}"}]}}\n`]);
    const human = capture();
    renderSuccess({ kind: "account.list" }, result, false, human.output);
    expect(human.stdout).toEqual([`LABEL  STATE      PROVIDERPLAN  ID\nWork   signed_in  Plus          ${profileA}\n`]);
    expect(json.stderr).toEqual([]);
    expect(human.stderr).toEqual([]);
  });

  test("refuses malformed, private, cross-provider and inconsistent data before either sink", () => {
    const result = fixture();
    const invalid: unknown[] = [
      null, [], { accounts: [] }, { ...result, version: 2 }, fixture("claude"),
      { ...result, provider: "devin" }, { ...result, orderRevision: 0 },
      { ...result, pointerRevision: 1.5 }, { ...result, orderRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...result, activeProviderAccountId: null }, { ...result, activeProviderAccountId: `acct_${"f".repeat(32)}` },
      { ...result, accounts: [] }, { ...result, accounts: result.accounts.toReversed() },
      ...["credentials", "providerPayload", "usage", "quota", "path", "email"].map((field) => ({ ...result, [field]: "private-sentinel" })),
      ...[
        { readiness: "removed" }, { readiness: "ready_now" }, { readinessObservedAt: -1 },
        { readinessObservedAt: 0.5 }, { readinessObservedAt: undefined }, { orderPosition: 0 },
        { active: false }, { label: " Personal " }, { label: "" }, { label: "x".repeat(161) },
        { id: `pact_${"a".repeat(32)}` }, { profileId: profileB },
        { token: "private-sentinel" }, { environment: { secret: "private-sentinel" } },
        { processGeneration: 1 }, { observedQuota: "private-sentinel" },
      ].map((changed) => ({ ...result, accounts: result.accounts.map((row, index) => index === 0 ? { ...row, ...changed } : row) })),
      { ...result, accounts: result.accounts.map((row) => ({ ...row, id: profileA, profileId: profileA, active: true })) },
    ];
    for (const candidate of invalid) for (const json of [false, true]) {
      const sink = capture();
      expect(() => renderSuccess({ kind: "account.list", provider: "codex" }, candidate, json, sink.output)).toThrow(InvalidCommandResponseError);
      expect(sink.stdout).toEqual([]);
      expect(sink.stderr).toEqual([]);
    }
  });

  test("escapes terminal-control labels while preserving their exact JSON value", () => {
    const label = "Work\u001b[31m\u202eprivate";
    const result = { ...fixture(), accounts: fixture().accounts.map((row, index) => index === 0 ? { ...row, label } : row) };
    for (const json of [false, true]) {
      const sink = capture();
      renderSuccess({ kind: "account.list", provider: "codex" }, result, json, sink.output);
      expect(sink.stdout).toHaveLength(1);
      const text = sink.stdout.join("");
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\u202e");
      if (json) expect(JSON.parse(text)).toEqual({ ok: true, version: 1, command: "account.list", data: result });
      else {
        expect(text).toContain("\\u{001b}");
        expect(text).toContain("\\u{202e}");
      }
      expect(sink.stderr).toEqual([]);
    }
  });

  test("enforces the canonical result byte bound before output, without truncation", () => {
    const result = fixture();
    const accounts = Array.from({ length: PROVIDER_ACCOUNT_LIST_MAX_COUNT }, (_, index) => {
      const id = `acct_${index.toString(16).padStart(32, "0")}`;
      return { id, profileId: id, label: `${index.toString().padStart(5, "0")}${"x".repeat(155)}`, readiness: "unverified", readinessObservedAt: null,
        orderPosition: index + 1, active: index === 0 };
    });
    const oversized = { ...result, activeProviderAccountId: `acct_${"0".repeat(32)}`, accounts };
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(PROVIDER_ACCOUNT_LIST_MAX_BYTES);
    for (const json of [false, true]) {
      const sink = capture();
      expect(() => renderSuccess({ kind: "account.list", provider: "codex" }, oversized, json, sink.output)).toThrow(InvalidCommandResponseError);
      expect(sink.stdout).toEqual([]);
      expect(sink.stderr).toEqual([]);
    }
  });

  test("canonicalizes bounded key permutations without changing ordered rows", () => {
    const result = fixture();
    const entries = Object.entries(result);
    fc.assert(fc.property(fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }), (shuffled) => {
      const sink = capture();
      renderSuccess({ kind: "account.list", provider: "codex" }, Object.fromEntries(shuffled), true, sink.output);
      expect(sink.stdout).toEqual([`{"ok":true,"version":1,"command":"account.list","data":${expectedData("codex")}}\n`]);
      expect(sink.stderr).toEqual([]);
    }), { seed: 7_041, numRuns: 50 });
  });

  test("rejects bounded arbitrary foreign JSON with closed diagnostics and no output", () => {
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 3 }), (candidate) => {
      for (const json of [false, true]) {
        const sink = capture();
        expect(() => renderSuccess({ kind: "account.list", provider: "codex" }, candidate, json, sink.output)).toThrow(InvalidCommandResponseError);
        expect(sink.stdout).toEqual([]);
        expect(sink.stderr).toEqual([]);
      }
    }), { seed: 7_042, numRuns: 100 });
  });
});
