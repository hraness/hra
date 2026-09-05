import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { sha256Hex } from "../src/cloud/crypto";
import { buildHraAttentionEmailBody } from "./attentionEmail";
import { attentionNotificationQuotaReservations } from "./attentionNotifications";
import { reserveAttentionNotificationFaultCapacity } from "./attentionNotificationControl";
import {
  adjustCommandQuotaForPatch,
  initializeAccountUsageQuotaAuthority,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  reserveAccountUsageSnapshotQuotaForInsert,
  reserveCodexAccountQuotaForInsert,
  reserveDeviceQuotaForInsert,
  reserveNonterminalCommandQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveServiceQuotaForInsert,
  reserveSessionHeadQuotaForInsert,
  requireHardQuotaAuthority,
  USER_TOTAL_QUOTA,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
const cleanupExpired = makeFunctionReference<"mutation", Args, Readonly<{
  abandonedIdentities: number;
  attentionNotificationFaults: number;
  accountDeletionReceipts: number;
  authAttempts: number;
  authInvites: number;
  bindChallenges: number;
  deviceCommandLoginResults: number;
  devicePresence: number;
  deviceRevocationJobs: number;
  expiredPendingAttentionNotifications: number;
  expiredPendingCommands: number;
  expiredPendingDeviceCommands: number;
  idempotencyReceipts: number;
  nextCategory: string;
  otpChallenges: number;
  processed: number;
  securityEvents: number;
  startedAttentionNotifications: number;
  terminalAttentionNotifications: number;
  terminalCommands: number;
  terminalDeviceCommands: number;
  usageSnapshots: number;
  visitedCategories: number;
}>>("maintenance:cleanupExpired");
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);
const consumeOtpChallenge = makeFunctionReference<"mutation", Args, unknown>(
  "authDelivery:consumeOtpChallenge",
);

describe("bounded cloud retention", () => {
  test("does not create maintenance state before hard genesis", async () => {
    const runtime = convexTest(schema, modules);
    await expect(runtime.mutation(cleanupExpired, { limit: 200 }))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    expect(await runtime.run(async (ctx) =>
      (await ctx.db.query("maintenanceState").collect()).length)).toBe(0);
  });

  test("materializes a legacy usage cursor before deleting its final source row", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisQuota, {});
    const now = Date.now();
    const fixture = await runtime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "legacy-usage-retention@example.com" });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing legacy usage retention user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      const device = {
        activatedAt: now,
        authEpoch: 1,
        createdAt: now,
        encryptedLabel: {
          algorithm: "A256GCM" as const,
          ciphertext: "A".repeat(32),
          keyVersion: 1,
          nonce: "A".repeat(16),
        },
        keyVersion: 1,
        publicId: "device_legacy_usage_retention",
        revision: 1,
        signingPublicKey: "{}",
        status: "active" as const,
        updatedAt: now,
        userId,
        wrappingPublicKey: "{}",
      };
      await reserveDeviceQuotaForInsert(ctx, userId, device);
      const deviceId = await ctx.db.insert("devices", device);
      const encrypted = {
        algorithm: "A256GCM" as const,
        ciphertext: "B".repeat(32),
        keyVersion: 1,
        nonce: "B".repeat(16),
      };
      const account = {
        createdAt: now,
        encryptedMetadata: encrypted,
        matchKey: "b".repeat(64),
        publicId: "codex_legacy_usage_retention",
        updatedAt: now,
        userId,
      };
      await reserveCodexAccountQuotaForInsert(ctx, userId, account);
      const accountId = await ctx.db.insert("codexAccounts", account);
      await initializeAccountUsageQuotaAuthority(ctx, userId, accountId);
      const binding = {
        accountId,
        deviceId,
        encryptedLocalReference: encrypted,
        lastSeenAt: now,
        sourceGeneration: 1,
        state: "present" as const,
        updatedAt: now,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "account", binding);
      const bindingId = await ctx.db.insert("deviceAccountBindings", binding);
      for (const sourceRevision of [1, 2]) {
        const receivedAt = now - (93 - sourceRevision) * 24 * 60 * 60 * 1_000;
        const snapshot = {
          accountId,
          createdAt: receivedAt,
          digest: sourceRevision.toString(16).padStart(64, "0"),
          envelope: encrypted,
          observedAt: receivedAt - 1_000,
          receivedAt,
          sourceDeviceId: deviceId,
          sourceDevicePublicId: device.publicId,
          sourceRevision,
          userId,
        };
        await reserveAccountUsageSnapshotQuotaForInsert(ctx, userId, accountId, snapshot);
        await ctx.db.insert("accountUsageSnapshots", snapshot);
      }
      const categoryRows = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder.eq("userId", userId))
        .collect();
      const chunk = categoryRows.find((row) => row.category === "chunk");
      const service = await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique();
      if (chunk === undefined || service === null) throw new Error("missing near-ceiling quota authority");
      const currentUserBytes = categoryRows.reduce((total, row) => total + row.logicalBytes, 0);
      const fillerBytes = USER_TOTAL_QUOTA.logicalBytes - 1 - currentUserBytes;
      if (fillerBytes <= 0) throw new Error("invalid near-ceiling quota fixture");
      await ctx.db.patch(chunk._id, {
        logicalBytes: fillerBytes,
        records: 1,
        updatedAt: now,
      });
      await ctx.db.patch(service._id, {
        logicalBytes: service.logicalBytes + fillerBytes,
        records: service.records + 1,
        updatedAt: now,
        userLogicalBytes: service.userLogicalBytes + fillerBytes,
        userRecords: service.userRecords + 1,
      });
      return { accountId, bindingId, userId };
    });

    expect(await runtime.mutation(cleanupExpired, { limit: 200 }))
      .toMatchObject({ usageSnapshots: 2 });
    expect(await runtime.run(async (ctx) => {
      const binding = await ctx.db.get(fixture.bindingId);
      const usageQuota = await ctx.db.query("storageResourceUsageByAccount")
        .withIndex("by_account_and_resource", (builder) => builder
          .eq("accountId", fixture.accountId)
          .eq("resource", "usage_snapshot"))
        .unique();
      return {
        remaining: (await ctx.db.query("accountUsageSnapshots").collect()).length,
        usageAdmission: binding?.usageAdmission,
        usageRecords: usageQuota?.records ?? 0,
      };
    })).toEqual({
      remaining: 0,
      usageAdmission: {
        cursor: {
          digest: "2".padStart(64, "0"),
          disposition: "stored",
          observedAt: now - 91 * 24 * 60 * 60 * 1_000 - 1_000,
          sourceRevision: 2,
        },
        lastAcceptedAt: now - 91 * 24 * 60 * 60 * 1_000,
      },
      usageRecords: 0,
    });
    const accounting = await runtime.run(async (ctx) => {
      const account = await ctx.db.get(fixture.accountId);
      const binding = await ctx.db.get(fixture.bindingId);
      const quota = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", fixture.userId)
          .eq("category", "account"))
        .unique();
      return {
        actual: quota?.logicalBytes,
        expected: (account === null ? 0 : logicalDocumentBytes(account))
          + (binding === null ? 0 : logicalDocumentBytes(binding)),
      };
    });
    expect(accounting.actual).toBe(accounting.expected);
    const initialAccounting = await runtime.run(async (ctx) => {
      const categories = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder.eq("userId", fixture.userId))
        .collect();
      const service = await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique();
      return {
        serviceUserBytes: service?.userLogicalBytes,
        userBytes: categories.reduce((total, row) => total + row.logicalBytes, 0),
      };
    });
    expect(initialAccounting.userBytes).toBeGreaterThan(0);
    expect(initialAccounting.serviceUserBytes).toBe(initialAccounting.userBytes);
    const nearCeiling = await runtime.run(async (ctx) => {
      const categories = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder.eq("userId", fixture.userId))
        .collect();
      const service = await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique();
      return {
        serviceUserBytes: service?.userLogicalBytes ?? -1,
        userBytes: categories.reduce((total, row) => total + row.logicalBytes, 0),
      };
    });
    expect(nearCeiling.userBytes).toBeLessThan(USER_TOTAL_QUOTA.logicalBytes);
    expect(nearCeiling.serviceUserBytes).toBe(nearCeiling.userBytes);
  });

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

  test("preserves valid verification and exact quota authority while abandoned cleanup races", async () => {
    for (const first of ["cleanup", "verification"] as const) {
      const runtime = convexTest(schema, modules);
      await runtime.mutation(genesisQuota, {});
      const now = Date.now();
      const emailDigest = first === "cleanup" ? "d".repeat(64) : "e".repeat(64);
      const codeDigest = first === "cleanup" ? "f".repeat(64) : "a".repeat(64);
      const fixture = await runtime.run(async (ctx) => {
        const userId = await ctx.db.insert("users", { email: `${first}@example.com` });
        await initializeUserQuotaAuthority(ctx, userId);
        const user = await ctx.db.get(userId);
        if (user === null) throw new Error("missing verification race user");
        await reserveQuotaForStoredIdentity(ctx, userId, user);
        const account = {
          provider: "hra-control-plane-otp-v1",
          providerAccountId: `${first}@example.com`,
          userId,
        };
        await reserveQuotaForInsert(ctx, userId, "identity", account);
        const accountId = await ctx.db.insert("authAccounts", account);
        const invite = {
          admissionExpiresAt: now + 60_000,
          boundAt: now - 2 * 24 * 60 * 60 * 1_000,
          boundEmailDigest: emailDigest,
          capabilityDigest: (first === "cleanup" ? "b" : "c").repeat(64),
          createdAt: now - 2 * 24 * 60 * 60 * 1_000,
          expiresAt: now + 60_000,
          publicId: `invite_verification_cleanup_${first}`,
          purpose: "identity" as const,
          state: "bound_to_email" as const,
          updatedAt: now - 2 * 24 * 60 * 60 * 1_000,
        };
        await reserveServiceQuotaForInsert(ctx, invite);
        const inviteId = await ctx.db.insert("authInvites", invite);
        const subject = {
          admissionInviteId: inviteId,
          authEpoch: 1,
          createdAt: now - 2 * 24 * 60 * 60 * 1_000,
          emailDigest,
          status: "active" as const,
          updatedAt: now - 2 * 24 * 60 * 60 * 1_000,
          userId,
        };
        await reserveQuotaForInsert(ctx, userId, "identity", subject);
        const subjectId = await ctx.db.insert("authSubjects", subject);
        const challenge = {
          accountId,
          authEpoch: 1,
          codeDigest,
          createdAt: now,
          deliveryState: "accepted" as const,
          emailDigest,
          expiresAt: now + 60_000,
          updatedAt: now,
          userId,
        };
        await reserveQuotaForInsert(ctx, userId, "identity", challenge);
        const challengeId = await ctx.db.insert("authOtpChallenges", challenge);
        return { accountId, challengeId, inviteId, subjectId, userId };
      });

      const verify = async () => await runtime.mutation(consumeOtpChallenge, {
        authEpoch: 1,
        codeDigest,
        emailDigest,
      });
      const cleanup = async () => await runtime.mutation(cleanupExpired, { limit: 200 });
      const results = first === "cleanup"
        ? await Promise.all([cleanup(), verify()])
        : await Promise.all([verify(), cleanup()]);
      expect(results).toHaveLength(2);

      const observed = await runtime.run(async (ctx) => {
        await requireHardQuotaAuthority(ctx);
        const [account, challenge, invite, subject, user] = await Promise.all([
          ctx.db.get(fixture.accountId),
          ctx.db.get(fixture.challengeId),
          ctx.db.get(fixture.inviteId),
          ctx.db.get(fixture.subjectId),
          ctx.db.get(fixture.userId),
        ]);
        const identity = await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (query) =>
            query.eq("userId", fixture.userId).eq("category", "identity"))
          .unique();
        const service = await ctx.db.query("storageUsageService")
          .withIndex("by_key", (query) => query.eq("key", "global"))
          .unique();
        const chargedDocument = (value: Readonly<Record<string, unknown>>) => {
          const document = Object.fromEntries(Object.entries(value).filter(
            ([key]) => key !== "_creationTime" && key !== "_id",
          ));
          return logicalDocumentBytes(document as Readonly<Record<string, Value>>);
        };
        const expectedIdentityBytes = account === null || subject === null || user === null
          ? -1
          : chargedDocument(account) + chargedDocument(subject) + chargedDocument(user);
        return {
          account,
          challenge,
          expectedIdentityBytes,
          identity,
          invite,
          service,
          subject,
          user,
        };
      });
      expect(observed.challenge).toBeNull();
      expect(observed.account).toMatchObject({ emailVerified: `${first}@example.com` });
      expect(observed.invite).toMatchObject({ state: "consumed" });
      expect(observed.subject).toMatchObject({ status: "active", userId: fixture.userId });
      expect(observed.subject?.verifiedAt).toBeNumber();
      expect(observed.user?.emailVerificationTime).toBe(observed.subject?.verifiedAt);
      expect(observed.identity).toMatchObject({
        logicalBytes: observed.expectedIdentityBytes,
        records: 3,
      });
      expect(observed.service).toMatchObject({
        identities: 1,
        serviceRecords: 1,
        userRecords: 3,
      });
    }
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
      const expiredLoginResult = {
        createdAt: now - 10 * 60 * 1_000,
        deadline: now - 9 * 60 * 1_000,
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000006",
        kind: "account_login_start" as const,
        nonterminal: false,
        payload: {
          algorithm: "A256GCM" as const,
          ciphertext: "C".repeat(32),
          keyVersion: 1,
          nonce: "C".repeat(16),
        },
        publicId: "018bcfe5-6800-7000-8000-000000000007",
        requestDigest: "e".repeat(64),
        requestingDeviceId: deviceId,
        result: {
          algorithm: "A256GCM" as const,
          ciphertext: "R".repeat(48),
          keyVersion: 1,
          nonce: "R".repeat(16),
        },
        resultCode: "APPLIED",
        resultDigest: "f".repeat(64),
        resultExpiresAt: now - 1,
        resultSingleUse: true,
        state: "applied" as const,
        targetDeviceId: deviceId,
        updatedAt: now - 5 * 60 * 1_000,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "command", expiredLoginResult);
      const expiredLoginResultId = await ctx.db.insert("deviceCommands", expiredLoginResult);
      const { resultExpiresAt: removedLegacyExpiry, ...legacyLoginResultBase } =
        expiredLoginResult;
      if (removedLegacyExpiry !== now - 1) throw new Error("invalid legacy expiry fixture");
      const legacyExpiredLoginResult = {
        ...legacyLoginResultBase,
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000008",
        publicId: "018bcfe5-6800-7000-8000-000000000009",
        resultDigest: "0".repeat(64),
      };
      await reserveQuotaForInsert(ctx, userId, "command", legacyExpiredLoginResult);
      const legacyExpiredLoginResultId = await ctx.db.insert(
        "deviceCommands",
        legacyExpiredLoginResult,
      );
      const oldSecurity = {
        createdAt: now - 91 * 24 * 60 * 60 * 1_000,
        entityId: "fixture_retention",
        event: "lease_acquired",
        userId,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "security", oldSecurity);
      const oldSecurityId = await ctx.db.insert("securityEvents", oldSecurity);
      return {
        expiredLoginResultId,
        legacyExpiredLoginResultId,
        oldSecurityId,
        oldTerminalId,
        pendingId,
        recentTerminalId,
        unacknowledgedTerminalId,
        userId,
      };
    });

    const result = await runtime.mutation(cleanupExpired, { limit: 10 });
    expect(result).toMatchObject({
      deviceCommandLoginResults: 2,
      expiredPendingCommands: 1,
      securityEvents: 1,
      terminalCommands: 1,
    });
    expect(await runtime.run(async (ctx) => {
      const loginResult = await ctx.db.get(ids.expiredLoginResultId);
      const legacyLoginResult = await ctx.db.get(ids.legacyExpiredLoginResultId);
      const projectLoginResult = (record: typeof loginResult) => record === null
        ? null
        : {
            hasResult: "result" in record,
            hasResultExpiresAt: "resultExpiresAt" in record,
            resultConsumedAt: record.resultConsumedAt,
            resultSingleUse: record.resultSingleUse,
            state: record.state,
          };
      return {
        oldSecurity: await ctx.db.get(ids.oldSecurityId),
        oldTerminal: await ctx.db.get(ids.oldTerminalId),
        pending: await ctx.db.get(ids.pendingId),
        loginResult: projectLoginResult(loginResult),
        legacyLoginResult: projectLoginResult(legacyLoginResult),
        recentTerminal: await ctx.db.get(ids.recentTerminalId),
        unacknowledgedTerminal: await ctx.db.get(ids.unacknowledgedTerminalId),
      };
    })).toMatchObject({
      oldSecurity: null,
      oldTerminal: null,
      pending: { state: "expired" },
      loginResult: {
        hasResult: false,
        hasResultExpiresAt: false,
        resultConsumedAt: expect.any(Number),
        resultSingleUse: true,
        state: "applied",
      },
      legacyLoginResult: {
        hasResult: false,
        hasResultExpiresAt: false,
        resultConsumedAt: expect.any(Number),
        resultSingleUse: true,
        state: "applied",
      },
      recentTerminal: { state: "applied" },
      unacknowledgedTerminal: { state: "applied" },
    });
    expect(await runtime.run(async (ctx) => {
      const expiredPending = await ctx.db.get(ids.pendingId);
      const oldTerminal = await ctx.db.get(ids.unacknowledgedTerminalId);
      return {
        expiredPendingAcknowledged: expiredPending !== null
          && "requesterAcknowledgedAt" in expiredPending,
        expiredPendingHasCleanup: expiredPending !== null
          && "terminalCleanupAfter" in expiredPending,
        oldTerminalAcknowledged: oldTerminal !== null
          && "requesterAcknowledgedAt" in oldTerminal,
      };
    })).toEqual({
      expiredPendingAcknowledged: false,
      expiredPendingHasCleanup: false,
      oldTerminalAcknowledged: false,
    });
    const accounting = async () => await runtime.run(async (ctx) => {
      const [sessionCommands, deviceCommands, quota, service] = await Promise.all([
        ctx.db.query("sessionCommands").collect(),
        ctx.db.query("deviceCommands").collect(),
        ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (builder) => builder
            .eq("userId", ids.userId)
            .eq("category", "command"))
          .unique(),
        ctx.db.query("storageUsageService")
          .withIndex("by_key", (builder) => builder.eq("key", "global"))
          .unique(),
      ]);
      const chargedBytes = [...sessionCommands, ...deviceCommands].reduce((total, document) => {
        const stored = Object.fromEntries(Object.entries(document).filter(
          ([key]) => key !== "_creationTime" && key !== "_id",
        )) as Readonly<Record<string, Value>>;
        return total + logicalDocumentBytes(stored);
      }, 0);
      return {
        chargedBytes,
        quotaBytes: quota?.logicalBytes,
        serviceUserBytes: service?.userLogicalBytes,
      };
    });
    const afterFirstSweep = await accounting();
    expect(afterFirstSweep.quotaBytes).toBe(afterFirstSweep.chargedBytes);
    expect(await runtime.mutation(cleanupExpired, { limit: 10 }))
      .toMatchObject({ deviceCommandLoginResults: 0 });
    expect(await accounting()).toEqual(afterFirstSweep);
  });

  test("drains every legacy terminal device state within budget at the hard quota ceiling", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisQuota, {});
    const now = Date.now();
    const terminalStates = ["applied", "failed", "ambiguous", "cancelled", "expired"] as const;
    const fixture = await runtime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "legacy-device-drain@example.com" });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing legacy device drain user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      const device = {
        activatedAt: now,
        authEpoch: 1,
        createdAt: now,
        encryptedLabel: {
          algorithm: "A256GCM" as const,
          ciphertext: "A".repeat(32),
          keyVersion: 1,
          nonce: "A".repeat(16),
        },
        keyVersion: 1,
        publicId: "device_legacy_device_drain",
        revision: 1,
        signingPublicKey: "{}",
        status: "active" as const,
        updatedAt: now,
        userId,
        wrappingPublicKey: "{}",
      };
      await reserveDeviceQuotaForInsert(ctx, userId, device);
      const deviceId = await ctx.db.insert("devices", device);
      const payload = {
        algorithm: "A256GCM" as const,
        ciphertext: "B".repeat(32),
        keyVersion: 1,
        nonce: "B".repeat(16),
      };
      const oldIds = [];
      for (const [index, state] of terminalStates.entries()) {
        const ordinal = (index + 1).toString(16);
        const command = {
          createdAt: now - 60 * 24 * 60 * 60 * 1_000,
          deadline: now - 59 * 24 * 60 * 60 * 1_000,
          idempotencyKey: `018bcfe5-6800-7000-8000-0000000003${ordinal}`,
          kind: "usage_refresh" as const,
          nonterminal: false,
          payload,
          publicId: `018bcfe5-6800-7000-8000-0000000004${ordinal}`,
          requestDigest: ordinal.repeat(64),
          requestingDeviceId: deviceId,
          state,
          targetDeviceId: deviceId,
          updatedAt: now - 60 * 24 * 60 * 60 * 1_000,
          userId,
        };
        await reserveQuotaForInsert(ctx, userId, "command", command);
        oldIds.push(await ctx.db.insert("deviceCommands", command));
      }
      const youngCommand = {
        createdAt: now - 24 * 60 * 60 * 1_000,
        deadline: now - 1,
        idempotencyKey: "018bcfe5-6800-7000-8000-00000000036",
        kind: "usage_refresh" as const,
        nonterminal: false,
        payload,
        publicId: "018bcfe5-6800-7000-8000-00000000046",
        requestDigest: "f".repeat(64),
        requestingDeviceId: deviceId,
        state: "expired" as const,
        targetDeviceId: deviceId,
        updatedAt: now - 24 * 60 * 60 * 1_000,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "command", youngCommand);
      const youngId = await ctx.db.insert("deviceCommands", youngCommand);

      // Leave one byte of quota headroom. Any repair that first adds hosted
      // acknowledgement metadata would fail; direct deletion must still run.
      const categoryRows = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder.eq("userId", userId))
        .collect();
      const chunk = categoryRows.find((row) => row.category === "chunk");
      const service = await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique();
      if (chunk === undefined || service === null) throw new Error("missing drain quota authority");
      const currentUserBytes = categoryRows.reduce((total, row) => total + row.logicalBytes, 0);
      const fillerBytes = USER_TOTAL_QUOTA.logicalBytes - 1 - currentUserBytes;
      if (fillerBytes <= 0) throw new Error("invalid drain quota fixture");
      await ctx.db.patch(chunk._id, {
        logicalBytes: fillerBytes,
        records: 1,
        updatedAt: now,
      });
      await ctx.db.patch(service._id, {
        logicalBytes: service.logicalBytes + fillerBytes,
        records: service.records + 1,
        updatedAt: now,
        userLogicalBytes: service.userLogicalBytes + fillerBytes,
        userRecords: service.userRecords + 1,
      });
      return { oldIds, userId, youngId };
    });

    const accounting = async () => await runtime.run(async (ctx) => {
      const commands = await ctx.db.query("deviceCommands")
        .withIndex("by_user", (builder) => builder.eq("userId", fixture.userId))
        .collect();
      const quota = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", fixture.userId)
          .eq("category", "command"))
        .unique();
      const service = await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique();
      const expectedBytes = commands.reduce((total, document) => total + logicalDocumentBytes(
        Object.fromEntries(Object.entries(document).filter(
          ([key]) => key !== "_creationTime" && key !== "_id",
        )) as Readonly<Record<string, Value>>,
      ), 0);
      return {
        commandBytes: quota?.logicalBytes,
        commandRecords: quota?.records,
        expectedBytes,
        ids: commands.map((command) => String(command._id)).sort(),
        serviceUserBytes: service?.userLogicalBytes,
      };
    });

    const before = await accounting();
    expect(before.commandBytes).toBe(before.expectedBytes);
    expect(await runtime.mutation(cleanupExpired, { limit: 3 })).toMatchObject({
      processed: 3,
      terminalDeviceCommands: 3,
    });
    const afterFirst = await accounting();
    expect(afterFirst.commandBytes).toBe(afterFirst.expectedBytes);
    expect((before.commandRecords ?? 0) - (afterFirst.commandRecords ?? 0)).toBe(3);
    expect((before.commandBytes ?? 0) - (afterFirst.commandBytes ?? 0)).toBe(
      (before.serviceUserBytes ?? 0) - (afterFirst.serviceUserBytes ?? 0),
    );

    expect(await runtime.mutation(cleanupExpired, { limit: 3 })).toMatchObject({
      processed: 2,
      terminalDeviceCommands: 2,
    });
    const afterSecond = await accounting();
    expect(afterSecond.commandBytes).toBe(afterSecond.expectedBytes);
    expect((afterFirst.commandRecords ?? 0) - (afterSecond.commandRecords ?? 0)).toBe(2);
    expect((afterFirst.commandBytes ?? 0) - (afterSecond.commandBytes ?? 0)).toBe(
      (afterFirst.serviceUserBytes ?? 0) - (afterSecond.serviceUserBytes ?? 0),
    );
    expect(afterSecond.ids).toEqual([String(fixture.youngId)]);
    expect(fixture.oldIds.every((id) => !afterSecond.ids.includes(String(id)))).toBe(true);
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
      const notificationBase = {
        allowedWindowEnd: now + 60_000,
        claimDeadline: now - 1,
        coalesceAfter: now - 60_000,
        consentLeaseUntil: now + 60_000,
        createdAt: now - 100_000,
        executionAuthority: {
          bootGeneration: 1,
          bootId: "boot_fair_notification",
          fence: 1,
        },
        globalNotificationGeneration: 1,
        interactionDeadline: now + 60_000,
        interactionKind: "command_approval" as const,
        interactionRevision: 1,
        localNotificationPolicyRevision: 1,
        reconciliationSequence: 1,
        remoteActions: ["decline"] as ("answer" | "decline")[],
        sessionId,
        sessionPublicId: session.publicId,
        sourceDeviceId: deviceId,
        updatedAt: now - 100_000,
        userId,
      };
      const pendingNotification = {
        ...notificationBase,
        claimCapacityReservation: attentionNotificationQuotaReservations.pending,
        interactionId: "interaction_fair_pending",
        nonterminal: true,
        state: "pending" as const,
      };
      await reserveNonterminalCommandQuotaForInsert(ctx, userId, pendingNotification);
      await ctx.db.insert("attentionNotificationOutbox", pendingNotification);
      const startedNotification = {
        ...notificationBase,
        claimCapacityReservation: attentionNotificationQuotaReservations.pending,
        claimDeadline: now + 60_000,
        interactionId: "interaction_fair_started",
        nonterminal: true,
        state: "pending" as const,
      };
      await reserveNonterminalCommandQuotaForInsert(ctx, userId, startedNotification);
      const startedNotificationId = await ctx.db.insert(
        "attentionNotificationOutbox",
        startedNotification,
      );
      const startedBody = buildHraAttentionEmailBody([{
        interactionKind: startedNotification.interactionKind,
        sessionPublicId: startedNotification.sessionPublicId,
      }]);
      const startedBodyDigest = await sha256Hex(
        `hra-attention-body:v1\u0000${startedBody.text}`,
      );
      const startedDeliveryId = "01912345-6789-7abc-8def-0123456789d1";
      const startedRecipientDigest = "7".repeat(64);
      const startedIdempotencyKey = await sha256Hex([
        "hra-attention-resend:v1",
        startedDeliveryId,
        startedRecipientDigest,
        startedBodyDigest,
      ].join("\u0000"));
      const startedPatch = {
        claimCapacityReservation: attentionNotificationQuotaReservations.started,
        delivery: {
          attemptCount: 3,
          body: startedBody,
          bodyDigest: startedBodyDigest,
          claimedAt: now - 200_000,
          deadline: now - 1,
          effectStartedAt: now - 200_000,
          firstAttemptAt: now - 200_000,
          generation: 1,
          id: startedDeliveryId,
          idempotencyKey: startedIdempotencyKey,
          lastAttemptAt: now - 200_000,
          leaderRowId: startedNotificationId,
          recipientDigest: startedRecipientDigest,
        },
        faultCapacityAnchor: startedNotificationId,
        state: "effect_started" as const,
      };
      expect(await reserveAttentionNotificationFaultCapacity(ctx, {
        anchorRowId: startedNotificationId,
        deliveryId: startedDeliveryId,
        now,
        userId,
      })).toBe(true);
      await adjustCommandQuotaForPatch(ctx, userId, startedNotification, startedPatch);
      await ctx.db.patch(startedNotificationId, startedPatch);
      const terminalNotification = {
        ...notificationBase,
        interactionId: "interaction_fair_terminal",
        nonterminal: false,
        state: "cancelled" as const,
        terminalCleanupAfter: now - 1,
      };
      await reserveQuotaForInsert(ctx, userId, "command", terminalNotification);
      await ctx.db.insert("attentionNotificationOutbox", terminalNotification);
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
      // Device commands sweep on their own two categories, so the rotation
      // fixture carries one row for each of them as well.
      const deviceCommandBase = {
        createdAt: now - 8 * 24 * 60 * 60 * 1_000,
        deadline: now - 1,
        kind: "usage_refresh" as const,
        payload: {
          algorithm: "A256GCM" as const,
          ciphertext: "D".repeat(32),
          keyVersion: 1,
          nonce: "D".repeat(16),
        },
        requestDigest: "9".repeat(64),
        requestingDeviceId: deviceId,
        targetDeviceId: deviceId,
        userId,
      };
      const pendingDeviceCommand = {
        ...deviceCommandBase,
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000108",
        nonterminal: true,
        publicId: "018bcfe5-6800-7000-8000-000000000109",
        requesterAcknowledgedAt: now - 100_000,
        state: "pending",
        updatedAt: now - 1,
      } as const;
      await reserveNonterminalCommandQuotaForInsert(ctx, userId, pendingDeviceCommand);
      await ctx.db.insert("deviceCommands", pendingDeviceCommand);
      const terminalDeviceCommand = {
        ...deviceCommandBase,
        idempotencyKey: "018bcfe5-6800-7000-8000-00000000010a",
        nonterminal: false,
        publicId: "018bcfe5-6800-7000-8000-00000000010b",
        requesterAcknowledgedAt: now - 100_000,
        state: "applied",
        terminalCleanupAfter: now - 1,
        updatedAt: now - 100_000,
      } as const;
      await reserveQuotaForInsert(ctx, userId, "command", terminalDeviceCommand);
      await ctx.db.insert("deviceCommands", terminalDeviceCommand);
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
      attentionNotificationFaults: 0,
      accountDeletionReceipts: 1,
      authAttempts: 1,
      authInvites: 1,
      bindChallenges: 1,
      deviceCommandLoginResults: 0,
      devicePresence: 1,
      deviceRevocationJobs: 1,
      expiredPendingAttentionNotifications: 1,
      expiredPendingCommands: 1,
      expiredPendingDeviceCommands: 1,
      idempotencyReceipts: 1,
      liveTailChunks: 0,
      otpChallenges: 1,
      securityEvents: 1,
      startedAttentionNotifications: 1,
      terminalAttentionNotifications: 1,
      terminalCommands: 1,
      terminalDeviceCommands: 1,
      usageSnapshots: 1,
      processed: 18,
      visitedCategories: 21,
    });
    expect(await runtime.run(async (ctx) => {
      const row = (await ctx.db.query("deviceCommands").collect())
        .find((command) => command.publicId === "018bcfe5-6800-7000-8000-000000000109");
      return row === undefined
        ? null
        : {
            requesterAcknowledgedAt: row.requesterAcknowledgedAt,
            state: row.state,
            terminalCleanupAfter: row.terminalCleanupAfter,
          };
    })).toMatchObject({
      requesterAcknowledgedAt: expect.any(Number),
      state: "expired",
      terminalCleanupAfter: expect.any(Number),
    });
    const retainedNotifications = await runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect());
    expect(retainedNotifications.find((row) =>
      row.interactionId === "interaction_fair_started")).toMatchObject({
      delivery: {
        outcomeCode: "unsettled_effect",
        outcomeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown as string,
        settledAt: expect.any(Number) as unknown as number,
      },
      nonterminal: false,
      state: "ambiguous",
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
        // The expired pending device command is still a stored row: expiry
        // terminalizes it, and the terminal sweep deletes it only after the
        // requester has acknowledged and the retention window has passed.
        records: 10,
        serviceLogicalBytes: 0,
        serviceRecords: 0,
        userRecords: 10,
      },
      userResources: [
        { records: 1, resource: "codex_account" },
        { records: 1, resource: "device" },
        { records: 0, resource: "live_chunk" },
        { records: 0, resource: "nonterminal_command" },
        { records: 0, resource: "session_chunk" },
        { records: 1, resource: "session_head" },
      ],
    });
  });

  test("closes only complete attention delivery groups within the row budget", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisQuota, {});
    const now = Date.now();
    await runtime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "attention-maintenance@example.com" });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing attention maintenance user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      const device = {
        activatedAt: now,
        authEpoch: 1,
        createdAt: now,
        encryptedLabel: {
          algorithm: "A256GCM" as const,
          ciphertext: "A".repeat(32),
          keyVersion: 1,
          nonce: "A".repeat(16),
        },
        keyVersion: 1,
        publicId: "device_attention_maintenance",
        revision: 1,
        signingPublicKey: "fixture-signing-key",
        status: "active" as const,
        updatedAt: now,
        userId,
        wrappingPublicKey: "fixture-wrapping-key",
      };
      await reserveDeviceQuotaForInsert(ctx, userId, device);
      const deviceId = await ctx.db.insert("devices", device);
      const session = {
        compactHeadSequence: 0,
        createdAt: now,
        detailHeadSequence: 0,
        executionDeviceId: deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "session_attention_maintenance",
        state: "idle" as const,
        updatedAt: now,
        userId,
      };
      await reserveSessionHeadQuotaForInsert(ctx, userId, session);
      const sessionId = await ctx.db.insert("sessionHeads", session);
      for (let groupIndex = 0; groupIndex < 3; groupIndex += 1) {
        const body = buildHraAttentionEmailBody(Array.from({ length: 8 }, () => ({
          interactionKind: "command_approval" as const,
          sessionPublicId: session.publicId,
        })));
        const bodyDigest = await sha256Hex(`hra-attention-body:v1\u0000${body.text}`);
        const deliveryId = `01912345-6789-7abc-8def-0123456789e${String(groupIndex)}`;
        const recipientDigest = String(groupIndex + 7).repeat(64);
        const idempotencyKey = await sha256Hex([
          "hra-attention-resend:v1",
          deliveryId,
          recipientDigest,
          bodyDigest,
        ].join("\u0000"));
        const rowIds = [];
        for (let rowIndex = 0; rowIndex < 8; rowIndex += 1) {
          const pending = {
            allowedWindowEnd: now + 60_000,
            claimCapacityReservation: attentionNotificationQuotaReservations.pending,
            claimDeadline: now + 60_000,
            coalesceAfter: now - 60_000,
            consentLeaseUntil: now + 60_000,
            createdAt: now - 100_000,
            executionAuthority: {
              bootGeneration: 1,
              bootId: "boot_attention_maintenance",
              fence: 1,
            },
            globalNotificationGeneration: 1,
            interactionDeadline: now + 60_000,
            interactionId: `interaction_attention_maintenance_${String(groupIndex)}_${String(rowIndex)}`,
            interactionKind: "command_approval" as const,
            interactionRevision: 1,
            localNotificationPolicyRevision: 1,
            nonterminal: true,
            reconciliationSequence: 1,
            remoteActions: ["decline"] as ("answer" | "decline")[],
            sessionId,
            sessionPublicId: session.publicId,
            sourceDeviceId: deviceId,
            state: "pending" as const,
            updatedAt: now - 100_000,
            userId,
          };
          await reserveNonterminalCommandQuotaForInsert(ctx, userId, pending);
          rowIds.push(await ctx.db.insert("attentionNotificationOutbox", pending));
        }
        const leaderRowId = rowIds[0];
        if (leaderRowId === undefined) throw new Error("missing attention group leader");
        expect(await reserveAttentionNotificationFaultCapacity(ctx, {
          anchorRowId: leaderRowId,
          deliveryId,
          now,
          userId,
        })).toBe(true);
        for (const [rowIndex, rowId] of rowIds.entries()) {
          const pending = await ctx.db.get(rowId);
          if (pending === null) throw new Error("missing attention group row");
          const patch = {
            claimCapacityReservation: attentionNotificationQuotaReservations.started,
            delivery: {
              attemptCount: 3,
              ...(rowIndex === 0
                ? { body }
                : {}),
              bodyDigest,
              claimedAt: now - 200_000,
              deadline: now - 30_000 + groupIndex * 1_000,
              effectStartedAt: now - 200_000,
              firstAttemptAt: now - 200_000,
              generation: 1,
              id: deliveryId,
              idempotencyKey,
              lastAttemptAt: now - 200_000,
              leaderRowId,
              nextAttemptAt: now - 60_000,
              recipientDigest,
            },
            faultCapacityAnchor: leaderRowId,
            state: "effect_started" as const,
          };
          await adjustCommandQuotaForPatch(ctx, userId, pending, patch);
          await ctx.db.patch(rowId, patch);
        }
      }
      await ctx.db.insert("maintenanceState", {
        key: "retention",
        nextCategory: "started_attention_notifications",
        updatedAt: now,
      });
    });

    expect(await runtime.mutation(cleanupExpired, { limit: 20 })).toMatchObject({
      processed: 16,
      startedAttentionNotifications: 16,
    });
    const groups = await runtime.run(async (ctx) => {
      const rows = await ctx.db.query("attentionNotificationOutbox").collect();
      return [0, 1, 2].map((groupIndex) => rows.filter((row) =>
        row.delivery?.id === `01912345-6789-7abc-8def-0123456789e${String(groupIndex)}`));
    });
    for (const group of groups.slice(0, 2)) {
      expect(group).toHaveLength(8);
      expect(new Set(group.map((row) => row.delivery?.settledAt)).size).toBe(1);
      expect(new Set(group.map((row) => row.delivery?.outcomeDigest)).size).toBe(1);
      expect(group.every((row) => row.delivery?.nextAttemptAt === undefined)).toBe(true);
      expect(group.every((row) => row.state === "ambiguous" && !row.nonterminal)).toBe(true);
    }
    expect(groups[2]).toHaveLength(8);
    expect(groups[2]?.every((row) =>
      row.state === "effect_started"
      && row.nonterminal
      && row.delivery?.settledAt === undefined)).toBe(true);

    await runtime.run(async (ctx) => {
      const corruptDeliveryId = "01912345-6789-7abc-8def-0123456789e2";
      const corruptRows = await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", corruptDeliveryId))
        .collect();
      const leader = corruptRows.find((row) => row.delivery?.body !== undefined);
      if (leader?.delivery?.body === undefined) throw new Error("missing corrupt leader fixture");
      await ctx.db.patch(leader._id, {
        delivery: {
          ...leader.delivery,
          body: { ...leader.delivery.body, text: `${leader.delivery.body.text} changed` },
        },
      });
      const state = await ctx.db.query("maintenanceState").unique();
      if (state === null) throw new Error("missing maintenance state fixture");
      await ctx.db.patch(state._id, { nextCategory: "started_attention_notifications" });
    });
    expect(await runtime.mutation(cleanupExpired, { limit: 20 })).toMatchObject({
      processed: 0,
      startedAttentionNotifications: 0,
    });
    const [control, fault] = await runtime.run(async (ctx) => await Promise.all([
      ctx.db.query("serviceControl").unique(),
      ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_state_and_observed_at", (builder) => builder.eq("state", "latched"))
        .first(),
    ]));
    expect(control).toMatchObject({ attentionNotificationGeneration: 1 });
    expect(fault).toMatchObject({
      deliveryId: "01912345-6789-7abc-8def-0123456789e2",
      reason: "stored_delivery_corrupt",
    });
    expect(control?.attentionNotifications).toBeUndefined();
    await runtime.run(async (ctx) => {
      const state = await ctx.db.query("maintenanceState").unique();
      if (state === null) throw new Error("missing maintenance state fixture");
      await ctx.db.patch(state._id, { nextCategory: "started_attention_notifications" });
    });
    expect(await runtime.mutation(cleanupExpired, { limit: 20 })).toMatchObject({
      processed: 8,
      startedAttentionNotifications: 8,
    });
    expect(await runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_delivery_id", (builder) => builder
          .eq("delivery.id", "01912345-6789-7abc-8def-0123456789e2"))
        .collect())).toEqual([]);
  });
});
