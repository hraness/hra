import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { z } from "@hra-internal/schema";
import {
  assertBoundedControlPlaneIntegrity,
  ControlPlaneIntegrityError,
} from "./control-plane-integrity";
import {
  assertRecoverableMissingControlPlaneRestore,
  controlPlaneRestoreJournalFileName,
  legacyControlPlaneRestoreV1FileNames,
} from "./control-plane-restore-state";

/**
 * Opaque physical state authority retained for the first in-place HRA bridge.
 * Display identity and new source vocabulary must not derive from this name.
 */
export const legacyOprteApplicationSupportDirectoryName = "OPRTE";

const historicalOprteDirectoryName = "Oprte";
const historicalOperateDevelopmentDirectoryName = "OPeRaTE";
const predecessorDirectoryName = "Kitchen";
const legacyDevelopmentDirectoryName = "Hraness Kitchen Development";
const predecessorPrimaryDirectoryName = "Hraness Kitchen";
const migrationReceiptFileName = ".oprte-application-support-migration-v2.json";
const migrationStageDirectoryName = ".oprte-application-support-migration-v2.stage";
const migrationLockFileName = ".oprte-application-support-migration-v2.lock.sqlite";
const legacyV1ReceiptFileName = ".hraness-kitchen-application-support-migration-v1.json";
const legacyV1StageDirectoryName = ".hraness-kitchen-application-support-migration-v1.stage";
const maximumMetadataBytes = 1_024;
const operationReceiptKeyFileName = "operation-receipts.hmac.key";
const operationReceiptKeyBytes = 32;

const legacySourceSchema = z.enum([
  "oprte",
  "operateDevelopment",
  "kitchen",
  "kitchenDevelopment",
  "hranessKitchen",
  "v1Stage",
]);
const migrationPhaseSchema = z.enum(["prepared", "staged", "published", "activated"]);
const migrationReceiptSchema = z
  .object({
    version: z.literal(2),
    kind: z.literal("oprte-application-support-migration"),
    source: z.union([z.literal("none"), legacySourceSchema]),
    phase: migrationPhaseSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.source === "none" && receipt.phase !== "activated") {
      context.addIssue({
        code: "custom",
        message: "A non-migration receipt may only record activated state",
      });
    }
  });
const legacyV1ReceiptSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("hraness-kitchen-application-support-migration"),
    source: z.union([
      z.literal("none"),
      z.enum([
        "oprte",
        "operateDevelopment",
        "kitchen",
        "kitchenDevelopment",
      ]),
    ]),
    phase: migrationPhaseSchema,
  })
  .strict();
const downgradeGuardSchema = z
  .union([
    z.object({
      version: z.literal(2),
      kind: z.literal("oprte-application-support-downgrade-guard"),
      target: z.literal(legacyOprteApplicationSupportDirectoryName),
    }).strict(),
    z.object({
      version: z.literal(1),
      kind: z.literal("hraness-kitchen-downgrade-guard"),
      target: z.literal("Hraness Kitchen"),
    }).strict(),
  ]);
const walCheckpointSchema = z
  .object({
    busy: z.number().int().nonnegative(),
    log: z.number().int().min(-1),
    checkpointed: z.number().int().min(-1),
  })
  .passthrough();
const sqlitePresenceSchema = z
  .object({ present: z.union([z.literal(0), z.literal(1)]) })
  .strict();

type LegacySource = z.infer<typeof legacySourceSchema>;
type MigrationReceipt = z.infer<typeof migrationReceiptSchema>;
type MigrationPhase = z.infer<typeof migrationPhaseSchema>;

export interface ApplicationSupportPaths {
  readonly parent: string;
  readonly target: string;
  /** Most recent production root, retained as the primary test/migration source. */
  readonly legacy: string;
  readonly developmentFallback: string;
  readonly historicalOprte: string;
  readonly historicalOperateDevelopment: string;
  readonly predecessor: string;
  readonly legacyV1Stage: string;
  readonly legacyV1Receipt: string;
  readonly stage: string;
  readonly receipt: string;
  readonly lock: string;
}

export type ApplicationSupportMigrationState =
  | Readonly<{ kind: "neither" }>
  | Readonly<{ kind: "legacyOnly"; source: LegacySource }>
  | Readonly<{ kind: "targetOnly" }>
  | Readonly<{ kind: "completedRetry"; source: LegacySource | "none" }>
  | Readonly<{
      kind: "interruptedRetry";
      source: LegacySource;
      phase: Exclude<MigrationPhase, "activated">;
    }>
  | Readonly<{
      kind: "conflictingBoth";
      reason: "multipleLegacyRoots" | "legacyAndTarget";
    }>;

export type ApplicationSupportReadinessInspection =
  | Readonly<{ kind: "fresh" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{
      kind: "retry";
      reason: "legacy" | "interrupted" | "interruptedRestore";
    }>
  | Readonly<{ kind: "conflict"; reason: "roots" | "locked" | "unsafe" }>;

export type ApplicationSupportMigrationFaultPoint =
  | "afterPreparedReceipt"
  | "afterExchangeGuardPrepared"
  | "afterSourceExchanged"
  | "afterSourceStaged"
  | "afterStagedReceipt"
  | "afterTargetPublished"
  | "afterPublishedReceipt"
  | "afterLegacyOprteDowngradeGuard"
  | "afterDevelopmentDowngradeGuard"
  | "afterActivatedReceipt"
  | "afterTargetRestagedForRollback"
  | "afterSourceRestored";

export interface ApplicationSupportMigrationOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly exchangePaths?: (left: string, right: string) => void;
  readonly isFileOpenByAnotherProcess?: (path: string) => boolean;
  readonly sameLegacyRootIdentity?: (
    left: Pick<Stats, "dev" | "ino">,
    right: Pick<Stats, "dev" | "ino">,
  ) => boolean;
  /** Test seam for case-insensitive path aliasing; production probes dev/ino. */
  readonly caseInsensitivePathAlias?: (path: string, target: string) => boolean;
  readonly onCheckpoint?: (point: ApplicationSupportMigrationFaultPoint) => void;
}

export class ApplicationSupportMigrationError extends Error {
  readonly code:
    | "conflicting_roots"
    | "cross_device_root"
    | "invalid_metadata"
    | "invalid_state"
    | "legacy_state_in_use"
    | "migration_locked"
    | "unsafe_root";
  readonly path: string | null;

  constructor(
    code: ApplicationSupportMigrationError["code"],
    message: string,
    path: string | null = null,
  ) {
    super(message);
    this.name = "ApplicationSupportMigrationError";
    this.code = code;
    this.path = path;
  }
}

export class ApplicationSupportStartup {
  readonly root: string;
  readonly initialState: ApplicationSupportMigrationState["kind"];
  readonly #options: ApplicationSupportMigrationOptions;
  readonly #paths: ApplicationSupportPaths;
  readonly #source: LegacySource | "none";
  #lock: Database | null;
  #activated: boolean;

  constructor(input: {
    readonly activated: boolean;
    readonly initialState: ApplicationSupportMigrationState["kind"];
    readonly options: ApplicationSupportMigrationOptions;
    readonly paths: ApplicationSupportPaths;
    readonly source: LegacySource | "none";
    readonly lock: Database;
  }) {
    this.root = input.paths.target;
    this.initialState = input.initialState;
    this.#activated = input.activated;
    this.#options = input.options;
    this.#paths = input.paths;
    this.#source = input.source;
    this.#lock = input.lock;
  }

  get activated(): boolean {
    return this.#activated;
  }

  get migratedFromRoot(): string | null {
    return this.#source === "none" ? null : sourcePath(this.#paths, this.#source);
  }

  hasControlPlaneDatabase(): boolean {
    return protectedFileMetadata(join(this.root, "control-plane.sqlite")) !== null;
  }

  prepareTargetRoot(): void {
    ensureDirectDirectory(this.#paths.target, legacyOprteApplicationSupportDirectoryName);
    validateOwnedTree(this.#paths.target);
    verifyControlPlaneCutover(this.#paths.target, this.#options);
  }

  preserveForwardOnlyForRetry(): void {
    try {
      if (this.#source === "none") {
        throw invalidState("A non-migration startup has no forward-only cutover to preserve");
      }
      assertOwnedDirectory(this.#paths.target, "target");
      const receipt = readMigrationReceipt(this.#paths.receipt);
      if (
        receipt === null
        || receipt.source !== this.#source
        || (receipt.phase !== "published" && receipt.phase !== "activated")
      ) {
        throw invalidState("Forward-only migration state is unavailable for retry");
      }
      installAllDowngradeGuards(this.#paths, this.#options);
      if (receipt.phase === "activated") this.#activated = true;
    } finally {
      this.#releaseLock();
    }
  }

  activate(): void {
    assertOwnedDirectory(this.#paths.target, "target");
    validateOwnedTree(this.#paths.target);
    const existingReceipt = readMigrationReceipt(this.#paths.receipt);
    if (existingReceipt?.phase === "activated") {
      this.#activated = true;
      installDowngradeGuards(this.#paths, this.#options);
      this.#releaseLock();
      return;
    }
    if (this.#source !== "none") {
      if (
        existingReceipt === null
        || existingReceipt.source !== this.#source
        || existingReceipt.phase !== "published"
      ) {
        throw invalidState("The published migration receipt is missing before activation");
      }
    }

    installDowngradeGuards(this.#paths, this.#options);
    writeMigrationReceipt(this.#paths, {
      version: 2,
      kind: "oprte-application-support-migration",
      source: this.#source,
      phase: "activated",
    });
    this.#activated = true;
    checkpoint(this.#options, "afterActivatedReceipt");
    this.#releaseLock();
  }

  rollbackBeforeActivation(): boolean {
    try {
      return this.#rollbackBeforeActivation();
    } finally {
      this.#releaseLock();
    }
  }

  #rollbackBeforeActivation(): boolean {
    if (this.#source === "none") return false;

    const receipt = readMigrationReceipt(this.#paths.receipt);
    if (receipt?.phase === "activated") {
      this.#activated = true;
      return false;
    }
    if (this.#activated) return false;

    const target = readExactRoot(this.#paths.target, false);
    const stage = readRoot(this.#paths.stage, true);
    const legacySourcePath = sourcePath(this.#paths, this.#source);
    const source = readExactRoot(legacySourcePath, true);
    if (source.kind === "directory" && (target.kind === "directory" || stage.kind === "directory")) {
      throw conflict("Rollback found both the legacy and migrated roots");
    }
    if (target.kind === "directory" && stage.kind === "directory") {
      throw conflict("Rollback found both the target and staging roots");
    }

    if (target.kind === "directory") {
      renameOwnedDirectory(this.#paths, this.#paths.target, this.#paths.stage);
      checkpoint(this.#options, "afterTargetRestagedForRollback");
      writeMigrationReceipt(this.#paths, migrationReceipt(this.#source, "staged"));
    }

    let currentStage = readRoot(this.#paths.stage, true);
    let currentSource = readExactRoot(legacySourcePath, true);
    if (currentStage.kind === "directory") {
      if (currentSource.kind === "missing") {
        installDowngradeGuard(legacySourcePath, this.#paths.parent);
        currentSource = readExactRoot(legacySourcePath, true);
      }
      if (currentSource.kind !== "guard") {
        throw conflict("Rollback cannot replace an existing legacy root");
      }
      exchangeOwnedPaths(
        this.#paths,
        legacySourcePath,
        this.#paths.stage,
        this.#options,
      );
      checkpoint(this.#options, "afterSourceRestored");
      currentStage = readRoot(this.#paths.stage, true);
      currentSource = readExactRoot(legacySourcePath, true);
    }
    if (currentSource.kind !== "directory") {
      throw invalidState("Rollback could not find migrated state to restore");
    }
    if (currentStage.kind === "guard") removeOwnedGuard(this.#paths.stage);
    else if (currentStage.kind !== "missing") {
      throw invalidState("Rollback left an unexpected staging root");
    }
    for (const { path } of legacySourceEntries(this.#paths)) {
      if (!caseFoldAliasesTarget(path, this.#paths.target, this.#options)) {
        removeOwnedGuard(path);
      }
    }

    removeMigrationReceipt(this.#paths.receipt, this.#paths.parent);
    return true;
  }

  #releaseLock(): void {
    const lock = this.#lock;
    this.#lock = null;
    if (lock === null) return;
    try {
      lock.exec("ROLLBACK");
    } finally {
      lock.close();
    }
  }
}

type RootState =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "directory"; metadata: Stats }>
  | Readonly<{ kind: "guard" }>;

export function applicationSupportPaths(homeDirectory: string): ApplicationSupportPaths {
  if (!isAbsolute(homeDirectory) || homeDirectory === parse(homeDirectory).root) {
    throw new Error("HOME must be an absolute user directory");
  }
  const parent = join(homeDirectory, "Library", "Application Support");
  return {
    parent,
    target: join(parent, legacyOprteApplicationSupportDirectoryName),
    legacy: join(parent, predecessorPrimaryDirectoryName),
    developmentFallback: join(parent, legacyDevelopmentDirectoryName),
    historicalOprte: join(parent, historicalOprteDirectoryName),
    historicalOperateDevelopment: join(
      parent,
      historicalOperateDevelopmentDirectoryName,
    ),
    predecessor: join(parent, predecessorDirectoryName),
    legacyV1Stage: join(parent, legacyV1StageDirectoryName),
    legacyV1Receipt: join(parent, legacyV1ReceiptFileName),
    stage: join(parent, migrationStageDirectoryName),
    receipt: join(parent, migrationReceiptFileName),
    lock: join(parent, migrationLockFileName),
  };
}

export function applicationSupportRoot(homeDirectory: string): string {
  return applicationSupportPaths(homeDirectory).target;
}

export function inspectApplicationSupportMigration(
  environment: NodeJS.ProcessEnv = process.env,
  options: Pick<ApplicationSupportMigrationOptions, "sameLegacyRootIdentity"> = {},
): ApplicationSupportMigrationState {
  const paths = pathsFromEnvironment(environment);
  ensureApplicationSupportParent(paths.parent);
  return inspectPaths(
    paths,
    options.sameLegacyRootIdentity ?? sameFileIdentity,
  );
}

/**
 * Classifies startup authority without creating ancestors, acquiring the
 * migration lock, selecting a legacy source, or exposing any local path.
 */
export function inspectApplicationSupportReadiness(
  options: Pick<
    ApplicationSupportMigrationOptions,
    "environment" | "isFileOpenByAnotherProcess" | "sameLegacyRootIdentity"
  > = {},
): ApplicationSupportReadinessInspection {
  try {
    const paths = pathsFromEnvironment(options.environment ?? process.env);
    const library = dirname(paths.parent);
    const home = dirname(library);
    const homeMetadata = readMetadata(home);
    if (
      homeMetadata === null || homeMetadata.isSymbolicLink() ||
      !homeMetadata.isDirectory()
    ) return { kind: "conflict", reason: "unsafe" };

    const libraryMetadata = readMetadata(library);
    if (libraryMetadata === null) return { kind: "fresh" };
    if (libraryMetadata.isSymbolicLink() || !libraryMetadata.isDirectory()) {
      return { kind: "conflict", reason: "unsafe" };
    }
    const parentMetadata = readMetadata(paths.parent);
    if (parentMetadata === null) return { kind: "fresh" };
    if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
      return { kind: "conflict", reason: "unsafe" };
    }

    const lockMetadata = readMetadata(paths.lock);
    if (
      lockMetadata !== null &&
      (lockMetadata.isSymbolicLink() || !lockMetadata.isFile())
    ) return { kind: "conflict", reason: "unsafe" };
    if (
      lockMetadata !== null &&
      (options.isFileOpenByAnotherProcess ?? defaultOpenFileInspection)(paths.lock)
    ) return { kind: "conflict", reason: "locked" };

    const state = inspectPaths(
      paths,
      options.sameLegacyRootIdentity ?? sameFileIdentity,
    );
    const interruptedRestore = validateStateTree(paths);
    switch (state.kind) {
      case "neither":
        return { kind: "fresh" };
      case "targetOnly":
      case "completedRetry":
        return interruptedRestore
          ? { kind: "retry", reason: "interruptedRestore" }
          : { kind: "ready" };
      case "legacyOnly":
        return { kind: "retry", reason: "legacy" };
      case "interruptedRetry":
        return { kind: "retry", reason: "interrupted" };
      case "conflictingBoth":
        return { kind: "conflict", reason: "roots" };
    }
  } catch (error: unknown) {
    if (
      error instanceof ApplicationSupportMigrationError &&
      error.code === "migration_locked"
    ) return { kind: "conflict", reason: "locked" };
    if (
      error instanceof ApplicationSupportMigrationError &&
      error.code === "conflicting_roots"
    ) return { kind: "conflict", reason: "roots" };
    return { kind: "conflict", reason: "unsafe" };
  }
}

export function prepareApplicationSupportMigration(
  options: ApplicationSupportMigrationOptions = {},
): ApplicationSupportStartup {
  const paths = pathsFromEnvironment(options.environment ?? process.env);
  ensureApplicationSupportParent(paths.parent);
  const lock = acquireMigrationLock(paths);
  try {
    const initialState = inspectPaths(
      paths,
      options.sameLegacyRootIdentity ?? sameFileIdentity,
    );
    validateStateTree(paths);

    switch (initialState.kind) {
      case "conflictingBoth":
        throw conflict(
          initialState.reason === "multipleLegacyRoots"
            ? "Both historical Application Support roots exist"
            : "Legacy and OPRTE Application Support roots both exist",
        );
      case "completedRetry":
        return new ApplicationSupportStartup({
          activated: true,
          initialState: initialState.kind,
          lock,
          options,
          paths,
          source: initialState.source,
        });
      case "neither":
      case "targetOnly":
        return new ApplicationSupportStartup({
          activated: false,
          initialState: initialState.kind,
          lock,
          options,
          paths,
          source: "none",
        });
      case "legacyOnly":
        publishLegacyRoot(paths, initialState.source, options);
        return new ApplicationSupportStartup({
          activated: false,
          initialState: initialState.kind,
          lock,
          options,
          paths,
          source: initialState.source,
        });
      case "interruptedRetry":
        resumeInterruptedMigration(paths, initialState, options);
        return new ApplicationSupportStartup({
          activated: false,
          initialState: initialState.kind,
          lock,
          options,
          paths,
          source: initialState.source,
        });
    }
  } catch (error: unknown) {
    releaseMigrationLock(lock);
    throw error;
  }
}

function inspectPaths(
  paths: ApplicationSupportPaths,
  rootsHaveSameIdentity: (
    left: Pick<Stats, "dev" | "ino">,
    right: Pick<Stats, "dev" | "ino">,
  ) => boolean,
): ApplicationSupportMigrationState {
  validateLegacyV1Receipt(paths.legacyV1Receipt);
  const target = readExactRoot(paths.target, false);
  const stage = readRoot(paths.stage, true);
  const receipt = readMigrationReceipt(paths.receipt);

  const legacyDirectories: LegacySource[] = [];
  const legacyStates = legacySourceEntries(paths).map(({ source, path }) => ({
    source,
    state: readExactRoot(path, true),
  }));
  const distinctDirectoryMetadata: Array<Pick<Stats, "dev" | "ino">> = [];
  for (const entry of legacyStates) {
    const state = entry.state;
    if (state.kind !== "directory") continue;
    if (distinctDirectoryMetadata.some((metadata) =>
      rootsHaveSameIdentity(metadata, state.metadata)
    )) continue;
    distinctDirectoryMetadata.push(state.metadata);
    legacyDirectories.push(entry.source);
  }

  if (legacyDirectories.length > 1) {
    return { kind: "conflictingBoth", reason: "multipleLegacyRoots" };
  }
  if (legacyDirectories.length === 1 && target.kind === "directory") {
    return { kind: "conflictingBoth", reason: "legacyAndTarget" };
  }

  if (receipt?.phase === "activated") {
    if (target.kind !== "directory" || stage.kind !== "missing" || legacyDirectories.length > 0) {
      throw invalidState("Activated Application Support authority is inconsistent");
    }
    return { kind: "completedRetry", source: receipt.source };
  }

  if (stage.kind !== "missing" || receipt !== null) {
    const source = interruptedSource(receipt, legacyDirectories);
    return {
      kind: "interruptedRetry",
      source,
      phase: receipt?.phase ?? "staged",
    };
  }

  if (target.kind === "directory") return { kind: "targetOnly" };
  const legacySource = legacyDirectories[0];
  if (legacySource !== undefined) return { kind: "legacyOnly", source: legacySource };

  if (legacyStates.some(({ state }) => state.kind === "guard")) {
    throw invalidState("Downgrade guards exist without activated OPRTE state");
  }
  return { kind: "neither" };
}

function interruptedSource(
  receipt: MigrationReceipt | null,
  roots: readonly LegacySource[],
): LegacySource {
  if (receipt?.source === "none") {
    throw invalidState("A non-migration receipt cannot describe interrupted state");
  }
  if (receipt !== null) {
    const root = roots[0];
    if (root !== undefined && root !== receipt.source) {
      throw conflict("The migration receipt names a different legacy root");
    }
    return receipt.source;
  }
  const root = roots[0];
  if (root === undefined) {
    throw invalidState("A staging root exists without a migration receipt");
  }
  return root;
}

function resumeInterruptedMigration(
  paths: ApplicationSupportPaths,
  state: Extract<ApplicationSupportMigrationState, { kind: "interruptedRetry" }>,
  options: ApplicationSupportMigrationOptions,
): void {
  const target = readExactRoot(paths.target, false);
  const stage = readRoot(paths.stage, true);
  const source = readExactRoot(sourcePath(paths, state.source), true);

  if (target.kind === "directory") {
    if (stage.kind !== "missing" || source.kind === "directory") {
      throw conflict("Interrupted migration found more than one state root");
    }
    assertControlPlaneDescriptorClosed(paths.target, options);
    installAllDowngradeGuards(paths, options);
    writeMigrationReceipt(paths, migrationReceipt(state.source, "published"));
    checkpoint(options, "afterPublishedReceipt");
    return;
  }

  if (stage.kind === "directory") {
    if (source.kind === "directory") {
      throw conflict("Interrupted migration found both legacy and staging roots");
    }
    assertControlPlaneDescriptorClosed(paths.stage, options);
    installAllDowngradeGuards(paths, options);
    writeMigrationReceipt(paths, migrationReceipt(state.source, "staged"));
    checkpoint(options, "afterStagedReceipt");
    if (caseFoldAliasesTarget(
      sourcePath(paths, state.source),
      paths.target,
      options,
    )) {
      removeOwnedGuard(sourcePath(paths, state.source));
    }
    renameOwnedDirectory(paths, paths.stage, paths.target);
    checkpoint(options, "afterTargetPublished");
    writeMigrationReceipt(paths, migrationReceipt(state.source, "published"));
    checkpoint(options, "afterPublishedReceipt");
    return;
  }

  if (source.kind === "directory") {
    publishLegacyRoot(paths, state.source, options);
    return;
  }
  throw invalidState("Interrupted migration contains no recoverable Application Support root");
}

function publishLegacyRoot(
  paths: ApplicationSupportPaths,
  source: LegacySource,
  options: ApplicationSupportMigrationOptions,
): void {
  const sourceRoot = sourcePath(paths, source);
  validateOwnedTree(sourceRoot);
  verifyControlPlaneCutover(sourceRoot, options);
  assertSameVolume(paths.parent, sourceRoot);
  writeMigrationReceipt(paths, migrationReceipt(source, "prepared"));
  checkpoint(options, "afterPreparedReceipt");
  installDowngradeGuard(paths.stage, paths.parent);
  checkpoint(options, "afterExchangeGuardPrepared");
  assertControlPlaneDescriptorClosed(sourceRoot, options);
  exchangeOwnedPaths(paths, sourceRoot, paths.stage, options);
  try {
    // The exchange has replaced the old path with a downgrade guard, so no
    // new legacy opener can enter after this second descriptor check.
    assertControlPlaneDescriptorClosed(paths.stage, options);
  } catch (error: unknown) {
    try {
      exchangeOwnedPaths(paths, sourceRoot, paths.stage, options);
    } catch {
      throw new ApplicationSupportMigrationError(
        "invalid_state",
        "Legacy SQLite state became live during cutover and could not be restored",
        paths.stage,
      );
    }
    throw error;
  }
  checkpoint(options, "afterSourceExchanged");
  installAllDowngradeGuards(paths, options);
  checkpoint(options, "afterSourceStaged");
  writeMigrationReceipt(paths, migrationReceipt(source, "staged"));
  checkpoint(options, "afterStagedReceipt");
  if (caseFoldAliasesTarget(sourceRoot, paths.target, options)) {
    // APFS cannot retain a guard at `Oprte` while publishing `OPRTE`.
    // The synced v2 receipt and staged root make this case-only window
    // recoverable after a crash.
    removeOwnedGuard(sourceRoot);
  }
  renameOwnedDirectory(paths, paths.stage, paths.target);
  checkpoint(options, "afterTargetPublished");
  writeMigrationReceipt(paths, migrationReceipt(source, "published"));
  checkpoint(options, "afterPublishedReceipt");
}

function migrationReceipt(source: LegacySource, phase: Exclude<MigrationPhase, "activated">): MigrationReceipt {
  return {
    version: 2,
    kind: "oprte-application-support-migration",
    source,
    phase,
  };
}

function installDowngradeGuards(
  paths: ApplicationSupportPaths,
  options: ApplicationSupportMigrationOptions,
): void {
  installAllDowngradeGuards(paths, options);
  checkpoint(options, "afterLegacyOprteDowngradeGuard");
  checkpoint(options, "afterDevelopmentDowngradeGuard");
}

function installAllDowngradeGuards(
  paths: ApplicationSupportPaths,
  options: ApplicationSupportMigrationOptions,
): void {
  for (const { path } of legacySourceEntries(paths)) {
    // A case-insensitive volume cannot hold both `Oprte` and `OPRTE`.
    // The old spelling resolves to the canonical target there, so a guard is
    // neither possible nor necessary.
    if (!caseFoldAliasesTarget(path, paths.target, options)) {
      installDowngradeGuard(path, paths.parent);
    }
  }
}

function installDowngradeGuard(path: string, parent: string): void {
  const existing = readRoot(path, true);
  if (existing.kind === "guard") return;
  if (existing.kind !== "missing") {
    throw conflict("A legacy state root appeared before downgrade protection");
  }

  const bytes = `${JSON.stringify({
    version: 2,
    kind: "oprte-application-support-downgrade-guard",
    target: legacyOprteApplicationSupportDirectoryName,
  })}\n`;
  publishNewFile(path, parent, bytes);
}

function removeOwnedGuard(path: string): void {
  const state = readRoot(path, true);
  if (state.kind !== "guard") return;
  unlinkSync(path);
  syncDirectory(join(path, ".."));
}

function readRoot(path: string, allowGuard: boolean): RootState {
  const metadata = readMetadata(path);
  if (metadata === null) return { kind: "missing" };
  if (metadata.isSymbolicLink()) throw unsafeRoot(path, "symbolic link");
  if (metadata.isDirectory()) return { kind: "directory", metadata };
  if (allowGuard && metadata.isFile()) {
    try {
      const value = readBoundedJson(path, "downgrade guard");
      const parsed = downgradeGuardSchema.safeParse(value);
      if (parsed.success) return { kind: "guard" };
    } catch (error: unknown) {
      if (!(error instanceof ApplicationSupportMigrationError)) throw error;
    }
  }
  throw unsafeRoot(path, "not an owned directory");
}

/** Resolve only an exact directory-entry spelling, even on case-folding APFS. */
function readExactRoot(path: string, allowGuard: boolean): RootState {
  const parent = dirname(path);
  const expectedName = basename(path);
  const directory = opendirSync(parent);
  let present = false;
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (entry.name === expectedName) {
        present = true;
        break;
      }
    }
  } finally {
    directory.closeSync();
  }
  return present ? readRoot(path, allowGuard) : { kind: "missing" };
}

function validateLegacyV1Receipt(path: string): void {
  const metadata = readMetadata(path);
  if (metadata === null) return;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ApplicationSupportMigrationError(
      "invalid_metadata",
      "Legacy Application Support migration receipt must be a regular file",
      path,
    );
  }
  const parsed = legacyV1ReceiptSchema.safeParse(
    readBoundedJson(path, "legacy v1 migration receipt"),
  );
  if (!parsed.success) {
    throw new ApplicationSupportMigrationError(
      "invalid_metadata",
      "Legacy Application Support migration receipt is invalid",
      path,
    );
  }
}

function readMigrationReceipt(path: string): MigrationReceipt | null {
  const metadata = readMetadata(path);
  if (metadata === null) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ApplicationSupportMigrationError(
      "invalid_metadata",
      "Application Support migration receipt must be a regular file",
      path,
    );
  }
  const value = readBoundedJson(path, "migration receipt");
  const parsed = migrationReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationSupportMigrationError(
      "invalid_metadata",
      "Application Support migration receipt is invalid",
      path,
    );
  }
  return parsed.data;
}

function readBoundedJson(path: string, label: string): unknown {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumMetadataBytes) {
      throw new ApplicationSupportMigrationError(
        "invalid_metadata",
        `Application Support ${label} has an invalid size`,
        path,
      );
    }
    const text = readFileSync(descriptor, "utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApplicationSupportMigrationError(
        "invalid_metadata",
        `Application Support ${label} is not valid JSON`,
        path,
      );
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeMigrationReceipt(paths: ApplicationSupportPaths, receipt: MigrationReceipt): void {
  const parsed = migrationReceiptSchema.parse(receipt);
  replaceFile(paths.receipt, paths.parent, `${JSON.stringify(parsed)}\n`);
}

function removeMigrationReceipt(path: string, parent: string): void {
  const receipt = readMigrationReceipt(path);
  if (receipt === null) return;
  unlinkSync(path);
  syncDirectory(parent);
}

function replaceFile(path: string, parent: string, bytes: string): void {
  const candidate = temporaryCandidate(path);
  recoverTemporaryCandidate(path, parent);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      candidate,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes, "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(candidate, path);
    chmodSync(path, 0o600);
    syncDirectory(parent);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    removeCandidate(candidate);
  }
}

function publishNewFile(path: string, parent: string, bytes: string): void {
  const candidate = temporaryCandidate(path);
  recoverTemporaryCandidate(path, parent);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      candidate,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes, "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(candidate, path);
      syncDirectory(parent);
    } catch (error: unknown) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (readRoot(path, true).kind !== "guard") {
        throw conflict("A legacy state root appeared while writing its downgrade guard");
      }
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    removeCandidate(candidate);
  }
}

function removeCandidate(path: string): void {
  try {
    unlinkSync(path);
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      // An orphan private candidate is safer than masking the durable result.
    }
  }
}

function temporaryCandidate(path: string): string {
  return `${path}.tmp`;
}

function recoverTemporaryCandidate(path: string, parent: string): void {
  const candidatePath = temporaryCandidate(path);
  const candidate = readMetadata(candidatePath);
  if (candidate === null) return;
  const parentMetadata = lstatSync(parent);
  if (
    !candidate.isFile() ||
    candidate.isSymbolicLink() ||
    candidate.uid !== process.geteuid?.() ||
    candidate.nlink < 1 ||
    candidate.nlink > 2 ||
    (candidate.mode & 0o777) !== 0o600 ||
    candidate.size < 0 ||
    candidate.size > maximumMetadataBytes ||
    candidate.dev !== parentMetadata.dev
  ) {
    throw unsafeRoot(candidatePath, "temporary migration metadata is unsafe");
  }
  if (candidate.nlink === 2) {
    const published = readMetadata(path);
    if (
      published === null ||
      published.dev !== candidate.dev ||
      published.ino !== candidate.ino
    ) {
      throw unsafeRoot(
        candidatePath,
        "temporary migration metadata has an unexpected hard link",
      );
    }
  }
  unlinkSync(candidatePath);
  syncDirectory(parent);
}

function renameOwnedDirectory(
  paths: ApplicationSupportPaths,
  from: string,
  to: string,
): void {
  assertOwnedDirectory(from, "source");
  if (readMetadata(to) !== null) {
    throw conflict("Application Support migration cannot replace an existing path");
  }
  assertSameVolume(paths.parent, from);
  renameSync(from, to);
  syncDirectory(paths.parent);
}

function exchangeOwnedPaths(
  paths: ApplicationSupportPaths,
  left: string,
  right: string,
  options: ApplicationSupportMigrationOptions,
): void {
  if (dirname(left) !== paths.parent || dirname(right) !== paths.parent) {
    throw invalidState("Application Support exchange paths must be sibling-owned roots");
  }
  const leftMetadata = readMetadata(left);
  const rightMetadata = readMetadata(right);
  if (leftMetadata === null || rightMetadata === null) {
    throw invalidState("Application Support exchange requires both owned paths");
  }
  if (leftMetadata.isSymbolicLink() || rightMetadata.isSymbolicLink()) {
    throw unsafeRoot(
      leftMetadata.isSymbolicLink() ? left : right,
      "atomic exchange path is a symbolic link",
    );
  }
  assertSameVolume(paths.parent, left);
  assertSameVolume(paths.parent, right);
  const exchange = options.exchangePaths ?? defaultExchangePaths;
  exchange(left, right);
  syncDirectory(paths.parent);
}

function defaultExchangePaths(left: string, right: string): void {
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      renameatx_np: {
        args: [
          FFIType.i32,
          FFIType.cstring,
          FFIType.i32,
          FFIType.cstring,
          FFIType.u32,
        ],
        returns: FFIType.i32,
      },
    });
    try {
      const leftBytes = Buffer.from(`${left}\0`);
      const rightBytes = Buffer.from(`${right}\0`);
      const atCurrentWorkingDirectory = -2;
      const renameSwap = 0x00000002;
      const result = library.symbols.renameatx_np(
        atCurrentWorkingDirectory,
        leftBytes,
        atCurrentWorkingDirectory,
        rightBytes,
        renameSwap,
      );
      if (result !== 0) {
        throw new ApplicationSupportMigrationError(
          "invalid_state",
          "macOS could not atomically exchange the legacy root and downgrade guard",
          left,
        );
      }
      return;
    } finally {
      library.close();
    }
  }

  const candidate = `${left}.swap`;
  renameSync(left, candidate);
  try {
    renameSync(right, left);
    renameSync(candidate, right);
  } catch (error: unknown) {
    try {
      if (readMetadata(left) === null) renameSync(candidate, left);
    } catch {
      // Portable development fallback remains fail-closed for the next retry.
    }
    throw error;
  }
}

function assertOwnedDirectory(path: string, label: string): void {
  const metadata = readMetadata(path);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafeRoot(path, `${label} is not a directory`);
  }
}

function assertSameVolume(parent: string, source: string): void {
  const parentMetadata = statSync(parent);
  const sourceMetadata = lstatSync(source);
  if (parentMetadata.dev !== sourceMetadata.dev) {
    throw new ApplicationSupportMigrationError(
      "cross_device_root",
      "Legacy Application Support state is not on the target volume",
      source,
    );
  }
}

function validateStateTree(paths: ApplicationSupportPaths): boolean {
  let interruptedRestore = false;
  for (const path of [
    paths.target,
    paths.stage,
    ...legacySourceEntries(paths).map(({ path }) => path),
  ]) {
    const metadata = readMetadata(path);
    if (metadata?.isDirectory()) {
      interruptedRestore = validateOwnedTree(path) || interruptedRestore;
    }
  }
  return interruptedRestore;
}

function validateOwnedTree(root: string): boolean {
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw unsafeRoot(root, "state-tree root is not a directory");
  }
  const interruptedRestore = validateProtectedStateFiles(root);
  const device = rootMetadata.dev;
  const pending = [root];

  while (pending.length > 0) {
    const directoryPath = pending.pop();
    if (directoryPath === undefined) break;
    const directory = opendirSync(directoryPath);
    try {
      while (true) {
        const entry = directory.readSync();
        if (entry === null) break;
        const path = join(directoryPath, entry.name);
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) {
          throw unsafeRoot(path, "nested symbolic link");
        }
        if (metadata.dev !== device) {
          throw new ApplicationSupportMigrationError(
            "cross_device_root",
            "Application Support state crosses a filesystem boundary",
            path,
          );
        }
        if (metadata.isDirectory()) {
          if (!isOpaqueStateDirectory(root, path)) pending.push(path);
          continue;
        }
        if (!metadata.isFile()) {
          throw unsafeRoot(path, "nested FIFO, socket, or device");
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  return interruptedRestore;
}

function validateProtectedStateFiles(root: string): boolean {
  const databasePath = join(root, "control-plane.sqlite");
  const walPath = `${databasePath}-wal`;
  const sharedMemoryPath = `${databasePath}-shm`;
  const keyPath = join(root, operationReceiptKeyFileName);
  const keyCandidatePath = `${keyPath}.tmp`;
  const database = protectedFileMetadata(databasePath);
  const wal = protectedFileMetadata(walPath);
  const sharedMemory = protectedFileMetadata(sharedMemoryPath);
  const key = protectedFileMetadata(keyPath);
  const keyCandidate = readMetadata(keyCandidatePath);
  const restoreJournalPath = join(root, controlPlaneRestoreJournalFileName);
  const restoreJournal = readMetadata(restoreJournalPath);
  if (legacyControlPlaneRestoreV1FileNames.some((fileName) =>
    readMetadata(join(root, fileName)) !== null
  )) {
    throw new ApplicationSupportMigrationError(
      "invalid_state",
      "Legacy interrupted control-plane restore state requires manual recovery",
      root,
    );
  }

  let interruptedRestore = false;
  if (database === null && restoreJournal !== null) {
    try {
      assertRecoverableMissingControlPlaneRestore(databasePath);
      interruptedRestore = true;
    } catch {
      throw new ApplicationSupportMigrationError(
        "invalid_state",
        "Interrupted control-plane restore state is unsafe",
        root,
      );
    }
  } else if (database === null && (wal !== null || sharedMemory !== null)) {
    throw new ApplicationSupportMigrationError(
      "invalid_state",
      "SQLite sidecars exist without the control-plane database",
      root,
    );
  }
  if (
    database === null &&
    (key !== null || keyCandidate !== null) &&
    !interruptedRestore
  ) {
    throw new ApplicationSupportMigrationError(
      "invalid_state",
      "Established operation-receipt authority exists without the control-plane database",
      root,
    );
  }
  if (key === null) return interruptedRestore;
  const currentUser = process.getuid?.();
  if (
    key.size !== operationReceiptKeyBytes
    || key.nlink !== 1
    || (currentUser !== undefined && key.uid !== currentUser)
  ) {
    throw new ApplicationSupportMigrationError(
      "invalid_state",
      "Operation-receipt key ownership or length is invalid",
      keyPath,
    );
  }
  return interruptedRestore;
}

function protectedFileMetadata(path: string): Stats | null {
  const metadata = readMetadata(path);
  if (metadata === null) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw unsafeRoot(path, "protected state is not a singly linked regular file");
  }
  return metadata;
}

function isOpaqueStateDirectory(root: string, path: string): boolean {
  const suffix = relative(root, path);
  if (suffix.length === 0 || suffix.startsWith("..")) return false;
  const segments = suffix.split(sep);
  if (
    segments.length === 4
    && segments[0] === "codex"
    && segments[1] === "accounts"
    && segments[3] === "home"
  ) {
    return true;
  }
  if (
    segments.length === 2
    && segments[0] === "dispatch"
    && segments[1] === "codex-home"
  ) {
    return true;
  }
  if (isOpaqueManagedWorktreeDirectory(segments)) {
    return true;
  }
  return (
    segments.length === 3
    && segments[0] === "profiles"
    && segments[1] === "default"
    && segments[2] === "codex-home"
  );
}

function isOpaqueManagedWorktreeDirectory(segments: readonly string[]): boolean {
  const laneName = segments.at(-1);
  if (
    laneName === undefined
    || laneName === ".oprte-manifests"
    || laneName === ".kitchen-manifests"
  ) return false;

  return (
    segments.length === 3
    && segments[0] === "dispatch"
    && segments[1] === "worktrees"
  ) || (
    segments.length === 2
    && (segments[0] === "local-task-worktrees" || segments[0] === "chat-worktrees")
  ) || (
    segments.length === 4
    && segments[0] === "harness"
    && segments[1] === "v1"
    && segments[2] === "worktrees"
  );
}

function verifyControlPlaneCutover(
  root: string,
  options: ApplicationSupportMigrationOptions,
): void {
  const databasePath = join(root, "control-plane.sqlite");
  const metadata = readMetadata(databasePath);
  if (metadata === null) return;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw unsafeRoot(databasePath, "control-plane database is not a regular file");
  }
  assertControlPlaneDescriptorClosed(root, options);

  let database: Database | null = null;
  let transactionOpen = false;
  try {
    database = new Database(databasePath, { strict: true });
    database.exec("PRAGMA busy_timeout = 0");
    database.query("PRAGMA locking_mode = EXCLUSIVE").get();
    database.exec("BEGIN EXCLUSIVE");
    transactionOpen = true;
    database.exec("COMMIT");
    transactionOpen = false;

    const checkpointValue: unknown = database.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const checkpoint = walCheckpointSchema.parse(checkpointValue);
    const deleteJournal = checkpoint.log === -1 && checkpoint.checkpointed === -1;
    const completeWal = checkpoint.log >= 0
      && checkpoint.checkpointed >= 0
      && checkpoint.log === checkpoint.checkpointed;
    if (checkpoint.busy !== 0 || (!deleteJournal && !completeWal)) {
      throw new ApplicationSupportMigrationError(
        "legacy_state_in_use",
        "Legacy SQLite state could not be checkpointed exclusively",
        databasePath,
      );
    }
    try {
      assertBoundedControlPlaneIntegrity(database);
    } catch (error: unknown) {
      if (!(error instanceof ControlPlaneIntegrityError)) throw error;
      throw new ApplicationSupportMigrationError(
        "invalid_state",
        "Legacy SQLite state failed its integrity check",
      );
    }
    const operationReceiptTableValue: unknown = database.query(`
      SELECT EXISTS(
        SELECT 1 FROM sqlite_schema
        WHERE type = 'table' AND name = 'operation_receipts'
      ) AS present
    `).get();
    const operationReceiptTable = sqlitePresenceSchema.parse(operationReceiptTableValue);
    if (operationReceiptTable.present === 1) {
      const operationReceiptRowValue: unknown = database.query(`
        SELECT EXISTS(SELECT 1 FROM operation_receipts LIMIT 1) AS present
      `).get();
      const operationReceiptRow = sqlitePresenceSchema.parse(operationReceiptRowValue);
      if (
        operationReceiptRow.present === 1
        && readMetadata(join(root, operationReceiptKeyFileName)) === null
      ) {
        throw new ApplicationSupportMigrationError(
          "invalid_state",
          "Operation receipts exist without their installation key",
          databasePath,
        );
      }
    }
  } catch (error: unknown) {
    if (error instanceof ApplicationSupportMigrationError) throw error;
    if (hasCode(error, "SQLITE_BUSY") || hasCode(error, "SQLITE_LOCKED")) {
      throw new ApplicationSupportMigrationError(
        "legacy_state_in_use",
        "Legacy SQLite state is open in another process",
        databasePath,
      );
    }
    throw new ApplicationSupportMigrationError(
      "invalid_state",
      "Legacy SQLite state could not be validated",
      databasePath,
    );
  } finally {
    if (database !== null) {
      if (transactionOpen) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The validation error remains the authoritative failure.
        }
      }
      database.close();
    }
  }
}

function assertControlPlaneDescriptorClosed(
  root: string,
  options: ApplicationSupportMigrationOptions,
): void {
  const databasePath = join(root, "control-plane.sqlite");
  if (readMetadata(databasePath) === null) return;
  const isOpen = options.isFileOpenByAnotherProcess ?? defaultOpenFileInspection;
  if (isOpen(databasePath)) {
    throw new ApplicationSupportMigrationError(
      "legacy_state_in_use",
      "Application Support SQLite state is open in another process",
      databasePath,
    );
  }
}

function defaultOpenFileInspection(path: string): boolean {
  if (process.platform !== "darwin") return false;
  const canonicalPath = realpathSync(path);
  const result = spawnSync(
    "/usr/sbin/lsof",
    ["-n", "-P", "-T", "-F", "pn", "--", canonicalPath],
    {
      encoding: "utf8",
      env: {
        LANG: "C",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      maxBuffer: 64 * 1_024,
      // lsof must retain mmap inspection for fail-closed cutover safety. A
      // busy Darwin host can legitimately need several seconds to enumerate
      // those mappings, so bound the whole inspection without treating normal
      // system contention as corrupted migration state.
      timeout: 10_000,
    },
  );
  if (result.error !== undefined || result.signal !== null) {
    throw new ApplicationSupportMigrationError(
      "invalid_state",
      "Open-file inspection did not complete",
      path,
    );
  }
  if (
    result.status === 1
    && result.stdout.length === 0
    && result.stderr.length === 0
  ) return false;
  if (result.status !== 0) {
    throw new ApplicationSupportMigrationError(
      "invalid_state",
      "Open-file inspection returned an unexpected result",
      path,
    );
  }

  const records = result.stdout.split("\n").filter((record) => record.length > 0);
  let sawProcess = false;
  let sawExactPath = false;
  for (const record of records) {
    if (/^p[1-9][0-9]*$/u.test(record)) {
      sawProcess = true;
      continue;
    }
    if (/^f(?:[0-9]+[a-z]*|cwd|rtd|txt|mem|NOFD)$/u.test(record)) {
      continue;
    }
    if (record.startsWith("n") && record.slice(1) === canonicalPath) {
      sawExactPath = true;
      continue;
    }
    throw new ApplicationSupportMigrationError(
      "invalid_state",
      "Open-file inspection returned malformed data",
      path,
    );
  }
  if (!sawProcess || !sawExactPath) {
    throw new ApplicationSupportMigrationError(
      "invalid_state",
      "Open-file inspection did not identify its exact target",
      path,
    );
  }
  return true;
}

function acquireMigrationLock(paths: ApplicationSupportPaths): Database {
  let database: Database | null = null;
  try {
    const existing = readMetadata(paths.lock);
    if (
      existing !== null
      && (existing.isSymbolicLink() || !existing.isFile())
    ) {
      throw unsafeRoot(paths.lock, "migration lock is not a regular file");
    }
    database = new Database(paths.lock, { create: true, strict: true });
    chmodSync(paths.lock, 0o600);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS migration_lock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      ) STRICT
    `);
    database.exec("BEGIN EXCLUSIVE");
    return database;
  } catch (error: unknown) {
    database?.close();
    if (hasCode(error, "SQLITE_BUSY") || hasCode(error, "SQLITE_LOCKED")) {
      throw new ApplicationSupportMigrationError(
        "migration_locked",
        "Another OPRTE process owns the Application Support cutover",
        paths.lock,
      );
    }
    throw error;
  }
}

function releaseMigrationLock(lock: Database): void {
  try {
    lock.exec("ROLLBACK");
  } finally {
    lock.close();
  }
}

function ensureApplicationSupportParent(path: string): void {
  const library = dirname(path);
  const home = dirname(library);
  assertRealDirectory(home, "HOME");
  ensureDirectDirectory(library, "Library");
  ensureDirectDirectory(path, "Application Support");
}

function ensureDirectDirectory(path: string, label: string): void {
  const existing = readMetadata(path);
  if (existing === null) mkdirSync(path, { mode: 0o700 });
  assertRealDirectory(path, label);
}

function assertRealDirectory(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafeRoot(path, `${label} ancestor is not a real directory`);
  }
}

function pathsFromEnvironment(environment: NodeJS.ProcessEnv): ApplicationSupportPaths {
  const home = environment.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error("HOME is required for local state");
  }
  return applicationSupportPaths(home);
}

function sourcePath(paths: ApplicationSupportPaths, source: LegacySource): string {
  switch (source) {
    case "oprte": return paths.historicalOprte;
    case "operateDevelopment": return paths.historicalOperateDevelopment;
    case "kitchen": return paths.predecessor;
    case "kitchenDevelopment": return paths.developmentFallback;
    case "hranessKitchen": return paths.legacy;
    case "v1Stage": return paths.legacyV1Stage;
  }
}

function legacySourceEntries(
  paths: ApplicationSupportPaths,
): readonly Readonly<{ source: LegacySource; path: string }>[] {
  return [
    { source: "hranessKitchen", path: paths.legacy },
    { source: "kitchenDevelopment", path: paths.developmentFallback },
    { source: "oprte", path: paths.historicalOprte },
    { source: "operateDevelopment", path: paths.historicalOperateDevelopment },
    { source: "kitchen", path: paths.predecessor },
    { source: "v1Stage", path: paths.legacyV1Stage },
  ];
}

function caseFoldAliasesTarget(
  path: string,
  target: string,
  options: ApplicationSupportMigrationOptions,
): boolean {
  if (
    path === target
    || basename(path).toLocaleLowerCase("en-US")
      !== basename(target).toLocaleLowerCase("en-US")
  ) return false;
  if (options.caseInsensitivePathAlias !== undefined) {
    return options.caseInsensitivePathAlias(path, target);
  }
  const pathMetadata = readMetadata(path);
  const targetMetadata = readMetadata(target);
  if (
    pathMetadata !== null
    && targetMetadata !== null
    && sameFileIdentity(pathMetadata, targetMetadata)
  ) return true;

  const parent = dirname(path);
  if (parent !== dirname(target)) return false;
  const parentName = basename(parent);
  const toggledName = toggleFirstAsciiLetterCase(parentName);
  if (toggledName === parentName) return false;
  const parentAlias = join(dirname(parent), toggledName);
  const parentMetadata = readMetadata(parent);
  const aliasMetadata = readMetadata(parentAlias);
  return parentMetadata !== null
    && aliasMetadata !== null
    && sameFileIdentity(parentMetadata, aliasMetadata);
}

function toggleFirstAsciiLetterCase(value: string): string {
  const index = value.search(/[A-Za-z]/u);
  if (index < 0) return value;
  const character = value[index];
  if (character === undefined) return value;
  const toggled = character === character.toUpperCase()
    ? character.toLowerCase()
    : character.toUpperCase();
  return `${value.slice(0, index)}${toggled}${value.slice(index + 1)}`;
}

function readMetadata(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function sameFileIdentity(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function checkpoint(
  options: ApplicationSupportMigrationOptions,
  point: ApplicationSupportMigrationFaultPoint,
): void {
  options.onCheckpoint?.(point);
}

function conflict(message: string): ApplicationSupportMigrationError {
  return new ApplicationSupportMigrationError("conflicting_roots", message);
}

function invalidState(message: string): ApplicationSupportMigrationError {
  return new ApplicationSupportMigrationError("invalid_state", message);
}

function unsafeRoot(path: string, reason: string): ApplicationSupportMigrationError {
  return new ApplicationSupportMigrationError(
    "unsafe_root",
    `Unsafe Application Support root (${reason}): ${path}`,
    path,
  );
}

function hasCode(error: unknown, expected: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === expected;
}
