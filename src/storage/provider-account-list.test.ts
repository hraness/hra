import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROVIDER_ACCOUNT_LIST_MAX_COUNT } from "../domain/provider-account-list";
import type { UsageProvider } from "../domain/provider-usage";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { ProviderAccountListingError, StateStore } from "./state-store";

const roots: string[] = [];
const stores: StateStore[] = [];
const now = 1_800_000_000_000;
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(labels: readonly string[] = ["Zulu", "Alpha"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-account-list-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  const open = (readonly = false) => {
    const store = new StateStore(paths, { readonly, now: () => now, resolveMachineTimeZone: () => "UTC" });
    stores.push(store);
    return store;
  };
  const store = open();
  const profiles = labels.map((label) => store.createProfile(label));
  const sql = (run: (db: Database) => void) => {
    const db = new Database(paths.database, { strict: true });
    try { run(db); } finally { db.close(false); }
  };
  const corrupt = (statement: string) => sql((db) => {
    db.exec("PRAGMA foreign_keys=OFF");
    db.transaction(() => {
      const triggers = db.query<{ name: string; sql: string }, []>(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('profiles','provider_accounts','provider_account_states') ORDER BY name",
      ).all();
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      db.exec(statement);
      for (const trigger of triggers) db.exec(trigger.sql);
      expect(db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('profiles','provider_accounts','provider_account_states') ORDER BY name").all())
        .toEqual(triggers);
    }).immediate();
  });
  const snapshot = () => {
    const db = new Database(paths.database, { readonly: true, strict: true });
    try {
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      const hash = createHash("sha256");
      for (const { name } of tables) {
        hash.update(name).update(JSON.stringify(db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()));
      }
      return { rows: hash.digest("hex"),
        schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        version: db.query("PRAGMA user_version").get(), schemaVersion: db.query("PRAGMA schema_version").get() };
    } finally { db.close(false); }
  };
  return { store, paths, open, profiles, sql, corrupt, snapshot };
}

function expectInvalid(store: StateStore, provider: UsageProvider) {
  try {
    store.readProviderAccountListing(provider);
    throw new Error("The invalid listing was accepted.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProviderAccountListingError);
    expect(error).toMatchObject({ code: "PROVIDER_ACCOUNT_LIST_INVALID", message: "PROVIDER_ACCOUNT_LIST_INVALID" });
  }
}

describe("cached provider account listing storage", () => {
  for (const provider of ["codex", "claude"] as const) {
    test(`${provider} has an exact empty projection without initializing state`, async () => {
      const value = await fixture([]);
      const before = value.snapshot();
      expect(value.store.readProviderAccountListing(provider)).toEqual({ version: 1, provider,
        orderRevision: 1, pointerRevision: 1, activeProviderAccountId: null, accounts: [] });
      expect(value.snapshot()).toEqual(before);
    });

    test(`${provider} returns provider order, exact default and cached readiness without private fields`, async () => {
      const value = await fixture();
      const accounts = value.store.listProviderAccounts(provider);
      const first = accounts[0]!;
      const second = accounts[1]!;
      if (provider === "claude") {
        value.store.observeProviderAccountReadiness({ provider, profileId: second.profileId,
          expectedBindingGeneration: second.bindingGeneration, readiness: "signed_in", observedAt: now - 1 });
      }
      const state = value.store.readProviderAccountState(provider);
      value.store.replaceProviderAccountOrder({ provider, expectedOrderRevision: state.orderRevision,
        providerAccountIds: [second.id, first.id] });
      value.store.activateProviderAccount({ provider, expectedPointerRevision: state.pointerRevision, providerAccountId: second.id });
      const before = value.snapshot();
      const result = value.store.readProviderAccountListing(provider);
      expect(result).toEqual({ version: 1, provider, orderRevision: state.orderRevision + 1,
        pointerRevision: state.pointerRevision + 1, activeProviderAccountId: second.id, accounts: [
          { id: second.id, profileId: second.profileId, label: "Alpha", readiness: provider === "claude" ? "signed_in" : "signed_out",
            readinessObservedAt: provider === "claude" ? now - 1 : now, orderPosition: 1, active: true },
          { id: first.id, profileId: first.profileId, label: "Zulu", readiness: provider === "claude" ? "unverified" : "signed_out",
            readinessObservedAt: provider === "claude" ? null : now, orderPosition: 2, active: false },
        ] });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.accounts)).toBe(true);
      expect(Object.isFrozen(result.accounts[0])).toBe(true);
      expect(value.snapshot()).toEqual(before);
      expect(value.open(true).readProviderAccountListing(provider)).toEqual(result);
    });
  }

  test("state and account joins share a snapshot across a concurrent reorder/default commit", async () => {
    const value = await fixture();
    const writer = value.open();
    const before = value.store.readProviderAccountListing("claude");
    const read = value.store.readProviderAccountState.bind(value.store);
    let interleaved = false;
    value.store.readProviderAccountState = (provider) => {
      const state = read(provider);
      if (!interleaved) {
        interleaved = true;
        writer.replaceProviderAccountOrder({ provider, expectedOrderRevision: state.orderRevision,
          providerAccountIds: before.accounts.map((account) => account.id).reverse() });
        writer.activateProviderAccount({ provider, expectedPointerRevision: state.pointerRevision,
          providerAccountId: before.accounts[1]!.id });
      }
      return state;
    };
    expect(value.store.readProviderAccountListing("claude")).toEqual(before);
    expect(interleaved).toBe(true);
    expect(value.store.readProviderAccountListing("claude")).toMatchObject({
      orderRevision: before.orderRevision + 1, pointerRevision: before.pointerRevision + 1,
      activeProviderAccountId: before.accounts[1]!.id });
  });

  test("an intentionally removed provider binding is excluded but still completes the inverse join", async () => {
    const value = await fixture();
    const removed = value.store.listProviderAccounts("claude")[1]!;
    value.sql((db) => db.query("UPDATE provider_accounts SET readiness='removed',binding_generation=binding_generation+1,order_position=NULL WHERE id=?").run(removed.id));
    const before = value.snapshot();
    expect(value.store.readProviderAccountListing("claude").accounts.map((account) => account.label)).toEqual(["Zulu"]);
    expect(value.snapshot()).toEqual(before);
  });

  test("display labels retain their admitted non-NFKC spelling and null observations remain null", async () => {
    const value = await fixture(["Ｆｏｏ"]);
    expect(value.store.readProviderAccountListing("claude").accounts[0]).toMatchObject({ label: "Ｆｏｏ", readinessObservedAt: null });
  });

  const corruptions = [
    ["order gap", "UPDATE provider_accounts SET order_position=3 WHERE provider='claude' AND order_position=2"],
    ["null default with live accounts", "UPDATE provider_account_states SET active_provider_account_id=NULL WHERE provider='claude'"],
    ["default from another provider", "UPDATE provider_account_states SET active_provider_account_id=(SELECT id FROM provider_accounts WHERE provider='codex' LIMIT 1) WHERE provider='claude'"],
    ["missing state", "DELETE FROM provider_account_states WHERE provider='claude'"],
    ["missing binding", "DELETE FROM provider_accounts WHERE provider='claude' AND order_position=2"],
    ["missing owner profile", "DELETE FROM profiles WHERE id=(SELECT profile_id FROM provider_accounts WHERE provider='claude' AND order_position=2)"],
    ["removed owner profile", "UPDATE profiles SET state='removed' WHERE id=(SELECT profile_id FROM provider_accounts WHERE provider='claude' AND order_position=2)"],
    ["invalid stored label key", "UPDATE profiles SET label_key='wrong-key' WHERE label='Alpha'"],
    ["canonical label collision", "UPDATE profiles SET label='Ｚｕｌｕ' WHERE label='Alpha'"],
    ["label requiring silent trim", "UPDATE profiles SET label=' Alpha ' WHERE label='Alpha'"],
    ["unsafe timestamp", "UPDATE provider_accounts SET readiness_observed_at=9007199254740992 WHERE provider='claude'"],
  ] as const;
  for (const [name, sql] of corruptions) {
    test(`refuses ${name} without repairing any durable state`, async () => {
      const value = await fixture();
      value.corrupt(sql);
      const before = value.snapshot();
      expectInvalid(value.store, "claude");
      expect(value.snapshot()).toEqual(before);
    });
  }

  test("Codex retains its process mirror admission", async () => {
    const value = await fixture();
    value.corrupt("UPDATE provider_accounts SET process_generation=1 WHERE provider='codex'");
    const before = value.snapshot();
    expectInvalid(value.store, "codex");
    expect(value.store.readProviderAccountListing("claude").accounts).toHaveLength(2);
    expect(value.snapshot()).toEqual(before);
  });

  test("Codex refuses contradictory cached readiness at the same process generation", async () => {
    const value = await fixture();
    // Binding-only readiness updates can be schema-valid, but Codex's profile
    // and provider projections must still agree before this read admits them.
    value.sql((db) => db.exec("UPDATE provider_accounts SET readiness='signed_in',binding_generation=binding_generation+1 WHERE provider='codex'"));
    const before = value.snapshot();
    expectInvalid(value.store, "codex");
    expect(value.store.readProviderAccountListing("claude").accounts).toHaveLength(2);
    expect(value.snapshot()).toEqual(before);
  });

  test("Codex retains the exact automatic-pointer schema proof without blocking unrelated Claude reads", async () => {
    const value = await fixture();
    value.sql((db) => db.exec("DROP TRIGGER automatic_pointer_move_anchor_insert_guard"));
    const before = value.snapshot();
    expectInvalid(value.store, "codex");
    expect(value.store.readProviderAccountListing("claude").accounts).toHaveLength(2);
    expect(value.snapshot()).toEqual(before);
  });

  for (const mode of ["visible-count", "verification-count", "result-bytes"] as const) {
    test(`fails closed at the ${mode} ceiling instead of returning a truncated projection`, async () => {
      const value = await fixture([]);
      // Synthetic strict-table rows exercise only the read's bounded admission.
      // They are not a complete mutation/reset-policy history or reopen fixture.
      const count = PROVIDER_ACCOUNT_LIST_MAX_COUNT + (mode === "result-bytes" ? 0 : 1);
      value.sql((db) => db.transaction(() => {
        const profile = db.query("INSERT INTO profiles(id,label,label_key,state,process_generation,created_at,updated_at) VALUES (?,?,?,'signed_out',0,?,?)");
        const account = db.query("INSERT INTO provider_accounts(id,profile_id,provider,readiness,binding_generation,process_generation,order_position,readiness_observed_at,created_at,updated_at) VALUES (?,?,'claude',?,1,0,?,NULL,?,?)");
        for (let index = 1; index <= count; index += 1) {
          const suffix = index.toString(16).padStart(32, "0");
          const label = `${mode === "result-bytes" ? "x".repeat(150) : "Account"}${index}`;
          profile.run(`acct_${suffix}`, label, label.toLowerCase(), now, now);
          account.run(`pact_${suffix}`, `acct_${suffix}`, mode === "verification-count" && index > 1 ? "removed" : "unverified",
            mode === "verification-count" && index > 1 ? null : index, now, now);
        }
        db.query("UPDATE provider_account_states SET active_provider_account_id=?,pointer_revision=pointer_revision+1 WHERE provider='claude'").run(`pact_${"1".padStart(32, "0")}`);
      }).immediate());
      const before = value.snapshot();
      expect(() => value.store.readProviderAccountListing("claude")).toThrow("PROVIDER_ACCOUNT_LIST_LIMIT");
      expect(value.snapshot()).toEqual(before);
    }, 30_000);
  }
});
