import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { convexTest, type TestConvex } from "convex-test";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Base64Url } from "./crypto";
import {
  browserMigrationClaimProof,
  storedMigrationClaimProofDigest,
} from "./passwordMigrations";
import { unauthenticatedSlotKey } from "./rateLimitPolicy";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": async () => await import("./_generated/api"),
  "./_generated/server.ts": async () => await import("./_generated/server"),
  "./auth.ts": async () => await import("./auth"),
  "./desktopPairing.ts": async () => await import("./desktopPairing"),
  "./passwordMigrations.ts": async () => await import("./passwordMigrations"),
  "./rateLimits.ts": async () => await import("./rateLimits"),
};

type AuthTest = TestConvex<typeof schema>;

const originalEnvironment = {
  CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
  JWKS: process.env.JWKS,
  JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY,
  SITE_URL: process.env.SITE_URL,
};

async function testSigningKeys(): Promise<{ privateKey: string; jwks: string }> {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2_048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const privateBytes = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const base64 = Buffer.from(privateBytes).toString("base64");
  const privateKey = [
    "-----BEGIN PRIVATE KEY-----",
    ...base64.match(/.{1,64}/gu) ?? [],
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey,
    jwks: JSON.stringify({
      keys: [{ ...publicJwk, use: "sig", alg: "RS256", kid: "auth-test-v1" }],
    }),
  };
}

beforeAll(async () => {
  const keys = await testSigningKeys();
  process.env.CONVEX_SITE_URL = "https://convex-auth.test";
  process.env.SITE_URL = "https://hra.test";
  process.env.JWT_PRIVATE_KEY = keys.privateKey;
  process.env.JWKS = keys.jwks;
});

afterAll(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function seedLegacyUser(
  t: AuthTest,
  publicId: string,
  email?: string,
) {
  return await t.run(async (ctx) => await ctx.db.insert("users", {
    publicId,
    name: "Preserved human",
    ...(email === undefined ? {} : { email }),
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  }));
}

async function storeClaim(t: AuthTest, userId: Awaited<ReturnType<typeof seedLegacyUser>>, claim: string) {
  const claimProof = await browserMigrationClaimProof(claim);
  const claimProofDigest = await storedMigrationClaimProofDigest(claimProof);
  return await t.run(async (ctx) => await ctx.db.insert("passwordMigrationClaims", {
    claimProofDigest,
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  }));
}

async function signUp(
  t: AuthTest,
  args: {
    email: string;
    password: string;
    migrationClaim?: string;
    migrationClaimProof?: string;
  },
) {
  const migrationClaimProof = args.migrationClaimProof ??
    (args.migrationClaim === undefined
      ? undefined
      : await browserMigrationClaimProof(args.migrationClaim));
  return await t.action(api.auth.signIn, {
    provider: "password",
    params: {
      flow: "signUp",
      email: args.email,
      password: args.password,
      name: "Migrated human",
      ...(migrationClaimProof === undefined ? {} : { migrationClaimProof }),
    },
    calledBy: "auth-migration-test",
  });
}

async function signIn(t: AuthTest, email: string, password: string) {
  return await t.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", email, password },
    calledBy: "auth-rate-limit-test",
  });
}

async function passwordEmailSlot(email: string): Promise<string> {
  const digest = await sha256Base64Url(
    `hra-password-email-v1:${email.trim().toLowerCase()}`,
  );
  const slot = unauthenticatedSlotKey(digest);
  if (slot === null) throw new Error("Unable to derive password admission slot.");
  return slot;
}

describe.serial("Convex Auth password cutover", () => {
  test("enforces the password policy on direct action calls", async () => {
    const t = convexTest(schema, modules);
    await expect(signUp(t, {
      email: "short-password@example.test",
      password: "too-short",
    })).rejects.toThrow();
    expect(await t.run(async (ctx) => await ctx.db.query("users").collect())).toEqual([]);
  });

  test("rejects impossible sign-in candidates before admission or Scrypt", async () => {
    const t = convexTest(schema, modules);
    await signUp(t, {
      email: "bounded-sign-in@example.test",
      password: "bounded-sign-in-password-1234",
    });
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    try {
      for (const password of [7, "a".repeat(1_025), "valid-password\u0000control"]) {
        await expect(t.action(api.auth.signIn, {
          provider: "password",
          params: {
            flow: "signIn",
            email: "bounded-sign-in@example.test",
            password,
          },
          calledBy: "auth-sign-in-bounds-test",
        })).rejects.toThrow();
      }
      expect(info.mock.calls.some((call) =>
        call.some((value) => String(value).includes("retrieveAccountWithCredentials"))
      )).toBeFalse();
    } finally {
      info.mockRestore();
    }
    expect(await t.run(async (ctx) => await ctx.db
      .query("apiRateLimitBuckets")
      .filter((query) => query.eq(query.field("routeClass"), "password_sign_in"))
      .collect())).toEqual([]);
  });

  test("rejects repeated sign-up for an existing account before password verification", async () => {
    const t = convexTest(schema, modules);
    await signUp(t, {
      email: "existing-sign-up@example.test",
      password: "existing-password-1234",
    });
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const attempts = await Promise.allSettled(Array.from({ length: 12 }, async (_, index) =>
        await signUp(t, {
          email: "existing-sign-up@example.test",
          password: `wrong-password-${String(index).padStart(4, "0")}`,
        })));
      expect(attempts.every(({ status }) => status === "rejected")).toBeTrue();
      expect(info.mock.calls.some((call) =>
        call.some((value) => String(value).includes("createAccountFromCredentials"))
      )).toBeFalse();
    } finally {
      info.mockRestore();
    }
    expect(await t.run(async (ctx) => await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (index) =>
        index.eq("provider", "password").eq("providerAccountId", "existing-sign-up@example.test"))
      .collect())).toHaveLength(1);
  });

  test("rate-limits direct password sign-in before unbounded secret verification", async () => {
    const t = convexTest(schema, modules);
    await signUp(t, {
      email: "limited-sign-in@example.test",
      password: "limited-password-1234",
    });
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const attempts = [];
      for (let index = 0; index < 12; index += 1) {
        attempts.push(await Promise.resolve(signIn(
          t,
          "limited-sign-in@example.test",
          `wrong-password-${String(index).padStart(4, "0")}`,
        )).then(
          () => "fulfilled" as const,
          () => "rejected" as const,
        ));
      }
      expect(attempts).toEqual(Array.from({ length: 12 }, () => "rejected"));
      const upstreamAttempts = info.mock.calls.filter((call) =>
        call.some((value) => String(value).includes("retrieveAccountWithCredentials"))
      ).length;
      expect(upstreamAttempts).toBeGreaterThan(0);
      expect(upstreamAttempts).toBeLessThan(12);
    } finally {
      info.mockRestore();
    }
    const buckets = await t.run(async (ctx) => await ctx.db
      .query("apiRateLimitBuckets")
      .collect());
    expect(buckets.some(({ routeClass }) => routeClass === "password_sign_in")).toBeTrue();
  }, 30_000);

  test("unknown same-slot emails cannot exhaust an existing account", async () => {
    const t = convexTest(schema, modules);
    const victimEmail = "stable-account@example.test";
    await signUp(t, {
      email: victimEmail,
      password: "stable-account-password-1234",
    });
    const victimSlot = await passwordEmailSlot(victimEmail);
    let collidingEmail: string | null = null;
    for (let index = 0; index < 4_096; index += 1) {
      const candidate = `unknown-collision-${String(index)}@example.test`;
      if (candidate !== victimEmail && await passwordEmailSlot(candidate) === victimSlot) {
        collidingEmail = candidate;
        break;
      }
    }
    expect(collidingEmail).not.toBeNull();
    if (collidingEmail === null) throw new Error("Missing deterministic slot collision.");
    for (let index = 0; index < 9; index += 1) {
      await expect(signIn(
        t,
        collidingEmail,
        `unknown-password-${String(index).padStart(4, "0")}`,
      )).rejects.toThrow();
    }
    const signedIn = await signIn(t, victimEmail, "stable-account-password-1234");
    expect(signedIn.tokens).not.toBeNull();
    const buckets = await t.run(async (ctx) => await ctx.db
      .query("apiRateLimitBuckets")
      .collect());
    expect(buckets.some(({ subjectKind, subjectKey }) =>
      subjectKind === "unauthenticated" && subjectKey === victimSlot
    )).toBeTrue();
    expect(buckets.filter(({ subjectKind }) => subjectKind === "credential"))
      .toEqual([expect.objectContaining({ count: 1 })]);
    expect(buckets.filter(({ subjectKind, subjectKey }) =>
      subjectKind === "global" && subjectKey === "password_sign_in_known"
    )).toEqual([expect.objectContaining({ count: 1 })]);
  }, 30_000);

  test("globally bounds distributed guesses across distinct known accounts", async () => {
    const t = convexTest(schema, modules);
    const accountIds = await t.run(async (ctx) => {
      const ids: Id<"authAccounts">[] = [];
      for (let index = 0; index < 61; index += 1) {
        const email = `known-global-${String(index)}@example.test`;
        const userId = await ctx.db.insert("users", {
          publicId: `usr_${String(index).padStart(26, "0")}`,
          name: `Known ${String(index)}`,
          email,
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        });
        ids.push(await ctx.db.insert("authAccounts", {
          userId,
          provider: "password",
          providerAccountId: email,
          secret: "not-read-by-admission",
        }));
      }
      return ids;
    });
    const results = [];
    for (let index = 0; index < accountIds.length; index += 1) {
      results.push(await t.mutation(internal.passwordMigrations.beginPasswordAuthorization, {
        email: `known-global-${String(index)}@example.test`,
        flow: "signIn",
        requestId: `req_${String(index + 500).padStart(26, "0")}`,
      }));
    }
    expect(results.slice(0, 60).every(({ kind }) => kind === "allowed")).toBeTrue();
    expect(results[60]?.kind).toBe("limited");
    const buckets = await t.run(async (ctx) => await ctx.db
      .query("apiRateLimitBuckets")
      .collect());
    expect(buckets.filter(({ subjectKind, subjectKey }) =>
      subjectKind === "global" && subjectKey === "password_sign_in_known"
    )).toEqual([expect.objectContaining({ count: 60 })]);
    expect(buckets.filter(({ subjectKind }) => subjectKind === "credential")).toHaveLength(60);
  });

  test("globally bounds sign-up admission across distinct email slots", async () => {
    const t = convexTest(schema, modules);
    const distinct = new Map<string, string>();
    for (let index = 0; index < 10_000 && distinct.size < 21; index += 1) {
      const email = `global-sign-up-${String(index)}@example.test`;
      distinct.set(await passwordEmailSlot(email), email);
    }
    expect(distinct.size).toBe(21);
    const results = [];
    let index = 0;
    for (const email of distinct.values()) {
      index += 1;
      results.push(await t.mutation(internal.passwordMigrations.beginPasswordAuthorization, {
        email,
        flow: "signUp",
        requestId: `req_${String(index).padStart(26, "0")}`,
      }));
    }
    expect(results.filter(({ kind }) => kind === "allowed")).toHaveLength(20);
    expect(results.at(-1)?.kind).toBe("limited");
    const global = await t.run(async (ctx) => await ctx.db
      .query("apiRateLimitBuckets")
      .withIndex("by_subject_route_window_shard", (query) => query
        .eq("subjectKind", "global")
        .eq("subjectKey", "password_sign_up")
        .eq("routeClass", "password_sign_up"))
      .unique());
    expect(global?.count).toBe(20);
  });

  test("real refresh rotation and ancestor replay share one session budget", async () => {
    const t = convexTest(schema, modules);
    const signedUp = await signUp(t, {
      email: "refresh-chain@example.test",
      password: "refresh-chain-password-1234",
    });
    if (signedUp.tokens === null || signedUp.tokens === undefined) {
      throw new Error("Missing refresh-chain credentials.");
    }
    const ancestor = signedUp.tokens.refreshToken;
    let current = ancestor;
    let stableSessionId: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const [refreshTokenId, sessionId] = current.split("|");
      if (refreshTokenId === undefined || sessionId === undefined) {
        throw new Error("Malformed refresh-chain credential.");
      }
      stableSessionId ??= sessionId;
      expect(sessionId).toBe(stableSessionId);
      expect((await t.mutation(internal.rateLimits.consumeRefresh, {
        refreshTokenId,
        sessionId,
        requestId: `req_${String(index + 100).padStart(26, "0")}`,
      })).kind).toBe("allowed");
      const refreshed = await t.action(api.auth.signIn, {
        refreshToken: current,
        calledBy: "auth-refresh-chain-test",
      });
      if (refreshed.tokens === null || refreshed.tokens === undefined) {
        throw new Error("Refresh-chain rotation failed.");
      }
      current = refreshed.tokens.refreshToken;
    }
    const [latestTokenId, latestSessionId] = current.split("|");
    expect((await t.mutation(internal.rateLimits.consumeRefresh, {
      refreshTokenId: latestTokenId!,
      sessionId: latestSessionId!,
      requestId: "req_00000000000000000000000108",
    })).kind).toBe("limited");
    const [ancestorTokenId, ancestorSessionId] = ancestor.split("|");
    expect((await t.mutation(internal.rateLimits.consumeRefresh, {
      refreshTokenId: ancestorTokenId!,
      sessionId: ancestorSessionId!,
      requestId: "req_00000000000000000000000109",
    })).kind).toBe("limited");
  }, 30_000);

  test("does not accept the stored migration verifier as a browser proof", async () => {
    const t = convexTest(schema, modules);
    const targetId = await seedLegacyUser(t, "user_preserved_second_hash");
    const claim = "migration_second_hash_exact_claim";
    const claimId = await storeClaim(t, targetId, claim);
    const claimProof = await browserMigrationClaimProof(claim);
    const storedDigest = await storedMigrationClaimProofDigest(claimProof);

    await expect(signUp(t, {
      email: "second-hash@example.test",
      password: "second-hash-password-1234",
      migrationClaimProof: storedDigest,
    })).rejects.toThrow();
    expect((await t.run(async (ctx) => await ctx.db.get(claimId)))?.consumedAt).toBeUndefined();
    expect(await t.run(async (ctx) => await ctx.db.query("authAccounts").collect())).toEqual([]);

    await signUp(t, {
      email: "second-hash@example.test",
      password: "second-hash-password-1234",
      migrationClaim: claim,
    });
    expect((await t.run(async (ctx) => await ctx.db.get(claimId)))?.consumedAt).toBeNumber();
  });

  test("binds a missing-email legacy user only through its exact claim", async () => {
    const t = convexTest(schema, modules);
    const targetId = await seedLegacyUser(t, "user_preserved_missing_email");
    const claim = "migration_missing_email_exact_claim";
    const claimId = await storeClaim(t, targetId, claim);

    const result = await signUp(t, {
      email: "preserved@example.test",
      password: "preserved-password-1234",
      migrationClaim: claim,
    });
    expect(result.tokens).not.toBeNull();
    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(targetId),
      claim: await ctx.db.get(claimId),
      accounts: await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (index) =>
          index.eq("userId", targetId).eq("provider", "password"))
        .collect(),
      sessions: await ctx.db.query("authSessions").collect(),
      passwordProofs: await ctx.db.query("passwordSessionProofs").collect(),
    }));
    expect(state.user).toMatchObject({
      _id: targetId,
      publicId: "user_preserved_missing_email",
      email: "preserved@example.test",
    });
    expect(state.claim?.consumedAt).toBeNumber();
    expect(state.accounts).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.passwordProofs).toEqual([
      expect.objectContaining({
        sessionId: state.sessions[0]!._id,
        userId: targetId,
      }),
    ]);
  });

  test("rejects a claim when its email belongs to a different user", async () => {
    const t = convexTest(schema, modules);
    const targetId = await seedLegacyUser(t, "user_preserved_collision_target");
    await seedLegacyUser(t, "user_preserved_collision_owner", "collision@example.test");
    const claim = "migration_collision_exact_claim";
    const claimId = await storeClaim(t, targetId, claim);

    await expect(signUp(t, {
      email: "collision@example.test",
      password: "collision-password-1234",
      migrationClaim: claim,
    })).rejects.toThrow();
    expect((await t.run(async (ctx) => await ctx.db.get(claimId)))?.consumedAt).toBeUndefined();
  });

  test("allows only one sequential password binding for a preserved user", async () => {
    const t = convexTest(schema, modules);
    const targetId = await seedLegacyUser(t, "user_preserved_sequential");
    const firstClaim = "migration_sequential_first_claim";
    const secondClaim = "migration_sequential_second_claim";
    await storeClaim(t, targetId, firstClaim);
    const secondClaimId = await storeClaim(t, targetId, secondClaim);

    await signUp(t, {
      email: "sequential-first@example.test",
      password: "sequential-password-1234",
      migrationClaim: firstClaim,
    });
    await expect(signUp(t, {
      email: "sequential-second@example.test",
      password: "sequential-password-5678",
      migrationClaim: secondClaim,
    })).rejects.toThrow();
    const state = await t.run(async (ctx) => ({
      secondClaim: await ctx.db.get(secondClaimId),
      accounts: await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (index) =>
          index.eq("userId", targetId).eq("provider", "password"))
        .collect(),
    }));
    expect(state.accounts).toHaveLength(1);
    expect(state.secondClaim?.consumedAt).toBeUndefined();
  });

  test("serializes concurrent claims to one password binding", async () => {
    const t = convexTest(schema, modules);
    const targetId = await seedLegacyUser(t, "user_preserved_concurrent");
    const firstClaim = "migration_concurrent_first_claim";
    const secondClaim = "migration_concurrent_second_claim";
    await Promise.all([
      storeClaim(t, targetId, firstClaim),
      storeClaim(t, targetId, secondClaim),
    ]);

    const results = await Promise.allSettled([
      signUp(t, {
        email: "concurrent-first@example.test",
        password: "concurrent-password-1234",
        migrationClaim: firstClaim,
      }),
      signUp(t, {
        email: "concurrent-second@example.test",
        password: "concurrent-password-5678",
        migrationClaim: secondClaim,
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await t.run(async (ctx) => await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (index) =>
        index.eq("userId", targetId).eq("provider", "password"))
      .collect())).toHaveLength(1);
  });
});
