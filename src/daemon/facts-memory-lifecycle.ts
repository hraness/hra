import { z } from "zod";

import {
  createFactsMemoryBinding,
  digestFactsMemoryInspection,
  digestFactsMemoryPurgeReceipt,
  digestFactsMemoryReceipt,
  factsMemoryPurgeReceiptSchema,
  factsMemoryStoreInspectionSchema,
  factsMemoryStoreReceiptSchema,
  type FactsMemoryBinding,
  type FactsMemoryCheckpoint,
  type FactsMemoryPurgeReceipt,
  type FactsMemoryStoreReceipt,
  type FactsMemoryStoreInspection,
} from "../domain/facts-memory";
import { unixMillisecondsSchema } from "../domain/values";
import {
  factsMemoryCleanupReasonSchema,
  type FactsMemoryCleanupReason,
  type FactsMemoryControlRecord,
  type FactsMemoryControlStore,
} from "../storage/facts-memory-control";

export const factsMemoryBrokerInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing") }).strict(),
  z.object({
    inspection: factsMemoryStoreInspectionSchema,
    status: z.literal("present"),
  }).strict(),
]);

export type FactsMemoryBrokerInspection = z.infer<typeof factsMemoryBrokerInspectionSchema>;

/**
 * Host-only semantic-store boundary. Implementations may use Oh, but HRA never
 * receives facts, rules, projections, credentials, database paths, or raw handles.
 */
export interface FactsMemoryBrokerPort {
  create(input: Readonly<{
    binding: FactsMemoryBinding;
    operationKey: string;
  }>): Promise<FactsMemoryStoreReceipt>;
  fork(input: Readonly<{
    binding: FactsMemoryBinding;
    operationKey: string;
    parent: FactsMemoryCheckpoint;
  }>): Promise<FactsMemoryStoreReceipt>;
  inspect(binding: FactsMemoryBinding): Promise<FactsMemoryBrokerInspection>;
  purge(input: Readonly<{
    binding: FactsMemoryBinding;
    expectedHandleHash: string | null;
    operationKey: string;
  }>): Promise<FactsMemoryPurgeReceipt>;
}

export type HraFactsMemoryLifecycleReceipt = Readonly<{
  bindingDigest: string;
  handleHash: string | null;
  head: FactsMemoryControlRecord["head"];
  sessionId: string;
  state: FactsMemoryControlRecord["state"];
}>;

export interface HraFactsMemoryLifecyclePort {
  cleanupSession(input: Readonly<{
    ownerId: string;
    reason: FactsMemoryCleanupReason;
    sessionId: string;
  }>): Promise<HraFactsMemoryLifecycleReceipt | null>;
  ensureSession(input: Readonly<{
    expiresAt: number;
    ownerId: string;
    sessionId: string;
  }>): Promise<HraFactsMemoryLifecycleReceipt>;
  forkSession(input: Readonly<{
    childExpiresAt: number;
    childSessionId: string;
    ownerId: string;
    parentSessionId: string;
  }>): Promise<HraFactsMemoryLifecycleReceipt>;
  resumeSession(input: Readonly<{
    ownerId: string;
    sessionId: string;
  }>): Promise<HraFactsMemoryLifecycleReceipt>;
  sweepExpired(now: number): Promise<Readonly<{ attempted: number; failed: number; purged: number }>>;
}

const lifecycleReceipt = (record: FactsMemoryControlRecord): HraFactsMemoryLifecycleReceipt => ({
  bindingDigest: record.binding.bindingDigest,
  handleHash: record.handleHash,
  head: record.head,
  sessionId: record.binding.sessionId,
  state: record.state,
});

const assertInitialReceipt = (
  binding: FactsMemoryBinding,
  value: FactsMemoryStoreReceipt,
): FactsMemoryStoreReceipt => {
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
};

const assertInspection = (
  binding: FactsMemoryBinding,
  value: FactsMemoryStoreInspection,
): FactsMemoryStoreInspection => {
  const inspection = factsMemoryStoreInspectionSchema.parse(value);
  const { inspectionDigest, ...inspectionBody } = inspection;
  const initial = {
    version: inspection.version,
    bindingDigest: inspection.bindingDigest,
    createdAt: inspection.createdAt,
    handleHash: inspection.handleHash,
    head: inspection.initialHead,
  };
  if (
    inspection.bindingDigest !== binding.bindingDigest
    || digestFactsMemoryReceipt(initial) !== inspection.receiptDigest
    || digestFactsMemoryInspection(inspectionBody) !== inspectionDigest
  ) throw new Error("FACTS_MEMORY_BROKER_INSPECTION_INVALID");
  return inspection;
};

const assertPurgeReceipt = (
  binding: FactsMemoryBinding,
  value: FactsMemoryPurgeReceipt,
): FactsMemoryPurgeReceipt => {
  const receipt = factsMemoryPurgeReceiptSchema.parse(value);
  if (
    receipt.bindingDigest !== binding.bindingDigest
    || digestFactsMemoryPurgeReceipt({
      version: receipt.version,
      bindingDigest: receipt.bindingDigest,
      handleHash: receipt.handleHash,
      purgedAt: receipt.purgedAt,
    }) !== receipt.purgeDigest
  ) throw new Error("FACTS_MEMORY_BROKER_PURGE_RECEIPT_INVALID");
  return receipt;
};

export class HraFactsMemoryLifecycle implements HraFactsMemoryLifecyclePort {
  readonly #broker: FactsMemoryBrokerPort;
  readonly #control: FactsMemoryControlStore;
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(input: Readonly<{
    broker: FactsMemoryBrokerPort;
    control: FactsMemoryControlStore;
  }>) {
    this.#broker = input.broker;
    this.#control = input.control;
  }

  ensureSession(input: Readonly<{
    expiresAt: number;
    ownerId: string;
    sessionId: string;
  }>): Promise<HraFactsMemoryLifecycleReceipt> {
    const binding = createFactsMemoryBinding(input);
    return this.#serialize(binding.sessionId, async () => {
      const record = this.#control.reserve({
        binding,
        createOperationKey: `create:${binding.sessionId}`,
        expiresAt: input.expiresAt,
      });
      return lifecycleReceipt(await this.#ensureReserved(record));
    });
  }

  async forkSession(input: Readonly<{
    childExpiresAt: number;
    childSessionId: string;
    ownerId: string;
    parentSessionId: string;
  }>): Promise<HraFactsMemoryLifecycleReceipt> {
    const childExpiresAt = unixMillisecondsSchema.parse(input.childExpiresAt);
    const child = createFactsMemoryBinding({ ownerId: input.ownerId, sessionId: input.childSessionId });
    const parentBinding = createFactsMemoryBinding({
      ownerId: input.ownerId,
      sessionId: input.parentSessionId,
    });
    if (child.sessionId === parentBinding.sessionId) throw new Error("FACTS_MEMORY_SELF_FORK");
    if (this.#control.get(child.sessionId) !== null) {
      return await this.#serialize(child.sessionId, async () => {
        const existing = this.#control.requireExact(child);
        this.#assertForkReservation(existing, parentBinding);
        return lifecycleReceipt(await this.#ensureReserved(existing));
      });
    }

    // Observe the parent before taking the child lock. This prevents opposite
    // fork attempts from deadlocking on child-then-parent locks. The broker
    // still re-proves this exact checkpoint immediately before copying.
    const parentRecord = await this.resumeSession({
      ownerId: input.ownerId,
      sessionId: input.parentSessionId,
    });
    if (parentRecord.state !== "active" || parentRecord.head === null) {
      throw new Error("FACTS_MEMORY_PARENT_NOT_ACTIVE");
    }
    const checkpoint: FactsMemoryCheckpoint = {
      ...parentBinding,
      head: parentRecord.head,
    };
    return await this.#serialize(child.sessionId, async () => {
      const raced = this.#control.get(child.sessionId);
      if (raced !== null) {
        const existing = this.#control.requireExact(child);
        this.#assertForkReservation(existing, parentBinding);
        return lifecycleReceipt(await this.#ensureReserved(existing));
      }
      const reserved = this.#control.reserve({
        binding: child,
        createOperationKey: `fork:${child.sessionId}`,
        expiresAt: childExpiresAt,
        parent: checkpoint,
      });
      return lifecycleReceipt(await this.#ensureReserved(reserved));
    });
  }

  resumeSession(input: Readonly<{
    ownerId: string;
    sessionId: string;
  }>): Promise<HraFactsMemoryLifecycleReceipt> {
    const binding = createFactsMemoryBinding(input);
    return this.#serialize(binding.sessionId, async () => {
      const record = this.#control.requireExact(binding);
      if (record.state !== "active") return lifecycleReceipt(await this.#ensureReserved(record));
      try {
        const inspection = await this.#inspect(binding);
        if (inspection.status === "missing") throw new Error("FACTS_MEMORY_ACTIVE_STORE_MISSING");
        return lifecycleReceipt(this.#control.refreshHead(
          binding,
          assertInspection(binding, inspection.inspection),
        ));
      } catch (error: unknown) {
        this.#markRecoveryRequired(binding);
        throw error;
      }
    });
  }

  cleanupSession(input: Readonly<{
    ownerId: string;
    reason: FactsMemoryCleanupReason;
    sessionId: string;
  }>): Promise<HraFactsMemoryLifecycleReceipt | null> {
    const binding = createFactsMemoryBinding(input);
    const requestedReason = factsMemoryCleanupReasonSchema.parse(input.reason);
    return this.#serialize(binding.sessionId, async () => {
      if (this.#control.get(binding.sessionId) === null) return null;
      const existing = this.#control.requireExact(binding);
      const reason = existing.cleanupReason ?? requestedReason;
      const operationKey = existing.cleanupOperationKey
        ?? `cleanup:${binding.sessionId}:${reason}`;
      const pending = this.#control.beginCleanup({
        binding,
        operationKey,
        reason,
      });
      if (pending.state === "purged") return lifecycleReceipt(pending);
      const purge = assertPurgeReceipt(binding, await this.#broker.purge({
        binding,
        expectedHandleHash: pending.handleHash,
        operationKey: pending.cleanupOperationKey ?? operationKey,
      }));
      return lifecycleReceipt(this.#control.finalizePurged(binding, purge));
    });
  }

  async sweepExpired(now: number): Promise<Readonly<{ attempted: number; failed: number; purged: number }>> {
    const records = this.#control.listExpired(now);
    let failed = 0;
    let purged = 0;
    for (const record of records) {
      try {
        const result = await this.cleanupSession({
          ownerId: record.binding.ownerId,
          reason: record.cleanupReason ?? "expired",
          sessionId: record.binding.sessionId,
        });
        if (result?.state === "purged") purged += 1;
      } catch {
        failed += 1;
      }
    }
    return { attempted: records.length, failed, purged };
  }

  async #ensureReserved(record: FactsMemoryControlRecord): Promise<FactsMemoryControlRecord> {
    const binding = record.binding;
    if (record.state === "active") {
      try {
        const inspection = await this.#inspect(binding);
        if (inspection.status === "missing") throw new Error("FACTS_MEMORY_ACTIVE_STORE_MISSING");
        return this.#control.refreshHead(binding, assertInspection(binding, inspection.inspection));
      } catch (error: unknown) {
        this.#markRecoveryRequired(binding);
        throw error;
      }
    }
    if (record.state === "cleanup_pending" || record.state === "purged") {
      throw new Error("FACTS_MEMORY_STORE_RETIRED");
    }
    if (record.state === "recovery_required") throw new Error("FACTS_MEMORY_RECOVERY_REQUIRED");
    if (record.state === "creating" || record.state === "create_ambiguous") {
      let inspection: FactsMemoryBrokerInspection;
      try {
        inspection = await this.#inspect(binding);
      } catch (error: unknown) {
        this.#markRecoveryRequired(binding);
        throw error;
      }
      if (inspection.status === "present") {
        let inspected: FactsMemoryStoreInspection;
        let initial: FactsMemoryStoreReceipt;
        try {
          inspected = assertInspection(binding, inspection.inspection);
          initial = assertInitialReceipt(binding, {
            version: inspected.version,
            bindingDigest: inspected.bindingDigest,
            createdAt: inspected.createdAt,
            handleHash: inspected.handleHash,
            head: inspected.initialHead,
            receiptDigest: inspected.receiptDigest,
          });
        } catch (error: unknown) {
          this.#markRecoveryRequired(binding);
          throw error;
        }
        const active = this.#finalizeActive(binding, initial);
        try {
          return this.#control.refreshHead(active.binding, inspected);
        } catch (error: unknown) {
          this.#markRecoveryRequired(binding);
          throw error;
        }
      }
    }
    this.#control.markCreating(binding);
    let receiptValue: FactsMemoryStoreReceipt;
    try {
      receiptValue = record.parent === null
        ? await this.#broker.create({ binding, operationKey: record.createOperationKey })
        : await this.#broker.fork({
            binding,
            operationKey: record.createOperationKey,
            parent: record.parent,
          });
    } catch (error: unknown) {
      try {
        this.#control.markCreateAmbiguous(binding);
      } catch {
        // Preserve the first broker/receipt failure; reconciliation reads the
        // exact durable state on the next host-owned call.
      }
      throw error;
    }
    let receipt: FactsMemoryStoreReceipt;
    try {
      receipt = assertInitialReceipt(binding, receiptValue);
    } catch (error: unknown) {
      this.#markRecoveryRequired(binding);
      throw error;
    }
    return this.#finalizeActive(binding, receipt);
  }

  #finalizeActive(
    binding: FactsMemoryBinding,
    receipt: FactsMemoryStoreReceipt,
  ): FactsMemoryControlRecord {
    try {
      return this.#control.finalizeActive(binding, receipt);
    } catch (error: unknown) {
      try {
        const observed = this.#control.requireExact(binding);
        if (
          observed.state === "active"
          && observed.handleHash === receipt.handleHash
          && observed.storeCreatedAt === receipt.createdAt
          && observed.createReceiptDigest === receipt.receiptDigest
        ) return observed;
        if (observed.state === "active") this.#markRecoveryRequired(binding);
        if (observed.state === "creating") this.#control.markCreateAmbiguous(binding);
      } catch {
        // Preserve the original finalization failure. A durable creating or
        // ambiguous record is inspected before any later broker replay.
      }
      throw error;
    }
  }

  #markRecoveryRequired(binding: FactsMemoryBinding): void {
    try {
      this.#control.markRecoveryRequired(binding);
    } catch {
      // The initiating invariant failure remains the diagnostic. A later exact
      // read will still refuse any incoherent lifecycle state.
    }
  }

  #assertForkReservation(
    record: FactsMemoryControlRecord,
    parent: FactsMemoryBinding,
  ): void {
    if (
      record.createKind !== "fork"
      || record.createOperationKey !== `fork:${record.binding.sessionId}`
      || record.parent === null
      || record.parent.bindingDigest !== parent.bindingDigest
      || record.parent.ownerId !== parent.ownerId
      || record.parent.sessionId !== parent.sessionId
    ) throw new Error("FACTS_MEMORY_FORK_RESERVATION_MISMATCH");
  }

  async #inspect(binding: FactsMemoryBinding): Promise<FactsMemoryBrokerInspection> {
    return factsMemoryBrokerInspectionSchema.parse(await this.#broker.inspect(binding));
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
