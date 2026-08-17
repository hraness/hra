import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { dlopen, FFIType } from "bun:ffi";

import { z } from "@hra-internal/schema";
import {
  HRA_HUMAN_KEYCHAIN_SERVICE,
  HRA_RUNNER_KEYCHAIN_SERVICE,
  secretCustodyDescriptorSchema,
  secretCustodyJournalSchema,
  secretCustodyQuarantinePointerSchema,
  type SecretCustodyJournal,
} from "@hraness/hra-human-client";

import {
  authoritiesOverlap,
  inspectProspectivePathAuthority,
  renameWithPathAuthority,
} from "./installation-path-authority";
import { quitInstalledApplicationRoots } from "./installation-process-authority";
import { verifyPublishedReleaseCandidate } from "./release-download-contract";
import { fixedLocalDataRemovalPaths } from "./src/maintenance/local-data-removal-inventory";
import {
  acquireControlPlaneLifetimeLock,
  type ControlPlaneLifetimeLock,
} from "./src/state/control-plane-lock";
import {
  assertBoundedControlPlaneIntegrity,
  checkpointControlPlaneForApplicationSupportCutover,
} from "./src/state/database";
import { launchSmokeMacOSApp } from "./verify-macos-package";

const handoffConfirmation = "RETIRE-OPRTE-IN-FAVOR-OF-HRA";
const committedCleanupConfirmation = "CLEAN-COMMITTED-HRA-HANDOFF-STAGING";
const rollbackConfirmation = "ROLL-BACK-HRA-TO-OPRTE";
const expectedPredecessor = Object.freeze({
  build: "5",
  bundleIdentifier: "kitchen.hraness",
  executable: "oprte",
  version: "0.1.4",
});
const expectedCandidate = Object.freeze({
  build: "9",
  bundleIdentifier: "kitchen.hraness",
  executable: "hra",
  version: "0.1.8",
});
const expectedPriorHra = Object.freeze({
  build: "8",
  bundleIdentifier: "kitchen.hraness",
  executable: "hra",
  version: "0.1.7",
});
const maximumTreeEntries = 2_000_000;
const maximumTreeBytes = 128 * 1024 * 1024 * 1024;
const maximumJournalBytes = 1024 * 1024;
const commitPattern = /^[0-9a-f]{40}$/u;
const operationIdPattern = /^handoff_[a-f0-9]{24}$/u;

export type InstallationHandoffFaultPoint =
  | "after_full_backup"
  | "after_candidate_smoke"
  | "after_bundle_archives"
  | "after_candidate_staged"
  | "after_candidate_installed"
  | "after_predecessor_retired"
  | "after_continuity_verified"
  | "after_authority_committed"
  | "after_committed_predecessor_cleanup"
  | "after_committed_prior_hra_cleanup"
  | "after_rollback_bundles_staged"
  | "after_rollback_predecessor_published"
  | "after_rollback_hra_restored"
  | "after_rollback_committed";

export interface TreeEvidence {
  readonly bytes: number;
  readonly directories: number;
  readonly digest: string;
  readonly entries: number;
  readonly files: number;
  readonly symlinks: number;
}

export interface DatabaseContinuityEvidence {
  readonly databaseSha256: string;
  readonly migrationVersion: number;
  readonly quickCheck: "ok";
  readonly rows: Readonly<Record<string, number>>;
}

export interface StateContinuityEvidence {
  readonly accountHomes: number;
  readonly chatWorktreeLanes: number;
  readonly database: DatabaseContinuityEvidence;
  readonly dispatchWorktreeLanes: number;
  readonly harnessWorktreeLanes: number;
  readonly localTaskWorktreeLanes: number;
  readonly sessionEntries: number;
  readonly tree: TreeEvidence;
}

export interface BundleIdentity {
  readonly build: string;
  readonly bundleIdentifier: string;
  readonly executable: string;
  readonly version: string;
}

interface BundleContinuityEvidence {
  readonly identity: BundleIdentity;
  readonly tree: TreeEvidence;
}

interface KeychainEvidence {
  readonly descriptors: readonly string[];
  readonly fingerprints: ReadonlyMap<string, Buffer | null>;
  readonly key: Buffer;
}

export interface InstallationHandoffPaths {
  readonly applicationsDirectory: string;
  readonly candidateApp: string;
  readonly canonicalApp: string;
  readonly predecessorApp: string;
  readonly stateRoot: string;
  readonly controlPlanePath: string;
  readonly nativeInstanceLockPath: string;
  readonly updateHazardPath: string;
  readonly updateHazardTemporaryPath: string;
  readonly sparkleCacheRoots: readonly string[];
}

export interface InstallationHandoffInput {
  readonly backupDirectory: string;
  readonly candidateApp: string;
  readonly confirmation: string;
  readonly paths?: InstallationHandoffPaths;
  readonly onCheckpoint?: (point: InstallationHandoffFaultPoint) => void;
}

export interface InstallationRollbackInput {
  readonly backupDirectory: string;
  readonly confirmation: string;
  readonly paths?: InstallationHandoffPaths;
  readonly onCheckpoint?: (point: InstallationHandoffFaultPoint) => void;
}

export interface InstallationHandoffCleanupInput {
  readonly backupDirectory: string;
  readonly confirmation: string;
  readonly paths?: InstallationHandoffPaths;
  readonly onCheckpoint?: (point: InstallationHandoffFaultPoint) => void;
}

interface HandoffJournal {
  readonly schemaVersion: 1;
  readonly createdAt: number;
  readonly operationId: string;
  readonly phase:
    | "created"
    | "backed_up"
    | "smoked"
    | "bundles_archived"
    | "candidate_staged"
    | "candidate_installed"
    | "predecessor_retired"
    | "verified"
    | "committed"
    | "rolled_back";
  readonly candidateCommit: string;
  readonly hadPriorHra: boolean;
  readonly state: StateContinuityEvidence;
  readonly predecessor: BundleContinuityEvidence;
  readonly candidate: BundleContinuityEvidence;
  readonly priorHra?: BundleContinuityEvidence;
  readonly keychainDescriptors: readonly string[];
}

interface HeldLock {
  release(): void;
}

export interface InstallationHandoffDependencies {
  readonly acquireControlPlaneLock: (
    controlPlanePath: string,
  ) => ControlPlaneLifetimeLock;
  readonly acquireNativeLock: (path: string) => HeldLock;
  readonly copyTree: (source: string, destination: string) => Promise<void>;
  readonly keychainRead: (
    descriptor: Readonly<{ service: string; name: string }>,
  ) => Promise<string | null>;
  readonly now: () => number;
  readonly openFilesAreQuiescent: (
    paths: InstallationHandoffPaths,
  ) => Promise<boolean>;
  readonly publishBundle: (
    source: string,
    destination: string,
    exchange: boolean,
  ) => Promise<void>;
  readonly quitApplications: (
    bundleRoots: readonly string[],
  ) => Promise<void>;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly smokeCandidate: (path: string) => Promise<void>;
  readonly updaterIsQuiescent: (paths: InstallationHandoffPaths) => Promise<boolean>;
  readonly verifyCandidate: (path: string) => Promise<Readonly<{ commit: string }>>;
}

const defaultDependencies: InstallationHandoffDependencies = {
  acquireControlPlaneLock: acquireControlPlaneLifetimeLock,
  acquireNativeLock: acquireNativeInstallationLock,
  copyTree: copyTreeWithDitto,
  keychainRead: async ({ service, name }) => await Bun.secrets.get({ service, name }),
  now: Date.now,
  openFilesAreQuiescent: inspectOpenFileQuiescence,
  publishBundle: publishBundleWithPathAuthority,
  quitApplications: quitExactApplicationProcesses,
  randomBytes,
  smokeCandidate: launchSmokeMacOSApp,
  updaterIsQuiescent: inspectUpdaterQuiescence,
  verifyCandidate: verifyPublishedReleaseCandidate,
};

export class InstallationHandoffError extends Error {
  readonly code:
    | "app_running"
    | "backup_invalid"
    | "candidate_invalid"
    | "confirmation_invalid"
    | "continuity_failed"
    | "filesystem_unsafe"
    | "invalid_arguments"
    | "lock_unavailable"
    | "predecessor_invalid"
    | "rollback_unsafe"
    | "updater_active";

  constructor(code: InstallationHandoffError["code"], message: string) {
    super(message);
    this.name = "InstallationHandoffError";
    this.code = code;
  }
}

export function installationHandoffPaths(
  candidateAppValue: string,
  effectiveHome = userInfo().homedir,
  applicationsDirectory = "/Applications",
): InstallationHandoffPaths {
  const candidateApp = requireAbsoluteNormalized(candidateAppValue, "candidate app");
  const applications = requireAbsoluteNormalized(
    applicationsDirectory,
    "Applications directory",
  );
  const fixed = fixedLocalDataRemovalPaths(
    requireAbsoluteNormalized(effectiveHome, "effective-user home"),
  );
  const cacheParent = join(effectiveHome, "Library", "Caches");
  return {
    applicationsDirectory: applications,
    candidateApp,
    canonicalApp: join(applications, "HRA.app"),
    predecessorApp: join(applications, "OPRTE.app"),
    stateRoot: fixed.applicationSupportRoot,
    controlPlanePath: fixed.controlPlanePath,
    nativeInstanceLockPath: fixed.nativeInstanceLockPath,
    updateHazardPath: fixed.updateHazardPath,
    updateHazardTemporaryPath: fixed.updateHazardTemporaryPath,
    sparkleCacheRoots: [
      "kitchen.hraness",
      "com.jungle.oprte",
      "com.jungle.kitchen",
    ].map((identifier) => join(cacheParent, identifier, "org.sparkle-project.Sparkle")),
  };
}

export async function performInstallationHandoff(
  input: InstallationHandoffInput,
  dependencies: InstallationHandoffDependencies = defaultDependencies,
): Promise<Readonly<{
  operationId: string;
  backupDirectory: string;
  candidateCommit: string;
  stateDigest: string;
  status: "committed";
}>> {
  if (input.confirmation !== handoffConfirmation) {
    throw new InstallationHandoffError(
      "confirmation_invalid",
      `Confirmation must be ${handoffConfirmation}.`,
    );
  }
  const backupDirectory = requireAbsoluteNormalized(
    input.backupDirectory,
    "backup directory",
  );
  const paths = input.paths ?? installationHandoffPaths(input.candidateApp);
  const canonicalBackupDirectory = await validateHandoffPaths(
    paths,
    backupDirectory,
  );
  await requireMissing(backupDirectory, "Backup directory already exists.");

  const operationId = createOperationId(dependencies.randomBytes(12));
  await mkdir(backupDirectory, { mode: 0o700 });
  await chmod(backupDirectory, 0o700);
  await assertPrivateBackupDirectory(
    backupDirectory,
    canonicalBackupDirectory,
  );
  const nativeLock = await stopAndLock(paths, dependencies);
  let controlPlaneLock: ControlPlaneLifetimeLock | null = null;
  let journal: HandoffJournal | null = null;
  let keychainBefore: KeychainEvidence | null = null;
  try {
    controlPlaneLock = dependencies.acquireControlPlaneLock(paths.controlPlanePath);
    controlPlaneLock.bindControlPlane();
    await requireQuiescent(paths, dependencies);
    const predecessor = await inspectBundle(paths.predecessorApp);
    assertBundleIdentity(predecessor.identity, expectedPredecessor, "predecessor");
    const hadPriorHra = await exists(paths.canonicalApp);
    const priorHra = hadPriorHra
      ? await inspectBundle(paths.canonicalApp)
      : undefined;
    if (priorHra !== undefined) {
      assertSupportedPriorHraIdentity(priorHra.identity);
    }

    const candidate = await inspectBundle(paths.candidateApp);
    assertBundleIdentity(candidate.identity, expectedCandidate, "candidate");
    const candidateVerification = await dependencies.verifyCandidate(paths.candidateApp);
    const candidateCommit = requireCommit(candidateVerification.commit);
    if (candidateCommit.length !== 40) {
      throw new InstallationHandoffError(
        "candidate_invalid",
        "Candidate runtime provenance is invalid.",
      );
    }

    const state = await inspectStateContinuity(paths.stateRoot, paths.controlPlanePath);
    keychainBefore = await inspectKeychainContinuity(
      paths.controlPlanePath,
      dependencies,
    );
    const createdAt = dependencies.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new InstallationHandoffError("invalid_arguments", "Handoff time is invalid.");
    }
    journal = {
      schemaVersion: 1,
      createdAt,
      operationId,
      phase: "created",
      candidateCommit,
      hadPriorHra,
      state,
      predecessor,
      candidate,
      ...(priorHra === undefined ? {} : { priorHra }),
      keychainDescriptors: keychainBefore.descriptors,
    };
    await writeJournal(backupDirectory, journal);

    const stateBackup = join(backupDirectory, "state");
    await dependencies.copyTree(paths.stateRoot, stateBackup);
    const copiedState = await inspectStateContinuity(
      stateBackup,
      join(stateBackup, basename(paths.controlPlanePath)),
      false,
    );
    assertStateContinuity(state, copiedState, "full-state backup");
    journal = await advance(backupDirectory, journal, "backed_up");
    input.onCheckpoint?.("after_full_backup");

    await dependencies.smokeCandidate(paths.candidateApp);
    journal = await advance(backupDirectory, journal, "smoked");
    input.onCheckpoint?.("after_candidate_smoke");

    const predecessorArchive = join(backupDirectory, "predecessor.bundle");
    await dependencies.copyTree(paths.predecessorApp, predecessorArchive);
    assertTreeEvidence(
      predecessor.tree,
      await inspectTree(predecessorArchive),
      "predecessor archive",
    );
    if (priorHra !== undefined) {
      const priorHraArchive = join(backupDirectory, "prior-hra.bundle");
      await dependencies.copyTree(paths.canonicalApp, priorHraArchive);
      assertTreeEvidence(
        priorHra.tree,
        await inspectTree(priorHraArchive),
        "prior HRA archive",
      );
    }
    journal = await advance(backupDirectory, journal, "bundles_archived");
    input.onCheckpoint?.("after_bundle_archives");

    const candidateStage = join(
      paths.applicationsDirectory,
      `.${operationId}.candidate.bundle`,
    );
    await requireMissing(candidateStage, "Candidate staging path already exists.");
    await dependencies.copyTree(paths.candidateApp, candidateStage);
    const stagedVerification = await dependencies.verifyCandidate(candidateStage);
    if (stagedVerification.commit !== candidateCommit) {
      throw new InstallationHandoffError(
        "candidate_invalid",
        "Staged candidate provenance differs from the verified source candidate.",
      );
    }
    assertTreeEvidence(candidate.tree, await inspectTree(candidateStage), "staged candidate");
    journal = await advance(backupDirectory, journal, "candidate_staged");
    input.onCheckpoint?.("after_candidate_staged");

    await dependencies.publishBundle(
      candidateStage,
      paths.canonicalApp,
      priorHra !== undefined,
    );
    await syncDirectory(paths.applicationsDirectory);
    journal = await advance(backupDirectory, journal, "candidate_installed");
    input.onCheckpoint?.("after_candidate_installed");

    await requireQuiescent(paths, dependencies);
    const installedBeforeRetirement = await inspectBundle(paths.canonicalApp);
    assertBundleIdentity(
      installedBeforeRetirement.identity,
      expectedCandidate,
      "installed HRA before predecessor retirement",
    );
    assertTreeEvidence(
      candidate.tree,
      installedBeforeRetirement.tree,
      "installed HRA before predecessor retirement",
    );
    const predecessorRetirementStage = join(
      paths.applicationsDirectory,
      `.${operationId}.predecessor.bundle`,
    );
    await stageExactBundle(
      paths.predecessorApp,
      predecessorRetirementStage,
      predecessor.tree,
      dependencies,
    );
    journal = await advance(backupDirectory, journal, "predecessor_retired");
    input.onCheckpoint?.("after_predecessor_retired");

    if (await exists(paths.predecessorApp)) {
      throw new InstallationHandoffError(
        "continuity_failed",
        "The predecessor app remains present after retirement.",
      );
    }
    const installed = await inspectBundle(paths.canonicalApp);
    assertBundleIdentity(installed.identity, expectedCandidate, "installed HRA");
    assertTreeEvidence(candidate.tree, installed.tree, "installed HRA");
    const stateAfter = await inspectStateContinuity(paths.stateRoot, paths.controlPlanePath);
    assertStateContinuity(state, stateAfter, "post-install state");
    await assertKeychainContinuity(keychainBefore, dependencies);
    journal = await advance(backupDirectory, journal, "verified");
    input.onCheckpoint?.("after_continuity_verified");
    journal = await advance(backupDirectory, journal, "committed");
    input.onCheckpoint?.("after_authority_committed");

    await cleanupCommittedInstallationStages(
      paths,
      journal,
      input.onCheckpoint,
    );

    return {
      operationId,
      backupDirectory,
      candidateCommit,
      stateDigest: state.tree.digest,
      status: "committed",
    };
  } catch (error: unknown) {
    if (journal !== null && journal.phase !== "committed") {
      try {
        await rollbackFromJournal(
          backupDirectory,
          paths,
          journal,
          dependencies,
          input.onCheckpoint,
        );
      } catch (rollbackError: unknown) {
        throw new InstallationHandoffError(
          "rollback_unsafe",
          `Handoff failed and automatic rollback did not complete: ${message(error)}; ${message(rollbackError)}`,
        );
      }
    }
    throw error;
  } finally {
    controlPlaneLock?.release();
    nativeLock.release();
    eraseKeychainEvidence(keychainBefore);
  }
}

/**
 * Resumes only deletion of bundle staging paths left after the committed
 * receipt. It never changes canonical HRA, the predecessor path, or state.
 */
export async function resumeCommittedInstallationHandoffCleanup(
  input: InstallationHandoffCleanupInput,
  dependencies: InstallationHandoffDependencies = defaultDependencies,
): Promise<Readonly<{ operationId: string; status: "clean" }>> {
  if (input.confirmation !== committedCleanupConfirmation) {
    throw new InstallationHandoffError(
      "confirmation_invalid",
      `Confirmation must be ${committedCleanupConfirmation}.`,
    );
  }
  const backupDirectory = requireAbsoluteNormalized(
    input.backupDirectory,
    "backup directory",
  );
  const journal = await readJournal(backupDirectory);
  if (journal.phase !== "committed") {
    throw new InstallationHandoffError(
      "backup_invalid",
      "Committed cleanup requires an exact committed handoff receipt.",
    );
  }
  const paths = input.paths ?? installationHandoffPaths(
    join(backupDirectory, "unused-candidate.app"),
  );
  await assertPrivateBackupDirectory(
    backupDirectory,
    await canonicalProspectivePath(backupDirectory, "backup directory"),
  );
  await validateRollbackPaths(paths, backupDirectory);
  const nativeLock = await stopAndLock(paths, dependencies);
  try {
    await requireQuiescent(paths, dependencies);
    if (await exists(paths.predecessorApp)) {
      throw new InstallationHandoffError(
        "rollback_unsafe",
        "Committed cleanup refuses while the predecessor path exists.",
      );
    }
    const installed = await inspectBundle(paths.canonicalApp);
    assertBundleIdentity(installed.identity, journal.candidate.identity, "committed HRA");
    assertTreeEvidence(journal.candidate.tree, installed.tree, "committed HRA");
    await cleanupCommittedInstallationStages(
      paths,
      journal,
      input.onCheckpoint,
    );
    return { operationId: journal.operationId, status: "clean" };
  } finally {
    nativeLock.release();
  }
}

async function cleanupCommittedInstallationStages(
  paths: InstallationHandoffPaths,
  journal: HandoffJournal,
  onCheckpoint?: (point: InstallationHandoffFaultPoint) => void,
): Promise<void> {
  await removeVerifiedStage(
    join(paths.applicationsDirectory, `.${journal.operationId}.predecessor.bundle`),
    journal.predecessor.tree,
    "committed predecessor retirement",
  );
  onCheckpoint?.("after_committed_predecessor_cleanup");

  const candidateStage = join(
    paths.applicationsDirectory,
    `.${journal.operationId}.candidate.bundle`,
  );
  if (journal.priorHra !== undefined) {
    await removeVerifiedStage(
      candidateStage,
      journal.priorHra.tree,
      "committed prior HRA retirement",
    );
  } else if (await exists(candidateStage)) {
    throw new InstallationHandoffError(
      "rollback_unsafe",
      "Committed cleanup found an unexpected candidate staging bundle.",
    );
  }
  onCheckpoint?.("after_committed_prior_hra_cleanup");
  await syncDirectory(paths.applicationsDirectory);
}

export async function rollbackInstallationHandoff(
  input: InstallationRollbackInput,
  dependencies: InstallationHandoffDependencies = defaultDependencies,
): Promise<Readonly<{ operationId: string; status: "rolled_back" }>> {
  if (input.confirmation !== rollbackConfirmation) {
    throw new InstallationHandoffError(
      "confirmation_invalid",
      `Confirmation must be ${rollbackConfirmation}.`,
    );
  }
  const backupDirectory = requireAbsoluteNormalized(
    input.backupDirectory,
    "backup directory",
  );
  const journal = await readJournal(backupDirectory);
  const paths = input.paths ?? installationHandoffPaths(
    join(backupDirectory, "unused-candidate.app"),
  );
  await assertPrivateBackupDirectory(
    backupDirectory,
    await canonicalProspectivePath(backupDirectory, "backup directory"),
  );
  await validateRollbackPaths(paths, backupDirectory);
  const nativeLock = await stopAndLock(paths, dependencies);
  let controlPlaneLock: ControlPlaneLifetimeLock | null = null;
  try {
    controlPlaneLock = dependencies.acquireControlPlaneLock(paths.controlPlanePath);
    controlPlaneLock.bindControlPlane();
    await requireQuiescent(paths, dependencies);
    await rollbackFromJournal(
      backupDirectory,
      paths,
      journal,
      dependencies,
      input.onCheckpoint,
    );
    return { operationId: journal.operationId, status: "rolled_back" };
  } finally {
    controlPlaneLock?.release();
    nativeLock.release();
  }
}

async function validateRollbackPaths(
  paths: InstallationHandoffPaths,
  backupDirectory: string,
): Promise<void> {
  validateFixedHandoffPaths(paths);
  const backupAuthority = await inspectProspectivePathAuthority(
    backupDirectory,
    "backup directory",
  );
  for (const protectedPath of [
    paths.applicationsDirectory,
    paths.canonicalApp,
    paths.predecessorApp,
    paths.stateRoot,
    paths.controlPlanePath,
    paths.nativeInstanceLockPath,
  ]) {
    const protectedAuthority = await inspectProspectivePathAuthority(
      protectedPath,
      "protected rollback path",
    );
    if (authoritiesOverlap(protectedAuthority, backupAuthority)) {
      throw new InstallationHandoffError(
        "filesystem_unsafe",
        "The backup directory overlaps an installed application or state path.",
      );
    }
  }
}

async function rollbackFromJournal(
  backupDirectory: string,
  paths: InstallationHandoffPaths,
  journal: HandoffJournal,
  dependencies: InstallationHandoffDependencies,
  onCheckpoint?: (point: InstallationHandoffFaultPoint) => void,
): Promise<void> {
  const currentState = await inspectStateContinuity(paths.stateRoot, paths.controlPlanePath);
  assertStateContinuity(
    journal.state,
    currentState,
    "rollback source state",
  );

  const priorRetirementStage = join(
    paths.applicationsDirectory,
    `.${journal.operationId}.prior-hra.bundle`,
  );
  const predecessorRetirementStage = join(
    paths.applicationsDirectory,
    `.${journal.operationId}.predecessor.bundle`,
  );
  const candidateStage = join(
    paths.applicationsDirectory,
    `.${journal.operationId}.candidate.bundle`,
  );
  const retainedCandidateStage = join(
    paths.applicationsDirectory,
    `.${journal.operationId}.rollback-hra.bundle`,
  );

  let canonicalDisposition: "candidate" | "prior" | "missing" = "missing";
  if (await exists(paths.canonicalApp)) {
    const current = await inspectBundle(paths.canonicalApp);
    if (journal.priorHra?.tree.digest === current.tree.digest) {
      assertBundleIdentity(current.identity, journal.priorHra.identity, "rollback prior HRA");
      canonicalDisposition = "prior";
    } else if (journal.candidate?.tree.digest === current.tree.digest) {
      assertBundleIdentity(current.identity, journal.candidate.identity, "rollback candidate");
      canonicalDisposition = "candidate";
    } else {
      throw new InstallationHandoffError(
        "rollback_unsafe",
        "The canonical HRA app changed after handoff; rollback refuses to replace it.",
      );
    }
  }

  let predecessorAlreadyRestored = false;
  if (await exists(paths.predecessorApp)) {
    const predecessor = await inspectBundle(paths.predecessorApp);
    assertBundleIdentity(
      predecessor.identity,
      journal.predecessor.identity,
      "restored predecessor",
    );
    assertTreeEvidence(journal.predecessor.tree, predecessor.tree, "restored predecessor");
    predecessorAlreadyRestored = true;
  }

  const predecessorRestore = predecessorAlreadyRestored
    ? null
    : await stageBundleRestore(
        await selectRestoreSource(
          [
            predecessorRetirementStage,
            join(backupDirectory, "predecessor.bundle"),
          ],
          journal.predecessor,
          "predecessor",
        ),
        paths.predecessorApp,
        journal.predecessor,
        journal.operationId,
        dependencies,
      );
  const priorRestore = !journal.hadPriorHra
      || journal.priorHra === undefined
      || canonicalDisposition === "prior"
    ? null
    : await stageBundleRestore(
        await selectRestoreSource(
          [
            candidateStage,
            priorRetirementStage,
            join(backupDirectory, "prior-hra.bundle"),
          ],
          journal.priorHra,
          "prior HRA",
        ),
        paths.canonicalApp,
        journal.priorHra,
        journal.operationId,
        dependencies,
      );
  onCheckpoint?.("after_rollback_bundles_staged");

  // Publish the predecessor while the candidate HRA remains canonical. A
  // failed later restore therefore leaves at least one verified authority.
  if (predecessorRestore !== null) {
    await dependencies.publishBundle(
      predecessorRestore.stage,
      predecessorRestore.target,
      false,
    );
    await syncDirectory(paths.applicationsDirectory);
    const installed = await inspectBundle(paths.predecessorApp);
    assertBundleIdentity(
      installed.identity,
      journal.predecessor.identity,
      "rollback predecessor",
    );
    assertTreeEvidence(
      journal.predecessor.tree,
      installed.tree,
      "rollback predecessor",
    );
  }
  onCheckpoint?.("after_rollback_predecessor_published");

  if (priorRestore !== null) {
    await dependencies.publishBundle(
      priorRestore.stage,
      paths.canonicalApp,
      canonicalDisposition === "candidate",
    );
    await syncDirectory(paths.applicationsDirectory);
    const installed = await inspectBundle(paths.canonicalApp);
    assertBundleIdentity(
      installed.identity,
      priorRestore.expected.identity,
      "rollback prior HRA",
    );
    assertTreeEvidence(
      priorRestore.expected.tree,
      installed.tree,
      "rollback prior HRA",
    );
  } else if (!journal.hadPriorHra && canonicalDisposition === "candidate") {
    await requireMissing(
      retainedCandidateStage,
      "Rollback candidate retention path already exists.",
    );
    await dependencies.publishBundle(
      paths.canonicalApp,
      retainedCandidateStage,
      false,
    );
    await syncDirectory(paths.applicationsDirectory);
    assertTreeEvidence(
      journal.candidate.tree,
      await inspectTree(retainedCandidateStage),
      "retained rollback candidate",
    );
  }
  onCheckpoint?.("after_rollback_hra_restored");

  const rolledBack = { ...journal, phase: "rolled_back" as const };
  await writeJournal(backupDirectory, rolledBack);
  onCheckpoint?.("after_rollback_committed");

  for (const stage of new Set([
    candidateStage,
    priorRetirementStage,
    predecessorRetirementStage,
    retainedCandidateStage,
    ...(priorRestore === null ? [] : [priorRestore.stage]),
  ])) {
    await removeKnownRollbackStage(stage, journal);
  }
  await syncDirectory(paths.applicationsDirectory);
}

async function selectRestoreSource(
  candidates: readonly string[],
  expected: BundleContinuityEvidence,
  label: string,
): Promise<string> {
  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    try {
      const inspected = await inspectBundle(candidate);
      assertBundleIdentity(inspected.identity, expected.identity, label);
      assertTreeEvidence(expected.tree, inspected.tree, label);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new InstallationHandoffError(
    "rollback_unsafe",
    `The verified ${label} recovery source is missing.`,
  );
}

async function removeKnownRollbackStage(
  stage: string,
  journal: HandoffJournal,
): Promise<void> {
  if (!await exists(stage)) return;
  const tree = await inspectTree(stage);
  const expected = [
    journal.candidate.tree,
    journal.predecessor.tree,
    ...(journal.priorHra === undefined ? [] : [journal.priorHra.tree]),
  ].find(candidate => candidate.digest === tree.digest);
  if (expected === undefined) {
    throw new InstallationHandoffError(
      "rollback_unsafe",
      "Rollback found an unknown installation staging bundle.",
    );
  }
  assertTreeEvidence(expected, tree, "rollback staging bundle");
  await rm(stage, { recursive: true, force: false });
}

async function stageBundleRestore(
  archive: string,
  target: string,
  expected: BundleContinuityEvidence,
  operationId: string,
  dependencies: InstallationHandoffDependencies,
): Promise<Readonly<{
  stage: string;
  target: string;
  expected: BundleContinuityEvidence;
}>> {
  const stage = join(dirname(target), `.${operationId}.${basename(target)}.restore.bundle`);
  if (await exists(stage)) {
    const restored = await inspectBundle(stage);
    assertBundleIdentity(restored.identity, expected.identity, "rollback bundle");
    assertTreeEvidence(expected.tree, restored.tree, "rollback bundle");
    return { stage, target, expected };
  }
  try {
    await dependencies.copyTree(archive, stage);
    const restored = await inspectBundle(stage);
    assertBundleIdentity(restored.identity, expected.identity, "rollback bundle");
    assertTreeEvidence(expected.tree, restored.tree, "rollback bundle");
    return { stage, target, expected };
  } catch (error: unknown) {
    if (await exists(stage)) await rm(stage, { recursive: true, force: false });
    throw error;
  }
}

async function stopAndLock(
  paths: InstallationHandoffPaths,
  dependencies: InstallationHandoffDependencies,
): Promise<HeldLock> {
  await dependencies.quitApplications([paths.predecessorApp, paths.canonicalApp]);
  let lock: HeldLock;
  try {
    lock = dependencies.acquireNativeLock(paths.nativeInstanceLockPath);
  } catch (error: unknown) {
    throw new InstallationHandoffError(
      "lock_unavailable",
      `The shared native instance lock is unavailable: ${message(error)}`,
    );
  }
  try {
    await dependencies.quitApplications([paths.predecessorApp, paths.canonicalApp]);
    return lock;
  } catch (error: unknown) {
    lock.release();
    throw error;
  }
}

async function requireQuiescent(
  paths: InstallationHandoffPaths,
  dependencies: InstallationHandoffDependencies,
): Promise<void> {
  if (!await dependencies.updaterIsQuiescent(paths)) {
    throw new InstallationHandoffError(
      "updater_active",
      "An updater hazard, installer job, Sparkle cache, or app process remains active.",
    );
  }
  if (!await dependencies.openFilesAreQuiescent(paths)) {
    throw new InstallationHandoffError(
      "app_running",
      "An application still has an installed bundle or control-plane database open.",
    );
  }
}

async function validateHandoffPaths(
  paths: InstallationHandoffPaths,
  backupDirectory: string,
): Promise<string> {
  validateFixedHandoffPaths(paths);
  const backupAuthority = await inspectProspectivePathAuthority(
    backupDirectory,
    "backup directory",
  );
  const candidateAuthority = await inspectProspectivePathAuthority(
    paths.candidateApp,
    "candidate app",
  );
  for (const protectedPath of [
    paths.applicationsDirectory,
    paths.candidateApp,
    paths.canonicalApp,
    paths.predecessorApp,
    paths.stateRoot,
  ]) {
    const protectedAuthority = await inspectProspectivePathAuthority(
      protectedPath,
      "protected handoff path",
    );
    if (authoritiesOverlap(protectedAuthority, backupAuthority)) {
      throw new InstallationHandoffError(
        "filesystem_unsafe",
        "The backup directory overlaps an application or state path.",
      );
    }
  }
  const installedAuthority = await inspectProspectivePathAuthority(
    paths.canonicalApp,
    "canonical app",
  );
  const predecessorAuthority = await inspectProspectivePathAuthority(
    paths.predecessorApp,
    "predecessor app",
  );
  if (
    authoritiesOverlap(candidateAuthority, installedAuthority)
    || authoritiesOverlap(candidateAuthority, predecessorAuthority)
  ) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      "The candidate must remain outside both installed application paths.",
    );
  }
  return backupAuthority.path;
}

function validateFixedHandoffPaths(paths: InstallationHandoffPaths): void {
  for (const [label, path] of Object.entries({
    applicationsDirectory: paths.applicationsDirectory,
    candidateApp: paths.candidateApp,
    canonicalApp: paths.canonicalApp,
    predecessorApp: paths.predecessorApp,
    stateRoot: paths.stateRoot,
    controlPlanePath: paths.controlPlanePath,
    nativeInstanceLockPath: paths.nativeInstanceLockPath,
    updateHazardPath: paths.updateHazardPath,
    updateHazardTemporaryPath: paths.updateHazardTemporaryPath,
  })) requireAbsoluteNormalized(path, label);
  for (const [index, path] of paths.sparkleCacheRoots.entries()) {
    requireAbsoluteNormalized(path, `sparkleCacheRoots[${index}]`);
  }
  if (
    paths.canonicalApp !== join(paths.applicationsDirectory, "HRA.app")
    || paths.predecessorApp !== join(paths.applicationsDirectory, "OPRTE.app")
    || paths.controlPlanePath !== join(paths.stateRoot, "control-plane.sqlite")
  ) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      "Handoff paths do not match the fixed HRA compatibility layout.",
    );
  }
}

async function inspectStateContinuity(
  stateRoot: string,
  controlPlanePath: string,
  checkpoint = true,
): Promise<StateContinuityEvidence> {
  const rootStatus = await lstat(stateRoot);
  if (
    !rootStatus.isDirectory()
    || rootStatus.isSymbolicLink()
    || await realpath(stateRoot) !== stateRoot
  ) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      "The compatibility state root must be one real directory.",
    );
  }
  const controlPlaneAuthority = await inspectRequiredSQLiteFileAuthority(
    controlPlanePath,
    "control-plane database",
  );
  await inspectSQLiteSidecarAuthorities(controlPlanePath);
  const database = new Database(controlPlanePath, { readonly: !checkpoint, strict: true });
  let migrationVersion = 0;
  const rows: Record<string, number> = {};
  try {
    if (checkpoint) checkpointControlPlaneForApplicationSupportCutover(database);
    assertBoundedControlPlaneIntegrity(database);
    const quickCheck: unknown = database.query("PRAGMA quick_check").get();
    if (!isRecord(quickCheck) || quickCheck["quick_check"] !== "ok") {
      throw new InstallationHandoffError(
        "continuity_failed",
        "The control-plane database quick check failed.",
      );
    }
    const migration: unknown = database.query(
      "SELECT coalesce(max(version), 0) AS version FROM schema_migrations",
    ).get();
    migrationVersion = integerField(migration, "version");
    const tableValues = database.query(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as unknown;
    if (!Array.isArray(tableValues)) throw new Error("SQLite table inventory is invalid.");
    for (const value of tableValues) {
      if (!isRecord(value) || typeof value["name"] !== "string") {
        throw new Error("SQLite table inventory is invalid.");
      }
      const name = value["name"];
      if (!/(?:account|chat|session|thread|worktree|workspace)/iu.test(name)) continue;
      const quotedName = name.replaceAll('"', '""');
      const count: unknown = database.query(
        `SELECT count(*) AS count FROM "${quotedName}"`,
      ).get();
      rows[name] = integerField(count, "count");
    }
  } finally {
    database.close();
  }
  await revalidateSQLiteFileAuthority(
    controlPlanePath,
    controlPlaneAuthority,
    "control-plane database",
  );
  await inspectSQLiteSidecarAuthorities(controlPlanePath);
  const databaseEvidence: DatabaseContinuityEvidence = {
    databaseSha256: await sha256File(controlPlanePath),
    migrationVersion,
    quickCheck: "ok",
    rows,
  };
  const tree = await inspectTree(stateRoot, {
    ignoredRelativePaths: new Set([
      ".control-plane.sqlite.lifetime.lock",
      "control-plane.sqlite-journal",
      "control-plane.sqlite-shm",
      "control-plane.sqlite-wal",
    ]),
  });
  const entries = await collectRelativeDirectories(stateRoot);
  return {
    accountHomes: countMatching(entries, /^codex\/accounts\/[^/]+\/home$/u),
    chatWorktreeLanes: countMatching(entries, /^chat-worktrees\/[^/]+$/u),
    database: databaseEvidence,
    dispatchWorktreeLanes: countMatching(entries, /^dispatch\/worktrees\/[^/.][^/]*$/u),
    harnessWorktreeLanes: countMatching(entries, /^harness\/v1\/worktrees\/[^/.][^/]*$/u),
    localTaskWorktreeLanes: countMatching(entries, /^local-task-worktrees\/[^/.][^/]*$/u),
    sessionEntries: entries.filter((path) => path.split("/").includes("sessions")).length,
    tree,
  };
}

type SQLiteFileAuthority = Readonly<{ device: bigint; inode: bigint }>;

async function inspectRequiredSQLiteFileAuthority(
  path: string,
  label: string,
): Promise<SQLiteFileAuthority> {
  const status = await lstat(path, { bigint: true });
  if (
    !status.isFile()
    || status.isSymbolicLink()
    || status.nlink !== 1n
    || await realpath(path) !== path
  ) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      `${label} must be one canonical, unlinked regular file.`,
    );
  }
  return { device: status.dev, inode: status.ino };
}

async function revalidateSQLiteFileAuthority(
  path: string,
  expected: SQLiteFileAuthority,
  label: string,
): Promise<void> {
  const actual = await inspectRequiredSQLiteFileAuthority(path, label);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      `${label} changed while continuity was inspected.`,
    );
  }
}

async function inspectSQLiteSidecarAuthorities(controlPlanePath: string): Promise<void> {
  for (const suffix of ["-journal", "-shm", "-wal"] as const) {
    const sidecar = `${controlPlanePath}${suffix}`;
    if (!await exists(sidecar)) continue;
    await inspectRequiredSQLiteFileAuthority(sidecar, `SQLite ${suffix.slice(1)} sidecar`);
  }
}

function assertStateContinuity(
  expected: StateContinuityEvidence,
  actual: StateContinuityEvidence,
  label: string,
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new InstallationHandoffError(
      "continuity_failed",
      `${label} differs from the pre-handoff SQLite/account/chat/worktree evidence: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

async function inspectKeychainContinuity(
  controlPlanePath: string,
  dependencies: InstallationHandoffDependencies,
): Promise<KeychainEvidence> {
  const controlPlaneAuthority = await inspectRequiredSQLiteFileAuthority(
    controlPlanePath,
    "Keychain inventory database",
  );
  const database = new Database(controlPlanePath, { readonly: true, strict: true });
  let targets: readonly Readonly<{ service: string; name: string }>[];
  try {
    targets = readKeychainTargets(database);
  } finally {
    database.close();
  }
  await revalidateSQLiteFileAuthority(
    controlPlanePath,
    controlPlaneAuthority,
    "Keychain inventory database",
  );
  const key = Buffer.from(dependencies.randomBytes(32));
  const fingerprints = new Map<string, Buffer | null>();
  for (const target of targets) {
    const descriptor = `${target.service}\u0000${target.name}`;
    const secret = await dependencies.keychainRead(target);
    fingerprints.set(
      descriptor,
      secret === null
        ? null
        : createHmac("sha256", key).update(secret, "utf8").digest(),
    );
  }
  return {
    descriptors: [...fingerprints.keys()].sort(),
    fingerprints,
    key,
  };
}

export function readKeychainTargets(
  database: Database,
): readonly Readonly<{ service: string; name: string }>[] {
  const targets = new Map<string, Readonly<{ service: string; name: string }>>();
  const add = (service: string, name: string) => {
    const key = `${service}\u0000${name}`;
    targets.set(key, { service, name });
  };
  const tables = new Set(
    (database.query(
      "SELECT name FROM sqlite_schema WHERE type = 'table'",
    ).all() as readonly unknown[]).flatMap((value) =>
      isRecord(value) && typeof value["name"] === "string" ? [value["name"]] : []),
  );
  if (tables.has("human_custody_metadata")) {
    const rowSchema = z.object({
      journal_json: z.string().min(1).max(maximumJournalBytes),
      name: z.string(),
      service: z.string(),
    }).strict();
    const values: unknown = database.query(
      "SELECT service, name, journal_json FROM human_custody_metadata ORDER BY service, name",
    ).all();
    for (const value of z.array(rowSchema).max(4096).parse(values)) {
      const descriptor = secretCustodyDescriptorSchema.parse({
        service: value.service,
        name: value.name,
      });
      requireKnownCustodyService(descriptor.service);
      let parsed: unknown;
      try {
        parsed = JSON.parse(value.journal_json) as unknown;
      } catch {
        throw new InstallationHandoffError(
          "backup_invalid",
          "Keychain custody journal JSON is invalid.",
        );
      }
      const journal: SecretCustodyJournal = secretCustodyJournalSchema.parse(parsed);
      if (journal.service !== descriptor.service || journal.name !== descriptor.name) {
        throw new InstallationHandoffError(
          "backup_invalid",
          "Keychain custody journal identity differs from its SQLite row.",
        );
      }
      const pointers = [
        ...(journal.committed === undefined ? [] : [journal.committed]),
        ...(journal.pending === undefined ? [] : [journal.pending.pointer]),
        ...(journal.deleting ?? []),
      ];
      for (const pointer of pointers) {
        add(descriptor.service, `${descriptor.name}:slot:${pointer.slot}`);
      }
    }
  }
  if (tables.has("human_custody_pointer_quarantine")) {
    const rowSchema = z.object({
      generation: z.number().int().nonnegative(),
      name: z.string(),
      pointer_kind: z.string(),
      reason: z.string(),
      service: z.string(),
      slot: z.string(),
      source_revision: z.number().int().nonnegative(),
    }).strict();
    const values: unknown = database.query(`
      SELECT service, name, pointer_kind, generation, slot, source_revision, reason
      FROM human_custody_pointer_quarantine
      ORDER BY service, name, generation, slot
    `).all();
    for (const value of z.array(rowSchema).max(4096).parse(values)) {
      const descriptor = secretCustodyDescriptorSchema.parse({
        service: value.service,
        name: value.name,
      });
      requireKnownCustodyService(descriptor.service);
      const pointer = secretCustodyQuarantinePointerSchema.parse({
        kind: value.pointer_kind,
        pointer: { generation: value.generation, slot: value.slot },
        reason: value.reason,
        sourceRevision: value.source_revision,
      });
      if (pointer.reason !== "missing_pointer_abandoned") {
        add(descriptor.service, `${descriptor.name}:slot:${pointer.pointer.slot}`);
      }
    }
  }
  add("com.0thernet.oprte.context-heap.v1", "installation-master");
  add("com.0thernet.oprte.context-heap.v2", "installation-master");
  add("com.0thernet.oprte.context-heap.v2", "legacy-reconciliation");
  add("kitchen.hraness.session-sync.v1", "device-vault");
  add("kitchen.hraness.session-sync.v1", "recovery-authority");
  return [...targets.values()].sort((left, right) =>
    `${left.service}\u0000${left.name}`.localeCompare(`${right.service}\u0000${right.name}`));
}

function requireKnownCustodyService(service: string): void {
  if (service !== HRA_HUMAN_KEYCHAIN_SERVICE && service !== HRA_RUNNER_KEYCHAIN_SERVICE) {
    throw new InstallationHandoffError(
      "backup_invalid",
      "An unknown secret-custody service is present.",
    );
  }
}

async function assertKeychainContinuity(
  before: KeychainEvidence,
  dependencies: InstallationHandoffDependencies,
): Promise<void> {
  for (const descriptor of before.descriptors) {
    const separator = descriptor.indexOf("\u0000");
    const service = descriptor.slice(0, separator);
    const name = descriptor.slice(separator + 1);
    const expected = before.fingerprints.get(descriptor) ?? null;
    const value = await dependencies.keychainRead({ service, name });
    if (expected === null) {
      if (value !== null) {
        throw new InstallationHandoffError(
          "continuity_failed",
          "A previously absent HRA Keychain descriptor appeared during handoff.",
        );
      }
      continue;
    }
    if (value === null) {
      throw new InstallationHandoffError(
        "continuity_failed",
        "An HRA Keychain descriptor disappeared during handoff.",
      );
    }
    const actual = createHmac("sha256", before.key)
      .update(value, "utf8")
      .digest();
    const same = actual.byteLength === expected.byteLength
      && timingSafeEqual(actual, expected);
    actual.fill(0);
    if (!same) {
      throw new InstallationHandoffError(
        "continuity_failed",
        "An HRA Keychain item changed during handoff.",
      );
    }
  }
}

function eraseKeychainEvidence(evidence: KeychainEvidence | null): void {
  if (evidence === null) return;
  evidence.key.fill(0);
  for (const digest of evidence.fingerprints.values()) digest?.fill(0);
}

async function inspectBundle(path: string): Promise<BundleContinuityEvidence> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      `Application bundle must be one real directory: ${basename(path)}`,
    );
  }
  const plist = join(path, "Contents", "Info.plist");
  const identity = {
    build: await plistValue(plist, "CFBundleVersion"),
    bundleIdentifier: await plistValue(plist, "CFBundleIdentifier"),
    executable: await plistValue(plist, "CFBundleExecutable"),
    version: await plistValue(plist, "CFBundleShortVersionString"),
  };
  const signature = await runCommand([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    path,
  ], true);
  if (signature.exitCode !== 0) {
    throw new InstallationHandoffError(
      "candidate_invalid",
      `Application code signature is invalid: ${signature.stderr.trim()}`,
    );
  }
  return { identity, tree: await inspectTree(path) };
}

function assertBundleIdentity(
  actual: BundleIdentity,
  expected: BundleIdentity,
  label: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new InstallationHandoffError(
      label === "predecessor" ? "predecessor_invalid" : "candidate_invalid",
      `${label} application identity differs from the checked handoff contract.`,
    );
  }
}

function assertSupportedPriorHraIdentity(actual: BundleIdentity): void {
  if (
    JSON.stringify(actual) !== JSON.stringify(expectedPriorHra)
    && JSON.stringify(actual) !== JSON.stringify(expectedCandidate)
  ) {
    throw new InstallationHandoffError(
      "candidate_invalid",
      "existing HRA application identity is not a supported rollback authority.",
    );
  }
}

export async function inspectTree(
  rootValue: string,
  options: Readonly<{ ignoredRelativePaths?: ReadonlySet<string> }> = {},
): Promise<TreeEvidence> {
  const root = await realpath(rootValue);
  const hasher = createHash("sha256");
  let entries = 0;
  let files = 0;
  let directories = 0;
  let symlinks = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (options.ignoredRelativePaths?.has(relativePath) === true) continue;
      const metadata = await lstat(path);
      entries += 1;
      if (entries > maximumTreeEntries) {
        throw new InstallationHandoffError("backup_invalid", "State tree has too many entries.");
      }
      const mode = metadata.mode & 0o7777;
      if (child.isDirectory() && !child.isSymbolicLink()) {
        directories += 1;
        hasher.update(`d\u0000${relativePath}\u0000${mode.toString(8)}\n`);
        await visit(path);
      } else if (child.isFile() && !child.isSymbolicLink()) {
        files += 1;
        bytes += metadata.size;
        if (bytes > maximumTreeBytes) {
          throw new InstallationHandoffError("backup_invalid", "State tree is too large.");
        }
        hasher.update(
          `f\u0000${relativePath}\u0000${mode.toString(8)}\u0000${metadata.size}\u0000${await sha256File(path)}\n`,
        );
      } else if (child.isSymbolicLink()) {
        symlinks += 1;
        const target = await readlink(path);
        if (target.includes("\u0000") || Buffer.byteLength(target, "utf8") > 4096) {
          throw new InstallationHandoffError("backup_invalid", "State symlink target is invalid.");
        }
        hasher.update(`l\u0000${relativePath}\u0000${mode.toString(8)}\u0000${target}\n`);
      } else {
        throw new InstallationHandoffError(
          "backup_invalid",
          `State tree contains a special entry: ${relativePath}`,
        );
      }
    }
  };
  await visit(root);
  return {
    bytes,
    directories,
    digest: hasher.digest("hex"),
    entries,
    files,
    symlinks,
  };
}

async function collectRelativeDirectories(rootValue: string): Promise<string[]> {
  const root = await realpath(rootValue);
  const directories: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const path = join(directory, child.name);
      directories.push(relative(root, path).split(sep).join("/"));
      await visit(path);
    }
  };
  await visit(root);
  return directories;
}

function assertTreeEvidence(expected: TreeEvidence, actual: TreeEvidence, label: string): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new InstallationHandoffError(
      "continuity_failed",
      `${label} differs from its source tree.`,
    );
  }
}

async function stageExactBundle(
  source: string,
  staging: string,
  expected: TreeEvidence,
  dependencies: InstallationHandoffDependencies,
): Promise<void> {
  assertTreeEvidence(expected, await inspectTree(source), "bundle retirement source");
  await requireMissing(staging, "Bundle retirement staging path already exists.");
  await dependencies.publishBundle(source, staging, false);
  await syncDirectory(dirname(source));
  assertTreeEvidence(expected, await inspectTree(staging), "retired bundle staging");
}

async function removeVerifiedStage(
  staging: string,
  expected: TreeEvidence,
  label: string,
): Promise<void> {
  if (!await exists(staging)) return;
  assertTreeEvidence(expected, await inspectTree(staging), label);
  await rm(staging, { recursive: true, force: false });
  await syncDirectory(dirname(staging));
}

async function publishBundleWithPathAuthority(
  source: string,
  destination: string,
  exchange: boolean,
): Promise<void> {
  const sourceAuthority = await inspectProspectivePathAuthority(
    source,
    "bundle publication source",
  );
  const destinationAuthority = await inspectProspectivePathAuthority(
    destination,
    "bundle publication destination",
  );
  if (sourceAuthority.missing.length > 0) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      "Bundle publication source is missing.",
    );
  }
  if (exchange !== (destinationAuthority.missing.length === 0)) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      "Bundle publication destination changed before mutation.",
    );
  }
  try {
    await renameWithPathAuthority(
      sourceAuthority,
      destinationAuthority,
      { exchange },
    );
  } catch (error: unknown) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      `Descriptor-relative bundle publication failed: ${message(error)}`,
    );
  }
}

async function copyTreeWithDitto(source: string, destination: string): Promise<void> {
  await requireMissing(destination, "Copy destination already exists.");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const result = await runCommand([
    "/usr/bin/ditto",
    "--rsrc",
    "--extattr",
    "--acl",
    "--qtn",
    "--preserveHFSCompression",
    source,
    destination,
  ]);
  if (result.exitCode !== 0) {
    throw new InstallationHandoffError(
      "backup_invalid",
      `ditto failed: ${result.stderr.trim()}`,
    );
  }
}

async function quitExactApplicationProcesses(bundleRoots: readonly string[]): Promise<void> {
  const bundles = bundleRoots.map(root => {
    const name = basename(root);
    if (name !== "HRA.app" && name !== "OPRTE.app") {
      throw new InstallationHandoffError(
        "filesystem_unsafe",
        "Ordered shutdown accepts only the canonical HRA and OPRTE bundles.",
      );
    }
    return { root, executable: name === "HRA.app" ? "hra" : "oprte" };
  });
  try {
    await quitInstalledApplicationRoots(bundles);
  } catch (error: unknown) {
    throw new InstallationHandoffError(
      "app_running",
      `Ordered AppKit/native-root shutdown failed: ${message(error)}`,
    );
  }
}

async function inspectOpenFileQuiescence(
  paths: InstallationHandoffPaths,
): Promise<boolean> {
  const databasePaths = [
    paths.controlPlanePath,
    `${paths.controlPlanePath}-wal`,
    `${paths.controlPlanePath}-shm`,
    `${paths.controlPlanePath}-journal`,
  ];
  for (const path of databasePaths) {
    if (!await exists(path)) continue;
    const result = await runCommand(["/usr/sbin/lsof", "-Fn", "--", path], true);
    if (result.exitCode === 0) return false;
    if (result.exitCode !== 1) return false;
  }
  for (const root of [paths.predecessorApp, paths.canonicalApp]) {
    if (!await exists(root)) continue;
    const result = await runCommand(["/usr/sbin/lsof", "+D", root], true);
    if (result.exitCode === 0) return false;
    if (result.exitCode !== 1) return false;
  }
  return true;
}

async function inspectUpdaterQuiescence(paths: InstallationHandoffPaths): Promise<boolean> {
  if (await exists(paths.updateHazardPath) || await exists(paths.updateHazardTemporaryPath)) {
    return false;
  }
  for (const root of paths.sparkleCacheRoots) {
    for (const leaf of ["PersistentDownloads", "Launcher"]) {
      const path = join(root, leaf);
      if (await exists(path)) {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
        if ((await readdir(path)).length > 0) return false;
      }
    }
  }
  const uid = process.geteuid?.();
  if (uid === undefined) return false;
  for (const identifier of ["kitchen.hraness", "com.jungle.oprte", "com.jungle.kitchen"]) {
    for (const suffix of ["-sparkle-updater", "-sparkle-progress"]) {
      for (const domain of [`gui/${uid}`, "system"]) {
        const result = await runCommand(
          ["/bin/launchctl", "print", `${domain}/${identifier}${suffix}`],
          true,
        );
        if (result.exitCode === 0) return false;
      }
    }
  }
  const processes = await runCommand(["/bin/ps", "-axo", "comm="]);
  if (processes.exitCode !== 0) return false;
  return !processes.stdout.split("\n").some((command) =>
    [paths.canonicalApp, paths.predecessorApp].some((root) =>
      command.trim().startsWith(`${root}${sep}`)));
}

function acquireNativeInstallationLock(pathValue: string): HeldLock {
  const path = requireAbsoluteNormalized(pathValue, "native instance lock");
  const parent = dirname(path);
  const parentStatus = lstatSync(parent);
  const expectedUser = process.geteuid?.();
  if (
    expectedUser === undefined
    || parentStatus.isSymbolicLink()
    || !parentStatus.isDirectory()
    || parentStatus.uid !== expectedUser
  ) throw new Error("Native instance-lock parent is unsafe.");
  const closeOnExecValue: unknown = Reflect.get(constants, "O_CLOEXEC");
  const closeOnExec = typeof closeOnExecValue === "number" ? closeOnExecValue : 0;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | closeOnExec,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor);
    const published = lstatSync(path);
    if (
      !opened.isFile()
      || opened.isSymbolicLink()
      || opened.uid !== expectedUser
      || opened.nlink !== 1
      || opened.dev !== published.dev
      || opened.ino !== published.ino
    ) throw new Error("Native instance lock is unsafe.");
    if (!tryFlock(descriptor)) throw new Error("Another application instance owns the lock.");
  } catch (error: unknown) {
    if (descriptor !== null) closeSync(descriptor);
    throw error;
  }
  let held: number | null = descriptor;
  return {
    release() {
      if (held === null) return;
      closeSync(held);
      held = null;
    },
  };
}

function tryFlock(descriptor: number): boolean {
  const libraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const library = dlopen(libraryPath, {
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  try {
    return library.symbols.flock(descriptor, 0x02 | 0x04) === 0;
  } finally {
    library.close();
  }
}

async function writeJournal(backupDirectory: string, journal: HandoffJournal): Promise<void> {
  const path = join(backupDirectory, "handoff-receipt.json");
  const temporary = join(
    backupDirectory,
    `.handoff-receipt.${process.pid}.${Date.now()}.tmp`,
  );
  const encoded = `${JSON.stringify(parseInstallationHandoffJournal(journal), null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > maximumJournalBytes) {
    throw new InstallationHandoffError("backup_invalid", "Handoff receipt is too large.");
  }
  await writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
  const handle = await open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  await syncDirectory(backupDirectory);
}

async function readJournal(backupDirectory: string): Promise<HandoffJournal> {
  const path = join(backupDirectory, "handoff-receipt.json");
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > maximumJournalBytes) {
    throw new InstallationHandoffError("backup_invalid", "Handoff receipt is unsafe.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw invalidJournal();
  }
  return parseInstallationHandoffJournal(parsed);
}

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const treeEvidenceSchema = z.object({
  bytes: nonNegativeSafeIntegerSchema.max(maximumTreeBytes),
  directories: nonNegativeSafeIntegerSchema.max(maximumTreeEntries),
  digest: sha256Schema,
  entries: nonNegativeSafeIntegerSchema.max(maximumTreeEntries),
  files: nonNegativeSafeIntegerSchema.max(maximumTreeEntries),
  symlinks: nonNegativeSafeIntegerSchema.max(maximumTreeEntries),
}).strict().superRefine((value, context) => {
  if (value.entries !== value.directories + value.files + value.symlinks) {
    context.addIssue({ code: "custom", message: "tree entry counts differ" });
  }
});
const databaseRowsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u),
  nonNegativeSafeIntegerSchema,
).refine(value => Object.keys(value).length <= 4096, "too many database rows");
const databaseEvidenceSchema = z.object({
  databaseSha256: sha256Schema,
  migrationVersion: nonNegativeSafeIntegerSchema,
  quickCheck: z.literal("ok"),
  rows: databaseRowsSchema,
}).strict();
const stateEvidenceSchema = z.object({
  accountHomes: nonNegativeSafeIntegerSchema,
  chatWorktreeLanes: nonNegativeSafeIntegerSchema,
  database: databaseEvidenceSchema,
  dispatchWorktreeLanes: nonNegativeSafeIntegerSchema,
  harnessWorktreeLanes: nonNegativeSafeIntegerSchema,
  localTaskWorktreeLanes: nonNegativeSafeIntegerSchema,
  sessionEntries: nonNegativeSafeIntegerSchema,
  tree: treeEvidenceSchema,
}).strict();
const identitySchema = (identity: BundleIdentity) => z.object({
  build: z.literal(identity.build),
  bundleIdentifier: z.literal(identity.bundleIdentifier),
  executable: z.literal(identity.executable),
  version: z.literal(identity.version),
}).strict();
const bundleEvidenceSchema = (identity: BundleIdentity) => z.object({
  identity: identitySchema(identity),
  tree: treeEvidenceSchema,
}).strict();
const priorHraEvidenceSchema = z.union([
  bundleEvidenceSchema(expectedPriorHra),
  bundleEvidenceSchema(expectedCandidate),
]);
const keychainDescriptorSchema = z.string().max(2048).refine(value => {
  const separator = value.indexOf("\u0000");
  return separator > 0
    && separator === value.lastIndexOf("\u0000")
    && separator < value.length - 1;
}, "invalid Keychain descriptor");
const keychainDescriptorsSchema = z.array(keychainDescriptorSchema).max(4096)
  .superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({ code: "custom", message: "duplicate Keychain descriptor" });
    }
    const sorted = [...value].sort();
    if (sorted.some((descriptor, index) => descriptor !== value[index])) {
      context.addIssue({ code: "custom", message: "unsorted Keychain descriptors" });
    }
  });
const handoffJournalSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: nonNegativeSafeIntegerSchema,
  operationId: z.string().regex(operationIdPattern),
  phase: z.enum([
    "created",
    "backed_up",
    "smoked",
    "bundles_archived",
    "candidate_staged",
    "candidate_installed",
    "predecessor_retired",
    "verified",
    "committed",
    "rolled_back",
  ]),
  candidateCommit: z.string().regex(commitPattern),
  hadPriorHra: z.boolean(),
  state: stateEvidenceSchema,
  predecessor: bundleEvidenceSchema(expectedPredecessor),
  candidate: bundleEvidenceSchema(expectedCandidate),
  priorHra: priorHraEvidenceSchema.optional(),
  keychainDescriptors: keychainDescriptorsSchema,
}).strict().superRefine((value, context) => {
  if (value.hadPriorHra !== (value.priorHra !== undefined)) {
    context.addIssue({ code: "custom", message: "prior HRA evidence mismatch" });
  }
});
export function parseInstallationHandoffJournal(value: unknown): HandoffJournal {
  const parsed = handoffJournalSchema.safeParse(value);
  if (!parsed.success) throw invalidJournal();
  const { priorHra, ...required } = parsed.data;
  return priorHra === undefined ? required : { ...required, priorHra };
}

function invalidJournal(): InstallationHandoffError {
  return new InstallationHandoffError("backup_invalid", "Handoff receipt is invalid.");
}

async function advance(
  backupDirectory: string,
  journal: HandoffJournal,
  phase: HandoffJournal["phase"],
): Promise<HandoffJournal> {
  const next = { ...journal, phase };
  await writeJournal(backupDirectory, next);
  return next;
}

async function plistValue(path: string, key: string): Promise<string> {
  const result = await runCommand([
    "/usr/bin/plutil",
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path,
  ]);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new InstallationHandoffError(
      "candidate_invalid",
      `Application Info.plist is missing ${key}.`,
    );
  }
  return result.stdout.trim();
}

async function runCommand(
  argv: readonly string[],
  allowFailure = false,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn([...argv], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`${argv[0]} failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return { exitCode, stdout, stderr };
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hasher = createHash("sha256");
  try {
    for await (const chunk of handle.readableWebStream()) {
      hasher.update(chunk as Uint8Array);
    }
  } finally {
    await handle.close();
  }
  return hasher.digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireMissing(path: string, messageValue: string): Promise<void> {
  if (await exists(path)) {
    throw new InstallationHandoffError("filesystem_unsafe", messageValue);
  }
}

async function canonicalProspectivePath(
  pathValue: string,
  label: string,
): Promise<string> {
  requireAbsoluteNormalized(pathValue, label);
  try {
    return (await inspectProspectivePathAuthority(pathValue, label)).path;
  } catch (error: unknown) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      `${label} has no unambiguous filesystem authority: ${message(error)}`,
    );
  }
}

async function assertPrivateBackupDirectory(
  pathValue: string,
  expectedCanonicalPath: string,
): Promise<void> {
  const status = await lstat(pathValue);
  const expectedUser = process.geteuid?.();
  if (
    expectedUser === undefined
    || !status.isDirectory()
    || status.isSymbolicLink()
    || status.uid !== expectedUser
    || (status.mode & 0o077) !== 0
    || await realpath(pathValue) !== expectedCanonicalPath
  ) {
    throw new InstallationHandoffError(
      "filesystem_unsafe",
      "The backup directory is not one canonical user-only directory.",
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function requireAbsoluteNormalized(value: string, label: string): string {
  if (
    !isAbsolute(value)
    || resolve(value) !== value
    || value === resolve(value, sep)
    || value.includes("\u0000")
  ) {
    throw new InstallationHandoffError(
      "invalid_arguments",
      `${label} must be an absolute normalized non-root path.`,
    );
  }
  return value;
}

function requireCommit(value: string): string {
  if (!commitPattern.test(value)) {
    throw new InstallationHandoffError(
      "invalid_arguments",
      "Expected commit must be one full lowercase SHA-1.",
    );
  }
  return value;
}

function createOperationId(bytes: Uint8Array): string {
  if (bytes.byteLength !== 12) {
    throw new InstallationHandoffError("invalid_arguments", "Operation entropy is invalid.");
  }
  return `handoff_${Buffer.from(bytes).toString("hex")}`;
}

function countMatching(values: readonly string[], pattern: RegExp): number {
  return values.filter((value) => pattern.test(value)).length;
}

function integerField(value: unknown, field: string): number {
  if (!isRecord(value) || !Number.isSafeInteger(value[field]) || Number(value[field]) < 0) {
    throw new Error(`SQLite ${field} is invalid.`);
  }
  return Number(value[field]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "handoff" && args.length === 6) {
      const values = flagValues(args);
      const result = await performInstallationHandoff({
        backupDirectory: requireFlag(values, "--backup-directory"),
        candidateApp: requireFlag(values, "--candidate-app"),
        confirmation: requireFlag(values, "--confirm"),
      });
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
      return;
    }
    if (command === "rollback" && args.length === 4) {
      const values = flagValues(args);
      const result = await rollbackInstallationHandoff({
        backupDirectory: requireFlag(values, "--backup-directory"),
        confirmation: requireFlag(values, "--confirm"),
      });
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
      return;
    }
    if (command === "cleanup" && args.length === 4) {
      const values = flagValues(args);
      const result = await resumeCommittedInstallationHandoffCleanup({
        backupDirectory: requireFlag(values, "--backup-directory"),
        confirmation: requireFlag(values, "--confirm"),
      });
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
      return;
    }
    throw new InstallationHandoffError(
      "invalid_arguments",
      "Usage: installation-handoff.ts handoff --candidate-app ABS --backup-directory ABS --confirm RETIRE-OPRTE-IN-FAVOR-OF-HRA | cleanup --backup-directory ABS --confirm CLEAN-COMMITTED-HRA-HANDOFF-STAGING | rollback --backup-directory ABS --confirm ROLL-BACK-HRA-TO-OPRTE",
    );
  } catch (error: unknown) {
    const failure = error instanceof InstallationHandoffError
      ? error
      : new InstallationHandoffError("continuity_failed", message(error));
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "error",
      code: failure.code,
      message: failure.message,
    })}\n`);
    process.exitCode = 1;
  }
}

function flagValues(args: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--") || values.has(name)) {
      throw new InstallationHandoffError("invalid_arguments", "Handoff flags are invalid.");
    }
    values.set(name, value);
  }
  return values;
}

function requireFlag(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) {
    throw new InstallationHandoffError("invalid_arguments", `Missing ${name}.`);
  }
  return value;
}

if (import.meta.main) await main();
