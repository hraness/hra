import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { commandTerminalRetentionMs } from "./commands";
import {
  adjustQuotaForPatch,
  initializeAccountUsageQuotaAuthority,
  initializeUserQuotaAuthority,
  reserveCodexAccountQuotaForInsert,
  reserveDeviceQuotaForInsert,
  reserveNonterminalCommandQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveSessionHeadQuotaForInsert,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type DrainResult = Readonly<{
  category?: string;
  jobId?: string;
  kind: "advanced" | "complete" | "drained" | "idle";
  processed: number;
  state?: string;
}>;

const revokeDevice = makeFunctionReference<"mutation", Args, Readonly<{
  deviceClass: "daemon" | "browser";
  publicId: string;
  revision: number;
  status: "revoked";
}>>("devices:revoke");
const listDevices = makeFunctionReference<"query", Args, readonly Readonly<{
  online: boolean;
  publicId: string;
  status: string;
}>[]>("devices:list");
const heartbeatPresence = makeFunctionReference<"mutation", Args, unknown>(
  "presence:heartbeat",
);
const acquireLease = makeFunctionReference<"mutation", Args, unknown>("leases:acquire");
const revocationStatus = makeFunctionReference<"query", Args, Readonly<{
  category: string;
  createdAt: number;
  jobId: string;
  state: string;
  targetPublicId: string;
  updatedAt: number;
}>>("deviceRevocation:status");
const drainRevocations = makeFunctionReference<"mutation", Args, DrainResult>(
  "deviceRevocation:drain",
);
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const encryptedEnvelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "B".repeat(16),
};

const wrappedEnvelope = {
  algorithm: "P256-HKDF-SHA256+A256GCM" as const,
  ciphertext: "C".repeat(32),
  ephemeralPublicKey: "fixture-public-key",
  keyVersion: 1,
  nonce: "D".repeat(16),
};

function uuidV7(now: number, suffix: string): string {
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`;
}

async function revocationWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "revocation@example.com",
      emailVerificationTime: now,
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const actorAuthSession = {
      expirationTime: now + 60 * 60 * 1_000,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "identity", actorAuthSession);
    const actorAuthSessionId = await ctx.db.insert("authSessions", actorAuthSession);
    const targetAuthSession = {
      expirationTime: now + 60 * 60 * 1_000,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "identity", targetAuthSession);
    const targetAuthSessionId = await ctx.db.insert("authSessions", targetAuthSession);
    const subject = {
      authEpoch: 1,
      createdAt: now,
      emailDigest: "1".repeat(64),
      status: "active",
      updatedAt: now,
      userId,
    } as const;
    await reserveQuotaForInsert(ctx, userId, "identity", subject);
    await ctx.db.insert("authSubjects", subject);
    const actorDevice = {
      activatedAt: now,
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      encryptedLabel: encryptedEnvelope,
      keyVersion: 1,
      publicId: "device_actor001",
      revision: 1,
      signingPublicKey: "fixture",
      status: "active",
      updatedAt: now,
      userId,
      wrappingPublicKey: "fixture",
    } as const;
    await reserveDeviceQuotaForInsert(ctx, userId, actorDevice);
    const actorDeviceId = await ctx.db.insert("devices", actorDevice);
    const targetDevice = {
      activatedAt: now,
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      encryptedLabel: encryptedEnvelope,
      keyVersion: 1,
      publicId: "device_target01",
      revision: 1,
      signingPublicKey: "fixture",
      status: "active",
      updatedAt: now,
      userId,
      wrappingPublicKey: "fixture",
    } as const;
    await reserveDeviceQuotaForInsert(ctx, userId, targetDevice);
    const targetDeviceId = await ctx.db.insert("devices", targetDevice);
    const actorDeviceSession = {
      authEpoch: 1,
      authSessionId: actorAuthSessionId,
      boundAt: now,
      deviceId: actorDeviceId,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "custody", actorDeviceSession);
    await ctx.db.insert("deviceSessions", actorDeviceSession);
    const targetDeviceSession = {
      authEpoch: 1,
      authSessionId: targetAuthSessionId,
      boundAt: now,
      deviceId: targetDeviceId,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "custody", targetDeviceSession);
    const targetDeviceSessionId = await ctx.db.insert("deviceSessions", targetDeviceSession);
    const session = {
      compactHeadSequence: 0,
      createdAt: now,
      detailHeadSequence: 0,
      executionDeviceId: targetDeviceId,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: "session_revoke01",
      state: "idle",
      updatedAt: now,
      userId,
    } as const;
    await reserveSessionHeadQuotaForInsert(ctx, userId, session);
    const sessionId = await ctx.db.insert("sessionHeads", session);
    const lease = {
      bootGeneration: 1,
      bootId: "boot_revoke_01",
      deviceId: targetDeviceId,
      fence: 1,
      heartbeatFingerprint: "2".repeat(64),
      heartbeatSequence: 0,
      leaseUntil: now + 60_000,
      sessionId,
      updatedAt: now,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "session", lease);
    const leaseId = await ctx.db.insert("executionLeases", lease);
    const presence = {
      authEpoch: 1,
      connectionId: "presence_target_01",
      connectionSequence: 0,
      credentialGeneration: 1,
      deviceId: targetDeviceId,
      fingerprint: "3".repeat(64),
      observedAt: now,
      presenceUntil: now + 45_000,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "device", presence);
    const presenceId = await ctx.db.insert("devicePresence", presence);
    const account = {
      createdAt: now,
      encryptedMetadata: encryptedEnvelope,
      matchKey: "match_revoke_01",
      publicId: "account_revoke01",
      updatedAt: now,
      userId,
    };
    await reserveCodexAccountQuotaForInsert(ctx, userId, account);
    const accountId = await ctx.db.insert("codexAccounts", account);
    await initializeAccountUsageQuotaAuthority(ctx, userId, accountId);
    const accountBinding = {
      accountId,
      deviceId: targetDeviceId,
      encryptedLocalReference: encryptedEnvelope,
      lastSeenAt: now,
      sourceGeneration: 1,
      state: "present",
      updatedAt: now,
      userId,
    } as const;
    await reserveQuotaForInsert(ctx, userId, "account", accountBinding);
    const accountBindingId = await ctx.db.insert("deviceAccountBindings", accountBinding);
    const bindChallenge = {
      authSessionId: targetAuthSessionId,
      challengeId: "challenge_revoke01",
      createdAt: now,
      deviceId: targetDeviceId,
      expiresAt: now + 60_000,
      nonce: "nonce_revoke_01",
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "custody", bindChallenge);
    const bindChallengeId = await ctx.db.insert("deviceBindChallenges", bindChallenge);
    const keyEnvelope = {
      createdAt: now,
      deviceId: targetDeviceId,
      envelope: wrappedEnvelope,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "custody", keyEnvelope);
    const keyEnvelopeId = await ctx.db.insert("deviceKeyEnvelopes", keyEnvelope);
    return {
      accountBindingId,
      actorAuthSessionId,
      actorDeviceId,
      bindChallengeId,
      keyEnvelopeId,
      leaseId,
      presenceId,
      sessionId,
      targetAuthSessionId,
      targetDeviceId,
      targetDeviceSessionId,
      userId,
    };
  });
  return {
    ...ids,
    actor: testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${ids.userId}|${ids.actorAuthSessionId}`,
      tokenIdentifier: `test|${ids.actorAuthSessionId}`,
    }),
    revokeRequest: {
      expectedRevision: 1,
      idempotencyKey: uuidV7(now, "201"),
      requestDigest: "d".repeat(64),
      targetPublicId: "device_target01",
    },
    target: testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${ids.userId}|${ids.targetAuthSessionId}`,
      tokenIdentifier: `test|${ids.targetAuthSessionId}`,
    }),
    testRuntime,
  };
}

async function insertCommandFixtures(world: Awaited<ReturnType<typeof revocationWorld>>) {
  const now = Date.now();
  return await world.testRuntime.run(async (ctx) => {
    const base = {
      createdAt: now,
      deadline: now + 60_000,
      kind: "stop" as const,
      nonterminal: true,
      payload: encryptedEnvelope,
      requestingDeviceId: world.actorDeviceId,
      sessionId: world.sessionId,
      targetDeviceId: world.targetDeviceId,
      updatedAt: now,
      userId: world.userId,
    };
    const pending = {
      ...base,
      idempotencyKey: uuidV7(now, "301"),
      publicId: uuidV7(now, "311"),
      requestDigest: "4".repeat(64),
      state: "pending",
    } as const;
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, pending);
    const pendingId = await ctx.db.insert("sessionCommands", pending);
    const prepared = {
      ...base,
      idempotencyKey: uuidV7(now, "302"),
      publicId: uuidV7(now, "312"),
      requesterAcknowledgedAt: now - 1_000,
      requestDigest: "5".repeat(64),
      state: "prepared",
    } as const;
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, prepared);
    const preparedId = await ctx.db.insert("sessionCommands", prepared);
    const started = {
      ...base,
      idempotencyKey: uuidV7(now, "303"),
      publicId: uuidV7(now, "313"),
      requestDigest: "6".repeat(64),
      state: "effect_started",
      terminalCleanupAfter: now - 1,
    } as const;
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, started);
    const startedId = await ctx.db.insert("sessionCommands", started);

    const otherDevice = {
      activatedAt: now,
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      encryptedLabel: encryptedEnvelope,
      keyVersion: 1,
      publicId: "device_other001",
      revision: 1,
      signingPublicKey: "fixture",
      status: "active",
      updatedAt: now,
      userId: world.userId,
      wrappingPublicKey: "fixture",
    } as const;
    await reserveDeviceQuotaForInsert(ctx, world.userId, otherDevice);
    const otherDeviceId = await ctx.db.insert("devices", otherDevice);
    const requestedSession = {
      compactHeadSequence: 0,
      createdAt: now,
      detailHeadSequence: 0,
      executionDeviceId: otherDeviceId,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: "session_requested01",
      state: "idle",
      updatedAt: now,
      userId: world.userId,
    } as const;
    await reserveSessionHeadQuotaForInsert(ctx, world.userId, requestedSession);
    const requestedSessionId = await ctx.db.insert("sessionHeads", requestedSession);
    const requested = {
      ...base,
      idempotencyKey: uuidV7(now, "304"),
      publicId: uuidV7(now, "314"),
      requestingDeviceId: world.targetDeviceId,
      requestDigest: "7".repeat(64),
      sessionId: requestedSessionId,
      state: "pending",
      targetDeviceId: otherDeviceId,
    } as const;
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, requested);
    const requestedId = await ctx.db.insert("sessionCommands", requested);
    return { pendingId, preparedId, requestedId, startedId };
  });
}

async function drainToCompletion(
  world: Awaited<ReturnType<typeof revocationWorld>>,
  limit = 200,
) {
  const observations: DrainResult[] = [];
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const result = await world.testRuntime.mutation(drainRevocations, { limit });
    observations.push(result);
    if (result.kind === "complete") return observations;
  }
  throw new Error("device revocation did not complete within its bounded category count");
}

describe("status-first device revocation", () => {
  test("removes authority and fences credentials before dependent cleanup, with exact replay", async () => {
    const world = await revocationWorld();
    const first = await world.actor.mutation(revokeDevice, world.revokeRequest);
    expect(first).toEqual({
      deviceClass: "daemon",
      publicId: "device_target01",
      revision: 2,
      status: "revoked",
    });

    const afterFirst = await world.testRuntime.run(async (ctx) => ({
      events: (await ctx.db.query("securityEvents").collect())
        .filter((event) => event.event === "device_revoked"),
      job: (await ctx.db.query("deviceRevocationJobs").collect())[0],
      lease: await ctx.db.get(world.leaseId),
      presence: await ctx.db.get(world.presenceId),
      session: await ctx.db.get(world.sessionId),
      target: await ctx.db.get(world.targetDeviceId),
      targetDeviceSession: await ctx.db.get(world.targetDeviceSessionId),
    }));
    expect(afterFirst.target).toMatchObject({
      credentialGeneration: 2,
      revision: 2,
      status: "revoked",
    });
    expect(afterFirst.target?.revokedAt).toBeNumber();
    expect(afterFirst.job).toMatchObject({
      category: "sessions",
      publicId: world.revokeRequest.idempotencyKey,
      state: "pending",
    });
    expect(afterFirst.presence?.presenceUntil).toBeLessThanOrEqual(Date.now());
    expect(afterFirst.session?.state).toBe("idle");
    expect(afterFirst.lease).not.toBeNull();
    expect(afterFirst.targetDeviceSession).not.toBeNull();
    expect(afterFirst.events).toHaveLength(1);

    const visibleTarget = (await world.actor.query(listDevices, {}))
      .find((device) => device.publicId === "device_target01");
    expect(visibleTarget).toMatchObject({ online: false, status: "revoked" });
    await expect(world.target.query(listDevices, {}))
      .rejects.toThrow("Cloud authority is not current.");
    await expect(world.target.mutation(heartbeatPresence, {
      connectionId: "presence_target_01",
      credentialGeneration: 1,
      fingerprint: "3".repeat(64),
      sequence: 1,
    })).rejects.toThrow("Cloud authority is not current.");
    await expect(world.target.mutation(acquireLease, {
      bootGeneration: 2,
      bootId: "boot_revoke_02",
      leaseDurationMs: 30_000,
      sessionPublicId: "session_revoke01",
    })).rejects.toThrow("Cloud authority is not current.");

    expect(await world.actor.query(revocationStatus, {
      jobId: world.revokeRequest.idempotencyKey,
    })).toMatchObject({
      category: "sessions",
      jobId: world.revokeRequest.idempotencyKey,
      state: "pending",
      targetPublicId: "device_target01",
    });

    expect(await world.actor.mutation(revokeDevice, world.revokeRequest)).toEqual(first);
    expect(await world.testRuntime.run(async (ctx) => ({
      events: (await ctx.db.query("securityEvents").collect())
        .filter((event) => event.event === "device_revoked").length,
      jobs: (await ctx.db.query("deviceRevocationJobs").collect()).length,
      target: await ctx.db.get(world.targetDeviceId),
    }))).toEqual({ events: 1, jobs: 1, target: afterFirst.target });
  });

  test("drains more than 500 dependent rows in crash-safe chunks of at most 200", async () => {
    const world = await revocationWorld();
    const commands = await insertCommandFixtures(world);
    await world.testRuntime.run(async (ctx) => {
      const now = Date.now();
      for (let index = 1; index < 505; index += 1) {
        const session = {
          compactHeadSequence: 0,
          createdAt: now,
          detailHeadSequence: 0,
          executionDeviceId: world.targetDeviceId,
          metadataRevision: 0,
          projectionRevision: 0,
          publicId: `session_mass_${index.toString().padStart(4, "0")}`,
          state: index % 2 === 0 ? "active" : "idle",
          updatedAt: now,
          userId: world.userId,
        } as const;
        await reserveSessionHeadQuotaForInsert(ctx, world.userId, session);
        await ctx.db.insert("sessionHeads", session);
      }
    });
    await world.actor.mutation(revokeDevice, world.revokeRequest);

    const observations = await drainToCompletion(world);
    expect(observations.every((result) => result.processed <= 200)).toBe(true);
    expect(observations.filter((result) =>
      result.category === "sessions" && result.kind === "drained")
      .map((result) => result.processed)).toEqual([200, 200, 105]);

    const final = await world.testRuntime.run(async (ctx) => ({
      accountBinding: await ctx.db.get(world.accountBindingId),
      bindChallenge: await ctx.db.get(world.bindChallengeId),
      commands: {
        pending: await ctx.db.get(commands.pendingId),
        prepared: await ctx.db.get(commands.preparedId),
        requested: await ctx.db.get(commands.requestedId),
        started: await ctx.db.get(commands.startedId),
      },
      keyEnvelope: await ctx.db.get(world.keyEnvelopeId),
      lease: await ctx.db.get(world.leaseId),
      presence: await ctx.db.get(world.presenceId),
      remainingLiveSessions: await ctx.db.query("sessionHeads")
        .withIndex("by_execution_device_and_state", (builder) => builder
          .eq("executionDeviceId", world.targetDeviceId)
          .eq("state", "idle"))
        .collect(),
      targetDeviceSession: await ctx.db.get(world.targetDeviceSessionId),
    }));
    expect(final.remainingLiveSessions).toHaveLength(0);
    expect(final.lease).toBeNull();
    expect(final.accountBinding).toBeNull();
    expect(final.targetDeviceSession).toBeNull();
    expect(final.bindChallenge).toBeNull();
    expect(final.keyEnvelope).toBeNull();
    expect(final.presence).toBeNull();
    expect(final.commands.pending).toMatchObject({ nonterminal: false, state: "cancelled" });
    expect(final.commands.prepared).toMatchObject({
      nonterminal: false,
      state: "cancelled",
    });
    expect(final.commands.started).toMatchObject({ nonterminal: false, state: "ambiguous" });
    expect(final.commands.requested).toMatchObject({ nonterminal: false, state: "cancelled" });
    expect(final.commands.prepared?.terminalCleanupAfter).toBeNumber();
    expect(final.commands.prepared?.terminalCleanupAfter)
      .toBe((final.commands.prepared?.updatedAt ?? 0) + commandTerminalRetentionMs);
    expect(final.commands.pending).not.toHaveProperty("terminalCleanupAfter");
    expect(final.commands.started).not.toHaveProperty("terminalCleanupAfter");

    expect(await world.actor.query(revocationStatus, {
      jobId: world.revokeRequest.idempotencyKey,
    })).toMatchObject({ category: "complete", state: "complete" });
    expect(await world.testRuntime.mutation(drainRevocations, { limit: 200 }))
      .toEqual({ kind: "idle", processed: 0 });
  });

  test("services unfinished jobs in least-recently-updated order", async () => {
    const world = await revocationWorld();
    const second = await world.testRuntime.run(async (ctx) => {
      const now = Date.now();
      const device = {
        activatedAt: now,
        authEpoch: 1,
        createdAt: now,
        credentialGeneration: 1,
        encryptedLabel: encryptedEnvelope,
        keyVersion: 1,
        publicId: "device_target02",
        revision: 1,
        signingPublicKey: "fixture",
        status: "active",
        updatedAt: now,
        userId: world.userId,
        wrappingPublicKey: "fixture",
      } as const;
      await reserveDeviceQuotaForInsert(ctx, world.userId, device);
      const deviceId = await ctx.db.insert("devices", device);
      const session = {
        compactHeadSequence: 0,
        createdAt: now,
        detailHeadSequence: 0,
        executionDeviceId: deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "session_revoke02",
        state: "idle",
        updatedAt: now,
        userId: world.userId,
      } as const;
      await reserveSessionHeadQuotaForInsert(ctx, world.userId, session);
      await ctx.db.insert("sessionHeads", session);
      return deviceId;
    });
    const secondRequest = {
      expectedRevision: 1,
      idempotencyKey: uuidV7(Date.now(), "401"),
      requestDigest: "e".repeat(64),
      targetPublicId: "device_target02",
    };
    await world.actor.mutation(revokeDevice, world.revokeRequest);
    await world.actor.mutation(revokeDevice, secondRequest);
    await world.testRuntime.run(async (ctx) => {
      const firstJob = await ctx.db.query("deviceRevocationJobs")
        .withIndex("by_device", (builder) => builder.eq("deviceId", world.targetDeviceId))
        .unique();
      const secondJob = await ctx.db.query("deviceRevocationJobs")
        .withIndex("by_device", (builder) => builder.eq("deviceId", second))
        .unique();
      if (firstJob === null || secondJob === null) throw new Error("revocation jobs missing");
      await adjustQuotaForPatch(ctx, world.userId, "job", firstJob, { updatedAt: 1 });
      await ctx.db.patch(firstJob._id, { updatedAt: 1 });
      await adjustQuotaForPatch(ctx, world.userId, "job", secondJob, { updatedAt: 2 });
      await ctx.db.patch(secondJob._id, { updatedAt: 2 });
    });

    expect(await world.testRuntime.mutation(drainRevocations, { limit: 1 }))
      .toMatchObject({ jobId: world.revokeRequest.idempotencyKey, processed: 1 });
    expect(await world.testRuntime.mutation(drainRevocations, { limit: 1 }))
      .toMatchObject({ jobId: secondRequest.idempotencyKey, processed: 1 });
  });
});
