import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { Database } from "bun:sqlite";
import { z } from "zod";

import { ensurePrivateDirectory, type StatePaths } from "../storage/paths";

export const DAEMON_PROTOCOL = "hra-control-plane-local-v1" as const;

const receiptStateSchema = z.enum(["booting", "ready", "stopping", "stopped", "failed", "maintenance"]);

export const daemonAuthorityReceiptSchema = z.object({
  version: z.literal(2),
  protocol: z.literal(DAEMON_PROTOCOL),
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  state: receiptStateSchema,
  acquiredAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  generation: z.number().int().positive().optional(),
  bootId: z.string().regex(/^boot_[a-f0-9]{32}$/u).optional(),
  failure: z.string().min(1).max(1_000).optional(),
}).strict().superRefine((receipt, context) => {
  if (receipt.updatedAt < receipt.acquiredAt) {
    context.addIssue({ code: "custom", message: "Daemon receipt time cannot precede authority acquisition." });
  }
  if ((receipt.generation === undefined) !== (receipt.bootId === undefined)) {
    context.addIssue({ code: "custom", message: "Daemon generation and boot ID must be published together." });
  }
  if (receipt.state === "ready" && receipt.generation === undefined) {
    context.addIssue({ code: "custom", message: "A ready daemon receipt requires an authority generation." });
  }
  if (receipt.state === "failed" && receipt.failure === undefined) {
    context.addIssue({ code: "custom", message: "A failed daemon receipt requires a bounded diagnostic." });
  }
});

export type DaemonAuthorityReceipt = z.infer<typeof daemonAuthorityReceiptSchema>;

export class DaemonAuthoritySafetyError extends Error {
  readonly code = "DAEMON_AUTHORITY_UNSAFE" as const;

  constructor(message: string) {
    super(message);
    this.name = "DaemonAuthoritySafetyError";
  }
}

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

export const daemonAuthorityDatabasePath = (paths: StatePaths): string => `${paths.daemonLock}.authority.sqlite`;

async function validateOwnedRegularFile(path: string, maximumBytes?: number): Promise<Stats> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new DaemonAuthoritySafetyError(`Unsafe daemon authority file: ${path}`);
  }
  const uid = currentUid();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new DaemonAuthoritySafetyError(`Daemon authority file is owned by another user: ${path}`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new DaemonAuthoritySafetyError(`Daemon authority file has unsafe permissions: ${path}`);
  }
  if (maximumBytes !== undefined && metadata.size > maximumBytes) {
    throw new DaemonAuthoritySafetyError(`Daemon authority file exceeds its byte limit: ${path}`);
  }
  if (resolve(dirname(path), basename(path)) !== path) {
    throw new DaemonAuthoritySafetyError(`Daemon authority file path is not canonical: ${path}`);
  }
  return metadata;
}

async function ensureAuthorityDatabaseFile(paths: StatePaths): Promise<{ path: string; metadata: Stats }> {
  await ensurePrivateDirectory(paths.runtime);
  const path = daemonAuthorityDatabasePath(paths);
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { path, metadata: await validateOwnedRegularFile(path) };
}

async function validateReplaceableReceipt(path: string): Promise<Stats | null> {
  try {
    return await validateOwnedRegularFile(path, 4_096);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeReceipt(path: string, receipt: DaemonAuthorityReceipt): Promise<void> {
  const parsed = daemonAuthorityReceiptSchema.parse(receipt);
  const replaced = await validateReplaceableReceipt(path);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const current = await validateReplaceableReceipt(path);
    if ((replaced === null) !== (current === null)
      || (replaced !== null && current !== null && (replaced.dev !== current.dev || replaced.ino !== current.ino))) {
      throw new DaemonAuthoritySafetyError("Daemon authority receipt changed before atomic publication.");
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    await validateOwnedRegularFile(path, 4_096);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy/iu.test(error.message);
}

export class DaemonAuthorityBusyError extends Error {
  readonly code = "DAEMON_AUTHORITY_BUSY" as const;

  constructor(receipt: DaemonAuthorityReceipt | null) {
    super(receipt === null
      ? "A HRA process already owns the local daemon authority."
      : `A HRA process already owns the local daemon authority (pid ${receipt.pid}, ${receipt.state}).`);
    this.name = "DaemonAuthorityBusyError";
  }
}

export type DaemonEffectAuthority = Readonly<{
  generation: number;
  bootId: string;
}>;

/**
 * A closeable capability for one published daemon lifetime. Callers recheck it
 * immediately before every external effect and every local commit that follows
 * an await.
 */
export class DaemonAuthorityFence {
  readonly authority: DaemonEffectAuthority;
  readonly #lock: DaemonLock;
  #closed = false;

  constructor(lock: DaemonLock, authority: DaemonEffectAuthority) {
    const receipt = lock.receipt;
    if (receipt.generation !== authority.generation || receipt.bootId !== authority.bootId) {
      throw new DaemonAuthoritySafetyError("The requested daemon effect authority is not the published lock authority.");
    }
    this.#lock = lock;
    this.authority = Object.freeze({ ...authority });
  }

  close(): void {
    this.#closed = true;
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  async assertCurrent(): Promise<void> {
    if (this.#isClosed()) {
      throw new DaemonAuthoritySafetyError("The daemon effect authority is closed.");
    }
    await this.#lock.assertCurrent();
    const receipt = this.#lock.receipt;
    if (
      this.#isClosed()
      || receipt.generation !== this.authority.generation
      || receipt.bootId !== this.authority.bootId
    ) {
      throw new DaemonAuthoritySafetyError("The daemon effect authority generation or boot ID changed.");
    }
  }
}

export async function readDaemonAuthorityReceipt(
  paths: StatePaths,
  hooks: Readonly<{ afterNamedValidation?(): void | Promise<void> }> = {},
): Promise<DaemonAuthorityReceipt | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const before = await validateOwnedRegularFile(paths.daemonLock, 4_096);
      await hooks.afterNamedValidation?.();
      const handle = await open(paths.daemonLock, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        const uid = currentUid();
        if (
          !metadata.isFile()
          || metadata.isSymbolicLink()
          || metadata.nlink !== 1
          || metadata.size > 4_096
          || (metadata.mode & 0o777) !== 0o600
          || (uid !== undefined && metadata.uid !== uid)
        ) {
          throw new DaemonAuthoritySafetyError("Daemon authority receipt became unsafe while it was opened.");
        }
        if (metadata.dev !== before.dev || metadata.ino !== before.ino) {
          continue;
        }
        const value = JSON.parse(await handle.readFile("utf8")) as unknown;
        const parsed = daemonAuthorityReceiptSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  throw new DaemonAuthoritySafetyError(
    "Daemon authority receipt changed repeatedly while it was opened.",
  );
}

export class DaemonLock {
  readonly #paths: StatePaths;
  readonly #database: Database;
  readonly #authorityPath: string;
  readonly #authorityDevice: number;
  readonly #authorityInode: number;
  #receipt: DaemonAuthorityReceipt;
  #released = false;

  private constructor(paths: StatePaths, database: Database, authority: { path: string; device: number; inode: number }, receipt: DaemonAuthorityReceipt) {
    this.#paths = paths;
    this.#database = database;
    this.#authorityPath = authority.path;
    this.#authorityDevice = authority.device;
    this.#authorityInode = authority.inode;
    this.#receipt = receipt;
  }

  get receipt(): DaemonAuthorityReceipt {
    return this.#receipt;
  }

  async #validateAuthorityName(): Promise<void> {
    const metadata = await validateOwnedRegularFile(this.#authorityPath);
    if (metadata.dev !== this.#authorityDevice || metadata.ino !== this.#authorityInode) {
      throw new DaemonAuthoritySafetyError("The named daemon authority database changed while authority was held.");
    }
  }

  async assertCurrent(): Promise<void> {
    if (this.#released) throw new DaemonAuthoritySafetyError("The daemon authority has already been released.");
    await this.#validateAuthorityName();
    try {
      this.#database.query("SELECT 1 AS authority_held").get();
    } catch (error: unknown) {
      throw new DaemonAuthoritySafetyError(`The daemon authority transaction is unavailable${error instanceof Error ? ` (${error.name})` : ""}.`);
    }
  }

  static async acquire(
    paths: StatePaths,
    input: { pid?: number; nonce?: string; now?: number; state?: "booting" | "maintenance" } = {},
  ): Promise<DaemonLock> {
    const authority = await ensureAuthorityDatabaseFile(paths);
    const database = new Database(authority.path, { create: false, strict: true });
    try {
      const opened = await validateOwnedRegularFile(authority.path);
      if (opened.dev !== authority.metadata.dev || opened.ino !== authority.metadata.ino) {
        throw new DaemonAuthoritySafetyError("The named daemon authority database changed while it was opened.");
      }
      database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
    } catch (error: unknown) {
      database.close();
      if (isBusy(error)) throw new DaemonAuthorityBusyError(await readDaemonAuthorityReceipt(paths).catch(() => null));
      throw new Error("The daemon authority database is invalid and requires manual recovery.", { cause: error });
    }
    const now = input.now ?? Date.now();
    const receipt = daemonAuthorityReceiptSchema.parse({
      version: 2,
      protocol: DAEMON_PROTOCOL,
      pid: input.pid ?? process.pid,
      nonce: input.nonce ?? randomUUID(),
      state: input.state ?? "booting",
      acquiredAt: now,
      updatedAt: now,
    });
    try {
      const named = await validateOwnedRegularFile(authority.path);
      if (named.dev !== authority.metadata.dev || named.ino !== authority.metadata.ino) {
        throw new DaemonAuthoritySafetyError("The named daemon authority database changed during acquisition.");
      }
      await writeReceipt(paths.daemonLock, receipt);
      return new DaemonLock(paths, database, {
        path: authority.path,
        device: authority.metadata.dev,
        inode: authority.metadata.ino,
      }, receipt);
    } catch (error: unknown) {
      try { database.exec("ROLLBACK"); } catch { /* Closing still releases the OS lock. */ }
      database.close();
      throw error;
    }
  }

  static async isAuthorityHeld(paths: StatePaths): Promise<boolean> {
    const databasePath = daemonAuthorityDatabasePath(paths);
    let before: Stats;
    try {
      before = await validateOwnedRegularFile(databasePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const database = new Database(databasePath, { create: false, strict: true });
    try {
      const opened = await validateOwnedRegularFile(databasePath);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new DaemonAuthoritySafetyError("The named daemon authority database changed while it was inspected.");
      }
      database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
      database.exec("ROLLBACK");
      return false;
    } catch (error: unknown) {
      if (isBusy(error)) return true;
      throw new Error("The daemon authority database is invalid and requires manual recovery.", { cause: error });
    } finally {
      database.close();
    }
  }

  async publish(input: {
    state: DaemonAuthorityReceipt["state"];
    generation?: number;
    bootId?: string;
    failure?: string;
    now?: number;
  }): Promise<DaemonAuthorityReceipt> {
    if (this.#released) throw new Error("The daemon authority has already been released.");
    await this.#validateAuthorityName();
    const next = daemonAuthorityReceiptSchema.parse({
      ...this.#receipt,
      state: input.state,
      updatedAt: Math.max(input.now ?? Date.now(), this.#receipt.updatedAt),
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      ...(input.bootId === undefined ? {} : { bootId: input.bootId }),
      ...(input.failure === undefined ? {} : { failure: input.failure.slice(0, 1_000) }),
    });
    await writeReceipt(this.#paths.daemonLock, next);
    this.#receipt = next;
    return next;
  }

  async release(input: { state?: "stopped" | "failed"; failure?: string; now?: number } = {}): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const errors: unknown[] = [];
    try {
      await this.#validateAuthorityName();
      const state = input.state ?? (this.#receipt.state === "failed" ? "failed" : "stopped");
      const failure = state === "failed"
        ? input.failure ?? this.#receipt.failure ?? "Daemon authority released after an unspecified failure."
        : undefined;
      const next = daemonAuthorityReceiptSchema.parse({
        ...this.#receipt,
        state,
        updatedAt: Math.max(input.now ?? Date.now(), this.#receipt.updatedAt),
        ...(failure === undefined ? {} : { failure: failure.slice(0, 1_000) }),
      });
      await writeReceipt(this.#paths.daemonLock, next);
      this.#receipt = next;
    } catch (error: unknown) {
      errors.push(error);
    }
    try { this.#database.exec("ROLLBACK"); } catch (error: unknown) { errors.push(error); }
    try { this.#database.close(); } catch (error: unknown) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "Daemon authority release was incomplete.");
  }
}
