import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ChatPaneStore } from "../src/state/chat-pane-store";
import {
  chatWorkspaceLaneId,
  ChatWorkspaceStore,
} from "../src/state/chat-workspace-store";
import { applyMigrations } from "../src/state/database";
import { WorkspaceSetupStore } from
  "../src/state/workspace-setup-store";
import {
  BundledBunWorkspaceSetupCoordinator,
  BundledBunWorkspaceSetupCoordinatorClosedError,
} from "../src/workspaces/bundled-bun-workspace-setup";
import type { GitResult, GitRunner } from
  "../src/workspaces/git-runner";
import type { WorkspaceLaneIdentity } from
  "../src/workspaces/workspace-broker";
import type { WorkspaceSetupRecipeV1 } from
  "../src/workspaces/workspace-setup-recipe";
import { WorkspaceSetupDeferredError } from
  "../src/workspaces/workspace-setup";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const ACCOUNT = "acct_bundledbunsetup01";
const PANE = "pane_bundledbunsetup01";
const REPOSITORY = `repo_${"7".repeat(26)}`;
const BASE = "a".repeat(40);
const BLOB = "e".repeat(40);

const defaultRecipe: WorkspaceSetupRecipeV1 = {
  version: 1,
  setup: {
    kind: "bunInstall",
    frozenLockfile: true,
    lifecycleScripts: "disabled",
    timeoutSeconds: 10,
    outputLimitBytes: 64 * 1_024,
  },
};

class RecipeGitRunner implements GitRunner {
  readonly #recipe: unknown;

  constructor(recipe: unknown) {
    this.#recipe = recipe;
  }

  run(_cwd: string, args: readonly string[]): Promise<GitResult> {
    if (args[0] === "ls-tree") {
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: `100644 blob ${BLOB}\t.hra/workspace.json\0`,
      });
    }
    if (args[0] === "cat-file") {
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(this.#recipe),
      });
    }
    throw new Error("Unexpected recipe Git command");
  }
}

interface Fixture {
  readonly bunBinary: string;
  readonly coordinator: BundledBunWorkspaceSetupCoordinator;
  readonly database: Database;
  readonly identity: WorkspaceLaneIdentity;
  readonly root: string;
  readonly setupRoot: string;
  readonly store: WorkspaceSetupStore;
  readonly workspace: ChatWorkspaceStore;
  close(): Promise<void>;
}

async function fixture(
  recipe: unknown = defaultRecipe,
  git: GitRunner = new RecipeGitRunner(recipe),
): Promise<Fixture> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "hra-bundled-bun-setup-"),
  );
  const root = await realpath(temporaryRoot);
  const repository = join(root, "repository");
  const gitCommonDir = join(repository, ".git");
  const checkout = join(root, "checkout");
  const setupRoot = join(root, "setup-runtime");
  await mkdir(gitCommonDir, { recursive: true });
  await mkdir(checkout, { recursive: true });
  const bunBinary = join(root, "fake-bun");
  await writeFile(bunBinary, fakeBunSource(), { mode: 0o700 });
  await chmod(bunBinary, 0o700);

  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Setup', 'signed_in', 1, 1, ?2, ?2)
  `).run(ACCOUNT, NOW.toISOString());
  database.query(`
    INSERT INTO local_repositories (
      repository_id, name, canonical_repository_path,
      canonical_git_common_dir, created_at, updated_at
    ) VALUES (?1, 'Setup repository', ?2, ?3, ?4, ?4)
  `).run(REPOSITORY, repository, gitCommonDir, NOW.getTime());
  const panes = new ChatPaneStore(database, {
    messageRequestDigestKey: new Uint8Array(32).fill(23),
  });
  panes.create({
    paneId: PANE,
    repository: {
      id: REPOSITORY,
      name: "Setup repository",
      workingDirectory: repository,
    },
    accountProfileId: ACCOUNT,
    now: NOW,
  });
  const laneId = chatWorkspaceLaneId(PANE, 1);
  const identity: WorkspaceLaneIdentity = {
    runId: laneId,
    laneId,
    baseSha: BASE,
    branchName: `codex/oprte-${laneId}`,
    canonicalRepositoryPath: repository,
    canonicalGitCommonDir: gitCommonDir,
    canonicalCheckoutPath: checkout,
    recoveryManifestPath: join(root, "manifests", `${laneId}.json`),
  };
  const workspace = new ChatWorkspaceStore(database, { now: () => NOW, panes });
  workspace.bindWorkspaceLane(identity);
  const store = new WorkspaceSetupStore(database, { now: () => NOW });
  const coordinator = await BundledBunWorkspaceSetupCoordinator.create({
    bunBinary,
    git,
    instrumentation: { unsafeTestOnlyAllowPathExecution: true },
    setupRoot,
    store,
  });
  return {
    bunBinary,
    coordinator,
    database,
    identity,
    root,
    setupRoot,
    store,
    workspace,
    async close() {
      coordinator.closeAdmission();
      await coordinator.settled();
      database.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

describe("BundledBunWorkspaceSetupCoordinator", () => {
  test("requires approval before spawn and uses only exact Bun authority", async () => {
    const value = await fixture();
    try {
      const request = await requestApproval(value);
      expect(await fileExists(recordPath(value))).toBe(false);
      expect(value.coordinator.attentionObservations()).toEqual([{
        paneId: PANE,
        setupRequestId: request.requestId,
        recipeDigest: request.recipeDigest,
        setupRevision: 1,
        state: "approvalRequired",
      }]);
      value.coordinator.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: request.setupRevision,
      });
      await writeBehavior(value, { mode: "success" });
      await value.coordinator.beforeWorkspaceReady(value.identity);

      const record = JSON.parse(await readFile(recordPath(value), "utf8")) as {
        argv: string[];
        cwd: string;
        env: Record<string, string>;
      };
      expect(record.argv).toEqual([
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
      ]);
      expect(record.cwd).toBe(value.identity.canonicalCheckoutPath);
      expect(record.env).toEqual({
        BUN_INSTALL_CACHE_DIR: instancePath(value, "cache"),
        CI: "1",
        HOME: instancePath(value, "home"),
        NO_COLOR: "1",
        PATH: instancePath(value, "path"),
        TMPDIR: instancePath(value, "tmp"),
      });
      expect(await fileExists(instancePath(value, "lifecycle-ran"))).toBe(false);
      expect((await stat(join(value.setupRoot, value.coordinator.executorInstanceId)))
        .mode & 0o777).toBe(0o700);
      expect(value.coordinator.executorDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "succeeded",
        setupRevision: 4,
      });
    } finally {
      await value.close();
    }
  });

  test("rejects a setup root symlink without touching its target", async () => {
    const value = await fixture();
    const outside = join(value.root, "outside-setup-authority");
    const sentinel = join(outside, "sentinel.txt");
    try {
      value.coordinator.closeAdmission();
      await value.coordinator.settled();
      await rm(value.setupRoot, { force: true, recursive: true });
      await mkdir(outside, { mode: 0o755 });
      await chmod(outside, 0o755);
      await writeFile(sentinel, "retained", { mode: 0o600 });
      await symlink(outside, value.setupRoot, "dir");

      let rejected = false;
      try {
        await BundledBunWorkspaceSetupCoordinator.create({
          bunBinary: value.bunBinary,
          git: new RecipeGitRunner(defaultRecipe),
          instrumentation: { unsafeTestOnlyAllowPathExecution: true },
          setupRoot: value.setupRoot,
          store: value.store,
        });
      } catch {
        rejected = true;
      }
      expect(rejected).toBeTrue();
      expect((await stat(outside)).mode & 0o777).toBe(0o755);
      expect(await readFile(sentinel, "utf8")).toBe("retained");
    } finally {
      await value.close();
    }
  });

  test("caps combined output and preserves a bounded local diagnostic", async () => {
    const value = await fixture({
      ...defaultRecipe,
      setup: { ...defaultRecipe.setup, outputLimitBytes: 96 },
    });
    try {
      const request = await requestApproval(value);
      value.coordinator.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: request.setupRevision,
      });
      await writeBehavior(value, { mode: "output", outputBytes: 8_192 });
      const error = await value.coordinator.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(WorkspaceSetupDeferredError);
      expect(error).toMatchObject({ state: "failed" });
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "failed",
        failureCode: "output_limit",
      });
      const diagnostic = value.store.readLocalDiagnostic(request.requestId);
      expect(diagnostic).not.toBeNull();
      expect(Buffer.byteLength(diagnostic ?? "", "utf8")).toBeLessThanOrEqual(96);
    } finally {
      await value.close();
    }
  });

  test.each([
    [
      "invalid recipe",
      { ...defaultRecipe, version: 2 },
      new RecipeGitRunner({ ...defaultRecipe, version: 2 }),
      "invalid_recipe",
    ],
    [
      "unsafe recipe object",
      defaultRecipe,
      unsafeRecipeGitRunner(),
      "invalid_recipe",
    ],
    [
      "Git read failure",
      defaultRecipe,
      throwingRecipeGitRunner(),
      "runtime_unavailable",
    ],
  ] as const)(
    "persists %s as pre-effect rejection with restart-visible attention",
    async (_label, recipe, git, outcome) => {
      const value = await fixture(recipe, git);
      try {
        const error = await value.coordinator
          .beforeWorkspaceReady(value.identity)
          .then(() => null, (reason: unknown) => reason);
        expect(error).toMatchObject({ state: "failed", setupRevision: 1 });
        const request = value.store.headForLane(value.identity.laneId);
        if (request === null) throw new Error("Expected rejected setup request");
        expect(request).toMatchObject({
          state: "rejected",
          setupRevision: 1,
          failureCode: outcome,
        });
        expect(await fileExists(recordPath(value))).toBe(false);
        expect(new WorkspaceSetupStore(value.database).allAttention())
          .toEqual([{
            paneId: PANE,
            setupRequestId: request.requestId,
            recipeDigest: request.recipeDigest,
            setupRevision: 1,
            state: "failed",
            outcome,
          }]);
      } finally {
        await value.close();
      }
    },
  );

  test("requires a clean replacement for a proven recipe on a v62-ready lane", async () => {
    const value = await fixture();
    try {
      value.workspace.markWorkspaceLaneReady(value.identity);
      const error = await value.coordinator.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(error).toMatchObject({ state: "failed", setupRevision: 1 });
      const fenced = value.store.headForLane(value.identity.laneId);
      if (fenced === null) throw new Error("Expected legacy setup fence");
      expect(fenced).toMatchObject({
        state: "rejected",
        failureCode: "clean_replacement_required",
      });
      expect(value.store.allAttention()).toEqual([{
        paneId: PANE,
        setupRequestId: fenced.requestId,
        recipeDigest: fenced.recipeDigest,
        setupRevision: 1,
        state: "failed",
        outcome: "clean_replacement_required",
      }]);
      expect(value.database.query(`
        SELECT workspace_state, workspace_recovery_reason
        FROM chat_panes WHERE pane_id = ?1
      `).get(PANE)).toEqual({
        workspace_state: "recovery_required",
        workspace_recovery_reason: "provision_interrupted",
      });
      expect(await fileExists(recordPath(value))).toBe(false);
    } finally {
      await value.close();
    }
  });

  test("keeps a proven recipe-free v62-ready lane usable without setup state", async () => {
    const value = await fixture(defaultRecipe, absentRecipeGitRunner());
    try {
      value.workspace.markWorkspaceLaneReady(value.identity);
      await value.coordinator.beforeWorkspaceReady(value.identity);
      expect(value.store.headForLane(value.identity.laneId)).toBeNull();
      expect(value.database.query(`
        SELECT workspace_state, workspace_recovery_reason
        FROM chat_panes WHERE pane_id = ?1
      `).get(PANE)).toEqual({
        workspace_state: "ready",
        workspace_recovery_reason: null,
      });
      expect(await fileExists(recordPath(value))).toBe(false);
    } finally {
      await value.close();
    }
  });

  test("reconciles a transient Git failure when the immutable recipe is proven absent", async () => {
    const value = await fixture(defaultRecipe, transientFailureThenAbsentGitRunner());
    try {
      const firstError = await value.coordinator
        .beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(firstError).toMatchObject({ state: "failed" });
      const rejected = value.store.headForLane(value.identity.laneId);
      expect(rejected).toMatchObject({
        state: "rejected",
        failureCode: "runtime_unavailable",
      });
      const afterFailure: unknown = value.database.query(`
        SELECT revision, workspace_revision, workspace_state
        FROM chat_panes WHERE pane_id = ?1
      `).get(PANE);

      await value.coordinator.beforeWorkspaceReady(value.identity);
      expect(value.store.headForLane(value.identity.laneId)).toBeNull();
      expect(value.store.allAttention()).toEqual([]);
      expect(value.database.query(`
        SELECT revision, workspace_revision, workspace_state
        FROM chat_panes WHERE pane_id = ?1
      `).get(PANE)).toEqual(afterFailure);
      value.workspace.markWorkspaceLaneReady(value.identity);
      expect(value.database.query(`
        SELECT workspace_state FROM chat_panes WHERE pane_id = ?1
      `).get(PANE)).toEqual({ workspace_state: "ready" });
      expect(await fileExists(recordPath(value))).toBe(false);
    } finally {
      await value.close();
    }
  });

  test("keeps every other setup head fail-closed when a recipe later appears absent", async () => {
    const value = await fixture(defaultRecipe, unsafeObjectThenAbsentGitRunner());
    try {
      const firstError = await value.coordinator
        .beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(firstError).toMatchObject({ state: "failed" });
      const rejected = value.store.headForLane(value.identity.laneId);
      expect(rejected).toMatchObject({
        state: "rejected",
        failureCode: "invalid_recipe",
      });
      const before = value.database.serialize();

      const secondError = await value.coordinator
        .beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(secondError).toMatchObject({
        requestId: rejected?.requestId,
        state: "failed",
      });
      expect(value.database.serialize()).toEqual(before);
      expect(value.store.allAttention()).toHaveLength(1);
      expect(await fileExists(recordPath(value))).toBe(false);
    } finally {
      await value.close();
    }
  });

  test("records an initial checkout failure before approval or effect", async () => {
    const value = await fixture();
    try {
      await rm(value.identity.canonicalCheckoutPath, {
        force: true,
        recursive: true,
      });
      const error = await value.coordinator.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(error).toMatchObject({ state: "failed", setupRevision: 1 });
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "rejected",
        setupRevision: 1,
        failureCode: "runtime_unavailable",
      });
      expect(value.database.query(`
        SELECT approval_binding_digest, executor_instance_id,
          approved_at, effect_started_at, transcript
        FROM workspace_setup_requests
      `).get()).toEqual({
        approval_binding_digest: null,
        executor_instance_id: null,
        approved_at: null,
        effect_started_at: null,
        transcript: null,
      });
      expect(await fileExists(recordPath(value))).toBe(false);
    } finally {
      await value.close();
    }
  });

  test("keeps durable approval usable when later preflight fails", async () => {
    const value = await fixture();
    try {
      const request = await requestApproval(value);
      await rm(value.identity.canonicalCheckoutPath, {
        force: true,
        recursive: true,
      });
      const stillAwaiting = await value.coordinator
        .beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(stillAwaiting).toMatchObject({
        state: "approval_required",
        requestId: request.requestId,
      });
      value.coordinator.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: request.setupRevision,
      });
      const failed = await value.coordinator.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(failed).toMatchObject({ state: "failed", setupRevision: 4 });
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "failed",
        setupRevision: 4,
        failureCode: "runtime_unavailable",
      });
      expect(await fileExists(recordPath(value))).toBe(false);
    } finally {
      await value.close();
    }
  });

  test("times out and kills the whole detached process group", async () => {
    const value = await fixture({
      ...defaultRecipe,
      setup: { ...defaultRecipe.setup, timeoutSeconds: 1 },
    });
    try {
      const request = await requestApproval(value);
      value.coordinator.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: request.setupRevision,
      });
      await writeBehavior(value, { mode: "hold" });
      const error = await value.coordinator.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(error).toMatchObject({ state: "failed" });
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "failed",
        failureCode: "timeout",
      });
      const descendantPid = Number.parseInt(
        await readFile(instancePath(value, "home", "descendant-pid"), "utf8"),
        10,
      );
      expect(await waitForProcessExit(descendantPid)).toBe(true);
    } finally {
      await value.close();
    }
  });

  test("leaves forced gateway-generation failures effect-started until restart", async () => {
    const timeoutRecipe = {
      ...defaultRecipe,
      setup: { ...defaultRecipe.setup, timeoutSeconds: 1 },
    } satisfies WorkspaceSetupRecipeV1;
    const value = await fixture(timeoutRecipe);
    let gateway: BundledBunWorkspaceSetupCoordinator | null = null;
    let replacement: BundledBunWorkspaceSetupCoordinator | null = null;
    try {
      value.coordinator.closeAdmission();
      await value.coordinator.settled();
      const fatalErrors: Error[] = [];
      gateway = await BundledBunWorkspaceSetupCoordinator.create({
        bunBinary: value.bunBinary,
        git: new RecipeGitRunner(timeoutRecipe),
        instrumentation: {
          unsafeTestOnlyAllowPathExecution: true,
          unsafeTestOnlyFatalGatewayGeneration(error): never {
            fatalErrors.push(error);
            throw error;
          },
        },
        processContainment: "gateway_generation",
        setupRoot: value.setupRoot,
        store: value.store,
      });
      const approvalError = await gateway.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(approvalError).toMatchObject({ state: "approval_required" });
      const request = value.store.headForLane(value.identity.laneId);
      if (request === null) throw new Error("Expected setup request");
      gateway.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: request.setupRevision,
      });
      await writeBehaviorForCoordinator(value.setupRoot, gateway, {
        mode: "holdDirect",
      });
      const error = await gateway.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(fatalErrors).toHaveLength(1);
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "effect_started",
        setupRevision: 3,
      });

      replacement = await BundledBunWorkspaceSetupCoordinator.create({
        bunBinary: value.bunBinary,
        git: new RecipeGitRunner(timeoutRecipe),
        instrumentation: { unsafeTestOnlyAllowPathExecution: true },
        setupRoot: value.setupRoot,
        store: value.store,
      });
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "ambiguous",
        setupRevision: 4,
      });
    } finally {
      gateway?.closeAdmission();
      await gateway?.settled();
      replacement?.closeAdmission();
      await replacement?.settled();
      await value.close();
    }
  });

  test("sandboxed Bun cannot write through a checkout symlink", async () => {
    if (process.platform !== "darwin") return;
    const value = await fixture();
    let sandboxed: BundledBunWorkspaceSetupCoordinator | null = null;
    try {
      value.coordinator.closeAdmission();
      await value.coordinator.settled();
      await prepareFrozenLocalInstall(value);
      await rm(join(value.identity.canonicalCheckoutPath, "node_modules"), {
        force: true,
        recursive: true,
      });
      const outside = join(value.root, "outside-node-modules");
      await mkdir(outside, { recursive: true });
      await symlink(
        outside,
        join(value.identity.canonicalCheckoutPath, "node_modules"),
        "dir",
      );

      sandboxed = await BundledBunWorkspaceSetupCoordinator.create({
        bunBinary: process.execPath,
        git: new RecipeGitRunner(defaultRecipe),
        processContainment: "command_process_group",
        setupRoot: value.setupRoot,
        store: value.store,
      });
      const approvalError = await sandboxed.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(approvalError).toMatchObject({ state: "approval_required" });
      const request = value.store.headForLane(value.identity.laneId);
      if (request === null) throw new Error("Expected setup request");
      sandboxed.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: request.setupRevision,
      });
      const error = await sandboxed.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(error).toMatchObject({ state: "failed" });
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "failed",
        failureCode: "exit_nonzero",
      });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      sandboxed?.closeAdmission();
      await sandboxed?.settled();
      await value.close();
    }
  });

  test("sandboxed Bun succeeds when every write stays in approved roots", async () => {
    if (process.platform !== "darwin") return;
    const value = await fixture();
    let sandboxed: BundledBunWorkspaceSetupCoordinator | null = null;
    try {
      value.coordinator.closeAdmission();
      await value.coordinator.settled();
      await prepareFrozenLocalInstall(value);
      await rm(join(value.identity.canonicalCheckoutPath, "node_modules"), {
        force: true,
        recursive: true,
      });
      sandboxed = await BundledBunWorkspaceSetupCoordinator.create({
        bunBinary: process.execPath,
        git: new RecipeGitRunner(defaultRecipe),
        processContainment: "command_process_group",
        setupRoot: value.setupRoot,
        store: value.store,
      });
      const approvalError = await sandboxed.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(approvalError).toMatchObject({ state: "approval_required" });
      const request = value.store.headForLane(value.identity.laneId);
      if (request === null) throw new Error("Expected setup request");
      sandboxed.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: request.setupRevision,
      });
      await sandboxed.beforeWorkspaceReady(value.identity);
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "succeeded",
      });
      expect(await fileExists(join(
        value.identity.canonicalCheckoutPath,
        "node_modules",
        "audit-dep",
        "package.json",
      ))).toBe(true);
    } finally {
      sandboxed?.closeAdmission();
      await sandboxed?.settled();
      await value.close();
    }
  });

  test("eager restart recovery makes an interrupted effect ambiguous without replay", async () => {
    const value = await fixture();
    let replacement: BundledBunWorkspaceSetupCoordinator | null = null;
    try {
      const request = await requestApproval(value);
      value.coordinator.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: request.setupRevision,
      });
      value.store.claimEffect({
        requestId: request.requestId,
        executorInstanceId: value.coordinator.executorInstanceId,
      });

      replacement = await BundledBunWorkspaceSetupCoordinator.create({
        bunBinary: value.bunBinary,
        git: new RecipeGitRunner(defaultRecipe),
        instrumentation: { unsafeTestOnlyAllowPathExecution: true },
        setupRoot: value.setupRoot,
        store: value.store,
      });
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "ambiguous",
        setupRevision: 4,
      });
      const error = await replacement.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      expect(error).toMatchObject({ state: "ambiguous" });
      expect(await fileExists(join(
        value.setupRoot,
        replacement.executorInstanceId,
        "home",
        "record.json",
      ))).toBe(false);
    } finally {
      replacement?.closeAdmission();
      await replacement?.settled();
      await value.close();
    }
  });

  test("shutdown contains active children and settles their authority ambiguous", async () => {
    const value = await fixture();
    try {
      const request = await requestApproval(value);
      value.coordinator.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: request.setupRevision,
      });
      await writeBehavior(value, { mode: "hold" });
      const execution = value.coordinator.beforeWorkspaceReady(value.identity)
        .then(() => null, (reason: unknown) => reason);
      await waitForFile(instancePath(value, "home", "started"));
      const descendantPid = Number.parseInt(
        await readFile(instancePath(value, "home", "descendant-pid"), "utf8"),
        10,
      );

      value.coordinator.closeAdmission();
      await value.coordinator.settled();
      expect(await execution).toMatchObject({ state: "ambiguous" });
      expect(value.store.headForLane(value.identity.laneId)).toMatchObject({
        state: "ambiguous",
      });
      expect(await waitForProcessExit(descendantPid)).toBe(true);
      expect(() => value.coordinator.approve({
        requestId: request.requestId,
        recipeDigest: request.recipeDigest,
        expectedSetupRevision: 1,
      })).toThrow(BundledBunWorkspaceSetupCoordinatorClosedError);
    } finally {
      await value.close();
    }
  });
});

async function requestApproval(value: Fixture) {
  const error = await value.coordinator.beforeWorkspaceReady(value.identity)
    .then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(WorkspaceSetupDeferredError);
  expect(error).toMatchObject({ state: "approval_required" });
  const request = value.store.headForLane(value.identity.laneId);
  if (request === null) throw new Error("Expected workspace setup request");
  return request;
}

function instancePath(value: Fixture, ...parts: string[]): string {
  return join(
    value.setupRoot,
    value.coordinator.executorInstanceId,
    ...parts,
  );
}

function recordPath(value: Fixture): string {
  return instancePath(value, "home", "record.json");
}

async function writeBehavior(
  value: Fixture,
  behavior: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    instancePath(value, "behavior.json"),
    JSON.stringify(behavior),
    { mode: 0o600 },
  );
}

async function writeBehaviorForCoordinator(
  setupRoot: string,
  coordinator: BundledBunWorkspaceSetupCoordinator,
  behavior: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    join(setupRoot, coordinator.executorInstanceId, "behavior.json"),
    JSON.stringify(behavior),
    { mode: 0o600 },
  );
}

async function prepareFrozenLocalInstall(value: Fixture): Promise<void> {
  const dependency = join(value.identity.canonicalCheckoutPath, "dependency");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), JSON.stringify({
    name: "audit-dep",
    version: "1.0.0",
  }));
  await writeFile(
    join(value.identity.canonicalCheckoutPath, "package.json"),
    JSON.stringify({
      name: "sandbox-fixture",
      private: true,
      dependencies: { "audit-dep": "file:./dependency" },
    }),
  );
  const bootstrap = Bun.spawn(
    [process.execPath, "install", "--ignore-scripts"],
    {
      cwd: value.identity.canonicalCheckoutPath,
      env: {
        HOME: join(value.root, "bootstrap-home"),
        PATH: "/usr/bin:/bin",
        TMPDIR: join(value.root, "bootstrap-tmp"),
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  expect(await bootstrap.exited).toBe(0);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForFile(path: string): Promise<void> {
  const until = performance.now() + 5_000;
  while (!await fileExists(path)) {
    if (performance.now() >= until) throw new Error("Timed out waiting for file");
    await Bun.sleep(10);
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const until = performance.now() + 2_000;
  while (processExists(pid)) {
    if (performance.now() >= until) return false;
    await Bun.sleep(10);
  }
  return true;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function fakeBunSource(): string {
  const bun = process.execPath;
  if (bun.includes("\n")) throw new Error("Test Bun path is not shebang-safe");
  return `#!${bun}
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const home = process.env.HOME;
if (home === undefined) process.exit(91);
const instanceRoot = dirname(home);
const behavior = JSON.parse(await readFile(
  join(instanceRoot, "behavior.json"),
  "utf8",
).catch(() => '{"mode":"success"}'));
await writeFile(join(home, "record.json"), JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
}));
if (!process.argv.includes("--ignore-scripts")) {
  await writeFile(join(instanceRoot, "lifecycle-ran"), "unsafe");
}
if (behavior.mode === "output") {
  process.stdout.write("o".repeat(behavior.outputBytes));
  process.stderr.write("e".repeat(behavior.outputBytes));
  await Bun.sleep(60_000);
}
if (behavior.mode === "hold") {
  const descendant = Bun.spawn(
    [process.execPath, "-e", "await Bun.sleep(60000)"],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  await writeFile(join(home, "descendant-pid"), String(descendant.pid));
  await writeFile(join(home, "started"), "started");
  await Bun.sleep(60_000);
}
if (behavior.mode === "holdDirect") {
  await Bun.sleep(60_000);
}
`;
}

function unsafeRecipeGitRunner(): GitRunner {
  return {
    run(): Promise<GitResult> {
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: `120000 blob ${BLOB}\t.hra/workspace.json\0`,
      });
    },
  };
}

function throwingRecipeGitRunner(): GitRunner {
  return {
    run(): Promise<GitResult> {
      return Promise.reject(new Error("private Git failure details"));
    },
  };
}

function absentRecipeGitRunner(): GitRunner {
  return {
    run(_cwd, args): Promise<GitResult> {
      if (args[0] !== "ls-tree") throw new Error("Unexpected recipe Git command");
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    },
  };
}

function transientFailureThenAbsentGitRunner(): GitRunner {
  let attempts = 0;
  return {
    run(_cwd, args): Promise<GitResult> {
      if (args[0] !== "ls-tree") throw new Error("Unexpected recipe Git command");
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error("private transient Git failure"));
      }
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    },
  };
}

function unsafeObjectThenAbsentGitRunner(): GitRunner {
  let attempts = 0;
  return {
    run(_cwd, args): Promise<GitResult> {
      if (args[0] !== "ls-tree") throw new Error("Unexpected recipe Git command");
      attempts += 1;
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: attempts === 1
          ? `120000 blob ${BLOB}\t.hra/workspace.json\0`
          : "",
      });
    },
  };
}
