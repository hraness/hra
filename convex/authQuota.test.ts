import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";
import { convexTest } from "convex-test";

import { parseAuthCredentials } from "../src/cloud/authCredentials";
import {
  PINNED_CONVEX_AUTH_QUOTA_TABLE_MATRIX,
  PINNED_CONVEX_AUTH_STORE_OPERATIONS,
  runQuotaAwareAuthStoreForTest,
  store,
} from "./auth";
import { digestAuthEmail } from "./authEmail";
import {
  digestInviteCapability,
  generateInviteAuthority,
  invitePublicIdFromCapabilityDigest,
  minimumInviteLifetimeMs,
} from "./authInvites";
import {
  adjustParentAttributedQuotaForPatch,
  reserveServiceQuotaForInsert,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;

const authModules = {
  ...modules,
  "./auth.ts": async () => await import("./auth"),
};
const quotaGenesis = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);
const recordIssue = makeFunctionReference<"mutation", Args, unknown>(
  "authInvites:recordIssue",
);
const reserveAttempt = makeFunctionReference<"mutation", Args, unknown>(
  "authDelivery:reserveEmailAttempt",
);
const storeChallenge = makeFunctionReference<"mutation", Args, Id<"authOtpChallenges">>(
  "authDelivery:storeOtpChallenge",
);
const authStore = makeFunctionReference<"mutation", Args, unknown>("auth:store");
const transitionAdmission = makeFunctionReference<
  "mutation",
  { expectedGeneration: number; mutationId: string; state: "frozen" | "open" },
  unknown
>("admissionControl:transition");
const hmacEnvironmentName = "HRA_AUTH_HMAC_SECRET";
const priorHmacSecret = process.env[hmacEnvironmentName];

beforeAll(() => {
  process.env[hmacEnvironmentName] = "auth-quota-test-secret-at-least-thirty-two-characters";
});

afterAll(() => {
  if (priorHmacSecret === undefined) delete process.env.HRA_AUTH_HMAC_SECRET;
  else process.env[hmacEnvironmentName] = priorHmacSecret;
});

async function hardRuntime() {
  const runtime = convexTest(schema, authModules);
  await runtime.mutation(quotaGenesis, {});
  return runtime;
}

async function quotaSnapshot(
  runtime: Awaited<ReturnType<typeof hardRuntime>>,
  userId?: Id<"users">,
) {
  return await runtime.run(async (ctx) => {
    const service = await ctx.db.query("storageUsageService").first();
    const identity = userId === undefined
      ? null
      : await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (query) =>
            query.eq("userId", userId).eq("category", "identity"))
          .unique();
    return {
      identity: identity === null
        ? null
        : { logicalBytes: identity.logicalBytes, records: identity.records },
      service: service === null
        ? null
        : {
            identities: service.identities,
            logicalBytes: service.logicalBytes,
            records: service.records,
          },
    };
  });
}

describe("Convex Auth hard quota boundary", () => {
  test("pins the exact handler shape, operation union, and exhaustive auth-table matrix", () => {
    expect(store).toMatchObject({ isInternal: true, isMutation: true });
    expect(typeof (store as unknown as { _handler?: unknown })._handler).toBe("function");
    expect(PINNED_CONVEX_AUTH_STORE_OPERATIONS).toEqual([
      "signIn",
      "signOut",
      "refreshSession",
      "verifyCodeAndSignIn",
      "verifier",
      "verifierSignature",
      "userOAuth",
      "createVerificationCode",
      "createAccountFromCredentials",
      "retrieveAccountWithCredentials",
      "modifyAccount",
      "invalidateSessions",
    ]);
    expect(PINNED_CONVEX_AUTH_QUOTA_TABLE_MATRIX).toEqual({
      users: "stored_identity",
      authSessions: "direct_user",
      authAccounts: "direct_user",
      authRefreshTokens: "session_parent",
      authVerificationCodes: "account_parent",
      authVerifiers: "service_or_session_parent",
      authRateLimits: "service",
    });
  });

  test("blocks refresh-session storage before its handler while admission is frozen", async () => {
    const runtime = await hardRuntime();
    await runtime.mutation(transitionAdmission, {
      expectedGeneration: 0,
      mutationId: "018bcfe5-6800-7000-8000-000000000903",
      state: "frozen",
    });
    let reachedHandler = false;
    await expect(runtime.run(async (ctx) =>
      await runQuotaAwareAuthStoreForTest(ctx, "refreshSession", async () => {
        reachedHandler = true;
      }))).rejects.toThrow("AUTH_ADMISSION_FROZEN");
    expect(reachedHandler).toBe(false);
  });

  test("charges first invite admission and makes exact account replays quota-neutral", async () => {
    const runtime = await hardRuntime();
    const invite = await generateInviteAuthority("identity");
    const capabilityDigest = await digestInviteCapability(invite.capability, "identity");
    await runtime.mutation(recordIssue, {
      capabilityDigest,
      lifetimeMs: minimumInviteLifetimeMs,
      publicId: invite.publicId,
      purpose: "identity",
    });
    const parsedEmail = parseAuthCredentials({ email: "reader@example.com" });
    if (parsedEmail.kind !== "request_code") throw new Error("email fixture is invalid");
    const emailDigest = await digestAuthEmail(parsedEmail.email);
    const reservation = await runtime.mutation(reserveAttempt, {
      emailDigest,
      inviteCapabilityDigest: capabilityDigest,
      kind: "send",
    });
    expect(reservation).toMatchObject({ authEpoch: 1, inviteBinding: "bound" });

    const created = await runtime.mutation(authStore, {
      args: {
        account: { id: "reader@example.com" },
        profile: { email: "reader@example.com" },
        provider: "hra-control-plane-otp-v1",
        shouldLinkViaEmail: true,
        type: "createAccountFromCredentials",
      },
    }) as {
      account: { _id: Id<"authAccounts"> };
      user: { _id: Id<"users"> };
    };
    const boundBeforeChallenge = await runtime.run(async (ctx) =>
      await ctx.db.query("authSubjects")
        .withIndex("by_email_digest", (builder) => builder.eq("emailDigest", emailDigest))
        .unique());
    expect(boundBeforeChallenge).toMatchObject({
      status: "active",
      userId: created.user._id,
    });
    expect(boundBeforeChallenge?.verifiedAt).toBeUndefined();
    const challengeId = await runtime.mutation(storeChallenge, {
      accountId: created.account._id,
      authEpoch: 1,
      codeDigest: "c".repeat(64),
      emailDigest,
      expiresAt: Date.now() + 60_000,
      userId: created.user._id,
    });
    expect(challengeId).toBeString();

    const beforeReplay = await quotaSnapshot(runtime, created.user._id);
    expect(beforeReplay.identity?.records).toBe(5);
    expect(beforeReplay.service).toMatchObject({ identities: 1, records: 8 });
    expect(await runtime.run(async (ctx) => ({
      identity: await ctx.db.query("accountDeletionIdentityReservations")
        .withIndex("by_user", (builder) => builder.eq("userId", created.user._id))
        .unique(),
      job: await ctx.db.query("accountDeletionJobReservations")
        .withIndex("by_user", (builder) => builder.eq("userId", created.user._id))
        .unique(),
    }))).toMatchObject({
      identity: { category: "identity" },
      job: { category: "job" },
    });

    await runtime.run(async (ctx) => {
      const user = await ctx.db.get(created.user._id);
      if (user === null) throw new Error("user fixture missing");
      const patch = { emailVerificationTime: Date.now() };
      await adjustParentAttributedQuotaForPatch(
        ctx,
        created.user._id,
        "identity",
        user,
        patch,
      );
      await ctx.db.patch(user._id, patch);
    });
    expect(await runtime.mutation(reserveAttempt, {
      emailDigest,
      kind: "send",
    })).toMatchObject({ authEpoch: 1, inviteBinding: "not_required" });
    const afterVerifiedReauth = await quotaSnapshot(runtime, created.user._id);
    expect(afterVerifiedReauth.identity?.records).toBe(5);
    expect(afterVerifiedReauth.service?.records).toBe(9);
    expect(await runtime.run(async (ctx) =>
      await ctx.db.query("authSubjects").first())).toMatchObject({
      userId: created.user._id,
      verifiedAt: expect.any(Number),
    });

    const beforeAccountReplay = await quotaSnapshot(runtime, created.user._id);
    const replay = await runtime.mutation(authStore, {
      args: {
        account: { id: "reader@example.com" },
        profile: { email: "reader@example.com" },
        provider: "hra-control-plane-otp-v1",
        shouldLinkViaEmail: true,
        type: "createAccountFromCredentials",
      },
    }) as typeof created;
    expect(replay.account._id).toBe(created.account._id);
    expect(replay.user._id).toBe(created.user._id);
    expect(await quotaSnapshot(runtime, created.user._id)).toEqual(beforeAccountReplay);

    const signedIn = await runtime.mutation(authStore, {
      args: {
        generateTokens: false,
        type: "signIn",
        userId: created.user._id,
      },
    }) as { sessionId: Id<"authSessions">; userId: Id<"users"> };
    expect(signedIn.userId).toBe(created.user._id);
    expect(await quotaSnapshot(runtime, created.user._id)).toMatchObject({
      identity: { records: 6 },
      service: { identities: 1, records: 10 },
    });
    await runtime.mutation(authStore, {
      args: { type: "invalidateSessions", userId: created.user._id },
    });
    expect(await runtime.run(async (ctx) => await ctx.db.get(signedIn.sessionId)))
      .toBeNull();
    expect(await quotaSnapshot(runtime, created.user._id)).toEqual(beforeAccountReplay);
  });

  test("accounts every pinned auth table across insert, patch, and parent-first delete", async () => {
    const runtime = await hardRuntime();
    const ids = await runtime.run(async (ctx) =>
      await runQuotaAwareAuthStoreForTest(ctx, "signIn", async (quotaCtx) => {
        const userId = await quotaCtx.db.insert("users", { email: "matrix@example.com" });
        const accountId = await quotaCtx.db.insert("authAccounts", {
          provider: "hra-control-plane-otp-v1",
          providerAccountId: "matrix@example.com",
          userId,
        });
        const sessionId = await quotaCtx.db.insert("authSessions", {
          expirationTime: Date.now() + 60_000,
          userId,
        });
        const refreshId = await quotaCtx.db.insert("authRefreshTokens", {
          expirationTime: Date.now() + 60_000,
          sessionId,
        });
        const verificationId = await quotaCtx.db.insert("authVerificationCodes", {
          accountId,
          code: "code",
          expirationTime: Date.now() + 60_000,
          provider: "hra-control-plane-otp-v1",
        });
        const verifierId = await quotaCtx.db.insert("authVerifiers", { sessionId });
        const rateId = await quotaCtx.db.insert("authRateLimits", {
          attemptsLeft: 5,
          identifier: "matrix",
          lastAttemptTime: Date.now(),
        });

        await quotaCtx.db.patch(userId, { name: "Matrix" });
        await quotaCtx.db.patch(accountId, { emailVerified: "matrix@example.com" });
        await quotaCtx.db.patch(sessionId, { expirationTime: Date.now() + 120_000 });
        await quotaCtx.db.patch(refreshId, { firstUsedTime: Date.now() });
        await quotaCtx.db.patch(verificationId, { code: "updated" });
        await quotaCtx.db.patch(verifierId, { signature: "signature" });
        await quotaCtx.db.patch(rateId, { attemptsLeft: 4 });

        await quotaCtx.db.delete(sessionId);
        await quotaCtx.db.delete(refreshId);
        await quotaCtx.db.delete(accountId);
        await quotaCtx.db.delete(verificationId);
        await quotaCtx.db.delete(verifierId);
        await quotaCtx.db.delete(rateId);
        await quotaCtx.db.delete(userId);
        return { accountId, refreshId, sessionId, userId, verificationId };
      }));

    const observed = await runtime.run(async (ctx) => ({
      account: await ctx.db.get(ids.accountId),
      refresh: await ctx.db.get(ids.refreshId),
      session: await ctx.db.get(ids.sessionId),
      user: await ctx.db.get(ids.userId),
      verification: await ctx.db.get(ids.verificationId),
    }));
    expect(observed).toEqual({
      account: null,
      refresh: null,
      session: null,
      user: null,
      verification: null,
    });
    expect(await runtime.run(async (ctx) => ({
      identity: await ctx.db.query("accountDeletionIdentityReservations").collect(),
      job: await ctx.db.query("accountDeletionJobReservations").collect(),
    }))).toEqual({ identity: [], job: [] });
    expect(await quotaSnapshot(runtime, ids.userId)).toMatchObject({
      identity: { logicalBytes: 0, records: 0 },
      service: { identities: 0, logicalBytes: 0, records: 0 },
    });
  });

  test("fails before writes for missing or corrupt service authority and unknown surfaces", async () => {
    const missing = convexTest(schema, authModules);
    await expect(missing.mutation(authStore, {
      args: {
        account: { id: "missing@example.com" },
        profile: { email: "missing@example.com" },
        provider: "hra-control-plane-otp-v1",
        shouldLinkViaEmail: true,
        type: "createAccountFromCredentials",
      },
    })).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    expect(await missing.run(async (ctx) =>
      (await ctx.db.query("users").collect()).length)).toBe(0);

    const corrupt = await hardRuntime();
    await corrupt.run(async (ctx) => {
      const service = await ctx.db.query("storageUsageService").unique();
      if (service === null) throw new Error("service fixture missing");
      await ctx.db.patch(service._id, { records: -1 });
    });
    await expect(corrupt.mutation(recordIssue, {
      capabilityDigest: "d".repeat(64),
      lifetimeMs: minimumInviteLifetimeMs,
      publicId: invitePublicIdFromCapabilityDigest("d".repeat(64)),
      purpose: "identity",
    })).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    expect(await corrupt.run(async (ctx) =>
      (await ctx.db.query("authInvites").collect()).length)).toBe(0);

    const unknown = await hardRuntime();
    await expect(unknown.run(async (ctx) =>
      await runQuotaAwareAuthStoreForTest(
        ctx,
        "signIn",
        async (quotaCtx) => await quotaCtx.db.insert(
          "authOtpChallenges" as never,
          {} as never,
        ),
      ))).rejects.toThrow("Authentication storage could not be completed.");
    await expect(unknown.run(async (ctx) =>
      await runQuotaAwareAuthStoreForTest(
        ctx,
        "futureOperation" as never,
        async () => undefined,
      ))).rejects.toThrow("Authentication storage could not be completed.");

    const mismatchedIdentity = await hardRuntime();
    const canonicalEmail = "binding-proof@example.com";
    const parsedEmail = parseAuthCredentials({ email: canonicalEmail });
    if (parsedEmail.kind !== "request_code") throw new Error("email fixture is invalid");
    const emailDigest = await digestAuthEmail(parsedEmail.email);
    await mismatchedIdentity.run(async (ctx) => {
      const subject = {
        authEpoch: 1,
        createdAt: Date.now(),
        emailDigest,
        status: "active" as const,
        updatedAt: Date.now(),
      };
      await reserveServiceQuotaForInsert(ctx, subject);
      await ctx.db.insert("authSubjects", subject);
    });
    await expect(mismatchedIdentity.run(async (ctx) =>
      await runQuotaAwareAuthStoreForTest(
        ctx,
        "createAccountFromCredentials",
        async (quotaCtx) => await quotaCtx.db.insert("users", {
          email: "different@example.com",
        }),
        { email: canonicalEmail, emailDigest },
      ))).rejects.toThrow("Authentication storage could not be completed.");
    const mismatchedState = await mismatchedIdentity.run(async (ctx) => ({
      identityCapacity: await ctx.db.query("accountDeletionIdentityReservations").collect(),
      jobCapacity: await ctx.db.query("accountDeletionJobReservations").collect(),
      subject: await ctx.db.query("authSubjects").unique(),
      users: await ctx.db.query("users").collect(),
    }));
    expect(mismatchedState).toMatchObject({
      identityCapacity: [],
      jobCapacity: [],
      subject: { emailDigest },
      users: [],
    });
    expect(mismatchedState.subject).not.toHaveProperty("userId");
  });
});
