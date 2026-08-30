import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { createOhSqliteStoreAuthorityV1 } from "@hraness/oh/sqlite";
import {
  OH_WORKING_STORE_PROFILE_V1,
  parseOhHeadV1,
  parseOhHeadRefV1,
  parseOhStoreBindingV1,
  type OhHeadV1,
  type OhStoreAuthorityV1,
} from "@hraness/oh/store";
import { z } from "zod";

import {
  digestFactsMemoryInspection,
  digestFactsMemoryReceipt,
  factsMemoryBindingSchema,
  factsMemoryCheckpointSchema,
  factsMemoryDigestSchema,
  factsMemoryHeadSchema,
  factsMemoryStoreInspectionSchema,
  factsMemoryStoreReceiptSchema,
  type FactsMemoryBinding,
  type FactsMemoryCheckpoint,
  type FactsMemoryHead,
  type FactsMemoryStoreInspection,
  type FactsMemoryStoreReceipt,
} from "../domain/facts-memory";
import { profileIdSchema, sessionIdSchema, unixMillisecondsSchema } from "../domain/values";
import type { FactsMemoryBrokerInspection } from "../daemon/facts-memory-lifecycle";
import type { LocalOhFactsMemoryEnginePort } from "./local-facts-memory-broker";

const adapterMetadataName = ".hra-oh-adapter-v1.json";
const adapterMetadataPendingName = ".hra-oh-adapter-v1.pending";
const adapterMetadataMigrationName = ".hra-oh-adapter-v1.migrating";
const databaseName = "oh.sqlite";
const operationKeySchema = z.string().min(1).max(200);
const maximumForkRecords = 8_192;
const metadataMaximumBytes = 16 * 1024;
const hostActorId = "hra.memory.host";

export const HRA_OH_FACTS_MEMORY_LIMITS_V1 = Object.freeze({
  forkSnapshotBytes: 8 * 1024 * 1024,
  sqliteLogicalBytes: 96 * 1024 * 1024,
});

const adapterMetadataSchema = z.object({
  adapterDigest: factsMemoryDigestSchema,
  bindingDigest: factsMemoryDigestSchema,
  createdAt: unixMillisecondsSchema,
  createKind: z.enum(["create", "fork"]),
  handleHash: factsMemoryDigestSchema,
  initialHead: factsMemoryHeadSchema,
  ohBindingSha256: factsMemoryDigestSchema,
  operationKey: operationKeySchema,
  parent: factsMemoryCheckpointSchema.nullable(),
  receiptDigest: factsMemoryDigestSchema,
  version: z.literal(1),
}).strict().superRefine((value, context) => {
  if ((value.createKind === "create") !== (value.parent === null)) {
    context.addIssue({ code: "custom", message: "Oh adapter creation kind and parent disagree." });
  }
});

type AdapterMetadata = z.infer<typeof adapterMetadataSchema>;
const legacyHeadSchema = z.object({
  digest: factsMemoryDigestSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const legacyCheckpointSchema = z.object({
  bindingDigest: factsMemoryDigestSchema,
  head: legacyHeadSchema,
  ownerId: profileIdSchema,
  sessionId: sessionIdSchema,
}).strict();
const legacyAdapterMetadataSchema = z.object({
  adapterDigest: factsMemoryDigestSchema,
  bindingDigest: factsMemoryDigestSchema,
  createdAt: unixMillisecondsSchema,
  createKind: z.enum(["create", "fork"]),
  handleHash: factsMemoryDigestSchema,
  initialHead: legacyHeadSchema,
  ohBindingSha256: factsMemoryDigestSchema,
  operationKey: operationKeySchema,
  parent: legacyCheckpointSchema.nullable(),
  receiptDigest: factsMemoryDigestSchema,
  version: z.literal(1),
}).strict().superRefine((value, context) => {
  if ((value.createKind === "create") !== (value.parent === null)) {
    context.addIssue({ code: "custom", message: "Legacy Oh adapter creation kind and parent disagree." });
  }
});
type LegacyAdapterMetadata = z.infer<typeof legacyAdapterMetadataSchema>;
type ParsedAdapterMetadata = Readonly<{ legacy: boolean; metadata: AdapterMetadata }>;
type PendingMetadata =
  | Readonly<{ status: "complete"; metadata: AdapterMetadata }>
  | Readonly<{ status: "incomplete" }>
  | Readonly<{ status: "missing" }>;

const normalizeLegacyMetadata = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const metadata = { ...(value as Record<string, unknown>) };
  if (
    metadata.initialHead !== null
    && typeof metadata.initialHead === "object"
    && !Array.isArray(metadata.initialHead)
  ) {
    const head = { ...(metadata.initialHead as Record<string, unknown>) };
    if (!Object.hasOwn(head, "operationSha256") && head.sequence === 0) {
      head.operationSha256 = null;
    }
    metadata.initialHead = head;
  }
  if (metadata.parent !== null && typeof metadata.parent === "object" && !Array.isArray(metadata.parent)) {
    const parent = { ...(metadata.parent as Record<string, unknown>) };
    if (!Object.hasOwn(parent, "epoch")) parent.epoch = 1;
    if (parent.head !== null && typeof parent.head === "object" && !Array.isArray(parent.head)) {
      const head = { ...(parent.head as Record<string, unknown>) };
      if (!Object.hasOwn(head, "operationSha256") && head.sequence === 0) {
        head.operationSha256 = null;
      }
      parent.head = head;
    }
    metadata.parent = parent;
  }
  return metadata;
};

const digestParts = (domain: string, parts: readonly string[]): string => {
  const digest = createHash("sha256");
  digest.update(domain);
  for (const part of parts) {
    digest.update("\0");
    digest.update(part);
  }
  return digest.digest("hex");
};

const digestOhHead = (head: OhHeadV1): string => digestParts("hra-oh-head-v1", [
  String(head.generation),
  head.graphRevisionSha256 ?? "empty",
  head.operationSha256 ?? "empty",
  head.recordsSha256,
  String(head.sequence),
  String(head.v),
]);

const projectOhHead = (value: unknown): FactsMemoryHead => {
  const head = parseOhHeadV1(value);
  if (head === null) throw new Error("FACTS_MEMORY_OH_HEAD_INVALID");
  return factsMemoryHeadSchema.parse({
    digest: digestOhHead(head),
    operationSha256: head.operationSha256,
    sequence: head.sequence,
  });
};

const ohHeadRef = (head: FactsMemoryHead) => {
  const value = parseOhHeadRefV1({
    operationSha256: head.operationSha256,
    sequence: head.sequence,
  });
  if (value === null) throw new Error("FACTS_MEMORY_OH_HEAD_INVALID");
  return value;
};

const metadataDigest = (value: Omit<AdapterMetadata, "adapterDigest">): string =>
  digestParts("hra-oh-adapter-metadata-v1", [
    value.bindingDigest,
    String(value.createdAt),
    value.createKind,
    value.handleHash,
    String(value.initialHead.sequence),
    ...(value.initialHead.operationSha256 === null ? [] : [value.initialHead.operationSha256]),
    value.initialHead.digest,
    value.ohBindingSha256,
    value.operationKey,
    value.parent?.bindingDigest ?? "no-parent",
    ...(value.parent === null || value.parent.epoch === 1 ? [] : [String(value.parent.epoch)]),
    value.parent?.ownerId ?? "no-parent",
    value.parent?.sessionId ?? "no-parent",
    value.parent === null ? "no-parent" : String(value.parent.head.sequence),
    value.parent?.head.operationSha256 ?? "no-parent",
    value.parent?.head.digest ?? "no-parent",
    value.receiptDigest,
    String(value.version),
  ]);

const legacyMetadataDigest = (value: Omit<LegacyAdapterMetadata, "adapterDigest">): string =>
  digestParts("hra-oh-adapter-metadata-v1", [
    value.bindingDigest,
    String(value.createdAt),
    value.createKind,
    value.handleHash,
    String(value.initialHead.sequence),
    value.initialHead.digest,
    value.ohBindingSha256,
    value.operationKey,
    value.parent?.bindingDigest ?? "no-parent",
    value.parent?.ownerId ?? "no-parent",
    value.parent?.sessionId ?? "no-parent",
    value.parent === null ? "no-parent" : String(value.parent.head.sequence),
    value.parent?.head.digest ?? "no-parent",
    value.receiptDigest,
    String(value.version),
  ]);

const parseAdapterMetadata = (value: unknown): ParsedAdapterMetadata => {
  const normalized = adapterMetadataSchema.safeParse(normalizeLegacyMetadata(value));
  if (normalized.success) {
    const { adapterDigest, ...body } = normalized.data;
    if (metadataDigest(body) === adapterDigest) {
      return { legacy: false, metadata: normalized.data };
    }
  }
  const legacy = legacyAdapterMetadataSchema.safeParse(value);
  if (!legacy.success) {
    if (normalized.success) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
    throw normalized.error;
  }
  const { adapterDigest, ...legacyBody } = legacy.data;
  if (legacyMetadataDigest(legacyBody) !== adapterDigest) {
    throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
  }
  if (
    legacy.data.initialHead.sequence !== 0
    || (legacy.data.parent !== null && legacy.data.parent.head.sequence !== 0)
  ) {
    throw new Error("FACTS_MEMORY_OH_LEGACY_NONEMPTY_RECOVERY_REQUIRED");
  }
  const normalizedLegacy = normalizeLegacyMetadata(legacy.data);
  if (normalizedLegacy === null || typeof normalizedLegacy !== "object" || Array.isArray(normalizedLegacy)) {
    throw new Error("FACTS_MEMORY_OH_METADATA_INVALID");
  }
  const currentWithPlaceholder = adapterMetadataSchema.parse({
    ...(normalizedLegacy as Record<string, unknown>),
    adapterDigest: "0".repeat(64),
  });
  return {
    legacy: true,
    metadata: adapterMetadataSchema.parse({
      ...currentWithPlaceholder,
      adapterDigest: metadataDigest(currentWithPlaceholder),
    }),
  };
};

const receiptFromMetadata = (metadata: AdapterMetadata): FactsMemoryStoreReceipt =>
  factsMemoryStoreReceiptSchema.parse({
    bindingDigest: metadata.bindingDigest,
    createdAt: metadata.createdAt,
    handleHash: metadata.handleHash,
    head: metadata.initialHead,
    receiptDigest: metadata.receiptDigest,
    version: metadata.version,
  });

const checkpointsEqual = (
  left: FactsMemoryCheckpoint | null,
  right: FactsMemoryCheckpoint | null,
): boolean => left === null || right === null
  ? left === right
  : left.bindingDigest === right.bindingDigest
    && left.epoch === right.epoch
    && left.ownerId === right.ownerId
    && left.sessionId === right.sessionId
    && left.head.sequence === right.head.sequence
    && left.head.operationSha256 === right.head.operationSha256
    && left.head.digest === right.head.digest;

const errorCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error ? String(error.code) : null;

const assertPrivateDirectory = (directory: string): void => {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("FACTS_MEMORY_OH_DIRECTORY_UNSAFE");
  }
  const metadata = lstatSync(directory);
  const owner = process.getuid?.();
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (owner !== undefined && metadata.uid !== owner)
    || (metadata.mode & 0o077) !== 0
    || realpathSync(directory) !== directory
  ) throw new Error("FACTS_MEMORY_OH_DIRECTORY_UNSAFE");
};

const assertPrivateDatabase = (path: string): void => {
  const metadata = lstatSync(path);
  const owner = process.getuid?.();
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (owner !== undefined && metadata.uid !== owner)
    || (metadata.mode & 0o077) !== 0
    || realpathSync(path) !== resolve(path)
  ) throw new Error("FACTS_MEMORY_OH_DATABASE_UNSAFE");
};

const enforcePrivateSqliteFiles = (directory: string): void => {
  for (const name of [databaseName, `${databaseName}-wal`, `${databaseName}-shm`] as const) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = fstatSync(descriptor);
      const owner = process.getuid?.();
      if (
        !metadata.isFile()
        || metadata.nlink !== 1
        || (owner !== undefined && metadata.uid !== owner)
      ) throw new Error("FACTS_MEMORY_OH_DATABASE_UNSAFE");
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    assertPrivateDatabase(path);
  }
};

const assertBoundedLogicalDatabase = (directory: string): void => {
  let logicalBytes = 0;
  for (const name of [databaseName, `${databaseName}-wal`] as const) {
    const path = join(directory, name);
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    try {
      const metadata = fstatSync(descriptor);
      const owner = process.getuid?.();
      if (
        !metadata.isFile()
        || metadata.nlink !== 1
        || (metadata.mode & 0o077) !== 0
        || (owner !== undefined && metadata.uid !== owner)
      ) throw new Error("FACTS_MEMORY_OH_DATABASE_UNSAFE");
      if (
        metadata.size > HRA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes - logicalBytes
      ) throw new Error("FACTS_MEMORY_OH_DATABASE_TOO_LARGE");
      logicalBytes += metadata.size;
    } finally {
      closeSync(descriptor);
    }
  }
};

const assertBoundedForkSnapshot = (records: readonly unknown[]): void => {
  let encodedBytes = 2;
  for (const [index, record] of records.entries()) {
    const encoded = JSON.stringify(record);
    const separatorBytes = index === 0 ? 0 : 1;
    const recordBytes = Buffer.byteLength(encoded, "utf8");
    if (
      recordBytes + separatorBytes
      > HRA_OH_FACTS_MEMORY_LIMITS_V1.forkSnapshotBytes - encodedBytes
    ) throw new Error("FACTS_MEMORY_OH_FORK_SNAPSHOT_TOO_LARGE");
    encodedBytes += recordBytes + separatorBytes;
  }
};

function migrateLegacyMetadataFile(path: string, metadata: AdapterMetadata): void {
  const directory = dirname(path);
  const pendingPath = join(directory, adapterMetadataMigrationName);
  let descriptor: number;
  try {
    descriptor = openSync(
      pendingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    const pending = readPendingMetadataFile(pendingPath);
    if (pending.status === "complete") {
      if (JSON.stringify(pending.metadata) !== JSON.stringify(metadata)) {
        throw new Error("FACTS_MEMORY_OH_METADATA_MIGRATION_CONFLICT");
      }
      renameSync(pendingPath, path);
      syncDirectory(directory);
      return;
    }
    try {
      descriptor = openSync(pendingPath, constants.O_WRONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Error("FACTS_MEMORY_OH_METADATA_MIGRATION_CONFLICT");
    }
  }
  try {
    const before = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (owner !== undefined && before.uid !== owner)
    ) throw new Error("FACTS_MEMORY_OH_METADATA_UNSAFE");
    fchmodSync(descriptor, 0o600);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, JSON.stringify(metadata), "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(pendingPath, path);
  syncDirectory(directory);
}

const readMetadataFile = (path: string): AdapterMetadata | null => {
  let descriptor: number | undefined;
  let result: ParsedAdapterMetadata;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o077) !== 0
      || (owner !== undefined && before.uid !== owner)
      || before.size < 2
      || before.size > metadataMaximumBytes
    ) throw new Error("FACTS_MEMORY_OH_METADATA_UNSAFE");
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || Buffer.byteLength(text, "utf8") !== after.size
    ) throw new Error("FACTS_MEMORY_OH_METADATA_CHANGED");
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error("FACTS_MEMORY_OH_METADATA_INVALID");
    }
    result = parseAdapterMetadata(value);
    const receipt = receiptFromMetadata(result.metadata);
    if (
      digestFactsMemoryReceipt({
        bindingDigest: receipt.bindingDigest,
        createdAt: receipt.createdAt,
        handleHash: receipt.handleHash,
        head: receipt.head,
        version: receipt.version,
      }) !== receipt.receiptDigest
    ) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
  } finally {
    closeSync(descriptor);
  }
  if (result.legacy) {
    migrateLegacyMetadataFile(path, result.metadata);
    const migrated = readMetadataFile(path);
    if (migrated === null || JSON.stringify(migrated) !== JSON.stringify(result.metadata)) {
      throw new Error("FACTS_MEMORY_OH_METADATA_MIGRATION_READBACK_MISMATCH");
    }
    return migrated;
  }
  return result.metadata;
};

const readPendingMetadataFile = (path: string): PendingMetadata => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o077) !== 0
      || (owner !== undefined && before.uid !== owner)
      || before.size > metadataMaximumBytes
    ) throw new Error("FACTS_MEMORY_OH_METADATA_UNSAFE");
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || Buffer.byteLength(text, "utf8") !== after.size
    ) throw new Error("FACTS_MEMORY_OH_METADATA_CHANGED");
    if (text.length < 2) return { status: "incomplete" };
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return { status: "incomplete" };
    }
    let parsed: ParsedAdapterMetadata;
    try {
      parsed = parseAdapterMetadata(value);
    } catch (error: unknown) {
      if (
        error instanceof Error
        && (
          error.message === "FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH"
          || error.message === "FACTS_MEMORY_OH_LEGACY_NONEMPTY_RECOVERY_REQUIRED"
        )
      ) {
        throw error;
      }
      return { status: "incomplete" };
    }
    const receipt = receiptFromMetadata(parsed.metadata);
    if (
      digestFactsMemoryReceipt({
        bindingDigest: receipt.bindingDigest,
        createdAt: receipt.createdAt,
        handleHash: receipt.handleHash,
        head: receipt.head,
        version: receipt.version,
      }) !== receipt.receiptDigest
    ) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
    return { status: "complete", metadata: parsed.metadata };
  } finally {
    closeSync(descriptor);
  }
};

const syncDirectory = (directory: string): void => {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const publishMetadata = (directory: string, metadata: AdapterMetadata): void => {
  const finalPath = join(directory, adapterMetadataName);
  const pendingPath = join(directory, adapterMetadataPendingName);
  const existing = readMetadataFile(finalPath);
  if (existing !== null) {
    if (JSON.stringify(existing) !== JSON.stringify(metadata)) {
      throw new Error("FACTS_MEMORY_OH_METADATA_REPLAY_MISMATCH");
    }
    return;
  }
  const pending = readPendingMetadataFile(pendingPath);
  if (pending.status === "complete") {
    if (JSON.stringify(pending.metadata) !== JSON.stringify(metadata)) {
      throw new Error("FACTS_MEMORY_OH_METADATA_PENDING_MISMATCH");
    }
    renameSync(pendingPath, finalPath);
    syncDirectory(directory);
    if (JSON.stringify(readMetadataFile(finalPath)) !== JSON.stringify(metadata)) {
      throw new Error("FACTS_MEMORY_OH_METADATA_READBACK_MISMATCH");
    }
    return;
  }
  const descriptor = openSync(pendingPath, pending.status === "missing"
    ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const before = fstatSync(descriptor);
    const owner = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (owner !== undefined && before.uid !== owner)
    ) throw new Error("FACTS_MEMORY_OH_METADATA_UNSAFE");
    fchmodSync(descriptor, 0o600);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, JSON.stringify(metadata), "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(pendingPath, finalPath);
  syncDirectory(directory);
  if (JSON.stringify(readMetadataFile(finalPath)) !== JSON.stringify(metadata)) {
    throw new Error("FACTS_MEMORY_OH_METADATA_READBACK_MISMATCH");
  }
};

const makeReceipt = (input: Readonly<{
  binding: FactsMemoryBinding;
  createdAt: number;
  handleHash: string;
  head: FactsMemoryHead;
}>): FactsMemoryStoreReceipt => {
  const base = {
    bindingDigest: input.binding.bindingDigest,
    createdAt: unixMillisecondsSchema.parse(input.createdAt),
    handleHash: factsMemoryDigestSchema.parse(input.handleHash),
    head: factsMemoryHeadSchema.parse(input.head),
    version: 1 as const,
  };
  return factsMemoryStoreReceiptSchema.parse({
    ...base,
    receiptDigest: digestFactsMemoryReceipt(base),
  });
};

/**
 * Exact Oh v0.2.0 working-profile adapter. Every Oh handle is host-owned,
 * directory-scoped, and closed before this lifecycle port resolves.
 */
export class OhSqliteFactsMemoryEngine implements LocalOhFactsMemoryEnginePort {
  readonly #now: () => number;
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(options: Readonly<{ now?: () => number }> = {}) {
    this.#now = options.now ?? Date.now;
  }

  create(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
    operationKey: string;
  }>): Promise<FactsMemoryStoreReceipt> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const directory = input.directory;
    const operationKey = operationKeySchema.parse(input.operationKey);
    return this.#serializeDirectories([directory], async () => {
      assertPrivateDirectory(directory);
      const existing = readMetadataFile(join(directory, adapterMetadataName));
      if (existing !== null) {
        this.#assertCreation(existing, binding, operationKey, null);
        await this.#inspectComplete(binding, directory, existing);
        return receiptFromMetadata(existing);
      }
      const pending = readPendingMetadataFile(join(directory, adapterMetadataPendingName));
      if (pending.status === "complete") {
        this.#assertCreation(pending.metadata, binding, operationKey, null);
        await this.#inspectComplete(binding, directory, pending.metadata);
        publishMetadata(directory, pending.metadata);
        return receiptFromMetadata(pending.metadata);
      }
      const authority = await this.#open(binding, directory, false);
      let receipt: FactsMemoryStoreReceipt;
      let metadata: AdapterMetadata;
      try {
        const verification = await this.#verifyBounded(authority, directory);
        const initialHead = projectOhHead(verification.head);
        if (initialHead.sequence !== 0 || verification.operations !== 0 || verification.records !== 0) {
          throw new Error("FACTS_MEMORY_OH_CREATE_NOT_EMPTY");
        }
        const handleHash = this.#handleHash(binding, authority.store.binding.bindingSha256);
        receipt = makeReceipt({
          binding,
          createdAt: this.#now(),
          handleHash,
          head: initialHead,
        });
        metadata = this.#metadata({
          binding,
          createKind: "create",
          ohBindingSha256: authority.store.binding.bindingSha256,
          operationKey,
          parent: null,
          receipt,
        });
      } finally {
        await authority.store.close();
      }
      publishMetadata(directory, metadata);
      return receipt;
    });
  }

  fork(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
    operationKey: string;
    parent: FactsMemoryCheckpoint;
    parentDirectory: string;
  }>): Promise<FactsMemoryStoreReceipt> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const parent = factsMemoryCheckpointSchema.parse(input.parent);
    const directory = input.directory;
    const parentDirectory = input.parentDirectory;
    const operationKey = operationKeySchema.parse(input.operationKey);
    if (binding.ownerId !== parent.ownerId) throw new Error("FACTS_MEMORY_PARENT_AUTHORITY_MISMATCH");
    if (binding.sessionId === parent.sessionId || directory === parentDirectory) {
      throw new Error("FACTS_MEMORY_SELF_FORK");
    }
    return this.#serializeDirectories([directory, parentDirectory], async () => {
      assertPrivateDirectory(directory);
      assertPrivateDirectory(parentDirectory);
      const existing = readMetadataFile(join(directory, adapterMetadataName));
      if (existing !== null) {
        this.#assertCreation(existing, binding, operationKey, parent);
        await this.#inspectComplete(binding, directory, existing);
        return receiptFromMetadata(existing);
      }
      const pending = readPendingMetadataFile(join(directory, adapterMetadataPendingName));
      if (pending.status === "complete") {
        this.#assertCreation(pending.metadata, binding, operationKey, parent);
        await this.#inspectComplete(binding, directory, pending.metadata);
        publishMetadata(directory, pending.metadata);
        return receiptFromMetadata(pending.metadata);
      }

      const parentBinding = factsMemoryBindingSchema.parse({
        bindingDigest: parent.bindingDigest,
        epoch: parent.epoch,
        ownerId: parent.ownerId,
        sessionId: parent.sessionId,
      });
      const parentMetadata = readMetadataFile(join(parentDirectory, adapterMetadataName));
      if (parentMetadata === null) throw new Error("FACTS_MEMORY_OH_PARENT_NOT_ACTIVE");
      this.#assertMetadataBinding(parentMetadata, parentBinding);
      const parentAuthority = await this.#open(parentBinding, parentDirectory, true);
      let snapshot: Awaited<ReturnType<typeof parentAuthority.store.snapshot>>;
      try {
        snapshot = await parentAuthority.store.snapshot({
          head: ohHeadRef(parent.head),
          maximumRecords: maximumForkRecords,
        });
        const snapshotHead = projectOhHead(snapshot.head);
        if (
          snapshotHead.sequence !== parent.head.sequence
          || snapshotHead.operationSha256 !== parent.head.operationSha256
          || snapshotHead.digest !== parent.head.digest
        ) {
          throw new Error("FACTS_MEMORY_PARENT_CHECKPOINT_MISMATCH");
        }
      } finally {
        await parentAuthority.store.close();
      }
      assertBoundedForkSnapshot(snapshot.records);

      const childAuthority = await this.#open(binding, directory, false);
      let receipt: FactsMemoryStoreReceipt;
      let metadata: AdapterMetadata;
      try {
        if (snapshot.records.length > 0) {
          await childAuthority.store.commit({
            actorId: hostActorId,
            changes: snapshot.records.map((record) => ({ kind: "put" as const, record, v: 1 as const })),
            expectedHead: { generation: 0, operationSha256: null },
            operationId: `hra.fork.${digestParts("hra-oh-fork-operation-v1", [operationKey])}`,
          });
        }
        const verification = await this.#verifyBounded(childAuthority, directory);
        if (
          verification.records !== snapshot.records.length
          || verification.head.recordsSha256 !== snapshot.head.recordsSha256
          || verification.operations !== (snapshot.records.length === 0 ? 0 : 1)
        ) throw new Error("FACTS_MEMORY_OH_FORK_COPY_MISMATCH");
        const initialHead = projectOhHead(verification.head);
        const handleHash = this.#handleHash(binding, childAuthority.store.binding.bindingSha256);
        receipt = makeReceipt({
          binding,
          createdAt: this.#now(),
          handleHash,
          head: initialHead,
        });
        metadata = this.#metadata({
          binding,
          createKind: "fork",
          ohBindingSha256: childAuthority.store.binding.bindingSha256,
          operationKey,
          parent,
          receipt,
        });
      } finally {
        await childAuthority.store.close();
      }
      publishMetadata(directory, metadata);
      return receipt;
    });
  }

  inspect(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
    expectedHead?: FactsMemoryHead;
  }>): Promise<FactsMemoryBrokerInspection> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const directory = input.directory;
    return this.#serializeDirectories([directory], async () => {
      assertPrivateDirectory(directory);
      let metadata = readMetadataFile(join(directory, adapterMetadataName));
      let recoveredInspection: FactsMemoryStoreInspection | undefined;
      if (metadata === null) {
        const pending = readPendingMetadataFile(join(directory, adapterMetadataPendingName));
        if (pending.status !== "complete") return { status: "missing" };
        metadata = pending.metadata;
        recoveredInspection = await this.#inspectComplete(
          binding,
          directory,
          metadata,
          input.expectedHead,
        );
        publishMetadata(directory, metadata);
      }
      return {
        inspection: recoveredInspection ?? await this.#inspectComplete(
          binding,
          directory,
          metadata,
          input.expectedHead,
        ),
        status: "present",
      };
    });
  }

  quiesceForPurge(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
  }>): Promise<Readonly<{ handleHash: string | null }>> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const directory = input.directory;
    return this.#serializeDirectories([directory], async () => {
      assertPrivateDirectory(directory);
      let metadata: AdapterMetadata | null = null;
      try {
        metadata = readMetadataFile(join(directory, adapterMetadataName));
      } catch {
        // Recovery cleanup owns the complete validated 0700 session directory.
        // A malformed or legacy sidecar cannot authorize reopening, but the Oh
        // database binding below can still prove the exact store before purge.
      }
      const databasePath = join(directory, databaseName);
      if (!existsSync(databasePath)) {
        if (metadata !== null) throw new Error("FACTS_MEMORY_OH_DATABASE_MISSING");
        return { handleHash: null };
      }
      try {
        assertBoundedLogicalDatabase(directory);
      } catch (error: unknown) {
        if (
          !(error instanceof Error)
          || error.message !== "FACTS_MEMORY_OH_DATABASE_TOO_LARGE"
          || metadata === null
        ) throw error;
        this.#assertMetadataBinding(metadata, binding);
        return { handleHash: metadata.handleHash };
      }
      const authority = await this.#open(binding, directory, true);
      try {
        const verification = await this.#verifyBounded(authority, directory);
        if (metadata !== null) {
          this.#assertMetadataAuthority(metadata, binding, authority);
          const head = projectOhHead(verification.head);
          if (
            head.sequence < metadata.initialHead.sequence
            || (head.sequence === metadata.initialHead.sequence
              && (head.operationSha256 !== metadata.initialHead.operationSha256
                || head.digest !== metadata.initialHead.digest))
          ) throw new Error("FACTS_MEMORY_OH_HEAD_REGRESSION");
          if (head.sequence > metadata.initialHead.sequence) {
            await authority.store.changesSince(ohHeadRef(metadata.initialHead), { limit: 1 });
          }
        }
        return { handleHash: this.#handleHash(binding, authority.store.binding.bindingSha256) };
      } finally {
        await authority.store.close();
      }
    });
  }

  async #open(
    binding: FactsMemoryBinding,
    directory: string,
    requireExisting: boolean,
  ): Promise<OhStoreAuthorityV1> {
    assertPrivateDirectory(directory);
    const path = join(directory, databaseName);
    if (requireExisting && !existsSync(path)) throw new Error("FACTS_MEMORY_OH_DATABASE_MISSING");
    enforcePrivateSqliteFiles(directory);
    assertBoundedLogicalDatabase(directory);
    const authority = createOhSqliteStoreAuthorityV1({
      path,
      profile: OH_WORKING_STORE_PROFILE_V1,
      realmId: `hra:${binding.bindingDigest}`,
      spaceId: this.#spaceId(binding),
    });
    try {
      enforcePrivateSqliteFiles(directory);
      assertBoundedLogicalDatabase(directory);
      const persisted = parseOhStoreBindingV1(authority.store.binding);
      if (
        persisted === null
        || persisted.profile.profileSha256 !== OH_WORKING_STORE_PROFILE_V1.profileSha256
        || persisted.realmId !== `hra:${binding.bindingDigest}`
        || persisted.spaceId !== this.#spaceId(binding)
        || authority.host.binding.bindingSha256 !== persisted.bindingSha256
      ) throw new Error("FACTS_MEMORY_OH_BINDING_MISMATCH");
      return authority;
    } catch (error: unknown) {
      try {
        await authority.store.close();
      } catch (closeError: unknown) {
        throw new AggregateError([error, closeError], "Failed to close rejected Oh authority.");
      }
      throw error;
    }
  }

  async #inspectComplete(
    binding: FactsMemoryBinding,
    directory: string,
    metadata: AdapterMetadata,
    expectedHead?: FactsMemoryHead,
  ): Promise<FactsMemoryStoreInspection> {
    this.#assertMetadataBinding(metadata, binding);
    const authority = await this.#open(binding, directory, true);
    try {
      this.#assertMetadataAuthority(metadata, binding, authority);
      const verification = await this.#verifyBounded(authority, directory);
      const head = projectOhHead(verification.head);
      if (expectedHead !== undefined) {
        const expected = factsMemoryHeadSchema.parse(expectedHead);
        if (head.sequence < expected.sequence) throw new Error("FACTS_MEMORY_OH_HEAD_REGRESSION");
        if (head.sequence === expected.sequence) {
          if (
            head.operationSha256 !== expected.operationSha256
            || head.digest !== expected.digest
          ) throw new Error("FACTS_MEMORY_OH_HEAD_EQUIVOCATION");
        } else {
          await authority.store.changesSince(ohHeadRef(expected), { limit: 1 });
        }
      }
      if (
        head.sequence < metadata.initialHead.sequence
        || (head.sequence === metadata.initialHead.sequence
          && (head.operationSha256 !== metadata.initialHead.operationSha256
            || head.digest !== metadata.initialHead.digest))
      ) throw new Error("FACTS_MEMORY_OH_HEAD_REGRESSION");
      if (head.sequence > metadata.initialHead.sequence) {
        await authority.store.changesSince(ohHeadRef(metadata.initialHead), { limit: 1 });
      }
      const receipt = receiptFromMetadata(metadata);
      const base = {
        bindingDigest: binding.bindingDigest,
        createdAt: receipt.createdAt,
        handleHash: receipt.handleHash,
        head,
        initialHead: receipt.head,
        receiptDigest: receipt.receiptDigest,
        version: 1 as const,
      };
      return factsMemoryStoreInspectionSchema.parse({
        ...base,
        inspectionDigest: digestFactsMemoryInspection(base),
      });
    } finally {
      await authority.store.close();
    }
  }

  async #verifyBounded(
    authority: OhStoreAuthorityV1,
    directory: string,
  ): Promise<Awaited<ReturnType<OhStoreAuthorityV1["store"]["verify"]>>> {
    assertBoundedLogicalDatabase(directory);
    const verification = await authority.store.verify();
    assertBoundedLogicalDatabase(directory);
    return verification;
  }

  #assertCreation(
    metadata: AdapterMetadata,
    binding: FactsMemoryBinding,
    operationKey: string,
    parent: FactsMemoryCheckpoint | null,
  ): void {
    this.#assertMetadataBinding(metadata, binding);
    if (
      metadata.operationKey !== operationKey
      || metadata.createKind !== (parent === null ? "create" : "fork")
      || !checkpointsEqual(metadata.parent, parent)
    ) throw new Error("FACTS_MEMORY_OH_CREATE_REPLAY_MISMATCH");
  }

  #assertMetadataBinding(metadata: AdapterMetadata, binding: FactsMemoryBinding): void {
    if (metadata.bindingDigest !== binding.bindingDigest) {
      throw new Error("FACTS_MEMORY_OH_METADATA_BINDING_MISMATCH");
    }
  }

  #assertMetadataAuthority(
    metadata: AdapterMetadata,
    binding: FactsMemoryBinding,
    authority: OhStoreAuthorityV1,
  ): void {
    const ohBindingSha256 = authority.store.binding.bindingSha256;
    if (
      metadata.ohBindingSha256 !== ohBindingSha256
      || metadata.handleHash !== this.#handleHash(binding, ohBindingSha256)
    ) throw new Error("FACTS_MEMORY_OH_METADATA_AUTHORITY_MISMATCH");
  }

  #handleHash(binding: FactsMemoryBinding, ohBindingSha256: string): string {
    return digestParts("hra-oh-handle-v1", [binding.bindingDigest, ohBindingSha256]);
  }

  #spaceId(binding: FactsMemoryBinding): string {
    return binding.epoch === 1
      ? `hra:${binding.sessionId}`
      : `hra:${binding.sessionId}:epoch:${String(binding.epoch)}`;
  }

  #metadata(input: Readonly<{
    binding: FactsMemoryBinding;
    createKind: "create" | "fork";
    ohBindingSha256: string;
    operationKey: string;
    parent: FactsMemoryCheckpoint | null;
    receipt: FactsMemoryStoreReceipt;
  }>): AdapterMetadata {
    const body = {
      bindingDigest: input.binding.bindingDigest,
      createdAt: input.receipt.createdAt,
      createKind: input.createKind,
      handleHash: input.receipt.handleHash,
      initialHead: input.receipt.head,
      ohBindingSha256: factsMemoryDigestSchema.parse(input.ohBindingSha256),
      operationKey: input.operationKey,
      parent: input.parent,
      receiptDigest: input.receipt.receiptDigest,
      version: 1 as const,
    };
    return adapterMetadataSchema.parse({ ...body, adapterDigest: metadataDigest(body) });
  }

  #serializeDirectories<T>(directories: readonly string[], operation: () => Promise<T>): Promise<T> {
    const exact = [...new Set(directories)].sort();
    const acquire = (index: number): Promise<T> => index >= exact.length
      ? operation()
      : this.#serialize(exact[index] as string, async () => await acquire(index + 1));
    return acquire(0);
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#tails.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.#tails.set(key, current);
    return current.finally(() => {
      if (this.#tails.get(key) === current) this.#tails.delete(key);
    });
  }
}
