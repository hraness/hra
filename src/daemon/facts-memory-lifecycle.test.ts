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
  OompaFactsMemoryLifecycle,
  type FactsMemoryAttestationLifecyclePort,
  type FactsMemoryBrokerInspection,
  type FactsMemoryBrokerPort,
} from "./facts-memory-lifecycle";

const ownerId = `acct_${"a".repeat(32)}`;
const anotherOwnerId = `acct_${"b".repeat(32)}`;
const thirdOwnerId = `acct_${"c".repeat(32)}`;
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

class FakeAttestations implements FactsMemoryAttestationLifecyclePort {
  readonly finalizations: Array<Readonly<{
    childBindingDigest: string;
    childHead: FactsMemoryHead;
    parentBindingDigest: string;
    parentHead: FactsMemoryHead;
  }>> = [];
  readonly reservations: Array<Readonly<{
    childBindingDigest: string;
    childSessionId: string;
    parentBindingDigest: string;
    parentHead: FactsMemoryHead;
  }>> = [];
  readonly purges: string[] = [];
  readonly pendingParents = new Set<string>();
  readonly pendingForks = new Map<string, Readonly<{
    childAuthorityDigest: string;
    childSessionId: string;
    parentAuthorityDigest: string;
    parentHead: Readonly<{
      headDigest: string;
      operationSha256: string | null;
      sequence: number;
    }>;
  }>>();
  readonly finalizedChildren = new Set<string>();
  failFinalizeOnce = false;
  failPurgeOnce = false;

  hasMemoryWorkingAttestationForkFromParent(parentBindingDigest: string): boolean {
    return this.pendingParents.has(parentBindingDigest);
  }

  listMemoryWorkingAttestationForks(
    limit: number,
    afterChildSessionId?: string,
  ): readonly Readonly<{
    childAuthorityDigest: string;
    childSessionId: string;
    parentAuthorityDigest: string;
    parentHead: Readonly<{
      headDigest: string;
      operationSha256: string | null;
      sequence: number;
    }>;
  }>[] {
    return [...this.pendingForks.values()]
      .filter((fork) => afterChildSessionId === undefined || fork.childSessionId > afterChildSessionId)
      .sort((left, right) => left.childSessionId.localeCompare(right.childSessionId))
      .slice(0, limit);
  }

  finalizeMemoryWorkingPageAttestationFork(input: Readonly<{
    childBindingDigest: string;
    childHead: FactsMemoryHead;
    parentBindingDigest: string;
    parentHead: FactsMemoryHead;
  }>): number {
    this.finalizations.push(input);
    if (this.failFinalizeOnce) {
      this.failFinalizeOnce = false;
      throw new Error("lost attestation clone response");
    }
    this.pendingParents.delete(input.parentBindingDigest);
    for (const [sessionId, fork] of this.pendingForks) {
      if (fork.childAuthorityDigest === input.childBindingDigest) this.pendingForks.delete(sessionId);
    }
    this.finalizedChildren.add(input.childBindingDigest);
    return 1;
  }

  reserveMemoryWorkingPageAttestationFork(input: Readonly<{
    childBindingDigest: string;
    childSessionId: string;
    parentBindingDigest: string;
    parentHead: FactsMemoryHead;
  }>): Readonly<{ references: number; state: "finalized" | "reserved" }> {
    this.reservations.push(input);
    if (this.finalizedChildren.has(input.childBindingDigest)) {
      return { references: 0, state: "finalized" };
    }
    this.pendingParents.add(input.parentBindingDigest);
    this.pendingForks.set(input.childSessionId, {
      childAuthorityDigest: input.childBindingDigest,
      childSessionId: input.childSessionId,
      parentAuthorityDigest: input.parentBindingDigest,
      parentHead: {
        headDigest: input.parentHead.digest,
        operationSha256: input.parentHead.operationSha256,
        sequence: input.parentHead.sequence,
      },
    });
    return { references: 1, state: "reserved" };
  }

  purgeMemoryWorkingPageAttestations(input: Readonly<{ bindingDigest: string }>): number {
    this.purges.push(input.bindingDigest);
    if (this.failPurgeOnce) {
      this.failPurgeOnce = false;
      throw new Error("lost attestation purge response");
    }
    this.finalizedChildren.delete(input.bindingDigest);
    for (const [sessionId, fork] of this.pendingForks) {
      if (fork.childAuthorityDigest === input.bindingDigest) {
        this.pendingParents.delete(fork.parentAuthorityDigest);
        this.pendingForks.delete(sessionId);
      }
    }
    return 1;
  }
}

const roots: string[] = [];
const controls: FactsMemoryControlStore[] = [];
afterEach(async () => {
  for (const control of controls.splice(0)) control.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-facts-memory-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const control = new FactsMemoryControlStore(paths.factsMemoryControl, { now: () => 50 });
  controls.push(control);
  const broker = new FakeBroker();
  return { broker, control, lifecycle: new OompaFactsMemoryLifecycle({ broker, control }), paths };
};

describe("Oompa facts-memory lifecycle", () => {
  test("refuses a control database containing any semantic table", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-facts-memory-schema-")));
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
    expect(migrated.schemaColumns()).toContain("owner_transfer_from_id");
    expect(migrated.schemaColumns()).toContain("owner_transfer_to_id");
    expect(migrated.schemaColumns()).toContain("owner_transfer_operation_key");
    const migratedInspector = new Database(paths.factsMemoryControl, { readonly: true });
    expect(migratedInspector.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    migratedInspector.close(false);
  });

  test("migrates v2 custody to v3 without changing its active authority", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-facts-memory-v2-")));
    roots.push(home);
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const binding = createFactsMemoryBinding({ ownerId, sessionId });
    const seed = new FactsMemoryControlStore(paths.factsMemoryControl, { now: () => 1 });
    const reserved = seed.reserve({
      binding,
      createOperationKey: `create:${sessionId}`,
      expiresAt: 1_000,
    });
    seed.finalizeActive(reserved.binding, storeReceipt(binding));
    seed.close();

    const database = new Database(paths.factsMemoryControl);
    database.exec(`
      DROP TRIGGER facts_memory_identity_immutable;
      DROP TRIGGER facts_memory_owner_transfer_provenance_guard;
      DROP INDEX facts_memory_expiry;
      ALTER TABLE facts_memory_lifecycles RENAME TO facts_memory_lifecycles_v3_seed;
      CREATE TABLE facts_memory_lifecycles AS SELECT
        session_id,epoch,owner_id,binding_digest,create_kind,create_operation_key,
        parent_session_id,parent_epoch,parent_owner_id,parent_binding_digest,parent_head_sequence,
        parent_head_operation_sha256,parent_head_digest,legacy_parent_head_sequence,
        legacy_parent_head_digest,state,handle_hash,head_sequence,head_operation_sha256,head_digest,
        legacy_head_sequence,legacy_head_digest,store_created_at,create_receipt_digest,expires_at,
        cleanup_reason,cleanup_operation_key,cleanup_receipt_digest,purged_at,prior_purge_chain_digest,
        revision,created_at,updated_at
      FROM facts_memory_lifecycles_v3_seed;
      DROP TABLE facts_memory_lifecycles_v3_seed;
      PRAGMA user_version=2;
    `);
    database.close(false);

    const migrated = new FactsMemoryControlStore(paths.factsMemoryControl, { now: () => 2 });
    controls.push(migrated);
    expect(migrated.get(sessionId)).toMatchObject({
      binding,
      ownerTransferFromId: null,
      ownerTransferOperationKey: null,
      ownerTransferToId: null,
      state: "active",
    });
    const inspector = new Database(paths.factsMemoryControl, { readonly: true });
    expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    inspector.close(false);
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

  test("purges source custody, advances one epoch, and exactly replays an owner transfer", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    const operationKey = "switch-attempt:exact-owner-transfer";
    const transferred = await lifecycle.transferSessionOwner({
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey,
      sessionId,
      toOwnerId: anotherOwnerId,
    });
    expect(transferred).toMatchObject({ epoch: 2, sessionId, state: "active" });
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 2, ownerId: anotherOwnerId },
      ownerTransferFromId: ownerId,
      ownerTransferOperationKey: operationKey,
      ownerTransferToId: anotherOwnerId,
      priorPurgeChainDigest: expect.any(String),
      state: "active",
    });
    expect(broker.createCalls).toBe(2);
    expect(broker.purgeCalls).toBe(1);

    expect(await lifecycle.transferSessionOwner({
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey,
      sessionId,
      toOwnerId: anotherOwnerId,
    })).toEqual(transferred);
    expect(broker.createCalls).toBe(2);
    expect(broker.purgeCalls).toBe(1);
    await expect(lifecycle.ensureSession({
      expiresAt: 3_000,
      ownerId: anotherOwnerId,
      sessionId,
    })).resolves.toMatchObject({ epoch: 2, state: "active" });
  });

  test("retains exact transfer authority across same-owner expiry reactivation", async () => {
    const { control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 100 });
    const input = {
      expiresAt: 100,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:survives-target-expiry",
      sessionId,
      toOwnerId: anotherOwnerId,
    } as const;
    await lifecycle.transferSessionOwner(input);
    expect(await lifecycle.sweepExpired(100)).toEqual({ attempted: 1, failed: 0, purged: 1 });
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 2, ownerId: anotherOwnerId },
      cleanupReason: "expired",
      ownerTransferOperationKey: input.operationKey,
      state: "purged",
    });
    await expect(lifecycle.transferSessionOwner({
      ...input,
      expiresAt: 200,
    })).resolves.toMatchObject({ epoch: 3, state: "active" });
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 3, ownerId: anotherOwnerId },
      ownerTransferFromId: ownerId,
      ownerTransferOperationKey: input.operationKey,
      ownerTransferToId: anotherOwnerId,
    });
    await expect(lifecycle.transferSessionOwner({
      ...input,
      expiresAt: 200,
    })).resolves.toMatchObject({ epoch: 3, state: "active" });
  });

  test("adopts an expired source purge into one exact owner transfer without resurrection", async () => {
    const { broker, control, lifecycle, paths } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 100 });
    expect(await lifecycle.sweepExpired(100)).toEqual({ attempted: 1, failed: 0, purged: 1 });
    expect(broker.receipts.has(sessionId)).toBe(false);
    const expired = control.get(sessionId);
    expect(expired).toMatchObject({
      binding: { epoch: 1, ownerId },
      cleanupReason: "expired",
      state: "purged",
    });

    const input = {
      expiresAt: 200,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:expired-source",
      sessionId,
      toOwnerId: anotherOwnerId,
    } as const;
    const inspector = new Database(paths.factsMemoryControl);
    expect(() => inspector.query(
      `UPDATE facts_memory_lifecycles SET cleanup_reason='provider_switch',cleanup_operation_key=?,
       owner_transfer_from_id=?,owner_transfer_to_id=?,owner_transfer_operation_key=?,
       cleanup_receipt_digest=?,purged_at=purged_at+1,prior_purge_chain_digest=?,
       handle_hash=?,head_digest=?,store_created_at=store_created_at+1,create_receipt_digest=?,
       expires_at=expires_at+1,created_at=created_at+1,revision=revision+1,updated_at=updated_at+1
       WHERE session_id=?`,
    ).run(
      input.operationKey,
      ownerId,
      anotherOwnerId,
      input.operationKey,
      "9".repeat(64),
      "8".repeat(64),
      "7".repeat(64),
      "6".repeat(64),
      "5".repeat(64),
      sessionId,
    )).toThrow("facts memory owner transfer provenance is immutable");
    inspector.close(false);
    expect(control.get(sessionId)).toEqual(expired);

    const advance = control.advanceOwnerTransfer.bind(control);
    let loseAdoptionResponse = true;
    control.advanceOwnerTransfer = (value) => {
      if (loseAdoptionResponse) {
        loseAdoptionResponse = false;
        throw new Error("crash after expired purge adoption");
      }
      return advance(value);
    };
    await expect(lifecycle.transferSessionOwner(input))
      .rejects.toThrow("crash after expired purge adoption");
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 1, ownerId },
      cleanupOperationKey: input.operationKey,
      cleanupReason: "provider_switch",
      ownerTransferFromId: ownerId,
      ownerTransferOperationKey: input.operationKey,
      ownerTransferToId: anotherOwnerId,
      state: "purged",
    });
    expect(broker.receipts.has(sessionId)).toBe(false);
    expect(broker.createCalls).toBe(1);
    expect(broker.purgeCalls).toBe(1);

    await expect(lifecycle.transferSessionOwner({
      ...input,
      operationKey: "switch-attempt:expired-source-changed",
    })).rejects.toThrow("FACTS_MEMORY_OWNER_TRANSFER_REPLAY_MISMATCH");
    await expect(lifecycle.transferSessionOwner({
      ...input,
      fromOwnerId: thirdOwnerId,
    })).rejects.toThrow("FACTS_MEMORY_AUTHORITY_MISMATCH");

    const transferred = await lifecycle.transferSessionOwner(input);
    expect(transferred).toMatchObject({
      epoch: 2,
      state: "active",
    });
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 2, ownerId: anotherOwnerId },
      ownerTransferOperationKey: input.operationKey,
      state: "active",
    });
    expect(broker.receipts.get(sessionId)?.bindingDigest).toBe(transferred.bindingDigest);
    expect(broker.createCalls).toBe(2);
    expect(broker.purgeCalls).toBe(1);
    await expect(lifecycle.transferSessionOwner(input)).resolves.toEqual(transferred);

    await lifecycle.cleanupSession({
      ownerId: anotherOwnerId,
      reason: "abandon",
      sessionId,
    });
    await expect(lifecycle.transferSessionOwner(input)).resolves.toMatchObject({
      state: "purged",
    });
    expect(broker.createCalls).toBe(2);
  });

  test("finishes a pending expired source purge before adopting switch custody", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 100 });
    broker.failPurgeOnce = true;
    expect(await lifecycle.sweepExpired(100)).toEqual({ attempted: 1, failed: 1, purged: 0 });
    expect(control.get(sessionId)).toMatchObject({
      binding: { ownerId },
      cleanupReason: "expired",
      state: "cleanup_pending",
    });

    await expect(lifecycle.transferSessionOwner({
      expiresAt: 200,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:pending-expired-source",
      sessionId,
      toOwnerId: anotherOwnerId,
    })).resolves.toMatchObject({
      epoch: 2,
      state: "active",
    });
    expect(control.get(sessionId)).toMatchObject({
      binding: { ownerId: anotherOwnerId },
      ownerTransferOperationKey: "switch-attempt:pending-expired-source",
    });
    expect(broker.purgeCalls).toBe(2);
  });

  test("replays exact target custody after terminal cleanup without resurrecting it", async () => {
    const { control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    const input = {
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:cleanup-before-state-commit",
      sessionId,
      toOwnerId: anotherOwnerId,
    } as const;
    await lifecycle.transferSessionOwner(input);
    await lifecycle.cleanupSession({
      ownerId: anotherOwnerId,
      reason: "abandon",
      sessionId,
    });
    await expect(lifecycle.transferSessionOwner(input)).resolves.toMatchObject({
      epoch: 2,
      state: "purged",
    });
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 2, ownerId: anotherOwnerId },
      cleanupReason: "abandon",
      ownerTransferOperationKey: input.operationKey,
      state: "purged",
    });
    await expect(lifecycle.cleanupSession({
      ownerId: anotherOwnerId,
      reason: "abandon",
      sessionId,
    })).resolves.toMatchObject({ state: "purged" });

    await lifecycle.ensureSession({
      expiresAt: 1_000,
      ownerId: anotherOwnerId,
      sessionId: childSessionId,
    });
    await lifecycle.cleanupSession({
      ownerId: anotherOwnerId,
      reason: "archive",
      sessionId: childSessionId,
    });
    await expect(lifecycle.transferSessionOwner({
      ...input,
      operationKey: "switch-attempt:unrelated-archived-target",
      sessionId: childSessionId,
    })).rejects.toThrow("FACTS_MEMORY_OWNER_TRANSFER_REPLAY_MISMATCH");
  });

  test("recovers exact owner transfer after a lost purge response", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.failPurgeOnce = true;
    const input = {
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:lost-purge-response",
      sessionId,
      toOwnerId: anotherOwnerId,
    } as const;
    await expect(lifecycle.transferSessionOwner(input)).rejects.toThrow("lost purge response");
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 1, ownerId },
      cleanupReason: "provider_switch",
      state: "cleanup_pending",
    });
    await expect(lifecycle.transferSessionOwner(input)).resolves.toMatchObject({
      epoch: 2,
      state: "active",
    });
    expect(broker.purgeCalls).toBe(2);
  });

  test("recovers after durable purge before owner rollover", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    const finalize = control.finalizePurged.bind(control);
    let loseResponse = true;
    control.finalizePurged = (binding, receipt) => {
      const result = finalize(binding, receipt);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("crash after durable purge");
      }
      return result;
    };
    const input = {
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:purged-before-rollover",
      sessionId,
      toOwnerId: anotherOwnerId,
    } as const;
    await expect(lifecycle.transferSessionOwner(input)).rejects.toThrow("crash after durable purge");
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 1, ownerId },
      cleanupReason: "provider_switch",
      state: "purged",
    });
    const targetBinding = createFactsMemoryBinding({
      epoch: 2,
      ownerId: anotherOwnerId,
      sessionId,
    });
    expect(() => control.advanceOwnerTransfer({
      createOperationKey: input.operationKey,
      expiresAt: input.expiresAt,
      fromBinding: createFactsMemoryBinding({ ownerId, sessionId }),
      operationKey: input.operationKey,
      toBinding: targetBinding,
    })).toThrow("FACTS_MEMORY_OPERATION_KEY_REUSED");
    await expect(lifecycle.transferSessionOwner(input)).resolves.toMatchObject({
      epoch: 2,
      state: "active",
    });
    expect(broker.purgeCalls).toBe(1);
  });

  test("recovers an owner rollover that committed before its response was lost", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    const advance = control.advanceOwnerTransfer.bind(control);
    let loseResponse = true;
    control.advanceOwnerTransfer = (input) => {
      const result = advance(input);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("lost owner rollover response");
      }
      return result;
    };
    const input = {
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:lost-rollover-response",
      sessionId,
      toOwnerId: anotherOwnerId,
    } as const;
    await expect(lifecycle.transferSessionOwner(input)).rejects.toThrow("lost owner rollover response");
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 2, ownerId: anotherOwnerId },
      state: "reserved",
    });
    await expect(lifecycle.transferSessionOwner(input)).resolves.toMatchObject({
      epoch: 2,
      state: "active",
    });
    expect(broker.createCalls).toBe(2);
    expect(broker.purgeCalls).toBe(1);
  });

  test("recovers a target create ambiguity without restoring source custody", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    broker.failCreateAfterCommit = true;
    const input = {
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:target-create-ambiguous",
      sessionId,
      toOwnerId: anotherOwnerId,
    } as const;
    await expect(lifecycle.transferSessionOwner(input)).rejects.toThrow("lost create response");
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 2, ownerId: anotherOwnerId },
      state: "create_ambiguous",
    });
    await expect(lifecycle.transferSessionOwner(input)).resolves.toMatchObject({
      epoch: 2,
      state: "active",
    });
    expect(broker.createCalls).toBe(2);
    expect(broker.purgeCalls).toBe(1);
  });

  test("creates fresh target custody when no control row exists and replays only its exact authority", async () => {
    const { broker, control, lifecycle } = await fixture();
    const aliasedSessionId = `sess_${"7".repeat(32)}`;
    await expect(lifecycle.transferSessionOwner({
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: `create:${aliasedSessionId}`,
      sessionId: aliasedSessionId,
      toOwnerId: anotherOwnerId,
    })).rejects.toThrow("FACTS_MEMORY_OPERATION_KEY_REUSED");
    expect(control.get(aliasedSessionId)).toBeNull();
    const input = {
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:no-source-row",
      sessionId,
      toOwnerId: anotherOwnerId,
    } as const;
    await expect(lifecycle.transferSessionOwner(input)).resolves.toMatchObject({
      epoch: 1,
      state: "active",
    });
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 1, ownerId: anotherOwnerId },
      ownerTransferFromId: ownerId,
      ownerTransferOperationKey: input.operationKey,
      ownerTransferToId: anotherOwnerId,
    });
    expect(broker.purgeCalls).toBe(0);
    expect(broker.createCalls).toBe(1);
    await expect(lifecycle.transferSessionOwner(input)).resolves.toMatchObject({ epoch: 1 });
    await expect(lifecycle.transferSessionOwner({
      ...input,
      operationKey: "switch-attempt:no-source-row-forged",
    })).rejects.toThrow("FACTS_MEMORY_OWNER_TRANSFER_REPLAY_MISMATCH");
    await expect(lifecycle.transferSessionOwner({
      ...input,
      fromOwnerId: thirdOwnerId,
    })).rejects.toThrow("FACTS_MEMORY_OWNER_TRANSFER_REPLAY_MISMATCH");
  });

  test("treats same-owner transfer as an idempotent ensure", async () => {
    const { broker, control, lifecycle } = await fixture();
    const first = await lifecycle.transferSessionOwner({
      expiresAt: 1_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:same-owner",
      sessionId,
      toOwnerId: ownerId,
    });
    const replay = await lifecycle.transferSessionOwner({
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:same-owner-replay",
      sessionId,
      toOwnerId: ownerId,
    });
    expect(replay).toMatchObject({ epoch: first.epoch, state: "active" });
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 1, ownerId },
      expiresAt: 2_000,
      ownerTransferOperationKey: null,
    });
    expect(broker.createCalls).toBe(1);
    expect(broker.purgeCalls).toBe(0);
  });

  test("refuses wrong transfer authority, changed requests, and terminal cleanup", async () => {
    const { broker, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    await expect(lifecycle.transferSessionOwner({
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: `create:${sessionId}`,
      sessionId,
      toOwnerId: anotherOwnerId,
    })).rejects.toThrow("FACTS_MEMORY_OPERATION_KEY_REUSED");
    await expect(lifecycle.transferSessionOwner({
      expiresAt: 2_000,
      fromOwnerId: thirdOwnerId,
      operationKey: "switch-attempt:wrong-source",
      sessionId,
      toOwnerId: anotherOwnerId,
    })).rejects.toThrow("FACTS_MEMORY_AUTHORITY_MISMATCH");

    broker.failPurgeOnce = true;
    const exact = {
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:frozen-request",
      sessionId,
      toOwnerId: anotherOwnerId,
    } as const;
    await expect(lifecycle.transferSessionOwner(exact)).rejects.toThrow("lost purge response");
    await expect(lifecycle.transferSessionOwner({
      ...exact,
      operationKey: "switch-attempt:changed-key",
    })).rejects.toThrow("FACTS_MEMORY_OWNER_TRANSFER_REPLAY_MISMATCH");
    await expect(lifecycle.transferSessionOwner({
      ...exact,
      toOwnerId: thirdOwnerId,
    })).rejects.toThrow("FACTS_MEMORY_OWNER_TRANSFER_REPLAY_MISMATCH");
    await lifecycle.transferSessionOwner(exact);

    const terminalSessionId = `sess_${"8".repeat(32)}`;
    await lifecycle.ensureSession({ ownerId, sessionId: terminalSessionId, expiresAt: 1_000 });
    await lifecycle.cleanupSession({ ownerId, reason: "archive", sessionId: terminalSessionId });
    await expect(lifecycle.transferSessionOwner({
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey: "switch-attempt:terminal-source",
      sessionId: terminalSessionId,
      toOwnerId: anotherOwnerId,
    })).rejects.toThrow("FACTS_MEMORY_STORE_RETIRED");
  });

  test("database triggers reject direct owner and transfer-provenance tampering", async () => {
    const { control, lifecycle, paths } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    const target = createFactsMemoryBinding({
      epoch: 2,
      ownerId: anotherOwnerId,
      sessionId,
    });
    const inspector = new Database(paths.factsMemoryControl);
    expect(() => inspector.query(
      "UPDATE facts_memory_lifecycles SET epoch=2,owner_id=?,binding_digest=? WHERE session_id=?",
    ).run(anotherOwnerId, target.bindingDigest, sessionId)).toThrow("facts memory identity is immutable");
    expect(() => inspector.query(
      `UPDATE facts_memory_lifecycles SET owner_transfer_from_id=?,owner_transfer_to_id=?,
       owner_transfer_operation_key=? WHERE session_id=?`,
    ).run(
      ownerId,
      anotherOwnerId,
      "switch-attempt:forged-provenance",
      sessionId,
    )).toThrow("facts memory owner transfer provenance is immutable");
    const operationKey = "switch-attempt:guarded-normal-transfer";
    expect(() => inspector.query(
      `UPDATE facts_memory_lifecycles SET state='cleanup_pending',cleanup_reason='provider_switch',
       cleanup_operation_key=?,owner_transfer_from_id=?,owner_transfer_to_id=?,
       owner_transfer_operation_key=?,expires_at=expires_at+1,revision=revision+1,
       updated_at=updated_at+1 WHERE session_id=?`,
    ).run(
      operationKey,
      ownerId,
      anotherOwnerId,
      operationKey,
      sessionId,
    )).toThrow("facts memory owner transfer provenance is immutable");
    inspector.close(false);
    expect(control.get(sessionId)).toMatchObject({
      binding: { epoch: 1, ownerId },
      expiresAt: 1_000,
      state: "active",
    });
    await expect(lifecycle.transferSessionOwner({
      expiresAt: 2_000,
      fromOwnerId: ownerId,
      operationKey,
      sessionId,
      toOwnerId: anotherOwnerId,
    })).resolves.toMatchObject({ epoch: 2, state: "active" });
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

  test("reconciles durable attestation clone and post-purge cleanup independently of Oh effects", async () => {
    const { broker, control } = await fixture();
    const attestations = new FakeAttestations();
    const lifecycle = new OompaFactsMemoryLifecycle({ attestations, broker, control });
    const parent = await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    attestations.failFinalizeOnce = true;
    await expect(lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    })).rejects.toThrow("lost attestation clone response");
    const childControl = control.get(childSessionId);
    expect(childControl).toMatchObject({ state: "recovery_required" });
    const child = await lifecycle.ensureSession({
      expiresAt: 2_000,
      ownerId,
      sessionId: childSessionId,
    });
    if (child.head === null || parent.head === null) {
      throw new Error("Expected active attestation checkpoints.");
    }
    expect(attestations.finalizations).toEqual([
      {
        childBindingDigest: child.bindingDigest,
        childHead: child.head,
        parentBindingDigest: parent.bindingDigest,
        parentHead: parent.head,
      },
      {
        childBindingDigest: child.bindingDigest,
        childHead: child.head,
        parentBindingDigest: parent.bindingDigest,
        parentHead: parent.head,
      },
    ]);

    attestations.purges.length = 0;
    attestations.failPurgeOnce = true;
    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId: childSessionId,
    })).rejects.toThrow("lost attestation purge response");
    expect(control.get(childSessionId)).toMatchObject({ state: "purged" });
    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId: childSessionId,
    })).resolves.toMatchObject({ state: "purged" });
    expect(attestations.purges).toEqual([child.bindingDigest, child.bindingDigest]);
  });

  test("resume finalizes a lost child attestation fork before releasing its parent", async () => {
    const { broker, control } = await fixture();
    const attestations = new FakeAttestations();
    const lifecycle = new OompaFactsMemoryLifecycle({ attestations, broker, control });
    const parent = await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    attestations.failFinalizeOnce = true;
    await expect(lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    })).rejects.toThrow("lost attestation clone response");
    expect(control.get(childSessionId)).toMatchObject({ state: "recovery_required" });
    expect(attestations.pendingParents.has(parent.bindingDigest)).toBe(true);

    const child = await lifecycle.resumeSession({ ownerId, sessionId: childSessionId });
    expect(child).toMatchObject({ ownerId, sessionId: childSessionId, state: "active" });
    expect(broker.forkCalls).toBe(1);
    expect(attestations.finalizations).toHaveLength(2);
    expect(attestations.pendingParents.has(parent.bindingDigest)).toBe(false);
    expect(attestations.pendingForks.has(childSessionId)).toBe(false);

    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId,
    })).resolves.toMatchObject({ state: "purged" });
    expect(control.get(childSessionId)).toMatchObject({ state: "active" });
    expect(broker.receipts.has(childSessionId)).toBe(true);
  });

  test("resume finalizes a crash-left attestation reservation for an active child", async () => {
    const { broker, control } = await fixture();
    const attestations = new FakeAttestations();
    const lifecycle = new OompaFactsMemoryLifecycle({ attestations, broker, control });
    const parent = await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    const child = await lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId,
      ownerId,
      parentSessionId: sessionId,
    });
    if (parent.head === null || child.head === null) {
      throw new Error("Expected active fork checkpoints.");
    }
    attestations.finalizedChildren.delete(child.bindingDigest);
    attestations.reserveMemoryWorkingPageAttestationFork({
      childBindingDigest: child.bindingDigest,
      childSessionId,
      parentBindingDigest: parent.bindingDigest,
      parentHead: parent.head,
    });
    expect(control.get(childSessionId)).toMatchObject({ state: "active" });
    expect(attestations.pendingParents.has(parent.bindingDigest)).toBe(true);

    await expect(lifecycle.resumeSession({ ownerId, sessionId: childSessionId }))
      .resolves.toMatchObject({ state: "active" });
    expect(attestations.pendingParents.has(parent.bindingDigest)).toBe(false);
    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId,
    })).resolves.toMatchObject({ state: "purged" });
    expect(control.get(childSessionId)).toMatchObject({ state: "active" });
  });

  test("treats a pre-control attestation fork reservation as a parent cleanup fence", async () => {
    const { broker, control } = await fixture();
    const attestations = new FakeAttestations();
    const lifecycle = new OompaFactsMemoryLifecycle({ attestations, broker, control });
    const parent = await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    attestations.pendingParents.add(parent.bindingDigest);

    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId,
    })).rejects.toThrow("FACTS_MEMORY_PARENT_REFERENCED");
    expect(control.get(sessionId)).toMatchObject({ state: "active" });
    expect(broker.purgeCalls).toBe(0);

    attestations.pendingParents.delete(parent.bindingDigest);
    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId,
    })).resolves.toMatchObject({ state: "purged" });
  });

  test("sweeps a crash-left pre-control fork reservation before releasing its parent", async () => {
    const { broker, control } = await fixture();
    const attestations = new FakeAttestations();
    const lifecycle = new OompaFactsMemoryLifecycle({ attestations, broker, control });
    const parent = await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 1_000 });
    if (parent.head === null) throw new Error("Expected an active parent checkpoint.");
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    attestations.reserveMemoryWorkingPageAttestationFork({
      childBindingDigest: child.bindingDigest,
      childSessionId,
      parentBindingDigest: parent.bindingDigest,
      parentHead: parent.head,
    });

    expect(await lifecycle.sweepExpired(50)).toEqual({ attempted: 1, failed: 0, purged: 0 });
    expect(attestations.pendingForks.size).toBe(0);
    expect(attestations.pendingParents.has(parent.bindingDigest)).toBe(false);
    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId,
    })).resolves.toMatchObject({ state: "purged" });
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

  test("retains an expired session when the caller's recovery policy refuses cleanup", async () => {
    const { broker, control, lifecycle } = await fixture();
    await lifecycle.ensureSession({ ownerId, sessionId, expiresAt: 100 });
    const retained: string[] = [];
    expect(await lifecycle.sweepExpired(100, {
      canCleanupSession: (candidate) => {
        retained.push(candidate);
        return false;
      },
    })).toEqual({ attempted: 1, failed: 0, purged: 0 });
    expect(retained).toEqual([sessionId]);
    expect(control.get(sessionId)?.state).toBe("active");
    expect(broker.purgeCalls).toBe(0);

    expect(await lifecycle.sweepExpired(100, {
      canCleanupSession: () => true,
    })).toEqual({ attempted: 1, failed: 0, purged: 1 });
    expect(control.get(sessionId)?.state).toBe("purged");
    expect(broker.purgeCalls).toBe(1);
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
