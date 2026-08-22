import {
  HRA_HUMAN_KEYCHAIN_SERVICE,
  HRA_RUNNER_KEYCHAIN_SERVICE,
  secretCustodyJournalSchema,
  type SecretCustodyJournal,
} from "@hraness/hra-human-client";
import { z } from "@hra-internal/schema";
import type { Database } from "bun:sqlite";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { accountProfileLayout } from "../accounts/profile-layout";
import {
  HRA_SESSION_SYNC_KEYCHAIN_NAME,
  HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
  HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
} from "../cloud/session-sync-key-custody";
import {
  harnessInstallKeyDescriptor,
  harnessLegacyInstallKeyDescriptor,
} from "../harness/key-custody";
import type { PortableRuntimeAssets } from "../runtime-paths";
import {
  BundledGitRunner,
  requireGit,
  type GitRunOptions,
  type GitRunner,
} from "../workspaces/git-runner";
import {
  discoverLocalDataRemovalInventory,
  type DiscoveredLocalDataRemovalInventory,
  type LocalDataRemovalArtifactCandidate,
  type LocalDataRemovalKeychainTarget,
  type LocalDataRemovalManagedWorktreeCandidate,
} from "./local-data-removal";

const absolutePathSchema = z
  .string()
  .min(2)
  .max(4_096)
  .refine(isAbsolute, "path must be absolute")
  .refine((path) => resolve(path) === path, "path must be normalized");
const boundedIdentifierSchema = z.string().min(1).max(256);
const managedWorktreeIdentifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{7,127}$/u);
const managedWriteWorktreeManifestSchema = z
  .object({
    version: z.literal(1),
    runId: managedWorktreeIdentifierSchema,
    laneId: managedWorktreeIdentifierSchema,
    canonicalRepositoryPath: absolutePathSchema,
    canonicalGitCommonDir: absolutePathSchema,
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
    branchName: z.string().min(1).max(512),
    canonicalCheckoutPath: absolutePathSchema,
  })
  .strict();
const readOnlyWorktreeManifestSchema = z
  .object({
    version: z.literal(2),
    kind: z.literal("readOnlySnapshot"),
    runId: managedWorktreeIdentifierSchema,
    laneId: managedWorktreeIdentifierSchema,
    canonicalRepositoryPath: absolutePathSchema,
    canonicalGitCommonDir: absolutePathSchema,
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
    canonicalCheckoutPath: absolutePathSchema,
  })
  .strict();
const managedWorktreeManifestSchema = z.union([
  managedWriteWorktreeManifestSchema,
  readOnlyWorktreeManifestSchema,
]);
const maximumManagedWorktreeManifestBytes = 16 * 1_024;
const managedWorktreeManifestDirectoryNames = [
  ".oprte-manifests",
  ".kitchen-manifests",
] as const;
const gitProofOptions = {
  stderrLimitBytes: 64 * 1_024,
  stdoutLimitBytes: 128 * 1_024,
  timeoutMs: 30_000,
} as const satisfies GitRunOptions;
const gitStatusOptions = {
  stderrLimitBytes: 128 * 1_024,
  stdoutLimitBytes: 4 * 1_024 * 1_024,
  timeoutMs: 30_000,
} as const satisfies GitRunOptions;

const repositoryRowSchema = z
  .object({
    source: z.enum(["projects", "repository_bindings", "local_repositories"]),
    row_id: boundedIdentifierSchema,
    canonical_repository_path: absolutePathSchema,
    canonical_git_common_dir: absolutePathSchema,
  })
  .strict();
type RepositoryRow = z.infer<typeof repositoryRowSchema>;

const worktreeRowSchema = z
  .object({
    source: z.enum(["workspace_leases", "local_run_execution_bindings"]),
    row_id: boundedIdentifierSchema,
    canonical_checkout_path: absolutePathSchema.nullable(),
    canonical_git_common_dir: absolutePathSchema,
    canonical_repository_path: absolutePathSchema,
    recovery_manifest_path: absolutePathSchema.nullable(),
  })
  .strict();
type WorktreeRow = z.infer<typeof worktreeRowSchema>;

const profileRowSchema = z
  .object({
    profile_id: z.string().min(1).max(128),
  })
  .strict();

const custodyRowSchema = z
  .object({
    service: z.string().min(1).max(240),
    name: z.string().min(1).max(240),
    journal_json: z.string().min(2).max(64 * 1_024),
  })
  .strict();

const custodyQuarantineRowSchema = z
  .object({
    service: z.string().min(1).max(240),
    name: z.string().min(1).max(240),
    slot: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u),
    reason: z.enum([
      "legacy_identity_access_denied",
      "invalid_pointer_preserved",
      "missing_pointer_abandoned",
    ]),
  })
  .strict();

export interface FixedLocalDataRemovalPaths {
  readonly applicationSupportParent: string;
  readonly applicationSupportRoot: string;
  readonly workspaceSetupRoot: string;
  readonly fixedCodexProfileRoots:
    readonly [string, string, string, string, string];
  readonly controlPlanePath: string;
  readonly harnessApplicationStateRoots:
    readonly [string, string, string, string];
  readonly helperStateRoot: string;
  readonly nativeInstanceLockPath: string;
  readonly updateHazardPath: string;
  readonly updateHazardTemporaryPath: string;
  readonly managedWorktreeRoots: readonly [string, string, string, string];
  readonly manifestRoots:
    readonly [string, string, string, string, string, string, string, string];
}

export function fixedLocalDataRemovalPaths(
  effectiveHomeValue: string,
): FixedLocalDataRemovalPaths {
  const effectiveHome = absolutePathSchema.parse(effectiveHomeValue);
  const applicationSupportParent = join(
    effectiveHome,
    "Library",
    "Application Support",
  );
  const applicationSupportRoot = join(
    applicationSupportParent,
    "OPRTE",
  );
  const dispatchWorktrees = join(
    applicationSupportRoot,
    "dispatch",
    "worktrees",
  );
  const localTaskWorktrees = join(
    applicationSupportRoot,
    "local-task-worktrees",
  );
  const harnessVersionRoot = join(
    applicationSupportRoot,
    "harness",
    "v1",
  );
  const harnessWorktrees = join(harnessVersionRoot, "worktrees");
  const chatWorktrees = join(applicationSupportRoot, "chat-worktrees");
  return {
    applicationSupportParent,
    applicationSupportRoot,
    workspaceSetupRoot: join(applicationSupportRoot, "workspace-setup"),
    fixedCodexProfileRoots: [
      join(applicationSupportRoot, "profiles", "default", "codex-home"),
      join(applicationSupportRoot, "dispatch", "codex-home"),
      join(applicationSupportRoot, "local-task-dispatch", "codex-home"),
      join(applicationSupportRoot, "onboarding", "codex-home"),
      join(applicationSupportRoot, "chat", "git-codex-home"),
    ],
    controlPlanePath: join(applicationSupportRoot, "control-plane.sqlite"),
    harnessApplicationStateRoots: [
      join(harnessVersionRoot, "objects"),
      join(harnessVersionRoot, "heap"),
      join(harnessVersionRoot, "context-values"),
      join(harnessVersionRoot, "scratch"),
    ],
    helperStateRoot: join(
      applicationSupportParent,
      "OPRTE Removal",
    ),
    nativeInstanceLockPath: join(
      applicationSupportParent,
      ".Hraness Kitchen.native-instance.lock",
    ),
    updateHazardPath: join(
      applicationSupportParent,
      ".Hraness Kitchen.update-hazard-v1.json",
    ),
    updateHazardTemporaryPath: join(
      applicationSupportParent,
      ".Hraness Kitchen.update-hazard-v1.json.tmp",
    ),
    managedWorktreeRoots: [
      dispatchWorktrees,
      localTaskWorktrees,
      harnessWorktrees,
      chatWorktrees,
    ],
    manifestRoots: [
      join(dispatchWorktrees, ".oprte-manifests"),
      join(dispatchWorktrees, ".kitchen-manifests"),
      join(localTaskWorktrees, ".oprte-manifests"),
      join(localTaskWorktrees, ".kitchen-manifests"),
      join(harnessWorktrees, ".oprte-manifests"),
      join(harnessWorktrees, ".kitchen-manifests"),
      join(chatWorktrees, ".oprte-manifests"),
      join(chatWorktrees, ".kitchen-manifests"),
    ],
  };
}

export function gatewayAdditionalApplicationStateArtifacts(
  fixed: FixedLocalDataRemovalPaths,
): readonly LocalDataRemovalArtifactCandidate[] {
  return [
    {
      path: fixed.workspaceSetupRoot,
      kind: "directory",
    },
    // Harness worktrees are inventoried separately as managed worktrees so
    // a dirty checkout can never hide inside an opaque application-state
    // target. These four sibling roots contain the remaining v1 harness
    // state, including encrypted heap bytes whose installation key is an
    // independently inventoried Keychain target.
    ...fixed.harnessApplicationStateRoots.map((path) => ({
      path,
      kind: "directory" as const,
    })),
    {
      path: fixed.nativeInstanceLockPath,
      kind: "file",
    },
    {
      path: fixed.updateHazardPath,
      kind: "file",
    },
    {
      path: fixed.updateHazardTemporaryPath,
      kind: "file",
    },
    ...fixed.manifestRoots.map((path) => ({
      path,
      kind: "directory" as const,
    })),
  ];
}

export interface LocalDataRemovalDatabaseInventory {
  readonly hraCodexProfileRoots: readonly string[];
  readonly keychainTargets: readonly LocalDataRemovalKeychainTarget[];
  readonly preservedCredentialEvidenceRecords: number;
  readonly repositories: readonly RepositoryRow[];
  readonly worktrees: readonly WorktreeRow[];
}

/**
 * Reads every path-bearing and custody-bearing row, including tombstones.
 * Callers must still prove the paths against the filesystem and bundled Git
 * before creating a signed plan.
 */
export function readLocalDataRemovalDatabaseInventory(
  database: Database,
  controlPlanePathValue: string,
): LocalDataRemovalDatabaseInventory {
  const controlPlanePath = absolutePathSchema.parse(controlPlanePathValue);
  const repositoryValues: unknown = [
    ...database.query(`
      SELECT 'projects' AS source, project_id AS row_id,
        canonical_repository_path, canonical_git_common_dir
      FROM projects
    `).all(),
    ...database.query(`
      SELECT 'repository_bindings' AS source,
        repository_public_id AS row_id,
        canonical_repository_path, canonical_git_common_dir
      FROM repository_bindings
    `).all(),
    ...database.query(`
      SELECT 'local_repositories' AS source, repository_id AS row_id,
        canonical_repository_path, canonical_git_common_dir
      FROM local_repositories
    `).all(),
  ];
  const repositories = z.array(repositoryRowSchema).parse(repositoryValues);

  const worktreeValues: unknown = [
    ...database.query(`
      SELECT 'workspace_leases' AS source, lease.lane_id AS row_id,
        lease.canonical_checkout_path,
        project.canonical_git_common_dir,
        project.canonical_repository_path,
        lease.recovery_manifest_path
      FROM workspace_leases AS lease
      JOIN projects AS project ON project.project_id = lease.project_id
    `).all(),
    ...database.query(`
      SELECT 'local_run_execution_bindings' AS source,
        binding.run_id AS row_id,
        binding.canonical_checkout_path,
        coalesce(
          binding.canonical_git_common_dir,
          repository.canonical_git_common_dir
        ) AS canonical_git_common_dir,
        repository.canonical_repository_path,
        binding.recovery_manifest_path
      FROM local_run_execution_bindings AS binding
      JOIN local_repositories AS repository
        ON repository.repository_id = binding.repository_id
    `).all(),
  ];
  const worktrees = z.array(worktreeRowSchema).parse(worktreeValues);

  const profileValues: unknown = database.query(`
    SELECT profile_id FROM account_profiles
  `).all();
  const profiles = z.array(profileRowSchema).parse(profileValues);

  const custodyValues: unknown = database.query(`
    SELECT service, name, journal_json
    FROM human_custody_metadata
  `).all();
  const custodyRows = z.array(custodyRowSchema).parse(custodyValues);
  const custodyQuarantineValues: unknown = database.query(`
    SELECT service, name, slot, reason
    FROM human_custody_pointer_quarantine
  `).all();
  const custodyQuarantineRows = z.array(custodyQuarantineRowSchema)
    .parse(custodyQuarantineValues);
  const preservedQuarantineKeys = new Set(
    custodyQuarantineRows.flatMap((row) => {
      if (custodyKeychainCategory(row.service) === null) {
        throw new TypeError("An unknown secret-custody service is present.");
      }
      return row.reason === "missing_pointer_abandoned"
        ? []
        : [`${row.service}\u0000${row.name}\u0000${row.slot}`];
    }),
  );

  const hraCodexProfileRoots = profiles.map(({ profile_id }) =>
    accountProfileLayout(controlPlanePath, profile_id).profileRoot
  );
  const keychainTargets: LocalDataRemovalKeychainTarget[] = [
    ...custodyRows.flatMap(keychainTargetsForCustodyRow),
    {
      category: "harness_context_heap_key",
      ...harnessLegacyInstallKeyDescriptor,
    },
    {
      category: "harness_context_heap_key",
      ...harnessInstallKeyDescriptor,
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
  ];

  return {
    hraCodexProfileRoots,
    keychainTargets,
    preservedCredentialEvidenceRecords: preservedQuarantineKeys.size,
    repositories,
    worktrees,
  };
}

export interface DiscoverGatewayLocalDataRemovalInventoryOptions {
  readonly database: Database;
  readonly effectiveHome: string;
  readonly controlPlanePath: string;
  readonly helperStateRoot: string;
  readonly assets: PortableRuntimeAssets;
  readonly git?: GitRunner;
}

export async function discoverGatewayLocalDataRemovalInventory(
  options: DiscoverGatewayLocalDataRemovalInventoryOptions,
): Promise<DiscoveredLocalDataRemovalInventory> {
  const fixed = fixedLocalDataRemovalPaths(options.effectiveHome);
  if (
    options.controlPlanePath !== fixed.controlPlanePath ||
    options.helperStateRoot !== fixed.helperStateRoot
  ) {
    throw new TypeError(
      "Local-data removal paths do not match the effective-user layout.",
    );
  }
  await assertBundledGitAssets(options.assets);
  const git = options.git ?? new BundledGitRunner({
    ...options.assets,
    codexHome: join(
      fixed.applicationSupportRoot,
      "local-task-dispatch",
      "codex-home",
    ),
  });
  const rows = readLocalDataRemovalDatabaseInventory(
    options.database,
    fixed.controlPlanePath,
  );
  const reconciledWorktrees =
    await reconcileGatewayManagedWorktreeInventory({
      repositories: rows.repositories,
      worktrees: rows.worktrees,
      roots: fixed.managedWorktreeRoots,
      git,
    });
  const additionalApplicationStateArtifacts =
    gatewayAdditionalApplicationStateArtifacts(fixed);
  return await discoverLocalDataRemovalInventory({
    homeDirectory: options.effectiveHome,
    applicationSupportRoot: fixed.applicationSupportRoot,
    controlPlanePath: fixed.controlPlanePath,
    helperStateRoot: fixed.helperStateRoot,
    hraCodexProfileRoots: [
      ...rows.hraCodexProfileRoots,
      ...fixed.fixedCodexProfileRoots,
    ],
    managedWorktreeRoots: fixed.managedWorktreeRoots,
    managedWorktrees: reconciledWorktrees.managedWorktrees,
    userRepositories: [...reconciledWorktrees.repositories.keys()],
    keychainTargets: rows.keychainTargets,
    preservedCredentialEvidenceRecords:
      rows.preservedCredentialEvidenceRecords,
    gitInspector: {
      async isDirty(worktreePath) {
        const result = await git.run(
          worktreePath,
          [
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ],
          gitStatusOptions,
        );
        if (result.exitCode !== 0) {
          throw new Error("Bundled Git could not inspect a managed worktree.");
        }
        return result.stdout.length > 0;
      },
    },
    additionalApplicationStateArtifacts,
  });
}

export async function verifiedLocalDataRemoverPath(
  pathValue: string | undefined,
): Promise<string> {
  if (pathValue === undefined) {
    throw new TypeError("The packaged local-data remover is unavailable.");
  }
  const path = absolutePathSchema.parse(pathValue);
  if (basename(path) !== "oprte-data-remover") {
    throw new TypeError("The packaged local-data remover path is invalid.");
  }
  const canonical = await realpath(path);
  if (canonical !== path) {
    throw new TypeError("The packaged local-data remover path is not canonical.");
  }
  const value = await lstat(canonical);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) {
    throw new TypeError("The packaged local-data remover is unsafe.");
  }
  await access(canonical, constants.X_OK);
  return canonical;
}

async function assertBundledGitAssets(
  assets: PortableRuntimeAssets,
): Promise<void> {
  const gitBinary = absolutePathSchema.parse(assets.gitBinary);
  const gitRoot = absolutePathSchema.parse(assets.gitRoot);
  if (!isLocalDataRemovalBundledGitPathContained(gitRoot, gitBinary)) {
    throw new TypeError("Bundled Git escaped its fixed runtime root.");
  }
  if (await realpath(gitRoot) !== gitRoot || await realpath(gitBinary) !== gitBinary) {
    throw new TypeError("Bundled Git assets are not canonical.");
  }
  await access(gitBinary, constants.X_OK);
}

export function isLocalDataRemovalBundledGitPathContained(
  gitRoot: string,
  gitBinary: string,
): boolean {
  const contained = relative(gitRoot, gitBinary);
  return (
    contained.length > 0 &&
    contained !== ".." &&
    !contained.startsWith(`..${sep}`) &&
    !isAbsolute(contained)
  );
}

function keychainTargetsForCustodyRow(
  row: z.infer<typeof custodyRowSchema>,
): LocalDataRemovalKeychainTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.journal_json) as unknown;
  } catch {
    throw new TypeError("An HRA secret-custody journal is malformed.");
  }
  const journal = secretCustodyJournalSchema.parse(parsed);
  if (journal.service !== row.service || journal.name !== row.name) {
    throw new TypeError(
      "An HRA secret-custody journal does not match its database row.",
    );
  }
  const category = custodyKeychainCategory(journal.service);
  if (category === null) {
    throw new TypeError("An unknown secret-custody service is present.");
  }
  return journalPointers(journal).map(({ slot }) => ({
    category,
    service: journal.service,
    name: `${journal.name}:slot:${slot}`,
  }));
}

function custodyKeychainCategory(
  service: string,
): "human_credential_generation" | "runner_pairing_secret" | null {
  return service === HRA_HUMAN_KEYCHAIN_SERVICE
    ? "human_credential_generation"
    : service === HRA_RUNNER_KEYCHAIN_SERVICE
    ? "runner_pairing_secret"
    : null;
}

function journalPointers(
  journal: SecretCustodyJournal,
): readonly { readonly slot: string }[] {
  return [
    ...(journal.committed === undefined ? [] : [journal.committed]),
    ...(journal.pending === undefined ? [] : [journal.pending.pointer]),
    ...(journal.deleting ?? []),
  ];
}

export interface ReconciledGatewayManagedWorktreeInventory {
  readonly repositories: ReadonlyMap<string, string>;
  readonly managedWorktrees:
    readonly LocalDataRemovalManagedWorktreeCandidate[];
}

export async function reconcileGatewayManagedWorktreeInventory(
  options: {
    readonly repositories: LocalDataRemovalDatabaseInventory["repositories"];
    readonly worktrees: LocalDataRemovalDatabaseInventory["worktrees"];
    readonly roots: readonly string[];
    readonly git: GitRunner;
  },
): Promise<ReconciledGatewayManagedWorktreeInventory> {
  const repositories = await proveRepositoryRows(
    options.repositories,
    options.git,
  );
  const managedWorktrees = await proveWorktreeRows({
    rows: options.worktrees,
    repositories,
    roots: options.roots,
    git: options.git,
  });
  return { repositories, managedWorktrees };
}

async function proveRepositoryRows(
  rows: readonly RepositoryRow[],
  git: GitRunner,
): Promise<ReadonlyMap<string, string>> {
  const repositories = new Map<string, string>();
  for (const row of rows) {
    const previous = repositories.get(row.canonical_repository_path);
    if (
      previous !== undefined &&
      previous !== row.canonical_git_common_dir
    ) {
      throw new TypeError(
        "Repository rows disagree about their Git common directory.",
      );
    }
    repositories.set(
      row.canonical_repository_path,
      row.canonical_git_common_dir,
    );
  }
  for (const [repositoryPath, commonDirectory] of repositories) {
    const value = await lstat(repositoryPath).catch((error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    });
    if (value === null) continue;
    if (
      value.isSymbolicLink() ||
      !value.isDirectory() ||
      await realpath(repositoryPath) !== repositoryPath
    ) {
      throw new TypeError("A preserved repository path is unsafe.");
    }
    const top = await canonicalGitOutput(
      repositoryPath,
      await requireGit(
        git,
        repositoryPath,
        [
          "--no-optional-locks",
          "rev-parse",
          "--show-toplevel",
        ],
        gitProofOptions,
      ),
    );
    const common = await canonicalGitOutput(
      repositoryPath,
      await requireGit(
        git,
        repositoryPath,
        [
          "--no-optional-locks",
          "rev-parse",
          "--git-common-dir",
        ],
        gitProofOptions,
      ),
    );
    if (top !== repositoryPath || common !== commonDirectory) {
      throw new TypeError(
        "Bundled Git did not prove a preserved repository row.",
      );
    }
  }
  return repositories;
}

async function proveWorktreeRows(options: {
  readonly rows: readonly WorktreeRow[];
  readonly repositories: ReadonlyMap<string, string>;
  readonly roots: readonly string[];
  readonly git: GitRunner;
}): Promise<readonly LocalDataRemovalManagedWorktreeCandidate[]> {
  const candidates = new Map<
    string,
    LocalDataRemovalManagedWorktreeCandidate
  >();
  for (const row of options.rows) {
    const repositoryCommon = options.repositories.get(
      row.canonical_repository_path,
    );
    if (
      repositoryCommon === undefined ||
      repositoryCommon !== row.canonical_git_common_dir
    ) {
      throw new TypeError(
        "A worktree row does not match a preserved repository row.",
      );
    }
    if (row.canonical_checkout_path === null) {
      if (row.recovery_manifest_path !== null) {
        throw new TypeError(
          "A worktree row without a checkout retained a recovery manifest.",
        );
      }
      continue;
    }
    const checkoutPath = row.canonical_checkout_path;
    const root = options.roots.find((candidate) =>
      isDirectChild(candidate, checkoutPath)
    );
    if (root === undefined) {
      throw new TypeError("A managed worktree escaped its fixed root.");
    }
    assertRecoveryManifest(row, root);
    const administrativeDirectory = await proveWorktreeAdministration({
      checkoutPath,
      commonDirectory: row.canonical_git_common_dir,
      rowId: row.row_id,
      git: options.git,
    });
    const candidate = {
      path: checkoutPath,
      registration: {
        repositoryPath: row.canonical_repository_path,
        gitCommonDirectory: row.canonical_git_common_dir,
        administrativeDirectory,
      },
    } satisfies LocalDataRemovalManagedWorktreeCandidate;
    const previous = candidates.get(checkoutPath);
    if (
      previous !== undefined &&
      JSON.stringify(previous) !== JSON.stringify(candidate)
    ) {
      throw new TypeError("Managed worktree rows disagree.");
    }
    candidates.set(checkoutPath, candidate);
  }
  await reconcileManagedWorktreeRootChildren({
    candidates,
    repositories: options.repositories,
    roots: options.roots,
    git: options.git,
  });
  return [...candidates.values()];
}

async function reconcileManagedWorktreeRootChildren(options: {
  readonly candidates: Map<
    string,
    LocalDataRemovalManagedWorktreeCandidate
  >;
  readonly repositories: ReadonlyMap<string, string>;
  readonly roots: readonly string[];
  readonly git: GitRunner;
}): Promise<void> {
  for (const root of options.roots) {
    const rootMetadata = await lstat(root).catch((error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    });
    if (rootMetadata === null) continue;
    if (
      rootMetadata.isSymbolicLink() ||
      !rootMetadata.isDirectory() ||
      await realpath(root) !== root
    ) {
      throw new TypeError("A managed-worktree root is unsafe.");
    }
    const entries = await readdir(root, { withFileTypes: true });
    const manifestsRoots = managedWorktreeManifestDirectoryNames.map((name) =>
      join(root, name)
    );
    for (const [index, name] of managedWorktreeManifestDirectoryNames.entries()) {
      const manifestEntry = entries.find((entry) => entry.name === name);
      const manifestsRoot = manifestsRoots[index];
      if (
        manifestEntry !== undefined &&
        manifestsRoot !== undefined &&
        (
          manifestEntry.isSymbolicLink() ||
          !manifestEntry.isDirectory() ||
          await realpath(manifestsRoot) !== manifestsRoot
        )
      ) {
        throw new TypeError(
          "A managed-worktree manifest root is unsafe.",
        );
      }
    }
    for (const entry of entries) {
      const child = join(root, entry.name);
      if (managedWorktreeManifestDirectoryNames.includes(
        entry.name as (typeof managedWorktreeManifestDirectoryNames)[number],
      )) continue;
      if (
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        await realpath(child) !== child
      ) {
        throw new TypeError(
          "A managed-worktree root contains an unknown unsafe child.",
        );
      }
      if (options.candidates.has(child)) continue;
      const candidate = await proveManifestOrphanWorktree({
        checkoutPath: child,
        manifestsRoots,
        repositories: options.repositories,
        git: options.git,
      });
      options.candidates.set(child, candidate);
    }
  }
}

async function proveManifestOrphanWorktree(options: {
  readonly checkoutPath: string;
  readonly manifestsRoots: readonly string[];
  readonly repositories: ReadonlyMap<string, string>;
  readonly git: GitRunner;
}): Promise<LocalDataRemovalManagedWorktreeCandidate> {
  const laneId = basename(options.checkoutPath);
  const candidates = options.manifestsRoots.map((root) =>
    join(root, `${laneId}.json`)
  );
  const present: string[] = [];
  for (const path of candidates) {
    const value = await lstat(path).catch((error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    });
    if (value !== null) present.push(path);
  }
  if (present.length !== 1) {
    throw new TypeError(
      present.length === 0
        ? "An unknown managed-worktree child has no exact manifest."
        : "An unknown managed-worktree child has conflicting manifests.",
    );
  }
  const manifestPath = present[0] as string;
  const manifest = await readManagedWorktreeManifest(manifestPath);
  if (
    manifest.runId !== laneId ||
    manifest.laneId !== laneId ||
    manifest.canonicalCheckoutPath !== options.checkoutPath
  ) {
    throw new TypeError(
      "An orphan managed-worktree manifest has a mismatched identity.",
    );
  }
  const repositoryCommon = options.repositories.get(
    manifest.canonicalRepositoryPath,
  );
  if (
    repositoryCommon === undefined ||
    repositoryCommon !== manifest.canonicalGitCommonDir
  ) {
    throw new TypeError(
      "An orphan managed worktree does not name a preserved repository.",
    );
  }
  const administrativeDirectory = await proveWorktreeAdministration({
    checkoutPath: options.checkoutPath,
    commonDirectory: manifest.canonicalGitCommonDir,
    rowId: laneId,
    git: options.git,
  });
  const status = await options.git.run(
    options.checkoutPath,
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ],
    gitStatusOptions,
  );
  if (status.exitCode !== 0) {
    throw new TypeError(
      "Bundled Git could not inspect an orphan managed worktree.",
    );
  }
  return {
    path: options.checkoutPath,
    dirty: status.stdout.length > 0,
    registration: {
      repositoryPath: manifest.canonicalRepositoryPath,
      gitCommonDirectory: manifest.canonicalGitCommonDir,
      administrativeDirectory,
    },
  };
}

async function readManagedWorktreeManifest(
  path: string,
): Promise<z.infer<typeof managedWorktreeManifestSchema>> {
  const source = await readNoFollowText(
    path,
    maximumManagedWorktreeManifestBytes,
  ).catch((error: unknown) => {
    if (isFileSystemError(error, "ENOENT")) {
      throw new TypeError(
        "An unknown managed-worktree child has no exact manifest.",
      );
    }
    throw error;
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new TypeError("A managed-worktree manifest is malformed.");
  }
  return managedWorktreeManifestSchema.parse(parsed);
}

function assertRecoveryManifest(row: WorktreeRow, worktreeRoot: string): void {
  if (row.recovery_manifest_path === null) return;
  const expected = managedWorktreeManifestDirectoryNames.map((name) =>
    join(worktreeRoot, name, `${row.row_id}.json`)
  );
  if (!expected.includes(row.recovery_manifest_path)) {
    throw new TypeError(
      "A managed-worktree recovery manifest escaped its fixed directory.",
    );
  }
}

async function proveWorktreeAdministration(options: {
  readonly checkoutPath: string;
  readonly commonDirectory: string;
  readonly rowId: string;
  readonly git: GitRunner;
}): Promise<string> {
  const checkout = await lstat(options.checkoutPath).catch(
    (error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    },
  );
  if (checkout !== null) {
    if (
      checkout.isSymbolicLink() ||
      !checkout.isDirectory() ||
      await realpath(options.checkoutPath) !== options.checkoutPath
    ) {
      throw new TypeError("A managed worktree path is unsafe.");
    }
    const top = await canonicalGitOutput(
      options.checkoutPath,
      await requireGit(
        options.git,
        options.checkoutPath,
        [
          "--no-optional-locks",
          "rev-parse",
          "--show-toplevel",
        ],
        gitProofOptions,
      ),
    );
    const common = await canonicalGitOutput(
      options.checkoutPath,
      await requireGit(
        options.git,
        options.checkoutPath,
        [
          "--no-optional-locks",
          "rev-parse",
          "--git-common-dir",
        ],
        gitProofOptions,
      ),
    );
    const administration = await canonicalGitOutput(
      options.checkoutPath,
      await requireGit(
        options.git,
        options.checkoutPath,
        [
          "--no-optional-locks",
          "rev-parse",
          "--git-dir",
        ],
        gitProofOptions,
      ),
    );
    if (
      top !== options.checkoutPath ||
      common !== options.commonDirectory ||
      !isDirectChild(
        join(options.commonDirectory, "worktrees"),
        administration,
      )
    ) {
      throw new TypeError("Bundled Git did not prove a managed worktree row.");
    }
    return administration;
  }

  const administrativeRoot = join(options.commonDirectory, "worktrees");
  const entries = await readdir(administrativeRoot, {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw error;
  });
  const expectedBacklink = join(options.checkoutPath, ".git");
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(administrativeRoot, entry.name);
    if (!isDirectChild(administrativeRoot, candidate)) continue;
    const backlink = await readNoFollowText(join(candidate, "gitdir")).catch(
      (error: unknown) => {
        if (isFileSystemError(error, "ENOENT")) return null;
        throw error;
      },
    );
    if (backlink?.trimEnd() === expectedBacklink) matches.push(candidate);
  }
  if (matches.length > 1) {
    throw new TypeError("Multiple Git administration rows claim one worktree.");
  }
  return matches[0] ?? join(administrativeRoot, options.rowId);
}

async function canonicalGitOutput(cwd: string, value: string): Promise<string> {
  const path = resolve(cwd, value);
  return await realpath(path);
}

async function readNoFollowText(
  path: string,
  maximumBytes = 4_096,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const value = await handle.stat();
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.nlink !== 1 ||
      value.size <= 0 ||
      value.size > maximumBytes
    ) {
      throw new TypeError("A Git administration backlink is unsafe.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle?.close();
  }
}

function isDirectChild(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix.length > 0 &&
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`) &&
    !suffix.includes(sep)
  );
}

function isFileSystemError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
