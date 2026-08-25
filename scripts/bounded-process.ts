import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dlopen } from "bun:ffi";
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
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { userInfo } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

import { assertSafeDarwinInstallAcl } from "../src/install-normalizer";
import {
  openAuthoritySupervisorArtifact,
  type OpenAuthoritySupervisorArtifact,
  type ResolvedAuthoritySupervisorArtifact,
} from "./authority-supervisor-artifact";

export type BoundedProcessContainment = "authority" | "local";

export type BoundedProcessRequest = Readonly<{
  arguments: readonly string[];
  containment: BoundedProcessContainment;
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  executable: string;
  killSettlementMs?: number;
  outputMaximumBytes: number;
  phase: string;
  stdin?: string;
  terminationGraceMs: number;
  timeoutMs: number;
}>;

export type CompletedBoundedProcessResult = Readonly<{
  cleanup: "proven";
  exitCode: number;
  stderr: Buffer;
  stdout: Buffer;
}>;

/**
 * A cleanup identity is deliberately tagged. A local process group is useful
 * only for the legacy local runner; it is never evidence about an authority
 * helper or its namespace. Authority recovery must use both Linux process
 * identities plus the boot identity recorded before GO.
 */
export type BoundedProcessRecoveryIdentity =
  | Readonly<{
    containment: "local";
    processGroupId: number;
  }>
  | Readonly<{
    bootId: string;
    containment: "authority";
    namespaceInit: Readonly<{
      pid: number;
      pidNamespaceInode: string;
      startTime: string;
    }>;
    outer: Readonly<{
      pid: number;
      startTime: string;
    }>;
  }>;

export type BoundedProcessCleanupProcess = Readonly<{
  phase: string;
  recoveryIdentity: BoundedProcessRecoveryIdentity;
}>;

type LocalBoundedProcessUnprovenResult = Readonly<{
  cleanup: "unproven";
  phase: string;
  processGroupId: number;
  recoveryIdentity: Extract<BoundedProcessRecoveryIdentity, { containment: "local" }>;
  recoveryPath: string;
  stderr: Buffer;
  stdout: Buffer;
}>;

type AuthorityBoundedProcessUnprovenResult = Readonly<{
  cleanup: "unproven";
  phase: string;
  recoveryIdentity: Extract<BoundedProcessRecoveryIdentity, { containment: "authority" }>;
  recoveryPath: string;
  stderr: Buffer;
  stdout: Buffer;
}>;

export type BoundedProcessResult =
  | CompletedBoundedProcessResult
  | LocalBoundedProcessUnprovenResult
  | AuthorityBoundedProcessUnprovenResult;

const localRecoveryIdentity = (processGroupId: number): Extract<
  BoundedProcessRecoveryIdentity,
  { containment: "local" }
> => ({ containment: "local", processGroupId });

const recoveryIdentityKey = (identity: BoundedProcessRecoveryIdentity): string => (
  identity.containment === "local"
    ? `local:${String(identity.processGroupId)}`
    : [
      "authority",
      identity.bootId,
      String(identity.outer.pid),
      identity.outer.startTime,
      String(identity.namespaceInit.pid),
      identity.namespaceInit.startTime,
      identity.namespaceInit.pidNamespaceInode,
    ].join(":")
);

const safeUnsignedDecimal = (value: string): boolean => {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) return false;
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
};

export class BoundedProcessCleanupUnprovenError extends Error {
  readonly #processes: BoundedProcessCleanupProcess[];
  readonly #recoveryPaths = new Set<string>();
  readonly #diagnostics = new Map<string, string>();

  constructor(
    recoveryIdentity: BoundedProcessRecoveryIdentity | number,
    readonly phase: string,
  ) {
    const identity = typeof recoveryIdentity === "number"
      ? localRecoveryIdentity(recoveryIdentity)
      : recoveryIdentity;
    if (
      !/^[a-z][a-z0-9._-]{0,63}$/u.test(phase)
      || identity.containment === "local"
        && (!Number.isSafeInteger(identity.processGroupId) || identity.processGroupId <= 1)
      || identity.containment === "authority"
        && (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(identity.bootId)
          || !Number.isSafeInteger(identity.outer.pid)
          || identity.outer.pid <= 1
          || !safeUnsignedDecimal(identity.outer.startTime)
          || !Number.isSafeInteger(identity.namespaceInit.pid)
          || identity.namespaceInit.pid <= 1
          || !safeUnsignedDecimal(identity.namespaceInit.startTime)
          || !safeUnsignedDecimal(identity.namespaceInit.pidNamespaceInode)
        )
    ) throw new Error("bounded_process_recovery_identity_invalid");
    super(`bounded_process_cleanup_unproven:${phase}:${recoveryIdentityKey(identity)}`);
    this.name = "BoundedProcessCleanupUnprovenError";
    this.#processes = [{ phase, recoveryIdentity: identity }];
  }

  /**
   * Kept only for older operator renderers. It is undefined for authority
   * failures so an authority PID can never be mis-rendered as a process group.
   */
  get processGroupId(): number | undefined {
    const first = this.#processes[0]?.recoveryIdentity;
    return first?.containment === "local" ? first.processGroupId : undefined;
  }

  get processes(): readonly BoundedProcessCleanupProcess[] {
    return [...this.#processes].sort((left, right) => (
      left.phase.localeCompare(right.phase)
      || recoveryIdentityKey(left.recoveryIdentity).localeCompare(
        recoveryIdentityKey(right.recoveryIdentity),
      )
    ));
  }

  get recoveryPaths(): readonly string[] {
    return [...this.#recoveryPaths].sort();
  }

  get diagnostics(): Readonly<Record<string, string>> {
    return Object.fromEntries([...this.#diagnostics].sort(([left], [right]) => (
      left.localeCompare(right)
    )));
  }

  annotateDiagnostic(name: string, value: string): this {
    if (
      /^[a-z][A-Za-z0-9]{0,63}$/u.test(name)
      && /^[a-z][a-z0-9._-]{0,63}$/u.test(value)
      && !this.#diagnostics.has(name)
    ) this.#diagnostics.set(name, value);
    return this;
  }

  include(error: BoundedProcessCleanupUnprovenError): this {
    for (const process of error.processes) {
      if (!this.#processes.some((candidate) => (
        candidate.phase === process.phase
        && recoveryIdentityKey(candidate.recoveryIdentity)
          === recoveryIdentityKey(process.recoveryIdentity)
      ))) this.#processes.push(process);
    }
    for (const path of error.recoveryPaths) this.#recoveryPaths.add(path);
    for (const [name, value] of Object.entries(error.diagnostics)) {
      if (!this.#diagnostics.has(name)) this.#diagnostics.set(name, value);
    }
    return this;
  }

  retainRecoveryPath(path: string): this {
    if (path.length > 0) this.#recoveryPaths.add(path);
    return this;
  }
}

export class BoundedProcessRecoveryJournalError extends Error {
  readonly recoveryPaths: readonly string[];

  constructor(
    recoveryPaths: readonly string[],
    readonly reason: string,
  ) {
    super(`bounded_process_recovery_journal_blocked:${reason}`);
    this.name = "BoundedProcessRecoveryJournalError";
    this.recoveryPaths = [...new Set(recoveryPaths.filter((path) => path.length > 0))].sort();
  }

  withRecoveryPaths(recoveryPaths: Iterable<string>): BoundedProcessRecoveryJournalError {
    const merged = new Set(this.recoveryPaths);
    for (const path of recoveryPaths) {
      if (path.length > 0) merged.add(path);
    }
    if (
      merged.size === this.recoveryPaths.length
      && this.recoveryPaths.every((path) => merged.has(path))
    ) return this;
    return new BoundedProcessRecoveryJournalError([...merged], this.reason);
  }
}

export type BoundedProcessContainmentUnavailableReason =
  | "authority_backend_unavailable"
  | "authority_unsupported_platform";

/**
 * Provider-facing subprocesses never silently degrade to process-group
 * cleanup. A caller must either receive a kernel-backed authority boundary or
 * stop before the target is spawned.
 */
export class BoundedProcessContainmentUnavailableError extends Error {
  constructor(
    readonly reason: BoundedProcessContainmentUnavailableReason,
  ) {
    super(`authority_containment_unavailable:${reason}`);
    this.name = "BoundedProcessContainmentUnavailableError";
  }
}

export const isBoundedProcessContainmentUnavailableError = (
  error: unknown,
): error is BoundedProcessContainmentUnavailableError =>
  error instanceof BoundedProcessContainmentUnavailableError;

export const isBoundedProcessRecoveryJournalError = (
  error: unknown,
): error is BoundedProcessRecoveryJournalError =>
  error instanceof BoundedProcessRecoveryJournalError;

export const isBoundedProcessCleanupUnprovenError = (
  error: unknown,
): error is BoundedProcessCleanupUnprovenError =>
  error instanceof BoundedProcessCleanupUnprovenError;

export const retainBoundedProcessRecoveryPath = (error: unknown, path: string): unknown => {
  if (isBoundedProcessCleanupUnprovenError(error)) {
    error.retainRecoveryPath(path);
    return error;
  }
  if (isBoundedProcessRecoveryJournalError(error)) {
    return error.withRecoveryPaths([path]);
  }
  return error;
};

export const rethrowBoundedProcessTerminalError = (error: unknown): void => {
  if (
    isBoundedProcessCleanupUnprovenError(error)
    || isBoundedProcessRecoveryJournalError(error)
  ) throw error;
};

/** @deprecated Use rethrowBoundedProcessTerminalError for the full terminal boundary. */
export const rethrowBoundedProcessCleanupUnproven = rethrowBoundedProcessTerminalError;

/**
 * One guard belongs to one authority-changing CLI invocation. Once cleanup is
 * indeterminate or durable recovery custody blocks, every later provider
 * operation observes the same terminal error. This prevents a sibling branch
 * or catch/retry path from issuing fresh reads or mutations while an old
 * process may live or its ownership cannot be proven.
 */
export class BoundedProcessInvocationGuard {
  #failure: BoundedProcessCleanupUnprovenError | BoundedProcessRecoveryJournalError | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  readonly #recoveryPaths = new Set<string>();

  assertMayProceed(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  retainRecoveryPath(path: string): void {
    if (path.length === 0) return;
    this.#recoveryPaths.add(path);
    if (isBoundedProcessCleanupUnprovenError(this.#failure)) {
      this.#failure.retainRecoveryPath(path);
    } else if (isBoundedProcessRecoveryJournalError(this.#failure)) {
      this.#failure = this.#failure.withRecoveryPaths([path]);
    }
  }

  async observe<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#operationTail;
    let releaseOperation!: () => void;
    this.#operationTail = new Promise<void>((resolvePromise) => {
      releaseOperation = resolvePromise;
    });
    await predecessor;
    try {
      this.assertMayProceed();
      return await operation();
    } catch (error: unknown) {
      if (isBoundedProcessCleanupUnprovenError(error)) {
        for (const path of this.#recoveryPaths) error.retainRecoveryPath(path);
        if (this.#failure === undefined) this.#failure = error;
        else if (isBoundedProcessCleanupUnprovenError(this.#failure)) this.#failure.include(error);
        throw this.#failure;
      }
      if (isBoundedProcessRecoveryJournalError(error)) {
        const observed = error.withRecoveryPaths(this.#recoveryPaths);
        if (this.#failure === undefined) this.#failure = observed;
        else if (isBoundedProcessRecoveryJournalError(this.#failure)) {
          this.#failure = this.#failure.withRecoveryPaths(observed.recoveryPaths);
        }
        throw this.#failure;
      }
      throw error;
    } finally {
      releaseOperation();
    }
  }
}

export async function settleConcurrentOperations<const Values extends readonly unknown[]>(
  operations: { readonly [Key in keyof Values]: Promise<Values[Key]> },
): Promise<Values> {
  const results = await Promise.allSettled(operations);
  let cleanupFailure: BoundedProcessCleanupUnprovenError | undefined;
  let journalFailure: BoundedProcessRecoveryJournalError | undefined;
  for (const result of results) {
    if (result.status === "rejected" && isBoundedProcessCleanupUnprovenError(result.reason)) {
      if (cleanupFailure === undefined) cleanupFailure = result.reason;
      else cleanupFailure.include(result.reason);
    }
    if (
      result.status === "rejected"
      && journalFailure === undefined
      && isBoundedProcessRecoveryJournalError(result.reason)
    ) journalFailure = result.reason;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (journalFailure !== undefined) throw journalFailure;
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map((result) => {
    if (result.status !== "fulfilled") throw new Error("concurrent_operation_unreachable");
    return result.value;
  }) as unknown as Values;
}

export const requireBoundedProcessCleanup = (
  result: BoundedProcessResult,
): CompletedBoundedProcessResult => {
  if (result.cleanup !== "proven") {
    throw new BoundedProcessCleanupUnprovenError(
      result.recoveryIdentity,
      result.phase,
    ).retainRecoveryPath(result.recoveryPath);
  }
  return result;
};

const errnoCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

const sameFileIdentity = (
  left: Readonly<{ dev: number; ino: number }>,
  right: Readonly<{ dev: number; ino: number }>,
): boolean => left.dev === right.dev && left.ino === right.ino;

const processGroupExists = (negativeProcessGroupId: number): boolean => {
  try {
    process.kill(negativeProcessGroupId, 0);
    return true;
  } catch (error: unknown) {
    return errnoCode(error) !== "ESRCH";
  }
};

const hostIdentityPattern = /^[0-9a-f]{64}$/u;
const custodyNameKeyPattern = /^[0-9a-f]{24}$/u;
const darwinGlobalPidVisibilityDomain = "global";

type BoundedProcessCustodyIdentity = Readonly<{
  custodyBootId: string;
  custodyMountNamespaceInode: string;
  custodyPidNamespaceInode: string;
  hostIdentity: string;
}>;

type BoundedProcessCustodyNameIdentity = Readonly<{
  boot: string;
  machine: string;
  mntns: string;
  pidns: string;
}>;

type BoundedProcessCustodyRelationship =
  | "current"
  | "foreign_host"
  | "foreign_mount_namespace"
  | "foreign_pid_namespace"
  | "old_boot";

const readRootOwnedBoundedVirtualFile = (
  path: string,
  maximumBytes: number,
): Buffer | undefined => {
  let descriptor: number | undefined;
  let document = Buffer.alloc(0);
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.uid !== 0
      || metadata.nlink !== 1
      || (metadata.mode & 0o022) !== 0
    ) return undefined;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !sameFileIdentity(metadata, opened)
      || opened.uid !== 0
      || opened.nlink !== 1
      || (opened.mode & 0o022) !== 0
    ) return undefined;
    document = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < document.byteLength) {
      const count = readSync(descriptor, document, offset, document.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset < 1 || offset > maximumBytes) return undefined;
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (
      !sameFileIdentity(opened, afterDescriptor)
      || !sameFileIdentity(opened, afterPath)
      || afterDescriptor.uid !== opened.uid
      || afterDescriptor.nlink !== opened.nlink
      || (afterDescriptor.mode & 0o022) !== 0
      || afterPath.uid !== opened.uid
      || afterPath.nlink !== opened.nlink
      || (afterPath.mode & 0o022) !== 0
    ) return undefined;
    const result = Buffer.from(document.subarray(0, offset));
    return result;
  } catch {
    return undefined;
  } finally {
    document.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const readLinuxMachineId = (): string | undefined => {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    let metadata: Stats;
    try {
      metadata = lstatSync(path);
    } catch (error: unknown) {
      if (errnoCode(error) === "ENOENT") continue;
      return undefined;
    }
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.uid !== 0
      || metadata.nlink !== 1
      || (metadata.mode & 0o022) !== 0
      || metadata.size < 32
      || metadata.size > 64
    ) return undefined;
    let descriptor: number | undefined;
    let document = Buffer.alloc(0);
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor);
      if (
        metadata.dev !== opened.dev
        || metadata.ino !== opened.ino
        || opened.uid !== 0
        || opened.nlink !== 1
        || (opened.mode & 0o022) !== 0
        || opened.size !== metadata.size
      ) return undefined;
      document = readFileSync(descriptor);
      const afterDescriptor = fstatSync(descriptor);
      const afterPath = lstatSync(path);
      if (
        opened.dev !== afterDescriptor.dev
        || opened.ino !== afterDescriptor.ino
        || opened.dev !== afterPath.dev
        || opened.ino !== afterPath.ino
        || afterDescriptor.size !== opened.size
        || afterPath.size !== opened.size
      ) return undefined;
      const value = new TextDecoder("utf-8", { fatal: true }).decode(document);
      const match = /^([0-9a-f]{32})\n?$/u.exec(value);
      return match?.[1] !== undefined && match[1] !== "0".repeat(32)
        ? match[1]
        : undefined;
    } catch {
      return undefined;
    } finally {
      document.fill(0);
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  return undefined;
};

const readDarwinPlatformUuid = (): string | undefined => {
  const result = spawnSync("/usr/sbin/ioreg", [
    "-rd1",
    "-c",
    "IOPlatformExpertDevice",
  ], {
    encoding: "buffer",
    env: {},
    maxBuffer: 32_768,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1_000,
    windowsHide: true,
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  try {
    if (
      result.error !== undefined
      || result.status !== 0
      || result.signal !== null
      || stderr.byteLength !== 0
      || stdout.byteLength < 1
      || stdout.byteLength > 32_768
    ) return undefined;
    const value = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
    const matches = [...value.matchAll(
      /"IOPlatformUUID" = "([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})"/gu,
    )];
    const uuid = matches.length === 1 ? matches[0]?.[1]?.toLowerCase() : undefined;
    return uuid !== undefined && uuid.replaceAll("-", "") !== "0".repeat(32)
      ? uuid
      : undefined;
  } catch {
    return undefined;
  } finally {
    stdout.fill(0);
    stderr.fill(0);
  }
};

const readLinuxBootId = (): string | undefined => {
  const document = readRootOwnedBoundedVirtualFile(
    "/proc/sys/kernel/random/boot_id",
    64,
  );
  if (document === undefined) return undefined;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(document).trim();
    return safeBootId(raw) ? raw : undefined;
  } catch {
    return undefined;
  } finally {
    document.fill(0);
  }
};

const readDarwinBootSessionUuid = (): string | undefined => {
  const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
    encoding: "buffer",
    env: {},
    maxBuffer: 256,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1_000,
    windowsHide: true,
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  try {
    if (
      result.error !== undefined
      || result.status !== 0
      || result.signal !== null
      || stderr.byteLength !== 0
      || stdout.byteLength < 1
      || stdout.byteLength > 256
    ) return undefined;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(stdout).trim().toLowerCase();
    return safeBootId(raw) ? raw : undefined;
  } catch {
    return undefined;
  } finally {
    stdout.fill(0);
    stderr.fill(0);
  }
};

const readCurrentLinuxNamespaceInode = (
  namespace: "mnt" | "pid",
): string | undefined => {
  const path = `/proc/self/ns/${namespace}`;
  try {
    const before = lstatSync(path);
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !before.isSymbolicLink()
      || before.uid !== uid
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o777
    ) return undefined;
    const target = readlinkSync(path, "utf8");
    const after = lstatSync(path);
    if (!sameFileIdentity(before, after) || after.uid !== uid || after.nlink !== 1) {
      return undefined;
    }
    const match = new RegExp(`^${namespace}:\\[([1-9][0-9]{0,19})\\]$`, "u").exec(target);
    const inode = match?.[1];
    return inode !== undefined && safeUnsignedDecimal(inode) ? inode : undefined;
  } catch {
    return undefined;
  }
};

let cachedBoundedProcessHostIdentity: string | undefined;
const boundedProcessHostIdentity = (): string => {
  if (cachedBoundedProcessHostIdentity !== undefined) return cachedBoundedProcessHostIdentity;
  const raw = process.platform === "linux"
    ? readLinuxMachineId()
    : process.platform === "darwin"
      ? readDarwinPlatformUuid()
      : undefined;
  if (raw === undefined) {
    throw new BoundedProcessRecoveryJournalError([], "host_identity_unavailable");
  }
  cachedBoundedProcessHostIdentity = createHash("sha256")
    .update("hra-bounded-process-host-v1\0", "utf8")
    .update(process.platform, "utf8")
    .update("\0", "utf8")
    .update(raw, "utf8")
    .digest("hex");
  return cachedBoundedProcessHostIdentity;
};

export const boundedProcessHostIdentityForTesting = (): string =>
  boundedProcessHostIdentity();

let cachedBoundedProcessCustodyIdentity: BoundedProcessCustodyIdentity | undefined;
const boundedProcessCustodyIdentity = (): BoundedProcessCustodyIdentity => {
  if (cachedBoundedProcessCustodyIdentity !== undefined) {
    return cachedBoundedProcessCustodyIdentity;
  }
  const custodyBootId = process.platform === "linux"
    ? readLinuxBootId()
    : process.platform === "darwin"
      ? readDarwinBootSessionUuid()
      : undefined;
  const custodyMountNamespaceInode = process.platform === "linux"
    ? readCurrentLinuxNamespaceInode("mnt")
    : process.platform === "darwin"
      ? darwinGlobalPidVisibilityDomain
      : undefined;
  const custodyPidNamespaceInode = process.platform === "linux"
    ? readCurrentLinuxNamespaceInode("pid")
    : process.platform === "darwin"
      ? darwinGlobalPidVisibilityDomain
      : undefined;
  if (
    custodyBootId === undefined
    || custodyMountNamespaceInode === undefined
    || custodyPidNamespaceInode === undefined
  ) {
    throw new BoundedProcessRecoveryJournalError([], "custody_identity_unavailable");
  }
  cachedBoundedProcessCustodyIdentity = {
    custodyBootId,
    custodyMountNamespaceInode,
    custodyPidNamespaceInode,
    hostIdentity: boundedProcessHostIdentity(),
  };
  return cachedBoundedProcessCustodyIdentity;
};

const custodyNameKey = (
  domain: "boot" | "machine" | "mntns" | "pidns",
  value: string,
): string =>
  createHash("sha256")
    .update("hra-bounded-process-custody-name-v1\0", "utf8")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 24);

const boundedProcessCustodyNameIdentity = (
  identity: BoundedProcessCustodyIdentity,
): BoundedProcessCustodyNameIdentity => ({
  boot: custodyNameKey("boot", identity.custodyBootId),
  machine: custodyNameKey("machine", identity.hostIdentity),
  mntns: custodyNameKey("mntns", identity.custodyMountNamespaceInode),
  pidns: custodyNameKey("pidns", identity.custodyPidNamespaceInode),
});

const boundedProcessCustodyNamePrefix = (
  identity: BoundedProcessCustodyIdentity,
): string => {
  const nameIdentity = boundedProcessCustodyNameIdentity(identity);
  return [
    nameIdentity.machine,
    nameIdentity.boot,
    nameIdentity.pidns,
    nameIdentity.mntns,
  ].join("-");
};

const custodyNamePrefixFromNameIdentity = (
  identity: BoundedProcessCustodyNameIdentity,
): string => [identity.machine, identity.boot, identity.pidns, identity.mntns].join("-");

const boundedProcessCustodyRelationship = (
  recorded: BoundedProcessCustodyIdentity,
  current = boundedProcessCustodyIdentity(),
): BoundedProcessCustodyRelationship => {
  if (recorded.hostIdentity !== current.hostIdentity) return "foreign_host";
  if (recorded.custodyPidNamespaceInode !== current.custodyPidNamespaceInode) {
    return "foreign_pid_namespace";
  }
  if (recorded.custodyMountNamespaceInode !== current.custodyMountNamespaceInode) {
    return "foreign_mount_namespace";
  }
  return recorded.custodyBootId === current.custodyBootId ? "current" : "old_boot";
};

const boundedProcessCustodyNameRelationship = (
  recorded: BoundedProcessCustodyNameIdentity,
  current = boundedProcessCustodyNameIdentity(boundedProcessCustodyIdentity()),
): BoundedProcessCustodyRelationship => {
  if (recorded.machine !== current.machine) return "foreign_host";
  if (recorded.pidns !== current.pidns) return "foreign_pid_namespace";
  if (recorded.mntns !== current.mntns) return "foreign_mount_namespace";
  return recorded.boot === current.boot ? "current" : "old_boot";
};

export const boundedProcessCustodyIdentityForTesting = (): BoundedProcessCustodyIdentity
  & BoundedProcessCustodyNameIdentity => {
  const identity = boundedProcessCustodyIdentity();
  return { ...identity, ...boundedProcessCustodyNameIdentity(identity) };
};

export const boundedProcessCustodyNameIdentityForTesting = (
  identity: BoundedProcessCustodyIdentity,
): BoundedProcessCustodyNameIdentity => boundedProcessCustodyNameIdentity(identity);

export const boundedProcessCustodyRelationshipForTesting = (
  recorded: BoundedProcessCustodyIdentity,
  current: BoundedProcessCustodyIdentity,
): BoundedProcessCustodyRelationship => boundedProcessCustodyRelationship(recorded, current);

const phasePattern = /^[a-z][a-z0-9._-]{0,63}$/u;
const pendingJournalNamePattern =
  /^process-(?<machine>[0-9a-f]{24})-(?<boot>[0-9a-f]{24})-(?<pidns>[0-9a-f]{24})-(?<mntns>[0-9a-f]{24})-(?<token>[0-9a-f]{32})\.pending\.json$/u;
const pendingJournalCreationNamePattern =
  /^process-(?<machine>[0-9a-f]{24})-(?<boot>[0-9a-f]{24})-(?<pidns>[0-9a-f]{24})-(?<mntns>[0-9a-f]{24})-(?<token>[0-9a-f]{32})\.pending\.json\.create-(?<artifact>[0-9a-f]{32})$/u;
const activeJournalNamePattern =
  /^process-(?<machine>[0-9a-f]{24})-(?<boot>[0-9a-f]{24})-(?<pidns>[0-9a-f]{24})-(?<mntns>[0-9a-f]{24})-(?<token>[0-9a-f]{32})\.active-(?<pgid>[1-9][0-9]*)\.json$/u;
const journalPromotionNamePattern =
  /^process-(?<machine>[0-9a-f]{24})-(?<boot>[0-9a-f]{24})-(?<pidns>[0-9a-f]{24})-(?<mntns>[0-9a-f]{24})-(?<token>[0-9a-f]{32})\.active-(?<pgid>[1-9][0-9]*)\.json\.promote-(?<promotion>[0-9a-f]{32})$/u;
const journalPromotionCreationNamePattern =
  /^process-(?<machine>[0-9a-f]{24})-(?<boot>[0-9a-f]{24})-(?<pidns>[0-9a-f]{24})-(?<mntns>[0-9a-f]{24})-(?<token>[0-9a-f]{32})\.active-(?<pgid>[1-9][0-9]*)\.json\.promote-(?<promotion>[0-9a-f]{32})\.create-(?<artifact>[0-9a-f]{32})$/u;
const journalMaximumBytes = 1_024;

type PendingProcessRecoveryJournal = Readonly<{
  createdAt: number;
  custodyBootId: string;
  custodyMountNamespaceInode: string;
  custodyPidNamespaceInode: string;
  hostIdentity: string;
  phase: string;
  state: "pending";
  schemaVersion: 2;
}>;

type ActiveProcessRecoveryJournal = Readonly<{
  createdAt: number;
  custodyBootId: string;
  custodyMountNamespaceInode: string;
  custodyPidNamespaceInode: string;
  hostIdentity: string;
  phase: string;
  processGroupId: number;
  state: "active";
  schemaVersion: 2;
}>;

type ProcessRecoveryJournal =
  | ActiveProcessRecoveryJournal
  | PendingProcessRecoveryJournal;

const authorityJournalNamePattern =
  /^authority-(?<machine>[0-9a-f]{24})-(?<boot>[0-9a-f]{24})-(?<pidns>[0-9a-f]{24})-(?<mntns>[0-9a-f]{24})-(?<token>[0-9a-f]{32})\.json$/u;
const authorityJournalCreationNamePattern =
  /^authority-(?<machine>[0-9a-f]{24})-(?<boot>[0-9a-f]{24})-(?<pidns>[0-9a-f]{24})-(?<mntns>[0-9a-f]{24})-(?<token>[0-9a-f]{32})\.json\.create-(?<artifact>[0-9a-f]{32})$/u;
const authorityJournalReplacementNamePattern =
  /^authority-(?<machine>[0-9a-f]{24})-(?<boot>[0-9a-f]{24})-(?<pidns>[0-9a-f]{24})-(?<mntns>[0-9a-f]{24})-(?<token>[0-9a-f]{32})\.json\.replace-(?<replacement>[0-9a-f]{32})$/u;
const authorityJournalReplacementCreationNamePattern =
  /^authority-(?<machine>[0-9a-f]{24})-(?<boot>[0-9a-f]{24})-(?<pidns>[0-9a-f]{24})-(?<mntns>[0-9a-f]{24})-(?<token>[0-9a-f]{32})\.json\.replace-(?<replacement>[0-9a-f]{32})\.create-(?<artifact>[0-9a-f]{32})$/u;
const authorityControlSocketNamePattern = /^\.authority-control-([0-9a-f]{32})\.sock$/u;
const authorityJournalMaximumBytes = 2_048;

const custodyNameIdentityFromMatch = (
  match: RegExpExecArray | null,
): BoundedProcessCustodyNameIdentity | undefined => {
  const boot = match?.groups?.boot;
  const machine = match?.groups?.machine;
  const mntns = match?.groups?.mntns;
  const pidns = match?.groups?.pidns;
  return boot !== undefined
    && machine !== undefined
    && mntns !== undefined
    && pidns !== undefined
    && custodyNameKeyPattern.test(boot)
    && custodyNameKeyPattern.test(machine)
    && custodyNameKeyPattern.test(mntns)
    && custodyNameKeyPattern.test(pidns)
    ? { boot, machine, mntns, pidns }
    : undefined;
};

const processJournalNameCustodyIdentity = (
  name: string,
): BoundedProcessCustodyNameIdentity | undefined => custodyNameIdentityFromMatch(
  pendingJournalNamePattern.exec(name)
  ?? pendingJournalCreationNamePattern.exec(name)
  ?? activeJournalNamePattern.exec(name)
  ?? journalPromotionNamePattern.exec(name)
  ?? journalPromotionCreationNamePattern.exec(name),
);

const authorityJournalNameCustodyIdentity = (
  name: string,
): BoundedProcessCustodyNameIdentity | undefined => custodyNameIdentityFromMatch(
  authorityJournalNamePattern.exec(name)
  ?? authorityJournalCreationNamePattern.exec(name)
  ?? authorityJournalReplacementNamePattern.exec(name)
  ?? authorityJournalReplacementCreationNamePattern.exec(name),
);

const custodyIdentityFromUnknown = (
  value: unknown,
): BoundedProcessCustodyIdentity | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.hostIdentity === "string"
    && hostIdentityPattern.test(record.hostIdentity)
    && safeBootId(record.custodyBootId)
    && typeof record.custodyMountNamespaceInode === "string"
    && (
      record.custodyMountNamespaceInode === darwinGlobalPidVisibilityDomain
      || safeUnsignedDecimal(record.custodyMountNamespaceInode)
    )
    && typeof record.custodyPidNamespaceInode === "string"
    && (
      record.custodyPidNamespaceInode === darwinGlobalPidVisibilityDomain
      || safeUnsignedDecimal(record.custodyPidNamespaceInode)
    )
    ? {
      custodyBootId: record.custodyBootId,
      custodyMountNamespaceInode: record.custodyMountNamespaceInode,
      custodyPidNamespaceInode: record.custodyPidNamespaceInode,
      hostIdentity: record.hostIdentity,
    }
    : undefined;
};

const throwIfCustodyRelationshipUnsafe = (
  path: string,
  relationship: BoundedProcessCustodyRelationship,
): void => {
  if (relationship === "foreign_host") {
    throw new BoundedProcessRecoveryJournalError([path], "host_identity_mismatch");
  }
  if (relationship === "foreign_pid_namespace") {
    throw new BoundedProcessRecoveryJournalError(
      [path],
      "pid_namespace_identity_mismatch",
    );
  }
  if (relationship === "foreign_mount_namespace") {
    throw new BoundedProcessRecoveryJournalError(
      [path],
      "mount_namespace_identity_mismatch",
    );
  }
};

const assertJournalNameCustodySafe = (
  directory: string,
  names: readonly string[],
  kind: "authority" | "process",
): void => {
  for (const name of names) {
    const identity = kind === "authority"
      ? authorityJournalNameCustodyIdentity(name)
      : processJournalNameCustodyIdentity(name);
    if (identity !== undefined) throwIfCustodyRelationshipUnsafe(
      join(directory, name),
      boundedProcessCustodyNameRelationship(identity),
    );
  }
};

const assertRecoveryEntryNamesRecognized = (
  directory: string,
  names: readonly string[],
): void => {
  for (const name of names) {
    if (
      processJournalNameCustodyIdentity(name) !== undefined
      || authorityJournalNameCustodyIdentity(name) !== undefined
      || authorityControlSocketNamePattern.test(name)
    ) continue;
    const path = join(directory, name);
    if (name.startsWith(".authority-control-")) {
      throw new BoundedProcessRecoveryJournalError([path], "authority_socket_name_invalid");
    }
    throw new BoundedProcessRecoveryJournalError([path], "entry_name_invalid");
  }
};

const preflightJournalDocumentCustodyIdentities = (
  directory: string,
  names: readonly string[],
): void => {
  for (const name of names) {
    const pending = pendingJournalNamePattern.exec(name);
    const pendingCreate = pendingJournalCreationNamePattern.exec(name);
    const active = activeJournalNamePattern.exec(name);
    const promotion = journalPromotionNamePattern.exec(name);
    const promotionCreate = journalPromotionCreationNamePattern.exec(name);
    const authority = authorityJournalNamePattern.exec(name);
    const authorityCreate = authorityJournalCreationNamePattern.exec(name);
    const replacement = authorityJournalReplacementNamePattern.exec(name);
    const replacementCreate = authorityJournalReplacementCreationNamePattern.exec(name);
    const match = pending
      ?? pendingCreate
      ?? active
      ?? promotion
      ?? promotionCreate
      ?? authority
      ?? authorityCreate
      ?? replacement
      ?? replacementCreate;
    if (match === null) continue;
    const expectedIdentity = custodyNameIdentityFromMatch(match);
    const path = join(directory, name);
    if (expectedIdentity === undefined) {
      throw new BoundedProcessRecoveryJournalError([path], "custody_identity_invalid");
    }
    throwIfCustodyRelationshipUnsafe(
      path,
      boundedProcessCustodyNameRelationship(expectedIdentity),
    );
    const allowIncomplete = pending !== null
      || pendingCreate !== null
      || promotion !== null
      || promotionCreate !== null
      || authorityCreate !== null
      || replacement !== null
      || replacementCreate !== null;
    const maximumBytes = authority !== null
      || authorityCreate !== null
      || replacement !== null
      || replacementCreate !== null
      ? authorityJournalMaximumBytes
      : journalMaximumBytes;
    const uid = process.getuid?.();
    const metadata = lstatSync(path);
    const mode = metadata.mode & 0o777;
    if (
      uid === undefined
      || !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.uid !== uid
      || metadata.nlink !== 1 && metadata.nlink !== 2
      || mode & ~0o600
      || metadata.nlink === 2 && mode !== 0o600
      || metadata.size > maximumBytes
    ) throw new BoundedProcessRecoveryJournalError([path], "entry_invalid");
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let document = Buffer.alloc(0);
    try {
      const opened = fstatSync(descriptor);
      if (
        !sameFileIdentity(metadata, opened)
        || opened.uid !== uid
        || opened.nlink !== metadata.nlink
        || (opened.mode & 0o777) !== mode
        || opened.size !== metadata.size
      ) throw new BoundedProcessRecoveryJournalError([path], "entry_changed");
      try {
        assertSafeDarwinInstallAcl(descriptor, uid, path);
      } catch {
        throw new BoundedProcessRecoveryJournalError([path], "entry_acl_invalid");
      }
      document = readFileSync(descriptor);
      const afterDescriptor = fstatSync(descriptor);
      const afterPath = lstatSync(path);
      if (
        !sameFileIdentity(opened, afterDescriptor)
        || !sameFileIdentity(opened, afterPath)
        || afterDescriptor.nlink !== opened.nlink
        || afterDescriptor.size !== opened.size
        || afterPath.nlink !== opened.nlink
        || afterPath.size !== opened.size
      ) throw new BoundedProcessRecoveryJournalError([path], "entry_changed");
      const incomplete = document.byteLength === 0
        || document[document.byteLength - 1] !== 0x0a;
      if (incomplete) {
        if (!allowIncomplete || opened.nlink !== 1) {
          throw new BoundedProcessRecoveryJournalError([path], "entry_invalid");
        }
        continue;
      }
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(document),
      ) as unknown;
      const identity = custodyIdentityFromUnknown(value);
      if (identity === undefined) {
        throw new BoundedProcessRecoveryJournalError([path], "custody_identity_invalid");
      }
      throwIfCustodyRelationshipUnsafe(
        path,
        boundedProcessCustodyRelationship(identity),
      );
      const documentNameIdentity = boundedProcessCustodyNameIdentity(identity);
      if (
        documentNameIdentity.machine !== expectedIdentity.machine
        || documentNameIdentity.boot !== expectedIdentity.boot
        || documentNameIdentity.mntns !== expectedIdentity.mntns
        || documentNameIdentity.pidns !== expectedIdentity.pidns
      ) throw new BoundedProcessRecoveryJournalError(
        [path],
        "custody_identity_mismatch",
      );
    } catch (error: unknown) {
      if (isBoundedProcessRecoveryJournalError(error)) throw error;
      throw new BoundedProcessRecoveryJournalError([path], "entry_invalid");
    } finally {
      document.fill(0);
      closeSync(descriptor);
    }
  }
};

type AuthorityArtifactIdentity = Readonly<{
  architecture: "arm64" | "x64";
  sha256: string;
}>;

type AuthorityJournalCommon = Readonly<{
  architecture: AuthorityArtifactIdentity["architecture"];
  createdAt: number;
  containment: "authority";
  custodyBootId: string;
  custodyMountNamespaceInode: string;
  custodyPidNamespaceInode: string;
  helperSha256: string;
  hostIdentity: string;
  phase: string;
  schemaVersion: 2;
}>;

type AuthorityIntentRecoveryJournal = AuthorityJournalCommon & Readonly<{
  state: "intent";
}>;

type AuthorityIdentityFields = Readonly<{
  bootId: string;
  initHostPid: number;
  initPidNamespaceInode: string;
  initStartTime: string;
  outerPid: number;
  outerStartTime: string;
}>;

type AuthorityPreparedRecoveryJournal = AuthorityJournalCommon & AuthorityIdentityFields & Readonly<{
  state: "prepared";
}>;

type AuthorityArmedRecoveryJournal = AuthorityJournalCommon
  & AuthorityIdentityFields
  & Readonly<{
  state: "armed";
}>;

type AuthorityGoAttemptedRecoveryJournal = AuthorityJournalCommon
  & AuthorityIdentityFields
  & Readonly<{
  state: "go_attempted";
}>;

type AuthorityProcessRecoveryJournal =
  | AuthorityArmedRecoveryJournal
  | AuthorityGoAttemptedRecoveryJournal
  | AuthorityIntentRecoveryJournal
  | AuthorityPreparedRecoveryJournal;

const safeLinuxPid = (value: unknown): value is number =>
  typeof value === "number"
  && Number.isSafeInteger(value)
  && value > 1
  && value <= 2_147_483_647;

const safeAuthorityArchitecture = (value: unknown): value is AuthorityArtifactIdentity["architecture"] =>
  value === "x64" || value === "arm64";

const safeAuthoritySha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

const safeBootId = (value: unknown): value is string =>
  typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);

const authorityJournalNames = (state: AuthorityProcessRecoveryJournal["state"]): readonly string[] => {
  const common = [
    "architecture",
    "containment",
    "createdAt",
    "custodyBootId",
    "custodyMountNamespaceInode",
    "custodyPidNamespaceInode",
    "helperSha256",
    "hostIdentity",
    "phase",
    "schemaVersion",
    "state",
  ];
  if (state === "intent") return common;
  const prepared = ["bootId", "outerPid", "outerStartTime", ...common];
  return [
    "initHostPid",
    "initPidNamespaceInode",
    "initStartTime",
    ...prepared,
  ].sort();
};

// Keep these checks at the opaque journal boundary even though the parsed
// TypeScript union carries literal types. A bad cast or a future parser change
// must not let a structurally similar record bypass its containment contract.
const hasAuthorityJournalEnvelope = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Readonly<{
    containment?: unknown;
    schemaVersion?: unknown;
  }>;
  return candidate.containment === "authority" && candidate.schemaVersion === 2;
};

const authorityJournalEnvelopesMatch = (left: unknown, right: unknown): boolean =>
  hasAuthorityJournalEnvelope(left) && hasAuthorityJournalEnvelope(right);

const sameAuthorityJournal = (
  left: AuthorityProcessRecoveryJournal,
  right: AuthorityProcessRecoveryJournal,
): boolean => {
  if (
    !authorityJournalEnvelopesMatch(left, right)
    || left.architecture !== right.architecture
    || left.createdAt !== right.createdAt
    || left.custodyBootId !== right.custodyBootId
    || left.custodyMountNamespaceInode !== right.custodyMountNamespaceInode
    || left.custodyPidNamespaceInode !== right.custodyPidNamespaceInode
    || left.helperSha256 !== right.helperSha256
    || left.hostIdentity !== right.hostIdentity
    || left.phase !== right.phase
    || left.state !== right.state
  ) return false;
  if (left.state === "intent" || right.state === "intent") return left.state === right.state;
  if (
    left.bootId !== right.bootId
    || left.outerPid !== right.outerPid
    || left.outerStartTime !== right.outerStartTime
  ) return false;
  return left.initHostPid === right.initHostPid
    && left.initPidNamespaceInode === right.initPidNamespaceInode
    && left.initStartTime === right.initStartTime;
};

const authorityJournalCommonMatches = (
  left: AuthorityProcessRecoveryJournal,
  right: AuthorityProcessRecoveryJournal,
): boolean => authorityJournalEnvelopesMatch(left, right)
  && left.architecture === right.architecture
  && left.createdAt === right.createdAt
  && left.custodyBootId === right.custodyBootId
  && left.custodyMountNamespaceInode === right.custodyMountNamespaceInode
  && left.custodyPidNamespaceInode === right.custodyPidNamespaceInode
  && left.helperSha256 === right.helperSha256
  && left.hostIdentity === right.hostIdentity
  && left.phase === right.phase;

const validAuthorityJournalTransition = (
  current: AuthorityProcessRecoveryJournal,
  next: AuthorityProcessRecoveryJournal,
): boolean => {
  if (!authorityJournalCommonMatches(current, next)) return false;
  if (current.state === "intent" && next.state === "prepared") {
    return next.bootId === current.custodyBootId;
  }
  if (current.state === "prepared" && next.state === "armed") {
    return current.bootId === next.bootId
      && current.outerPid === next.outerPid
      && current.outerStartTime === next.outerStartTime
      && current.initHostPid === next.initHostPid
      && current.initStartTime === next.initStartTime
      && current.initPidNamespaceInode === next.initPidNamespaceInode;
  }
  if (current.state === "armed" && next.state === "go_attempted") {
    return current.bootId === next.bootId
      && current.outerPid === next.outerPid
      && current.outerStartTime === next.outerStartTime
      && current.initHostPid === next.initHostPid
      && current.initStartTime === next.initStartTime
      && current.initPidNamespaceInode === next.initPidNamespaceInode;
  }
  return false;
};

const isAuthorityArmedRecoveryJournal = (
  value: AuthorityProcessRecoveryJournal,
): value is AuthorityArmedRecoveryJournal => value.state === "armed";

const parseAuthorityRecoveryJournalValue = (value: unknown): AuthorityProcessRecoveryJournal => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoundedProcessRecoveryJournalError([], "authority_entry_invalid");
  }
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (
    (state !== "intent" && state !== "prepared" && state !== "armed" && state !== "go_attempted")
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(authorityJournalNames(state))
    || record.schemaVersion !== 2
    || record.containment !== "authority"
    || typeof record.createdAt !== "number"
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0
    || typeof record.phase !== "string"
    || !phasePattern.test(record.phase)
    || !safeAuthorityArchitecture(record.architecture)
    || !safeAuthoritySha256(record.helperSha256)
    || typeof record.hostIdentity !== "string"
    || !hostIdentityPattern.test(record.hostIdentity)
    || custodyIdentityFromUnknown(record) === undefined
  ) throw new BoundedProcessRecoveryJournalError([], "authority_entry_invalid");
  if (state === "intent") return record as AuthorityIntentRecoveryJournal;
  if (
    !safeBootId(record.bootId)
    || record.bootId !== record.custodyBootId
    || !safeLinuxPid(record.outerPid)
    || typeof record.outerStartTime !== "string"
    || !safeUnsignedDecimal(record.outerStartTime)
  ) throw new BoundedProcessRecoveryJournalError([], "authority_entry_invalid");
  if (
    !safeLinuxPid(record.initHostPid)
    || typeof record.initStartTime !== "string"
    || !safeUnsignedDecimal(record.initStartTime)
    || typeof record.initPidNamespaceInode !== "string"
    || !safeUnsignedDecimal(record.initPidNamespaceInode)
  ) throw new BoundedProcessRecoveryJournalError([], "authority_entry_invalid");
  return record as AuthorityPreparedRecoveryJournal
    | AuthorityArmedRecoveryJournal
    | AuthorityGoAttemptedRecoveryJournal;
};

const parseAuthorityRecoveryJournal = (path: string): AuthorityProcessRecoveryJournal => {
  const uid = process.getuid?.();
  const metadata = lstatSync(path);
  if (
    uid === undefined
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size < 1
    || metadata.size > authorityJournalMaximumBytes
  ) throw new BoundedProcessRecoveryJournalError([path], "authority_entry_invalid");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let document: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.uid !== metadata.uid
      || opened.nlink !== 1
      || (opened.mode & 0o777) !== 0o600
      || opened.size !== metadata.size
    ) throw new BoundedProcessRecoveryJournalError([path], "authority_entry_changed");
    try {
      assertSafeDarwinInstallAcl(descriptor, uid, path);
    } catch {
      throw new BoundedProcessRecoveryJournalError([path], "authority_entry_acl_invalid");
    }
    document = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (
      afterDescriptor.dev !== opened.dev
      || afterDescriptor.ino !== opened.ino
      || afterDescriptor.uid !== opened.uid
      || afterDescriptor.nlink !== 1
      || (afterDescriptor.mode & 0o777) !== 0o600
      || afterDescriptor.size !== opened.size
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
      || afterPath.uid !== opened.uid
      || afterPath.nlink !== 1
      || (afterPath.mode & 0o777) !== 0o600
      || afterPath.size !== opened.size
    ) throw new BoundedProcessRecoveryJournalError([path], "authority_entry_changed");
  } finally {
    closeSync(descriptor);
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(document)) as unknown;
    const journal = parseAuthorityRecoveryJournalValue(value);
    throwIfCustodyRelationshipUnsafe(
      path,
      boundedProcessCustodyRelationship(journal),
    );
    return journal;
  } catch (error: unknown) {
    if (isBoundedProcessRecoveryJournalError(error)) {
      throw new BoundedProcessRecoveryJournalError([path, ...error.recoveryPaths], error.reason);
    }
    throw new BoundedProcessRecoveryJournalError([path], "authority_entry_invalid");
  } finally {
    document.fill(0);
  }
};

const safeProcessGroupId = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 1 && value <= 2_147_483_647;

export const boundedProcessRecoveryDirectory = (): string => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new BoundedProcessRecoveryJournalError([], "owner_unavailable");
  }
  let account: Readonly<{ homedir: string; uid: number }>;
  try {
    const systemAccount = userInfo({ encoding: "utf8" });
    account = { homedir: systemAccount.homedir, uid: systemAccount.uid };
  } catch {
    throw new BoundedProcessRecoveryJournalError([], "owner_unavailable");
  }
  if (account.uid !== uid || !isAbsolute(account.homedir)) {
    throw new BoundedProcessRecoveryJournalError([], "owner_unavailable");
  }
  return join(account.homedir, ".local", "state", "hra", "process-recovery");
};

export const openOwnedPrivateStateDirectory = (
  directory: string,
  create = true,
): number => {
  const uid = process.getuid?.();
  const absolute = resolve(directory);
  if (uid === undefined || !isAbsolute(directory) || absolute !== directory) {
    throw new BoundedProcessRecoveryJournalError([directory], "directory_invalid");
  }
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split("/").filter((value) => value.length > 0);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    if (create) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error: unknown) {
        if (errnoCode(error) !== "EEXIST") {
          throw new BoundedProcessRecoveryJournalError([current], "directory_create_failed");
        }
      }
    }
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(current);
    } catch {
      if (!create) {
        throw new BoundedProcessRecoveryJournalError([current], "directory_missing");
      }
      throw new BoundedProcessRecoveryJournalError([current], "directory_create_failed");
    }
    const rootOwnedStickyDirectory = metadata.uid === 0
      && (metadata.mode & 0o1000) !== 0;
    const isFinal = index === segments.length - 1;
    if (
      realpathSync(current) !== current
      || !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== uid && metadata.uid !== 0
      || (metadata.mode & 0o022) !== 0 && !rootOwnedStickyDirectory
      || isFinal && (metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700)
    ) throw new BoundedProcessRecoveryJournalError([current], "directory_invalid");
    const descriptor = openSync(
      current,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const identity = fstatSync(descriptor);
    if (
      !identity.isDirectory()
      || identity.dev !== metadata.dev
      || identity.ino !== metadata.ino
      || identity.uid !== metadata.uid
      || (identity.mode & 0o777) !== (metadata.mode & 0o777)
    ) {
      closeSync(descriptor);
      throw new BoundedProcessRecoveryJournalError([current], "directory_changed");
    }
    try {
      assertSafeDarwinInstallAcl(descriptor, uid, current);
    } catch {
      closeSync(descriptor);
      throw new BoundedProcessRecoveryJournalError([current], "directory_acl_invalid");
    }
    if (isFinal) return descriptor;
    closeSync(descriptor);
  }
  throw new BoundedProcessRecoveryJournalError([directory], "directory_invalid");
};

const openRecoveryDirectory = (directory: string): number =>
  openOwnedPrivateStateDirectory(directory);

type FlockLibrary = Readonly<{
  close: () => void;
  symbols: Readonly<{ flock: (descriptor: number, operation: number) => number }>;
}>;

const openFlockLibrary = (): FlockLibrary => {
  const linuxCandidates = process.arch === "x64"
    ? [
      "/lib/x86_64-linux-gnu/libc.so.6",
      "/usr/lib/x86_64-linux-gnu/libc.so.6",
      "/lib64/libc.so.6",
      "/usr/lib64/libc.so.6",
      "/lib/libc.musl-x86_64.so.1",
      "/usr/lib/libc.musl-x86_64.so.1",
      "/lib/ld-musl-x86_64.so.1",
      "/usr/lib/ld-musl-x86_64.so.1",
    ]
    : process.arch === "arm64"
      ? [
        "/lib/aarch64-linux-gnu/libc.so.6",
        "/usr/lib/aarch64-linux-gnu/libc.so.6",
        "/lib64/libc.so.6",
        "/usr/lib64/libc.so.6",
        "/lib/libc.musl-aarch64.so.1",
        "/usr/lib/libc.musl-aarch64.so.1",
        "/lib/ld-musl-aarch64.so.1",
        "/usr/lib/ld-musl-aarch64.so.1",
      ]
      : [];
  const candidates = process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : linuxCandidates;
  for (const candidate of candidates) {
    try {
      return dlopen(candidate, {
        flock: { args: ["i32", "i32"], returns: "i32" },
      });
    } catch {
      // Try the next platform-specific libc name.
    }
  }
  throw new BoundedProcessRecoveryJournalError([], "lock_primitive_unavailable");
};

let processFlockLibrary: FlockLibrary | undefined;
const flock = (descriptor: number, operation: number): number => {
  processFlockLibrary ??= openFlockLibrary();
  return processFlockLibrary.symbols.flock(descriptor, operation);
};

const recoveryLockName = ".journal.lock";
const flockExclusive = 2;
const flockNonblocking = 4;
const flockUnlock = 8;

const acquireRecoveryLock = (directory: string): number => {
  const directoryDescriptor = openRecoveryDirectory(directory);
  const path = join(directory, recoveryLockName);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR,
      0o600,
    );
    const uid = process.getuid?.();
    const identity = fstatSync(descriptor);
    const pathIdentity = lstatSync(path);
    if (
      uid === undefined
      || !identity.isFile()
      || identity.uid !== uid
      || identity.nlink !== 1
      || (identity.mode & 0o777) !== 0o600
      || identity.size !== 0
      || !sameFileIdentity(identity, pathIdentity)
    ) throw new BoundedProcessRecoveryJournalError([path], "lock_invalid");
    try {
      assertSafeDarwinInstallAcl(descriptor, uid, path);
    } catch {
      throw new BoundedProcessRecoveryJournalError([path], "lock_acl_invalid");
    }
    fsyncSync(descriptor);
    fsyncSync(directoryDescriptor);
    if (flock(descriptor, flockExclusive | flockNonblocking) !== 0) {
      throw new BoundedProcessRecoveryJournalError([path], "concurrent_invocation");
    }
    return descriptor;
  } catch (error: unknown) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (isBoundedProcessRecoveryJournalError(error)) throw error;
    throw new BoundedProcessRecoveryJournalError([path], "lock_invalid");
  } finally {
    closeSync(directoryDescriptor);
  }
};

const releaseRecoveryLock = (descriptor: number): void => {
  try {
    flock(descriptor, flockUnlock);
  } finally {
    closeSync(descriptor);
  }
};

const parseRecoveryJournal = (path: string): ProcessRecoveryJournal => {
  const uid = process.getuid?.();
  const metadata = lstatSync(path);
  if (
    uid === undefined
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size < 1
    || metadata.size > journalMaximumBytes
  ) throw new BoundedProcessRecoveryJournalError([path], "entry_invalid");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let document: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.uid !== metadata.uid
      || opened.nlink !== 1
      || (opened.mode & 0o777) !== 0o600
      || opened.size !== metadata.size
    ) throw new BoundedProcessRecoveryJournalError([path], "entry_changed");
    try {
      assertSafeDarwinInstallAcl(descriptor, uid, path);
    } catch {
      throw new BoundedProcessRecoveryJournalError([path], "entry_acl_invalid");
    }
    document = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (
      afterDescriptor.dev !== opened.dev
      || afterDescriptor.ino !== opened.ino
      || afterDescriptor.size !== opened.size
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
      || afterPath.uid !== opened.uid
      || afterPath.nlink !== 1
      || afterPath.size !== opened.size
    ) throw new BoundedProcessRecoveryJournalError([path], "entry_changed");
  } finally {
    closeSync(descriptor);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(document)) as unknown;
  } catch {
    throw new BoundedProcessRecoveryJournalError([path], "entry_invalid");
  } finally {
    document.fill(0);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoundedProcessRecoveryJournalError([path], "entry_invalid");
  }
  const record = value as Record<string, unknown>;
  const names = Object.keys(record).sort();
  const commonInvalid = record.schemaVersion !== 2
    || typeof record.createdAt !== "number"
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0
    || typeof record.hostIdentity !== "string"
    || !hostIdentityPattern.test(record.hostIdentity)
    || custodyIdentityFromUnknown(record) === undefined
    || typeof record.phase !== "string"
    || !phasePattern.test(record.phase);
  if (
    commonInvalid
    || record.state === "pending"
      && JSON.stringify(names) !== JSON.stringify([
        "createdAt",
        "custodyBootId",
        "custodyMountNamespaceInode",
        "custodyPidNamespaceInode",
        "hostIdentity",
        "phase",
        "schemaVersion",
        "state",
      ])
    || record.state === "active"
      && (
        JSON.stringify(names) !== JSON.stringify([
          "createdAt",
          "custodyBootId",
          "custodyMountNamespaceInode",
          "custodyPidNamespaceInode",
          "hostIdentity",
          "phase",
          "processGroupId",
          "schemaVersion",
          "state",
        ])
        || typeof record.processGroupId !== "number"
        || !safeProcessGroupId(record.processGroupId)
      )
    || record.state !== "pending" && record.state !== "active"
  ) throw new BoundedProcessRecoveryJournalError([path], "entry_invalid");
  const journal = record as unknown as ProcessRecoveryJournal;
  throwIfCustodyRelationshipUnsafe(
    path,
    boundedProcessCustodyRelationship(journal),
  );
  return journal;
};

const writeExclusiveRecoveryJournal = (
  path: string,
  journal: ProcessRecoveryJournal,
): void => {
  const encoded = Buffer.from(`${JSON.stringify(journal)}\n`, "utf8");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < encoded.byteLength) {
      const written = writeSync(descriptor, encoded, offset, encoded.byteLength - offset, offset);
      if (written < 1) throw new Error("journal_write_failed");
      offset += written;
    }
    fsyncSync(descriptor);
    const identity = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !identity.isFile()
      || identity.uid !== uid
      || identity.nlink !== 1
      || (identity.mode & 0o777) !== 0o600
      || identity.size !== encoded.byteLength
    ) throw new Error("journal_write_unproven");
    assertSafeDarwinInstallAcl(descriptor, uid, path);
  } finally {
    encoded.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const writeExclusiveAuthorityRecoveryJournal = (
  path: string,
  journal: AuthorityProcessRecoveryJournal,
): void => {
  const encoded = Buffer.from(`${JSON.stringify(journal)}\n`, "utf8");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < encoded.byteLength) {
      const written = writeSync(descriptor, encoded, offset, encoded.byteLength - offset, offset);
      if (written < 1) throw new Error("authority_journal_write_failed");
      offset += written;
    }
    fsyncSync(descriptor);
    const identity = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !identity.isFile()
      || identity.uid !== uid
      || identity.nlink !== 1
      || (identity.mode & 0o777) !== 0o600
      || identity.size !== encoded.byteLength
    ) throw new Error("authority_journal_write_unproven");
    assertSafeDarwinInstallAcl(descriptor, uid, path);
  } finally {
    encoded.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const writeAuthorityIntentRecoveryJournal = (
  directory: string,
  phase: string,
  artifact: AuthorityArtifactIdentity,
): Readonly<{ journal: AuthorityIntentRecoveryJournal; path: string; token: string }> => {
  const custodyIdentity = boundedProcessCustodyIdentity();
  const directoryDescriptor = openRecoveryDirectory(directory);
  const journal = {
    architecture: artifact.architecture,
    containment: "authority",
    createdAt: Date.now(),
    custodyBootId: custodyIdentity.custodyBootId,
    custodyMountNamespaceInode: custodyIdentity.custodyMountNamespaceInode,
    custodyPidNamespaceInode: custodyIdentity.custodyPidNamespaceInode,
    helperSha256: artifact.sha256,
    hostIdentity: custodyIdentity.hostIdentity,
    phase,
    schemaVersion: 2,
    state: "intent",
  } as const;
  const token = randomBytes(16).toString("hex");
  const custodyPrefix = boundedProcessCustodyNamePrefix(custodyIdentity);
  const path = join(directory, `authority-${custodyPrefix}-${token}.json`);
  const temporary = `${path}.create-${randomBytes(16).toString("hex")}`;
  try {
    writeExclusiveAuthorityRecoveryJournal(temporary, journal);
    linkSync(temporary, path);
    fsyncSync(directoryDescriptor);
    unlinkSync(temporary);
    fsyncSync(directoryDescriptor);
    const persisted = parseAuthorityRecoveryJournal(path);
    if (!sameAuthorityJournal(persisted, journal)) throw new Error("authority_journal_write_unproven");
    return { journal, path, token };
  } catch {
    // Startup can discard a lone exact create-temp because no helper launch is
    // possible until this function returns. A final+temp hard-link pair is
    // likewise completed under the recovery lock after its inode is verified.
    throw new BoundedProcessRecoveryJournalError([path, temporary], "authority_write_failed");
  } finally {
    closeSync(directoryDescriptor);
  }
};

const replaceAuthorityRecoveryJournal = <Next extends AuthorityProcessRecoveryJournal>(
  path: string,
  expected: AuthorityProcessRecoveryJournal,
  next: Next,
): Next => {
  const directory = resolve(path, "..");
  const directoryDescriptor = openRecoveryDirectory(directory);
  const temporary = `${path}.replace-${randomBytes(16).toString("hex")}`;
  const creationTemporary = `${temporary}.create-${randomBytes(16).toString("hex")}`;
  try {
    if (!validAuthorityJournalTransition(expected, next)) {
      throw new Error("authority_journal_transition_invalid");
    }
    const before = lstatSync(path);
    const current = parseAuthorityRecoveryJournal(path);
    const after = lstatSync(path);
    if (!sameAuthorityJournal(current, expected) || !sameFileIdentity(before, after)) {
      throw new Error("authority_journal_changed");
    }
    writeExclusiveAuthorityRecoveryJournal(creationTemporary, next);
    linkSync(creationTemporary, temporary);
    fsyncSync(directoryDescriptor);
    unlinkSync(creationTemporary);
    fsyncSync(directoryDescriptor);
    const beforeRename = lstatSync(path);
    if (!sameFileIdentity(before, beforeRename)) throw new Error("authority_journal_changed");
    renameSync(temporary, path);
    fsyncSync(directoryDescriptor);
    const persisted = parseAuthorityRecoveryJournal(path);
    if (!sameAuthorityJournal(persisted, next)) throw new Error("authority_journal_replace_unproven");
    return next;
  } catch {
    // Leave any temporary name in place. A failed O_EXCL create must never
    // unlink a collision owned by another invocation. Startup removes only an
    // exact unpublished create-temp or a narrowly proven legacy torn write.
    throw new BoundedProcessRecoveryJournalError(
      [path, temporary, creationTemporary],
      "authority_replace_failed",
    );
  } finally {
    closeSync(directoryDescriptor);
  }
};

const writePendingRecoveryJournal = (
  directory: string,
  phase: string,
): Readonly<{ journal: PendingProcessRecoveryJournal; path: string; token: string }> => {
  const custodyIdentity = boundedProcessCustodyIdentity();
  const directoryDescriptor = openRecoveryDirectory(directory);
  const journal = {
    createdAt: Date.now(),
    custodyBootId: custodyIdentity.custodyBootId,
    custodyMountNamespaceInode: custodyIdentity.custodyMountNamespaceInode,
    custodyPidNamespaceInode: custodyIdentity.custodyPidNamespaceInode,
    hostIdentity: custodyIdentity.hostIdentity,
    phase,
    schemaVersion: 2,
    state: "pending",
  } as const;
  const token = randomBytes(16).toString("hex");
  const custodyPrefix = boundedProcessCustodyNamePrefix(custodyIdentity);
  const path = join(directory, `process-${custodyPrefix}-${token}.pending.json`);
  const temporary = `${path}.create-${randomBytes(16).toString("hex")}`;
  try {
    writeExclusiveRecoveryJournal(temporary, journal);
    linkSync(temporary, path);
    fsyncSync(directoryDescriptor);
    unlinkSync(temporary);
    fsyncSync(directoryDescriptor);
    const persisted = parseRecoveryJournal(path);
    if (
      persisted.state !== "pending"
      || persisted.createdAt !== journal.createdAt
      || persisted.phase !== journal.phase
    ) throw new Error("journal_write_unproven");
    return { journal, path, token };
  } catch {
    // Startup can discard a lone exact create-temp because no child is
    // spawned until this function returns. A final+temp hard-link pair is
    // completed under the recovery lock after its inode is verified.
    throw new BoundedProcessRecoveryJournalError([path, temporary], "write_failed");
  } finally {
    closeSync(directoryDescriptor);
  }
};

const promoteRecoveryJournal = (
  path: string,
  pending: PendingProcessRecoveryJournal,
  processGroupId: number,
  token: string,
): Readonly<{ journal: ActiveProcessRecoveryJournal; path: string }> => {
  if (!safeProcessGroupId(processGroupId)) {
    throw new BoundedProcessRecoveryJournalError([path], "process_group_invalid");
  }
  const directory = resolve(path, "..");
  const directoryDescriptor = openRecoveryDirectory(directory);
  const activePath = join(
    directory,
    [
      `process-${boundedProcessCustodyNamePrefix(pending)}-${token}`,
      `.active-${String(processGroupId)}.json`,
    ].join(""),
  );
  const promotionPath = `${activePath}.promote-${randomBytes(16).toString("hex")}`;
  const promotionTemporary = `${promotionPath}.create-${randomBytes(16).toString("hex")}`;
  try {
    const before = lstatSync(path);
    const current = parseRecoveryJournal(path);
    const after = lstatSync(path);
    if (
      current.state !== "pending"
      || current.createdAt !== pending.createdAt
      || current.phase !== pending.phase
      || !sameFileIdentity(before, after)
    ) throw new Error("journal_pending_changed");
    try {
      lstatSync(activePath);
      throw new Error("journal_active_exists");
    } catch (error: unknown) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    const beforeRename = lstatSync(path);
    if (!sameFileIdentity(before, beforeRename)) {
      throw new Error("journal_pending_changed");
    }
    // Consuming the pending pathname is the concurrency boundary. Recovery
    // can either unlink that old name first (making this rename fail) or see
    // only the non-disposable active name; it can never unlink both states.
    renameSync(path, activePath);
    fsyncSync(directoryDescriptor);
    const renamed = parseRecoveryJournal(activePath);
    const renamedIdentity = lstatSync(activePath);
    if (
      renamed.state !== "pending"
      || renamed.createdAt !== pending.createdAt
      || renamed.phase !== pending.phase
      || !sameFileIdentity(before, renamedIdentity)
    ) throw new Error("journal_pending_rename_unproven");
    const active = {
      createdAt: pending.createdAt,
      custodyBootId: pending.custodyBootId,
      custodyMountNamespaceInode: pending.custodyMountNamespaceInode,
      custodyPidNamespaceInode: pending.custodyPidNamespaceInode,
      hostIdentity: pending.hostIdentity,
      phase: pending.phase,
      processGroupId,
      schemaVersion: 2,
      state: "active",
    } as const;
    writeExclusiveRecoveryJournal(promotionTemporary, active);
    linkSync(promotionTemporary, promotionPath);
    fsyncSync(directoryDescriptor);
    unlinkSync(promotionTemporary);
    fsyncSync(directoryDescriptor);
    renameSync(promotionPath, activePath);
    fsyncSync(directoryDescriptor);
    const persisted = parseRecoveryJournal(activePath);
    if (
      persisted.state !== "active"
      || persisted.createdAt !== active.createdAt
      || persisted.phase !== active.phase
      || persisted.processGroupId !== active.processGroupId
    ) throw new Error("journal_promotion_unproven");
    return { journal: active, path: activePath };
  } catch {
    // Never unlink a pathname after an uncertain O_EXCL/link/rename failure.
    // Startup repairs only exact unpublished temps or verified hard-link
    // publication pairs while the process gate remains unreleased.
    throw new BoundedProcessRecoveryJournalError(
      [activePath, path, promotionPath, promotionTemporary],
      "promotion_failed",
    );
  } finally {
    closeSync(directoryDescriptor);
  }
};

const sameRecoveryJournal = (
  left: ProcessRecoveryJournal,
  right: ProcessRecoveryJournal,
): boolean => left.state === right.state
  && left.createdAt === right.createdAt
  && left.custodyBootId === right.custodyBootId
  && left.custodyMountNamespaceInode === right.custodyMountNamespaceInode
  && left.custodyPidNamespaceInode === right.custodyPidNamespaceInode
  && left.hostIdentity === right.hostIdentity
  && left.phase === right.phase
  && (left.state !== "active" || (
    right.state === "active"
    && left.processGroupId === right.processGroupId
  ));

const removeRecoveryJournal = (
  path: string,
  expected: ProcessRecoveryJournal,
): boolean => {
  const directory = resolve(path, "..");
  const directoryDescriptor = openRecoveryDirectory(directory);
  try {
    let before: ReturnType<typeof lstatSync>;
    try {
      before = lstatSync(path);
    } catch (error: unknown) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
    const current = parseRecoveryJournal(path);
    const after = lstatSync(path);
    if (!sameRecoveryJournal(current, expected) || !sameFileIdentity(before, after)) {
      throw new BoundedProcessRecoveryJournalError([path], "entry_changed");
    }
    try {
      unlinkSync(path);
    } catch (error: unknown) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
    fsyncSync(directoryDescriptor);
    return true;
  } finally {
    closeSync(directoryDescriptor);
  }
};

const removeAuthorityRecoveryJournal = (
  path: string,
  expected: AuthorityProcessRecoveryJournal,
): boolean => {
  const directory = resolve(path, "..");
  const directoryDescriptor = openRecoveryDirectory(directory);
  try {
    let before: ReturnType<typeof lstatSync>;
    try {
      before = lstatSync(path);
    } catch (error: unknown) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
    const current = parseAuthorityRecoveryJournal(path);
    const after = lstatSync(path);
    if (!sameAuthorityJournal(current, expected) || !sameFileIdentity(before, after)) {
      throw new BoundedProcessRecoveryJournalError([path], "authority_entry_changed");
    }
    try {
      unlinkSync(path);
    } catch (error: unknown) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
    fsyncSync(directoryDescriptor);
    return true;
  } finally {
    closeSync(directoryDescriptor);
  }
};

const assertProcessTransitionTemporaryFile = (
  path: string,
  expectedLinkCount: number,
): Stats => {
  const uid = process.getuid?.();
  const metadata = lstatSync(path);
  const mode = metadata.mode & 0o777;
  if (
    uid === undefined
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.nlink !== expectedLinkCount
    || mode & ~0o600
    || expectedLinkCount > 1 && mode !== 0o600
    || metadata.size > journalMaximumBytes
  ) throw new BoundedProcessRecoveryJournalError([path], "transition_incomplete");
  return metadata;
};

const incompleteProcessTransitionIdentity = (path: string): Stats | undefined => {
  const metadata = assertProcessTransitionTemporaryFile(path, 1);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let document = Buffer.alloc(0);
  try {
    const opened = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !sameFileIdentity(metadata, opened)
      || opened.uid !== uid
      || opened.nlink !== 1
      || (opened.mode & 0o777) & ~0o600
      || opened.size !== metadata.size
    ) throw new BoundedProcessRecoveryJournalError([path], "transition_incomplete");
    try {
      assertSafeDarwinInstallAcl(descriptor, uid, path);
    } catch {
      throw new BoundedProcessRecoveryJournalError([path], "transition_incomplete");
    }
    document = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (
      !sameFileIdentity(opened, afterDescriptor)
      || !sameFileIdentity(opened, afterPath)
      || afterDescriptor.uid !== opened.uid
      || afterDescriptor.nlink !== 1
      || (afterDescriptor.mode & 0o777) !== (opened.mode & 0o777)
      || afterDescriptor.size !== opened.size
      || afterPath.uid !== opened.uid
      || afterPath.nlink !== 1
      || (afterPath.mode & 0o777) !== (opened.mode & 0o777)
      || afterPath.size !== opened.size
    ) throw new BoundedProcessRecoveryJournalError([path], "transition_incomplete");
    return document.byteLength === 0 || document[document.byteLength - 1] !== 0x0a
      ? afterPath
      : undefined;
  } finally {
    document.fill(0);
    closeSync(descriptor);
  }
};

const removeIncompleteProcessTransitionArtifact = (path: string): boolean => {
  const identity = incompleteProcessTransitionIdentity(path);
  if (identity === undefined) return false;
  const directoryDescriptor = openRecoveryDirectory(resolve(path, ".."));
  try {
    const beforeUnlink = lstatSync(path);
    if (!sameFileIdentity(identity, beforeUnlink)) {
      throw new BoundedProcessRecoveryJournalError([path], "transition_incomplete");
    }
    unlinkSync(path);
    fsyncSync(directoryDescriptor);
    return true;
  } finally {
    closeSync(directoryDescriptor);
  }
};

type ProcessTransitionArtifact =
  | Readonly<{
    finalName: string;
    kind: "pending_create";
    temporaryName: string;
  }>
  | Readonly<{
    activeName: string;
    finalName: string;
    kind: "promotion_create";
    processGroupId: number;
    temporaryName: string;
  }>;

const reconcileProcessTransitionArtifactsLocked = (
  directory: string,
  names: readonly string[],
): readonly string[] => {
  const directoryDescriptor = openRecoveryDirectory(directory);
  const namesSet = new Set(names);
  const transitions: ProcessTransitionArtifact[] = [];
  const finalNames = new Set<string>();
  try {
    for (const name of names) {
      const pendingCreation = pendingJournalCreationNamePattern.exec(name);
      const promotionCreation = journalPromotionCreationNamePattern.exec(name);
      if (pendingCreation === null && promotionCreation === null) continue;

      const nameIdentity = custodyNameIdentityFromMatch(pendingCreation ?? promotionCreation);
      const token = pendingCreation?.groups?.token ?? promotionCreation?.groups?.token;
      if (nameIdentity === undefined || token === undefined) {
        throw new BoundedProcessRecoveryJournalError(
          [join(directory, name)],
          "transition_incomplete",
        );
      }
      const custodyPrefix = custodyNamePrefixFromNameIdentity(nameIdentity);
      if (pendingCreation !== null) {
        const finalName = `process-${custodyPrefix}-${token}.pending.json`;
        const allowed = new Set([name, finalName]);
        const collisions = names.filter((candidate) => (
          candidate.startsWith(`process-${custodyPrefix}-${token}.`) && !allowed.has(candidate)
        ));
        if (finalNames.has(finalName) || collisions.length > 0) {
          throw new BoundedProcessRecoveryJournalError(
            [name, finalName, ...collisions].map((candidate) => join(directory, candidate)),
            "transition_incomplete",
          );
        }
        finalNames.add(finalName);
        transitions.push({
          finalName,
          kind: "pending_create",
          temporaryName: name,
        });
        continue;
      }

      const processGroupId = Number(promotionCreation?.groups?.pgid);
      const promotionToken = promotionCreation?.groups?.promotion;
      if (!safeProcessGroupId(processGroupId) || promotionToken === undefined) {
        throw new BoundedProcessRecoveryJournalError(
          [join(directory, name)],
          "transition_incomplete",
        );
      }
      const activeName = [
        `process-${custodyPrefix}-${token}`,
        `.active-${String(processGroupId)}.json`,
      ].join("");
      const finalName = `${activeName}.promote-${promotionToken}`;
      const allowed = new Set([activeName, finalName, name]);
      const collisions = names.filter((candidate) => (
        candidate.startsWith(`process-${custodyPrefix}-${token}.`) && !allowed.has(candidate)
      ));
      if (
        finalNames.has(finalName)
        || !namesSet.has(activeName)
        || collisions.length > 0
      ) throw new BoundedProcessRecoveryJournalError(
        [activeName, finalName, name, ...collisions]
          .map((candidate) => join(directory, candidate)),
        "transition_incomplete",
      );
      finalNames.add(finalName);
      transitions.push({
        activeName,
        finalName,
        kind: "promotion_create",
        processGroupId,
        temporaryName: name,
      });
    }

    for (const transition of transitions) {
      const finalPath = join(directory, transition.finalName);
      const temporaryPath = join(directory, transition.temporaryName);
      if (transition.kind === "pending_create") {
        if (!namesSet.has(transition.finalName)) {
          const before = assertProcessTransitionTemporaryFile(temporaryPath, 1);
          const after = lstatSync(temporaryPath);
          if (!sameFileIdentity(before, after)) {
            throw new BoundedProcessRecoveryJournalError(
              [temporaryPath],
              "transition_incomplete",
            );
          }
          unlinkSync(temporaryPath);
          fsyncSync(directoryDescriptor);
          continue;
        }
        const temporary = assertProcessTransitionTemporaryFile(temporaryPath, 2);
        const final = assertProcessTransitionTemporaryFile(finalPath, 2);
        if (!sameFileIdentity(temporary, final)) {
          throw new BoundedProcessRecoveryJournalError(
            [finalPath, temporaryPath],
            "transition_incomplete",
          );
        }
        unlinkSync(temporaryPath);
        fsyncSync(directoryDescriptor);
        const persisted = parseRecoveryJournal(finalPath);
        if (persisted.state !== "pending") {
          throw new BoundedProcessRecoveryJournalError(
            [finalPath],
            "transition_incomplete",
          );
        }
        continue;
      }

      const activePath = join(directory, transition.activeName);
      const activeBefore = lstatSync(activePath);
      const pending = parseRecoveryJournal(activePath);
      const activeAfter = lstatSync(activePath);
      if (pending.state !== "pending" || !sameFileIdentity(activeBefore, activeAfter)) {
        throw new BoundedProcessRecoveryJournalError(
          [activePath, temporaryPath],
          "transition_incomplete",
        );
      }
      if (!namesSet.has(transition.finalName)) {
        const before = assertProcessTransitionTemporaryFile(temporaryPath, 1);
        const after = lstatSync(temporaryPath);
        if (!sameFileIdentity(before, after)) {
          throw new BoundedProcessRecoveryJournalError(
            [temporaryPath],
            "transition_incomplete",
          );
        }
        unlinkSync(temporaryPath);
        fsyncSync(directoryDescriptor);
        continue;
      }
      const temporary = assertProcessTransitionTemporaryFile(temporaryPath, 2);
      const final = assertProcessTransitionTemporaryFile(finalPath, 2);
      if (!sameFileIdentity(temporary, final)) {
        throw new BoundedProcessRecoveryJournalError(
          [finalPath, temporaryPath],
          "transition_incomplete",
        );
      }
      unlinkSync(temporaryPath);
      fsyncSync(directoryDescriptor);
      const promotion = parseRecoveryJournal(finalPath);
      if (
        promotion.state !== "active"
        || promotion.processGroupId !== transition.processGroupId
        || promotion.createdAt !== pending.createdAt
        || promotion.custodyBootId !== pending.custodyBootId
        || promotion.custodyMountNamespaceInode !== pending.custodyMountNamespaceInode
        || promotion.custodyPidNamespaceInode !== pending.custodyPidNamespaceInode
        || promotion.hostIdentity !== pending.hostIdentity
        || promotion.phase !== pending.phase
      ) throw new BoundedProcessRecoveryJournalError(
        [activePath, finalPath],
        "transition_incomplete",
      );
    }
  } finally {
    closeSync(directoryDescriptor);
  }
  return names.filter((name) => (
    !pendingJournalCreationNamePattern.test(name)
    && !journalPromotionCreationNamePattern.test(name)
  ));
};

const recoverBoundedProcessJournalLocked = (directory: string): void => {
  const directoryDescriptor = openRecoveryDirectory(directory);
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name !== recoveryLockName)
      .sort();
  } finally {
    closeSync(directoryDescriptor);
  }
  if (names.length > 128) {
    throw new BoundedProcessRecoveryJournalError([directory], "entry_limit_exceeded");
  }
  assertJournalNameCustodySafe(directory, names, "process");
  const reconciledNames = reconcileProcessTransitionArtifactsLocked(directory, names);
  let failure: BoundedProcessCleanupUnprovenError | undefined;
  const recordLiveProcess = (
    processGroupId: number,
    phase: string,
    paths: readonly string[],
  ): void => {
    const current = new BoundedProcessCleanupUnprovenError(processGroupId, phase);
    for (const path of paths) current.retainRecoveryPath(path);
    if (failure === undefined) failure = current;
    else failure.include(current);
  };
  const handled = new Set<string>();
  const promotionsByActiveName = new Map<string, string[]>();

  // A complete promotion is an immutable proof tied to exactly one pending
  // active name. Detect duplicate proofs for that name before removing either
  // proof or the shared pending record; otherwise directory order could erase
  // the first pair before the second collision is discovered.
  for (const name of reconciledNames) {
    const promotionName = journalPromotionNamePattern.exec(name);
    if (promotionName === null) continue;
    const nameIdentity = custodyNameIdentityFromMatch(promotionName);
    const token = promotionName.groups?.token;
    const namedProcessGroupId = Number(promotionName.groups?.pgid);
    if (
      nameIdentity === undefined
      || token === undefined
      || !safeProcessGroupId(namedProcessGroupId)
    ) continue;
    const activeName = [
      `process-${custodyNamePrefixFromNameIdentity(nameIdentity)}-${token}`,
      `.active-${String(namedProcessGroupId)}.json`,
    ].join("");
    const promotions = promotionsByActiveName.get(activeName) ?? [];
    promotions.push(name);
    promotionsByActiveName.set(activeName, promotions);
  }
  for (const [activeName, promotions] of promotionsByActiveName) {
    if (promotions.length <= 1) continue;
    throw new BoundedProcessRecoveryJournalError(
      [activeName, ...promotions].map((name) => join(directory, name)),
      "promotion_incomplete",
    );
  }

  for (const name of reconciledNames) {
    const promotionName = journalPromotionNamePattern.exec(name);
    if (promotionName === null) continue;
    const nameIdentity = custodyNameIdentityFromMatch(promotionName);
    const token = promotionName.groups?.token;
    const namedProcessGroupId = Number(promotionName.groups?.pgid);
    if (nameIdentity === undefined || token === undefined) {
      throw new BoundedProcessRecoveryJournalError(
        [join(directory, name)],
        "promotion_incomplete",
      );
    }
    const custodyPrefix = custodyNamePrefixFromNameIdentity(nameIdentity);
    const activeName = [
      `process-${custodyPrefix}-${token}`,
      `.active-${String(namedProcessGroupId)}.json`,
    ].join("");
    const promotionPath = join(directory, name);
    const activePath = join(directory, activeName);
    if (
      !safeProcessGroupId(namedProcessGroupId)
      || !reconciledNames.includes(activeName)
      || handled.has(activeName)
    ) throw new BoundedProcessRecoveryJournalError([promotionPath, activePath], "promotion_incomplete");
    const pending = parseRecoveryJournal(activePath);
    if (pending.state !== "pending") {
      throw new BoundedProcessRecoveryJournalError(
        [promotionPath, activePath],
        "promotion_incomplete",
      );
    }
    const incompletePromotion = incompleteProcessTransitionIdentity(promotionPath);
    if (incompletePromotion !== undefined) {
      const allowed = new Set([activeName, name]);
      const collisions = reconciledNames.filter((candidate) => (
        candidate.startsWith(`process-${custodyPrefix}-${token}.`) && !allowed.has(candidate)
      ));
      if (collisions.length > 0) {
        throw new BoundedProcessRecoveryJournalError(
          [activeName, name, ...collisions].map((candidate) => join(directory, candidate)),
          "promotion_incomplete",
        );
      }
      if (!removeIncompleteProcessTransitionArtifact(promotionPath)) {
        throw new BoundedProcessRecoveryJournalError(
          [promotionPath],
          "promotion_incomplete",
        );
      }
      handled.add(name);
      continue;
    }
    const promotion = parseRecoveryJournal(promotionPath);
    if (
      promotion.state !== "active"
      || promotion.processGroupId !== namedProcessGroupId
      || promotion.createdAt !== pending.createdAt
      || promotion.custodyBootId !== pending.custodyBootId
      || promotion.custodyMountNamespaceInode !== pending.custodyMountNamespaceInode
      || promotion.custodyPidNamespaceInode !== pending.custodyPidNamespaceInode
      || promotion.hostIdentity !== pending.hostIdentity
      || promotion.phase !== pending.phase
    ) throw new BoundedProcessRecoveryJournalError([promotionPath, activePath], "promotion_incomplete");
    handled.add(name);
    handled.add(activeName);
    if (
      boundedProcessCustodyRelationship(pending) !== "old_boot"
      && processGroupExists(-namedProcessGroupId)
    ) {
      // The launch owner may have crashed after the rename, but the gate can
      // never have been released until the active document was read back.
      // Preserve both records until the named group is conclusively absent.
      recordLiveProcess(namedProcessGroupId, pending.phase, [activePath, promotionPath]);
      continue;
    }
    // Removing the promotion first means a crash between removals leaves an
    // active-name pending record that the branch below can safely reconcile.
    if (!removeRecoveryJournal(promotionPath, promotion)) {
      throw new BoundedProcessRecoveryJournalError([promotionPath], "entry_changed");
    }
    if (!removeRecoveryJournal(activePath, pending)) {
      throw new BoundedProcessRecoveryJournalError([activePath], "entry_changed");
    }
  }

  for (const name of reconciledNames) {
    if (handled.has(name)) continue;
    const path = join(directory, name);
    const pendingName = pendingJournalNamePattern.exec(name);
    if (pendingName !== null) {
      const nameIdentity = custodyNameIdentityFromMatch(pendingName);
      const token = pendingName.groups?.token;
      if (nameIdentity === undefined || token === undefined) {
        throw new BoundedProcessRecoveryJournalError([path], "entry_name_invalid");
      }
      const custodyPrefix = custodyNamePrefixFromNameIdentity(nameIdentity);
      const incompletePending = incompleteProcessTransitionIdentity(path);
      if (incompletePending !== undefined) {
        const collisions = reconciledNames.filter((candidate) => (
          candidate !== name
          && candidate.startsWith(`process-${custodyPrefix}-${token}.`)
        ));
        if (collisions.length > 0) {
          throw new BoundedProcessRecoveryJournalError(
            [name, ...collisions].map((candidate) => join(directory, candidate)),
            "transition_incomplete",
          );
        }
        if (!removeIncompleteProcessTransitionArtifact(path)) {
          throw new BoundedProcessRecoveryJournalError([path], "transition_incomplete");
        }
        continue;
      }
      const journal = parseRecoveryJournal(path);
      if (journal.state !== "pending") {
        throw new BoundedProcessRecoveryJournalError([path], "entry_state_invalid");
      }
      // The transition lock proves that no live owner can still release this
      // pending gate. Removal is bound to this exact state and pathname.
      if (!removeRecoveryJournal(path, journal)) {
        throw new BoundedProcessRecoveryJournalError([path], "entry_changed");
      }
      continue;
    }
    const activeName = activeJournalNamePattern.exec(name);
    if (activeName === null) {
      throw new BoundedProcessRecoveryJournalError([path], "entry_name_invalid");
    }
    const journal = parseRecoveryJournal(path);
    const namedProcessGroupId = Number(activeName.groups?.pgid);
    if (!safeProcessGroupId(namedProcessGroupId)) {
      throw new BoundedProcessRecoveryJournalError([path], "entry_state_invalid");
    }
    if (journal.state === "pending") {
      // A crash after consuming the pending pathname but before promotion can
      // leave this form. The private gate was not released. Its named group is
      // still checked so recovery cannot erase a live launch boundary.
      if (
        boundedProcessCustodyRelationship(journal) !== "old_boot"
        && processGroupExists(-namedProcessGroupId)
      ) {
        recordLiveProcess(namedProcessGroupId, journal.phase, [path]);
        continue;
      }
      if (!removeRecoveryJournal(path, journal)) {
        throw new BoundedProcessRecoveryJournalError([path], "entry_changed");
      }
      continue;
    }
    if (journal.processGroupId !== namedProcessGroupId) {
      throw new BoundedProcessRecoveryJournalError([path], "entry_state_invalid");
    }
    if (
      boundedProcessCustodyRelationship(journal) !== "old_boot"
      && processGroupExists(-journal.processGroupId)
    ) {
      recordLiveProcess(journal.processGroupId, journal.phase, [path]);
      continue;
    }
    if (!removeRecoveryJournal(path, journal)) {
      throw new BoundedProcessRecoveryJournalError([path], "entry_changed");
    }
  }
  if (failure !== undefined) throw failure;
};

const authorityProtocolPrefix = "HRA_AUTHORITY_SUPERVISOR/1 ";
const authorityControlMaximumBytes = 1_024;
const authoritySocketMaximumPathBytes = 107;

type AuthorityControlFrame = Readonly<{
  fields: Readonly<Record<string, string>>;
  kind: "CLEAN" | "FAIL" | "READY" | "RECOVERY_CLEAN" | "RECOVERY_READY";
}>;

class AuthorityControlProtocolError extends Error {
  constructor(readonly code: string) {
    super(`authority_control_protocol:${code}`);
    this.name = "AuthorityControlProtocolError";
  }
}

const parseAuthorityControlFrame = (line: Buffer): AuthorityControlFrame => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch {
    throw new AuthorityControlProtocolError("encoding_invalid");
  }
  if (!text.startsWith(authorityProtocolPrefix) || /[\r\n\t]/u.test(text)) {
    throw new AuthorityControlProtocolError("prefix_invalid");
  }
  const parts = text.slice(authorityProtocolPrefix.length).split(" ");
  const candidateKind = parts.shift();
  if (
    candidateKind !== "READY"
    && candidateKind !== "CLEAN"
    && candidateKind !== "FAIL"
    && candidateKind !== "RECOVERY_READY"
    && candidateKind !== "RECOVERY_CLEAN"
    || parts.length === 0
  ) throw new AuthorityControlProtocolError("kind_invalid");
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const equals = part.indexOf("=");
    const name = equals < 1 ? undefined : part.slice(0, equals);
    const value = equals < 1 ? undefined : part.slice(equals + 1);
    if (
      name === undefined
      || value === undefined
      || !/^[a-z][a-z0-9_]{0,63}$/u.test(name)
      || value.length === 0
      || !/^[A-Za-z0-9._:-]{1,127}$/u.test(value)
      || Object.hasOwn(fields, name)
    ) throw new AuthorityControlProtocolError("field_invalid");
    fields[name] = value;
  }
  return { fields: Object.freeze(fields), kind: candidateKind };
};

const requireAuthorityFrame = (
  frame: AuthorityControlFrame,
  kind: AuthorityControlFrame["kind"],
  names: readonly string[],
): Readonly<Record<string, string>> => {
  if (frame.kind !== kind || JSON.stringify(Object.keys(frame.fields).sort()) !== JSON.stringify([...names].sort())) {
    throw new AuthorityControlProtocolError("frame_shape_invalid");
  }
  return frame.fields;
};

const parseFramePid = (value: string | undefined): number => {
  if (value === undefined || !/^[1-9][0-9]{0,9}$/u.test(value)) {
    throw new AuthorityControlProtocolError("pid_invalid");
  }
  const parsed = Number(value);
  if (!safeLinuxPid(parsed) || String(parsed) !== value) {
    throw new AuthorityControlProtocolError("pid_invalid");
  }
  return parsed;
};

const parseFrameUnsignedDecimal = (value: string | undefined): string => {
  if (value === undefined || !safeUnsignedDecimal(value)) {
    throw new AuthorityControlProtocolError("unsigned_decimal_invalid");
  }
  return value;
};

const parseFrameBootId = (value: string | undefined): string => {
  if (value === undefined || !safeBootId(value)) {
    throw new AuthorityControlProtocolError("boot_id_invalid");
  }
  return value;
};

const parseFrameExitCode = (value: string | undefined): number => {
  if (value === undefined || !/^(?:0|[1-9][0-9]{0,2})$/u.test(value)) {
    throw new AuthorityControlProtocolError("exit_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 255 || String(parsed) !== value) {
    throw new AuthorityControlProtocolError("exit_invalid");
  }
  return parsed;
};

const authorityLaunchReadyIdentity = (
  frame: AuthorityControlFrame,
  nonce: string,
): Extract<BoundedProcessRecoveryIdentity, { containment: "authority" }> & Readonly<{
  monotonicMilliseconds: bigint;
  outerProcessGroupId: number;
}> => {
  const fields = requireAuthorityFrame(frame, "READY", [
    "boot_id",
    "init_host_pid",
    "init_pid_namespace_inode",
    "init_start_time",
    "monotonic_ms",
    "nonce",
    "ns_init_pid",
    "outer_pgid",
    "outer_pid",
    "outer_start_time",
  ]);
  if (fields.nonce !== nonce || fields.ns_init_pid !== "1") {
    throw new AuthorityControlProtocolError("ready_nonce_invalid");
  }
  return {
    bootId: parseFrameBootId(fields.boot_id),
    containment: "authority",
    monotonicMilliseconds: BigInt(parseFrameUnsignedDecimal(fields.monotonic_ms)),
    namespaceInit: {
      pid: parseFramePid(fields.init_host_pid),
      pidNamespaceInode: parseFrameUnsignedDecimal(fields.init_pid_namespace_inode),
      startTime: parseFrameUnsignedDecimal(fields.init_start_time),
    },
    outer: {
      pid: parseFramePid(fields.outer_pid),
      startTime: parseFrameUnsignedDecimal(fields.outer_start_time),
    },
    outerProcessGroupId: parseFramePid(fields.outer_pgid),
  };
};

const assertAuthorityCleanFrame = (
  frame: AuthorityControlFrame,
  nonce: string,
): number => {
  const fields = requireAuthorityFrame(frame, "CLEAN", ["exit", "nonce"]);
  if (fields.nonce !== nonce) throw new AuthorityControlProtocolError("clean_nonce_invalid");
  return parseFrameExitCode(fields.exit);
};

const assertAuthorityFailFrame = (
  frame: AuthorityControlFrame,
  nonce: string,
): void => {
  const fields = requireAuthorityFrame(frame, "FAIL", ["code", "nonce"]);
  if (
    fields.nonce !== nonce
    || fields.code === undefined
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(fields.code)
  ) throw new AuthorityControlProtocolError("fail_frame_invalid");
};

const assertAuthorityRecoveryReadyFrame = (
  frame: AuthorityControlFrame,
  nonce: string,
  identity: Extract<BoundedProcessRecoveryIdentity, { containment: "authority" }>,
  recovery: Readonly<{ pid: number; startTime: string }>,
): void => {
  const fields = requireAuthorityFrame(frame, "RECOVERY_READY", [
    "init_host_pid",
    "init_pid_namespace_inode",
    "init_start_time",
    "nonce",
    "outer_pid",
    "outer_start_time",
    "recovery_pid",
    "recovery_start_time",
  ]);
  if (
    fields.nonce !== nonce
    || parseFramePid(fields.recovery_pid) !== recovery.pid
    || parseFrameUnsignedDecimal(fields.recovery_start_time) !== recovery.startTime
    || parseFramePid(fields.outer_pid) !== identity.outer.pid
    || parseFrameUnsignedDecimal(fields.outer_start_time) !== identity.outer.startTime
    || parseFramePid(fields.init_host_pid) !== identity.namespaceInit.pid
    || parseFrameUnsignedDecimal(fields.init_start_time) !== identity.namespaceInit.startTime
    || parseFrameUnsignedDecimal(fields.init_pid_namespace_inode)
      !== identity.namespaceInit.pidNamespaceInode
  ) throw new AuthorityControlProtocolError("recovery_ready_identity_invalid");
};

const assertAuthorityRecoveryCleanFrame = (
  frame: AuthorityControlFrame,
  nonce: string,
  identity: Extract<BoundedProcessRecoveryIdentity, { containment: "authority" }>,
  recovery: Readonly<{ pid: number; startTime: string }>,
): void => {
  const fields = requireAuthorityFrame(frame, "RECOVERY_CLEAN", [
    "boot_id",
    "init_host_pid",
    "init_pid_namespace_inode",
    "init_start_time",
    "method",
    "nonce",
    "outer_pid",
    "outer_start_time",
    "recovery_pid",
    "recovery_start_time",
  ]);
  if (
    fields.nonce !== nonce
    || fields.method !== "pidfd-sigkill" && fields.method !== "pidfd-already-exited"
    || parseFramePid(fields.recovery_pid) !== recovery.pid
    || parseFrameUnsignedDecimal(fields.recovery_start_time) !== recovery.startTime
    || parseFrameBootId(fields.boot_id) !== identity.bootId
    || parseFramePid(fields.outer_pid) !== identity.outer.pid
    || parseFrameUnsignedDecimal(fields.outer_start_time) !== identity.outer.startTime
    || parseFramePid(fields.init_host_pid) !== identity.namespaceInit.pid
    || parseFrameUnsignedDecimal(fields.init_start_time) !== identity.namespaceInit.startTime
    || parseFrameUnsignedDecimal(fields.init_pid_namespace_inode)
      !== identity.namespaceInit.pidNamespaceInode
  ) throw new AuthorityControlProtocolError("recovery_clean_identity_invalid");
};

const authorityControlError = (code: string): Error =>
  new AuthorityControlProtocolError(code);

class AuthorityControlEndpoint {
  readonly #frames: AuthorityControlFrame[] = [];
  readonly #server: Server;
  readonly #socketPath: string;
  #closed = false;
  #failure: Error | undefined;
  #receivedBytes = 0;
  #socket: Socket | undefined;
  #socketEnded = false;
  #waiter: Readonly<{ reject: (error: Error) => void; resolve: (frame: AuthorityControlFrame) => void }> | undefined;
  #endWaiter: Readonly<{ reject: (error: Error) => void; resolve: () => void }> | undefined;

  private constructor(server: Server, socketPath: string) {
    this.#server = server;
    this.#socketPath = socketPath;
  }

  static async create(directory: string): Promise<AuthorityControlEndpoint> {
    const directoryDescriptor = openRecoveryDirectory(directory);
    closeSync(directoryDescriptor);
    const socketPath = join(directory, `.authority-control-${randomBytes(16).toString("hex")}.sock`);
    if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath, "utf8") > authoritySocketMaximumPathBytes) {
      throw new BoundedProcessRecoveryJournalError([socketPath], "authority_socket_path_invalid");
    }
    const server = createServer();
    const endpoint = new AuthorityControlEndpoint(server, socketPath);
    server.maxConnections = 1;
    server.on("connection", (socket) => endpoint.#accept(socket));
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const reject = (error: Error) => {
          server.off("error", reject);
          rejectPromise(error);
        };
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolvePromise();
        });
      });
      chmodSync(socketPath, 0o600);
      const metadata = lstatSync(socketPath);
      const uid = process.getuid?.();
      if (
        uid === undefined
        || !metadata.isSocket()
        || metadata.isSymbolicLink()
        || metadata.uid !== uid
        || (metadata.mode & 0o777) !== 0o600
      ) throw new BoundedProcessRecoveryJournalError([socketPath], "authority_socket_invalid");
      return endpoint;
    } catch (error: unknown) {
      await endpoint.close();
      if (isBoundedProcessRecoveryJournalError(error)) throw error;
      throw new BoundedProcessRecoveryJournalError([socketPath], "authority_socket_create_failed");
    }
  }

  get path(): string {
    return this.#socketPath;
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#waiter?.reject(error);
    this.#waiter = undefined;
    this.#endWaiter?.reject(error);
    this.#endWaiter = undefined;
  }

  #accept(socket: Socket): void {
    if (this.#socket !== undefined || this.#closed) {
      socket.destroy();
      this.#fail(authorityControlError("connection_count_invalid"));
      return;
    }
    this.#socket = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (this.#failure !== undefined) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.#receivedBytes += bytes.byteLength;
      if (this.#receivedBytes > authorityControlMaximumBytes) {
        this.#fail(authorityControlError("message_limit_exceeded"));
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, bytes]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          const frame = parseAuthorityControlFrame(line);
          if (this.#waiter !== undefined) {
            const waiter = this.#waiter;
            this.#waiter = undefined;
            waiter.resolve(frame);
          } else this.#frames.push(frame);
        } catch (error: unknown) {
          this.#fail(error instanceof Error ? error : authorityControlError("frame_invalid"));
          socket.destroy();
          return;
        }
      }
      if (buffer.byteLength > authorityControlMaximumBytes) {
        this.#fail(authorityControlError("line_limit_exceeded"));
        socket.destroy();
      }
    });
    socket.once("error", () => this.#fail(authorityControlError("socket_error")));
    socket.once("end", () => {
      if (buffer.byteLength !== 0) this.#fail(authorityControlError("truncated_frame"));
      this.#socketEnded = true;
      if (this.#failure === undefined && this.#waiter !== undefined) {
        this.#fail(authorityControlError("socket_ended_early"));
      }
      if (this.#failure === undefined) this.#endWaiter?.resolve();
      this.#endWaiter = undefined;
    });
    socket.once("close", () => {
      if (!this.#socketEnded && !this.#closed) this.#fail(authorityControlError("socket_closed_early"));
    });
  }

  async nextFrame(timeoutMs: number): Promise<AuthorityControlFrame> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw authorityControlError("deadline_invalid");
    }
    const next = this.#frames.shift();
    if (next !== undefined) return next;
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#socketEnded) throw authorityControlError("socket_ended_early");
    if (this.#waiter !== undefined) throw authorityControlError("concurrent_frame_wait");
    return await new Promise<AuthorityControlFrame>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        rejectPromise(authorityControlError("frame_deadline_exceeded"));
      }, timeoutMs);
      timer.unref();
      this.#waiter = {
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
        resolve: (frame) => {
          clearTimeout(timer);
          resolvePromise(frame);
        },
      };
    });
  }

  async write(frame: string): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    const socket = this.#socket;
    if (socket === undefined || socket.destroyed || this.#socketEnded) {
      throw authorityControlError("socket_unavailable");
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      socket.write(frame, "utf8", (error) => error === undefined ? resolvePromise() : rejectPromise(error));
    });
  }

  async waitForEnd(timeoutMs: number): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#socketEnded) return;
    if (this.#endWaiter !== undefined) throw authorityControlError("concurrent_end_wait");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#endWaiter = undefined;
        rejectPromise(authorityControlError("end_deadline_exceeded"));
      }, timeoutMs);
      timer.unref();
      this.#endWaiter = {
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
        resolve: () => {
          clearTimeout(timer);
          resolvePromise();
        },
      };
    });
  }

  assertComplete(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (!this.#socketEnded || this.#frames.length !== 0 || this.#waiter !== undefined) {
      throw authorityControlError("protocol_completion_invalid");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket?.destroy();
    await new Promise<void>((resolvePromise) => {
      try {
        this.#server.close(() => resolvePromise());
      } catch {
        resolvePromise();
      }
    });
    try {
      const metadata = lstatSync(this.#socketPath);
      const uid = process.getuid?.();
      if (
        uid === undefined
        || !metadata.isSocket()
        || metadata.isSymbolicLink()
        || metadata.uid !== uid
      ) throw new BoundedProcessRecoveryJournalError([this.#socketPath], "authority_socket_invalid");
      unlinkSync(this.#socketPath);
    } catch (error: unknown) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
}

type LinuxProcessStartTimeObservation =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "observed"; startTime: string }>
  | Readonly<{ state: "unknown" }>;

type LinuxProcStatReader = (path: string) => string;

const systemLinuxProcStatReader: LinuxProcStatReader = (path) =>
  readFileSync(path, "utf8");

const observeLinuxProcessStartTime = (
  pid: number,
  readStat: LinuxProcStatReader = systemLinuxProcStatReader,
): LinuxProcessStartTimeObservation => {
  if (!safeLinuxPid(pid)) return { state: "unknown" };
  let document: string;
  try {
    document = readStat(`/proc/${String(pid)}/stat`);
  } catch (error: unknown) {
    const code = errnoCode(error);
    return code === "ENOENT" || code === "ESRCH"
      ? { state: "absent" }
      : { state: "unknown" };
  }
  if (Buffer.byteLength(document, "utf8") > 4_096) return { state: "unknown" };
  const firstSpace = document.indexOf(" ");
  const closingParenthesis = document.lastIndexOf(")");
  if (firstSpace < 1 || closingParenthesis <= firstSpace || document[closingParenthesis + 1] !== " ") {
    return { state: "unknown" };
  }
  if (document.slice(0, firstSpace) !== String(pid)) return { state: "unknown" };
  const fields = document.slice(closingParenthesis + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  return startTime !== undefined && safeUnsignedDecimal(startTime)
    ? { startTime, state: "observed" }
    : { state: "unknown" };
};

const readLinuxProcessStartTime = (pid: number): string | undefined => {
  const observation = observeLinuxProcessStartTime(pid);
  return observation.state === "observed" ? observation.startTime : undefined;
};

const linuxProcessIdentityProvenGone = (
  pid: number,
  expectedStartTime: string,
  readStat: LinuxProcStatReader = systemLinuxProcStatReader,
): boolean => {
  const observation = observeLinuxProcessStartTime(pid, readStat);
  return observation.state === "absent"
    || observation.state === "observed" && observation.startTime !== expectedStartTime;
};

export const linuxProcessIdentityProvenGoneForTesting = (
  pid: number,
  expectedStartTime: string,
  readStat: LinuxProcStatReader,
): boolean => linuxProcessIdentityProvenGone(pid, expectedStartTime, readStat);

const readLinuxPidNamespaceInode = (pid: number): string | undefined => {
  if (!safeLinuxPid(pid)) return undefined;
  try {
    const target = readlinkSync(`/proc/${String(pid)}/ns/pid`, "utf8");
    const match = /^pid:\[([1-9][0-9]{0,19})\]$/u.exec(target);
    const inode = match?.[1];
    return inode !== undefined && safeUnsignedDecimal(inode) ? inode : undefined;
  } catch {
    return undefined;
  }
};

const verifyAuthorityLaunchIdentity = (
  identity: Extract<BoundedProcessRecoveryIdentity, { containment: "authority" }>,
  childPid: number | undefined,
): void => {
  if (
    childPid === undefined
    || childPid !== identity.outer.pid
    || identity.namespaceInit.pid === identity.outer.pid
    || readLinuxBootId() !== identity.bootId
    || readLinuxProcessStartTime(identity.outer.pid) !== identity.outer.startTime
    || readLinuxProcessStartTime(identity.namespaceInit.pid) !== identity.namespaceInit.startTime
    || readLinuxPidNamespaceInode(identity.namespaceInit.pid)
      !== identity.namespaceInit.pidNamespaceInode
  ) throw new AuthorityControlProtocolError("launch_identity_invalid");
};

const authorityJournalIdentity = (
  journal: AuthorityPreparedRecoveryJournal
    | AuthorityArmedRecoveryJournal
    | AuthorityGoAttemptedRecoveryJournal,
): Extract<BoundedProcessRecoveryIdentity, { containment: "authority" }> => ({
  bootId: journal.bootId,
  containment: "authority",
  namespaceInit: {
    pid: journal.initHostPid,
    pidNamespaceInode: journal.initPidNamespaceInode,
    startTime: journal.initStartTime,
  },
  outer: {
    pid: journal.outerPid,
    startTime: journal.outerStartTime,
  },
});

const preparedAuthorityJournal = (
  intent: AuthorityIntentRecoveryJournal,
  identity: Extract<BoundedProcessRecoveryIdentity, { containment: "authority" }>,
): AuthorityPreparedRecoveryJournal => {
  if (identity.bootId !== intent.custodyBootId) {
    throw new AuthorityControlProtocolError("ready_boot_identity_invalid");
  }
  return {
    architecture: intent.architecture,
    bootId: identity.bootId,
    containment: "authority",
    createdAt: intent.createdAt,
    custodyBootId: intent.custodyBootId,
    custodyMountNamespaceInode: intent.custodyMountNamespaceInode,
    custodyPidNamespaceInode: intent.custodyPidNamespaceInode,
    helperSha256: intent.helperSha256,
    hostIdentity: intent.hostIdentity,
    initHostPid: identity.namespaceInit.pid,
    initPidNamespaceInode: identity.namespaceInit.pidNamespaceInode,
    initStartTime: identity.namespaceInit.startTime,
    outerPid: identity.outer.pid,
    outerStartTime: identity.outer.startTime,
    phase: intent.phase,
    schemaVersion: 2,
    state: "prepared",
  };
};

const armedAuthorityJournal = (
  prepared: AuthorityPreparedRecoveryJournal,
): AuthorityArmedRecoveryJournal => ({
  architecture: prepared.architecture,
  bootId: prepared.bootId,
  containment: "authority",
  createdAt: prepared.createdAt,
  custodyBootId: prepared.custodyBootId,
  custodyMountNamespaceInode: prepared.custodyMountNamespaceInode,
  custodyPidNamespaceInode: prepared.custodyPidNamespaceInode,
  helperSha256: prepared.helperSha256,
  hostIdentity: prepared.hostIdentity,
  initHostPid: prepared.initHostPid,
  initPidNamespaceInode: prepared.initPidNamespaceInode,
  initStartTime: prepared.initStartTime,
  outerPid: prepared.outerPid,
  outerStartTime: prepared.outerStartTime,
  phase: prepared.phase,
  schemaVersion: 2,
  state: "armed",
});

const goAttemptedAuthorityJournal = (
  armed: AuthorityArmedRecoveryJournal,
): AuthorityGoAttemptedRecoveryJournal => ({
  architecture: armed.architecture,
  bootId: armed.bootId,
  containment: "authority",
  createdAt: armed.createdAt,
  custodyBootId: armed.custodyBootId,
  custodyMountNamespaceInode: armed.custodyMountNamespaceInode,
  custodyPidNamespaceInode: armed.custodyPidNamespaceInode,
  helperSha256: armed.helperSha256,
  hostIdentity: armed.hostIdentity,
  initHostPid: armed.initHostPid,
  initPidNamespaceInode: armed.initPidNamespaceInode,
  initStartTime: armed.initStartTime,
  outerPid: armed.outerPid,
  outerStartTime: armed.outerStartTime,
  phase: armed.phase,
  schemaVersion: 2,
  state: "go_attempted",
});

const waitForChildClose = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new AuthorityControlProtocolError("child_deadline_invalid");
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new AuthorityControlProtocolError("child_exit_deadline_exceeded"));
    }, timeoutMs);
    timer.unref();
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once("error", () => {
      clearTimeout(timer);
      rejectPromise(new AuthorityControlProtocolError("child_error"));
    });
  });
};

/**
 * Node only emits `spawn` after its exec handshake has succeeded. Keeping the
 * sealed helper descriptor open through this event lets the child resolve the
 * parent's `/proc/<pid>/fd/<fd>` execution path, then releases it before the
 * authority protocol can admit a target.
 */
const waitForChildSpawn = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new AuthorityControlProtocolError("child_spawn_deadline_invalid");
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => settle(() => rejectPromise(
      new AuthorityControlProtocolError("child_spawn_deadline_exceeded"),
    )), timeoutMs);
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      child.off("spawn", onSpawn);
      callback();
    };
    const onSpawn = (): void => settle(resolvePromise);
    const onError = (): void => settle(() => rejectPromise(
      new AuthorityControlProtocolError("child_spawn_error"),
    ));
    const onClose = (): void => settle(() => rejectPromise(
      new AuthorityControlProtocolError("child_closed_before_spawn"),
    ));
    timer.unref();
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("close", onClose);
  });
};

const stopDirectAuthorityHelperBeforeGo = async (
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  try {
    child.kill("SIGKILL");
  } catch {
    // The target remains behind its GO gate. A vanished helper is sufficient.
  }
  try {
    await waitForChildClose(child, 1_000);
  } catch {
    // The target has no route through the unissued GO frame. Do not turn this
    // pre-execution cleanup into a false provider-liveness claim.
  }
};

const removeStaleAuthorityControlSocketsLocked = (directory: string): void => {
  const directoryDescriptor = openRecoveryDirectory(directory);
  try {
    const names = readdirSync(directory).sort();
    const preChmodMode = 0o777 & ~process.umask();
    for (const name of names) {
      if (!name.startsWith(".authority-control-")) continue;
      const path = join(directory, name);
      if (!authorityControlSocketNamePattern.test(name)) {
        throw new BoundedProcessRecoveryJournalError([path], "authority_socket_name_invalid");
      }
      const metadata = lstatSync(path);
      const uid = process.getuid?.();
      const mode = metadata.mode & 0o777;
      if (
        uid === undefined
        || !metadata.isSocket()
        || metadata.isSymbolicLink()
        || metadata.uid !== uid
        || metadata.nlink !== 1
        || metadata.size !== 0
        || mode !== 0o600 && mode !== preChmodMode
      ) throw new BoundedProcessRecoveryJournalError([path], "authority_socket_invalid");
      // A completed endpoint is 0600. A crash between bind/listen and chmod
      // leaves exactly the platform's 0777-and-current-umask socket mode. The
      // owned 0700 directory and held global lock make these two exact shapes
      // stale and removable without accepting an arbitrary wrong-mode entry.
      unlinkSync(path);
      fsyncSync(directoryDescriptor);
    }
  } finally {
    closeSync(directoryDescriptor);
  }
};

const openAuthorityArtifactForLaunch = async (): Promise<OpenAuthoritySupervisorArtifact> => {
  try {
    return await openAuthoritySupervisorArtifact();
  } catch {
    throw new BoundedProcessContainmentUnavailableError("authority_backend_unavailable");
  }
};

const authorityArtifactMatchesJournal = (
  artifact: ResolvedAuthoritySupervisorArtifact,
  journal: AuthorityProcessRecoveryJournal,
): boolean => artifact.architecture === journal.architecture && artifact.sha256 === journal.helperSha256;

const authorityHelperCleanupProven = (
  journal: AuthorityPreparedRecoveryJournal
    | AuthorityArmedRecoveryJournal
    | AuthorityGoAttemptedRecoveryJournal,
): boolean => {
  const relationship = boundedProcessCustodyRelationship(journal);
  if (relationship === "old_boot") return true;
  if (relationship !== "current") return false;
  const outerGone = linuxProcessIdentityProvenGone(journal.outerPid, journal.outerStartTime);
  if (journal.state !== "go_attempted") {
    // These states are written before GO. Once the outer helper is gone, its
    // gate cannot release and no provider target could have begun.
    return outerGone;
  }
  // After GO may have been attempted, prove both recorded namespace owners
  // are gone. Start-time comparison remains safe across numeric PID reuse.
  return outerGone
    && linuxProcessIdentityProvenGone(journal.initHostPid, journal.initStartTime);
};

const authorityRecoveryReadyTimeoutMs = 2_000;
const authorityRecoveryCleanTimeoutMs = 6_000;
const authorityRecoveryExitMarginMs = 2_000;
const authorityRecoveryChildCloseTimeoutMs = authorityRecoveryReadyTimeoutMs
  + authorityRecoveryCleanTimeoutMs
  + authorityRecoveryExitMarginMs;

export const authorityRecoveryTimingForTesting = (): Readonly<{
  childCloseTimeoutMs: number;
  cleanTimeoutMs: number;
  exitMarginMs: number;
  readyTimeoutMs: number;
}> => ({
  childCloseTimeoutMs: authorityRecoveryChildCloseTimeoutMs,
  cleanTimeoutMs: authorityRecoveryCleanTimeoutMs,
  exitMarginMs: authorityRecoveryExitMarginMs,
  readyTimeoutMs: authorityRecoveryReadyTimeoutMs,
});

const runAuthorityRecoveryHelperLocked = async (
  directory: string,
  journal: AuthorityPreparedRecoveryJournal
    | AuthorityArmedRecoveryJournal
    | AuthorityGoAttemptedRecoveryJournal,
): Promise<boolean> => {
  if (boundedProcessCustodyRelationship(journal) !== "current") return false;
  let opened: OpenAuthoritySupervisorArtifact | undefined;
  try {
    opened = await openAuthoritySupervisorArtifact();
  } catch {
    return false;
  }
  try {
    if (!authorityArtifactMatchesJournal(opened.artifact, journal)) return false;
    const identity = authorityJournalIdentity(journal);
    let endpoint: AuthorityControlEndpoint | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      endpoint = await AuthorityControlEndpoint.create(directory);
      const nonce = randomBytes(16).toString("hex");
      const executionPath = opened.executionPath;
      child = spawn(executionPath, [
        "--control-socket",
        endpoint.path,
        "--nonce",
        nonce,
        "--terminate",
        "--outer-pid",
        String(identity.outer.pid),
        "--outer-start-time",
        identity.outer.startTime,
        "--boot-id",
        identity.bootId,
        "--init-host-pid",
        String(identity.namespaceInit.pid),
        "--init-start-time",
        identity.namespaceInit.startTime,
        "--init-pid-namespace-inode",
        identity.namespaceInit.pidNamespaceInode,
      ], {
        cwd: directory,
        detached: false,
        // The static recovery helper needs no provider or user environment.
        // Keep ambient credentials and target configuration out of this trusted
        // infrastructure process.
        env: {},
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const close = waitForChildClose(child, authorityRecoveryChildCloseTimeoutMs);
      void close.catch(() => undefined);
      await waitForChildSpawn(child, 2_000);
      await opened.close();
      opened = undefined;
      child.stdin.end();
      child.stdout.resume();
      child.stderr.resume();
      const recoveryPid = child.pid;
      const recoveryStartTime = recoveryPid === undefined
        ? undefined
        : readLinuxProcessStartTime(recoveryPid);
      if (recoveryPid === undefined || recoveryStartTime === undefined) {
        throw new AuthorityControlProtocolError("recovery_child_identity_unavailable");
      }
      const recoveryIdentity = { pid: recoveryPid, startTime: recoveryStartTime } as const;
      const ready = await endpoint.nextFrame(authorityRecoveryReadyTimeoutMs);
      assertAuthorityRecoveryReadyFrame(ready, nonce, identity, recoveryIdentity);
      await endpoint.write(`${authorityProtocolPrefix}RECOVERY_GO nonce=${nonce}\n`);
      const clean = await endpoint.nextFrame(authorityRecoveryCleanTimeoutMs);
      assertAuthorityRecoveryCleanFrame(clean, nonce, identity, recoveryIdentity);
      const exit = await close;
      if (exit.code !== 0 || exit.signal !== null) return false;
      await endpoint.waitForEnd(1_000);
      endpoint.assertComplete();
      return true;
    } catch {
      if (child !== undefined) await stopDirectAuthorityHelperBeforeGo(child);
      return false;
    } finally {
      await endpoint?.close().catch(() => undefined);
    }
  } finally {
    await opened?.close().catch(() => undefined);
  }
};

const assertAuthorityTransitionTemporaryFile = (
  path: string,
  expectedLinkCount: number,
): Stats => {
  const uid = process.getuid?.();
  const metadata = lstatSync(path);
  const mode = metadata.mode & 0o777;
  if (
    uid === undefined
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.nlink !== expectedLinkCount
    || mode & ~0o600
    || expectedLinkCount > 1 && mode !== 0o600
    || metadata.size > authorityJournalMaximumBytes
  ) throw new BoundedProcessRecoveryJournalError([path], "authority_transition_incomplete");
  return metadata;
};

const incompleteAuthorityReplacementIdentity = (path: string): Stats | undefined => {
  const metadata = assertAuthorityTransitionTemporaryFile(path, 1);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let document = Buffer.alloc(0);
  try {
    const opened = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !sameFileIdentity(metadata, opened)
      || opened.uid !== uid
      || opened.nlink !== 1
      || (opened.mode & 0o777) & ~0o600
      || opened.size !== metadata.size
    ) throw new BoundedProcessRecoveryJournalError(
      [path],
      "authority_transition_incomplete",
    );
    try {
      assertSafeDarwinInstallAcl(descriptor, uid, path);
    } catch {
      throw new BoundedProcessRecoveryJournalError(
        [path],
        "authority_transition_incomplete",
      );
    }
    document = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (
      !sameFileIdentity(opened, afterDescriptor)
      || !sameFileIdentity(opened, afterPath)
      || afterDescriptor.uid !== opened.uid
      || afterDescriptor.nlink !== 1
      || (afterDescriptor.mode & 0o777) !== (opened.mode & 0o777)
      || afterDescriptor.size !== opened.size
      || afterPath.uid !== opened.uid
      || afterPath.nlink !== 1
      || (afterPath.mode & 0o777) !== (opened.mode & 0o777)
      || afterPath.size !== opened.size
    ) throw new BoundedProcessRecoveryJournalError(
      [path],
      "authority_transition_incomplete",
    );
    // Every completed writer document ends with exactly one newline. A zero
    // length or non-newline-terminated exact O_EXCL temp is therefore a torn
    // legacy replacement, while a complete invalid document remains a
    // blocker for the strict parser below.
    return document.byteLength === 0 || document[document.byteLength - 1] !== 0x0a
      ? afterPath
      : undefined;
  } finally {
    document.fill(0);
    closeSync(descriptor);
  }
};

type AuthorityReplacementCreationArtifact = Readonly<{
  finalName: string;
  mainName: string;
  temporaryName: string;
}>;

const reconcileAuthorityReplacementCreationArtifactsLocked = (
  directory: string,
  names: readonly string[],
  directoryDescriptor: number,
): readonly string[] => {
  const namesSet = new Set(names);
  const artifacts: AuthorityReplacementCreationArtifact[] = [];
  const finalNames = new Set<string>();
  for (const name of names) {
    const creation = authorityJournalReplacementCreationNamePattern.exec(name);
    if (creation === null) continue;
    const nameIdentity = custodyNameIdentityFromMatch(creation);
    const token = creation.groups?.token;
    const replacementToken = creation.groups?.replacement;
    if (
      nameIdentity === undefined
      || token === undefined
      || replacementToken === undefined
    ) {
      throw new BoundedProcessRecoveryJournalError(
        [join(directory, name)],
        "authority_transition_incomplete",
      );
    }
    const custodyPrefix = custodyNamePrefixFromNameIdentity(nameIdentity);
    const mainName = `authority-${custodyPrefix}-${token}.json`;
    const finalName = `${mainName}.replace-${replacementToken}`;
    const allowed = new Set([mainName, finalName, name]);
    const collisions = names.filter((candidate) => (
      candidate.startsWith(`authority-${custodyPrefix}-${token}.`) && !allowed.has(candidate)
    ));
    if (
      finalNames.has(finalName)
      || !namesSet.has(mainName)
      || collisions.length > 0
    ) throw new BoundedProcessRecoveryJournalError(
      [mainName, finalName, name, ...collisions]
        .map((candidate) => join(directory, candidate)),
      "authority_transition_incomplete",
    );
    finalNames.add(finalName);
    artifacts.push({ finalName, mainName, temporaryName: name });
  }

  for (const artifact of artifacts) {
    const finalPath = join(directory, artifact.finalName);
    const mainPath = join(directory, artifact.mainName);
    const temporaryPath = join(directory, artifact.temporaryName);
    const mainBefore = lstatSync(mainPath);
    const current = parseAuthorityRecoveryJournal(mainPath);
    const mainAfter = lstatSync(mainPath);
    if (!sameFileIdentity(mainBefore, mainAfter)) {
      throw new BoundedProcessRecoveryJournalError(
        [mainPath, temporaryPath],
        "authority_transition_incomplete",
      );
    }
    if (!namesSet.has(artifact.finalName)) {
      const before = assertAuthorityTransitionTemporaryFile(temporaryPath, 1);
      const after = lstatSync(temporaryPath);
      if (!sameFileIdentity(before, after)) {
        throw new BoundedProcessRecoveryJournalError(
          [temporaryPath],
          "authority_transition_incomplete",
        );
      }
      unlinkSync(temporaryPath);
      fsyncSync(directoryDescriptor);
    } else {
      const temporary = assertAuthorityTransitionTemporaryFile(temporaryPath, 2);
      const final = assertAuthorityTransitionTemporaryFile(finalPath, 2);
      if (!sameFileIdentity(temporary, final)) {
        throw new BoundedProcessRecoveryJournalError(
          [finalPath, temporaryPath],
          "authority_transition_incomplete",
        );
      }
      unlinkSync(temporaryPath);
      fsyncSync(directoryDescriptor);
      const next = parseAuthorityRecoveryJournal(finalPath);
      if (!validAuthorityJournalTransition(current, next)) {
        throw new BoundedProcessRecoveryJournalError(
          [mainPath, finalPath],
          "authority_transition_incomplete",
        );
      }
    }
    const persisted = parseAuthorityRecoveryJournal(mainPath);
    if (!sameAuthorityJournal(persisted, current)) {
      throw new BoundedProcessRecoveryJournalError(
        [mainPath],
        "authority_transition_incomplete",
      );
    }
  }
  return names.filter((name) => !authorityJournalReplacementCreationNamePattern.test(name));
};

const reconcileAuthorityTransitionArtifactsLocked = (
  directory: string,
  names: readonly string[],
): readonly string[] => {
  const directoryDescriptor = openRecoveryDirectory(directory);
  let creationReconciledNames: readonly string[] = names;
  try {
    creationReconciledNames = reconcileAuthorityReplacementCreationArtifactsLocked(
      directory,
      names,
      directoryDescriptor,
    );
    const namesSet = new Set(creationReconciledNames);
    const temporaryByMain = new Map<string, string>();
    for (const name of creationReconciledNames) {
      const creation = authorityJournalCreationNamePattern.exec(name);
      const replacement = authorityJournalReplacementNamePattern.exec(name);
      const nameIdentity = custodyNameIdentityFromMatch(creation ?? replacement);
      const token = creation?.groups?.token ?? replacement?.groups?.token;
      if (nameIdentity === undefined || token === undefined) continue;
      const custodyPrefix = custodyNamePrefixFromNameIdentity(nameIdentity);
      const mainName = `authority-${custodyPrefix}-${token}.json`;
      if (temporaryByMain.has(mainName)) {
        throw new BoundedProcessRecoveryJournalError(
          [join(directory, mainName), join(directory, name)],
          "authority_transition_incomplete",
        );
      }
      temporaryByMain.set(mainName, name);
    }

    for (const [mainName, temporaryName] of temporaryByMain) {
      const mainPath = join(directory, mainName);
      const temporaryPath = join(directory, temporaryName);
      if (authorityJournalCreationNamePattern.test(temporaryName)) {
        if (!namesSet.has(mainName)) {
          const before = assertAuthorityTransitionTemporaryFile(temporaryPath, 1);
          const after = lstatSync(temporaryPath);
          if (!sameFileIdentity(before, after)) {
            throw new BoundedProcessRecoveryJournalError(
              [temporaryPath],
              "authority_transition_incomplete",
            );
          }
          unlinkSync(temporaryPath);
          fsyncSync(directoryDescriptor);
          continue;
        }
        const temporary = assertAuthorityTransitionTemporaryFile(temporaryPath, 2);
        const main = assertAuthorityTransitionTemporaryFile(mainPath, 2);
        if (!sameFileIdentity(temporary, main)) {
          throw new BoundedProcessRecoveryJournalError(
            [mainPath, temporaryPath],
            "authority_transition_incomplete",
          );
        }
        unlinkSync(temporaryPath);
        fsyncSync(directoryDescriptor);
        const persisted = parseAuthorityRecoveryJournal(mainPath);
        if (persisted.state !== "intent") {
          throw new BoundedProcessRecoveryJournalError(
            [mainPath],
            "authority_transition_incomplete",
          );
        }
        continue;
      }

      if (!namesSet.has(mainName)) {
        throw new BoundedProcessRecoveryJournalError(
          [mainPath, temporaryPath],
          "authority_transition_incomplete",
        );
      }
      const mainBefore = lstatSync(mainPath);
      const current = parseAuthorityRecoveryJournal(mainPath);
      const mainAfter = lstatSync(mainPath);
      if (!sameFileIdentity(mainBefore, mainAfter)) {
        throw new BoundedProcessRecoveryJournalError(
          [mainPath, temporaryPath],
          "authority_transition_incomplete",
        );
      }
      const incomplete = incompleteAuthorityReplacementIdentity(temporaryPath);
      if (incomplete !== undefined) {
        const beforeUnlink = lstatSync(temporaryPath);
        if (!sameFileIdentity(incomplete, beforeUnlink)) {
          throw new BoundedProcessRecoveryJournalError(
            [temporaryPath],
            "authority_transition_incomplete",
          );
        }
        unlinkSync(temporaryPath);
        fsyncSync(directoryDescriptor);
        const persisted = parseAuthorityRecoveryJournal(mainPath);
        if (!sameAuthorityJournal(persisted, current)) {
          throw new BoundedProcessRecoveryJournalError(
            [mainPath],
            "authority_transition_incomplete",
          );
        }
        continue;
      }
      const temporaryBefore = lstatSync(temporaryPath);
      const next = parseAuthorityRecoveryJournal(temporaryPath);
      const temporaryAfter = lstatSync(temporaryPath);
      if (
        !validAuthorityJournalTransition(current, next)
        || !sameFileIdentity(temporaryBefore, temporaryAfter)
      ) throw new BoundedProcessRecoveryJournalError(
        [mainPath, temporaryPath],
        "authority_transition_incomplete",
      );
      unlinkSync(temporaryPath);
      fsyncSync(directoryDescriptor);
      const persisted = parseAuthorityRecoveryJournal(mainPath);
      if (!sameAuthorityJournal(persisted, current)) {
        throw new BoundedProcessRecoveryJournalError(
          [mainPath],
          "authority_transition_incomplete",
        );
      }
    }
  } finally {
    closeSync(directoryDescriptor);
  }
  return creationReconciledNames.filter((name) => (
    !authorityJournalCreationNamePattern.test(name)
    && !authorityJournalReplacementNamePattern.test(name)
    && !authorityJournalReplacementCreationNamePattern.test(name)
  ));
};

const recoverAuthorityProcessJournalLocked = async (directory: string): Promise<void> => {
  const directoryDescriptor = openRecoveryDirectory(directory);
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name !== recoveryLockName)
      .sort();
  } finally {
    closeSync(directoryDescriptor);
  }
  if (names.length > 128) {
    throw new BoundedProcessRecoveryJournalError([directory], "entry_limit_exceeded");
  }
  assertRecoveryEntryNamesRecognized(directory, names);
  assertJournalNameCustodySafe(directory, names, "authority");
  assertJournalNameCustodySafe(directory, names, "process");
  preflightJournalDocumentCustodyIdentities(directory, names);
  removeStaleAuthorityControlSocketsLocked(directory);
  const reconciledNames = reconcileAuthorityTransitionArtifactsLocked(directory, names);
  let cleanupFailure: BoundedProcessCleanupUnprovenError | undefined;
  for (const name of reconciledNames) {
    const path = join(directory, name);
    if (name.startsWith("authority-") && !authorityJournalNamePattern.test(name)) {
      throw new BoundedProcessRecoveryJournalError([path], "authority_entry_name_invalid");
    }
    if (!authorityJournalNamePattern.test(name)) continue;
    const journal = parseAuthorityRecoveryJournal(path);
    if (journal.state === "intent") {
      if (!removeAuthorityRecoveryJournal(path, journal)) {
        throw new BoundedProcessRecoveryJournalError([path], "authority_entry_changed");
      }
      continue;
    }
    const cleanupAlreadyProven = authorityHelperCleanupProven(journal);
    const recovered = cleanupAlreadyProven
      ? false
      : await runAuthorityRecoveryHelperLocked(directory, journal);
    if (cleanupAlreadyProven || recovered) {
      if (!removeAuthorityRecoveryJournal(path, journal)) {
        throw new BoundedProcessRecoveryJournalError([path], "authority_entry_changed");
      }
      continue;
    }
    const current = new BoundedProcessCleanupUnprovenError(
      authorityJournalIdentity(journal),
      journal.phase,
    ).retainRecoveryPath(path);
    if (cleanupFailure === undefined) cleanupFailure = current;
    else cleanupFailure.include(current);
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
};

const recoverAllBoundedProcessJournalsLocked = async (directory: string): Promise<void> => {
  // Authority goes first. If its exact pidfd recovery cannot prove custody,
  // local PGID work must not continue as though the provider lane were clear.
  await recoverAuthorityProcessJournalLocked(directory);
  recoverBoundedProcessJournalLocked(directory);
};

export const recoverBoundedProcessJournal = async (
  dependencies: Readonly<{ recoveryDirectory?: string }> = {},
): Promise<void> => {
  const directory = dependencies.recoveryDirectory
    ?? boundedProcessRecoveryDirectory();
  const lockDescriptor = acquireRecoveryLock(directory);
  try {
    await recoverAllBoundedProcessJournalsLocked(directory);
  } finally {
    releaseRecoveryLock(lockDescriptor);
  }
};

const signalProcessGroup = (
  negativeProcessGroupId: number,
  signal: NodeJS.Signals,
): void => {
  try {
    process.kill(negativeProcessGroupId, signal);
  } catch (error: unknown) {
    if (errnoCode(error) !== "ESRCH") throw error;
  }
};

const invalidRequest = (request: BoundedProcessRequest): boolean =>
  !phasePattern.test(request.phase)
  || !Number.isSafeInteger(request.outputMaximumBytes)
  || request.outputMaximumBytes < 1
  || !Number.isSafeInteger(request.timeoutMs)
  || request.timeoutMs < 1
  || !Number.isSafeInteger(request.terminationGraceMs)
  || request.terminationGraceMs < 1
  || request.killSettlementMs !== undefined
    && (!Number.isSafeInteger(request.killSettlementMs) || request.killSettlementMs < 1);

type BoundedProcessDependencies = Readonly<{
  /** Test-only delay/failure point after durable GO intent but before release. */
  afterAuthorityGoJournal?: () => void;
  beforeJournalPromotion?: () => void;
  /** Test-only narrowing switch. It can only refuse authority execution. */
  forceAuthorityUnavailable?: boolean;
  recoveryDirectory?: string;
}>;

const executionGateProgram = [
  "IFS= read -r hra_gate || exit 125",
  '[ "$hra_gate" = "hra-release-v1" ] || exit 125',
  'exec "$@"',
].join("; ");

const executionGateInput = (stdin: string | undefined): string =>
  `hra-release-v1\n${stdin ?? ""}`;

const authorityUnprovenResult = (
  journal: AuthorityPreparedRecoveryJournal
    | AuthorityArmedRecoveryJournal
    | AuthorityGoAttemptedRecoveryJournal,
  path: string,
  output: Readonly<{ stderr: Buffer; stdout: Buffer }>,
): AuthorityBoundedProcessUnprovenResult => ({
  cleanup: "unproven",
  phase: journal.phase,
  recoveryIdentity: authorityJournalIdentity(journal),
  recoveryPath: path,
  ...output,
});

const authorityAbortRequested = (state: Readonly<{ requested: boolean }>): boolean =>
  state.requested;

const closeOriginalAuthorityChildAfterRecovery = async (
  close: Promise<unknown>,
): Promise<boolean> => await Promise.race([
  close.then(() => true, () => false),
  new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), 1_000);
    timer.unref();
  }),
]);

const runAuthorityBoundedProcess = async (
  request: BoundedProcessRequest,
  dependencies: BoundedProcessDependencies,
): Promise<BoundedProcessResult> => {
  if (process.platform !== "linux") {
    throw new BoundedProcessContainmentUnavailableError("authority_unsupported_platform");
  }
  if (dependencies.forceAuthorityUnavailable === true || !isAbsolute(request.executable)) {
    throw new BoundedProcessContainmentUnavailableError("authority_backend_unavailable");
  }
  const recoveryDirectory = dependencies.recoveryDirectory
    ?? boundedProcessRecoveryDirectory();
  const lockDescriptor = acquireRecoveryLock(recoveryDirectory);
  let opened: OpenAuthoritySupervisorArtifact | undefined;
  try {
    await recoverAllBoundedProcessJournalsLocked(recoveryDirectory);
    opened = await openAuthorityArtifactForLaunch();
    const artifact = opened.artifact;
    const intent = writeAuthorityIntentRecoveryJournal(
      recoveryDirectory,
      request.phase,
      { architecture: artifact.architecture, sha256: artifact.sha256 },
    );
    let current: AuthorityProcessRecoveryJournal = intent.journal;
    let endpoint: AuthorityControlEndpoint | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let childClose: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    const outputState = { overflow: false };
    let abort!: (exitCode: number) => void;
    const abortState = { requested: false };
    const abortPromise = new Promise<Readonly<{ exitCode: number }>>((resolvePromise) => {
      abort = (exitCode) => {
        if (abortState.requested) return;
        abortState.requested = true;
        resolvePromise({ exitCode });
      };
    });
    const deadline = performance.now() + request.timeoutMs;
    const remaining = (): number => Math.max(1, Math.ceil(deadline - performance.now()));
    const output = (): Readonly<{ stderr: Buffer; stdout: Buffer }> => ({
      stderr: Buffer.concat(stderrChunks),
      stdout: Buffer.concat(stdoutChunks),
    });
    const unresolvedAuthorityJournal = (): AuthorityPreparedRecoveryJournal
      | AuthorityArmedRecoveryJournal
      | AuthorityGoAttemptedRecoveryJournal => {
      if (current.state === "intent") {
        throw new BoundedProcessRecoveryJournalError([intent.path], "authority_intent_recovery_unreachable");
      }
      return current;
    };
    const clearIntent = (): void => {
      if (current.state !== "intent" || !removeAuthorityRecoveryJournal(intent.path, current)) {
        throw new BoundedProcessRecoveryJournalError([intent.path], "authority_entry_changed");
      }
    };
    const recoverCurrent = async (): Promise<boolean> => {
      if (current.state === "intent") {
        if (child !== undefined) await stopDirectAuthorityHelperBeforeGo(child);
        clearIntent();
        return true;
      }
      const recovered = await runAuthorityRecoveryHelperLocked(recoveryDirectory, current);
      if (!recovered && !authorityHelperCleanupProven(current)) return false;
      if (childClose !== undefined && !await closeOriginalAuthorityChildAfterRecovery(childClose)) {
        return false;
      }
      if (!removeAuthorityRecoveryJournal(intent.path, current)) {
        throw new BoundedProcessRecoveryJournalError([intent.path], "authority_entry_changed");
      }
      return true;
    };
    try {
      endpoint = await AuthorityControlEndpoint.create(recoveryDirectory);
      const nonce = randomBytes(16).toString("hex");
      const executionPath = opened.executionPath;
      child = spawn(executionPath, [
        "--control-socket",
        endpoint.path,
        "--nonce",
        nonce,
        "--",
        request.executable,
        ...request.arguments,
      ], {
        cwd: request.cwd,
        detached: false,
        env: request.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      childClose = waitForChildClose(child, request.timeoutMs + 8_000);
      void childClose.catch(() => undefined);
      await waitForChildSpawn(child, Math.min(2_000, remaining()));
      await opened.close();
      opened = undefined;
      const append = (target: Buffer[], chunk: Buffer): void => {
        const available = request.outputMaximumBytes - capturedBytes;
        if (available > 0) {
          const captured = chunk.subarray(0, available);
          target.push(Buffer.from(captured));
          capturedBytes += captured.byteLength;
        }
        if (chunk.byteLength > available) {
          outputState.overflow = true;
          abort(1);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk));
      child.stdin.once("error", () => undefined);

      let readyFrame: AuthorityControlFrame;
      try {
        readyFrame = await endpoint.nextFrame(remaining());
      } catch {
        const recovered = await recoverCurrent();
        if (!recovered) return authorityUnprovenResult(
          unresolvedAuthorityJournal(),
          intent.path,
          output(),
        );
        return {
          cleanup: "proven",
          exitCode: 124,
          ...output(),
        };
      }
      if (readyFrame.kind === "FAIL") {
        assertAuthorityFailFrame(readyFrame, nonce);
        // The outer catch owns the one pre-GO cleanup. Cleaning here as well
        // would remove the intent twice and misclassify a typed refusal as a
        // recovery-journal identity change.
        throw new BoundedProcessContainmentUnavailableError("authority_backend_unavailable");
      }
      let authorityDeadlineMonotonicMs: bigint;
      let identity: Extract<BoundedProcessRecoveryIdentity, { containment: "authority" }>;
      try {
        const announced = authorityLaunchReadyIdentity(readyFrame, nonce);
        authorityDeadlineMonotonicMs = announced.monotonicMilliseconds + BigInt(remaining());
        if (authorityDeadlineMonotonicMs > 18_446_744_073_709_551_615n) {
          throw new AuthorityControlProtocolError("deadline_overflow");
        }
        identity = {
          bootId: announced.bootId,
          containment: "authority",
          namespaceInit: announced.namespaceInit,
          outer: announced.outer,
        };
        const prepared = preparedAuthorityJournal(intent.journal, identity);
        current = replaceAuthorityRecoveryJournal(
          intent.path,
          intent.journal,
          prepared,
        );
        verifyAuthorityLaunchIdentity(identity, child.pid);
        const armed = armedAuthorityJournal(prepared);
        current = replaceAuthorityRecoveryJournal(
          intent.path,
          prepared,
          armed,
        );
      } catch {
        const recovered = await recoverCurrent();
        if (!recovered) return authorityUnprovenResult(
          unresolvedAuthorityJournal(),
          intent.path,
          output(),
        );
        throw new BoundedProcessContainmentUnavailableError("authority_backend_unavailable");
      }
      if (authorityAbortRequested(abortState) || remaining() < 2) {
        const recovered = await recoverCurrent();
        if (!recovered) return authorityUnprovenResult(
          unresolvedAuthorityJournal(),
          intent.path,
          output(),
        );
        return {
          cleanup: "proven",
          exitCode: outputState.overflow ? 1 : 124,
          ...output(),
        };
      }
      if (!isAuthorityArmedRecoveryJournal(current)) {
        throw new BoundedProcessRecoveryJournalError([intent.path], "authority_state_invalid");
      }
      const goJournal = goAttemptedAuthorityJournal(current);
      current = replaceAuthorityRecoveryJournal(
        intent.path,
        current,
        goJournal,
      );
      dependencies.afterAuthorityGoJournal?.();
      if (authorityAbortRequested(abortState) || remaining() < 2) {
        const recovered = await recoverCurrent();
        if (!recovered) return authorityUnprovenResult(
          unresolvedAuthorityJournal(),
          intent.path,
          output(),
        );
        return {
          cleanup: "proven",
          exitCode: outputState.overflow ? 1 : 124,
          ...output(),
        };
      }
      await endpoint.write(
        `${authorityProtocolPrefix}GO nonce=${nonce} deadline_monotonic_ms=${authorityDeadlineMonotonicMs.toString()}\n`,
      );
      child.stdin.end(request.stdin ?? "", "utf8");

      const cleanFrame = endpoint.nextFrame(remaining());
      const raced = await Promise.race([
        cleanFrame.then((frame) => ({ kind: "frame" as const, frame })),
        abortPromise.then((result) => ({ ...result, kind: "abort" as const })),
      ]);
      if (raced.kind === "abort") {
        const recovered = await recoverCurrent();
        if (!recovered) return authorityUnprovenResult(goJournal, intent.path, output());
        return { cleanup: "proven", exitCode: raced.exitCode, ...output() };
      }
      const cleanExit = assertAuthorityCleanFrame(raced.frame, nonce);
      const directExit = await childClose;
      await endpoint.waitForEnd(Math.min(1_000, remaining()));
      endpoint.assertComplete();
      if (
        directExit.code !== cleanExit
        || directExit.signal !== null
        || outputState.overflow
        || authorityAbortRequested(abortState)
      ) {
        const recovered = await recoverCurrent();
        if (!recovered) return authorityUnprovenResult(goJournal, intent.path, output());
        return {
          cleanup: "proven",
          exitCode: outputState.overflow ? 1 : 124,
          ...output(),
        };
      }
      if (!removeAuthorityRecoveryJournal(intent.path, goJournal)) {
        throw new BoundedProcessRecoveryJournalError([intent.path], "authority_entry_changed");
      }
      return { cleanup: "proven", exitCode: cleanExit, ...output() };
    } catch (error: unknown) {
      if (current.state === "go_attempted") {
        const recovered = await recoverCurrent();
        if (!recovered) return authorityUnprovenResult(current, intent.path, output());
        return { cleanup: "proven", exitCode: 1, ...output() };
      } else {
        const recovered = await recoverCurrent();
        if (!recovered) return authorityUnprovenResult(
          unresolvedAuthorityJournal(),
          intent.path,
          output(),
        );
      }
      if (isBoundedProcessRecoveryJournalError(error)) throw error;
      if (isBoundedProcessContainmentUnavailableError(error)) throw error;
      throw new BoundedProcessContainmentUnavailableError("authority_backend_unavailable");
    } finally {
      await endpoint?.close().catch(() => undefined);
    }
  } finally {
    await opened?.close().catch(() => undefined);
    releaseRecoveryLock(lockDescriptor);
  }
};

export const runBoundedProcess = async (
  request: BoundedProcessRequest,
  dependencies: BoundedProcessDependencies = {},
): Promise<BoundedProcessResult> => {
  if (invalidRequest(request) || process.platform === "win32") {
    return {
      cleanup: "proven",
      exitCode: 1,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    };
  }
  if (request.containment === "authority") {
    return await runAuthorityBoundedProcess(request, dependencies);
  }
  const phase = request.phase;
  const recoveryDirectory = dependencies.recoveryDirectory
    ?? boundedProcessRecoveryDirectory();
  const lockDescriptor = acquireRecoveryLock(recoveryDirectory);
  let pending: ReturnType<typeof writePendingRecoveryJournal>;
  try {
    // This is intentionally under the same lock retained through the child
    // lifetime. A second invocation cannot pass either authority pidfd
    // recovery or local PGID recovery and then launch while the first
    // operation still owns a live boundary.
    await recoverAllBoundedProcessJournalsLocked(recoveryDirectory);
    pending = writePendingRecoveryJournal(recoveryDirectory, phase);
  } catch (error: unknown) {
    releaseRecoveryLock(lockDescriptor);
    throw error;
  }
  return await new Promise<BoundedProcessResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("/bin/sh", [
        "-c",
        executionGateProgram,
        "hra-process-gate",
        request.executable,
        ...request.arguments,
      ], {
        cwd: request.cwd,
        detached: true,
        env: request.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      try {
        removeRecoveryJournal(pending.path, pending.journal);
      } catch {
        // Startup recovery can safely remove a stale pending intent.
      }
      resolvePromise({
        cleanup: "proven",
        exitCode: 1,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      });
      return;
    }

    const negativeProcessGroupId = child.pid === undefined ? undefined : -child.pid;
    const processGroupId = negativeProcessGroupId === undefined ? undefined : -negativeProcessGroupId;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let overflow = false;
    let settled = false;
    let stopping = false;
    let leaderClosed = false;
    let observedExitCode = 1;
    let forcedExitCode: number | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    let quiescenceTimer: ReturnType<typeof setTimeout> | undefined;
    let recoveryPath = pending.path;
    let recoveryJournal: ProcessRecoveryJournal = pending.journal;
    let journalActive = false;
    let journalActivationError: BoundedProcessRecoveryJournalError | undefined;
    if (!safeProcessGroupId(processGroupId ?? 0)) {
      journalActivationError = new BoundedProcessRecoveryJournalError(
        [recoveryPath],
        "execution_gate_invalid",
      );
    } else if (processGroupId !== undefined) {
      try {
        dependencies.beforeJournalPromotion?.();
        const active = promoteRecoveryJournal(
          recoveryPath,
          pending.journal,
          processGroupId,
          pending.token,
        );
        recoveryPath = active.path;
        recoveryJournal = active.journal;
        journalActive = true;
      } catch (error: unknown) {
        journalActivationError = isBoundedProcessRecoveryJournalError(error)
          ? error
          : new BoundedProcessRecoveryJournalError([recoveryPath], "promotion_failed");
      }
    }

    const groupExists = (): boolean => negativeProcessGroupId !== undefined
      && processGroupExists(negativeProcessGroupId);
    const clearTimers = (): void => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
      if (quiescenceTimer !== undefined) clearTimeout(quiescenceTimer);
      clearTimeout(timeoutTimer);
    };
    const finish = (cleanup: BoundedProcessResult["cleanup"]): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      const output = {
        stderr: Buffer.concat(stderrChunks),
        stdout: Buffer.concat(stdoutChunks),
      };
      if (cleanup === "unproven" && !journalActive) {
        // A failed promotion never releases the target. The detached gate may
        // still be settling, but it has no writer and therefore cannot execute
        // authority. Surface the journal failure instead of a normal result.
        child.unref();
        rejectPromise(journalActivationError ?? new BoundedProcessRecoveryJournalError(
          [recoveryPath],
          "promotion_failed",
        ));
        return;
      }
      if (cleanup === "proven") {
        try {
          removeRecoveryJournal(recoveryPath, recoveryJournal);
        } catch {
          // An active stale entry is removed only after startup proves ESRCH;
          // a pending stale entry is safe because its gate was never released.
        }
        if (journalActivationError !== undefined) {
          rejectPromise(journalActivationError);
          return;
        }
      }
      if (cleanup === "unproven") child.unref();
      resolvePromise(cleanup === "proven"
        ? {
            cleanup,
            exitCode: overflow ? 1 : (forcedExitCode ?? observedExitCode),
            ...output,
          }
        : {
            cleanup,
            phase,
            processGroupId: processGroupId ?? 0,
            recoveryIdentity: localRecoveryIdentity(processGroupId ?? 0),
            recoveryPath,
            ...output,
          });
    };
    const scheduleQuiescenceCheck = (): void => {
      if (settled || quiescenceTimer !== undefined) return;
      quiescenceTimer = setTimeout(() => {
        quiescenceTimer = undefined;
        if (leaderClosed && !groupExists()) {
          finish("proven");
          return;
        }
        if (!settled && stopping) scheduleQuiescenceCheck();
      }, 10);
    };
    const beginTermination = (exitCode: number): void => {
      if (settled) return;
      forcedExitCode ??= exitCode;
      if (stopping) return;
      stopping = true;
      if (negativeProcessGroupId !== undefined) {
        try {
          signalProcessGroup(negativeProcessGroupId, "SIGTERM");
        } catch {
          forcedExitCode = 1;
        }
      }
      if (leaderClosed && !groupExists()) {
        finish("proven");
        return;
      }
      scheduleQuiescenceCheck();
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (negativeProcessGroupId !== undefined && groupExists()) {
          try {
            signalProcessGroup(negativeProcessGroupId, "SIGKILL");
          } catch {
            forcedExitCode = 1;
          }
        }
        if (leaderClosed && !groupExists()) {
          finish("proven");
          return;
        }
        scheduleQuiescenceCheck();
        settlementTimer = setTimeout(() => {
          settlementTimer = undefined;
          finish(leaderClosed && !groupExists() ? "proven" : "unproven");
        }, request.killSettlementMs ?? 100);
      }, request.terminationGraceMs);
    };
    const append = (target: Buffer[], chunk: Buffer): void => {
      const remaining = request.outputMaximumBytes - capturedBytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        target.push(Buffer.from(captured));
        capturedBytes += captured.byteLength;
      }
      if (chunk.byteLength > remaining) {
        overflow = true;
        beginTermination(1);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      append(stdoutChunks, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(stderrChunks, chunk);
    });
    child.once("error", () => {
      if (negativeProcessGroupId === undefined) {
        leaderClosed = true;
        finish("proven");
      }
      else beginTermination(1);
    });
    child.once("close", (code, signal) => {
      leaderClosed = true;
      observedExitCode = code ?? (signal === null ? 1 : 128);
      if (stopping) {
        if (!groupExists()) finish("proven");
        else scheduleQuiescenceCheck();
        return;
      }
      if (groupExists()) beginTermination(1);
      else finish("proven");
    });
    child.stdin.once("error", () => undefined);
    const timeoutTimer = setTimeout(
      () => beginTermination(journalActivationError === undefined ? 124 : 1),
      journalActivationError === undefined ? request.timeoutMs : 0,
    );
    if (journalActivationError === undefined) {
      child.stdin.end(executionGateInput(request.stdin), "utf8");
    } else {
      child.stdin.destroy();
    }
  }).finally(() => {
    releaseRecoveryLock(lockDescriptor);
  });
};
