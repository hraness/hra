import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";
import { convexTest } from "convex-test";

import { isIdentityInviteCapability } from "../src/cloud/authCredentials";
import {
  digestInviteCapability,
  generateInviteAuthority,
  maximumInviteLifetimeMs,
  minimumInviteLifetimeMs,
} from "./authInvites";
import {
  initializeUserQuotaAuthority,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  transferServiceQuotaToUserForPatch,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type Reservation = Readonly<{
  authEpoch: number;
  inviteBinding: "bound" | "not_required" | "replay";
}>;
type IssueResult = Readonly<{
  capability: string;
  expiresAt: number;
  publicId: string;
  purpose: "device" | "identity";
  replay: boolean;
  state: "issued";
}>;

const issue = makeFunctionReference<"action", Args, IssueResult>("authInvites:issue");
const recordIssue = makeFunctionReference<"mutation", Args, Omit<IssueResult, "capability">>(
  "authInvites:recordIssue",
);
const inviteStatus = makeFunctionReference<"query", Args, unknown>("authInvites:status");
const revoke = makeFunctionReference<"mutation", Args, unknown>("authInvites:revoke");
const reserve = makeFunctionReference<"mutation", Args, Reservation>(
  "authDelivery:reserveEmailAttempt",
);
const consume = makeFunctionReference<"mutation", Args, Id<"users">>(
  "authDelivery:consumeOtpChallenge",
);
const storeChallenge = makeFunctionReference<"mutation", Args, Id<"authOtpChallenges">>(
  "authDelivery:storeOtpChallenge",
);
const quotaGenesis = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const emailA = "a".repeat(64);
const emailB = "b".repeat(64);

async function preparedIdentityInvite() {
  const authority = generateInviteAuthority("identity");
  return {
    ...authority,
    capabilityDigest: await digestInviteCapability(authority.capability, "identity"),
  };
}

async function recordPrepared(
  testRuntime: ReturnType<typeof convexTest>,
  prepared: Awaited<ReturnType<typeof preparedIdentityInvite>>,
) {
  return await testRuntime.mutation(recordIssue, {
    capabilityDigest: prepared.capabilityDigest,
    lifetimeMs: minimumInviteLifetimeMs,
    publicId: prepared.publicId,
    purpose: "identity",
  });
}

async function counts(testRuntime: ReturnType<typeof convexTest>) {
  return await testRuntime.run(async (ctx) => ({
    accounts: (await ctx.db.query("authAccounts").collect()).length,
    attempts: (await ctx.db.query("authEmailAttemptEvents").collect()).length,
    subjects: (await ctx.db.query("authSubjects").collect()).length,
    users: (await ctx.db.query("users").collect()).length,
  }));
}

async function hardRuntime() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(quotaGenesis, {});
  return testRuntime;
}

describe("identity invitation admission", () => {
  test("issues 256-bit capabilities, stores only their digest, and exposes bounded status", async () => {
    const testRuntime = await hardRuntime();
    const issued = await testRuntime.action(issue, {
      lifetimeMs: minimumInviteLifetimeMs,
      purpose: "identity",
    });
    expect(isIdentityInviteCapability(issued.capability)).toBe(true);
    expect(issued).toMatchObject({ purpose: "identity", replay: false, state: "issued" });
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + maximumInviteLifetimeMs);

    const stored = await testRuntime.run(async (ctx) =>
      await ctx.db.query("authInvites").first());
    expect(stored?.capabilityDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(issued.capability);
    expect(await testRuntime.query(inviteStatus, { publicId: issued.publicId }))
      .toMatchObject({
        bound: false,
        expired: false,
        expiresAt: issued.expiresAt,
        publicId: issued.publicId,
        purpose: "identity",
        state: "issued",
      });

    expect(await testRuntime.mutation(revoke, { publicId: issued.publicId }))
      .toMatchObject({ replay: false, state: "revoked" });
    expect(await testRuntime.mutation(revoke, { publicId: issued.publicId }))
      .toMatchObject({ replay: true, state: "revoked" });
  });

  test("replays only an exact prepared issue and rejects public-id or digest rotation", async () => {
    const testRuntime = await hardRuntime();
    const prepared = await preparedIdentityInvite();
    const first = await recordPrepared(testRuntime, prepared);
    expect(first.replay).toBe(false);
    expect(await recordPrepared(testRuntime, prepared))
      .toEqual({ ...first, replay: true });
    await expect(testRuntime.mutation(recordIssue, {
      capabilityDigest: prepared.capabilityDigest,
      lifetimeMs: minimumInviteLifetimeMs + 1,
      publicId: prepared.publicId,
      purpose: "identity",
    })).rejects.toThrow("Invite operation could not be completed.");

    const rotatedCapability = await preparedIdentityInvite();
    await expect(testRuntime.mutation(recordIssue, {
      capabilityDigest: rotatedCapability.capabilityDigest,
      lifetimeMs: minimumInviteLifetimeMs,
      publicId: prepared.publicId,
      purpose: "identity",
    })).rejects.toThrow("Invite operation could not be completed.");
    await expect(testRuntime.mutation(recordIssue, {
      capabilityDigest: prepared.capabilityDigest,
      lifetimeMs: minimumInviteLifetimeMs,
      publicId: rotatedCapability.publicId,
      purpose: "identity",
    })).rejects.toThrow("Invite operation could not be completed.");
    expect(await testRuntime.run(async (ctx) =>
      (await ctx.db.query("authInvites").collect()).length)).toBe(1);
  });

  test("invite omission, unknown capabilities, wrong purpose, and expiry leave no footprint", async () => {
    const testRuntime = await hardRuntime();
    await expect(testRuntime.mutation(reserve, {
      emailDigest: emailA,
      kind: "send",
    })).rejects.toThrow("Authentication could not be completed.");
    await expect(testRuntime.mutation(reserve, {
      emailDigest: emailA,
      inviteCapabilityDigest: "9".repeat(64),
      kind: "send",
    })).rejects.toThrow("Authentication could not be completed.");
    expect(await testRuntime.run(async (ctx) => {
      const service = await ctx.db.query("storageUsageService").unique();
      return {
        attempts: (await ctx.db.query("authEmailAttemptEvents").collect()).length,
        logicalBytes: service?.logicalBytes,
        records: service?.records,
        subjects: (await ctx.db.query("authSubjects").collect()).length,
      };
    })).toEqual({ attempts: 0, logicalBytes: 0, records: 0, subjects: 0 });

    const wrongPurpose = await preparedIdentityInvite();
    const expired = await preparedIdentityInvite();
    const now = Date.now();
    await testRuntime.run(async (ctx) => {
      await ctx.db.insert("authInvites", {
        admissionExpiresAt: now + minimumInviteLifetimeMs,
        capabilityDigest: wrongPurpose.capabilityDigest,
        createdAt: now,
        expiresAt: now + minimumInviteLifetimeMs,
        publicId: wrongPurpose.publicId,
        purpose: "device",
        state: "issued",
        updatedAt: now,
      });
      await ctx.db.insert("authInvites", {
        admissionExpiresAt: now - 1,
        capabilityDigest: expired.capabilityDigest,
        createdAt: now - minimumInviteLifetimeMs,
        expiresAt: now + 60_000,
        publicId: expired.publicId,
        purpose: "identity",
        state: "issued",
        updatedAt: now,
      });
    });
    for (const capabilityDigest of [
      wrongPurpose.capabilityDigest,
      expired.capabilityDigest,
    ]) {
      await expect(testRuntime.mutation(reserve, {
        emailDigest: emailA,
        inviteCapabilityDigest: capabilityDigest,
        kind: "send",
      })).rejects.toThrow("Authentication could not be completed.");
    }
    expect(await counts(testRuntime)).toEqual({
      accounts: 0,
      attempts: 0,
      subjects: 0,
      users: 0,
    });
  });

  test("binds once, permits exact same-email replay, and rejects email or capability rotation", async () => {
    const testRuntime = await hardRuntime();
    const firstInvite = await preparedIdentityInvite();
    const rotatedInvite = await preparedIdentityInvite();
    await recordPrepared(testRuntime, firstInvite);
    await recordPrepared(testRuntime, rotatedInvite);

    expect(await testRuntime.mutation(reserve, {
      emailDigest: emailA,
      inviteCapabilityDigest: firstInvite.capabilityDigest,
      kind: "send",
    })).toEqual({ authEpoch: 1, inviteBinding: "bound" });
    expect(await testRuntime.mutation(reserve, {
      emailDigest: emailA,
      inviteCapabilityDigest: firstInvite.capabilityDigest,
      kind: "send",
    })).toEqual({ authEpoch: 1, inviteBinding: "replay" });

    await expect(testRuntime.mutation(reserve, {
      emailDigest: emailA,
      inviteCapabilityDigest: rotatedInvite.capabilityDigest,
      kind: "send",
    })).rejects.toThrow("Authentication could not be completed.");
    await expect(testRuntime.mutation(reserve, {
      emailDigest: emailB,
      inviteCapabilityDigest: firstInvite.capabilityDigest,
      kind: "send",
    })).rejects.toThrow("Authentication could not be completed.");

    const observed = await testRuntime.run(async (ctx) => ({
      attempts: await ctx.db.query("authEmailAttemptEvents").collect(),
      invites: await ctx.db.query("authInvites").collect(),
      subjects: await ctx.db.query("authSubjects").collect(),
    }));
    expect(observed.attempts).toHaveLength(2);
    expect(observed.subjects).toHaveLength(1);
    expect(observed.subjects[0]?.admissionInviteId).toBe(observed.invites[0]?._id);
    expect(observed.invites.find((invite) =>
      invite.capabilityDigest === firstInvite.capabilityDigest))
      .toMatchObject({ boundEmailDigest: emailA, state: "bound_to_email" });
    const unbound = observed.invites.find((invite) =>
      invite.capabilityDigest === rotatedInvite.capabilityDigest);
    expect(unbound).toMatchObject({ state: "issued" });
    expect(unbound?.boundEmailDigest).toBeUndefined();
  });

  test("consumes the bound capability only on verification and admits verified reauthentication", async () => {
    const testRuntime = await hardRuntime();
    const prepared = await preparedIdentityInvite();
    await recordPrepared(testRuntime, prepared);
    await testRuntime.mutation(reserve, {
      emailDigest: emailA,
      inviteCapabilityDigest: prepared.capabilityDigest,
      kind: "send",
    });
    const now = Date.now();
    const fixture = await testRuntime.run(async (ctx) => {
      const subject = await ctx.db.query("authSubjects")
        .withIndex("by_email_digest", (query) => query.eq("emailDigest", emailA))
        .first();
      if (subject === null) throw new Error("subject fixture missing");
      const userId = await ctx.db.insert("users", { email: "reader@example.com" });
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("user fixture missing");
      await initializeUserQuotaAuthority(ctx, userId);
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      const accountId = await ctx.db.insert("authAccounts", {
        provider: "hra-control-plane-otp-v1",
        providerAccountId: "reader@example.com",
        userId,
      });
      const account = await ctx.db.get(accountId);
      if (account === null) throw new Error("account fixture missing");
      await reserveQuotaForInsert(ctx, userId, "identity", account);
      const subjectPatch = { updatedAt: now, userId };
      await transferServiceQuotaToUserForPatch(
        ctx,
        userId,
        "identity",
        subject,
        subjectPatch,
      );
      await ctx.db.patch(subject._id, subjectPatch);
      const challengeId = await ctx.db.insert("authOtpChallenges", {
        accountId,
        authEpoch: 1,
        codeDigest: "c".repeat(64),
        createdAt: now,
        deliveryState: "accepted",
        emailDigest: emailA,
        expiresAt: now + 60_000,
        updatedAt: now,
        userId,
      });
      const challenge = await ctx.db.get(challengeId);
      if (challenge === null) throw new Error("challenge fixture missing");
      await reserveQuotaForInsert(ctx, userId, "identity", challenge);
      return { challengeId, userId };
    });
    expect(await testRuntime.mutation(consume, {
      authEpoch: 1,
      codeDigest: "c".repeat(64),
      emailDigest: emailA,
    })).toBe(fixture.userId);

    const after = await testRuntime.run(async (ctx) => ({
      challenge: await ctx.db.get(fixture.challengeId),
      invite: await ctx.db.query("authInvites").first(),
      subject: await ctx.db.query("authSubjects").first(),
    }));
    expect(after.challenge).toBeNull();
    expect(after.invite).toMatchObject({ state: "consumed" });
    expect(after.invite?.consumedAt).toBeNumber();
    expect(after.subject?.verifiedAt).toBeNumber();

    await expect(testRuntime.mutation(reserve, {
      emailDigest: emailB,
      inviteCapabilityDigest: prepared.capabilityDigest,
      kind: "send",
    })).rejects.toThrow("Authentication could not be completed.");
    expect(await testRuntime.mutation(reserve, {
      emailDigest: emailA,
      kind: "send",
    })).toEqual({ authEpoch: 1, inviteBinding: "not_required" });
    expect(await counts(testRuntime)).toMatchObject({ attempts: 2, subjects: 1, users: 1 });
  });

  test("revocation between admission and challenge storage prevents mail authority", async () => {
    const testRuntime = await hardRuntime();
    const prepared = await preparedIdentityInvite();
    await recordPrepared(testRuntime, prepared);
    await testRuntime.mutation(reserve, {
      emailDigest: emailA,
      inviteCapabilityDigest: prepared.capabilityDigest,
      kind: "send",
    });
    await testRuntime.mutation(revoke, { publicId: prepared.publicId });
    const now = Date.now();
    const fixture = await testRuntime.run(async (ctx) => {
      const subject = await ctx.db.query("authSubjects").first();
      if (subject === null) throw new Error("subject fixture missing");
      const userId = await ctx.db.insert("users", { email: "reader@example.com" });
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("user fixture missing");
      await initializeUserQuotaAuthority(ctx, userId);
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      const accountId = await ctx.db.insert("authAccounts", {
        provider: "hra-control-plane-otp-v1",
        providerAccountId: "reader@example.com",
        userId,
      });
      const account = await ctx.db.get(accountId);
      if (account === null) throw new Error("account fixture missing");
      await reserveQuotaForInsert(ctx, userId, "identity", account);
      const subjectPatch = { userId, updatedAt: now };
      await transferServiceQuotaToUserForPatch(
        ctx,
        userId,
        "identity",
        subject,
        subjectPatch,
      );
      await ctx.db.patch(subject._id, subjectPatch);
      return { accountId, userId };
    });
    await expect(testRuntime.mutation(storeChallenge, {
      accountId: fixture.accountId,
      authEpoch: 1,
      codeDigest: "d".repeat(64),
      emailDigest: emailA,
      expiresAt: now + 60_000,
      userId: fixture.userId,
    })).rejects.toThrow("Authentication could not be completed.");
    expect(await testRuntime.run(async (ctx) =>
      (await ctx.db.query("authOtpChallenges").collect()).length)).toBe(0);
  });
});
