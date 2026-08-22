import { afterEach, describe, expect, test } from "bun:test";
import { assertAsyncProperty, fc } from "@hra-internal/test";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertHarnessDirectoryIdentity,
  prepareHarnessStorageLayout,
} from "../src/harness/storage-layout";
import type {
  GitResult,
  GitRunner,
  GitRunOptions,
} from "../src/workspaces/git-runner";
import { requireGit } from "../src/workspaces/git-runner";
import {
  WorkspaceBroker,
  WorkspaceCapacityError,
  WorkspaceLaneQuarantinedError,
  type WorkspaceLaneIdentity,
  type WorkspaceLaneIdentityStore,
} from "../src/workspaces/workspace-broker";
import type { WorkspaceSetupGate } from "../src/workspaces/workspace-setup";

const temporaryRoots: string[] = [];
const gitBinary = Bun.which("git");

class TestGitRunner implements GitRunner {
  async run(cwd: string, args: readonly string[]): Promise<GitResult> {
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

class ObservedGitRunner implements GitRunner {
  readonly #delegate: GitRunner;
  readonly #observe: (args: readonly string[]) => void;

  constructor(
    delegate: GitRunner,
    observe: (args: readonly string[]) => void,
  ) {
    this.#delegate = delegate;
    this.#observe = observe;
  }

  run(
    cwd: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): Promise<GitResult> {
    this.#observe(args);
    return this.#delegate.run(cwd, args, options);
  }
}

class MemoryWorkspaceIdentityStore implements WorkspaceLaneIdentityStore {
  identity: WorkspaceLaneIdentity | null = null;
  recoveryOverride: WorkspaceLaneIdentity | null | undefined;
  readonly events: string[] = [];
  readyCalls = 0;

  bindWorkspaceLane(input: WorkspaceLaneIdentity): WorkspaceLaneIdentity {
    if (this.identity === null) this.identity = input;
    return this.identity;
  }

  authorizeWorkspaceLaneRecovery(): WorkspaceLaneIdentity | null {
    return this.recoveryOverride === undefined
      ? this.identity
      : this.recoveryOverride;
  }

  markWorkspaceLaneReady(): void {
    this.events.push("ready");
    this.readyCalls += 1;
  }
}

async function repositoryFixture(prefix: string): Promise<{
  readonly baseSha: string;
  readonly git: TestGitRunner;
  readonly lanesRoot: string;
  readonly repository: string;
  readonly root: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  const lanesRoot = join(root, "lanes");
  await mkdir(repository);
  const git = new TestGitRunner();
  await requireGit(git, repository, ["init", "--initial-branch=main"]);
  await requireGit(git, repository, ["config", "user.name", "OPRTE test"]);
  await requireGit(git, repository, ["config", "user.email", "test@oprte.invalid"]);
  await writeFile(join(repository, "fixture.txt"), "base\n");
  await requireGit(git, repository, ["add", "fixture.txt"]);
  await requireGit(git, repository, ["commit", "-m", "base"]);
  const broker = new WorkspaceBroker({ git, lanesRoot });
  const baseSha = await broker.resolveBase(repository, "HEAD");
  return { baseSha, git, lanesRoot, repository, root };
}

async function preparedLanesFixture(root: string): Promise<{
  readonly applicationSupport: string;
  readonly layout: ReturnType<typeof prepareHarnessStorageLayout>;
}> {
  const applicationSupport = join(root, "OPRTE");
  await mkdir(applicationSupport, { mode: 0o700 });
  const controlPlanePath = join(applicationSupport, "control-plane.sqlite");
  await writeFile(controlPlanePath, "sqlite fixture", { mode: 0o600 });
  return {
    applicationSupport,
    layout: prepareHarnessStorageLayout(controlPlanePath),
  };
}

async function quarantineReason(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof WorkspaceLaneQuarantinedError) return error.reason;
    throw error;
  }
  throw new Error("Expected the managed lane to be quarantined");
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected the operation to fail");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(gitBinary === null)("managed workspace broker", () => {
  test(
    "fails closed before Git mutation when a new lane lacks disk admission",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-capacity-",
      );
      const commands: string[][] = [];
      const broker = new WorkspaceBroker({
        capacity: {
          assertCanProvision() {
            throw new WorkspaceCapacityError("insufficient_disk");
          },
        },
        git: new ObservedGitRunner(git, (args) => commands.push([...args])),
        lanesRoot,
      });

      expect(await rejectionMessage(broker.provision({
        runId: "run_capacity0001",
        repositoryPath: repository,
        baseSha,
      }))).toBe("Managed workspace is waiting for sufficient disk capacity");
      expect(commands.some((args) =>
        args[0] === "worktree" && args[1] === "add"
      )).toBeFalse();
      expect(await readFile(
        join(lanesRoot, ".oprte-manifests", "run_capacity0001.json"),
        "utf8",
      ).catch(() => null)).toBeNull();
    },
    20_000,
  );

  test(
    "serializes new lanes across broker instances for one Git common directory",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-serialized-",
      );
      let releaseFirst!: () => void;
      const firstMayFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let capacityCalls = 0;
      let active = 0;
      let maximumActive = 0;
      let enteredFirst!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        enteredFirst = resolve;
      });
      const capacity = {
        async assertCanProvision(): Promise<void> {
          capacityCalls += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (capacityCalls === 1) {
            enteredFirst();
            await firstMayFinish;
          }
          active -= 1;
        },
      };
      const first = new WorkspaceBroker({ capacity, git, lanesRoot }).provision({
        runId: "run_serial000001",
        repositoryPath: repository,
        baseSha,
      });
      await firstEntered;
      const second = new WorkspaceBroker({ capacity, git, lanesRoot }).provision({
        runId: "run_serial000002",
        repositoryPath: repository,
        baseSha,
      });
      await Bun.sleep(25);
      expect(capacityCalls).toBe(1);
      releaseFirst();
      const workspaces = await Promise.all([first, second]);

      expect(maximumActive).toBe(1);
      expect(capacityCalls).toBe(2);
      expect(new Set(workspaces.map((workspace) => workspace.checkoutPath)).size)
        .toBe(2);
    },
    20_000,
  );

  test(
    "recovers an existing exact lane even when new provisioning is capacity-blocked",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-capacity-recovery-",
      );
      const first = await new WorkspaceBroker({ git, lanesRoot }).provision({
        runId: "run_capacity0002",
        repositoryPath: repository,
        baseSha,
      });
      const replay = await new WorkspaceBroker({
        capacity: {
          assertCanProvision() {
            throw new WorkspaceCapacityError("insufficient_disk");
          },
        },
        git,
        lanesRoot,
      }).provision({
        runId: "run_capacity0002",
        repositoryPath: repository,
        baseSha,
      });

      expect(replay).toEqual({ ...first, recovered: true });
    },
    20_000,
  );

  test(
    "gates created and recovered lanes before the durable ready edge",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "hra-workspace-setup-gate-",
      );
      const identityStore = new MemoryWorkspaceIdentityStore();
      let blocked = true;
      let calls = 0;
      const setupGate: WorkspaceSetupGate = {
        async beforeWorkspaceReady(input) {
          calls += 1;
          identityStore.events.push("setup");
          expect(await lstat(input.canonicalCheckoutPath)).toMatchObject({});
          if (blocked) throw new Error("approval required");
        },
      };
      const broker = new WorkspaceBroker({
        git,
        identityStore,
        lanesRoot,
        setupGate,
      });

      expect(await rejectionMessage(broker.provision({
        runId: "run_setupgate001",
        repositoryPath: repository,
        baseSha,
      }))).toBe("approval required");
      expect(identityStore.identity).not.toBeNull();
      expect(identityStore.readyCalls).toBe(0);
      expect(await lstat(join(lanesRoot, "run_setupgate001"))).toMatchObject({});

      blocked = false;
      const recovered = await broker.provision({
        runId: "run_setupgate001",
        repositoryPath: repository,
        baseSha,
      });
      expect(recovered.recovered).toBeTrue();
      expect(calls).toBe(2);
      expect(identityStore.events).toEqual(["setup", "setup", "ready"]);
      expect(identityStore.readyCalls).toBe(1);
    },
    20_000,
  );

  test(
    "does not retain the repository provisioning lock while setup waits",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "hra-workspace-setup-unlocked-",
      );
      let releaseFirst!: () => void;
      const firstMayFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstEntered!: () => void;
      const firstSetupEntered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      let secondEntered!: () => void;
      const secondSetupEntered = new Promise<void>((resolve) => {
        secondEntered = resolve;
      });
      const setupGate: WorkspaceSetupGate = {
        async beforeWorkspaceReady(input) {
          if (input.laneId === "run_setupslow001") {
            firstEntered();
            await firstMayFinish;
          } else {
            secondEntered();
          }
        },
      };
      const broker = new WorkspaceBroker({ git, lanesRoot, setupGate });
      const first = broker.provision({
        runId: "run_setupslow001",
        repositoryPath: repository,
        baseSha,
      });
      await firstSetupEntered;
      const second = broker.provision({
        runId: "run_setupslow002",
        repositoryPath: repository,
        baseSha,
      });
      await Promise.race([
        secondSetupEntered,
        Bun.sleep(2_000).then(() => {
          throw new Error("second lane remained behind the setup gate lock");
        }),
      ]);
      releaseFirst();
      await Promise.all([first, second]);
    },
    20_000,
  );

  test(
    "never applies the managed setup gate to read-only snapshots",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "hra-workspace-setup-read-only-",
      );
      let calls = 0;
      const broker = new WorkspaceBroker({
        git,
        lanesRoot,
        setupGate: {
          beforeWorkspaceReady() {
            calls += 1;
            return Promise.resolve();
          },
        },
      });
      await broker.provisionReadOnlySnapshot({
        snapshotId: "snapshot_setupreadonly01",
        repositoryPath: repository,
        sourceSha: baseSha,
      });
      expect(calls).toBe(0);
    },
    20_000,
  );

  test(
    "bounds but parallelizes exact same-repository recovery inspection",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-parallel-recovery-",
      );
      const laneIds = Array.from(
        { length: 12 },
        (_, index) => `run_recover${String(index + 1).padStart(6, "0")}`,
      );
      const creator = new WorkspaceBroker({ git, lanesRoot });
      for (const runId of laneIds) {
        await creator.provision({ runId, repositoryPath: repository, baseSha });
      }

      let active = 0;
      let maximumActive = 0;
      const delayedGit: GitRunner = {
        async run(cwd, args) {
          const recoveryBranchProbe = args[0] === "branch" &&
            args[1] === "--show-current" && cwd.startsWith(lanesRoot);
          if (!recoveryBranchProbe) return await git.run(cwd, args);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          try {
            await Bun.sleep(40);
            return await git.run(cwd, args);
          } finally {
            active -= 1;
          }
        },
      };
      const broker = new WorkspaceBroker({ git: delayedGit, lanesRoot });
      const recovered = await Promise.all(laneIds.map((runId) =>
        broker.provision({ runId, repositoryPath: repository, baseSha })
      ));

      expect(recovered.every((workspace) => workspace.recovered)).toBeTrue();
      expect(maximumActive).toBeGreaterThan(1);
      expect(maximumActive).toBeLessThanOrEqual(8);
      expect(new Set(recovered.map(({ checkoutPath }) => checkoutPath)).size)
        .toBe(laneIds.length);
    },
    30_000,
  );

  test(
    "rejects a prepared lanes root redirected through a replaced ancestor before Git mutation",
    async () => {
      const { baseSha, git, repository, root } = await repositoryFixture(
        "oprte-workspace-guarded-ancestor-",
      );
      const { applicationSupport, layout } = await preparedLanesFixture(root);
      const displaced = join(root, "OPRTE-displaced");
      await rename(applicationSupport, displaced);
      await symlink(displaced, applicationSupport);

      // The leaf still resolves to the captured inode. Exact realpath equality
      // is what detects the redirected ancestor during canonical preparation.
      expect(() => assertHarnessDirectoryIdentity(layout.lanesRootIdentity))
        .not.toThrow();
      const commands: string[][] = [];
      const observedGit = new ObservedGitRunner(git, (args) => {
        commands.push([...args]);
      });
      const broker = new WorkspaceBroker({
        git: observedGit,
        lanesRoot: layout.lanesRoot,
        lanesRootGuard: {
          assertCurrent(path) {
            if (path !== layout.lanesRoot) {
              throw new Error("Unexpected guarded lanes root");
            }
            assertHarnessDirectoryIdentity(layout.lanesRootIdentity);
          },
        },
      });

      expect(await rejectionMessage(broker.provision({
        runId: "run_guarded0001",
        repositoryPath: repository,
        baseSha,
      }))).toBe("Managed-worktree root must use its canonical path");
      expect(commands.some((args) =>
        args[0] === "worktree" && args[1] === "add"
      )).toBeFalse();
    },
    20_000,
  );

  test(
    "stops before worktree creation when the retained-root guard fails",
    async () => {
      const { baseSha, git, repository, root } = await repositoryFixture(
        "oprte-workspace-guard-failure-",
      );
      const { layout } = await preparedLanesFixture(root);
      const commands: string[][] = [];
      let rejectRoot = false;
      const observedGit = new ObservedGitRunner(git, (args) => {
        commands.push([...args]);
        if (args[0] === "show-ref") rejectRoot = true;
      });
      const broker = new WorkspaceBroker({
        git: observedGit,
        lanesRoot: layout.lanesRoot,
        lanesRootGuard: {
          assertCurrent(path) {
            if (path !== layout.lanesRoot) {
              throw new Error("Unexpected guarded lanes root");
            }
            assertHarnessDirectoryIdentity(layout.lanesRootIdentity);
            if (rejectRoot) throw new Error("Injected lanes-root guard failure");
          },
        },
      });

      expect(await rejectionMessage(broker.provision({
        runId: "run_guarded0002",
        repositoryPath: repository,
        baseSha,
      }))).toBe("Injected lanes-root guard failure");
      expect(commands.some((args) => args[0] === "show-ref")).toBeTrue();
      expect(commands.some((args) =>
        args[0] === "worktree" && args[1] === "add"
      )).toBeFalse();
    },
    20_000,
  );

  test(
    "reasserts the retained root around worktree creation and recovery",
    async () => {
      const { baseSha, git, repository, root } = await repositoryFixture(
        "oprte-workspace-guard-span-",
      );
      const { layout } = await preparedLanesFixture(root);
      const events: string[] = [];
      const observedGit = new ObservedGitRunner(git, (args) => {
        if (args[0] === "worktree" && args[1] === "add") {
          events.push("git:worktree-add");
        } else if (args[0] === "branch" && args[1] === "--show-current") {
          events.push("git:recovery-complete");
        } else {
          events.push("git:inspection");
        }
      });
      const broker = new WorkspaceBroker({
        git: observedGit,
        lanesRoot: layout.lanesRoot,
        lanesRootGuard: {
          assertCurrent(path) {
            if (path !== layout.lanesRoot) {
              throw new Error("Unexpected guarded lanes root");
            }
            assertHarnessDirectoryIdentity(layout.lanesRootIdentity);
            events.push("guard");
          },
        },
      });

      await broker.provision({
        runId: "run_guarded0003",
        repositoryPath: repository,
        baseSha,
      });

      const mutation = events.indexOf("git:worktree-add");
      const recovery = events.lastIndexOf("git:recovery-complete");
      expect(mutation).toBeGreaterThan(0);
      expect(events[mutation - 1]).toBe("guard");
      expect(events[mutation + 1]).toBe("guard");
      expect(recovery).toBeGreaterThan(mutation);
      expect(events[recovery + 1]).toBe("guard");
      expect(events.at(-1)).toBe("guard");
    },
    20_000,
  );

  test(
    "reuses one exact detached clean snapshot without returning the parent checkout",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-read-only-",
      );
      const first = await new WorkspaceBroker({ git, lanesRoot })
        .provisionReadOnlySnapshot({
          snapshotId: "snapshot_primary0001",
          repositoryPath: repository,
          sourceSha: baseSha,
        });
      const replay = await new WorkspaceBroker({ git, lanesRoot })
        .provisionReadOnlySnapshot({
          snapshotId: "snapshot_primary0001",
          repositoryPath: repository,
          sourceSha: baseSha,
        });

      expect(first.recovered).toBe(false);
      expect(replay).toEqual({ ...first, recovered: true });
      expect(first.checkoutPath).not.toBe(repository);
      expect(await requireGit(git, first.checkoutPath, ["rev-parse", "HEAD"]))
        .toBe(baseSha);
      expect(await requireGit(git, first.checkoutPath, ["branch", "--show-current"]))
        .toBe("");
      expect(await requireGit(
        git,
        first.checkoutPath,
        ["status", "--porcelain=v1", "--untracked-files=all"],
      )).toBe("");
      const manifest = JSON.parse(await readFile(
        join(lanesRoot, ".oprte-manifests", "snapshot_primary0001.json"),
        "utf8",
      )) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        version: 2,
        kind: "readOnlySnapshot",
        laneId: "snapshot_primary0001",
        baseSha,
      });
      expect(manifest).not.toHaveProperty("branchName");
    },
    20_000,
  );

  test(
    "quarantines a read-only snapshot after any local drift",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-read-only-drift-",
      );
      const snapshot = await new WorkspaceBroker({ git, lanesRoot })
        .provisionReadOnlySnapshot({
          snapshotId: "snapshot_primary0002",
          repositoryPath: repository,
          sourceSha: baseSha,
        });
      await writeFile(join(snapshot.checkoutPath, "untracked.txt"), "drift\n");

      expect(await quarantineReason(new WorkspaceBroker({ git, lanesRoot })
        .provisionReadOnlySnapshot({
          snapshotId: "snapshot_primary0002",
          repositoryPath: repository,
          sourceSha: baseSha,
        }))).toBe("dirty_checkout");
      expect(await readFile(join(snapshot.checkoutPath, "untracked.txt"), "utf8"))
        .toBe("drift\n");
    },
    20_000,
  );

  test(
    "recovers an exact manifest-bound lane after a broker restart",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-broker-",
      );
      const broker = new WorkspaceBroker({ git, lanesRoot });
      const first = await broker.provision({
        runId: "run_primary0001",
        repositoryPath: repository,
        baseSha,
      });
      const restartedBroker = new WorkspaceBroker({ git, lanesRoot });
      const replay = await restartedBroker.provision({
        runId: "run_primary0001",
        repositoryPath: repository,
        baseSha,
      });
      expect(first).toMatchObject({
        baseSha,
        branchName: "codex/oprte-run_primary0001",
        recovered: false,
      });
      expect(replay).toEqual({ ...first, recovered: true });
      expect(await requireGit(git, first.checkoutPath, ["branch", "--show-current"])).toBe(
        first.branchName,
      );
      const manifest = JSON.parse(await readFile(
        join(lanesRoot, ".oprte-manifests", "run_primary0001.json"),
        "utf8",
      )) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        version: 1,
        runId: "run_primary0001",
        laneId: "run_primary0001",
        baseSha,
        branchName: first.branchName,
      });
    },
    20_000,
  );

  test(
    "recovers an interrupted durable branch whose checkout was never installed",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-branch-crash-",
      );
      const identities = new MemoryWorkspaceIdentityStore();
      const first = await new WorkspaceBroker({
        git,
        identityStore: identities,
        lanesRoot,
      }).provision({
        runId: "run_branchcrash01",
        repositoryPath: repository,
        baseSha,
      });
      await writeFile(join(first.checkoutPath, "retained.txt"), "retained work\n");
      await requireGit(git, first.checkoutPath, ["add", "retained.txt"]);
      await requireGit(git, first.checkoutPath, ["commit", "-m", "retained work"]);
      const retainedHead = await requireGit(git, first.checkoutPath, ["rev-parse", "HEAD"]);
      await requireGit(git, repository, ["worktree", "remove", first.checkoutPath]);

      const recovered = await new WorkspaceBroker({
        git,
        identityStore: identities,
        lanesRoot,
      }).provision({
        runId: "run_branchcrash01",
        repositoryPath: repository,
        baseSha,
      });

      expect(recovered).toMatchObject({
        branchName: first.branchName,
        checkoutPath: first.checkoutPath,
        recovered: true,
      });
      expect(await requireGit(git, recovered.checkoutPath, ["rev-parse", "HEAD"]))
        .toBe(retainedHead);
      expect(await readFile(join(recovered.checkoutPath, "retained.txt"), "utf8"))
        .toBe("retained work\n");
    },
    20_000,
  );

  test(
    "never adopts a branch without preexisting durable binding authority",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-foreign-branch-",
      );
      const first = await new WorkspaceBroker({ git, lanesRoot }).provision({
        runId: "run_foreignbranch1",
        repositoryPath: repository,
        baseSha,
      });
      await requireGit(git, repository, ["worktree", "remove", first.checkoutPath]);

      expect(await quarantineReason(new WorkspaceBroker({ git, lanesRoot }).provision({
        runId: "run_foreignbranch1",
        repositoryPath: repository,
        baseSha,
      }))).toBe("branch_without_lane");
      expect(await lstat(first.checkoutPath).catch(() => null)).toBeNull();
      expect(await requireGit(git, repository, ["show-ref", "--verify", `refs/heads/${first.branchName}`]))
        .not.toBe("");
    },
    20_000,
  );

  test(
    "property: any durable branch-authority coordinate drift prevents crash adoption",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-branch-authority-",
      );
      const identities = new MemoryWorkspaceIdentityStore();
      const first = await new WorkspaceBroker({
        git,
        identityStore: identities,
        lanesRoot,
      }).provision({
        runId: "run_branchproof01",
        repositoryPath: repository,
        baseSha,
      });
      await requireGit(git, repository, ["worktree", "remove", first.checkoutPath]);
      const exact = identities.identity;
      if (exact === null) throw new Error("Expected the fixture identity to be durable");
      const mutations = {
        baseSha: "f".repeat(40),
        branchName: `${exact.branchName}-foreign`,
        canonicalCheckoutPath: `${exact.canonicalCheckoutPath}-foreign`,
        canonicalGitCommonDir: `${exact.canonicalGitCommonDir}-foreign`,
        canonicalRepositoryPath: `${exact.canonicalRepositoryPath}-foreign`,
        laneId: "run_branchproof02",
        recoveryManifestPath: `${exact.recoveryManifestPath}-foreign`,
        runId: "run_branchproof02",
      } satisfies Record<keyof WorkspaceLaneIdentity, string>;
      const expectedReasons = {
        baseSha: "base_mismatch",
        branchName: "binding_mismatch",
        canonicalCheckoutPath: "binding_mismatch",
        canonicalGitCommonDir: "repository_mismatch",
        canonicalRepositoryPath: "repository_mismatch",
        laneId: "binding_mismatch",
        recoveryManifestPath: "binding_mismatch",
        runId: "binding_mismatch",
      } as const satisfies Record<
        keyof WorkspaceLaneIdentity,
        "base_mismatch" | "binding_mismatch" | "repository_mismatch"
      >;

      await assertAsyncProperty(fc.asyncProperty(
        fc.constantFrom(...(Object.keys(mutations) as Array<keyof WorkspaceLaneIdentity>)),
        async (field) => {
          identities.recoveryOverride = { ...exact, [field]: mutations[field] };
          expect(await quarantineReason(new WorkspaceBroker({
            git,
            identityStore: identities,
            lanesRoot,
          }).provision({
            runId: exact.runId,
            repositoryPath: repository,
            baseSha,
          }))).toBe(expectedReasons[field]);
          expect(await lstat(first.checkoutPath).catch(() => null)).toBeNull();
        },
      ), { numRuns: 24 });
    },
    20_000,
  );

  test(
    "quarantines the same repository and branch when the requested base SHA changes",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-base-mismatch-",
      );
      const runId = "run_primary0003";
      const first = await new WorkspaceBroker({ git, lanesRoot }).provision({
        runId,
        repositoryPath: repository,
        baseSha,
      });
      await writeFile(join(repository, "fixture.txt"), "second base\n");
      await requireGit(git, repository, ["add", "fixture.txt"]);
      await requireGit(git, repository, ["commit", "-m", "second base"]);
      const changedBase = await requireGit(git, repository, ["rev-parse", "HEAD"]);

      expect(await quarantineReason(new WorkspaceBroker({ git, lanesRoot }).provision({
        runId,
        repositoryPath: repository,
        baseSha: changedBase,
      }))).toBe("base_mismatch");
      expect(await requireGit(git, first.checkoutPath, ["branch", "--show-current"])).toBe(
        first.branchName,
      );
      expect(await requireGit(git, first.checkoutPath, ["rev-parse", "HEAD"])).toBe(baseSha);
    },
    20_000,
  );

  test(
    "quarantines a stale manifest whose lane identity no longer binds the run",
    async () => {
      const { baseSha, git, lanesRoot, repository } = await repositoryFixture(
        "oprte-workspace-binding-mismatch-",
      );
      const runId = "run_primary0004";
      await new WorkspaceBroker({ git, lanesRoot }).provision({
        runId,
        repositoryPath: repository,
        baseSha,
      });
      const manifestPath = join(lanesRoot, ".oprte-manifests", `${runId}.json`);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, laneId: "run_stale000004" })}\n`);

      expect(await quarantineReason(new WorkspaceBroker({ git, lanesRoot }).provision({
        runId,
        repositoryPath: repository,
        baseSha,
      }))).toBe("binding_mismatch");
    },
    20_000,
  );

  test(
    "quarantines a lane when restart recovery targets another repository identity",
    async () => {
      const primary = await repositoryFixture("oprte-workspace-repository-primary-");
      const foreign = await repositoryFixture("oprte-workspace-repository-foreign-");
      const runId = "run_primary0005";
      await new WorkspaceBroker({ git: primary.git, lanesRoot: primary.lanesRoot }).provision({
        runId,
        repositoryPath: primary.repository,
        baseSha: primary.baseSha,
      });

      expect(await quarantineReason(new WorkspaceBroker({
        git: primary.git,
        lanesRoot: primary.lanesRoot,
      }).provision({
        runId,
        repositoryPath: foreign.repository,
        baseSha: foreign.baseSha,
      }))).toBe("repository_mismatch");
    },
    20_000,
  );

  test("rejects a symlink occupying the deterministic lane", async () => {
    const { baseSha, git, lanesRoot, repository, root } = await repositoryFixture(
      "oprte-workspace-symlink-",
    );
    const outside = join(root, "outside");
    await Promise.all([mkdir(lanesRoot), mkdir(outside)]);
    await symlink(outside, join(lanesRoot, "run_primary0002"));

    const broker = new WorkspaceBroker({ git, lanesRoot });
    expect(await quarantineReason(broker.provision({
      runId: "run_primary0002",
      repositoryPath: repository,
      baseSha,
    }))).toBe("path_escape");
  });

  test("rejects a symlink that redirects the app-owned manifest directory", async () => {
    const { baseSha, git, lanesRoot, repository, root } = await repositoryFixture(
      "oprte-workspace-manifest-symlink-",
    );
    const outside = join(root, "outside-manifests");
    await Promise.all([mkdir(lanesRoot), mkdir(outside)]);
    await symlink(outside, join(lanesRoot, ".oprte-manifests"));

    expect(await quarantineReason(new WorkspaceBroker({ git, lanesRoot }).provision({
      runId: "run_primary0006",
      repositoryPath: repository,
      baseSha,
    }))).toBe("path_escape");
  });
});
