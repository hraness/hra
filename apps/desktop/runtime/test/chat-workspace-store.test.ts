import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertProperty, fc } from "@hra-internal/test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../src/state/database";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { WorkspaceSetupStore } from "../src/state/workspace-setup-store";
import { ProviderThreadArchiveJournalV57 } from
  "../src/state/provider-thread-archive-journal-v57";
import {
  chatWorkspaceBindingId,
  chatWorkspaceLaneId,
  ChatWorkspaceStore,
  ManagedChatWorkspaceService,
} from "../src/state/chat-workspace-store";
import type { GitResult, GitRunner } from "../src/workspaces/git-runner";
import {
  GitExecutionError,
  requireGit,
} from "../src/workspaces/git-runner";
import {
  WorkspaceBroker,
  WorkspaceCapacityError,
  type WorkspaceLaneIdentityStore,
} from "../src/workspaces/workspace-broker";

const gitBinary = Bun.which("git");
const temporaryRoots: string[] = [];
const ACCOUNT = "acct_chatworkspace1";
const REPOSITORY = `repo_${"8".repeat(26)}`;
const REPOSITORY_TWO = `repo_${"9".repeat(26)}`;
const PANE_ONE = "pane_chatworkspace01";
const PANE_TWO = "pane_chatworkspace02";
const NOW = new Date("2026-08-08T12:00:00.000Z");
const ARCHIVE_RECEIPT_KEY = new Uint8Array(32).fill(57);

class TestGitRunner implements GitRunner {
  async run(
    cwd: string,
    args: readonly string[],
  ): Promise<GitResult> {
    if (gitBinary === null) throw new Error("Git is unavailable");
    const child = Bun.spawn([gitBinary, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

interface Fixture {
  readonly database: Database;
  readonly git: TestGitRunner;
  readonly lanesRoot: string;
  readonly root: string;
  readonly panes: ChatPaneStore;
  readonly repository: Readonly<{
    id: typeof REPOSITORY;
    name: "Example";
    workingDirectory: string;
  }>;
  readonly workspaceStore: ChatWorkspaceStore;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oprte-chat-workspace-")));
  temporaryRoots.push(root);
  const repositoryPath = join(root, "repository");
  const lanesRoot = join(root, "lanes");
  await mkdir(repositoryPath);
  const git = new TestGitRunner();
  await requireGit(git, repositoryPath, ["init", "--initial-branch=main"]);
  await requireGit(git, repositoryPath, ["config", "user.name", "OPRTE test"]);
  await requireGit(git, repositoryPath, ["config", "user.email", "test@oprte.invalid"]);
  await writeFile(join(repositoryPath, "fixture.txt"), "base\n");
  await requireGit(git, repositoryPath, ["add", "fixture.txt"]);
  await requireGit(git, repositoryPath, ["commit", "-m", "base"]);
  const inspected = await new WorkspaceBroker({ git, lanesRoot })
    .inspectRepository(repositoryPath);

  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Workspace account', 'signed_in', 1, 1, ?2, ?2)
  `).run(ACCOUNT, NOW.toISOString());
  database.query(`
    INSERT INTO local_repositories (
      repository_id, name, canonical_repository_path,
      canonical_git_common_dir, created_at, updated_at
    ) VALUES (?1, 'Example', ?2, ?3, ?4, ?4)
  `).run(
    REPOSITORY,
    inspected.canonicalRepositoryPath,
    inspected.canonicalGitCommonDir,
    NOW.getTime(),
  );
  const panes = new ChatPaneStore(database, {
    messageRequestDigestKey: ARCHIVE_RECEIPT_KEY,
  });
  return {
    database,
    git,
    lanesRoot,
    root,
    panes,
    repository: {
      id: REPOSITORY,
      name: "Example",
      workingDirectory: inspected.canonicalRepositoryPath,
    },
    workspaceStore: new ChatWorkspaceStore(database, {
      now: () => NOW,
      panes,
    }),
  };
}

async function addRepository(
  value: Fixture,
): Promise<Readonly<{
  id: typeof REPOSITORY_TWO;
  name: "Other";
  workingDirectory: string;
}>> {
  const repositoryPath = join(value.root, "other-repository");
  await mkdir(repositoryPath);
  await requireGit(value.git, repositoryPath, ["init", "--initial-branch=main"]);
  await requireGit(value.git, repositoryPath, ["config", "user.name", "OPRTE test"]);
  await requireGit(value.git, repositoryPath, ["config", "user.email", "test@oprte.invalid"]);
  await writeFile(join(repositoryPath, "other.txt"), "other\n");
  await requireGit(value.git, repositoryPath, ["add", "other.txt"]);
  await requireGit(value.git, repositoryPath, ["commit", "-m", "other base"]);
  const inspected = await new WorkspaceBroker({
    git: value.git,
    lanesRoot: value.lanesRoot,
  }).inspectRepository(repositoryPath);
  value.database.query(`
    INSERT INTO local_repositories (
      repository_id, name, canonical_repository_path,
      canonical_git_common_dir, created_at, updated_at
    ) VALUES (?1, 'Other', ?2, ?3, ?4, ?4)
  `).run(
    REPOSITORY_TWO,
    inspected.canonicalRepositoryPath,
    inspected.canonicalGitCommonDir,
    NOW.getTime(),
  );
  return {
    id: REPOSITORY_TWO,
    name: "Other",
    workingDirectory: inspected.canonicalRepositoryPath,
  };
}

function createPane(value: Fixture, paneId: string) {
  return value.panes.create({
    paneId,
    repository: value.repository,
    accountProfileId: ACCOUNT,
    now: NOW,
  });
}

function prepareWorkspaceArchiveTarget(value: Fixture, paneId: string): void {
  value.database.query(`
    UPDATE chat_panes SET provider_account_profile_id = ?2,
      provider_thread_id = ?3, provider_restart_thread_id = ?4
    WHERE pane_id = ?1
  `).run(
    paneId,
    ACCOUNT,
    "thread_workspaceguard01",
    "restart_workspaceguard01",
  );
  const pane = value.panes.require(paneId);
  const profile = value.database.query<{
    process_generation: number;
    revision: number;
  }, [string]>(`
    SELECT process_generation, revision
    FROM account_profiles WHERE profile_id = ?1
  `).get(ACCOUNT);
  if (profile === null) throw new Error("workspace profile disappeared");
  const journal = new ProviderThreadArchiveJournalV57(
    value.database,
    ARCHIVE_RECEIPT_KEY,
  );
  journal.prepareTarget({
    targetId: "archtarget_workspaceguard01",
    paneId,
    purpose: "pane_archive",
    paneRevision: pane.projection.revision,
    queueRevision: null,
    paneCasDigest: "1".repeat(64),
    queueCasDigest: null,
    accountProfileId: ACCOUNT,
    accountProfileRevision: profile.revision,
    threadId: "thread_workspaceguard01",
    restartThreadId: "restart_workspaceguard01",
    binding: { kind: "none" },
    attempt: {
      attemptId: "archattempt_workspaceguard01",
      generation: profile.process_generation,
      accountProfileRevision: profile.revision,
      requestEvidenceDigest: "2".repeat(64),
      requestRevisionDigest: "3".repeat(64),
    },
    now: NOW,
  });
  journal.markEffectStarted({
    attemptId: "archattempt_workspaceguard01",
    effectEvidenceDigest: "4".repeat(64),
    effectRevisionDigest: "5".repeat(64),
    now: NOW,
  });
}

function workspaceService(
  value: Fixture,
  capacity?: { assertCanProvision(): void },
): ManagedChatWorkspaceService {
  const broker = new WorkspaceBroker({
    ...(capacity === undefined ? {} : { capacity }),
    git: value.git,
    identityStore: value.workspaceStore,
    lanesRoot: value.lanesRoot,
  });
  return new ManagedChatWorkspaceService({
    broker,
    panes: value.panes,
    store: value.workspaceStore,
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe.skipIf(gitBinary === null)("ordinary chat managed workspaces", () => {
  test("pane and generation identities are deterministic, bounded, and collision-free", () => {
    assertProperty(fc.property(
      fc.uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), {
        minLength: 1,
        maxLength: 64,
      }),
      fc.integer({ min: 1, max: 64 }),
      (indices, generation) => {
        const paneIds = indices.map((index) =>
          `pane_property${String(index).padStart(8, "0")}`
        );
        const lanes = paneIds.map((paneId) =>
          chatWorkspaceLaneId(paneId, generation)
        );
        const bindings = lanes.map(chatWorkspaceBindingId);
        expect(new Set(lanes).size).toBe(lanes.length);
        expect(new Set(bindings).size).toBe(bindings.length);
        expect(lanes.map((_, index) =>
          chatWorkspaceLaneId(paneIds[index]!, generation)
        )).toEqual(lanes);
        expect(lanes.every((lane) => lane.length === 37)).toBeTrue();
        expect(bindings.every((binding) => binding.length === 39)).toBeTrue();
      },
    ));
  });

  test("v57 archive authority freezes every workspace admission and pane writer", async () => {
    const value = await fixture();
    try {
      createPane(value, PANE_ONE);
      prepareWorkspaceArchiveTarget(value, PANE_ONE);
      const laneId = value.workspaceStore.expectedLaneId(PANE_ONE);
      const identity = {
        baseSha: "a".repeat(40),
        branchName: `codex/oprte-${laneId}`,
        canonicalCheckoutPath: join(value.lanesRoot, laneId),
        canonicalGitCommonDir: join(value.repository.workingDirectory, ".git"),
        canonicalRepositoryPath: value.repository.workingDirectory,
        laneId,
        recoveryManifestPath: join(value.lanesRoot, `${laneId}.json`),
        runId: laneId,
      };
      const before = value.database.query(`
        SELECT workspace_state, workspace_revision, revision
        FROM chat_panes WHERE pane_id = ?1
      `).get(PANE_ONE);

      expect(() => value.workspaceStore.authorizeWorkspaceLaneRecovery(identity))
        .toThrow("only its exact recovery may continue");
      expect(() => value.workspaceStore.bindWorkspaceLane(identity))
        .toThrow("only its exact recovery may continue");
      expect(() => value.workspaceStore.markWorkspaceLaneReady(identity))
        .toThrow("only its exact recovery may continue");
      expect(() => value.workspaceStore.beginProvisioning(PANE_ONE))
        .toThrow("only its exact recovery may continue");
      expect(() => value.workspaceStore.markWaiting(
        PANE_ONE,
        "capacity_unavailable",
      )).toThrow("only its exact recovery may continue");
      expect(() => value.workspaceStore.markRecovery(PANE_ONE, "unknown"))
        .toThrow("only its exact recovery may continue");

      expect(value.database.query(`
        SELECT workspace_state, workspace_revision, revision
        FROM chat_panes WHERE pane_id = ?1
      `).get(PANE_ONE)).toEqual(before);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM chat_pane_workspace_bindings
      `).get()).toEqual({ count: 0 });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM workspace_leases
      `).get()).toEqual({ count: 0 });
    } finally {
      value.database.close();
    }
  });

  test("gives every pane a distinct restart-stable checkout and preserves it on close", async () => {
    const value = await fixture();
    try {
      createPane(value, PANE_ONE);
      createPane(value, PANE_TWO);
      const firstService = workspaceService(value);
      const [first, second] = await Promise.all([
        firstService.provision(PANE_ONE, value.repository),
        firstService.provision(PANE_TWO, value.repository),
      ]);
      expect(first.workspace).toMatchObject({
        mode: "managedWorktree",
        state: "ready",
        recoveryKind: null,
      });
      expect(second.workspace).toMatchObject({ state: "ready" });

      const firstRepository = await firstService.resolve(PANE_ONE, value.repository);
      const secondRepository = await firstService.resolve(PANE_TWO, value.repository);
      expect(firstRepository).not.toBeNull();
      expect(secondRepository).not.toBeNull();
      expect(firstRepository?.workingDirectory).not.toBe(value.repository.workingDirectory);
      expect(secondRepository?.workingDirectory).not.toBe(value.repository.workingDirectory);
      expect(firstRepository?.workingDirectory).not.toBe(secondRepository?.workingDirectory);
      expect(await requireGit(
        value.git,
        firstRepository!.workingDirectory,
        ["branch", "--show-current"],
      )).toStartWith("codex/oprte-chat_");

      const restarted = workspaceService(value);
      expect(await restarted.resolve(PANE_ONE, value.repository)).toEqual(firstRepository);
      const latest = value.panes.require(PANE_ONE).projection;
      value.panes.remove(PANE_ONE, latest.revision, NOW);
      restarted.release(PANE_ONE);
      expect(value.panes.get(PANE_ONE)).toBeNull();
      expect(value.panes.list()).toHaveLength(1);
      expect(value.workspaceStore.activeBinding(PANE_ONE)).toBeNull();
      const preserved = value.database.query<{
        state: string;
        canonical_checkout_path: string;
      }, []>(`
        SELECT state, canonical_checkout_path
        FROM chat_pane_workspace_bindings WHERE pane_id = '${PANE_ONE}'
      `).get();
      expect(preserved?.state).toBe("preserved");
      expect((await stat(preserved!.canonical_checkout_path)).isDirectory()).toBeTrue();
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("never retries a v62-ready recipe lane after clean replacement is required", async () => {
    const value = await fixture();
    try {
      createPane(value, PANE_ONE);
      const service = workspaceService(value);
      const ready = await service.provision(PANE_ONE, value.repository);
      expect(ready.workspace?.state).toBe("ready");
      const binding = value.workspaceStore.activeBinding(PANE_ONE);
      if (binding === null) throw new Error("Expected ready workspace binding");
      const setup = new WorkspaceSetupStore(value.database, { now: () => NOW });
      const fenced = setup.requireCleanReplacementForLegacyReadyLane({
        identity: {
          runId: binding.expected_lane_id,
          laneId: binding.expected_lane_id,
          baseSha: binding.base_sha,
          branchName: binding.branch_name,
          canonicalRepositoryPath: binding.canonical_repository_path,
          canonicalGitCommonDir: binding.canonical_git_common_dir,
          canonicalCheckoutPath: binding.canonical_checkout_path,
          recoveryManifestPath: binding.recovery_manifest_path,
        },
        recipeDigest: "a".repeat(64),
        executorDigest: "b".repeat(64),
      });
      expect(fenced).toMatchObject({
        state: "rejected",
        failureCode: "clean_replacement_required",
      });

      const stillBlocked = await service.provision(PANE_ONE, value.repository);
      expect(stillBlocked.workspace).toMatchObject({
        state: "recoveryRequired",
        recoveryKind: "provisionInterrupted",
      });
      expect(value.workspaceStore.activeBinding(PANE_ONE)).toMatchObject({
        state: "quarantined",
        recovery_reason: "provision_interrupted",
      });
      expect(setup.headForLane(binding.expected_lane_id)).toEqual(fenced);
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("waits durably for capacity and an explicit retry resumes exact provisioning", async () => {
    const value = await fixture();
    try {
      const created = createPane(value, PANE_ONE);
      const blocked = await workspaceService(value, {
        assertCanProvision() {
          throw new WorkspaceCapacityError("insufficient_disk");
        },
      }).provision(PANE_ONE, value.repository);
      expect(blocked).toMatchObject({
        revision: created.revision + 1,
        workspace: {
          state: "waitingCapacity",
          recoveryKind: "insufficientDisk",
        },
      });
      expect(value.workspaceStore.activeBinding(PANE_ONE)).toBeNull();

      const retrying = value.panes.recoverWorkspace(
        PANE_ONE,
        blocked.revision,
        NOW,
      );
      expect(retrying.workspace).toMatchObject({
        state: "preparing",
        recoveryKind: null,
      });
      const ready = await workspaceService(value).provision(PANE_ONE, value.repository);
      expect(ready.workspace).toMatchObject({ state: "ready", recoveryKind: null });
      expect(await workspaceService(value).resolve(PANE_ONE, value.repository)).not.toBeNull();
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("classifies bounded Git admission as retryable workspace capacity", async () => {
    const value = await fixture();
    try {
      const created = createPane(value, PANE_ONE);
      const capacityGit: GitRunner = {
        run: () => Promise.reject(new GitExecutionError("capacity_unavailable")),
      };
      const blocked = await new ManagedChatWorkspaceService({
        broker: new WorkspaceBroker({
          git: capacityGit,
          identityStore: value.workspaceStore,
          lanesRoot: value.lanesRoot,
        }),
        panes: value.panes,
        store: value.workspaceStore,
      }).provision(PANE_ONE, value.repository);

      expect(blocked).toMatchObject({
        revision: created.revision + 1,
        workspace: {
          state: "waitingCapacity",
          recoveryKind: "capacityUnavailable",
        },
      });
      expect(value.workspaceStore.activeBinding(PANE_ONE)).toBeNull();
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("adopts an exact checkout after a crash between Git creation and readiness", async () => {
    const value = await fixture();
    try {
      createPane(value, PANE_ONE);
      let failReadiness = true;
      const crashStore: WorkspaceLaneIdentityStore = {
        bindWorkspaceLane: (input) => value.workspaceStore.bindWorkspaceLane(input),
        markWorkspaceLaneReady: (input) => {
          if (failReadiness) {
            failReadiness = false;
            throw new Error("simulated process loss before readiness commit");
          }
          value.workspaceStore.markWorkspaceLaneReady(input);
        },
      };
      const interrupted = new WorkspaceBroker({
        git: value.git,
        identityStore: crashStore,
        lanesRoot: value.lanesRoot,
      });
      const baseSha = await interrupted.resolveBase(
        value.repository.workingDirectory,
        "HEAD",
      );
      const interruptedError = await interrupted.provision({
        runId: value.workspaceStore.expectedLaneId(PANE_ONE),
        repositoryPath: value.repository.workingDirectory,
        baseSha,
      }).then(() => null, (error: unknown) => error);
      expect(interruptedError).toBeInstanceOf(Error);
      expect((interruptedError as Error).message).toContain("simulated process loss");
      const interruptedBinding = value.workspaceStore.activeBinding(PANE_ONE);
      expect(interruptedBinding?.state).toBe("provisioning");
      expect((await stat(interruptedBinding!.canonical_checkout_path)).isDirectory())
        .toBeTrue();
      expect(value.panes.require(PANE_ONE).projection.workspace?.state)
        .toBe("preparing");

      const ready = await workspaceService(value).provision(PANE_ONE, value.repository);
      expect(ready.workspace).toMatchObject({
        state: "ready",
        recoveryKind: null,
      });
      expect(value.workspaceStore.activeBinding(PANE_ONE)?.canonical_checkout_path)
        .toBe(interruptedBinding?.canonical_checkout_path);
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("quarantines an exact filesystem lane that has no prior durable chat binding", async () => {
    const value = await fixture();
    try {
      createPane(value, PANE_ONE);
      const laneId = value.workspaceStore.expectedLaneId(PANE_ONE);
      const unboundBroker = new WorkspaceBroker({
        git: value.git,
        lanesRoot: value.lanesRoot,
      });
      const baseSha = await unboundBroker.resolveBase(
        value.repository.workingDirectory,
        "HEAD",
      );
      const orphan = await unboundBroker.provision({
        runId: laneId,
        repositoryPath: value.repository.workingDirectory,
        baseSha,
      });
      expect(value.workspaceStore.activeBinding(PANE_ONE)).toBeNull();

      const projected = await workspaceService(value).provision(
        PANE_ONE,
        value.repository,
      );
      expect(projected.workspace).toMatchObject({
        state: "recoveryRequired",
        recoveryKind: "bindingMismatch",
      });
      expect(value.workspaceStore.activeBinding(PANE_ONE)).toBeNull();
      expect((await stat(orphan.checkoutPath)).isDirectory()).toBeTrue();
      expect(await readFile(
        join(value.lanesRoot, ".oprte-manifests", `${laneId}.json`),
        "utf8",
      )).toContain(`"laneId":"${laneId}"`);
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("preserves every prior generation while project reselection gets a fresh lane", async () => {
    const value = await fixture();
    try {
      const other = await addRepository(value);
      createPane(value, PANE_ONE);
      const service = workspaceService(value);
      const firstReady = await service.provision(PANE_ONE, value.repository);
      const firstBinding = value.workspaceStore.activeBinding(PANE_ONE);
      if (firstBinding === null) throw new Error("Expected first workspace binding");

      const selectedOther = value.panes.selectRepository(
        PANE_ONE,
        firstReady.revision,
        other,
        NOW,
      );
      const secondReady = await service.provision(PANE_ONE, other);
      const secondBinding = value.workspaceStore.activeBinding(PANE_ONE);
      if (secondBinding === null) throw new Error("Expected second workspace binding");
      expect(selectedOther.workspace?.state).toBe("preparing");
      expect(secondBinding.expected_lane_id).not.toBe(firstBinding.expected_lane_id);
      expect(secondBinding.canonical_checkout_path).not.toBe(
        firstBinding.canonical_checkout_path,
      );

      value.panes.selectRepository(
        PANE_ONE,
        secondReady.revision,
        value.repository,
        NOW,
      );
      await service.provision(PANE_ONE, value.repository);
      const thirdBinding = value.workspaceStore.activeBinding(PANE_ONE);
      if (thirdBinding === null) throw new Error("Expected third workspace binding");
      expect(new Set([
        firstBinding.expected_lane_id,
        secondBinding.expected_lane_id,
        thirdBinding.expected_lane_id,
      ]).size).toBe(3);
      expect(new Set([
        firstBinding.canonical_checkout_path,
        secondBinding.canonical_checkout_path,
        thirdBinding.canonical_checkout_path,
      ]).size).toBe(3);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM chat_pane_workspace_bindings
        WHERE pane_id = ?1 AND state = 'preserved'
      `).get(PANE_ONE)).toEqual({ count: 2 });
      expect((await stat(firstBinding.canonical_checkout_path)).isDirectory()).toBeTrue();
      expect((await stat(secondBinding.canonical_checkout_path)).isDirectory()).toBeTrue();
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("quarantines manifest drift, preserves bytes, and never falls back to the source checkout", async () => {
    const value = await fixture();
    try {
      createPane(value, PANE_ONE);
      const initial = workspaceService(value);
      await initial.provision(PANE_ONE, value.repository);
      const binding = value.workspaceStore.activeBinding(PANE_ONE);
      if (binding === null) throw new Error("Expected a workspace binding");
      const manifest = JSON.parse(
        await readFile(binding.recovery_manifest_path, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(binding.recovery_manifest_path, `${JSON.stringify({
        ...manifest,
        laneId: `chat_${"f".repeat(32)}`,
      })}\n`);
      await writeFile(join(binding.canonical_checkout_path, "preserved.txt"), "keep\n");

      expect(await initial.resolve(PANE_ONE, value.repository)).toBeNull();
      expect(value.panes.require(PANE_ONE).projection.workspace).toMatchObject({
        state: "recoveryRequired",
        recoveryKind: "bindingMismatch",
      });
      expect(await readFile(
        join(binding.canonical_checkout_path, "preserved.txt"),
        "utf8",
      )).toBe("keep\n");
      expect(value.repository.workingDirectory).not.toBe(binding.canonical_checkout_path);
    } finally {
      value.database.close();
    }
  }, 30_000);
});
