import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { sha256Hex } from "../src/cloud/crypto";
import { buildOompaAttentionEmailBody } from "./attentionEmail";
import { reserveAttentionNotificationFaultCapacity } from "./attentionNotificationControl";
import { attentionNotificationQuotaReservations } from "./attentionNotifications";
import {
  createAccountDeletionCapacityForNewUser,
  createDeviceRevocationCapacityForNewDevice,
} from "./authorityReductionCapacity";
import { reserveCommandLifecycleForInsert } from "./commandLifecycle";
import { commandTerminalRetentionMs } from "./commands";
import { ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS } from "./lifecyclePolicy";
import {
  CATEGORY_QUOTAS,
  QUOTA_CATEGORIES,
  SERVICE_TOTAL_QUOTA,
  USER_TOTAL_QUOTA,
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  initializeAccountUsageQuotaAuthority,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  releaseQuotaForDelete,
  releaseSessionHeadQuotaForDelete,
  reserveCodexAccountQuotaForInsert,
  reserveDeviceQuotaForInsert,
  reserveNonterminalCommandQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveSessionHeadQuotaForInsert,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";
import {
  commandLifecycleCapacityVersion,
  commandReceiptCapacityReservation,
} from "./validators";
import { DEVICE_REVOCATION_RETAINED_SERVICE_TABLES } from "./deviceRevocation";

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
const listSessionHeads = makeFunctionReference<"query", Args, readonly Readonly<{
  publicId: string;
  state: string;
}>[]>("sessions:listHeads");
const listSessionHeadsPage = makeFunctionReference<"query", Args, Readonly<{
  page: readonly Readonly<{ publicId: string; state: string }>[];
}>>("sessions:listHeadsPage");
const getSessionHead = makeFunctionReference<"query", Args, Readonly<{
  publicId: string;
  state: string;
}> | null>("sessions:getHead");
const updateSessionMetadata = makeFunctionReference<"mutation", Args, Readonly<{
  publicId: string;
  state: string;
}>>("sessions:updateMetadata");
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
const settleAttentionNotification = makeFunctionReference<"mutation", Args, unknown>(
  "attentionNotifications:settleAttempt",
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
    await createAccountDeletionCapacityForNewUser(ctx, userId);
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
    await createDeviceRevocationCapacityForNewDevice(ctx, userId, actorDeviceId);
    const targetDevice = {
      activatedAt: now,
      attentionNotificationAuthority: {
        consentLeaseUntil: now + 120_000,
        globalNotificationGeneration: 1,
        localNotificationPolicyRevision: 1,
        reconciliationSequence: 1,
      },
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
    await createDeviceRevocationCapacityForNewDevice(ctx, userId, targetDeviceId);
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
      lifecycleCapacityVersion: commandLifecycleCapacityVersion,
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
    await reserveCommandLifecycleForInsert(ctx, "session", pending);
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
    await reserveCommandLifecycleForInsert(ctx, "session", prepared);
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
    await reserveCommandLifecycleForInsert(ctx, "session", started);
    const startedDevice = {
      createdAt: now,
      deadline: now + 60_000,
      idempotencyKey: uuidV7(now, "305"),
      kind: "usage_refresh" as const,
      lifecycleCapacityVersion: commandLifecycleCapacityVersion,
      nonterminal: true,
      payload: encryptedEnvelope,
      publicId: uuidV7(now, "315"),
      requestDigest: "8".repeat(64),
      requestingDeviceId: world.actorDeviceId,
      state: "effect_started" as const,
      targetDeviceId: world.targetDeviceId,
      updatedAt: now,
      userId: world.userId,
    };
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, startedDevice);
    const startedDeviceId = await ctx.db.insert("deviceCommands", startedDevice);
    await reserveCommandLifecycleForInsert(ctx, "device", startedDevice);

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
      state: "effect_started",
      targetDeviceId: otherDeviceId,
    } as const;
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, requested);
    const requestedId = await ctx.db.insert("sessionCommands", requested);
    await reserveCommandLifecycleForInsert(ctx, "session", requested);
    const requestedDevice = {
      createdAt: now,
      deadline: now + 60_000,
      idempotencyKey: uuidV7(now, "306"),
      kind: "usage_refresh" as const,
      lifecycleCapacityVersion: commandLifecycleCapacityVersion,
      nonterminal: true,
      payload: encryptedEnvelope,
      publicId: uuidV7(now, "316"),
      requestDigest: "9".repeat(64),
      requestingDeviceId: world.targetDeviceId,
      state: "effect_started" as const,
      targetDeviceId: otherDeviceId,
      updatedAt: now,
      userId: world.userId,
    };
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, requestedDevice);
    const requestedDeviceId = await ctx.db.insert("deviceCommands", requestedDevice);
    await reserveCommandLifecycleForInsert(ctx, "device", requestedDevice);
    return {
      pendingId,
      preparedId,
      requestedDeviceId,
      requestedId,
      startedDeviceId,
      startedId,
    };
  });
}

async function insertNotificationFixtures(world: Awaited<ReturnType<typeof revocationWorld>>) {
  const now = Date.now();
  return await world.testRuntime.run(async (ctx) => {
    const base = {
      allowedWindowEnd: now + 60_000,
      claimCapacityReservation: attentionNotificationQuotaReservations.pending,
      claimDeadline: now + 60_000,
      coalesceAfter: now - 1,
      consentLeaseUntil: now + 60_000,
      createdAt: now,
      executionAuthority: {
        bootGeneration: 1,
        bootId: "boot_revoke_01",
        fence: 1,
      },
      globalNotificationGeneration: 1,
      interactionDeadline: now + 60_000,
      interactionKind: "permission_approval" as const,
      interactionRevision: 1,
      localNotificationPolicyRevision: 1,
      nonterminal: true,
      reconciliationSequence: 1,
      remoteActions: ["decline"] as ("answer" | "decline")[],
      sessionId: world.sessionId,
      sessionPublicId: "session_revoke01",
      sourceDeviceId: world.targetDeviceId,
      state: "pending" as const,
      updatedAt: now,
      userId: world.userId,
    };
    const pending = { ...base, interactionId: "interaction_revoke_pending" };
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, pending);
    const pendingId = await ctx.db.insert("attentionNotificationOutbox", pending);
    const started = { ...base, interactionId: "interaction_revoke_started" };
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, started);
    const startedId = await ctx.db.insert("attentionNotificationOutbox", started);
    const deliveryId = uuidV7(now, "401");
    const body = buildOompaAttentionEmailBody([{
      interactionKind: started.interactionKind,
      sessionPublicId: started.sessionPublicId,
    }]);
    const bodyDigest = await sha256Hex(`oompa-attention-body:v1\u0000${body.text}`);
    const recipientDigest = "9".repeat(64);
    const idempotencyKey = await sha256Hex([
      "oompa-attention-resend:v1",
      deliveryId,
      recipientDigest,
      bodyDigest,
    ].join("\u0000"));
    expect(await reserveAttentionNotificationFaultCapacity(ctx, {
      anchorRowId: startedId,
      deliveryId,
      now,
      userId: world.userId,
    })).toBe(true);
    const startedPatch = {
      claimCapacityReservation: attentionNotificationQuotaReservations.started,
      delivery: {
        attemptCount: 1,
        body,
        bodyDigest,
        claimedAt: now,
        deadline: now + 60_000,
        effectStartedAt: now,
        firstAttemptAt: now,
        generation: 1,
        id: deliveryId,
        idempotencyKey,
        lastAttemptAt: now,
        leaderRowId: startedId,
        recipientDigest,
      },
      faultCapacityAnchor: startedId,
      state: "effect_started" as const,
    };
    await adjustCommandQuotaForPatch(ctx, world.userId, started, startedPatch);
    await ctx.db.patch(startedId, startedPatch);
    return { deliveryId, pendingId, startedId };
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

async function removeTargetRevocationDependencies(
  world: Awaited<ReturnType<typeof revocationWorld>>,
): Promise<void> {
  await world.testRuntime.run(async (ctx) => {
    const session = await ctx.db.get(world.sessionId);
    if (session !== null) {
      await releaseSessionHeadQuotaForDelete(ctx, world.userId, session);
      await ctx.db.delete(session._id);
    }
    for (const [id, category] of [
      [world.leaseId, "session"],
      [world.targetDeviceSessionId, "custody"],
      [world.presenceId, "device"],
      [world.accountBindingId, "account"],
      [world.bindChallengeId, "custody"],
      [world.keyEnvelopeId, "custody"],
    ] as const) {
      const row = await ctx.db.get(id);
      if (row === null) continue;
      await releaseQuotaForDelete(ctx, world.userId, category, row);
      await ctx.db.delete(row._id);
    }
  });
}

async function saturateRevocationQuota(
  world: Awaited<ReturnType<typeof revocationWorld>>,
  saturateUserRecords = false,
): Promise<void> {
  await world.testRuntime.run(async (ctx) => {
    const categories = await ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (builder) => builder.eq("userId", world.userId))
      .collect();
    const chunk = categories.find((row) => row.category === "chunk");
    const service = await ctx.db.query("storageUsageService")
      .withIndex("by_key", (builder) => builder.eq("key", "global"))
      .unique();
    if (chunk === undefined || service === null) throw new Error("missing revocation quota fixture");
    const currentBytes = categories.reduce((sum, row) => sum + row.logicalBytes, 0);
    const currentRecords = categories.reduce((sum, row) => sum + row.records, 0);
    const targetRecords = new Map(categories.map((row) => [row.category, row.records]));
    let remainingRecords = USER_TOTAL_QUOTA.records - currentRecords;
    if (saturateUserRecords) {
      for (const category of QUOTA_CATEGORIES) {
        if (remainingRecords === 0) break;
        const current = targetRecords.get(category) ?? 0;
        const added = Math.min(CATEGORY_QUOTAS[category].records - current, remainingRecords);
        targetRecords.set(category, current + added);
        remainingRecords -= added;
      }
    } else {
      targetRecords.set("chunk", chunk.records === 0 ? 1 : chunk.records);
      remainingRecords = 0;
    }
    if (remainingRecords !== 0) throw new Error("unable to saturate revocation record quota");
    const canonicalByteAdds = categories.reduce((sum, row) =>
      row.category !== "chunk"
      && row.logicalBytes === 0
      && (targetRecords.get(row.category) ?? 0) > 0
        ? sum + 1
        : sum, 0);
    for (const row of categories) {
      const logicalBytes = row.category === "chunk"
        ? row.logicalBytes + USER_TOTAL_QUOTA.logicalBytes - currentBytes - canonicalByteAdds
        : row.logicalBytes === 0 && (targetRecords.get(row.category) ?? 0) > 0
          ? 1
          : row.logicalBytes;
      await ctx.db.patch(row._id, {
        logicalBytes,
        records: targetRecords.get(row.category) ?? row.records,
        updatedAt: Date.now(),
      });
    }
    const userRecords = [...targetRecords.values()].reduce((sum, records) => sum + records, 0);
    await ctx.db.patch(service._id, {
      logicalBytes: SERVICE_TOTAL_QUOTA.logicalBytes,
      records: SERVICE_TOTAL_QUOTA.records,
      serviceLogicalBytes: SERVICE_TOTAL_QUOTA.logicalBytes - USER_TOTAL_QUOTA.logicalBytes,
      serviceRecords: SERVICE_TOTAL_QUOTA.records - userRecords,
      updatedAt: Date.now(),
      userLogicalBytes: USER_TOTAL_QUOTA.logicalBytes,
      userRecords,
    });
  });
}

describe("status-first device revocation", () => {
  for (const targetState of ["active", "pending"] as const) {
    test(`accepts ${targetState} revocation by exchange at exact user and service ceilings`, async () => {
      const world = await revocationWorld();
      if (targetState === "pending") {
        await world.testRuntime.run(async (ctx) => {
          const target = await ctx.db.get(world.targetDeviceId);
          if (target === null) throw new Error("missing pending revocation target");
          const patch = { activatedAt: undefined, status: "pending" as const };
          await adjustQuotaForPatch(ctx, world.userId, "device", target, patch);
          await ctx.db.patch(target._id, patch);
        });
      }
      await saturateRevocationQuota(world, true);
      expect(await world.testRuntime.run(async (ctx) => {
        const categories = await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (builder) =>
            builder.eq("userId", world.userId))
          .collect();
        const service = await ctx.db.query("storageUsageService").unique();
        return {
          serviceBytes: service?.logicalBytes,
          serviceRecords: service?.records,
          userBytes: categories.reduce((sum, row) => sum + row.logicalBytes, 0),
          userRecords: categories.reduce((sum, row) => sum + row.records, 0),
        };
      })).toEqual({
        serviceBytes: SERVICE_TOTAL_QUOTA.logicalBytes,
        serviceRecords: SERVICE_TOTAL_QUOTA.records,
        userBytes: USER_TOTAL_QUOTA.logicalBytes,
        userRecords: USER_TOTAL_QUOTA.records,
      });
      expect(await world.actor.mutation(revokeDevice, world.revokeRequest))
        .toMatchObject({ status: "revoked" });
      const observed = await world.testRuntime.run(async (ctx) => {
        const categories = await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (builder) => builder.eq("userId", world.userId))
          .collect();
        return {
          deviceCapacity: await ctx.db.query("deviceRevocationDeviceReservations")
            .withIndex("by_device", (builder) =>
              builder.eq("deviceId", world.targetDeviceId))
            .collect(),
          jobCapacity: await ctx.db.query("deviceRevocationJobReservations")
            .withIndex("by_device", (builder) =>
              builder.eq("deviceId", world.targetDeviceId))
            .collect(),
          receiptCapacity: await ctx.db.query("deviceRevocationReceiptReservations")
            .withIndex("by_device", (builder) =>
              builder.eq("deviceId", world.targetDeviceId))
            .collect(),
          securityCapacity: await ctx.db.query("deviceRevocationSecurityReservations")
            .withIndex("by_device", (builder) =>
              builder.eq("deviceId", world.targetDeviceId))
            .collect(),
          service: await ctx.db.query("storageUsageService").unique(),
          target: await ctx.db.get(world.targetDeviceId),
          userBytes: categories.reduce((sum, row) => sum + row.logicalBytes, 0),
          userRecords: categories.reduce((sum, row) => sum + row.records, 0),
        };
      });
      expect(observed.deviceCapacity).toEqual([]);
      expect(observed.jobCapacity).toEqual([]);
      expect(observed.receiptCapacity).toEqual([]);
      expect(observed.securityCapacity).toEqual([]);
      expect(observed.target).toMatchObject({ status: "revoked" });
      expect(observed.userBytes).toBeLessThan(USER_TOTAL_QUOTA.logicalBytes);
      expect(observed.userRecords).toBe(USER_TOTAL_QUOTA.records - 1);
      expect(observed.service?.logicalBytes).toBeLessThan(SERVICE_TOTAL_QUOTA.logicalBytes);
      expect(observed.service?.records).toBe(SERVICE_TOTAL_QUOTA.records - 1);
    });
  }

  test("capacity-backed and predecessor empty jobs drain at exact hard ceilings", async () => {
    for (const legacy of [false, true]) {
      const world = await revocationWorld();
      await removeTargetRevocationDependencies(world);
      await world.actor.mutation(revokeDevice, world.revokeRequest);
      const initialBytes = await world.testRuntime.run(async (ctx) => {
        const job = await ctx.db.query("deviceRevocationJobs").unique();
        if (job === null) throw new Error("missing revocation capacity job");
        expect(job.capacityReservation).toHaveLength(256);
        if (legacy) {
          const patch = { capacityReservation: undefined };
          await adjustQuotaForPatch(ctx, world.userId, "job", job, patch);
          await ctx.db.patch(job._id, patch);
          return logicalDocumentBytes({ ...job, ...patch });
        }
        return logicalDocumentBytes(job);
      });
      await saturateRevocationQuota(world);
      const observations = await drainToCompletion(world);
      expect(observations.at(-1)).toMatchObject({
        category: "complete",
        kind: "complete",
        state: "complete",
      });
      const completed = await world.testRuntime.run(async (ctx) =>
        await ctx.db.query("deviceRevocationJobs").unique());
      expect(completed).toMatchObject({ state: "complete" });
      if (!legacy) expect(logicalDocumentBytes(completed ?? {})).toBe(initialBytes);
      expect(await world.actor.query(revocationStatus, {
        jobId: world.revokeRequest.idempotencyKey,
      })).toMatchObject({ category: "complete", state: "complete" });
    }
  });

  test("live session heads stay byte-neutral and read orphaned at exact hard ceilings", async () => {
    for (const legacy of [false, true]) {
      const world = await revocationWorld();
      // A legal identity may already own 10k heads and 10k leases. Revocation
      // must not require an extra session-category record just to represent
      // the derived orphan state.
      await world.testRuntime.run(async (ctx) => {
        const sessionUsage = await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (builder) => builder
            .eq("userId", world.userId)
            .eq("category", "session"))
          .unique();
        const service = await ctx.db.query("storageUsageService")
          .withIndex("by_key", (builder) => builder.eq("key", "global"))
          .unique();
        if (sessionUsage === null || service === null) {
          throw new Error("missing session quota fixture");
        }
        const recordDelta = CATEGORY_QUOTAS.session.records - sessionUsage.records;
        await ctx.db.patch(sessionUsage._id, {
          records: CATEGORY_QUOTAS.session.records,
          updatedAt: Date.now(),
        });
        await ctx.db.patch(service._id, {
          records: service.records + recordDelta,
          updatedAt: Date.now(),
          userRecords: service.userRecords + recordDelta,
        });
      });
      await world.actor.mutation(revokeDevice, world.revokeRequest);
      await world.testRuntime.run(async (ctx) => {
        const job = await ctx.db.query("deviceRevocationJobs").unique();
        if (job === null) throw new Error("missing revocation job");
        if (legacy) {
          const patch = { capacityReservation: undefined };
          await adjustQuotaForPatch(ctx, world.userId, "job", job, patch);
          await ctx.db.patch(job._id, patch);
        }
      });
      await saturateRevocationQuota(world);

      const observations = await drainToCompletion(world, 1);
      expect(observations.at(-1)).toMatchObject({
        category: "complete",
        kind: "complete",
        state: "complete",
      });
      const stored = await world.testRuntime.run(async (ctx) =>
        await ctx.db.get(world.sessionId));
      expect(stored?.state).toBe("idle");
      expect(await world.actor.query(getSessionHead, {
        publicId: "session_revoke01",
      })).toMatchObject({ publicId: "session_revoke01", state: "orphaned" });
    }
  });

  test("removes authority and fences credentials before dependent cleanup, with exact replay", async () => {
    const world = await revocationWorld();
    const metadataRequest = {
      expectedRevision: 0,
      idempotencyKey: uuidV7(Date.now(), "401"),
      metadata: encryptedEnvelope,
      requestDigest: "4".repeat(64),
      sessionPublicId: "session_revoke01",
    };
    expect(await world.actor.mutation(updateSessionMetadata, metadataRequest))
      .toMatchObject({ publicId: "session_revoke01", state: "idle" });
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
    expect(afterFirst.target?.attentionNotificationAuthority).toBeUndefined();
    expect(afterFirst.target?.revokedAt).toBeNumber();
    expect(afterFirst.job).toMatchObject({
      category: "sessions",
      publicId: world.revokeRequest.idempotencyKey,
      state: "pending",
    });
    expect(afterFirst.presence?.presenceUntil).toBeLessThanOrEqual(Date.now());
    expect(afterFirst.session?.state).toBe("idle");
    expect(await world.actor.query(getSessionHead, {
      publicId: "session_revoke01",
    })).toMatchObject({ publicId: "session_revoke01", state: "orphaned" });
    const listedHeads = await world.actor.query(listSessionHeads, { limit: 10 });
    expect(listedHeads.some((head) =>
      head.publicId === "session_revoke01" && head.state === "orphaned")).toBe(true);
    const listedHeadsPage = await world.actor.query(listSessionHeadsPage, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(listedHeadsPage.page.some((head) =>
      head.publicId === "session_revoke01" && head.state === "orphaned")).toBe(true);
    expect(await world.actor.mutation(updateSessionMetadata, metadataRequest))
      .toMatchObject({ publicId: "session_revoke01", state: "orphaned" });
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
    const notifications = await insertNotificationFixtures(world);
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
      .map((result) => result.processed)).toEqual([]);

    const final = await world.testRuntime.run(async (ctx) => ({
      accountBinding: await ctx.db.get(world.accountBindingId),
      bindChallenge: await ctx.db.get(world.bindChallengeId),
      commands: {
        pending: await ctx.db.get(commands.pendingId),
        prepared: await ctx.db.get(commands.preparedId),
        requestedDevice: await ctx.db.get(commands.requestedDeviceId),
        requested: await ctx.db.get(commands.requestedId),
        startedDevice: await ctx.db.get(commands.startedDeviceId),
        started: await ctx.db.get(commands.startedId),
      },
      commandReservations: await ctx.db.query("commandLifecycleReservations").collect(),
      commandSecurityReservations: await ctx.db.query(
        "commandTerminalSecurityReservations",
      ).collect(),
      commandTerminalEvents: (await ctx.db.query("securityEvents").collect())
        .filter((event) => event.event === "command_terminal"),
      keyEnvelope: await ctx.db.get(world.keyEnvelopeId),
      lease: await ctx.db.get(world.leaseId),
      notifications: {
        pending: await ctx.db.get(notifications.pendingId),
        started: await ctx.db.get(notifications.startedId),
      },
      notificationFaultCapacity: await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_user", (builder) => builder.eq("userId", world.userId))
        .collect(),
      nonterminalCommandUsage: await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (builder) => builder
          .eq("userId", world.userId)
          .eq("resource", "nonterminal_command"))
        .unique(),
      presence: await ctx.db.get(world.presenceId),
      remainingLiveSessions: await ctx.db.query("sessionHeads")
        .withIndex("by_execution_device_and_state", (builder) => builder
          .eq("executionDeviceId", world.targetDeviceId)
          .eq("state", "idle"))
        .collect(),
      targetDeviceSession: await ctx.db.get(world.targetDeviceSessionId),
    }));
    // Session state is derived from the revoked execution authority instead
    // of growing up to 10,000 stored heads from idle/active to orphaned.
    expect(final.remainingLiveSessions).toHaveLength(253);
    expect(await world.actor.query(getSessionHead, {
      publicId: "session_mass_0001",
    })).toMatchObject({ publicId: "session_mass_0001", state: "orphaned" });
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
    expect(final.commands.requested).toMatchObject({ nonterminal: false, state: "ambiguous" });
    expect(final.commands.requestedDevice)
      .toMatchObject({ nonterminal: false, state: "ambiguous" });
    expect(final.commands.startedDevice)
      .toMatchObject({ nonterminal: false, state: "ambiguous" });
    expect(final.commands.requested?.requesterReceiptAbandonedAt).toBeNumber();
    expect(final.commands.requestedDevice?.requesterReceiptAbandonedAt).toBeNumber();
    expect(final.commands.requested?.terminalCleanupAfter).toBeNumber();
    expect(final.commands.requested).not.toHaveProperty("requesterAcknowledgedAt");
    expect(final.commands.requested).not.toHaveProperty("receiptCapacityReservation");
    expect(final.commands.prepared?.terminalCleanupAfter).toBeNumber();
    expect(final.commands.prepared?.terminalCleanupAfter)
      .toBe((final.commands.prepared?.updatedAt ?? 0) + commandTerminalRetentionMs);
    expect(final.commands.pending).not.toHaveProperty("terminalCleanupAfter");
    expect(final.commands.started).not.toHaveProperty("terminalCleanupAfter");
    expect(final.commands.pending?.receiptCapacityReservation)
      .toBe(commandReceiptCapacityReservation);
    expect(final.commands.started?.receiptCapacityReservation)
      .toBe(commandReceiptCapacityReservation);
    expect(final.commandReservations).toEqual([]);
    expect(final.commandSecurityReservations).toEqual([]);
    expect(final.commandTerminalEvents).toHaveLength(4);
    const expectedTerminalIds = [
      final.commands.requested?.publicId,
      final.commands.requestedDevice?.publicId,
      final.commands.started?.publicId,
      final.commands.startedDevice?.publicId,
    ].filter((publicId): publicId is string => publicId !== undefined);
    expect(new Set(final.commandTerminalEvents.map((event) => event.entityId)))
      .toEqual(new Set(expectedTerminalIds));
    for (const event of final.commandTerminalEvents) {
      const expectedTarget = event.entityId === final.commands.started?.publicId
        || event.entityId === final.commands.startedDevice?.publicId
        ? world.targetDeviceId
        : event.entityId === final.commands.requested?.publicId
          ? final.commands.requested.targetDeviceId
          : final.commands.requestedDevice?.targetDeviceId;
      expect(event.actorDeviceId).toBe(expectedTarget);
    }
    expect(final.notifications.pending).toMatchObject({
      nonterminal: false,
      retrySuppressionReason: "device_revoked",
      state: "cancelled",
    });
    expect(final.notifications.pending?.revocationObservedAt).toBeNumber();
    expect(final.notifications.pending?.terminalCleanupAfter).toBeNumber();
    expect(final.notifications.pending?.terminalCleanupAfter)
      .toBe(
        (final.notifications.pending?.updatedAt ?? 0)
        + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
      );
    expect(final.notifications.started).toMatchObject({
      nonterminal: true,
      retrySuppressionReason: "device_revoked",
      state: "effect_started",
    });
    expect(final.notifications.started?.revocationObservedAt).toBeNumber();
    expect(final.notifications.started?.delivery?.id).toBe(notifications.deliveryId);
    expect(final.notifications.started?.delivery?.settledAt).toBeUndefined();
    expect(final.notificationFaultCapacity).toHaveLength(4);
    expect(final.notificationFaultCapacity.every((row) => row.state === "reserved")).toBe(true);
    expect(DEVICE_REVOCATION_RETAINED_SERVICE_TABLES)
      .toEqual(["attentionNotificationSafetyFaults"]);
    expect(final.nonterminalCommandUsage).toMatchObject({ records: 1 });

    expect(await world.testRuntime.mutation(settleAttentionNotification, {
      deliveryId: notifications.deliveryId,
      generation: 1,
      globalNotificationGeneration: 1,
      result: { kind: "accepted", providerMessageId: "revoked_device_delivery" },
    })).toEqual({ kind: "accepted" });
    expect(await world.testRuntime.run(async (ctx) => ({
      faults: await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_user", (builder) => builder.eq("userId", world.userId))
        .collect(),
      notification: await ctx.db.get(notifications.startedId),
    }))).toMatchObject({
      faults: [],
      notification: { nonterminal: false, state: "accepted" },
    });

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
      await createDeviceRevocationCapacityForNewDevice(ctx, world.userId, deviceId);
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
      .toMatchObject({
        category: "leases",
        jobId: world.revokeRequest.idempotencyKey,
        processed: 0,
      });
    expect(await world.testRuntime.mutation(drainRevocations, { limit: 1 }))
      .toMatchObject({
        category: "leases",
        jobId: secondRequest.idempotencyKey,
        processed: 0,
      });
  });
});
