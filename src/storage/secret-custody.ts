import { createHash } from "node:crypto";
import { dlopen, read } from "bun:ffi";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  readFileSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  proveDescriptorAclAbsence,
  type DescriptorAclInspection,
  type DescriptorAclPolicy,
} from "./descriptor-security";
import { ensurePrivateDirectory, type StatePaths } from "./paths";

const safeGenerationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const lowercaseUuidSchema = z.string().uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
);
const locatorSchema = z.object({
  generation: safeGenerationSchema,
  nonce: lowercaseUuidSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const committedPointerSchema = z.object({
  version: z.literal(1),
  generation: safeGenerationSchema,
  nonce: lowercaseUuidSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const clearingPointerSchema = z.object({
  version: z.literal(2),
  state: z.literal("clearing"),
  generation: safeGenerationSchema,
  nonce: lowercaseUuidSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const clearedPointerSchema = z.object({
  version: z.literal(2),
  state: z.literal("cleared"),
  generation: safeGenerationSchema,
  nonce: lowercaseUuidSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const boundedCommittedPointerSchema = z.object({
  version: z.literal(3),
  state: z.literal("committed"),
  current: locatorSchema,
  retired: locatorSchema.optional(),
}).strict();
export const secretPointerSchema = z.union([
  committedPointerSchema,
  clearingPointerSchema,
  clearedPointerSchema,
  boundedCommittedPointerSchema,
]);

export type SecretPointer = z.infer<typeof secretPointerSchema>;
type SecretLocator = z.infer<typeof locatorSchema>;

const slotPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const accountPattern = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const staleLockSuffixPattern = /^\.stale\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAXIMUM_SECRET_BYTES = 65_536;
const MAXIMUM_POINTER_BYTES = 1_024;
export const MAXIMUM_LEGACY_STALE_LOCKS_PER_SLOT = 64;
const POSIX_ENOENT = 2;
const POSIX_EEXIST = 17;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

export interface SecretBackend {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

type DirectoryIdentity = Readonly<{ device: bigint; inode: bigint }>;
type HeldDirectory = Readonly<{ handle: FileHandle; identity: DirectoryIdentity }>;

const errorFromUnknown = (value: unknown, message: string): Error => value instanceof Error
  ? value
  : new Error(message, { cause: value });

const throwFailures = (failures: readonly unknown[], message: string): void => {
  if (failures.length === 0) return;
  if (failures.length === 1) throw errorFromUnknown(failures[0], message);
  throw new AggregateError(failures, message);
};

const attemptCloseDescriptor = (descriptor: number, failures: unknown[]): void => {
  try { closeSync(descriptor); } catch (error: unknown) { failures.push(error); }
};

const useDescriptor = <T>(
  descriptor: number,
  operation: () => T,
  message: string,
): T => {
  let result: T | undefined;
  const failures: unknown[] = [];
  try { result = operation(); } catch (error: unknown) { failures.push(error); }
  attemptCloseDescriptor(descriptor, failures);
  throwFailures(failures, message);
  return result as T;
};

const useDescriptorAsync = async <T>(
  descriptor: number,
  operation: () => Promise<T>,
  message: string,
): Promise<T> => {
  let result: T | undefined;
  const failures: unknown[] = [];
  try { result = await operation(); } catch (error: unknown) { failures.push(error); }
  attemptCloseDescriptor(descriptor, failures);
  throwFailures(failures, message);
  return result as T;
};

const ownerUid = (): bigint | undefined => {
  const owner = process.getuid?.();
  return owner === undefined ? undefined : BigInt(owner);
};

const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const directoryIdentity = (metadata: BigIntStats): DirectoryIdentity => ({
  device: metadata.dev,
  inode: metadata.ino,
});

const safeDirectory = (metadata: BigIntStats): boolean => {
  const owner = ownerUid();
  return metadata.isDirectory()
    && metadata.nlink >= 1n
    && (metadata.mode & 0o777n) === 0o700n
    && (owner === undefined || metadata.uid === owner);
};

const safeFile = (
  metadata: BigIntStats,
  minimumBytes: bigint,
  maximumBytes: bigint,
  minimumLinks = 1n,
  maximumLinks = 1n,
): boolean => {
  const owner = ownerUid();
  return metadata.isFile()
    && metadata.nlink >= minimumLinks
    && metadata.nlink <= maximumLinks
    && (metadata.mode & 0o777n) === 0o600n
    && (owner === undefined || metadata.uid === owner)
    && metadata.size >= minimumBytes
    && metadata.size <= maximumBytes;
};

type NativeDirectoryOperations = Readonly<{
  flock: (descriptor: number, operation: number) => number | null;
  linkAt: (
    sourceDirectoryDescriptor: number,
    sourceName: Uint8Array,
    targetDirectoryDescriptor: number,
    targetName: Uint8Array,
  ) => number | null;
  openAt: (
    directoryDescriptor: number,
    name: Uint8Array,
    flags: number,
    mode: number,
  ) => Readonly<{ descriptor: number }> | Readonly<{ errno: number }>;
  renameAt: (
    sourceDirectoryDescriptor: number,
    sourceName: Uint8Array,
    targetDirectoryDescriptor: number,
    targetName: Uint8Array,
  ) => number | null;
  unlinkAt: (directoryDescriptor: number, name: Uint8Array) => number | null;
}>;

const nativeLibraryNames = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): readonly string[] => {
  if (platform === "darwin") return ["/usr/lib/libSystem.B.dylib"];
  if (platform !== "linux") return [];
  const muslArchitecture = architecture === "x64"
    ? "x86_64"
    : architecture === "arm64"
      ? "aarch64"
      : null;
  if (muslArchitecture === null) return ["libc.so.6"];
  const musl = `libc.musl-${muslArchitecture}.so.1`;
  return ["libc.so.6", musl, `/lib/${musl}`, `/usr/lib/${musl}`];
};

const loadNativeDirectoryOperations = (): NativeDirectoryOperations | null => {
  for (const libraryName of nativeLibraryNames(process.platform, process.arch)) {
    try {
      if (process.platform === "darwin") {
        const library = dlopen(libraryName, {
          flock: { args: ["i32", "i32"], returns: "i32" },
          linkat: { args: ["i32", "cstring", "i32", "cstring", "i32"], returns: "i32" },
          openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
          renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
          unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
          __error: { args: [], returns: "ptr" },
        });
        const errno = (): number => {
          const pointer = library.symbols.__error();
          if (pointer === null) throw new Error("Native directory error state is unavailable.");
          return read.i32(pointer);
        };
        return {
          flock: (descriptor, operation) => library.symbols.flock(descriptor, operation) === 0
            ? null
            : errno(),
          linkAt: (sourceDescriptor, source, targetDescriptor, target) =>
            library.symbols.linkat(sourceDescriptor, source, targetDescriptor, target, 0) === 0
              ? null
              : errno(),
          openAt: (directoryDescriptor, name, flags, mode) => {
            const descriptor = library.symbols.openat(directoryDescriptor, name, flags, mode);
            return descriptor >= 0 ? { descriptor } : { errno: errno() };
          },
          renameAt: (sourceDescriptor, source, targetDescriptor, target) =>
            library.symbols.renameat(sourceDescriptor, source, targetDescriptor, target) === 0
              ? null
              : errno(),
          unlinkAt: (directoryDescriptor, name) =>
            library.symbols.unlinkat(directoryDescriptor, name, 0) === 0 ? null : errno(),
        };
      }
      const library = dlopen(libraryName, {
        flock: { args: ["i32", "i32"], returns: "i32" },
        linkat: { args: ["i32", "cstring", "i32", "cstring", "i32"], returns: "i32" },
        openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
        renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
        unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
        __errno_location: { args: [], returns: "ptr" },
      });
      const errno = (): number => {
        const pointer = library.symbols.__errno_location();
        if (pointer === null) throw new Error("Native directory error state is unavailable.");
        return read.i32(pointer);
      };
      return {
        flock: (descriptor, operation) => library.symbols.flock(descriptor, operation) === 0
          ? null
          : errno(),
        linkAt: (sourceDescriptor, source, targetDescriptor, target) =>
          library.symbols.linkat(sourceDescriptor, source, targetDescriptor, target, 0) === 0
            ? null
            : errno(),
        openAt: (directoryDescriptor, name, flags, mode) => {
          const descriptor = library.symbols.openat(directoryDescriptor, name, flags, mode);
          return descriptor >= 0 ? { descriptor } : { errno: errno() };
        },
        renameAt: (sourceDescriptor, source, targetDescriptor, target) =>
          library.symbols.renameat(sourceDescriptor, source, targetDescriptor, target) === 0
            ? null
            : errno(),
        unlinkAt: (directoryDescriptor, name) =>
          library.symbols.unlinkat(directoryDescriptor, name, 0) === 0 ? null : errno(),
      };
    } catch {
      // Try the next platform libc. Custody fails closed when no candidate loads.
    }
  }
  return null;
};

let processNativeDirectoryOperations: NativeDirectoryOperations | null | undefined;

const nativeDirectoryOperations = (): NativeDirectoryOperations => {
  if (processNativeDirectoryOperations === undefined) {
    processNativeDirectoryOperations = loadNativeDirectoryOperations();
  }
  if (processNativeDirectoryOperations === null) {
    throw new Error("Descriptor-relative secret operations are unavailable.");
  }
  return processNativeDirectoryOperations;
};

const closeOnExecFlag = (): number => process.platform === "darwin"
  ? 0x01000000
  : process.platform === "linux"
    ? 0x00080000
    : 0;

const directoryOpenFlags = (): number => constants.O_RDONLY
  | constants.O_DIRECTORY
  | constants.O_NOFOLLOW
  | constants.O_NONBLOCK
  | closeOnExecFlag();

const encodeNativeName = <T>(name: string, operation: (encoded: Uint8Array) => T): T => {
  const encoded = Buffer.from(`${name}\0`, "utf8");
  try {
    return operation(encoded);
  } finally {
    encoded.fill(0);
  }
};

const withEncodedNativeNames = <T>(
  sourceName: string,
  targetName: string,
  operation: (source: Uint8Array, target: Uint8Array) => T,
): T => encodeNativeName(
  sourceName,
  (source) => encodeNativeName(targetName, (target) => operation(source, target)),
);

const openFileAt = (
  directoryDescriptor: number,
  name: string,
  flags: number,
  mode = 0,
): Readonly<{ descriptor: number }> | Readonly<{ errno: number }> => encodeNativeName(
  name,
  (encoded) => nativeDirectoryOperations().openAt(
    directoryDescriptor,
    encoded,
    flags | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExecFlag(),
    mode,
  ),
);

const linkFileAt = (
  directoryDescriptor: number,
  sourceName: string,
  targetName: string,
): number | null => withEncodedNativeNames(
  sourceName,
  targetName,
  (source, target) => nativeDirectoryOperations().linkAt(
    directoryDescriptor,
    source,
    directoryDescriptor,
    target,
  ),
);

const renameFileAt = (
  directoryDescriptor: number,
  sourceName: string,
  targetName: string,
): number | null => withEncodedNativeNames(
  sourceName,
  targetName,
  (source, target) => nativeDirectoryOperations().renameAt(
    directoryDescriptor,
    source,
    directoryDescriptor,
    target,
  ),
);

const unlinkFileAt = (directoryDescriptor: number, name: string): number | null =>
  encodeNativeName(
    name,
    (encoded) => nativeDirectoryOperations().unlinkAt(directoryDescriptor, encoded),
  );

type FlockOperation = (descriptor: number, operation: number) => number | null;

const acquireFlock = async (
  descriptor: number,
  flock: FlockOperation,
  busyMessage: string,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    const error = flock(descriptor, LOCK_EX | LOCK_NB);
    if (error === null) return;
    if (error !== 11 && error !== 35) throw new Error("Secret descriptor lock failed.");
    await Bun.sleep(10);
  }
  throw new Error(busyMessage);
};

const releaseFlock = (descriptor: number, flock: FlockOperation): void => {
  if (flock(descriptor, LOCK_UN) !== null) throw new Error("Secret descriptor unlock failed.");
};

type CommonSecurityOperations = DescriptorAclPolicy & Readonly<{
  flock?: FlockOperation;
}>;

export type FileSecretBackendOperations = CommonSecurityOperations & Readonly<{
  beforeLinkAt?: (account: string) => Promise<void>;
  beforeOpenAt?: (operation: "get" | "set" | "delete", account: string) => Promise<void>;
  beforeUnlinkAt?: (account: string) => Promise<void>;
  linkAt?: (directoryDescriptor: number, sourceName: string, targetName: string) => number | null;
  syncDirectory?: (handle: FileHandle) => Promise<void>;
  unlinkAt?: (directoryDescriptor: number, name: string) => number | null;
}>;

type PendingValue = Readonly<{ descriptor: number; name: string }>;

export class FileSecretBackend implements SecretBackend {
  readonly #root: string;
  readonly #aclPolicy: DescriptorAclPolicy;
  readonly #flock: FlockOperation;
  readonly #beforeLinkAt: NonNullable<FileSecretBackendOperations["beforeLinkAt"]>;
  readonly #beforeOpenAt: NonNullable<FileSecretBackendOperations["beforeOpenAt"]>;
  readonly #beforeUnlinkAt: NonNullable<FileSecretBackendOperations["beforeUnlinkAt"]>;
  readonly #linkAt: NonNullable<FileSecretBackendOperations["linkAt"]>;
  readonly #syncDirectory: NonNullable<FileSecretBackendOperations["syncDirectory"]>;
  readonly #unlinkAt: NonNullable<FileSecretBackendOperations["unlinkAt"]>;
  #rootIdentity: DirectoryIdentity | undefined;

  constructor(root: string, operations: FileSecretBackendOperations = {}) {
    this.#root = root;
    this.#aclPolicy = {
      ...(operations.inspectDarwinAcl === undefined
        ? {}
        : { inspectDarwinAcl: operations.inspectDarwinAcl }),
      ...(operations.platform === undefined ? {} : { platform: operations.platform }),
    };
    this.#flock = operations.flock ?? ((descriptor, operation) =>
      nativeDirectoryOperations().flock(descriptor, operation));
    this.#beforeLinkAt = operations.beforeLinkAt ?? (async () => undefined);
    this.#beforeOpenAt = operations.beforeOpenAt ?? (async () => undefined);
    this.#beforeUnlinkAt = operations.beforeUnlinkAt ?? (async () => undefined);
    this.#linkAt = operations.linkAt ?? linkFileAt;
    this.#syncDirectory = operations.syncDirectory ?? (async (handle) => await handle.sync());
    this.#unlinkAt = operations.unlinkAt ?? unlinkFileAt;
  }

  #accountName(account: string): string {
    if (!accountPattern.test(account)) throw new Error("Invalid secret account.");
    return account;
  }

  #pendingName(account: string): string {
    return `.${this.#accountName(account)}.pending`;
  }

  #proveAcl(descriptor: number, message: string): void {
    proveDescriptorAclAbsence(descriptor, this.#aclPolicy, message);
  }

  async #assertRootIdentity(identity: DirectoryIdentity): Promise<void> {
    const [metadata, canonical] = await Promise.all([
      lstat(this.#root, { bigint: true }),
      realpath(this.#root),
    ]);
    if (
      !safeDirectory(metadata)
      || metadata.isSymbolicLink()
      || metadata.dev !== identity.device
      || metadata.ino !== identity.inode
      || canonical !== resolve(this.#root)
    ) throw new Error("Secret root identity changed.");
  }

  async #openRoot(): Promise<HeldDirectory> {
    if (this.#rootIdentity === undefined) await ensurePrivateDirectory(this.#root);
    const handle = await open(this.#root, directoryOpenFlags());
    try {
      const metadata = fstatSync(handle.fd, { bigint: true });
      if (!safeDirectory(metadata)) throw new Error("Unsafe secret root.");
      this.#proveAcl(handle.fd, "Unsafe secret root ACL.");
      const identity = directoryIdentity(metadata);
      await this.#assertRootIdentity(identity);
      if (
        this.#rootIdentity !== undefined
        && (
          this.#rootIdentity.device !== identity.device
          || this.#rootIdentity.inode !== identity.inode
        )
      ) throw new Error("Secret root identity changed.");
      this.#rootIdentity = identity;
      return { handle, identity };
    } catch (error: unknown) {
      const failures: unknown[] = [error];
      try { await handle.close(); } catch (cleanup: unknown) { failures.push(cleanup); }
      throwFailures(failures, "Secret root admission and cleanup failed.");
      throw new Error("unreachable");
    }
  }

  async #syncRoot(root: HeldDirectory): Promise<void> {
    this.#proveAcl(root.handle.fd, "Unsafe secret root ACL.");
    await this.#syncDirectory(root.handle);
    this.#proveAcl(root.handle.fd, "Unsafe secret root ACL.");
    await this.#assertRootIdentity(root.identity);
  }

  async #openPending(root: HeldDirectory, account: string): Promise<PendingValue> {
    const name = this.#pendingName(account);
    const deadline = Date.now() + 5_000;
    while (Date.now() <= deadline) {
      let opened = openFileAt(
        root.handle.fd,
        name,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
      if ("errno" in opened && opened.errno === POSIX_EEXIST) {
        opened = openFileAt(root.handle.fd, name, constants.O_RDWR);
      }
      if ("errno" in opened) throw new Error("Secret pending value open failed.");
      let retry = false;
      try {
        await acquireFlock(opened.descriptor, this.#flock, "Secret account is busy.");
        const metadata = fstatSync(opened.descriptor, { bigint: true });
        const owner = ownerUid();
        if (
          !metadata.isFile()
          || metadata.nlink < 1n
          || metadata.nlink > 2n
          || (owner !== undefined && metadata.uid !== owner)
          || metadata.size > BigInt(MAXIMUM_SECRET_BYTES)
        ) throw new Error("Unsafe secret pending value.");
        fchmodSync(opened.descriptor, 0o600);
        const protectedMetadata = fstatSync(opened.descriptor, { bigint: true });
        if ((protectedMetadata.mode & 0o777n) !== 0o600n) {
          throw new Error("Unsafe secret pending value.");
        }
        this.#proveAcl(opened.descriptor, "Unsafe secret value ACL.");

        // A waiter may have opened the pending inode before the prior writer
        // atomically linked and unlinked its name. After acquiring flock, prove
        // that this descriptor still names the deterministic pending account.
        const current = openFileAt(root.handle.fd, name, constants.O_RDWR);
        if ("errno" in current) {
          if (current.errno !== POSIX_ENOENT) {
            throw new Error("Secret pending value identity check failed.");
          }
          retry = true;
        } else {
          retry = useDescriptor(
            current.descriptor,
            () => !sameIdentity(
              protectedMetadata,
              fstatSync(current.descriptor, { bigint: true }),
            ),
            "Secret pending value identity check cleanup failed.",
          );
        }
        if (!retry) return { descriptor: opened.descriptor, name };
      } catch (error: unknown) {
        const failures: unknown[] = [error];
        try { releaseFlock(opened.descriptor, this.#flock); } catch (cleanup: unknown) { failures.push(cleanup); }
        try { closeSync(opened.descriptor); } catch (cleanup: unknown) { failures.push(cleanup); }
        throwFailures(failures, "Secret pending value admission failed.");
        throw new Error("unreachable");
      }
      const failures: unknown[] = [];
      try { releaseFlock(opened.descriptor, this.#flock); } catch (cleanup: unknown) { failures.push(cleanup); }
      try { closeSync(opened.descriptor); } catch (cleanup: unknown) { failures.push(cleanup); }
      throwFailures(failures, "Secret pending value retry cleanup failed.");
      await Bun.sleep(0);
    }
    throw new Error("Secret account is busy.");
  }

  #proveValue(
    descriptor: number,
    minimumLinks = 1n,
    maximumLinks = 1n,
  ): BigIntStats {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (!safeFile(
      metadata,
      1n,
      BigInt(MAXIMUM_SECRET_BYTES),
      minimumLinks,
      maximumLinks,
    )) throw new Error("Unsafe secret file.");
    this.#proveAcl(descriptor, "Unsafe secret value ACL.");
    return metadata;
  }

  #readValue(descriptor: number, minimumLinks = 1n, maximumLinks = 1n): Buffer {
    const before = this.#proveValue(descriptor, minimumLinks, maximumLinks);
    const value = readFileSync(descriptor);
    const after = this.#proveValue(descriptor, minimumLinks, maximumLinks);
    if (
      !sameIdentity(before, after)
      || before.size !== after.size
      || BigInt(value.byteLength) !== before.size
    ) throw new Error("Secret value changed while reading.");
    return value;
  }

  async #unlinkPending(root: HeldDirectory, pending: PendingValue): Promise<void> {
    this.#proveAcl(pending.descriptor, "Unsafe secret value ACL.");
    await this.#beforeUnlinkAt(pending.name);
    const before = fstatSync(pending.descriptor, { bigint: true });
    const errno = this.#unlinkAt(root.handle.fd, pending.name);
    if (errno !== null) throw new Error("Descriptor-relative secret unlink failed.");
    const after = fstatSync(pending.descriptor, { bigint: true });
    this.#proveAcl(pending.descriptor, "Unsafe secret value ACL.");
    if (!sameIdentity(before, after) || after.nlink !== before.nlink - 1n) {
      throw new Error("Secret pending value unlink could not be proven.");
    }
  }

  async #withPending<T>(
    account: string,
    operation: (root: HeldDirectory, pending: PendingValue) => Promise<T>,
  ): Promise<T> {
    const root = await this.#openRoot();
    let pending: PendingValue;
    try {
      pending = await this.#openPending(root, account);
    } catch (error: unknown) {
      const failures: unknown[] = [error];
      try { await root.handle.close(); } catch (cleanup: unknown) { failures.push(cleanup); }
      throwFailures(failures, "Secret pending value acquisition failed.");
      throw new Error("unreachable");
    }
    let result: T | undefined;
    const failures: unknown[] = [];
    try { result = await operation(root, pending); } catch (error: unknown) { failures.push(error); }
    try { releaseFlock(pending.descriptor, this.#flock); } catch (error: unknown) { failures.push(error); }
    try { closeSync(pending.descriptor); } catch (error: unknown) { failures.push(error); }
    try { await root.handle.close(); } catch (error: unknown) { failures.push(error); }
    throwFailures(failures, "Secret value operation and cleanup failed.");
    return result as T;
  }

  async get(account: string): Promise<string | null> {
    const name = this.#accountName(account);
    const root = await this.#openRoot();
    let finalDescriptor: number | undefined;
    let pendingDescriptor: number | undefined;
    let pendingLocked = false;
    const failures: unknown[] = [];
    let result: string | null = null;
    try {
      await this.#beforeOpenAt("get", name);
      const opened = openFileAt(root.handle.fd, name, constants.O_RDONLY);
      if ("errno" in opened) {
        if (opened.errno !== POSIX_ENOENT) throw new Error("Descriptor-relative secret open failed.");
        this.#proveAcl(root.handle.fd, "Unsafe secret root ACL.");
        await this.#assertRootIdentity(root.identity);
      } else {
        finalDescriptor = opened.descriptor;
        let metadata = this.#proveValue(finalDescriptor, 1n, 2n);
        if (metadata.nlink === 2n) {
          const pending = openFileAt(root.handle.fd, this.#pendingName(name), constants.O_RDWR);
          if ("errno" in pending) {
            if (pending.errno !== POSIX_ENOENT) {
              throw new Error("Linked secret pending value open failed.");
            }
            metadata = this.#proveValue(finalDescriptor);
          } else {
            pendingDescriptor = pending.descriptor;
            await acquireFlock(pendingDescriptor, this.#flock, "Secret account is busy.");
            pendingLocked = true;
            const pendingMetadata = fstatSync(pendingDescriptor, { bigint: true });
            metadata = this.#proveValue(finalDescriptor, 1n, 2n);
            if (!sameIdentity(metadata, pendingMetadata)) {
              throw new Error("Secret pending publication identity changed.");
            }
            if (metadata.nlink === 2n) {
              const current = openFileAt(
                root.handle.fd,
                this.#pendingName(name),
                constants.O_RDWR,
              );
              if ("errno" in current) {
                if (current.errno !== POSIX_ENOENT) {
                  throw new Error("Secret pending publication identity check failed.");
                }
                metadata = this.#proveValue(finalDescriptor);
              } else {
                useDescriptor(
                  current.descriptor,
                  () => {
                  if (!sameIdentity(
                    metadata,
                    fstatSync(current.descriptor, { bigint: true }),
                  )) throw new Error("Secret pending publication identity changed.");
                  },
                  "Secret pending publication identity check cleanup failed.",
                );
                await this.#syncRoot(root);
                this.#proveAcl(finalDescriptor, "Unsafe secret value ACL.");
                await this.#beforeUnlinkAt(this.#pendingName(name));
                if (this.#unlinkAt(root.handle.fd, this.#pendingName(name)) !== null) {
                  throw new Error("Descriptor-relative secret unlink failed.");
                }
                if (fstatSync(finalDescriptor, { bigint: true }).nlink !== 1n) {
                  throw new Error("Secret pending publication cleanup could not be proven.");
                }
                this.#proveAcl(finalDescriptor, "Unsafe secret value ACL.");
                await this.#syncRoot(root);
              }
            }
          }
        }
        const bytes = this.#readValue(finalDescriptor);
        try {
          result = bytes.toString("utf8");
        } finally {
          bytes.fill(0);
        }
        this.#proveAcl(root.handle.fd, "Unsafe secret root ACL.");
        await this.#assertRootIdentity(root.identity);
      }
    } catch (error: unknown) {
      failures.push(error);
    }
    if (pendingDescriptor !== undefined && pendingLocked) {
      try { releaseFlock(pendingDescriptor, this.#flock); } catch (error: unknown) { failures.push(error); }
    }
    if (pendingDescriptor !== undefined) {
      try { closeSync(pendingDescriptor); } catch (error: unknown) { failures.push(error); }
    }
    if (finalDescriptor !== undefined) {
      try { closeSync(finalDescriptor); } catch (error: unknown) { failures.push(error); }
    }
    try { await root.handle.close(); } catch (error: unknown) { failures.push(error); }
    throwFailures(failures, "Secret value read and cleanup failed.");
    return result;
  }

  async set(account: string, value: string): Promise<void> {
    const name = this.#accountName(account);
    const desired = Buffer.from(value, "utf8");
    if (desired.byteLength < 1 || desired.byteLength > MAXIMUM_SECRET_BYTES) {
      desired.fill(0);
      throw new Error("Secret value is outside the custody bound.");
    }
    try {
      await this.#withPending(name, async (root, pending) => {
        await this.#beforeOpenAt("set", name);
        const existing = openFileAt(root.handle.fd, name, constants.O_RDONLY);
        if ("descriptor" in existing) {
          await useDescriptorAsync(
            existing.descriptor,
            async () => {
              const finalMetadata = this.#proveValue(existing.descriptor, 1n, 2n);
              const pendingMetadata = fstatSync(pending.descriptor, { bigint: true });
              if (finalMetadata.nlink === 2n && sameIdentity(finalMetadata, pendingMetadata)) {
                const published = this.#readValue(existing.descriptor, 2n, 2n);
                const matches = published.equals(desired);
                published.fill(0);
                await this.#syncRoot(root);
                await this.#unlinkPending(root, pending);
                if (fstatSync(existing.descriptor, { bigint: true }).nlink !== 1n) {
                  throw new Error("Secret publication cleanup could not be proven.");
                }
                this.#proveAcl(existing.descriptor, "Unsafe secret value ACL.");
                await this.#syncRoot(root);
                if (matches) return;
                const conflict: NodeJS.ErrnoException = new Error(
                  "Immutable secret value already exists.",
                );
                conflict.code = "EEXIST";
                throw conflict;
              }
              if (finalMetadata.nlink !== 1n) throw new Error("Unsafe secret file.");
              const conflict: NodeJS.ErrnoException = new Error(
                "Immutable secret value already exists.",
              );
              conflict.code = "EEXIST";
              const cleanupFailures: unknown[] = [conflict];
              try {
                if (pendingMetadata.nlink !== 1n) throw new Error("Unsafe secret pending value.");
                await this.#unlinkPending(root, pending);
                await this.#syncRoot(root);
              } catch (cleanup: unknown) {
                cleanupFailures.push(cleanup);
              }
              throwFailures(cleanupFailures, "Immutable secret conflict cleanup failed.");
            },
            "Existing immutable secret inspection and cleanup failed.",
          );
          return;
        }
        if (existing.errno !== POSIX_ENOENT) throw new Error("Descriptor-relative secret open failed.");
        const pendingMetadata = fstatSync(pending.descriptor, { bigint: true });
        if (pendingMetadata.nlink !== 1n) throw new Error("Unsafe secret pending value.");
        this.#proveAcl(pending.descriptor, "Unsafe secret value ACL.");
        ftruncateSync(pending.descriptor, 0);
        let written = 0;
        while (written < desired.byteLength) {
          written += writeSync(
            pending.descriptor,
            desired,
            written,
            desired.byteLength - written,
            written,
          );
        }
        fchmodSync(pending.descriptor, 0o600);
        fsyncSync(pending.descriptor);
        const staged = this.#proveValue(pending.descriptor);
        if (staged.size !== BigInt(desired.byteLength)) {
          throw new Error("Secret pending value publication could not be proven.");
        }
        await this.#beforeLinkAt(name);
        const linkError = this.#linkAt(root.handle.fd, pending.name, name);
        if (linkError !== null) {
          if (linkError === POSIX_EEXIST) {
            const conflict: NodeJS.ErrnoException = new Error("Immutable secret value already exists.");
            conflict.code = "EEXIST";
            throw conflict;
          }
          throw new Error("Descriptor-relative secret publication failed.");
        }
        const published = openFileAt(root.handle.fd, name, constants.O_RDONLY);
        if ("errno" in published) {
          throw new Error("Secret immutable publication could not be proven.");
        }
        await useDescriptorAsync(
          published.descriptor,
          async () => {
            const pendingLinked = this.#proveValue(pending.descriptor, 2n, 2n);
            const finalLinked = this.#proveValue(published.descriptor, 2n, 2n);
            if (!sameIdentity(pendingLinked, finalLinked)) {
              throw new Error("Secret immutable publication could not be proven.");
            }
            await this.#syncRoot(root);
            await this.#unlinkPending(root, pending);
            const pendingAfter = this.#proveValue(pending.descriptor);
            const finalAfter = this.#proveValue(published.descriptor);
            if (
              !sameIdentity(pendingLinked, pendingAfter)
              || !sameIdentity(finalLinked, finalAfter)
            ) throw new Error("Secret immutable publication cleanup could not be proven.");

            const lingering = openFileAt(root.handle.fd, pending.name, constants.O_RDONLY);
            if ("descriptor" in lingering) {
              useDescriptor(
                lingering.descriptor,
                () => { throw new Error("Secret pending publication name still exists."); },
                "Secret pending publication name inspection cleanup failed.",
              );
            } else if (lingering.errno !== POSIX_ENOENT) {
              throw new Error("Secret pending publication absence could not be proven.");
            }
            const current = openFileAt(root.handle.fd, name, constants.O_RDONLY);
            if ("errno" in current) {
              throw new Error("Secret final publication name is missing.");
            }
            useDescriptor(
              current.descriptor,
              () => {
                const currentMetadata = this.#proveValue(current.descriptor);
                if (!sameIdentity(finalAfter, currentMetadata)) {
                  throw new Error("Secret final publication identity changed.");
                }
              },
              "Secret final publication identity inspection cleanup failed.",
            );
            await this.#syncRoot(root);
          },
          "Secret immutable publication inspection and cleanup failed.",
        );
      });
    } finally {
      desired.fill(0);
    }
  }

  async delete(account: string): Promise<boolean> {
    const name = this.#accountName(account);
    return await this.#withPending(name, async (root, pending) => {
      await this.#beforeOpenAt("delete", name);
      const opened = openFileAt(root.handle.fd, name, constants.O_RDONLY);
      let finalDescriptor: number | undefined;
      let existed = false;
      const failures: unknown[] = [];
      if ("descriptor" in opened) {
        finalDescriptor = opened.descriptor;
        try {
          this.#proveValue(finalDescriptor, 1n, 2n);
          existed = true;
          await this.#beforeUnlinkAt(name);
          const before = fstatSync(finalDescriptor, { bigint: true });
          if (this.#unlinkAt(root.handle.fd, name) !== null) {
            throw new Error("Descriptor-relative secret unlink failed.");
          }
          const after = fstatSync(finalDescriptor, { bigint: true });
          this.#proveAcl(finalDescriptor, "Unsafe secret value ACL.");
          if (!sameIdentity(before, after) || after.nlink !== before.nlink - 1n) {
            throw new Error("Secret final value unlink could not be proven.");
          }
        } catch (error: unknown) {
          failures.push(error);
        }
      } else if (opened.errno !== POSIX_ENOENT) {
        failures.push(new Error("Descriptor-relative secret open failed."));
      }
      try {
        const pendingMetadata = fstatSync(pending.descriptor, { bigint: true });
        if (pendingMetadata.nlink > 0n) await this.#unlinkPending(root, pending);
      } catch (error: unknown) {
        failures.push(error);
      }
      try { await this.#syncRoot(root); } catch (error: unknown) { failures.push(error); }
      if (finalDescriptor !== undefined) {
        try { closeSync(finalDescriptor); } catch (error: unknown) { failures.push(error); }
      }
      throwFailures(failures, "Secret deletion and cleanup failed.");
      return existed;
    });
  }
}

export type SecretObservation = { generation: number; value: string };

type MetadataChildOperation =
  | "lock-open"
  | "lock-stale-unlink"
  | "pointer-open"
  | "pointer-rename"
  | "pointer-unlink"
  | "pointer-write";

export type GenerationalSecretCustodyOperations = CommonSecurityOperations & Readonly<{
  beforeMetadataOperation?: (operation: MetadataChildOperation, name: string) => Promise<void>;
  renameAt?: (directoryDescriptor: number, sourceName: string, targetName: string) => number | null;
  syncMetadataDirectory?: (handle: FileHandle) => Promise<void>;
  unlinkAt?: (directoryDescriptor: number, name: string) => number | null;
}>;

type SlotLock = Readonly<{ descriptor: number; name: string }>;
type PendingPointerRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "pointer"; pointer: SecretPointer }>;

const locatorFromPointer = (pointer: SecretPointer): SecretLocator | null => {
  if (pointer.version === 1) {
    return { generation: pointer.generation, nonce: pointer.nonce, digest: pointer.digest };
  }
  if (pointer.version === 2) {
    return pointer.state === "cleared"
      ? null
      : { generation: pointer.generation, nonce: pointer.nonce, digest: pointer.digest };
  }
  return pointer.current;
};

const historicalLocator = (pointer: SecretPointer): SecretLocator => pointer.version === 2
  ? { generation: pointer.generation, nonce: pointer.nonce, digest: pointer.digest }
  : pointer.version === 1
    ? { generation: pointer.generation, nonce: pointer.nonce, digest: pointer.digest }
    : pointer.current;

const sameLocator = (left: SecretLocator, right: SecretLocator): boolean =>
  left.generation === right.generation
  && left.nonce === right.nonce
  && left.digest === right.digest;

const samePointer = (left: SecretPointer, right: SecretPointer): boolean => {
  if (left.version !== right.version) return false;
  if (left.version === 1 && right.version === 1) {
    return sameLocator(left, right);
  }
  if (left.version === 2 && right.version === 2) {
    return left.state === right.state
      && sameLocator(historicalLocator(left), historicalLocator(right));
  }
  if (left.version === 3 && right.version === 3) {
    return sameLocator(left.current, right.current)
      && (
        left.retired === undefined
          ? right.retired === undefined
          : right.retired !== undefined && sameLocator(left.retired, right.retired)
      );
  }
  return false;
};

export const isValidSecretPointerTransition = (
  authority: SecretPointer | null,
  desired: SecretPointer,
): boolean => {
  if (authority !== null && samePointer(authority, desired)) return true;
  if (desired.version === 3) {
    if (authority?.version === 2 && authority.state === "clearing") return false;
    if (authority?.version === 3 && authority.retired !== undefined) {
      return desired.retired === undefined && sameLocator(authority.current, desired.current);
    }
    const active = authority === null ? null : locatorFromPointer(authority);
    if (active === null) {
      const predecessor = authority === null ? -1 : historicalLocator(authority).generation;
      return desired.retired === undefined && desired.current.generation === predecessor + 1;
    }
    return desired.retired !== undefined
      && sameLocator(desired.retired, active)
      && active.generation < Number.MAX_SAFE_INTEGER
      && desired.current.generation === active.generation + 1;
  }
  if (desired.version === 2 && desired.state === "clearing") {
    const active = authority === null ? null : locatorFromPointer(authority);
    return active !== null && sameLocator(active, historicalLocator(desired));
  }
  if (desired.version === 2) {
    return authority?.version === 2
      && authority.state === "clearing"
      && sameLocator(historicalLocator(authority), historicalLocator(desired));
  }
  return false;
};

export class GenerationalSecretCustody {
  readonly #metadataRoot: string;
  readonly #backend: SecretBackend;
  readonly #aclPolicy: DescriptorAclPolicy;
  readonly #flock: FlockOperation;
  readonly #beforeMetadataOperation: NonNullable<GenerationalSecretCustodyOperations["beforeMetadataOperation"]>;
  readonly #renameAt: NonNullable<GenerationalSecretCustodyOperations["renameAt"]>;
  readonly #syncMetadataDirectory: NonNullable<GenerationalSecretCustodyOperations["syncMetadataDirectory"]>;
  readonly #unlinkAt: NonNullable<GenerationalSecretCustodyOperations["unlinkAt"]>;
  #metadataRootIdentity: DirectoryIdentity | undefined;

  constructor(
    paths: StatePaths,
    backend?: SecretBackend,
    operations: GenerationalSecretCustodyOperations = {},
  ) {
    this.#metadataRoot = join(paths.root, "secret-metadata");
    this.#backend = backend ?? new FileSecretBackend(join(paths.root, "secret-values"), operations);
    this.#aclPolicy = {
      ...(operations.inspectDarwinAcl === undefined
        ? {}
        : { inspectDarwinAcl: operations.inspectDarwinAcl }),
      ...(operations.platform === undefined ? {} : { platform: operations.platform }),
    };
    this.#flock = operations.flock ?? ((descriptor, operation) =>
      nativeDirectoryOperations().flock(descriptor, operation));
    this.#beforeMetadataOperation = operations.beforeMetadataOperation
      ?? (async () => undefined);
    this.#renameAt = operations.renameAt ?? renameFileAt;
    this.#syncMetadataDirectory = operations.syncMetadataDirectory
      ?? (async (handle) => await handle.sync());
    this.#unlinkAt = operations.unlinkAt ?? unlinkFileAt;
  }

  #assertSlot(slot: string): void {
    if (!slotPattern.test(slot)) throw new Error("Invalid secret slot.");
  }

  #pointerName(slot: string): string {
    this.#assertSlot(slot);
    return `${slot}.json`;
  }

  #pendingPointerName(slot: string): string {
    this.#assertSlot(slot);
    return `${slot}.pending.json`;
  }

  #account(slot: string, locator: SecretLocator): string {
    this.#assertSlot(slot);
    return `${slot}.${locator.generation}.${locator.nonce}`;
  }

  #proveAcl(descriptor: number, message: string): void {
    proveDescriptorAclAbsence(descriptor, this.#aclPolicy, message);
  }

  async #assertMetadataRootIdentity(identity: DirectoryIdentity): Promise<void> {
    const [metadata, canonical] = await Promise.all([
      lstat(this.#metadataRoot, { bigint: true }),
      realpath(this.#metadataRoot),
    ]);
    if (
      !safeDirectory(metadata)
      || metadata.isSymbolicLink()
      || metadata.dev !== identity.device
      || metadata.ino !== identity.inode
      || canonical !== resolve(this.#metadataRoot)
    ) throw new Error("Secret metadata root identity changed.");
  }

  async #openMetadataRoot(): Promise<HeldDirectory> {
    if (this.#metadataRootIdentity === undefined) await ensurePrivateDirectory(this.#metadataRoot);
    const handle = await open(this.#metadataRoot, directoryOpenFlags());
    try {
      const metadata = fstatSync(handle.fd, { bigint: true });
      if (!safeDirectory(metadata)) throw new Error("Unsafe secret metadata root.");
      this.#proveAcl(handle.fd, "Unsafe secret metadata root ACL.");
      const identity = directoryIdentity(metadata);
      await this.#assertMetadataRootIdentity(identity);
      if (
        this.#metadataRootIdentity !== undefined
        && (
          this.#metadataRootIdentity.device !== identity.device
          || this.#metadataRootIdentity.inode !== identity.inode
        )
      ) throw new Error("Secret metadata root identity changed.");
      this.#metadataRootIdentity = identity;
      return { handle, identity };
    } catch (error: unknown) {
      const failures: unknown[] = [error];
      try { await handle.close(); } catch (cleanup: unknown) { failures.push(cleanup); }
      throwFailures(failures, "Secret metadata root admission and cleanup failed.");
      throw new Error("unreachable");
    }
  }

  async #syncMetadataRoot(root: HeldDirectory): Promise<void> {
    this.#proveAcl(root.handle.fd, "Unsafe secret metadata root ACL.");
    await this.#syncMetadataDirectory(root.handle);
    this.#proveAcl(root.handle.fd, "Unsafe secret metadata root ACL.");
    await this.#assertMetadataRootIdentity(root.identity);
  }

  async #reconcileOldLockLinks(root: HeldDirectory, lock: SlotLock): Promise<void> {
    const canonicalBefore = fstatSync(lock.descriptor, { bigint: true });
    await this.#assertMetadataRootIdentity(root.identity);
    const names = await readdir(this.#metadataRoot);
    const prefix = lock.name;
    const staleNames = names.filter((name) =>
      name.startsWith(prefix)
      && staleLockSuffixPattern.test(name.slice(prefix.length)));
    if (staleNames.length > MAXIMUM_LEGACY_STALE_LOCKS_PER_SLOT) {
      throw new Error("Legacy secret lock recovery exceeds its bound.");
    }
    if (staleNames.length === 0) {
      if (canonicalBefore.nlink !== 1n) {
        throw new Error("Legacy secret lock links cannot be accounted for.");
      }
      return;
    }

    type LegacyLockRecord = {
      before: BigIntStats;
      descriptor: number;
      locked: boolean;
      names: string[];
    };
    const records = new Map<string, LegacyLockRecord>();
    const descriptors = new Set<number>();
    const failures: unknown[] = [];
    try {
      for (const name of staleNames) {
        const opened = openFileAt(root.handle.fd, name, constants.O_RDWR);
        if ("errno" in opened) {
          if (opened.errno === POSIX_ENOENT) continue;
          throw new Error("Legacy secret lock recovery failed.");
        }
        descriptors.add(opened.descriptor);
        const metadata = fstatSync(opened.descriptor, { bigint: true });
        const owner = ownerUid();
        if (
          !metadata.isFile()
          || metadata.nlink < 1n
          || (metadata.mode & 0o777n) !== 0o600n
          || (owner !== undefined && metadata.uid !== owner)
          || metadata.size > 256n
        ) throw new Error("Unsafe legacy secret lock artifact.");
        this.#proveAcl(opened.descriptor, "Unsafe secret slot lock ACL.");
        const key = `${metadata.dev.toString(16)}:${metadata.ino.toString(16)}`;
        const record = records.get(key);
        if (record === undefined) {
          records.set(key, {
            before: metadata,
            descriptor: opened.descriptor,
            locked: false,
            names: [name],
          });
        } else {
          record.names.push(name);
          const closeFailures: unknown[] = [];
          attemptCloseDescriptor(opened.descriptor, closeFailures);
          descriptors.delete(opened.descriptor);
          throwFailures(closeFailures, "Legacy duplicate lock descriptor cleanup failed.");
        }
      }

      for (const record of records.values()) {
        const isCanonical = sameIdentity(canonicalBefore, record.before);
        const expectedLinks = BigInt(record.names.length + (isCanonical ? 1 : 0));
        if (record.before.nlink !== expectedLinks) {
          throw new Error("Legacy secret lock links cannot be accounted for.");
        }
        if (!isCanonical) {
          await acquireFlock(
            record.descriptor,
            this.#flock,
            "Legacy secret slot recovery is busy.",
          );
          record.locked = true;
        }
      }

      for (const record of records.values()) {
        for (const name of record.names) {
          this.#proveAcl(record.descriptor, "Unsafe secret slot lock ACL.");
          await this.#beforeMetadataOperation("lock-stale-unlink", name);
          if (this.#unlinkAt(root.handle.fd, name) !== null) {
            throw new Error("Legacy secret lock unlink failed.");
          }
          this.#proveAcl(record.descriptor, "Unsafe secret slot lock ACL.");
        }
        const after = fstatSync(record.descriptor, { bigint: true });
        const expectedLinks = sameIdentity(canonicalBefore, record.before) ? 1n : 0n;
        if (!sameIdentity(record.before, after) || after.nlink !== expectedLinks) {
          throw new Error("Legacy secret lock cleanup could not be proven.");
        }
      }
      const canonicalAfter = fstatSync(lock.descriptor, { bigint: true });
      if (!sameIdentity(canonicalBefore, canonicalAfter) || canonicalAfter.nlink !== 1n) {
        throw new Error("Legacy secret lock cleanup could not be proven.");
      }
      await this.#syncMetadataRoot(root);
    } catch (error: unknown) {
      failures.push(error);
    }
    for (const record of [...records.values()].reverse()) {
      if (record.locked) {
        try { releaseFlock(record.descriptor, this.#flock); } catch (error: unknown) { failures.push(error); }
      }
    }
    for (const descriptor of [...descriptors].reverse()) {
      attemptCloseDescriptor(descriptor, failures);
    }
    throwFailures(failures, "Legacy secret lock recovery and cleanup failed.");
  }

  #lockIsCanonical(root: HeldDirectory, lock: SlotLock, expected: BigIntStats): boolean {
    const current = openFileAt(root.handle.fd, lock.name, constants.O_RDONLY);
    if ("errno" in current) {
      if (current.errno === POSIX_ENOENT) return false;
      throw new Error("Secret slot lock identity check failed.");
    }
    return useDescriptor(
      current.descriptor,
      () => {
        const metadata = fstatSync(current.descriptor, { bigint: true });
        this.#proveAcl(current.descriptor, "Unsafe secret slot lock ACL.");
        return sameIdentity(expected, metadata);
      },
      "Secret slot lock identity inspection cleanup failed.",
    );
  }

  async #acquireSlotLock(root: HeldDirectory, slot: string): Promise<SlotLock> {
    const name = `${slot}.lock`;
    const deadline = Date.now() + 5_000;
    while (Date.now() <= deadline) {
      await this.#beforeMetadataOperation("lock-open", name);
      let opened = openFileAt(
        root.handle.fd,
        name,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
      if ("errno" in opened && opened.errno === POSIX_EEXIST) {
        opened = openFileAt(root.handle.fd, name, constants.O_RDWR);
      }
      if ("errno" in opened) throw new Error("Secret slot lock open failed.");
      const lock = { descriptor: opened.descriptor, name };
      let retry = false;
      try {
        await acquireFlock(lock.descriptor, this.#flock, "Secret slot is busy.");
        const metadata = fstatSync(lock.descriptor, { bigint: true });
        const owner = ownerUid();
        if (
          !metadata.isFile()
          || metadata.nlink < 1n
          || (owner !== undefined && metadata.uid !== owner)
          || metadata.size > 256n
        ) throw new Error("Unsafe secret slot lock.");
        this.#proveAcl(lock.descriptor, "Unsafe secret slot lock ACL.");
        fchmodSync(lock.descriptor, 0o600);
        const protectedBefore = fstatSync(lock.descriptor, { bigint: true });
        if ((protectedBefore.mode & 0o777n) !== 0o600n) {
          throw new Error("Unsafe secret slot lock.");
        }
        retry = !this.#lockIsCanonical(root, lock, protectedBefore);
        if (!retry) {
          ftruncateSync(lock.descriptor, 0);
          fsyncSync(lock.descriptor);
          this.#proveAcl(lock.descriptor, "Unsafe secret slot lock ACL.");
          const protectedMetadata = fstatSync(lock.descriptor, { bigint: true });
          if ((protectedMetadata.mode & 0o777n) !== 0o600n || protectedMetadata.size !== 0n) {
            throw new Error("Unsafe secret slot lock.");
          }
          await this.#reconcileOldLockLinks(root, lock);
          if (!this.#lockIsCanonical(root, lock, protectedMetadata)) {
            throw new Error("Secret slot lock identity changed.");
          }
          await this.#syncMetadataRoot(root);
          return lock;
        }
      } catch (error: unknown) {
        const failures: unknown[] = [error];
        try { releaseFlock(lock.descriptor, this.#flock); } catch (cleanup: unknown) { failures.push(cleanup); }
        try { closeSync(lock.descriptor); } catch (cleanup: unknown) { failures.push(cleanup); }
        throwFailures(failures, "Secret slot lock admission failed.");
        throw new Error("unreachable");
      }
      const failures: unknown[] = [];
      try { releaseFlock(lock.descriptor, this.#flock); } catch (cleanup: unknown) { failures.push(cleanup); }
      try { closeSync(lock.descriptor); } catch (cleanup: unknown) { failures.push(cleanup); }
      throwFailures(failures, "Secret slot lock retry cleanup failed.");
      await Bun.sleep(0);
    }
    throw new Error("Secret slot is busy.");
  }

  async #withSlotLock<T>(
    slot: string,
    operation: (root: HeldDirectory) => Promise<T>,
  ): Promise<T> {
    this.#assertSlot(slot);
    const root = await this.#openMetadataRoot();
    let lock: SlotLock;
    try {
      lock = await this.#acquireSlotLock(root, slot);
    } catch (error: unknown) {
      const failures: unknown[] = [error];
      try { await root.handle.close(); } catch (cleanup: unknown) { failures.push(cleanup); }
      throwFailures(failures, "Secret slot lock acquisition failed.");
      throw new Error("unreachable");
    }
    let result: T | undefined;
    const failures: unknown[] = [];
    try { result = await operation(root); } catch (error: unknown) { failures.push(error); }
    try {
      this.#proveAcl(root.handle.fd, "Unsafe secret metadata root ACL.");
      await this.#assertMetadataRootIdentity(root.identity);
    } catch (error: unknown) {
      failures.push(error);
    }
    try { releaseFlock(lock.descriptor, this.#flock); } catch (error: unknown) { failures.push(error); }
    try { closeSync(lock.descriptor); } catch (error: unknown) { failures.push(error); }
    try { await root.handle.close(); } catch (error: unknown) { failures.push(error); }
    throwFailures(failures, "Secret custody operation and cleanup failed.");
    return result as T;
  }

  async #readPointerName(
    root: HeldDirectory,
    name: string,
    tolerateInvalid: boolean,
  ): Promise<SecretPointer | null | "invalid"> {
    await this.#beforeMetadataOperation("pointer-open", name);
    const opened = openFileAt(root.handle.fd, name, constants.O_RDONLY);
    if ("errno" in opened) {
      if (opened.errno !== POSIX_ENOENT) throw new Error("Secret pointer open failed.");
      await this.#assertMetadataRootIdentity(root.identity);
      return null;
    }
    return useDescriptor(
      opened.descriptor,
      () => {
        const metadata = fstatSync(opened.descriptor, { bigint: true });
        if (!safeFile(metadata, tolerateInvalid ? 0n : 1n, BigInt(MAXIMUM_POINTER_BYTES))) {
          throw new Error("Unsafe secret pointer.");
        }
        this.#proveAcl(opened.descriptor, "Unsafe secret pointer ACL.");
        const document = readFileSync(opened.descriptor, "utf8");
        const after = fstatSync(opened.descriptor, { bigint: true });
        this.#proveAcl(opened.descriptor, "Unsafe secret pointer ACL.");
        if (!sameIdentity(metadata, after) || metadata.size !== after.size) {
          throw new Error("Secret pointer changed while reading.");
        }
        try {
          return secretPointerSchema.parse(JSON.parse(document) as unknown);
        } catch (error: unknown) {
          if (tolerateInvalid) return "invalid";
          throw error;
        }
      },
      "Secret pointer read and cleanup failed.",
    );
  }

  async #readPointer(root: HeldDirectory, slot: string): Promise<SecretPointer | null> {
    const pointer = await this.#readPointerName(root, this.#pointerName(slot), false);
    if (pointer === "invalid") throw new Error("Invalid authoritative secret pointer.");
    return pointer;
  }

  async #readPendingPointer(root: HeldDirectory, slot: string): Promise<PendingPointerRead> {
    const pointer = await this.#readPointerName(root, this.#pendingPointerName(slot), true);
    if (pointer === null) return { kind: "absent" };
    if (pointer === "invalid") return { kind: "invalid" };
    return { kind: "pointer", pointer };
  }

  async #removePointerName(root: HeldDirectory, name: string): Promise<void> {
    const opened = openFileAt(root.handle.fd, name, constants.O_RDONLY);
    if ("errno" in opened) {
      if (opened.errno === POSIX_ENOENT) return;
      throw new Error("Secret pointer cleanup open failed.");
    }
    await useDescriptorAsync(
      opened.descriptor,
      async () => {
        const before = fstatSync(opened.descriptor, { bigint: true });
        if (!safeFile(before, 0n, BigInt(MAXIMUM_POINTER_BYTES))) {
          throw new Error("Unsafe secret pointer cleanup target.");
        }
        this.#proveAcl(opened.descriptor, "Unsafe secret pointer ACL.");
        await this.#beforeMetadataOperation("pointer-unlink", name);
        if (this.#unlinkAt(root.handle.fd, name) !== null) {
          throw new Error("Secret pointer cleanup unlink failed.");
        }
        const after = fstatSync(opened.descriptor, { bigint: true });
        this.#proveAcl(opened.descriptor, "Unsafe secret pointer ACL.");
        if (!sameIdentity(before, after) || after.nlink !== 0n) {
          throw new Error("Secret pointer cleanup could not be proven.");
        }
        await this.#syncMetadataRoot(root);
      },
      "Secret pointer removal and cleanup failed.",
    );
  }

  async #stagePointer(root: HeldDirectory, slot: string, pointer: SecretPointer): Promise<void> {
    const name = this.#pendingPointerName(slot);
    let opened = openFileAt(
      root.handle.fd,
      name,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600,
    );
    if ("errno" in opened && opened.errno === POSIX_EEXIST) {
      opened = openFileAt(root.handle.fd, name, constants.O_RDWR);
    }
    if ("errno" in opened) throw new Error("Secret pending pointer open failed.");
    const encoded = Buffer.from(JSON.stringify(pointer), "utf8");
    try {
      await useDescriptorAsync(
        opened.descriptor,
        async () => {
          const metadata = fstatSync(opened.descriptor, { bigint: true });
          const owner = ownerUid();
          if (
            !metadata.isFile()
            || metadata.nlink !== 1n
            || (owner !== undefined && metadata.uid !== owner)
            || metadata.size > BigInt(MAXIMUM_POINTER_BYTES)
          ) {
            throw new Error("Unsafe secret pending pointer.");
          }
          fchmodSync(opened.descriptor, 0o600);
          this.#proveAcl(opened.descriptor, "Unsafe secret pointer ACL.");
          ftruncateSync(opened.descriptor, 0);
          await this.#beforeMetadataOperation("pointer-write", name);
          let written = 0;
          while (written < encoded.byteLength) {
            written += writeSync(
              opened.descriptor,
              encoded,
              written,
              encoded.byteLength - written,
              written,
            );
          }
          fchmodSync(opened.descriptor, 0o600);
          fsyncSync(opened.descriptor);
          const staged = fstatSync(opened.descriptor, { bigint: true });
          this.#proveAcl(opened.descriptor, "Unsafe secret pointer ACL.");
          if (
            !sameIdentity(metadata, staged)
            || staged.size !== BigInt(encoded.byteLength)
            || staged.nlink !== 1n
          ) throw new Error("Secret pending pointer publication could not be proven.");
          await this.#syncMetadataRoot(root);
        },
        "Secret pending pointer publication and cleanup failed.",
      );
    } finally {
      encoded.fill(0);
    }
  }

  async #commitStagedPointer(root: HeldDirectory, slot: string): Promise<void> {
    const pending = this.#pendingPointerName(slot);
    const target = this.#pointerName(slot);
    const descriptors: number[] = [];
    const failures: unknown[] = [];
    try {
      const staged = openFileAt(root.handle.fd, pending, constants.O_RDONLY);
      if ("errno" in staged) throw new Error("Secret staged pointer open failed.");
      descriptors.push(staged.descriptor);
      const stagedBefore = fstatSync(staged.descriptor, { bigint: true });
      if (!safeFile(stagedBefore, 1n, BigInt(MAXIMUM_POINTER_BYTES))) {
        throw new Error("Unsafe staged secret pointer.");
      }
      this.#proveAcl(staged.descriptor, "Unsafe secret pointer ACL.");

      const previous = openFileAt(root.handle.fd, target, constants.O_RDONLY);
      let previousBefore: BigIntStats | undefined;
      let previousDescriptor: number | undefined;
      if ("descriptor" in previous) {
        previousDescriptor = previous.descriptor;
        descriptors.push(previousDescriptor);
        previousBefore = fstatSync(previousDescriptor, { bigint: true });
        if (!safeFile(previousBefore, 1n, BigInt(MAXIMUM_POINTER_BYTES))) {
          throw new Error("Unsafe authoritative secret pointer.");
        }
        this.#proveAcl(previousDescriptor, "Unsafe secret pointer ACL.");
      } else if (previous.errno !== POSIX_ENOENT) {
        throw new Error("Secret authoritative pointer open failed.");
      }

      await this.#beforeMetadataOperation("pointer-rename", target);
      if (this.#renameAt(root.handle.fd, pending, target) !== null) {
        throw new Error("Secret pointer rename failed.");
      }

      const published = openFileAt(root.handle.fd, target, constants.O_RDONLY);
      if ("errno" in published) {
        throw new Error("Secret pointer rename could not be proven.");
      }
      descriptors.push(published.descriptor);
      const publishedMetadata = fstatSync(published.descriptor, { bigint: true });
      if (
        !safeFile(publishedMetadata, 1n, BigInt(MAXIMUM_POINTER_BYTES))
        || !sameIdentity(stagedBefore, publishedMetadata)
        || stagedBefore.size !== publishedMetadata.size
      ) throw new Error("Secret pointer rename could not be proven.");
      this.#proveAcl(published.descriptor, "Unsafe secret pointer ACL.");

      const lingering = openFileAt(root.handle.fd, pending, constants.O_RDONLY);
      if ("descriptor" in lingering) {
        descriptors.push(lingering.descriptor);
        throw new Error("Secret pointer rename could not be proven.");
      }
      if (lingering.errno !== POSIX_ENOENT) {
        throw new Error("Secret pointer rename could not be proven.");
      }
      const stagedAfter = fstatSync(staged.descriptor, { bigint: true });
      this.#proveAcl(staged.descriptor, "Unsafe secret pointer ACL.");
      if (!sameIdentity(stagedBefore, stagedAfter) || stagedAfter.nlink !== 1n) {
        throw new Error("Secret pointer rename could not be proven.");
      }
      if (previousDescriptor !== undefined && previousBefore !== undefined) {
        const previousAfter = fstatSync(previousDescriptor, { bigint: true });
        this.#proveAcl(previousDescriptor, "Unsafe secret pointer ACL.");
        if (!sameIdentity(previousBefore, previousAfter) || previousAfter.nlink !== 0n) {
          throw new Error("Secret pointer replacement could not be proven.");
        }
      }
      await this.#syncMetadataRoot(root);
    } catch (error: unknown) {
      failures.push(error);
    }
    for (const descriptor of descriptors.reverse()) {
      try { closeSync(descriptor); } catch (error: unknown) { failures.push(error); }
    }
    throwFailures(failures, "Secret pointer publication and cleanup failed.");
  }

  async #reconcilePending(
    root: HeldDirectory,
    slot: string,
    authority: SecretPointer | null,
  ): Promise<SecretPointer | null> {
    const pending = await this.#readPendingPointer(root, slot);
    if (pending.kind === "absent") return authority;
    if (pending.kind === "invalid") {
      await this.#removePointerName(root, this.#pendingPointerName(slot));
      return authority;
    }
    const desired = pending.pointer;
    if (authority !== null && samePointer(authority, desired)) {
      await this.#removePointerName(root, this.#pendingPointerName(slot));
      return authority;
    }
    if (!isValidSecretPointerTransition(authority, desired)) {
      throw new Error("Secret pending pointer does not follow authoritative state.");
    }
    if (desired.version === 3) {
      const authorityCurrent = authority === null ? null : locatorFromPointer(authority);
      const advances = authorityCurrent === null
        || !sameLocator(authorityCurrent, desired.current);
      if (advances) {
        const account = this.#account(slot, desired.current);
        const value = await this.#backend.get(account);
        if (value === null) {
          await this.#backend.delete(account);
          if (await this.#backend.get(account) !== null) {
            throw new Error("Uncommitted secret value cleanup could not be proven.");
          }
          await this.#removePointerName(root, this.#pendingPointerName(slot));
          return authority;
        }
        if (createHash("sha256").update(value).digest("hex") !== desired.current.digest) {
          throw new Error("Pending secret value does not match its staged digest.");
        }
      }
    }
    if (desired.version === 2 && desired.state === "cleared") {
      const locator = historicalLocator(desired);
      const account = this.#account(slot, locator);
      await this.#backend.delete(account);
      if (await this.#backend.get(account) !== null) {
        throw new Error("Cleared secret value deletion could not be proven.");
      }
    }
    await this.#commitStagedPointer(root, slot);
    return desired;
  }

  async #reconcileRetired(
    root: HeldDirectory,
    slot: string,
    authority: SecretPointer | null,
  ): Promise<SecretPointer | null> {
    if (authority?.version !== 3 || authority.retired === undefined) return authority;
    const account = this.#account(slot, authority.retired);
    await this.#backend.delete(account);
    if (await this.#backend.get(account) !== null) {
      throw new Error("Retired secret generation deletion could not be proven.");
    }
    const compact: SecretPointer = {
      version: 3,
      state: "committed",
      current: authority.current,
    };
    await this.#stagePointer(root, slot, compact);
    await this.#commitStagedPointer(root, slot);
    return compact;
  }

  async #reconcileClearing(
    root: HeldDirectory,
    slot: string,
    authority: SecretPointer | null,
  ): Promise<SecretPointer | null> {
    if (authority?.version !== 2 || authority.state !== "clearing") return authority;
    const locator = historicalLocator(authority);
    const account = this.#account(slot, locator);
    await this.#backend.delete(account);
    if (await this.#backend.get(account) !== null) {
      throw new Error("Secret generation deletion could not be proven.");
    }
    const cleared: SecretPointer = {
      version: 2,
      state: "cleared",
      ...locator,
    };
    await this.#stagePointer(root, slot, cleared);
    await this.#commitStagedPointer(root, slot);
    return cleared;
  }

  async #reconcile(root: HeldDirectory, slot: string): Promise<SecretPointer | null> {
    let authority = await this.#readPointer(root, slot);
    authority = await this.#reconcilePending(root, slot, authority);
    authority = await this.#reconcileRetired(root, slot, authority);
    return await this.#reconcileClearing(root, slot, authority);
  }

  async #observe(slot: string, pointer: SecretPointer | null): Promise<SecretObservation | null> {
    if (pointer === null || (pointer.version === 2 && pointer.state === "cleared")) return null;
    if (pointer.version === 2) throw new Error("Secret generation clearing is incomplete.");
    const locator = locatorFromPointer(pointer);
    if (locator === null) return null;
    const value = await this.#backend.get(this.#account(slot, locator));
    if (value === null) throw new Error("Secret pointer refers to a missing immutable value.");
    if (createHash("sha256").update(value).digest("hex") !== locator.digest) {
      throw new Error("Secret value does not match its committed digest.");
    }
    return { generation: locator.generation, value };
  }

  async read(slot: string): Promise<SecretObservation | null> {
    return await this.#withSlotLock(slot, async (root) =>
      await this.#observe(slot, await this.#reconcile(root, slot)));
  }

  async compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<SecretObservation | null> {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_SECRET_BYTES) {
      bytes.fill(0);
      throw new Error("Secret value is outside the custody bound.");
    }
    try {
      return await this.#withSlotLock(slot, async (root) => {
        const authority = await this.#reconcile(root, slot);
        const current = await this.#observe(slot, authority);
        if ((current?.generation ?? null) !== expectedGeneration) return null;
        const predecessor = authority === null ? -1 : historicalLocator(authority).generation;
        if (predecessor >= Number.MAX_SAFE_INTEGER) {
          throw new Error("Secret generation is exhausted.");
        }
        const locator: SecretLocator = {
          generation: predecessor + 1,
          nonce: crypto.randomUUID(),
          digest: createHash("sha256").update(bytes).digest("hex"),
        };
        const active = authority === null ? null : locatorFromPointer(authority);
        const desired: SecretPointer = {
          version: 3,
          state: "committed",
          current: locator,
          ...(active === null ? {} : { retired: active }),
        };
        await this.#stagePointer(root, slot, desired);
        const account = this.#account(slot, locator);
        try {
          await this.#backend.set(account, value);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await this.#backend.get(account);
          if (
            existing === null
            || createHash("sha256").update(existing).digest("hex") !== locator.digest
          ) throw error;
        }
        await this.#commitStagedPointer(root, slot);
        await this.#reconcileRetired(root, slot, desired);
        return { generation: locator.generation, value };
      });
    } finally {
      bytes.fill(0);
    }
  }

  async clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    return await this.#withSlotLock(slot, async (root) => {
      let authority = await this.#reconcile(root, slot);
      if (authority === null) {
        await this.#syncMetadataRoot(root);
        return false;
      }
      const historical = historicalLocator(authority);
      if (historical.generation !== expectedGeneration) return false;
      if (authority.version === 2 && authority.state === "cleared") {
        await this.#syncMetadataRoot(root);
        return true;
      }
      const clearing: SecretPointer = {
        version: 2,
        state: "clearing",
        ...historical,
      };
      await this.#stagePointer(root, slot, clearing);
      await this.#commitStagedPointer(root, slot);
      authority = clearing;
      const locator = historicalLocator(authority);
      const account = this.#account(slot, locator);
      await this.#backend.delete(account);
      if (await this.#backend.get(account) !== null) {
        throw new Error("Secret generation deletion could not be proven.");
      }
      const cleared: SecretPointer = {
        version: 2,
        state: "cleared",
        ...locator,
      };
      await this.#stagePointer(root, slot, cleared);
      await this.#commitStagedPointer(root, slot);
      return true;
    });
  }
}

export type { DescriptorAclInspection };
