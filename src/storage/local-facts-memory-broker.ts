import { constants } from "node:fs";
import { access, lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import {
  digestFactsMemoryInspection,
  digestFactsMemoryPurgeReceipt,
  digestFactsMemoryReceipt,
  factsMemoryBindingSchema,
  factsMemoryCheckpointSchema,
  factsMemoryDigestSchema,
  factsMemoryHeadSchema,
  factsMemoryPurgeReceiptSchema,
  factsMemoryStoreInspectionSchema,
  factsMemoryStoreReceiptSchema,
  type FactsMemoryBinding,
  type FactsMemoryCheckpoint,
  type FactsMemoryHead,
  type FactsMemoryPurgeReceipt,
  type FactsMemoryStoreInspection,
  type FactsMemoryStoreReceipt,
} from "../domain/facts-memory";
import { sessionIdSchema, unixMillisecondsSchema } from "../domain/values";
import type {
  FactsMemoryBrokerInspection,
  FactsMemoryBrokerPort,
} from "../daemon/facts-memory-lifecycle";
import { ensurePrivateDirectory } from "./paths";

const operationKeySchema = z.string().min(1).max(200);
const engineInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing") }).strict(),
  z.object({
    inspection: factsMemoryStoreInspectionSchema,
    status: z.literal("present"),
  }).strict(),
]);

/** @internal Exported only for exact boundary regression tests. */
export const isTransientFactsMemorySidecarDisappearance = (
  root: string,
  path: string,
  depth: number,
  error: unknown,
): boolean =>
  depth === 1
  && (path === join(root, "oh.sqlite-shm") || path === join(root, "oh.sqlite-wal"))
  && error instanceof Error
  && "code" in error
  && error.code === "ENOENT";

/** Host adapter seam for the immutable Oh package. It is never reachable from model tools. */
export interface LocalOhFactsMemoryEnginePort {
  create(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
    operationKey: string;
  }>): Promise<FactsMemoryStoreReceipt>;
  fork(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
    operationKey: string;
    parent: FactsMemoryCheckpoint;
    parentDirectory: string;
  }>): Promise<FactsMemoryStoreReceipt>;
  inspect(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
    expectedHead?: FactsMemoryHead;
  }>): Promise<FactsMemoryBrokerInspection>;
  quiesceForPurge(input: Readonly<{
    binding: FactsMemoryBinding;
    directory: string;
  }>): Promise<Readonly<{ handleHash: string | null }>>;
}

const isMissing = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return false;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
};

export class LocalFactsMemoryBroker implements FactsMemoryBrokerPort {
  readonly #engine: LocalOhFactsMemoryEnginePort;
  readonly #now: () => number;
  readonly #root: string;

  constructor(input: Readonly<{
    engine: LocalOhFactsMemoryEnginePort;
    now?: () => number;
    root: string;
  }>) {
    if (!isAbsolute(input.root)) throw new Error("FACTS_MEMORY_ROOT_NOT_ABSOLUTE");
    this.#root = resolve(input.root);
    this.#engine = input.engine;
    this.#now = input.now ?? Date.now;
  }

  async create(input: Readonly<{
    binding: FactsMemoryBinding;
    operationKey: string;
  }>): Promise<FactsMemoryStoreReceipt> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const operationKey = operationKeySchema.parse(input.operationKey);
    const directory = await this.#prepareCreateDirectory(binding);
    const receipt = this.#assertReceipt(binding, await this.#engine.create({
      binding,
      directory,
      operationKey,
    }));
    return receipt;
  }

  async fork(input: Readonly<{
    binding: FactsMemoryBinding;
    operationKey: string;
    parent: FactsMemoryCheckpoint;
  }>): Promise<FactsMemoryStoreReceipt> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const operationKey = operationKeySchema.parse(input.operationKey);
    const parent = factsMemoryCheckpointSchema.parse(input.parent);
    if (binding.sessionId === parent.sessionId) throw new Error("FACTS_MEMORY_SELF_FORK");
    if (binding.ownerId !== parent.ownerId) throw new Error("FACTS_MEMORY_PARENT_AUTHORITY_MISMATCH");
    const parentBinding = factsMemoryBindingSchema.parse({
      bindingDigest: parent.bindingDigest,
      epoch: parent.epoch,
      ownerId: parent.ownerId,
      sessionId: parent.sessionId,
    });
    const parentDirectory = await this.#requireExistingDirectory(parentBinding);
    let parentInspection: z.infer<typeof engineInspectionSchema>;
    try {
      parentInspection = engineInspectionSchema.parse(await this.#engine.inspect({
        binding: parentBinding,
        directory: parentDirectory,
        expectedHead: parent.head,
      }));
    } catch (cause: unknown) {
      throw new Error("FACTS_MEMORY_PARENT_CHECKPOINT_MISMATCH", { cause });
    }
    const inspectedParent = parentInspection.status === "present"
      ? this.#assertInspection(parent, parentInspection.inspection)
      : null;
    if (
      inspectedParent === null
      || inspectedParent.head.sequence < parent.head.sequence
      || (inspectedParent.head.sequence === parent.head.sequence
        && (inspectedParent.head.operationSha256 !== parent.head.operationSha256
          || inspectedParent.head.digest !== parent.head.digest))
    ) throw new Error("FACTS_MEMORY_PARENT_CHECKPOINT_MISMATCH");
    const directory = await this.#prepareCreateDirectory(binding);
    const receipt = this.#assertReceipt(binding, await this.#engine.fork({
      binding,
      directory,
      operationKey,
      parent,
      parentDirectory,
    }));
    return receipt;
  }

  async inspect(
    bindingValue: FactsMemoryBinding,
    expectedHead?: FactsMemoryHead,
  ): Promise<FactsMemoryBrokerInspection> {
    const binding = factsMemoryBindingSchema.parse(bindingValue);
    await this.#requireRoot();
    const directory = this.#sessionDirectory(binding);
    if (await isMissing(directory)) return { status: "missing" };
    await this.#assertPrivateTree(directory);
    const inspection = engineInspectionSchema.parse(await this.#engine.inspect({
      binding,
      directory,
      ...(expectedHead === undefined ? {} : { expectedHead: factsMemoryHeadSchema.parse(expectedHead) }),
    }));
    if (inspection.status === "present") this.#assertInspection(binding, inspection.inspection);
    return inspection;
  }

  async purge(input: Readonly<{
    binding: FactsMemoryBinding;
    expectedHandleHash: string | null;
    operationKey: string;
  }>): Promise<FactsMemoryPurgeReceipt> {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const expectedHandleHash = factsMemoryDigestSchema.nullable().parse(input.expectedHandleHash);
    operationKeySchema.parse(input.operationKey);
    await this.#requireRoot();
    const directory = this.#sessionDirectory(binding);
    const quarantine = this.#quarantineDirectory(binding);
    let handleHash = expectedHandleHash;
    if (!(await isMissing(directory))) {
      if (!(await isMissing(quarantine))) throw new Error("FACTS_MEMORY_PURGE_QUARANTINE_CONFLICT");
      await this.#assertPrivateTree(directory);
      const quiesced = z.object({ handleHash: factsMemoryDigestSchema.nullable() }).strict().parse(
        await this.#engine.quiesceForPurge({ binding, directory }),
      );
      if (
        expectedHandleHash !== null
        && quiesced.handleHash !== null
        && quiesced.handleHash !== expectedHandleHash
      ) {
        throw new Error("FACTS_MEMORY_PURGE_HANDLE_MISMATCH");
      }
      handleHash = quiesced.handleHash ?? expectedHandleHash;
      await this.#assertPrivateTree(directory);
      await rename(directory, quarantine);
    }
    if (!(await isMissing(quarantine))) {
      await this.#assertPrivateTree(quarantine);
      await rm(quarantine, { recursive: true });
    }
    if (!(await isMissing(directory)) || !(await isMissing(quarantine))) {
      throw new Error("FACTS_MEMORY_PURGE_INCOMPLETE");
    }
    const base = {
      version: 1 as const,
      bindingDigest: binding.bindingDigest,
      handleHash,
      purgedAt: unixMillisecondsSchema.parse(this.#now()),
    };
    return factsMemoryPurgeReceiptSchema.parse({
      ...base,
      purgeDigest: digestFactsMemoryPurgeReceipt(base),
    });
  }

  async #prepareCreateDirectory(binding: FactsMemoryBinding): Promise<string> {
    await this.#requireRoot();
    const quarantine = this.#quarantineDirectory(binding);
    if (!(await isMissing(quarantine))) throw new Error("FACTS_MEMORY_CLEANUP_PENDING");
    const directory = this.#sessionDirectory(binding);
    if (await isMissing(directory)) await ensurePrivateDirectory(directory);
    await this.#assertPrivateTree(directory);
    return directory;
  }

  async #requireExistingDirectory(binding: FactsMemoryBinding): Promise<string> {
    await this.#requireRoot();
    const directory = this.#sessionDirectory(binding);
    if (await isMissing(directory)) throw new Error("FACTS_MEMORY_PARENT_STORE_MISSING");
    await this.#assertPrivateTree(directory);
    return directory;
  }

  async #requireRoot(): Promise<void> {
    const canonical = await ensurePrivateDirectory(this.#root);
    if (canonical !== this.#root) throw new Error("FACTS_MEMORY_ROOT_UNSAFE");
  }

  #sessionDirectory(bindingValue: FactsMemoryBinding): string {
    const binding = factsMemoryBindingSchema.parse(bindingValue);
    const component = this.#directoryComponent(binding);
    const target = resolve(join(this.#root, component));
    const relativeTarget = relative(this.#root, target);
    if (relativeTarget !== component || relativeTarget.startsWith("..")) {
      throw new Error("FACTS_MEMORY_PATH_ESCAPE");
    }
    return target;
  }

  #quarantineDirectory(bindingValue: FactsMemoryBinding): string {
    const binding = factsMemoryBindingSchema.parse(bindingValue);
    return resolve(join(this.#root, `.purging-${this.#directoryComponent(binding)}`));
  }

  #directoryComponent(binding: FactsMemoryBinding): string {
    const sessionId = sessionIdSchema.parse(binding.sessionId);
    return binding.epoch === 1 ? sessionId : `${sessionId}.epoch-${String(binding.epoch)}`;
  }

  #assertReceipt(binding: FactsMemoryBinding, value: unknown): FactsMemoryStoreReceipt {
    const receipt = factsMemoryStoreReceiptSchema.parse(value);
    if (
      receipt.bindingDigest !== binding.bindingDigest
      || digestFactsMemoryReceipt({
        version: receipt.version,
        bindingDigest: receipt.bindingDigest,
        createdAt: receipt.createdAt,
        handleHash: receipt.handleHash,
        head: receipt.head,
      }) !== receipt.receiptDigest
    ) throw new Error("FACTS_MEMORY_BROKER_RECEIPT_INVALID");
    return receipt;
  }

  #assertInspection(
    binding: FactsMemoryBinding,
    value: unknown,
  ): FactsMemoryStoreInspection {
    const inspection = factsMemoryStoreInspectionSchema.parse(value);
    const { inspectionDigest, ...body } = inspection;
    if (
      inspection.bindingDigest !== binding.bindingDigest
      || digestFactsMemoryReceipt({
        version: inspection.version,
        bindingDigest: inspection.bindingDigest,
        createdAt: inspection.createdAt,
        handleHash: inspection.handleHash,
        head: inspection.initialHead,
      }) !== inspection.receiptDigest
      || digestFactsMemoryInspection(body) !== inspectionDigest
    ) throw new Error("FACTS_MEMORY_BROKER_INSPECTION_INVALID");
    return inspection;
  }

  async #assertPrivateTree(root: string): Promise<void> {
    const owner = process.getuid?.();
    let observed = 0;
    const readEntry = async (path: string, depth: number) => {
      try {
        return await lstat(path);
      } catch (error: unknown) {
        if (isTransientFactsMemorySidecarDisappearance(root, path, depth, error)) {
          // Bun may unlink its root-level WAL/SHM after close(false) returns on Linux.
          // A recreated sidecar is revalidated by the Oh engine before it opens SQLite.
          return null;
        }
        throw error;
      }
    };
    const visit = async (path: string, depth: number): Promise<void> => {
      observed += 1;
      if (observed > 4_096 || depth > 16) throw new Error("FACTS_MEMORY_TREE_BOUND_EXCEEDED");
      const before = await readEntry(path, depth);
      if (before === null) return;
      if (
        before.isSymbolicLink()
        || before.nlink < 1
        || (owner !== undefined && before.uid !== owner)
      ) throw new Error("FACTS_MEMORY_TREE_UNSAFE");
      if (before.isDirectory()) {
        if (await realpath(path) !== resolve(path)) throw new Error("FACTS_MEMORY_TREE_UNSAFE");
        await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
        const entries = await readdir(path);
        for (const entry of entries.sort()) await visit(join(path, entry), depth + 1);
      } else if (!before.isFile() || before.nlink !== 1) {
        throw new Error("FACTS_MEMORY_TREE_UNSAFE");
      }
      const after = await readEntry(path, depth);
      if (after === null) return;
      if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.uid !== after.uid
        || before.isDirectory() !== after.isDirectory()
        || before.isFile() !== after.isFile()
        || after.isSymbolicLink()
        || (after.isFile() && after.nlink !== 1)
      ) {
        throw new Error("FACTS_MEMORY_TREE_CHANGED");
      }
    };
    await visit(root, 0);
  }
}
