import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  type Stats,
  writeSync,
} from "node:fs";
import {
  availableParallelism,
  cpus,
  constants as osConstants,
  setPriority,
} from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_EX = 0x02;
const LOCK_SH = 0x01;
const LOCK_NB = 0x04;
const F_SETFD = 2;
const FD_CLOEXEC = 1;
const EINTR = 4;
// Keep the first two permit files and the state-root version stable during the
// weighted-scheduler rollout. Older schedulers coordinate through those files
// and the same intent/turnstile locks; newer schedulers add permits 3 and 4.
// Weighted workloads retain a shared lock on the legacy turnstile, so an old
// exclusive holder also waits for work using permits 3 and 4. New admissions
// use a separate turnstile and can still overlap with each other.
const maximumPermitCount = 4;
const retryDelayMilliseconds = 250;
const cpuSampleMilliseconds = 500;
const waitingReportMilliseconds = 15_000;
const localCheckNiceness = 10;
const terminationGraceMilliseconds = 5_000;
const bindingVariable = "HRA_CHECK_RESOURCE_BINDING";
const turboConcurrencyVariable = "HRA_CHECK_TURBO_CONCURRENCY";
const workerBudgetVariable = "HRA_CHECK_WORKER_BUDGET";
const guardianArgument = "--internal-check-resource-guardian";
const guardianIpcDescriptor = 3;
const guardianLeaseDescriptorOffset = guardianIpcDescriptor + 1;
const guardianProtocolVersion = 1;
const bindingVersion = 4;
const leaseTokenPattern = /^[0-9a-f-]{36}$/u;
const lockFileNames = new Set([
  "exclusive-intent.lock",
  "turnstile.lock",
  ...Array.from(
    { length: maximumPermitCount },
    (_, index) => `slot-${index + 1}.lock`,
  ),
]);
const weightedTurnstileFileName = "weighted-turnstile.lock";

export type CheckResourceMode = "exclusive" | "heavy" | "shared";

export interface CheckResourceRequest {
  readonly cpuAdmission?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly label: string;
  readonly mode: CheckResourceMode;
  readonly root: string;
  readonly stateRoot?: string;
}

export interface CheckResourceExecution {
  readonly environment: NodeJS.ProcessEnv;
  readonly inheritedDescriptors: readonly number[];
  readonly inheritedFileNames: readonly string[];
  readonly leaseToken: string | null;
  readonly leaseMode: CheckResourceMode | null;
  readonly ownsLease: boolean;
  readonly repositoryIdentity: string | null;
}

export interface CheckResourceRunnerOptions {
  readonly arguments: readonly string[];
  readonly label: string;
  readonly program: string;
}

export interface CheckResourceLeaseProbeRequest {
  readonly fileNames: readonly string[];
  readonly leaseFingerprint: string;
  readonly root: string;
  readonly stateRoot?: string;
}

export type TryExclusiveCheckResourceRequest = Omit<
  CheckResourceRequest,
  "cpuAdmission" | "mode"
> & {
  readonly cpuAdmission?: false;
  readonly mode?: "exclusive";
};

export type TryExclusiveCheckResourceResult<T> =
  | {
    readonly acquired: false;
    readonly reason: "contended";
  }
  | {
    readonly acquired: true;
    readonly value: T;
  };

interface HeldCheckResources {
  readonly capacity: number;
  readonly descriptors: readonly number[];
  readonly fileNames: readonly string[];
  readonly permitCount: number;
  readonly release: () => void;
  readonly token: string;
  readonly workerBudget: number;
}

interface ParsedRunnerArguments {
  readonly command: readonly [string, ...string[]];
  readonly label: string;
  readonly mode: CheckResourceMode;
}

interface InheritedBinding {
  readonly descriptors: readonly number[];
  readonly fileNames: readonly string[];
  readonly mode: CheckResourceMode;
  readonly serialized: string;
  readonly token: string;
  readonly workerBudget: number;
}

interface ActiveCheckResourceLease {
  active: boolean;
  readonly execution: CheckResourceExecution;
  readonly stateRoot: string;
}

export interface ActiveCheckResourceLeaseIdentity {
  readonly repositoryIdentity: string;
  readonly stateRoot: string;
}

type LeaseStopTarget = (signal: "SIGCONT" | "SIGTSTP") => void;

interface OwnedLeaseJobControl {
  readonly dispose: () => void;
  readonly finishAdmission: (release: AdmissionCleanup) => void;
  readonly setStopTarget: (target: LeaseStopTarget | null) => void;
}

export interface CheckCpuTimeSample {
  readonly idleMilliseconds: number;
  readonly logicalCpuCount: number;
  readonly totalMilliseconds: number;
}

interface GuardianStartMessage {
  readonly arguments: readonly string[];
  readonly descriptorCount: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly label: string;
  readonly program: string;
  readonly root: string;
  readonly type: "start";
  readonly version: typeof guardianProtocolVersion;
}

interface GuardianSpawnedMessage {
  readonly pid: number;
  readonly type: "spawned";
  readonly version: typeof guardianProtocolVersion;
}

interface GuardianReadyMessage {
  readonly type: "ready";
  readonly version: typeof guardianProtocolVersion;
}

interface GuardianResultMessage {
  readonly status: number;
  readonly type: "result";
  readonly version: typeof guardianProtocolVersion;
}

interface GuardianErrorMessage {
  readonly message: string;
  readonly type: "error";
  readonly version: typeof guardianProtocolVersion;
}

type GuardianResponseMessage =
  | GuardianReadyMessage
  | GuardianSpawnedMessage
  | GuardianResultMessage
  | GuardianErrorMessage;

let nativeFlock: ((descriptor: number, operation: number) => number) | undefined;
let nativeFcntl: ((descriptor: number, command: number, argument: number) => number) | undefined;
let nativeDup: ((descriptor: number) => number) | undefined;
let nativeErrnoLocation: (() => Pointer | null) | undefined;
const nativeLibraries: unknown[] = [];
let malformedCpuCountersReported = false;
const activeCheckResourceLease = new AsyncLocalStorage<ActiveCheckResourceLease>();
const ownedLeaseJobControls = new WeakMap<
  CheckResourceExecution,
  OwnedLeaseJobControl
>();

function controlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function checkedLabel(value: string): string {
  if (value.length === 0 || value.length > 120 || controlCharacter(value)) {
    throw new Error("check resource labels must contain 1-120 printable characters");
  }
  return value;
}

export function linuxLibcCandidatesFromProcessMaps(
  processMaps: string,
  architecture = process.arch,
): readonly string[] {
  const candidates: string[] = [];
  const append = (candidate: string): void => {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };
  for (const line of processMaps.split("\n")) {
    const pathStart = line.indexOf("/");
    if (pathStart < 0 || line.endsWith(" (deleted)")) continue;
    const path = line.slice(pathStart).replace(
      /\\([0-7]{3})/gu,
      (_, octal: string) => String.fromCodePoint(Number.parseInt(octal, 8)),
    );
    if (
      /\/(?:libc(?:-[^/]+)?\.so(?:\.[0-9]+)*|libc\.musl-[^/]+\.so(?:\.[0-9]+)*|ld-musl-[^/]+\.so(?:\.[0-9]+)*)$/u
        .test(path)
    ) {
      append(path);
    }
  }
  append("libc.so.6");
  if (architecture === "x64") append("/lib/ld-musl-x86_64.so.1");
  if (architecture === "arm64") append("/lib/ld-musl-aarch64.so.1");
  return candidates;
}

function linuxLibcCandidates(): readonly string[] {
  try {
    return linuxLibcCandidatesFromProcessMaps(
      readFileSync("/proc/self/maps", "utf8"),
    );
  } catch {
    return linuxLibcCandidatesFromProcessMaps("");
  }
}

function initializeNativeLocking(): void {
  if (
    nativeFcntl !== undefined
    && nativeFlock !== undefined
    && nativeDup !== undefined
    && nativeErrnoLocation !== undefined
  ) {
    return;
  }
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      __error: {
        args: [],
        returns: FFIType.ptr,
      },
      fcntl: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      dup: {
        args: [FFIType.i32],
        returns: FFIType.i32,
      },
      flock: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    nativeLibraries.push(library);
    nativeFcntl = library.symbols.fcntl;
    nativeFlock = library.symbols.flock;
    nativeDup = library.symbols.dup;
    nativeErrnoLocation = library.symbols.__error;
    return;
  }
  if (process.platform === "linux") {
    const failures: string[] = [];
    for (const candidate of linuxLibcCandidates()) {
      try {
        const library = dlopen(candidate, {
          __errno_location: {
            args: [],
            returns: FFIType.ptr,
          },
          fcntl: {
            args: [FFIType.i32, FFIType.i32, FFIType.i32],
            returns: FFIType.i32,
          },
          dup: {
            args: [FFIType.i32],
            returns: FFIType.i32,
          },
          flock: {
            args: [FFIType.i32, FFIType.i32],
            returns: FFIType.i32,
          },
        });
        nativeLibraries.push(library);
        nativeFcntl = library.symbols.fcntl;
        nativeFlock = library.symbols.flock;
        nativeDup = library.symbols.dup;
        nativeErrnoLocation = library.symbols.__errno_location;
        return;
      } catch (error) {
        failures.push(
          `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new Error(
      "check resource scheduling could not load the host Linux libc"
      + ` (${failures.join("; ")})`,
    );
  }
  throw new Error(`check resource scheduling is unsupported on ${process.platform}`);
}

function currentErrno(): number {
  initializeNativeLocking();
  const pointer = nativeErrnoLocation?.();
  if (pointer === undefined || pointer === null) {
    throw new Error("check resource scheduling could not read errno");
  }
  return read.i32(pointer);
}

function busyErrnos(): readonly number[] {
  return process.platform === "darwin" ? [35] : [11];
}

function tryLockOperation(descriptor: number, operation: number): boolean {
  initializeNativeLocking();
  for (;;) {
    if (nativeFlock?.(descriptor, operation | LOCK_NB) === 0) return true;
    const errno = currentErrno();
    if (errno === EINTR) continue;
    if (busyErrnos().includes(errno)) return false;
    throw new Error(`check resource flock failed with errno ${errno}`);
  }
}

function tryLock(descriptor: number): boolean {
  return tryLockOperation(descriptor, LOCK_EX);
}

function tryLockShared(descriptor: number): boolean {
  return tryLockOperation(descriptor, LOCK_SH);
}

function setCloseOnExec(descriptor: number): void {
  initializeNativeLocking();
  if (nativeFcntl?.(descriptor, F_SETFD, FD_CLOEXEC) !== 0) {
    throw new Error(`check resource fcntl failed with errno ${currentErrno()}`);
  }
}

function duplicateDescriptorsForSpawn(
  descriptors: readonly number[],
  minimumDescriptor: number,
): readonly number[] {
  const duplicates: number[] = [];
  const reservations: number[] = [];
  try {
    for (const descriptor of descriptors) {
      for (;;) {
        initializeNativeLocking();
        const duplicate = nativeDup?.(descriptor);
        if (duplicate === undefined || duplicate < 0) {
          throw new Error(
            `check resource descriptor duplication failed with errno ${currentErrno()}`,
          );
        }
        if (duplicate < minimumDescriptor) {
          // Reserve low gaps until dup returns a source outside every child fd
          // that this spawn call will populate.
          reservations.push(duplicate);
          continue;
        }
        try {
          setCloseOnExec(duplicate);
        } catch (error) {
          closeSync(duplicate);
          throw error;
        }
        duplicates.push(duplicate);
        break;
      }
    }
    closeAll(reservations);
    return duplicates;
  } catch (error) {
    try {
      closeAll(reservations);
    } catch {
      // Preserve the duplication failure.
    }
    closeAll(duplicates);
    throw error;
  }
}

function metadataOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function assertOwnedDirectory(path: string, metadata: Stats): void {
  const effectiveUserId = process.geteuid?.();
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (effectiveUserId !== undefined && metadata.uid !== effectiveUserId)
    || (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error(`check resource state must be one private owned directory: ${path}`);
  }
}

function ensureStateRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("check resource state root must be absolute");
  let existing = metadataOrNull(path);
  if (existing === null) {
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    } catch (error: unknown) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
    existing = lstatSync(path);
  }
  assertOwnedDirectory(path, existing);
  const canonical = realpathSync(path);
  assertOwnedDirectory(canonical, lstatSync(canonical));
  return canonical;
}

function assertOwnedRegularFile(path: string, metadata: Stats): void {
  const effectiveUserId = process.geteuid?.();
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || (effectiveUserId !== undefined && metadata.uid !== effectiveUserId)
    || (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error(`check resource lock must be one private owned regular file: ${path}`);
  }
}

function openLockFile(path: string): number {
  const existing = metadataOrNull(path);
  if (existing !== null) assertOwnedRegularFile(path, existing);
  const descriptor = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    setCloseOnExec(descriptor);
    fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor);
    const published = lstatSync(path);
    assertOwnedRegularFile(path, opened);
    assertOwnedRegularFile(path, published);
    if (opened.dev !== published.dev || opened.ino !== published.ino) {
      throw new Error(`check resource lock identity changed while opening: ${path}`);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function permitFileNames(permitCount: number): readonly string[] {
  return Array.from(
    { length: permitCount },
    (_, index) => `slot-${index + 1}.lock`,
  );
}

function closeAll(descriptors: readonly number[]): void {
  let firstError: unknown;
  for (const descriptor of [...descriptors].reverse()) {
    try {
      closeSync(descriptor);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError instanceof Error) throw firstError;
  if (firstError !== undefined) {
    throw new Error("closing check resource descriptors failed", { cause: firstError });
  }
}

export function withCheckResourceLeaseDescriptorsForSpawn<T>(
  descriptors: readonly number[],
  firstChildDescriptor: number,
  spawnChild: (descriptors: readonly number[]) => T,
): T {
  if (!Number.isSafeInteger(firstChildDescriptor) || firstChildDescriptor < 0) {
    throw new Error("check resource child descriptor offset must be a nonnegative integer");
  }
  const spawnDescriptors = duplicateDescriptorsForSpawn(
    descriptors,
    firstChildDescriptor + descriptors.length,
  );
  try {
    return spawnChild(spawnDescriptors);
  } finally {
    closeAll(spawnDescriptors);
  }
}

function bindLockToken(
  descriptors: readonly number[],
  token = randomUUID(),
): string {
  const encoded = Buffer.from(token, "utf8");
  for (const descriptor of descriptors) {
    ftruncateSync(descriptor, 0);
    const written = writeSync(descriptor, encoded, 0, encoded.length, 0);
    if (written !== encoded.length) {
      throw new Error("check resource lock token was only partially written");
    }
  }
  return token;
}

export function sanitizedGitEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_QUARANTINE_PATH",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
  ]) {
    delete result[name];
  }
  result.GIT_NO_REPLACE_OBJECTS = "1";
  result.LANG = "C";
  result.LC_ALL = "C";
  return result;
}

export function gitCommonDirectory(
  root: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const commonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: root,
      encoding: "utf8",
      env: sanitizedGitEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  if (!isAbsolute(commonDirectory) || commonDirectory.length === 0) {
    throw new Error("Git returned an invalid common directory");
  }
  return realpathSync(commonDirectory);
}

export function checkResourceStateRoot(root: string): string {
  return join(gitCommonDirectory(root), "hra-check-resources-v1");
}

export function checkPermitCount(
  hostParallelism = availableParallelism(),
): number {
  if (hostParallelism >= 12) return 4;
  if (hostParallelism >= 6) return 3;
  if (hostParallelism >= 3) return 2;
  return 1;
}

export function checkResourcePermitCount(
  mode: CheckResourceMode,
  hostParallelism = availableParallelism(),
): number {
  const capacity = checkPermitCount(hostParallelism);
  if (mode === "shared") return 1;
  if (mode === "heavy") return Math.min(2, capacity);
  return capacity;
}

function checkResourceModeRank(mode: CheckResourceMode): number {
  if (mode === "shared") return 0;
  if (mode === "heavy") return 1;
  return 2;
}

export function checkWorkerBudget(
  mode: CheckResourceMode,
  hostParallelism = availableParallelism(),
): number {
  const usableParallelism = Math.max(
    1,
    hostParallelism - checkCpuReserve(hostParallelism),
  );
  const capacity = checkPermitCount(hostParallelism);
  const claimedPermits = checkResourcePermitCount(mode, hostParallelism);
  return Math.max(
    1,
    Math.floor(usableParallelism * claimedPermits / capacity),
  );
}

export function checkTurboConcurrency(
  _hostParallelism = availableParallelism(),
): number {
  void _hostParallelism;
  // Turbo graphs remain width one while any task can traverse an unbounded
  // `^build` edge. Parallelism comes from independently admitted sessions.
  return 1;
}

function checkCpuReserve(hostParallelism: number): number {
  if (hostParallelism >= 6) return 2;
  if (hostParallelism >= 2) return 1;
  return 0;
}

function minimumIdleCpuEquivalent(hostParallelism: number): number {
  if (hostParallelism <= 2) return hostParallelism / 2;
  return checkCpuReserve(hostParallelism) + 1;
}

function boundedPositiveInteger(value: string | undefined, maximum: number): string {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return String(maximum);
  return String(Math.min(Number.parseInt(value, 10), maximum));
}

function executionEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  budget: number,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    CIRCLE_NODE_TOTAL: boundedPositiveInteger(
      environment.CIRCLE_NODE_TOTAL,
      budget + 1,
    ),
    GOMAXPROCS: boundedPositiveInteger(environment.GOMAXPROCS, budget),
    [turboConcurrencyVariable]: boundedPositiveInteger(
      environment[turboConcurrencyVariable],
      Math.min(checkTurboConcurrency(), budget),
    ),
    RAYON_NUM_THREADS: boundedPositiveInteger(environment.RAYON_NUM_THREADS, budget),
    UV_THREADPOOL_SIZE: boundedPositiveInteger(environment.UV_THREADPOOL_SIZE, budget),
    VIPS_CONCURRENCY: boundedPositiveInteger(environment.VIPS_CONCURRENCY, budget),
    VITEST_MAX_WORKERS: boundedPositiveInteger(
      environment.VITEST_MAX_WORKERS,
      budget,
    ),
    [workerBudgetVariable]: String(budget),
  };
}

export function checkCpuTimeSample(
  cpuInformation = cpus(),
): CheckCpuTimeSample | null {
  if (cpuInformation.length === 0) return null;
  let idleMilliseconds = 0;
  let totalMilliseconds = 0;
  for (const { times } of cpuInformation) {
    const values = [
      times.user,
      times.nice,
      times.sys,
      times.idle,
      times.irq,
    ];
    if (
      values.some(
        (value) => !Number.isFinite(value) || value < 0,
      )
    ) {
      return null;
    }
    idleMilliseconds += times.idle;
    totalMilliseconds += values.reduce((sum, value) => sum + value, 0);
  }
  return {
    idleMilliseconds,
    logicalCpuCount: cpuInformation.length,
    totalMilliseconds,
  };
}

export function idleCpuEquivalentFromCpuTimeSamples(
  before: CheckCpuTimeSample | null,
  after: CheckCpuTimeSample | null,
  hostParallelism = availableParallelism(),
): number | null {
  if (
    before === null
    || after === null
    || before.logicalCpuCount !== after.logicalCpuCount
    || before.logicalCpuCount < 1
    || !Number.isSafeInteger(hostParallelism)
    || hostParallelism < 1
  ) {
    return null;
  }
  const idleDelta = after.idleMilliseconds - before.idleMilliseconds;
  const totalDelta = after.totalMilliseconds - before.totalMilliseconds;
  if (
    !Number.isFinite(idleDelta)
    || !Number.isFinite(totalDelta)
    || idleDelta < 0
    || totalDelta <= 0
    || idleDelta > totalDelta
  ) {
    return null;
  }
  return Math.min(
    hostParallelism,
    Math.max(0, hostParallelism * idleDelta / totalDelta),
  );
}

export function admittedCheckWorkerBudget(
  mode: CheckResourceMode,
  idleCpuEquivalent: number,
  hostParallelism = availableParallelism(),
): number | null {
  if (!Number.isFinite(idleCpuEquivalent) || idleCpuEquivalent < 0) return null;
  if (idleCpuEquivalent < minimumIdleCpuEquivalent(hostParallelism)) {
    return null;
  }
  if (hostParallelism <= 2) return 1;
  const reserve = checkCpuReserve(hostParallelism);
  const admittedTaskWidth = checkTurboConcurrency(hostParallelism);
  const availableBudget = Math.floor(
    (idleCpuEquivalent - reserve) / admittedTaskWidth,
  );
  return availableBudget < 1
    ? null
    : Math.min(checkWorkerBudget(mode, hostParallelism), availableBudget);
}

async function waitForCpuAdmission(
  mode: CheckResourceMode,
  reportWaiting: (reason: string) => void,
  control: AdmissionJobControl,
  generation: number,
): Promise<number> {
  const hostParallelism = availableParallelism();
  const requiredIdle = minimumIdleCpuEquivalent(hostParallelism);
  const desiredBudget = checkWorkerBudget(mode, hostParallelism);
  for (;;) {
    const before = checkCpuTimeSample();
    await Bun.sleep(cpuSampleMilliseconds);
    control.checkpoint(generation);
    const idle = idleCpuEquivalentFromCpuTimeSamples(
      before,
      checkCpuTimeSample(),
      hostParallelism,
    );
    if (idle === null) {
      if (!malformedCpuCountersReported) {
        console.warn(
          "[check-resources] CPU counters were unavailable; "
          + "the weighted permit limit remains active",
        );
        malformedCpuCountersReported = true;
      }
      return desiredBudget;
    }
    const admittedBudget = admittedCheckWorkerBudget(
      mode,
      idle,
      hostParallelism,
    );
    if (admittedBudget !== null) return admittedBudget;
    reportWaiting(
      `CPU headroom (${idle.toFixed(1)} idle cores;`
      + ` ${requiredIdle.toFixed(1)} required)`,
    );
  }
}

function waitReporter(label: string, mode: CheckResourceMode): (reason: string) => void {
  const startedAt = Date.now();
  let lastReportedAt = 0;
  return (reason) => {
    const now = Date.now();
    if (lastReportedAt === 0 || now - lastReportedAt >= waitingReportMilliseconds) {
      const waitedSeconds = Math.round((now - startedAt) / 1_000);
      console.log(
        `[check-resources] ${label} waiting for ${mode} capacity`
        + ` across local worktrees: ${reason} (${waitedSeconds}s)`,
      );
      lastReportedAt = now;
    }
  };
}

class AdmissionInterruptedError extends Error {
  override readonly name = "AdmissionInterruptedError";
}

type AdmissionCleanup = () => void;

interface AdmissionJobControl {
  readonly checkpoint: (generation: number) => void;
  readonly clearCleanup: (cleanup: AdmissionCleanup) => void;
  readonly generation: () => number;
  readonly replaceCleanup: (
    expected: AdmissionCleanup,
    replacement: AdmissionCleanup,
  ) => void;
  readonly setCleanup: (cleanup: AdmissionCleanup) => void;
}

class AdmissionDescriptorAttempt {
  readonly #cleanup: AdmissionCleanup;
  readonly #control: AdmissionJobControl;
  readonly #descriptors = new Set<number>();

  constructor(control: AdmissionJobControl) {
    this.#control = control;
    this.#cleanup = () => this.closeAll();
    control.setCleanup(this.#cleanup);
  }

  open(path: string): number {
    const descriptor = openLockFile(path);
    this.#descriptors.add(descriptor);
    return descriptor;
  }

  close(descriptor: number): void {
    if (!this.#descriptors.delete(descriptor)) return;
    closeSync(descriptor);
  }

  closeAll(): void {
    const descriptors = [...this.#descriptors];
    this.#descriptors.clear();
    closeAll(descriptors);
  }

  retain(
    descriptors: readonly number[],
    release: AdmissionCleanup,
  ): void {
    for (const descriptor of descriptors) {
      if (!this.#descriptors.delete(descriptor)) {
        throw new Error("admitted check resource descriptor was not tracked");
      }
    }
    this.#control.replaceCleanup(this.#cleanup, release);
  }

  dispose(): void {
    try {
      this.closeAll();
    } finally {
      this.#control.clearCleanup(this.#cleanup);
    }
  }
}

async function waitForAdmissionRetry(
  control: AdmissionJobControl,
  generation: number,
): Promise<void> {
  await Bun.sleep(retryDelayMilliseconds);
  control.checkpoint(generation);
}

async function withAdmissionJobControl<T>(
  run: (control: AdmissionJobControl) => Promise<T>,
): Promise<T> {
  let cleanup: AdmissionCleanup | null = null;
  let cleanupFailure: unknown;
  let generation = 0;
  let stopping = false;
  const control: AdmissionJobControl = {
    checkpoint(expectedGeneration) {
      if (cleanupFailure !== undefined) {
        throw new Error("stopped check resource admission could not release its locks", {
          cause: cleanupFailure,
        });
      }
      if (generation !== expectedGeneration) throw new AdmissionInterruptedError();
    },
    clearCleanup(expected) {
      if (cleanup === expected) cleanup = null;
    },
    generation: () => generation,
    replaceCleanup(expected, replacement) {
      if (cleanup !== expected) {
        throw new Error("check resource admission cleanup changed unexpectedly");
      }
      cleanup = replacement;
    },
    setCleanup(nextCleanup) {
      if (cleanup !== null) {
        throw new Error("check resource admission already owns a cleanup boundary");
      }
      cleanup = nextCleanup;
    },
  };
  const releaseForStop = (): void => {
    generation += 1;
    const activeCleanup = cleanup;
    cleanup = null;
    try {
      activeCleanup?.();
    } catch (error) {
      cleanupFailure ??= error;
    }
  };
  const onStop = (): void => {
    if (stopping) return;
    stopping = true;
    releaseForStop();
    process.kill(process.pid, "SIGSTOP");
  };
  const onContinue = (): void => {
    stopping = false;
  };
  process.on("SIGTSTP", onStop);
  process.on("SIGCONT", onContinue);
  try {
    const result = await run(control);
    if (cleanupFailure !== undefined) {
      throw new Error("stopped check resource admission could not release its locks", {
        cause: cleanupFailure,
      });
    }
    if (cleanup === null) throw new AdmissionInterruptedError();
    cleanup = null;
    return result;
  } catch (error) {
    const activeCleanup = cleanup as AdmissionCleanup | null;
    cleanup = null;
    try {
      activeCleanup?.();
    } catch {
      // Preserve the acquisition failure.
    }
    throw error;
  } finally {
    process.off("SIGTSTP", onStop);
    process.off("SIGCONT", onContinue);
  }
}

async function acquireWeighted(
  stateRoot: string,
  mode: "heavy" | "shared",
  reportWaiting: (reason: string) => void,
  workerBudget: number,
  control: AdmissionJobControl,
  generation: number,
): Promise<HeldCheckResources> {
  const capacity = checkPermitCount();
  const permitCount = checkResourcePermitCount(mode);
  const startIndex = process.pid % capacity;
  for (;;) {
    const attempt = new AdmissionDescriptorAttempt(control);
    try {
      const slots = permitFileNames(capacity).map(
        (name) => attempt.open(join(stateRoot, name)),
      );
      const exclusiveIntent = attempt.open(
        join(stateRoot, "exclusive-intent.lock"),
      );
      if (!tryLock(exclusiveIntent)) {
        reportWaiting("an exclusive check has declared its intent");
        attempt.closeAll();
        await waitForAdmissionRetry(control, generation);
        continue;
      }
      const compatibilityTurnstile = attempt.open(
        join(stateRoot, "turnstile.lock"),
      );
      if (!tryLockShared(compatibilityTurnstile)) {
        reportWaiting("a legacy check owns the compatibility turnstile");
        attempt.closeAll();
        await waitForAdmissionRetry(control, generation);
        continue;
      }
      const admissionTurnstile = attempt.open(
        join(stateRoot, weightedTurnstileFileName),
      );
      if (!tryLock(admissionTurnstile)) {
        reportWaiting("an earlier check owns the weighted admission turnstile");
        attempt.closeAll();
        await waitForAdmissionRetry(control, generation);
        continue;
      }

      // Once the weighted turnstile is ours, an exclusive waiter may publish intent
      // while this atomic weighted claim drains. That stops later shared
      // claimants and guarantees the exclusive request can make progress as
      // soon as this claim has entered and eventually released its permits.
      attempt.close(exclusiveIntent);

      const heldSlotIndexes: number[] = [];
      while (heldSlotIndexes.length < permitCount) {
        for (let offset = 0; offset < capacity; offset += 1) {
          const index = (startIndex + offset) % capacity;
          if (heldSlotIndexes.includes(index)) continue;
          const slot = slots[index];
          if (slot !== undefined && tryLock(slot)) {
            heldSlotIndexes.push(index);
            if (heldSlotIndexes.length === permitCount) break;
          }
        }
        if (heldSlotIndexes.length < permitCount) {
          if (mode === "shared") break;
          reportWaiting(
            `${permitCount - heldSlotIndexes.length} of ${permitCount}`
            + " heavy permits are still occupied",
          );
          await waitForAdmissionRetry(control, generation);
        }
      }

      if (heldSlotIndexes.length < permitCount) {
        reportWaiting(`all ${capacity} permits are occupied`);
        attempt.closeAll();
        await waitForAdmissionRetry(control, generation);
        continue;
      }
      const heldSlots = heldSlotIndexes.map((index) => {
        const slot = slots[index];
        if (slot === undefined) {
          throw new Error("admitted check resource permit disappeared");
        }
        return slot;
      });
      const token = bindLockToken(heldSlots);
      for (const [index, slot] of slots.entries()) {
        if (!heldSlotIndexes.includes(index)) attempt.close(slot);
      }
      attempt.close(admissionTurnstile);
      const descriptors = [compatibilityTurnstile, ...heldSlots];
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        closeAll(descriptors);
      };
      attempt.retain(descriptors, release);
      return {
        capacity,
        descriptors,
        fileNames: [
          "turnstile.lock",
          ...heldSlotIndexes.map((index) => `slot-${index + 1}.lock`),
        ],
        permitCount,
        release,
        token,
        workerBudget,
      };
    } finally {
      attempt.dispose();
    }
  }
}

async function acquireExclusive(
  stateRoot: string,
  reportWaiting: (reason: string) => void,
  workerBudget: number,
  control: AdmissionJobControl,
  generation: number,
): Promise<HeldCheckResources> {
  const capacity = checkPermitCount();
  const attempt = new AdmissionDescriptorAttempt(control);
  try {
    const exclusiveIntent = attempt.open(
      join(stateRoot, "exclusive-intent.lock"),
    );
    const turnstile = attempt.open(join(stateRoot, "turnstile.lock"));
    const slots = permitFileNames(capacity).map(
      (name) => attempt.open(join(stateRoot, name)),
    );
    while (!tryLock(exclusiveIntent)) {
      reportWaiting("an earlier exclusive check owns writer intent");
      await waitForAdmissionRetry(control, generation);
    }
    const token = randomUUID();
    bindLockToken([exclusiveIntent], token);
    while (!tryLock(turnstile)) {
      reportWaiting("an earlier check owns the admission turnstile");
      await waitForAdmissionRetry(control, generation);
    }
    bindLockToken([turnstile], token);
    const held = [turnstile, exclusiveIntent];
    for (const slot of slots) {
      while (!tryLock(slot)) {
        reportWaiting("an admitted check is still running");
        await waitForAdmissionRetry(control, generation);
      }
      held.push(slot);
      bindLockToken([slot], token);
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      closeAll(held);
    };
    attempt.retain(held, release);
    return {
      capacity,
      descriptors: held,
      fileNames: [
        "turnstile.lock",
        "exclusive-intent.lock",
        ...permitFileNames(capacity),
      ],
      permitCount: capacity,
      release,
      token,
      workerBudget,
    };
  } finally {
    attempt.dispose();
  }
}

function tryAcquireExclusiveOnce(
  stateRoot: string,
  workerBudget: number,
): HeldCheckResources | null {
  const capacity = checkPermitCount();
  const opened = new Set<number>();
  let retained = false;
  const open = (path: string): number => {
    const descriptor = openLockFile(path);
    opened.add(descriptor);
    return descriptor;
  };
  try {
    const exclusiveIntent = open(join(stateRoot, "exclusive-intent.lock"));
    const turnstile = open(join(stateRoot, "turnstile.lock"));
    const slots = permitFileNames(capacity).map(
      (name) => open(join(stateRoot, name)),
    );
    if (!tryLock(exclusiveIntent) || !tryLock(turnstile)) return null;
    for (const slot of slots) {
      if (!tryLock(slot)) return null;
    }
    const token = randomUUID();
    const held = [turnstile, exclusiveIntent, ...slots];
    bindLockToken(held, token);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      for (const descriptor of held) opened.delete(descriptor);
      closeAll(held);
    };
    retained = true;
    return {
      capacity,
      descriptors: held,
      fileNames: [
        "turnstile.lock",
        "exclusive-intent.lock",
        ...permitFileNames(capacity),
      ],
      permitCount: capacity,
      release,
      token,
      workerBudget,
    };
  } finally {
    if (!retained) {
      const descriptors = [...opened];
      opened.clear();
      closeAll(descriptors);
    }
  }
}

async function acquireCheckResources(
  stateRoot: string,
  label: string,
  mode: CheckResourceMode,
  cpuAdmission: boolean,
): Promise<HeldCheckResources> {
  const reportWaiting = waitReporter(label, mode);
  for (;;) {
    try {
      return await withAdmissionJobControl(async (control) => {
        for (;;) {
          const generation = control.generation();
          let held: HeldCheckResources | null = null;
          try {
            // CPU admission is intentionally complete before any intent,
            // turnstile, or permit lock can be owned. A pressured host may
            // leave this wrapper waiting, but it can never become a childless
            // owner that blocks unrelated work.
            const workerBudget = cpuAdmission
              ? await waitForCpuAdmission(
                mode,
                reportWaiting,
                control,
                generation,
              )
              : checkWorkerBudget(mode);
            control.checkpoint(generation);
            held = mode === "exclusive"
              ? await acquireExclusive(
                stateRoot,
                reportWaiting,
                workerBudget,
                control,
                generation,
              )
              : await acquireWeighted(
                stateRoot,
                mode,
                reportWaiting,
                workerBudget,
                control,
                generation,
              );
            control.checkpoint(generation);
            return held;
          } catch (error) {
            held?.release();
            if (error instanceof AdmissionInterruptedError) continue;
            throw error;
          }
        }
      });
    } catch (error) {
      if (error instanceof AdmissionInterruptedError) continue;
      throw error;
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lockFilesAreHeldByToken(
  stateRoot: string,
  fileNames: readonly string[],
  token: string,
): boolean {
  const descriptors: number[] = [];
  try {
    for (const name of fileNames) {
      descriptors.push(openLockFile(join(stateRoot, name)));
    }
    const tokenBuffer = Buffer.alloc(token.length + 1);
    return descriptors.every((descriptor) => {
      tokenBuffer.fill(0);
      const bytesRead = readSync(
        descriptor,
        tokenBuffer,
        0,
        tokenBuffer.length,
        0,
      );
      return bytesRead === token.length
        && tokenBuffer.subarray(0, bytesRead).toString("utf8") === token
        && !tryLock(descriptor);
    });
  } finally {
    closeAll(descriptors);
  }
}

function lockFilesAreHeld(
  stateRoot: string,
  fileNames: readonly string[],
): boolean {
  const descriptors: number[] = [];
  try {
    for (const name of fileNames) {
      descriptors.push(openLockFile(join(stateRoot, name)));
    }
    return descriptors.every((descriptor) => !tryLock(descriptor));
  } finally {
    closeAll(descriptors);
  }
}

function lockFilesAreHeldByFingerprint(
  stateRoot: string,
  fileNames: readonly string[],
  fingerprint: string,
): boolean {
  const descriptors: number[] = [];
  try {
    for (const name of fileNames) {
      descriptors.push(openLockFile(join(stateRoot, name)));
    }
    const tokenBuffer = Buffer.alloc(128);
    return descriptors.every((descriptor) => {
      tokenBuffer.fill(0);
      const bytesRead = readSync(
        descriptor,
        tokenBuffer,
        0,
        tokenBuffer.length,
        0,
      );
      const token = tokenBuffer.subarray(0, bytesRead).toString("utf8");
      return leaseTokenPattern.test(token)
        && createHash("sha256").update(token).digest("hex") === fingerprint
        && !tryLock(descriptor);
    });
  } finally {
    closeAll(descriptors);
  }
}

export function areCheckResourceLeaseFilesHeld(
  request: CheckResourceLeaseProbeRequest,
): boolean {
  const root = realpathSync(resolve(request.root));
  const repositoryIdentity = gitCommonDirectory(root);
  const stateRoot = ensureStateRoot(
    request.stateRoot === undefined
      ? join(repositoryIdentity, "hra-check-resources-v1")
      : request.stateRoot,
  );
  if (
    request.fileNames.length === 0
    || new Set(request.fileNames).size !== request.fileNames.length
    || request.fileNames.some((name) => !lockFileNames.has(name))
    || !/^[0-9a-f]{64}$/u.test(request.leaseFingerprint)
  ) {
    throw new Error("check resource lease probe has invalid lock files");
  }
  return lockFilesAreHeldByFingerprint(
    stateRoot,
    request.fileNames,
    request.leaseFingerprint,
  );
}

function parseInheritedBinding(
  environment: Readonly<NodeJS.ProcessEnv>,
  repositoryIdentity: string,
  stateRoot: string,
): InheritedBinding | null {
  const serialized = environment[bindingVariable];
  if (serialized === undefined) return null;
  if (serialized.length === 0 || serialized.length > 4_096) {
    throw new Error("inherited check resource binding has an invalid length");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("inherited check resource binding is not valid JSON");
  }
  if (
    !object(value)
    || value.version !== bindingVersion
    || value.repository !== repositoryIdentity
    || (
      value.mode !== "shared"
      && value.mode !== "heavy"
      && value.mode !== "exclusive"
    )
    || typeof value.token !== "string"
    || !leaseTokenPattern.test(value.token)
    || typeof value.ownerPid !== "number"
    || !Number.isSafeInteger(value.ownerPid)
    || value.ownerPid < 1
    || typeof value.workerBudget !== "number"
    || !Number.isSafeInteger(value.workerBudget)
    || value.workerBudget < 1
    || !Array.isArray(value.files)
  ) {
    throw new Error("inherited check resource binding is malformed or belongs to another repository");
  }
  if (value.workerBudget > checkWorkerBudget(value.mode)) {
    throw new Error("inherited check resource binding exceeds the local worker budget");
  }
  const capacity = checkPermitCount();
  const activeSlotNames = new Set(permitFileNames(capacity));
  const expectedExclusiveNames = [
    "exclusive-intent.lock",
    ...permitFileNames(capacity),
    "turnstile.lock",
  ].sort();
  const descriptors: number[] = [];
  const fileNames: string[] = [];
  for (const candidate of value.files) {
    if (
      !object(candidate)
      || typeof candidate.name !== "string"
      || !lockFileNames.has(candidate.name)
      || typeof candidate.fd !== "number"
      || !Number.isSafeInteger(candidate.fd)
      || candidate.fd < 3
      || candidate.fd > 64
      || fileNames.includes(candidate.name)
      || descriptors.includes(candidate.fd)
    ) {
      throw new Error("inherited check resource descriptor is malformed");
    }
    descriptors.push(candidate.fd);
    fileNames.push(candidate.name);
  }
  const sortedNames = [...fileNames].sort();
  const weightedDescriptorCount = checkResourcePermitCount(value.mode);
  const coversWeightedMode = value.mode === "exclusive"
    ? JSON.stringify(sortedNames) === JSON.stringify(expectedExclusiveNames)
    : (
      sortedNames.length === weightedDescriptorCount + 1
      && sortedNames.includes("turnstile.lock")
      && sortedNames
        .filter((name) => name !== "turnstile.lock")
        .every((name) => activeSlotNames.has(name))
    );
  if (!coversWeightedMode) {
    throw new Error("inherited check resource binding does not cover its declared mode");
  }
  let descriptorsMatch = true;
  for (const [index, descriptor] of descriptors.entries()) {
    const name = fileNames[index];
    if (name === undefined) throw new Error("inherited check resource descriptor is unbound");
    try {
      const path = join(stateRoot, name);
      const opened = fstatSync(descriptor);
      const published = lstatSync(path);
      assertOwnedRegularFile(path, opened);
      assertOwnedRegularFile(path, published);
      if (opened.dev !== published.dev || opened.ino !== published.ino) {
        descriptorsMatch = false;
        break;
      }
    } catch {
      descriptorsMatch = false;
      break;
    }
  }
  const tokenFileNames = value.mode === "exclusive"
    ? fileNames
    : fileNames.filter((name) => name !== "turnstile.lock");
  const compatibilityFenceIsHeld = value.mode === "exclusive"
    || lockFilesAreHeld(stateRoot, ["turnstile.lock"]);
  if (
    !compatibilityFenceIsHeld
    || !lockFilesAreHeldByToken(stateRoot, tokenFileNames, value.token)
  ) {
    throw new Error(
      "inherited check resource binding is not backed by its active locks",
    );
  }
  return {
    descriptors: descriptorsMatch ? descriptors : [],
    fileNames,
    mode: value.mode,
    serialized,
    token: value.token,
    workerBudget: value.workerBudget,
  };
}

export function shouldBypassCheckResources(
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean {
  return environment.GITHUB_ACTIONS === "true";
}

export function activeCheckResourceLeaseIdentity(): ActiveCheckResourceLeaseIdentity | null {
  const active = activeCheckResourceLease.getStore();
  if (
    active === undefined
    || !active.active
    || active.execution.leaseMode === null
    || active.execution.repositoryIdentity === null
  ) {
    return null;
  }
  return {
    repositoryIdentity: active.execution.repositoryIdentity,
    stateRoot: active.stateRoot,
  };
}

export function uncoordinatedCheckResourceExecution(
  environment: NodeJS.ProcessEnv = process.env,
): CheckResourceExecution {
  const cleanedEnvironment = { ...environment };
  delete cleanedEnvironment[bindingVariable];
  return {
    environment: cleanedEnvironment,
    inheritedDescriptors: [],
    inheritedFileNames: [],
    leaseToken: null,
    leaseMode: null,
    ownsLease: false,
    repositoryIdentity: null,
  };
}

function installOwnedLeaseJobControl(): OwnedLeaseJobControl {
  let admissionActive = true;
  let disposed = false;
  let releaseLease: AdmissionCleanup | null = null;
  let stopPending = false;
  let stopping = false;
  let stopTarget: LeaseStopTarget | null = null;
  const onStop = (): void => {
    // The admission-specific listener owns cleanup and suspension until its
    // final ownership handshake. Keeping this listener installed first closes
    // the signal-registration gap without preempting that cleanup.
    if (admissionActive || stopPending || stopping) return;
    if (stopTarget === null) {
      // A scheduler CLI calls its command runner synchronously, but the
      // guardian target is attached only after spawn. Defer suspension across
      // that childless interval so the wrapper cannot stop while retaining a
      // lease that no live workload can make progress on.
      stopPending = true;
      return;
    }
    stopping = true;
    try {
      stopTarget("SIGTSTP");
    } finally {
      process.kill(process.pid, "SIGSTOP");
    }
  };
  const onContinue = (): void => {
    if (admissionActive) return;
    if (stopPending) {
      stopPending = false;
      return;
    }
    stopping = false;
    stopTarget?.("SIGCONT");
  };
  process.on("SIGTSTP", onStop);
  process.on("SIGCONT", onContinue);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      process.off("SIGTSTP", onStop);
      process.off("SIGCONT", onContinue);
      stopTarget = null;
      if (stopPending) {
        stopPending = false;
        releaseLease?.();
        process.kill(process.pid, "SIGSTOP");
      }
      releaseLease = null;
    },
    finishAdmission(release) {
      if (disposed || !admissionActive) {
        throw new Error("check resource job-control admission handoff was invalid");
      }
      releaseLease = release;
      admissionActive = false;
    },
    setStopTarget(target) {
      if (disposed) {
        throw new Error("check resource job-control handoff is already closed");
      }
      stopTarget = target;
      if (target !== null && stopPending) {
        stopPending = false;
        stopping = true;
        try {
          target("SIGTSTP");
        } finally {
          process.kill(process.pid, "SIGSTOP");
        }
      }
    },
  };
}

export async function tryWithExclusiveCheckResources<T>(
  request: TryExclusiveCheckResourceRequest,
  run: (execution: CheckResourceExecution) => Promise<T>,
): Promise<TryExclusiveCheckResourceResult<T>> {
  if (request.cpuAdmission !== undefined && request.cpuAdmission !== false) {
    throw new Error("a nonblocking exclusive lease cannot wait for CPU admission");
  }
  if (request.mode !== undefined && request.mode !== "exclusive") {
    throw new Error("a nonblocking exclusive lease must use exclusive mode");
  }
  const root = realpathSync(resolve(request.root));
  const label = checkedLabel(request.label);
  const environment = request.environment ?? process.env;
  const repositoryIdentity = gitCommonDirectory(root);
  const active = activeCheckResourceLease.getStore();
  const runWithExistingLeaseSemantics = async (): Promise<
    TryExclusiveCheckResourceResult<T>
  > => ({
    acquired: true,
    value: await withCheckResources(
      {
        cpuAdmission: false,
        environment,
        label,
        mode: "exclusive",
        root,
        ...(request.stateRoot === undefined
          ? {}
          : { stateRoot: request.stateRoot }),
      },
      run,
    ),
  });
  if (active === undefined && shouldBypassCheckResources(environment)) {
    return runWithExistingLeaseSemantics();
  }

  const stateRoot = ensureStateRoot(
    request.stateRoot === undefined
      ? join(repositoryIdentity, "hra-check-resources-v1")
      : request.stateRoot,
  );
  if (
    (
      active !== undefined
      && active.active
      && active.execution.repositoryIdentity === repositoryIdentity
      && active.stateRoot === stateRoot
      && active.execution.leaseMode !== null
    )
    || shouldBypassCheckResources(environment)
    || environment[bindingVariable] !== undefined
  ) {
    return runWithExistingLeaseSemantics();
  }

  const acquisitionStartedAt = Date.now();
  const leaseJobControl = installOwnedLeaseJobControl();
  let held: HeldCheckResources | null;
  try {
    held = tryAcquireExclusiveOnce(
      stateRoot,
      checkWorkerBudget("exclusive"),
    );
  } catch (error) {
    leaseJobControl.dispose();
    throw error;
  }
  if (held === null) {
    leaseJobControl.dispose();
    return { acquired: false, reason: "contended" };
  }
  try {
    leaseJobControl.finishAdmission(held.release);
  } catch (error) {
    leaseJobControl.dispose();
    held.release();
    throw error;
  }
  const acquiredAt = Date.now();
  const workerBudget = Number.parseInt(
    boundedPositiveInteger(
      environment[workerBudgetVariable],
      held.workerBudget,
    ),
    10,
  );
  console.log(
    `[check-resources] ${label} acquired exclusive capacity`
    + ` (${held.permitCount}/${held.capacity} permits,`
    + ` nested worker budget ${workerBudget},`
    + ` waited ${acquiredAt - acquisitionStartedAt}ms)`,
  );
  try {
    const execution: CheckResourceExecution = {
      environment: executionEnvironment(environment, workerBudget),
      inheritedDescriptors: held.descriptors,
      inheritedFileNames: held.fileNames,
      leaseToken: held.token,
      leaseMode: "exclusive",
      ownsLease: true,
      repositoryIdentity,
    };
    const activeLease: ActiveCheckResourceLease = {
      active: true,
      execution,
      stateRoot,
    };
    ownedLeaseJobControls.set(execution, leaseJobControl);
    try {
      return {
        acquired: true,
        value: await activeCheckResourceLease.run(
          activeLease,
          () => run(execution),
        ),
      };
    } finally {
      activeLease.active = false;
      ownedLeaseJobControls.delete(execution);
    }
  } finally {
    leaseJobControl.dispose();
    held.release();
    console.log(
      `[check-resources] ${label} released exclusive capacity`
      + ` (ran ${Date.now() - acquiredAt}ms)`,
    );
  }
}

export async function withCheckResources<T>(
  request: CheckResourceRequest,
  run: (execution: CheckResourceExecution) => Promise<T>,
): Promise<T> {
  const root = realpathSync(resolve(request.root));
  const label = checkedLabel(request.label);
  const environment = request.environment ?? process.env;
  const repositoryIdentity = gitCommonDirectory(root);
  const active = activeCheckResourceLease.getStore();
  if (active === undefined && shouldBypassCheckResources(environment)) {
    return run(uncoordinatedCheckResourceExecution({ ...environment }));
  }

  const stateRoot = ensureStateRoot(
    request.stateRoot === undefined
      ? join(repositoryIdentity, "hra-check-resources-v1")
      : request.stateRoot,
  );
  if (
    active !== undefined
    && active.active
    && active.execution.repositoryIdentity === repositoryIdentity
    && active.stateRoot === stateRoot
    && active.execution.leaseMode !== null
  ) {
    if (
      checkResourceModeRank(request.mode)
      > checkResourceModeRank(active.execution.leaseMode)
    ) {
      throw new Error(
        `a ${active.execution.leaseMode} check resource lease cannot be upgraded`
        + ` to ${request.mode}`,
      );
    }
    const activeBudget = Number.parseInt(
      active.execution.environment[workerBudgetVariable] ?? "",
      10,
    );
    if (!Number.isSafeInteger(activeBudget) || activeBudget < 1) {
      throw new Error("active check resource lease has an invalid worker budget");
    }
    const nestedEnvironment = { ...environment };
    if (active.execution.inheritedDescriptors.length === 0) {
      const serialized = active.execution.environment[bindingVariable];
      if (serialized === undefined) {
        throw new Error("indirect active check resource lease lost its binding");
      }
      nestedEnvironment[bindingVariable] = serialized;
    }
    return run({
      environment: executionEnvironment(nestedEnvironment, activeBudget),
      inheritedDescriptors: active.execution.inheritedDescriptors,
      inheritedFileNames: active.execution.inheritedFileNames,
      leaseToken: active.execution.leaseToken,
      leaseMode: active.execution.leaseMode,
      ownsLease: false,
      repositoryIdentity,
    });
  }
  if (shouldBypassCheckResources(environment)) {
    return run(uncoordinatedCheckResourceExecution({ ...environment }));
  }
  const inherited = parseInheritedBinding(
    environment,
    repositoryIdentity,
    stateRoot,
  );
  if (inherited !== null) {
    if (checkResourceModeRank(request.mode) > checkResourceModeRank(inherited.mode)) {
      throw new Error(
        `a ${inherited.mode} check resource lease cannot be upgraded`
        + ` to ${request.mode}`,
      );
    }
    const execution: CheckResourceExecution = {
      environment: executionEnvironment(
        { ...environment, [bindingVariable]: inherited.serialized },
        inherited.workerBudget,
      ),
      inheritedDescriptors: inherited.descriptors,
      inheritedFileNames: inherited.fileNames,
      leaseToken: inherited.token,
      leaseMode: inherited.mode,
      ownsLease: false,
      repositoryIdentity,
    };
    const activeLease: ActiveCheckResourceLease = {
      active: true,
      execution,
      stateRoot,
    };
    try {
      return await activeCheckResourceLease.run(
        activeLease,
        () => run(execution),
      );
    } finally {
      activeLease.active = false;
    }
  }

  const acquisitionStartedAt = Date.now();
  const leaseJobControl = installOwnedLeaseJobControl();
  let held: HeldCheckResources;
  try {
    held = await acquireCheckResources(
      stateRoot,
      label,
      request.mode,
      request.cpuAdmission !== false,
    );
    leaseJobControl.finishAdmission(held.release);
  } catch (error) {
    leaseJobControl.dispose();
    throw error;
  }
  const acquiredAt = Date.now();
  const workerBudget = Number.parseInt(
    boundedPositiveInteger(
      environment[workerBudgetVariable],
      held.workerBudget,
    ),
    10,
  );
  console.log(
    `[check-resources] ${label} acquired ${request.mode} capacity`
    + ` (${held.permitCount}/${held.capacity} permits,`
    + ` nested worker budget ${workerBudget},`
    + ` waited ${acquiredAt - acquisitionStartedAt}ms)`,
  );
  try {
    const execution: CheckResourceExecution = {
      environment: executionEnvironment(environment, workerBudget),
      inheritedDescriptors: held.descriptors,
      inheritedFileNames: held.fileNames,
      leaseToken: held.token,
      leaseMode: request.mode,
      ownsLease: true,
      repositoryIdentity,
    };
    const activeLease: ActiveCheckResourceLease = {
      active: true,
      execution,
      stateRoot,
    };
    ownedLeaseJobControls.set(execution, leaseJobControl);
    try {
      return await activeCheckResourceLease.run(
        activeLease,
        () => run(execution),
      );
    } finally {
      activeLease.active = false;
      ownedLeaseJobControls.delete(execution);
    }
  } finally {
    leaseJobControl.dispose();
    held.release();
    console.log(
      `[check-resources] ${label} released ${request.mode} capacity`
      + ` (ran ${Date.now() - acquiredAt}ms)`,
    );
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const signalNumber = osConstants.signals[signal];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function signalProcess(
  pid: number,
  signal: NodeJS.Signals,
  processGroup: boolean,
): void {
  try {
    process.kill(processGroup ? -pid : pid, signal);
  } catch (error: unknown) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ESRCH"
    ) {
      throw error;
    }
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ESRCH"
    ) {
      return false;
    }
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "EPERM"
    ) {
      return true;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(pid: number, label: string): Promise<void> {
  let lastReportedAt = 0;
  while (processGroupExists(pid)) {
    const now = Date.now();
    if (lastReportedAt === 0 || now - lastReportedAt >= waitingReportMilliseconds) {
      console.log(
        `[check-resources] ${label} waiting for its process group to exit`,
      );
      lastReportedAt = now;
    }
    await Bun.sleep(50);
  }
}

function childEnvironment(execution: CheckResourceExecution): NodeJS.ProcessEnv {
  const environment = { ...execution.environment };
  const inheritedSerialized = environment[bindingVariable];
  delete environment[bindingVariable];
  if (execution.inheritedDescriptors.length === 0) {
    if (execution.leaseMode === null) return environment;
    if (inheritedSerialized === undefined) {
      throw new Error("indirect check resource execution lost its lease binding");
    }
    environment[bindingVariable] = inheritedSerialized;
    return environment;
  }
  if (
    execution.repositoryIdentity === null
    || execution.leaseToken === null
    || execution.leaseMode === null
    || execution.inheritedDescriptors.length !== execution.inheritedFileNames.length
  ) {
    throw new Error("check resource execution cannot describe its inherited lease");
  }
  const workerBudget = Number.parseInt(
    execution.environment[workerBudgetVariable] ?? "",
    10,
  );
  if (!Number.isSafeInteger(workerBudget) || workerBudget < 1) {
    throw new Error("check resource execution has an invalid worker budget");
  }
  environment[bindingVariable] = JSON.stringify({
    files: execution.inheritedFileNames.map((name, index) => ({
      fd: index + 3,
      name,
    })),
    mode: execution.leaseMode,
    ownerPid: process.pid,
    repository: execution.repositoryIdentity,
    token: execution.leaseToken,
    version: bindingVersion,
    workerBudget,
  });
  return environment;
}

function serializableEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function parseGuardianStartMessage(value: unknown): GuardianStartMessage {
  if (
    !object(value)
    || value.type !== "start"
    || value.version !== guardianProtocolVersion
    || !Array.isArray(value.arguments)
    || !value.arguments.every((argument) => typeof argument === "string")
    || typeof value.descriptorCount !== "number"
    || !Number.isSafeInteger(value.descriptorCount)
    || value.descriptorCount < 1
    || value.descriptorCount > maximumPermitCount + 2
    || !object(value.environment)
    || typeof value.label !== "string"
    || typeof value.program !== "string"
    || value.program.length === 0
    || controlCharacter(value.program)
    || typeof value.root !== "string"
    || !isAbsolute(value.root)
  ) {
    throw new Error("check resource guardian received a malformed start message");
  }
  const environmentEntries = Object.entries(value.environment);
  if (
    environmentEntries.some(
      ([name, entry]) => (
        name.length === 0
        || name.includes("=")
        || controlCharacter(name)
        || typeof entry !== "string"
        || entry.includes("\0")
      ),
    )
  ) {
    throw new Error("check resource guardian received a malformed environment");
  }
  return {
    arguments: [...value.arguments],
    descriptorCount: value.descriptorCount,
    environment: Object.fromEntries(environmentEntries) as NodeJS.ProcessEnv,
    label: checkedLabel(value.label),
    program: value.program,
    root: value.root,
    type: "start",
    version: guardianProtocolVersion,
  };
}

function parseGuardianResponseMessage(value: unknown): GuardianResponseMessage {
  if (!object(value) || value.version !== guardianProtocolVersion) {
    throw new Error("check resource guardian sent a malformed response");
  }
  if (value.type === "ready") {
    return { type: "ready", version: guardianProtocolVersion };
  }
  if (
    value.type === "spawned"
    && typeof value.pid === "number"
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
  ) {
    return {
      pid: value.pid,
      type: "spawned",
      version: guardianProtocolVersion,
    };
  }
  if (
    value.type === "result"
    && typeof value.status === "number"
    && Number.isSafeInteger(value.status)
    && value.status >= 0
    && value.status <= 255
  ) {
    return {
      status: value.status,
      type: "result",
      version: guardianProtocolVersion,
    };
  }
  if (
    value.type === "error"
    && typeof value.message === "string"
    && value.message.length > 0
    && value.message.length <= 8_192
  ) {
    return {
      message: value.message,
      type: "error",
      version: guardianProtocolVersion,
    };
  }
  throw new Error("check resource guardian sent a malformed response");
}

async function sendGuardianResponse(
  message: GuardianResponseMessage,
): Promise<boolean> {
  if (!process.connected || process.send === undefined) return false;
  return new Promise<boolean>((resolveSend) => {
    try {
      process.send?.(message, (error) => {
        resolveSend(error == null);
      });
    } catch {
      resolveSend(false);
    }
  });
}

async function runCheckResourceGuardian(): Promise<number> {
  if (process.platform === "win32") {
    throw new Error("check resource guardians require POSIX process groups");
  }
  if (!process.connected || process.send === undefined) {
    throw new Error("check resource guardian requires its supervisor IPC channel");
  }

  let parentConnected = true;
  let startMessageReceived = false;
  let workloadPid: number | null = null;
  let stopRequested = false;
  let workloadSuspended = false;
  let forwardedSignal: NodeJS.Signals | null = null;
  let forceKillRequested = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveStart: ((message: GuardianStartMessage) => void) | null = null;
  let rejectStart: ((error: Error) => void) | null = null;

  const armKillTimer = (): void => {
    if (killTimer !== null || workloadPid === null) return;
    killTimer = setTimeout(() => {
      if (workloadPid === null) return;
      try {
        signalProcess(workloadPid, "SIGKILL", true);
      } catch {
        // The first forwarded signal continues to own the reported result.
      }
    }, terminationGraceMilliseconds);
    killTimer.unref();
  };
  const resumeWorkload = (): void => {
    stopRequested = false;
    if (workloadPid !== null && workloadSuspended) {
      signalProcess(workloadPid, "SIGCONT", true);
    }
    workloadSuspended = false;
  };
  const forwardTerminationSignal = (signal: NodeJS.Signals): void => {
    if (forwardedSignal === null) {
      forwardedSignal = signal;
      resumeWorkload();
      if (workloadPid !== null) {
        signalProcess(workloadPid, signal, true);
        armKillTimer();
      }
      return;
    }
    forceKillRequested = true;
    if (workloadPid !== null) {
      signalProcess(workloadPid, "SIGKILL", true);
    }
  };
  const onInterrupt = (): void => forwardTerminationSignal("SIGINT");
  const onTerminate = (): void => forwardTerminationSignal("SIGTERM");
  const onHangup = (): void => forwardTerminationSignal("SIGHUP");
  const onQuit = (): void => forwardTerminationSignal("SIGQUIT");
  const onStop = (): void => {
    if (!parentConnected) return;
    stopRequested = true;
    if (workloadPid !== null) {
      signalProcess(workloadPid, "SIGSTOP", true);
      workloadSuspended = true;
    }
  };
  const onContinue = (): void => {
    resumeWorkload();
    if (workloadPid !== null) {
      signalProcess(workloadPid, "SIGCONT", true);
    }
  };
  const onDisconnect = (): void => {
    parentConnected = false;
    resumeWorkload();
    if (!startMessageReceived) {
      rejectStart?.(
        new Error("check resource supervisor disconnected before the start handshake"),
      );
    }
  };
  const onStartMessage = (value: unknown): void => {
    if (startMessageReceived) return;
    startMessageReceived = true;
    try {
      resolveStart?.(parseGuardianStartMessage(value));
    } catch (error: unknown) {
      rejectStart?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onHangup);
  process.on("SIGQUIT", onQuit);
  process.on("SIGTSTP", onStop);
  process.on("SIGCONT", onContinue);
  process.on("disconnect", onDisconnect);
  const startMessage = new Promise<GuardianStartMessage>((resolveMessage, reject) => {
    resolveStart = resolveMessage;
    rejectStart = reject;
    process.once("message", onStartMessage);
  });

  try {
    if (!await sendGuardianResponse({
      type: "ready",
      version: guardianProtocolVersion,
    })) {
      throw new Error("check resource guardian could not complete its ready handshake");
    }
    const start = await startMessage;
    if (forwardedSignal !== null) return signalExitCode(forwardedSignal);

    try {
      // Lower the guardian before spawning so the workload inherits niceness
      // from its first instruction instead of racing a post-spawn adjustment.
      setPriority(process.pid, localCheckNiceness);
    } catch {
      console.warn(
        `[check-resources] ${start.label} could not lower its CPU priority`,
      );
    }

    const leaseDescriptors = Array.from(
      { length: start.descriptorCount },
      (_, index) => guardianLeaseDescriptorOffset + index,
    );
    // The guardian's lease descriptors begin immediately after its IPC fd.
    // Remapping those adjacent sources down to workload fds 3..N can clobber a
    // later source descriptor on some spawn implementations. Duplicate them
    // above the child target range before constructing the stdio map.
    const spawnDescriptors = duplicateDescriptorsForSpawn(
      leaseDescriptors,
      3 + leaseDescriptors.length,
    );
    const stdio: StdioOptions = [
      "inherit",
      "inherit",
      "inherit",
      ...spawnDescriptors,
    ];
    const workload = (() => {
      try {
        return spawn(start.program, start.arguments, {
          cwd: start.root,
          detached: true,
          env: start.environment,
          stdio,
        });
      } finally {
        closeAll(spawnDescriptors);
      }
    })();
    workloadPid = workload.pid ?? null;
    let resolveSpawn: (
      outcome: { readonly error: Error; readonly ok: false } | { readonly ok: true },
    ) => void = () => undefined;
    const spawnCompletion = new Promise<
      { readonly error: Error; readonly ok: false } | { readonly ok: true }
    >((resolveSpawnOutcome) => {
      resolveSpawn = resolveSpawnOutcome;
    });
    const workloadCompletion = new Promise<
      | { readonly error: Error; readonly type: "error" }
      | { readonly status: number; readonly type: "exit" }
    >((resolveWorkload) => {
      workload.once("spawn", () => resolveSpawn({ ok: true }));
      workload.once("error", (error) => {
        resolveSpawn({ error, ok: false });
        resolveWorkload({ error, type: "error" });
      });
      workload.once("exit", (code, signal) => {
        resolveWorkload({
          status: code ?? signalExitCode(signal),
          type: "exit",
        });
      });
    });
    const spawnOutcome = await spawnCompletion;
    if (!spawnOutcome.ok) throw spawnOutcome.error;
    const spawnedPid = workload.pid;
    if (spawnedPid === undefined) {
      throw new Error("check resource guardian lost the spawned workload pid");
    }
    const ownedWorkloadPid = spawnedPid;
    workloadPid = ownedWorkloadPid;

    if (stopRequested && parentConnected) {
      signalProcess(ownedWorkloadPid, "SIGSTOP", true);
      workloadSuspended = true;
    }
    if (forwardedSignal !== null) {
      resumeWorkload();
      signalProcess(ownedWorkloadPid, forwardedSignal, true);
      armKillTimer();
    }
    if (forceKillRequested) {
      signalProcess(ownedWorkloadPid, "SIGKILL", true);
    }
    await sendGuardianResponse({
      pid: ownedWorkloadPid,
      type: "spawned",
      version: guardianProtocolVersion,
    });

    const workloadOutcome = await workloadCompletion;
    if (workloadOutcome.type === "error") throw workloadOutcome.error;
    await waitForProcessGroupExit(ownedWorkloadPid, start.label);
    workloadPid = null;
    return forwardedSignal === null
      ? workloadOutcome.status
      : signalExitCode(forwardedSignal);
  } catch (error) {
    if (workloadPid !== null) {
      try {
        signalProcess(workloadPid, "SIGCONT", true);
        signalProcess(workloadPid, "SIGKILL", true);
        await waitForProcessGroupExit(workloadPid, "failed guardian cleanup");
      } catch {
        // Preserve the guardian's original failure.
      }
      workloadPid = null;
    }
    throw error;
  } finally {
    if (killTimer !== null) clearTimeout(killTimer);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onHangup);
    process.off("SIGQUIT", onQuit);
    process.off("SIGTSTP", onStop);
    process.off("SIGCONT", onContinue);
    process.off("disconnect", onDisconnect);
    process.off("message", onStartMessage);
  }
}

async function guardianMain(): Promise<void> {
  try {
    const status = await runCheckResourceGuardian();
    await sendGuardianResponse({
      status,
      type: "result",
      version: guardianProtocolVersion,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const reported = await sendGuardianResponse({
      message,
      type: "error",
      version: guardianProtocolVersion,
    });
    if (!reported && process.connected) {
      console.error(`[check-resources] guardian failed: ${message}`);
    }
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}

async function runDirectCheckResourceCommand(
  execution: CheckResourceExecution,
  options: CheckResourceRunnerOptions,
  root: string,
): Promise<number> {
  const useProcessGroup = execution.ownsLease && process.platform !== "win32";
  const spawnDescriptors = duplicateDescriptorsForSpawn(
    execution.inheritedDescriptors,
    3 + execution.inheritedDescriptors.length,
  );
  const stdio: StdioOptions = [
    "inherit",
    "inherit",
    "inherit",
    ...spawnDescriptors,
  ];
  const child = (() => {
    try {
      return spawn(options.program, options.arguments, {
        cwd: root,
        detached: useProcessGroup,
        env: childEnvironment(execution),
        stdio,
      });
    } finally {
      closeAll(spawnDescriptors);
    }
  })();
  const completion = new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolveExit(code ?? signalExitCode(signal));
    });
  });
  const childPid = child.pid;
  if (childPid === undefined) return completion;
  if (execution.ownsLease) {
    try {
      // Nice processes still consume every otherwise-idle core, but yield CPU
      // promptly to editors, agents, and narrow direct test loops.
      setPriority(childPid, localCheckNiceness);
    } catch {
      console.warn(
        `[check-resources] ${options.label} could not lower its CPU priority`,
      );
    }
  }

  let forwardedSignal: NodeJS.Signals | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const forward = (signal: NodeJS.Signals): void => {
    if (forwardedSignal === null) {
      forwardedSignal = signal;
      signalProcess(childPid, signal, useProcessGroup);
      killTimer = setTimeout(() => {
        try {
          signalProcess(childPid, "SIGKILL", useProcessGroup);
        } catch {
          // The original signal still owns the exit result.
        }
      }, terminationGraceMilliseconds);
      killTimer.unref();
      return;
    }
    signalProcess(childPid, "SIGKILL", useProcessGroup);
  };
  const onInterrupt = (): void => forward("SIGINT");
  const onTerminate = (): void => forward("SIGTERM");
  const onHangup = (): void => forward("SIGHUP");
  const onQuit = (): void => forward("SIGQUIT");
  const onStop = (): void => {
    // A detached child is an orphaned process group. POSIX may discard a
    // default-action SIGTSTP for that group, while SIGSTOP is unignorable.
    signalProcess(childPid, "SIGSTOP", useProcessGroup);
    process.kill(process.pid, "SIGSTOP");
  };
  const onContinue = (): void => {
    signalProcess(childPid, "SIGCONT", useProcessGroup);
  };
  if (execution.ownsLease) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    process.on("SIGHUP", onHangup);
    process.on("SIGQUIT", onQuit);
    process.on("SIGTSTP", onStop);
    process.on("SIGCONT", onContinue);
  }
  try {
    const directStatus = await completion;
    if (useProcessGroup) {
      await waitForProcessGroupExit(childPid, options.label);
    }
    return forwardedSignal === null
      ? directStatus
      : signalExitCode(forwardedSignal);
  } finally {
    if (killTimer !== null) clearTimeout(killTimer);
    if (execution.ownsLease) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      process.off("SIGHUP", onHangup);
      process.off("SIGQUIT", onQuit);
      process.off("SIGTSTP", onStop);
      process.off("SIGCONT", onContinue);
    }
  }
}

async function runGuardedCheckResourceCommand(
  execution: CheckResourceExecution,
  options: CheckResourceRunnerOptions,
  root: string,
): Promise<number> {
  const guardianEnvironment = { ...execution.environment };
  delete guardianEnvironment[bindingVariable];
  const spawnDescriptors = duplicateDescriptorsForSpawn(
    execution.inheritedDescriptors,
    guardianLeaseDescriptorOffset + execution.inheritedDescriptors.length,
  );
  const guardianStdio: StdioOptions = [
    "inherit",
    "inherit",
    "inherit",
    "ipc",
    ...spawnDescriptors,
  ];
  const guardian = (() => {
    try {
      return spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), guardianArgument],
        {
          cwd: root,
          detached: true,
          env: guardianEnvironment,
          stdio: guardianStdio,
        },
      );
    } finally {
      closeAll(spawnDescriptors);
    }
  })();
  const guardianPid = guardian.pid;
  const state: {
    closed:
      | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
      | null;
    guardianSpawnError: Error | null;
    ready: boolean;
    responseFailure: Error | null;
    terminal: GuardianResultMessage | GuardianErrorMessage | null;
    workloadPid: number | null;
  } = {
    closed: null,
    guardianSpawnError: null,
    ready: false,
    responseFailure: null,
    terminal: null,
    workloadPid: null,
  };
  let revision = 0;
  let wake: (() => void) | null = null;
  const notifyChanged = (): void => {
    revision += 1;
    const notify = wake;
    wake = null;
    notify?.();
  };
  const waitForChange = (observedRevision: number): Promise<void> => {
    if (revision !== observedRevision) return Promise.resolve();
    return new Promise((resolveChanged) => {
      if (revision !== observedRevision) {
        resolveChanged();
        return;
      }
      wake = resolveChanged;
    });
  };
  const closedPromise = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveClosed) => {
    guardian.once("close", (code, signal) => {
      state.closed = { code, signal };
      resolveClosed(state.closed);
      notifyChanged();
    });
  });
  guardian.once("error", (error) => {
    state.guardianSpawnError = error;
    state.responseFailure = error;
    notifyChanged();
  });
  guardian.on("message", (value: unknown) => {
    try {
      const message = parseGuardianResponseMessage(value);
      if (message.type === "ready") {
        if (state.ready || state.workloadPid !== null || state.terminal !== null) {
          throw new Error("check resource guardian repeated its ready handshake");
        }
        state.ready = true;
        notifyChanged();
        return;
      }
      if (message.type === "spawned") {
        if (
          !state.ready
          || state.workloadPid !== null
          || state.terminal !== null
        ) {
          throw new Error("check resource guardian sent an out-of-order spawn handshake");
        }
        state.workloadPid = message.pid;
        return;
      }
      if (!state.ready || state.terminal !== null) {
        throw new Error("check resource guardian sent an out-of-order result");
      }
      state.terminal = message;
      notifyChanged();
    } catch (error: unknown) {
      state.responseFailure = error instanceof Error ? error : new Error(String(error));
      notifyChanged();
    }
  });

  if (guardianPid === undefined) {
    await closedPromise;
    throw state.guardianSpawnError
      ?? new Error("check resource guardian did not publish a pid");
  }

  let handlersInstalled = false;
  const leaseJobControl = ownedLeaseJobControls.get(execution);
  const forward = (signal: NodeJS.Signals): void => {
    signalProcess(guardianPid, signal, false);
  };
  leaseJobControl?.setStopTarget((signal) => forward(signal));
  const onInterrupt = (): void => forward("SIGINT");
  const onTerminate = (): void => forward("SIGTERM");
  const onHangup = (): void => forward("SIGHUP");
  const onQuit = (): void => forward("SIGQUIT");
  const onStop = (): void => {
    forward("SIGTSTP");
    process.kill(process.pid, "SIGSTOP");
  };
  const onContinue = (): void => forward("SIGCONT");
  const installHandlers = (): void => {
    if (handlersInstalled) return;
    handlersInstalled = true;
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    process.on("SIGHUP", onHangup);
    process.on("SIGQUIT", onQuit);
    if (leaseJobControl === undefined) {
      process.on("SIGTSTP", onStop);
      process.on("SIGCONT", onContinue);
    }
  };
  const removeHandlers = (): void => {
    if (!handlersInstalled) return;
    handlersInstalled = false;
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onHangup);
    process.off("SIGQUIT", onQuit);
    if (leaseJobControl === undefined) {
      process.off("SIGTSTP", onStop);
      process.off("SIGCONT", onContinue);
    }
  };
  const failClosed = async (): Promise<void> => {
    if (state.closed === null) {
      try {
        signalProcess(guardianPid, "SIGCONT", false);
        signalProcess(guardianPid, "SIGTERM", false);
      } catch {
        // The guardian close event below remains authoritative.
      }
      if (guardian.connected) {
        try {
          guardian.disconnect();
        } catch {
          // A concurrent guardian exit may close IPC first.
        }
      }
      await closedPromise;
    }
    const workloadPid = state.workloadPid;
    if (workloadPid !== null && processGroupExists(workloadPid)) {
      signalProcess(workloadPid, "SIGCONT", true);
      signalProcess(workloadPid, "SIGKILL", true);
      await waitForProcessGroupExit(
        workloadPid,
        `${options.label} guardian failure cleanup`,
      );
    }
  };

  try {
    let observedRevision = revision;
    while (!state.ready && state.responseFailure === null && state.closed === null) {
      await waitForChange(observedRevision);
      observedRevision = revision;
    }
    if (state.responseFailure !== null) throw state.responseFailure;
    if (!state.ready) {
      throw state.guardianSpawnError
        ?? new Error(
          `check resource guardian exited before its ready handshake`
          + ` (${state.closed?.code ?? state.closed?.signal ?? "unknown"})`,
        );
    }
    installHandlers();
    const startMessage: GuardianStartMessage = {
      arguments: [...options.arguments],
      descriptorCount: execution.inheritedDescriptors.length,
      environment: serializableEnvironment(childEnvironment(execution)),
      label: options.label,
      program: options.program,
      root,
      type: "start",
      version: guardianProtocolVersion,
    };
    await new Promise<void>((resolveSend, rejectSend) => {
      try {
        guardian.send(startMessage, (error) => {
          if (error == null) {
            resolveSend();
          } else {
            rejectSend(error);
          }
        });
      } catch (error: unknown) {
        rejectSend(error instanceof Error ? error : new Error(String(error)));
      }
    });

    observedRevision = revision;
    while (
      state.terminal === null
      && state.responseFailure === null
      && state.closed === null
    ) {
      await waitForChange(observedRevision);
      observedRevision = revision;
    }
    const responseFailure = state.responseFailure;
    if (responseFailure !== null) {
      throw new Error("check resource guardian protocol failed", {
        cause: responseFailure,
      });
    }
    if (state.terminal === null) {
      throw state.guardianSpawnError
        ?? new Error(
          `check resource guardian exited before reporting a result`
          + ` (${state.closed?.code ?? state.closed?.signal ?? "unknown"})`,
        );
    }
    const terminal = state.terminal;
    const finalClose = await closedPromise;
    if (terminal.type === "error") throw new Error(terminal.message);
    if (finalClose.code !== 0 || finalClose.signal !== null) {
      throw new Error(
        `check resource guardian exited unexpectedly`
        + ` (${finalClose.code ?? finalClose.signal ?? "unknown"})`,
      );
    }
    return terminal.status;
  } catch (error) {
    await failClosed();
    throw error;
  } finally {
    removeHandlers();
    leaseJobControl?.setStopTarget(null);
  }
}

export async function runCheckResourceCommand(
  execution: CheckResourceExecution,
  options: CheckResourceRunnerOptions,
  root: string,
): Promise<number> {
  return execution.ownsLease && process.platform !== "win32"
    ? runGuardedCheckResourceCommand(execution, options, root)
    : runDirectCheckResourceCommand(execution, options, root);
}

export function parseCheckResourceRunnerArguments(
  arguments_: readonly string[],
): ParsedRunnerArguments {
  let mode: CheckResourceMode | undefined;
  let label: string | undefined;
  const delimiter = arguments_.indexOf("--");
  if (delimiter < 0) throw new Error("check resource command requires -- before its command");
  for (const argument of arguments_.slice(0, delimiter)) {
    if (argument.startsWith("--mode=")) {
      if (mode !== undefined) throw new Error("--mode may be provided only once");
      const value = argument.slice("--mode=".length);
      if (value !== "exclusive" && value !== "heavy" && value !== "shared") {
        throw new Error(`invalid check resource mode ${JSON.stringify(value)}`);
      }
      mode = value;
      continue;
    }
    if (argument.startsWith("--label=")) {
      if (label !== undefined) throw new Error("--label may be provided only once");
      label = checkedLabel(argument.slice("--label=".length));
      continue;
    }
    throw new Error(`unknown check resource argument ${JSON.stringify(argument)}`);
  }
  const command = arguments_.slice(delimiter + 1);
  const program = command[0];
  if (program === undefined || program.length === 0 || controlCharacter(program)) {
    throw new Error("check resource command requires a program");
  }
  if (mode === undefined) throw new Error("--mode is required");
  return {
    command: [program, ...command.slice(1)],
    label: label ?? program,
    mode,
  };
}

function usage(): string {
  return [
    "Usage: bun run scripts/check-resource-scheduler.ts",
    "  --mode=shared|heavy|exclusive [--label=LABEL] -- COMMAND [ARGUMENT ...]",
  ].join("\n");
}

async function main(): Promise<void> {
  if (
    process.argv.length === 3
    && process.argv[2] === guardianArgument
  ) {
    await guardianMain();
    return;
  }
  let parsed: ParsedRunnerArguments;
  try {
    parsed = parseCheckResourceRunnerArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const root = resolve(process.cwd());
  const [program, ...arguments_] = parsed.command;
  const resolvedProgram = program === "bun" ? process.execPath : program;
  try {
    process.exitCode = await withCheckResources(
      { label: parsed.label, mode: parsed.mode, root },
      (execution) => runCheckResourceCommand(
        execution,
        {
          arguments: arguments_,
          label: parsed.label,
          program: resolvedProgram,
        },
        root,
      ),
    );
  } catch (error) {
    console.error(
      `[check-resources] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
