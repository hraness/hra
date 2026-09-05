import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { expectPromiseToReject } from "../src/cloud/testAssertions";
import { deviceCommandLoginResultLifetimeMs } from "../src/cloud/payloads";
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
const enqueue = makeFunctionReference<"mutation", Args, unknown>("deviceCommands:enqueue");
const acknowledge = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:acknowledgeReceipt",
);
const prepare = makeFunctionReference<"mutation", Args, unknown>("deviceCommands:prepare");
const markEffectStarted = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:markEffectStarted",
);
const settle = makeFunctionReference<"mutation", Args, unknown>("deviceCommands:settle");
const recoverEffectStarted = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:recoverEffectStarted",
);
const cancelPending = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:cancelPending",
);
const consumeResult = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:consumeResult",
);
const getCommand = makeFunctionReference<"query", Args, unknown>("deviceCommands:get");
const listPending = makeFunctionReference<"query", Args, unknown>(
  "deviceCommands:listPendingForTarget",
);
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const envelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "B".repeat(16),
};
const resultEnvelope = { ...envelope, ciphertext: "R".repeat(48) };
const publicKey = JSON.stringify({ crv: "P-256", kty: "EC", x: "A".repeat(43), y: "B".repeat(43) });
const wrappedKeyEnvelope = {
  algorithm: "P256-HKDF-SHA256+A256GCM" as const,
  ciphertext: "C".repeat(64),
  ephemeralPublicKey: publicKey,
  keyVersion: 1,
  nonce: "D".repeat(16),
};
const daemonAuthority: Authority = { bootGeneration: 1, bootId: "boot_00000001", fence: 1 };
const laterAuthority: Authority = { bootGeneration: 2, bootId: "boot_00000002", fence: 1 };

function uuidV7(now: number, suffix: string): string {
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`;
}

type Runtime = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

async function deviceCommandWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "device-commands@example.com",
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
    return { browserAuthSessionId, daemonAuthSessionId, userId };
  });
  const asSession = (authSessionId: string): Runtime => testRuntime.withIdentity({
    issuer: "https://test.example",
    subject: `${ids.userId}|${authSessionId}`,
    tokenIdentifier: `test|${authSessionId}`,
  });
  const daemon = asSession(ids.daemonAuthSessionId);
  const browser = asSession(ids.browserAuthSessionId);
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
  let ordinal = 16;
  const enqueueFrom = async (
    runtime: Runtime,
    overrides: Args = {},
  ): Promise<Readonly<{ publicId: string }>> => {
    ordinal += 1;
    const suffix = ordinal.toString(16).padStart(2, "0");
    const publicId = uuidV7(now, `a${suffix}`);
    const response = await runtime.mutation(enqueue, {
      deadline: Date.now() + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: uuidV7(now, `b${suffix}`),
      kind: "usage_refresh",
      payload: envelope,
      publicId,
      requestDigest: suffix.padEnd(64, "d"),
      ...overrides,
    }) as Readonly<{ publicId: string }>;
    return response;
  };
  return { browser, daemon, enqueueFrom, ids, now, testRuntime, uuid: (s: string) => uuidV7(now, s) };
}

describe("device commands", () => {
  test("runs the full lifecycle from a browser device to a daemon target", async () => {
    const world = await deviceCommandWorld();
    const enqueued = await world.browser.mutation(enqueue, {
      deadline: Date.now() + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: world.uuid("11"),
      kind: "session_start",
      payload: envelope,
      publicId: world.uuid("21"),
      requestDigest: "1".repeat(64),
    });
    expect(enqueued).toMatchObject({
      publicId: world.uuid("21"),
      replay: false,
      state: "pending",
      targetDevicePublicId: "device_daemon01",
    });

    const pending = await world.daemon.query(listPending, { limit: 10 }) as readonly unknown[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "session_start", state: "pending" });

    expect(await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("21"),
      localPhase: "prepared_no_effect",
    })).toMatchObject({ replay: false, state: "prepared" });
    // A second prepare under the same boot authority is a replay, not a second claim.
    expect(await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("21"),
      localPhase: "prepared_no_effect",
    })).toMatchObject({ replay: true, state: "prepared" });
    expect(await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("21"),
    })).toMatchObject({ replay: false, state: "effect_started" });
    expect(await world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("21"),
      result: resultEnvelope,
      resultCode: "APPLIED",
      resultDigest: "e".repeat(64),
      state: "applied",
    })).toMatchObject({ replay: false, state: "applied" });

    const settled = await world.browser.query(getCommand, {
      commandPublicId: world.uuid("21"),
    }) as Readonly<{ result?: unknown; resultCode: string; state: string }>;
    expect(settled).toMatchObject({ resultCode: "APPLIED", state: "applied" });
    expect(settled.result).toEqual(resultEnvelope);
  });

  test("a browser device is never a device command target", async () => {
    const world = await deviceCommandWorld();
    await expectPromiseToReject(
      world.daemon.mutation(enqueue, {
        deadline: Date.now() + 60_000,
        expectedTargetDevicePublicId: "device_browser1",
        idempotencyKey: world.uuid("12"),
        kind: "usage_refresh",
        payload: envelope,
        publicId: world.uuid("22"),
        requestDigest: "2".repeat(64),
      }),
      "DEVICE_COMMAND_TARGET_NOT_EXECUTOR",
    );
  });

  test("a browser device cannot execute the lifecycle it enqueued", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, { publicId: world.uuid("23") });
    await expectPromiseToReject(
      world.browser.mutation(prepare, {
        authority: daemonAuthority,
        commandPublicId: world.uuid("23"),
        localPhase: "prepared_no_effect",
      }),
      "BROWSER_DEVICE_CANNOT_EXECUTE",
    );
  });

  test("replays an identical enqueue and refuses a conflicting digest", async () => {
    const world = await deviceCommandWorld();
    const request = {
      deadline: Date.now() + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: world.uuid("13"),
      kind: "usage_refresh",
      payload: envelope,
      publicId: world.uuid("24"),
      requestDigest: "3".repeat(64),
    };
    expect(await world.browser.mutation(enqueue, request)).toMatchObject({ replay: false });
    expect(await world.browser.mutation(enqueue, request)).toMatchObject({ replay: true });
    await expectPromiseToReject(
      world.browser.mutation(enqueue, { ...request, requestDigest: "4".repeat(64) }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  test("quarantines an effect that may have begun as ambiguous under a later boot", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, {
      kind: "session_start",
      publicId: world.uuid("25"),
    });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("25"),
      localPhase: "prepared_no_effect",
    });
    await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("25"),
    });

    // The daemon crashed here. A later boot may only close it as ambiguous.
    await expectPromiseToReject(world.daemon.mutation(recoverEffectStarted, {
      commandPublicId: world.uuid("25"),
      recoveryAuthority: laterAuthority,
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      resultDigest: "f".repeat(64),
      staleAuthority: daemonAuthority,
      state: "failed",
    }));
    // And the stale authority itself cannot settle it as applied under a new boot.
    await expectPromiseToReject(world.daemon.mutation(settle, {
      authority: laterAuthority,
      commandPublicId: world.uuid("25"),
      resultCode: "APPLIED",
      resultDigest: "f".repeat(64),
      state: "applied",
    }));

    expect(await world.daemon.mutation(recoverEffectStarted, {
      commandPublicId: world.uuid("25"),
      recoveryAuthority: laterAuthority,
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      resultDigest: "f".repeat(64),
      staleAuthority: daemonAuthority,
      state: "ambiguous",
    })).toMatchObject({ replay: false, state: "ambiguous" });
    expect(await world.browser.query(getCommand, { commandPublicId: world.uuid("25") }))
      .toMatchObject({ resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED", state: "ambiguous" });
  });

  test("an earlier boot can never take a prepared command from a later one", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, { publicId: world.uuid("26") });
    await world.daemon.mutation(prepare, {
      authority: laterAuthority,
      commandPublicId: world.uuid("26"),
      localPhase: "prepared_no_effect",
    });
    await expectPromiseToReject(world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("26"),
      localPhase: "prepared_no_effect",
    }));
    // A strictly later authority may rebind, because nothing has started.
    expect(await world.daemon.mutation(prepare, {
      authority: { bootGeneration: 3, bootId: "boot_00000003", fence: 1 },
      commandPublicId: world.uuid("26"),
      localPhase: "prepared_no_effect",
    })).toMatchObject({ rebound: true, state: "prepared" });
  });

  test("expires a command whose deadline passed before the daemon claimed it", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, {
      deadline: Date.now() + 5,
      publicId: world.uuid("27"),
    });
    await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      const row = rows.find((entry) => entry.publicId === world.uuid("27"));
      if (row === undefined) throw new Error("missing command fixture");
      await ctx.db.patch(row._id, { deadline: Date.now() - 1 });
    });
    expect(await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("27"),
      localPhase: "prepared_no_effect",
    })).toMatchObject({ state: "expired" });
  });

  test("releases a single-use result exactly once, to the requester only", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, {
      kind: "account_login_start",
      publicId: world.uuid("28"),
    });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      localPhase: "prepared_no_effect",
    });
    await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
    });
    // A login handoff that is not marked single use is refused outright.
    await expectPromiseToReject(world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      result: resultEnvelope,
      resultCode: "APPLIED",
      resultDigest: "a".repeat(64),
      state: "applied",
    }));
    await world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      result: resultEnvelope,
      resultCode: "APPLIED",
      resultDigest: "a".repeat(64),
      singleUseResult: true,
      state: "applied",
    });

    // An ordinary read never carries the ciphertext.
    const beforeRead = await world.browser.query(getCommand, {
      commandPublicId: world.uuid("28"),
    }) as Readonly<{ result?: unknown; resultConsumed: boolean; resultSingleUse: boolean }>;
    expect(beforeRead.result).toBeUndefined();
    expect(beforeRead).toMatchObject({ resultConsumed: false, resultSingleUse: true });

    expect(await world.browser.mutation(consumeResult, { commandPublicId: world.uuid("28") }))
      .toMatchObject({
        expiresAt: expect.any(Number),
        result: resultEnvelope,
        status: "released",
      });
    expect(await world.browser.mutation(consumeResult, { commandPublicId: world.uuid("28") }))
      .toMatchObject({ status: "spent" });
    // The target device is not the requester and may never exchange the relay.
    await expectPromiseToReject(
      world.daemon.mutation(consumeResult, { commandPublicId: world.uuid("28") }),
    );
    expect(await world.browser.query(getCommand, { commandPublicId: world.uuid("28") }))
      .toMatchObject({ resultConsumed: true, resultSingleUse: true });
  });

  test("erases an expired login handoff without releasing its ciphertext", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, {
      kind: "account_login_start",
      publicId: world.uuid("38"),
    });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("38"),
      localPhase: "prepared_no_effect",
    });
    await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("38"),
    });
    await world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("38"),
      result: resultEnvelope,
      resultCode: "APPLIED",
      resultDigest: "e".repeat(64),
      singleUseResult: true,
      state: "applied",
    });
    await world.testRuntime.run(async (ctx) => {
      const row = (await ctx.db
        .query("deviceCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", world.uuid("38")))
        .unique());
      if (row === null) throw new Error("missing device command fixture");
      await ctx.db.patch(row._id, {
        updatedAt: Date.now() - deviceCommandLoginResultLifetimeMs,
      });
    });

    expect(await world.browser.mutation(consumeResult, { commandPublicId: world.uuid("38") }))
      .toMatchObject({ status: "expired" });
    expect(await world.browser.mutation(consumeResult, { commandPublicId: world.uuid("38") }))
      .toMatchObject({ status: "spent" });
    expect(await world.browser.query(getCommand, { commandPublicId: world.uuid("38") }))
      .toMatchObject({ resultConsumed: true, resultSingleUse: true });
  });

  test("only the requester acknowledges or cancels", async () => {
    const world = await deviceCommandWorld();
    await world.browser.mutation(enqueue, {
      deadline: Date.now() + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: world.uuid("14"),
      kind: "usage_refresh",
      payload: envelope,
      publicId: world.uuid("29"),
      requestDigest: "5".repeat(64),
    });
    await expectPromiseToReject(world.daemon.mutation(cancelPending, {
      commandPublicId: world.uuid("29"),
    }));
    expect(await world.browser.mutation(acknowledge, {
      commandPublicId: world.uuid("29"),
      idempotencyKey: world.uuid("14"),
      requestDigest: "5".repeat(64),
    })).toMatchObject({ replay: false });
    expect(await world.browser.mutation(cancelPending, { commandPublicId: world.uuid("29") }))
      .toMatchObject({ replay: false, state: "cancelled" });
  });

  test("device revocation drains device commands the revoked device owns", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, { publicId: world.uuid("2a") });
    await world.enqueueFrom(world.browser, {
      kind: "session_start",
      publicId: world.uuid("2b"),
    });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("2b"),
      localPhase: "prepared_no_effect",
    });
    await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("2b"),
    });
    await world.daemon.mutation(revoke, {
      expectedRevision: 2,
      idempotencyKey: world.uuid("15"),
      requestDigest: "6".repeat(64),
      targetPublicId: "device_browser1",
    });
    const drain = makeFunctionReference<"mutation", Args, unknown>("deviceRevocation:drain");
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await world.testRuntime.mutation(drain, { limit: 200 });
    }
    const states = await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      return Object.fromEntries(rows.map((row) => [row.publicId, row.state]));
    });
    expect(states[world.uuid("2a")]).toBe("cancelled");
    // An effect that may have begun is quarantined, never cancelled.
    expect(states[world.uuid("2b")]).toBe("ambiguous");
  });
});
