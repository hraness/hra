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
  failForkAfterCommit = false;
  failInspectOnce = false;
  failPurgeOnce = false;
  readonly failPurgeSessions = new Set<string>();
  inspectGate: Promise<void> | undefined;
  inspectEntered: (() => void) | undefined;
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
    if (this.failForkAfterCommit) {
      this.failForkAfterCommit = false;
      throw new Error("lost fork response");
    }
    return receipt;
  }

  async inspect(binding: FactsMemoryBinding): Promise<FactsMemoryBrokerInspection> {
    this.inspectEntered?.();
    this.inspectEntered = undefined;
    if (this.inspectGate !== undefined) {
      const gate = this.inspectGate;
      this.inspectGate = undefined;
      await gate;
    }
    if (this.failInspectOnce) {
      this.failInspectOnce = false;
      throw new Error("transient inspect failure");
    }
    const receipt = this.receipts.get(binding.sessionId);
    const head = this.heads.get(binding.sessionId);
    return receipt === undefined || head === undefined
      ? { status: "missing" }
      : { status: "present", inspection: storeInspection(receipt, head) };
  }

  async purge(input: { binding: FactsMemoryBinding; expectedHandleHash: string | null }) {
    this.purgeCalls += 1;
    if (this.failPurgeSessions.has(input.binding.sessionId)) {
      throw new Error("persistent purge failure");
    }
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
  return { broker, control, lifecycle: new HraFactsMemoryLifecycle({ broker, control }), paths };
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

  test("migrates v1 custody and quarantines a nonempty legacy head until exact reproof", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-facts-memory-v1-")));
    roots.push(home);
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const binding = createFactsMemoryBinding({ ownerId, sessionId });
    const database = new Database(paths.factsMemoryControl);
    database.exec(`
      CREATE TABLE facts_memory_lifecycles (
        session_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,binding_digest TEXT NOT NULL UNIQUE,
        create_kind TEXT NOT NULL,create_operation_key TEXT NOT NULL UNIQUE,parent_session_id TEXT,
        parent_owner_id TEXT,parent_binding_digest TEXT,parent_head_sequence INTEGER,
        parent_head_digest TEXT,state TEXT NOT NULL,handle_hash TEXT,head_sequence INTEGER,
        head_digest TEXT,store_created_at INTEGER,create_receipt_digest TEXT,expires_at INTEGER NOT NULL,
        cleanup_reason TEXT,cleanup_operation_key TEXT UNIQUE,cleanup_receipt_digest TEXT,purged_at INTEGER,
        revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version=1;
    `);
    database.query(
      `INSERT INTO facts_memory_lifecycles(
        session_id,owner_id,binding_digest,create_kind,create_operation_key,state,handle_hash,
        head_sequence,head_digest,store_created_at,create_receipt_digest,expires_at,revision,created_at,updated_at
      ) VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,1,1,1)`,
    ).run(
      sessionId,
      ownerId,
      binding.bindingDigest,
      "create",
      `create:${sessionId}`,
      "c".repeat(64),
      1,
      "d".repeat(64),
      1,
      "e".repeat(64),
      1_000,
    );
    database.close(false);

    const migrated = new FactsMemoryControlStore(paths.factsMemoryControl, { now: () => 2 });
    controls.push(migrated);
    expect(migrated.get(sessionId)).toMatchObject({
      binding: { epoch: 1 },
      head: null,
      legacyHead: { digest: "d".repeat(64), sequence: 1 },
      state: "recovery_required",
    });
    expect(migrated.schemaColumns()).toContain("head_operation_sha256");
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
    broker.heads.set(sessionId, {
      digest: "f".repeat(64),
      operationSha256: "7".repeat(64),
      sequence: 7,
    });
    const child = await lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    });
    expect(child.head).toEqual({
      digest: "f".repeat(64),
      operationSha256: "7".repeat(64),
      sequence: 7,
    });
    expect(broker.lastParent?.head).toEqual({
      digest: "f".repeat(64),
      operationSha256: "7".repeat(64),
      sequence: 7,
    });
    broker.heads.set(sessionId, {
      digest: "9".repeat(64),
      operationSha256: "8".repeat(64),
      sequence: 8,
    });
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
    broker.heads.set(sessionId, {
      digest: "f".repeat(64),
      operationSha256: "7".repeat(64),
      sequence: 7,
    });
    const calls = [1, 2].map(async () => await lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    }));
    const [first, second] = await Promise.all(calls);
    expect(first).toEqual(second);
    expect(broker.forkCalls).toBe(1);
    expect(broker.lastParent?.head).toEqual({
      digest: "f".repeat(64),
      operationSha256: "7".repeat(64),
      sequence: 7,
    });
  });

  test("fences a parent epoch until a crash-left child fork becomes exactly recoverable", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.failForkAfterCommit = true;
    await expect(lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    })).rejects.toThrow("lost fork response");
    expect(control.get(childSessionId)?.state).toBe("create_ambiguous");
    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId,
    })).rejects.toThrow("FACTS_MEMORY_PARENT_REFERENCED");
    expect(control.get(sessionId)?.state).toBe("active");

    await expect(lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    })).resolves.toMatchObject({ state: "active" });
    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId,
    })).resolves.toMatchObject({ state: "purged" });
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
    broker.heads.set(sessionId, {
      digest: "9".repeat(64),
      operationSha256: null,
      sequence: 0,
    });
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

  test("reactivates only an expired session in a new bounded epoch", async () => {
    const { broker, control, lifecycle, paths } = await fixture();
    const first = await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 100 });
    expect(first.epoch).toBe(1);
    expect(await lifecycle.sweepExpired(100)).toEqual({ attempted: 1, failed: 0, purged: 1 });
    const purged = control.get(sessionId);
    expect(purged).toMatchObject({ state: "purged", binding: { epoch: 1 } });

    const reactivated = await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 200 });
    expect(reactivated).toMatchObject({ epoch: 2, state: "active" });
    expect(reactivated.bindingDigest).not.toBe(first.bindingDigest);
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 2 },
      priorPurgeChainDigest: expect.any(String),
      state: "active",
    });
    expect(broker.createCalls).toBe(2);

    let expiresAt = 200;
    for (let epoch = 3; epoch <= 8; epoch += 1) {
      expect(await lifecycle.sweepExpired(expiresAt)).toEqual({ attempted: 1, failed: 0, purged: 1 });
      expiresAt += 100;
      expect(await lifecycle.ensureSession({ ownerId, sessionId, expiresAt }))
        .toMatchObject({ epoch, state: "active" });
    }
    const inspector = new Database(paths.factsMemoryControl, { readonly: true });
    expect(inspector.query("SELECT count(*) AS count FROM facts_memory_lifecycles").get())
      .toEqual({ count: 1 });
    inspector.close(false);
    expect(broker.createCalls).toBe(8);

    await lifecycle.cleanupSession({ ownerId, reason: "archive", sessionId });
    await expect(lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 2_000 }))
      .rejects.toThrow("FACTS_MEMORY_STORE_RETIRED");
  });

  test("seals an already expired purge as archive or abandon before reactivation", async () => {
    const { control, lifecycle } = await fixture();
    for (const [index, reason] of (["archive", "abandon"] as const).entries()) {
      const terminalSessionId = `sess_${String(index + 40).padStart(32, "0")}`;
      await lifecycle.ensureSession({ ownerId, sessionId: terminalSessionId, expiresAt: 100 });
      await lifecycle.sweepExpired(100);
      expect(control.get(terminalSessionId)).toMatchObject({
        cleanupReason: "expired",
        state: "purged",
      });
      await expect(lifecycle.cleanupSession({
        ownerId,
        reason,
        sessionId: terminalSessionId,
      })).resolves.toMatchObject({ state: "purged" });
      expect(control.get(terminalSessionId)).toMatchObject({ cleanupReason: reason, state: "purged" });
      await expect(lifecycle.ensureSession({
        ownerId,
        sessionId: terminalSessionId,
        expiresAt: 1_000,
      })).rejects.toThrow("FACTS_MEMORY_STORE_RETIRED");
    }
  });

  test("advances its bounded expiry cursor past sixteen poisoned cleanups", async () => {
    const { broker, control, lifecycle } = await fixture();
    const sessionIds = Array.from({ length: 17 }, (_, index) =>
      `sess_${String(index + 100).padStart(32, "0")}`);
    for (const candidate of sessionIds) {
      await lifecycle.ensureSession({ ownerId, sessionId: candidate, expiresAt: 100 });
    }
    for (const candidate of sessionIds.slice(0, 16)) broker.failPurgeSessions.add(candidate);
    expect(await lifecycle.sweepExpired(100)).toEqual({ attempted: 16, failed: 16, purged: 0 });
    expect(await lifecycle.sweepExpired(100)).toEqual({ attempted: 1, failed: 0, purged: 1 });
    expect(control.get(sessionIds[16] as string)?.state).toBe("purged");
  });

  test("fences a stale expiry page behind a queued renewal", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 100 });
    let entered!: () => void;
    const inspected = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    broker.inspectGate = new Promise<void>((resolve) => { release = resolve; });
    broker.inspectEntered = entered;
    const occupyingResume = lifecycle.resumeSession({ ownerId, sessionId });
    await inspected;
    const renewal = lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    const staleSweep = lifecycle.sweepExpired(100);
    release();
    await occupyingResume;
    await renewal;
    expect(await staleSweep).toEqual({ attempted: 1, failed: 0, purged: 0 });
    expect(control.get(sessionId)).toMatchObject({ expiresAt: 1_000, state: "active" });
    expect(broker.purgeCalls).toBe(0);
  });

  test("recovers a transient inspection failure but retains fail-closed tamper custody", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.failInspectOnce = true;
    await expect(lifecycle.resumeSession({ ownerId, sessionId }))
      .rejects.toThrow("transient inspect failure");
    expect(control.get(sessionId)?.state).toBe("recovery_required");
    await expect(lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 }))
      .resolves.toMatchObject({ state: "active" });

    broker.failInspectOnce = true;
    await expect(lifecycle.resumeSession({ ownerId, sessionId })).rejects.toThrow();
    const binding = control.get(sessionId)?.binding;
    if (binding === undefined) throw new Error("Expected memory binding.");
    const originalReceipt = broker.receipts.get(sessionId);
    if (originalReceipt === undefined) throw new Error("Expected memory receipt.");
    const forgedBase = {
      ...storeReceipt(binding),
      handleHash: "e".repeat(64),
    };
    broker.receipts.set(sessionId, {
      ...forgedBase,
      receiptDigest: digestFactsMemoryReceipt({
        version: forgedBase.version,
        bindingDigest: forgedBase.bindingDigest,
        createdAt: forgedBase.createdAt,
        handleHash: forgedBase.handleHash,
        head: forgedBase.head,
      }),
    });
    await expect(lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 }))
      .rejects.toThrow("FACTS_MEMORY_RECOVERY_REQUIRED");
    expect(control.get(sessionId)?.state).toBe("recovery_required");
    broker.receipts.set(sessionId, originalReceipt);
    await expect(lifecycle.cleanupSession({ ownerId, reason: "abandon", sessionId }))
      .resolves.toMatchObject({ state: "purged" });
  });
});
