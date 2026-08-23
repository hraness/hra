import { describe, expect, spyOn, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { cloudLimits } from "../src/cloud/contracts";
import { expectPromiseToReject } from "../src/cloud/testAssertions";
import {
  adjustQuotaForPatch,
  initializeAccountUsageQuotaAuthority,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  releaseAccountUsageSnapshotQuotaForDelete,
  reserveAccountUsageSnapshotQuotaForInsert,
  reserveCodexAccountQuotaForInsert,
  reserveDeviceQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveQuotaForInsert,
} from "./quota";
import { CLOUD_USAGE_SNAPSHOT_RETENTION_MS } from "./lifecyclePolicy";
import schema from "./schema";
import { modules } from "./test.setup";
import {
  USAGE_ADMISSION_EXPIRY_RELEASE_LIMIT,
  USAGE_SERVER_ADMISSION_MIN_INTERVAL_MS,
} from "./usage";

type Args = Readonly<Record<string, Value>>;
const upsertSnapshot = makeFunctionReference<"mutation", Args, unknown>("usage:upsertSnapshot");
const upsertAccount = makeFunctionReference<"mutation", Args, unknown>("usage:upsertAccount");
const getAccountBinding = makeFunctionReference<"query", Args, unknown>(
  "usage:getAccountBinding",
);
const listSnapshots = makeFunctionReference<"query", Args, unknown>("usage:listSnapshots");
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const envelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "B".repeat(16),
};

const digest = (value: number): string => value.toString(16).padStart(64, "0");

function uuidV7(now: number, sequence: number): string {
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  const suffix = sequence.toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix}`;
}

async function usageWorld(devicePublicIds: readonly string[]) {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "usage-order@example.com",
      emailVerificationTime: now,
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    await ctx.db.insert("authSubjects", {
      authEpoch: 1,
      createdAt: now,
      emailDigest: "a".repeat(64),
      status: "active",
      updatedAt: now,
      userId,
    });
    const accountDocument = {
      createdAt: now,
      encryptedMetadata: envelope,
      matchKey: "b".repeat(64),
      publicId: "codex_account1",
      updatedAt: now,
      userId,
    } as const;
    await reserveCodexAccountQuotaForInsert(ctx, userId, accountDocument);
    const accountId = await ctx.db.insert("codexAccounts", accountDocument);
    await initializeAccountUsageQuotaAuthority(ctx, userId, accountId);
    const devices = [];
    for (const publicId of devicePublicIds) {
      const authSessionId = await ctx.db.insert("authSessions", {
        expirationTime: now + 365 * 24 * 60 * 60 * 1_000,
        userId,
      });
      const deviceDocument = {
        activatedAt: now,
        authEpoch: 1,
        createdAt: now,
        encryptedLabel: envelope,
        keyVersion: 1,
        publicId,
        revision: 1,
        signingPublicKey: "{}",
        status: "active",
        updatedAt: now,
        userId,
        wrappingPublicKey: "{}",
      } as const;
      await reserveDeviceQuotaForInsert(ctx, userId, deviceDocument);
      const deviceId = await ctx.db.insert("devices", deviceDocument);
      await ctx.db.insert("deviceSessions", {
        authEpoch: 1,
        authSessionId,
        boundAt: now,
        deviceId,
        userId,
      });
      const bindingDocument = {
        accountId,
        deviceId,
        encryptedLocalReference: envelope,
        lastSeenAt: now,
        sourceGeneration: 1,
        state: "present" as const,
        updatedAt: now,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "account", bindingDocument);
      const bindingId = await ctx.db.insert("deviceAccountBindings", bindingDocument);
      devices.push({ authSessionId, bindingId, deviceId, publicId });
    }
    return { accountId, devices, userId };
  });
  return {
    ...ids,
    runtimeFor(publicId: string) {
      const device = ids.devices.find((candidate) => candidate.publicId === publicId);
      if (device === undefined) throw new Error("test device is missing");
      return testRuntime.withIdentity({
        issuer: "https://test.example",
        subject: `${ids.userId}|${device.authSessionId}`,
        tokenIdentifier: `test|${device.authSessionId}`,
      });
    },
    testRuntime,
  };
}

describe("usage snapshot ordering", () => {
  test("converges equal-time device winners in both arrival orders", async () => {
    const observedAt = Date.now() - 1_000;
    for (const arrival of [["device_Z", "device_a"], ["device_a", "device_Z"]] as const) {
      const world = await usageWorld(arrival);
      const first = arrival[0];
      const second = arrival[1];
      expect(await world.runtimeFor(first).mutation(upsertSnapshot, {
        accountPublicId: "codex_account1",
        digest: first === "device_a" ? digest(2) : digest(1),
        envelope,
        observedAt,
        sourceGeneration: 1,
        sourceRevision: 1,
      })).toMatchObject({ disposition: "replace", sourceRevision: 1 });
      expect(await world.runtimeFor(second).mutation(upsertSnapshot, {
        accountPublicId: "codex_account1",
        digest: second === "device_a" ? digest(2) : digest(1),
        envelope,
        observedAt,
        sourceGeneration: 1,
        sourceRevision: 1,
      })).toMatchObject({
        disposition: second === "device_a" ? "replace" : "store",
        sourceRevision: 1,
      });
      expect(await world.runtimeFor(first).query(listSnapshots, {
        accountPublicId: "codex_account1",
        limit: 1,
      })).toEqual([expect.objectContaining({ digest: digest(2), observedAt, sourceRevision: 1 })]);
      expect(await world.runtimeFor(first).query(listSnapshots, {
        accountPublicId: "codex_account1",
        limit: 2,
      })).toEqual([
        expect.objectContaining({ digest: digest(2), sourceRevision: 1 }),
        expect.objectContaining({ digest: digest(1), sourceRevision: 1 }),
      ]);
    }
  });

  test("coalesces a same-source burst while preserving replay, conflict, and stale order", async () => {
    const world = await usageWorld(["device_a"]);
    const runtime = world.runtimeFor("device_a");
    const observedAt = Date.now() - 1_000;
    const first = {
      accountPublicId: "codex_account1",
      digest: digest(10),
      envelope,
      observedAt,
      sourceGeneration: 1,
      sourceRevision: 1,
    };
    const second = { ...first, digest: digest(11), sourceRevision: 3 };
    expect(await runtime.mutation(upsertSnapshot, first))
      .toMatchObject({ disposition: "replace", sourceRevision: 1 });
    expect(await runtime.mutation(upsertSnapshot, second))
      .toMatchObject({ disposition: "coalesced", sourceRevision: 3 });
    expect(await runtime.mutation(upsertSnapshot, second))
      .toMatchObject({ disposition: "coalesced", sourceRevision: 3 });
    await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
      ...second,
      digest: digest(12),
    }), "USAGE_SNAPSHOT_CONFLICT");
    expect(await runtime.mutation(upsertSnapshot, first))
      .toMatchObject({ disposition: "replay", sourceRevision: 1 });
    await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
      ...first,
      digest: digest(13),
    }), "USAGE_SNAPSHOT_CONFLICT");
    await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
      ...first,
      sourceRevision: 2,
    }), "USAGE_SNAPSHOT_STALE");
    expect(await runtime.query(listSnapshots, {
      accountPublicId: "codex_account1",
      limit: 2,
    })).toEqual([
      expect.objectContaining({ digest: digest(10), sourceRevision: 1 }),
    ]);
  });

  test("classifies exact stored and coalesced retries independently of later clock rollback", async () => {
    const world = await usageWorld(["device_a"]);
    const runtime = world.runtimeFor("device_a");
    const startedAt = Date.now();
    const dateNow = spyOn(Date, "now").mockReturnValue(startedAt);
    const observedAt = startedAt + 5 * 60 * 1_000;
    const first = {
      accountPublicId: "codex_account1",
      digest: digest(100),
      envelope,
      observedAt,
      sourceGeneration: 1,
      sourceRevision: 1,
    };
    const second = { ...first, digest: digest(101), sourceRevision: 2 };
    try {
      expect(await runtime.mutation(upsertSnapshot, first))
        .toMatchObject({ disposition: "replace", sourceRevision: 1 });
      expect(await runtime.mutation(upsertSnapshot, second))
        .toMatchObject({ disposition: "coalesced", sourceRevision: 2 });
      dateNow.mockReturnValue(startedAt - 1);
      expect(await runtime.mutation(upsertSnapshot, first))
        .toMatchObject({ disposition: "replay", sourceRevision: 1 });
      expect(await runtime.mutation(upsertSnapshot, second))
        .toMatchObject({ disposition: "coalesced", sourceRevision: 2 });
      await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
        ...first,
        digest: digest(102),
      }), "USAGE_SNAPSHOT_CONFLICT");
      await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
        ...second,
        digest: digest(103),
      }), "USAGE_SNAPSHOT_CONFLICT");
      await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
        ...second,
        digest: digest(104),
        sourceRevision: 3,
      }), "USAGE_SNAPSHOT_FUTURE");
    } finally {
      dateNow.mockRestore();
    }
  });

  test("uses a quota-neutral durable cursor for hostile offline catch-up and exact retries", async () => {
    const world = await usageWorld(["device_a"]);
    const runtime = world.runtimeFor("device_a");
    const device = world.devices[0];
    if (device === undefined) throw new Error("usage catch-up device is missing");
    const observedAt = Date.now() - 1_000;
    const first = {
      accountPublicId: "codex_account1",
      digest: digest(1),
      envelope,
      observedAt,
      sourceGeneration: 1,
      sourceRevision: 1,
    };
    expect(await runtime.mutation(upsertSnapshot, first))
      .toMatchObject({ disposition: "replace", sourceRevision: 1 });
    for (let sourceRevision = 2; sourceRevision <= 70; sourceRevision += 1) {
      expect(await runtime.mutation(upsertSnapshot, {
        ...first,
        digest: digest(sourceRevision),
        observedAt: observedAt + sourceRevision,
        sourceRevision,
      })).toMatchObject({ disposition: "coalesced", sourceRevision });
    }
    const last = {
      ...first,
      digest: digest(70),
      observedAt: observedAt + 70,
      sourceRevision: 70,
    };
    expect(await runtime.mutation(upsertSnapshot, last))
      .toMatchObject({ disposition: "coalesced", sourceRevision: 70 });
    await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
      ...last,
      digest: digest(71),
    }), "USAGE_SNAPSHOT_CONFLICT");
    await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
      ...first,
      digest: digest(69),
      observedAt: observedAt + 69,
      sourceRevision: 69,
    }), "USAGE_SNAPSHOT_STALE");
    expect(await runtime.query(getAccountBinding, { publicId: "codex_account1" }))
      .toMatchObject({ binding: { usageSourceRevision: 70 } });
    expect(await world.testRuntime.run(async (ctx) => {
      const binding = await ctx.db.get(device.bindingId);
      const quota = await ctx.db.query("storageResourceUsageByAccount")
        .withIndex("by_account_and_resource", (builder) => builder
          .eq("accountId", world.accountId)
          .eq("resource", "usage_snapshot"))
        .unique();
      const snapshots = await ctx.db.query("accountUsageSnapshots")
        .withIndex("by_source_revision", (builder) => builder
          .eq("accountId", world.accountId)
          .eq("sourceDeviceId", device.deviceId))
        .collect();
      return { binding, records: quota?.records, snapshots: snapshots.length };
    })).toMatchObject({
      binding: {
        usageAdmission: {
          cursor: { disposition: "coalesced", sourceRevision: 70 },
        },
      },
      records: 1,
      snapshots: 1,
    });
  });

  test("reconstructs a legacy binding cursor from its latest stored source row", async () => {
    const world = await usageWorld(["device_a"]);
    const runtime = world.runtimeFor("device_a");
    const device = world.devices[0];
    if (device === undefined) throw new Error("legacy usage device is missing");
    const first = {
      accountPublicId: "codex_account1",
      digest: digest(1),
      envelope,
      observedAt: Date.now() - 1_000,
      sourceGeneration: 1,
      sourceRevision: 1,
    };
    expect(await runtime.mutation(upsertSnapshot, first))
      .toMatchObject({ disposition: "replace", sourceRevision: 1 });
    await world.testRuntime.run(async (ctx) => {
      const binding = await ctx.db.get(device.bindingId);
      if (binding === null) throw new Error("legacy usage binding is missing");
      const patch = { usageAdmission: undefined } as const;
      await adjustQuotaForPatch(ctx, world.userId, "account", binding, patch);
      await ctx.db.patch(binding._id, patch);
    });

    expect(await runtime.query(getAccountBinding, { publicId: "codex_account1" }))
      .toMatchObject({ binding: { usageSourceRevision: 1 } });
    expect(await runtime.mutation(upsertSnapshot, {
      ...first,
      digest: digest(2),
      observedAt: first.observedAt + 1,
      sourceRevision: 2,
    })).toMatchObject({ disposition: "coalesced", sourceRevision: 2 });
    expect(await world.testRuntime.run(async (ctx) => await ctx.db.get(device.bindingId)))
      .toMatchObject({
        usageAdmission: { cursor: { disposition: "coalesced", sourceRevision: 2 } },
      });
  });

  test("admits at the exact 24-hour server boundary and never retains more than 91 rows", async () => {
    const world = await usageWorld(["device_a"]);
    const runtime = world.runtimeFor("device_a");
    const device = world.devices[0];
    if (device === undefined) throw new Error("usage capacity device is missing");
    const startedAt = Date.now();
    const dateNow = spyOn(Date, "now").mockReturnValue(startedAt);
    try {
      expect(await runtime.mutation(upsertSnapshot, {
        accountPublicId: "codex_account1",
        digest: digest(1),
        envelope,
        observedAt: startedAt,
        sourceGeneration: 1,
        sourceRevision: 1,
      })).toMatchObject({ disposition: "replace", sourceRevision: 1 });
      dateNow.mockReturnValue(startedAt + USAGE_SERVER_ADMISSION_MIN_INTERVAL_MS - 1);
      expect(await runtime.mutation(upsertSnapshot, {
        accountPublicId: "codex_account1",
        digest: digest(2),
        envelope,
        observedAt: startedAt + USAGE_SERVER_ADMISSION_MIN_INTERVAL_MS - 1,
        sourceGeneration: 1,
        sourceRevision: 2,
      })).toMatchObject({ disposition: "coalesced", sourceRevision: 2 });
      for (let day = 1; day <= 91; day += 1) {
        const receivedAt = startedAt + day * USAGE_SERVER_ADMISSION_MIN_INTERVAL_MS;
        const sourceRevision = day + 2;
        dateNow.mockReturnValue(receivedAt);
        expect(await runtime.mutation(upsertSnapshot, {
          accountPublicId: "codex_account1",
          digest: digest(sourceRevision),
          envelope,
          observedAt: receivedAt,
          sourceGeneration: 1,
          sourceRevision,
        })).toMatchObject({ disposition: "replace", sourceRevision });
        const count = await world.testRuntime.run(async (ctx) =>
          (await ctx.db.query("accountUsageSnapshots")
            .withIndex("by_source_revision", (builder) => builder
              .eq("accountId", world.accountId)
              .eq("sourceDeviceId", device.deviceId))
            .collect()).length);
        expect(count).toBeLessThanOrEqual(91);
      }
      expect(await world.testRuntime.run(async (ctx) => {
        const snapshots = await ctx.db.query("accountUsageSnapshots")
          .withIndex("by_source_revision", (builder) => builder
            .eq("accountId", world.accountId)
            .eq("sourceDeviceId", device.deviceId))
          .order("asc")
          .collect();
        const quota = await ctx.db.query("storageResourceUsageByAccount")
          .withIndex("by_account_and_resource", (builder) => builder
            .eq("accountId", world.accountId)
            .eq("resource", "usage_snapshot"))
          .unique();
        return {
          firstRevision: snapshots[0]?.sourceRevision,
          lastRevision: snapshots.at(-1)?.sourceRevision,
          records: quota?.records,
          snapshots: snapshots.length,
        };
      })).toEqual({
        firstRevision: 3,
        lastRevision: 93,
        records: 91,
        snapshots: 91,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  test("replays a stored cursor after retention erases its row and preserves it through account patches", async () => {
    const world = await usageWorld(["device_a"]);
    const runtime = world.runtimeFor("device_a");
    const device = world.devices[0];
    if (device === undefined) throw new Error("usage cursor device is missing");
    const startedAt = Date.now();
    const first = {
      accountPublicId: "codex_account1",
      digest: digest(1),
      envelope,
      observedAt: startedAt,
      sourceGeneration: 1,
      sourceRevision: 1,
    };
    expect(await runtime.mutation(upsertSnapshot, first))
      .toMatchObject({ disposition: "replace", sourceRevision: 1 });
    const admission = await world.testRuntime.run(async (ctx) =>
      (await ctx.db.get(device.bindingId))?.usageAdmission);
    expect(admission).toMatchObject({
      cursor: { disposition: "stored", sourceRevision: 1 },
    });

    const accountPatchAt = Date.now();
    expect(await runtime.mutation(upsertAccount, {
      encryptedLocalReference: envelope,
      encryptedMetadata: envelope,
      idempotencyKey: uuidV7(accountPatchAt, 1),
      matchKey: "b".repeat(64),
      publicId: "codex_account1",
      requestDigest: digest(500),
      sourceGeneration: 2,
    })).toMatchObject({ publicId: "codex_account1", sourceGeneration: 2 });
    expect(await world.testRuntime.run(async (ctx) => await ctx.db.get(device.bindingId)))
      .toMatchObject({ sourceGeneration: 2, usageAdmission: admission });
    const quotaProof = await world.testRuntime.run(async (ctx) => {
      const account = await ctx.db.get(world.accountId);
      const bindings = await ctx.db.query("deviceAccountBindings")
        .withIndex("by_user_and_account", (builder) => builder
          .eq("userId", world.userId)
          .eq("accountId", world.accountId))
        .collect();
      const accountQuota = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", world.userId)
          .eq("category", "account"))
        .unique();
      return {
        expectedBytes: (account === null ? 0 : logicalDocumentBytes(account))
          + bindings.reduce((total, binding) => total + logicalDocumentBytes(binding), 0),
        logicalBytes: accountQuota?.logicalBytes,
        records: accountQuota?.records,
      };
    });
    expect(quotaProof.records).toBe(2);
    expect(quotaProof.logicalBytes).toBe(quotaProof.expectedBytes);

    const beforeStaleGeneration = await world.testRuntime.run(async (ctx) => ({
      accountQuota: await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", world.userId)
          .eq("category", "account"))
        .unique(),
      binding: await ctx.db.get(device.bindingId),
      snapshots: await ctx.db.query("accountUsageSnapshots")
        .withIndex("by_source_revision", (builder) => builder
          .eq("accountId", world.accountId)
          .eq("sourceDeviceId", device.deviceId))
        .collect(),
      usageQuota: await ctx.db.query("storageResourceUsageByAccount")
        .withIndex("by_account_and_resource", (builder) => builder
          .eq("accountId", world.accountId)
          .eq("resource", "usage_snapshot"))
        .unique(),
    }));
    await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
      ...first,
      digest: digest(2),
      sourceRevision: 2,
    }), "Cloud authority is not current.");
    expect(await world.testRuntime.run(async (ctx) => ({
      accountQuota: await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", world.userId)
          .eq("category", "account"))
        .unique(),
      binding: await ctx.db.get(device.bindingId),
      snapshots: await ctx.db.query("accountUsageSnapshots")
        .withIndex("by_source_revision", (builder) => builder
          .eq("accountId", world.accountId)
          .eq("sourceDeviceId", device.deviceId))
        .collect(),
      usageQuota: await ctx.db.query("storageResourceUsageByAccount")
        .withIndex("by_account_and_resource", (builder) => builder
          .eq("accountId", world.accountId)
          .eq("resource", "usage_snapshot"))
        .unique(),
    }))).toEqual(beforeStaleGeneration);

    const currentGenerationFirst = { ...first, sourceGeneration: 2 };

    const agedAt = startedAt + CLOUD_USAGE_SNAPSHOT_RETENTION_MS + 1;
    const dateNow = spyOn(Date, "now").mockReturnValue(agedAt);
    try {
      await world.testRuntime.run(async (ctx) => {
        const snapshot = await ctx.db.query("accountUsageSnapshots")
          .withIndex("by_source_revision", (builder) => builder
            .eq("accountId", world.accountId)
            .eq("sourceDeviceId", device.deviceId)
            .eq("sourceRevision", 1))
          .unique();
        if (snapshot === null) throw new Error("stored cursor row is missing");
        await releaseAccountUsageSnapshotQuotaForDelete(
          ctx,
          world.userId,
          world.accountId,
          snapshot,
        );
        await ctx.db.delete(snapshot._id);
      });
      expect(await runtime.mutation(upsertSnapshot, currentGenerationFirst))
        .toMatchObject({ disposition: "replay", sourceRevision: 1 });
      await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
        ...currentGenerationFirst,
        digest: digest(2),
      }), "USAGE_SNAPSHOT_CONFLICT");
      expect(await world.testRuntime.run(async (ctx) => {
        const rows = await ctx.db.query("accountUsageSnapshots")
          .withIndex("by_source_revision", (builder) => builder
            .eq("accountId", world.accountId)
            .eq("sourceDeviceId", device.deviceId))
          .collect();
        const quota = await ctx.db.query("storageResourceUsageByAccount")
          .withIndex("by_account_and_resource", (builder) => builder
            .eq("accountId", world.accountId)
            .eq("resource", "usage_snapshot"))
          .unique();
        return { records: quota?.records, rows: rows.length };
      })).toEqual({ records: 0, rows: 0 });
    } finally {
      dateNow.mockRestore();
    }
  });

  test("an arriving snapshot releases its own account's expired quota before admission", async () => {
    const world = await usageWorld(["device_a"]);
    const device = world.devices[0];
    if (device === undefined) throw new Error("usage cleanup device is missing");
    const now = Date.now();
    await world.testRuntime.run(async (ctx) => {
      for (let index = 1; index <= USAGE_ADMISSION_EXPIRY_RELEASE_LIMIT + 1; index += 1) {
        const snapshot = {
          accountId: world.accountId,
          createdAt: now - CLOUD_USAGE_SNAPSHOT_RETENTION_MS - 10_000 + index,
          digest: digest(index),
          envelope,
          observedAt: now - CLOUD_USAGE_SNAPSHOT_RETENTION_MS - 10_000 + index,
          receivedAt: now - CLOUD_USAGE_SNAPSHOT_RETENTION_MS - 10_000 + index,
          sourceDeviceId: device.deviceId,
          sourceDevicePublicId: device.publicId,
          sourceRevision: index,
          userId: world.userId,
        } as const;
        await reserveAccountUsageSnapshotQuotaForInsert(
          ctx,
          world.userId,
          world.accountId,
          snapshot,
        );
        await ctx.db.insert("accountUsageSnapshots", snapshot);
      }
    });

    expect(await world.runtimeFor("device_a").mutation(upsertSnapshot, {
      accountPublicId: "codex_account1",
      digest: digest(100),
      envelope,
      observedAt: now - 1,
      sourceGeneration: 1,
      sourceRevision: USAGE_ADMISSION_EXPIRY_RELEASE_LIMIT + 2,
    })).toMatchObject({ disposition: "replace" });
    expect(await world.testRuntime.run(async (ctx) => {
      const snapshots = await ctx.db.query("accountUsageSnapshots")
        .withIndex("by_account_and_received_at", (builder) => builder
          .eq("accountId", world.accountId))
        .collect();
      const quota = await ctx.db.query("storageResourceUsageByAccount")
        .withIndex("by_account_and_resource", (builder) => builder
          .eq("accountId", world.accountId)
          .eq("resource", "usage_snapshot"))
        .unique();
      return { records: quota?.records, snapshots: snapshots.length };
    })).toEqual({ records: 2, snapshots: 2 });
  });

  test("selects the deterministic winner beyond the public page bound", async () => {
    const readerPublicId = "device_reader";
    const world = await usageWorld([readerPublicId]);
    const observedAt = Date.now() - 1_000;
    await world.testRuntime.run(async (ctx) => {
      for (let index = 0; index <= cloudLimits.pageSize; index += 1) {
        const sourceDevicePublicId = `device_${String(index).padStart(3, "0")}`;
        const sourceDeviceId = await ctx.db.insert("devices", {
          activatedAt: observedAt,
          authEpoch: 1,
          createdAt: observedAt,
          encryptedLabel: envelope,
          keyVersion: 1,
          publicId: sourceDevicePublicId,
          revision: 1,
          signingPublicKey: "{}",
          status: "active",
          updatedAt: observedAt,
          userId: world.userId,
          wrappingPublicKey: "{}",
        });
        await ctx.db.insert("accountUsageSnapshots", {
          accountId: world.accountId,
          createdAt: observedAt + (cloudLimits.pageSize - index),
          digest: digest(index + 100),
          envelope,
          observedAt,
          receivedAt: observedAt,
          sourceDeviceId,
          sourceDevicePublicId,
          sourceRevision: 1,
          userId: world.userId,
        });
      }
    });

    const runtime = world.runtimeFor(readerPublicId);
    expect(await runtime.query(listSnapshots, {
      accountPublicId: "codex_account1",
      limit: 1,
    })).toEqual([expect.objectContaining({
      digest: digest(cloudLimits.pageSize + 100),
      observedAt,
      sourceRevision: 1,
    })]);
    const page = await runtime.query(listSnapshots, {
      accountPublicId: "codex_account1",
      limit: cloudLimits.pageSize,
    }) as readonly Readonly<{ digest: string }>[];
    expect(page).toHaveLength(cloudLimits.pageSize);
    expect(page[0]?.digest).toBe(digest(cloudLimits.pageSize + 100));
    expect(page.at(-1)?.digest).toBe(digest(101));
  });
});
