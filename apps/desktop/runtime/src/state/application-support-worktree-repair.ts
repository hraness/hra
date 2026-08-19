import type { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "@hra-internal/schema";
import { validateAppliedMigrationPrefix } from "./database";

import type { GitResult, GitRunner } from "../workspaces/git-runner";
import { GitCommandError } from "../workspaces/git-runner";

const journalName = ".hraness-kitchen-managed-worktree-repair-v1.json";
const maximumJournalBytes = 4 * 1024 * 1024;
const maximumManifestBytes = 16 * 1024;
const maximumLanes = 256;
const maximumBindings = 4_096;
const commitPattern = /^[a-f0-9]{40,64}$/u;
const movedCwdFailureCode = "application_support_root_moved";
const chatProvisionInterruptedReason = "provision_interrupted";
const terminalStages = new Set(["ambiguous", "cancelled", "completed", "failed", "lease_lost"]);
const providerThreadArchiveAuthorityTablesV57 = [
  "chat_provider_thread_archive_targets_v57",
  "chat_provider_thread_archive_attempts_v57",
  "chat_provider_thread_archive_cuts_v57",
  "chat_provider_thread_archive_cut_members_v57",
] as const;

const managedWriteManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(128),
  laneId: z.string().min(1).max(128),
  canonicalRepositoryPath: z.string().min(1).max(4_096),
  canonicalGitCommonDir: z.string().min(1).max(4_096),
  baseSha: z.string().regex(commitPattern),
  branchName: z.string().min(1).max(512),
  canonicalCheckoutPath: z.string().min(1).max(4_096),
}).strict();
const readOnlyManifestSchema = z.object({
  version: z.literal(2),
  kind: z.literal("readOnlySnapshot"),
  runId: z.string().min(1).max(128),
  laneId: z.string().min(1).max(128),
  canonicalRepositoryPath: z.string().min(1).max(4_096),
  canonicalGitCommonDir: z.string().min(1).max(4_096),
  baseSha: z.string().regex(commitPattern),
  canonicalCheckoutPath: z.string().min(1).max(4_096),
}).strict();
const manifestSchema = z.union([
  managedWriteManifestSchema,
  readOnlyManifestSchema,
]);

const threadSchema = z.object({
  threadId: z.string().min(1).max(256),
  codexThreadId: z.string().min(1).max(512),
  archived: z.number().int().min(0).max(1),
  updatedAt: z.string().min(1).max(256),
}).strict();
const dispatchSchema = z.object({
  runId: z.string().min(1).max(256),
  stage: z.string().min(1).max(64),
  failureCode: z.string().max(256).nullable(),
  updatedAt: z.string().min(1).max(256),
}).strict();
const databaseCapabilitiesSchema = z.object({
  foundation: z.boolean(),
  dispatch: z.boolean(),
  chatWorkspaceBindings: z.boolean().default(false),
}).strict();
const leaseStatusSchema = z.enum([
  "provisioning",
  "ready",
  "preserved",
  "quarantined",
]);
const chatProvisioningRecoverySchema = z.object({
  bindingId: z.string().min(16).max(96),
  bindingRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 2),
  bindingUpdatedAt: z.string().min(1).max(256),
  paneId: z.string().min(12).max(96),
  paneRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 2),
  paneUpdatedAt: z.string().min(1).max(256),
  paneWorkspaceRevision: z.number().int().positive()
    .max(Number.MAX_SAFE_INTEGER - 2),
}).strict();
const laneSchema = z.object({
  laneId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  legacyCheckoutPath: z.string().min(1).max(4_096),
  targetCheckoutPath: z.string().min(1).max(4_096),
  legacyManifestPath: z.string().min(1).max(4_096).nullable(),
  targetManifestPath: z.string().min(1).max(4_096).nullable(),
  repositoryPath: z.string().min(1).max(4_096),
  gitCommonDir: z.string().min(1).max(4_096),
  baseSha: z.string().regex(commitPattern),
  workspaceMode: z.string().min(1).max(64),
  branchName: z.string().min(1).max(512).nullable(),
  manifest: manifestSchema.nullable(),
  leaseStatus: leaseStatusSchema,
  leaseUpdatedAt: z.string().min(1).max(256),
  repairKind: z.enum(["databaseOnly", "manifestOnly", "linked"]),
  threads: z.array(threadSchema).max(maximumBindings),
  dispatches: z.array(dispatchSchema).max(maximumBindings),
  chatBindingIds: z.array(z.string().min(16).max(96)).max(maximumBindings)
    .default([]),
  chatProvisioningRecoveries: z.array(chatProvisioningRecoverySchema)
    .max(maximumBindings).default([]),
  manifestState: z.enum(["absent", "legacy", "target"]),
  gitState: z.enum(["legacy", "target", "verified"]),
}).strict().superRefine((lane, context) => {
  const manifestIdentityPresent = lane.legacyManifestPath !== null
    && lane.targetManifestPath !== null
    && lane.manifest !== null;
  if (
    lane.chatProvisioningRecoveries.length > 0 &&
    lane.leaseStatus !== "provisioning"
  ) {
    context.addIssue({
      code: "custom",
      message: "Only an interrupted provisioning lease can own chat recovery",
    });
  }
  const recoveryBindingIds = new Set(
    lane.chatProvisioningRecoveries.map((recovery) => recovery.bindingId),
  );
  const recoveryPaneIds = new Set(
    lane.chatProvisioningRecoveries.map((recovery) => recovery.paneId),
  );
  if (
    recoveryBindingIds.size !== lane.chatProvisioningRecoveries.length ||
    recoveryPaneIds.size !== lane.chatProvisioningRecoveries.length ||
    [...recoveryBindingIds].some((bindingId) =>
      !lane.chatBindingIds.includes(bindingId)
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Chat provisioning recovery identities are inconsistent",
    });
  }
  if (lane.repairKind === "databaseOnly") {
    if (lane.manifest !== null || lane.manifestState !== "absent") {
      context.addIssue({
        code: "custom",
        message: "A database-only lane cannot own a manifest",
      });
    }
    return;
  }
  if (!manifestIdentityPresent || lane.manifestState === "absent") {
    context.addIssue({
      code: "custom",
      message: "A manifest-bearing lane has incomplete identity",
    });
  }
  if (
    lane.manifest !== null &&
    ((lane.manifest.version === 2) !==
      (lane.workspaceMode === "harness_read_only_snapshot"))
  ) {
    context.addIssue({
      code: "custom",
      message: "A snapshot manifest must match its read-only workspace mode",
    });
  }
  if (
    lane.manifest !== null &&
    lane.manifest.version === 1 &&
    lane.branchName === null
  ) {
    context.addIssue({
      code: "custom",
      message: "A managed-write manifest requires a branch identity",
    });
  }
  if (
    lane.manifest !== null &&
    lane.manifest.version === 2 &&
    lane.branchName !== null
  ) {
    context.addIssue({
      code: "custom",
      message: "A detached snapshot cannot retain a branch identity",
    });
  }
});
const stateSchema = z.enum([
  "prepared",
  "databaseRewritten",
  "manifestsRewritten",
  "irreversibleForward",
  "gitRepaired",
  "verified",
  "complete",
  "reversing",
  "reversed",
]);
const journalSchema = z.object({
  version: z.literal(1),
  kind: z.literal("hraness-kitchen-managed-worktree-repair"),
  legacyRoot: z.string().min(1).max(4_096),
  targetRoot: z.string().min(1).max(4_096),
  migrationTimestamp: z.string().datetime(),
  databaseCapabilities: databaseCapabilitiesSchema,
  state: stateSchema,
  irreversibleForward: z.boolean(),
  lanes: z.array(laneSchema).max(maximumLanes),
}).strict().superRefine((journal, context) => {
  if (
    journal.irreversibleForward
    && !["irreversibleForward", "gitRepaired", "verified", "complete"].includes(journal.state)
  ) {
    context.addIssue({ code: "custom", message: "Irreversible journal phase is invalid" });
  }
});

type Manifest = z.infer<typeof manifestSchema>;
type Journal = z.infer<typeof journalSchema>;
type Lane = z.infer<typeof laneSchema>;
type JournalState = z.infer<typeof stateSchema>;
type DatabaseCapabilities = z.infer<typeof databaseCapabilitiesSchema>;
type LeaseStatus = z.infer<typeof leaseStatusSchema>;

function manifestBranchName(manifest: Manifest): string | null {
  return manifest.version === 1 ? manifest.branchName : null;
}

export type ApplicationSupportWorktreeRepairFaultPoint =
  | "afterPreparedJournal"
  | "afterDatabaseRewrite"
  | "afterManifestRewrite"
  | "afterManifestsRewrittenJournal"
  | "afterIrreversibleForwardJournal"
  | "afterGitRepair"
  | "afterGitRepairedJournal"
  | "afterGitVerification"
  | "afterVerifiedJournal"
  | "afterCompletedJournal"
  | "afterReversePreparedJournal"
  | "afterReverseManifestRewrite"
  | "afterReverseDatabaseRewrite"
  | "afterReversedJournal";

export interface ApplicationSupportWorktreeRepairOptions {
  readonly database: Database;
  readonly legacyRoot: string;
  readonly targetRoot: string;
  readonly git: GitRunner;
  readonly onCheckpoint?: (
    point: ApplicationSupportWorktreeRepairFaultPoint,
    laneId: string | null,
  ) => void;
}

export interface ApplicationSupportWorktreeRepairResult {
  readonly journalPath: string;
  readonly repairedLaneIds: readonly string[];
  readonly archivedCodexThreadIds: readonly string[];
  readonly ambiguousRunIds: readonly string[];
  readonly codexCwdPolicy: "archive_threads_and_quarantine_nonterminal_runs";
  readonly irreversibleForward: boolean;
}

export interface ApplicationSupportWorktreeRepairInspection {
  readonly kind: "absent" | JournalState;
  readonly journalPath: string;
  readonly rollbackSafe: boolean;
}

export class ApplicationSupportWorktreeRepairError extends Error {
  readonly code:
    | "conflicting_paths"
    | "git_repair_failed"
    | "git_verification_failed"
    | "invalid_database"
    | "invalid_journal"
    | "invalid_manifest"
    | "rollback_requires_forward_completion"
    | "unsafe_path";
  readonly rollbackSafe: boolean;
  readonly path: string | null;

  constructor(
    code: ApplicationSupportWorktreeRepairError["code"],
    message: string,
    options: {
      readonly cause?: unknown;
      readonly path?: string;
      readonly rollbackSafe?: boolean;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApplicationSupportWorktreeRepairError";
    this.code = code;
    this.rollbackSafe = options.rollbackSafe ?? true;
    this.path = options.path ?? null;
  }
}

/**
 * Repairs all path-bearing managed-worktree state after the containing
 * Application Support directory has moved. The core migration lock must remain
 * held and account, Codex, and dispatch services must not have started.
 *
 * The durable irreversible marker precedes the first `git worktree repair`.
 * Once present, callers must retry forward instead of renaming the target root
 * back: Git cannot point at a legacy lane that does not exist yet.
 */
export async function repairMovedApplicationSupportWorktrees(
  options: ApplicationSupportWorktreeRepairOptions,
): Promise<ApplicationSupportWorktreeRepairResult> {
  const roots = await validateRoots(options.legacyRoot, options.targetRoot);
  assertNoProviderThreadArchiveAuthorityV57(options.database);
  let journal = await readJournal(roots.target);
  if (journal === null) {
    journal = await inventory(options.database, roots.legacy, roots.target, options.git);
    await writeJournal(roots.target, journal);
    checkpoint(options, "afterPreparedJournal", null);
  } else {
    assertJournalRoots(journal, roots);
  }
  if (journal.state === "complete") {
    await assertCompletedRepair(options.database, journal);
    return result(journal, roots.target);
  }
  if (journal.state === "reversing" || journal.state === "reversed") {
    journal = normalizeReversedChatProvisioning(
      options.database,
      journal,
    );
    journal = {
      ...journal,
      state: "prepared",
      irreversibleForward: false,
      lanes: journal.lanes.map((lane) => ({
        ...lane,
        manifestState: lane.repairKind === "databaseOnly" ? "absent" : "legacy",
        gitState: "legacy",
      })),
    };
    await writeJournal(roots.target, journal);
    checkpoint(options, "afterPreparedJournal", null);
  }

  try {
    applyForwardDatabase(options.database, journal);
    journal = {
      ...journal,
      state: journal.irreversibleForward ? "irreversibleForward" : "databaseRewritten",
    };
    await writeJournal(roots.target, journal);
    checkpoint(options, "afterDatabaseRewrite", null);

    for (let index = 0; index < journal.lanes.length; index += 1) {
      const lane = requiredLane(journal, index);
      if (lane.repairKind === "databaseOnly") continue;
      await replaceManifest(lane, "target");
      journal = replaceLane(journal, index, { ...lane, manifestState: "target" });
      await writeJournal(roots.target, journal);
      checkpoint(options, "afterManifestRewrite", lane.laneId);
    }
    journal = {
      ...journal,
      state: journal.irreversibleForward ? "irreversibleForward" : "manifestsRewritten",
    };
    await writeJournal(roots.target, journal);
    checkpoint(options, "afterManifestsRewrittenJournal", null);

    if (
      journal.lanes.some((lane) => lane.repairKind === "linked")
      && !journal.irreversibleForward
    ) {
      journal = { ...journal, state: "irreversibleForward", irreversibleForward: true };
      await writeJournal(roots.target, journal);
      checkpoint(options, "afterIrreversibleForwardJournal", null);
    }
    for (let index = 0; index < journal.lanes.length; index += 1) {
      const lane = requiredLane(journal, index);
      if (lane.repairKind !== "linked") continue;
      await repairGitLane(options.git, lane);
      journal = replaceLane(journal, index, { ...lane, gitState: "target" });
      await writeJournal(roots.target, journal);
      checkpoint(options, "afterGitRepair", lane.laneId);
    }
    journal = { ...journal, state: "gitRepaired" };
    await writeJournal(roots.target, journal);
    checkpoint(options, "afterGitRepairedJournal", null);

    for (let index = 0; index < journal.lanes.length; index += 1) {
      const lane = requiredLane(journal, index);
      if (lane.repairKind !== "linked") continue;
      await verifyGitLane(options.git, lane);
      journal = replaceLane(journal, index, { ...lane, gitState: "verified" });
      await writeJournal(roots.target, journal);
      checkpoint(options, "afterGitVerification", lane.laneId);
    }
    assertForwardDatabase(options.database, journal);
    journal = { ...journal, state: "verified" };
    await writeJournal(roots.target, journal);
    checkpoint(options, "afterVerifiedJournal", null);

    journal = { ...journal, state: "complete" };
    await writeJournal(roots.target, journal);
    checkpoint(options, "afterCompletedJournal", null);
    return result(journal, roots.target);
  } catch (error: unknown) {
    if (error instanceof ApplicationSupportWorktreeRepairError) throw error;
    throw new ApplicationSupportWorktreeRepairError(
      journal.irreversibleForward ? "git_repair_failed" : "invalid_database",
      `${journal.irreversibleForward
        ? "Managed-worktree repair must retry forward"
        : "Managed-worktree repair failed before its Git phase"}${
        error instanceof Error ? `: ${error.message}` : ""
      }`,
      { cause: error, rollbackSafe: !journal.irreversibleForward },
    );
  }
}

/**
 * Reverses DB and manifest changes while proving external Git metadata still
 * names the legacy lanes. It intentionally refuses after the irreversible Git
 * marker; that state must complete forward.
 */
export async function reverseMovedApplicationSupportWorktreeRepair(
  options: ApplicationSupportWorktreeRepairOptions,
): Promise<ApplicationSupportWorktreeRepairInspection> {
  const roots = await validateRoots(options.legacyRoot, options.targetRoot);
  assertNoProviderThreadArchiveAuthorityV57(options.database);
  let journal = await readJournal(roots.target);
  const journalPath = worktreeRepairJournalPath(roots.target);
  if (journal === null) return { kind: "absent", journalPath, rollbackSafe: true };
  assertJournalRoots(journal, roots);
  if (journal.irreversibleForward) {
    throw new ApplicationSupportWorktreeRepairError(
      "rollback_requires_forward_completion",
      "External Git metadata may already name the target lanes; retry repair forward",
      { path: journalPath, rollbackSafe: false },
    );
  }

  assertNoProviderThreadArchiveAuthorityV57(options.database);
  journal = { ...journal, state: "reversing" };
  await writeJournal(roots.target, journal);
  checkpoint(options, "afterReversePreparedJournal", null);
  assertNoProviderThreadArchiveAuthorityV57(options.database);
  for (let index = 0; index < journal.lanes.length; index += 1) {
    const lane = requiredLane(journal, index);
    if (lane.repairKind === "databaseOnly") continue;
    await replaceManifest(lane, "legacy");
    journal = replaceLane(journal, index, { ...lane, manifestState: "legacy" });
    await writeJournal(roots.target, journal);
    checkpoint(options, "afterReverseManifestRewrite", lane.laneId);
  }
  applyReverseDatabase(options.database, journal);
  checkpoint(options, "afterReverseDatabaseRewrite", null);
  journal = normalizeReversedChatProvisioning(options.database, journal);
  for (const lane of journal.lanes) {
    if (lane.repairKind === "linked") await assertLegacyGitMetadata(options.git, lane);
  }
  journal = {
    ...journal,
    state: "reversed",
    lanes: journal.lanes.map((lane) => ({
      ...lane,
      manifestState: lane.repairKind === "databaseOnly" ? "absent" : "legacy",
      gitState: "legacy",
    })),
  };
  await writeJournal(roots.target, journal);
  checkpoint(options, "afterReversedJournal", null);
  return { kind: "reversed", journalPath, rollbackSafe: true };
}

export async function inspectApplicationSupportWorktreeRepair(
  targetRoot: string,
): Promise<ApplicationSupportWorktreeRepairInspection> {
  const target = normalizedPath(targetRoot, "target root");
  const journal = await readJournal(target);
  return journal === null
    ? { kind: "absent", journalPath: worktreeRepairJournalPath(target), rollbackSafe: true }
    : {
        kind: journal.state,
        journalPath: worktreeRepairJournalPath(target),
        rollbackSafe: !journal.irreversibleForward,
      };
}

export function worktreeRepairJournalPath(targetRoot: string): string {
  return join(normalizedPath(targetRoot, "target root"), journalName);
}

function assertNoProviderThreadArchiveAuthorityV57(database: Database): void {
  const tableNameSchema = z.enum(providerThreadArchiveAuthorityTablesV57);
  let rows: readonly { readonly name: string; readonly type: string }[];
  try {
    const values: unknown[] = database.query(`
      SELECT name, type FROM main.sqlite_schema
      WHERE name IN (
        'chat_provider_thread_archive_targets_v57',
        'chat_provider_thread_archive_attempts_v57',
        'chat_provider_thread_archive_cuts_v57',
        'chat_provider_thread_archive_cut_members_v57'
      )
      ORDER BY name
    `).all();
    rows = z.array(z.object({
      name: tableNameSchema,
      type: z.string(),
    }).strict()).max(providerThreadArchiveAuthorityTablesV57.length).parse(values);
  } catch (error: unknown) {
    throw new ApplicationSupportWorktreeRepairError(
      "invalid_database",
      "Provider-thread archive authority schema could not be inspected",
      { cause: error, rollbackSafe: true },
    );
  }

  if (rows.length === 0) return;
  if (rows.length !== providerThreadArchiveAuthorityTablesV57.length) {
    throw invalidDatabase(
      "Provider-thread archive authority relations form a partial v57 schema",
    );
  }
  const objectTypes = new Map(rows.map((row) => [row.name, row.type] as const));
  if (
    providerThreadArchiveAuthorityTablesV57.some((name) =>
      objectTypes.get(name) !== "table"
    )
  ) {
    throw invalidDatabase(
      "Provider-thread archive authority relations are not v57 tables",
    );
  }

  let authoritySurvives: boolean;
  try {
    const value: unknown = database.query(`
      SELECT CASE WHEN
        EXISTS (SELECT 1 FROM main.chat_provider_thread_archive_targets_v57)
        OR EXISTS (SELECT 1 FROM main.chat_provider_thread_archive_attempts_v57)
        OR EXISTS (SELECT 1 FROM main.chat_provider_thread_archive_cuts_v57)
        OR EXISTS (SELECT 1 FROM main.chat_provider_thread_archive_cut_members_v57)
      THEN 1 ELSE 0 END AS authority_survives
    `).get();
    const parsed = z.object({
      authority_survives: z.number().int().min(0).max(1),
    }).strict().parse(value);
    authoritySurvives = parsed.authority_survives === 1;
  } catch (error: unknown) {
    throw new ApplicationSupportWorktreeRepairError(
      "invalid_database",
      "Provider-thread archive authority relations could not be read",
      { cause: error, rollbackSafe: true },
    );
  }
  if (authoritySurvives) {
    throw invalidDatabase(
      "Provider-thread archive authority must reconcile exactly before Application Support repair",
    );
  }
}

function inspectDatabaseCapabilities(database: Database): DatabaseCapabilities {
  let migrationVersion: number;
  try {
    migrationVersion = validateAppliedMigrationPrefix(database);
  } catch (error: unknown) {
    throw new ApplicationSupportWorktreeRepairError(
      "invalid_database",
      "Control-plane migration history is unsupported",
      { cause: error, rollbackSafe: true },
    );
  }
  const foundationTables = ["projects", "thread_bindings", "workspace_leases"] as const;
  const dispatchTables = [
    "dispatch_bindings",
    "dispatch_outbox",
    "repository_bindings",
  ] as const;
  const chatWorkspaceTables = ["chat_pane_workspace_bindings"] as const;
  const relevantNames = [
    ...foundationTables,
    ...dispatchTables,
    ...chatWorkspaceTables,
  ] as const;
  const values: unknown[] = database.query(`
    SELECT name, type FROM sqlite_schema
    WHERE name IN (
      'projects',
      'thread_bindings',
      'workspace_leases',
      'dispatch_bindings',
      'dispatch_outbox',
      'repository_bindings',
      'chat_pane_workspace_bindings'
    )
    ORDER BY name
  `).all();
  const rows = z.array(z.object({
    name: z.enum(relevantNames),
    type: z.string(),
  }).strict()).max(relevantNames.length).parse(values);
  const objects = new Map(rows.map((row) => [row.name, row.type] as const));

  const foundationCount = foundationTables.filter((name) => objects.has(name)).length;
  const dispatchCount = dispatchTables.filter((name) => objects.has(name)).length;
  const chatWorkspaceCount = chatWorkspaceTables.filter((name) =>
    objects.has(name)
  ).length;
  if (foundationCount !== 0 && foundationCount !== foundationTables.length) {
    throw invalidDatabase("Control-plane foundation tables form a partial schema");
  }
  if (dispatchCount !== 0 && dispatchCount !== dispatchTables.length) {
    throw invalidDatabase("Control-plane dispatch tables form a partial schema");
  }
  if (dispatchCount > 0 && foundationCount === 0) {
    throw invalidDatabase("Control-plane dispatch tables exist without their foundation");
  }
  if (chatWorkspaceCount > 0 && foundationCount === 0) {
    throw invalidDatabase("Chat workspace bindings exist without their foundation");
  }
  for (const [name, type] of objects) {
    if (type !== "table") {
      throw invalidDatabase(`Control-plane object ${name} is not a table`);
    }
  }

  const foundation = foundationCount === foundationTables.length;
  const dispatch = dispatchCount === dispatchTables.length;
  const chatWorkspaceBindings = chatWorkspaceCount === chatWorkspaceTables.length;
  const expectedFoundation = migrationVersion >= 1;
  const expectedDispatch = migrationVersion >= 4;
  const expectedChatWorkspaceBindings = migrationVersion >= 30;
  if (
    foundation !== expectedFoundation
    || dispatch !== expectedDispatch
    || chatWorkspaceBindings !== expectedChatWorkspaceBindings
  ) {
    throw invalidDatabase("Control-plane tables do not match their migration prefix");
  }
  if (foundation) {
    assertTableColumns(database, "projects", [
      "project_id",
      "canonical_repository_path",
      "canonical_git_common_dir",
    ]);
    assertTableColumns(database, "workspace_leases", [
      "lane_id",
      "project_id",
      "canonical_checkout_path",
      "recovery_manifest_path",
      "base_sha",
      "branch_name",
    ]);
    assertTableColumns(database, "thread_bindings", [
      "thread_id",
      "codex_thread_id",
      "lane_id",
      "archived",
      "updated_at",
    ]);
  }
  if (dispatch) {
    assertTableColumns(database, "repository_bindings", [
      "repository_public_id",
      "project_id",
    ]);
    assertTableColumns(database, "dispatch_bindings", [
      "run_id",
      "lane_id",
      "stage",
      "failure_code",
      "updated_at",
    ]);
    assertTableColumns(database, "dispatch_outbox", ["run_id", "sequence"]);
  }
  if (chatWorkspaceBindings) {
    assertTableColumns(database, "chat_pane_workspace_bindings", [
      "binding_id",
      "workspace_lease_id",
      "canonical_checkout_path",
      "recovery_manifest_path",
    ]);
  }
  return { foundation, dispatch, chatWorkspaceBindings };
}

function assertDatabaseCapabilities(
  database: Database,
  expected: DatabaseCapabilities,
): void {
  const observed = inspectDatabaseCapabilities(database);
  if (
    observed.foundation !== expected.foundation
    || observed.dispatch !== expected.dispatch
    || observed.chatWorkspaceBindings !== expected.chatWorkspaceBindings
  ) {
    throw invalidDatabase("Control-plane schema capabilities changed during repair");
  }
}

function assertTableColumns(
  database: Database,
  table:
    | "dispatch_bindings"
    | "dispatch_outbox"
    | "chat_pane_workspace_bindings"
    | "projects"
    | "repository_bindings"
    | "thread_bindings"
    | "workspace_leases",
  required: readonly string[],
): void {
  const values: unknown[] = database.query(`PRAGMA table_info("${table}")`).all();
  const rows = z.array(z.object({
    cid: z.number().int().nonnegative(),
    name: z.string().min(1),
  }).passthrough()).min(1).parse(values);
  const columns = new Set(rows.map((row) => row.name));
  if (columns.size !== rows.length || required.some((name) => !columns.has(name))) {
    throw invalidDatabase(`Control-plane table ${table} has an incompatible shape`);
  }
}

async function inventory(
  database: Database,
  legacyRoot: string,
  targetRoot: string,
  git: GitRunner,
): Promise<Journal> {
  const rowSchema = z.object({
    lane_id: z.string().min(1).max(128),
    project_id: z.string().min(1).max(128),
    canonical_repository_path: z.string().min(1).max(4_096),
    canonical_git_common_dir: z.string().min(1).max(4_096),
    canonical_checkout_path: z.string().min(1).max(4_096),
    recovery_manifest_path: z.string().min(1).max(4_096).nullable(),
    base_sha: z.string().regex(commitPattern),
    mode: z.string().min(1).max(64),
    branch_name: z.string().min(1).max(512).nullable(),
    status: z.string().min(1).max(64),
    updated_at: z.string().min(1).max(256),
  }).strict();
  const databaseCapabilities = inspectDatabaseCapabilities(database);
  const values: unknown[] = databaseCapabilities.foundation
    ? database.query(`
      SELECT workspace_leases.lane_id, workspace_leases.project_id,
        projects.canonical_repository_path, projects.canonical_git_common_dir,
        workspace_leases.canonical_checkout_path, workspace_leases.recovery_manifest_path,
        workspace_leases.base_sha, workspace_leases.mode,
        workspace_leases.branch_name,
        workspace_leases.status, workspace_leases.updated_at
      FROM workspace_leases
      JOIN projects ON projects.project_id = workspace_leases.project_id
      ORDER BY workspace_leases.lane_id
      LIMIT ?1
    `).all(maximumLanes + 1)
    : [];
  const rows = z.array(rowSchema).max(maximumLanes).parse(values);
  const lanes: Lane[] = [];
  let bindingCount = 0;
  let orientation: "legacy" | "target" | null = null;
  for (const row of rows) {
    const leaseStatus = leaseStatusSchema.safeParse(row.status);
    if (!leaseStatus.success) {
      throw invalidDatabase("A workspace lease has an unsupported migration status");
    }
    assertExternal(row.canonical_repository_path, legacyRoot, targetRoot);
    assertExternal(row.canonical_git_common_dir, legacyRoot, targetRoot);
    const checkout = pathPair(row.canonical_checkout_path, legacyRoot, targetRoot);
    const manifestPath = row.recovery_manifest_path === null
      ? null
      : pathPair(row.recovery_manifest_path, legacyRoot, targetRoot);
    if (
      (manifestPath !== null && checkout.orientation !== manifestPath.orientation)
      || (orientation !== null && checkout.orientation !== orientation)
    ) {
      throw conflicting("Workspace leases mix legacy and target path generations");
    }
    orientation = checkout.orientation;
    const checkoutKind = await repairPathKind(checkout.target, "managed checkout");
    if (checkoutKind === "file") {
      throw invalidDatabase("A managed checkout path contains a regular file");
    }
    const manifestKind = manifestPath === null
      ? "missing"
      : await repairPathKind(manifestPath.target, "recovery manifest");
    if (manifestKind === "directory") {
      throw invalidManifest(
        "Recovery manifest path contains a directory",
        manifestPath?.target ?? checkout.target,
      );
    }
    const manifest = manifestKind === "file" && manifestPath !== null
      ? await readManifest(manifestPath.target)
      : null;
    if (manifest !== null) {
      if (
        manifest.runId !== row.lane_id
        || manifest.laneId !== row.lane_id
        || manifest.canonicalRepositoryPath !== row.canonical_repository_path
        || manifest.canonicalGitCommonDir !== row.canonical_git_common_dir
        || manifest.baseSha !== row.base_sha
        || (manifest.version === 1 && manifest.branchName !== row.branch_name)
        || ((manifest.version === 2) !==
          (row.mode === "harness_read_only_snapshot"))
        || (manifest.version === 2 && row.branch_name !== null)
        || ![checkout.legacy, checkout.target].includes(manifest.canonicalCheckoutPath)
      ) {
        throw invalidManifest(
          "Recovery manifest conflicts with its SQLite lease",
          manifestPath?.target ?? checkout.target,
        );
      }
    }

    let repairKind: Lane["repairKind"];
    if (leaseStatus.data === "ready") {
      if (
        manifestPath === null
        || manifest === null
        || checkoutKind !== "directory"
        || (manifest.version === 1 && row.branch_name === null)
      ) {
        throw invalidDatabase("A ready workspace lease is not a complete linked worktree");
      }
      repairKind = "linked";
    } else if (checkoutKind === "directory") {
      if (
        manifestPath === null
        || manifest === null
        || (manifest.version === 1 && row.branch_name === null)
      ) {
        throw invalidDatabase("A non-ready checkout lacks its recovery identity");
      }
      repairKind = "linked";
    } else if (manifest !== null) {
      repairKind = "manifestOnly";
    } else {
      repairKind = "databaseOnly";
    }
    const threads = readThreads(database, row.lane_id);
    const dispatches = databaseCapabilities.dispatch
      ? readDispatches(database, row.lane_id)
      : [];
    const chatBindings = databaseCapabilities.chatWorkspaceBindings
      ? readChatBindings(
          database,
          row.lane_id,
          row.canonical_checkout_path,
          row.recovery_manifest_path,
          leaseStatus.data,
        )
      : { bindingIds: [], provisioningRecoveries: [] };
    bindingCount += threads.length + dispatches.length + chatBindings.bindingIds.length;
    if (bindingCount > maximumBindings) throw invalidDatabase("Binding inventory is too large");
    const lane: Lane = {
      laneId: row.lane_id,
      projectId: row.project_id,
      legacyCheckoutPath: checkout.legacy,
      targetCheckoutPath: checkout.target,
      legacyManifestPath: manifestPath?.legacy ?? null,
      targetManifestPath: manifestPath?.target ?? null,
      repositoryPath: row.canonical_repository_path,
      gitCommonDir: row.canonical_git_common_dir,
      baseSha: row.base_sha,
      workspaceMode: row.mode,
      branchName: row.branch_name,
      manifest: manifest === null
        ? null
        : { ...manifest, canonicalCheckoutPath: checkout.legacy },
      leaseStatus: leaseStatus.data,
      leaseUpdatedAt: row.updated_at,
      repairKind,
      threads,
      dispatches,
      chatBindingIds: chatBindings.bindingIds,
      chatProvisioningRecoveries: chatBindings.provisioningRecoveries,
      manifestState: manifest === null ? "absent" : "legacy",
      gitState: "legacy",
    };
    if (repairKind === "linked") await assertLegacyLinkedCandidate(git, lane);
    lanes.push(lane);
  }
  return journalSchema.parse({
    version: 1,
    kind: "hraness-kitchen-managed-worktree-repair",
    legacyRoot,
    targetRoot,
    migrationTimestamp: new Date().toISOString(),
    databaseCapabilities,
    state: "prepared",
    irreversibleForward: false,
    lanes,
  });
}

function readThreads(database: Database, laneId: string): Lane["threads"] {
  const schema = z.object({
    thread_id: z.string().min(1).max(256),
    codex_thread_id: z.string().min(1).max(512),
    archived: z.number().int().min(0).max(1),
    updated_at: z.string().min(1).max(256),
  }).strict();
  const values: unknown[] = database.query(`
    SELECT thread_id, codex_thread_id, archived, updated_at
    FROM thread_bindings WHERE lane_id = ?1 ORDER BY thread_id LIMIT ?2
  `).all(laneId, maximumBindings + 1);
  return z.array(schema).max(maximumBindings).parse(values).map((row) => ({
    threadId: row.thread_id,
    codexThreadId: row.codex_thread_id,
    archived: row.archived,
    updatedAt: row.updated_at,
  }));
}

function readDispatches(database: Database, laneId: string): Lane["dispatches"] {
  const schema = z.object({
    run_id: z.string().min(1).max(256),
    stage: z.string().min(1).max(64),
    failure_code: z.string().max(256).nullable(),
    updated_at: z.string().min(1).max(256),
  }).strict();
  const values: unknown[] = database.query(`
    SELECT run_id, stage, failure_code, updated_at
    FROM dispatch_bindings WHERE lane_id = ?1 ORDER BY run_id LIMIT ?2
  `).all(laneId, maximumBindings + 1);
  return z.array(schema).max(maximumBindings).parse(values).map((row) => ({
    runId: row.run_id,
    stage: row.stage,
    failureCode: row.failure_code,
    updatedAt: row.updated_at,
  }));
}

function readChatBindings(
  database: Database,
  laneId: string,
  expectedCheckoutPath: string,
  expectedManifestPath: string | null,
  leaseStatus: LeaseStatus,
): {
  readonly bindingIds: Lane["chatBindingIds"];
  readonly provisioningRecoveries: Lane["chatProvisioningRecoveries"];
} {
  const schema = z.object({
    binding_id: z.string().min(16).max(96),
    canonical_checkout_path: z.string().min(1).max(4_096),
    recovery_manifest_path: z.string().min(1).max(4_096),
    state: z.enum([
      "provisioning",
      "ready",
      "preserved",
      "quarantined",
      "recovery_required",
    ]),
    revision: z.number().int().positive().safe(),
    recovery_reason: z.string().min(1).max(64).nullable(),
    updated_at: z.string().min(1).max(256),
    pane_id: z.string().min(12).max(96),
    pane_revision: z.number().int().positive().safe(),
    pane_updated_at: z.string().min(1).max(256),
    workspace_state: z.enum([
      "preparing",
      "waiting_capacity",
      "ready",
      "preserved",
      "recovery_required",
    ]),
    workspace_revision: z.number().int().positive().safe(),
    workspace_recovery_reason: z.string().min(1).max(64).nullable(),
    archived_at: z.string().min(1).max(256).nullable(),
  }).strict();
  const values: unknown[] = database.query(`
    SELECT binding.binding_id, binding.canonical_checkout_path,
      binding.recovery_manifest_path, binding.state, binding.revision,
      binding.recovery_reason, binding.updated_at, binding.pane_id,
      pane.revision AS pane_revision, pane.updated_at AS pane_updated_at,
      pane.workspace_state, pane.workspace_revision,
      pane.workspace_recovery_reason, pane.archived_at
    FROM chat_pane_workspace_bindings AS binding
    JOIN chat_panes AS pane ON pane.pane_id = binding.pane_id
    WHERE binding.workspace_lease_id = ?1
    ORDER BY binding.binding_id
    LIMIT ?2
  `).all(laneId, maximumBindings + 1);
  const rows = z.array(schema).max(maximumBindings).parse(values);
  if (
    expectedManifestPath === null
    || rows.some((row) =>
      row.canonical_checkout_path !== expectedCheckoutPath
      || row.recovery_manifest_path !== expectedManifestPath
    )
  ) {
    if (rows.length > 0) {
      throw conflicting(
        "Chat workspace binding paths conflict with their workspace lease",
      );
    }
  }
  const provisioningRecoveries = leaseStatus === "provisioning"
    ? rows.map((row) => {
        if (
          row.state !== "provisioning" || row.recovery_reason !== null ||
          row.workspace_state !== "preparing" ||
          row.workspace_recovery_reason !== null || row.archived_at !== null
        ) {
          throw invalidDatabase(
            "A provisioning chat workspace is not recoverable from its durable state",
          );
        }
        return {
          bindingId: row.binding_id,
          bindingRevision: row.revision,
          bindingUpdatedAt: row.updated_at,
          paneId: row.pane_id,
          paneRevision: row.pane_revision,
          paneUpdatedAt: row.pane_updated_at,
          paneWorkspaceRevision: row.workspace_revision,
        };
      })
    : [];
  return {
    bindingIds: rows.map((row) => row.binding_id),
    provisioningRecoveries,
  };
}

function applyForwardDatabase(database: Database, journal: Journal): void {
  assertDatabaseCapabilities(database, journal.databaseCapabilities);
  if (!journal.databaseCapabilities.foundation) return;
  database.transaction(() => {
    assertNoProviderThreadArchiveAuthorityV57(database);
    assertLaneSet(database, journal);
    for (const lane of journal.lanes) {
      assertPathsKnown(database, lane);
      if (journal.databaseCapabilities.chatWorkspaceBindings) {
        assertChatBindingsKnown(database, lane);
      }
      assertLeaseDispositionKnown(database, lane, journal.migrationTimestamp);
      const chatRecoveryState = interruptedChatProvisioningState(
        database,
        lane,
        journal.migrationTimestamp,
      );
      rewriteChatBindingPaths(database, lane, "target");
      if (lane.leaseStatus === "provisioning") {
        if (lane.chatProvisioningRecoveries.length > 0) {
          database.query(`
            UPDATE workspace_leases SET canonical_checkout_path = ?2,
              recovery_manifest_path = ?3, status = 'quarantined',
              quarantine_reason = ?4, quarantined_at = ?5, updated_at = ?5
            WHERE lane_id = ?1
          `).run(
            lane.laneId,
            lane.targetCheckoutPath,
            lane.targetManifestPath,
            chatProvisionInterruptedReason,
            journal.migrationTimestamp,
          );
        } else {
          database.query(`
            UPDATE workspace_leases SET canonical_checkout_path = ?2,
              recovery_manifest_path = ?3, status = 'preserved', updated_at = ?4
            WHERE lane_id = ?1
          `).run(
            lane.laneId,
            lane.targetCheckoutPath,
            lane.targetManifestPath,
            journal.migrationTimestamp,
          );
        }
      } else {
        database.query(`
          UPDATE workspace_leases SET canonical_checkout_path = ?2,
            recovery_manifest_path = ?3 WHERE lane_id = ?1
        `).run(lane.laneId, lane.targetCheckoutPath, lane.targetManifestPath);
      }
      if (chatRecoveryState === "original") {
        enterInterruptedChatProvisioningRecovery(
          database,
          lane,
          journal.migrationTimestamp,
        );
      }
      for (const thread of lane.threads) {
        assertThreadKnown(database, lane.laneId, thread, journal.migrationTimestamp);
        database.query(`
          UPDATE thread_bindings SET archived = 1, updated_at = ?3
          WHERE lane_id = ?1 AND thread_id = ?2
        `).run(lane.laneId, thread.threadId, journal.migrationTimestamp);
      }
      for (const dispatch of lane.dispatches) {
        assertDispatchKnown(database, lane.laneId, dispatch, journal.migrationTimestamp);
        if (terminalStages.has(dispatch.stage)) continue;
        database.query(`
          UPDATE dispatch_bindings SET stage = 'ambiguous', failure_code = ?3,
            updated_at = ?4 WHERE lane_id = ?1 AND run_id = ?2
        `).run(
          lane.laneId,
          dispatch.runId,
          movedCwdFailureCode,
          journal.migrationTimestamp,
        );
      }
    }
  })();
}

function applyReverseDatabase(database: Database, journal: Journal): void {
  assertDatabaseCapabilities(database, journal.databaseCapabilities);
  if (!journal.databaseCapabilities.foundation) return;
  database.transaction(() => {
    assertNoProviderThreadArchiveAuthorityV57(database);
    assertLaneSet(database, journal);
    for (const lane of journal.lanes) {
      assertPathsKnown(database, lane);
      if (journal.databaseCapabilities.chatWorkspaceBindings) {
        assertChatBindingsKnown(database, lane);
      }
      assertLeaseDispositionKnown(database, lane, journal.migrationTimestamp);
      const chatRecoveryState = interruptedChatProvisioningState(
        database,
        lane,
        journal.migrationTimestamp,
      );
      rewriteChatBindingPaths(database, lane, "legacy");
      if (lane.chatProvisioningRecoveries.length > 0) {
        database.query(`
          UPDATE workspace_leases SET canonical_checkout_path = ?2,
            recovery_manifest_path = ?3, status = ?4, updated_at = ?5,
            quarantine_reason = NULL, quarantined_at = NULL
          WHERE lane_id = ?1
        `).run(
          lane.laneId,
          lane.legacyCheckoutPath,
          lane.legacyManifestPath,
          lane.leaseStatus,
          lane.leaseUpdatedAt,
        );
      } else {
        database.query(`
          UPDATE workspace_leases SET canonical_checkout_path = ?2,
            recovery_manifest_path = ?3, status = ?4, updated_at = ?5
          WHERE lane_id = ?1
        `).run(
          lane.laneId,
          lane.legacyCheckoutPath,
          lane.legacyManifestPath,
          lane.leaseStatus,
          lane.leaseUpdatedAt,
        );
      }
      if (chatRecoveryState === "migrated") {
        reverseInterruptedChatProvisioningRecovery(
          database,
          lane,
          journal.migrationTimestamp,
        );
      }
      for (const thread of lane.threads) {
        assertThreadKnown(database, lane.laneId, thread, journal.migrationTimestamp);
        database.query(`
          UPDATE thread_bindings SET archived = ?3, updated_at = ?4
          WHERE lane_id = ?1 AND thread_id = ?2
        `).run(lane.laneId, thread.threadId, thread.archived, thread.updatedAt);
      }
      for (const dispatch of lane.dispatches) {
        assertDispatchKnown(database, lane.laneId, dispatch, journal.migrationTimestamp);
        database.query(`
          UPDATE dispatch_bindings SET stage = ?3, failure_code = ?4, updated_at = ?5
          WHERE lane_id = ?1 AND run_id = ?2
        `).run(
          lane.laneId,
          dispatch.runId,
          dispatch.stage,
          dispatch.failureCode,
          dispatch.updatedAt,
        );
      }
    }
  })();
}

function assertForwardDatabase(database: Database, journal: Journal): void {
  assertDatabaseCapabilities(database, journal.databaseCapabilities);
  if (!journal.databaseCapabilities.foundation) return;
  for (const lane of journal.lanes) {
    const observed = workspacePaths(database, lane.laneId);
    const expected = forwardLeaseDisposition(lane, journal.migrationTimestamp);
    if (
      observed.checkout !== lane.targetCheckoutPath
      || observed.manifest !== lane.targetManifestPath
      || observed.status !== expected.status
      || observed.updatedAt !== expected.updatedAt
    ) {
      throw conflicting("Database did not retain repaired worktree paths");
    }
    if (journal.databaseCapabilities.chatWorkspaceBindings) {
      assertChatBindingsAt(database, lane, "target");
    }
    const chatRecoveryState = interruptedChatProvisioningState(
      database,
      lane,
      journal.migrationTimestamp,
    );
    if (
      lane.chatProvisioningRecoveries.length > 0 &&
      chatRecoveryState !== "migrated"
    ) {
      throw conflicting("Interrupted chat provisioning did not enter recovery");
    }
  }
}

async function assertCompletedRepair(database: Database, journal: Journal): Promise<void> {
  assertForwardDatabase(database, journal);
  if (!journal.databaseCapabilities.foundation) return;
  const pathSchema = z.object({
    canonical_checkout_path: z.string().min(1).max(4_096),
    recovery_manifest_path: z.string().min(1).max(4_096).nullable(),
  }).strict();
  const values: unknown[] = database.query(`
    SELECT canonical_checkout_path, recovery_manifest_path
    FROM workspace_leases ORDER BY lane_id LIMIT ?1
  `).all(maximumLanes + 1);
  for (const row of z.array(pathSchema).max(maximumLanes).parse(values)) {
    if (
      row.canonical_checkout_path === journal.legacyRoot
      || ownedRelative(journal.legacyRoot, row.canonical_checkout_path) !== null
      || (
        row.recovery_manifest_path !== null
        && (
          row.recovery_manifest_path === journal.legacyRoot
          || ownedRelative(journal.legacyRoot, row.recovery_manifest_path) !== null
        )
      )
    ) {
      throw conflicting("A completed repair contains a legacy-root path");
    }
  }
  if (journal.databaseCapabilities.chatWorkspaceBindings) {
    const bindingValues: unknown[] = database.query(`
      SELECT canonical_checkout_path, recovery_manifest_path
      FROM chat_pane_workspace_bindings ORDER BY binding_id LIMIT ?1
    `).all(maximumBindings + 1);
    const bindingPathSchema = z.object({
      canonical_checkout_path: z.string().min(1).max(4_096),
      recovery_manifest_path: z.string().min(1).max(4_096),
    }).strict();
    for (const row of z.array(bindingPathSchema).max(maximumBindings).parse(
      bindingValues,
    )) {
      if (
        row.canonical_checkout_path === journal.legacyRoot
        || ownedRelative(journal.legacyRoot, row.canonical_checkout_path) !== null
        || row.recovery_manifest_path === journal.legacyRoot
        || ownedRelative(journal.legacyRoot, row.recovery_manifest_path) !== null
      ) {
        throw conflicting("A completed repair contains a legacy chat binding path");
      }
    }
  }
  for (const lane of journal.lanes) {
    if (
      lane.repairKind !== "linked"
      && await repairPathKind(lane.targetCheckoutPath, "managed checkout") !== "missing"
    ) {
      throw invalidDatabase(
        "A non-linked repair unexpectedly gained a physical managed checkout",
      );
    }
    if (lane.repairKind === "databaseOnly") {
      if (
        lane.targetManifestPath !== null
        && await repairPathKind(lane.targetManifestPath, "recovery manifest") !== "missing"
      ) {
        throw invalidManifest(
          "A database-only repair unexpectedly gained a recovery manifest",
          lane.targetManifestPath,
        );
      }
      continue;
    }
    if (
      lane.targetManifestPath === null
      || lane.manifest === null
      || (lane.manifest.version === 1 && lane.branchName === null)
    ) {
      throw invalidDatabase("A manifest-bearing repair journal lost its identity");
    }
    const manifest = await readManifest(lane.targetManifestPath);
    if (
      manifest.runId !== lane.laneId
      || manifest.laneId !== lane.laneId
      || manifest.canonicalCheckoutPath !== lane.targetCheckoutPath
      || manifest.canonicalRepositoryPath !== lane.repositoryPath
      || manifest.canonicalGitCommonDir !== lane.gitCommonDir
      || manifest.baseSha !== lane.baseSha
      || manifestBranchName(manifest) !== lane.branchName
    ) {
      throw invalidManifest(
        "Completed recovery manifest conflicts with its repair receipt",
        lane.targetManifestPath,
      );
    }
  }
}

function assertLaneSet(database: Database, journal: Journal): void {
  if (!journal.databaseCapabilities.foundation) {
    if (journal.lanes.length !== 0) {
      throw invalidDatabase("A pre-foundation repair journal contains workspace lanes");
    }
    return;
  }
  const values: unknown[] = database.query(
    "SELECT lane_id FROM workspace_leases ORDER BY lane_id LIMIT ?1",
  ).all(maximumLanes + 1);
  const observed = z.array(z.object({ lane_id: z.string() }).strict())
    .max(maximumLanes).parse(values).map((row) => row.lane_id);
  const expected = journal.lanes.map((lane) => lane.laneId);
  if (observed.length !== expected.length || observed.some((id, index) => id !== expected[index])) {
    throw invalidDatabase("Workspace lease inventory changed during repair");
  }
}

function assertPathsKnown(database: Database, lane: Lane): void {
  const observed = workspacePaths(database, lane.laneId);
  const legacy = observed.checkout === lane.legacyCheckoutPath
    && observed.manifest === lane.legacyManifestPath;
  const target = observed.checkout === lane.targetCheckoutPath
    && observed.manifest === lane.targetManifestPath;
  if (!legacy && !target) throw conflicting("Workspace lease has an unowned path generation");
}

function chatBindingPaths(
  database: Database,
  lane: Lane,
): readonly {
  readonly bindingId: string;
  readonly checkout: string;
  readonly manifest: string;
}[] {
  const values: unknown[] = database.query(`
    SELECT binding_id, canonical_checkout_path, recovery_manifest_path
    FROM chat_pane_workspace_bindings
    WHERE workspace_lease_id = ?1
    ORDER BY binding_id
    LIMIT ?2
  `).all(lane.laneId, maximumBindings + 1);
  const rows = z.array(z.object({
    binding_id: z.string().min(16).max(96),
    canonical_checkout_path: z.string().min(1).max(4_096),
    recovery_manifest_path: z.string().min(1).max(4_096),
  }).strict()).max(maximumBindings).parse(values);
  const expected = lane.chatBindingIds;
  if (
    rows.length !== expected.length
    || rows.some((row, index) => row.binding_id !== expected[index])
  ) {
    throw invalidDatabase("Chat workspace binding inventory changed during repair");
  }
  return rows.map((row) => ({
    bindingId: row.binding_id,
    checkout: row.canonical_checkout_path,
    manifest: row.recovery_manifest_path,
  }));
}

function assertChatBindingsKnown(database: Database, lane: Lane): void {
  const paths = chatBindingPaths(database, lane);
  if (paths.length === 0) return;
  const lease = workspacePaths(database, lane.laneId);
  if (lease.manifest === null) {
    throw invalidDatabase("A chat workspace binding lacks manifest identity");
  }
  if (paths.some((row) =>
    row.checkout !== lease.checkout || row.manifest !== lease.manifest
  )) {
    throw conflicting("Chat workspace bindings disagree with their workspace lease");
  }
}

function assertChatBindingsAt(
  database: Database,
  lane: Lane,
  orientation: "legacy" | "target",
): void {
  const paths = chatBindingPaths(database, lane);
  if (paths.length === 0) return;
  const expectedCheckout = orientation === "legacy"
    ? lane.legacyCheckoutPath
    : lane.targetCheckoutPath;
  const expectedManifest = orientation === "legacy"
    ? lane.legacyManifestPath
    : lane.targetManifestPath;
  if (
    expectedManifest === null
    || paths.some((row) =>
      row.checkout !== expectedCheckout || row.manifest !== expectedManifest
    )
  ) {
    throw conflicting("Chat workspace bindings did not retain repaired paths");
  }
}

function rewriteChatBindingPaths(
  database: Database,
  lane: Lane,
  orientation: "legacy" | "target",
): void {
  if (lane.chatBindingIds.length === 0) return;
  const checkout = orientation === "legacy"
    ? lane.legacyCheckoutPath
    : lane.targetCheckoutPath;
  const manifest = orientation === "legacy"
    ? lane.legacyManifestPath
    : lane.targetManifestPath;
  if (manifest === null) {
    throw invalidDatabase("A chat workspace binding lacks manifest identity");
  }
  for (const bindingId of lane.chatBindingIds) {
    const changes = database.query(`
      UPDATE chat_pane_workspace_bindings
      SET canonical_checkout_path = ?2, recovery_manifest_path = ?3
      WHERE binding_id = ?1 AND workspace_lease_id = ?4
    `).run(bindingId, checkout, manifest, lane.laneId).changes;
    if (changes !== 1) {
      throw invalidDatabase("Chat workspace binding changed during repair");
    }
  }
}

function workspacePaths(database: Database, laneId: string): {
  readonly checkout: string;
  readonly manifest: string | null;
  readonly status: string;
  readonly updatedAt: string;
} {
  const value: unknown = database.query(`
    SELECT canonical_checkout_path, recovery_manifest_path, status, updated_at
    FROM workspace_leases WHERE lane_id = ?1
  `).get(laneId);
  const row = z.object({
    canonical_checkout_path: z.string(),
    recovery_manifest_path: z.string().nullable(),
    status: z.string(),
    updated_at: z.string(),
  }).strict().parse(value);
  return {
    checkout: row.canonical_checkout_path,
    manifest: row.recovery_manifest_path,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function assertLeaseDispositionKnown(
  database: Database,
  lane: Lane,
  migrationTimestamp: string,
): void {
  const observed = workspacePaths(database, lane.laneId);
  const original = observed.status === lane.leaseStatus
    && observed.updatedAt === lane.leaseUpdatedAt;
  const forward = forwardLeaseDisposition(lane, migrationTimestamp);
  const migrated = observed.status === forward.status
    && observed.updatedAt === forward.updatedAt;
  if (!original && !migrated) {
    throw invalidDatabase("Workspace lease disposition changed during repair");
  }
}

function interruptedChatProvisioningState(
  database: Database,
  lane: Lane,
  migrationTimestamp: string,
): "original" | "migrated" | "reversed" | null {
  if (lane.chatProvisioningRecoveries.length === 0) return null;
  const leaseValue: unknown = database.query(`
    SELECT status, updated_at, quarantine_reason, quarantined_at
    FROM workspace_leases WHERE lane_id = ?1
  `).get(lane.laneId);
  const lease = z.object({
    status: z.string(),
    updated_at: z.string(),
    quarantine_reason: z.string().nullable(),
    quarantined_at: z.string().nullable(),
  }).strict().parse(leaseValue);
  const leaseOriginal = lease.status === "provisioning"
    && lease.updated_at === lane.leaseUpdatedAt
    && lease.quarantine_reason === null
    && lease.quarantined_at === null;
  const leaseMigrated = lease.status === "quarantined"
    && lease.updated_at === migrationTimestamp
    && lease.quarantine_reason === chatProvisionInterruptedReason
    && lease.quarantined_at === migrationTimestamp;
  if (!leaseOriginal && !leaseMigrated) {
    throw invalidDatabase("Interrupted chat lease recovery evidence changed");
  }

  let observedState: "original" | "migrated" | "reversed" | null = null;
  for (const recovery of lane.chatProvisioningRecoveries) {
    const value: unknown = database.query(`
      SELECT binding.state, binding.revision AS binding_revision,
        binding.recovery_reason, binding.updated_at AS binding_updated_at,
        pane.workspace_state, pane.workspace_revision,
        pane.workspace_recovery_reason, pane.revision AS pane_revision,
        pane.updated_at AS pane_updated_at
      FROM chat_pane_workspace_bindings AS binding
      JOIN chat_panes AS pane ON pane.pane_id = binding.pane_id
      WHERE binding.binding_id = ?1 AND binding.workspace_lease_id = ?2
        AND binding.pane_id = ?3
    `).get(recovery.bindingId, lane.laneId, recovery.paneId);
    const row = z.object({
      state: z.string(),
      binding_revision: z.number().int().positive().safe(),
      recovery_reason: z.string().nullable(),
      binding_updated_at: z.string(),
      workspace_state: z.string(),
      workspace_revision: z.number().int().positive().safe(),
      workspace_recovery_reason: z.string().nullable(),
      pane_revision: z.number().int().positive().safe(),
      pane_updated_at: z.string(),
    }).strict().parse(value);
    const original = row.state === "provisioning"
      && row.binding_revision === recovery.bindingRevision
      && row.recovery_reason === null
      && row.binding_updated_at === recovery.bindingUpdatedAt
      && row.workspace_state === "preparing"
      && row.workspace_revision === recovery.paneWorkspaceRevision
      && row.workspace_recovery_reason === null
      && row.pane_revision === recovery.paneRevision
      && row.pane_updated_at === recovery.paneUpdatedAt;
    const migrated = row.state === "recovery_required"
      && row.binding_revision === recovery.bindingRevision + 1
      && row.recovery_reason === chatProvisionInterruptedReason
      && row.binding_updated_at === migrationTimestamp
      && row.workspace_state === "recovery_required"
      && row.workspace_revision === recovery.paneWorkspaceRevision + 1
      && row.workspace_recovery_reason === chatProvisionInterruptedReason
      && row.pane_revision === recovery.paneRevision + 1
      && row.pane_updated_at === migrationTimestamp;
    const reversed = row.state === "provisioning"
      && row.binding_revision === recovery.bindingRevision + 2
      && row.recovery_reason === null
      && row.binding_updated_at === migrationTimestamp
      && row.workspace_state === "preparing"
      && row.workspace_revision === recovery.paneWorkspaceRevision + 2
      && row.workspace_recovery_reason === null
      && row.pane_revision === recovery.paneRevision + 2
      && row.pane_updated_at === migrationTimestamp;
    const rowState = original
      ? "original"
      : migrated
        ? "migrated"
        : reversed
          ? "reversed"
          : null;
    if (
      rowState === null ||
      (leaseMigrated && rowState !== "migrated") ||
      (leaseOriginal && rowState === "migrated") ||
      (observedState !== null && observedState !== rowState)
    ) {
      throw invalidDatabase("Interrupted chat workspace recovery evidence changed");
    }
    observedState = rowState;
  }
  return observedState ?? (leaseOriginal ? "original" : "migrated");
}

function enterInterruptedChatProvisioningRecovery(
  database: Database,
  lane: Lane,
  migrationTimestamp: string,
): void {
  for (const recovery of lane.chatProvisioningRecoveries) {
    const binding = database.query(`
      UPDATE chat_pane_workspace_bindings
      SET state = 'recovery_required', revision = ?4,
        recovery_reason = ?5, updated_at = ?6
      WHERE binding_id = ?1 AND workspace_lease_id = ?2 AND pane_id = ?3
        AND state = 'provisioning' AND revision = ?7
        AND recovery_reason IS NULL AND updated_at = ?8
    `).run(
      recovery.bindingId,
      lane.laneId,
      recovery.paneId,
      recovery.bindingRevision + 1,
      chatProvisionInterruptedReason,
      migrationTimestamp,
      recovery.bindingRevision,
      recovery.bindingUpdatedAt,
    );
    const pane = database.query(`
      UPDATE chat_panes
      SET workspace_state = 'recovery_required', workspace_revision = ?2,
        workspace_recovery_reason = ?3, revision = ?4, updated_at = ?5
      WHERE pane_id = ?1 AND workspace_state = 'preparing'
        AND workspace_revision = ?6 AND workspace_recovery_reason IS NULL
        AND revision = ?7 AND updated_at = ?8 AND archived_at IS NULL
    `).run(
      recovery.paneId,
      recovery.paneWorkspaceRevision + 1,
      chatProvisionInterruptedReason,
      recovery.paneRevision + 1,
      migrationTimestamp,
      recovery.paneWorkspaceRevision,
      recovery.paneRevision,
      recovery.paneUpdatedAt,
    );
    if (binding.changes !== 1 || pane.changes !== 1) {
      throw invalidDatabase("Interrupted chat provisioning recovery raced another writer");
    }
  }
}

function reverseInterruptedChatProvisioningRecovery(
  database: Database,
  lane: Lane,
  migrationTimestamp: string,
): void {
  for (const recovery of lane.chatProvisioningRecoveries) {
    const binding = database.query(`
      UPDATE chat_pane_workspace_bindings
      SET state = 'provisioning', revision = ?4,
        recovery_reason = NULL, updated_at = ?5
      WHERE binding_id = ?1 AND workspace_lease_id = ?2 AND pane_id = ?3
        AND state = 'recovery_required' AND revision = ?6
        AND recovery_reason = ?7
    `).run(
      recovery.bindingId,
      lane.laneId,
      recovery.paneId,
      recovery.bindingRevision + 2,
      migrationTimestamp,
      recovery.bindingRevision + 1,
      chatProvisionInterruptedReason,
    );
    const pane = database.query(`
      UPDATE chat_panes
      SET workspace_state = 'preparing', workspace_revision = ?2,
        workspace_recovery_reason = NULL, revision = ?3, updated_at = ?4
      WHERE pane_id = ?1 AND workspace_state = 'recovery_required'
        AND workspace_revision = ?5 AND workspace_recovery_reason = ?6
        AND revision = ?7 AND archived_at IS NULL
    `).run(
      recovery.paneId,
      recovery.paneWorkspaceRevision + 2,
      recovery.paneRevision + 2,
      migrationTimestamp,
      recovery.paneWorkspaceRevision + 1,
      chatProvisionInterruptedReason,
      recovery.paneRevision + 1,
    );
    if (binding.changes !== 1 || pane.changes !== 1) {
      throw invalidDatabase("Interrupted chat provisioning reversal raced another writer");
    }
  }
}

function normalizeReversedChatProvisioning(
  database: Database,
  journal: Journal,
): Journal {
  return {
    ...journal,
    lanes: journal.lanes.map((lane) => {
      if (
        interruptedChatProvisioningState(
          database,
          lane,
          journal.migrationTimestamp,
        ) !== "reversed"
      ) return lane;
      return {
        ...lane,
        chatProvisioningRecoveries: lane.chatProvisioningRecoveries.map(
          (recovery) => ({
            ...recovery,
            bindingRevision: recovery.bindingRevision + 2,
            bindingUpdatedAt: journal.migrationTimestamp,
            paneRevision: recovery.paneRevision + 2,
            paneUpdatedAt: journal.migrationTimestamp,
            paneWorkspaceRevision: recovery.paneWorkspaceRevision + 2,
          }),
        ),
      };
    }),
  };
}

function forwardLeaseDisposition(
  lane: Pick<
    Lane,
    "chatProvisioningRecoveries" | "leaseStatus" | "leaseUpdatedAt"
  >,
  migrationTimestamp: string,
): { readonly status: LeaseStatus; readonly updatedAt: string } {
  return lane.leaseStatus === "provisioning"
    ? {
        status: lane.chatProvisioningRecoveries.length > 0
          ? "quarantined"
          : "preserved",
        updatedAt: migrationTimestamp,
      }
    : { status: lane.leaseStatus, updatedAt: lane.leaseUpdatedAt };
}

function assertThreadKnown(
  database: Database,
  laneId: string,
  original: Lane["threads"][number],
  migrationTimestamp: string,
): void {
  const value: unknown = database.query(`
    SELECT archived, updated_at FROM thread_bindings
    WHERE lane_id = ?1 AND thread_id = ?2
  `).get(laneId, original.threadId);
  const observed = z.object({
    archived: z.number().int(),
    updated_at: z.string(),
  }).strict().parse(value);
  if (
    !(
      observed.archived === original.archived
      && observed.updated_at === original.updatedAt
    )
    && !(
      observed.archived === 1
      && observed.updated_at === migrationTimestamp
    )
  ) {
    throw invalidDatabase("Codex thread binding changed during repair");
  }
}

function assertDispatchKnown(
  database: Database,
  laneId: string,
  original: Lane["dispatches"][number],
  migrationTimestamp: string,
): void {
  const value: unknown = database.query(`
    SELECT stage, failure_code, updated_at FROM dispatch_bindings
    WHERE lane_id = ?1 AND run_id = ?2
  `).get(laneId, original.runId);
  const observed = z.object({
    stage: z.string(),
    failure_code: z.string().nullable(),
    updated_at: z.string(),
  }).strict().parse(value);
  const unchanged = observed.stage === original.stage
    && observed.failure_code === original.failureCode
    && observed.updated_at === original.updatedAt;
  const quarantined = !terminalStages.has(original.stage)
    && observed.stage === "ambiguous"
    && observed.failure_code === movedCwdFailureCode
    && observed.updated_at === migrationTimestamp;
  if (!unchanged && !quarantined) throw invalidDatabase("Dispatch binding changed during repair");
}

async function replaceManifest(lane: Lane, orientation: "legacy" | "target"): Promise<void> {
  const targetManifestPath = lane.targetManifestPath;
  const expectedManifest = lane.manifest;
  if (targetManifestPath === null || expectedManifest === null) {
    throw invalidDatabase("A manifest repair lacks its durable identity");
  }
  const observed = await readManifest(targetManifestPath);
  if (
    observed.runId !== expectedManifest.runId
    || observed.laneId !== expectedManifest.laneId
    || observed.canonicalRepositoryPath !== lane.repositoryPath
    || observed.canonicalGitCommonDir !== lane.gitCommonDir
    || observed.baseSha !== lane.baseSha
    || manifestBranchName(observed) !== lane.branchName
    || ![lane.legacyCheckoutPath, lane.targetCheckoutPath].includes(
      observed.canonicalCheckoutPath,
    )
  ) {
    throw invalidManifest("Recovery manifest conflicts with repair journal", targetManifestPath);
  }
  const next: Manifest = {
    ...expectedManifest,
    canonicalCheckoutPath: orientation === "legacy"
      ? lane.legacyCheckoutPath
      : lane.targetCheckoutPath,
  };
  await replacePrivateFile(
    targetManifestPath,
    `${JSON.stringify(manifestSchema.parse(next))}\n`,
    maximumManifestBytes,
  );
}

async function repairGitLane(git: GitRunner, lane: Lane): Promise<void> {
  await assertDirectory(lane.repositoryPath, "repository");
  await assertDirectory(lane.targetCheckoutPath, "managed checkout");
  const result = await git.run(lane.repositoryPath, [
    "worktree",
    "repair",
    lane.targetCheckoutPath,
  ]);
  if (result.exitCode !== 0) {
    throw new ApplicationSupportWorktreeRepairError(
      "git_repair_failed",
      "Bundled Git could not repair a moved worktree",
      {
        cause: new GitCommandError(["worktree", "repair"], result),
        rollbackSafe: false,
      },
    );
  }
}

async function assertLegacyLinkedCandidate(git: GitRunner, lane: Lane): Promise<void> {
  try {
    const listing = await gitText(git, lane.repositoryPath, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const paths = worktreePaths(listing);
    if (
      !paths.includes(lane.legacyCheckoutPath)
      || paths.includes(lane.targetCheckoutPath)
    ) {
      throw gitError("Git does not prove the legacy managed-worktree registration");
    }

    const laneGitFile = join(lane.targetCheckoutPath, ".git");
    const source = await readBounded(laneGitFile, maximumManifestBytes, "Git link");
    const match = /^gitdir: (.+)\n?$/u.exec(source);
    if (match?.[1] === undefined || !isAbsolute(match[1])) {
      throw gitError("The managed-worktree Git link is invalid");
    }
    const administrative = await realpath(match[1]);
    if (ownedRelative(join(lane.gitCommonDir, "worktrees"), administrative) === null) {
      throw gitError("The managed-worktree Git link escapes its common directory");
    }
    const backlink = await readBounded(
      join(administrative, "gitdir"),
      maximumManifestBytes,
      "Git backlink",
    );
    if (backlink.trimEnd() !== join(lane.legacyCheckoutPath, ".git")) {
      throw gitError("Git does not prove the legacy managed-worktree backlink");
    }
  } catch (error: unknown) {
    if (
      error instanceof ApplicationSupportWorktreeRepairError
      && !error.rollbackSafe
    ) {
      throw error;
    }
    throw new ApplicationSupportWorktreeRepairError(
      "git_verification_failed",
      "A physical managed checkout is not proven as a linked worktree",
      { cause: error, rollbackSafe: false, path: lane.targetCheckoutPath },
    );
  }
}

async function verifyGitLane(git: GitRunner, lane: Lane): Promise<void> {
  const checkout = await realpath(lane.targetCheckoutPath);
  if (checkout !== lane.targetCheckoutPath) throw gitError("Checkout resolved through another path");
  const top = await gitText(git, checkout, ["rev-parse", "--show-toplevel"]);
  if (await realpath(top) !== checkout) throw gitError("Git reports another worktree root");
  const common = await gitText(git, checkout, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (await realpath(common) !== lane.gitCommonDir) throw gitError("Git common dir changed");
  const expectedBranch = lane.workspaceMode === "harness_read_only_snapshot"
    ? ""
    : lane.branchName;
  if (await gitText(git, checkout, ["branch", "--show-current"]) !== expectedBranch) {
    throw gitError("Worktree branch changed");
  }
  const head = await gitText(git, checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!commitPattern.test(head)) throw gitError("Worktree HEAD is invalid");
  if (
    lane.workspaceMode === "harness_read_only_snapshot" &&
    head !== lane.baseSha
  ) {
    throw gitError("Read-only snapshot HEAD changed");
  }
  if (
    await gitText(git, checkout, ["rev-parse", "--verify", `${lane.baseSha}^{commit}`])
    !== lane.baseSha
  ) {
    throw gitError("Worktree base commit is unavailable");
  }
  if (lane.workspaceMode === "harness_read_only_snapshot") {
    const status = await gitText(git, checkout, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status !== "") throw gitError("Read-only snapshot is dirty");
  }
  const list = await gitText(git, lane.repositoryPath, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const paths = worktreePaths(list);
  if (!paths.includes(lane.targetCheckoutPath) || paths.includes(lane.legacyCheckoutPath)) {
    throw gitError("Git worktree inventory retains the wrong path");
  }
  const prune = await git.run(lane.repositoryPath, [
    "worktree",
    "prune",
    "--dry-run",
    "--verbose",
    "--expire",
    "now",
  ]);
  if (
    prune.exitCode !== 0
    || `${prune.stdout}\n${prune.stderr}`.includes(lane.targetCheckoutPath)
  ) {
    throw gitError("Git considers the repaired worktree prunable", prune);
  }
  await verifyGitLinkFiles(lane);
}

async function assertLegacyGitMetadata(git: GitRunner, lane: Lane): Promise<void> {
  const list = await gitText(git, lane.repositoryPath, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const paths = worktreePaths(list);
  if (!paths.includes(lane.legacyCheckoutPath) || paths.includes(lane.targetCheckoutPath)) {
    throw gitError("External Git metadata changed before the irreversible marker");
  }
}

async function verifyGitLinkFiles(lane: Lane): Promise<void> {
  const laneGitFile = join(lane.targetCheckoutPath, ".git");
  const source = await readBounded(laneGitFile, maximumManifestBytes, "Git link");
  const match = /^gitdir: (.+)\n?$/u.exec(source);
  if (match?.[1] === undefined || !isAbsolute(match[1])) throw gitError("Git link is invalid");
  const administrative = await realpath(match[1]);
  if (ownedRelative(join(lane.gitCommonDir, "worktrees"), administrative) === null) {
    throw gitError("Git link escapes the common directory");
  }
  const backlink = await readBounded(
    join(administrative, "gitdir"),
    maximumManifestBytes,
    "Git backlink",
  );
  if (backlink.trimEnd() !== laneGitFile) throw gitError("Git backlink retains the old lane");
}

async function gitText(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
  rollbackSafe = false,
): Promise<string> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw gitError("Bundled Git verification failed", result, rollbackSafe);
  return result.stdout;
}

function worktreePaths(source: string): readonly string[] {
  return source.split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}

async function validateRoots(
  legacyRoot: string,
  targetRoot: string,
): Promise<{ readonly legacy: string; readonly target: string }> {
  const legacy = normalizedPath(legacyRoot, "legacy root");
  const target = normalizedPath(targetRoot, "target root");
  if (legacy === target || dirname(legacy) !== dirname(target)) {
    throw unsafe("Migration roots must be distinct siblings");
  }
  await assertDirectory(target, "target root");
  return { legacy, target };
}

async function repairPathKind(
  path: string,
  label: string,
): Promise<"directory" | "file" | "missing"> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  if (metadata === null) return "missing";
  if (metadata.isSymbolicLink()) throw unsafe(`${label} must not be a symbolic link`, path);
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  throw unsafe(`${label} must not be a FIFO, socket, or device`, path);
}

function pathPair(
  observedPath: string,
  legacyRoot: string,
  targetRoot: string,
): { readonly orientation: "legacy" | "target"; readonly legacy: string; readonly target: string } {
  const observed = normalizedPath(observedPath, "persisted worktree path");
  const fromLegacy = ownedRelative(legacyRoot, observed);
  if (fromLegacy !== null) {
    return { orientation: "legacy", legacy: observed, target: join(targetRoot, fromLegacy) };
  }
  const fromTarget = ownedRelative(targetRoot, observed);
  if (fromTarget !== null) {
    return { orientation: "target", legacy: join(legacyRoot, fromTarget), target: observed };
  }
  throw conflicting("Persisted worktree path is outside both migration roots", observed);
}

function assertExternal(path: string, legacyRoot: string, targetRoot: string): void {
  const normalized = normalizedPath(path, "repository identity");
  if (
    normalized === legacyRoot
    || normalized === targetRoot
    || ownedRelative(legacyRoot, normalized) !== null
    || ownedRelative(targetRoot, normalized) !== null
  ) {
    throw conflicting("Managed-worktree repository must remain external", normalized);
  }
}

function ownedRelative(root: string, path: string): string | null {
  const candidate = relative(root, path);
  return candidate.length === 0
    || candidate === ".."
    || candidate.startsWith("../")
    || isAbsolute(candidate)
    ? null
    : candidate;
}

function normalizedPath(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0") || resolve(path) !== path) {
    throw unsafe(`${label} must be a normalized absolute path`, path);
  }
  return path;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch((cause: unknown) => {
    throw unsafe(`${label} is unavailable`, path, cause);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw unsafe(`${label} must be a real directory`, path);
  }
}

async function readManifest(path: string): Promise<Manifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readBounded(path, maximumManifestBytes, "manifest")) as unknown;
  } catch (cause: unknown) {
    if (cause instanceof ApplicationSupportWorktreeRepairError) throw cause;
    throw invalidManifest("Recovery manifest is not valid JSON", path, cause);
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw invalidManifest("Recovery manifest is invalid", path);
  return parsed.data;
}

async function readJournal(targetRoot: string): Promise<Journal | null> {
  const path = worktreeRepairJournalPath(targetRoot);
  const metadata = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  if (metadata === null) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ApplicationSupportWorktreeRepairError(
      "invalid_journal",
      "Worktree repair journal must be a regular file",
      { path },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readBounded(path, maximumJournalBytes, "journal")) as unknown;
  } catch (cause: unknown) {
    if (cause instanceof ApplicationSupportWorktreeRepairError) throw cause;
    throw new ApplicationSupportWorktreeRepairError(
      "invalid_journal",
      "Worktree repair journal is not valid JSON",
      { cause, path },
    );
  }
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationSupportWorktreeRepairError(
      "invalid_journal",
      "Worktree repair journal is invalid",
      { path },
    );
  }
  return parsed.data;
}

async function readBounded(path: string, maximum: number, label: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause: unknown) {
    throw unsafe(`${label} cannot be opened without following links`, path, cause);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximum) {
      throw unsafe(`${label} has an invalid size`, path);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeJournal(targetRoot: string, journal: Journal): Promise<void> {
  const parsed = journalSchema.parse(journal);
  await replacePrivateFile(
    worktreeRepairJournalPath(targetRoot),
    `${JSON.stringify(parsed)}\n`,
    maximumJournalBytes,
  );
}

async function replacePrivateFile(path: string, source: string, maximum: number): Promise<void> {
  if (Buffer.byteLength(source) > maximum) throw unsafe("Repair metadata is too large", path);
  const parent = dirname(path);
  await assertDirectory(parent, "repair metadata parent");
  const existing = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) {
    throw unsafe("Repair metadata cannot replace a non-regular file", path);
  }
  const candidate = `${path}.tmp`;
  const candidateMetadata = await lstat(candidate).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  if (candidateMetadata !== null) {
    const parentMetadata = await lstat(parent);
    if (
      !candidateMetadata.isFile() ||
      candidateMetadata.isSymbolicLink() ||
      candidateMetadata.uid !== process.geteuid?.() ||
      candidateMetadata.nlink !== 1 ||
      (candidateMetadata.mode & 0o777) !== 0o600 ||
      candidateMetadata.size < 0 ||
      candidateMetadata.size > maximum ||
      candidateMetadata.dev !== parentMetadata.dev
    ) {
      throw unsafe("Repair metadata candidate is unsafe", candidate);
    }
    await unlink(candidate);
    await syncDirectory(parent);
  }
  let handle = await open(
    candidate,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(source, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null as never;
    await rename(candidate, path);
    await chmod(path, 0o600);
    await syncDirectory(parent);
  } finally {
    if (handle !== null) await handle.close();
    await unlink(candidate).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) {
        // A private orphan candidate is safer than masking the durable result.
      }
    });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertJournalRoots(
  journal: Journal,
  roots: { readonly legacy: string; readonly target: string },
): void {
  if (journal.legacyRoot !== roots.legacy || journal.targetRoot !== roots.target) {
    throw new ApplicationSupportWorktreeRepairError(
      "invalid_journal",
      "Worktree repair journal names different roots",
    );
  }
}

function requiredLane(journal: Journal, index: number): Lane {
  const lane = journal.lanes[index];
  if (lane === undefined) throw new Error("Repair journal lane index is invalid");
  return lane;
}

function replaceLane(journal: Journal, index: number, lane: Lane): Journal {
  return {
    ...journal,
    lanes: journal.lanes.map((current, currentIndex) => (
      currentIndex === index ? lane : current
    )),
  };
}

function result(journal: Journal, targetRoot: string): ApplicationSupportWorktreeRepairResult {
  return {
    journalPath: worktreeRepairJournalPath(targetRoot),
    repairedLaneIds: journal.lanes.map((lane) => lane.laneId),
    archivedCodexThreadIds: journal.lanes.flatMap((lane) => (
      lane.threads.map((thread) => thread.codexThreadId)
    )),
    ambiguousRunIds: journal.lanes.flatMap((lane) => (
      lane.dispatches
        .filter((dispatch) => !terminalStages.has(dispatch.stage))
        .map((dispatch) => dispatch.runId)
    )),
    codexCwdPolicy: "archive_threads_and_quarantine_nonterminal_runs",
    irreversibleForward: journal.irreversibleForward,
  };
}

function checkpoint(
  options: ApplicationSupportWorktreeRepairOptions,
  point: ApplicationSupportWorktreeRepairFaultPoint,
  laneId: string | null,
): void {
  options.onCheckpoint?.(point, laneId);
}

function invalidDatabase(message: string): ApplicationSupportWorktreeRepairError {
  return new ApplicationSupportWorktreeRepairError("invalid_database", message);
}

function conflicting(message: string, path?: string): ApplicationSupportWorktreeRepairError {
  return new ApplicationSupportWorktreeRepairError(
    "conflicting_paths",
    message,
    path === undefined ? {} : { path },
  );
}

function invalidManifest(
  message: string,
  path: string,
  cause?: unknown,
): ApplicationSupportWorktreeRepairError {
  return new ApplicationSupportWorktreeRepairError(
    "invalid_manifest",
    message,
    cause === undefined ? { path } : { cause, path },
  );
}

function unsafe(message: string, path?: string, cause?: unknown): ApplicationSupportWorktreeRepairError {
  return new ApplicationSupportWorktreeRepairError(
    "unsafe_path",
    message,
    { ...(path === undefined ? {} : { path }), ...(cause === undefined ? {} : { cause }) },
  );
}

function gitError(
  message: string,
  gitResult?: GitResult,
  rollbackSafe = false,
): ApplicationSupportWorktreeRepairError {
  return new ApplicationSupportWorktreeRepairError(
    "git_verification_failed",
    message,
    {
      ...(gitResult === undefined
        ? {}
        : { cause: new GitCommandError(["worktree", "verify"], gitResult) }),
      rollbackSafe,
    },
  );
}

function hasCode(error: unknown, expected: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === expected;
}
