import { v } from "convex/values";

import type { GenericId as Id } from "convex/values";
import {
  authAttemptPolicies,
  authOtpLifetimeMs,
  isAuthDigest,
  maximumLiveOtpChallenges,
  type AuthAttemptKind,
} from "./authPolicy";
import {
  bindIdentityInviteToEmail,
  consumeBoundIdentityInvite,
  requireBoundIdentityInvite,
} from "./authInvites";
import {
  adjustParentAttributedQuotaForPatch,
  adjustQuotaForPatch,
  adjustServiceQuotaForPatch,
  releaseQuotaForDelete,
  reserveQuotaForInsert,
  reserveServiceQuotaForInsert,
  transferServiceQuotaToUserForPatch,
} from "./quota";
import { internalMutation, type MutationCtx } from "./server";

const authenticationRejectedMessage = "Authentication could not be completed.";
const hraOtpProviderId = "hra-control-plane-otp-v1";

function rejectAuthentication(): never {
  throw new Error(authenticationRejectedMessage);
}

function requireDigest(value: string): void {
  if (!isAuthDigest(value)) rejectAuthentication();
}

async function subjectByEmail(ctx: MutationCtx, emailDigest: string) {
  const matches = await ctx.db
    .query("authSubjects")
    .withIndex("by_email_digest", (query) => query.eq("emailDigest", emailDigest))
    .take(2);
  if (matches.length > 1) rejectAuthentication();
  return matches[0] ?? null;
}

async function countEmailAttempts(
  ctx: MutationCtx,
  input: Readonly<{
    cutoff: number;
    emailDigest: string;
    kind: AuthAttemptKind;
    limit: number;
  }>,
): Promise<number> {
  return await ctx.db
    .query("authEmailAttemptEvents")
    .withIndex("by_email_kind_and_created_at", (query) =>
      query
        .eq("emailDigest", input.emailDigest)
        .eq("kind", input.kind)
        .gte("createdAt", input.cutoff))
    .take(input.limit)
    .then((matches) => matches.length);
}

async function countGlobalAttempts(
  ctx: MutationCtx,
  input: Readonly<{
    cutoff: number;
    kind: AuthAttemptKind;
    limit: number;
  }>,
): Promise<number> {
  return await ctx.db
    .query("authEmailAttemptEvents")
    .withIndex("by_kind_and_created_at", (query) =>
      query.eq("kind", input.kind).gte("createdAt", input.cutoff))
    .take(input.limit)
    .then((matches) => matches.length);
}

async function subjectIsVerified(
  ctx: MutationCtx,
  subject: NonNullable<Awaited<ReturnType<typeof subjectByEmail>>>,
): Promise<boolean> {
  if (subject.userId === undefined) {
    if (subject.verifiedAt !== undefined) rejectAuthentication();
    return false;
  }
  const user = await ctx.db.get(subject.userId);
  if (user === null) rejectAuthentication();
  if (user.emailVerificationTime === undefined) {
    if (subject.verifiedAt !== undefined) rejectAuthentication();
    return false;
  }
  if (
    subject.verifiedAt !== undefined
    && subject.verifiedAt !== user.emailVerificationTime
  ) rejectAuthentication();
  if (subject.verifiedAt !== undefined) return true;
  const patch = {
    updatedAt: Date.now(),
    verifiedAt: user.emailVerificationTime,
  };
  await adjustQuotaForPatch(ctx, subject.userId, "identity", subject, patch);
  await ctx.db.patch(subject._id, patch);
  return true;
}

export const reserveEmailAttempt = internalMutation({
  args: {
    emailDigest: v.string(),
    inviteCapabilityDigest: v.optional(v.string()),
    kind: v.union(v.literal("send"), v.literal("verify")),
  },
  handler: async (ctx, args) => {
    requireDigest(args.emailDigest);
    if (args.inviteCapabilityDigest !== undefined) {
      requireDigest(args.inviteCapabilityDigest);
    }
    const now = Date.now();
    let subject = await subjectByEmail(ctx, args.emailDigest);
    let inviteBinding: "bound" | "not_required" | "replay" = "not_required";
    if (args.kind === "verify") {
      if (subject?.status !== "active" || args.inviteCapabilityDigest !== undefined) {
        rejectAuthentication();
      }
    } else if (subject?.status === "active" && await subjectIsVerified(ctx, subject)) {
      if (args.inviteCapabilityDigest !== undefined) rejectAuthentication();
    } else {
      if (subject !== null && subject.status !== "active") rejectAuthentication();
      if (args.inviteCapabilityDigest === undefined) rejectAuthentication();
      const binding = await bindIdentityInviteToEmail(ctx, {
        capabilityDigest: args.inviteCapabilityDigest,
        emailDigest: args.emailDigest,
        ...(subject?.admissionInviteId === undefined
          ? {}
          : { expectedInviteId: subject.admissionInviteId }),
      });
      inviteBinding = binding.replay ? "replay" : "bound";
      if (subject === null) {
        const subjectId = await ctx.db.insert("authSubjects", {
          admissionInviteId: binding.inviteId,
          authEpoch: 1,
          createdAt: now,
          emailDigest: args.emailDigest,
          status: "active",
          updatedAt: now,
        });
        subject = await ctx.db.get(subjectId);
        if (subject === null) rejectAuthentication();
        await reserveServiceQuotaForInsert(ctx, subject);
      } else if (subject.admissionInviteId === undefined) {
        const patch = {
          admissionInviteId: binding.inviteId,
          updatedAt: now,
        };
        if (subject.userId === undefined) {
          await adjustServiceQuotaForPatch(ctx, subject, patch);
        } else {
          await adjustQuotaForPatch(ctx, subject.userId, "identity", subject, patch);
        }
        await ctx.db.patch(subject._id, patch);
        subject = await ctx.db.get(subject._id);
      }
    }
    if (subject?.status !== "active") rejectAuthentication();

    const policy = authAttemptPolicies[args.kind];
    for (const window of policy.perEmail) {
      if (await countEmailAttempts(ctx, {
        cutoff: now - window.windowMs,
        emailDigest: args.emailDigest,
        kind: args.kind,
        limit: window.limit,
      }) >= window.limit) rejectAuthentication();
    }
    for (const window of policy.global) {
      if (await countGlobalAttempts(ctx, {
        cutoff: now - window.windowMs,
        kind: args.kind,
        limit: window.limit,
      }) >= window.limit) rejectAuthentication();
    }
    const attemptId = await ctx.db.insert("authEmailAttemptEvents", {
      authEpoch: subject.authEpoch,
      createdAt: now,
      emailDigest: args.emailDigest,
      expiresAt: now + policy.retentionMs,
      kind: args.kind,
    });
    const attempt = await ctx.db.get(attemptId);
    if (attempt === null) rejectAuthentication();
    await reserveServiceQuotaForInsert(ctx, attempt);
    return { authEpoch: subject.authEpoch, inviteBinding };
  },
});

export const storeOtpChallenge = internalMutation({
  args: {
    accountId: v.id("authAccounts"),
    authEpoch: v.number(),
    codeDigest: v.string(),
    emailDigest: v.string(),
    expiresAt: v.number(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    requireDigest(args.emailDigest);
    requireDigest(args.codeDigest);
    const now = Date.now();
    const subject = await subjectByEmail(ctx, args.emailDigest);
    const [account, user] = await Promise.all([
      ctx.db.get(args.accountId),
      ctx.db.get(args.userId),
    ]);
    if (
      subject?.status !== "active"
      || subject.authEpoch !== args.authEpoch
      || (subject.userId !== undefined && subject.userId !== args.userId)
      || account?.provider !== hraOtpProviderId
      || account.userId !== args.userId
      || user?._id === undefined
      || !Number.isFinite(args.expiresAt)
      || args.expiresAt <= now
      || args.expiresAt > now + authOtpLifetimeMs
    ) rejectAuthentication();
    if (subject.verifiedAt === undefined) {
      if (subject.admissionInviteId === undefined) rejectAuthentication();
      await requireBoundIdentityInvite(ctx, {
        emailDigest: args.emailDigest,
        inviteId: subject.admissionInviteId,
      });
    }
    if (subject.userId === undefined) {
      const patch = { userId: args.userId, updatedAt: now };
      await transferServiceQuotaToUserForPatch(
        ctx,
        args.userId,
        "identity",
        subject,
        patch,
      );
      await ctx.db.patch(subject._id, patch);
    }

    const challenges = await ctx.db
      .query("authOtpChallenges")
      .withIndex("by_email", (query) => query.eq("emailDigest", args.emailDigest))
      .take(maximumLiveOtpChallenges + 1);
    if (challenges.length > maximumLiveOtpChallenges) rejectAuthentication();
    const live = [];
    for (const challenge of challenges) {
      if (challenge.expiresAt <= now || challenge.authEpoch !== args.authEpoch) {
        await releaseQuotaForDelete(ctx, challenge.userId, "identity", challenge);
        await ctx.db.delete(challenge._id);
      } else {
        live.push(challenge);
      }
    }
    if (live.some((challenge) =>
      challenge.accountId !== args.accountId || challenge.userId !== args.userId)) {
      rejectAuthentication();
    }
    const duplicate = live.find((challenge) => challenge.codeDigest === args.codeDigest);
    if (duplicate !== undefined) {
      await adjustQuotaForPatch(ctx, duplicate.userId, "identity", duplicate, {});
      return duplicate._id;
    }
    if (live.length >= maximumLiveOtpChallenges) rejectAuthentication();
    const challengeId = await ctx.db.insert("authOtpChallenges", {
      accountId: args.accountId,
      authEpoch: args.authEpoch,
      codeDigest: args.codeDigest,
      createdAt: now,
      deliveryState: "reserved",
      emailDigest: args.emailDigest,
      expiresAt: args.expiresAt,
      updatedAt: now,
      userId: args.userId,
    });
    const challenge = await ctx.db.get(challengeId);
    if (challenge === null) rejectAuthentication();
    await reserveQuotaForInsert(ctx, args.userId, "identity", challenge);
    return challengeId;
  },
});

export const recordOtpDelivery = internalMutation({
  args: {
    challengeId: v.id("authOtpChallenges"),
    state: v.union(v.literal("accepted"), v.literal("ambiguous")),
  },
  handler: async (ctx, args) => {
    const challenge = await ctx.db.get(args.challengeId);
    if (challenge === null) return null;
    if (challenge.deliveryState === args.state) {
      await adjustQuotaForPatch(ctx, challenge.userId, "identity", challenge, {});
      return challenge._id;
    }
    if (challenge.deliveryState !== "reserved") rejectAuthentication();
    const patch = {
      deliveryState: args.state,
      updatedAt: Date.now(),
    };
    await adjustQuotaForPatch(ctx, challenge.userId, "identity", challenge, patch);
    await ctx.db.patch(challenge._id, patch);
    return challenge._id;
  },
});

export const consumeOtpChallenge = internalMutation({
  args: {
    authEpoch: v.number(),
    codeDigest: v.string(),
    emailDigest: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"users">> => {
    requireDigest(args.emailDigest);
    requireDigest(args.codeDigest);
    const now = Date.now();
    const subject = await subjectByEmail(ctx, args.emailDigest);
    if (
      subject?.status !== "active"
      || subject.authEpoch !== args.authEpoch
      || subject.userId === undefined
    ) rejectAuthentication();
    const challenges = await ctx.db
      .query("authOtpChallenges")
      .withIndex("by_email", (query) => query.eq("emailDigest", args.emailDigest))
      .take(maximumLiveOtpChallenges + 1);
    if (challenges.length > maximumLiveOtpChallenges) rejectAuthentication();
    const matches = challenges.filter((challenge) =>
      challenge.codeDigest === args.codeDigest
      && challenge.authEpoch === args.authEpoch
      && challenge.expiresAt > now);
    const challenge = matches[0];
    if (matches.length !== 1 || challenge === undefined) rejectAuthentication();
    const [account, user] = await Promise.all([
      ctx.db.get(challenge.accountId),
      ctx.db.get(challenge.userId),
    ]);
    if (account?.provider !== hraOtpProviderId || user === null) rejectAuthentication();
    if (
      subject.userId !== user._id
      || account.userId !== user._id
      || challenges.some((stored) =>
        stored.accountId !== account._id || stored.userId !== user._id)
    ) rejectAuthentication();
    if (subject.verifiedAt === undefined) {
      if (subject.admissionInviteId === undefined) rejectAuthentication();
      await consumeBoundIdentityInvite(ctx, {
        emailDigest: args.emailDigest,
        inviteId: subject.admissionInviteId,
      });
    }
    const accountPatch = { emailVerified: account.providerAccountId };
    await adjustQuotaForPatch(ctx, user._id, "identity", account, accountPatch);
    await ctx.db.patch(account._id, accountPatch);
    const userPatch = { emailVerificationTime: now };
    await adjustParentAttributedQuotaForPatch(
      ctx,
      user._id,
      "identity",
      user,
      userPatch,
    );
    await ctx.db.patch(user._id, userPatch);
    const subjectPatch = { updatedAt: now, verifiedAt: now };
    await adjustQuotaForPatch(ctx, user._id, "identity", subject, subjectPatch);
    await ctx.db.patch(subject._id, subjectPatch);
    for (const stored of challenges) {
      await releaseQuotaForDelete(ctx, user._id, "identity", stored);
      await ctx.db.delete(stored._id);
    }
    return user._id;
  },
});

export async function requireActiveAuthSubject(
  ctx: MutationCtx,
  userId: Id<"users">,
) {
  const matches = await ctx.db
    .query("authSubjects")
    .withIndex("by_user", (query) => query.eq("userId", userId))
    .take(2);
  if (
    matches.length !== 1
    || matches[0]?.status !== "active"
    || matches[0].userId !== userId
  ) rejectAuthentication();
  const user = await ctx.db.get(userId);
  if (user === null) rejectAuthentication();
  await adjustParentAttributedQuotaForPatch(ctx, userId, "identity", user, {});
  await adjustQuotaForPatch(ctx, userId, "identity", matches[0], {});
  return matches[0];
}
