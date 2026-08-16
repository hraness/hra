import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountProfileLayout,
  UnsafeAccountProfilePathError,
} from "../src/accounts/profile-layout";
import {
  AccountProfileCapacityExceeded,
  AccountProfileGenerationRegression,
  AccountProfileNotFound,
  AccountProfileStaleRevision,
  AccountProfileStore,
} from "../src/accounts/profile-store";
import { applyMigrations } from "../src/state/database";

describe("isolated account profile layout", () => {
  test("derives the exact per-profile layout without touching the filesystem", () => {
    const root = "/Users/example/Library/Application Support/OPRTE";
    const databasePath = join(root, "state", "control-plane.sqlite");
    const layout = accountProfileLayout(databasePath, "acct_work0001");

    expect(layout).toEqual({
      stateRoot: join(root, "state"),
      accountsRoot: join(root, "state", "codex", "accounts"),
      profileRoot: join(root, "state", "codex", "accounts", "acct_work0001"),
      codexHome: join(root, "state", "codex", "accounts", "acct_work0001", "home"),
      runtimeDirectory: join(
        root,
        "state",
        "codex",
        "accounts",
        "acct_work0001",
        "runtime",
      ),
    });
  });

  test("rejects account ID escapes and broad control-plane paths", () => {
    const stateRoot = "/Users/example/Library/Application Support/OPRTE";
    expect(() =>
      accountProfileLayout(join(stateRoot, "control-plane.sqlite"), "acct_../../outside"),
    ).toThrow();
    expect(() => accountProfileLayout("/control-plane.sqlite", "acct_work0001")).toThrow(
      UnsafeAccountProfilePathError,
    );
  });
});

describe("account profile store", () => {
  test("keeps two profiles uniquely selected and advances one durable revision", () => {
    const database = accountDatabase();
    const store = deterministicStore(database);
    try {
      const work = store.create("Work", at(0));
      const personal = store.create("Personal", at(1));
      expect(work).toMatchObject({ id: workId, revision: 1, selected: true });
      expect(personal).toMatchObject({ id: personalId, revision: 1, selected: false });
      expect(store.list().map(({ id }) => id)).toEqual([workId, personalId]);

      const selection = store.select(personalId, at(2));
      expect(selection.deselected).toMatchObject({ id: workId, revision: 2, selected: false });
      expect(selection.selected).toMatchObject({ id: personalId, revision: 2, selected: true });
      expect(store.select(personalId, at(3))).toEqual({
        selected: selection.selected,
        deselected: null,
      });

      expect(store.updateIdentityLabel(personalId, "person@example.com", at(4))).toMatchObject({
        revision: 3,
        identityLabel: "person@example.com",
      });
      expect(store.updateAuthState(personalId, "signedIn", at(5))).toMatchObject({
        revision: 4,
        authState: "signedIn",
      });
      expect(store.updatePlanLabel(personalId, "Plus", at(6))).toMatchObject({
        revision: 5,
        planLabel: "Plus",
      });
      expect(store.updateProcessGeneration(personalId, 4, at(7))).toMatchObject({
        advanced: true,
        profile: {
          revision: 6,
          processGeneration: 4,
        },
      });
      expect(store.updateProcessGeneration(personalId, 4, at(8))).toMatchObject({
        advanced: false,
        profile: { revision: 6, processGeneration: 4 },
      });
      expect(store.bumpRevision(personalId, at(9)).revision).toBe(7);
      expect(() => store.updateProcessGeneration(personalId, 3, at(10))).toThrow(
        AccountProfileGenerationRegression,
      );
      expect(store.updateProcessGeneration(personalId, 9, at(11))).toMatchObject({
        advanced: true,
        profile: {
          revision: 8,
          processGeneration: 9,
        },
      });
      expect(() =>
        store.updateProcessGeneration(personalId, Number.MAX_SAFE_INTEGER + 1, at(12))
      ).toThrow();
      expect(store.find(personalId)).toEqual(store.findAny(personalId));

      const selectedCount = database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM account_profiles WHERE selected = 1 AND removed_at IS NULL",
        )
        .get();
      expect(selectedCount?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("lets only one SQLite connection claim a proposed process generation", () => {
    const root = mkdtempSync(join(tmpdir(), "oprte-generation-claim-"));
    const databasePath = join(root, "control-plane.sqlite");
    const firstDatabase = new Database(databasePath, { create: true, strict: true });
    let secondDatabase: Database | null = null;
    try {
      firstDatabase.exec("PRAGMA foreign_keys = ON");
      applyMigrations(firstDatabase);
      const firstStore = new AccountProfileStore(firstDatabase, {
        idFactory: () => "acct_claim000001",
      });
      const profile = firstStore.create("Claimed", at(0));

      secondDatabase = new Database(databasePath, { strict: true });
      secondDatabase.exec("PRAGMA foreign_keys = ON");
      const secondStore = new AccountProfileStore(secondDatabase);
      const claims = [
        firstStore.updateProcessGeneration(profile.id, 7, at(1)),
        secondStore.updateProcessGeneration(profile.id, 7, at(2)),
      ];

      expect(claims).toMatchObject([
        { advanced: true, profile: { processGeneration: 7, revision: 2 } },
        { advanced: false, profile: { processGeneration: 7, revision: 2 } },
      ]);
      expect(claims.filter(({ advanced }) => advanced)).toHaveLength(1);
      expect(firstStore.find(profile.id)).toEqual(secondStore.find(profile.id));
    } finally {
      secondDatabase?.close();
      firstDatabase.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("previews bindings, rejects a stale removal, and tombstones without deleting work", () => {
    const database = accountDatabase();
    const store = deterministicStore(database);
    try {
      const work = store.create("Work", at(0));
      store.create("Personal", at(1));
      insertRemovalFixture(database, work.id);
      store.updateIdentityLabel(work.id, "work@example.test", at(2));
      store.updatePlanLabel(work.id, "Pro", at(3));
      store.updateAuthState(work.id, "signedIn", at(4));
      const current = store.bumpRevision(work.id, at(5));

      expect(store.removalPreview(work.id)).toEqual({
        accountProfileId: work.id,
        accountRevision: current.revision,
        label: "Work",
        threadCount: 1,
        workspaceLaneCount: 2,
        localDataState: "present",
      });
      expect(() => store.tombstone(work.id, work.revision, at(6))).toThrow(
        AccountProfileStaleRevision,
      );

      const removed = store.tombstone(work.id, current.revision, at(7));
      expect(removed.removed).toMatchObject({
        id: work.id,
        revision: current.revision + 1,
        selected: false,
        identityLabel: null,
        planLabel: null,
        authState: "signedOut",
        removedAt: at(7).toISOString(),
      });
      expect(removed.selectedReplacement).toMatchObject({
        id: personalId,
        revision: 2,
        selected: true,
      });
      expect(store.find(work.id)).toBeNull();
      expect(store.findAny(work.id)).toEqual(removed.removed);
      expect(() => store.removalPreview(work.id)).toThrow(AccountProfileNotFound);

      const bindingCounts = database
        .query<{ lanes: number; threads: number }, []>(
          `SELECT
             (SELECT count(*) FROM workspace_leases) AS lanes,
             (SELECT count(*) FROM thread_bindings) AS threads`,
        )
        .get();
      expect(bindingCounts).toEqual({ lanes: 2, threads: 1 });

      expect(store.listRetainedLocalData()).toEqual([removed.removed]);
      const deleted = store.markLocalDataDeleted(
        work.id,
        removed.removed.revision,
        at(8),
      );
      expect(deleted).toMatchObject({
        revision: removed.removed.revision + 1,
        localDataState: "deleted",
        localDataDeletedAt: at(8).toISOString(),
      });
      expect(store.listRetainedLocalData()).toEqual([]);
      expect(() => store.markLocalDataDeleted(work.id, removed.removed.revision, at(9))).toThrow(
        AccountProfileStaleRevision,
      );
      expect(store.list().map(({ id }) => id)).toEqual([personalId]);
      expect(store.listAll()).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  test("never persists an account set that can exceed the renderer snapshot", () => {
    const database = accountDatabase();
    let nextId = 0;
    const store = new AccountProfileStore(database, {
      idFactory: () => `acct_capacity${String(nextId++).padStart(4, "0")}`,
    });
    try {
      const profiles = Array.from({ length: 64 }, (_, index) =>
        store.create(`Account ${String(index + 1)}`, at(index)));
      expect(store.list()).toHaveLength(64);
      expect(() => store.create("Overflow", at(65))).toThrow(
        AccountProfileCapacityExceeded,
      );
      expect(store.list()).toHaveLength(64);

      const removed = store.tombstone(
        profiles[0]!.id,
        profiles[0]!.revision,
        at(66),
      ).removed;
      expect(store.list()).toHaveLength(63);
      expect(store.listRetainedLocalData()).toHaveLength(1);
      expect(() => store.create("Reserved recovery slot", at(67))).toThrow(
        AccountProfileCapacityExceeded,
      );

      store.markLocalDataDeleted(removed.id, removed.revision, at(68));
      expect(store.create("Reclaimed", at(69))).toMatchObject({
        label: "Reclaimed",
        revision: 1,
      });
      expect(store.list()).toHaveLength(64);
      expect(store.listRetainedLocalData()).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});

const workId = "acct_work0001";
const personalId = "acct_personal1";

function deterministicStore(database: Database): AccountProfileStore {
  const ids = [workId, personalId];
  return new AccountProfileStore(database, {
    idFactory: () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("Test account ID factory exhausted");
      return id;
    },
  });
}

function accountDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  return database;
}

function insertRemovalFixture(database: Database, accountProfileId: string): void {
  const createdAt = at(0).toISOString();
  database
    .query(
      `INSERT INTO projects
        (project_id, canonical_repository_path, canonical_git_common_dir, display_name,
         created_at, updated_at)
       VALUES ('proj_example01', '/repo', '/repo/.git', 'Example', ?1, ?1)`,
    )
    .run(createdAt);
  database
    .query(
      `INSERT INTO workspace_leases
        (lane_id, project_id, account_profile_id, canonical_checkout_path, mode, status,
         base_sha, retention, created_at, updated_at)
       VALUES
        ('lane_direct001', 'proj_example01', ?1, '/work/direct', 'managed', 'ready',
         '1111111', 'preserve', ?2, ?2),
        ('lane_thread001', 'proj_example01', NULL, '/work/thread', 'managed', 'ready',
         '2222222', 'preserve', ?2, ?2)`,
    )
    .run(accountProfileId, createdAt);
  database
    .query(
      `INSERT INTO thread_bindings
        (thread_id, codex_thread_id, account_profile_id, project_id, lane_id, created_at,
         updated_at)
       VALUES
        ('thread_work0001', 'codex-thread-1', ?1, 'proj_example01', 'lane_thread001', ?2, ?2)`,
    )
    .run(accountProfileId, createdAt);
}

function at(offsetSeconds: number): Date {
  return new Date(Date.UTC(2026, 6, 19, 12, 0, offsetSeconds));
}
