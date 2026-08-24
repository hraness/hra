import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { proveDescriptorAclAbsence } from "./descriptor-security";
import {
  FileSecretBackend,
  MAXIMUM_LEGACY_STALE_LOCKS_PER_SLOT,
  isValidSecretPointerTransition,
  secretPointerSchema,
  type SecretPointer,
} from "./secret-custody";
import type { StatePaths } from "./paths";

export const LEGACY_HRA_KEYCHAIN_SERVICE = "sh.hra.control-plane.v1";

const maximumPointerCount = 1_024;
const maximumMetadataArtifactCount = maximumPointerCount * 4;
const maximumPointerBytes = 1_024;
const maximumSecretBytes = 65_536;
const pointerNamePattern = /^([a-z][a-z0-9-]{0,63})\.json$/u;
const pendingPointerNamePattern = /^([a-z][a-z0-9-]{0,63})\.pending\.json$/u;
const persistentLockNamePattern = /^([a-z][a-z0-9-]{0,63})\.lock$/u;
const staleLockNamePattern = /^([a-z][a-z0-9-]{0,63})\.lock\.stale\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const pointerSchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nonce: z.string().uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  version: z.literal(1),
}).strict();
const legacyLockSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
}).strict();

export type LegacySecretMigrationErrorCode =
  | "legacy_digest_mismatch"
  | "legacy_read_failed"
  | "legacy_value_missing"
  | "migration_incomplete"
  | "migration_state_changed"
  | "target_value_conflict"
  | "unsafe_metadata";

export class LegacySecretMigrationError extends Error {
  readonly code: LegacySecretMigrationErrorCode;

  constructor(code: LegacySecretMigrationErrorCode) {
    super(code);
    this.name = "LegacySecretMigrationError";
    this.code = code;
  }
}

export interface LegacySecretReader {
  get(account: string): Promise<unknown>;
}

export interface LegacySecretMigrationAuthority {
  assertCurrent(): Promise<void>;
}

export class BunLegacySecretReader implements LegacySecretReader {
  async get(account: string): Promise<string | null> {
    return await Bun.secrets.get({
      name: account,
      service: LEGACY_HRA_KEYCHAIN_SERVICE,
    });
  }
}

export type LegacySecretMigrationPreflight = Readonly<{
  copiesPending: number;
  copiesPresent: number;
  copiesRequired: number;
  nextAction: "execute_migration" | "none";
  status: "already_complete" | "not_required" | "ready";
}>;

export type LegacySecretMigrationOutcome = Readonly<{
  copiesPresent: number;
  copiesRequired: number;
  legacyEntriesRetained: true;
  status: "already_complete" | "migrated" | "not_required";
}>;

type DirectoryIdentity = Readonly<{ device: bigint; inode: bigint }>;
type Pointer = Readonly<{
  account: string;
  digest: string;
  generation: number;
  nonce: string;
  slot: string;
}>;
type MigrationSnapshot = Readonly<{
  pointers: readonly Pointer[];
  presentAccounts: ReadonlySet<string>;
}>;

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const throwLegacyFailures = (failures: readonly unknown[], message: string): void => {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
};

const identityOf = (metadata: BigIntStats): DirectoryIdentity => ({
  device: metadata.dev,
  inode: metadata.ino,
});

const identityMatches = (metadata: BigIntStats, identity: DirectoryIdentity): boolean =>
  metadata.dev === identity.device && metadata.ino === identity.inode;

const safeProtectedFile = (
  metadata: BigIntStats,
  maximumBytes: number,
  minimumBytes = 1,
  maximumLinks = 1,
): boolean => {
  const owner = process.getuid?.();
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink >= 1n
    && metadata.nlink <= BigInt(maximumLinks)
    && (metadata.mode & 0o777n) === 0o600n
    && (owner === undefined || metadata.uid === BigInt(owner))
    && metadata.size >= BigInt(minimumBytes)
    && metadata.size <= BigInt(maximumBytes);
};

const safePrivateDirectory = (metadata: BigIntStats): boolean => {
  const owner = process.getuid?.();
  return metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && metadata.nlink >= 1n
    && (metadata.mode & 0o777n) === 0o700n
    && (owner === undefined || metadata.uid === BigInt(owner));
};

const inspectPrivateDirectory = async (path: string): Promise<DirectoryIdentity | null> => {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw new LegacySecretMigrationError("unsafe_metadata");
  }
  if (!safePrivateDirectory(before)) {
    throw new LegacySecretMigrationError("unsafe_metadata");
  }
  let handle: FileHandle | undefined;
  let result: DirectoryIdentity | undefined;
  const failures: unknown[] = [];
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const descriptor = await handle.stat({ bigint: true });
    proveDescriptorAclAbsence(handle.fd, {}, "unsafe_metadata");
    const [canonical, after] = await Promise.all([
      realpath(path),
      lstat(path, { bigint: true }),
    ]);
    if (
      canonical !== resolve(path)
      || !safePrivateDirectory(after)
      || !safePrivateDirectory(descriptor)
      || !identityMatches(after, identityOf(before))
      || !identityMatches(descriptor, identityOf(before))
    ) {
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
    proveDescriptorAclAbsence(handle.fd, {}, "unsafe_metadata");
    result = identityOf(before);
  } catch (error: unknown) {
    failures.push(error instanceof LegacySecretMigrationError
      ? error
      : new LegacySecretMigrationError("unsafe_metadata"));
  }
  if (handle !== undefined) {
    try { await handle.close(); } catch (cleanup: unknown) { failures.push(cleanup); }
  }
  throwLegacyFailures(failures, "Legacy private directory inspection and cleanup failed.");
  return result as DirectoryIdentity;
};

const requireDirectoryIdentity = async (
  path: string,
  identity: DirectoryIdentity,
): Promise<void> => {
  const current = await inspectPrivateDirectory(path);
  if (current === null || current.device !== identity.device || current.inode !== identity.inode) {
    throw new LegacySecretMigrationError("migration_state_changed");
  }
};

const secureRead = async (
  path: string,
  maximumBytes: number,
  allowMissing: boolean,
  options: Readonly<{
    maximumLinks?: number;
    minimumBytes?: number;
    onValidatedMetadata?: (metadata: BigIntStats) => void;
  }> = {},
): Promise<Buffer | null> => {
  let handle: FileHandle | undefined;
  let result: Buffer | null | undefined;
  const failures: unknown[] = [];
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!safeProtectedFile(
      before,
      maximumBytes,
      options.minimumBytes,
      options.maximumLinks,
    )) {
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
    proveDescriptorAclAbsence(handle.fd, {}, "unsafe_metadata");
    const value = await handle.readFile();
    const [after, linked] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    proveDescriptorAclAbsence(handle.fd, {}, "unsafe_metadata");
    if (
      !safeProtectedFile(after, maximumBytes, options.minimumBytes, options.maximumLinks)
      || !safeProtectedFile(linked, maximumBytes, options.minimumBytes, options.maximumLinks)
      || BigInt(value.byteLength) !== before.size
      || !identityMatches(after, identityOf(before))
      || !identityMatches(linked, identityOf(before))
      || after.size !== before.size
      || linked.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || linked.mtimeNs !== before.mtimeNs
      || linked.ctimeNs !== before.ctimeNs
    ) throw new LegacySecretMigrationError("migration_state_changed");
    options.onValidatedMetadata?.(after);
    result = value;
  } catch (error: unknown) {
    if (allowMissing && handle === undefined && isMissing(error)) result = null;
    else failures.push(error instanceof LegacySecretMigrationError
      ? error
      : new LegacySecretMigrationError("unsafe_metadata"));
  }
  if (handle !== undefined) {
    try { await handle.close(); } catch (cleanup: unknown) { failures.push(cleanup); }
  }
  throwLegacyFailures(failures, "Legacy protected file read and cleanup failed.");
  return result as Buffer | null;
};

const readPointers = async (paths: StatePaths): Promise<readonly Pointer[]> => {
  const stateRoot = await inspectPrivateDirectory(paths.root);
  if (stateRoot === null) return [];
  const metadataRoot = join(paths.root, "secret-metadata");
  const metadataIdentity = await inspectPrivateDirectory(metadataRoot);
  if (metadataIdentity === null) {
    await requireDirectoryIdentity(paths.root, stateRoot);
    return [];
  }

  let names: string[];
  try {
    names = await readdir(metadataRoot);
  } catch {
    throw new LegacySecretMigrationError("unsafe_metadata");
  }
  if (names.length > maximumMetadataArtifactCount) {
    throw new LegacySecretMigrationError("unsafe_metadata");
  }
  names.sort((left, right) => left.localeCompare(right));
  const lockNames: string[] = [];
  const staleLockNames: string[] = [];
  const pendingPointerNames: string[] = [];
  const pointerNames: string[] = [];
  for (const name of names) {
    if (persistentLockNamePattern.test(name)) lockNames.push(name);
    else if (staleLockNamePattern.test(name)) staleLockNames.push(name);
    else if (pendingPointerNamePattern.test(name)) pendingPointerNames.push(name);
    else if (pointerNamePattern.test(name)) pointerNames.push(name);
    else throw new LegacySecretMigrationError("unsafe_metadata");
  }
  if (pointerNames.length > maximumPointerCount) {
    throw new LegacySecretMigrationError("unsafe_metadata");
  }
  const staleCountBySlot = new Map<string, number>();
  for (const name of staleLockNames) {
    const slot = staleLockNamePattern.exec(name)?.[1];
    if (slot === undefined) throw new LegacySecretMigrationError("unsafe_metadata");
    const count = (staleCountBySlot.get(slot) ?? 0) + 1;
    if (count > MAXIMUM_LEGACY_STALE_LOCKS_PER_SLOT) {
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
    staleCountBySlot.set(slot, count);
  }

  type LockArtifact = Readonly<{
    identity: DirectoryIdentity;
    links: bigint;
  }> & { staleCount: number };
  const locks = new Map<string, LockArtifact>();
  const orphanLocks = new Map<string, LockArtifact>();
  for (const name of lockNames) {
    let validated: BigIntStats | undefined;
    const document = await secureRead(
      join(metadataRoot, name),
      256,
      false,
      {
        maximumLinks: maximumMetadataArtifactCount,
        minimumBytes: 0,
        onValidatedMetadata: (metadata) => { validated = metadata; },
      },
    );
    if (document === null || validated === undefined) {
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
    if (document.byteLength > 0) {
      try {
        legacyLockSchema.parse(JSON.parse(document.toString("utf8")) as unknown);
      } catch {
        throw new LegacySecretMigrationError("unsafe_metadata");
      }
    }
    locks.set(name, {
      identity: identityOf(validated),
      links: validated.nlink,
      staleCount: 0,
    });
  }
  for (const name of staleLockNames) {
    const match = staleLockNamePattern.exec(name);
    const slot = match?.[1];
    if (slot === undefined) throw new LegacySecretMigrationError("unsafe_metadata");
    const lock = locks.get(`${slot}.lock`);
    let validated: BigIntStats | undefined;
    const document = await secureRead(
      join(metadataRoot, name),
      256,
      false,
      {
        maximumLinks: maximumMetadataArtifactCount,
        minimumBytes: 0,
        onValidatedMetadata: (metadata) => { validated = metadata; },
      },
    );
    if (document === null || validated === undefined) {
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
    if (document.byteLength > 0) {
      try {
        legacyLockSchema.parse(JSON.parse(document.toString("utf8")) as unknown);
      } catch {
        throw new LegacySecretMigrationError("unsafe_metadata");
      }
    }
    if (
      lock !== undefined
      && identityMatches(validated, lock.identity)
      && validated.nlink === lock.links
    ) {
      lock.staleCount += 1;
      continue;
    }
    const identity = identityOf(validated);
    const key = `${slot}:${identity.device.toString(16)}:${identity.inode.toString(16)}`;
    const orphan = orphanLocks.get(key);
    if (orphan === undefined) {
      orphanLocks.set(key, {
        identity,
        links: validated.nlink,
        staleCount: 1,
      });
    } else {
      if (validated.nlink !== orphan.links) {
        throw new LegacySecretMigrationError("unsafe_metadata");
      }
      orphan.staleCount += 1;
    }
  }
  for (const lock of locks.values()) {
    if (lock.links !== BigInt(lock.staleCount + 1)) {
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
  }
  for (const orphan of orphanLocks.values()) {
    if (orphan.links !== BigInt(orphan.staleCount)) {
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
  }

  const pendingPointers = new Map<string, SecretPointer>();
  for (const name of pendingPointerNames) {
    const slot = pendingPointerNamePattern.exec(name)?.[1];
    if (slot === undefined) throw new LegacySecretMigrationError("unsafe_metadata");
    const document = await secureRead(
      join(metadataRoot, name),
      maximumPointerBytes,
      false,
    );
    if (document === null) throw new LegacySecretMigrationError("unsafe_metadata");
    try {
      pendingPointers.set(
        slot,
        secretPointerSchema.parse(JSON.parse(document.toString("utf8")) as unknown),
      );
    } catch {
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
  }

  const pointers: Pointer[] = [];
  const authorities = new Map<string, SecretPointer>();
  for (const name of pointerNames) {
    const match = pointerNamePattern.exec(name);
    const slot = match?.[1];
    if (slot === undefined) throw new LegacySecretMigrationError("unsafe_metadata");
    let parsed: z.infer<typeof pointerSchema>;
    try {
      const document = await secureRead(
        join(metadataRoot, name),
        maximumPointerBytes,
        false,
      );
      if (document === null) throw new LegacySecretMigrationError("unsafe_metadata");
      parsed = pointerSchema.parse(JSON.parse(document.toString("utf8")) as unknown);
    } catch (error: unknown) {
      if (error instanceof LegacySecretMigrationError) throw error;
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
    pointers.push({
      account: `${slot}.${parsed.generation}.${parsed.nonce}`,
      digest: parsed.digest,
      generation: parsed.generation,
      nonce: parsed.nonce,
      slot,
    });
    authorities.set(slot, parsed);
  }
  for (const [slot, pending] of pendingPointers) {
    if (!isValidSecretPointerTransition(authorities.get(slot) ?? null, pending)) {
      throw new LegacySecretMigrationError("unsafe_metadata");
    }
  }
  await Promise.all([
    requireDirectoryIdentity(paths.root, stateRoot),
    requireDirectoryIdentity(metadataRoot, metadataIdentity),
  ]);
  return pointers;
};

const readMigrationSnapshot = async (paths: StatePaths): Promise<MigrationSnapshot> => {
  const pointers = await readPointers(paths);
  if (pointers.length === 0) return { pointers, presentAccounts: new Set() };
  const valuesRoot = join(paths.root, "secret-values");
  const valuesIdentity = await inspectPrivateDirectory(valuesRoot);
  if (valuesIdentity === null) return { pointers, presentAccounts: new Set() };

  const presentAccounts = new Set<string>();
  for (const pointer of pointers) {
    const value = await secureRead(
      join(valuesRoot, pointer.account),
      maximumSecretBytes,
      true,
      { maximumLinks: 2 },
    );
    if (value === null) continue;
    const finalMetadata = await lstat(
      join(valuesRoot, pointer.account),
      { bigint: true },
    );
    if (finalMetadata.nlink === 2n) {
      const pendingPath = join(valuesRoot, `.${pointer.account}.pending`);
      const pending = await secureRead(
        pendingPath,
        maximumSecretBytes,
        false,
        { maximumLinks: 2 },
      );
      if (pending === null || !pending.equals(value)) {
        throw new LegacySecretMigrationError("unsafe_metadata");
      }
      const pendingMetadata = await lstat(pendingPath, { bigint: true });
      if (!identityMatches(pendingMetadata, identityOf(finalMetadata))) {
        throw new LegacySecretMigrationError("unsafe_metadata");
      }
    }
    if (createHash("sha256").update(value).digest("hex") !== pointer.digest) {
      throw new LegacySecretMigrationError("target_value_conflict");
    }
    presentAccounts.add(pointer.account);
  }
  await requireDirectoryIdentity(valuesRoot, valuesIdentity);
  return { pointers, presentAccounts };
};

const pointerFingerprint = (pointer: Pointer): string =>
  `${pointer.slot}\0${pointer.generation}\0${pointer.nonce}\0${pointer.digest}`;

const pointersMatch = (
  left: readonly Pointer[],
  right: readonly Pointer[],
): boolean => left.length === right.length && left.every((pointer, index) => {
  const compared = right[index];
  return compared !== undefined
    && pointerFingerprint(pointer) === pointerFingerprint(compared);
});

const preflightFromSnapshot = (
  snapshot: MigrationSnapshot,
): LegacySecretMigrationPreflight => {
  const copiesRequired = snapshot.pointers.length;
  const copiesPresent = snapshot.presentAccounts.size;
  const copiesPending = copiesRequired - copiesPresent;
  if (copiesRequired === 0) {
    return {
      copiesPending,
      copiesPresent,
      copiesRequired,
      nextAction: "none",
      status: "not_required",
    };
  }
  if (copiesPending === 0) {
    return {
      copiesPending,
      copiesPresent,
      copiesRequired,
      nextAction: "none",
      status: "already_complete",
    };
  }
  return {
    copiesPending,
    copiesPresent,
    copiesRequired,
    nextAction: "execute_migration",
    status: "ready",
  };
};

export async function preflightLegacySecretMigration(
  paths: StatePaths,
): Promise<LegacySecretMigrationPreflight> {
  return preflightFromSnapshot(await readMigrationSnapshot(paths));
}

export async function migrateLegacySecrets(
  paths: StatePaths,
  legacy: LegacySecretReader,
  authority: LegacySecretMigrationAuthority,
): Promise<LegacySecretMigrationOutcome> {
  await authority.assertCurrent();
  const initial = await readMigrationSnapshot(paths);
  await authority.assertCurrent();
  const preflight = preflightFromSnapshot(initial);
  if (preflight.status === "not_required" || preflight.status === "already_complete") {
    return {
      copiesPresent: preflight.copiesPresent,
      copiesRequired: preflight.copiesRequired,
      legacyEntriesRetained: true,
      status: preflight.status,
    };
  }

  const values = new Map<string, string>();
  for (const pointer of initial.pointers) {
    if (initial.presentAccounts.has(pointer.account)) continue;
    let value: unknown;
    await authority.assertCurrent();
    try {
      value = await legacy.get(pointer.account);
    } catch {
      throw new LegacySecretMigrationError("legacy_read_failed");
    }
    await authority.assertCurrent();
    if (value === null) throw new LegacySecretMigrationError("legacy_value_missing");
    if (typeof value !== "string") {
      throw new LegacySecretMigrationError("legacy_read_failed");
    }
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes < 1 || bytes > maximumSecretBytes) {
      throw new LegacySecretMigrationError("legacy_digest_mismatch");
    }
    if (createHash("sha256").update(value).digest("hex") !== pointer.digest) {
      throw new LegacySecretMigrationError("legacy_digest_mismatch");
    }
    values.set(pointer.account, value);
  }

  await authority.assertCurrent();
  const beforeWrite = await readMigrationSnapshot(paths);
  await authority.assertCurrent();
  if (!pointersMatch(initial.pointers, beforeWrite.pointers)) {
    throw new LegacySecretMigrationError("migration_state_changed");
  }
  for (const account of initial.presentAccounts) {
    if (!beforeWrite.presentAccounts.has(account)) {
      throw new LegacySecretMigrationError("migration_state_changed");
    }
  }

  const destination = new FileSecretBackend(join(paths.root, "secret-values"));
  for (const pointer of beforeWrite.pointers) {
    if (beforeWrite.presentAccounts.has(pointer.account)) continue;
    const value = values.get(pointer.account);
    if (value === undefined) throw new LegacySecretMigrationError("migration_state_changed");
    await authority.assertCurrent();
    try {
      await destination.set(pointer.account, value);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new LegacySecretMigrationError("migration_incomplete");
      }
      const concurrent = await secureRead(
        join(paths.root, "secret-values", pointer.account),
        maximumSecretBytes,
        false,
        { maximumLinks: 2 },
      );
      if (
        concurrent === null
        || createHash("sha256").update(concurrent).digest("hex") !== pointer.digest
      ) {
        throw new LegacySecretMigrationError("target_value_conflict");
      }
    }
    await authority.assertCurrent();
    const copied = await secureRead(
      join(paths.root, "secret-values", pointer.account),
      maximumSecretBytes,
      false,
      { maximumLinks: 2 },
    );
    await authority.assertCurrent();
    if (
      copied === null
      || createHash("sha256").update(copied).digest("hex") !== pointer.digest
    ) {
      throw new LegacySecretMigrationError("migration_incomplete");
    }
  }

  values.clear();
  await authority.assertCurrent();
  const final = await readMigrationSnapshot(paths);
  await authority.assertCurrent();
  if (!pointersMatch(initial.pointers, final.pointers)) {
    throw new LegacySecretMigrationError("migration_state_changed");
  }
  if (final.presentAccounts.size !== final.pointers.length) {
    throw new LegacySecretMigrationError("migration_incomplete");
  }
  return {
    copiesPresent: final.presentAccounts.size,
    copiesRequired: final.pointers.length,
    legacyEntriesRetained: true,
    status: "migrated",
  };
}
