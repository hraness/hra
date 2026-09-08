import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";
import { convexTest } from "convex-test";

import { cloudLimits } from "../src/cloud/contracts";
import { expectPromiseToReject } from "../src/cloud/testAssertions";
import {
  CATEGORY_QUOTAS,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  reserveQuotaForStoredIdentity,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type RegistryWrite = Readonly<{
  devicePublicId: string;
  revision: number;
  updatedAt: number;
}>;
type RegistryRow = Readonly<{
  devicePublicId: string;
  envelope: Readonly<{ ciphertext: string; keyVersion: number }>;
  keyVersion: number;
  memorySummaryEnvelope?: Readonly<{ ciphertext: string; keyVersion: number }>;
  memorySummaryRevision?: number;
  memorySummaryUpdatedAt?: number;
  notificationEmailEnvelope?: Readonly<{ ciphertext: string; keyVersion: number }>;
  notificationHoursEnvelope?: Readonly<{ ciphertext: string; keyVersion: number }>;
  notificationPolicyRevision?: number;
  revision: number;
  updatedAt: number;
}>;

const updateRegistry = makeFunctionReference<"mutation", Args, RegistryWrite>(
  "devices:updateRegistry",
);
const updateMemorySummary = makeFunctionReference<"mutation", Args, RegistryWrite>(
  "devices:updateMemorySummary",
);
const getRegistry = makeFunctionReference<"query", Args, RegistryRow | null>(
  "devices:getRegistry",
);
const listRegistries = makeFunctionReference<"query", Args, readonly RegistryRow[]>(
  "devices:listRegistries",
);
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const envelopeWith = (ciphertext: string) => ({
  algorithm: "A256GCM" as const,
  ciphertext,
  keyVersion: 1,
  nonce: "B".repeat(16),
});

const labelEnvelope = envelopeWith("A".repeat(32));

type Identity = Readonly<{
  authSessionId: Id<"authSessions">;
  devicePublicId: string;
  userId: Id<"users">;
}>;

async function registryWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();

  const enrollUser = async (label: string): Promise<Id<"users">> =>
    await testRuntime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: `${label}@example.test`,
        emailVerificationTime: now,
      });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing quota fixture user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      await ctx.db.insert("authSubjects", {
        authEpoch: 1,
        createdAt: now,
        emailDigest: `${label}_`.padEnd(64, "a").slice(0, 64),
        status: "active",
        updatedAt: now,
        userId,
      });
      return userId;
    });

  const enrollDevice = async (
    label: string,
    userId: Id<"users">,
    deviceClass: "browser" | "daemon" = "daemon",
  ): Promise<Identity> => await testRuntime.run(async (ctx) => {
    const authSessionId = await ctx.db.insert("authSessions", {
      expirationTime: now + 3_600_000,
      userId,
    });
    const devicePublicId = `device_registry_${label}`;
    const deviceId = await ctx.db.insert("devices", {
      activatedAt: now,
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      ...(deviceClass === "daemon" ? {} : { deviceClass }),
      encryptedLabel: labelEnvelope,
      keyVersion: 1,
      publicId: devicePublicId,
      revision: 1,
      signingPublicKey: "fixture",
      status: "active",
      updatedAt: now,
      userId,
      wrappingPublicKey: "fixture",
    });
    await ctx.db.insert("deviceSessions", {
      authEpoch: 1,
      authSessionId,
      boundAt: now,
      deviceId,
      userId,
    });
    return { authSessionId, devicePublicId, userId };
  });

  const asDevice = (identity: Identity) => testRuntime.withIdentity({
    issuer: "https://test.example",
    subject: `${identity.userId}|${identity.authSessionId}`,
    tokenIdentifier: `test|${identity.authSessionId}`,
  });

  return { asDevice, enrollDevice, enrollUser, testRuntime };
}

describe("device registry", () => {
  test("keeps command capability internal and clears it when an old daemon republishes", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("command-capability", await world.enrollUser(
      "command-capability",
    ));
    const runtime = world.asDevice(primary);

    await runtime.mutation(updateRegistry, {
      commandRequestVersion: 2,
      envelope: envelopeWith("C".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });
    expect(await world.testRuntime.run(async (ctx) =>
      (await ctx.db.query("deviceRegistries").unique())?.commandRequestVersion)).toBe(2);
    expect(await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId }))
      .not.toHaveProperty("commandRequestVersion");
    const listed = await runtime.query(listRegistries, {});
    expect(listed[0]).not.toHaveProperty("commandRequestVersion");

    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("D".repeat(48)),
      expectedRevision: 1,
      keyVersion: 1,
    });
    const downgraded = await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("deviceRegistries").unique());
    expect(downgraded).not.toBeNull();
    expect(downgraded).not.toHaveProperty("commandRequestVersion");
    expect(await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId }))
      .toMatchObject({ revision: 2 });
  });

  test("advances an exact revision chain for the calling device", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("primary", await world.enrollUser("primary"));
    const runtime = world.asDevice(primary);

    const first = await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("C".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });
    expect(first).toMatchObject({
      devicePublicId: primary.devicePublicId,
      revision: 1,
    });
    expect(first.updatedAt).toBeGreaterThan(0);

    const second = await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("D".repeat(48)),
      expectedRevision: 1,
      keyVersion: 1,
    });
    expect(second).toMatchObject({
      devicePublicId: primary.devicePublicId,
      revision: 2,
    });

    const stored = await runtime.query(getRegistry, {
      devicePublicId: primary.devicePublicId,
    });
    expect(stored).toMatchObject({
      devicePublicId: primary.devicePublicId,
      keyVersion: 1,
      revision: 2,
    });
    expect(stored?.envelope.ciphertext).toBe("D".repeat(48));
  });

  test("keeps notification hours separately encrypted and clears it when an older publisher omits it", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("hours", await world.enrollUser("hours"));
    const runtime = world.asDevice(primary);
    const hours = envelopeWith("H".repeat(48));
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("M".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
      notificationHoursEnvelope: hours,
    });
    expect(await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId }))
      .toMatchObject({ notificationHoursEnvelope: hours });
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("N".repeat(48)),
      expectedRevision: 1,
      keyVersion: 1,
    });
    expect(await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId }))
      .not.toHaveProperty("notificationHoursEnvelope");
  });

  test("keeps memory supervision on an independent revision while core updates preserve it", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("memory", await world.enrollUser("memory"));
    const runtime = world.asDevice(primary);
    const summary = envelopeWith("S".repeat(48));
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("M".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });
    await runtime.mutation(updateMemorySummary, {
      envelope: summary,
      expectedRevision: 0,
      keyVersion: 1,
    });
    expect(await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId }))
      .toMatchObject({
        memorySummaryEnvelope: summary,
        memorySummaryRevision: 1,
        memorySummaryUpdatedAt: expect.any(Number),
        revision: 1,
      });
    await expectPromiseToReject(
      runtime.mutation(updateMemorySummary, {
        envelope: envelopeWith("T".repeat(48)),
        expectedRevision: 0,
        keyVersion: 1,
      }),
      "MEMORY_SUMMARY_REVISION_CONFLICT",
    );
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("N".repeat(48)),
      expectedRevision: 1,
      keyVersion: 1,
    });
    const preserved = await runtime.query(getRegistry, {
      devicePublicId: primary.devicePublicId,
    });
    expect(preserved).toMatchObject({
      memorySummaryEnvelope: summary,
      memorySummaryRevision: 1,
      revision: 2,
    });
    await runtime.mutation(updateMemorySummary, {
      expectedRevision: 1,
      keyVersion: 1,
    });
    const cleared = await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId });
    expect(cleared).toMatchObject({ memorySummaryRevision: 2, revision: 2 });
    expect(cleared).not.toHaveProperty("memorySummaryEnvelope");
  });

  test("charges and releases the memory summary through registry custody quota", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("memory-quota", await world.enrollUser("memory-quota"));
    const runtime = world.asDevice(primary);
    const accounting = async () => await world.testRuntime.run(async (ctx) => {
      const registry = await ctx.db.query("deviceRegistries").unique();
      const quota = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", primary.userId)
          .eq("category", "custody"))
        .unique();
      if (registry === null || quota === null) throw new Error("missing registry quota fixture");
      const document: Record<string, Value | undefined> = {};
      for (const [key, value] of Object.entries(registry)) {
        if (key !== "_creationTime" && key !== "_id") document[key] = value;
      }
      return { documentBytes: logicalDocumentBytes(document), quotaBytes: quota.logicalBytes };
    });

    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("M".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });
    const withoutSummary = await accounting();
    await runtime.mutation(updateMemorySummary, {
      envelope: envelopeWith("S".repeat(1_024)),
      expectedRevision: 0,
      keyVersion: 1,
    });
    const withSummary = await accounting();
    expect(withSummary.quotaBytes - withoutSummary.quotaBytes)
      .toBe(withSummary.documentBytes - withoutSummary.documentBytes);
    expect(withSummary.quotaBytes).toBeGreaterThan(withoutSummary.quotaBytes);

    await runtime.mutation(updateMemorySummary, {
      expectedRevision: 1,
      keyVersion: 1,
    });
    const cleared = await accounting();
    expect(cleared.quotaBytes - withSummary.quotaBytes)
      .toBe(cleared.documentBytes - withSummary.documentBytes);
    expect(cleared.quotaBytes).toBeLessThan(withSummary.quotaBytes);
  });

  test("a summary quota refusal leaves the core registry revision independently writable", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("summary-refusal", await world.enrollUser("summary-refusal"));
    const runtime = world.asDevice(primary);
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("M".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });
    await world.testRuntime.run(async (ctx) => {
      const custody = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", primary.userId)
          .eq("category", "custody"))
        .unique();
      const service = await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique();
      if (custody === null || service === null) throw new Error("missing quota authority");
      const targetBytes = CATEGORY_QUOTAS.custody.logicalBytes - 512;
      const delta = targetBytes - custody.logicalBytes;
      expect(delta).toBeGreaterThan(0);
      await ctx.db.patch(custody._id, { logicalBytes: targetBytes });
      await ctx.db.patch(service._id, {
        logicalBytes: service.logicalBytes + delta,
        userLogicalBytes: service.userLogicalBytes + delta,
      });
    });

    await expectPromiseToReject(
      runtime.mutation(updateMemorySummary, {
        envelope: envelopeWith("S".repeat(1_024)),
        expectedRevision: 0,
        keyVersion: 1,
      }),
      "QUOTA_EXCEEDED",
    );
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("N".repeat(48)),
      expectedRevision: 1,
      keyVersion: 1,
    });
    const stored = await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId });
    expect(stored).toMatchObject({ revision: 2 });
    expect(stored).not.toHaveProperty("memorySummaryEnvelope");
    expect(stored).not.toHaveProperty("memorySummaryRevision");
  });

  test("keeps memory-summary publication daemon-only while browser devices remain readers", async () => {
    const world = await registryWorld();
    const browser = await world.enrollDevice(
      "summary-browser",
      await world.enrollUser("summary-browser"),
      "browser",
    );
    const runtime = world.asDevice(browser);
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("B".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });
    await expectPromiseToReject(
      runtime.mutation(updateMemorySummary, {
        envelope: envelopeWith("S".repeat(48)),
        expectedRevision: 0,
        keyVersion: 1,
      }),
      "BROWSER_DEVICE_CANNOT_EXECUTE",
    );
  });

  test("binds email consent and hours to one outer revision and clears consent on downgrade", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("email", await world.enrollUser("email"));
    const runtime = world.asDevice(primary);
    const email = envelopeWith("E".repeat(48));
    const hours = envelopeWith("H".repeat(48));
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("M".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
      notificationEmailEnvelope: email,
      notificationHoursEnvelope: hours,
      notificationPolicyRevision: 7,
    });
    expect(await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId }))
      .toMatchObject({
        notificationEmailEnvelope: email,
        notificationHoursEnvelope: hours,
        notificationPolicyRevision: 7,
      });

    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("N".repeat(48)),
      expectedRevision: 1,
      keyVersion: 1,
      notificationHoursEnvelope: hours,
    });
    const downgraded = await runtime.query(getRegistry, {
      devicePublicId: primary.devicePublicId,
    });
    expect(downgraded).toMatchObject({ notificationHoursEnvelope: hours, revision: 2 });
    expect(downgraded).not.toHaveProperty("notificationEmailEnvelope");
    expect(downgraded).not.toHaveProperty("notificationPolicyRevision");
  });

  test("rejects composite rollback below stored and retained hosted revision authority", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("rollback", await world.enrollUser("rollback"));
    const runtime = world.asDevice(primary);
    const email = envelopeWith("E".repeat(48));
    const hours = envelopeWith("H".repeat(48));
    const writeComposite = (expectedRevision: number, notificationPolicyRevision: number) =>
      runtime.mutation(updateRegistry, {
        envelope: envelopeWith("M".repeat(48)),
        expectedRevision,
        keyVersion: 1,
        notificationEmailEnvelope: email,
        notificationHoursEnvelope: hours,
        notificationPolicyRevision,
      });

    await writeComposite(0, 7);
    await expectPromiseToReject(
      writeComposite(1, 6),
      "Cloud authority is not current.",
    );
    expect(await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId }))
      .toMatchObject({ notificationPolicyRevision: 7, revision: 1 });

    await world.testRuntime.run(async (ctx) => {
      const devices = await ctx.db.query("devices")
        .withIndex("by_user_and_public_id", (builder) => builder
          .eq("userId", primary.userId)
          .eq("publicId", primary.devicePublicId))
        .take(2);
      expect(devices).toHaveLength(1);
      const device = devices[0];
      if (device === undefined) throw new Error("missing rollback fixture device");
      await ctx.db.patch(device._id, {
        attentionNotificationAuthority: {
          consentLeaseUntil: Date.now(),
          globalNotificationGeneration: 1,
          localNotificationPolicyRevision: 7,
          reconciliationSequence: 1,
        },
      });
    });
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("N".repeat(48)),
      expectedRevision: 1,
      keyVersion: 1,
    });
    await expectPromiseToReject(
      writeComposite(2, 6),
      "Cloud authority is not current.",
    );
    const cleared = await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId });
    expect(cleared).toMatchObject({ revision: 2 });
    expect(cleared).not.toHaveProperty("notificationEmailEnvelope");
    expect(cleared).not.toHaveProperty("notificationPolicyRevision");
  });

  test("rejects every incomplete composite notification-policy envelope", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("incomplete", await world.enrollUser("incomplete"));
    const runtime = world.asDevice(primary);
    const base = {
      envelope: envelopeWith("M".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    } as const;
    const email = envelopeWith("E".repeat(48));
    const hours = envelopeWith("H".repeat(48));
    for (const partial of [
      { notificationEmailEnvelope: email },
      { notificationEmailEnvelope: email, notificationPolicyRevision: 1 },
      { notificationHoursEnvelope: hours, notificationPolicyRevision: 1 },
    ]) {
      await expectPromiseToReject(
        runtime.mutation(updateRegistry, { ...base, ...partial }),
        "Cloud authority is not current.",
      );
    }
    expect(await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId }))
      .toBeNull();
  });

  test("rejects a stale expected revision and preserves the stored envelope", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("primary", await world.enrollUser("primary"));
    const runtime = world.asDevice(primary);

    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("C".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("D".repeat(48)),
      expectedRevision: 1,
      keyVersion: 1,
    });

    await expectPromiseToReject(
      runtime.mutation(updateRegistry, {
        envelope: envelopeWith("E".repeat(48)),
        expectedRevision: 1,
        keyVersion: 1,
      }),
      "DEVICE_REGISTRY_REVISION_CONFLICT",
    );
    await expectPromiseToReject(
      runtime.mutation(updateRegistry, {
        envelope: envelopeWith("E".repeat(48)),
        expectedRevision: 0,
        keyVersion: 1,
      }),
      "DEVICE_REGISTRY_REVISION_CONFLICT",
    );

    const stored = await runtime.query(getRegistry, {
      devicePublicId: primary.devicePublicId,
    });
    expect(stored).toMatchObject({ revision: 2 });
    expect(stored?.envelope.ciphertext).toBe("D".repeat(48));
  });

  test("reads the caller's own row and returns null for an unknown device", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("primary", await world.enrollUser("primary"));
    const runtime = world.asDevice(primary);

    expect(await runtime.query(getRegistry, {
      devicePublicId: primary.devicePublicId,
    })).toBeNull();
    expect(await runtime.query(listRegistries, {})).toEqual([]);

    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("C".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });

    expect(await runtime.query(getRegistry, {
      devicePublicId: primary.devicePublicId,
    })).toMatchObject({ devicePublicId: primary.devicePublicId, revision: 1 });
    expect(await runtime.query(getRegistry, {
      devicePublicId: "device_registry_absent",
    })).toBeNull();
    const listed = await runtime.query(listRegistries, {});
    expect(listed).toEqual([
      expect.objectContaining({ devicePublicId: primary.devicePublicId, revision: 1 }),
    ]);
    expect(listed[0]).not.toHaveProperty("userId");
    expect(listed[0]).not.toHaveProperty("_id");
    expect(listed[0]).not.toHaveProperty("_creationTime");
  });

  test("lets a second device of the same user read the first device's registry", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("primary", await world.enrollUser("primary"));
    const secondary = await world.enrollDevice("secondary", primary.userId);
    const primaryRuntime = world.asDevice(primary);
    const secondaryRuntime = world.asDevice(secondary);

    await primaryRuntime.mutation(updateRegistry, {
      envelope: envelopeWith("C".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });

    expect(await secondaryRuntime.query(getRegistry, {
      devicePublicId: primary.devicePublicId,
    })).toMatchObject({ devicePublicId: primary.devicePublicId, revision: 1 });
    expect(await secondaryRuntime.query(listRegistries, {})).toEqual([
      expect.objectContaining({ devicePublicId: primary.devicePublicId }),
    ]);

    // The second device writes its own row rather than the first device's.
    await secondaryRuntime.mutation(updateRegistry, {
      envelope: envelopeWith("F".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });
    const stored = await primaryRuntime.query(getRegistry, {
      devicePublicId: primary.devicePublicId,
    });
    expect(stored?.envelope.ciphertext).toBe("C".repeat(48));
    expect(await primaryRuntime.query(listRegistries, {})).toHaveLength(2);
  });

  test("never exposes another user's registry row", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("primary", await world.enrollUser("primary"));
    const stranger = await world.enrollDevice("stranger", await world.enrollUser("stranger"));
    const primaryRuntime = world.asDevice(primary);
    const strangerRuntime = world.asDevice(stranger);

    await primaryRuntime.mutation(updateRegistry, {
      envelope: envelopeWith("C".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });

    expect(await strangerRuntime.query(getRegistry, {
      devicePublicId: primary.devicePublicId,
    })).toBeNull();
    expect(await strangerRuntime.query(listRegistries, {})).toEqual([]);
  });

  test("rejects an over-long ciphertext and a mismatched key version", async () => {
    const world = await registryWorld();
    const primary = await world.enrollDevice("primary", await world.enrollUser("primary"));
    const runtime = world.asDevice(primary);
    await runtime.mutation(updateRegistry, {
      envelope: envelopeWith("C".repeat(48)),
      expectedRevision: 0,
      keyVersion: 1,
    });

    await expectPromiseToReject(
      runtime.mutation(updateMemorySummary, {
        envelope: envelopeWith(
          "S".repeat(cloudLimits.memorySummaryCiphertextCharacters + 1),
        ),
        expectedRevision: 0,
        keyVersion: 1,
      }),
      "Cloud authority is not current",
    );
    await expectPromiseToReject(
      runtime.mutation(updateMemorySummary, {
        envelope: { ...envelopeWith("S".repeat(48)), keyVersion: 2 },
        expectedRevision: 0,
        keyVersion: 1,
      }),
      "Cloud authority is not current",
    );
    await expectPromiseToReject(
      runtime.mutation(updateRegistry, {
        envelope: envelopeWith("G".repeat(cloudLimits.registryCiphertextCharacters + 1)),
        expectedRevision: 1,
        keyVersion: 1,
      }),
      "Cloud authority is not current",
    );
    await expectPromiseToReject(
      runtime.mutation(updateRegistry, {
        envelope: envelopeWith("C".repeat(48)),
        expectedRevision: 1,
        keyVersion: 2,
      }),
      "Cloud authority is not current",
    );
    expect(await runtime.query(getRegistry, { devicePublicId: primary.devicePublicId }))
      .toMatchObject({ revision: 1 });
  });
});
