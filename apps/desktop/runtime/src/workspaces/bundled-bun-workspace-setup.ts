import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import type { WorkspaceSetupAttentionObservation } from
  "../observation/attention-projector";
import type {
  WorkspaceSetupApproval,
  WorkspaceSetupFailureCode,
  WorkspaceSetupRequest,
  WorkspaceSetupStore,
} from "../state/workspace-setup-store";
import type { GitRunner } from "./git-runner";
import type { WorkspaceLaneIdentity } from "./workspace-broker";
import {
  loadWorkspaceSetupRecipe,
  WorkspaceSetupRecipeError,
  type WorkspaceSetupRecipeV1,
} from "./workspace-setup-recipe";
import {
  WorkspaceSetupDeferredError,
  type WorkspaceSetupGate,
} from "./workspace-setup";

const bunInstallArguments = Object.freeze([
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
] as const);
const privateDirectoryMode = 0o700;
const terminateGraceMs = 250;
const killGraceMs = 5_000;
const executableReadBufferBytes = 1024 * 1024;
const macOSSandboxExecutable = "/usr/bin/sandbox-exec";

const fixedExecutionContract = JSON.stringify({
  version: 1,
  argv: ["<bundled-bun>", ...bunInstallArguments],
  cwd: "exact-managed-checkout",
  environment: [
    "BUN_INSTALL_CACHE_DIR",
    "CI",
    "HOME",
    "NO_COLOR",
    "PATH",
    "TMPDIR",
  ],
  shell: false,
  lifecycleScripts: "disabled",
  processExecution: "sandboxed-bundled-bun-only",
  writeAuthority: "managed-checkout-and-private-runtime-only",
  containment: "native-gateway-generation",
});

export type WorkspaceSetupProcessContainment =
  | "command_process_group"
  | "gateway_generation";

export interface WorkspaceSetupCoordinatorInstrumentation {
  /** Source-test-only escape hatch for script fixtures and portable hosts. */
  readonly unsafeTestOnlyAllowPathExecution?: boolean;
  /** Source-test-only replacement for the production process exit. */
  readonly unsafeTestOnlyFatalGatewayGeneration?: (error: Error) => never;
}

type SetupStore = Pick<WorkspaceSetupStore,
  | "allAttention"
  | "approve"
  | "claimEffect"
  | "headForLane"
  | "markEffectAmbiguous"
  | "reconcileProvenAbsentAfterGitReadFailure"
  | "recoverInterruptedEffects"
  | "recordPreEffectFailure"
  | "requireCleanReplacementForLegacyReadyLane"
  | "requestApproval"
  | "settleFailed"
  | "settleSucceeded"
>;

type SetupChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface ExecutableIdentity {
  readonly canonicalPath: string;
  readonly ctimeNanoseconds: bigint;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly mtimeNanoseconds: bigint;
  readonly sha256: string;
  readonly size: bigint;
}

interface ActiveEffect {
  child: SetupChild | null;
  shutdownRequested: boolean;
  termination: Promise<boolean> | null;
}

interface ExecutionBoundary {
  readonly sandbox: ExecutableIdentity | null;
}

type WorkspaceSetupEnvironment = Readonly<Record<
  | "BUN_INSTALL_CACHE_DIR"
  | "CI"
  | "HOME"
  | "NO_COLOR"
  | "PATH"
  | "TMPDIR",
  string
>>;

type ExecutionResult =
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{ kind: "succeeded"; transcript: string }>
  | Readonly<{
      kind: "failed";
      failureCode: WorkspaceSetupFailureCode;
      transcript: string;
    }>;

export class BundledBunWorkspaceSetupCoordinatorClosedError extends Error {
  constructor() {
    super("Workspace setup admission is closed");
    this.name = "BundledBunWorkspaceSetupCoordinatorClosedError";
  }
}

/**
 * Executes the one closed workspace-setup recipe with a bundled Bun binary.
 * Approval and effect ownership live in SQLite; this object owns only the
 * generation-scoped child processes and their private, credential-free homes.
 */
export class BundledBunWorkspaceSetupCoordinator implements WorkspaceSetupGate {
  readonly #bun: ExecutableIdentity;
  readonly #environment: WorkspaceSetupEnvironment;
  readonly #executionBoundary: ExecutionBoundary;
  readonly #fatalGatewayGeneration: (error: Error) => never;
  readonly #git: GitRunner;
  readonly #operations = new Set<Promise<void>>();
  readonly #effects = new Map<string, ActiveEffect>();
  readonly #effectTasks = new Map<string, Promise<void>>();
  readonly #store: SetupStore;
  readonly #processContainment: WorkspaceSetupProcessContainment;
  #admissionClosed = false;

  readonly executorDigest: string;
  readonly executorInstanceId: string;

  private constructor(input: Readonly<{
    bun: ExecutableIdentity;
    environment: WorkspaceSetupEnvironment;
    executionBoundary: ExecutionBoundary;
    executorDigest: string;
    executorInstanceId: string;
    fatalGatewayGeneration: (error: Error) => never;
    git: GitRunner;
    processContainment: WorkspaceSetupProcessContainment;
    store: SetupStore;
  }>) {
    this.#bun = input.bun;
    this.#environment = input.environment;
    this.#executionBoundary = input.executionBoundary;
    this.executorDigest = input.executorDigest;
    this.executorInstanceId = input.executorInstanceId;
    this.#fatalGatewayGeneration = input.fatalGatewayGeneration;
    this.#git = input.git;
    this.#processContainment = input.processContainment;
    this.#store = input.store;
  }

  static async create(options: Readonly<{
    bunBinary: string;
    git: GitRunner;
    instrumentation?: WorkspaceSetupCoordinatorInstrumentation;
    processContainment?: WorkspaceSetupProcessContainment;
    setupRoot: string;
    store: SetupStore;
  }>): Promise<BundledBunWorkspaceSetupCoordinator> {
    const bun = await inspectExecutable(options.bunBinary);
    const processContainment = options.processContainment ??
      "command_process_group";
    const unsafePathExecution =
      options.instrumentation?.unsafeTestOnlyAllowPathExecution === true;
    if (unsafePathExecution && basename(process.execPath) !== "bun") {
      throw new Error("Unsafe workspace setup instrumentation is unavailable");
    }
    if (
      options.instrumentation?.unsafeTestOnlyFatalGatewayGeneration !==
        undefined &&
      !unsafePathExecution
    ) {
      throw new Error("Workspace setup fatal instrumentation is test-only");
    }
    const sandbox = unsafePathExecution
      ? null
      : await inspectWorkspaceSetupSandbox();
    const executorDigest = createHash("sha256")
      .update("hra.workspace-setup-executor.v1\0", "utf8")
      .update(bun.canonicalPath, "utf8")
      .update("\0", "utf8")
      .update(bun.sha256, "utf8")
      .update("\0", "utf8")
      .update(sandbox?.canonicalPath ?? "unsafe-test-path-execution", "utf8")
      .update("\0", "utf8")
      .update(sandbox?.sha256 ?? "unsafe-test-path-execution", "utf8")
      .update("\0", "utf8")
      .update(processContainment, "utf8")
      .update("\0", "utf8")
      .update(fixedExecutionContract, "utf8")
      .digest("hex");
    const executorInstanceId = `wsexec_${randomBytes(16).toString("hex")}`;
    const setupRoot = await preparePrivateDirectory(options.setupRoot);
    const instanceRoot = await preparePrivateDirectory(
      join(setupRoot, executorInstanceId),
      setupRoot,
    );
    const home = await preparePrivateDirectory(join(instanceRoot, "home"), instanceRoot);
    const cache = await preparePrivateDirectory(join(instanceRoot, "cache"), instanceRoot);
    const emptyPath = await preparePrivateDirectory(join(instanceRoot, "path"), instanceRoot);
    const temporary = await preparePrivateDirectory(join(instanceRoot, "tmp"), instanceRoot);
    const environment = Object.freeze({
      BUN_INSTALL_CACHE_DIR: cache,
      CI: "1",
      HOME: home,
      NO_COLOR: "1",
      PATH: emptyPath,
      TMPDIR: temporary,
    });

    // A new generation must terminalize every prior effect before callers can
    // obtain this coordinator and admit any setup work.
    options.store.recoverInterruptedEffects(executorInstanceId);
    return new BundledBunWorkspaceSetupCoordinator({
      bun,
      environment,
      executionBoundary: { sandbox },
      executorDigest,
      executorInstanceId,
      fatalGatewayGeneration:
        options.instrumentation?.unsafeTestOnlyFatalGatewayGeneration ??
          fatalGatewayGeneration,
      git: options.git,
      processContainment,
      store: options.store,
    });
  }

  beforeWorkspaceReady(identity: WorkspaceLaneIdentity): Promise<void> {
    if (this.#admissionClosed) {
      return Promise.reject(
        new BundledBunWorkspaceSetupCoordinatorClosedError(),
      );
    }
    const operation = this.#beforeWorkspaceReady(identity).finally(() => {
      this.#operations.delete(operation);
    });
    this.#operations.add(operation);
    void operation.catch(() => undefined);
    return operation;
  }

  approve(
    input: Parameters<WorkspaceSetupStore["approve"]>[0],
  ): WorkspaceSetupApproval {
    if (this.#admissionClosed) {
      throw new BundledBunWorkspaceSetupCoordinatorClosedError();
    }
    return this.#store.approve(input);
  }

  attentionObservations(): readonly WorkspaceSetupAttentionObservation[] {
    return this.#store.allAttention();
  }

  hasUnsettledWork(): boolean {
    return this.#operations.size > 0 || this.#effects.size > 0;
  }

  /**
   * Stops new approval/effect admission. Native-owned effects terminate the
   * complete gateway generation; isolated test/automation effects use their
   * own process group and record ambiguity only after that group disappears.
   */
  closeAdmission(): void {
    if (this.#admissionClosed) return;
    this.#admissionClosed = true;
    for (const effect of this.#effects.values()) {
      effect.shutdownRequested = true;
      if (effect.child !== null) {
        if (this.#processContainment === "gateway_generation") {
          bestEffortStopDirectChild(effect.child);
          this.#fatalGatewayGeneration(
            new WorkspaceSetupGenerationRecoveryError(),
          );
        }
        void terminateEffect(effect).catch(() => undefined);
      }
    }
  }

  async settled(): Promise<void> {
    for (;;) {
      const operations = [...this.#operations];
      const effects = [...this.#effectTasks.values()];
      if (operations.length === 0 && effects.length === 0) return;
      await Promise.allSettled([...operations, ...effects]);
      await Promise.resolve();
    }
  }

  async #beforeWorkspaceReady(identity: WorkspaceLaneIdentity): Promise<void> {
    let loaded: Awaited<ReturnType<typeof loadWorkspaceSetupRecipe>>;
    try {
      loaded = await loadWorkspaceSetupRecipe(
        this.#git,
        identity.canonicalRepositoryPath,
        identity.baseSha,
      );
    } catch (error: unknown) {
      if (this.#admissionClosed) {
        throw new BundledBunWorkspaceSetupCoordinatorClosedError();
      }
      if (!(error instanceof WorkspaceSetupRecipeError)) throw error;
      const rejected = this.#store.recordPreEffectFailure({
        identity,
        recipeDigest: error.rejectionDigest,
        executorDigest: this.executorDigest,
        failureCode: error.reason === "git_read_failed"
          ? "runtime_unavailable"
          : "invalid_recipe",
      });
      if (rejected.state === "succeeded") return;
      throw deferred(rejected, "failed");
    }
    if (this.#admissionClosed) {
      throw new BundledBunWorkspaceSetupCoordinatorClosedError();
    }
    if (loaded === null) {
      const current = this.#store.headForLane(identity.laneId);
      if (current === null) return;
      if (this.#store.reconcileProvenAbsentAfterGitReadFailure({
        identity,
        executorDigest: this.executorDigest,
      })) return;
      if (current.state === "approval_required") {
        throw deferred(current, "approval_required");
      }
      if (current.state === "ambiguous" || current.state === "effect_started") {
        throw deferred(current, "ambiguous");
      }
      throw deferred(current, "failed");
    }

    let current = this.#store.headForLane(identity.laneId);
    if (current?.failureCode === "clean_replacement_required") {
      throw deferred(current, "failed");
    }
    if (current === null) {
      const fenced = this.#store.requireCleanReplacementForLegacyReadyLane({
        identity,
        recipeDigest: loaded.digest,
        executorDigest: this.executorDigest,
      });
      if (fenced !== null) throw deferred(fenced, "failed");
      current = this.#store.headForLane(identity.laneId);
    }
    if (
      current !== null &&
      current.state === "succeeded" &&
      current.baseSha === identity.baseSha &&
      current.recipeDigest === loaded.digest
    ) return;
    const durablePreEffectAuthority = current !== null && (
      current.state === "approval_required" ||
      current.state === "prepared" ||
      current.state === "effect_started"
    );
    if (
      !durablePreEffectAuthority &&
      !await this.#runtimePreflight(identity.canonicalCheckoutPath)
    ) {
      const rejected = this.#store.recordPreEffectFailure({
        identity,
        recipeDigest: loaded.digest,
        executorDigest: this.executorDigest,
        failureCode: "runtime_unavailable",
      });
      if (rejected.state === "succeeded") return;
      throw deferred(rejected, "failed");
    }
    if (this.#admissionClosed) {
      throw new BundledBunWorkspaceSetupCoordinatorClosedError();
    }

    const request = this.#store.requestApproval({
      identity,
      recipeDigest: loaded.digest,
      executorDigest: this.executorDigest,
    });
    if (request.state === "approval_required") {
      throw deferred(request, "approval_required");
    }
    if (request.state === "succeeded") return;
    if (request.state === "rejected" || request.state === "failed") {
      throw deferred(request, "failed");
    }
    if (request.state === "ambiguous") {
      throw deferred(request, request.state);
    }

    const existingTask = this.#effectTasks.get(request.requestId);
    if (existingTask !== undefined) {
      await existingTask;
      return this.#requireSuccessfulCompletion(identity, request.requestId);
    }

    const claim = this.#store.claimEffect({
      requestId: request.requestId,
      executorInstanceId: this.executorInstanceId,
    });
    if (claim.disposition === "claimed") {
      this.#startClaimedEffect(claim.request, loaded.recipe);
      await this.#effectTasks.get(request.requestId);
      return this.#requireSuccessfulCompletion(identity, request.requestId);
    }
    if (claim.disposition === "in_progress") {
      const inFlight = this.#effectTasks.get(request.requestId);
      if (inFlight !== undefined) {
        await inFlight;
      } else {
        // An effect cannot be safely rediscovered from in-memory identity. A
        // missing task is treated like a generation loss and is never replayed.
        this.#store.markEffectAmbiguous({
          requestId: request.requestId,
          executorInstanceId: this.executorInstanceId,
        });
      }
    }
    return this.#requireSuccessfulCompletion(identity, request.requestId);
  }

  async #runtimePreflight(canonicalCheckoutPath: string): Promise<boolean> {
    if (canonicalCheckoutPath.length === 0) return false;
    try {
      const checkout = await realpath(canonicalCheckoutPath);
      const checkoutStatus = await lstat(checkout);
      if (
        checkout !== canonicalCheckoutPath ||
        !checkoutStatus.isDirectory() ||
        checkoutStatus.isSymbolicLink()
      ) return false;
      await assertExecutableIntegrity(this.#bun);
      if (this.#executionBoundary.sandbox !== null) {
        await assertExecutableIntegrity(this.#executionBoundary.sandbox);
      }
      return true;
    } catch {
      return false;
    }
  }

  #startClaimedEffect(
    request: WorkspaceSetupRequest,
    recipe: WorkspaceSetupRecipeV1,
  ): void {
    const effect: ActiveEffect = {
      child: null,
      shutdownRequested: this.#admissionClosed,
      termination: null,
    };
    this.#effects.set(request.requestId, effect);
    const task = this.#executeAndSettle(request, recipe, effect).finally(() => {
      if (this.#effectTasks.get(request.requestId) === task) {
        this.#effectTasks.delete(request.requestId);
      }
      if (this.#effects.get(request.requestId) === effect) {
        this.#effects.delete(request.requestId);
      }
    });
    this.#effectTasks.set(request.requestId, task);
    void task.catch(() => undefined);
  }

  async #executeAndSettle(
    request: WorkspaceSetupRequest,
    recipe: WorkspaceSetupRecipeV1,
    effect: ActiveEffect,
  ): Promise<void> {
    const result = await this.#execute(request, recipe, effect);
    if (result.kind === "ambiguous") {
      this.#store.markEffectAmbiguous({
        requestId: request.requestId,
        executorInstanceId: this.executorInstanceId,
      });
      return;
    }
    if (result.kind === "succeeded") {
      this.#store.settleSucceeded({
        requestId: request.requestId,
        executorInstanceId: this.executorInstanceId,
        transcript: result.transcript,
      });
      return;
    }
    this.#store.settleFailed({
      requestId: request.requestId,
      executorInstanceId: this.executorInstanceId,
      failureCode: result.failureCode,
      transcript: result.transcript,
    });
  }

  async #execute(
    request: WorkspaceSetupRequest,
    recipe: WorkspaceSetupRecipeV1,
    effect: ActiveEffect,
  ): Promise<ExecutionResult> {
    if (effect.shutdownRequested) return { kind: "ambiguous" };
    if (!await this.#runtimePreflight(request.canonicalCheckoutPath)) {
      return effect.shutdownRequested
        ? { kind: "ambiguous" }
        : failed("runtime_unavailable", "");
    }
    if (effect.shutdownRequested) return { kind: "ambiguous" };

    const transcript = new BoundedTranscript(
      recipe.setup.outputLimitBytes,
    );
    let child: SetupChild;
    try {
      const sandbox = this.#executionBoundary.sandbox;
      const command = sandbox === null
        ? [this.#bun.canonicalPath, ...bunInstallArguments]
        : [
            sandbox.canonicalPath,
            "-p",
            workspaceSetupSandboxProfile({
              bunBinary: this.#bun.canonicalPath,
              checkout: request.canonicalCheckoutPath,
              writableRuntimeRoots: [
                this.#environment.HOME,
                this.#environment.BUN_INSTALL_CACHE_DIR,
                this.#environment.TMPDIR,
              ],
            }),
            this.#bun.canonicalPath,
            ...bunInstallArguments,
          ];
      child = Bun.spawn(
        command,
        {
          cwd: request.canonicalCheckoutPath,
          detached: this.#processContainment === "command_process_group" &&
            process.platform !== "win32",
          env: this.#environment,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      effect.child = child;
    } catch {
      return effect.shutdownRequested
        ? { kind: "ambiguous" }
        : failed("runtime_unavailable", transcript.text());
    }
    if (effect.shutdownRequested) {
      if (this.#processContainment === "gateway_generation") {
        bestEffortStopDirectChild(child);
        this.#fatalGatewayGeneration(
          new WorkspaceSetupGenerationRecoveryError(),
        );
      }
      await terminateEffect(effect);
      return { kind: "ambiguous" };
    }

    const outputAbort = new AbortController();
    const completion = Promise.all([
      child.exited,
      readOutput(child.stdout, transcript, outputAbort.signal),
      readOutput(child.stderr, transcript, outputAbort.signal),
    ]);
    void completion.catch(() => undefined);
    const timeout = deadline(recipe.setup.timeoutSeconds * 1_000);
    try {
      const [exitCode] = await Promise.race([completion, timeout.promise]);
      timeout.cancel();
      if (effect.shutdownRequested) {
        if (this.#processContainment === "gateway_generation") {
          bestEffortStopDirectChild(child);
          this.#fatalGatewayGeneration(
            new WorkspaceSetupGenerationRecoveryError(),
          );
        }
        await terminateEffect(effect);
        return { kind: "ambiguous" };
      }
      if (
        this.#processContainment === "command_process_group" &&
        processTreeExists(child)
      ) {
        const contained = await terminateEffect(effect);
        return contained
          ? failed("containment_failed", transcript.text())
          : { kind: "ambiguous" };
      }
      return exitCode === 0
        ? { kind: "succeeded", transcript: transcript.text() }
        : failed("exit_nonzero", transcript.text());
    } catch (error: unknown) {
      timeout.cancel();
      outputAbort.abort();
      if (this.#processContainment === "gateway_generation") {
        bestEffortStopDirectChild(child);
        this.#fatalGatewayGeneration(
          new WorkspaceSetupGenerationRecoveryError(),
        );
      }
      const contained = await terminateEffect(effect);
      if (effect.shutdownRequested) return { kind: "ambiguous" };
      if (!contained) return { kind: "ambiguous" };
      if (error instanceof OutputLimitError) {
        return failed("output_limit", transcript.text());
      }
      if (error instanceof SetupTimeoutError) {
        return failed("timeout", transcript.text());
      }
      return failed("transcript_unavailable", transcript.text());
    } finally {
      timeout.cancel();
      outputAbort.abort();
    }
  }

  #requireSuccessfulCompletion(
    identity: WorkspaceLaneIdentity,
    requestId: string,
  ): void {
    const request = this.#store.headForLane(identity.laneId);
    if (request === null || request.requestId !== requestId) {
      throw new Error("Workspace setup authority changed during execution");
    }
    switch (request.state) {
      case "succeeded":
        return;
      case "approval_required":
        throw deferred(request, "approval_required");
      case "rejected":
        throw deferred(request, "failed");
      case "effect_started":
      case "prepared":
        throw deferred(request, "effect_started");
      case "failed":
      case "ambiguous":
        throw deferred(request, request.state);
    }
  }
}

function deferred(
  request: WorkspaceSetupRequest,
  state: ConstructorParameters<typeof WorkspaceSetupDeferredError>[0]["state"],
): WorkspaceSetupDeferredError {
  return new WorkspaceSetupDeferredError({
    recipeDigest: request.recipeDigest,
    requestId: request.requestId,
    setupRevision: request.setupRevision,
    state,
  });
}

function failed(
  failureCode: WorkspaceSetupFailureCode,
  transcript: string,
): ExecutionResult {
  return { kind: "failed", failureCode, transcript };
}

async function preparePrivateDirectory(
  path: string,
  expectedParent?: string,
): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0") || normalize(path) !== path) {
    throw new Error("Workspace setup storage root must be absolute");
  }
  const parent = dirname(path);
  if (expectedParent !== undefined && parent !== expectedParent) {
    throw new Error("Workspace setup storage escaped its retained parent");
  }
  const canonicalParent = await realpath(parent);
  const parentStatus = await lstat(parent);
  if (
    canonicalParent !== parent ||
    !parentStatus.isDirectory() ||
    parentStatus.isSymbolicLink()
  ) {
    throw new Error("Workspace setup storage parent is unsafe");
  }
  if (
    typeof process.geteuid === "function" &&
    parentStatus.uid !== process.geteuid()
  ) throw new Error("Workspace setup storage parent must be owned by this user");
  try {
    await mkdir(path, { mode: privateDirectoryMode });
  } catch (error: unknown) {
    if (
      typeof error !== "object" || error === null ||
      !("code" in error) || error.code !== "EEXIST"
    ) throw error;
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("Workspace setup storage must be a directory");
    }
    if (
      typeof process.geteuid === "function" &&
      before.uid !== process.geteuid()
    ) throw new Error("Workspace setup storage must be owned by this user");
    const canonicalPath = await realpath(path);
    const pathStatus = await lstat(path);
    if (
      canonicalPath !== path ||
      pathStatus.isSymbolicLink() ||
      pathStatus.dev !== before.dev ||
      pathStatus.ino !== before.ino
    ) throw new Error("Workspace setup storage identity changed");
    await handle.chmod(privateDirectoryMode);
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (after.mode & 0o777) !== privateDirectoryMode
    ) {
      throw new Error("Workspace setup storage permissions are unsafe");
    }
    return canonicalPath;
  } finally {
    await handle.close();
  }
}

async function inspectExecutable(path: string): Promise<ExecutableIdentity> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("Bundled Bun executable path must be absolute");
  }
  const canonicalPath = await realpath(path);
  const handle = await open(canonicalPath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || (before.mode & 0o111n) === 0n) {
      throw new Error("Bundled Bun must be an executable regular file");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(executableReadBufferBytes);
    let position = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.byteLength, position);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) throw new Error("Bundled Bun changed while it was inspected");
    return {
      canonicalPath,
      ctimeNanoseconds: after.ctimeNs,
      device: after.dev,
      inode: after.ino,
      mode: after.mode,
      mtimeNanoseconds: after.mtimeNs,
      sha256: hash.digest("hex"),
      size: after.size,
    };
  } finally {
    await handle.close();
  }
}

async function assertExecutableIntegrity(
  expected: ExecutableIdentity,
): Promise<void> {
  const current = await inspectExecutable(expected.canonicalPath);
  if (
    current.canonicalPath !== expected.canonicalPath ||
    current.ctimeNanoseconds !== expected.ctimeNanoseconds ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.mode !== expected.mode ||
    current.mtimeNanoseconds !== expected.mtimeNanoseconds ||
    current.sha256 !== expected.sha256 ||
    current.size !== expected.size
  ) throw new Error("Bundled Bun identity changed after approval");
}

class BoundedTranscript {
  readonly #chunks: Uint8Array[] = [];
  readonly #limit: number;
  #bytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(value: Uint8Array): void {
    const remaining = this.#limit - this.#bytes;
    if (remaining > 0) {
      const accepted = value.subarray(0, Math.min(value.byteLength, remaining));
      this.#chunks.push(accepted.slice());
      this.#bytes += accepted.byteLength;
    }
    if (value.byteLength > remaining) throw new OutputLimitError();
  }

  text(): string {
    const bytes = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoded = new TextDecoder().decode(bytes).replaceAll("\0", "\uFFFD");
    return utf8Prefix(decoded, this.#limit);
  }
}

class OutputLimitError extends Error {}
class SetupTimeoutError extends Error {}
class WorkspaceSetupGenerationRecoveryError extends Error {
  constructor() {
    super("Workspace setup requires gateway generation recovery");
    this.name = "WorkspaceSetupGenerationRecoveryError";
  }
}

async function inspectWorkspaceSetupSandbox(): Promise<ExecutableIdentity> {
  if (process.platform !== "darwin") {
    throw new Error("Workspace setup requires the packaged macOS sandbox");
  }
  return await inspectExecutable(macOSSandboxExecutable);
}

function workspaceSetupSandboxProfile(input: Readonly<{
  bunBinary: string;
  checkout: string;
  writableRuntimeRoots: readonly string[];
}>): string {
  const writableRoots = [input.checkout, ...input.writableRuntimeRoots];
  if (
    !isAbsolute(input.bunBinary) ||
    writableRoots.some((path) => !isAbsolute(path) || path.includes("\0"))
  ) {
    throw new Error("Workspace setup sandbox authority is invalid");
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny process-exec)",
    "(deny file-write*)",
    `(allow process-exec (literal ${JSON.stringify(input.bunBinary)}))`,
    `(allow file-write-data (literal ${JSON.stringify("/dev/null")}))`,
    ...writableRoots.map((path) =>
      `(allow file-write* (subpath ${JSON.stringify(path)}))`
    ),
  ].join("\n");
}

function fatalGatewayGeneration(error: Error): never {
  // Native owns the gateway generation PGID and proves it absent before a
  // replacement starts. No post-spawn failure may be caught and translated
  // into a terminal setup result before that fence completes.
  void error;
  process.exit(86);
}

function bestEffortStopDirectChild(child: SetupChild): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // Native's generation fence remains authoritative for every descendant.
  }
}

async function readOutput(
  stream: ReadableStream<Uint8Array>,
  transcript: BoundedTranscript,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      transcript.append(result.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const length = Buffer.byteLength(character, "utf8");
    if (bytes + length > maximumBytes) break;
    result += character;
    bytes += length;
  }
  return result;
}

function deadline(milliseconds: number): {
  readonly cancel: () => void;
  readonly promise: Promise<never>;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SetupTimeoutError()), milliseconds);
  });
  return {
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    promise,
  };
}

function processTreeExists(child: SetupChild): boolean {
  if (process.platform === "win32") return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function terminateEffect(effect: ActiveEffect): Promise<boolean> {
  if (effect.termination !== null) return effect.termination;
  const child = effect.child;
  if (child === null) return Promise.resolve(true);
  effect.termination = terminateProcessTree(child);
  return effect.termination;
}

async function terminateProcessTree(child: SetupChild): Promise<boolean> {
  if (!processTreeExists(child)) return true;
  signalProcessTree(child, "SIGTERM");
  if (await waitUntilMissing(child, terminateGraceMs)) return true;
  signalProcessTree(child, "SIGKILL");
  return await waitUntilMissing(child, killGraceMs);
}

function signalProcessTree(child: SetupChild, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // A group that exited during the signal falls through to its handle.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // An already-exited process needs no further cleanup.
  }
}

async function waitUntilMissing(
  child: SetupChild,
  maximumWaitMs: number,
): Promise<boolean> {
  const until = performance.now() + maximumWaitMs;
  while (processTreeExists(child)) {
    const remaining = until - performance.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(10, remaining));
    });
  }
  return true;
}
