import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import {
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
      accountDeletionReceipts: 1,
      authAttempts: 1,
      authInvites: 1,
      bindChallenges: 1,
      devicePresence: 1,
      deviceRevocationJobs: 1,
      expiredPendingCommands: 1,
      expiredPendingDeviceCommands: 1,
      idempotencyReceipts: 1,
      liveTailChunks: 0,
      otpChallenges: 1,
      securityEvents: 1,
      terminalCommands: 1,
      terminalDeviceCommands: 1,
      usageSnapshots: 1,
      processed: 15,
      visitedCategories: 16,
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
        records: 8,
        serviceLogicalBytes: 0,
        serviceRecords: 0,
        userRecords: 8,
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
});
