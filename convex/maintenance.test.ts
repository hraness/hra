import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import {
  initializeAccountUsageQuotaAuthority,
  initializeUserQuotaAuthority,
  reserveAccountUsageSnapshotQuotaForInsert,
  reserveCodexAccountQuotaForInsert,
  reserveDeviceQuotaForInsert,
  reserveNonterminalCommandQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveServiceQuotaForInsert,
  reserveSessionHeadQuotaForInsert,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
const cleanupExpired = makeFunctionReference<"mutation", Args, Readonly<{
  abandonedIdentities: number;
  accountDeletionReceipts: number;
  authAttempts: number;
  authInvites: number;
  bindChallenges: number;
  devicePresence: number;
  deviceRevocationJobs: number;
  expiredPendingCommands: number;
  idempotencyReceipts: number;
  nextCategory: string;
  otpChallenges: number;
  processed: number;
  securityEvents: number;
  terminalCommands: number;
  usageSnapshots: number;
  visitedCategories: number;
}>>("maintenance:cleanupExpired");
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

describe("bounded cloud retention", () => {
  test("shares one hard batch budget across categories", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisQuota, {});
    const now = Date.now();
    await runtime.run(async (ctx) => {
      for (let index = 0; index < 3; index += 1) {
        const attempt = {
          authEpoch: 1,
          createdAt: now - 100_000,
          emailDigest: index.toString(16).padStart(64, "0"),
          expiresAt: now - 1,
          kind: "send" as const,
        };
        await reserveServiceQuotaForInsert(ctx, attempt);
        await ctx.db.insert("authEmailAttemptEvents", attempt);
      }
      const userId = await ctx.db.insert("users", { email: "cleanup@example.com" });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing cleanup quota user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      const account = {
        provider: "hra-control-plane-otp-v1",
        providerAccountId: "cleanup@example.com",
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "identity", account);
      const accountId = await ctx.db.insert("authAccounts", account);
      const challenge = {
        accountId,
        authEpoch: 1,
        codeDigest: "b".repeat(64),
        createdAt: now - 100_000,
        deliveryState: "accepted",
        emailDigest: "c".repeat(64),
        expiresAt: now - 1,
        updatedAt: now - 100_000,
        userId,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "identity", challenge);
      await ctx.db.insert("authOtpChallenges", challenge);
    });

    const first = await runtime.mutation(cleanupExpired, { limit: 2 });
    expect(first.processed).toBe(2);
    expect(first.authAttempts).toBe(2);
    expect(first.otpChallenges).toBe(0);
    const remaining = await runtime.run(async (ctx) => ({
      attempts: (await ctx.db.query("authEmailAttemptEvents").collect()).length,
      otp: (await ctx.db.query("authOtpChallenges").collect()).length,
    }));
    expect(remaining).toEqual({ attempts: 1, otp: 1 });

    const second = await runtime.mutation(cleanupExpired, { limit: 2 });
    expect(second.processed).toBe(2);
    expect(second.authAttempts).toBe(1);
    expect(second.otpChallenges).toBe(1);
  });

  test("expires no-effect pending commands and deletes only old terminal evidence", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisQuota, {});
    const now = Date.now();
    const ids = await runtime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "retention@example.com" });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing retention quota user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      const device = {
        authEpoch: 1,
        createdAt: now,
        encryptedLabel: {
          algorithm: "A256GCM",
          ciphertext: "A".repeat(32),
          keyVersion: 1,
          nonce: "A".repeat(16),
        },
        keyVersion: 1,
        publicId: "device_retention1",
        revision: 1,
        signingPublicKey: "fixture",
        status: "active",
        updatedAt: now,
        userId,
        wrappingPublicKey: "fixture",
      } as const;
      await reserveDeviceQuotaForInsert(ctx, userId, device);
      const deviceId = await ctx.db.insert("devices", device);
      const session = {
        compactHeadSequence: 0,
        createdAt: now,
        detailHeadSequence: 0,
        executionDeviceId: deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "session_retention1",
        state: "idle",
        updatedAt: now,
        userId,
      } as const;
      await reserveSessionHeadQuotaForInsert(ctx, userId, session);
      const sessionId = await ctx.db.insert("sessionHeads", session);
      const base = {
        createdAt: now - 40 * 24 * 60 * 60 * 1_000,
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000001",
        kind: "stop" as const,
        payload: {
          algorithm: "A256GCM" as const,
          ciphertext: "B".repeat(32),
          keyVersion: 1,
          nonce: "B".repeat(16),
        },
        requestDigest: "d".repeat(64),
        requestingDeviceId: deviceId,
        sessionId,
        targetDeviceId: deviceId,
        userId,
      };
      const pending = {
        ...base,
        deadline: now - 1,
        nonterminal: true,
        publicId: "018bcfe5-6800-7000-8000-000000000002",
        state: "pending",
        updatedAt: now - 1,
      } as const;
      await reserveNonterminalCommandQuotaForInsert(ctx, userId, pending);
      const pendingId = await ctx.db.insert("sessionCommands", pending);
      const oldTerminal = {
        ...base,
        deadline: now - 1,
        nonterminal: false,
        publicId: "018bcfe5-6800-7000-8000-000000000003",
        requesterAcknowledgedAt: now - 31 * 24 * 60 * 60 * 1_000,
        state: "applied",
        terminalCleanupAfter: now - 1,
        updatedAt: now - 31 * 24 * 60 * 60 * 1_000,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "command", oldTerminal);
      const oldTerminalId = await ctx.db.insert("sessionCommands", oldTerminal);
      const recentTerminal = {
        ...base,
        deadline: now - 1,
        nonterminal: false,
        publicId: "018bcfe5-6800-7000-8000-000000000004",
        requesterAcknowledgedAt: now - 29 * 24 * 60 * 60 * 1_000,
        state: "applied",
        terminalCleanupAfter: now + 60_000,
        updatedAt: now - 29 * 24 * 60 * 60 * 1_000,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "command", recentTerminal);
      const recentTerminalId = await ctx.db.insert("sessionCommands", recentTerminal);
      const unacknowledgedTerminal = {
        ...base,
        deadline: now - 1,
        nonterminal: false,
        publicId: "018bcfe5-6800-7000-8000-000000000005",
        state: "applied",
        updatedAt: now - 60 * 24 * 60 * 60 * 1_000,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "command", unacknowledgedTerminal);
      const unacknowledgedTerminalId = await ctx.db.insert(
        "sessionCommands",
        unacknowledgedTerminal,
      );
      const oldSecurity = {
        createdAt: now - 91 * 24 * 60 * 60 * 1_000,
        entityId: "fixture_retention",
        event: "lease_acquired",
        userId,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "security", oldSecurity);
      const oldSecurityId = await ctx.db.insert("securityEvents", oldSecurity);
      return { oldSecurityId, oldTerminalId, pendingId, recentTerminalId, unacknowledgedTerminalId };
    });

    const result = await runtime.mutation(cleanupExpired, { limit: 10 });
    expect(result).toMatchObject({
      expiredPendingCommands: 1,
      securityEvents: 1,
      terminalCommands: 1,
    });
    expect(await runtime.run(async (ctx) => ({
      oldSecurity: await ctx.db.get(ids.oldSecurityId),
      oldTerminal: await ctx.db.get(ids.oldTerminalId),
      pending: await ctx.db.get(ids.pendingId),
      recentTerminal: await ctx.db.get(ids.recentTerminalId),
      unacknowledgedTerminal: await ctx.db.get(ids.unacknowledgedTerminalId),
    }))).toMatchObject({
      oldSecurity: null,
      oldTerminal: null,
      pending: { state: "expired" },
      recentTerminal: { state: "applied" },
      unacknowledgedTerminal: { state: "applied" },
    });
    expect(await runtime.run(async (ctx) => {
      const record = await ctx.db.get(ids.unacknowledgedTerminalId);
      return record !== null && "requesterAcknowledgedAt" in record;
    })).toBe(false);
  });

  test("gives every eligible category one bounded quantum in a full rotation", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisQuota, {});
    const now = Date.now();
    await runtime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "fair-retention@example.com" });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing fair-retention quota user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      const authSession = {
        expirationTime: now + 60_000,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "identity", authSession);
      const authSessionId = await ctx.db.insert("authSessions", authSession);
      const authAccount = {
        provider: "hra-control-plane-otp-v1",
        providerAccountId: "fair-retention@example.com",
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "identity", authAccount);
      const accountId = await ctx.db.insert("authAccounts", authAccount);
      const authAttempt = {
        authEpoch: 1,
        createdAt: now - 100_000,
        emailDigest: "1".repeat(64),
        expiresAt: now - 1,
        kind: "send" as const,
      };
      await reserveServiceQuotaForInsert(ctx, authAttempt);
      await ctx.db.insert("authEmailAttemptEvents", authAttempt);
      const otpChallenge = {
        accountId,
        authEpoch: 1,
        codeDigest: "2".repeat(64),
        createdAt: now - 100_000,
        deliveryState: "accepted",
        emailDigest: "3".repeat(64),
        expiresAt: now - 1,
        updatedAt: now - 100_000,
        userId,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "identity", otpChallenge);
      await ctx.db.insert("authOtpChallenges", otpChallenge);
      const invite = {
        capabilityDigest: "4".repeat(64),
        createdAt: now - 100_000,
        expiresAt: now - 1,
        publicId: "invite_expired_fair_rotation",
        purpose: "identity",
        state: "issued",
        updatedAt: now - 100_000,
      } as const;
      await reserveServiceQuotaForInsert(ctx, invite);
      await ctx.db.insert("authInvites", invite);
      const abandonedSubject = {
        authEpoch: 1,
        createdAt: now - 2 * 24 * 60 * 60 * 1_000,
        emailDigest: "5".repeat(64),
        status: "active",
        updatedAt: now - 2 * 24 * 60 * 60 * 1_000,
      } as const;
      await reserveServiceQuotaForInsert(ctx, abandonedSubject);
      await ctx.db.insert("authSubjects", abandonedSubject);
      const device = {
        authEpoch: 1,
        createdAt: now,
        credentialGeneration: 1,
        encryptedLabel: {
          algorithm: "A256GCM",
          ciphertext: "A".repeat(32),
          keyVersion: 1,
          nonce: "A".repeat(16),
        },
        keyVersion: 1,
        publicId: "device_fair_retention",
        revision: 1,
        signingPublicKey: "fixture",
        status: "active",
        updatedAt: now,
        userId,
        wrappingPublicKey: "fixture",
      } as const;
      await reserveDeviceQuotaForInsert(ctx, userId, device);
      const deviceId = await ctx.db.insert("devices", device);
      const bindChallenge = {
        authSessionId,
        challengeId: "bind_fair_retention",
        createdAt: now - 100_000,
        deviceId,
        expiresAt: now - 1,
        nonce: "nonce_fair_retention",
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "custody", bindChallenge);
      await ctx.db.insert("deviceBindChallenges", bindChallenge);
      const presence = {
        authEpoch: 1,
        connectionId: "018bcfe5-6800-7000-8000-000000000101",
        connectionSequence: 1,
        credentialGeneration: 1,
        deviceId,
        fingerprint: "6".repeat(64),
        observedAt: now - 100_000,
        presenceUntil: now - 1,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "device", presence);
      await ctx.db.insert("devicePresence", presence);
      const receipt = {
        createdAt: now - 100_000,
        expiresAt: now - 1,
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000102",
        operation: "fair",
        requestDigest: "7".repeat(64),
        responseJson: "{}",
        scopeId: "fair",
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "receipt", receipt);
      await ctx.db.insert("idempotencyReceipts", receipt);
      const session = {
        compactHeadSequence: 0,
        createdAt: now,
        detailHeadSequence: 0,
        executionDeviceId: deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "session_fair_retention",
        state: "idle",
        updatedAt: now,
        userId,
      } as const;
      await reserveSessionHeadQuotaForInsert(ctx, userId, session);
      const sessionId = await ctx.db.insert("sessionHeads", session);
      const commandBase = {
        createdAt: now - 100_000,
        deadline: now - 1,
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000103",
        kind: "stop" as const,
        payload: {
          algorithm: "A256GCM" as const,
          ciphertext: "B".repeat(32),
          keyVersion: 1,
          nonce: "B".repeat(16),
        },
        requestDigest: "8".repeat(64),
        requestingDeviceId: deviceId,
        sessionId,
        targetDeviceId: deviceId,
        userId,
      };
      const pendingCommand = {
        ...commandBase,
        nonterminal: true,
        publicId: "018bcfe5-6800-7000-8000-000000000104",
        state: "pending",
        updatedAt: now - 1,
      } as const;
      await reserveNonterminalCommandQuotaForInsert(ctx, userId, pendingCommand);
      await ctx.db.insert("sessionCommands", pendingCommand);
      const terminalCommand = {
        ...commandBase,
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000105",
        nonterminal: false,
        publicId: "018bcfe5-6800-7000-8000-000000000106",
        requesterAcknowledgedAt: now - 100_000,
        state: "applied",
        terminalCleanupAfter: now - 1,
        updatedAt: now - 100_000,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "command", terminalCommand);
      await ctx.db.insert("sessionCommands", terminalCommand);
      const securityEvent = {
        createdAt: now - 91 * 24 * 60 * 60 * 1_000,
        entityId: "fair",
        event: "lease_acquired",
        userId,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "security", securityEvent);
      await ctx.db.insert("securityEvents", securityEvent);
      const codexAccount = {
        createdAt: now,
        encryptedMetadata: {
          algorithm: "A256GCM",
          ciphertext: "C".repeat(32),
          keyVersion: 1,
          nonce: "C".repeat(16),
        },
        matchKey: "match_fair",
        publicId: "account_fair_retention",
        updatedAt: now,
        userId,
      } as const;
      await reserveCodexAccountQuotaForInsert(ctx, userId, codexAccount);
      const codexAccountId = await ctx.db.insert("codexAccounts", codexAccount);
      await initializeAccountUsageQuotaAuthority(ctx, userId, codexAccountId);
      const usageSnapshot = {
        accountId: codexAccountId,
        createdAt: now - 91 * 24 * 60 * 60 * 1_000,
        digest: "9".repeat(64),
        envelope: {
          algorithm: "A256GCM",
          ciphertext: "D".repeat(32),
          keyVersion: 1,
          nonce: "D".repeat(16),
        },
        observedAt: now - 91 * 24 * 60 * 60 * 1_000,
        receivedAt: now - 91 * 24 * 60 * 60 * 1_000,
        sourceDeviceId: deviceId,
        sourceDevicePublicId: "device_fair_retention",
        sourceRevision: 1,
        userId,
      } as const;
      await reserveAccountUsageSnapshotQuotaForInsert(
        ctx,
        userId,
        codexAccountId,
        usageSnapshot,
      );
      await ctx.db.insert("accountUsageSnapshots", usageSnapshot);
      const deletionReceipt = {
        completedAt: now - 100_000,
        expiresAt: now - 1,
        publicId: "delete_fair_retention",
        statusCapabilityDigest: "a".repeat(64),
      };
      await reserveServiceQuotaForInsert(ctx, deletionReceipt);
      await ctx.db.insert("accountDeletionReceipts", deletionReceipt);
      const revocationJob = {
        category: "complete",
        createdAt: now - 8 * 24 * 60 * 60 * 1_000,
        deviceId,
        publicId: "018bcfe5-6800-7000-8000-000000000107",
        state: "complete",
        updatedAt: now - 8 * 24 * 60 * 60 * 1_000,
        userId,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "job", revocationJob);
      await ctx.db.insert("deviceRevocationJobs", revocationJob);
    });

    const result = await runtime.mutation(cleanupExpired, { limit: 200 });
    expect(result).toMatchObject({
      abandonedIdentities: 1,
      accountDeletionReceipts: 1,
      authAttempts: 1,
      authInvites: 1,
      bindChallenges: 1,
      devicePresence: 1,
      deviceRevocationJobs: 1,
      expiredPendingCommands: 1,
      idempotencyReceipts: 1,
      otpChallenges: 1,
      securityEvents: 1,
      terminalCommands: 1,
      usageSnapshots: 1,
      processed: 13,
      visitedCategories: 13,
    });
    expect(await runtime.run(async (ctx) => {
      const service = await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique();
      const accountResources = await ctx.db.query("storageResourceUsageByAccount")
        .collect();
      const userResources = await ctx.db.query("storageResourceUsageByUser")
        .collect();
      return {
        accountResources: accountResources.map((row) => ({
          records: row.records,
          resource: row.resource,
        })),
        attempts: (await ctx.db.query("authEmailAttemptEvents").collect()).length,
        maintenanceStates: (await ctx.db.query("maintenanceState").collect()).length,
        service: service === null ? null : {
          identities: service.identities,
          records: service.records,
          serviceLogicalBytes: service.serviceLogicalBytes,
          serviceRecords: service.serviceRecords,
          userRecords: service.userRecords,
        },
        userResources: userResources.map((row) => ({
          records: row.records,
          resource: row.resource,
        })).sort((left, right) => left.resource.localeCompare(right.resource)),
      };
    })).toEqual({
      accountResources: [{ records: 0, resource: "usage_snapshot" }],
      attempts: 0,
      maintenanceStates: 1,
      service: {
        identities: 1,
        records: 7,
        serviceLogicalBytes: 0,
        serviceRecords: 0,
        userRecords: 7,
      },
      userResources: [
        { records: 1, resource: "codex_account" },
        { records: 1, resource: "device" },
        { records: 0, resource: "nonterminal_command" },
        { records: 0, resource: "session_chunk" },
        { records: 1, resource: "session_head" },
      ],
    });
  });
});
