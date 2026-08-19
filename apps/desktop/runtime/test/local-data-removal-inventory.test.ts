import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  HRA_HUMAN_KEYCHAIN_SERVICE,
  HRA_RUNNER_KEYCHAIN_SERVICE,
} from "@hraness/hra-human-client";
import { join } from "node:path";

import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  HRA_SESSION_SYNC_KEYCHAIN_NAME,
  HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
  HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
} from "../src/cloud/session-sync-key-custody";
import {
  fixedLocalDataRemovalPaths,
  isLocalDataRemovalBundledGitPathContained,
  readLocalDataRemovalDatabaseInventory,
  reconcileGatewayManagedWorktreeInventory,
} from "../src/maintenance/local-data-removal-inventory";
import {
  controlPlaneRestoreRemovalArtifacts,
  createLocalDataRemovalPlan,
} from "../src/maintenance/local-data-removal";
import {
  HRA_HARNESS_KEYCHAIN_NAME,
  HRA_HARNESS_LEGACY_KEYCHAIN_SERVICE,
  HRA_HARNESS_KEYCHAIN_SERVICE,
} from "../src/harness/key-custody";
import type { GitRunner } from "../src/workspaces/git-runner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

function inventoryDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      canonical_repository_path TEXT NOT NULL,
      canonical_git_common_dir TEXT NOT NULL
    ) STRICT;
    CREATE TABLE repository_bindings (
      repository_public_id TEXT PRIMARY KEY,
      canonical_repository_path TEXT NOT NULL,
      canonical_git_common_dir TEXT NOT NULL
    ) STRICT;
    CREATE TABLE local_repositories (
      repository_id TEXT PRIMARY KEY,
      canonical_repository_path TEXT NOT NULL,
      canonical_git_common_dir TEXT NOT NULL,
      tombstoned_at INTEGER
    ) STRICT;
    CREATE TABLE workspace_leases (
      lane_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      canonical_checkout_path TEXT NOT NULL,
      recovery_manifest_path TEXT
    ) STRICT;
    CREATE TABLE local_run_execution_bindings (
      run_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      canonical_checkout_path TEXT,
      canonical_git_common_dir TEXT,
      recovery_manifest_path TEXT
    ) STRICT;
    CREATE TABLE account_profiles (
      profile_id TEXT PRIMARY KEY,
      removed_at TEXT
    ) STRICT;
    CREATE TABLE human_custody_metadata (
      service TEXT NOT NULL,
      name TEXT NOT NULL,
      journal_json TEXT NOT NULL,
      PRIMARY KEY (service, name)
    ) STRICT;
    CREATE TABLE human_custody_pointer_quarantine (
      service TEXT NOT NULL,
      name TEXT NOT NULL,
      slot TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (service, name, slot)
    ) STRICT;
  `);
  return database;
}

function journal(input: {
  readonly service: string;
  readonly name: string;
  readonly committed: Readonly<{ generation: number; slot: string }>;
  readonly pending?: Readonly<{ generation: number; slot: string }>;
  readonly deleting?: Readonly<{ generation: number; slot: string }>;
}): string {
  const latestGeneration = input.pending?.generation ??
    input.committed.generation;
  return JSON.stringify({
    version: 1,
    revision: 4,
    latestGeneration,
    service: input.service,
    name: input.name,
    committed: input.committed,
    ...(input.pending === undefined
      ? {}
      : {
        pending: {
          pointer: input.pending,
          replacesGeneration: input.committed.generation,
        },
      }),
    ...(input.deleting === undefined
      ? {}
      : { deleting: [input.deleting] }),
  });
}

describe("gateway local-data removal inventory", () => {
  test("inventories every v2 vault restore artifact and exact legacy v1 file", () => {
    const root = "/Users/example/Library/Application Support/OPRTE";
    expect(controlPlaneRestoreRemovalArtifacts(root)).toEqual([
      ...[
        ".control-plane-restore-v2.json",
        ".control-plane-restore-v2.json.tmp",
        ".control-plane-restore-v2.stage.sqlite",
        ".control-plane-restore-v2.rollback.sqlite",
        ".control-plane-restore-v2.stage.hmac.key",
        ".control-plane-restore-v2.rollback.hmac.key",
        ".control-plane-restore-v1.json",
        ".control-plane-restore-v1.json.tmp",
        ".control-plane-restore-v1.stage.sqlite",
        ".control-plane-restore-v1.rollback.sqlite",
        ".control-plane-restore-v1.stage.hmac.key",
        ".control-plane-restore-v1.rollback.hmac.key",
      ].map((fileName) => ({
        path: join(root, fileName),
        kind: "file" as const,
      })),
      ...[
        "attachment-vault-v2",
        ".control-plane-restore-v2.stage.attachments",
        ".control-plane-restore-v2.rollback.attachments",
      ].map((directoryName) => ({
        path: join(root, directoryName),
        kind: "directory" as const,
      })),
    ]);
  });

  test("derives only fixed effective-user removal paths", () => {
    const paths = fixedLocalDataRemovalPaths("/Users/example");
    expect(paths).toEqual({
      applicationSupportParent:
        "/Users/example/Library/Application Support",
      applicationSupportRoot:
        "/Users/example/Library/Application Support/OPRTE",
      fixedCodexProfileRoots: [
        "/Users/example/Library/Application Support/OPRTE/profiles/default/codex-home",
        "/Users/example/Library/Application Support/OPRTE/dispatch/codex-home",
        "/Users/example/Library/Application Support/OPRTE/local-task-dispatch/codex-home",
        "/Users/example/Library/Application Support/OPRTE/onboarding/codex-home",
        "/Users/example/Library/Application Support/OPRTE/chat/git-codex-home",
      ],
      controlPlanePath:
        "/Users/example/Library/Application Support/OPRTE/control-plane.sqlite",
      harnessApplicationStateRoots: [
        "/Users/example/Library/Application Support/OPRTE/harness/v1/objects",
        "/Users/example/Library/Application Support/OPRTE/harness/v1/heap",
        "/Users/example/Library/Application Support/OPRTE/harness/v1/context-values",
        "/Users/example/Library/Application Support/OPRTE/harness/v1/scratch",
      ],
      helperStateRoot:
        "/Users/example/Library/Application Support/OPRTE Removal",
      nativeInstanceLockPath:
        "/Users/example/Library/Application Support/.Hraness Kitchen.native-instance.lock",
      updateHazardPath:
        "/Users/example/Library/Application Support/.Hraness Kitchen.update-hazard-v1.json",
      updateHazardTemporaryPath:
        "/Users/example/Library/Application Support/.Hraness Kitchen.update-hazard-v1.json.tmp",
      managedWorktreeRoots: [
        "/Users/example/Library/Application Support/OPRTE/dispatch/worktrees",
        "/Users/example/Library/Application Support/OPRTE/local-task-worktrees",
        "/Users/example/Library/Application Support/OPRTE/harness/v1/worktrees",
        "/Users/example/Library/Application Support/OPRTE/chat-worktrees",
      ],
      manifestRoots: [
        "/Users/example/Library/Application Support/OPRTE/dispatch/worktrees/.oprte-manifests",
        "/Users/example/Library/Application Support/OPRTE/dispatch/worktrees/.kitchen-manifests",
        "/Users/example/Library/Application Support/OPRTE/local-task-worktrees/.oprte-manifests",
        "/Users/example/Library/Application Support/OPRTE/local-task-worktrees/.kitchen-manifests",
        "/Users/example/Library/Application Support/OPRTE/harness/v1/worktrees/.oprte-manifests",
        "/Users/example/Library/Application Support/OPRTE/harness/v1/worktrees/.kitchen-manifests",
        "/Users/example/Library/Application Support/OPRTE/chat-worktrees/.oprte-manifests",
        "/Users/example/Library/Application Support/OPRTE/chat-worktrees/.kitchen-manifests",
      ],
    });
  });

  test("rejects exact-parent and nested parent escapes from bundled Git", () => {
    const root = "/Applications/OPRTE.app/Contents/Resources/runtime/git";
    expect(isLocalDataRemovalBundledGitPathContained(
      root,
      "/Applications/OPRTE.app/Contents/Resources/runtime/bin/git",
    )).toBeFalse();
    expect(isLocalDataRemovalBundledGitPathContained(
      root,
      "/Applications/OPRTE.app/Contents/Resources/runtime",
    )).toBeFalse();
    expect(isLocalDataRemovalBundledGitPathContained(
      root,
      join(root, "bin", "git"),
    )).toBeTrue();
  });

  test("reads every repository, worktree, tombstoned profile, and custody slot", () => {
    const database = inventoryDatabase();
    try {
      const root = "/Users/example/Library/Application Support/OPRTE";
      const controlPlanePath = join(root, "control-plane.sqlite");
      const projectRepository = "/Users/example/Repositories/project";
      const projectCommon = join(projectRepository, ".git");
      const localRepository = "/Users/example/Repositories/local";
      const localCommon = join(localRepository, ".git");
      const dispatchRoot = join(root, "dispatch", "worktrees");
      const localRoot = join(root, "local-task-worktrees");
      database.query(`
        INSERT INTO projects VALUES (?1, ?2, ?3)
      `).run("project_one", projectRepository, projectCommon);
      database.query(`
        INSERT INTO repository_bindings VALUES (?1, ?2, ?3)
      `).run("repository_public_one", projectRepository, projectCommon);
      database.query(`
        INSERT INTO local_repositories VALUES (?1, ?2, ?3, ?4)
      `).run("repository_local_one", localRepository, localCommon, 50);
      database.query(`
        INSERT INTO workspace_leases VALUES (?1, ?2, ?3, ?4)
      `).run(
        "lane_dispatch_one",
        "project_one",
        join(dispatchRoot, "lane_dispatch_one"),
        join(
          dispatchRoot,
          ".oprte-manifests",
          "lane_dispatch_one.json",
        ),
      );
      database.query(`
        INSERT INTO local_run_execution_bindings VALUES (?1, ?2, ?3, ?4, ?5)
      `).run(
        "run_local_one",
        "repository_local_one",
        join(localRoot, "run_local_one"),
        localCommon,
        join(localRoot, ".oprte-manifests", "run_local_one.json"),
      );
      database.query(`
        INSERT INTO local_run_execution_bindings VALUES (?1, ?2, NULL, NULL, NULL)
      `).run(
        "run_source_checkout_one",
        "repository_local_one",
      );
      database.query(`
        INSERT INTO account_profiles VALUES (?1, ?2), (?3, ?4)
      `).run(
        "acct_active01",
        null,
        "acct_tombstone01",
        "2026-07-25T12:00:00.000Z",
      );
      const humanJournal = journal({
        service: HRA_HUMAN_KEYCHAIN_SERVICE,
        name: "primary",
        committed: { generation: 2, slot: "human_committed_001" },
        pending: { generation: 3, slot: "human_pending_0001" },
        deleting: { generation: 1, slot: "human_deleting_001" },
      });
      const runnerOneJournal = journal({
        service: HRA_RUNNER_KEYCHAIN_SERVICE,
        name: "runner-workspace-one",
        committed: { generation: 0, slot: "runner_one_slot_0001" },
      });
      const runnerTwoJournal = journal({
        service: HRA_RUNNER_KEYCHAIN_SERVICE,
        name: "runner-workspace-two",
        committed: { generation: 0, slot: "runner_two_slot_0001" },
      });
      database.query(`
        INSERT INTO human_custody_metadata VALUES
          (?1, ?2, ?3),
          (?4, ?5, ?6),
          (?7, ?8, ?9)
      `).run(
        HRA_HUMAN_KEYCHAIN_SERVICE,
        "primary",
        humanJournal,
        HRA_RUNNER_KEYCHAIN_SERVICE,
        "runner-workspace-one",
        runnerOneJournal,
        HRA_RUNNER_KEYCHAIN_SERVICE,
        "runner-workspace-two",
        runnerTwoJournal,
      );

      const inventory = readLocalDataRemovalDatabaseInventory(
        database,
        controlPlanePath,
      );
      expect(inventory.repositories).toHaveLength(3);
      expect(inventory.worktrees.map(({ source, row_id }) => [
        source,
        row_id,
      ])).toEqual([
        ["workspace_leases", "lane_dispatch_one"],
        ["local_run_execution_bindings", "run_local_one"],
        ["local_run_execution_bindings", "run_source_checkout_one"],
      ]);
      expect(inventory.worktrees.find(
        ({ row_id }) => row_id === "run_source_checkout_one",
      )).toMatchObject({
        canonical_checkout_path: null,
        recovery_manifest_path: null,
      });
      expect(inventory.hraCodexProfileRoots).toEqual([
        join(root, "codex", "accounts", "acct_active01"),
        join(root, "codex", "accounts", "acct_tombstone01"),
      ]);
      expect(inventory.keychainTargets).toEqual([
        {
          category: "human_credential_generation",
          service: HRA_HUMAN_KEYCHAIN_SERVICE,
          name: "primary:slot:human_committed_001",
        },
        {
          category: "human_credential_generation",
          service: HRA_HUMAN_KEYCHAIN_SERVICE,
          name: "primary:slot:human_pending_0001",
        },
        {
          category: "human_credential_generation",
          service: HRA_HUMAN_KEYCHAIN_SERVICE,
          name: "primary:slot:human_deleting_001",
        },
        {
          category: "runner_pairing_secret",
          service: HRA_RUNNER_KEYCHAIN_SERVICE,
          name: "runner-workspace-one:slot:runner_one_slot_0001",
        },
        {
          category: "runner_pairing_secret",
          service: HRA_RUNNER_KEYCHAIN_SERVICE,
          name: "runner-workspace-two:slot:runner_two_slot_0001",
        },
        {
          category: "harness_context_heap_key",
          service: HRA_HARNESS_LEGACY_KEYCHAIN_SERVICE,
          name: HRA_HARNESS_KEYCHAIN_NAME,
        },
        {
          category: "harness_context_heap_key",
          service: HRA_HARNESS_KEYCHAIN_SERVICE,
          name: HRA_HARNESS_KEYCHAIN_NAME,
        },
        {
          category: "session_sync_key_material",
          service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
          name: HRA_SESSION_SYNC_KEYCHAIN_NAME,
        },
        {
          category: "session_sync_key_material",
          service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
          name: HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
        },
      ]);
    } finally {
      database.close();
    }
  });

  test("reconciles both fixed roots and proves a dirty detached manifest-only orphan", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "oprte-removal-orphan-")),
    );
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const commonDirectory = join(repository, ".git");
    const administrativeRoot = join(commonDirectory, "worktrees");
    const administrativeDirectory = join(
      administrativeRoot,
      "run_orphan0001",
    );
    const dispatchRoot = join(root, "dispatch-worktrees");
    const localTaskRoot = join(root, "local-task-worktrees");
    const dispatchManifests = join(
      dispatchRoot,
      ".oprte-manifests",
    );
    const localTaskManifests = join(
      localTaskRoot,
      ".oprte-manifests",
    );
    const checkout = join(dispatchRoot, "run_orphan0001");
    await Promise.all([
      mkdir(administrativeDirectory, { recursive: true, mode: 0o700 }),
      mkdir(dispatchManifests, { recursive: true, mode: 0o700 }),
      mkdir(localTaskManifests, { recursive: true, mode: 0o700 }),
      mkdir(checkout, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      join(checkout, ".git"),
      `gitdir: ${administrativeDirectory}\n`,
    );
    await writeFile(
      join(administrativeDirectory, "gitdir"),
      `${join(checkout, ".git")}\n`,
    );
    await writeFile(
      join(dispatchManifests, "run_orphan0001.json"),
      `${JSON.stringify({
        version: 2,
        kind: "readOnlySnapshot",
        runId: "run_orphan0001",
        laneId: "run_orphan0001",
        canonicalRepositoryPath: repository,
        canonicalGitCommonDir: commonDirectory,
        baseSha: "a".repeat(40),
        canonicalCheckoutPath: checkout,
      })}\n`,
    );

    const database = inventoryDatabase();
    try {
      database.query(`
        INSERT INTO local_repositories VALUES (?1, ?2, ?3, NULL)
      `).run("repository_orphan", repository, commonDirectory);
      database.query(`
        INSERT INTO local_run_execution_bindings VALUES (?1, ?2, NULL, NULL, NULL)
      `).run("run_source_checkout_one", "repository_orphan");
      const rows = readLocalDataRemovalDatabaseInventory(
        database,
        join(root, "control-plane.sqlite"),
      );
      const git: GitRunner = {
        run(cwd, args) {
          const command = args.filter(
            (argument) => argument !== "--no-optional-locks",
          ).join(" ");
          if (command === "rev-parse --show-toplevel") {
            return Promise.resolve({
              exitCode: 0,
              stdout: cwd,
              stderr: "",
            });
          }
          if (command === "rev-parse --git-common-dir") {
            return Promise.resolve({
              exitCode: 0,
              stdout: commonDirectory,
              stderr: "",
            });
          }
          if (
            cwd === checkout &&
            command === "rev-parse --git-dir"
          ) {
            return Promise.resolve({
              exitCode: 0,
              stdout: administrativeDirectory,
              stderr: "",
            });
          }
          if (
            cwd === checkout &&
            command ===
              "status --porcelain=v1 --untracked-files=all"
          ) {
            return Promise.resolve({
              exitCode: 0,
              stdout: " M dirty.txt",
              stderr: "",
            });
          }
          return Promise.resolve({
            exitCode: 1,
            stdout: "",
            stderr: "unsupported fixture command",
          });
        },
      };

      const reconciled =
        await reconcileGatewayManagedWorktreeInventory({
          repositories: rows.repositories,
          worktrees: rows.worktrees,
          roots: [dispatchRoot, localTaskRoot],
          git,
        });
      expect([...reconciled.repositories.entries()]).toEqual([
        [repository, commonDirectory],
      ]);
      expect(reconciled.managedWorktrees).toEqual([{
        path: checkout,
        dirty: true,
        registration: {
          repositoryPath: repository,
          gitCommonDirectory: commonDirectory,
          administrativeDirectory,
        },
      }]);

      const unknown = join(localTaskRoot, "run_unknown0001");
      await mkdir(unknown, { mode: 0o700 });
      expect(reconcileGatewayManagedWorktreeInventory({
        repositories: rows.repositories,
        worktrees: rows.worktrees,
        roots: [dispatchRoot, localTaskRoot],
        git,
      })).rejects.toThrow("no exact manifest");
      await rm(unknown, { recursive: true });

      const outside = join(root, "outside");
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, join(localTaskRoot, "run_linked0001"));
      expect(reconcileGatewayManagedWorktreeInventory({
        repositories: rows.repositories,
        worktrees: rows.worktrees,
        roots: [dispatchRoot, localTaskRoot],
        git,
      })).rejects.toThrow("unknown unsafe child");
      await rm(join(localTaskRoot, "run_linked0001"));
      await rm(localTaskManifests, { recursive: true });
      await symlink(outside, localTaskManifests);
      expect(reconcileGatewayManagedWorktreeInventory({
        repositories: rows.repositories,
        worktrees: rows.worktrees,
        roots: [dispatchRoot, localTaskRoot],
        git,
      })).rejects.toThrow("manifest root is unsafe");
    } finally {
      database.close();
    }
  });

  test("classifies clean and dirty harness worktrees for separate acknowledgement", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "oprte-removal-harness-")),
    );
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const commonDirectory = join(repository, ".git");
    const administrativeRoot = join(commonDirectory, "worktrees");
    const harnessRoot = join(root, "harness", "v1", "worktrees");
    const manifestsRoot = join(harnessRoot, ".oprte-manifests");
    const helperStateRoot = join(root, "removal-helper");
    const lanes = [
      { laneId: "hmanaged_clean0001", dirty: false },
      { laneId: "hmanaged_dirty0001", dirty: true },
    ] as const;
    const administrations = new Map<string, string>();
    await Promise.all([
      mkdir(manifestsRoot, { recursive: true, mode: 0o700 }),
      mkdir(helperStateRoot, { recursive: true, mode: 0o700 }),
      ...lanes.map(async ({ laneId }) => {
        const checkout = join(harnessRoot, laneId);
        const administration = join(administrativeRoot, laneId);
        administrations.set(checkout, administration);
        await Promise.all([
          mkdir(checkout, { recursive: true, mode: 0o700 }),
          mkdir(administration, { recursive: true, mode: 0o700 }),
        ]);
        await Promise.all([
          writeFile(
            join(checkout, ".git"),
            `gitdir: ${administration}\n`,
          ),
          writeFile(
            join(administration, "gitdir"),
            `${join(checkout, ".git")}\n`,
          ),
          writeFile(
            join(manifestsRoot, `${laneId}.json`),
            `${JSON.stringify({
              version: 1,
              runId: laneId,
              laneId,
              canonicalRepositoryPath: repository,
              canonicalGitCommonDir: commonDirectory,
              baseSha: "b".repeat(40),
              branchName: `codex/oprte-${laneId}`,
              canonicalCheckoutPath: checkout,
            })}\n`,
          ),
        ]);
      }),
    ]);

    const database = inventoryDatabase();
    try {
      database.query(`
        INSERT INTO projects VALUES (?1, ?2, ?3)
      `).run("project_harness", repository, commonDirectory);
      const rows = readLocalDataRemovalDatabaseInventory(
        database,
        join(root, "control-plane.sqlite"),
      );
      const git: GitRunner = {
        run(cwd, args) {
          const command = args.filter(
            (argument) => argument !== "--no-optional-locks",
          ).join(" ");
          if (command === "rev-parse --show-toplevel") {
            return Promise.resolve({ exitCode: 0, stdout: cwd, stderr: "" });
          }
          if (command === "rev-parse --git-common-dir") {
            return Promise.resolve({
              exitCode: 0,
              stdout: commonDirectory,
              stderr: "",
            });
          }
          if (command === "rev-parse --git-dir") {
            const administration = administrations.get(cwd);
            return Promise.resolve(administration === undefined
              ? {
                exitCode: 1,
                stdout: "",
                stderr: "unknown checkout",
              }
              : { exitCode: 0, stdout: administration, stderr: "" });
          }
          if (command === "status --porcelain=v1 --untracked-files=all") {
            const lane = lanes.find(({ laneId }) =>
              cwd === join(harnessRoot, laneId)
            );
            return Promise.resolve(lane === undefined
              ? {
                exitCode: 1,
                stdout: "",
                stderr: "unknown checkout",
              }
              : {
                exitCode: 0,
                stdout: lane.dirty ? " M actor-output.txt" : "",
                stderr: "",
              });
          }
          return Promise.resolve({
            exitCode: 1,
            stdout: "",
            stderr: "unsupported fixture command",
          });
        },
      };

      const reconciled = await reconcileGatewayManagedWorktreeInventory({
        repositories: rows.repositories,
        worktrees: rows.worktrees,
        roots: [
          join(root, "dispatch", "worktrees"),
          join(root, "local-task-worktrees"),
          harnessRoot,
        ],
        git,
      });
      expect(reconciled.managedWorktrees.map(({ path, dirty }) => ({
        laneId: path.slice(harnessRoot.length + 1),
        dirty,
      })).sort((left, right) => left.laneId.localeCompare(right.laneId)))
        .toEqual(lanes.map(({ laneId, dirty }) => ({ laneId, dirty })));

      const targets = reconciled.managedWorktrees.map((candidate) => ({
        category: "managed_worktree" as const,
        path: candidate.path,
        kind: "directory" as const,
        dirty: candidate.dirty ?? false,
        registration: candidate.registration,
      }));
      const ownedRoots = {
        controlPlane: [join(root, "control-plane.sqlite")],
        kitchenCodexProfileData: [join(root, "codex")],
        releaseUpdateArtifacts: [join(root, "updates")],
        applicationState: [join(root, "application-state")],
        managedWorktrees: [harnessRoot],
        helperStateRoot,
      };
      const plan = await createLocalDataRemovalPlan({
        inventory: {
          filesystemTargets: targets,
          keychainTargets: [],
          userRepositories: [repository],
        },
        ownedRoots,
        signingKey: new Uint8Array(32).fill(0x29),
        previewId: "removal_harness01",
      });
      expect(plan.preview.removes).toMatchObject({
        managedWorktrees: 2,
        dirtyManagedWorktrees: 1,
      });
      expect(plan.preview.dirtyWorktreeAcknowledgementRequired).toBeTrue();

      const cleanPlan = await createLocalDataRemovalPlan({
        inventory: {
          filesystemTargets: targets.filter(({ dirty }) => !dirty),
          keychainTargets: [],
          userRepositories: [repository],
        },
        ownedRoots,
        signingKey: new Uint8Array(32).fill(0x2a),
        previewId: "removal_harness02",
      });
      expect(cleanPlan.preview.removes).toMatchObject({
        managedWorktrees: 1,
        dirtyManagedWorktrees: 0,
      });
      expect(cleanPlan.preview.dirtyWorktreeAcknowledgementRequired).toBeFalse();
    } finally {
      database.close();
    }
  });

  test("fails closed on malformed or unknown custody journals", () => {
    const database = inventoryDatabase();
    try {
      const controlPlanePath =
        "/Users/example/Library/Application Support/OPRTE/control-plane.sqlite";
      database.query(`
        INSERT INTO human_custody_metadata VALUES (?1, ?2, ?3)
      `).run(
        HRA_HUMAN_KEYCHAIN_SERVICE,
        "primary",
        "{not-json",
      );
      expect(() =>
        readLocalDataRemovalDatabaseInventory(database, controlPlanePath)
      ).toThrow("malformed");

      database.query("DELETE FROM human_custody_metadata").run();
      database.query(`
        INSERT INTO human_custody_metadata VALUES (?1, ?2, ?3)
      `).run(
        "taskctl.credentials",
        "external",
        journal({
          service: "taskctl.credentials",
          name: "external",
          committed: { generation: 0, slot: "external_slot_0001" },
        }),
      );
      expect(() =>
        readLocalDataRemovalDatabaseInventory(database, controlPlanePath)
      ).toThrow("unknown secret-custody service");

      database.query("DELETE FROM human_custody_metadata").run();
      const duplicatePointerJournal = JSON.stringify({
        version: 1,
        revision: 1,
        latestGeneration: 1,
        service: HRA_RUNNER_KEYCHAIN_SERVICE,
        name: "runner-duplicate",
        committed: {
          generation: 0,
          slot: "runner_duplicate_01",
        },
        deleting: [{
          generation: 1,
          slot: "runner_duplicate_01",
        }],
      });
      database.query(`
        INSERT INTO human_custody_metadata VALUES (?1, ?2, ?3)
      `).run(
        HRA_RUNNER_KEYCHAIN_SERVICE,
        "runner-duplicate",
        duplicatePointerJournal,
      );
      expect(() =>
        readLocalDataRemovalDatabaseInventory(database, controlPlanePath)
      ).toThrow();
    } finally {
      database.close();
    }
  });

  test("keeps quarantined credential evidence out of mandatory deletion", () => {
    const database = inventoryDatabase();
    try {
      const controlPlanePath =
        "/Users/example/Library/Application Support/OPRTE/control-plane.sqlite";
      database.query(`
        INSERT INTO human_custody_pointer_quarantine
          (service, name, slot, reason)
        VALUES
          (?1, ?2, ?3, 'legacy_identity_access_denied'),
          (?1, ?2, ?4, 'invalid_pointer_preserved'),
          (?1, ?2, ?5, 'missing_pointer_abandoned')
      `).run(
        HRA_HUMAN_KEYCHAIN_SERVICE,
        "primary",
        "legacy_denied_slot01",
        "invalid_preserved01",
        "missing_abandoned01",
      );

      const inventory = readLocalDataRemovalDatabaseInventory(
        database,
        controlPlanePath,
      );
      expect(inventory.keychainTargets.some(({ name }) =>
        name.includes("legacy_denied_slot01") ||
        name.includes("invalid_preserved01") ||
        name.includes("missing_abandoned01")
      )).toBeFalse();
      // Denied and invalid opaque items may still exist. Missing-pointer
      // evidence is retained durably but does not claim an item is present.
      expect(inventory.preservedCredentialEvidenceRecords).toBe(2);

      database.query(`
        INSERT INTO human_custody_pointer_quarantine
          (service, name, slot, reason)
        VALUES ('taskctl.credentials', 'external', 'unknown_service_0001',
          'legacy_identity_access_denied')
      `).run();
      expect(() =>
        readLocalDataRemovalDatabaseInventory(database, controlPlanePath)
      ).toThrow("unknown secret-custody service");
    } finally {
      database.close();
    }
  });

  test("a custody-row change produces a different exact inventory", () => {
    const database = inventoryDatabase();
    try {
      const controlPlanePath =
        "/Users/example/Library/Application Support/OPRTE/control-plane.sqlite";
      database.query(`
        INSERT INTO human_custody_metadata VALUES (?1, ?2, ?3)
      `).run(
        HRA_RUNNER_KEYCHAIN_SERVICE,
        "runner-workspace",
        journal({
          service: HRA_RUNNER_KEYCHAIN_SERVICE,
          name: "runner-workspace",
          committed: { generation: 0, slot: "runner_initial_0001" },
        }),
      );
      const before = readLocalDataRemovalDatabaseInventory(
        database,
        controlPlanePath,
      );
      database.query(`
        UPDATE human_custody_metadata SET journal_json = ?1
      `).run(journal({
        service: HRA_RUNNER_KEYCHAIN_SERVICE,
        name: "runner-workspace",
        committed: { generation: 1, slot: "runner_changed_0001" },
      }));
      const after = readLocalDataRemovalDatabaseInventory(
        database,
        controlPlanePath,
      );
      expect(after.keychainTargets).not.toEqual(before.keychainTargets);
    } finally {
      database.close();
    }
  });
});
