import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";
import { convexTest } from "convex-test";

import { cloudLimits } from "../src/cloud/contracts";
import { expectPromiseToReject } from "../src/cloud/testAssertions";
import {
  initializeUserQuotaAuthority,
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
  revision: number;
  updatedAt: number;
}>;

const updateRegistry = makeFunctionReference<"mutation", Args, RegistryWrite>(
  "devices:updateRegistry",
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

    await expectPromiseToReject(
      runtime.mutation(updateRegistry, {
        envelope: envelopeWith("G".repeat(cloudLimits.registryCiphertextCharacters + 1)),
        expectedRevision: 0,
        keyVersion: 1,
      }),
      "Cloud authority is not current",
    );
    await expectPromiseToReject(
      runtime.mutation(updateRegistry, {
        envelope: envelopeWith("C".repeat(48)),
        expectedRevision: 0,
        keyVersion: 2,
      }),
      "Cloud authority is not current",
    );
    expect(await runtime.query(listRegistries, {})).toEqual([]);
  });
});
