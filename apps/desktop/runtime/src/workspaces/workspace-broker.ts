import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, statfs, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "@hra-internal/schema";

import type { GitRunner, GitRunOptions } from "./git-runner";
import { GitCommandError, requireGit } from "./git-runner";

const runIdPattern = /^[a-z0-9][a-z0-9_-]{7,127}$/u;
const commitPattern = /^[a-f0-9]{40,64}$/u;
// Opaque durable recovery authority retained for the first HRA bridge.
const legacyOprteLaneManifestDirectory = ".oprte-manifests";
const legacyOprteBranchPrefix = "codex/oprte-";
const maximumLaneManifestBytes = 16 * 1024;
const gitInspectionOptions = {
  stderrLimitBytes: 64 * 1_024,
  stdoutLimitBytes: 128 * 1_024,
  timeoutMs: 30_000,
} as const satisfies GitRunOptions;
const gitMutationOptions = {
  stderrLimitBytes: 512 * 1_024,
  stdoutLimitBytes: 512 * 1_024,
  timeoutMs: 120_000,
} as const satisfies GitRunOptions;
const defaultMinimumWorkspaceFreeBytes = 2n * 1024n * 1024n * 1024n;

const repositoryProvisionTails = new Map<string, Promise<void>>();
const maximumParallelRecoveryInspections = 8;
let activeRecoveryInspections = 0;
const recoveryInspectionWaiters: Array<() => void> = [];

const laneManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().regex(runIdPattern),
  laneId: z.string().regex(runIdPattern),
  canonicalRepositoryPath: z.string().min(1),
  canonicalGitCommonDir: z.string().min(1),
  baseSha: z.string().regex(commitPattern),
  branchName: z.string().min(1),
  canonicalCheckoutPath: z.string().min(1),
}).strict();

type LaneManifest = z.infer<typeof laneManifestSchema>;

const readOnlyLaneManifestSchema = z.object({
  version: z.literal(2),
  kind: z.literal("readOnlySnapshot"),
  runId: z.string().regex(runIdPattern),
  laneId: z.string().regex(runIdPattern),
  canonicalRepositoryPath: z.string().min(1),
  canonicalGitCommonDir: z.string().min(1),
  baseSha: z.string().regex(commitPattern),
  canonicalCheckoutPath: z.string().min(1),
}).strict();

type ReadOnlyLaneManifest = z.infer<typeof readOnlyLaneManifestSchema>;
type AnyLaneManifest = LaneManifest | ReadOnlyLaneManifest;

export type WorkspaceLaneQuarantineReason =
  | "base_mismatch"
  | "binding_mismatch"
  | "branch_without_lane"
  | "checkout_mismatch"
  | "dirty_checkout"
  | "invalid_manifest"
  | "manifest_missing"
  | "path_escape"
  | "repository_mismatch";

/**
 * A quarantined lane is deliberately preserved for inspection. Callers must
 * never treat this error as permission to replace, reset, or delete the lane.
 */
export class WorkspaceLaneQuarantinedError extends Error {
  readonly reason: WorkspaceLaneQuarantineReason;

  constructor(reason: WorkspaceLaneQuarantineReason) {
    super(quarantineMessage(reason));
    this.name = "WorkspaceLaneQuarantinedError";
    this.reason = reason;
  }
}

export interface InspectedRepository {
  readonly canonicalGitCommonDir: string;
  readonly canonicalRepositoryPath: string;
}

export interface ManagedWorkspace {
  readonly baseSha: string;
  readonly branchName: string;
  readonly canonicalGitCommonDir: string;
  readonly checkoutPath: string;
  readonly laneId: string;
  readonly recovered: boolean;
}

export interface ReadOnlyWorkspace {
  readonly baseSha: string;
  readonly canonicalGitCommonDir: string;
  readonly checkoutPath: string;
  readonly laneId: string;
  readonly recovered: boolean;
}

export interface WorkspaceLaneIdentity {
  readonly baseSha: string;
  readonly branchName: string;
  readonly canonicalCheckoutPath: string;
  readonly canonicalGitCommonDir: string;
  readonly canonicalRepositoryPath: string;
  readonly laneId: string;
  readonly recoveryManifestPath: string;
  readonly runId: string;
}

export interface WorkspaceLaneIdentityStore {
  bindWorkspaceLane(input: WorkspaceLaneIdentity): WorkspaceLaneIdentity;
  markWorkspaceLaneReady(input: WorkspaceLaneIdentity): void;
  /**
   * Existing filesystem state may be adopted only when durable authority was
   * written before the original mutation. Stores that implement this hook
   * return that preexisting identity; `null` quarantines an orphan lane.
   */
  authorizeWorkspaceLaneRecovery?(
    input: WorkspaceLaneIdentity,
  ): WorkspaceLaneIdentity | null;
}

export interface ReadOnlySnapshotIdentity {
  readonly baseSha: string;
  readonly canonicalCheckoutPath: string;
  readonly canonicalGitCommonDir: string;
  readonly canonicalRepositoryPath: string;
  readonly laneId: string;
  readonly recoveryManifestPath: string;
  readonly runId: string;
}

export interface ReadOnlySnapshotIdentityStore {
  bindReadOnlySnapshot(input: ReadOnlySnapshotIdentity): ReadOnlySnapshotIdentity;
  markReadOnlySnapshotReady(input: ReadOnlySnapshotIdentity): void;
}

export interface WorkspaceLanesRootGuard {
  assertCurrent(path: string): void | Promise<void>;
}

export interface WorkspaceCapacityProbeInput {
  readonly canonicalGitCommonDir: string;
  readonly canonicalRepositoryPath: string;
  readonly lanesRoot: string;
}

export interface WorkspaceCapacityProbe {
  assertCanProvision(input: WorkspaceCapacityProbeInput): void | Promise<void>;
}

export type WorkspaceCapacityErrorCode =
  | "capacity_unavailable"
  | "insufficient_disk";

export class WorkspaceCapacityError extends Error {
  readonly code: WorkspaceCapacityErrorCode;

  constructor(code: WorkspaceCapacityErrorCode) {
    super(code === "insufficient_disk"
      ? "Managed workspace is waiting for sufficient disk capacity"
      : "Managed workspace capacity could not be verified");
    this.name = "WorkspaceCapacityError";
    this.code = code;
  }
}

export function filesystemWorkspaceCapacityProbe(
  minimumFreeBytes: bigint = defaultMinimumWorkspaceFreeBytes,
): WorkspaceCapacityProbe {
  if (minimumFreeBytes <= 0n) {
    throw new Error("Managed-workspace free-space floor must be positive");
  }
  return {
    async assertCanProvision(input): Promise<void> {
      let roots;
      try {
        roots = await Promise.all([
          statfs(input.lanesRoot, { bigint: true }),
          statfs(input.canonicalGitCommonDir, { bigint: true }),
        ]);
      } catch {
        throw new WorkspaceCapacityError("capacity_unavailable");
      }
      if (roots.some((value) => value.bavail * value.bsize < minimumFreeBytes)) {
        throw new WorkspaceCapacityError("insufficient_disk");
      }
    },
  };
}

export class WorkspaceBroker {
  readonly #git: GitRunner;
  readonly #capacity: WorkspaceCapacityProbe;
  readonly #identityStore: WorkspaceLaneIdentityStore | null;
  readonly #lanesRootGuard: WorkspaceLanesRootGuard | null;
  readonly #readOnlyIdentityStore: ReadOnlySnapshotIdentityStore | null;
  readonly #lanesRoot: string;

  constructor(options: {
    readonly git: GitRunner;
    readonly capacity?: WorkspaceCapacityProbe;
    readonly identityStore?: WorkspaceLaneIdentityStore;
    readonly lanesRootGuard?: WorkspaceLanesRootGuard;
    readonly readOnlyIdentityStore?: ReadOnlySnapshotIdentityStore;
    readonly lanesRoot: string;
  }) {
    if (!isAbsolute(options.lanesRoot)) throw new Error("Managed-worktree root must be absolute");
    this.#git = options.git;
    this.#capacity = options.capacity ?? filesystemWorkspaceCapacityProbe();
    this.#identityStore = options.identityStore ?? null;
    this.#lanesRootGuard = options.lanesRootGuard ?? null;
    this.#readOnlyIdentityStore = options.readOnlyIdentityStore ?? null;
    this.#lanesRoot = options.lanesRoot;
  }

  async inspectRepository(repositoryPath: string): Promise<InspectedRepository> {
    if (!isAbsolute(repositoryPath)) throw new Error("Repository path must be absolute");
    const canonicalRepositoryPath = await realpath(repositoryPath);
    const topLevel = await canonicalGitPath(
      canonicalRepositoryPath,
      await requireGit(
        this.#git,
        canonicalRepositoryPath,
        ["rev-parse", "--show-toplevel"],
        gitInspectionOptions,
      ),
    );
    if (topLevel !== canonicalRepositoryPath) {
      throw new Error("Repository binding must target the Git worktree root");
    }
    const canonicalGitCommonDir = await canonicalGitPath(
      canonicalRepositoryPath,
      await requireGit(
        this.#git,
        canonicalRepositoryPath,
        ["rev-parse", "--git-common-dir"],
        gitInspectionOptions,
      ),
    );
    return { canonicalRepositoryPath, canonicalGitCommonDir };
  }

  async resolveBase(repositoryPath: string, baseRef: string): Promise<string> {
    if (baseRef.length < 1 || baseRef.length > 512 || baseRef.includes("\0")) {
      throw new Error("Base ref is invalid");
    }
    const inspected = await this.inspectRepository(repositoryPath);
    const sha = await requireGit(
      this.#git,
      inspected.canonicalRepositoryPath,
      [
        "rev-parse",
        "--verify",
        `${baseRef}^{commit}`,
      ],
      gitInspectionOptions,
    );
    if (!commitPattern.test(sha)) throw new Error("Git returned an invalid base commit");
    return sha;
  }

  async provision(input: {
    readonly runId: string;
    readonly repositoryPath: string;
    readonly baseSha: string;
  }): Promise<ManagedWorkspace> {
    if (!runIdPattern.test(input.runId)) throw new Error("Dispatch run ID is invalid");
    if (!commitPattern.test(input.baseSha)) throw new Error("Dispatch base commit is invalid");
    const repository = await this.inspectRepository(input.repositoryPath);
    const lanesRoot = await this.#prepareLanesRoot();
    const manifestsRoot = await this.#withLanesRootGuard(() =>
      ensureManifestDirectory(lanesRoot)
    );
    const laneId = input.runId;
    const checkoutPath = join(lanesRoot, laneId);
    assertDirectChild(lanesRoot, checkoutPath);
    const branchName = `${legacyOprteBranchPrefix}${input.runId}`;
    const manifestPath = join(manifestsRoot, `${laneId}.json`);
    assertDirectChild(manifestsRoot, manifestPath);
    const expectedManifest: LaneManifest = {
      version: 1,
      runId: input.runId,
      laneId,
      canonicalRepositoryPath: repository.canonicalRepositoryPath,
      canonicalGitCommonDir: repository.canonicalGitCommonDir,
      baseSha: input.baseSha,
      branchName,
      canonicalCheckoutPath: checkoutPath,
    };
    const expectedIdentity: WorkspaceLaneIdentity = {
      baseSha: expectedManifest.baseSha,
      branchName: expectedManifest.branchName,
      canonicalCheckoutPath: expectedManifest.canonicalCheckoutPath,
      canonicalGitCommonDir: expectedManifest.canonicalGitCommonDir,
      canonicalRepositoryPath: expectedManifest.canonicalRepositoryPath,
      laneId: expectedManifest.laneId,
      recoveryManifestPath: manifestPath,
      runId: expectedManifest.runId,
    };

    const existing = await this.#withLanesRootGuard(() =>
      lstat(checkoutPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      })
    );
    if (existing !== null) {
      return await withRecoveryInspectionSlot(() =>
        this.#recoverManagedWorkspace({
          existing,
          expectedIdentity,
          expectedManifest,
          lanesRoot,
          manifestPath,
        })
      );
    }

    const outcome = await withRepositoryProvisionLock(
      repository.canonicalGitCommonDir,
      async () => {
    // Another broker may have completed this exact lane while this caller was
    // queued for repository mutation. Adopt only after rechecking durable
    // authority and the complete filesystem identity.
    const racedExisting = await this.#withLanesRootGuard(() =>
      lstat(checkoutPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      })
    );
    if (racedExisting !== null) {
      return { kind: "recover" as const, existing: racedExisting };
    }

    await this.#capacity.assertCanProvision({
      canonicalGitCommonDir: repository.canonicalGitCommonDir,
      canonicalRepositoryPath: repository.canonicalRepositoryPath,
      lanesRoot,
    });
    const manifest = await this.#withLanesRootGuard(() =>
      readLaneManifest(manifestPath)
    );
    const branchProbe = await this.#withLanesRootGuard(() =>
      this.#git.run(
        repository.canonicalRepositoryPath,
        [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branchName}`,
        ],
        gitInspectionOptions,
      )
    );
    if (branchProbe.exitCode === 0) {
      // `git worktree add -b` creates the branch before its checkout is fully
      // installed. Recover that exact crash window only when both independent
      // durable authorities predate this attempt. A matching name discovered
      // on disk is never enough to adopt an arbitrary local branch.
      if (manifest === null) quarantine("branch_without_lane");
      assertManifestIdentity(manifest, expectedManifest);
      this.#assertRecoveryAuthorizedStrict(expectedIdentity);
      await this.#assertBranchHasNoCheckout(
        repository.canonicalRepositoryPath,
        branchName,
      );
      await this.#withLanesRootGuard(() =>
        requireGit(
          this.#git,
          repository.canonicalRepositoryPath,
          [
            "worktree",
            "add",
            checkoutPath,
            branchName,
          ],
          gitMutationOptions,
        )
      );
      const recovered = await this.#withLanesRootGuard(() =>
        this.#recoverExistingLane({
          baseSha: input.baseSha,
          branchName,
          checkoutPath,
          expectedGitCommonDir: repository.canonicalGitCommonDir,
          laneId,
          lanesRoot,
        })
      );
      this.#bindIdentity(expectedIdentity);
      this.#identityStore?.markWorkspaceLaneReady(expectedIdentity);
      await this.#assertLanesRoot();
      return { kind: "created" as const, workspace: recovered };
    }
    if (branchProbe.exitCode !== 1) {
      throw new GitCommandError(["show-ref", "--verify", "--quiet"], branchProbe);
    }

    this.#bindIdentity(expectedIdentity);
    if (manifest === null) {
      await this.#withLanesRootGuard(() =>
        persistLaneManifest(manifestsRoot, manifestPath, expectedManifest)
      );
    } else {
      assertManifestIdentity(manifest, expectedManifest);
    }

    await this.#withLanesRootGuard(() =>
      requireGit(
        this.#git,
        repository.canonicalRepositoryPath,
        [
          "worktree",
          "add",
          "--no-track",
          "-b",
          branchName,
          checkoutPath,
          input.baseSha,
        ],
        gitMutationOptions,
      )
    );
    const workspace = {
      ...await this.#withLanesRootGuard(() =>
        this.#recoverExistingLane({
          baseSha: input.baseSha,
          branchName,
          checkoutPath,
          expectedGitCommonDir: repository.canonicalGitCommonDir,
          laneId,
          lanesRoot,
        })
      ),
      recovered: false,
    };
    this.#identityStore?.markWorkspaceLaneReady(expectedIdentity);
    await this.#assertLanesRoot();
    return { kind: "created" as const, workspace };
      },
    );
    if (outcome.kind === "recover") {
      return await withRecoveryInspectionSlot(() =>
        this.#recoverManagedWorkspace({
          existing: outcome.existing,
          expectedIdentity,
          expectedManifest,
          lanesRoot,
          manifestPath,
        })
      );
    }
    return outcome.workspace;
  }

  async #recoverManagedWorkspace(input: Readonly<{
    existing: Awaited<ReturnType<typeof lstat>>;
    expectedIdentity: WorkspaceLaneIdentity;
    expectedManifest: LaneManifest;
    lanesRoot: string;
    manifestPath: string;
  }>): Promise<ManagedWorkspace> {
    if (!input.existing.isDirectory() || input.existing.isSymbolicLink()) {
      quarantine("path_escape");
    }
    this.#assertRecoveryAuthorized(input.expectedIdentity);
    const manifest = await this.#withLanesRootGuard(() =>
      readLaneManifest(input.manifestPath)
    );
    if (manifest === null) quarantine("manifest_missing");
    assertManifestIdentity(manifest, input.expectedManifest);
    const workspace = await this.#withLanesRootGuard(() =>
      this.#recoverExistingLane({
        baseSha: input.expectedIdentity.baseSha,
        branchName: input.expectedIdentity.branchName,
        checkoutPath: input.expectedIdentity.canonicalCheckoutPath,
        expectedGitCommonDir: input.expectedIdentity.canonicalGitCommonDir,
        laneId: input.expectedIdentity.laneId,
        lanesRoot: input.lanesRoot,
      })
    );
    this.#bindIdentity(input.expectedIdentity);
    this.#identityStore?.markWorkspaceLaneReady(input.expectedIdentity);
    await this.#assertLanesRoot();
    return workspace;
  }

  /**
   * Provisions one immutable, detached, clean source snapshot. Multiple actors
   * may bind the same snapshot through SQLite; this broker never returns the
   * mutable parent checkout and never resets or replaces a drifted snapshot.
   */
  async provisionReadOnlySnapshot(input: {
    readonly snapshotId: string;
    readonly repositoryPath: string;
    readonly sourceSha: string;
  }): Promise<ReadOnlyWorkspace> {
    if (!runIdPattern.test(input.snapshotId)) {
      throw new Error("Read-only snapshot ID is invalid");
    }
    if (!commitPattern.test(input.sourceSha)) {
      throw new Error("Read-only snapshot commit is invalid");
    }
    const repository = await this.inspectRepository(input.repositoryPath);
    const lanesRoot = await this.#prepareLanesRoot();
    const manifestsRoot = await this.#withLanesRootGuard(() =>
      ensureManifestDirectory(lanesRoot)
    );
    const laneId = input.snapshotId;
    const checkoutPath = join(lanesRoot, laneId);
    const manifestPath = join(manifestsRoot, `${laneId}.json`);
    assertDirectChild(lanesRoot, checkoutPath);
    assertDirectChild(manifestsRoot, manifestPath);
    const manifest: ReadOnlyLaneManifest = {
      version: 2,
      kind: "readOnlySnapshot",
      runId: input.snapshotId,
      laneId,
      canonicalRepositoryPath: repository.canonicalRepositoryPath,
      canonicalGitCommonDir: repository.canonicalGitCommonDir,
      baseSha: input.sourceSha,
      canonicalCheckoutPath: checkoutPath,
    };
    const identity: ReadOnlySnapshotIdentity = {
      baseSha: manifest.baseSha,
      canonicalCheckoutPath: manifest.canonicalCheckoutPath,
      canonicalGitCommonDir: manifest.canonicalGitCommonDir,
      canonicalRepositoryPath: manifest.canonicalRepositoryPath,
      laneId: manifest.laneId,
      recoveryManifestPath: manifestPath,
      runId: manifest.runId,
    };
    const existing = await this.#withLanesRootGuard(() =>
      lstat(checkoutPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      })
    );
    if (existing !== null) {
      return await withRecoveryInspectionSlot(() =>
        this.#recoverReadOnlyWorkspace({
          existing,
          identity,
          lanesRoot,
          manifest,
          manifestPath,
        })
      );
    }

    const outcome = await withRepositoryProvisionLock(
      repository.canonicalGitCommonDir,
      async () => {
    const racedExisting = await this.#withLanesRootGuard(() =>
      lstat(checkoutPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      })
    );
    if (racedExisting !== null) {
      return { kind: "recover" as const, existing: racedExisting };
    }
    await this.#capacity.assertCanProvision({
      canonicalGitCommonDir: repository.canonicalGitCommonDir,
      canonicalRepositoryPath: repository.canonicalRepositoryPath,
      lanesRoot,
    });
    this.#bindReadOnlyIdentity(identity);
    const observed = await this.#withLanesRootGuard(() =>
      readLaneManifest(manifestPath)
    );
    if (observed === null) {
      await this.#withLanesRootGuard(() =>
        persistLaneManifest(manifestsRoot, manifestPath, manifest)
      );
    } else {
      assertReadOnlyManifestIdentity(observed, manifest);
    }
    await this.#withLanesRootGuard(() =>
      requireGit(
        this.#git,
        repository.canonicalRepositoryPath,
        ["worktree", "add", "--detach", checkoutPath, input.sourceSha],
        gitMutationOptions,
      )
    );
    const workspace = {
      ...await this.#withLanesRootGuard(() =>
        this.#recoverReadOnlySnapshot({
          sourceSha: input.sourceSha,
          checkoutPath,
          expectedGitCommonDir: repository.canonicalGitCommonDir,
          laneId,
          lanesRoot,
        })
      ),
      recovered: false,
    };
    this.#readOnlyIdentityStore?.markReadOnlySnapshotReady(identity);
    await this.#assertLanesRoot();
    return { kind: "created" as const, workspace };
      },
    );
    if (outcome.kind === "recover") {
      return await withRecoveryInspectionSlot(() =>
        this.#recoverReadOnlyWorkspace({
          existing: outcome.existing,
          identity,
          lanesRoot,
          manifest,
          manifestPath,
        })
      );
    }
    return outcome.workspace;
  }

  async #recoverReadOnlyWorkspace(input: Readonly<{
    existing: Awaited<ReturnType<typeof lstat>>;
    identity: ReadOnlySnapshotIdentity;
    lanesRoot: string;
    manifest: ReadOnlyLaneManifest;
    manifestPath: string;
  }>): Promise<ReadOnlyWorkspace> {
    if (!input.existing.isDirectory() || input.existing.isSymbolicLink()) {
      quarantine("path_escape");
    }
    const observed = await this.#withLanesRootGuard(() =>
      readLaneManifest(input.manifestPath)
    );
    if (observed === null) quarantine("manifest_missing");
    assertReadOnlyManifestIdentity(observed, input.manifest);
    const workspace = await this.#withLanesRootGuard(() =>
      this.#recoverReadOnlySnapshot({
        sourceSha: input.identity.baseSha,
        checkoutPath: input.identity.canonicalCheckoutPath,
        expectedGitCommonDir: input.identity.canonicalGitCommonDir,
        laneId: input.identity.laneId,
        lanesRoot: input.lanesRoot,
      })
    );
    this.#bindReadOnlyIdentity(input.identity);
    this.#readOnlyIdentityStore?.markReadOnlySnapshotReady(input.identity);
    await this.#assertLanesRoot();
    return workspace;
  }

  async #recoverExistingLane(input: {
    readonly baseSha: string;
    readonly branchName: string;
    readonly checkoutPath: string;
    readonly expectedGitCommonDir: string;
    readonly laneId: string;
    readonly lanesRoot: string;
  }): Promise<ManagedWorkspace> {
    const canonicalCheckout = await realpath(input.checkoutPath).catch(() => quarantine("path_escape"));
    assertDirectChild(input.lanesRoot, canonicalCheckout);
    const topLevel = await canonicalGitPath(
      canonicalCheckout,
      await requireGit(
        this.#git,
        canonicalCheckout,
        ["rev-parse", "--show-toplevel"],
        gitInspectionOptions,
      ),
    );
    if (topLevel !== canonicalCheckout) quarantine("checkout_mismatch");
    const commonDir = await canonicalGitPath(
      canonicalCheckout,
      await requireGit(
        this.#git,
        canonicalCheckout,
        ["rev-parse", "--git-common-dir"],
        gitInspectionOptions,
      ),
    );
    if (commonDir !== input.expectedGitCommonDir) quarantine("repository_mismatch");
    const observedBase = await requireGit(
      this.#git,
      canonicalCheckout,
      [
        "rev-parse",
        "--verify",
        `${input.baseSha}^{commit}`,
      ],
      gitInspectionOptions,
    );
    if (observedBase !== input.baseSha) quarantine("base_mismatch");
    const observedBranch = await requireGit(
      this.#git,
      canonicalCheckout,
      [
        "branch",
        "--show-current",
      ],
      gitInspectionOptions,
    );
    if (observedBranch !== input.branchName) quarantine("binding_mismatch");
    return {
      baseSha: input.baseSha,
      branchName: input.branchName,
      canonicalGitCommonDir: commonDir,
      checkoutPath: canonicalCheckout,
      laneId: input.laneId,
      recovered: true,
    };
  }

  async #recoverReadOnlySnapshot(input: {
    readonly sourceSha: string;
    readonly checkoutPath: string;
    readonly expectedGitCommonDir: string;
    readonly laneId: string;
    readonly lanesRoot: string;
  }): Promise<ReadOnlyWorkspace> {
    const canonicalCheckout = await realpath(input.checkoutPath)
      .catch(() => quarantine("path_escape"));
    assertDirectChild(input.lanesRoot, canonicalCheckout);
    const topLevel = await canonicalGitPath(
      canonicalCheckout,
      await requireGit(
        this.#git,
        canonicalCheckout,
        ["rev-parse", "--show-toplevel"],
        gitInspectionOptions,
      ),
    );
    if (topLevel !== canonicalCheckout) quarantine("checkout_mismatch");
    const commonDir = await canonicalGitPath(
      canonicalCheckout,
      await requireGit(
        this.#git,
        canonicalCheckout,
        ["rev-parse", "--git-common-dir"],
        gitInspectionOptions,
      ),
    );
    if (commonDir !== input.expectedGitCommonDir) quarantine("repository_mismatch");
    const observedHead = await requireGit(
      this.#git,
      canonicalCheckout,
      ["rev-parse", "--verify", "HEAD"],
      gitInspectionOptions,
    );
    if (observedHead !== input.sourceSha) quarantine("base_mismatch");
    const observedBranch = await requireGit(
      this.#git,
      canonicalCheckout,
      ["branch", "--show-current"],
      gitInspectionOptions,
    );
    if (observedBranch !== "") quarantine("binding_mismatch");
    const status = await requireGit(
      this.#git,
      canonicalCheckout,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      gitInspectionOptions,
    );
    if (status !== "") quarantine("dirty_checkout");
    return {
      baseSha: input.sourceSha,
      canonicalGitCommonDir: commonDir,
      checkoutPath: canonicalCheckout,
      laneId: input.laneId,
      recovered: true,
    };
  }

  #bindIdentity(expected: WorkspaceLaneIdentity): void {
    if (this.#identityStore === null) return;
    const observed = this.#identityStore.bindWorkspaceLane(expected);
    assertStoredIdentity(observed, expected);
  }

  #assertRecoveryAuthorized(expected: WorkspaceLaneIdentity): void {
    if (this.#identityStore?.authorizeWorkspaceLaneRecovery === undefined) return;
    const observed = this.#identityStore.authorizeWorkspaceLaneRecovery(expected);
    if (observed === null) quarantine("binding_mismatch");
    assertStoredIdentity(observed, expected);
  }

  #assertRecoveryAuthorizedStrict(expected: WorkspaceLaneIdentity): void {
    const store = this.#identityStore;
    if (store?.authorizeWorkspaceLaneRecovery === undefined) {
      quarantine("branch_without_lane");
    }
    const observed = store.authorizeWorkspaceLaneRecovery(expected);
    if (observed === null) quarantine("branch_without_lane");
    assertStoredIdentity(observed, expected);
  }

  async #assertBranchHasNoCheckout(
    canonicalRepositoryPath: string,
    branchName: string,
  ): Promise<void> {
    const listing = await this.#withLanesRootGuard(() =>
      requireGit(
        this.#git,
        canonicalRepositoryPath,
        ["worktree", "list", "--porcelain"],
        gitInspectionOptions,
      )
    );
    const expected = `branch refs/heads/${branchName}`;
    if (listing.split("\n").some((line) => line === expected)) {
      quarantine("branch_without_lane");
    }
  }

  #bindReadOnlyIdentity(expected: ReadOnlySnapshotIdentity): void {
    if (this.#readOnlyIdentityStore === null) return;
    const observed = this.#readOnlyIdentityStore.bindReadOnlySnapshot(expected);
    assertReadOnlyStoredIdentity(observed, expected);
  }

  async #prepareLanesRoot(): Promise<string> {
    return this.#withLanesRootGuard(() =>
      ensureCanonicalDirectory(
        this.#lanesRoot,
        this.#lanesRootGuard !== null,
      )
    );
  }

  async #withLanesRootGuard<T>(operation: () => Promise<T>): Promise<T> {
    await this.#assertLanesRoot();
    try {
      return await operation();
    } finally {
      await this.#assertLanesRoot();
    }
  }

  async #assertLanesRoot(): Promise<void> {
    await this.#lanesRootGuard?.assertCurrent(this.#lanesRoot);
  }
}

async function ensureCanonicalDirectory(
  path: string,
  requireConfiguredPath: boolean,
): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Managed-worktree root must be a real directory");
  }
  const canonical = await realpath(path);
  if (requireConfiguredPath && canonical !== path) {
    throw new Error("Managed-worktree root must use its canonical path");
  }
  if (basename(canonical).length === 0) throw new Error("Managed-worktree root is invalid");
  return canonical;
}

async function ensureManifestDirectory(lanesRoot: string): Promise<string> {
  const path = join(lanesRoot, legacyOprteLaneManifestDirectory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) quarantine("path_escape");
  const canonical = await realpath(path);
  assertDirectChild(lanesRoot, canonical);
  return canonical;
}

async function readLaneManifest(path: string): Promise<AnyLaneManifest | null> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (metadata === null) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumLaneManifestBytes) {
    quarantine("invalid_manifest");
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isSymlinkLoop(error)) quarantine("invalid_manifest");
    throw error;
  }
  try {
    const observed = await handle.stat();
    if (!observed.isFile() || observed.size > maximumLaneManifestBytes) {
      quarantine("invalid_manifest");
    }
    const buffer = Buffer.alloc(maximumLaneManifestBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumLaneManifestBytes) quarantine("invalid_manifest");
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, offset).toString("utf8")) as unknown;
    } catch {
      quarantine("invalid_manifest");
    }
    const result = z.union([laneManifestSchema, readOnlyLaneManifestSchema])
      .safeParse(parsed);
    if (!result.success) quarantine("invalid_manifest");
    return result.data;
  } finally {
    await handle.close();
  }
}

async function persistLaneManifest(
  manifestsRoot: string,
  manifestPath: string,
  manifest: AnyLaneManifest,
): Promise<void> {
  const source = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(source) > maximumLaneManifestBytes) {
    throw new Error("Managed-worktree manifest is unexpectedly large");
  }
  const temporaryPath = join(manifestsRoot, `.${manifest.runId}.${randomUUID()}.tmp`);
  assertDirectChild(manifestsRoot, temporaryPath);
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, manifestPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readLaneManifest(manifestPath);
    if (existing === null) quarantine("manifest_missing");
    assertAnyManifestIdentity(existing, manifest);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
  await syncDirectory(manifestsRoot);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertManifestIdentity(
  observed: AnyLaneManifest,
  expected: LaneManifest,
): void {
  if ("kind" in observed) quarantine("binding_mismatch");
  if (
    observed.canonicalRepositoryPath !== expected.canonicalRepositoryPath ||
    observed.canonicalGitCommonDir !== expected.canonicalGitCommonDir
  ) {
    quarantine("repository_mismatch");
  }
  if (observed.baseSha !== expected.baseSha) quarantine("base_mismatch");
  if (
    observed.version !== expected.version ||
    observed.runId !== expected.runId ||
    observed.laneId !== expected.laneId ||
    observed.branchName !== expected.branchName ||
    observed.canonicalCheckoutPath !== expected.canonicalCheckoutPath
  ) {
    quarantine("binding_mismatch");
  }
}

function assertAnyManifestIdentity(
  observed: AnyLaneManifest,
  expected: AnyLaneManifest,
): void {
  if ("kind" in expected) {
    assertReadOnlyManifestIdentity(observed, expected);
    return;
  }
  assertManifestIdentity(observed, expected);
}

function assertReadOnlyManifestIdentity(
  observed: AnyLaneManifest,
  expected: ReadOnlyLaneManifest,
): void {
  if (!("kind" in observed) || observed.kind !== "readOnlySnapshot") {
    quarantine("binding_mismatch");
  }
  if (
    observed.canonicalRepositoryPath !== expected.canonicalRepositoryPath ||
    observed.canonicalGitCommonDir !== expected.canonicalGitCommonDir
  ) {
    quarantine("repository_mismatch");
  }
  if (observed.baseSha !== expected.baseSha) quarantine("base_mismatch");
  if (
    observed.version !== expected.version ||
    observed.runId !== expected.runId ||
    observed.laneId !== expected.laneId ||
    observed.canonicalCheckoutPath !== expected.canonicalCheckoutPath
  ) {
    quarantine("binding_mismatch");
  }
}

function assertStoredIdentity(
  observed: WorkspaceLaneIdentity,
  expected: WorkspaceLaneIdentity,
): void {
  if (
    observed.canonicalRepositoryPath !== expected.canonicalRepositoryPath ||
    observed.canonicalGitCommonDir !== expected.canonicalGitCommonDir
  ) {
    quarantine("repository_mismatch");
  }
  if (observed.baseSha !== expected.baseSha) quarantine("base_mismatch");
  if (
    observed.runId !== expected.runId ||
    observed.laneId !== expected.laneId ||
    observed.branchName !== expected.branchName ||
    observed.canonicalCheckoutPath !== expected.canonicalCheckoutPath ||
    observed.recoveryManifestPath !== expected.recoveryManifestPath
  ) {
    quarantine("binding_mismatch");
  }
}

function assertReadOnlyStoredIdentity(
  observed: ReadOnlySnapshotIdentity,
  expected: ReadOnlySnapshotIdentity,
): void {
  if (
    observed.canonicalRepositoryPath !== expected.canonicalRepositoryPath ||
    observed.canonicalGitCommonDir !== expected.canonicalGitCommonDir
  ) {
    quarantine("repository_mismatch");
  }
  if (observed.baseSha !== expected.baseSha) quarantine("base_mismatch");
  if (
    observed.runId !== expected.runId ||
    observed.laneId !== expected.laneId ||
    observed.canonicalCheckoutPath !== expected.canonicalCheckoutPath ||
    observed.recoveryManifestPath !== expected.recoveryManifestPath
  ) {
    quarantine("binding_mismatch");
  }
}

async function canonicalGitPath(cwd: string, path: string): Promise<string> {
  return realpath(isAbsolute(path) ? path : resolve(cwd, path));
}

function assertDirectChild(parent: string, child: string): void {
  const fragment = relative(parent, child);
  if (fragment.length === 0 || fragment.startsWith("..") || isAbsolute(fragment) || dirname(fragment) !== ".") {
    quarantine("path_escape");
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isSymlinkLoop(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOOP";
}

function quarantine(reason: WorkspaceLaneQuarantineReason): never {
  throw new WorkspaceLaneQuarantinedError(reason);
}

function quarantineMessage(reason: WorkspaceLaneQuarantineReason): string {
  switch (reason) {
    case "base_mismatch":
      return "Managed-worktree base identity does not match the requested dispatch";
    case "binding_mismatch":
      return "Managed-worktree lane identity does not match the requested dispatch";
    case "branch_without_lane":
      return "Managed-worktree branch exists without its bound lane";
    case "checkout_mismatch":
      return "Managed-worktree checkout identity is inconsistent";
    case "dirty_checkout":
      return "Managed-worktree checkout contains unverified local changes";
    case "invalid_manifest":
      return "Managed-worktree recovery manifest is invalid";
    case "manifest_missing":
      return "Managed-worktree recovery manifest is missing";
    case "path_escape":
      return "Managed-worktree path escaped its app-owned root";
    case "repository_mismatch":
      return "Managed-worktree repository identity does not match the requested dispatch";
  }
}

async function withRepositoryProvisionLock<T>(
  canonicalGitCommonDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = repositoryProvisionTails.get(canonicalGitCommonDir) ??
    Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolveTail) => {
    release = resolveTail;
  });
  const queued = predecessor.catch(() => undefined).then(() => tail);
  repositoryProvisionTails.set(canonicalGitCommonDir, queued);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (repositoryProvisionTails.get(canonicalGitCommonDir) === queued) {
      repositoryProvisionTails.delete(canonicalGitCommonDir);
    }
  }
}

async function withRecoveryInspectionSlot<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (activeRecoveryInspections >= maximumParallelRecoveryInspections) {
    await new Promise<void>((resolveWaiter) => {
      recoveryInspectionWaiters.push(resolveWaiter);
    });
  } else {
    activeRecoveryInspections += 1;
  }
  try {
    return await operation();
  } finally {
    const next = recoveryInspectionWaiters.shift();
    if (next === undefined) {
      activeRecoveryInspections -= 1;
    } else {
      next();
    }
  }
}
