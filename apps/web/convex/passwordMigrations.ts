import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  normalizePasswordEmail,
  PASSWORD_SIGN_UP_RESERVATION_LIFETIME_MS,
} from "./authPolicy";
import { sha256Base64Url } from "./crypto";
import { randomCrockford } from "./domain";
import { unauthenticatedSlotKey } from "./rateLimitPolicy";
import { consumePasswordRateLimit } from "./rateLimits";

const MAXIMUM_CLAIM_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CANONICAL_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export async function browserMigrationClaimProof(claim: string): Promise<string> {
  return await sha256Base64Url(`hra-password-migration-v1:${claim}`);
}

export async function storedMigrationClaimProofDigest(proof: string): Promise<string> {
  return await sha256Base64Url(`hra-password-migration-proof-v2:${proof}`);
}

export const userByPublicId = internalQuery({
  args: { userPublicId: v.string() },
  returns: v.union(v.object({ userId: v.id("users") }), v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_public_id", (index) => index.eq("publicId", args.userPublicId))
      .unique();
    return user === null ? null : { userId: user._id };
  },
});

export const storeClaim = internalMutation({
  args: {
    userId: v.id("users"),
    claimProofDigest: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (
      args.expiresAt <= now ||
      args.expiresAt > now + MAXIMUM_CLAIM_LIFETIME_MS ||
      !CANONICAL_PROOF_PATTERN.test(args.claimProofDigest)
    ) throw new Error("Invalid password migration claim.");
    await ctx.db.insert("passwordMigrationClaims", {
      claimProofDigest: args.claimProofDigest,
      userId: args.userId,
      createdAt: now,
      expiresAt: args.expiresAt,
    });
    return null;
  },
});

const passwordAuthorizationResultValidator = v.union(
  v.object({ kind: v.literal("allowed") }),
  v.object({ kind: v.literal("limited"), retryAfterMs: v.number() }),
  v.object({ kind: v.literal("rejected") }),
  v.object({ kind: v.literal("unavailable") }),
);

export const beginPasswordAuthorization = internalMutation({
  args: {
    email: v.string(),
    flow: v.union(v.literal("signIn"), v.literal("signUp")),
    migrationClaimProof: v.optional(v.string()),
    requestId: v.string(),
  },
  returns: passwordAuthorizationResultValidator,
  handler: async (ctx, args) => {
    const email = normalizePasswordEmail(args.email);
    const emailDigest = await sha256Base64Url(`hra-password-email-v1:${email}`);
    const slotKey = unauthenticatedSlotKey(emailDigest);
    if (slotKey === null) return { kind: "unavailable" as const };
    const [accountByEmail, existingByEmail, outstanding] = await Promise.all([
      ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (index) =>
          index.eq("provider", "password").eq("providerAccountId", email))
        .unique(),
      ctx.db.query("users").withIndex("email", (index) => index.eq("email", email)).unique(),
      ctx.db
        .query("passwordSignUpReservations")
        .withIndex("by_email_digest", (index) => index.eq("emailDigest", emailDigest))
        .unique(),
    ]);
    if (args.flow === "signIn") {
      // Resolve a known account before admission. Arbitrary colliding emails
      // remain in unknown/global buckets and cannot exhaust this exact
      // account's password-verification budget.
      const admission = await consumePasswordRateLimit(ctx, {
        routeClass: "password_sign_in",
        ...(accountByEmail === null
          ? { unknownSlotKey: slotKey }
          : { accountId: accountByEmail._id }),
        requestId: args.requestId,
      });
      return admission.kind === "allowed" || admission.kind === "limited"
        ? admission
        : { kind: "unavailable" as const };
    }

    // Reject an existing password account before the pinned provider can
    // verify a supplied secret through its sign-up implementation.
    if (accountByEmail !== null) return { kind: "rejected" as const };
    const now = Date.now();
    if (outstanding !== null) {
      if (outstanding.expiresAt > now) return { kind: "rejected" as const };
      await ctx.db.delete(outstanding._id);
    }

    let targetUserId;
    let migrationClaimId;
    if (args.migrationClaimProof !== undefined) {
      if (!CANONICAL_PROOF_PATTERN.test(args.migrationClaimProof)) {
        return { kind: "rejected" as const };
      }
      const claimProofDigest = await storedMigrationClaimProofDigest(
        args.migrationClaimProof,
      );
      const claim = await ctx.db
        .query("passwordMigrationClaims")
        .withIndex("by_claim_proof_digest", (index) =>
          index.eq("claimProofDigest", claimProofDigest))
        .unique();
      if (
        claim === null || claim.consumedAt !== undefined || claim.expiresAt <= now
      ) return { kind: "rejected" as const };
      const target = await ctx.db.get(claim.userId);
      if (
        target === null || target.status !== "active" ||
        (existingByEmail !== null && existingByEmail._id !== target._id)
      ) return { kind: "rejected" as const };
      const existingPasswordAccount = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (index) =>
          index.eq("userId", target._id).eq("provider", "password"))
        .first();
      if (existingPasswordAccount !== null) return { kind: "rejected" as const };
      targetUserId = target._id;
      migrationClaimId = claim._id;
    } else if (existingByEmail !== null) {
      return { kind: "rejected" as const };
    }

    // Both dimensions are debited in one transaction before password hashing:
    // a fixed global account-creation ceiling and a coarse unknown-email slot.
    const admission = await consumePasswordRateLimit(ctx, {
      routeClass: "password_sign_up",
      unknownSlotKey: slotKey,
      requestId: args.requestId,
    });
    if (admission.kind !== "allowed") return admission.kind === "limited"
      ? admission
      : { kind: "unavailable" as const };

    await ctx.db.insert("passwordSignUpReservations", {
      emailDigest,
      ...(targetUserId === undefined ? {} : { targetUserId }),
      ...(migrationClaimId === undefined ? {} : { migrationClaimId }),
      createdAt: now,
      expiresAt: now + PASSWORD_SIGN_UP_RESERVATION_LIFETIME_MS,
    });
    return { kind: "allowed" as const };
  },
});

/**
 * Operator-only helper for attaching a password account to one exact existing
 * HRA user. The returned claim is shown once and expires within one day.
 */
export const issue = internalAction({
  args: { userPublicId: v.string(), lifetimeMs: v.optional(v.number()) },
  returns: v.object({ claim: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const lifetimeMs = args.lifetimeMs ?? 30 * 60 * 1_000;
    if (
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs < 60_000 ||
      lifetimeMs > MAXIMUM_CLAIM_LIFETIME_MS
    ) throw new Error("Invalid password migration claim lifetime.");
    const found = await ctx.runQuery(internal.passwordMigrations.userByPublicId, {
      userPublicId: args.userPublicId,
    });
    if (found === null) throw new Error("HRA user not found.");
    const claim = `migration_${randomCrockford(52)}`;
    const claimProof = await browserMigrationClaimProof(claim);
    const claimProofDigest = await storedMigrationClaimProofDigest(claimProof);
    const expiresAt = Date.now() + lifetimeMs;
    await ctx.runMutation(internal.passwordMigrations.storeClaim, {
      userId: found.userId,
      claimProofDigest,
      expiresAt,
    });
    return { claim, expiresAt };
  },
});
