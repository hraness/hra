#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants, readSync, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isatty } from "node:tty";

import { z } from "zod";

import {
  acceptanceInstallationDescriptorSchema,
  type AcceptanceInstallationDescriptor,
} from "./live-acceptance-installation";
import {
  commandResponseSchema,
  localCommandSchema,
  type CommandResponse,
  type LocalCommand,
} from "../src/domain/contracts";
import { DaemonLock, readDaemonAuthorityReceipt } from "../src/daemon/daemon-lock";
import { DEFAULT_CLOUD_DEPLOYMENT_URL } from "../src/cloud/identity-custody";
import { resolveStatePaths } from "../src/storage/paths";
import { HRA_VERSION } from "../src/version";

export const LIVE_ACCEPTANCE_CONTROL_FD = 0;
export const LIVE_ACCEPTANCE_STATUS_FD = 1;
export const LIVE_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES = 8 * 1024;
export const LIVE_ACCEPTANCE_CONTROL_MAXIMUM_BYTES = 256 * 1024;
export const LIVE_ACCEPTANCE_STATUS_MAXIMUM_BYTES = 2 * 1024 * 1024;
export const LIVE_ACCEPTANCE_WORKER_STDIO = ["pipe", "pipe", "ignore"] as const;

const workerStartupDeadlineMs = 30_000;
const workerCommandDeadlineMs = 90_000;
const workerShutdownDeadlineMs = 30_000;
const cloudDeletionDeadlineMs = 15 * 60 * 1_000;
const cloudDeletionPollMs = 1_000;

const deviceSchema = z.enum(["a", "b"]);
export type LiveAcceptanceDeviceName = z.infer<typeof deviceSchema>;

const requestIdSchema = z.string().uuid();

const cliArgumentSchema = z.string().min(1).max(16 * 1024);

export const liveAcceptanceCliResultSchema = z.object({
  exitCode: z.number().int().min(0).max(255),
  stderr: z.string().max(256 * 1024),
  stdout: z.string().max(1024 * 1024),
}).strict();

export type LiveAcceptanceCliResult = z.infer<typeof liveAcceptanceCliResultSchema>;

export const liveAcceptanceWorkerControlSchema = z.discriminatedUnion("type", [
  z.object({
    argv: z.array(cliArgumentSchema).min(1).max(64),
    protectedInput: z.object({ document: z.unknown() }).strict().optional(),
    requestId: requestIdSchema,
    type: z.literal("cli"),
    version: z.literal(1),
  }).strict(),
  z.object({
    command: localCommandSchema,
    requestId: requestIdSchema,
    type: z.literal("command"),
    version: z.literal(1),
  }).strict(),
  z.object({
    requestId: requestIdSchema,
    type: z.literal("suspend"),
    version: z.literal(1),
  }).strict(),
  z.object({
    requestId: requestIdSchema,
    type: z.literal("resume"),
    version: z.literal(1),
  }).strict(),
  z.object({
    requestId: requestIdSchema,
    type: z.literal("stop"),
    version: z.literal(1),
  }).strict(),
]).superRefine((value, context) => {
  if (value.type !== "cli") return;
  const serializedBytes = value.argv.reduce(
    (total, argument) => total + Buffer.byteLength(argument, "utf8"),
    0,
  );
  if (serializedBytes > 64 * 1024) {
    context.addIssue({ code: "custom", message: "CLI arguments are oversized." });
  }
  if (value.argv.includes("--follow")) {
    context.addIssue({ code: "custom", message: "Unbounded CLI following is unavailable." });
  }
  if (value.argv.includes("--input-stdin")) {
    context.addIssue({ code: "custom", message: "Protected input must use worker standard input descriptor 0." });
  }
  const inputFd = value.argv.indexOf("--input-fd");
  const requestsProtectedInput = inputFd >= 0
    && value.argv[inputFd + 1] === String(LIVE_ACCEPTANCE_CONTROL_FD);
  if ((value.protectedInput !== undefined) !== requestsProtectedInput) {
    context.addIssue({ code: "custom", message: "Protected input and descriptor selection must agree." });
  }
  if (inputFd >= 0 && !requestsProtectedInput) {
    context.addIssue({ code: "custom", message: "Only worker standard input carries protected input." });
  }
});

export type LiveAcceptanceWorkerControl = z.infer<
  typeof liveAcceptanceWorkerControlSchema
>;

export const liveAcceptanceWorkerStatusSchema = z.discriminatedUnion("type", [
  z.object({
    device: deviceSchema,
    pid: z.number().int().positive(),
    runId: z.string().uuid(),
    type: z.literal("ready"),
    version: z.literal(1),
  }).strict(),
  z.object({
    requestId: requestIdSchema,
    result: liveAcceptanceCliResultSchema,
    type: z.literal("cli_result"),
    version: z.literal(1),
  }).strict(),
  z.object({
    requestId: requestIdSchema,
    response: commandResponseSchema,
    type: z.literal("command_result"),
    version: z.literal(1),
  }).strict(),
  z.object({
    action: z.enum(["resume", "suspend"]),
    requestId: requestIdSchema,
    type: z.literal("ack"),
    version: z.literal(1),
  }).strict(),
  z.object({
    device: deviceSchema,
    runId: z.string().uuid(),
    type: z.literal("stopped"),
    version: z.literal(1),
  }).strict(),
  z.object({
    code: z.enum([
      "control_invalid",
      "daemon_failed",
      "descriptor_invalid",
      "home_changed",
      "internal_failure",
      "layout_invalid",
      "status_unavailable",
    ]),
    device: deviceSchema.optional(),
    runId: z.string().uuid().optional(),
    type: z.literal("failed"),
    version: z.literal(1),
  }).strict(),
]);

export type LiveAcceptanceWorkerStatus = z.infer<
  typeof liveAcceptanceWorkerStatusSchema
>;

const resourceRoleSchema = z.enum([
  "device_a",
  "device_b",
  "project_a",
  "project_b",
]);

type ResourceRole = z.infer<typeof resourceRoleSchema>;

const resourceStatusSchema = z.enum([
  "active",
  "quarantine_planned",
  "quarantined",
  "deleted",
]);

const directoryIdentitySchema = z.object({
  device: z.number().int().nonnegative(),
  inode: z.number().int().positive(),
  mode: z.literal(0o700),
  owner: z.number().int().nonnegative(),
  path: z.string().min(1).max(4_096).refine(isAbsolute),
}).strict();

type DirectoryIdentity = z.infer<typeof directoryIdentitySchema>;

const cleanupResourceSchema = z.object({
  identity: directoryIdentitySchema,
  quarantinePath: z.string().min(1).max(4_096).refine(isAbsolute).optional(),
  role: resourceRoleSchema,
  status: resourceStatusSchema,
}).strict();

const workerReceiptSchema = z.object({
  device: deviceSchema,
  pid: z.number().int().positive(),
  state: z.enum(["starting", "ready", "stopped", "failed"]),
}).strict();

const cleanupCheckpointSchema = z.enum([
  "prepared",
  "workers_starting",
  "workers_ready",
  "cleanup_revocation_proven",
  "cleanup_cloud_erased",
  "cleanup_codex_logged_out",
  "cleanup_daemons_stopped",
  "cleanup_quarantined",
]);

const recoveryPhaseSchema = z.union([
  cleanupCheckpointSchema,
  z.literal("recovery_required"),
]);

const recoveryFailureCodeSchema = z.enum([
  "account_logout_unproven",
  "cloud_deletion_unproven",
  "cloud_revocation_unproven",
  "daemon_shutdown_unproven",
  "home_changed",
  "layout_changed",
  "operator_interrupted",
  "worker_failed",
]);

export const liveAcceptanceRecoveryReceiptSchema = z.object({
  checkpoint: cleanupCheckpointSchema,
  cloudCleanupMode: z.enum(["delete_identity", "no_identity"]).optional(),
  cloudDeploymentUrl: z.string().min(1).max(2_048).optional(),
  createdAt: z.number().int().nonnegative(),
  expectedHomeDirectory: z.string().min(1).max(4_096).refine(isAbsolute),
  expectedRevocationIdempotencyKey: z.string().uuid().optional(),
  expectedRevokedPeerPublicId: z.string().min(1).max(200).optional(),
  failureCode: recoveryFailureCodeSchema.optional(),
  phase: recoveryPhaseSchema,
  receiptPath: z.string().min(1).max(4_096).refine(isAbsolute),
  resources: z.array(cleanupResourceSchema).length(4),
  runId: z.string().uuid(),
  runRoot: directoryIdentitySchema,
  updatedAt: z.number().int().nonnegative(),
  version: z.literal(1),
  workers: z.array(workerReceiptSchema).max(2),
}).strict();

export type LiveAcceptanceRecoveryReceipt = z.infer<
  typeof liveAcceptanceRecoveryReceiptSchema
>;

export class LiveAcceptanceError extends Error {
  constructor(readonly code: z.infer<typeof recoveryFailureCodeSchema> | "input_invalid" | "worker_protocol_invalid") {
    super(code);
    this.name = "LiveAcceptanceError";
  }
}

export class LiveAcceptanceStartError extends LiveAcceptanceError {
  constructor(
    code: z.infer<typeof recoveryFailureCodeSchema>,
    readonly recoveryReceiptPath: string,
    readonly runId: string,
  ) {
    super(code);
    this.name = "LiveAcceptanceStartError";
  }
}

type ResourceLayout = Readonly<{
  identity: DirectoryIdentity;
  role: ResourceRole;
}>;

export type LiveAcceptanceLayout = Readonly<{
  descriptors: Readonly<Record<LiveAcceptanceDeviceName, AcceptanceInstallationDescriptor>>;
  expectedHomeDirectory: string;
  receiptPath: string;
  resources: readonly ResourceLayout[];
  runId: string;
  runRoot: DirectoryIdentity;
}>;

export interface LiveAcceptanceWorker {
  readonly device: LiveAcceptanceDeviceName;
  readonly pid: number;
  readonly projectDirectory: string;
  command(command: LocalCommand): Promise<CommandResponse>;
  execute(
    argv: readonly string[],
    options?: Readonly<{ protectedDocument?: unknown }>,
  ): Promise<LiveAcceptanceCliResult>;
  failure(): Promise<never>;
  lifetime(): Promise<void>;
  preserve(): Promise<void>;
  ready(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  suspend(): Promise<void>;
}

export type LiveAcceptanceDevice = Readonly<{
  device: LiveAcceptanceDeviceName;
  projectDirectory: string;
  execute(
    argv: readonly string[],
    options?: Readonly<{ protectedDocument?: unknown }>,
  ): Promise<LiveAcceptanceCliResult>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
}>;

export type LiveAcceptanceWorkerFactory = (
  descriptor: AcceptanceInstallationDescriptor,
) => Promise<LiveAcceptanceWorker>;

type StartOptions = Readonly<{
  cloudDeploymentUrl?: string;
  shutdownVerifier?: (
    worker: LiveAcceptanceWorker,
    descriptor: AcceptanceInstallationDescriptor,
  ) => Promise<void>;
  temporaryBaseDirectory?: string;
  workerFactory?: LiveAcceptanceWorkerFactory;
}>;

type CleanupOptions = Readonly<{
  cloudDeletionDeadlineMs?: number;
  cloudDeletionPollMs?: number;
  signal?: AbortSignal;
}>;

type MutableReceipt = LiveAcceptanceRecoveryReceipt;

const checkpointOrder = new Map(
  cleanupCheckpointSchema.options.map((checkpoint, index) => [checkpoint, index]),
);

const checkpointAtLeast = (
  checkpoint: z.infer<typeof cleanupCheckpointSchema>,
  expected: z.infer<typeof cleanupCheckpointSchema>,
): boolean => (checkpointOrder.get(checkpoint) ?? -1) >= (checkpointOrder.get(expected) ?? -1);

const deferred = <T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} => {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
};

const deferredSignal = (): {
  promise: Promise<void>;
  reject: (reason?: unknown) => void;
  resolve: () => void;
} => {
  const signal = deferred<true>();
  return {
    promise: signal.promise.then(() => undefined),
    reject: signal.reject,
    resolve: () => signal.resolve(true),
  };
};

const boundedDeadline = async <T>(
  operation: Promise<T>,
  deadlineMs: number,
  code: LiveAcceptanceError["code"],
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LiveAcceptanceError(code)), deadlineMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const currentOwner = (): number => {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (owner === undefined) throw new LiveAcceptanceError("layout_changed");
  return owner;
};

const assertNormalizedAbsolute = (value: string): string => {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new LiveAcceptanceError("layout_changed");
  }
  return value;
};

const isContainedDirectChild = (parent: string, child: string): boolean => {
  const relation = relative(parent, child);
  return relation !== ""
    && !relation.startsWith("..")
    && !isAbsolute(relation)
    && !relation.includes("/")
    && !relation.includes("\\");
};

const pathsOverlap = (leftInput: string, rightInput: string): boolean => {
  const left = resolve(leftInput);
  const right = resolve(rightInput);
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return left === right
    || (!leftToRight.startsWith("..") && !isAbsolute(leftToRight))
    || (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft));
};

function assertSafeAcceptanceLocation(
  runRoot: string,
  expectedHomeDirectory: string,
): void {
  const productionRoot = resolveStatePaths().root;
  if (
    pathsOverlap(runRoot, productionRoot)
    || pathsOverlap(runRoot, expectedHomeDirectory)
  ) throw new LiveAcceptanceError("layout_changed");
}

function assertReceiptLayoutShape(receipt: LiveAcceptanceRecoveryReceipt): void {
  const runRoot = assertNormalizedAbsolute(receipt.runRoot.path);
  const expectedHomeDirectory = assertNormalizedAbsolute(receipt.expectedHomeDirectory);
  const receiptPath = assertNormalizedAbsolute(receipt.receiptPath);
  if (
    expectedHomeDirectory !== homedir()
    || process.env.HOME !== expectedHomeDirectory
    || dirname(receiptPath) !== dirname(runRoot)
    || basename(receiptPath) !== `.hra-live-acceptance-${receipt.runId}.recovery.json`
    || !basename(runRoot).startsWith(`hra-live-acceptance-${receipt.runId}-`)
  ) throw new LiveAcceptanceError("layout_changed");
  assertSafeAcceptanceLocation(runRoot, expectedHomeDirectory);
  if (
    pathsOverlap(receiptPath, runRoot)
    || pathsOverlap(receiptPath, expectedHomeDirectory)
    || pathsOverlap(receiptPath, resolveStatePaths().root)
  ) throw new LiveAcceptanceError("layout_changed");

  const expectedPrefixes: Readonly<Record<ResourceRole, string>> = {
    device_a: "device-a-",
    device_b: "device-b-",
    project_a: "project-a-",
    project_b: "project-b-",
  };
  const roles = new Set<ResourceRole>();
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const resource of receipt.resources) {
    const resourcePath = assertNormalizedAbsolute(resource.identity.path);
    if (
      roles.has(resource.role)
      || paths.has(resourcePath)
      || identities.has(`${String(resource.identity.device)}:${String(resource.identity.inode)}`)
      || !isContainedDirectChild(runRoot, resourcePath)
      || !basename(resourcePath).startsWith(expectedPrefixes[resource.role])
      || pathsOverlap(resourcePath, expectedHomeDirectory)
      || pathsOverlap(resourcePath, resolveStatePaths().root)
    ) throw new LiveAcceptanceError("layout_changed");
    roles.add(resource.role);
    paths.add(resourcePath);
    identities.add(`${String(resource.identity.device)}:${String(resource.identity.inode)}`);
    if (resource.quarantinePath !== undefined) {
      const quarantine = assertNormalizedAbsolute(resource.quarantinePath);
      if (
        !isContainedDirectChild(runRoot, quarantine)
        || !basename(quarantine).startsWith(`.hra-quarantine-${resource.role}-`)
        || paths.has(quarantine)
      ) throw new LiveAcceptanceError("layout_changed");
      paths.add(quarantine);
    }
  }
  if (roles.size !== resourceRoleSchema.options.length) {
    throw new LiveAcceptanceError("layout_changed");
  }
  if (
    (receipt.expectedRevokedPeerPublicId === undefined)
    !== (receipt.expectedRevocationIdempotencyKey === undefined)
    || (
      checkpointAtLeast(receipt.checkpoint, "cleanup_revocation_proven")
      && receipt.cloudCleanupMode === undefined
    )
    || (
      receipt.cloudCleanupMode === "no_identity"
      && receipt.expectedRevokedPeerPublicId !== undefined
    )
  ) throw new LiveAcceptanceError("layout_changed");
  if (checkpointAtLeast(receipt.checkpoint, "workers_ready")) {
    const workerDevices = new Set(receipt.workers.map((worker) => worker.device));
    const workerPids = new Set(receipt.workers.map((worker) => worker.pid));
    if (
      receipt.workers.length !== 2
      || workerDevices.size !== 2
      || !workerDevices.has("a")
      || !workerDevices.has("b")
      || workerPids.size !== 2
      || (
        checkpointAtLeast(receipt.checkpoint, "cleanup_daemons_stopped")
        && receipt.workers.some((worker) => worker.state !== "stopped")
      )
    ) throw new LiveAcceptanceError("layout_changed");
  }
}

async function assertReceiptLayoutRuntime(receipt: LiveAcceptanceRecoveryReceipt): Promise<void> {
  assertReceiptLayoutShape(receipt);
  const parent = dirname(receipt.runRoot.path);
  if (await realpath(parent) !== parent) throw new LiveAcceptanceError("layout_changed");
}

async function observePrivateDirectory(path: string): Promise<DirectoryIdentity> {
  const normalized = assertNormalizedAbsolute(path);
  const metadata = await lstat(normalized);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== currentOwner()
    || (metadata.mode & 0o777) !== 0o700
  ) throw new LiveAcceptanceError("layout_changed");
  const canonical = await realpath(normalized);
  if (canonical !== normalized) throw new LiveAcceptanceError("layout_changed");
  return directoryIdentitySchema.parse({
    device: metadata.dev,
    inode: metadata.ino,
    mode: 0o700,
    owner: metadata.uid,
    path: normalized,
  });
}

async function assertDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
  const current = await observePrivateDirectory(identity.path);
  if (
    current.device !== identity.device
    || current.inode !== identity.inode
    || current.owner !== identity.owner
  ) throw new LiveAcceptanceError("layout_changed");
}

async function createPrivateTemporaryDirectory(prefix: string): Promise<DirectoryIdentity> {
  const path = await mkdtemp(prefix);
  await chmod(path, 0o700);
  return await observePrivateDirectory(path);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

class AtomicRecoveryReceipt {
  #identity: Readonly<{ device: number; inode: number }>;
  #value: MutableReceipt;

  private constructor(
    value: MutableReceipt,
    identity: Readonly<{ device: number; inode: number }>,
  ) {
    this.#value = value;
    this.#identity = identity;
  }

  static async create(value: MutableReceipt): Promise<AtomicRecoveryReceipt> {
    const parsed = liveAcceptanceRecoveryReceiptSchema.parse(value);
    await assertReceiptLayoutRuntime(parsed);
    const parent = dirname(parsed.receiptPath);
    await observePrivateDirectory(parsed.runRoot.path);
    const handle = await open(
      parsed.receiptPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(parsed), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(parsed.receiptPath, 0o600);
    await syncDirectory(parent);
    const metadata = await AtomicRecoveryReceipt.#observeFile(parsed.receiptPath);
    return new AtomicRecoveryReceipt(parsed, metadata);
  }

  static async open(value: unknown): Promise<AtomicRecoveryReceipt> {
    const locator = liveAcceptanceRecoveryReceiptSchema.parse(value);
    assertReceiptLayoutShape(locator);
    const handle = await open(locator.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let parsed: LiveAcceptanceRecoveryReceipt;
    let identity: Readonly<{ device: number; inode: number }>;
    try {
      const before = await handle.stat();
      AtomicRecoveryReceipt.#assertSafeFileMetadata(before);
      if (before.size > 32 * 1024) throw new LiveAcceptanceError("layout_changed");
      const bytes = await handle.readFile();
      try {
        parsed = liveAcceptanceRecoveryReceiptSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
        );
      } finally {
        bytes.fill(0);
      }
      const after = await handle.stat();
      AtomicRecoveryReceipt.#assertSafeFileMetadata(after);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
        throw new LiveAcceptanceError("layout_changed");
      }
      identity = { device: after.dev, inode: after.ino };
    } finally {
      await handle.close();
    }
    if (
      parsed.receiptPath !== locator.receiptPath
      || parsed.runId !== locator.runId
    ) throw new LiveAcceptanceError("layout_changed");
    await assertReceiptLayoutRuntime(parsed);
    return new AtomicRecoveryReceipt(parsed, identity);
  }

  get value(): MutableReceipt {
    return this.#value;
  }

  async update(
    transform: (current: MutableReceipt) => MutableReceipt,
  ): Promise<MutableReceipt> {
    const next = liveAcceptanceRecoveryReceiptSchema.parse(transform(this.#value));
    assertReceiptLayoutShape(next);
    if (
      next.receiptPath !== this.#value.receiptPath
      || next.runId !== this.#value.runId
      || next.createdAt !== this.#value.createdAt
    ) throw new LiveAcceptanceError("layout_changed");
    await this.#assertCurrent();
    const parent = dirname(next.receiptPath);
    const temporary = join(parent, `.${basename(next.receiptPath)}.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(next), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(temporary, 0o600);
      await this.#assertCurrent();
      await rename(temporary, next.receiptPath);
      await syncDirectory(parent);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    this.#identity = await AtomicRecoveryReceipt.#observeFile(next.receiptPath);
    this.#value = next;
    return next;
  }

  async remove(): Promise<void> {
    await this.#assertCurrent();
    await unlink(this.#value.receiptPath);
    await syncDirectory(dirname(this.#value.receiptPath));
  }

  async #assertCurrent(): Promise<void> {
    const current = await AtomicRecoveryReceipt.#observeFile(this.#value.receiptPath);
    if (
      current.device !== this.#identity.device
      || current.inode !== this.#identity.inode
    ) throw new LiveAcceptanceError("layout_changed");
  }

  static async #observeFile(path: string): Promise<Readonly<{ device: number; inode: number }>> {
    const metadata = await lstat(assertNormalizedAbsolute(path));
    AtomicRecoveryReceipt.#assertSafeFileMetadata(metadata);
    if (metadata.isSymbolicLink() || metadata.size > 32 * 1024) {
      throw new LiveAcceptanceError("layout_changed");
    }
    return { device: metadata.dev, inode: metadata.ino };
  }

  static #assertSafeFileMetadata(metadata: Stats): void {
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== currentOwner()
      || (metadata.mode & 0o777) !== 0o600
    ) throw new LiveAcceptanceError("layout_changed");
  }
}

export async function createLiveAcceptanceLayout(
  options: Pick<StartOptions, "cloudDeploymentUrl" | "temporaryBaseDirectory"> = {},
): Promise<LiveAcceptanceLayout> {
  const expectedHomeDirectory = process.env.HOME;
  if (
    expectedHomeDirectory === undefined
    || expectedHomeDirectory !== homedir()
    || !isAbsolute(expectedHomeDirectory)
    || resolve(expectedHomeDirectory) !== expectedHomeDirectory
  ) throw new LiveAcceptanceError("home_changed");

  const temporaryBase = await realpath(options.temporaryBaseDirectory ?? tmpdir());
  const baseMetadata = await stat(temporaryBase);
  if (!baseMetadata.isDirectory()) throw new LiveAcceptanceError("layout_changed");
  assertSafeAcceptanceLocation(temporaryBase, expectedHomeDirectory);

  const runId = randomUUID();
  const runRoot = await createPrivateTemporaryDirectory(
    join(temporaryBase, `hra-live-acceptance-${runId}-`),
  );
  assertSafeAcceptanceLocation(runRoot.path, expectedHomeDirectory);

  try {
    const resources = await Promise.all([
      createPrivateTemporaryDirectory(join(runRoot.path, "device-a-"))
        .then((identity) => ({ identity, role: "device_a" as const })),
      createPrivateTemporaryDirectory(join(runRoot.path, "device-b-"))
        .then((identity) => ({ identity, role: "device_b" as const })),
      createPrivateTemporaryDirectory(join(runRoot.path, "project-a-"))
        .then((identity) => ({ identity, role: "project_a" as const })),
      createPrivateTemporaryDirectory(join(runRoot.path, "project-b-"))
        .then((identity) => ({ identity, role: "project_b" as const })),
    ]);
    for (const resource of resources) {
      if (!isContainedDirectChild(runRoot.path, resource.identity.path)) {
        throw new LiveAcceptanceError("layout_changed");
      }
    }
    const byRole = new Map(resources.map((resource) => [resource.role, resource.identity]));
    const stateA = byRole.get("device_a");
    const stateB = byRole.get("device_b");
    const projectA = byRole.get("project_a");
    const projectB = byRole.get("project_b");
    if (stateA === undefined || stateB === undefined || projectA === undefined || projectB === undefined) {
      throw new LiveAcceptanceError("layout_changed");
    }
    const descriptor = (
      device: LiveAcceptanceDeviceName,
      rootDirectory: string,
      documentsDirectory: string,
    ): AcceptanceInstallationDescriptor => acceptanceInstallationDescriptorSchema.parse({
      ...(options.cloudDeploymentUrl === undefined
        ? {}
        : { cloudDeploymentUrl: options.cloudDeploymentUrl }),
      device,
      documentsDirectory,
      expectedHomeDirectory,
      rootDirectory,
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    });
    const receiptPath = join(temporaryBase, `.hra-live-acceptance-${runId}.recovery.json`);
    const layout = {
      descriptors: {
        a: descriptor("a", stateA.path, projectA.path),
        b: descriptor("b", stateB.path, projectB.path),
      },
      expectedHomeDirectory,
      receiptPath,
      resources,
      runId,
      runRoot,
    } satisfies LiveAcceptanceLayout;
    assertReceiptLayoutShape(initialReceipt(layout));
    return layout;
  } catch (error: unknown) {
    await rm(runRoot.path, { force: false, recursive: true }).catch(() => undefined);
    throw error;
  }
}

export async function assertAcceptanceDescriptorLayout(
  descriptorInput: unknown,
): Promise<AcceptanceInstallationDescriptor> {
  const descriptor = acceptanceInstallationDescriptorSchema.parse(descriptorInput);
  if (process.env.HOME !== descriptor.expectedHomeDirectory) {
    throw new LiveAcceptanceError("home_changed");
  }
  const state = await observePrivateDirectory(descriptor.rootDirectory);
  const project = await observePrivateDirectory(descriptor.documentsDirectory);
  const runRootPath = dirname(state.path);
  if (
    dirname(project.path) !== runRootPath
    || !isContainedDirectChild(runRootPath, state.path)
    || !isContainedDirectChild(runRootPath, project.path)
    || state.path === project.path
    || !basename(runRootPath).startsWith(`hra-live-acceptance-${descriptor.runId}-`)
    || !basename(state.path).startsWith(`device-${descriptor.device}-`)
    || !basename(project.path).startsWith(`project-${descriptor.device}-`)
  ) throw new LiveAcceptanceError("layout_changed");
  await observePrivateDirectory(runRootPath);
  assertSafeAcceptanceLocation(runRootPath, descriptor.expectedHomeDirectory);
  return descriptor;
}

const safeWorkerEnvironment = (expectedHomeDirectory: string): NodeJS.ProcessEnv => {
  const allowed = [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SHELL",
    "USER",
  ] as const;
  const environment: NodeJS.ProcessEnv = { HOME: expectedHomeDirectory };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

export type LiveAcceptanceWorkerLaunch = Readonly<{
  arguments: readonly [string];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  executable: string;
}>;

export function liveAcceptanceWorkerLaunch(
  descriptorInput: AcceptanceInstallationDescriptor,
): LiveAcceptanceWorkerLaunch {
  const descriptor = acceptanceInstallationDescriptorSchema.parse(descriptorInput);
  return {
    arguments: [join(import.meta.dir, "live-acceptance-worker.ts")],
    cwd: resolve(import.meta.dir, ".."),
    environment: safeWorkerEnvironment(descriptor.expectedHomeDirectory),
    executable: process.execPath,
  };
}

const asWritable = (value: unknown): Writable => {
  if (
    value === null
    || typeof value !== "object"
    || !("write" in value)
    || !("end" in value)
  ) throw new LiveAcceptanceError("worker_failed");
  return value as Writable;
};

const asReadable = (value: unknown): Readable => {
  if (
    value === null
    || typeof value !== "object"
    || !("on" in value)
  ) throw new LiveAcceptanceError("worker_failed");
  return value as Readable;
};

const writeStreamDocument = async (stream: Writable, document: string): Promise<void> => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const settle = (error?: Error | null): void => {
      if (error === undefined || error === null) resolvePromise();
      else rejectPromise(error);
    };
    stream.write(document, settle);
  });
};

type WorkerPending =
  | Readonly<{
      kind: "ack";
      action: "resume" | "suspend";
      result: ReturnType<typeof deferredSignal>;
    }>
  | Readonly<{
      kind: "cli";
      result: ReturnType<typeof deferred<LiveAcceptanceCliResult>>;
    }>
  | Readonly<{
      kind: "command";
      result: ReturnType<typeof deferred<CommandResponse>>;
    }>;

class ProcessWorker implements LiveAcceptanceWorker {
  readonly device: LiveAcceptanceDeviceName;
  readonly pid: number;
  readonly projectDirectory: string;
  readonly #child: ChildProcess;
  readonly #control: Writable;
  readonly #closed = deferredSignal();
  readonly #descriptor: AcceptanceInstallationDescriptor;
  readonly #lifetime = deferredSignal();
  readonly #ready = deferredSignal();
  readonly #stopped = deferredSignal();
  readonly #pending = new Map<string, WorkerPending>();
  #statusBuffer = Buffer.alloc(0);
  #receivedStopped = false;
  #receivedReady = false;
  #statusEnded = false;
  #terminalError: Error | undefined;
  #stopOperation: Promise<void> | undefined;

  private constructor(
    descriptor: AcceptanceInstallationDescriptor,
    child: ChildProcess,
    control: Writable,
    status: Readable,
  ) {
    if (child.pid === undefined) throw new LiveAcceptanceError("worker_failed");
    this.device = descriptor.device;
    this.pid = child.pid;
    this.projectDirectory = descriptor.documentsDirectory;
    this.#descriptor = descriptor;
    this.#child = child;
    this.#control = control;
    void this.#closed.promise.catch(() => undefined);
    void this.#lifetime.promise.catch(() => undefined);
    void this.#ready.promise.catch(() => undefined);
    void this.#stopped.promise.catch(() => undefined);
    status.on("data", (chunk: Buffer | string) => {
      try {
        this.#consumeStatus(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch {
        this.#fail(new LiveAcceptanceError("worker_protocol_invalid"));
      }
    });
    status.once("error", () => this.#fail(new LiveAcceptanceError("worker_protocol_invalid")));
    status.once("end", () => {
      this.#statusEnded = true;
      if (this.#statusBuffer.byteLength !== 0 || !this.#receivedStopped) {
        this.#fail(new LiveAcceptanceError("worker_protocol_invalid"));
      }
    });
    child.once("error", () => this.#fail(new LiveAcceptanceError("worker_failed")));
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null) this.#fail(new LiveAcceptanceError("worker_failed"));
    });
    child.once("close", (code, signal) => {
      this.#closed.resolve();
      if (code !== 0 || signal !== null || !this.#receivedStopped || !this.#statusEnded) {
        this.#fail(new LiveAcceptanceError("worker_failed"));
        return;
      }
      this.#lifetime.resolve();
    });
  }

  static async start(descriptorInput: AcceptanceInstallationDescriptor): Promise<ProcessWorker> {
    const descriptor = acceptanceInstallationDescriptorSchema.parse(descriptorInput);
    const launch = liveAcceptanceWorkerLaunch(descriptor);
    const child = spawn(launch.executable, [...launch.arguments], {
      cwd: launch.cwd,
      env: launch.environment,
      stdio: [...LIVE_ACCEPTANCE_WORKER_STDIO],
    });
    const childClosed = new Promise<void>((resolvePromise) => {
      child.once("close", () => resolvePromise());
    });
    try {
      const control = asWritable(child.stdin);
      const status = asReadable(child.stdout);
      const worker = new ProcessWorker(descriptor, child, control, status);
      const serialized = `${JSON.stringify(descriptor)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > LIVE_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES) {
        throw new LiveAcceptanceError("input_invalid");
      }
      await writeStreamDocument(control, serialized);
      return worker;
    } catch (error: unknown) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill("SIGTERM");
      const closedAfterTermination = await boundedDeadline(
        childClosed,
        workerShutdownDeadlineMs,
        "worker_failed",
      ).then(() => true, () => false);
      if (!closedAfterTermination) {
        child.kill("SIGKILL");
        await boundedDeadline(
          childClosed,
          workerShutdownDeadlineMs,
          "worker_failed",
        );
      }
      throw error;
    }
  }

  async ready(): Promise<void> {
    this.#assertHealthy();
    await boundedDeadline(
      Promise.race([
        this.#ready.promise,
        this.#lifetime.promise.then(() => { throw new LiveAcceptanceError("worker_failed"); }),
      ]),
      workerStartupDeadlineMs,
      "worker_failed",
    );
    this.#assertHealthy();
  }

  async command(commandInput: LocalCommand): Promise<CommandResponse> {
    await this.ready();
    this.#assertHealthy();
    const command = localCommandSchema.parse(commandInput);
    const requestId = randomUUID();
    const result = deferred<CommandResponse>();
    this.#pending.set(requestId, { kind: "command", result });
    const frame = `${JSON.stringify({ command, requestId, type: "command", version: 1 })}\n`;
    try {
      await this.#writeControl(frame, requestId);
      return await boundedDeadline(result.promise, workerCommandDeadlineMs, "worker_failed");
    } finally {
      this.#pending.delete(requestId);
    }
  }

  async execute(
    argvInput: readonly string[],
    options: Readonly<{ protectedDocument?: unknown }> = {},
  ): Promise<LiveAcceptanceCliResult> {
    await this.ready();
    this.#assertHealthy();
    const requestId = randomUUID();
    const result = deferred<LiveAcceptanceCliResult>();
    const hasProtectedDocument = Object.hasOwn(options, "protectedDocument");
    if (hasProtectedDocument && options.protectedDocument === undefined) {
      throw new LiveAcceptanceError("input_invalid");
    }
    const control = liveAcceptanceWorkerControlSchema.parse({
      argv: [...argvInput],
      ...(hasProtectedDocument
        ? { protectedInput: { document: options.protectedDocument } }
        : {}),
      requestId,
      type: "cli",
      version: 1,
    });
    const frame = `${JSON.stringify(control)}\n`;
    this.#pending.set(requestId, { kind: "cli", result });
    try {
      await this.#writeControl(frame, requestId);
      return await boundedDeadline(result.promise, workerCommandDeadlineMs, "worker_failed");
    } finally {
      this.#pending.delete(requestId);
    }
  }

  async suspend(): Promise<void> {
    await this.#workerAction("suspend");
  }

  async resume(): Promise<void> {
    await this.#workerAction("resume");
  }

  lifetime(): Promise<void> {
    return this.#lifetime.promise;
  }

  failure(): Promise<never> {
    return this.#lifetime.promise.then(
      () => new Promise<never>(() => undefined),
      (error: unknown) => Promise.reject(error),
    );
  }

  async stop(): Promise<void> {
    if (this.#stopOperation !== undefined) return await this.#stopOperation;
    this.#stopOperation = (async () => {
      this.#assertHealthy();
      const requestId = randomUUID();
      const frame = `${JSON.stringify({ requestId, type: "stop", version: 1 })}\n`;
      await this.#writeControl(frame);
      await boundedDeadline(this.#stopped.promise, workerShutdownDeadlineMs, "daemon_shutdown_unproven");
      await boundedDeadline(this.#lifetime.promise, workerShutdownDeadlineMs, "daemon_shutdown_unproven");
      if (this.#terminalError !== undefined) throw this.#terminalError;
    })();
    return await this.#stopOperation;
  }

  async preserve(): Promise<void> {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#control.end();
    }
    await boundedDeadline(
      this.#closed.promise,
      workerShutdownDeadlineMs,
      "daemon_shutdown_unproven",
    ).catch(() => undefined);
  }

  async #workerAction(action: "resume" | "suspend"): Promise<void> {
    await this.ready();
    this.#assertHealthy();
    const requestId = randomUUID();
    const result = deferredSignal();
    this.#pending.set(requestId, { action, kind: "ack", result });
    const frame = `${JSON.stringify({ requestId, type: action, version: 1 })}\n`;
    try {
      await this.#writeControl(frame, requestId);
      await boundedDeadline(result.promise, workerShutdownDeadlineMs, "worker_failed");
    } finally {
      this.#pending.delete(requestId);
    }
    this.#assertHealthy();
  }

  async #writeControl(frame: string, requestId?: string): Promise<void> {
    if (Buffer.byteLength(frame, "utf8") > LIVE_ACCEPTANCE_CONTROL_MAXIMUM_BYTES) {
      if (requestId !== undefined) this.#pending.delete(requestId);
      throw new LiveAcceptanceError("input_invalid");
    }
    try {
      await writeStreamDocument(this.#control, frame);
    } catch {
      const error = new LiveAcceptanceError("worker_failed");
      this.#fail(error);
      throw error;
    }
  }

  #consumeStatus(chunk: Buffer): void {
    this.#statusBuffer = Buffer.concat([this.#statusBuffer, chunk]);
    if (this.#statusBuffer.byteLength > LIVE_ACCEPTANCE_STATUS_MAXIMUM_BYTES) {
      throw new LiveAcceptanceError("worker_protocol_invalid");
    }
    for (;;) {
      const newline = this.#statusBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.#statusBuffer.subarray(0, newline);
      this.#statusBuffer = this.#statusBuffer.subarray(newline + 1);
      if (line.byteLength === 0) throw new LiveAcceptanceError("worker_protocol_invalid");
      try {
        const frame = liveAcceptanceWorkerStatusSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown,
        );
        this.#acceptStatus(frame);
      } finally {
        line.fill(0);
      }
    }
  }

  #acceptStatus(frame: LiveAcceptanceWorkerStatus): void {
    if (frame.type === "ready") {
      if (
        this.#receivedReady
        || this.#receivedStopped
        || frame.device !== this.device
        || frame.runId !== this.#descriptor.runId
        || frame.pid !== this.pid
      ) throw new LiveAcceptanceError("worker_protocol_invalid");
      this.#receivedReady = true;
      this.#ready.resolve();
      return;
    }
    if (frame.type === "command_result") {
      const pending = this.#pending.get(frame.requestId);
      if (pending?.kind !== "command") throw new LiveAcceptanceError("worker_protocol_invalid");
      this.#pending.delete(frame.requestId);
      pending.result.resolve(frame.response);
      return;
    }
    if (frame.type === "cli_result") {
      const pending = this.#pending.get(frame.requestId);
      if (pending?.kind !== "cli") throw new LiveAcceptanceError("worker_protocol_invalid");
      this.#pending.delete(frame.requestId);
      pending.result.resolve(frame.result);
      return;
    }
    if (frame.type === "ack") {
      const pending = this.#pending.get(frame.requestId);
      if (pending?.kind !== "ack" || pending.action !== frame.action) {
        throw new LiveAcceptanceError("worker_protocol_invalid");
      }
      this.#pending.delete(frame.requestId);
      pending.result.resolve();
      return;
    }
    if (frame.type === "stopped") {
      if (frame.device !== this.device || frame.runId !== this.#descriptor.runId) {
        throw new LiveAcceptanceError("worker_protocol_invalid");
      }
      if (this.#receivedStopped) throw new LiveAcceptanceError("worker_protocol_invalid");
      this.#receivedStopped = true;
      this.#stopped.resolve();
      return;
    }
    this.#fail(new LiveAcceptanceError("worker_failed"));
  }

  #fail(error: Error): void {
    if (this.#terminalError !== undefined) return;
    this.#terminalError = error;
    this.#ready.reject(error);
    this.#stopped.reject(error);
    this.#lifetime.reject(error);
    for (const pending of this.#pending.values()) pending.result.reject(error);
    this.#pending.clear();
    this.#control.end();
  }

  #assertHealthy(): void {
    if (this.#terminalError !== undefined) throw this.#terminalError;
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      throw new LiveAcceptanceError("worker_failed");
    }
  }
}

const initialReceipt = (
  layout: LiveAcceptanceLayout,
  workers: readonly LiveAcceptanceWorker[] = [],
): MutableReceipt => {
  const now = Date.now();
  return liveAcceptanceRecoveryReceiptSchema.parse({
    checkpoint: workers.length === 0 ? "prepared" : "workers_starting",
    ...(layout.descriptors.a.cloudDeploymentUrl === undefined
      ? {}
      : { cloudDeploymentUrl: layout.descriptors.a.cloudDeploymentUrl }),
    createdAt: now,
    expectedHomeDirectory: layout.expectedHomeDirectory,
    phase: workers.length === 0 ? "prepared" : "workers_starting",
    receiptPath: layout.receiptPath,
    resources: layout.resources.map((resource) => ({
      identity: resource.identity,
      role: resource.role,
      status: "active",
    })),
    runId: layout.runId,
    runRoot: layout.runRoot,
    updatedAt: now,
    version: 1,
    workers: workers.map((worker) => ({
      device: worker.device,
      pid: worker.pid,
      state: "starting",
    })),
  });
};

const updatePhase = async (
  receipt: AtomicRecoveryReceipt,
  phase: z.infer<typeof cleanupCheckpointSchema>,
  transform: (current: MutableReceipt) => Partial<MutableReceipt> = () => ({}),
): Promise<void> => {
  await receipt.update((current) => ({
    ...current,
    ...transform(current),
    checkpoint: phase,
    failureCode: undefined,
    phase,
    updatedAt: Date.now(),
  }));
};

const requireOk = (response: CommandResponse): unknown => {
  if (!response.ok) throw new LiveAcceptanceError("worker_failed");
  return response.data;
};

const deviceListSchema = z.object({
  currentDevicePublicId: z.string().min(1).max(200),
  devices: z.array(z.object({
    current: z.boolean(),
    publicId: z.string().min(1).max(200),
    status: z.enum(["pending", "active", "revoked"]),
  }).passthrough()).min(1).max(1_024),
}).passthrough();

const cleanupAuthStatusSchema = z.object({
  configured: z.literal(true),
  deletion: z.object({
    effectsDisabled: z.literal(true),
    state: z.enum(["pending", "draining", "complete"]),
    statusFresh: z.boolean(),
  }).passthrough().optional(),
  device: z.object({
    publicId: z.string().min(1).max(200),
    status: z.enum(["pending", "active", "revoked"]).optional(),
  }).passthrough().nullable().optional(),
  email: z.string().email().min(3).max(320).optional(),
  signedIn: z.boolean(),
}).passthrough();

const deletionSchema = z.object({
  deletion: z.object({
    effectsDisabled: z.literal(true),
    state: z.enum(["pending", "draining", "complete"]),
    statusFresh: z.boolean(),
  }).passthrough(),
}).passthrough();

const authDeletionStatusSchema = z.object({
  configured: z.literal(true),
  deletion: z.object({
    effectsDisabled: z.literal(true),
    state: z.literal("complete"),
    statusFresh: z.literal(true),
  }).passthrough(),
  signedIn: z.literal(false),
}).passthrough();

const accountListSchema = z.object({
  accounts: z.array(z.object({
    id: z.string().min(1).max(200),
    state: z.enum([
      "signed_out",
      "login_pending",
      "signed_in",
      "recovery_required",
      "removed",
    ]),
  }).passthrough()).max(64),
}).strict();

const cleanupAccountSchema = z.object({
  id: z.string().min(1).max(200),
  state: z.enum([
    "signed_out",
    "login_pending",
    "signed_in",
    "recovery_required",
    "removed",
  ]),
}).passthrough();

const cleanupAccountResultSchema = z.object({
  account: cleanupAccountSchema,
}).passthrough();

const throwIfCleanupAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new LiveAcceptanceError("operator_interrupted");
};

const waitForCleanupDelay = async (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal === undefined) {
    await Bun.sleep(milliseconds);
    return;
  }
  const activeSignal = signal;
  throwIfCleanupAborted(activeSignal);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(settle, milliseconds);
    const abort = () => settle(new LiveAcceptanceError("operator_interrupted"));
    function settle(error?: Error): void {
      clearTimeout(timer);
      activeSignal.removeEventListener("abort", abort);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    }
    activeSignal.addEventListener("abort", abort, { once: true });
    if (activeSignal.aborted) abort();
  });
};

function assertCurrentDeviceAndUniquePeers(
  listed: z.infer<typeof deviceListSchema>,
): void {
  const current = listed.devices.filter((device) => device.current);
  if (
    current.length !== 1
    || current[0]?.publicId !== listed.currentDevicePublicId
    || current[0].status !== "active"
    || new Set(listed.devices.map((device) => device.publicId)).size !== listed.devices.length
  ) throw new LiveAcceptanceError("cloud_revocation_unproven");
}

async function convergeCloudCleanupAdmission(
  workerA: LiveAcceptanceWorker,
  workerB: LiveAcceptanceWorker,
  expectedInput: Readonly<{ idempotencyKey: string; publicId: string }> | null,
  persistDerivedPeer: (
    expected: Readonly<{ idempotencyKey: string; publicId: string }>,
  ) => Promise<void>,
  signal?: AbortSignal,
): Promise<"delete_identity" | "no_identity"> {
  let expected = expectedInput;
  throwIfCleanupAborted(signal);
  const auth = cleanupAuthStatusSchema.parse(requireOk(
    await workerA.command({ kind: "auth.status" }),
  ));
  throwIfCleanupAborted(signal);
  if (auth.deletion !== undefined) {
    if (auth.signedIn || expected !== null) {
      throw new LiveAcceptanceError("cloud_revocation_unproven");
    }
    return "delete_identity";
  }
  if (!auth.signedIn) {
    if (auth.device !== undefined && auth.device !== null) {
      throw new LiveAcceptanceError("cloud_revocation_unproven");
    }
    if (expected !== null) throw new LiveAcceptanceError("cloud_revocation_unproven");
    const authB = cleanupAuthStatusSchema.parse(requireOk(
      await workerB.command({ kind: "auth.status" }),
    ));
    if (authB.signedIn || (authB.device !== undefined && authB.device !== null)) {
      throw new LiveAcceptanceError("cloud_revocation_unproven");
    }
    return "no_identity";
  }
  if (auth.email === undefined) throw new LiveAcceptanceError("cloud_revocation_unproven");

  let listed = deviceListSchema.parse(requireOk(await workerA.command({ kind: "device.list" })));
  throwIfCleanupAborted(signal);
  assertCurrentDeviceAndUniquePeers(listed);
  const peers = listed.devices.filter((device) => !device.current);
  if (expected === null) {
    const authB = cleanupAuthStatusSchema.parse(requireOk(
      await workerB.command({ kind: "auth.status" }),
    ));
    if (authB.signedIn) {
      if (authB.email !== auth.email) {
        throw new LiveAcceptanceError("cloud_revocation_unproven");
      }
      if (authB.device === undefined || authB.device === null) {
        if (peers.length !== 0) {
          throw new LiveAcceptanceError("cloud_revocation_unproven");
        }
        return "delete_identity";
      }
      const candidates = listed.devices.filter((device) =>
        !device.current && device.publicId === authB.device?.publicId);
      const candidate = candidates[0];
      if (
        candidates.length !== 1
        || candidate === undefined
        || authB.device.status !== candidate.status
        || peers.length !== 1
      ) throw new LiveAcceptanceError("cloud_revocation_unproven");
      expected = { idempotencyKey: randomUUID(), publicId: candidate.publicId };
      // Persist the exact peer authority before honoring a concurrent abort or
      // issuing the revocation effect. Recovery can then converge a lost pair
      // response without guessing which hosted device belongs to this run.
      await persistDerivedPeer(expected);
      throwIfCleanupAborted(signal);
    } else if (
      (authB.device !== undefined && authB.device !== null)
      || peers.length !== 0
    ) {
      throw new LiveAcceptanceError("cloud_revocation_unproven");
    }
  }
  if (expected === null) return "delete_identity";

  if (peers.length !== 1 || peers[0]?.publicId !== expected.publicId) {
    throw new LiveAcceptanceError("cloud_revocation_unproven");
  }

  const peer = listed.devices.filter((device) => device.publicId === expected.publicId);
  const peerEntry = peer[0];
  if (
    expected.publicId === listed.currentDevicePublicId
    || peer.length !== 1
    || peerEntry === undefined
    || peerEntry.current
  ) throw new LiveAcceptanceError("cloud_revocation_unproven");
  if (peerEntry.status !== "revoked") {
    const revoked = z.object({
      device: z.object({
        publicId: z.literal(expected.publicId),
        status: z.literal("revoked"),
      }).passthrough(),
    }).passthrough().parse(requireOk(await workerA.command({
      device: expected.publicId,
      idempotencyKey: expected.idempotencyKey,
      kind: "device.revoke",
    })));
    if (revoked.device.publicId !== expected.publicId) {
      throw new LiveAcceptanceError("cloud_revocation_unproven");
    }
    throwIfCleanupAborted(signal);
    listed = deviceListSchema.parse(requireOk(await workerA.command({ kind: "device.list" })));
    assertCurrentDeviceAndUniquePeers(listed);
    const peersAfterRevocation = listed.devices.filter((device) => !device.current);
    if (peersAfterRevocation.length !== 1
      || peersAfterRevocation[0]?.publicId !== expected.publicId) {
      throw new LiveAcceptanceError("cloud_revocation_unproven");
    }
  }
  const provenPeer = listed.devices.filter((device) => device.publicId === expected.publicId);
  if (
    provenPeer.length !== 1
    || provenPeer[0]?.current
    || provenPeer[0]?.status !== "revoked"
  ) throw new LiveAcceptanceError("cloud_revocation_unproven");
  return "delete_identity";
}

async function eraseCloudIdentity(
  worker: LiveAcceptanceWorker,
  options: CleanupOptions,
): Promise<void> {
  const deadline = Date.now() + (options.cloudDeletionDeadlineMs ?? cloudDeletionDeadlineMs);
  let complete = false;
  while (Date.now() <= deadline) {
    throwIfCleanupAborted(options.signal);
    const result = deletionSchema.parse(requireOk(await worker.command({
      acknowledgeErasure: true,
      kind: "auth.delete",
    })));
    throwIfCleanupAborted(options.signal);
    if (
      result.deletion.state === "complete"
      && result.deletion.statusFresh
    ) {
      complete = true;
      break;
    }
    await waitForCleanupDelay(
      options.cloudDeletionPollMs ?? cloudDeletionPollMs,
      options.signal,
    );
  }
  if (!complete) throw new LiveAcceptanceError("cloud_deletion_unproven");
  throwIfCleanupAborted(options.signal);
  authDeletionStatusSchema.parse(requireOk(await worker.command({ kind: "auth.status" })));
}

async function logoutEveryCodexAccount(
  worker: LiveAcceptanceWorker,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCleanupAborted(signal);
  let listed = accountListSchema.parse(requireOk(await worker.command({ kind: "account.list" })));
  for (const account of listed.accounts) {
    throwIfCleanupAborted(signal);
    let current = cleanupAccountSchema.parse(account);
    if (current.state === "login_pending") {
      const canceled = cleanupAccountResultSchema.parse(requireOk(await worker.command({
        kind: "account.login-cancel",
        account: current.id,
      })));
      if (canceled.account.id !== current.id) {
        throw new LiveAcceptanceError("account_logout_unproven");
      }
      current = canceled.account;
    }
    if (current.state === "recovery_required") {
      const reconciled = cleanupAccountResultSchema.parse(requireOk(await worker.command({
        account: current.id,
        kind: "account.show",
      })));
      if (reconciled.account.id !== current.id) {
        throw new LiveAcceptanceError("account_logout_unproven");
      }
      current = reconciled.account;
    }
    if (current.state === "signed_in") {
      requireOk(await worker.command({
        account: current.id,
        idempotencyKey: randomUUID(),
        kind: "account.logout",
      }));
    } else if (current.state !== "signed_out" && current.state !== "removed") {
      throw new LiveAcceptanceError("account_logout_unproven");
    }
  }
  throwIfCleanupAborted(signal);
  listed = accountListSchema.parse(requireOk(await worker.command({ kind: "account.list" })));
  if (listed.accounts.some((account) => account.state !== "signed_out" && account.state !== "removed")) {
    throw new LiveAcceptanceError("account_logout_unproven");
  }
}

async function assertAbsent(path: string): Promise<void> {
  if (await pathExists(path)) throw new LiveAcceptanceError("daemon_shutdown_unproven");
}

async function proveWorkerShutdown(
  worker: LiveAcceptanceWorker,
  descriptor: AcceptanceInstallationDescriptor,
): Promise<void> {
  if (processIsAlive(worker.pid)) throw new LiveAcceptanceError("daemon_shutdown_unproven");
  const paths = resolveStatePaths({ rootDirectory: descriptor.rootDirectory });
  if (await DaemonLock.isAuthorityHeld(paths)) {
    throw new LiveAcceptanceError("daemon_shutdown_unproven");
  }
  const receipt = await readDaemonAuthorityReceipt(paths);
  if (receipt?.state !== "stopped" || receipt.pid !== worker.pid) {
    throw new LiveAcceptanceError("daemon_shutdown_unproven");
  }
  await Promise.all([assertAbsent(paths.socket), assertAbsent(paths.capability)]);
}

async function markRecoveryRequired(
  receipt: AtomicRecoveryReceipt,
  code: z.infer<typeof recoveryFailureCodeSchema>,
  workers: readonly LiveAcceptanceWorker[],
): Promise<void> {
  await receipt.update((current) => ({
    ...current,
    failureCode: code,
    phase: "recovery_required",
    updatedAt: Date.now(),
    workers: current.workers.map((entry) => {
      const worker = workers.find((candidate) => candidate.device === entry.device);
      if (worker === undefined) return entry;
      return {
        ...entry,
        state: entry.state === "stopped"
          ? "stopped"
          : processIsAlive(worker.pid)
            ? entry.state
            : "failed",
      };
    }),
  }));
}

function failureCode(error: unknown): z.infer<typeof recoveryFailureCodeSchema> {
  if (error instanceof LiveAcceptanceError) {
    if (recoveryFailureCodeSchema.safeParse(error.code).success) {
      return error.code as z.infer<typeof recoveryFailureCodeSchema>;
    }
    if (error.code === "worker_protocol_invalid") return "worker_failed";
  }
  return "worker_failed";
}

async function reconcileAndDeleteResource(
  receipt: AtomicRecoveryReceipt,
  role: ResourceRole,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCleanupAborted(signal);
  await assertReceiptLayoutRuntime(receipt.value);
  let current = receipt.value.resources.find((resource) => resource.role === role);
  if (current === undefined) throw new LiveAcceptanceError("layout_changed");
  const runRoot = receipt.value.runRoot.path;
  if (current.status === "active") {
    await assertDirectoryIdentity(current.identity);
    const quarantinePath = join(
      runRoot,
      `.hra-quarantine-${role}-${randomUUID()}`,
    );
    if (!isContainedDirectChild(runRoot, quarantinePath) || await pathExists(quarantinePath)) {
      throw new LiveAcceptanceError("layout_changed");
    }
    await receipt.update((value) => ({
      ...value,
      resources: value.resources.map((resource) => resource.role === role
        ? { ...resource, quarantinePath, status: "quarantine_planned" }
        : resource),
      updatedAt: Date.now(),
    }));
    throwIfCleanupAborted(signal);
    current = receipt.value.resources.find((resource) => resource.role === role);
  }
  if (current === undefined) throw new LiveAcceptanceError("layout_changed");
  if (current.status === "quarantine_planned") {
    const quarantinePath = current.quarantinePath;
    if (quarantinePath === undefined || !isContainedDirectChild(runRoot, quarantinePath)) {
      throw new LiveAcceptanceError("layout_changed");
    }
    const sourceExists = await pathExists(current.identity.path);
    const quarantineExists = await pathExists(quarantinePath);
    if (sourceExists && quarantineExists) throw new LiveAcceptanceError("layout_changed");
    if (sourceExists) {
      throwIfCleanupAborted(signal);
      await assertReceiptLayoutRuntime(receipt.value);
      await assertDirectoryIdentity(current.identity);
      await rename(current.identity.path, quarantinePath);
      await syncDirectory(runRoot);
    }
    if (await pathExists(quarantinePath)) {
      await assertReceiptLayoutRuntime(receipt.value);
      const quarantined = await observePrivateDirectory(quarantinePath);
      if (
        quarantined.device !== current.identity.device
        || quarantined.inode !== current.identity.inode
        || quarantined.owner !== current.identity.owner
      ) throw new LiveAcceptanceError("layout_changed");
      await receipt.update((value) => ({
        ...value,
        resources: value.resources.map((resource) => resource.role === role
          ? { ...resource, status: "quarantined" }
          : resource),
        updatedAt: Date.now(),
      }));
    } else {
      await receipt.update((value) => ({
        ...value,
        resources: value.resources.map((resource) => resource.role === role
          ? { ...resource, status: "deleted" }
          : resource),
        updatedAt: Date.now(),
      }));
    }
    current = receipt.value.resources.find((resource) => resource.role === role);
  }
  if (current === undefined) throw new LiveAcceptanceError("layout_changed");
  if (current.status === "quarantined") {
    const quarantinePath = current.quarantinePath;
    if (quarantinePath === undefined || !isContainedDirectChild(runRoot, quarantinePath)) {
      throw new LiveAcceptanceError("layout_changed");
    }
    if (await pathExists(quarantinePath)) {
      throwIfCleanupAborted(signal);
      await assertReceiptLayoutRuntime(receipt.value);
      const quarantined = await observePrivateDirectory(quarantinePath);
      if (
        quarantined.device !== current.identity.device
        || quarantined.inode !== current.identity.inode
        || quarantined.owner !== current.identity.owner
      ) throw new LiveAcceptanceError("layout_changed");
      await rm(quarantinePath, { force: false, recursive: true });
      await syncDirectory(runRoot);
    }
    await assertAbsentForCleanup(quarantinePath);
    await receipt.update((value) => ({
      ...value,
      resources: value.resources.map((resource) => resource.role === role
        ? { ...resource, status: "deleted" }
        : resource),
      updatedAt: Date.now(),
    }));
    current = receipt.value.resources.find((resource) => resource.role === role);
  }
  if (current?.status !== "deleted") throw new LiveAcceptanceError("layout_changed");
  await assertAbsentForCleanup(current.identity.path);
  if (current.quarantinePath !== undefined) await assertAbsentForCleanup(current.quarantinePath);
}

async function assertAbsentForCleanup(path: string): Promise<void> {
  if (await pathExists(path)) throw new LiveAcceptanceError("layout_changed");
}

async function assertNoUnknownRunChildren(receipt: LiveAcceptanceRecoveryReceipt): Promise<void> {
  if (!await pathExists(receipt.runRoot.path)) return;
  const allowed = new Set<string>();
  for (const resource of receipt.resources) {
    if (resource.status === "active" || resource.status === "quarantine_planned") {
      allowed.add(basename(resource.identity.path));
    }
    if (
      resource.quarantinePath !== undefined
      && (resource.status === "quarantine_planned" || resource.status === "quarantined")
    ) allowed.add(basename(resource.quarantinePath));
  }
  const entries = await readdir(receipt.runRoot.path);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new LiveAcceptanceError("layout_changed");
  }
}

async function deleteVerifiedLayout(
  receipt: AtomicRecoveryReceipt,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCleanupAborted(signal);
  await assertReceiptLayoutRuntime(receipt.value);
  if (!await pathExists(receipt.value.runRoot.path)) {
    if (receipt.value.resources.some((resource) => resource.status !== "deleted")) {
      throw new LiveAcceptanceError("layout_changed");
    }
    await receipt.remove();
    return;
  }
  await assertDirectoryIdentity(receipt.value.runRoot);
  await assertNoUnknownRunChildren(receipt.value);
  for (const role of resourceRoleSchema.options) {
    throwIfCleanupAborted(signal);
    await assertReceiptLayoutRuntime(receipt.value);
    await assertNoUnknownRunChildren(receipt.value);
    await reconcileAndDeleteResource(receipt, role, signal);
  }
  throwIfCleanupAborted(signal);
  await updatePhase(receipt, "cleanup_quarantined");
  await assertDirectoryIdentity(receipt.value.runRoot);
  const remaining = await readdir(receipt.value.runRoot.path);
  if (remaining.length !== 0) throw new LiveAcceptanceError("layout_changed");
  throwIfCleanupAborted(signal);
  await assertReceiptLayoutRuntime(receipt.value);
  await rmdir(receipt.value.runRoot.path);
  await syncDirectory(dirname(receipt.value.runRoot.path));
  await assertAbsentForCleanup(receipt.value.runRoot.path);
  await receipt.remove();
}

export class LiveAcceptanceRun {
  readonly recoveryReceiptPath: string;
  readonly runId: string;
  readonly #layout: LiveAcceptanceLayout;
  readonly #receipt: AtomicRecoveryReceipt;
  readonly #workers: Readonly<Record<LiveAcceptanceDeviceName, LiveAcceptanceWorker>>;
  readonly #shutdownVerifier: NonNullable<StartOptions["shutdownVerifier"]>;
  #abortRequested = false;
  #cleanupOperation: Promise<void> | undefined;
  #preservationOperation: Promise<"cleanup_complete" | "recovery_required"> | undefined;
  #preservedWorkers: Promise<void> | undefined;
  #terminalState: "active" | "cleanup_complete" | "recovery_required" = "active";

  private constructor(
    layout: LiveAcceptanceLayout,
    receipt: AtomicRecoveryReceipt,
    workers: Readonly<Record<LiveAcceptanceDeviceName, LiveAcceptanceWorker>>,
    shutdownVerifier: NonNullable<StartOptions["shutdownVerifier"]>,
  ) {
    this.runId = layout.runId;
    this.recoveryReceiptPath = layout.receiptPath;
    this.#layout = layout;
    this.#receipt = receipt;
    this.#workers = workers;
    this.#shutdownVerifier = shutdownVerifier;
  }

  static async start(options: StartOptions = {}): Promise<LiveAcceptanceRun> {
    const originalHome = process.env.HOME;
    const layout = await createLiveAcceptanceLayout(options);
    if (process.env.HOME !== originalHome) throw new LiveAcceptanceError("home_changed");
    const receipt = await AtomicRecoveryReceipt.create(initialReceipt(layout));
    const factory = options.workerFactory
      ?? (async (descriptor) => await ProcessWorker.start(descriptor));
    const started: LiveAcceptanceWorker[] = [];
    try {
      const results = await Promise.allSettled([
        factory(layout.descriptors.a),
        factory(layout.descriptors.b),
      ]);
      for (const result of results) {
        if (result.status === "fulfilled") started.push(result.value);
      }
      await receipt.update((current) => ({
        ...current,
        checkpoint: "workers_starting",
        phase: "workers_starting",
        updatedAt: Date.now(),
        workers: started.map((worker) => ({
          device: worker.device,
          pid: worker.pid,
          state: "starting",
        })),
      }));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const workerA = results[0].status === "fulfilled" ? results[0].value : undefined;
      const workerB = results[1].status === "fulfilled" ? results[1].value : undefined;
      if (workerA === undefined || workerB === undefined) {
        throw new LiveAcceptanceError("worker_failed");
      }
      await Promise.all(started.map(async (worker) => await worker.ready()));
      if (process.env.HOME !== originalHome) throw new LiveAcceptanceError("home_changed");
      await receipt.update((current) => ({
        ...current,
        checkpoint: "workers_ready",
        phase: "workers_ready",
        updatedAt: Date.now(),
        workers: current.workers.map((worker) => ({ ...worker, state: "ready" })),
      }));
      return new LiveAcceptanceRun(
        layout,
        receipt,
        { a: workerA, b: workerB },
        options.shutdownVerifier ?? proveWorkerShutdown,
      );
    } catch (error: unknown) {
      await Promise.allSettled(started.map(async (worker) => await worker.preserve()));
      const code = failureCode(error);
      await markRecoveryRequired(receipt, code, started).catch(() => undefined);
      throw new LiveAcceptanceStartError(code, layout.receiptPath, layout.runId);
    }
  }

  static async resume(
    receipt: AtomicRecoveryReceipt,
    options: Pick<StartOptions, "shutdownVerifier" | "workerFactory"> = {},
  ): Promise<LiveAcceptanceRun> {
    const layout = layoutFromReceipt(receipt.value);
    if (receipt.value.workers.some((worker) => processIsAlive(worker.pid))) {
      throw new LiveAcceptanceError("daemon_shutdown_unproven");
    }
    if (receipt.value.resources.some((resource) => resource.status !== "active")) {
      throw new LiveAcceptanceError("layout_changed");
    }
    const factory = options.workerFactory
      ?? (async (descriptor) => await ProcessWorker.start(descriptor));
    const started: LiveAcceptanceWorker[] = [];
    try {
      const results = await Promise.allSettled([
        factory(layout.descriptors.a),
        factory(layout.descriptors.b),
      ]);
      for (const result of results) {
        if (result.status === "fulfilled") started.push(result.value);
      }
      await receipt.update((current) => ({
        ...current,
        phase: "recovery_required",
        updatedAt: Date.now(),
        workers: started.map((worker) => ({
          device: worker.device,
          pid: worker.pid,
          state: "starting",
        })),
      }));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const workerA = results[0].status === "fulfilled" ? results[0].value : undefined;
      const workerB = results[1].status === "fulfilled" ? results[1].value : undefined;
      if (workerA === undefined || workerB === undefined) {
        throw new LiveAcceptanceError("worker_failed");
      }
      await Promise.all(started.map(async (worker) => await worker.ready()));
      const recoveredCheckpoint = checkpointAtLeast(receipt.value.checkpoint, "workers_ready")
        ? receipt.value.checkpoint
        : "workers_ready";
      await receipt.update((current) => ({
        ...current,
        checkpoint: recoveredCheckpoint,
        failureCode: undefined,
        phase: recoveredCheckpoint,
        updatedAt: Date.now(),
        workers: current.workers.map((worker) => ({ ...worker, state: "ready" })),
      }));
      return new LiveAcceptanceRun(
        layout,
        receipt,
        { a: workerA, b: workerB },
        options.shutdownVerifier ?? proveWorkerShutdown,
      );
    } catch (error: unknown) {
      await Promise.allSettled(started.map(async (worker) => await worker.preserve()));
      await markRecoveryRequired(receipt, failureCode(error), started).catch(() => undefined);
      throw error;
    }
  }

  device(device: LiveAcceptanceDeviceName): LiveAcceptanceDevice {
    const worker = this.#workers[device];
    return {
      device,
      execute: async (argv, options) => await worker.execute(argv, options),
      projectDirectory: worker.projectDirectory,
      resume: async () => await worker.resume(),
      suspend: async () => await worker.suspend(),
    };
  }

  async bindExpectedRevokedPeer(publicIdInput: string): Promise<void> {
    if (
      this.#abortRequested
      || this.#cleanupOperation !== undefined
      || this.#terminalState !== "active"
      || checkpointAtLeast(
      this.#receipt.value.checkpoint,
      "cleanup_revocation_proven",
      )
    ) throw new LiveAcceptanceError("cloud_revocation_unproven");
    const publicId = z.string().min(1).max(200).parse(publicIdInput);
    const idempotencyKey = randomUUID();
    await this.#receipt.update((current) => {
      if (
        current.expectedRevokedPeerPublicId !== undefined
        && current.expectedRevokedPeerPublicId !== publicId
      ) throw new LiveAcceptanceError("cloud_revocation_unproven");
      return {
        ...current,
        expectedRevocationIdempotencyKey:
          current.expectedRevocationIdempotencyKey ?? idempotencyKey,
        expectedRevokedPeerPublicId: publicId,
        updatedAt: Date.now(),
      };
    });
  }

  workerFailure(): Promise<never> {
    return Promise.race([
      this.#workers.a.failure(),
      this.#workers.b.failure(),
    ]);
  }

  async cleanup(options: CleanupOptions = {}): Promise<void> {
    if (this.#terminalState === "cleanup_complete") return;
    if (this.#terminalState === "recovery_required" || this.#abortRequested) {
      throw new LiveAcceptanceError(this.#receipt.value.failureCode ?? "operator_interrupted");
    }
    if (this.#cleanupOperation !== undefined) return await this.#cleanupOperation;
    this.#cleanupOperation = this.#performCleanup(options);
    return await this.#cleanupOperation;
  }

  requestAbort(): void {
    if (this.#terminalState !== "active") return;
    this.#abortRequested = true;
    void this.#preserveWorkers();
  }

  async #performCleanup(options: CleanupOptions): Promise<void> {
    const originalHome = process.env.HOME;
    try {
      throwIfCleanupAborted(options.signal);
      if (!checkpointAtLeast(this.#receipt.value.checkpoint, "cleanup_revocation_proven")) {
        const expectedRevokedPeerPublicId = this.#receipt.value.expectedRevokedPeerPublicId;
        const expectedRevocationIdempotencyKey =
          this.#receipt.value.expectedRevocationIdempotencyKey;
        if (
          (expectedRevokedPeerPublicId === undefined)
          !== (expectedRevocationIdempotencyKey === undefined)
        ) {
          throw new LiveAcceptanceError("cloud_revocation_unproven");
        }
        const cloudCleanupMode = await convergeCloudCleanupAdmission(
          this.#workers.a,
          this.#workers.b,
          expectedRevokedPeerPublicId === undefined
            ? null
            : expectedRevocationIdempotencyKey === undefined
              ? null
              : {
                idempotencyKey: expectedRevocationIdempotencyKey,
                publicId: expectedRevokedPeerPublicId,
              },
          async (derived) => {
            await this.#receipt.update((current) => {
              if (
                current.expectedRevokedPeerPublicId !== undefined
                || current.expectedRevocationIdempotencyKey !== undefined
              ) {
                if (
                  current.expectedRevokedPeerPublicId !== derived.publicId
                  || current.expectedRevocationIdempotencyKey !== derived.idempotencyKey
                ) throw new LiveAcceptanceError("cloud_revocation_unproven");
                return current;
              }
              return {
                ...current,
                expectedRevocationIdempotencyKey: derived.idempotencyKey,
                expectedRevokedPeerPublicId: derived.publicId,
                updatedAt: Date.now(),
              };
            });
          },
          options.signal,
        );
        throwIfCleanupAborted(options.signal);
        await updatePhase(this.#receipt, "cleanup_revocation_proven", () => ({
          cloudCleanupMode,
        }));
      }
      if (!checkpointAtLeast(this.#receipt.value.checkpoint, "cleanup_cloud_erased")) {
        if (this.#receipt.value.cloudCleanupMode === undefined) {
          throw new LiveAcceptanceError("cloud_deletion_unproven");
        }
        if (this.#receipt.value.cloudCleanupMode === "delete_identity") {
          await eraseCloudIdentity(this.#workers.a, options);
        }
        throwIfCleanupAborted(options.signal);
        await updatePhase(this.#receipt, "cleanup_cloud_erased");
      }
      if (!checkpointAtLeast(this.#receipt.value.checkpoint, "cleanup_codex_logged_out")) {
        await Promise.all([
          logoutEveryCodexAccount(this.#workers.a, options.signal),
          logoutEveryCodexAccount(this.#workers.b, options.signal),
        ]);
        throwIfCleanupAborted(options.signal);
        await updatePhase(this.#receipt, "cleanup_codex_logged_out");
      }
      if (!checkpointAtLeast(this.#receipt.value.checkpoint, "cleanup_daemons_stopped")) {
        throwIfCleanupAborted(options.signal);
        await Promise.all([this.#workers.a.stop(), this.#workers.b.stop()]);
        await Promise.all([
          this.#shutdownVerifier(this.#workers.a, this.#layout.descriptors.a),
          this.#shutdownVerifier(this.#workers.b, this.#layout.descriptors.b),
        ]);
        await this.#receipt.update((current) => ({
          ...current,
          checkpoint: "cleanup_daemons_stopped",
          phase: "cleanup_daemons_stopped",
          updatedAt: Date.now(),
          workers: current.workers.map((worker) => ({ ...worker, state: "stopped" })),
        }));
      }
      if (process.env.HOME !== originalHome || originalHome !== this.#layout.expectedHomeDirectory) {
        throw new LiveAcceptanceError("home_changed");
      }
      throwIfCleanupAborted(options.signal);
      await deleteVerifiedLayout(this.#receipt, options.signal);
      this.#terminalState = "cleanup_complete";
    } catch (error: unknown) {
      await this.#preserveWorkers();
      await markRecoveryRequired(
        this.#receipt,
        failureCode(error),
        [this.#workers.a, this.#workers.b],
      ).catch(() => undefined);
      this.#terminalState = "recovery_required";
      throw error;
    }
  }

  async preserveForRecovery(
    code: z.infer<typeof recoveryFailureCodeSchema> = "operator_interrupted",
  ): Promise<"cleanup_complete" | "recovery_required"> {
    if (this.#terminalState !== "active") return this.#terminalState;
    if (this.#preservationOperation !== undefined) return await this.#preservationOperation;
    this.requestAbort();
    this.#preservationOperation = (async () => {
      await this.#preserveWorkers();
      await this.#cleanupOperation?.catch(() => undefined);
      if (this.#terminalState !== "active") return this.#terminalState;
      await markRecoveryRequired(
        this.#receipt,
        code,
        [this.#workers.a, this.#workers.b],
      );
      this.#terminalState = "recovery_required";
      return this.#terminalState;
    })();
    return await this.#preservationOperation;
  }

  #preserveWorkers(): Promise<void> {
    this.#preservedWorkers ??= Promise.allSettled([
      this.#workers.a.preserve(),
      this.#workers.b.preserve(),
    ]).then(() => undefined);
    return this.#preservedWorkers;
  }
}

function layoutFromReceipt(receipt: LiveAcceptanceRecoveryReceipt): LiveAcceptanceLayout {
  assertReceiptLayoutShape(receipt);
  const resource = (role: ResourceRole): DirectoryIdentity => {
    const found = receipt.resources.find((candidate) => candidate.role === role);
    if (found === undefined) throw new LiveAcceptanceError("layout_changed");
    return found.identity;
  };
  const descriptor = (
    device: LiveAcceptanceDeviceName,
    rootDirectory: string,
    documentsDirectory: string,
  ): AcceptanceInstallationDescriptor => acceptanceInstallationDescriptorSchema.parse({
    ...(receipt.cloudDeploymentUrl === undefined
      ? {}
      : { cloudDeploymentUrl: receipt.cloudDeploymentUrl }),
    device,
    documentsDirectory,
    expectedHomeDirectory: receipt.expectedHomeDirectory,
    rootDirectory,
    runId: receipt.runId,
    type: "hra-live-acceptance-device",
    version: 1,
  });
  return {
    descriptors: {
      a: descriptor("a", resource("device_a").path, resource("project_a").path),
      b: descriptor("b", resource("device_b").path, resource("project_b").path),
    },
    expectedHomeDirectory: receipt.expectedHomeDirectory,
    receiptPath: receipt.receiptPath,
    resources: receipt.resources.map((entry) => ({
      identity: entry.identity,
      role: entry.role,
    })),
    runId: receipt.runId,
    runRoot: receipt.runRoot,
  };
}

export async function startLiveAcceptanceRun(options: StartOptions = {}): Promise<LiveAcceptanceRun> {
  return await LiveAcceptanceRun.start(options);
}

export async function resumeVerifiedLayoutDeletion(
  receiptDocument: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const receipt = await AtomicRecoveryReceipt.open(receiptDocument);
  if (process.env.HOME !== receipt.value.expectedHomeDirectory) {
    throw new LiveAcceptanceError("home_changed");
  }
  if (!checkpointAtLeast(receipt.value.checkpoint, "cleanup_daemons_stopped")) {
    throw new LiveAcceptanceError("daemon_shutdown_unproven");
  }
  if (receipt.value.workers.some((worker) => processIsAlive(worker.pid))) {
    throw new LiveAcceptanceError("daemon_shutdown_unproven");
  }
  await deleteVerifiedLayout(receipt, signal);
}

export async function resumeLiveAcceptanceCleanup(
  receiptDocument: unknown,
  options: CleanupOptions & Pick<StartOptions, "shutdownVerifier" | "workerFactory"> = {},
): Promise<void> {
  const receipt = await AtomicRecoveryReceipt.open(receiptDocument);
  if (process.env.HOME !== receipt.value.expectedHomeDirectory) {
    throw new LiveAcceptanceError("home_changed");
  }
  if (receipt.value.workers.some((worker) => processIsAlive(worker.pid))) {
    throw new LiveAcceptanceError("daemon_shutdown_unproven");
  }
  if (checkpointAtLeast(receipt.value.checkpoint, "cleanup_daemons_stopped")) {
    await deleteVerifiedLayout(receipt, options.signal);
    return;
  }
  const run = await LiveAcceptanceRun.resume(receipt, options);
  await run.cleanup(options);
}

export function readLiveAcceptanceRecoveryReceiptFromFd(fd: number): LiveAcceptanceRecoveryReceipt {
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 255 || isatty(fd)) {
    throw new LiveAcceptanceError("input_invalid");
  }
  const maximum = 32 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const remaining = maximum + 1 - total;
      if (remaining <= 0) throw new LiveAcceptanceError("input_invalid");
      const chunk = Buffer.allocUnsafe(Math.min(4 * 1024, remaining));
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, count));
      total += count;
      if (total > maximum) throw new LiveAcceptanceError("input_invalid");
    }
    if (total === 0) throw new LiveAcceptanceError("input_invalid");
    const bytes = Buffer.concat(chunks, total);
    try {
      return liveAcceptanceRecoveryReceiptSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      );
    } finally {
      bytes.fill(0);
    }
  } catch (error: unknown) {
    if (error instanceof LiveAcceptanceError) throw error;
    throw new LiveAcceptanceError("input_invalid");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

const sourceGitOutput = async (arguments_: readonly string[]): Promise<string> => {
  const repositoryRoot = resolve(import.meta.dir, "..");
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...arguments_],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5_000,
      },
      (error, stdout, stderr) => {
        if (
          error !== null
          || stderr !== ""
          || typeof stdout !== "string"
        ) {
          rejectPromise(new LiveAcceptanceError("input_invalid"));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
};

export const liveAcceptanceSourceAttestation = async (
  cloudDeploymentUrlInput: string,
): Promise<Readonly<{
  cloudTargetDigest: string;
  packageVersion: string;
  sourceRevision: string;
}>> => {
  if (cloudDeploymentUrlInput !== DEFAULT_CLOUD_DEPLOYMENT_URL) {
    throw new LiveAcceptanceError("input_invalid");
  }
  const [revisionOutput, statusOutput] = await Promise.all([
    sourceGitOutput(["rev-parse", "--verify", "HEAD^{commit}"]),
    sourceGitOutput(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const sourceRevision = revisionOutput.trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision) || statusOutput !== "") {
    throw new LiveAcceptanceError("input_invalid");
  }
  return {
    cloudTargetDigest: createHash("sha256")
      .update(cloudDeploymentUrlInput, "utf8")
      .digest("hex"),
    packageVersion: HRA_VERSION,
    sourceRevision,
  };
};

const writeStandardOutputFrame = async (value: unknown): Promise<void> => {
  const frame = `${JSON.stringify(value)}\n`;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    process.stdout.write(frame, (error) => {
      if (error === undefined || error === null) resolvePromise();
      else rejectPromise(error);
    });
  });
};

export const liveAcceptanceMain = async (
  arguments_: readonly string[] = Bun.argv.slice(2),
): Promise<number> => {
  if (arguments_.length === 2 && arguments_[0] === "--resume-fd") {
    const rawFd = arguments_[1];
    if (rawFd === undefined || !/^[0-9]+$/u.test(rawFd)) {
      process.stderr.write("hra live acceptance: invalid protected descriptor\n");
      return 2;
    }
    const resumeAbort = new AbortController();
    const stopResume = () => resumeAbort.abort(new LiveAcceptanceError("operator_interrupted"));
    process.once("SIGINT", stopResume);
    process.once("SIGTERM", stopResume);
    try {
      await resumeLiveAcceptanceCleanup(
        readLiveAcceptanceRecoveryReceiptFromFd(Number(rawFd)),
        { signal: resumeAbort.signal },
      );
      await writeStandardOutputFrame({ ok: true, status: "cleanup_complete", version: 1 });
      return 0;
    } catch {
      process.stderr.write("hra live acceptance: cleanup remains recovery-required\n");
      return 1;
    } finally {
      process.off("SIGINT", stopResume);
      process.off("SIGTERM", stopResume);
    }
  }
  const standardStreamScenario = arguments_.length === 1
    && arguments_[0] === "--scenario-stdin";
  const descriptorScenario = arguments_.length === 2
    && arguments_[0] === "--scenario-fd"
    && arguments_[1] !== undefined
    && /^[0-9]+$/u.test(arguments_[1]);
  if (!standardStreamScenario && !descriptorScenario) {
    process.stderr.write(
      "hra live acceptance: use --scenario-fd <nonterminal-fd> for a terminal run or --scenario-stdin for a JSONL agent run\n",
    );
    return 2;
  }
  const scenarioFd = descriptorScenario ? Number(arguments_[1]) : undefined;
  let run: LiveAcceptanceRun | undefined;
  let scenarioOperator: Readonly<{
    close?: () => void;
    flush?: () => Promise<void>;
  }> | undefined;
  const interruption = deferredSignal();
  const scenarioAbort = new AbortController();
  const stop = () => {
    if (!scenarioAbort.signal.aborted) {
      scenarioAbort.abort(new LiveAcceptanceError("operator_interrupted"));
    }
    run?.requestAbort();
    interruption.resolve();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const scenarioModule = await import("./live-acceptance-scenario");
    const standardScenario = standardStreamScenario
      ? await scenarioModule.createStandardJsonlLiveAcceptanceScenario(scenarioAbort.signal)
      : undefined;
    let configuration;
    if (standardScenario !== undefined) {
      configuration = standardScenario.configuration;
    } else {
      if (scenarioFd === undefined) throw new LiveAcceptanceError("input_invalid");
      configuration = scenarioModule.readLiveAcceptanceScenarioConfigurationFromFd(scenarioFd);
    }
    if (!standardStreamScenario && configuration.operator.kind !== "terminal") {
      throw new LiveAcceptanceError("input_invalid");
    }
    if (
      configuration.operator.kind === "terminal"
      && (!process.stdin.isTTY || !process.stderr.isTTY)
    ) throw new LiveAcceptanceError("input_invalid");
    const operator = standardScenario?.operator
      ?? scenarioModule.createLiveAcceptanceScenarioOperator(configuration);
    scenarioOperator = operator;
    const attestation = await liveAcceptanceSourceAttestation(configuration.cloudDeploymentUrl);
    if (scenarioAbort.signal.aborted) throw new LiveAcceptanceError("operator_interrupted");
    run = await startLiveAcceptanceRun({
      cloudDeploymentUrl: configuration.cloudDeploymentUrl,
    });
    const activeRun = run;
    const scenario = scenarioModule.runLiveAcceptanceScenario(
      activeRun,
      operator,
      attestation,
      { signal: scenarioAbort.signal },
    );
    void scenario.catch(() => undefined);
    const outcome = await Promise.race([
      scenario.then((evidence) => ({ evidence, type: "complete" as const })),
      interruption.promise.then(() => ({ type: "interrupted" as const })),
      activeRun.workerFailure().then(() => {
        throw new LiveAcceptanceError("worker_failed");
      }),
    ]);
    if (outcome.type === "interrupted") {
      const preservation = await activeRun.preserveForRecovery("operator_interrupted");
      const settlement = await boundedDeadline(
        scenario.then(
          (evidence) => ({ evidence, type: "complete" as const }),
          () => ({ type: "failed" as const }),
        ),
        5_000,
        "worker_failed",
      ).catch(() => ({ type: "failed" as const }));
      if (preservation === "cleanup_complete" && settlement.type === "complete") {
        await scenarioOperator.flush?.();
        await writeStandardOutputFrame({
          evidence: settlement.evidence,
          ok: true,
          status: "passed",
          version: 1,
        });
        return 0;
      }
      if (preservation === "cleanup_complete") {
        await scenarioOperator.flush?.();
        await writeStandardOutputFrame({
          ok: false,
          recoveryReceiptRetained: false,
          runId: activeRun.runId,
          status: "evidence_unavailable_after_cleanup",
          version: 1,
        });
        return 1;
      }
      await scenarioOperator.flush?.();
      await writeStandardOutputFrame({
        ok: false,
        recoveryReceiptPath: activeRun.recoveryReceiptPath,
        recoveryReceiptRetained: true,
        runId: activeRun.runId,
        status: "recovery_required",
        version: 1,
      });
      return 75;
    }
    await scenarioOperator.flush?.();
    await writeStandardOutputFrame({
      evidence: outcome.evidence,
      ok: true,
      status: "passed",
      version: 1,
    });
    return 0;
  } catch (error: unknown) {
    const failedRun = run;
    const operatorInterrupted = scenarioAbort.signal.aborted
      && scenarioAbort.signal.reason instanceof LiveAcceptanceError
      && scenarioAbort.signal.reason.code === "operator_interrupted";
    if (!scenarioAbort.signal.aborted) {
      scenarioAbort.abort(new LiveAcceptanceError("worker_failed"));
    }
    failedRun?.requestAbort();
    const preservation = failedRun === undefined
      ? undefined
      : await failedRun.preserveForRecovery(
        operatorInterrupted ? "operator_interrupted" : "worker_failed",
      ).catch(() => undefined);
    if (failedRun !== undefined && preservation === "cleanup_complete") {
      await scenarioOperator?.flush?.().catch(() => undefined);
      await writeStandardOutputFrame({
        ok: false,
        recoveryReceiptRetained: false,
        runId: failedRun.runId,
        status: "evidence_unavailable_after_cleanup",
        version: 1,
      }).catch(() => undefined);
      return 1;
    }
    const recovery = failedRun
      ?? (error instanceof LiveAcceptanceStartError ? error : undefined);
    await scenarioOperator?.flush?.().catch(() => undefined);
    if (recovery !== undefined) {
      await writeStandardOutputFrame({
        ok: false,
        recoveryReceiptPath: recovery.recoveryReceiptPath,
        recoveryReceiptRetained: true,
        runId: recovery.runId,
        status: "recovery_required",
        version: 1,
      }).catch(() => undefined);
    } else {
      await writeStandardOutputFrame({
        ok: false,
        status: "startup_failed",
        version: 1,
      }).catch(() => undefined);
      process.stderr.write("hra live acceptance: startup failed safely\n");
    }
    return operatorInterrupted ? 75 : 1;
  } finally {
    scenarioOperator?.close?.();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
};

if (import.meta.main) process.exitCode = await liveAcceptanceMain();
