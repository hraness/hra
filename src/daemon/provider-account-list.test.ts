import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAccountListResult } from "../domain/provider-account-list";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { ProviderAccountListingError, StateStore } from "../storage/state-store";
import type { ClaudeRuntimePort, CloudControlPort, CodexRuntimePort } from "./ports";
import { CommandFailure, HraService } from "./service";

const roots: string[] = [];
const stores: StateStore[] = [];
const signal = new AbortController().signal;
const now = 1_800_000_000_000;
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-account-list-service-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: () => now, resolveMachineTimeZone: () => "UTC" });
  stores.push(store);
  const first = store.createProfile("Zulu");
  const second = store.createProfile("Alpha");
  const observed = store.nextProfileGeneration(first.id);
  expect(store.setProfileState(first.id, observed.processGeneration, "signed_in", {
    email: "private-list@example.com", plan: "Private plan",
  })).toBe(true);
  const calls: string[] = [];
  // No runtime member, including a read/probe, is allowed at this boundary.
  // These fail-on-access ports are never started and own no cleanup resources.
  const forbiddenPort = (name: string): object => new Proxy({}, {
    get: (_target, property) => {
      calls.push(`${name}.${String(property)}`);
      throw new Error("A cached listing accessed an external port.");
    },
  });
  let authorityChecks = 0;
  const service = new HraService({ store, paths,
    codex: forbiddenPort("codex") as CodexRuntimePort, claude: forbiddenPort("claude") as ClaudeRuntimePort,
    cloud: forbiddenPort("cloud") as CloudControlPort,
    daemonAuthority: { assertCurrent: async () => { authorityChecks += 1; }, close: () => {} },
    now: () => now, requestStop: () => { calls.push("requestStop"); } });
  const snapshot = () => {
    const db = new Database(paths.database, { readonly: true, strict: true });
    try {
      const hash = createHash("sha256");
      hash.update(JSON.stringify(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()));
      for (const { name } of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
        hash.update(name).update(JSON.stringify(db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()));
      }
      return { digest: hash.digest("hex"), version: db.query("PRAGMA user_version").get(),
        schemaVersion: db.query("PRAGMA schema_version").get() };
    } finally { db.close(false); }
  };
  return { store, service, first, second, paths, calls, snapshot, authorityChecks: () => authorityChecks };
}

describe("cached provider account listing service", () => {
  for (const provider of ["codex", "claude"] as const) {
    test(`${provider} uses the strict read without provider reads, generic profile lookup or durable effects`, async () => {
      const value = await fixture();
      const expected = value.store.readProviderAccountListing(provider);
      const before = value.snapshot();
      value.store.listProfiles = () => { throw new Error("The legacy profile list must not serve a qualified request."); };
      value.store.listProviderAccounts = () => { throw new Error("The unbounded provider list must not serve this request."); };
      value.store.requireProfileById = () => { throw new Error("Per-account lookups must not serve this request."); };
      const result = await value.service.execute({ kind: "account.list", provider }, { signal });
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain("private-list@example.com");
      expect(JSON.stringify(result)).not.toContain("Private plan");
      expect(value.calls).toEqual([]);
      expect(value.authorityChecks()).toBe(2);
      expect(value.snapshot()).toEqual(before);
    });
  }

  test("unqualified account.list preserves the original sorted profile bytes and never enters the new read", async () => {
    const value = await fixture();
    const before = value.snapshot();
    const profiles = value.store.listProfiles();
    const expected = JSON.stringify({ accounts: profiles.map((profile) => ({ id: profile.id, label: profile.label,
      state: profile.state, processGeneration: profile.processGeneration, providerEmail: profile.providerEmail,
      providerPlan: profile.providerPlan, updatedAt: profile.updatedAt })) });
    value.store.readProviderAccountListing = () => { throw new Error("Legacy list entered the new API."); };
    expect(JSON.stringify(await value.service.execute({ kind: "account.list" }, { signal }))).toBe(expected);
    expect(profiles.map((profile) => profile.label)).toEqual(["Alpha", "Zulu"]);
    expect(value.calls).toEqual([]);
    expect(value.snapshot()).toEqual(before);
  });

  for (const [error, code, message] of [
    [new ProviderAccountListingError("PROVIDER_ACCOUNT_LIST_LIMIT"), "UNAVAILABLE",
      "Cached provider accounts exceed the bounded listing capacity. No account state was changed."],
    [new ProviderAccountListingError("PROVIDER_ACCOUNT_LIST_INVALID"), "RECOVERY_REQUIRED",
      "Cached provider accounts could not be verified. No account state was changed."],
    [new Error("SQLite /private/account-list-secret provider-email@example.com"), "RECOVERY_REQUIRED",
      "Cached provider accounts could not be verified. No account state was changed."],
  ] as const) {
    test(`${error.message} maps to a fixed ${code} response without details or effects`, async () => {
      const value = await fixture();
      const before = value.snapshot();
      value.store.readProviderAccountListing = () => { throw error; };
      try {
        await value.service.execute({ kind: "account.list", provider: "codex" }, { signal });
        throw new Error("The unreadable listing succeeded.");
      } catch (caught: unknown) {
        expect(caught).toBeInstanceOf(CommandFailure);
        expect(caught).toMatchObject({ code, message });
        expect((caught as CommandFailure).details).toBeUndefined();
      }
      expect(value.calls).toEqual([]);
      expect(value.snapshot()).toEqual(before);
    });
  }

  for (const fault of ["wrong-provider", "private-extra", "wrong-order", "null-default"] as const) {
    test(`a ${fault} store result is rejected before becoming a public response`, async () => {
      const value = await fixture();
      const base = value.store.readProviderAccountListing(fault === "wrong-provider" ? "claude" : "codex");
      const malformed = fault === "private-extra" ? { ...base, providerEmail: "private-list@example.com" }
        : fault === "wrong-order" ? { ...base, accounts: [...base.accounts].reverse() }
        : fault === "null-default" ? { ...base, activeProviderAccountId: null }
        : base;
      value.store.readProviderAccountListing = () => malformed as ProviderAccountListResult;
      const before = value.snapshot();
      await expect(value.service.execute({ kind: "account.list", provider: "codex" }, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", message: "Cached provider accounts could not be verified. No account state was changed.", details: undefined });
      expect(value.calls).toEqual([]);
      expect(value.snapshot()).toEqual(before);
    });
  }

  test("real cached-order corruption returns sanitized recovery without a repair or provider refresh", async () => {
    const value = await fixture();
    const db = new Database(value.paths.database, { strict: true });
    try { db.exec("UPDATE provider_accounts SET order_position=3 WHERE provider='claude' AND order_position=2"); }
    finally { db.close(false); }
    const before = value.snapshot();
    await expect(value.service.execute({ kind: "account.list", provider: "claude" }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", message: "Cached provider accounts could not be verified. No account state was changed.", details: undefined });
    expect(value.calls).toEqual([]);
    expect(value.snapshot()).toEqual(before);
  });
});
