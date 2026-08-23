import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { ensurePrivateDirectory, type StatePaths } from "./paths";

const pointerSchema = z.object({ version: z.literal(1), generation: z.number().int().nonnegative(), nonce: z.string().uuid(), digest: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();
const lockSchema = z.object({ version: z.literal(1), pid: z.number().int().positive(), nonce: z.string().uuid() }).strict();
const slotPattern = /^[a-z][a-z0-9-]{0,63}$/u;
export const HRA_KEYCHAIN_SERVICE = "sh.hra.control-plane.v1";

export interface SecretBackend {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export class BunSecretBackend implements SecretBackend {
  readonly #service: string;
  constructor(service = HRA_KEYCHAIN_SERVICE) { this.#service = service; }
  async get(account: string): Promise<string | null> {
    return await Bun.secrets.get({ service: this.#service, name: account });
  }
  async set(account: string, value: string): Promise<void> {
    await Bun.secrets.set({ service: this.#service, name: account, value });
  }
  async delete(account: string): Promise<boolean> {
    return await Bun.secrets.delete({ service: this.#service, name: account });
  }
}

export class FileSecretBackend implements SecretBackend {
  readonly #root: string;
  constructor(root: string) { this.#root = root; }
  async #prepare(): Promise<void> { await ensurePrivateDirectory(this.#root); }
  #path(account: string): string {
    if (!/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(account)) throw new Error("Invalid secret account.");
    return join(this.#root, account);
  }
  async get(account: string): Promise<string | null> {
    await this.#prepare();
    const path = this.#path(account);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error("Unsafe secret file.");
      return await readFile(path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async set(account: string, value: string): Promise<void> {
    await this.#prepare();
    const path = this.#path(account);
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await chmod(path, 0o600);
  }
  async delete(account: string): Promise<boolean> {
    try { await unlink(this.#path(account)); return true; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
}

export type SecretObservation = { generation: number; value: string };

type SlotLock = { handle: FileHandle; device: number; inode: number; path: string };

export class GenerationalSecretCustody {
  readonly #metadataRoot: string;
  readonly #backend: SecretBackend;

  constructor(paths: StatePaths, backend?: SecretBackend) {
    this.#metadataRoot = join(paths.root, "secret-metadata");
    this.#backend = backend ?? (process.platform === "darwin" ? new BunSecretBackend() : new FileSecretBackend(join(paths.root, "secret-values")));
  }

  async read(slot: string): Promise<SecretObservation | null> {
    return await this.#withSlotLock(slot, async () => this.#readUnlocked(slot));
  }

  async #readUnlocked(slot: string): Promise<SecretObservation | null> {
    const pointer = await this.#readPointer(slot);
    if (pointer === null) return null;
    const value = await this.#backend.get(this.#account(slot, pointer.generation, pointer.nonce));
    if (value === null) throw new Error("Secret pointer refers to a missing immutable value.");
    if (createHash("sha256").update(value).digest("hex") !== pointer.digest) throw new Error("Secret value does not match its committed digest.");
    return { generation: pointer.generation, value };
  }

  async compareAndSwap(slot: string, expectedGeneration: number | null, value: string): Promise<SecretObservation | null> {
    if (value.length === 0 || new TextEncoder().encode(value).byteLength > 65_536) throw new Error("Secret value is outside the custody bound.");
    return await this.#withSlotLock(slot, async () => {
      const current = await this.#readUnlocked(slot);
      if ((current?.generation ?? null) !== expectedGeneration) return null;
      const generation = expectedGeneration === null ? 0 : expectedGeneration + 1;
      const nonce = crypto.randomUUID();
      const digest = createHash("sha256").update(value).digest("hex");
      const account = this.#account(slot, generation, nonce);
      const existing = await this.#backend.get(account);
      if (existing !== null) throw new Error("Immutable secret generation already exists.");
      await this.#backend.set(account, value);
      try {
        await this.#publishPointer(slot, { version: 1, generation, nonce, digest });
      } catch (error: unknown) {
        const resolved = await this.#readPointer(slot).catch(() => null);
        if (resolved?.generation !== generation || resolved.nonce !== nonce || resolved.digest !== digest) throw error;
      }
      return { generation, value };
    });
  }

  async clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    return await this.#withSlotLock(slot, async () => {
      const current = await this.#readPointer(slot);
      if (current?.generation !== expectedGeneration) return false;
      const pointer = this.#pointerPath(slot);
      await unlink(pointer);
      await this.#syncMetadataRoot();
      await this.#backend.delete(this.#account(slot, expectedGeneration, current.nonce)).catch(() => false);
      return true;
    });
  }

  async #readPointer(slot: string): Promise<z.infer<typeof pointerSchema> | null> {
    const path = this.#pointerPath(slot);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 || metadata.size > 256) throw new Error("Unsafe secret pointer.");
      return pointerSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async #publishPointer(slot: string, pointer: z.infer<typeof pointerSchema>): Promise<void> {
    await ensurePrivateDirectory(this.#metadataRoot);
    const target = this.#pointerPath(slot);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(pointer), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await this.#syncMetadataRoot();
  }

  #pointerPath(slot: string): string {
    this.#assertSlot(slot);
    return join(this.#metadataRoot, `${slot}.json`);
  }
  #account(slot: string, generation: number, nonce: string): string {
    this.#assertSlot(slot);
    return `${slot}.${generation}.${nonce}`;
  }
  #assertSlot(slot: string): void {
    if (!slotPattern.test(slot)) throw new Error("Invalid secret slot.");
  }

  async #syncMetadataRoot(): Promise<void> {
    const directory = await open(this.#metadataRoot, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async #withSlotLock<T>(slot: string, operation: () => Promise<T>): Promise<T> {
    this.#assertSlot(slot);
    await ensurePrivateDirectory(this.#metadataRoot);
    const lock = await this.#acquireSlotLock(slot);
    try { return await operation(); } finally { await this.#releaseSlotLock(lock); }
  }

  async #acquireSlotLock(slot: string): Promise<SlotLock> {
    const path = join(this.#metadataRoot, `${slot}.lock`);
    const deadline = Date.now() + 5_000;
    while (Date.now() <= deadline) {
      try {
        const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce: crypto.randomUUID() }), "utf8");
          await handle.sync();
          const metadata = await handle.stat();
          return { handle, device: metadata.dev, inode: metadata.ino, path };
        } catch (error: unknown) {
          await handle.close();
          await unlink(path).catch(() => undefined);
          throw error;
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const metadata = await lstat(path);
          if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 || metadata.size > 256) throw new Error("Unsafe secret slot lock.");
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          let payload: z.infer<typeof lockSchema>;
          try {
            const opened = await handle.stat();
            if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) continue;
            try {
              payload = lockSchema.parse(JSON.parse(await handle.readFile("utf8")) as unknown);
            } catch (parseError: unknown) {
              if (Date.now() - metadata.mtimeMs < 1_000) {
                await Bun.sleep(10);
                continue;
              }
              throw parseError;
            }
          } finally { await handle.close(); }
          let alive = true;
          try { process.kill(payload.pid, 0); } catch (processError: unknown) { alive = (processError as NodeJS.ErrnoException).code !== "ESRCH"; }
          if (!alive) await this.#quarantineStaleLock(path, metadata.dev, metadata.ino);
          else await Bun.sleep(10);
        } catch (inspectionError: unknown) {
          if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw inspectionError;
        }
      }
    }
    throw new Error("Secret slot is busy.");
  }

  async #quarantineStaleLock(path: string, device: number, inode: number): Promise<void> {
    const quarantine = `${path}.stale.${crypto.randomUUID()}`;
    await link(path, quarantine);
    try {
      const [current, linked] = await Promise.all([lstat(path), lstat(quarantine)]);
      if (current.dev !== device || current.ino !== inode || linked.dev !== device || linked.ino !== inode) throw new Error("Secret slot lock changed during recovery.");
      await unlink(path);
    } finally { await unlink(quarantine).catch(() => undefined); }
  }

  async #releaseSlotLock(lock: SlotLock): Promise<void> {
    try {
      const current = await lstat(lock.path);
      if (current.dev !== lock.device || current.ino !== lock.inode) throw new Error("Secret slot lock identity changed.");
      await unlink(lock.path);
    } finally { await lock.handle.close(); }
  }
}
