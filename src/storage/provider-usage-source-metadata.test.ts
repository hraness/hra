import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { ProviderAccountListingError, StateStore } from "./state-store";

const roots: string[] = [];
const stores: StateStore[] = [];
const now = 1_800_000_000_000;
const policyKey = "68030000-0000-4000-8000-000000000001";
const initialConfiguration = { version: 1, defaultEnabled: true,
  overrides: { codex: "inherit", claude: "inherit" }, automaticPolicyRevision: 1 } as const;
const policyUnavailable = { state: "unavailable", reason: "configuration_unavailable" } as const;
const orderUnavailable = { state: "unavailable", reason: "snapshot_conflict" } as const;
const sourceConflict = { state: "unavailable", reason: "snapshot_conflict" } as const;
const sourceUnavailable = { state: "unavailable", reason: "source_unavailable" } as const;
const invalidInputResult = { source: sourceConflict, order: orderUnavailable, automaticPolicy: policyUnavailable };

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-usage-source-metadata-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  const open = (readonly = false) => {
    const store = new StateStore(paths, { readonly, now: () => now, resolveMachineTimeZone: () => "UTC" });
    stores.push(store);
    return store;
  };
  const store = open();
  const profile = store.createProfile("First");
  const secondProfile = store.createProfile("Second");
  const codex = store.requireProviderAccountForProfile(profile.id, "codex");
  const claude = store.requireProviderAccountForProfile(profile.id, "claude");
  const input = (provider: "codex" | "claude") => ({ provider,
    providerAccountId: provider === "codex" ? codex.id : claude.id });
  const sql = (run: (database: Database) => void) => {
    const database = new Database(paths.database, { strict: true });
    try { run(database); } finally { database.close(false); }
  };
  // Corrupt only this disposable fixture. Restore the exact schema before any
  // reader assertion, so a weakened guard cannot explain the result.
  const corrupt = (run: (database: Database) => void) => sql((database) => {
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec("PRAGMA ignore_check_constraints=ON");
    try { database.transaction(() => {
      const triggers = database.query<{ name: string; sql: string }, []>(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('profiles','provider_accounts','provider_account_states','automatic_usage_policy_revisions') ORDER BY name",
      ).all();
      for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      run(database);
      for (const trigger of triggers) database.exec(trigger.sql);
      expect(database.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('profiles','provider_accounts','provider_account_states','automatic_usage_policy_revisions') ORDER BY name").all())
        .toEqual(triggers);
    }).immediate(); } finally { database.exec("PRAGMA ignore_check_constraints=OFF"); }
    expect(database.query("PRAGMA ignore_check_constraints").get()).toEqual({ ignore_check_constraints: 0 });
  });
  const snapshot = () => {
    const database = new Database(paths.database, { readonly: true, strict: true });
    try {
      return database.transaction(() => {
        const tables = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
        const hash = createHash("sha256");
        for (const { name } of tables) {
          const table = `"${name.replaceAll('"', '""')}"`;
          const columns = database.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
          // Preserve raw TEXT bytes too: Bun may decode distinct damaged UTF-8
          // cells to the same string, which would make a JS-only hash too weak.
          const projection = columns.map((column, index) => {
            const identifier = `"${column.name.replaceAll('"', '""')}"`;
            return `typeof(${identifier}) AS t${index}, CASE WHEN typeof(${identifier}) IN ('text','blob') THEN hex(CAST(${identifier} AS BLOB)) ELSE ${identifier} END AS v${index}`;
          }).join(",");
          hash.update(name).update(JSON.stringify(database.query(`SELECT ${projection} FROM ${table}`).all()));
        }
        return { rows: hash.digest("hex"),
          schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
          version: database.query("PRAGMA user_version").get(),
          schemaVersion: database.query("PRAGMA schema_version").get() };
      })();
    } finally { database.close(false); }
  };
  return { store, profile, secondProfile, codex, claude, input, open, sql, corrupt, snapshot };
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("private cached provider usage source metadata", () => {
  for (const provider of ["codex", "claude"] as const) {
    test(`${provider} returns exact generation-zero metadata without durable writes, including readonly reopen`, async () => {
      const value = await fixture();
      const account = provider === "codex" ? value.codex : value.claude;
      const before = value.snapshot();
      const result = value.store.readProviderUsageSourceMetadata(value.input(provider));
      const sourceBase = { state: "cached", providerAccountId: account.id,
        profileId: value.profile.id, bindingGeneration: account.bindingGeneration, processGeneration: 0 } as const;
      expect(result).toEqual({
        source: provider === "codex"
          ? { ...sourceBase, provider: "codex", readiness: "signed_out", readinessObservedAt: now,
              identity: { state: "unavailable", reason: "identity_unavailable" } }
          : { ...sourceBase, provider: "claude", readiness: "unverified", readinessObservedAt: null,
              identity: { state: "unavailable", reason: "provider_unsupported" } },
        order: { state: "cached", orderRevision: 3, pointerRevision: 2, accountCount: 2, orderPosition: 1, active: true },
        automaticPolicy: { state: "configured", configuration: initialConfiguration },
      });
      expectDeepFrozen(result);
      const reopened = value.open(true).readProviderUsageSourceMetadata(value.input(provider));
      expect(reopened).toEqual(result);
      expect(reopened).not.toBe(result);
      expect(reopened.source).not.toBe(result.source);
      expect(reopened.order).not.toBe(result.order);
      expect(reopened.automaticPolicy).not.toBe(result.automaticPolicy);
      expect(value.snapshot()).toEqual(before);
    });
  }

  test("Codex copies original identity spelling without normalization and remains independent of provider readiness", async () => {
    const value = await fixture();
    const email = " MiXeD+Tag@Example.COM ";
    expect(value.store.setProfileState(value.profile.id, 0, "signed_in", { email, plan: "Plus" })).toBe(true);
    value.store.observeProviderAccountReadiness({ provider: "claude", profileId: value.profile.id,
      expectedBindingGeneration: value.claude.bindingGeneration, readiness: "recovery_required", observedAt: now + 500 });
    const before = value.snapshot();
    expect(value.store.readProviderUsageSourceMetadata(value.input("codex")).source).toMatchObject({
      state: "cached", readiness: "signed_in", processGeneration: 0,
      identity: { state: "cached", email } });
    expect(value.store.readProviderUsageSourceMetadata(value.input("claude")).source).toMatchObject({
      state: "cached", readiness: "recovery_required", processGeneration: 0, readinessObservedAt: now + 500,
      identity: { state: "unavailable", reason: "provider_unsupported" } });
    expect(value.snapshot()).toEqual(before);
  });

  test("future and zero cached observation times are not changed into a freshness claim", async () => {
    const value = await fixture();
    value.corrupt((database) => {
      database.query("UPDATE provider_accounts SET readiness_observed_at=? WHERE id=?").run(Number.MAX_SAFE_INTEGER, value.codex.id);
      database.query("UPDATE provider_accounts SET readiness_observed_at=0,process_generation=7 WHERE id=?").run(value.claude.id);
    });
    const before = value.snapshot();
    expect(value.store.readProviderUsageSourceMetadata(value.input("codex")).source).toMatchObject({ readinessObservedAt: Number.MAX_SAFE_INTEGER });
    expect(value.store.readProviderUsageSourceMetadata(value.input("claude")).source).toMatchObject({ readinessObservedAt: 0, processGeneration: 7 });
    expect(value.snapshot()).toEqual(before);
  });

  for (const email of [null, "", "bad\nidentity", "bad\u0000identity"]) {
    test(`equal ${JSON.stringify(email)} identity is unavailable without discarding readiness`, async () => {
      const value = await fixture();
      value.corrupt((database) => {
        database.query("UPDATE profiles SET provider_email=? WHERE id=?").run(email, value.profile.id);
        database.query("UPDATE provider_accounts SET provider_email=? WHERE id=?").run(email, value.codex.id);
      });
      const before = value.snapshot();
      expect(value.store.readProviderUsageSourceMetadata(value.input("codex"))).toMatchObject({
        source: { state: "cached", readiness: "signed_out", identity: { state: "unavailable", reason: "identity_unavailable" } },
        order: { state: "cached" }, automaticPolicy: { state: "configured" } });
      expect(value.snapshot()).toEqual(before);
    });
  }

  test.each([
    ["different exact spellings", "ONE@example.com", "one@example.com", "snapshot_conflict"],
    ["one missing mirror", null, "one@example.com", "snapshot_conflict"],
    ["oversized equal identity", "a".repeat(1025), "a".repeat(1025), "representation_limit"],
    ["oversized mismatch takes precedence", "a".repeat(1025), "other@example.com", "representation_limit"],
    ["oversized raw UTF-8 identity", "界".repeat(1025), "界".repeat(1025), "representation_limit"],
    ["oversized raw UTF-8 mismatch", "界".repeat(1025), "other@example.com", "representation_limit"],
  ] as const)("identity refusal is isolated: %s", async (_name, profileEmail, accountEmail, reason) => {
    const value = await fixture();
    value.corrupt((database) => {
      database.query("UPDATE profiles SET provider_email=? WHERE id=?").run(profileEmail, value.profile.id);
      database.query("UPDATE provider_accounts SET provider_email=? WHERE id=?").run(accountEmail, value.codex.id);
    });
    const before = value.snapshot();
    expect(value.store.readProviderUsageSourceMetadata(value.input("codex"))).toMatchObject({
      source: { state: "cached", identity: { state: "unavailable", reason } },
      order: { state: "cached" }, automaticPolicy: { state: "configured" } });
    expect(value.snapshot()).toEqual(before);
  });

  test("the exact 1024 UTF-16 / 3072 UTF-8 identity boundary preserves all bytes", async () => {
    const value = await fixture();
    const email = "界".repeat(1024);
    expect(email.length).toBe(1024);
    expect(Buffer.byteLength(email)).toBe(3072);
    value.corrupt((database) => {
      database.query("UPDATE profiles SET provider_email=? WHERE id=?").run(email, value.profile.id);
      database.query("UPDATE provider_accounts SET provider_email=? WHERE id=?").run(email, value.codex.id);
    });
    const before = value.snapshot();
    expect(value.store.readProviderUsageSourceMetadata(value.input("codex")).source).toMatchObject({ identity: { state: "cached", email } });
    expect(value.snapshot()).toEqual(before);
  });

  test.each([
    ["equal invalid UTF-8", "ff", "ff", "identity_unavailable"],
    ["different invalid UTF-8", "ff", "fe", "snapshot_conflict"],
    ["encoded unpaired surrogate", "eda080", "eda080", "identity_unavailable"],
    ["valid owner and malformed binding", "614062", "614062ff", "snapshot_conflict"],
    ["malformed owner and valid binding", "614062ff", "614062", "snapshot_conflict"],
  ] as const)("raw stored identity bytes are not normalized into authority: %s", async (_name, ownerHex, bindingHex, reason) => {
    const value = await fixture();
    value.corrupt((database) => {
      database.query("UPDATE profiles SET provider_email=CAST(? AS TEXT) WHERE id=?").run(Buffer.from(ownerHex, "hex"), value.profile.id);
      database.query("UPDATE provider_accounts SET provider_email=CAST(? AS TEXT) WHERE id=?").run(Buffer.from(bindingHex, "hex"), value.codex.id);
      expect(database.query("SELECT hex(CAST(provider_email AS BLOB)) AS bytes FROM profiles WHERE id=?").get(value.profile.id))
        .toEqual({ bytes: ownerHex.toUpperCase() });
      expect(database.query("SELECT hex(CAST(provider_email AS BLOB)) AS bytes FROM provider_accounts WHERE id=?").get(value.codex.id))
        .toEqual({ bytes: bindingHex.toUpperCase() });
    });
    const before = value.snapshot();
    expect(value.store.readProviderUsageSourceMetadata(value.input("codex"))).toMatchObject({
      source: { state: "cached", readiness: "signed_out", identity: { state: "unavailable", reason } },
      order: { state: "cached" }, automaticPolicy: { state: "configured" } });
    expect(value.snapshot()).toEqual(before);
  });

  test("valid stored UTF-8 BOM and surrounding whitespace remain part of the exact cached identity", async () => {
    const value = await fixture();
    const email = "\uFEFF MiXeD@Example.COM ";
    // Bun's SQLite JS-string binding strips a leading BOM before storage. Use
    // explicit BLOB bytes here to test the reader's exact stored-text contract.
    const bytes = Buffer.from(email, "utf8");
    value.corrupt((database) => {
      database.query("UPDATE profiles SET provider_email=CAST(? AS TEXT) WHERE id=?").run(bytes, value.profile.id);
      database.query("UPDATE provider_accounts SET provider_email=CAST(? AS TEXT) WHERE id=?").run(bytes, value.codex.id);
      expect(database.query("SELECT hex(CAST(provider_email AS BLOB)) AS bytes FROM provider_accounts WHERE id=?").get(value.codex.id))
        .toEqual({ bytes: bytes.toString("hex").toUpperCase() });
    });
    const before = value.snapshot();
    expect(value.store.readProviderUsageSourceMetadata(value.input("codex")).source)
      .toMatchObject({ state: "cached", identity: { state: "cached", email } });
    expect(value.snapshot()).toEqual(before);
  });

  for (const damage of ["missing", "removed", "owner_removed"] as const) {
    test(`a ${damage} selected source is unavailable while policy stays independently readable`, async () => {
      const value = await fixture();
      value.corrupt((database) => {
        if (damage === "missing") database.query("DELETE FROM provider_accounts WHERE id=?").run(value.claude.id);
        else if (damage === "removed") database.query("UPDATE provider_accounts SET readiness='removed',order_position=NULL WHERE id=?").run(value.claude.id);
        else database.query("UPDATE profiles SET state='removed' WHERE id=?").run(value.profile.id);
      });
      const before = value.snapshot();
      expect(value.store.readProviderUsageSourceMetadata(value.input("claude"))).toEqual({
        source: sourceUnavailable, order: orderUnavailable,
        automaticPolicy: { state: "configured", configuration: initialConfiguration } });
      expect(value.snapshot()).toEqual(before);
    });
  }

  const sourceCorruptions = [
    ["missing owner", "DELETE FROM profiles WHERE id=?", "profile"],
    ["provider mismatch", "UPDATE provider_accounts SET provider='codex' WHERE id=?", "claude"],
    ["Codex process mirror mismatch", "UPDATE provider_accounts SET process_generation=1 WHERE id=?", "codex"],
    ["Codex readiness mirror mismatch", "UPDATE provider_accounts SET readiness='signed_in' WHERE id=?", "codex"],
    ["Claude has private email", "UPDATE provider_accounts SET provider_email='private@example.com' WHERE id=?", "claude"],
    ["Claude has private plan", "UPDATE provider_accounts SET provider_plan='private-plan' WHERE id=?", "claude"],
  ] as const;
  for (const [name, statement, target] of sourceCorruptions) {
    test(`source refuses ${name} without repairs`, async () => {
      const value = await fixture();
      const provider = target === "codex" ? "codex" : "claude";
      value.corrupt((database) => {
        if (name === "provider mismatch") database.query("DELETE FROM provider_accounts WHERE id=?").run(value.codex.id);
        database.query(statement).run(target === "profile" ? value.profile.id : target === "codex" ? value.codex.id : value.claude.id);
      });
      const before = value.snapshot();
      expect(value.store.readProviderUsageSourceMetadata(value.input(provider))).toEqual({
        source: sourceConflict, order: orderUnavailable,
        automaticPolicy: { state: "configured", configuration: initialConfiguration } });
      expect(value.snapshot()).toEqual(before);
    });
  }

  test("a missing inverse binding invalidates order but not the independently selected source", async () => {
    const value = await fixture();
    value.corrupt((database) => database.query("DELETE FROM provider_accounts WHERE provider='claude' AND profile_id=?").run(value.secondProfile.id));
    const before = value.snapshot();
    expect(value.store.readProviderUsageSourceMetadata(value.input("claude"))).toMatchObject({
      source: { state: "cached" }, order: orderUnavailable, automaticPolicy: { state: "configured" } });
    expect(value.snapshot()).toEqual(before);
  });

  test("removed other bindings remain intentional exclusion, not missing inverse entries", async () => {
    const value = await fixture();
    value.corrupt((database) => database.query("UPDATE provider_accounts SET readiness='removed',order_position=NULL WHERE provider='claude' AND profile_id=?").run(value.secondProfile.id));
    const before = value.snapshot();
    expect(value.store.readProviderUsageSourceMetadata(value.input("claude"))).toMatchObject({
      source: { state: "cached" }, order: { state: "cached", accountCount: 1, orderPosition: 1, active: true } });
    expect(value.snapshot()).toEqual(before);
  });

  test("corrupt order and policy are isolated from cached source metadata", async () => {
    const value = await fixture();
    value.store.updateAutomaticUsagePolicyConfiguration({ idempotencyKey: policyKey,
      expectedAutomaticPolicyRevision: 1, change: { kind: "set_override", provider: "claude", override: "off" } });
    value.corrupt((database) => {
      database.exec("UPDATE provider_accounts SET order_position=3 WHERE provider='claude' AND order_position=2");
      database.query("UPDATE automatic_usage_policy_revisions SET configuration_digest=? WHERE automatic_policy_revision=2").run("f".repeat(64));
    });
    const before = value.snapshot();
    expect(value.store.readProviderUsageSourceMetadata(value.input("claude"))).toMatchObject({
      source: { state: "cached" }, order: orderUnavailable, automaticPolicy: policyUnavailable });
    expect(value.store.readProviderUsageSourceMetadata(value.input("codex"))).toMatchObject({
      source: { state: "cached" }, order: { state: "cached" }, automaticPolicy: policyUnavailable });
    expect(value.snapshot()).toEqual(before);
  });

  test("existing listing limits and private failures become bounded independent unavailable blocks", async () => {
    const value = await fixture();
    const before = value.snapshot();
    value.store.readProviderAccountListing = () => { throw new ProviderAccountListingError("PROVIDER_ACCOUNT_LIST_LIMIT"); };
    expect(value.store.readProviderUsageSourceMetadata(value.input("claude"))).toMatchObject({
      source: { state: "cached" }, order: { state: "unavailable", reason: "representation_limit" }, automaticPolicy: { state: "configured" } });
    value.store.readProviderAccountListing = () => { throw new Error("PRIVATE_ORDER_SENTINEL"); };
    value.store.readAutomaticUsagePolicyConfiguration = () => { throw new Error("PRIVATE_POLICY_SENTINEL"); };
    const result = value.store.readProviderUsageSourceMetadata(value.input("claude"));
    expect(result).toMatchObject({ source: { state: "cached" }, order: orderUnavailable, automaticPolicy: policyUnavailable });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expectDeepFrozen(result);
    expect(value.snapshot()).toEqual(before);
  });

  test("source, nested order and policy reads share one snapshot across a real second-writer commit", async () => {
    const value = await fixture();
    const writer = value.open();
    const request = value.input("claude");
    const before = value.store.readProviderUsageSourceMetadata(request);
    const listing = value.store.readProviderAccountListing.bind(value.store);
    let interleaved = false;
    value.store.readProviderAccountListing = (provider) => {
      const result = listing(provider);
      if (!interleaved) {
        interleaved = true;
        writer.observeProviderAccountReadiness({ provider: "claude", profileId: value.profile.id,
          expectedBindingGeneration: value.claude.bindingGeneration, readiness: "signed_in", observedAt: now + 1 });
        writer.replaceProviderAccountOrder({ provider: "claude", expectedOrderRevision: result.orderRevision,
          providerAccountIds: result.accounts.map((account) => account.id).reverse() });
        writer.activateProviderAccount({ provider: "claude", expectedPointerRevision: result.pointerRevision,
          providerAccountId: result.accounts[1]!.id });
        writer.updateAutomaticUsagePolicyConfiguration({ idempotencyKey: policyKey,
          expectedAutomaticPolicyRevision: 1, change: { kind: "set_override", provider: "claude", override: "off" } });
      }
      return result;
    };
    expect(value.store.readProviderUsageSourceMetadata(request)).toEqual(before);
    expect(interleaved).toBe(true);
    const afterWriter = value.snapshot();
    const after = value.store.readProviderUsageSourceMetadata(request);
    expect(after).toMatchObject({ source: { state: "cached", readiness: "signed_in",
      bindingGeneration: value.claude.bindingGeneration + 1, readinessObservedAt: now + 1 },
    order: { state: "cached", orderRevision: 4, pointerRevision: 3, orderPosition: 2, active: false },
    automaticPolicy: { state: "configured", configuration: { automaticPolicyRevision: 2, overrides: { claude: "off" } } } });
    expect(value.snapshot()).toEqual(afterWriter);
    expectDeepFrozen(after);
    expect(before).not.toEqual(after);
  });

  test("returned configuration is detached from caller-owned nested read results", async () => {
    const value = await fixture();
    const configuration = structuredClone(initialConfiguration);
    value.store.readAutomaticUsagePolicyConfiguration = () => configuration;
    const before = value.snapshot();
    const result = value.store.readProviderUsageSourceMetadata(value.input("claude"));
    expect(result.automaticPolicy).toEqual({ state: "configured", configuration: initialConfiguration });
    if (result.automaticPolicy.state !== "configured") throw new Error("Expected configured policy");
    expect(result.automaticPolicy.configuration).not.toBe(configuration);
    expect(result.automaticPolicy.configuration.overrides).not.toBe(configuration.overrides);
    expect(Object.isFrozen(configuration)).toBe(false);
    expect(Object.isFrozen(configuration.overrides)).toBe(false);
    Reflect.set(configuration, "defaultEnabled", false);
    Reflect.set(configuration.overrides, "claude", "off");
    expect(result.automaticPolicy.configuration).toEqual(initialConfiguration);
    expectDeepFrozen(result);
    expect(value.snapshot()).toEqual(before);
  });

  for (const kind of ["accessor", "nondefault prototype"] as const) {
    test(`${kind} requests cannot confer authority or invoke nested readers`, async () => {
      const value = await fixture();
      let getters = 0;
      let nestedReads = 0;
      value.store.readProviderAccountListing = () => { nestedReads += 1; throw new Error("unexpected listing"); };
      value.store.readAutomaticUsagePolicyConfiguration = () => { nestedReads += 1; throw new Error("unexpected policy"); };
      const input = kind === "accessor"
        ? Object.defineProperty({ provider: "claude" }, "providerAccountId", {
            enumerable: true, get: () => { getters += 1; return value.claude.id; },
          })
        : Object.assign(Object.create({ inherited: true }) as object, value.input("claude"));
      expect(Object.keys(input)).toEqual(["provider", "providerAccountId"]);
      const before = value.snapshot();
      expect(value.store.readProviderUsageSourceMetadata(input)).toEqual(invalidInputResult);
      expect(getters).toBe(0);
      expect(nestedReads).toBe(0);
      expect(value.snapshot()).toEqual(before);
    });
  }

  test("unknown request values are total and exact-key checked without nested readers", async () => {
    const value = await fixture();
    let calls = 0;
    value.store.readProviderAccountListing = () => { calls += 1; throw new Error("unexpected listing"); };
    value.store.readAutomaticUsagePolicyConfiguration = () => { calls += 1; throw new Error("unexpected policy"); };
    const request = value.input("claude");
    const invalid = [null, undefined, false, 1, "claude", [], {},
      { ...request, extra: true }, { provider: "codex", providerAccountId: value.claude.id },
      { provider: "claude", providerAccountId: value.codex.id },
      { provider: "devin", providerAccountId: `dact_${"1".repeat(32)}` }];
    const before = value.snapshot();
    for (const input of invalid) {
      const result = value.store.readProviderUsageSourceMetadata(input);
      expect(result).toEqual(invalidInputResult);
      expectDeepFrozen(result);
    }
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 3 }), (foreign) => {
      // This extra key makes every generated JSON tree invalid independently
      // of its contents; the law checks closed admission without field inference.
      const input = { ...request, foreign };
      const original = JSON.stringify(input);
      expect(value.store.readProviderUsageSourceMetadata(input)).toEqual(invalidInputResult);
      expect(JSON.stringify(input)).toBe(original);
    }), { seed: 68301, numRuns: 100 });
    expect(calls).toBe(0);
    expect(value.snapshot()).toEqual(before);
  });

  test("valid request key permutations preserve canonical detached and frozen results", async () => {
    const value = await fixture();
    const expected = {
      codex: value.store.readProviderUsageSourceMetadata(value.input("codex")),
      claude: value.store.readProviderUsageSourceMetadata(value.input("claude")),
    };
    const before = value.snapshot();
    fc.assert(fc.property(fc.constantFrom("codex", "claude"), fc.boolean(), (provider, reverse) => {
      const original = value.input(provider);
      const request = reverse
        ? { providerAccountId: original.providerAccountId, provider: original.provider }
        : { ...original };
      const bytes = JSON.stringify(request);
      const result = value.store.readProviderUsageSourceMetadata(request);
      expect(result).toEqual(expected[provider]);
      expect(JSON.stringify(result)).toBe(JSON.stringify(expected[provider]));
      expect(JSON.stringify(request)).toBe(bytes);
      expect(Object.isFrozen(request)).toBe(false);
      expect(result).not.toBe(expected[provider]);
      expectDeepFrozen(result);
      Reflect.set(request, "provider", "devin");
      Reflect.set(request, "providerAccountId", "changed");
      expect(result).toEqual(expected[provider]);
    }), { seed: 68302, numRuns: 100 });
    expect(value.snapshot()).toEqual(before);
  });
});
