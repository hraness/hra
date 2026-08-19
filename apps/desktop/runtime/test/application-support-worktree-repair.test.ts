import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApplicationSupportWorktreeRepairError,
  type ApplicationSupportWorktreeRepairFaultPoint,
  inspectApplicationSupportWorktreeRepair,
  repairMovedApplicationSupportWorktrees,
  reverseMovedApplicationSupportWorktreeRepair,
} from "../src/state/application-support-worktree-repair";
import { applyMigrations } from "../src/state/database";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { migrations } from "../src/state/migrations";
import { ProviderThreadArchiveJournalV57 } from
  "../src/state/provider-thread-archive-journal-v57";
import type { GitResult, GitRunner } from "../src/workspaces/git-runner";
import { requireGit } from "../src/workspaces/git-runner";
import { WorkspaceBroker } from "../src/workspaces/workspace-broker";

const gitBinary = Bun.which("git");
const temporaryRoots: string[] = [];
const laneId = "run_migration0001";
const chatBindingId = "chatws_migration0000000001";
const timestamp = "2026-07-24T12:00:00.000Z";
const futureMigrationVersion = (migrations.at(-1)?.version ?? 0) + 1;
const archiveReceiptKey = new Uint8Array(32).fill(57);
const archiveThreadId = "thread_worktree_repair_v57";
const archiveRestartThreadId = "restart_worktree_repair_v57";
const archiveTargetId = "archtarget_worktree_repair_v57";
const archiveAttemptId = "archattempt_worktree_repair_v57";
const archiveCutId = "archcut_worktree_repair_v57";
const archiveMemberId = "archmember_worktree_repair_v57";

class RealGitRunner implements GitRunner {
  readonly calls: { readonly cwd: string; readonly args: readonly string[] }[] = [];

  async run(cwd: string, args: readonly string[]): Promise<GitResult> {
    if (gitBinary === null) throw new Error("Git is unavailable");
    this.calls.push({ cwd, args: [...args] });
    const child = Bun.spawn([gitBinary, ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

interface RepairFixture {
  readonly database: Database;
  readonly git: RealGitRunner;
  readonly legacyCheckout: string;
  readonly legacyManifest: string;
  readonly legacyRoot: string;
  readonly repository: string;
  readonly root: string;
  readonly targetCheckout: string;
  readonly targetManifest: string;
  readonly targetRoot: string;
}

type FixtureLaneState =
  | "databaseOnly"
  | "linkedChatProvisioning"
  | "linkedProvisioning"
  | "manifestOnly"
  | "ready";
type FixtureLeaseStatus = "preserved" | "quarantined";

async function fixture(
  migrationPrefix: 0 | 1 | 3 | "current" = "current",
  laneState: FixtureLaneState = "ready",
  leaseStatusOverride?: FixtureLeaseStatus,
): Promise<RepairFixture> {
  if (leaseStatusOverride !== undefined && migrationPrefix !== "current") {
    throw new Error("Terminal lease fixtures require the current schema");
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "oprte-worktree-repair-")));
  temporaryRoots.push(root);
  const supportParent = join(root, "Application Support");
  const legacyRoot = join(supportParent, "Hraness Kitchen");
  const targetRoot = join(supportParent, "OPRTE");
  const repository = join(root, "external-repository");
  await Promise.all([mkdir(legacyRoot, { recursive: true }), mkdir(repository)]);

  const git = new RealGitRunner();
  await requireGit(git, repository, ["init", "--initial-branch=main"]);
  await requireGit(git, repository, ["config", "user.name", "OPRTE test"]);
  await requireGit(git, repository, ["config", "user.email", "test@oprte.invalid"]);
  await writeFile(join(repository, "tracked.txt"), "base\n");
  await requireGit(git, repository, ["add", "tracked.txt"]);
  await requireGit(git, repository, ["commit", "-m", "base"]);

  const lanesRoot = join(legacyRoot, "dispatch", "worktrees");
  const broker = new WorkspaceBroker({ git, lanesRoot });
  const baseSha = await broker.resolveBase(repository, "HEAD");
  const repositoryIdentity = await broker.inspectRepository(repository);
  const branchName = `codex/oprte-${laneId}`;
  const legacyCheckout = join(lanesRoot, laneId);
  const legacyManifest = join(lanesRoot, ".oprte-manifests", `${laneId}.json`);
  if (
    migrationPrefix !== 0
    && (
      laneState === "ready" || laneState === "linkedProvisioning" ||
      laneState === "linkedChatProvisioning"
    )
  ) {
    await broker.provision({ runId: laneId, repositoryPath: repository, baseSha });
    await writeFile(join(legacyCheckout, "tracked.txt"), "dirty tracked\n");
    await writeFile(join(legacyCheckout, "untracked.txt"), "dirty untracked\n");
  } else if (migrationPrefix !== 0 && laneState === "manifestOnly") {
    await mkdir(join(lanesRoot, ".oprte-manifests"), { recursive: true, mode: 0o700 });
    await writeFile(legacyManifest, `${JSON.stringify({
      version: 1,
      runId: laneId,
      laneId,
      canonicalRepositoryPath: repository,
      canonicalGitCommonDir: repositoryIdentity.canonicalGitCommonDir,
      baseSha,
      branchName,
      canonicalCheckoutPath: legacyCheckout,
    })}\n`, { mode: 0o600 });
  }

  const databasePath = join(legacyRoot, "control-plane.sqlite");
  let database = new Database(databasePath, { create: true, strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  if (migrationPrefix === "current") {
    applyMigrations(database);
  } else {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    for (const migration of migrations) {
      if (migration.version > migrationPrefix) break;
      database.exec(migration.sql);
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(`${String(migration.version)}\n${migration.name}\n${migration.sql}`);
      database.query(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?1, ?2, ?3, ?4)
      `).run(
        migration.version,
        migration.name,
        hasher.digest("hex"),
        timestamp,
      );
    }
  }
  if (migrationPrefix !== 0) {
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation, created_at, updated_at
      ) VALUES ('profile_migration01', 'Local Codex', 'ready', 1, ?1, ?1)
    `).run(timestamp);
    database.query(`
      INSERT INTO projects (
        project_id, canonical_repository_path, canonical_git_common_dir,
        display_name, created_at, updated_at
      ) VALUES ('project_migration1', ?1, ?2, 'Fixture', ?3, ?3)
    `).run(repository, repositoryIdentity.canonicalGitCommonDir, timestamp);
    const leaseStatus = leaseStatusOverride
      ?? (laneState === "ready" ? "ready" : "provisioning");
    const workspaceMode = laneState === "linkedChatProvisioning"
      ? "chat_managed_worktree"
      : "managed_dispatch";
    database.query(`
      INSERT INTO workspace_leases (
        lane_id, project_id, account_profile_id, canonical_checkout_path, mode,
        status, base_sha, branch_name, retention, recovery_manifest_path,
        created_at, updated_at
      ) VALUES (
        ?1, 'project_migration1', 'profile_migration01', ?2, ?8,
        ?6, ?3, ?4, 'preserve', ?5, ?7, ?7
      )
    `).run(
      laneId,
      legacyCheckout,
      baseSha,
      branchName,
      legacyManifest,
      leaseStatus,
      timestamp,
      workspaceMode,
    );
    if (leaseStatus === "quarantined") {
      database.query(`
        UPDATE workspace_leases
        SET quarantine_reason = 'provision_interrupted', quarantined_at = ?2
        WHERE lane_id = ?1
      `).run(laneId, timestamp);
    }
    database.query(`
      INSERT INTO thread_bindings (
        thread_id, codex_thread_id, account_profile_id, project_id, lane_id,
        archived, created_at, updated_at
      ) VALUES (
        'thread_migration1', 'codex-thread-migration-1', 'profile_migration01',
        'project_migration1', ?1, 0, ?2, ?2
      )
    `).run(laneId, timestamp);
  }
  if (migrationPrefix === "current") {
    database.query(`
      INSERT INTO repository_bindings (
        repository_public_id, project_id, canonical_repository_path,
        canonical_git_common_dir, enabled, created_at, updated_at
      ) VALUES (
        'repository_migration1', 'project_migration1', ?1, ?2, 1, ?3, ?3
      )
    `).run(repository, repositoryIdentity.canonicalGitCommonDir, timestamp);
    database.query(`
      INSERT INTO dispatch_bindings (
        run_id, task_id, claim_id, claim_fence, input_review_revision,
        runtime_public_id, runtime_boot_id, repository_public_id,
        account_profile_id, lane_id, thread_id, stage, base_sha, branch_name,
        created_at, updated_at
      ) VALUES (
        ?1, 'task_migration01', 'claim_migration1', 1, 1, 'runtime_migration1',
        'boot_migration001', 'repository_migration1', 'profile_migration01', ?1,
        'thread_migration1', 'running', ?2, ?3, ?4, ?4
      )
    `).run(laneId, baseSha, branchName, timestamp);
    if (
      (laneState === "ready" || laneState === "linkedChatProvisioning") &&
      leaseStatusOverride === undefined
    ) {
      database.query(`
        INSERT INTO local_repositories (
          repository_id, name, canonical_repository_path,
          canonical_git_common_dir, created_at, updated_at
        ) VALUES (
          'repo_00000000000000000000000001', 'Fixture', ?1, ?2, 1, 1
        )
      `).run(repository, repositoryIdentity.canonicalGitCommonDir);
      database.query(`
        INSERT INTO chat_panes (
          pane_id, palette_index, repository_id, repository_name, revision, title,
          reasoning_effort, state, display_order, workspace_mode,
          workspace_state, workspace_revision, workspace_recovery_reason,
          created_at, updated_at
        ) VALUES (
          'pane_migration0001',
          (SELECT next_palette_index FROM chat_pane_palette_sequence WHERE singleton = 1),
          'repo_00000000000000000000000001', 'Fixture', 1,
          'Migration fixture', 'ultra', 'ready', 0, 'managed_worktree',
          'preparing', 1, NULL, ?1, ?1
        )
      `).run(timestamp);
      if (laneState === "ready") {
        database.query(`
          UPDATE chat_panes
          SET workspace_state = 'ready', workspace_revision = 2
          WHERE pane_id = 'pane_migration0001'
        `).run();
      }
      const bindingState = laneState === "ready" ? "ready" : "provisioning";
      database.query(`
        INSERT INTO chat_pane_workspace_bindings (
          binding_id, pane_id, repository_id, project_id, expected_lane_id,
          workspace_lease_id, base_sha, branch_name,
          canonical_repository_path, canonical_git_common_dir,
          canonical_checkout_path, recovery_manifest_path, state, revision,
          recovery_reason, created_at, updated_at
        ) VALUES (
          ?1, 'pane_migration0001', 'repo_00000000000000000000000001',
          'project_migration1', ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
          ?10, 1, NULL, ?9, ?9
        )
      `).run(
        chatBindingId,
        laneId,
        baseSha,
        branchName,
        repository,
        repositoryIdentity.canonicalGitCommonDir,
        legacyCheckout,
        legacyManifest,
        timestamp,
        bindingState,
      );
    }
  }
  database.close();

  await rename(legacyRoot, targetRoot);
  const targetCheckout = legacyCheckout.replace(legacyRoot, targetRoot);
  const targetManifest = legacyManifest.replace(legacyRoot, targetRoot);
  database = new Database(join(targetRoot, "control-plane.sqlite"), { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  return {
    database,
    git,
    legacyCheckout,
    legacyManifest,
    legacyRoot,
    repository,
    root,
    targetCheckout,
    targetManifest,
    targetRoot,
  };
}

function options(
  value: RepairFixture,
  onCheckpoint?: (
    point: ApplicationSupportWorktreeRepairFaultPoint,
    lane: string | null,
  ) => void,
) {
  return {
    database: value.database,
    git: value.git,
    legacyRoot: value.legacyRoot,
    targetRoot: value.targetRoot,
    ...(onCheckpoint === undefined ? {} : { onCheckpoint }),
  };
}

function archiveDigest(character: string): string {
  return character.repeat(64);
}

function archiveJournal(value: RepairFixture): ProviderThreadArchiveJournalV57 {
  return new ProviderThreadArchiveJournalV57(value.database, archiveReceiptKey);
}

function configureArchivePane(value: RepairFixture): Readonly<{
  accountProfileRevision: number;
  generation: number;
  paneRevision: number;
}> {
  const account = value.database.query<{
    process_generation: number;
    revision: number;
  }, []>(`
    SELECT process_generation, revision FROM account_profiles
    WHERE profile_id = 'profile_migration01'
  `).get();
  const pane = value.database.query<{ revision: number }, []>(`
    SELECT revision FROM chat_panes WHERE pane_id = 'pane_migration0001'
  `).get();
  if (account === null || pane === null) {
    throw new Error("Archive repair fixture lacks its account or pane");
  }
  const updated = value.database.query(`
    UPDATE chat_panes SET provider_account_profile_id = 'profile_migration01',
      provider_thread_id = ?1, provider_restart_thread_id = ?2
    WHERE pane_id = 'pane_migration0001'
  `).run(archiveThreadId, archiveRestartThreadId);
  if (updated.changes !== 1) {
    throw new Error("Archive repair fixture pane could not be configured");
  }
  return {
    accountProfileRevision: account.revision,
    generation: account.process_generation,
    paneRevision: pane.revision,
  };
}

function seedPreparedArchiveTarget(
  value: RepairFixture,
): ProviderThreadArchiveJournalV57 {
  const authority = configureArchivePane(value);
  const journal = archiveJournal(value);
  journal.prepareTarget({
    targetId: archiveTargetId,
    paneId: "pane_migration0001",
    purpose: "pane_archive",
    paneRevision: authority.paneRevision,
    queueRevision: null,
    paneCasDigest: archiveDigest("1"),
    queueCasDigest: null,
    accountProfileId: "profile_migration01",
    accountProfileRevision: authority.accountProfileRevision,
    threadId: archiveThreadId,
    restartThreadId: archiveRestartThreadId,
    binding: { kind: "none" },
    attempt: {
      attemptId: archiveAttemptId,
      generation: authority.generation,
      accountProfileRevision: authority.accountProfileRevision,
      requestEvidenceDigest: archiveDigest("2"),
      requestRevisionDigest: archiveDigest("3"),
    },
    now: new Date(timestamp),
  });
  return journal;
}

function seedCommittedArchiveTarget(value: RepairFixture): void {
  const journal = seedPreparedArchiveTarget(value);
  journal.markEffectStarted({
    attemptId: archiveAttemptId,
    effectEvidenceDigest: archiveDigest("4"),
    effectRevisionDigest: archiveDigest("5"),
    now: new Date("2026-07-24T12:00:01.000Z"),
  });
  journal.recordDirectApplied({
    attemptId: archiveAttemptId,
    responseGeneration: 1,
    responseStreamPosition: 1,
    outcomeEvidenceDigest: archiveDigest("6"),
    outcomeRevisionDigest: archiveDigest("7"),
    now: new Date("2026-07-24T12:00:02.000Z"),
  });
  journal.markTargetCommitted({
    targetId: archiveTargetId,
    commitEvidenceDigest: archiveDigest("8"),
    commitRevisionDigest: archiveDigest("9"),
    now: new Date("2026-07-24T12:00:03.000Z"),
  });
}

function seedArchiveCut(
  value: RepairFixture,
  includeMember: boolean,
): void {
  const authority = configureArchivePane(value);
  const journal = archiveJournal(value);
  journal.createCut({
    cutId: archiveCutId,
    accountProfileId: "profile_migration01",
    accountProfileRevision: authority.accountProfileRevision,
    sourceGeneration: authority.generation,
    cause: "account_removal",
    initiatingAttemptId: null,
    predecessorCutId: null,
    identityEvidenceDigest: archiveDigest("a"),
    identityRevisionDigest: archiveDigest("b"),
    now: new Date(timestamp),
  });
  journal.recordFence({
    cutId: archiveCutId,
    successorGeneration: null,
    successorAccountProfileRevision: null,
    fenceEvidenceDigest: archiveDigest("c"),
    fenceRevisionDigest: archiveDigest("d"),
    now: new Date("2026-07-24T12:00:01.000Z"),
  });
  if (!includeMember) return;
  journal.addCutMember({
    memberId: archiveMemberId,
    cutId: archiveCutId,
    paneId: "pane_migration0001",
    paneRevision: authority.paneRevision,
    paneCasDigest: archiveDigest("1"),
    threadId: archiveThreadId,
    restartThreadId: archiveRestartThreadId,
    role: "sibling",
    targetId: null,
    attemptId: null,
    targetAttemptOrdinal: null,
    action: "detach_binding_only",
    binding: { kind: "none" },
    identityEvidenceDigest: archiveDigest("e"),
    identityRevisionDigest: archiveDigest("f"),
    now: new Date("2026-07-24T12:00:02.000Z"),
  });
}

async function optionalBytes(path: string): Promise<Buffer | null> {
  try {
    return Buffer.from(await readFile(path));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function repairMutationSnapshot(value: RepairFixture): Promise<Readonly<{
  checkoutTracked: Buffer;
  checkoutUntracked: Buffer;
  database: Buffer;
  gitCalls: readonly { readonly args: readonly string[]; readonly cwd: string }[];
  journal: Buffer | null;
  manifest: Buffer;
}>> {
  return {
    checkoutTracked: Buffer.from(await readFile(join(value.targetCheckout, "tracked.txt"))),
    checkoutUntracked: Buffer.from(await readFile(join(value.targetCheckout, "untracked.txt"))),
    database: Buffer.from(value.database.serialize()),
    gitCalls: value.git.calls.map((call) => ({ cwd: call.cwd, args: [...call.args] })),
    journal: await optionalBytes(join(
      value.targetRoot,
      ".hraness-kitchen-managed-worktree-repair-v1.json",
    )),
    manifest: Buffer.from(await readFile(value.targetManifest)),
  };
}

function archiveAuthorityCounts(value: RepairFixture): Readonly<{
  attempts: number;
  cuts: number;
  members: number;
  targets: number;
}> {
  return value.database.query<{
    attempts: number;
    cuts: number;
    members: number;
    targets: number;
  }, []>(`
    SELECT
      (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
      (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57) AS attempts,
      (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
      (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
  `).get()!;
}

function repairLogicalDatabaseSnapshot(value: RepairFixture): Readonly<{
  chatBindings: readonly unknown[];
  chatPanes: readonly unknown[];
  dispatches: readonly unknown[];
  schema: readonly unknown[];
  threads: readonly unknown[];
  workspaceLeases: readonly unknown[];
}> {
  return {
    schema: value.database.query(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name
    `).all(),
    workspaceLeases: value.database.query(`
      SELECT * FROM workspace_leases ORDER BY lane_id
    `).all(),
    threads: value.database.query(`
      SELECT * FROM thread_bindings ORDER BY thread_id
    `).all(),
    dispatches: value.database.query(`
      SELECT * FROM dispatch_bindings ORDER BY run_id
    `).all(),
    chatPanes: value.database.query(`
      SELECT * FROM chat_panes ORDER BY pane_id
    `).all(),
    chatBindings: value.database.query(`
      SELECT * FROM chat_pane_workspace_bindings ORDER BY binding_id
    `).all(),
  };
}

async function rejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw new Error("Expected a rejected Error");
  }
  throw new Error("Expected the operation to reject");
}

function workspaceRow(value: RepairFixture): {
  readonly canonical_checkout_path: string;
  readonly recovery_manifest_path: string | null;
} {
  return value.database.query<{
    canonical_checkout_path: string;
    recovery_manifest_path: string | null;
  }, []>(`
    SELECT canonical_checkout_path, recovery_manifest_path
    FROM workspace_leases WHERE lane_id = '${laneId}'
  `).get()!;
}

function leaseDispositionRow(value: RepairFixture): {
  readonly quarantine_reason: string | null;
  readonly quarantined_at: string | null;
  readonly status: string;
  readonly updated_at: string;
} {
  return value.database.query<{
    quarantine_reason: string | null;
    quarantined_at: string | null;
    status: string;
    updated_at: string;
  }, []>(`
    SELECT status, updated_at, quarantine_reason, quarantined_at
    FROM workspace_leases WHERE lane_id = '${laneId}'
  `).get()!;
}

function gitRepairCount(git: RealGitRunner): number {
  return git.calls.filter((call) =>
    call.args[0] === "worktree" && call.args[1] === "repair"
  ).length;
}

function chatWorkspaceRow(value: RepairFixture): {
  readonly canonical_checkout_path: string;
  readonly recovery_manifest_path: string;
} {
  return value.database.query<{
    canonical_checkout_path: string;
    recovery_manifest_path: string;
  }, []>(`
    SELECT canonical_checkout_path, recovery_manifest_path
    FROM chat_pane_workspace_bindings WHERE binding_id = '${chatBindingId}'
  `).get()!;
}

function chatWorkspaceRecoveryRow(value: RepairFixture): {
  readonly recovery_reason: string | null;
  readonly revision: number;
  readonly state: string;
  readonly updated_at: string;
} {
  return value.database.query<{
    recovery_reason: string | null;
    revision: number;
    state: string;
    updated_at: string;
  }, []>(`
    SELECT state, revision, recovery_reason, updated_at
    FROM chat_pane_workspace_bindings WHERE binding_id = '${chatBindingId}'
  `).get()!;
}

function chatPaneWorkspaceRow(value: RepairFixture): {
  readonly revision: number;
  readonly updated_at: string;
  readonly workspace_recovery_reason: string | null;
  readonly workspace_revision: number;
  readonly workspace_state: string;
} {
  return value.database.query<{
    revision: number;
    updated_at: string;
    workspace_recovery_reason: string | null;
    workspace_revision: number;
    workspace_state: string;
  }, []>(`
    SELECT revision, updated_at, workspace_state, workspace_revision,
      workspace_recovery_reason
    FROM chat_panes WHERE pane_id = 'pane_migration0001'
  `).get()!;
}

function dispositionRow(value: RepairFixture): {
  readonly archived: number;
  readonly dispatch_updated_at: string;
  readonly failure_code: string | null;
  readonly stage: string;
  readonly thread_updated_at: string;
} {
  return value.database.query<{
    archived: number;
    dispatch_updated_at: string;
    failure_code: string | null;
    stage: string;
    thread_updated_at: string;
  }, []>(`
    SELECT thread_bindings.archived, dispatch_bindings.stage,
      dispatch_bindings.failure_code,
      thread_bindings.updated_at AS thread_updated_at,
      dispatch_bindings.updated_at AS dispatch_updated_at
    FROM thread_bindings
    JOIN dispatch_bindings ON dispatch_bindings.lane_id = thread_bindings.lane_id
    WHERE thread_bindings.lane_id = '${laneId}'
  `).get()!;
}

async function manifestCheckout(path: string): Promise<string> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const checkout = value.canonicalCheckoutPath;
  if (typeof checkout !== "string") throw new Error("Fixture manifest is invalid");
  return checkout;
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(gitBinary === null)("Application Support managed-worktree repair", () => {
  test("treats a pre-foundation v0 database as an empty reversible repair", async () => {
    const value = await fixture(0);
    try {
      const journalCandidate = join(
        value.targetRoot,
        ".hraness-kitchen-managed-worktree-repair-v1.json.tmp",
      );
      await writeFile(journalCandidate, "{\"version\":1", { mode: 0o600 });
      const first = await repairMovedApplicationSupportWorktrees(options(value));
      const retry = await repairMovedApplicationSupportWorktrees(options(value));
      expect(lstat(journalCandidate)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(retry).toEqual(first);
      expect(first).toMatchObject({
        repairedLaneIds: [],
        archivedCodexThreadIds: [],
        ambiguousRunIds: [],
        irreversibleForward: false,
      });
      expect(value.database.query(`
        SELECT name FROM sqlite_schema WHERE name = 'workspace_leases'
      `).get()).toBeNull();
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot)).toMatchObject({
        kind: "complete",
        rollbackSafe: true,
      });
    } finally {
      value.database.close();
    }
  });

  test("allows a complete empty v57 archive schema to repair normally", async () => {
    const value = await fixture();
    try {
      expect(archiveAuthorityCounts(value)).toEqual({
        targets: 0,
        attempts: 0,
        cuts: 0,
        members: 0,
      });
      expect(await repairMovedApplicationSupportWorktrees(options(value))).toMatchObject({
        repairedLaneIds: [laneId],
        irreversibleForward: true,
      });
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("rejects a partial v57 archive schema before repair mutation", async () => {
    const value = await fixture();
    try {
      value.database.exec("DROP TABLE chat_provider_thread_archive_cut_members_v57");
      const before = await repairMutationSnapshot(value);
      const databaseBefore = repairLogicalDatabaseSnapshot(value);
      const error = await rejection(
        repairMovedApplicationSupportWorktrees(options(value)),
      );
      expect(error).toMatchObject({ code: "invalid_database", rollbackSafe: true });
      expect(error.message).toContain("partial v57 schema");
      const after = await repairMutationSnapshot(value);
      expect(repairLogicalDatabaseSnapshot(value)).toEqual(databaseBefore);
      expect(after.journal).toEqual(before.journal);
      expect(after.manifest).toEqual(before.manifest);
      expect(after.checkoutTracked).toEqual(before.checkoutTracked);
      expect(after.checkoutUntracked).toEqual(before.checkoutUntracked);
      expect(after.gitCalls).toEqual(before.gitCalls);
    } finally {
      value.database.close();
    }
  });

  test("preserves an open v57 target before the first forward repair write", async () => {
    const value = await fixture();
    try {
      seedPreparedArchiveTarget(value);
      expect(archiveAuthorityCounts(value)).toEqual({
        targets: 1,
        attempts: 1,
        cuts: 0,
        members: 0,
      });
      const before = await repairMutationSnapshot(value);
      const error = await rejection(
        repairMovedApplicationSupportWorktrees(options(value)),
      );
      expect(error).toMatchObject({ code: "invalid_database", rollbackSafe: true });
      expect(error.message).toContain("reconcile exactly");
      expect(await repairMutationSnapshot(value)).toEqual(before);
    } finally {
      value.database.close();
    }
  });

  test("preserves a committed v57 target on a prepared forward retry", async () => {
    const value = await fixture();
    try {
      await rejection(repairMovedApplicationSupportWorktrees(options(
        value,
        (point) => {
          if (point === "afterPreparedJournal") throw new Error("prepared-cut");
        },
      )));
      seedCommittedArchiveTarget(value);
      expect(archiveAuthorityCounts(value)).toEqual({
        targets: 1,
        attempts: 1,
        cuts: 0,
        members: 0,
      });
      const before = await repairMutationSnapshot(value);
      const error = await rejection(
        repairMovedApplicationSupportWorktrees(options(value)),
      );
      expect(error).toMatchObject({ code: "invalid_database", rollbackSafe: true });
      expect(error.message).toContain("reconcile exactly");
      expect(await repairMutationSnapshot(value)).toEqual(before);
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot))
        .toMatchObject({ kind: "prepared", rollbackSafe: true });
    } finally {
      value.database.close();
    }
  });

  test("preserves cut-only v57 removal authority before forward repair", async () => {
    const value = await fixture();
    try {
      seedArchiveCut(value, false);
      expect(archiveAuthorityCounts(value)).toEqual({
        targets: 0,
        attempts: 0,
        cuts: 1,
        members: 0,
      });
      const before = await repairMutationSnapshot(value);
      const error = await rejection(
        repairMovedApplicationSupportWorktrees(options(value)),
      );
      expect(error).toMatchObject({ code: "invalid_database", rollbackSafe: true });
      expect(error.message).toContain("reconcile exactly");
      expect(await repairMutationSnapshot(value)).toEqual(before);
    } finally {
      value.database.close();
    }
  });

  test("preserves v57 cut-member authority before prepared-journal reversal", async () => {
    const value = await fixture();
    try {
      await rejection(repairMovedApplicationSupportWorktrees(options(
        value,
        (point) => {
          if (point === "afterPreparedJournal") throw new Error("prepared-cut");
        },
      )));
      seedArchiveCut(value, true);
      expect(archiveAuthorityCounts(value)).toEqual({
        targets: 0,
        attempts: 0,
        cuts: 1,
        members: 1,
      });
      const before = await repairMutationSnapshot(value);
      const error = await rejection(
        reverseMovedApplicationSupportWorktreeRepair(options(value)),
      );
      expect(error).toMatchObject({ code: "invalid_database", rollbackSafe: true });
      expect(error.message).toContain("reconcile exactly");
      expect(await repairMutationSnapshot(value)).toEqual(before);
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot))
        .toMatchObject({ kind: "prepared", rollbackSafe: true });
    } finally {
      value.database.close();
    }
  });

  test("catches v57 authority injected between entry and forward DB apply", async () => {
    const value = await fixture();
    try {
      const before = await repairMutationSnapshot(value);
      const gitBefore = await requireGit(value.git, value.repository, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      let injected = false;
      let databaseAfterInjection: Buffer | null = null;
      const error = await rejection(repairMovedApplicationSupportWorktrees(options(
        value,
        (point) => {
          if (point !== "afterPreparedJournal") return;
          injected = true;
          seedPreparedArchiveTarget(value);
          databaseAfterInjection = Buffer.from(value.database.serialize());
        },
      )));
      expect(injected).toBeTrue();
      expect(error).toMatchObject({ code: "invalid_database", rollbackSafe: true });
      expect(error.message).toContain("reconcile exactly");
      expect(databaseAfterInjection).not.toBeNull();
      const after = await repairMutationSnapshot(value);
      expect(after.database).toEqual(databaseAfterInjection!);
      expect(after.manifest).toEqual(before.manifest);
      expect(after.checkoutTracked).toEqual(before.checkoutTracked);
      expect(after.checkoutUntracked).toEqual(before.checkoutUntracked);
      expect(await requireGit(value.git, value.repository, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ])).toBe(gitBefore);
      expect(gitRepairCount(value.git)).toBe(0);
      expect(before.journal).toBeNull();
      expect(after.journal).not.toBeNull();
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot))
        .toMatchObject({ kind: "prepared", rollbackSafe: true });
    } finally {
      value.database.close();
    }
  });

  test("catches v57 authority injected before reverse manifests or DB apply", async () => {
    const value = await fixture();
    try {
      await rejection(repairMovedApplicationSupportWorktrees(options(
        value,
        (point) => {
          if (point === "afterPreparedJournal") throw new Error("prepared-cut");
        },
      )));
      const before = await repairMutationSnapshot(value);
      let injected = false;
      let databaseAfterInjection: Buffer | null = null;
      const error = await rejection(reverseMovedApplicationSupportWorktreeRepair(options(
        value,
        (point) => {
          if (point !== "afterReversePreparedJournal") return;
          injected = true;
          seedArchiveCut(value, false);
          databaseAfterInjection = Buffer.from(value.database.serialize());
        },
      )));
      expect(injected).toBeTrue();
      expect(error).toMatchObject({ code: "invalid_database", rollbackSafe: true });
      expect(error.message).toContain("reconcile exactly");
      expect(databaseAfterInjection).not.toBeNull();
      const after = await repairMutationSnapshot(value);
      expect(after.database).toEqual(databaseAfterInjection!);
      expect(after.manifest).toEqual(before.manifest);
      expect(after.checkoutTracked).toEqual(before.checkoutTracked);
      expect(after.checkoutUntracked).toEqual(before.checkoutUntracked);
      expect(after.gitCalls).toEqual(before.gitCalls);
      expect(after.journal).not.toEqual(before.journal);
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot))
        .toMatchObject({ kind: "reversing", rollbackSafe: true });
    } finally {
      value.database.close();
    }
  });

  test("rejects an unsupported migration history before DB, manifest, or Git mutation", async () => {
    const value = await fixture();
    try {
      const rowBefore = workspaceRow(value);
      const chatRowBefore = chatWorkspaceRow(value);
      const manifestBefore = await readFile(value.targetManifest, "utf8");
      const gitBefore = await requireGit(value.git, value.repository, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      value.database.query(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?1, 'future-schema', ?2, ?3)
      `).run(futureMigrationVersion, "a".repeat(64), timestamp);

      const error = await rejection(
        repairMovedApplicationSupportWorktrees(options(value)),
      );
      expect(error).toBeInstanceOf(ApplicationSupportWorktreeRepairError);
      expect(error).toMatchObject({
        code: "invalid_database",
        rollbackSafe: true,
      });
      expect(workspaceRow(value)).toEqual(rowBefore);
      expect(chatWorkspaceRow(value)).toEqual(chatRowBefore);
      expect(await readFile(value.targetManifest, "utf8")).toBe(manifestBefore);
      expect(
        await requireGit(value.git, value.repository, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]),
      ).toBe(gitBefore);
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot)).toMatchObject({
        kind: "absent",
        rollbackSafe: true,
      });
      expect(
        value.database.query<{ count: number }, []>(
          "SELECT count(*) AS count FROM schema_migrations",
        ).get(),
      ).toEqual({ count: migrations.length + 1 });
    } finally {
      value.database.close();
    }
  });

  for (const migrationPrefix of [1, 3] as const) {
    test(`repairs and retries a real v${String(migrationPrefix)} schema prefix without dispatch tables`, async () => {
      const value = await fixture(migrationPrefix);
      try {
        const first = await repairMovedApplicationSupportWorktrees(options(value));
        const retry = await repairMovedApplicationSupportWorktrees(options(value));
        expect(retry).toEqual(first);
        expect(first).toMatchObject({
          repairedLaneIds: [laneId],
          archivedCodexThreadIds: ["codex-thread-migration-1"],
          ambiguousRunIds: [],
          irreversibleForward: true,
        });
        expect(workspaceRow(value)).toEqual({
          canonical_checkout_path: value.targetCheckout,
          recovery_manifest_path: value.targetManifest,
        });
        expect(value.database.query(`
          SELECT name FROM sqlite_schema WHERE name = 'dispatch_bindings'
        `).get()).toBeNull();
        const thread = value.database.query<{
          archived: number;
          updated_at: string;
        }, []>(`
          SELECT archived, updated_at FROM thread_bindings
          WHERE lane_id = '${laneId}'
        `).get();
        expect(thread?.archived).toBe(1);
        expect(new Date(thread!.updated_at).toISOString()).toBe(thread!.updated_at);
        expect(await requireGit(value.git, value.targetCheckout, [
          "rev-parse",
          "--show-toplevel",
        ])).toBe(value.targetCheckout);
      } finally {
        value.database.close();
      }
    }, 30_000);
  }

  test("fails closed on a partial persisted control-plane object set", async () => {
    const value = await fixture(0);
    try {
      value.database.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY,
          canonical_repository_path TEXT NOT NULL,
          canonical_git_common_dir TEXT NOT NULL
        ) STRICT
      `);
      expect(await rejection(repairMovedApplicationSupportWorktrees(options(value))))
        .toMatchObject({ code: "invalid_database", rollbackSafe: true });
    } finally {
      value.database.close();
    }
  });

  for (const laneState of [
    "databaseOnly",
    "manifestOnly",
    "linkedProvisioning",
  ] as const) {
    test(`repairs and quarantines a ${laneState} provisioning crash without guessing at Git`, async () => {
      const value = await fixture("current", laneState);
      try {
        const first = await repairMovedApplicationSupportWorktrees(options(value));
        const retry = await repairMovedApplicationSupportWorktrees(options(value));
        expect(retry).toEqual(first);
        expect(first).toMatchObject({
          repairedLaneIds: [laneId],
          archivedCodexThreadIds: ["codex-thread-migration-1"],
          ambiguousRunIds: [laneId],
          irreversibleForward: laneState === "linkedProvisioning",
        });
        expect(workspaceRow(value)).toEqual({
          canonical_checkout_path: value.targetCheckout,
          recovery_manifest_path: value.targetManifest,
        });
        const lease = value.database.query<{
          status: string;
          updated_at: string;
        }, []>(`
          SELECT status, updated_at FROM workspace_leases
          WHERE lane_id = '${laneId}'
        `).get();
        expect(lease?.status).toBe("preserved");
        expect(new Date(lease!.updated_at).toISOString()).toBe(lease!.updated_at);
        expect(dispositionRow(value)).toMatchObject({
          archived: 1,
          stage: "ambiguous",
          failure_code: "application_support_root_moved",
        });

        if (laneState === "databaseOnly") {
          expect(await pathExists(value.targetManifest)).toBeFalse();
          expect(await pathExists(value.targetCheckout)).toBeFalse();
        } else {
          expect(await manifestCheckout(value.targetManifest)).toBe(value.targetCheckout);
        }
        const listing = await requireGit(value.git, value.repository, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        if (laneState === "linkedProvisioning") {
          expect(listing).toContain(`worktree ${value.targetCheckout}`);
          expect(await requireGit(value.git, value.targetCheckout, [
            "rev-parse",
            "--show-toplevel",
          ])).toBe(value.targetCheckout);
        } else {
          expect(listing).not.toContain(value.targetCheckout);
          expect(listing).not.toContain(value.legacyCheckout);
        }
      } finally {
        value.database.close();
      }
    }, 30_000);

    test(`reverses a ${laneState} provisioning crash before the Git marker`, async () => {
      const value = await fixture("current", laneState);
      try {
        const forwardError = await rejection(repairMovedApplicationSupportWorktrees(options(
          value,
          (point) => {
            if (point === "afterManifestsRewrittenJournal") {
              throw new Error(`stop:${laneState}`);
            }
          },
        )));
        expect(forwardError).toMatchObject({ rollbackSafe: true });
        expect(await reverseMovedApplicationSupportWorktreeRepair(options(value))).toMatchObject({
          kind: "reversed",
          rollbackSafe: true,
        });
        expect(workspaceRow(value)).toEqual({
          canonical_checkout_path: value.legacyCheckout,
          recovery_manifest_path: value.legacyManifest,
        });
        const lease = value.database.query<{ status: string; updated_at: string }, []>(`
          SELECT status, updated_at FROM workspace_leases
          WHERE lane_id = '${laneId}'
        `).get();
        expect(lease).toEqual({ status: "provisioning", updated_at: timestamp });
        expect(dispositionRow(value)).toEqual({
          archived: 0,
          stage: "running",
          failure_code: null,
          thread_updated_at: timestamp,
          dispatch_updated_at: timestamp,
        });
        if (laneState !== "databaseOnly") {
          expect(await manifestCheckout(value.targetManifest)).toBe(value.legacyCheckout);
        }
      } finally {
        value.database.close();
      }
    }, 30_000);
  }

  test("moves interrupted chat provisioning into exact recoverable startup state", async () => {
    const value = await fixture("current", "linkedChatProvisioning");
    try {
      const first = await repairMovedApplicationSupportWorktrees(options(value));
      const recoveryLease = leaseDispositionRow(value);
      const recoveryBinding = chatWorkspaceRecoveryRow(value);
      const recoveryPane = chatPaneWorkspaceRow(value);
      const retry = await repairMovedApplicationSupportWorktrees(options(value));

      expect(retry).toEqual(first);
      expect(first.irreversibleForward).toBeTrue();
      expect(recoveryLease).toEqual({
        status: "quarantined",
        updated_at: recoveryLease.updated_at,
        quarantine_reason: "provision_interrupted",
        quarantined_at: recoveryLease.updated_at,
      });
      expect(new Date(recoveryLease.updated_at).toISOString())
        .toBe(recoveryLease.updated_at);
      expect(recoveryBinding).toEqual({
        state: "recovery_required",
        revision: 2,
        recovery_reason: "provision_interrupted",
        updated_at: recoveryLease.updated_at,
      });
      expect(recoveryPane).toEqual({
        revision: 2,
        updated_at: recoveryLease.updated_at,
        workspace_state: "recovery_required",
        workspace_revision: 2,
        workspace_recovery_reason: "provision_interrupted",
      });
      expect(chatWorkspaceRow(value)).toEqual({
        canonical_checkout_path: value.targetCheckout,
        recovery_manifest_path: value.targetManifest,
      });
      expect(await manifestCheckout(value.targetManifest)).toBe(value.targetCheckout);

      const retryAt = new Date("2026-07-24T13:00:00.000Z");
      const panes = new ChatPaneStore(value.database);
      const recovering = panes.require("pane_migration0001").projection;
      expect(recovering.workspace).toMatchObject({
        state: "recoveryRequired",
        recoveryKind: "provisionInterrupted",
      });
      const preparing = panes.recoverWorkspace(
        "pane_migration0001",
        recovering.revision,
        retryAt,
      );
      expect(preparing.workspace).toMatchObject({
        state: "preparing",
        recoveryKind: null,
      });
      expect(leaseDispositionRow(value)).toEqual({
        status: "provisioning",
        updated_at: retryAt.toISOString(),
        quarantine_reason: null,
        quarantined_at: null,
      });
      expect(chatWorkspaceRecoveryRow(value)).toEqual({
        state: "provisioning",
        revision: 3,
        recovery_reason: null,
        updated_at: retryAt.toISOString(),
      });
      expect(chatPaneWorkspaceRow(value)).toEqual({
        revision: 3,
        updated_at: retryAt.toISOString(),
        workspace_state: "preparing",
        workspace_revision: 3,
        workspace_recovery_reason: null,
      });
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("rolls interrupted chat recovery back as one coherent pre-Git state", async () => {
    const value = await fixture("current", "linkedChatProvisioning");
    try {
      const failure = await rejection(repairMovedApplicationSupportWorktrees(options(
        value,
        (point) => {
          if (point === "afterDatabaseRewrite") throw new Error("stop-chat-recovery");
        },
      )));
      expect(failure).toMatchObject({ rollbackSafe: true });
      const recoveryAt = leaseDispositionRow(value).updated_at;
      expect(await reverseMovedApplicationSupportWorktreeRepair(options(value))).toMatchObject({
        kind: "reversed",
        rollbackSafe: true,
      });
      expect(workspaceRow(value)).toEqual({
        canonical_checkout_path: value.legacyCheckout,
        recovery_manifest_path: value.legacyManifest,
      });
      expect(leaseDispositionRow(value)).toEqual({
        status: "provisioning",
        updated_at: timestamp,
        quarantine_reason: null,
        quarantined_at: null,
      });
      expect(chatWorkspaceRecoveryRow(value)).toEqual({
        state: "provisioning",
        revision: 3,
        recovery_reason: null,
        updated_at: recoveryAt,
      });
      expect(chatPaneWorkspaceRow(value)).toEqual({
        revision: 3,
        updated_at: recoveryAt,
        workspace_state: "preparing",
        workspace_revision: 3,
        workspace_recovery_reason: null,
      });
      expect(await manifestCheckout(value.targetManifest)).toBe(value.legacyCheckout);

      expect(await repairMovedApplicationSupportWorktrees(options(value))).toMatchObject({
        repairedLaneIds: [laneId],
      });
      expect(chatWorkspaceRecoveryRow(value)).toEqual({
        state: "recovery_required",
        revision: 4,
        recovery_reason: "provision_interrupted",
        updated_at: recoveryAt,
      });
      expect(chatPaneWorkspaceRow(value)).toEqual({
        revision: 4,
        updated_at: recoveryAt,
        workspace_state: "recovery_required",
        workspace_revision: 4,
        workspace_recovery_reason: "provision_interrupted",
      });
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("repairs a preexisting quarantined partial lease without invoking Git", async () => {
    const value = await fixture("current", "databaseOnly", "quarantined");
    try {
      const gitCallsBefore = value.git.calls.length;
      const first = await repairMovedApplicationSupportWorktrees(options(value));
      const retry = await repairMovedApplicationSupportWorktrees(options(value));

      expect(retry).toEqual(first);
      expect(first).toMatchObject({
        repairedLaneIds: [laneId],
        archivedCodexThreadIds: ["codex-thread-migration-1"],
        ambiguousRunIds: [laneId],
        irreversibleForward: false,
      });
      expect(workspaceRow(value)).toEqual({
        canonical_checkout_path: value.targetCheckout,
        recovery_manifest_path: value.targetManifest,
      });
      expect(leaseDispositionRow(value)).toEqual({
        status: "quarantined",
        updated_at: timestamp,
        quarantine_reason: "provision_interrupted",
        quarantined_at: timestamp,
      });
      expect(await pathExists(value.targetCheckout)).toBeFalse();
      expect(await pathExists(value.targetManifest)).toBeFalse();
      expect(value.git.calls).toHaveLength(gitCallsBefore);
      expect(gitRepairCount(value.git)).toBe(0);
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot)).toMatchObject({
        kind: "complete",
        rollbackSafe: true,
      });
    } finally {
      value.database.close();
    }
  });

  test("repairs a preexisting preserved linked lease exactly once", async () => {
    const value = await fixture("current", "ready", "preserved");
    try {
      const repairsBefore = gitRepairCount(value.git);
      const first = await repairMovedApplicationSupportWorktrees(options(value));
      const repairsAfterFirst = gitRepairCount(value.git);
      const retry = await repairMovedApplicationSupportWorktrees(options(value));

      expect(retry).toEqual(first);
      expect(first).toMatchObject({
        repairedLaneIds: [laneId],
        archivedCodexThreadIds: ["codex-thread-migration-1"],
        ambiguousRunIds: [laneId],
        irreversibleForward: true,
      });
      expect(repairsAfterFirst).toBe(repairsBefore + 1);
      expect(gitRepairCount(value.git)).toBe(repairsAfterFirst);
      expect(workspaceRow(value)).toEqual({
        canonical_checkout_path: value.targetCheckout,
        recovery_manifest_path: value.targetManifest,
      });
      expect(leaseDispositionRow(value)).toEqual({
        status: "preserved",
        updated_at: timestamp,
        quarantine_reason: null,
        quarantined_at: null,
      });
      expect(await manifestCheckout(value.targetManifest)).toBe(value.targetCheckout);
      expect(await requireGit(value.git, value.targetCheckout, [
        "rev-parse",
        "--show-toplevel",
      ])).toBe(value.targetCheckout);
      expect(await readFile(join(value.targetCheckout, "tracked.txt"), "utf8"))
        .toBe("dirty tracked\n");
      expect(await readFile(join(value.targetCheckout, "untracked.txt"), "utf8"))
        .toBe("dirty untracked\n");
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("repairs a preexisting preserved partial lease without invoking Git", async () => {
    const value = await fixture("current", "manifestOnly", "preserved");
    try {
      const gitCallsBefore = value.git.calls.length;
      const first = await repairMovedApplicationSupportWorktrees(options(value));
      const retry = await repairMovedApplicationSupportWorktrees(options(value));

      expect(retry).toEqual(first);
      expect(first.irreversibleForward).toBeFalse();
      expect(workspaceRow(value)).toEqual({
        canonical_checkout_path: value.targetCheckout,
        recovery_manifest_path: value.targetManifest,
      });
      expect(leaseDispositionRow(value)).toEqual({
        status: "preserved",
        updated_at: timestamp,
        quarantine_reason: null,
        quarantined_at: null,
      });
      expect(await pathExists(value.targetCheckout)).toBeFalse();
      expect(await manifestCheckout(value.targetManifest)).toBe(value.targetCheckout);
      expect(value.git.calls).toHaveLength(gitCallsBefore);
      expect(gitRepairCount(value.git)).toBe(0);
    } finally {
      value.database.close();
    }
  });

  test("repairs a preexisting quarantined linked lease exactly once", async () => {
    const value = await fixture("current", "ready", "quarantined");
    try {
      const repairsBefore = gitRepairCount(value.git);
      const first = await repairMovedApplicationSupportWorktrees(options(value));
      const repairsAfterFirst = gitRepairCount(value.git);
      const retry = await repairMovedApplicationSupportWorktrees(options(value));

      expect(retry).toEqual(first);
      expect(first.irreversibleForward).toBeTrue();
      expect(repairsAfterFirst).toBe(repairsBefore + 1);
      expect(gitRepairCount(value.git)).toBe(repairsAfterFirst);
      expect(workspaceRow(value)).toEqual({
        canonical_checkout_path: value.targetCheckout,
        recovery_manifest_path: value.targetManifest,
      });
      expect(leaseDispositionRow(value)).toEqual({
        status: "quarantined",
        updated_at: timestamp,
        quarantine_reason: "provision_interrupted",
        quarantined_at: timestamp,
      });
      expect(await manifestCheckout(value.targetManifest)).toBe(value.targetCheckout);
      expect(await requireGit(value.git, value.targetCheckout, [
        "rev-parse",
        "--show-toplevel",
      ])).toBe(value.targetCheckout);
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("rejects an unknown lease status before journal or Git mutation", async () => {
    const value = await fixture("current", "databaseOnly");
    try {
      value.database.query(`
        UPDATE workspace_leases SET status = 'retired_unknown' WHERE lane_id = ?1
      `).run(laneId);
      const leaseBefore = workspaceRow(value);
      const gitCallsBefore = value.git.calls.length;

      expect(await rejection(repairMovedApplicationSupportWorktrees(options(value))))
        .toMatchObject({ code: "invalid_database", rollbackSafe: true });
      expect(workspaceRow(value)).toEqual(leaseBefore);
      expect(value.git.calls).toHaveLength(gitCallsBefore);
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot)).toMatchObject({
        kind: "absent",
        rollbackSafe: true,
      });
    } finally {
      value.database.close();
    }
  });

  test("preserves a DB-only provisioning lease with null optional identity", async () => {
    const value = await fixture("current", "databaseOnly");
    try {
      value.database.query(`
        UPDATE workspace_leases
        SET branch_name = NULL, recovery_manifest_path = NULL
        WHERE lane_id = ?1
      `).run(laneId);
      const repaired = await repairMovedApplicationSupportWorktrees(options(value));
      expect(repaired).toMatchObject({
        repairedLaneIds: [laneId],
        irreversibleForward: false,
      });
      expect(workspaceRow(value)).toEqual({
        canonical_checkout_path: value.targetCheckout,
        recovery_manifest_path: null,
      });
    } finally {
      value.database.close();
    }
  });

  test("repairs SQLite, manifests, linked-worktree metadata, and moved Codex cwd authority", async () => {
    const value = await fixture();
    try {
      const first = await repairMovedApplicationSupportWorktrees(options(value));
      const replay = await repairMovedApplicationSupportWorktrees(options(value));

      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        repairedLaneIds: [laneId],
        archivedCodexThreadIds: ["codex-thread-migration-1"],
        ambiguousRunIds: [laneId],
        codexCwdPolicy: "archive_threads_and_quarantine_nonterminal_runs",
        irreversibleForward: true,
      });
      expect(workspaceRow(value)).toEqual({
        canonical_checkout_path: value.targetCheckout,
        recovery_manifest_path: value.targetManifest,
      });
      expect(chatWorkspaceRow(value)).toEqual({
        canonical_checkout_path: value.targetCheckout,
        recovery_manifest_path: value.targetManifest,
      });
      expect(await manifestCheckout(value.targetManifest)).toBe(value.targetCheckout);
      expect(dispositionRow(value)).toMatchObject({
        archived: 1,
        stage: "ambiguous",
        failure_code: "application_support_root_moved",
      });
      expect(new Date(dispositionRow(value).thread_updated_at).toISOString())
        .toBe(dispositionRow(value).thread_updated_at);
      expect(new Date(dispositionRow(value).dispatch_updated_at).toISOString())
        .toBe(dispositionRow(value).dispatch_updated_at);
      expect(await requireGit(value.git, value.targetCheckout, [
        "rev-parse",
        "--show-toplevel",
      ])).toBe(value.targetCheckout);
      expect(await requireGit(value.git, value.targetCheckout, [
        "branch",
        "--show-current",
      ])).toBe(`codex/oprte-${laneId}`);
      const status = await requireGit(value.git, value.targetCheckout, [
        "status",
        "--porcelain=v1",
        "-z",
      ]);
      expect(status).toContain("M tracked.txt");
      expect(status).toContain("?? untracked.txt");
      expect(await readFile(join(value.targetCheckout, "tracked.txt"), "utf8"))
        .toBe("dirty tracked\n");
      expect(await readFile(join(value.targetCheckout, "untracked.txt"), "utf8"))
        .toBe("dirty untracked\n");

      const listing = await requireGit(value.git, value.repository, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      expect(listing).toContain(`worktree ${value.targetCheckout}`);
      expect(listing).not.toContain(`worktree ${value.legacyCheckout}`);
      const prune = await value.git.run(value.repository, [
        "worktree",
        "prune",
        "--dry-run",
        "--verbose",
        "--expire",
        "now",
      ]);
      expect(`${prune.stdout}\n${prune.stderr}`).not.toContain(value.targetCheckout);
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("reverses safely before Git repair and remains idempotent across a restart", async () => {
    const value = await fixture();
    try {
      const forwardError = await rejection(repairMovedApplicationSupportWorktrees(options(
        value,
        (point) => {
          if (point === "afterManifestsRewrittenJournal") throw new Error("injected");
        },
      )));
      expect(forwardError).toMatchObject({ rollbackSafe: true });

      expect(await reverseMovedApplicationSupportWorktreeRepair(options(value))).toMatchObject({
        kind: "reversed",
        rollbackSafe: true,
      });
      expect(await reverseMovedApplicationSupportWorktreeRepair(options(value))).toMatchObject({
        kind: "reversed",
        rollbackSafe: true,
      });
      expect(workspaceRow(value)).toEqual({
        canonical_checkout_path: value.legacyCheckout,
        recovery_manifest_path: value.legacyManifest,
      });
      expect(chatWorkspaceRow(value)).toEqual({
        canonical_checkout_path: value.legacyCheckout,
        recovery_manifest_path: value.legacyManifest,
      });
      expect(await manifestCheckout(value.targetManifest)).toBe(value.legacyCheckout);
      expect(dispositionRow(value)).toEqual({
        archived: 0,
        stage: "running",
        failure_code: null,
        thread_updated_at: timestamp,
        dispatch_updated_at: timestamp,
      });

      value.database.close();
      await rename(value.targetRoot, value.legacyRoot);
      expect(await requireGit(value.git, value.legacyCheckout, [
        "rev-parse",
        "--show-toplevel",
      ])).toBe(value.legacyCheckout);
      const status = await requireGit(value.git, value.legacyCheckout, [
        "status",
        "--porcelain=v1",
      ]);
      expect(status).toContain("M tracked.txt");
      expect(status).toContain("?? untracked.txt");
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("forces forward recovery after the durable irreversible marker", async () => {
    const value = await fixture();
    try {
      const forwardError = await rejection(repairMovedApplicationSupportWorktrees(options(
        value,
        (point) => {
          if (point === "afterIrreversibleForwardJournal") throw new Error("injected");
        },
      )));
      expect(forwardError).toMatchObject({ rollbackSafe: false });
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot)).toMatchObject({
        kind: "irreversibleForward",
        rollbackSafe: false,
      });
      const reverseError = await rejection(
        reverseMovedApplicationSupportWorktreeRepair(options(value)),
      );
      expect(reverseError).toBeInstanceOf(ApplicationSupportWorktreeRepairError);
      expect(reverseError).toMatchObject({
        code: "rollback_requires_forward_completion",
        rollbackSafe: false,
      });
      expect(await repairMovedApplicationSupportWorktrees(options(value)))
        .toMatchObject({ repairedLaneIds: [laneId] });
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("uses the completed receipt without requiring the external repository", async () => {
    const value = await fixture();
    try {
      const completed = await repairMovedApplicationSupportWorktrees(options(value));
      await rename(value.repository, `${value.repository}-temporarily-unavailable`);
      expect(await repairMovedApplicationSupportWorktrees(options(value))).toEqual(completed);
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot)).toMatchObject({
        kind: "complete",
        rollbackSafe: false,
      });
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("retries forward deterministically from every durable checkpoint", async () => {
    const points: readonly ApplicationSupportWorktreeRepairFaultPoint[] = [
      "afterPreparedJournal",
      "afterDatabaseRewrite",
      "afterManifestRewrite",
      "afterManifestsRewrittenJournal",
      "afterIrreversibleForwardJournal",
      "afterGitRepair",
      "afterGitRepairedJournal",
      "afterGitVerification",
      "afterVerifiedJournal",
      "afterCompletedJournal",
    ];
    for (const faultPoint of points) {
      const value = await fixture();
      let injected = false;
      try {
        const forwardError = await rejection(repairMovedApplicationSupportWorktrees(options(
          value,
          (point) => {
            if (!injected && point === faultPoint) {
              injected = true;
              throw new Error(`fault:${point}`);
            }
          },
        )));
        expect(forwardError.message).toContain(`fault:${faultPoint}`);
        expect(injected).toBeTrue();
        expect(await repairMovedApplicationSupportWorktrees(options(value)))
          .toMatchObject({ repairedLaneIds: [laneId] });
        expect(workspaceRow(value).canonical_checkout_path).toBe(value.targetCheckout);
        expect(chatWorkspaceRow(value)).toEqual({
          canonical_checkout_path: value.targetCheckout,
          recovery_manifest_path: value.targetManifest,
        });
        expect(await manifestCheckout(value.targetManifest)).toBe(value.targetCheckout);
        expect(await requireGit(value.git, value.targetCheckout, [
          "rev-parse",
          "--show-toplevel",
        ])).toBe(value.targetCheckout);
      } finally {
        value.database.close();
      }
    }
  }, 120_000);

  test("retries reverse deterministically from every reverse checkpoint", async () => {
    const points: readonly ApplicationSupportWorktreeRepairFaultPoint[] = [
      "afterReversePreparedJournal",
      "afterReverseManifestRewrite",
      "afterReverseDatabaseRewrite",
      "afterReversedJournal",
    ];
    for (const faultPoint of points) {
      const value = await fixture();
      try {
        await rejection(repairMovedApplicationSupportWorktrees(options(
          value,
          (point) => {
            if (point === "afterManifestsRewrittenJournal") throw new Error("stop-forward");
          },
        )));
        let injected = false;
        const reverseError = await rejection(reverseMovedApplicationSupportWorktreeRepair(options(
          value,
          (point) => {
            if (!injected && point === faultPoint) {
              injected = true;
              throw new Error(`fault:${point}`);
            }
          },
        )));
        expect(reverseError.message).toContain(`fault:${faultPoint}`);
        expect(injected).toBeTrue();
        expect(await reverseMovedApplicationSupportWorktreeRepair(options(value)))
          .toMatchObject({ kind: "reversed", rollbackSafe: true });
        expect(workspaceRow(value).canonical_checkout_path).toBe(value.legacyCheckout);
        expect(chatWorkspaceRow(value)).toEqual({
          canonical_checkout_path: value.legacyCheckout,
          recovery_manifest_path: value.legacyManifest,
        });
        expect(await manifestCheckout(value.targetManifest)).toBe(value.legacyCheckout);
      } finally {
        value.database.close();
      }
    }
  }, 60_000);

  test("treats uncertain legacy Git metadata as unsafe to roll back", async () => {
    const value = await fixture();
    try {
      await rejection(repairMovedApplicationSupportWorktrees(options(
        value,
        (point) => {
          if (point === "afterManifestsRewrittenJournal") throw new Error("stop-forward");
        },
      )));
      const unavailableGit: GitRunner = {
        run: () => Promise.resolve({
          exitCode: 1,
          stderr: "injected Git failure",
          stdout: "",
        }),
      };
      const reverseError = await rejection(reverseMovedApplicationSupportWorktreeRepair({
        ...options(value),
        git: unavailableGit,
      }));
      expect(reverseError).toMatchObject({
        code: "git_verification_failed",
        rollbackSafe: false,
      });
      expect(await reverseMovedApplicationSupportWorktreeRepair(options(value))).toMatchObject({
        kind: "reversed",
        rollbackSafe: true,
      });
    } finally {
      value.database.close();
    }
  }, 30_000);

  test("fails closed when a lease path is outside the moved root", async () => {
    const value = await fixture();
    try {
      value.database.query(`
        UPDATE workspace_leases SET canonical_checkout_path = ?2 WHERE lane_id = ?1
      `).run(laneId, join(value.root, "foreign-lane"));
      expect(await rejection(repairMovedApplicationSupportWorktrees(options(value))))
        .toMatchObject({ code: "conflicting_paths", rollbackSafe: true });
    } finally {
      value.database.close();
    }
  });

  test("fails closed before mutation when a chat binding disagrees with its lease", async () => {
    const value = await fixture();
    try {
      const leaseBefore = workspaceRow(value);
      const manifestBefore = await readFile(value.targetManifest, "utf8");
      value.database.query(`
        UPDATE chat_pane_workspace_bindings
        SET canonical_checkout_path = ?2 WHERE binding_id = ?1
      `).run(chatBindingId, join(value.root, "foreign-chat-lane"));

      expect(await rejection(repairMovedApplicationSupportWorktrees(options(value))))
        .toMatchObject({ code: "conflicting_paths", rollbackSafe: true });
      expect(workspaceRow(value)).toEqual(leaseBefore);
      expect(await readFile(value.targetManifest, "utf8")).toBe(manifestBefore);
      expect(await inspectApplicationSupportWorktreeRepair(value.targetRoot))
        .toMatchObject({ kind: "absent", rollbackSafe: true });
    } finally {
      value.database.close();
    }
  });
});
