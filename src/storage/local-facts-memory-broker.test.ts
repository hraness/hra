import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFactsMemoryBinding,
  digestFactsMemoryInspection,
  digestFactsMemoryReceipt,
  type FactsMemoryBinding,
  type FactsMemoryCheckpoint,
  type FactsMemoryHead,
  type FactsMemoryStoreReceipt,
} from "../domain/facts-memory";
import type { FactsMemoryBrokerInspection } from "../daemon/facts-memory-lifecycle";
import {
  LocalFactsMemoryBroker,
  type LocalOhFactsMemoryEnginePort,
} from "./local-facts-memory-broker";
import { ensurePrivateDirectory } from "./paths";

const ownerId = `acct_${"a".repeat(32)}`;
const sessionId = `sess_${"1".repeat(32)}`;
const childSessionId = `sess_${"2".repeat(32)}`;

const receipt = (
  binding: FactsMemoryBinding,
  head: FactsMemoryHead = { digest: "d".repeat(64), operationSha256: null, sequence: 0 },
): FactsMemoryStoreReceipt => {
  const base = {
    version: 1 as const,
    bindingDigest: binding.bindingDigest,
    createdAt: 100,
    handleHash: "c".repeat(64),
    head,
  };
  return { ...base, receiptDigest: digestFactsMemoryReceipt(base) };
};

const inspection = (stored: FactsMemoryStoreReceipt) => {
  const base = {
    version: 1 as const,
    bindingDigest: stored.bindingDigest,
    createdAt: stored.createdAt,
    handleHash: stored.handleHash,
    head: stored.head,
    initialHead: stored.head,
    receiptDigest: stored.receiptDigest,
  };
  return { ...base, inspectionDigest: digestFactsMemoryInspection(base) };
};

class FakeLocalOhEngine implements LocalOhFactsMemoryEnginePort {
  readonly stores = new Map<string, FactsMemoryStoreReceipt>();
  quiesceCalls = 0;
  quiesceHandleOverride: string | undefined;

  async create(input: { binding: FactsMemoryBinding; directory: string }): Promise<FactsMemoryStoreReceipt> {
    await writeFile(join(input.directory, "store.sqlite"), "semantic bytes");
    await writeFile(join(input.directory, "store.sqlite-wal"), "wal");
    await writeFile(join(input.directory, "store.sqlite-shm"), "shm");
    await mkdir(join(input.directory, "cache"));
    await writeFile(join(input.directory, "cache", "projection.bin"), "cache");
    const created = receipt(input.binding);
    this.stores.set(input.directory, created);
    return created;
  }

  async fork(input: {
    binding: FactsMemoryBinding;
    directory: string;
    parent: FactsMemoryCheckpoint;
  }): Promise<FactsMemoryStoreReceipt> {
    await writeFile(join(input.directory, "store.sqlite"), "forked semantic bytes");
    const created = receipt(input.binding, input.parent.head);
    this.stores.set(input.directory, created);
    return created;
  }

  async inspect(input: { directory: string }): Promise<FactsMemoryBrokerInspection> {
    const stored = this.stores.get(input.directory);
    return stored === undefined
      ? { status: "missing" }
      : { status: "present", inspection: inspection(stored) };
  }

  async quiesceForPurge(input: { directory: string }): Promise<{ handleHash: string | null }> {
    this.quiesceCalls += 1;
    const handleHash = this.quiesceHandleOverride
      ?? this.stores.get(input.directory)?.handleHash
      ?? null;
    return { handleHash };
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-local-memory-")));
  roots.push(root);
  await ensurePrivateDirectory(root);
  const engine = new FakeLocalOhEngine();
  const broker = new LocalFactsMemoryBroker({ engine, now: () => 200, root });
  return { broker, engine, root };
};

describe("local Oh facts-memory custody", () => {
  test("uses one host-derived directory and removes SQLite, WAL, SHM, and cache together", async () => {
    const { broker, engine, root } = await fixture();
    const binding = createFactsMemoryBinding({ ownerId, sessionId });
    const created = await broker.create({ binding, operationKey: `create:${sessionId}` });
    expect(await realpath(join(root, sessionId))).toBe(join(root, sessionId));
    const purged = await broker.purge({
      binding,
      expectedHandleHash: created.handleHash,
      operationKey: `cleanup:${sessionId}:archive`,
    });
    expect(purged.handleHash).toBe(created.handleHash);
    expect(engine.quiesceCalls).toBe(1);
    await expect(realpath(join(root, sessionId))).rejects.toThrow();
    await expect(realpath(join(root, `.purging-${sessionId}`))).rejects.toThrow();
  });

  test("finishes an interrupted post-rename cleanup idempotently", async () => {
    const { broker, root } = await fixture();
    const binding = createFactsMemoryBinding({ ownerId, sessionId });
    const created = await broker.create({ binding, operationKey: `create:${sessionId}` });
    await rename(join(root, sessionId), join(root, `.purging-${sessionId}`));
    await expect(broker.purge({
      binding,
      expectedHandleHash: created.handleHash,
      operationKey: `cleanup:${sessionId}:abandon`,
    })).resolves.toMatchObject({ handleHash: created.handleHash });
    await expect(broker.purge({
      binding,
      expectedHandleHash: created.handleHash,
      operationKey: `cleanup:${sessionId}:abandon`,
    })).resolves.toMatchObject({ handleHash: created.handleHash });
  });

  test("rejects target and root symlinks instead of following them", async () => {
    const { broker, root } = await fixture();
    const outside = await realpath(await mkdtemp(join(tmpdir(), "hra-memory-outside-")));
    roots.push(outside);
    await symlink(outside, join(root, sessionId));
    const binding = createFactsMemoryBinding({ ownerId, sessionId });
    await expect(broker.inspect(binding)).rejects.toThrow();

    const linkedRoot = join(outside, "linked-root");
    await symlink(root, linkedRoot);
    const linked = new LocalFactsMemoryBroker({
      engine: new FakeLocalOhEngine(),
      root: linkedRoot,
    });
    await expect(linked.inspect(createFactsMemoryBinding({ ownerId, sessionId: childSessionId })))
      .rejects.toThrow();
  });

  test("rejects invalid session path input and an inexact fork checkpoint", async () => {
    const { broker, engine, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId });
    await broker.create({ binding: parent, operationKey: `create:${sessionId}` });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await expect(broker.fork({
      binding: child,
      operationKey: `fork:${childSessionId}`,
      parent: {
        ...parent,
        head: { digest: "e".repeat(64), operationSha256: "a".repeat(64), sequence: 1 },
      },
    })).rejects.toThrow("FACTS_MEMORY_PARENT_CHECKPOINT_MISMATCH");
    expect(engine.stores.has(join(root, childSessionId))).toBe(false);
    await expect(broker.inspect({
      ...child,
      sessionId: "../../escape",
    } as FactsMemoryBinding)).rejects.toThrow();
  });

  test("rejects forged bindings and invalid engine inspection receipts", async () => {
    const { broker, engine, root } = await fixture();
    const binding = createFactsMemoryBinding({ ownerId, sessionId });
    const created = await broker.create({ binding, operationKey: `create:${sessionId}` });
    engine.stores.set(join(root, sessionId), {
      ...created,
      receiptDigest: "e".repeat(64),
    });
    await expect(broker.inspect(binding)).rejects.toThrow("FACTS_MEMORY_BROKER_INSPECTION_INVALID");
    await expect(broker.inspect({
      ...binding,
      bindingDigest: "f".repeat(64),
    })).rejects.toThrow();
  });

  test("retains the exact directory when quiescence proves a different handle", async () => {
    const { broker, engine, root } = await fixture();
    const binding = createFactsMemoryBinding({ ownerId, sessionId });
    const created = await broker.create({ binding, operationKey: `create:${sessionId}` });
    engine.quiesceHandleOverride = "e".repeat(64);
    await expect(broker.purge({
      binding,
      expectedHandleHash: created.handleHash,
      operationKey: `cleanup:${sessionId}:archive`,
    })).rejects.toThrow("FACTS_MEMORY_PURGE_HANDLE_MISMATCH");
    expect(await realpath(join(root, sessionId))).toBe(join(root, sessionId));
  });
});
