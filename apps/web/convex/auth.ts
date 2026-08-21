import { humanUserIdSchema } from "@hraness/agent-tasks-protocol";
import {
  ConvexCredentials,
  type ConvexCredentialsUserConfig,
} from "@convex-dev/auth/providers/ConvexCredentials";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, getAuthSessionId } from "@convex-dev/auth/server";
import type { GenericDataModel } from "convex/server";
import type { Value } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  AUTH_SESSION_TOTAL_DURATION_MS,
  normalizePasswordEmail,
  validatePasswordRequirements,
} from "./authPolicy";
import { decodeBase64Url32, sha256Base64Url } from "./crypto";
import { randomCrockford } from "./domain";
import { parseDesktopPairingVerifier } from "./desktopPairing";

type AuthDataModel = DataModel & GenericDataModel;

const ALL_WORKSPACE_ROLES = ["planner", "reviewer", "viewer"] as const;

function normalizedName(value: unknown, email: string): string {
  if (value === undefined || value === null || value === "") return email.split("@", 1)[0] ?? email;
  if (typeof value !== "string") throw new Error("Enter a valid name.");
  const name = value.trim();
  if (name.length === 0 || name.length > 240) throw new Error("Enter a valid name.");
  return name;
}

function constantTimeChallengeMatches(left: string, right: string): boolean {
  const leftBytes = decodeBase64Url32(left);
  const rightBytes = decodeBase64Url32(right);
  if (leftBytes === null || rightBytes === null) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

const basePassword = Password<AuthDataModel>({
  validatePasswordRequirements,
  profile: (params) => {
    const email = normalizePasswordEmail(params.email);
    const name = normalizedName(params.name, email);
    const now = Date.now();
    return {
      publicId: humanUserIdSchema.parse(`usr_${randomCrockford(26)}`),
      email,
      name,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
  },
});

const passwordImplementation = (
  basePassword as unknown as { options: ConvexCredentialsUserConfig<AuthDataModel> }
).options;

// Convex Auth 0.0.95 materializes Password from this credentials implementation.
// Supplying the exact session persists durable password-origin provenance.
// Pairing decisions separately require its authenticatedAt timestamp to be
// recent; pairing and scope-selection providers never receive provenance.
const password = ConvexCredentials<AuthDataModel>({
  ...passwordImplementation,
  id: "password",
  authorize: async (credentials, ctx) => {
    const flow = credentials.flow;
    if (flow !== "signIn" && flow !== "signUp") {
      throw new Error("Unsupported password authentication flow.");
    }
    const email = normalizePasswordEmail(credentials.email);
    const migrationClaimProof = credentials.migrationClaimProof;
    if (credentials.migrationClaimDigest !== undefined) {
      throw new Error("Password authentication was not accepted.");
    }
    if (
      migrationClaimProof !== undefined &&
      (typeof migrationClaimProof !== "string" || decodeBase64Url32(migrationClaimProof) === null)
    ) throw new Error("Password authentication was not accepted.");
    if (typeof credentials.password !== "string") {
      throw new Error("Password authentication was not accepted.");
    }
    // Every password account is created under this exact policy. Rejecting
    // impossible sign-in candidates before admission avoids needless Scrypt
    // work and keeps controls/oversized values out of the pinned provider.
    validatePasswordRequirements(credentials.password);
    const admission = await ctx.runMutation(
      internal.passwordMigrations.beginPasswordAuthorization,
      {
        email,
        flow,
        ...(migrationClaimProof === undefined ? {} : { migrationClaimProof }),
        requestId: `req_${randomCrockford(26)}`,
      },
    );
    if (admission.kind !== "allowed") {
      throw new Error("Password authentication was not accepted.");
    }
    const providerCredentials: Partial<Record<string, Value | undefined>> = {
      ...credentials,
      email,
    };
    delete providerCredentials.migrationClaimProof;
    const authorized = await passwordImplementation.authorize(providerCredentials, ctx);
    if (authorized === null) return null;
    if (authorized.sessionId !== undefined) {
      throw new Error("Unexpected nested password session.");
    }
    let replacedSessionId;
    try {
      replacedSessionId = await getAuthSessionId(ctx);
    } catch {
      replacedSessionId = null;
    }
    return await ctx.runMutation(internal.desktopPairing.createPasswordSession, {
      userId: authorized.userId,
      ...(replacedSessionId === null ? {} : { replacedSessionId }),
    });
  },
});

const desktopPairing = ConvexCredentials<AuthDataModel>({
  id: "desktop-pairing",
  authorize: async (credentials, ctx) => {
    const pairingId = credentials.pairingId;
    const verifier = parseDesktopPairingVerifier(credentials.verifier);
    if (typeof pairingId !== "string" || verifier === null) return null;
    const stored = await ctx.runQuery(internal.desktopPairing.readCredentialChallenge, {
      pairingId,
    });
    if (stored === null) return null;
    const challenge = await sha256Base64Url(verifier);
    if (!constantTimeChallengeMatches(stored.challenge, challenge)) return null;
    return await ctx.runMutation(internal.desktopPairing.consumeApproved, {
      pairingId,
      expectedChallenge: challenge,
    });
  },
});

const scopeSelection = ConvexCredentials<AuthDataModel>({
  id: "scope-selection",
  authorize: async (credentials, ctx) => {
    if (
      typeof credentials.credential !== "string" ||
      !/^selection_[0-9A-HJKMNP-TV-Z]{52}$/u.test(credentials.credential)
    ) return null;
    return await ctx.runMutation(internal.desktopPairing.consumeScopeRotation, {
      credential: credentials.credential,
    });
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [password, desktopPairing, scopeSelection],
  session: { totalDurationMs: AUTH_SESSION_TOTAL_DURATION_MS },
  callbacks: {
    createOrUpdateUser: async (ctx, args) => {
      const db = ctx.db as unknown as MutationCtx["db"];
      const profile = args.profile as Record<string, unknown>;
      const email = normalizePasswordEmail(profile.email);
      const name = normalizedName(profile.name, email);
      const now = Date.now();

      if (args.existingUserId !== null || args.provider.id !== "password") {
        throw new Error("Password account creation was not admitted.");
      }

      const existingByEmail = await db
        .query("users")
        .withIndex("email", (index) => index.eq("email", email))
        .unique();
      const emailDigest = await sha256Base64Url(`hra-password-email-v1:${email}`);
      const reservation = await db
        .query("passwordSignUpReservations")
        .withIndex("by_email_digest", (index) => index.eq("emailDigest", emailDigest))
        .unique();
      if (reservation === null || reservation.expiresAt <= now) {
        throw new Error("Password account creation was not admitted.");
      }
      if (reservation.targetUserId !== undefined) {
        const claim = reservation.migrationClaimId === undefined
          ? null
          : await db.get(reservation.migrationClaimId);
        const target = await db.get(reservation.targetUserId);
        if (
          claim === null || target === null || target.status !== "active" ||
          claim.userId !== target._id ||
          claim.consumedAt !== undefined || claim.expiresAt <= now ||
          (existingByEmail !== null && existingByEmail._id !== target._id)
        ) throw new Error("Password account creation was not admitted.");
        const existingPasswordAccount = await db
          .query("authAccounts")
          .withIndex("userIdAndProvider", (index) =>
            index.eq("userId", target._id).eq("provider", "password"))
          .first();
        if (existingPasswordAccount !== null) {
          throw new Error("Password account creation was not admitted.");
        }
        await db.patch(claim._id, { consumedAt: now });
        await db.patch(target._id, { email, name, updatedAt: now });
        await db.delete(reservation._id);
        return target._id;
      }
      if (reservation.migrationClaimId !== undefined) {
        throw new Error("Password account creation was not admitted.");
      }
      if (existingByEmail !== null) {
        throw new Error("Password account creation was not admitted.");
      }

      const publicId = humanUserIdSchema.parse(profile.publicId);
      const userId = await db.insert("users", {
        publicId,
        email,
        name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const organizationId = await db.insert("organizations", {
        publicId: `org_${randomCrockford(26)}`,
        name: `${name.slice(0, 140)}'s HRA`,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert("organizationMemberships", {
        organizationId,
        userId,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const workspaceId = await db.insert("workspaces", {
        organizationId,
        publicId: `wsp_${randomCrockford(26)}`,
        slug: "personal",
        name: "Personal",
        taskKeyPrefix: "HRA",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert("workspaceMemberships", {
        organizationId,
        workspaceId,
        userId,
        roles: [...ALL_WORKSPACE_ROLES],
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert("workspaceUsage", {
        organizationId,
        workspaceId,
        activeTasks: 0,
        totalTasks: 0,
        activeAgents: 0,
        updatedAt: now,
      });
      await db.delete(reservation._id);
      return userId;
    },
    beforeSessionCreation: async (ctx, { userId }) => {
      const db = ctx.db as unknown as MutationCtx["db"];
      const user = await db.get(userId);
      if (user === null || user.status !== "active") {
        throw new Error("This HRA account is unavailable.");
      }
    },
  },
});
