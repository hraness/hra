import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { expectPromiseToReject } from "../src/cloud/testAssertions";
import {
  initializeUserQuotaAuthority,
  reserveQuotaForStoredIdentity,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type Authority = Readonly<{ bootGeneration: number; bootId: string; fence: number }>;

const register = makeFunctionReference<"mutation", Args, unknown>("devices:register");
const approve = makeFunctionReference<"mutation", Args, unknown>("devices:approve");
const revoke = makeFunctionReference<"mutation", Args, unknown>("devices:revoke");
const listDevices = makeFunctionReference<"query", Args, unknown>("devices:list");
const createSession = makeFunctionReference<"mutation", Args, unknown>("sessions:create");
const updateMetadata = makeFunctionReference<"mutation", Args, unknown>("sessions:updateMetadata");
const updateState = makeFunctionReference<"mutation", Args, unknown>("sessions:updateState");
const listHeads = makeFunctionReference<"query", Args, unknown>("sessions:listHeads");
const acquireLease = makeFunctionReference<"mutation", Args, unknown>("leases:acquire");
const leaseHeartbeat = makeFunctionReference<"mutation", Args, unknown>("leases:heartbeat");
const upsertAccount = makeFunctionReference<"mutation", Args, unknown>("usage:upsertAccount");
const upsertSnapshot = makeFunctionReference<"mutation", Args, unknown>("usage:upsertSnapshot");
const presenceConnect = makeFunctionReference<"mutation", Args, unknown>("presence:connect");
const presenceHeartbeat = makeFunctionReference<"mutation", Args, unknown>("presence:heartbeat");
const presenceDisconnect = makeFunctionReference<"mutation", Args, unknown>("presence:disconnect");
const enqueueCommand = makeFunctionReference<"mutation", Args, unknown>("commands:enqueue");
const cancelPending = makeFunctionReference<"mutation", Args, unknown>("commands:cancelPending");
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const envelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "B".repeat(16),
};
const publicKey = JSON.stringify({ crv: "P-256", kty: "EC", x: "A".repeat(43), y: "B".repeat(43) });
const wrappedKeyEnvelope = {
  algorithm: "P256-HKDF-SHA256+A256GCM" as const,
  ciphertext: "C".repeat(64),
  ephemeralPublicKey: publicKey,
  keyVersion: 1,
  nonce: "D".repeat(16),
};

function uuidV7(now: number, suffix: string): string {
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`;
}

type Runtime = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

async function deviceClassWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "class@example.com",
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
    const daemonAuthSessionId = await ctx.db.insert("authSessions", {
      expirationTime: now + 3_600_000,
      userId,
    });
    const browserAuthSessionId = await ctx.db.insert("authSessions", {
      expirationTime: now + 3_600_000,
      userId,
    });
    const spareAuthSessionId = await ctx.db.insert("authSessions", {
      expirationTime: now + 3_600_000,
      userId,
    });
    return { browserAuthSessionId, daemonAuthSessionId, spareAuthSessionId, userId };
  });
  const asSession = (authSessionId: string): Runtime => testRuntime.withIdentity({
    issuer: "https://test.example",
    subject: `${ids.userId}|${authSessionId}`,
    tokenIdentifier: `test|${authSessionId}`,
  });
  const daemon = asSession(ids.daemonAuthSessionId);
  const browser = asSession(ids.browserAuthSessionId);
  const spare = asSession(ids.spareAuthSessionId);
  await daemon.mutation(register, {
    bootstrapKeyEnvelope: wrappedKeyEnvelope,
    encryptedLabel: envelope,
    idempotencyKey: uuidV7(now, "01"),
    keyVersion: 1,
    publicId: "device_daemon01",
    requestDigest: "a".repeat(64),
    signingPublicKey: publicKey,
    wrappingPublicKey: publicKey,
  });
  await browser.mutation(register, {
    deviceClass: "browser",
    encryptedLabel: envelope,
    idempotencyKey: uuidV7(now, "02"),
    keyVersion: 1,
    publicId: "device_browser1",
    requestDigest: "b".repeat(64),
    signingPublicKey: publicKey,
    wrappingPublicKey: publicKey,
  });
  await daemon.mutation(approve, {
    expectedRevision: 1,
    idempotencyKey: uuidV7(now, "03"),
    keyEnvelope: wrappedKeyEnvelope,
    requestDigest: "c".repeat(64),
    targetPublicId: "device_browser1",
  });
  await daemon.mutation(createSession, {
    idempotencyKey: uuidV7(now, "04"),
    publicId: "session_class01",
    requestDigest: "d".repeat(64),
  });
  return { browser, daemon, ids, now, spare, testRuntime };
}

describe("browser device class", () => {
  test("refuses a browser registration while the account has no active device", async () => {
    const testRuntime = convexTest(schema, modules);
    await testRuntime.mutation(genesisQuota, {});
    const now = Date.now();
    const ids = await testRuntime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: "first@example.com",
        emailVerificationTime: now,
      });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing quota fixture user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      await ctx.db.insert("authSubjects", {
        authEpoch: 1,
        createdAt: now,
        emailDigest: "e".repeat(64),
        status: "active",
        updatedAt: now,
        userId,
      });
      const authSessionId = await ctx.db.insert("authSessions", {
        expirationTime: now + 3_600_000,
        userId,
      });
      return { authSessionId, userId };
    });
    const runtime = testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${ids.userId}|${ids.authSessionId}`,
      tokenIdentifier: `test|${ids.authSessionId}`,
    });
    await expectPromiseToReject(
      runtime.mutation(register, {
        deviceClass: "browser",
        encryptedLabel: envelope,
        idempotencyKey: uuidV7(now, "11"),
        keyVersion: 1,
        publicId: "device_browser0",
        requestDigest: "f".repeat(64),
        signingPublicKey: publicKey,
        wrappingPublicKey: publicKey,
      }),
      "BROWSER_DEVICE_REQUIRES_ACTIVE_DEVICE",
    );
    expect(await testRuntime.run(async (ctx) => await ctx.db.query("devices").collect()))
      .toHaveLength(0);
  });

  test("reports the class on every summary and defaults a legacy row to daemon", async () => {
    const world = await deviceClassWorld();
    const legacyDeviceId = await world.testRuntime.run(async (ctx) => await ctx.db.insert("devices", {
      activatedAt: world.now,
      authEpoch: 1,
      createdAt: world.now,
      credentialGeneration: 1,
      encryptedLabel: envelope,
      keyVersion: 1,
      publicId: "device_legacy01",
      revision: 1,
      signingPublicKey: publicKey,
      status: "active",
      updatedAt: world.now,
      userId: world.ids.userId,
      wrappingPublicKey: publicKey,
    }));
    const listed = await world.daemon.query(listDevices, {}) as readonly Readonly<{
      deviceClass: string;
      publicId: string;
    }>[];
    expect(listed.find((device) => device.publicId === "device_daemon01")?.deviceClass)
      .toBe("daemon");
    expect(listed.find((device) => device.publicId === "device_browser1")?.deviceClass)
      .toBe("browser");
    expect(listed.find((device) => device.publicId === "device_legacy01")?.deviceClass)
      .toBe("daemon");
    // A row written before this field existed carries full daemon authority.
    await world.testRuntime.run(async (ctx) => {
      await ctx.db.insert("deviceSessions", {
        authEpoch: 1,
        authSessionId: world.ids.spareAuthSessionId,
        boundAt: world.now,
        deviceId: legacyDeviceId,
        userId: world.ids.userId,
      });
    });
    expect(await world.spare.mutation(createSession, {
      idempotencyKey: uuidV7(world.now, "21"),
      publicId: "session_legacy1",
      requestDigest: "1".repeat(64),
    })).toMatchObject({ publicId: "session_legacy1" });
  });

  test("refuses device administration from a browser caller", async () => {
    const world = await deviceClassWorld();
    await world.spare.mutation(register, {
      deviceClass: "daemon",
      encryptedLabel: envelope,
      idempotencyKey: uuidV7(world.now, "31"),
      keyVersion: 1,
      publicId: "device_pending1",
      requestDigest: "2".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    });
    await expectPromiseToReject(
      world.browser.mutation(approve, {
        expectedRevision: 1,
        idempotencyKey: uuidV7(world.now, "32"),
        keyEnvelope: wrappedKeyEnvelope,
        requestDigest: "3".repeat(64),
        targetPublicId: "device_pending1",
      }),
      "BROWSER_DEVICE_CANNOT_ADMINISTER",
    );
    await expectPromiseToReject(
      world.browser.mutation(revoke, {
        expectedRevision: 1,
        idempotencyKey: uuidV7(world.now, "33"),
        requestDigest: "4".repeat(64),
        targetPublicId: "device_pending1",
      }),
      "BROWSER_DEVICE_CANNOT_ADMINISTER",
    );
    expect(await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("devices").collect();
      return rows.find((row) => row.publicId === "device_pending1")?.status;
    })).toBe("pending");
  });

  test("refuses every daemon-owned session, lease, and usage write from a browser caller", async () => {
    const world = await deviceClassWorld();
    const lease = await world.daemon.mutation(acquireLease, {
      bootGeneration: 1,
      bootId: "boot_class0001",
      leaseDurationMs: 60_000,
      sessionPublicId: "session_class01",
    }) as Authority;
    const authority = {
      bootGeneration: lease.bootGeneration,
      bootId: lease.bootId,
      fence: lease.fence,
    };
    for (const [reference, args] of [
      [createSession, {
        idempotencyKey: uuidV7(world.now, "41"),
        publicId: "session_browser",
        requestDigest: "5".repeat(64),
      }],
      [updateMetadata, {
        expectedRevision: 1,
        idempotencyKey: uuidV7(world.now, "42"),
        metadata: envelope,
        requestDigest: "6".repeat(64),
        sessionPublicId: "session_class01",
      }],
      [updateState, {
        authority,
        expectedState: "active",
        sessionPublicId: "session_class01",
        state: "idle",
      }],
      [acquireLease, {
        bootGeneration: 1,
        bootId: "boot_browser001",
        leaseDurationMs: 60_000,
        sessionPublicId: "session_class01",
      }],
      [leaseHeartbeat, {
        authority,
        fingerprint: "b".repeat(64),
        leaseDurationMs: 60_000,
        sequence: 1,
        sessionPublicId: "session_class01",
      }],
      [upsertAccount, {
        encryptedLocalReference: envelope,
        encryptedMetadata: envelope,
        idempotencyKey: uuidV7(world.now, "43"),
        matchKey: "7".repeat(64),
        publicId: "acct_class00001",
        requestDigest: "8".repeat(64),
        sourceGeneration: 1,
      }],
      [upsertSnapshot, {
        accountPublicId: "acct_class00001",
        digest: "9".repeat(64),
        envelope,
        observedAt: world.now,
        sourceGeneration: 1,
        sourceRevision: 1,
      }],
    ] as const) {
      await expectPromiseToReject(
        world.browser.mutation(reference, args as Args),
        "BROWSER_DEVICE_CANNOT_EXECUTE",
      );
    }
    expect(await world.browser.query(listHeads, { limit: 10 })).toBeArray();
  });

  test("keeps presence and command submission open to a browser caller", async () => {
    const world = await deviceClassWorld();
    expect(await world.browser.mutation(presenceConnect, {
      connectionId: "presence_browser1",
      credentialGeneration: 1,
      fingerprint: "1".repeat(64),
      sequence: 0,
    })).toMatchObject({ online: true });
    expect(await world.browser.mutation(presenceHeartbeat, {
      connectionId: "presence_browser1",
      credentialGeneration: 1,
      fingerprint: "1".repeat(64),
      sequence: 1,
    })).toMatchObject({ online: true });
    const commandPublicId = uuidV7(world.now, "51");
    expect(await world.browser.mutation(enqueueCommand, {
      deadline: world.now + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: uuidV7(world.now, "52"),
      kind: "steer",
      payload: envelope,
      publicId: commandPublicId,
      requestDigest: "a".repeat(64),
      sessionPublicId: "session_class01",
    })).toMatchObject({ publicId: commandPublicId, state: "pending" });
    expect(await world.browser.mutation(cancelPending, { commandPublicId }))
      .toMatchObject({ publicId: commandPublicId, state: "cancelled" });
    expect(await world.browser.mutation(presenceDisconnect, {
      connectionId: "presence_browser1",
      credentialGeneration: 1,
      fingerprint: "1".repeat(64),
      sequence: 1,
    })).toMatchObject({ online: false });
  });
});
