import { describe, expect, jest, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest, type TestConvex } from "convex-test";

import {
  attentionNotificationFaultCapacityReservations,
  attentionNotificationFaultSlotsPerDelivery,
  deleteAttentionNotificationSafetyFaultsForAccount,
  deleteExpiredAttentionNotificationSafetyFaults,
  readOldestLatchedAttentionNotificationSafetyFault,
  reserveAttentionNotificationFaultCapacity,
} from "./attentionNotificationControl";
import { ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS } from "./lifecyclePolicy";
import { logicalDocumentBytes } from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;

const genesis = makeFunctionReference<"mutation", Args, unknown>("quota:genesisHardAuthority");
const status = makeFunctionReference<"query", Args, Readonly<{
  enabled: boolean;
  generation: number;
  safetyFault: null | Readonly<{
    deliveryId: string;
    faultId: string;
    observedAt: number;
    reason: "invalid_idempotent_request" | "stored_delivery_corrupt";
    resultDigest: string;
    reviewedAt?: number;
    reviewMutationId?: string;
    state: "latched" | "reviewed";
  }>;
  updatedAt: number;
}>>("attentionNotificationControl:status");
const inactiveDeploymentStatus = makeFunctionReference<"query", Args, Readonly<{
  generation: number;
  globalState: "absent" | "disabled" | "enabled";
  outboxOccupancy: 0 | 1;
  safetyFaultOccupancy: 0 | 1;
}>>("attentionNotificationControl:inactiveDeploymentStatus");
const transition = makeFunctionReference<"mutation", Args, unknown>(
  "attentionNotificationControl:transition",
);
const latchSafetyFault = makeFunctionReference<"mutation", Args, Readonly<{
  changed: boolean;
  enabled: boolean;
  generation: number;
  replay: boolean;
  safetyFault: null | Readonly<{ faultId: string }>;
}>>("attentionNotificationControl:latchSafetyFault");
const acknowledgeSafetyFault = makeFunctionReference<"mutation", Args, unknown>(
  "attentionNotificationControl:acknowledgeSafetyFault",
);

const enableOne = "01912345-6789-7abc-8def-0123456789b1";
const enableThree = "01912345-6789-7abc-8def-0123456789b3";
const enableFive = "01912345-6789-7abc-8def-0123456789b5";
const faultDelivery = "01912345-6789-7abc-8def-0123456789b4";
const firstReview = "01912345-6789-7abc-8def-0123456789c1";
const secondReview = "01912345-6789-7abc-8def-0123456789c2";
const firstDigest = "d".repeat(64);
const secondDigest = "e".repeat(64);

async function seedCapacity(
  runtime: TestConvex<typeof schema>,
  deliveryId = faultDelivery,
) {
  return await runtime.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const deviceId = await ctx.db.insert("devices", {
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      deviceClass: "daemon",
      encryptedLabel: {
        algorithm: "A256GCM",
        ciphertext: "fixture",
        keyVersion: 1,
        nonce: "nonce",
      },
      keyVersion: 1,
      publicId: "control_fixture_device",
      revision: 1,
      signingPublicKey: "signing-key",
      status: "active",
      updatedAt: now,
      userId,
      wrappingPublicKey: "wrapping-key",
    });
    const sessionId = await ctx.db.insert("sessionHeads", {
      compactHeadSequence: 0,
      createdAt: now,
      detailHeadSequence: 0,
      executionDeviceId: deviceId,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: "control_fixture_session",
      state: "active",
      updatedAt: now,
      userId,
    });
    const anchorRowId = await ctx.db.insert("attentionNotificationOutbox", {
      allowedWindowEnd: now + 60_000,
      claimCapacityReservation: "0".repeat(16 * 1_024),
      claimDeadline: now + 60_000,
      coalesceAfter: now,
      consentLeaseUntil: now + 60_000,
      createdAt: now,
      executionAuthority: { bootGeneration: 1, bootId: "boot", fence: 1 },
      globalNotificationGeneration: 1,
      interactionDeadline: now + 60_000,
      interactionId: "control_fixture_interaction",
      interactionKind: "user_input",
      interactionRevision: 1,
      localNotificationPolicyRevision: 1,
      nonterminal: true,
      reconciliationSequence: 1,
      remoteActions: ["answer"],
      sessionId,
      sessionPublicId: "control_fixture_session",
      sourceDeviceId: deviceId,
      state: "pending",
      updatedAt: now,
      userId,
    });
    expect(await reserveAttentionNotificationFaultCapacity(ctx, {
      anchorRowId,
      deliveryId,
      now,
      userId,
    })).toBe(true);
    return { anchorRowId, userId };
  });
}

describe("attention-notification safety fault ledger", () => {
  test("is globally disabled by absence and advances explicit generations", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesis, {});
    expect(await runtime.query(inactiveDeploymentStatus, {})).toEqual({
      generation: 0,
      globalState: "absent",
      outboxOccupancy: 0,
      safetyFaultOccupancy: 0,
    });
    expect(await runtime.query(status, {})).toMatchObject({
      enabled: false,
      generation: 0,
      safetyFault: null,
    });
    expect(await runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 0,
      mutationId: enableOne,
    })).toMatchObject({ enabled: true, generation: 1, replay: false });
    expect(await runtime.query(inactiveDeploymentStatus, {})).toMatchObject({
      generation: 1,
      globalState: "enabled",
    });
  });

  test("reports only bounded occupancy when inactive delivery rows exist", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesis, {});
    await seedCapacity(runtime);
    expect(await runtime.query(inactiveDeploymentStatus, {})).toEqual({
      generation: 0,
      globalState: "absent",
      outboxOccupancy: 1,
      safetyFaultOccupancy: 1,
    });
  });

  test("retains and independently reviews concurrent obligations, including delayed replay", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesis, {});
    await runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 0,
      mutationId: enableOne,
    });
    const ids = await seedCapacity(runtime);
    const first = await runtime.mutation(latchSafetyFault, {
      anchorRowId: ids.anchorRowId,
      capacityDeliveryId: faultDelivery,
      deliveryGeneration: 1,
      deliveryId: faultDelivery,
      expectedGeneration: 1,
      reason: "invalid_idempotent_request",
      resultDigest: firstDigest,
      userId: ids.userId,
    });
    const firstFaultId = first.safetyFault?.faultId;
    if (firstFaultId === undefined) throw new Error("missing first fault id");
    expect(first).toMatchObject({ changed: true, enabled: false, generation: 2 });
    const second = await runtime.mutation(latchSafetyFault, {
      anchorRowId: ids.anchorRowId,
      capacityDeliveryId: faultDelivery,
      deliveryGeneration: 2,
      deliveryId: faultDelivery,
      expectedGeneration: 1,
      reason: "invalid_idempotent_request",
      resultDigest: secondDigest,
      userId: ids.userId,
    });
    const secondFaultId = second.safetyFault?.faultId;
    if (secondFaultId === undefined) throw new Error("missing second fault id");
    expect(secondFaultId).not.toBe(firstFaultId);
    expect(second).toMatchObject({ changed: true, enabled: false, generation: 2 });
    await runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: faultDelivery,
      expectedFaultId: firstFaultId,
      expectedGeneration: 2,
      expectedResultDigest: firstDigest,
      mutationId: firstReview,
    });
    await expect(runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: enableThree,
    })).rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");
    await runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: faultDelivery,
      expectedFaultId: secondFaultId,
      expectedGeneration: 2,
      expectedResultDigest: secondDigest,
      mutationId: secondReview,
    });
    expect(await runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: faultDelivery,
      expectedFaultId: firstFaultId,
      expectedGeneration: 2,
      expectedResultDigest: firstDigest,
      mutationId: firstReview,
    })).toMatchObject({ changed: false, replay: true });
    await runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: enableThree,
    });

    const late = await runtime.mutation(latchSafetyFault, {
      anchorRowId: ids.anchorRowId,
      capacityDeliveryId: faultDelivery,
      deliveryGeneration: 3,
      deliveryId: faultDelivery,
      expectedGeneration: 1,
      reason: "invalid_idempotent_request",
      resultDigest: "f".repeat(64),
      userId: ids.userId,
    });
    expect(late).toMatchObject({ changed: true, enabled: false, generation: 4 });
    await expect(runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 4,
      mutationId: enableFive,
    })).rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");

    const rows = await runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_anchor_and_slot", (builder) => builder.eq("anchorRowId", ids.anchorRowId))
        .collect());
    expect(rows).toHaveLength(attentionNotificationFaultSlotsPerDelivery);
    expect(rows.filter((row) => row.state === "latched")).toHaveLength(1);
    expect(rows.filter((row) => row.state === "reviewed")).toHaveLength(2);
    const armed = rows.find((row) => row.state === "reserved");
    expect(armed?.capacityReservation)
      .toBe(attentionNotificationFaultCapacityReservations.armed);
    expect(armed?.terminalCleanupAfter)
      .toBe(armed === undefined ? undefined : armed.updatedAt + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS);
  });

  test("every reserved transition is non-growing and malformed latched rows fail closed", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesis, {});
    const ids = await seedCapacity(runtime);
    const before = await runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_anchor_and_slot", (builder) => builder.eq("anchorRowId", ids.anchorRowId))
        .collect());
    const reservedQuota = await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique());
    expect(before).toHaveLength(4);
    expect(before.every((row) => row.capacityReservation
      === attentionNotificationFaultCapacityReservations.reserved)).toBe(true);
    const latched = await runtime.mutation(latchSafetyFault, {
      anchorRowId: ids.anchorRowId,
      capacityDeliveryId: faultDelivery,
      deliveryGeneration: 1,
      deliveryId: faultDelivery,
      expectedGeneration: 0,
      reason: "invalid_idempotent_request",
      resultDigest: firstDigest,
      userId: ids.userId,
    });
    const faultId = latched.safetyFault?.faultId;
    if (faultId === undefined) throw new Error("missing fault id");
    const after = await runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_anchor_and_slot", (builder) => builder.eq("anchorRowId", ids.anchorRowId))
        .collect());
    for (const row of after) {
      const original = before.find((candidate) => candidate.slot === row.slot);
      if (original === undefined) throw new Error("missing original slot");
      expect(logicalDocumentBytes(row)).toBeLessThanOrEqual(logicalDocumentBytes(original));
    }
    expect(await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique())).toMatchObject({
      serviceLogicalBytes: reservedQuota?.serviceLogicalBytes,
      serviceRecords: reservedQuota?.serviceRecords,
    });
    await runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: faultDelivery,
      expectedFaultId: faultId,
      expectedGeneration: 1,
      expectedResultDigest: firstDigest,
      mutationId: firstReview,
    });
    const reviewed = await runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_fault_id", (builder) => builder.eq("faultId", faultId))
        .unique());
    const prior = after.find((row) => row.faultId === faultId);
    if (reviewed === null || prior === undefined) throw new Error("missing reviewed fault");
    expect(logicalDocumentBytes(reviewed)).toBeLessThanOrEqual(logicalDocumentBytes(prior));
    expect(await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique())).toMatchObject({
      serviceLogicalBytes: reservedQuota?.serviceLogicalBytes,
      serviceRecords: reservedQuota?.serviceRecords,
    });

    await runtime.run(async (ctx) => {
      await ctx.db.patch(reviewed._id, {
        capacityReservation: attentionNotificationFaultCapacityReservations.reserved,
        state: "latched",
      });
    });
    await expect(runtime.query(status, {}))
      .rejects.toThrow("ATTENTION_NOTIFICATION_CONTROL_CORRUPT");
  });

  test("converts all four same-delivery slots and refuses a fifth obligation", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesis, {});
    const ids = await seedCapacity(runtime);
    const before = await runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_anchor_and_slot", (builder) => builder.eq("anchorRowId", ids.anchorRowId))
        .collect());
    for (const [index, resultDigest] of [
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
    ].entries()) {
      expect(await runtime.mutation(latchSafetyFault, {
        anchorRowId: ids.anchorRowId,
        capacityDeliveryId: faultDelivery,
        deliveryGeneration: index + 1,
        deliveryId: faultDelivery,
        expectedGeneration: 0,
        reason: "invalid_idempotent_request",
        resultDigest,
        userId: ids.userId,
      })).toMatchObject({ changed: true, enabled: false, generation: 1 });
    }
    expect(await runtime.mutation(latchSafetyFault, {
      anchorRowId: ids.anchorRowId,
      capacityDeliveryId: faultDelivery,
      cleanupRowId: ids.anchorRowId,
      deliveryGeneration: 0,
      deliveryId: faultDelivery,
      expectedGeneration: 0,
      reason: "stored_delivery_corrupt",
      resultDigest: "4".repeat(64),
      userId: ids.userId,
    })).toMatchObject({ changed: true, enabled: false, generation: 1 });

    const after = await runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_anchor_and_slot", (builder) => builder.eq("anchorRowId", ids.anchorRowId))
        .collect());
    expect(after).toHaveLength(attentionNotificationFaultSlotsPerDelivery);
    expect(after.every((row) => row.state === "latched")).toBe(true);
    expect(new Set(after.map((row) => row.faultId)).size)
      .toBe(attentionNotificationFaultSlotsPerDelivery);
    for (const row of after) {
      const original = before.find((candidate) => candidate.slot === row.slot);
      if (original === undefined) throw new Error("missing original slot");
      expect(logicalDocumentBytes(row)).toBeLessThanOrEqual(logicalDocumentBytes(original));
    }
    await expect(runtime.mutation(latchSafetyFault, {
      anchorRowId: ids.anchorRowId,
      capacityDeliveryId: faultDelivery,
      deliveryGeneration: 5,
      deliveryId: faultDelivery,
      expectedGeneration: 0,
      reason: "invalid_idempotent_request",
      resultDigest: "5".repeat(64),
      userId: ids.userId,
    })).rejects.toThrow("ATTENTION_NOTIFICATION_CONTROL_CORRUPT");
  });

  test("expires armed and reviewed capacity strictly after the seven-day boundary", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_800_000_000_000);
    try {
      const runtime = convexTest(schema, modules);
      await runtime.mutation(genesis, {});
      const ids = await seedCapacity(runtime);
      const latched = await runtime.mutation(latchSafetyFault, {
        anchorRowId: ids.anchorRowId,
        capacityDeliveryId: faultDelivery,
        deliveryGeneration: 1,
        deliveryId: faultDelivery,
        expectedGeneration: 0,
        reason: "invalid_idempotent_request",
        resultDigest: firstDigest,
        userId: ids.userId,
      });
      const faultId = latched.safetyFault?.faultId;
      if (faultId === undefined) throw new Error("missing expiry fault id");
      await runtime.mutation(acknowledgeSafetyFault, {
        expectedDeliveryId: faultDelivery,
        expectedFaultId: faultId,
        expectedGeneration: 1,
        expectedResultDigest: firstDigest,
        mutationId: firstReview,
      });
      const expiresAt = 1_800_000_000_000 + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS;
      expect(await runtime.run(async (ctx) =>
        await deleteExpiredAttentionNotificationSafetyFaults(ctx, expiresAt - 1, 10)))
        .toBe(0);
      expect(await runtime.run(async (ctx) =>
        await deleteExpiredAttentionNotificationSafetyFaults(ctx, expiresAt, 10)))
        .toBe(0);
      expect(await runtime.run(async (ctx) =>
        await deleteExpiredAttentionNotificationSafetyFaults(ctx, expiresAt + 1, 10)))
        .toBe(attentionNotificationFaultSlotsPerDelivery);
      expect(await runtime.run(async (ctx) =>
        await ctx.db.query("attentionNotificationSafetyFaults").collect())).toEqual([]);
      expect(await runtime.run(async (ctx) =>
        await ctx.db.query("storageUsageService")
          .withIndex("by_key", (builder) => builder.eq("key", "global"))
          .unique())).toMatchObject({
        logicalBytes: 0,
        records: 0,
        serviceLogicalBytes: 0,
        serviceRecords: 0,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("account erasure releases the fixed charge for an inflated corrupt slot", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesis, {});
    const target = await seedCapacity(runtime);
    const otherDelivery = "01912345-6789-7abc-8def-0123456789b7";
    const other = await seedCapacity(runtime, otherDelivery);
    const expectedRemaining = await runtime.run(async (ctx) => {
      const rows = await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_user", (builder) => builder.eq("userId", other.userId))
        .collect();
      return {
        bytes: rows.reduce((total, row) => total + logicalDocumentBytes(row), 0),
        ids: rows.map((row) => row._id).sort(),
      };
    });
    await runtime.run(async (ctx) => {
      const slot = await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_anchor_and_slot", (builder) => builder
          .eq("anchorRowId", target.anchorRowId)
          .eq("slot", 0))
        .unique();
      if (slot === null) throw new Error("missing corrupt erasure fixture");
      const inflated = {
        deliveryGeneration: 1,
        faultId: "x".repeat(64 * 1_024),
        observedAt: Date.now(),
        quarantineState: "not_required" as const,
        reason: "invalid_idempotent_request" as const,
        resultDigest: "f".repeat(64),
      };
      expect(logicalDocumentBytes({ ...slot, ...inflated }))
        .toBeGreaterThan(logicalDocumentBytes(slot));
      await ctx.db.patch(slot._id, inflated);
    });

    expect(await runtime.run(async (ctx) =>
      await deleteAttentionNotificationSafetyFaultsForAccount(ctx, target.userId, 4)))
      .toEqual({ deleted: 4, empty: false });
    expect(await runtime.run(async (ctx) =>
      await deleteAttentionNotificationSafetyFaultsForAccount(ctx, target.userId, 4)))
      .toEqual({ deleted: 0, empty: true });
    expect(await runtime.run(async (ctx) => {
      const service = await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique();
      const rows = await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_user", (builder) => builder.eq("userId", other.userId))
        .collect();
      return {
        ids: rows.map((row) => row._id).sort(),
        service,
      };
    })).toMatchObject({
      ids: expectedRemaining.ids,
      service: {
        logicalBytes: expectedRemaining.bytes,
        records: 4,
        serviceLogicalBytes: expectedRemaining.bytes,
        serviceRecords: 4,
      },
    });
  });

  test("account erasure removes only the target user's faults and preserves the global latch", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesis, {});
    const first = await seedCapacity(runtime, faultDelivery);
    const otherDelivery = "01912345-6789-7abc-8def-0123456789b6";
    const second = await seedCapacity(runtime, otherDelivery);
    await runtime.mutation(latchSafetyFault, {
      anchorRowId: first.anchorRowId,
      capacityDeliveryId: faultDelivery,
      deliveryGeneration: 1,
      deliveryId: faultDelivery,
      expectedGeneration: 0,
      reason: "invalid_idempotent_request",
      resultDigest: firstDigest,
      userId: first.userId,
    });
    await runtime.mutation(latchSafetyFault, {
      anchorRowId: second.anchorRowId,
      capacityDeliveryId: otherDelivery,
      deliveryGeneration: 1,
      deliveryId: otherDelivery,
      expectedGeneration: 0,
      reason: "invalid_idempotent_request",
      resultDigest: secondDigest,
      userId: second.userId,
    });

    expect(await runtime.run(async (ctx) =>
      await deleteAttentionNotificationSafetyFaultsForAccount(ctx, first.userId, 4)))
      .toEqual({ deleted: 4, empty: false });
    expect(await runtime.run(async (ctx) =>
      await deleteAttentionNotificationSafetyFaultsForAccount(ctx, first.userId, 4)))
      .toEqual({ deleted: 0, empty: true });
    const oldest = await runtime.run(async (ctx) =>
      await readOldestLatchedAttentionNotificationSafetyFault(ctx));
    expect(oldest).toMatchObject({ deliveryId: otherDelivery, userId: second.userId });
    await expect(runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 1,
      mutationId: enableThree,
    })).rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");
  });
});
