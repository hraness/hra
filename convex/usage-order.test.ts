import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { cloudLimits } from "../src/cloud/contracts";
import { expectPromiseToReject } from "../src/cloud/testAssertions";
import {
  initializeAccountUsageQuotaAuthority,
  initializeUserQuotaAuthority,
  reserveQuotaForStoredIdentity,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
const upsertSnapshot = makeFunctionReference<"mutation", Args, unknown>("usage:upsertSnapshot");
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
    const accountId = await ctx.db.insert("codexAccounts", {
      createdAt: now,
      encryptedMetadata: envelope,
      matchKey: "b".repeat(64),
      publicId: "codex_account1",
      updatedAt: now,
      userId,
    });
    await initializeAccountUsageQuotaAuthority(ctx, userId, accountId);
    const devices = [];
    for (const publicId of devicePublicIds) {
      const authSessionId = await ctx.db.insert("authSessions", {
        expirationTime: now + 60 * 60 * 1_000,
        userId,
      });
      const deviceId = await ctx.db.insert("devices", {
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
      });
      await ctx.db.insert("deviceSessions", {
        authEpoch: 1,
        authSessionId,
        boundAt: now,
        deviceId,
        userId,
      });
      devices.push({ authSessionId, deviceId, publicId });
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
        sourceRevision: 1,
      })).toMatchObject({ disposition: "replace", sourceRevision: 1 });
      expect(await world.runtimeFor(second).mutation(upsertSnapshot, {
        accountPublicId: "codex_account1",
        digest: second === "device_a" ? digest(2) : digest(1),
        envelope,
        observedAt,
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

  test("preserves exact replay, conflict, and same-source revision ordering", async () => {
    const world = await usageWorld(["device_a"]);
    const runtime = world.runtimeFor("device_a");
    const observedAt = Date.now() - 1_000;
    const first = {
      accountPublicId: "codex_account1",
      digest: digest(10),
      envelope,
      observedAt,
      sourceRevision: 1,
    };
    const second = { ...first, digest: digest(11), sourceRevision: 2 };
    expect(await runtime.mutation(upsertSnapshot, first))
      .toMatchObject({ disposition: "replace", sourceRevision: 1 });
    expect(await runtime.mutation(upsertSnapshot, second))
      .toMatchObject({ disposition: "replace", sourceRevision: 2 });
    expect(await runtime.mutation(upsertSnapshot, second))
      .toMatchObject({ disposition: "replay", sourceRevision: 2 });
    await expectPromiseToReject(runtime.mutation(upsertSnapshot, {
      ...second,
      digest: digest(12),
    }), "USAGE_SNAPSHOT_CONFLICT");
    expect(await runtime.query(listSnapshots, {
      accountPublicId: "codex_account1",
      limit: 2,
    })).toEqual([
      expect.objectContaining({ digest: digest(11), sourceRevision: 2 }),
      expect.objectContaining({ digest: digest(10), sourceRevision: 1 }),
    ]);
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
