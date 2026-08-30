import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  createFactsMemoryBinding,
  digestFactsMemoryInspection,
  digestFactsMemoryPurgeReceipt,
  digestFactsMemoryReceipt,
  type FactsMemoryBinding,
  type FactsMemoryCheckpoint,
  type FactsMemoryHead,
  type FactsMemoryStoreReceipt,
} from "../domain/facts-memory";
import { FactsMemoryControlStore } from "../storage/facts-memory-control";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import {
  HraFactsMemoryLifecycle,
  type FactsMemoryBrokerInspection,
  type FactsMemoryBrokerPort,
} from "./facts-memory-lifecycle";

const ownerId = `acct_${"a".repeat(32)}`;
const anotherOwnerId = `acct_${"b".repeat(32)}`;
const sessionId = `sess_${"1".repeat(32)}`;
const childSessionId = `sess_${"2".repeat(32)}`;
const otherParentSessionId = `sess_${"3".repeat(32)}`;

const storeReceipt = (
  binding: FactsMemoryBinding,
  head = { digest: "d".repeat(64), sequence: 0 },
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

const storeInspection = (receipt: FactsMemoryStoreReceipt, head: FactsMemoryHead) => {
  const base = {
    version: 1 as const,
    bindingDigest: receipt.bindingDigest,
    createdAt: receipt.createdAt,
    handleHash: receipt.handleHash,
    head,
    initialHead: receipt.head,
    receiptDigest: receipt.receiptDigest,
  };
  return { ...base, inspectionDigest: digestFactsMemoryInspection(base) };
};

class FakeBroker implements FactsMemoryBrokerPort {
  readonly receipts = new Map<string, FactsMemoryStoreReceipt>();
  readonly heads = new Map<string, FactsMemoryHead>();
  createCalls = 0;
  forkCalls = 0;
  purgeCalls = 0;
  failCreateAfterCommit = false;
  failPurgeOnce = false;
  lastParent: FactsMemoryCheckpoint | null = null;

  async create(input: { binding: FactsMemoryBinding }): Promise<FactsMemoryStoreReceipt> {
    this.createCalls += 1;
    const receipt = this.receipts.get(input.binding.sessionId) ?? storeReceipt(input.binding);
    this.receipts.set(input.binding.sessionId, receipt);
    this.heads.set(input.binding.sessionId, receipt.head);
    if (this.failCreateAfterCommit) {
      this.failCreateAfterCommit = false;
      throw new Error("lost create response");
    }
    return receipt;
  }

  async fork(input: { binding: FactsMemoryBinding; parent: FactsMemoryCheckpoint }): Promise<FactsMemoryStoreReceipt> {
    this.forkCalls += 1;
    this.lastParent = input.parent;
    const receipt = storeReceipt(input.binding, input.parent.head);
    this.receipts.set(input.binding.sessionId, receipt);
    this.heads.set(input.binding.sessionId, receipt.head);
    return receipt;
  }

  async inspect(binding: FactsMemoryBinding): Promise<FactsMemoryBrokerInspection> {
    const receipt = this.receipts.get(binding.sessionId);
    const head = this.heads.get(binding.sessionId);
    return receipt === undefined || head === undefined
      ? { status: "missing" }
      : { status: "present", inspection: storeInspection(receipt, head) };
  }

  async purge(input: { binding: FactsMemoryBinding; expectedHandleHash: string | null }) {
    this.purgeCalls += 1;
    const present = this.receipts.get(input.binding.sessionId);
    const handleHash = present?.handleHash ?? input.expectedHandleHash ?? "e".repeat(64);
    this.receipts.delete(input.binding.sessionId);
    this.heads.delete(input.binding.sessionId);
    if (this.failPurgeOnce) {
      this.failPurgeOnce = false;
      throw new Error("lost purge response");
    }
    const base = {
      version: 1 as const,
      bindingDigest: input.binding.bindingDigest,
      handleHash,
      purgedAt: 200,
    };
    return { ...base, purgeDigest: digestFactsMemoryPurgeReceipt(base) };
  }
}

const roots: string[] = [];
const controls: FactsMemoryControlStore[] = [];
afterEach(async () => {
  for (const control of controls.splice(0)) control.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-facts-memory-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const control = new FactsMemoryControlStore(paths.factsMemoryControl, { now: () => 50 });
  controls.push(control);
  const broker = new FakeBroker();
  return { broker, control, lifecycle: new HraFactsMemoryLifecycle({ broker, control }) };
};

describe("HRA facts-memory lifecycle", () => {
  test("refuses a control database containing any semantic table", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-facts-memory-schema-")));
    roots.push(home);
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const database = new Database(paths.factsMemoryControl);
    database.exec("CREATE TABLE semantic_facts(payload TEXT)");
    database.close(false);
    expect(() => new FactsMemoryControlStore(paths.factsMemoryControl))
      .toThrow("FACTS_MEMORY_CONTROL_SCHEMA_UNEXPECTED");
  });

  test("single-flights create, persists only bounded authority, and replays exactly", async () => {
    const { broker, control, lifecycle } = await fixture();
    const [first, second] = await Promise.all([
      lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 }),
      lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 }),
    ]);
    expect(first).toEqual(second);
    expect(first.state).toBe("active");
    expect(broker.createCalls).toBe(1);
    expect(await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 })).toEqual(first);
    expect(broker.createCalls).toBe(1);
    expect(control.schemaColumns().some((column) =>
      /fact|payload|record|rule|projection|credential|token|path/u.test(column))).toBe(false);
  });

  test("reconciles a create/finalize response race without speculative replay", async () => {
    const { broker, lifecycle } = await fixture();
    broker.failCreateAfterCommit = true;
    await expect(lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 }))
      .rejects.toThrow("lost create response");
    expect(await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 }))
      .toMatchObject({ state: "active" });
    expect(broker.createCalls).toBe(1);
  });

  test("reconciles an exact control finalize that committed before its response was lost", async () => {
    const { broker, control, lifecycle } = await fixture();
    const finalize = control.finalizeActive.bind(control);
    let loseResponse = true;
    control.finalizeActive = (binding, receipt) => {
      const result = finalize(binding, receipt);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("lost finalize response");
      }
      return result;
    };
    await expect(lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 }))
      .resolves.toMatchObject({ state: "active" });
    expect(control.get(sessionId)?.state).toBe("active");
    expect(broker.createCalls).toBe(1);
  });

  test("rejects cross-owner binding and global operation-key reuse", async () => {
    const { control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    await expect(lifecycle.resumeSession({ ownerId: anotherOwnerId, sessionId }))
      .rejects.toThrow("FACTS_MEMORY_AUTHORITY_MISMATCH");
    const other = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    expect(() => control.reserve({
      binding: other,
      createOperationKey: `create:${sessionId}`,
      expiresAt: 1_000,
    })).toThrow("FACTS_MEMORY_OPERATION_KEY_REUSED");
  });

  test("forks only the exact parent checkpoint and preserves it across retry", async () => {
    const { broker, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.heads.set(sessionId, { digest: "f".repeat(64), sequence: 7 });
    const child = await lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    });
    expect(child.head).toEqual({ digest: "f".repeat(64), sequence: 7 });
    expect(broker.lastParent?.head).toEqual({ digest: "f".repeat(64), sequence: 7 });
    broker.heads.set(sessionId, { digest: "9".repeat(64), sequence: 8 });
    await lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    });
    expect(broker.forkCalls).toBe(1);
    expect(broker.lastParent?.head.sequence).toBe(7);
  });

  test("single-flights concurrent forks onto one recorded parent checkpoint", async () => {
    const { broker, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.heads.set(sessionId, { digest: "f".repeat(64), sequence: 7 });
    const calls = [1, 2].map(async () => await lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    }));
    const [first, second] = await Promise.all(calls);
    expect(first).toEqual(second);
    expect(broker.forkCalls).toBe(1);
    expect(broker.lastParent?.head).toEqual({ digest: "f".repeat(64), sequence: 7 });
  });

  test("refuses to reinterpret an existing child as a fork or change its parent", async () => {
    const { lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    await lifecycle.ensureSession({ ownerId, sessionId: childSessionId, expiresAt: 1_000 });
    await expect(lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    })).rejects.toThrow("FACTS_MEMORY_FORK_RESERVATION_MISMATCH");

    await lifecycle.ensureSession({ ownerId, sessionId: otherParentSessionId, expiresAt: 1_000 });
    const forkedSessionId = `sess_${"4".repeat(32)}`;
    await lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId: forkedSessionId,
      ownerId,
      parentSessionId: sessionId,
    });
    await expect(lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId: forkedSessionId,
      ownerId,
      parentSessionId: otherParentSessionId,
    })).rejects.toThrow("FACTS_MEMORY_FORK_RESERVATION_MISMATCH");
  });

  test("rejects same-sequence head equivocation", async () => {
    const { broker, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.heads.set(sessionId, { digest: "9".repeat(64), sequence: 0 });
    await expect(lifecycle.resumeSession({ ownerId, sessionId }))
      .rejects.toThrow("FACTS_MEMORY_HEAD_EQUIVOCATION");
  });

  test("quarantines a non-strict foreign inspection envelope", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.inspect = async () => ({
      status: "missing",
      unexpected: "foreign field",
    }) as unknown as FactsMemoryBrokerInspection;
    await expect(lifecycle.resumeSession({ ownerId, sessionId })).rejects.toThrow();
    expect(control.get(sessionId)?.state).toBe("recovery_required");
  });

  test("retries cleanup-pending authority before expiry and sweeps expiry with idempotent receipts", async () => {
    const { broker, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.failPurgeOnce = true;
    await expect(lifecycle.cleanupSession({ ownerId, reason: "abandon", sessionId }))
      .rejects.toThrow("lost purge response");
    expect(await lifecycle.sweepExpired(50)).toEqual({ attempted: 1, failed: 0, purged: 1 });
    expect(broker.purgeCalls).toBe(2);

    await lifecycle.ensureSession({ ownerId, sessionId: childSessionId, expiresAt: 500 });
    expect(await lifecycle.sweepExpired(500)).toEqual({ attempted: 1, failed: 0, purged: 1 });
  });

  test("reconciles an earlier cleanup reason instead of creating a second purge authority", async () => {
    const { broker, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.failPurgeOnce = true;
    await expect(lifecycle.cleanupSession({ ownerId, reason: "archive", sessionId }))
      .rejects.toThrow("lost purge response");
    expect(await lifecycle.cleanupSession({ ownerId, reason: "abandon", sessionId }))
      .toMatchObject({ state: "purged" });
    expect(broker.purgeCalls).toBe(2);
  });
});
