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
const register = makeFunctionReference<"mutation", Args, unknown>("devices:register");
const getDevice = makeFunctionReference<"query", Args, unknown>("devices:get");
const listDevicePage = makeFunctionReference<"query", Args, unknown>("devices:listPage");
const accountCurrent = makeFunctionReference<"query", Args, unknown>("account:current");
const createSession = makeFunctionReference<"mutation", Args, unknown>("sessions:create");
const getSessionHead = makeFunctionReference<"query", Args, unknown>("sessions:getHead");
const updateSessionState = makeFunctionReference<"mutation", Args, unknown>(
  "sessions:updateState",
);
const acquireLease = makeFunctionReference<"mutation", Args, unknown>("leases:acquire");
const enqueueCommand = makeFunctionReference<"mutation", Args, unknown>("commands:enqueue");
const acknowledgeCommand = makeFunctionReference<"mutation", Args, unknown>(
  "commands:acknowledgeReceipt",
);
const listPendingCommandPage = makeFunctionReference<"query", Args, unknown>(
  "commands:listPendingForTargetPage",
);
const listNonterminalCommandPage = makeFunctionReference<"query", Args, unknown>(
  "commands:listNonterminalForTargetPage",
);
const upsertUsageAccount = makeFunctionReference<"mutation", Args, unknown>(
  "usage:upsertAccount",
);
const getUsageAccountBinding = makeFunctionReference<"query", Args, unknown>(
  "usage:getAccountBinding",
);
const prepareCommand = makeFunctionReference<"mutation", Args, unknown>("commands:prepare");
const markEffectStarted = makeFunctionReference<"mutation", Args, unknown>(
  "commands:markEffectStarted",
);
const settleCommand = makeFunctionReference<"mutation", Args, unknown>("commands:settle");
const recoverEffectStarted = makeFunctionReference<"mutation", Args, unknown>(
  "commands:recoverEffectStarted",
);
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const encryptedEnvelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "A".repeat(16),
};
const publicKey = JSON.stringify({
  crv: "P-256",
  kty: "EC",
  x: "A".repeat(43),
  y: "B".repeat(43),
});
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

async function authenticatedWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "reader@example.com",
      emailVerificationTime: Date.now(),
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const authSessionId = await ctx.db.insert("authSessions", {
      expirationTime: Date.now() + 60 * 60 * 1_000,
      userId,
    });
    await ctx.db.insert("authSubjects", {
      authEpoch: 1,
      createdAt: Date.now(),
      emailDigest: "a".repeat(64),
      status: "active",
      updatedAt: Date.now(),
      userId,
    });
    return { authSessionId, userId };
  });
  return {
    ids,
    runtime: testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${ids.userId}|${ids.authSessionId}`,
      tokenIdentifier: `test|${ids.authSessionId}`,
    }),
    testRuntime,
  };
}

describe("cloud transactions", () => {
  test("fences one encrypted command effect under an exact device and lease", async () => {
    const world = await authenticatedWorld();
    const now = Date.now();
    const registerKey = uuidV7(now, "1");
    const registered = await world.runtime.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: registerKey,
      keyVersion: 1,
      publicId: "device_12345678",
      requestDigest: "b".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    });
    expect(registered).toMatchObject({ status: "active" });
    expect(await world.runtime.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: registerKey,
      keyVersion: 1,
      publicId: "device_12345678",
      requestDigest: "b".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    })).toEqual(registered);
    await expectPromiseToReject(world.runtime.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: registerKey,
      keyVersion: 1,
      publicId: "device_12345678",
      requestDigest: "c".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    }), "IDEMPOTENCY_CONFLICT");
    await expectPromiseToReject(world.runtime.mutation(register, {
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: registerKey,
      keyVersion: 1,
      publicId: "device_12345678",
      requestDigest: "b".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    }), "Cloud authority is not current");
    expect(await world.runtime.query(accountCurrent, {})).toMatchObject({
      authEpoch: 1,
      device: { publicId: "device_12345678", status: "active" },
    });

    const secondAuthSessionId = await world.testRuntime.run(async (ctx) =>
      await ctx.db.insert("authSessions", {
        expirationTime: Date.now() + 60 * 60 * 1_000,
        userId: world.ids.userId,
      }));
    const secondAuthSession = world.testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${world.ids.userId}|${secondAuthSessionId}`,
      tokenIdentifier: `test|${secondAuthSessionId}`,
    });
    expect(await secondAuthSession.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: registerKey,
      keyVersion: 1,
      publicId: "device_12345678",
      requestDigest: "b".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    })).toEqual(registered);
    expect(await secondAuthSession.query(accountCurrent, {})).toMatchObject({
      device: { publicId: "device_12345678", status: "active" },
    });
    expect(await world.testRuntime.run(async (ctx) =>
      (await ctx.db.query("devices").collect()).length)).toBe(1);
    expect(await world.runtime.query(getDevice, { publicId: "device_12345678" }))
      .toMatchObject({ publicId: "device_12345678", status: "active" });
    expect(await world.runtime.query(listDevicePage, {
      paginationOpts: { cursor: null, numItems: 100 },
    })).toMatchObject({ isDone: true, page: [{ publicId: "device_12345678" }] });

    await world.runtime.mutation(upsertUsageAccount, {
      encryptedLocalReference: encryptedEnvelope,
      encryptedMetadata: encryptedEnvelope,
      idempotencyKey: uuidV7(now, "f1"),
      matchKey: "8".repeat(64),
      publicId: "codex_account1",
      requestDigest: "9".repeat(64),
      sourceGeneration: 1,
    });
    expect(await world.runtime.query(getUsageAccountBinding, {
      publicId: "codex_account1",
    })).toMatchObject({
      binding: { sourceGeneration: 1, state: "present" },
      matchKey: "8".repeat(64),
      publicId: "codex_account1",
    });

    await world.runtime.mutation(createSession, {
      idempotencyKey: uuidV7(now, "2"),
      publicId: "session_12345678",
      requestDigest: "d".repeat(64),
    });
    const lease = await world.runtime.mutation(acquireLease, {
      bootGeneration: 1,
      bootId: "boot_12345678",
      leaseDurationMs: 30_000,
      sessionPublicId: "session_12345678",
    }) as Readonly<{ bootGeneration: number; bootId: string; fence: number }>;
    const commandPublicId = uuidV7(now, "3");
    await expectPromiseToReject(world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_stale000",
      idempotencyKey: uuidV7(now, "b"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: uuidV7(now, "c"),
      requestDigest: "1".repeat(64),
      sessionPublicId: "session_12345678",
    }), "Cloud authority is not current");
    expect(await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_12345678",
      idempotencyKey: uuidV7(now, "4"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: commandPublicId,
      requestDigest: "e".repeat(64),
      sessionPublicId: "session_12345678",
    })).toMatchObject({
      publicId: commandPublicId,
      sessionPublicId: "session_12345678",
      state: "pending",
      targetDevicePublicId: "device_12345678",
    });
    const acknowledgement = await world.runtime.mutation(acknowledgeCommand, {
      commandPublicId,
      idempotencyKey: uuidV7(now, "4"),
      requestDigest: "e".repeat(64),
    });
    expect(acknowledgement).toMatchObject({ publicId: commandPublicId, replay: false });
    expect(await world.runtime.mutation(acknowledgeCommand, {
      commandPublicId,
      idempotencyKey: uuidV7(now, "4"),
      requestDigest: "e".repeat(64),
    })).toMatchObject({ publicId: commandPublicId, replay: true });
    await expectPromiseToReject(world.runtime.mutation(acknowledgeCommand, {
      commandPublicId,
      idempotencyKey: uuidV7(now, "4"),
      requestDigest: "0".repeat(64),
    }), "Cloud authority is not current");
    expect(await world.runtime.query(listPendingCommandPage, {
      paginationOpts: { cursor: null, numItems: 100 },
    })).toMatchObject({ isDone: true, page: [{ publicId: commandPublicId }] });
    const schedulingPage = await world.runtime.query(listNonterminalCommandPage, {
      paginationOpts: { cursor: null, numItems: 100 },
    });
    expect(schedulingPage).toMatchObject({ isDone: true, page: [{ publicId: commandPublicId }] });
    expect(JSON.stringify(schedulingPage)).not.toContain('"payload"');
    const authority = {
      bootGeneration: lease.bootGeneration,
      bootId: lease.bootId,
      fence: lease.fence,
    };
    await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId,
      localPhase: "prepared_no_effect",
    });
    await world.runtime.mutation(markEffectStarted, { authority, commandPublicId });
    const settled = await world.runtime.mutation(settleCommand, {
      authority,
      commandPublicId,
      resultCode: "STOPPED",
      resultDigest: "f".repeat(64),
      state: "applied",
    });
    expect(settled).toMatchObject({ state: "applied" });
    expect(await world.runtime.mutation(settleCommand, {
      authority,
      commandPublicId,
      resultCode: "STOPPED",
      resultDigest: "f".repeat(64),
      state: "applied",
    })).toMatchObject({ replay: true, state: "applied" });

    const expiredPublicId = uuidV7(now, "d");
    await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_12345678",
      idempotencyKey: uuidV7(now, "e"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: expiredPublicId,
      requestDigest: "7".repeat(64),
      sessionPublicId: "session_12345678",
    });
    await world.testRuntime.run(async (ctx) => {
      const commands = await ctx.db.query("sessionCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", expiredPublicId))
        .collect();
      const command = commands[0];
      if (command === undefined) throw new Error("missing expired command fixture");
      await ctx.db.patch(command._id, { deadline: Date.now() - 1 });
    });
    expect(await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId: expiredPublicId,
      localPhase: "prepared_no_effect",
    })).toMatchObject({ state: "expired" });
    await expectPromiseToReject(world.runtime.mutation(markEffectStarted, {
      authority,
      commandPublicId: expiredPublicId,
    }), "Cloud authority is not current");

    for (const [suffix, recover] of [["f", "prepare"], ["0", "mark"]] as const) {
      const preparedPublicId = uuidV7(now, suffix);
      await world.runtime.mutation(enqueueCommand, {
        deadline: now + 60_000,
        expectedTargetDevicePublicId: "device_12345678",
        idempotencyKey: uuidV7(now, `${suffix}1`),
        kind: "stop",
        payload: encryptedEnvelope,
        publicId: preparedPublicId,
        requestDigest: suffix.repeat(64),
        sessionPublicId: "session_12345678",
      });
      await world.runtime.mutation(prepareCommand, {
        authority,
        commandPublicId: preparedPublicId,
        localPhase: "prepared_no_effect",
      });
      await world.testRuntime.run(async (ctx) => {
        const commands = await ctx.db.query("sessionCommands")
          .withIndex("by_public_id", (builder) => builder.eq("publicId", preparedPublicId))
          .collect();
        const command = commands[0];
        if (command === undefined) throw new Error("missing prepared expiry fixture");
        await ctx.db.patch(command._id, { deadline: Date.now() - 1 });
      });
      const expired = recover === "prepare"
        ? await world.runtime.mutation(prepareCommand, {
            authority,
            commandPublicId: preparedPublicId,
            localPhase: "prepared_no_effect",
          })
        : await world.runtime.mutation(markEffectStarted, {
            authority,
            commandPublicId: preparedPublicId,
          });
      expect(expired).toMatchObject({ state: "expired" });
    }
  });

  test("an auth epoch change immediately invalidates a bound device", async () => {
    const world = await authenticatedWorld();
    const now = Date.now();
    await world.runtime.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: uuidV7(now, "5"),
      keyVersion: 1,
      publicId: "device_87654321",
      requestDigest: "1".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    });
    await world.testRuntime.run(async (ctx) => {
      const subjects = await ctx.db
        .query("authSubjects")
        .withIndex("by_user", (builder) =>
          builder.eq("userId", world.ids.userId))
        .collect();
      const subject = subjects[0];
      if (subject === undefined) throw new Error("missing subject fixture");
      await ctx.db.patch(subject._id, { authEpoch: 2, updatedAt: Date.now() });
    });
    await expectPromiseToReject(world.runtime.mutation(createSession, {
      idempotencyKey: uuidV7(now, "6"),
      publicId: "session_87654321",
      requestDigest: "2".repeat(64),
    }), "Cloud authority is not current");
  });

  test("atomically refuses terminal state while any command effect remains unsettled", async () => {
    const world = await authenticatedWorld();
    const now = Date.now();
    await world.runtime.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: uuidV7(now, "71"),
      keyVersion: 1,
      publicId: "device_terminal1",
      requestDigest: "a".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    });
    await world.runtime.mutation(createSession, {
      idempotencyKey: uuidV7(now, "72"),
      publicId: "session_terminal1",
      requestDigest: "b".repeat(64),
    });
    const lease = await world.runtime.mutation(acquireLease, {
      bootGeneration: 1,
      bootId: "boot_terminal1",
      leaseDurationMs: 30_000,
      sessionPublicId: "session_terminal1",
    }) as Readonly<{ bootGeneration: number; bootId: string; fence: number }>;
    const authority = {
      bootGeneration: lease.bootGeneration,
      bootId: lease.bootId,
      fence: lease.fence,
    };
    const commandPublicId = uuidV7(now, "73");
    await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_terminal1",
      idempotencyKey: uuidV7(now, "74"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: commandPublicId,
      requestDigest: "c".repeat(64),
      sessionPublicId: "session_terminal1",
    });

    const terminalRequest = {
      authority,
      expectedState: "active",
      sessionPublicId: "session_terminal1",
      state: "terminal",
    } as const;
    await expectPromiseToReject(
      world.runtime.mutation(updateSessionState, terminalRequest),
      "SESSION_COMMANDS_UNSETTLED",
    );
    await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId,
      localPhase: "prepared_no_effect",
    });
    await expectPromiseToReject(
      world.runtime.mutation(updateSessionState, terminalRequest),
      "SESSION_COMMANDS_UNSETTLED",
    );
    await world.runtime.mutation(markEffectStarted, { authority, commandPublicId });
    await expectPromiseToReject(
      world.runtime.mutation(updateSessionState, terminalRequest),
      "SESSION_COMMANDS_UNSETTLED",
    );
    await world.runtime.mutation(settleCommand, {
      authority,
      commandPublicId,
      resultCode: "STOPPED",
      resultDigest: "d".repeat(64),
      state: "applied",
    });
    expect(await world.runtime.mutation(updateSessionState, terminalRequest)).toMatchObject({
      replay: false,
      state: "terminal",
    });
    expect(await world.runtime.query(getSessionHead, {
      publicId: "session_terminal1",
    })).toMatchObject({ state: "terminal" });
  });

  test("a newer same-daemon fence closes an effect-started command as ambiguous without replay", async () => {
    const world = await authenticatedWorld();
    const now = Date.now();
    await world.runtime.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: uuidV7(now, "7"),
      keyVersion: 1,
      publicId: "device_recovery1",
      requestDigest: "3".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    });
    await world.runtime.mutation(createSession, {
      idempotencyKey: uuidV7(now, "8"),
      publicId: "session_recovery1",
      requestDigest: "4".repeat(64),
    });
    const firstLease = await world.runtime.mutation(acquireLease, {
      bootGeneration: 1,
      bootId: "boot_recovery1",
      leaseDurationMs: 30_000,
      sessionPublicId: "session_recovery1",
    }) as Readonly<{ bootGeneration: number; bootId: string; fence: number }>;
    const commandPublicId = uuidV7(now, "9");
    await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_recovery1",
      idempotencyKey: uuidV7(now, "a"),
      kind: "send",
      payload: encryptedEnvelope,
      publicId: commandPublicId,
      requestDigest: "5".repeat(64),
      sessionPublicId: "session_recovery1",
    });
    const staleAuthority = {
      bootGeneration: firstLease.bootGeneration,
      bootId: firstLease.bootId,
      fence: firstLease.fence,
    };
    await world.runtime.mutation(prepareCommand, {
      authority: staleAuthority,
      commandPublicId,
      localPhase: "prepared_no_effect",
    });
    await world.runtime.mutation(markEffectStarted, {
      authority: staleAuthority,
      commandPublicId,
    });
    await world.testRuntime.run(async (ctx) => {
      const leases = await ctx.db.query("executionLeases").collect();
      const lease = leases[0];
      if (lease === undefined) throw new Error("missing lease fixture");
      await ctx.db.patch(lease._id, { leaseUntil: Date.now() - 1 });
    });
    const recoveryLease = await world.runtime.mutation(acquireLease, {
      bootGeneration: 1,
      bootId: "boot_recovery1",
      leaseDurationMs: 30_000,
      sessionPublicId: "session_recovery1",
    }) as Readonly<{ bootGeneration: number; bootId: string; fence: number }>;
    expect(recoveryLease.fence).toBe(firstLease.fence + 1);
    const recoveryAuthority = {
      bootGeneration: recoveryLease.bootGeneration,
      bootId: recoveryLease.bootId,
      fence: recoveryLease.fence,
    };
    const recovered = await world.runtime.mutation(recoverEffectStarted, {
      commandPublicId,
      recoveryAuthority,
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      resultDigest: "6".repeat(64),
      staleAuthority,
      state: "ambiguous",
    });
    expect(recovered).toMatchObject({ replay: false, state: "ambiguous" });
    expect(await world.runtime.mutation(recoverEffectStarted, {
      commandPublicId,
      recoveryAuthority,
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      resultDigest: "6".repeat(64),
      staleAuthority,
      state: "ambiguous",
    })).toMatchObject({ replay: true, state: "ambiguous" });
  });
});
