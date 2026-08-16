import { afterEach, describe, expect, test } from "bun:test";
import {
  HRA_HUMAN_KEYCHAIN_SERVICE,
  HRA_RUNNER_KEYCHAIN_SERVICE,
} from "@hraness/hra-human-client";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeLocalDataRemovalConfirmation } from "../../contracts/runtime";
import {
  HRA_SESSION_SYNC_KEYCHAIN_NAME,
  HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
  HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
} from "../src/cloud/session-sync-key-custody";
import {
  HRA_HARNESS_KEYCHAIN_NAME,
  HRA_HARNESS_LEGACY_KEYCHAIN_SERVICE,
  HRA_HARNESS_KEYCHAIN_SERVICE,
} from "../src/harness/key-custody";
import {
  createLocalDataRemovalPlan,
  controlPlaneSqliteRemovalArtifacts,
  defaultMacosApplicationStateArtifacts,
  defaultMacosReleaseUpdateArtifacts,
  discoverLocalDataRemovalInventory,
  executeLocalDataRemovalFilesystemRequest,
  FileLocalDataRemovalReceiptStore,
  inspectLocalDataRemovalStartup,
  isLocalDataRemovalHelperRequestByteLengthAllowed,
  localDataRemovalExclusionPath,
  LocalDataRemovalConfirmationError,
  packagedLocalDataRemoverBundlePath,
  prepareLocalDataRemovalHelperLaunch,
  recoverStagedLocalDataRemovalHelperState,
  resumeLocalDataRemovalHelperLaunch,
  resumePendingLocalDataRemovalHelperLaunch,
  UnsafeLocalDataRemovalTargetError,
  verifyLocalDataRemovalHelperRequest,
  type LocalDataRemovalFaultCheckpoint,
  type AuthenticatedLocalDataRemovalSecretStore,
  type AuthenticatedLocalDataRemovalKeychainAuthorization,
  type LocalDataRemovalKeychainTarget,
  type LocalDataRemovalInventory,
  type LocalDataRemovalOwnedRoots,
  maximumLocalDataRemovalHelperRequestBytes,
} from "../src/maintenance/local-data-removal";

const NOW = new Date("2026-07-25T16:00:00.000Z");
const SIGNING_KEY = new Uint8Array(32).fill(0x5a);
const NATIVE_REMOVAL_CAPABILITY = "ab".repeat(32);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

interface RemovalFixture {
  readonly root: string;
  readonly roots: LocalDataRemovalOwnedRoots;
  readonly inventory: LocalDataRemovalInventory;
  readonly signingKeyPath: string;
  readonly repository: string;
  readonly unrelatedFile: string;
  readonly globalCodexFile: string;
  readonly targets: readonly string[];
  readonly worktreeAdministrations: readonly string[];
  readonly preservedBranchRef: string;
}

async function removalFixture(): Promise<RemovalFixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "oprte-local-data-removal-")),
  );
  temporaryDirectories.push(root);
  const controlPlaneRoot = join(root, "control-plane");
  const codexRoot = join(root, "oprte-codex");
  const releaseRoot = join(root, "updates");
  const applicationStateRoot = join(root, "app-state");
  const managedWorktreesRoot = join(root, "managed-worktrees");
  const helperStateRoot = join(root, "removal-helper-state");
  const repository = join(root, "user-repository");
  const unrelatedRoot = join(root, "unrelated");
  const externalCodexRoot = join(root, "external-codex");
  for (const path of [
    controlPlaneRoot,
    codexRoot,
    releaseRoot,
    applicationStateRoot,
    managedWorktreesRoot,
    helperStateRoot,
    repository,
    unrelatedRoot,
    externalCodexRoot,
  ]) {
    await mkdir(path, { mode: 0o700 });
  }

  const controlPlane = join(controlPlaneRoot, "control-plane.sqlite");
  const hraCodexProfile = join(codexRoot, "acct_example1");
  const hraCodexHome = join(hraCodexProfile, "home");
  const hraCodexRuntime = join(hraCodexProfile, "runtime");
  const updateCache = join(releaseRoot, "downloaded-update");
  const applicationState = join(applicationStateRoot, "window-state.json");
  const cleanWorktree = join(managedWorktreesRoot, "lane-clean");
  const dirtyWorktree = join(managedWorktreesRoot, "lane-dirty");
  await writeFile(controlPlane, "database");
  await mkdir(hraCodexHome, { recursive: true, mode: 0o700 });
  await mkdir(hraCodexRuntime, { mode: 0o700 });
  await writeFile(
    join(hraCodexHome, "auth.json"),
    "OPRTE Codex credentials",
  );
  await writeFile(
    join(hraCodexRuntime, "app-server.sock"),
    "OPRTE runtime state",
  );
  await mkdir(updateCache, { mode: 0o700 });
  await writeFile(join(updateCache, "artifact.zip"), "update");
  await writeFile(applicationState, "window state");
  await mkdir(cleanWorktree, { mode: 0o700 });
  await writeFile(join(cleanWorktree, "clean.txt"), "clean");
  await symlink(unrelatedRoot, join(cleanWorktree, "external-link"));
  await mkdir(dirtyWorktree, { mode: 0o700 });
  await writeFile(join(dirtyWorktree, "dirty.txt"), "uncommitted work");
  const gitCommonDirectory = join(repository, ".git");
  const worktreeAdministrationRoot = join(
    gitCommonDirectory,
    "worktrees",
  );
  const cleanAdministration = join(worktreeAdministrationRoot, "lane-clean");
  const dirtyAdministration = join(worktreeAdministrationRoot, "lane-dirty");
  const preservedBranchRef = join(
    gitCommonDirectory,
    "refs",
    "heads",
    "oprte-preserved",
  );
  for (const administration of [
    cleanAdministration,
    dirtyAdministration,
  ]) {
    await mkdir(administration, { recursive: true, mode: 0o700 });
  }
  await mkdir(join(gitCommonDirectory, "refs", "heads"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(cleanWorktree, ".git"),
    `gitdir: ${cleanAdministration}\n`,
  );
  await writeFile(
    join(dirtyWorktree, ".git"),
    `gitdir: ${dirtyAdministration}\n`,
  );
  await writeFile(
    join(cleanAdministration, "gitdir"),
    `${join(cleanWorktree, ".git")}\n`,
  );
  await writeFile(
    join(dirtyAdministration, "gitdir"),
    `${join(dirtyWorktree, ".git")}\n`,
  );
  await writeFile(preservedBranchRef, `${"a".repeat(40)}\n`);

  const repositoryFile = join(repository, "README.md");
  const unrelatedFile = join(unrelatedRoot, "other-app.txt");
  const globalCodexFile = join(externalCodexRoot, "auth.json");
  const signingKeyPath = join(helperStateRoot, "removal-signing.key");
  await writeFile(repositoryFile, "user repository");
  await writeFile(unrelatedFile, "unrelated data");
  await writeFile(globalCodexFile, "external Codex credentials");
  await writeFile(signingKeyPath, SIGNING_KEY, { mode: 0o600 });

  return {
    root,
    roots: {
      controlPlane: [controlPlaneRoot],
      kitchenCodexProfileData: [codexRoot],
      releaseUpdateArtifacts: [releaseRoot],
      applicationState: [applicationStateRoot],
      managedWorktrees: [managedWorktreesRoot],
      helperStateRoot,
    },
    inventory: {
      filesystemTargets: [
        { category: "control_plane", path: controlPlane, kind: "file" },
        {
          category: "kitchen_codex_profile_data",
          path: hraCodexProfile,
          kind: "directory",
        },
        {
          category: "release_update_artifact",
          path: updateCache,
          kind: "directory",
        },
        {
          category: "application_state",
          path: applicationState,
          kind: "file",
        },
        {
          category: "managed_worktree",
          path: cleanWorktree,
          kind: "directory",
          dirty: false,
          registration: {
            repositoryPath: repository,
            gitCommonDirectory,
            administrativeDirectory: cleanAdministration,
          },
        },
        {
          category: "managed_worktree",
          path: dirtyWorktree,
          kind: "directory",
          dirty: true,
          registration: {
            repositoryPath: repository,
            gitCommonDirectory,
            administrativeDirectory: dirtyAdministration,
          },
        },
      ],
      keychainTargets: [
        {
          category: "human_credential_generation",
          service: HRA_HUMAN_KEYCHAIN_SERVICE,
          name: "primary:slot:human-generation-1",
        },
        {
          category: "runner_pairing_secret",
          service: HRA_RUNNER_KEYCHAIN_SERVICE,
          name: "workspace-example:slot:runner-generation-2",
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
      ],
      userRepositories: [repository],
    },
    signingKeyPath,
    repository,
    unrelatedFile,
    globalCodexFile,
    worktreeAdministrations: [
      cleanAdministration,
      dirtyAdministration,
    ],
    preservedBranchRef,
    targets: [
      controlPlane,
      hraCodexProfile,
      updateCache,
      applicationState,
      cleanWorktree,
      dirtyWorktree,
    ],
  };
}

function confirmation(
  plan: Awaited<ReturnType<typeof createLocalDataRemovalPlan>>,
  acknowledgeDirtyWorktrees: boolean,
) {
  return {
    type: "maintenance.localDataRemoval.remove",
    previewId: plan.preview.previewId,
    confirmationToken: plan.preview.confirmationToken,
    confirmation: runtimeLocalDataRemovalConfirmation,
    acknowledgeDirtyWorktrees,
  } as const;
}

function secretStore(
  deleted: string[],
): AuthenticatedLocalDataRemovalSecretStore {
  return {
    delete(input) {
      deleted.push(`${input.service}\u0000${input.name}`);
      return Promise.resolve(true);
    },
  };
}

const heldMaintenanceFence = {
  isHeld: () => true,
} as const;

function revalidation(fixture: RemovalFixture) {
  return {
    nativeRemovalCapability: NATIVE_REMOVAL_CAPABILITY,
    maintenanceFence: heldMaintenanceFence,
    revalidateInventory() {
      return Promise.resolve({
        inventory: fixture.inventory,
        ownedRoots: fixture.roots,
      });
    },
  } as const;
}

describe("whole-app local-data removal", () => {
  test("uses the helper's exact inclusive 64 MiB signed-request limit", () => {
    expect(maximumLocalDataRemovalHelperRequestBytes).toBe(
      64 * 1_024 * 1_024,
    );
    expect(isLocalDataRemovalHelperRequestByteLengthAllowed(
      maximumLocalDataRemovalHelperRequestBytes,
    )).toBe(true);
    expect(isLocalDataRemovalHelperRequestByteLengthAllowed(
      maximumLocalDataRemovalHelperRequestBytes + 1,
    )).toBe(false);
  });

  test("inventories every SQLite control-plane sidecar including rollback journals", () => {
    const database =
      "/Users/example/Library/Application Support/OPRTE/control-plane.sqlite";
    expect(controlPlaneSqliteRemovalArtifacts(database)).toEqual([
      { path: database, kind: "file" },
      { path: `${database}-wal`, kind: "file" },
      { path: `${database}-shm`, kind: "file" },
      { path: `${database}-journal`, kind: "file" },
    ]);
  });

  test("derives the exact Sparkle 2.9.4 cache leaves for current and legacy bundle identifiers", () => {
    const home = "/Users/example";
    const candidates = defaultMacosReleaseUpdateArtifacts(home).map(
      ({ path }) => path,
    );
    for (const identifier of ["kitchen.hraness", "com.jungle.kitchen"]) {
      for (const leaf of ["PersistentDownloads", "Launcher"]) {
        expect(candidates).toContain(join(
          home,
          "Library",
          "Caches",
          identifier,
          "org.sparkle-project.Sparkle",
          leaf,
        ));
      }
    }
    expect(candidates).not.toContain(join(
      home,
      "Library",
      "Caches",
      "org.sparkle-project.Sparkle",
      "kitchen.hraness",
    ));
  });

  test("includes the display-name log directory used by packaged smoke runs", () => {
    const home = "/Users/example";
    expect(defaultMacosApplicationStateArtifacts(home)).toContainEqual({
      path: join(home, "Library", "Logs", "OPRTE"),
      kind: "directory",
    });
  });

  test("rejects a forged inherited home before deriving any destructive target", async () => {
    const forgedHome = await realpath(
      await mkdtemp(join(tmpdir(), "oprte-forged-home-")),
    );
    temporaryDirectories.push(forgedHome);
    expect(discoverLocalDataRemovalInventory({
      homeDirectory: forgedHome,
      applicationSupportRoot: join(
        forgedHome,
        "Library",
        "Application Support",
        "OPRTE",
      ),
      controlPlanePath: join(
        forgedHome,
        "Library",
        "Application Support",
        "OPRTE",
        "control-plane.sqlite",
      ),
      helperStateRoot: join(
        forgedHome,
        "Library",
        "Application Support",
        "OPRTE Removal",
      ),
      hraCodexProfileRoots: [],
      managedWorktreeRoots: [
        join(
          forgedHome,
          "Library",
          "Application Support",
          "OPRTE",
          "local-task-worktrees",
        ),
      ],
      managedWorktrees: [],
      userRepositories: [],
      keychainTargets: [],
      gitInspector: {
        isDirty() {
          return Promise.resolve(false);
        },
      },
    })).rejects.toMatchObject({
      name: "UnsafeLocalDataRemovalTargetError",
      reason: "home directory does not match the effective user account",
    });
  });

  test("previews precise safe categories while keeping every private path out of the renderer value", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        preservedCredentialEvidenceRecords: 2,
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });

    expect(plan.preview).toMatchObject({
      removes: {
        controlPlaneItems: 1,
        hraCodexProfileDataItems: 1,
        humanCredentialGenerations: 1,
        runnerPairingSecrets: 1,
        harnessContextHeapKeys: 0,
        sessionSyncKeyMaterials: 2,
        releaseUpdateArtifacts: 1,
        applicationStateItems: 1,
        managedWorktrees: 2,
        dirtyManagedWorktrees: 1,
      },
      preserves: {
        userRepositories: 1,
        externalCodexData: true,
        taskctlCredentials: true,
        credentialRecoveryEvidenceRecords: 2,
        unrelatedData: true,
      },
      dirtyWorktreeAcknowledgementRequired: true,
      canRemove: true,
    });
    const rendererJson = JSON.stringify(plan.preview);
    expect(rendererJson).not.toContain(fixture.root);
    expect(rendererJson).not.toContain("Keychain");
    expect(rendererJson).not.toContain("slot:");
  });

  test("accepts only the fixed Context Heap install-key target", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        keychainTargets: [
          ...fixture.inventory.keychainTargets,
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
        ],
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_heapkey1",
      now: NOW,
    });

    expect(plan.preview.removes.harnessContextHeapKeys).toBe(2);
    expect(createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        keychainTargets: [{
          category: "harness_context_heap_key",
          service: HRA_HARNESS_KEYCHAIN_SERVICE,
          name: "another-key",
        }],
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_heapkey2",
      now: NOW,
    })).rejects.toThrow("fixed install key");
  });

  test("authenticates and atomically receipts one grouped Harness deletion", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        keychainTargets: [
          ...fixture.inventory.keychainTargets,
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
        ],
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_harness1",
      now: NOW,
    });
    const observed: Array<{
      target: LocalDataRemovalKeychainTarget;
      authorization: AuthenticatedLocalDataRemovalKeychainAuthorization;
    }> = [];
    const receipts = new FileLocalDataRemovalReceiptStore(
      fixture.roots.helperStateRoot,
    );
    await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_harness01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      revalidateInventory: () => Promise.resolve({
        inventory: {
          ...fixture.inventory,
          keychainTargets: [...plan.privatePlan.keychainTargets],
        },
        ownedRoots: fixture.roots,
      }),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: {
        delete: (target, authorization) => {
          observed.push({ target, authorization });
          return Promise.resolve(true);
        },
      },
      receipts,
      now: NOW,
    });
    const harnessCalls = observed.filter(
      ({ target }) => target.category === "harness_context_heap_key",
    );
    expect(harnessCalls).toHaveLength(1);
    expect(harnessCalls[0]?.authorization).toMatchObject({
      operationId: "op_harness01",
      previewId: "removal_harness1",
      nativeRemovalCapability: NATIVE_REMOVAL_CAPABILITY,
    });
    expect(harnessCalls[0]?.authorization.receiptAuthentication).toMatch(
      /^hmac_sha256_[a-f0-9]{64}$/u,
    );
    const [receipt] = await receipts.list();
    expect(receipt?.keychainTargets.filter(
      ({ category }) => category === "harness_context_heap_key",
    )).toEqual([
      expect.objectContaining({ completed: true }),
      expect.objectContaining({ completed: true }),
    ]);
  });

  test("accepts only the two fixed session-sync custody targets", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_sync_key1",
      now: NOW,
    });

    expect(plan.preview.removes.sessionSyncKeyMaterials).toBe(2);
    expect(createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        keychainTargets: [{
          category: "session_sync_key_material",
          service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
          name: "another-device-vault",
        }],
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_sync_key2",
      now: NOW,
    })).rejects.toThrow("fixed key material");
  });

  test("requires the additional dirty-worktree acknowledgement before any Keychain side effect", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const deleted: string[] = [];

    expect(prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, false),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore(deleted),
      receipts: new FileLocalDataRemovalReceiptStore(
        fixture.roots.helperStateRoot,
      ),
      now: NOW,
    })).rejects.toMatchObject({
      name: "LocalDataRemovalConfirmationError",
      code: "dirty_worktree_acknowledgement_required",
    });
    expect(deleted).toEqual([]);
  });

  test("durably excludes normal startup before writing the first gateway receipt", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const receipts = new FileLocalDataRemovalReceiptStore(
      fixture.roots.helperStateRoot,
    );

    expect(prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts,
      now: NOW,
      faultInjector(checkpoint) {
        if (checkpoint === "after_exclusion_before_gateway_receipt") {
          throw new Error("crash:durable-exclusion");
        }
      },
    })).rejects.toThrow("crash:durable-exclusion");

    const exclusion = localDataRemovalExclusionPath(
      fixture.roots.helperStateRoot,
    );
    const exclusionMetadata = await lstat(exclusion);
    expect(exclusionMetadata.isDirectory()).toBeTrue();
    expect(exclusionMetadata.mode & 0o777).toBe(0o700);
    expect(await receipts.list()).toEqual([]);
    expect(await inspectLocalDataRemovalStartup({
      helperStateRoot: fixture.roots.helperStateRoot,
      executionLock: {
        isLocked() {
          return Promise.resolve(false);
        },
      },
    })).toEqual({
      state: "recovery_required",
      pendingOperations: 1,
    });
  });

  test("a durable first gateway receipt remains startup-excluded and resumable", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const receipts = new FileLocalDataRemovalReceiptStore(
      fixture.roots.helperStateRoot,
    );

    expect(prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts,
      now: NOW,
      faultInjector(checkpoint) {
        if (checkpoint === "after_gateway_receipt") {
          throw new Error("crash:durable-gateway-receipt");
        }
      },
    })).rejects.toThrow("crash:durable-gateway-receipt");

    expect(await lstat(localDataRemovalExclusionPath(
      fixture.roots.helperStateRoot,
    ))).not.toBeNull();
    expect(await receipts.list()).toHaveLength(1);
    expect(await inspectLocalDataRemovalStartup({
      helperStateRoot: fixture.roots.helperStateRoot,
      executionLock: {
        isLocked() {
          return Promise.resolve(false);
        },
      },
    })).toEqual({
      state: "recovery_required",
      pendingOperations: 1,
    });

    const resumed = await resumePendingLocalDataRemovalHelperLaunch({
      parentProcessId: 42_002,
      nativeRemovalCapability: NATIVE_REMOVAL_CAPABILITY,
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts,
      maintenanceFence: heldMaintenanceFence,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(resumed).not.toBeNull();
    expect(resumed?.parentProcessId).toBe(42_002);
    expect(resumed?.signedRequest.payload.operationId).toBe(
      "op_removal01",
    );
  });

  test("deletes only exact OPRTE Keychain entries and emits a bundle-pinned quit-before-delete launch", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const deleted: string[] = [];
    const receipts = new FileLocalDataRemovalReceiptStore(
      fixture.roots.helperStateRoot,
    );

    const launch = await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore(deleted),
      receipts,
      now: NOW,
    });

    expect(deleted).toEqual([
      `${HRA_HUMAN_KEYCHAIN_SERVICE}\u0000primary:slot:human-generation-1`,
      `${HRA_RUNNER_KEYCHAIN_SERVICE}\u0000workspace-example:slot:runner-generation-2`,
      `${HRA_SESSION_SYNC_KEYCHAIN_SERVICE}\u0000${HRA_SESSION_SYNC_KEYCHAIN_NAME}`,
      `${HRA_SESSION_SYNC_KEYCHAIN_SERVICE}\u0000${HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME}`,
    ]);
    expect(launch).toMatchObject({
      executable: {
        packagedBundlePath: packagedLocalDataRemoverBundlePath,
        requireSignedBundleResource: true,
        permitPathOrEnvironmentOverrideInPackagedBuild: false,
      },
      spawnBeforeApplicationQuit: true,
      quitApplicationAfterSuccessfulLaunch: true,
      waitForParentExit: true,
      parentProcessId: 41_001,
    });
    expect(
      verifyLocalDataRemovalHelperRequest(launch.signedRequest, SIGNING_KEY),
    ).toEqual(launch.signedRequest);
    expect(JSON.stringify(launch.signedRequest)).not.toContain("slot:");

    const retry = await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore(deleted),
      receipts,
      now: NOW,
    });
    expect(retry).toEqual(launch);
    expect(deleted).toHaveLength(4);
  });

  test("atomically stages exact allowlisted targets and preserves repositories, external Codex data, and unrelated files", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const launch = await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts: new FileLocalDataRemovalReceiptStore(
        fixture.roots.helperStateRoot,
      ),
      now: NOW,
    });

    expect(await executeLocalDataRemovalFilesystemRequest({
      request: launch.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: NOW,
    })).toEqual({ state: "completed", alreadyCompleted: false });
    for (const target of fixture.targets) {
      expect(await lstat(target).catch(() => null)).toBeNull();
    }
    for (const administration of fixture.worktreeAdministrations) {
      expect(await lstat(administration).catch(() => null)).toBeNull();
    }
    expect(await readFile(join(fixture.repository, "README.md"), "utf8")).toBe(
      "user repository",
    );
    expect(await readFile(fixture.preservedBranchRef, "utf8")).toBe(
      `${"a".repeat(40)}\n`,
    );
    expect(await readFile(fixture.globalCodexFile, "utf8")).toBe(
      "external Codex credentials",
    );
    expect(await readFile(fixture.unrelatedFile, "utf8")).toBe(
      "unrelated data",
    );
    expect(
      await lstat(fixture.roots.helperStateRoot).catch(() => null),
    ).toBeNull();
    expect(
      await lstat(
        join(fixture.root, ".removal-helper-state.removing-op_removal01"),
      ).catch(() => null),
    ).toBeNull();
    expect(await executeLocalDataRemovalFilesystemRequest({
      request: launch.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: NOW,
    })).toEqual({ state: "completed", alreadyCompleted: true });
  });

  test("removes an exact stale Git administration record when its registered checkout is already missing", async () => {
    const fixture = await removalFixture();
    const missingCheckout = fixture.targets[4]!;
    const staleAdministration = fixture.worktreeAdministrations[0]!;
    await rm(missingCheckout, { recursive: true, force: false });
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const launch = await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts: new FileLocalDataRemovalReceiptStore(
        fixture.roots.helperStateRoot,
      ),
      now: NOW,
    });

    await executeLocalDataRemovalFilesystemRequest({
      request: launch.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: NOW,
    });
    expect(await lstat(staleAdministration).catch(() => null)).toBeNull();
    expect(await readFile(join(fixture.repository, "README.md"), "utf8")).toBe(
      "user repository",
    );
    expect(await readFile(fixture.preservedBranchRef, "utf8")).toBe(
      `${"a".repeat(40)}\n`,
    );
  });

  test("rejects an internally reciprocal admin record from a different repository and preserves it", async () => {
    const fixture = await removalFixture();
    const checkout = fixture.targets[4]!;
    const repositoryB = join(fixture.root, "repository-b");
    const commonB = join(repositoryB, ".git");
    const administrationB = join(commonB, "worktrees", "forged");
    await mkdir(administrationB, { recursive: true, mode: 0o700 });
    await writeFile(join(checkout, ".git"), `gitdir: ${administrationB}\n`);
    await writeFile(
      join(administrationB, "gitdir"),
      `${join(checkout, ".git")}\n`,
    );
    const forgedTargets = fixture.inventory.filesystemTargets.map((target) =>
      target.category === "managed_worktree" && target.path === checkout
        ? {
          ...target,
          registration: {
            repositoryPath: fixture.repository,
            gitCommonDirectory: commonB,
            administrativeDirectory: administrationB,
          },
        }
        : target
    );

    expect(createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        filesystemTargets: forgedTargets,
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    })).rejects.toMatchObject({
      name: "UnsafeLocalDataRemovalTargetError",
      reason:
        "managed worktree Git common directory does not belong to its preserved repository",
    });
    expect(await lstat(administrationB)).not.toBeNull();
  });

  test("recovers a crash after an atomic stage without widening or repeating the request", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const launch = await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts: new FileLocalDataRemovalReceiptStore(
        fixture.roots.helperStateRoot,
      ),
      now: NOW,
    });
    let crashed = false;
    const faultInjector = (
      checkpoint: LocalDataRemovalFaultCheckpoint,
    ): void => {
      if (!crashed && checkpoint === "after_target_stage") {
        crashed = true;
        throw new Error("injected crash");
      }
    };

    expect(executeLocalDataRemovalFilesystemRequest({
      request: launch.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: NOW,
      faultInjector,
    })).rejects.toThrow("injected crash");
    expect(await readFile(fixture.unrelatedFile, "utf8")).toBe(
      "unrelated data",
    );

    expect(await executeLocalDataRemovalFilesystemRequest({
      request: launch.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: NOW,
    })).toEqual({ state: "completed", alreadyCompleted: false });
    for (const target of fixture.targets) {
      expect(await lstat(target).catch(() => null)).toBeNull();
    }
    expect(await readFile(fixture.unrelatedFile, "utf8")).toBe(
      "unrelated data",
    );
  });

  test("recovers before and after atomic final helper-state staging, then leaves no request, key, or receipts", async () => {
    for (const crashPoint of [
      "before_helper_state_cleanup",
      "after_helper_state_staged",
    ] as const) {
      const fixture = await removalFixture();
      const plan = await createLocalDataRemovalPlan({
        inventory: fixture.inventory,
        ownedRoots: fixture.roots,
        signingKey: SIGNING_KEY,
        previewId: "removal_example1",
        now: NOW,
      });
      const launch = await prepareLocalDataRemovalHelperLaunch({
        plan,
        command: confirmation(plan, true),
        operationId: "op_removal01",
        parentProcessId: 41_001,
      ...revalidation(fixture),
        signingKey: SIGNING_KEY,
        signingKeyPath: fixture.signingKeyPath,
        secrets: secretStore([]),
        receipts: new FileLocalDataRemovalReceiptStore(
          fixture.roots.helperStateRoot,
        ),
        now: NOW,
      });
      let injected = false;

      expect(executeLocalDataRemovalFilesystemRequest({
        request: launch.signedRequest,
        signingKey: SIGNING_KEY,
        ownedRoots: fixture.roots,
        now: NOW,
        faultInjector(checkpoint) {
          if (!injected && checkpoint === crashPoint) {
            injected = true;
            throw new Error(`crash:${crashPoint}`);
          }
        },
      })).rejects.toThrow(`crash:${crashPoint}`);
      if (crashPoint === "after_helper_state_staged") {
        const unrelatedSibling = join(
          fixture.root,
          ".removal-helper-state.removing-not-an-operation",
        );
        await writeFile(unrelatedSibling, "preserve");
        expect(await recoverStagedLocalDataRemovalHelperState({
          helperStateRoot: fixture.roots.helperStateRoot,
          executionLock: {
            isLocked() {
              return Promise.resolve(false);
            },
          },
        })).toEqual({
          state: "completed",
          recoveredOperationIds: ["op_removal01"],
        });
        expect(await readFile(unrelatedSibling, "utf8")).toBe("preserve");
      } else {
        expect(await executeLocalDataRemovalFilesystemRequest({
          request: launch.signedRequest,
          signingKey: SIGNING_KEY,
          ownedRoots: fixture.roots,
          now: NOW,
        })).toEqual({ state: "completed", alreadyCompleted: false });
      }

      expect(
        await lstat(fixture.roots.helperStateRoot).catch(() => null),
      ).toBeNull();
      expect(
        await lstat(
          join(fixture.root, ".removal-helper-state.removing-op_removal01"),
        ).catch(() => null),
      ).toBeNull();
      expect(await readFile(fixture.unrelatedFile, "utf8")).toBe(
        "unrelated data",
      );
    }
  });

  test("gates expiry only before first execution and resumes a durable partial removal after sleep", async () => {
    const neverStarted = await removalFixture();
    const neverStartedPlan = await createLocalDataRemovalPlan({
      inventory: neverStarted.inventory,
      ownedRoots: neverStarted.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const neverStartedLaunch = await prepareLocalDataRemovalHelperLaunch({
      plan: neverStartedPlan,
      command: confirmation(neverStartedPlan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(neverStarted),
      signingKey: SIGNING_KEY,
      signingKeyPath: neverStarted.signingKeyPath,
      secrets: secretStore([]),
      receipts: new FileLocalDataRemovalReceiptStore(
        neverStarted.roots.helperStateRoot,
      ),
      now: NOW,
    });
    const afterExpiry = new Date(
      neverStartedLaunch.signedRequest.payload.expiresAt + 60_000,
    );
    expect(executeLocalDataRemovalFilesystemRequest({
      request: neverStartedLaunch.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: neverStarted.roots,
      now: afterExpiry,
    })).rejects.toMatchObject({
      name: "LocalDataRemovalConfirmationError",
      code: "expired_preview",
    });

    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const launch = await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts: new FileLocalDataRemovalReceiptStore(
        fixture.roots.helperStateRoot,
      ),
      now: NOW,
    });
    let injected = false;
    expect(executeLocalDataRemovalFilesystemRequest({
      request: launch.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: NOW,
      faultInjector(checkpoint) {
        if (!injected && checkpoint === "after_target_stage") {
          injected = true;
          throw new Error("crash:after_target_stage");
        }
      },
    })).rejects.toThrow("crash:after_target_stage");

    expect(await executeLocalDataRemovalFilesystemRequest({
      request: launch.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: new Date(launch.signedRequest.payload.expiresAt + 86_400_000),
    })).toEqual({ state: "completed", alreadyCompleted: false });
  });

  test("resumes a partial helper receipt from a freshly rebound parent without renderer state", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const receipts = new FileLocalDataRemovalReceiptStore(
      fixture.roots.helperStateRoot,
    );
    const original = await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts,
      now: NOW,
    });
    let crashed = false;
    expect(executeLocalDataRemovalFilesystemRequest({
      request: original.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: NOW,
      faultInjector(checkpoint) {
        if (!crashed && checkpoint === "after_target_stage_receipt") {
          crashed = true;
          throw new Error("crash:partial");
        }
      },
    })).rejects.toThrow("crash:partial");

    const rebound = await resumePendingLocalDataRemovalHelperLaunch({
      parentProcessId: 42_002,
      nativeRemovalCapability: NATIVE_REMOVAL_CAPABILITY,
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts,
      maintenanceFence: heldMaintenanceFence,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(rebound?.parentProcessId).toBe(42_002);
    expect(rebound?.signedRequest.payload.parentProcessId).toBe(42_002);
    expect(rebound?.signedRequest.signature).not.toBe(
      original.signedRequest.signature,
    );
    expect(await executeLocalDataRemovalFilesystemRequest({
      request: rebound?.signedRequest,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: new Date(NOW.getTime() + 1_000),
    })).toEqual({ state: "completed", alreadyCompleted: false });
  });

  test("retries a crash after a Keychain delete from its durable per-entry receipt", async () => {
    const fixture = await removalFixture();
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const deleted: string[] = [];
    const receipts = new FileLocalDataRemovalReceiptStore(
      fixture.roots.helperStateRoot,
    );
    let injected = false;
    expect(prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore(deleted),
      receipts,
      now: NOW,
      faultInjector(checkpoint) {
        if (!injected && checkpoint === "after_keychain_delete") {
          injected = true;
          throw new Error("crash:after_keychain_delete");
        }
      },
    })).rejects.toThrow("crash:after_keychain_delete");

    const launch = await resumeLocalDataRemovalHelperLaunch({
      operationId: "op_removal01",
      nativeRemovalCapability: NATIVE_REMOVAL_CAPABILITY,
      parentProcessId: 41_001,
      command: confirmation(plan, true),
      maintenanceFence: heldMaintenanceFence,
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore(deleted),
      receipts: new FileLocalDataRemovalReceiptStore(
        fixture.roots.helperStateRoot,
      ),
      now: NOW,
    });
    expect(launch.waitForParentExit).toBe(true);
    expect(deleted).toEqual([
      `${HRA_HUMAN_KEYCHAIN_SERVICE}\u0000primary:slot:human-generation-1`,
      `${HRA_HUMAN_KEYCHAIN_SERVICE}\u0000primary:slot:human-generation-1`,
      `${HRA_RUNNER_KEYCHAIN_SERVICE}\u0000workspace-example:slot:runner-generation-2`,
      `${HRA_SESSION_SYNC_KEYCHAIN_SERVICE}\u0000${HRA_SESSION_SYNC_KEYCHAIN_NAME}`,
      `${HRA_SESSION_SYNC_KEYCHAIN_SERVICE}\u0000${HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME}`,
    ]);
  });

  test("rejects escapes, symlinks, preserved-repository overlap, and non-OPRTE Keychain services", async () => {
    const fixture = await removalFixture();
    const outside = join(fixture.root, "outside-target.txt");
    await writeFile(outside, "outside");
    expect(createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        filesystemTargets: [
          { category: "application_state", path: outside, kind: "file" },
        ],
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    })).rejects.toBeInstanceOf(UnsafeLocalDataRemovalTargetError);
    expect(await readFile(outside, "utf8")).toBe("outside");

    const alias = join(
      fixture.roots.applicationState[0]!,
      "outside-alias",
    );
    await symlink(outside, alias);
    expect(createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        filesystemTargets: [
          { category: "application_state", path: alias, kind: "file" },
        ],
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    })).rejects.toBeInstanceOf(UnsafeLocalDataRemovalTargetError);

    expect(createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        filesystemTargets: [{
          category: "application_state",
          path: fixture.repository,
          kind: "directory",
        }],
      },
      ownedRoots: {
        ...fixture.roots,
        applicationState: [
          fixture.roots.applicationState[0]!,
          fixture.root,
        ],
      },
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    })).rejects.toBeInstanceOf(UnsafeLocalDataRemovalTargetError);

    expect(createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        keychainTargets: [{
          category: "runner_pairing_secret",
          service: "taskctl.credentials",
          name: "must-survive",
        }],
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    })).rejects.toThrow();
  });

  test("rejects signed-request tampering and operation-ID reuse with a different preview", async () => {
    const fixture = await removalFixture();
    const receipts = new FileLocalDataRemovalReceiptStore(
      fixture.roots.helperStateRoot,
    );
    const plan = await createLocalDataRemovalPlan({
      inventory: fixture.inventory,
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_example1",
      now: NOW,
    });
    const launch = await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: confirmation(plan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts,
      now: NOW,
    });
    const tampered = {
      ...launch.signedRequest,
      payload: {
        ...launch.signedRequest.payload,
        targets: launch.signedRequest.payload.targets.slice(1),
      },
    };
    expect(executeLocalDataRemovalFilesystemRequest({
      request: tampered,
      signingKey: SIGNING_KEY,
      ownedRoots: fixture.roots,
      now: NOW,
    })).rejects.toBeInstanceOf(LocalDataRemovalConfirmationError);
    expect(await readFile(fixture.targets[0]!, "utf8")).toBe("database");

    const changedPlan = await createLocalDataRemovalPlan({
      inventory: {
        ...fixture.inventory,
        filesystemTargets: fixture.inventory.filesystemTargets.slice(1),
      },
      ownedRoots: fixture.roots,
      signingKey: SIGNING_KEY,
      previewId: "removal_changed1",
      now: NOW,
    });
    expect(prepareLocalDataRemovalHelperLaunch({
      plan: changedPlan,
      command: confirmation(changedPlan, true),
      operationId: "op_removal01",
      parentProcessId: 41_001,
      ...revalidation(fixture),
      signingKey: SIGNING_KEY,
      signingKeyPath: fixture.signingKeyPath,
      secrets: secretStore([]),
      receipts,
      now: NOW,
    })).rejects.toMatchObject({
      name: "LocalDataRemovalConfirmationError",
      code: "operation_conflict",
    });
  });
});
