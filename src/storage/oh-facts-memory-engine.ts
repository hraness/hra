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
import { isAbsolute, join, resolve } from "node:path";

import { createOhSqliteStoreAuthorityV1 } from "@hraness/oh/sqlite";
import {
  OH_WORKING_STORE_PROFILE_V1,
  parseOhHeadV1,
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
import { unixMillisecondsSchema } from "../domain/values";
import type { FactsMemoryBrokerInspection } from "../daemon/facts-memory-lifecycle";
import type { LocalOhFactsMemoryEnginePort } from "./local-facts-memory-broker";

const adapterMetadataName = ".hra-oh-adapter-v1.json";
const adapterMetadataPendingName = ".hra-oh-adapter-v1.pending";
const databaseName = "oh.sqlite";
const operationKeySchema = z.string().min(1).max(200);
const maximumForkRecords = 8_192;
const metadataMaximumBytes = 16 * 1024;
const hostActorId = "hra.memory.host";

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
type PendingMetadata =
  | Readonly<{ status: "complete"; metadata: AdapterMetadata }>
  | Readonly<{ status: "incomplete" }>
  | Readonly<{ status: "missing" }>;

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
  return factsMemoryHeadSchema.parse({ digest: digestOhHead(head), sequence: head.sequence });
};

const metadataDigest = (value: Omit<AdapterMetadata, "adapterDigest">): string =>
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
    && left.ownerId === right.ownerId
    && left.sessionId === right.sessionId
    && left.head.sequence === right.head.sequence
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

const readMetadataFile = (path: string): AdapterMetadata | null => {
  let descriptor: number | undefined;
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
    const parsed = adapterMetadataSchema.parse(value);
    const { adapterDigest, ...body } = parsed;
    const receipt = receiptFromMetadata(parsed);
    if (
      metadataDigest(body) !== adapterDigest
      || digestFactsMemoryReceipt({
        bindingDigest: receipt.bindingDigest,
        createdAt: receipt.createdAt,
        handleHash: receipt.handleHash,
        head: receipt.head,
        version: receipt.version,
      }) !== receipt.receiptDigest
    ) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
    return parsed;
  } finally {
    closeSync(descriptor);
  }
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
    const parsedResult = adapterMetadataSchema.safeParse(value);
    if (!parsedResult.success) return { status: "incomplete" };
    const parsed = parsedResult.data;
    const { adapterDigest, ...body } = parsed;
    const receipt = receiptFromMetadata(parsed);
    if (
      metadataDigest(body) !== adapterDigest
      || digestFactsMemoryReceipt({
        bindingDigest: receipt.bindingDigest,
        createdAt: receipt.createdAt,
        handleHash: receipt.handleHash,
        head: receipt.head,
        version: receipt.version,
      }) !== receipt.receiptDigest
    ) throw new Error("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
    return { status: "complete", metadata: parsed };
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
        const verification = await authority.store.verify();
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
        ownerId: parent.ownerId,
        sessionId: parent.sessionId,
      });
      const parentMetadata = readMetadataFile(join(parentDirectory, adapterMetadataName));
      if (parentMetadata === null) throw new Error("FACTS_MEMORY_OH_PARENT_NOT_ACTIVE");
      this.#assertMetadataBinding(parentMetadata, parentBinding);
      const parentAuthority = await this.#open(parentBinding, parentDirectory, true);
      let snapshot: Awaited<ReturnType<typeof parentAuthority.store.snapshot>>;
      try {
        const verification = await parentAuthority.store.verify();
        const currentHead = projectOhHead(verification.head);
        if (
          currentHead.sequence !== parent.head.sequence
          || currentHead.digest !== parent.head.digest
        ) throw new Error("FACTS_MEMORY_PARENT_CHECKPOINT_MISMATCH");
        snapshot = await parentAuthority.store.snapshot({
          head: {
            operationSha256: verification.head.operationSha256,
            sequence: verification.head.sequence,
          },
          maximumRecords: maximumForkRecords,
        });
        const snapshotHead = projectOhHead(snapshot.head);
        if (
          snapshotHead.sequence !== parent.head.sequence
          || snapshotHead.digest !== parent.head.digest
        ) {
          throw new Error("FACTS_MEMORY_PARENT_CHECKPOINT_MISMATCH");
        }
      } finally {
        await parentAuthority.store.close();
      }

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
        const verification = await childAuthority.store.verify();
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
        recoveredInspection = await this.#inspectComplete(binding, directory, metadata);
        publishMetadata(directory, metadata);
      }
      return {
        inspection: recoveredInspection ?? await this.#inspectComplete(binding, directory, metadata),
        status: "present",
      };
    });
  }

  quiesceForPurge(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
  }>): Promise<void> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const directory = input.directory;
    return this.#serializeDirectories([directory], async () => {
      assertPrivateDirectory(directory);
      const metadata = readMetadataFile(join(directory, adapterMetadataName));
      const databasePath = join(directory, databaseName);
      if (!existsSync(databasePath)) {
        if (metadata !== null) throw new Error("FACTS_MEMORY_OH_DATABASE_MISSING");
        return;
      }
      const authority = await this.#open(binding, directory, true);
      try {
        const verification = await authority.store.verify();
        if (metadata !== null) {
          this.#assertMetadataAuthority(metadata, binding, authority);
          const head = projectOhHead(verification.head);
          if (
            head.sequence < metadata.initialHead.sequence
            || (head.sequence === metadata.initialHead.sequence
              && head.digest !== metadata.initialHead.digest)
          ) throw new Error("FACTS_MEMORY_OH_HEAD_REGRESSION");
        }
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
    const authority = createOhSqliteStoreAuthorityV1({
      path,
      profile: OH_WORKING_STORE_PROFILE_V1,
      realmId: `hra:${binding.bindingDigest}`,
      spaceId: `hra:${binding.sessionId}`,
    });
    enforcePrivateSqliteFiles(directory);
    const persisted = parseOhStoreBindingV1(authority.store.binding);
    if (
      persisted === null
      || persisted.profile.profileSha256 !== OH_WORKING_STORE_PROFILE_V1.profileSha256
      || persisted.realmId !== `hra:${binding.bindingDigest}`
      || persisted.spaceId !== `hra:${binding.sessionId}`
      || authority.host.binding.bindingSha256 !== persisted.bindingSha256
    ) {
      await authority.store.close();
      enforcePrivateSqliteFiles(directory);
      throw new Error("FACTS_MEMORY_OH_BINDING_MISMATCH");
    }
    return authority;
  }

  async #inspectComplete(
    binding: FactsMemoryBinding,
    directory: string,
    metadata: AdapterMetadata,
  ): Promise<FactsMemoryStoreInspection> {
    this.#assertMetadataBinding(metadata, binding);
    const authority = await this.#open(binding, directory, true);
    try {
      this.#assertMetadataAuthority(metadata, binding, authority);
      const verification = await authority.store.verify();
      const head = projectOhHead(verification.head);
      if (
        head.sequence < metadata.initialHead.sequence
        || (head.sequence === metadata.initialHead.sequence
          && head.digest !== metadata.initialHead.digest)
      ) throw new Error("FACTS_MEMORY_OH_HEAD_REGRESSION");
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
