import { SUITE_CATALOG_REVISION } from "../suite-account-contracts";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authorizeOrganizationHuman } from "./humanAuthorization";
import {
  suiteAliasesAllowLink,
  suiteEntitlementProjectionIsFresh,
  suiteEntitlementProjectionTransition,
} from "./suiteIdentityRules";

const QUERY_REQUEST_ID = "req_00000000000000000000000000";
const MAX_LIVE_CHALLENGES_PER_USER = 5;
const MAX_CHALLENGES_SCANNED_PER_USER = 32;

type ReadCtx = QueryCtx | MutationCtx;
type CurrentHuman = Readonly<{
  localSubject: string;
  userId: Id<"users">;
}>;

const environmentValidator = v.union(
  v.literal("development"),
  v.literal("production"),
);
const featureValidator = v.union(
  v.literal("suite.paid"),
  v.literal("suite.believer"),
);

async function currentHuman(ctx: ReadCtx): Promise<CurrentHuman | null> {
  const authorized = await authorizeOrganizationHuman(ctx, {
    requestId: QUERY_REQUEST_ID,
  });
  if (!authorized.ok) return null;
  const { subject, user } = authorized.authorization;
  if (
    user.status !== "active"
    || (
      user.workosUserId !== subject
      && user.publicId !== subject
    )
  ) {
    return null;
  }
  return { localSubject: subject, userId: user._id };
}

function aliasCandidate(alias: Doc<"suiteIdentityAliases"> | null) {
  return alias === null
    ? null
    : {
        id: alias._id,
        localSubject: alias.localSubject,
        state: alias.state,
        suiteAccountId: alias.suiteAccountId,
        userId: alias.userId,
      };
}

export const currentSubject = internalQuery({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      localSubject: v.string(),
      userId: v.id("users"),
    }),
  ),
  handler: currentHuman,
});

export const storeChallenge = internalMutation({
  args: {
    challengeId: v.string(),
    environment: environmentValidator,
    expiresAt: v.number(),
    issuedAt: v.number(),
    keyVersion: v.string(),
    localSubject: v.string(),
    proofDigest: v.string(),
    userId: v.id("users"),
  },
  returns: v.union(v.literal("accepted"), v.literal("rejected")),
  handler: async (ctx, args) => {
    const human = await currentHuman(ctx);
    if (
      human === null
      || human.userId !== args.userId
      || human.localSubject !== args.localSubject
    ) {
      return "rejected";
    }
    const existing = await ctx.db.query("suiteIdentityLinkChallenges")
      .withIndex("by_challenge", (index) =>
        index.eq("challengeId", args.challengeId)
      )
      .unique();
    if (existing !== null) return "rejected";
    const now = Date.now();
    const recent = await ctx.db.query("suiteIdentityLinkChallenges")
      .withIndex("by_user", (index) => index.eq("userId", args.userId))
      .take(MAX_CHALLENGES_SCANNED_PER_USER + 1);
    let live = 0;
    let retained = 0;
    for (const challenge of recent) {
      if (challenge.expiresAt <= now) {
        await ctx.db.delete(challenge._id);
      } else {
        retained += 1;
        if (challenge.state === "pending") live += 1;
      }
    }
    if (
      retained >= MAX_CHALLENGES_SCANNED_PER_USER
      || live >= MAX_LIVE_CHALLENGES_PER_USER
    ) {
      return "rejected";
    }
    await ctx.db.insert("suiteIdentityLinkChallenges", {
      ...args,
      createdAt: now,
      state: "pending",
    });
    return "accepted";
  },
});
export const consumeReceipt = internalMutation({
  args: {
    challengeId: v.string(),
    environment: environmentValidator,
    expiresAt: v.number(),
    issuedAt: v.number(),
    keyVersion: v.string(),
    localSubject: v.string(),
    receiptDigest: v.string(),
    suiteAccountId: v.string(),
    userId: v.id("users"),
  },
  returns: v.union(
    v.literal("conflict"),
    v.literal("expired"),
    v.literal("linked"),
  ),
  handler: async (ctx, args) => {
    const human = await currentHuman(ctx);
    if (
      human === null
      || human.userId !== args.userId
      || human.localSubject !== args.localSubject
    ) {
      return "conflict";
    }
    const challenge = await ctx.db.query("suiteIdentityLinkChallenges")
      .withIndex("by_challenge", (index) =>
        index.eq("challengeId", args.challengeId)
      )
      .unique();
    if (
      challenge === null
      || challenge.userId !== args.userId
      || challenge.localSubject !== args.localSubject
      || challenge.environment !== args.environment
      || challenge.issuedAt !== args.issuedAt
      || challenge.expiresAt !== args.expiresAt
      || challenge.keyVersion !== args.keyVersion
    ) {
      return "conflict";
    }
    if (challenge.expiresAt <= Date.now()) return "expired";
    if (challenge.state === "consumed") {
      return challenge.receiptDigest === args.receiptDigest
          && challenge.suiteAccountId === args.suiteAccountId
        ? "linked"
        : "conflict";
    }

    const [byUser, byLocalSubject, bySuiteAccount] = await Promise.all([
      ctx.db.query("suiteIdentityAliases")
        .withIndex("by_user", (index) => index.eq("userId", args.userId))
        .unique(),
      ctx.db.query("suiteIdentityAliases")
        .withIndex("by_local_subject", (index) =>
          index.eq("localSubject", args.localSubject)
        )
        .unique(),
      ctx.db.query("suiteIdentityAliases")
        .withIndex("by_suite_account", (index) =>
          index.eq("suiteAccountId", args.suiteAccountId)
        )
        .unique(),
    ]);
    if (!suiteAliasesAllowLink(
      [
        aliasCandidate(byUser),
        aliasCandidate(byLocalSubject),
        aliasCandidate(bySuiteAccount),
      ],
      {
        localSubject: args.localSubject,
        suiteAccountId: args.suiteAccountId,
        userId: args.userId,
      },
    )) {
      return "conflict";
    }
    if (byUser === null && byLocalSubject === null && bySuiteAccount === null) {
      const now = Date.now();
      await ctx.db.insert("suiteIdentityAliases", {
        environment: args.environment,
        linkedAt: now,
        localSubject: args.localSubject,
        state: "active",
        suiteAccountId: args.suiteAccountId,
        updatedAt: now,
        userId: args.userId,
      });
    }
    await ctx.db.patch(challenge._id, {
      receiptDigest: args.receiptDigest,
      state: "consumed",
      suiteAccountId: args.suiteAccountId,
    });
    return "linked";
  },
});

export const applyEntitlementReceipt = internalMutation({
  args: {
    expiresAt: v.number(),
    features: v.array(featureValidator),
    localSubject: v.string(),
    observedAt: v.number(),
    projectionRevision: v.number(),
    receiptDigest: v.string(),
    receiptIssuedAt: v.number(),
    suiteAccountId: v.string(),
    userId: v.id("users"),
  },
  returns: v.union(
    v.literal("accepted"),
    v.literal("conflict"),
    v.literal("unlinked"),
  ),
  handler: async (ctx, args) => {
    const human = await currentHuman(ctx);
    if (
      human === null
      || human.userId !== args.userId
      || human.localSubject !== args.localSubject
    ) {
      return "unlinked";
    }
    const [byUser, byLocalSubject] = await Promise.all([
      ctx.db.query("suiteIdentityAliases")
        .withIndex("by_user", (index) => index.eq("userId", args.userId))
        .unique(),
      ctx.db.query("suiteIdentityAliases")
        .withIndex("by_local_subject", (index) =>
          index.eq("localSubject", args.localSubject)
        )
        .unique(),
    ]);
    if (
      byUser === null
      || byLocalSubject === null
      || byUser._id !== byLocalSubject._id
      || byUser.state !== "active"
      || byUser.suiteAccountId !== args.suiteAccountId
    ) {
      return "unlinked";
    }
    const projection = await ctx.db.query("suiteEntitlementProjections")
      .withIndex("by_user", (index) => index.eq("userId", args.userId))
      .unique();
    const incoming = {
      catalogRevision: SUITE_CATALOG_REVISION,
      expiresAt: args.expiresAt,
      features: args.features,
      observedAt: args.observedAt,
      projectionRevision: args.projectionRevision,
      receiptDigest: args.receiptDigest,
      receiptIssuedAt: args.receiptIssuedAt,
      suiteAccountId: args.suiteAccountId,
    };
    const transition = suiteEntitlementProjectionTransition(
      projection === null
        ? null
        : {
            catalogRevision: projection.catalogRevision,
            expiresAt: projection.expiresAt,
            features: projection.features,
            observedAt: projection.observedAt,
            projectionRevision: projection.projectionRevision,
            receiptDigest: projection.receiptDigest,
            ...(projection.receiptIssuedAt === undefined
              ? {}
              : { receiptIssuedAt: projection.receiptIssuedAt }),
            suiteAccountId: projection.suiteAccountId,
          },
      incoming,
    );
    if (transition === "conflict") return "conflict";
    if (transition === "idempotent") {
      if (
        projection !== null
        && projection.catalogRevision !== SUITE_CATALOG_REVISION
      ) {
        await ctx.db.patch(projection._id, {
          catalogRevision: SUITE_CATALOG_REVISION,
          updatedAt: Date.now(),
        });
      }
      return "accepted";
    }
    const value = {
      ...incoming,
      localSubject: args.localSubject,
      updatedAt: Date.now(),
      userId: args.userId,
    };
    if (transition === "replace" && projection !== null) {
      await ctx.db.patch(projection._id, value);
    } else {
      await ctx.db.insert("suiteEntitlementProjections", value);
    }
    return "accepted";
  },
});

export const current = query({
  args: {},
  returns: v.union(
    v.object({ kind: v.literal("signed_out") }),
    v.object({ kind: v.literal("unlinked") }),
    v.object({
      kind: v.literal("linked"),
      suiteAccountId: v.string(),
      verification: v.union(
        v.object({ kind: v.literal("unverified") }),
        v.object({
          expiresAtMs: v.number(),
          features: v.array(featureValidator),
          freshness: v.union(v.literal("fresh"), v.literal("stale")),
          kind: v.literal("verified"),
          observedAtMs: v.number(),
          projectionRevision: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const human = await currentHuman(ctx);
    if (human === null) return { kind: "signed_out" as const };
    const [byUser, byLocalSubject] = await Promise.all([
      ctx.db.query("suiteIdentityAliases")
        .withIndex("by_user", (index) => index.eq("userId", human.userId))
        .unique(),
      ctx.db.query("suiteIdentityAliases")
        .withIndex("by_local_subject", (index) =>
          index.eq("localSubject", human.localSubject)
        )
        .unique(),
    ]);
    if (
      byUser === null
      || byLocalSubject === null
      || byUser._id !== byLocalSubject._id
      || byUser.state !== "active"
    ) {
      return { kind: "unlinked" as const };
    }
    const projection = await ctx.db.query("suiteEntitlementProjections")
      .withIndex("by_user", (index) => index.eq("userId", human.userId))
      .unique();
    if (
      projection === null
      || projection.localSubject !== human.localSubject
      || projection.suiteAccountId !== byUser.suiteAccountId
    ) {
      return {
        kind: "linked" as const,
        suiteAccountId: byUser.suiteAccountId,
        verification: { kind: "unverified" as const },
      };
    }
    const fresh = suiteEntitlementProjectionIsFresh(
      {
        catalogRevision: projection.catalogRevision,
        expiresAt: projection.expiresAt,
        features: projection.features,
        observedAt: projection.observedAt,
        projectionRevision: projection.projectionRevision,
        receiptDigest: projection.receiptDigest,
        suiteAccountId: projection.suiteAccountId,
      },
      byUser.suiteAccountId,
      Date.now(),
    );
    return {
      kind: "linked" as const,
      suiteAccountId: byUser.suiteAccountId,
      verification: {
        expiresAtMs: projection.expiresAt,
        features: fresh ? projection.features : [],
        freshness: fresh ? "fresh" as const : "stale" as const,
        kind: "verified" as const,
        observedAtMs: projection.observedAt,
        projectionRevision: projection.projectionRevision,
      },
    };
  },
});
