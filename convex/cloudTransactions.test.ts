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
const approveDevice = makeFunctionReference<"mutation", Args, unknown>("devices:approve");
const getDevice = makeFunctionReference<"query", Args, unknown>("devices:get");
const updateRegistry = makeFunctionReference<"mutation", Args, unknown>("devices:updateRegistry");
const listDevicePage = makeFunctionReference<"query", Args, unknown>("devices:listPage");
const accountCurrent = makeFunctionReference<"query", Args, unknown>("account:current");
const createSession = makeFunctionReference<"mutation", Args, unknown>("sessions:create");
const getSessionHead = makeFunctionReference<"query", Args, unknown>("sessions:getHead");
const updateSessionState = makeFunctionReference<"mutation", Args, unknown>(
  "sessions:updateState",
);
const appendSessionChunk = makeFunctionReference<"mutation", Args, unknown>(
  "sessions:appendChunk",
);
const beginCompactEpoch = makeFunctionReference<"mutation", Args, unknown>(
  "sessions:beginCompactEpoch",
);
const acquireLease = makeFunctionReference<"mutation", Args, unknown>("leases:acquire");
const heartbeatLease = makeFunctionReference<"mutation", Args, unknown>("leases:heartbeat");
const enqueueCommand = makeFunctionReference<"mutation", Args, unknown>("commands:enqueue");
const getCommand = makeFunctionReference<"query", Args, unknown>("commands:get");
const getCommandForOutboxRecovery = makeFunctionReference<"query", Args, unknown>(
  "commands:getForOutboxRecovery",
);
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
const failPreparedCommand = makeFunctionReference<"mutation", Args, unknown>(
  "commands:failPrepared",
);
const confirmCommandTerminalRecovery = makeFunctionReference<"mutation", Args, unknown>(
  "commands:confirmTerminalRecovery",
);
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
const transitionAuthAdmission = makeFunctionReference<"mutation", Args, unknown>(
  "admissionControl:transition",
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

async function sessionCommandWriteState(world: Awaited<ReturnType<typeof authenticatedWorld>>) {
  return await world.testRuntime.run(async (ctx) => ({
    commands: await ctx.db.query("sessionCommands").collect(),
    securityEvents: await ctx.db.query("securityEvents").collect(),
    storage: await ctx.db.query("storageUsageByUser").collect(),
    userResources: await ctx.db.query("storageResourceUsageByUser").collect(),
  }));
}

describe("cloud transactions", () => {
  test("admits session command versions per target and binds executable transitions", async () => {
    const world = await authenticatedWorld();
    const now = Date.now();
    await world.runtime.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: uuidV7(now, "c001"),
      keyVersion: 1,
      publicId: "device_command_version",
      requestDigest: "1".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    });
    await world.runtime.mutation(createSession, {
      idempotencyKey: uuidV7(now, "c002"),
      publicId: "session_command_version",
      requestDigest: "2".repeat(64),
    });
    const lease = await world.runtime.mutation(acquireLease, {
      bootGeneration: 1,
      bootId: "boot_command_version",
      leaseDurationMs: 30_000,
      sessionPublicId: "session_command_version",
    }) as Readonly<{ bootGeneration: number; bootId: string; fence: number }>;
    const authority = {
      bootGeneration: lease.bootGeneration,
      bootId: lease.bootId,
      fence: lease.fence,
    };
    const legacy = {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_command_version",
      idempotencyKey: uuidV7(now, "c003"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: uuidV7(now, "c004"),
      requestDigest: "3".repeat(64),
      sessionPublicId: "session_command_version",
    } as const;
    expect(await world.runtime.mutation(enqueueCommand, legacy))
      .toMatchObject({ replay: false });

    const currentWhileAbsent = {
      ...legacy,
      expectedRequestingDevicePublicId: "device_command_version",
      idempotencyKey: uuidV7(now, "c005"),
      publicId: uuidV7(now, "c006"),
      requestCommitmentVersion: 2,
      requestDigest: "4".repeat(64),
    } as const;
    const beforeAbsentMismatch = await sessionCommandWriteState(world);
    await expectPromiseToReject(
      world.runtime.mutation(enqueueCommand, currentWhileAbsent),
      "COMMAND_REQUEST_VERSION_UNSUPPORTED",
    );
    expect(await sessionCommandWriteState(world)).toEqual(beforeAbsentMismatch);

    await world.runtime.mutation(updateRegistry, {
      commandRequestVersion: 2,
      envelope: encryptedEnvelope,
      expectedRevision: 0,
      keyVersion: 1,
    });
    expect(await world.runtime.mutation(enqueueCommand, legacy))
      .toMatchObject({ publicId: legacy.publicId, replay: true });
    await expectPromiseToReject(world.runtime.mutation(enqueueCommand, {
      ...legacy,
      expectedRequestingDevicePublicId: "device_command_version",
      requestCommitmentVersion: 2,
    }), "IDEMPOTENCY_CONFLICT");

    const current = {
      ...currentWhileAbsent,
      idempotencyKey: uuidV7(now, "c007"),
      publicId: uuidV7(now, "c008"),
      requestDigest: "5".repeat(64),
    } as const;
    expect(await world.runtime.mutation(enqueueCommand, current))
      .toMatchObject({ replay: false, requestCommitmentVersion: 2 });
    const legacyWhileCurrent = {
      ...legacy,
      idempotencyKey: uuidV7(now, "c009"),
      publicId: uuidV7(now, "c00a"),
      requestDigest: "6".repeat(64),
    } as const;
    const beforeCurrentMismatch = await sessionCommandWriteState(world);
    await expectPromiseToReject(
      world.runtime.mutation(enqueueCommand, legacyWhileCurrent),
      "COMMAND_REQUEST_VERSION_UNSUPPORTED",
    );
    expect(await sessionCommandWriteState(world)).toEqual(beforeCurrentMismatch);

    const beforeOldExecutor = await sessionCommandWriteState(world);
    await expectPromiseToReject(world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId: current.publicId,
      localPhase: "prepared_no_effect",
    }), "COMMAND_EXECUTOR_VERSION_UNSUPPORTED");
    expect(await sessionCommandWriteState(world)).toEqual(beforeOldExecutor);
    await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId: current.publicId,
      executorRequestVersion: 2,
      localPhase: "prepared_no_effect",
    });
    const beforeOldEffect = await sessionCommandWriteState(world);
    await expectPromiseToReject(world.runtime.mutation(markEffectStarted, {
      authority,
      commandPublicId: current.publicId,
    }), "COMMAND_EXECUTOR_VERSION_UNSUPPORTED");
    expect(await sessionCommandWriteState(world)).toEqual(beforeOldEffect);
    await world.runtime.mutation(markEffectStarted, {
      authority,
      commandPublicId: current.publicId,
      executorRequestVersion: 2,
    });

    await world.runtime.mutation(updateRegistry, {
      envelope: encryptedEnvelope,
      expectedRevision: 1,
      keyVersion: 1,
    });
    expect(await world.runtime.mutation(enqueueCommand, current))
      .toMatchObject({ publicId: current.publicId, replay: true });
    const legacyShape: Record<string, Value> = { ...current };
    delete legacyShape.expectedRequestingDevicePublicId;
    delete legacyShape.requestCommitmentVersion;
    await expectPromiseToReject(
      world.runtime.mutation(enqueueCommand, legacyShape),
      "IDEMPOTENCY_CONFLICT",
    );

    await expectPromiseToReject(world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId: legacy.publicId,
      executorRequestVersion: 2,
      localPhase: "prepared_no_effect",
    }), "COMMAND_EXECUTOR_VERSION_UNSUPPORTED");
    await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId: legacy.publicId,
      localPhase: "prepared_no_effect",
    });
    await expectPromiseToReject(world.runtime.mutation(markEffectStarted, {
      authority,
      commandPublicId: legacy.publicId,
      executorRequestVersion: 2,
    }), "COMMAND_EXECUTOR_VERSION_UNSUPPORTED");
    await world.runtime.mutation(markEffectStarted, {
      authority,
      commandPublicId: legacy.publicId,
    });
  });

  test("recovers an old requester outbox proof after the active local device changes", async () => {
    const world = await authenticatedWorld();
    const now = Date.now();
    await world.runtime.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: uuidV7(now, "b01"),
      keyVersion: 1,
      publicId: "device_old_requester",
      requestDigest: "1".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    });
    const newAuthSessionId = await world.testRuntime.run(async (ctx) =>
      await ctx.db.insert("authSessions", {
        expirationTime: now + 60 * 60 * 1_000,
        userId: world.ids.userId,
      }));
    const newDevice = world.testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${world.ids.userId}|${newAuthSessionId}`,
      tokenIdentifier: `test|${newAuthSessionId}`,
    });
    await newDevice.mutation(register, {
      deviceClass: "browser",
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: uuidV7(now, "b02"),
      keyVersion: 1,
      publicId: "device_new_requester",
      requestDigest: "2".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    });
    await world.runtime.mutation(approveDevice, {
      expectedRevision: 1,
      idempotencyKey: uuidV7(now, "b03"),
      keyEnvelope: wrappedKeyEnvelope,
      requestDigest: "3".repeat(64),
      targetPublicId: "device_new_requester",
    });
    await world.runtime.mutation(createSession, {
      idempotencyKey: uuidV7(now, "b04"),
      publicId: "session_outbox_rollover",
      requestDigest: "4".repeat(64),
    });
    const commandPublicId = uuidV7(now, "b05");
    const idempotencyKey = uuidV7(now, "b06");
    const requestDigest = "5".repeat(64);
    await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_old_requester",
      idempotencyKey,
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: commandPublicId,
      requestDigest,
      sessionPublicId: "session_outbox_rollover",
    });

    await expectPromiseToReject(
      newDevice.query(getCommand, { commandPublicId }),
      "Cloud authority is not current",
    );
    expect(await newDevice.query(getCommandForOutboxRecovery, {
      commandPublicId,
      idempotencyKey,
      requestDigest,
    })).toMatchObject({
      publicId: commandPublicId,
      requestDigest,
      requestingDevicePublicId: "device_old_requester",
      sessionPublicId: "session_outbox_rollover",
      state: "pending",
      targetDevicePublicId: "device_old_requester",
    });
    expect(await newDevice.query(getCommandForOutboxRecovery, {
      commandPublicId,
      idempotencyKey: uuidV7(now, "b08"),
      requestDigest,
    })).toBeNull();
    expect(await newDevice.query(getCommandForOutboxRecovery, {
      commandPublicId,
      idempotencyKey,
      requestDigest: "6".repeat(64),
    })).toBeNull();
    expect(await newDevice.query(getCommandForOutboxRecovery, {
      commandPublicId: uuidV7(now, "b07"),
      idempotencyKey,
      requestDigest,
    })).toBeNull();
    const outsiderIds = await world.testRuntime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: "outbox-outsider@example.com",
        emailVerificationTime: now,
      });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing outsider quota fixture user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      const authSessionId = await ctx.db.insert("authSessions", {
        expirationTime: now + 60 * 60 * 1_000,
        userId,
      });
      await ctx.db.insert("authSubjects", {
        authEpoch: 1,
        createdAt: now,
        emailDigest: "7".repeat(64),
        status: "active",
        updatedAt: now,
        userId,
      });
      return { authSessionId, userId };
    });
    const outsider = world.testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${outsiderIds.userId}|${outsiderIds.authSessionId}`,
      tokenIdentifier: `test|${outsiderIds.authSessionId}`,
    });
    await outsider.mutation(register, {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: uuidV7(now, "c01"),
      keyVersion: 1,
      publicId: "device_outbox_outsider",
      requestDigest: "8".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    });
    expect(await outsider.query(getCommandForOutboxRecovery, {
      commandPublicId,
      idempotencyKey,
      requestDigest,
    })).toBeNull();
    await expectPromiseToReject(newDevice.mutation(acknowledgeCommand, {
      commandPublicId,
      idempotencyKey,
      requestDigest,
    }), "Cloud authority is not current");
    expect(await world.testRuntime.run(async (ctx) => {
      const row = (await ctx.db.query("sessionCommands").collect())
        .find((command) => command.publicId === commandPublicId);
      return row?.requesterAcknowledgedAt;
    })).toBeNull();
  });

  test("auth freeze blocks new device credentials but preserves exact registration replay", async () => {
    const world = await authenticatedWorld();
    const now = Date.now();
    const registration = {
      bootstrapKeyEnvelope: wrappedKeyEnvelope,
      encryptedLabel: encryptedEnvelope,
      idempotencyKey: uuidV7(now, "ad01"),
      keyVersion: 1,
      publicId: "device_admission1",
      requestDigest: "e".repeat(64),
      signingPublicKey: publicKey,
      wrappingPublicKey: publicKey,
    } as const;
    await world.testRuntime.mutation(transitionAuthAdmission, {
      expectedGeneration: 0,
      mutationId: uuidV7(now, "ad02"),
      state: "frozen",
    });
    await expectPromiseToReject(
      world.runtime.mutation(register, registration),
      "AUTH_ADMISSION_FROZEN",
    );
    await world.testRuntime.mutation(transitionAuthAdmission, {
      expectedGeneration: 1,
      mutationId: uuidV7(now, "ad03"),
      state: "open",
    });
    const registered = await world.runtime.mutation(register, registration);
    await world.testRuntime.mutation(transitionAuthAdmission, {
      expectedGeneration: 2,
      mutationId: uuidV7(now, "ad04"),
      state: "frozen",
    });
    expect(await world.runtime.mutation(register, registration)).toEqual(registered);
  });

  test("fences one encrypted command effect under an exact device and lease", async () => {
    const world = await authenticatedWorld();
    const now = Date.now();
    expect(await world.runtime.query(accountCurrent, {})).toEqual({
      authEpoch: 1,
      device: null,
      hasActiveDevices: false,
      userPublicId: String(world.ids.userId),
    });
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
    expect(await world.runtime.query(accountCurrent, {})).toEqual({
      authEpoch: 1,
      device: {
        credentialGeneration: 1,
        keyVersion: 1,
        publicId: "device_12345678",
        revision: 1,
        status: "active",
      },
      hasActiveDevices: true,
      userPublicId: String(world.ids.userId),
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
    expect(await secondAuthSession.query(accountCurrent, {})).toEqual({
      authEpoch: 1,
      device: {
        credentialGeneration: 1,
        keyVersion: 1,
        publicId: "device_12345678",
        revision: 1,
        status: "active",
      },
      hasActiveDevices: true,
      userPublicId: String(world.ids.userId),
    });
    expect(await world.testRuntime.run(async (ctx) =>
      (await ctx.db.query("devices").collect()).length)).toBe(1);
    expect(await world.runtime.query(getDevice, { publicId: "device_12345678" }))
      .toMatchObject({ publicId: "device_12345678", status: "active" });
    expect(await world.runtime.query(listDevicePage, {
      paginationOpts: { cursor: null, numItems: 100 },
    })).toMatchObject({
      isDone: true,
      page: [{
        publicId: "device_12345678",
        userPublicId: String(world.ids.userId),
      }],
      userPublicId: String(world.ids.userId),
    });

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
    await world.runtime.mutation(updateRegistry, {
      commandRequestVersion: 2,
      envelope: encryptedEnvelope,
      expectedRevision: 0,
      keyVersion: 1,
    });
    const currentCommandRequest = {
      deadline: now + 60_000,
      expectedRequestingDevicePublicId: "device_12345678",
      expectedTargetDevicePublicId: "device_12345678",
      idempotencyKey: uuidV7(now, "4"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: commandPublicId,
      requestCommitmentVersion: 2,
      requestDigest: "e".repeat(64),
      sessionPublicId: "session_12345678",
    } as const;
    expect(await world.runtime.mutation(enqueueCommand, currentCommandRequest)).toMatchObject({
      publicId: commandPublicId,
      requestCommitmentVersion: 2,
      requestingDevicePublicId: "device_12345678",
      sessionPublicId: "session_12345678",
      state: "pending",
      targetDevicePublicId: "device_12345678",
    });
    expect(await world.runtime.query(getCommand, { commandPublicId })).toMatchObject({
      publicId: commandPublicId,
      requestCommitmentVersion: 2,
      requestingDevicePublicId: "device_12345678",
    });
    await expectPromiseToReject(world.runtime.mutation(enqueueCommand, {
      ...currentCommandRequest,
      expectedRequestingDevicePublicId: "device_stale000",
      idempotencyKey: uuidV7(now, "41"),
      publicId: uuidV7(now, "42"),
    }), "Cloud authority is not current");
    const legacyReplay: Record<string, Value> = { ...currentCommandRequest };
    delete legacyReplay.expectedRequestingDevicePublicId;
    delete legacyReplay.requestCommitmentVersion;
    await expectPromiseToReject(
      world.runtime.mutation(enqueueCommand, legacyReplay),
      "IDEMPOTENCY_CONFLICT",
    );
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
    })).toMatchObject({
      isDone: true,
      page: [{ publicId: commandPublicId, requestCommitmentVersion: 2 }],
    });
    const schedulingPage = await world.runtime.query(listNonterminalCommandPage, {
      paginationOpts: { cursor: null, numItems: 100 },
    });
    expect(schedulingPage).toMatchObject({
      isDone: true,
      page: [{ publicId: commandPublicId, requestCommitmentVersion: 2 }],
    });
    expect(JSON.stringify(schedulingPage)).not.toContain('"payload"');
    const authority = {
      bootGeneration: lease.bootGeneration,
      bootId: lease.bootId,
      fence: lease.fence,
    };
    await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId,
      executorRequestVersion: 2,
      localPhase: "prepared_no_effect",
    });
    await world.runtime.mutation(markEffectStarted, {
      authority,
      commandPublicId,
      executorRequestVersion: 2,
    });
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
    await world.runtime.mutation(updateRegistry, {
      envelope: encryptedEnvelope,
      expectedRevision: 1,
      keyVersion: 1,
    });

    const rejectedPublicId = uuidV7(now, "a1");
    await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_12345678",
      idempotencyKey: uuidV7(now, "a2"),
      kind: "set_model",
      payload: encryptedEnvelope,
      publicId: rejectedPublicId,
      requestDigest: "8".repeat(64),
      sessionPublicId: "session_12345678",
    });
    await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId: rejectedPublicId,
      localPhase: "prepared_no_effect",
    });
    const preparedFailure = {
      authority,
      commandPublicId: rejectedPublicId,
      resultCode: "INVALID_COMMAND_PAYLOAD_BEFORE_EFFECT",
      resultDigest: "9".repeat(64),
    };
    expect(await world.runtime.mutation(failPreparedCommand, preparedFailure))
      .toMatchObject({ replay: false, state: "failed" });
    expect(await world.runtime.mutation(failPreparedCommand, preparedFailure))
      .toMatchObject({ replay: true, state: "failed" });
    await expectPromiseToReject(world.runtime.mutation(failPreparedCommand, {
      ...preparedFailure,
      resultDigest: "0".repeat(64),
    }), "COMMAND_RESULT_CONFLICT");
    await expectPromiseToReject(world.runtime.mutation(markEffectStarted, {
      authority,
      commandPublicId: rejectedPublicId,
    }), "COMMAND_TRANSITION_CONFLICT");
    expect(await world.testRuntime.run(async (ctx) => {
      const commands = await ctx.db.query("sessionCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", rejectedPublicId))
        .collect();
      const command = commands[0];
      if (command === undefined) throw new Error("missing ordinary prepared failure fixture");
      return {
        requesterAcknowledgedAt: command.requesterAcknowledgedAt,
        terminalCleanupAfter: command.terminalCleanupAfter,
      };
    })).toEqual({
      requesterAcknowledgedAt: undefined,
      terminalCleanupAfter: undefined,
    });

    const legacyRejectedPublicId = uuidV7(now, "a5");
    await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_12345678",
      idempotencyKey: uuidV7(now, "a6"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: legacyRejectedPublicId,
      requestDigest: "5".repeat(64),
      sessionPublicId: "session_12345678",
    });
    await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId: legacyRejectedPublicId,
      localPhase: "prepared_no_effect",
    });
    expect(await world.runtime.mutation(failPreparedCommand, {
      authority,
      commandPublicId: legacyRejectedPublicId,
      resultCode: "LEGACY_REQUEST_COMMITMENT_BEFORE_EFFECT",
      resultDigest: "4".repeat(64),
    })).toMatchObject({ replay: false, state: "failed" });
    const legacyFailure = await world.testRuntime.run(async (ctx) => {
      const commands = await ctx.db.query("sessionCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", legacyRejectedPublicId))
        .collect();
      const command = commands[0];
      if (command === undefined) throw new Error("missing legacy prepared failure fixture");
      return {
        requesterAcknowledgedAt: command.requesterAcknowledgedAt,
        resultCode: command.resultCode,
        terminalCleanupAfter: command.terminalCleanupAfter,
      };
    });
    expect(legacyFailure).toMatchObject({
      resultCode: "LEGACY_REQUEST_COMMITMENT_BEFORE_EFFECT",
      terminalCleanupAfter: expect.any(Number),
    });
    expect(legacyFailure.requesterAcknowledgedAt).toBeUndefined();

    const rejectedExpiredPublicId = uuidV7(now, "a3");
    await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_12345678",
      idempotencyKey: uuidV7(now, "a4"),
      kind: "set_model",
      payload: encryptedEnvelope,
      publicId: rejectedExpiredPublicId,
      requestDigest: "6".repeat(64),
      sessionPublicId: "session_12345678",
    });
    await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId: rejectedExpiredPublicId,
      localPhase: "prepared_no_effect",
    });
    await world.testRuntime.run(async (ctx) => {
      const commands = await ctx.db.query("sessionCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", rejectedExpiredPublicId))
        .collect();
      const command = commands[0];
      if (command === undefined) throw new Error("missing prepared failure expiry fixture");
      await ctx.db.patch(command._id, { deadline: Date.now() - 1 });
    });
    const expiryFailure = { ...preparedFailure, commandPublicId: rejectedExpiredPublicId };
    expect(await world.runtime.mutation(failPreparedCommand, expiryFailure))
      .toMatchObject({ replay: false, state: "expired" });
    expect(await world.runtime.mutation(failPreparedCommand, expiryFailure))
      .toMatchObject({ replay: true, state: "expired" });

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

    await world.runtime.mutation(updateRegistry, {
      commandRequestVersion: 2,
      envelope: encryptedEnvelope,
      expectedRevision: 2,
      keyVersion: 1,
    });
    const cancelledRecoveryPublicId = uuidV7(now, "c1");
    await world.runtime.mutation(enqueueCommand, {
      ...currentCommandRequest,
      idempotencyKey: uuidV7(now, "c2"),
      publicId: cancelledRecoveryPublicId,
      requestDigest: "c".repeat(64),
    });
    await world.runtime.mutation(prepareCommand, {
      authority,
      commandPublicId: cancelledRecoveryPublicId,
      executorRequestVersion: 2,
      localPhase: "prepared_no_effect",
    });
    const setCancelledRecoveryEvidence = async (resultCode?: string) => {
      await world.testRuntime.run(async (ctx) => {
        const command = await ctx.db.query("sessionCommands")
          .withIndex("by_public_id", (builder) => builder.eq("publicId", cancelledRecoveryPublicId))
          .unique();
        if (command === null) throw new Error("missing terminal recovery fixture");
        await ctx.db.patch(command._id, {
          nonterminal: false,
          resultCode,
          state: "cancelled",
          terminalResultless: true,
          updatedAt: Date.now(),
        });
      });
    };
    await setCancelledRecoveryEvidence("CANCELLED_WITH_EVIDENCE");
    await expectPromiseToReject(world.runtime.mutation(confirmCommandTerminalRecovery, {
      commandPublicId: cancelledRecoveryPublicId,
      localPhase: "prepared_no_effect",
      staleAuthority: authority,
    }), "COMMAND_TERMINAL_RECOVERY_CONFLICT");
    await setCancelledRecoveryEvidence();
    await expectPromiseToReject(world.runtime.mutation(confirmCommandTerminalRecovery, {
      commandPublicId: cancelledRecoveryPublicId,
      localPhase: "prepared_no_effect",
      staleAuthority: { ...authority, fence: authority.fence + 1 },
    }), "COMMAND_TERMINAL_RECOVERY_CONFLICT");
    expect(await world.runtime.mutation(confirmCommandTerminalRecovery, {
      commandPublicId: cancelledRecoveryPublicId,
      localPhase: "prepared_no_effect",
      staleAuthority: authority,
    })).toEqual({
      publicId: cancelledRecoveryPublicId,
      replay: true,
      state: "cancelled",
    });
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

  test("closes terminal commands and state while exact-origin compact tails remain appendable", async () => {
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

    const terminalTailDigest = "e".repeat(64);
    expect(await world.runtime.mutation(appendSessionChunk, {
      authority,
      digest: terminalTailDigest,
      envelope: encryptedEnvelope,
      expectedHeadSequence: 0,
      expectedStreamEpoch: 0,
      firstSequence: 1,
      lastSequence: 1,
      sessionPublicId: "session_terminal1",
      stream: "compact",
    })).toEqual({
      digest: terminalTailDigest,
      headSequence: 1,
      replay: false,
      streamEpoch: 0,
    });
    expect(await world.runtime.mutation(heartbeatLease, {
      authority,
      fingerprint: "f".repeat(64),
      leaseDurationMs: 30_000,
      sequence: 1,
      sessionPublicId: "session_terminal1",
    })).toMatchObject({ heartbeatSequence: 1 });
    expect(await world.runtime.mutation(acquireLease, {
      bootGeneration: authority.bootGeneration,
      bootId: authority.bootId,
      leaseDurationMs: 30_000,
      sessionPublicId: "session_terminal1",
    })).toMatchObject({
      bootGeneration: authority.bootGeneration,
      bootId: authority.bootId,
      fence: authority.fence,
    });

    await expectPromiseToReject(world.runtime.mutation(updateSessionState, {
      authority,
      expectedState: "idle",
      sessionPublicId: "session_terminal1",
      state: "active",
    }), "SESSION_STATE_CONFLICT");
    await expectPromiseToReject(world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_terminal1",
      idempotencyKey: uuidV7(now, "75"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: uuidV7(now, "76"),
      requestDigest: "6".repeat(64),
      sessionPublicId: "session_terminal1",
    }), "Cloud authority is not current");
    await expectPromiseToReject(world.runtime.mutation(appendSessionChunk, {
      authority,
      digest: "7".repeat(64),
      envelope: encryptedEnvelope,
      expectedHeadSequence: 0,
      expectedStreamEpoch: 0,
      firstSequence: 1,
      lastSequence: 1,
      sessionPublicId: "session_terminal1",
      stream: "detail",
    }), "Cloud authority is not current");
    await expectPromiseToReject(world.runtime.mutation(beginCompactEpoch, {
      authority,
      epochPublicId: uuidV7(now, "77"),
      expectedCompactStreamEpoch: 0,
      expectedHeadSequence: 1,
      expectedTailDigest: terminalTailDigest,
      idempotencyKey: uuidV7(now, "78"),
      lineageCommitment: "terminal_lineage_commitment",
      requestDigest: "8".repeat(64),
      sessionPublicId: "session_terminal1",
    }), "Cloud authority is not current");

    await world.testRuntime.run(async (ctx) => {
      const leases = await ctx.db.query("executionLeases").collect();
      const terminalLease = leases[0];
      if (leases.length !== 1 || terminalLease === undefined) {
        throw new Error("missing terminal lease fixture");
      }
      await ctx.db.patch(terminalLease._id, { leaseUntil: Date.now() - 1 });
    });
    const reacquired = await world.runtime.mutation(acquireLease, {
      bootGeneration: 2,
      bootId: "boot_terminal2",
      leaseDurationMs: 30_000,
      sessionPublicId: "session_terminal1",
    }) as Readonly<{ bootGeneration: number; bootId: string; fence: number }>;
    const recoveryAuthority = {
      bootGeneration: reacquired.bootGeneration,
      bootId: reacquired.bootId,
      fence: reacquired.fence,
    };
    expect(recoveryAuthority.fence).toBeGreaterThan(authority.fence);
    const finalTailDigest = "9".repeat(64);
    expect(await world.runtime.mutation(appendSessionChunk, {
      authority: recoveryAuthority,
      digest: finalTailDigest,
      envelope: encryptedEnvelope,
      expectedHeadSequence: 1,
      expectedStreamEpoch: 0,
      expectedTailDigest: terminalTailDigest,
      firstSequence: 2,
      lastSequence: 2,
      previousDigest: terminalTailDigest,
      sessionPublicId: "session_terminal1",
      stream: "compact",
    })).toMatchObject({ headSequence: 2, replay: false });
    await expectPromiseToReject(world.runtime.mutation(appendSessionChunk, {
      authority,
      digest: "0".repeat(64),
      envelope: encryptedEnvelope,
      expectedHeadSequence: 2,
      expectedStreamEpoch: 0,
      expectedTailDigest: finalTailDigest,
      firstSequence: 3,
      lastSequence: 3,
      previousDigest: finalTailDigest,
      sessionPublicId: "session_terminal1",
      stream: "compact",
    }), "Cloud authority is not current");
    expect(await world.runtime.mutation(heartbeatLease, {
      authority: recoveryAuthority,
      fingerprint: "1".repeat(64),
      leaseDurationMs: 30_000,
      sequence: 1,
      sessionPublicId: "session_terminal1",
    })).toMatchObject({ heartbeatSequence: 1 });
    expect(await world.runtime.query(getSessionHead, {
      publicId: "session_terminal1",
    })).toMatchObject({
      compactHeadSequence: 2,
      compactTailDigest: finalTailDigest,
      state: "terminal",
    });
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
    const preparedOnlyPublicId = uuidV7(now, "b");
    await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_recovery1",
      idempotencyKey: uuidV7(now, "c"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: preparedOnlyPublicId,
      requestDigest: "7".repeat(64),
      sessionPublicId: "session_recovery1",
    });
    await world.runtime.mutation(prepareCommand, {
      authority: staleAuthority,
      commandPublicId: preparedOnlyPublicId,
      localPhase: "prepared_no_effect",
    });
    const nonAmbiguousPublicId = uuidV7(now, "d");
    await world.runtime.mutation(enqueueCommand, {
      deadline: now + 60_000,
      expectedTargetDevicePublicId: "device_recovery1",
      idempotencyKey: uuidV7(now, "e"),
      kind: "stop",
      payload: encryptedEnvelope,
      publicId: nonAmbiguousPublicId,
      requestDigest: "8".repeat(64),
      sessionPublicId: "session_recovery1",
    });
    await world.runtime.mutation(prepareCommand, {
      authority: staleAuthority,
      commandPublicId: nonAmbiguousPublicId,
      localPhase: "prepared_no_effect",
    });
    await world.runtime.mutation(markEffectStarted, {
      authority: staleAuthority,
      commandPublicId: nonAmbiguousPublicId,
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
    await expectPromiseToReject(world.runtime.mutation(recoverEffectStarted, {
      commandPublicId: preparedOnlyPublicId,
      recoveryAuthority,
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      resultDigest: "7".repeat(64),
      staleAuthority,
      state: "ambiguous",
    }));
    await expectPromiseToReject(world.runtime.mutation(recoverEffectStarted, {
      commandPublicId: nonAmbiguousPublicId,
      recoveryAuthority,
      resultCode: "APPLIED",
      resultDigest: "8".repeat(64),
      staleAuthority,
      state: "applied",
    }));
    expect(await world.runtime.query(getCommand, {
      commandPublicId: preparedOnlyPublicId,
    })).toMatchObject({ state: "prepared" });
    expect(await world.runtime.query(getCommand, {
      commandPublicId: nonAmbiguousPublicId,
    })).toMatchObject({ state: "effect_started" });
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
