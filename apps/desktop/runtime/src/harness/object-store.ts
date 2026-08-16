import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { z } from "@hra-internal/schema";

import {
  assertHarnessDirectoryIdentity,
  bindHarnessDirectory,
  HarnessStoragePathError,
  type HarnessDirectoryIdentity,
} from "./storage-layout";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const maximumDefaultObjectBytes = 2 * 1024 * 1024;
const objectMode = 0o600;
const candidatePrefix = ".candidate-v1-";
const candidateNameSchema = z.string().regex(
  /^\.candidate-v1-([a-f0-9]{64})-([A-Za-z0-9_-]{16})$/u,
);

export type HarnessObjectStoreErrorCode =
  | "invalid_digest"
  | "invalid_object"
  | "object_missing"
  | "object_tampered"
  | "publish_failed"
  | "unsafe_object";

/** Fixed, path-free errors keep private Application Support paths out of logs. */
export class HarnessObjectStoreError extends Error {
  readonly code: HarnessObjectStoreErrorCode;

  constructor(code: HarnessObjectStoreErrorCode) {
    super({
      invalid_digest: "The harness object digest is invalid.",
      invalid_object: "The harness object bytes are invalid.",
      object_missing: "The harness object is missing.",
      object_tampered: "The harness object failed integrity verification.",
      publish_failed: "The harness object could not be published.",
      unsafe_object: "The harness object path is unsafe.",
    }[code]);
    this.name = "HarnessObjectStoreError";
    this.code = code;
  }
}

export interface HarnessObjectPublication {
  readonly byteLength: number;
  readonly digest: string;
  readonly state: "created" | "existing";
}

export interface HarnessObjectRemoval {
  readonly digest: string;
  readonly state: "missing" | "removed";
}

export interface HarnessObjectStorePort {
  publish(value: unknown): HarnessObjectPublication;
  read(digest: unknown): Uint8Array;
  remove(digest: unknown): HarnessObjectRemoval;
}

export interface HarnessImmutableObjectStoreOptions {
  readonly directory: string;
  readonly maximumObjectBytes?: number;
  readonly randomSuffix?: () => Uint8Array;
}

interface HarnessFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

/**
 * A content-addressed, immutable, same-filesystem object store. Publication is
 * temp O_EXCL/O_NOFOLLOW -> write -> fsync -> verify -> hard-link -> directory
 * fsync -> candidate unlink -> directory fsync. A crash can leave one bounded
 * candidate, which the next operation validates and removes.
 */
export class HarnessImmutableObjectStore implements HarnessObjectStorePort {
  readonly #directory: HarnessDirectoryIdentity;
  readonly #maximumObjectBytes: number;
  readonly #randomSuffix: () => Uint8Array;

  constructor(options: HarnessImmutableObjectStoreOptions) {
    if (!isAbsolute(options.directory)) {
      throw new HarnessStoragePathError("unsafe_directory");
    }
    this.#directory = bindHarnessDirectory(options.directory);
    this.#maximumObjectBytes = positiveSafeInteger(
      options.maximumObjectBytes ?? maximumDefaultObjectBytes,
      "maximum object bytes",
    );
    this.#randomSuffix = options.randomSuffix ?? (() => randomBytes(12));
    this.#recoverCandidates();
  }

  publish(value: unknown): HarnessObjectPublication {
    const bytes = objectBytes(value, this.#maximumObjectBytes);
    const digest = sha256(bytes);
    const destination = this.#objectPath(digest);
    this.#assertDirectory();

    const existing = this.#readIfPresent(digest);
    if (existing !== null) {
      return { byteLength: existing.byteLength, digest, state: "existing" };
    }

    // A random suffix permits independent candidate cleanup without letting an
    // interrupted publisher block another exact publication indefinitely.
    const suffix = candidateSuffix(this.#randomSuffix());
    const candidate = join(
      this.#directory.path,
      `${candidatePrefix}${digest}-${suffix}`,
    );
    let descriptor: number | null = null;
    let candidateIdentity: HarnessFileIdentity | null = null;
    let linked = false;
    try {
      descriptor = openSync(
        candidate,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        objectMode,
      );
      const openedCandidate = fstatSync(descriptor, { bigint: true });
      assertOwnedCandidateFile(openedCandidate, this.#directory, 1n);
      candidateIdentity = {
        device: openedCandidate.dev,
        inode: openedCandidate.ino,
      };
      writeFileSync(descriptor, bytes);
      fchmodSync(descriptor, objectMode);
      fsyncSync(descriptor);
      const candidateMetadata = fstatSync(descriptor, { bigint: true });
      assertOwnedImmutableFile(
        candidateMetadata,
        this.#directory,
        bytes.byteLength,
        1n,
      );
      const verifiedCandidate = readAndHashDescriptor(
        descriptor,
        candidateMetadata,
        this.#maximumObjectBytes,
      );
      if (verifiedCandidate.digest !== digest) {
        throw new HarnessObjectStoreError("object_tampered");
      }
      closeSync(descriptor);
      descriptor = null;
      this.#assertDirectory();

      try {
        linkSync(candidate, destination);
        linked = true;
      } catch (error: unknown) {
        if (!hasCode(error, "EEXIST")) {
          throw new HarnessObjectStoreError("publish_failed");
        }
      }
      syncDirectory(this.#directory);

      if (linked) {
        const linkedMetadata = lstatSync(destination, { bigint: true });
        const candidateAfterLink = lstatSync(candidate, { bigint: true });
        if (
          linkedMetadata.dev !== candidateAfterLink.dev ||
          linkedMetadata.ino !== candidateAfterLink.ino
        ) {
          throw new HarnessObjectStoreError("unsafe_object");
        }
        assertOwnedImmutableFile(
          linkedMetadata,
          this.#directory,
          bytes.byteLength,
          2n,
        );
      } else {
        this.#readRequired(digest);
      }

      unlinkSync(candidate);
      syncDirectory(this.#directory);
      const published = this.#readRequired(digest);
      return {
        byteLength: published.byteLength,
        digest,
        state: linked ? "created" : "existing",
      };
    } catch (error: unknown) {
      if (
        error instanceof HarnessObjectStoreError ||
        error instanceof HarnessStoragePathError
      ) {
        throw error;
      }
      throw new HarnessObjectStoreError("publish_failed");
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      removePrivateCandidate(candidate, this.#directory, candidateIdentity);
    }
  }

  read(digestValue: unknown): Uint8Array {
    const digest = parseDigest(digestValue);
    return this.#readRequired(digest);
  }

  remove(digestValue: unknown): HarnessObjectRemoval {
    const digest = parseDigest(digestValue);
    const path = this.#objectPath(digest);
    this.#assertDirectory();
    const existing = this.#readIfPresent(digest);
    if (existing === null) return { digest, state: "missing" };
    try {
      unlinkSync(path);
      syncDirectory(this.#directory);
    } catch {
      throw new HarnessObjectStoreError("unsafe_object");
    }
    this.#assertDirectory();
    try {
      lstatSync(path);
      throw new HarnessObjectStoreError("unsafe_object");
    } catch (error: unknown) {
      if (error instanceof HarnessObjectStoreError) throw error;
      if (!hasCode(error, "ENOENT")) {
        throw new HarnessObjectStoreError("unsafe_object");
      }
    }
    return { digest, state: "removed" };
  }

  #readRequired(digest: string): Uint8Array {
    const value = this.#readIfPresent(digest);
    if (value === null) throw new HarnessObjectStoreError("object_missing");
    return value;
  }

  #recoverCandidates(): void {
    this.#assertDirectory();
    let entries: string[];
    try {
      entries = readdirSync(this.#directory.path, { encoding: "utf8" });
    } catch {
      throw new HarnessObjectStoreError("unsafe_object");
    }
    let candidateCount = 0;
    for (const entry of entries) {
      if (digestSchema.safeParse(entry).success) continue;
      const parsed = candidateNameSchema.safeParse(entry);
      if (!parsed.success) throw new HarnessObjectStoreError("unsafe_object");
      candidateCount += 1;
      if (candidateCount > 128) {
        throw new HarnessObjectStoreError("unsafe_object");
      }
      const digest = entry.slice(candidatePrefix.length, candidatePrefix.length + 64);
      this.#recoverCandidate(join(this.#directory.path, entry), digest);
    }
  }

  #recoverCandidate(candidate: string, digest: string): void {
    let descriptor: number;
    try {
      descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new HarnessObjectStoreError("unsafe_object");
    }
    try {
      const metadata = fstatSync(descriptor, { bigint: true });
      if (metadata.nlink !== 1n && metadata.nlink !== 2n) {
        throw new HarnessObjectStoreError("unsafe_object");
      }
      assertOwnedCandidateFile(metadata, this.#directory, metadata.nlink);
      const destination = this.#objectPath(digest);
      let published: BigIntStats | null = null;
      try {
        published = lstatSync(destination, { bigint: true });
      } catch (error: unknown) {
        if (!hasCode(error, "ENOENT")) {
          throw new HarnessObjectStoreError("unsafe_object");
        }
      }
      if (metadata.nlink === 2n) {
        const verified = readAndHashDescriptor(
          descriptor,
          metadata,
          this.#maximumObjectBytes,
        );
        if (verified.digest !== digest) {
          throw new HarnessObjectStoreError("object_tampered");
        }
        if (
          published === null ||
          published.dev !== metadata.dev ||
          published.ino !== metadata.ino
        ) {
          throw new HarnessObjectStoreError("unsafe_object");
        }
        assertOwnedImmutableFile(
          published,
          this.#directory,
          verified.bytes.byteLength,
          2n,
        );
      } else if (published !== null) {
        // A prior publisher may already have installed an independent exact
        // object before this candidate was orphaned.
        this.#readRequired(digest);
      }
      this.#assertDirectory();
      unlinkSync(candidate);
      syncDirectory(this.#directory);
      if (published !== null) this.#readRequired(digest);
    } finally {
      closeSync(descriptor);
    }
  }

  #readIfPresent(digest: string): Uint8Array | null {
    this.#assertDirectory();
    const path = this.#objectPath(digest);
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return null;
      throw new HarnessObjectStoreError("unsafe_object");
    }
    try {
      const metadata = fstatSync(descriptor, { bigint: true });
      assertOwnedImmutableFile(
        metadata,
        this.#directory,
        undefined,
        1n,
      );
      const published = lstatSync(path, { bigint: true });
      if (published.dev !== metadata.dev || published.ino !== metadata.ino) {
        throw new HarnessObjectStoreError("unsafe_object");
      }
      assertOwnedImmutableFile(
        published,
        this.#directory,
        Number(metadata.size),
        1n,
      );
      const verified = readAndHashDescriptor(
        descriptor,
        metadata,
        this.#maximumObjectBytes,
      );
      if (verified.digest !== digest) {
        throw new HarnessObjectStoreError("object_tampered");
      }
      this.#assertDirectory();
      return verified.bytes;
    } finally {
      closeSync(descriptor);
    }
  }

  #objectPath(digest: string): string {
    const path = join(this.#directory.path, digest);
    if (basename(path) !== digest) {
      throw new HarnessObjectStoreError("invalid_digest");
    }
    return path;
  }

  #assertDirectory(): void {
    assertHarnessDirectoryIdentity(this.#directory);
  }
}

export function harnessObjectDigest(value: unknown): string {
  return sha256(objectBytes(value, maximumDefaultObjectBytes));
}

function parseDigest(value: unknown): string {
  const parsed = digestSchema.safeParse(value);
  if (!parsed.success) throw new HarnessObjectStoreError("invalid_digest");
  return parsed.data;
}

function objectBytes(value: unknown, maximumBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new HarnessObjectStoreError("invalid_object");
  }
  if (value.byteLength < 1 || value.byteLength > maximumBytes) {
    throw new HarnessObjectStoreError("invalid_object");
  }
  return Uint8Array.from(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function candidateSuffix(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 12) {
    throw new HarnessObjectStoreError("publish_failed");
  }
  return Buffer.from(value).toString("base64url");
}

function assertOwnedImmutableFile(
  metadata: BigIntStats,
  directory: HarnessDirectoryIdentity,
  byteLength: number | undefined,
  linkCount: bigint,
): void {
  const effectiveUser = process.geteuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== directory.device ||
    metadata.nlink !== linkCount ||
    (effectiveUser !== undefined && Number(metadata.uid) !== effectiveUser) ||
    (Number(metadata.mode) & 0o777) !== objectMode ||
    metadata.size < 1n ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    (byteLength !== undefined && metadata.size !== BigInt(byteLength))
  ) {
    throw new HarnessObjectStoreError("unsafe_object");
  }
}

function assertOwnedCandidateFile(
  metadata: BigIntStats,
  directory: HarnessDirectoryIdentity,
  linkCount: bigint,
): void {
  const effectiveUser = process.geteuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== directory.device ||
    metadata.nlink !== linkCount ||
    (effectiveUser !== undefined && Number(metadata.uid) !== effectiveUser) ||
    (Number(metadata.mode) & 0o777) !== objectMode
  ) {
    throw new HarnessObjectStoreError("unsafe_object");
  }
}

function readAndHashDescriptor(
  descriptor: number,
  before: BigIntStats,
  maximumBytes: number,
): { readonly bytes: Uint8Array; readonly digest: string } {
  if (before.size > BigInt(maximumBytes)) {
    throw new HarnessObjectStoreError("invalid_object");
  }
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (count < 1) throw new HarnessObjectStoreError("object_tampered");
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.mode !== after.mode ||
    before.nlink !== after.nlink ||
    bytes.byteLength !== Number(before.size)
  ) {
    throw new HarnessObjectStoreError("object_tampered");
  }
  return { bytes, digest: sha256(bytes) };
}

function removePrivateCandidate(
  candidate: string,
  directory: HarnessDirectoryIdentity,
  identity: HarnessFileIdentity | null,
): void {
  if (identity === null) return;
  try {
    assertHarnessDirectoryIdentity(directory);
  } catch {
    return;
  }
  let metadata: BigIntStats;
  try {
    metadata = lstatSync(candidate, { bigint: true });
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return;
    return;
  }
  const effectiveUser = process.geteuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== directory.device ||
    metadata.dev !== identity.device ||
    metadata.ino !== identity.inode ||
    metadata.nlink > 2n ||
    (effectiveUser !== undefined && Number(metadata.uid) !== effectiveUser) ||
    (Number(metadata.mode) & 0o777) !== objectMode
  ) return;
  try {
    unlinkSync(candidate);
    syncDirectory(directory);
  } catch {
    // A bounded private orphan is safer than masking the publication result.
  }
}

function syncDirectory(directory: HarnessDirectoryIdentity): void {
  assertHarnessDirectoryIdentity(directory);
  let descriptor: number;
  try {
    descriptor = openSync(
      directory.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new HarnessObjectStoreError("unsafe_object");
  }
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (metadata.dev !== directory.device || metadata.ino !== directory.inode) {
      throw new HarnessObjectStoreError("unsafe_object");
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function hasCode(error: unknown, expected: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === expected;
}
