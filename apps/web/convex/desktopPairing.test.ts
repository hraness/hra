import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { convexTest, type TestConvex } from "convex-test";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PASSWORD_PAIRING_APPROVAL_WINDOW_MS } from "./authPolicy";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": async () => await import("./_generated/api"),
  "./_generated/server.ts": async () => await import("./_generated/server"),
  "./auth.ts": async () => await import("./auth"),
  "./desktopPairing.ts": async () => await import("./desktopPairing"),
  "./http.ts": async () => await import("./http"),
  "./rateLimits.ts": async () => await import("./rateLimits"),
};

type PairingTest = TestConvex<typeof schema>;

const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

beforeAll(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:3211";
});

afterAll(() => {
  if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

function secret(index: number): string {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(28, index);
  return Buffer.from(bytes).toString("base64url");
}

function request(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:3211${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedScope(t: PairingTest) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      publicId: "usr_00000000000000000000001001",
      email: "pairing@example.test",
      name: "Pairing human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const organizationId = await ctx.db.insert("organizations", {
      publicId: "org_00000000000000000000001001",
      name: "Pairing organization",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = await ctx.db.insert("organizationMemberships", {
      userId,
      organizationId,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      publicId: "wsp_00000000000000000000001001",
      slug: "pairing",
      name: "Pairing workspace",
      taskKeyPrefix: "PAIR",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const expirationTime = now + 60 * 60 * 1_000;
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime,
    });
    const passwordProofId = await ctx.db.insert("passwordSessionProofs", {
      sessionId,
      userId,
      authenticatedAt: now,
      expiresAt: expirationTime,
    });
    return {
      membershipId,
      organizationId,
      passwordProofId,
      sessionId,
      userId,
      workspaceId,
    };
  });
  return {
    ...seeded,
    actor: t.withIdentity({
      issuer: "https://convex.test",
      subject: `${seeded.userId}|${seeded.sessionId}`,
      tokenIdentifier: `https://convex.test|${seeded.userId}|${seeded.sessionId}`,
    }),
  };
}

describe.serial("desktop pairing authority", () => {
  test("bounds a distinct-challenge start flood through shared admission", async () => {
    const t = convexTest(schema, modules);
    const statuses = [];
    for (let index = 0; index < 121; index += 1) {
      statuses.push((await t.fetch(
        "/v1/auth/desktop-pairings",
        request("/v1/auth/desktop-pairings", { challenge: secret(index + 1) }),
      )).status);
    }
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(120);
    expect(statuses).toContain(429);
    expect(await t.run(async (ctx) =>
      await ctx.db.query("desktopPairingRequests").collect()
    )).toHaveLength(statuses.filter((status) => status === 200).length);
  }, 30_000);

  test("keys rotating verifier guesses by pairing locator, not verifier", async () => {
    const t = convexTest(schema, modules);
    const started = await t.mutation(internal.desktopPairing.start, { challenge: secret(1) });
    const statuses = [];
    for (let index = 0; index < 601; index += 1) {
      const path = `/v1/auth/desktop-pairings/${started.pairingId}/redeem`;
      statuses.push((await t.fetch(path, request(path, { verifier: secret(index + 10) }))).status);
    }
    expect(statuses).toContain(429);
    const subjectKeys = new Set(await t.run(async (ctx) =>
      (await ctx.db.query("apiRateLimitBuckets").collect())
        .filter(({ routeClass }) => routeClass === "desktop_pairing_redeem")
        .map(({ subjectKey }) => subjectKey)
    ));
    expect(subjectKeys.size).toBeLessThanOrEqual(2);
  }, 30_000);

  test("binds rotating and replayed refresh tokens to one stable session budget", async () => {
    const t = convexTest(schema, modules);
    const scope = await seedScope(t);
    const tokens = await t.run(async (ctx) => {
      const ids: Id<"authRefreshTokens">[] = [];
      let parentRefreshTokenId: Id<"authRefreshTokens"> | undefined;
      for (let index = 0; index < 9; index += 1) {
        const id: Id<"authRefreshTokens"> = await ctx.db.insert("authRefreshTokens", {
          sessionId: scope.sessionId,
          expirationTime: Date.now() + 60_000,
          ...(parentRefreshTokenId === undefined ? {} : { parentRefreshTokenId }),
        });
        ids.push(id);
        parentRefreshTokenId = id;
      }
      return ids;
    });
    const results = [];
    for (let index = 0; index < tokens.length; index += 1) {
      results.push(await t.mutation(internal.rateLimits.consumeRefresh, {
        refreshTokenId: tokens[index]!,
        sessionId: scope.sessionId,
        requestId: `req_${String(index + 1).padStart(26, "0")}`,
      }));
    }
    expect(results.slice(0, 8).every(({ kind }) => kind === "allowed")).toBeTrue();
    expect(results[8]?.kind).toBe("limited");
    expect((await t.mutation(internal.rateLimits.consumeRefresh, {
      refreshTokenId: tokens[0]!,
      sessionId: scope.sessionId,
      requestId: "req_00000000000000000000000010",
    })).kind).toBe("limited");
    const buckets = await t.run(async (ctx) => await ctx.db
      .query("apiRateLimitBuckets")
      .collect());
    expect(buckets.filter(({ routeClass }) => routeClass === "refresh_auth")).toEqual([
      expect.objectContaining({
        subjectKind: "credential",
        subjectKey: scope.sessionId,
        count: 8,
      }),
    ]);
  });

  test("accepts only a recent password session for browser pairing decisions", async () => {
    const t = convexTest(schema, modules);
    const scope = await seedScope(t);
    const approved = await t.mutation(internal.desktopPairing.start, { challenge: secret(700) });
    expect(await scope.actor.query(api.desktopPairing.approvalContext, {
      pairingId: approved.pairingId,
    })).not.toBeNull();
    expect(await scope.actor.mutation(api.desktopPairing.approve, {
      pairingId: approved.pairingId,
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeTrue();

    const stale = await t.mutation(internal.desktopPairing.start, { challenge: secret(701) });
    await t.run(async (ctx) => {
      await ctx.db.patch(scope.passwordProofId, {
        authenticatedAt: Date.now() - PASSWORD_PAIRING_APPROVAL_WINDOW_MS - 1,
      });
    });
    expect(await scope.actor.query(api.desktopPairing.approvalContext, {
      pairingId: stale.pairingId,
    })).toBeNull();
    expect(await scope.actor.mutation(api.desktopPairing.approve, {
      pairingId: stale.pairingId,
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeFalse();
    expect(await scope.actor.mutation(api.desktopPairing.deny, {
      pairingId: stale.pairingId,
    })).toBeFalse();
    // Browser scope selection requires durable password-session provenance,
    // not the short recent-password window used for a pairing decision.
    expect(await scope.actor.mutation(api.desktopPairing.selectSession, {
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).not.toBeNull();

    const paired = await t.mutation(internal.desktopPairing.consumeApproved, {
      pairingId: approved.pairingId,
      expectedChallenge: secret(700),
    });
    expect(paired).not.toBeNull();
    if (paired === null) throw new Error("Missing paired session fixture.");
    const pairedActor = t.withIdentity({
      issuer: "https://convex.test",
      subject: `${paired.userId}|${paired.sessionId}`,
      tokenIdentifier: `https://convex.test|${paired.userId}|${paired.sessionId}`,
    });
    const pairedAttempt = await t.mutation(internal.desktopPairing.start, {
      challenge: secret(702),
    });
    expect(await pairedActor.query(api.desktopPairing.approvalContext, {
      pairingId: pairedAttempt.pairingId,
    })).toBeNull();
    expect(await pairedActor.mutation(api.desktopPairing.approve, {
      pairingId: pairedAttempt.pairingId,
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeFalse();
    expect(await pairedActor.mutation(api.desktopPairing.deny, {
      pairingId: pairedAttempt.pairingId,
    })).toBeFalse();
    expect(await pairedActor.mutation(api.desktopPairing.selectSession, {
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeNull();

    const rotation = await scope.actor.mutation(api.desktopPairing.prepareScopeRotation, {
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    });
    expect(rotation).not.toBeNull();
    if (rotation === null) throw new Error("Missing scope-rotation fixture.");
    const rotated = await t.mutation(internal.desktopPairing.consumeScopeRotation, {
      credential: rotation.credential,
    });
    expect(rotated).not.toBeNull();
    if (rotated === null) throw new Error("Missing rotated session fixture.");
    const rotatedActor = t.withIdentity({
      issuer: "https://convex.test",
      subject: `${rotated.userId}|${rotated.sessionId}`,
      tokenIdentifier: `https://convex.test|${rotated.userId}|${rotated.sessionId}`,
    });
    const rotatedAttempt = await t.mutation(internal.desktopPairing.start, {
      challenge: secret(703),
    });
    expect(await rotatedActor.query(api.desktopPairing.approvalContext, {
      pairingId: rotatedAttempt.pairingId,
    })).toBeNull();
    expect(await rotatedActor.mutation(api.desktopPairing.approve, {
      pairingId: rotatedAttempt.pairingId,
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeFalse();
    expect(await rotatedActor.mutation(api.desktopPairing.deny, {
      pairingId: rotatedAttempt.pairingId,
    })).toBeFalse();
    expect(await rotatedActor.mutation(api.desktopPairing.selectSession, {
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeNull();
  });

  test("returns and approves an exact authorized workspace beyond the first hundred", async () => {
    const t = convexTest(schema, modules);
    const scope = await seedScope(t);
    const targetPublicId = "wsp_00000000000000000000002101";
    const targetWorkspaceId = await t.run(async (ctx) => {
      let target = null;
      for (let index = 2_001; index <= 2_101; index += 1) {
        const publicId = `wsp_${String(index).padStart(26, "0")}`;
        const workspaceId = await ctx.db.insert("workspaces", {
          organizationId: scope.organizationId,
          publicId,
          slug: `pairing-${String(index)}`,
          name: `Pairing workspace ${String(index)}`,
          taskKeyPrefix: `P${String(index)}`,
          status: "active",
          createdAt: index,
          updatedAt: index,
        });
        if (publicId === targetPublicId) target = workspaceId;
      }
      return target;
    });
    expect(targetWorkspaceId).not.toBeNull();
    const started = await t.mutation(internal.desktopPairing.start, { challenge: secret(704) });
    const context = await scope.actor.query(api.desktopPairing.approvalContext, {
      pairingId: started.pairingId,
    });
    const organization = context?.organizations.find(({ organization }) =>
      organization.id === "org_00000000000000000000001001");
    expect(organization?.workspacesComplete).toBeTrue();
    expect(organization?.workspaces.length).toBe(102);
    expect(organization?.workspaces.some(({ id }) => id === targetPublicId)).toBeTrue();
    expect(await scope.actor.mutation(api.desktopPairing.approve, {
      pairingId: started.pairingId,
      organizationId: "org_00000000000000000000001001",
      workspaceId: targetPublicId,
    })).toBeTrue();
    const persisted = await t.run(async (ctx) => await ctx.db
      .query("desktopPairingRequests")
      .withIndex("by_pairing_id", (index) => index.eq("pairingId", started.pairingId))
      .unique());
    if (targetWorkspaceId === null) throw new Error("Missing late workspace fixture.");
    expect(persisted?.workspaceId).toBe(targetWorkspaceId);
  });

  test("requires a live browser session and rechecks pairing membership, expiry, and replay", async () => {
    const t = convexTest(schema, modules);
    const scope = await seedScope(t);
    const expiredSessionPairing = await t.mutation(internal.desktopPairing.start, {
      challenge: secret(2),
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(scope.sessionId, { expirationTime: Date.now() - 1 });
    });
    expect(await scope.actor.query(api.desktopPairing.approvalContext, {
      pairingId: expiredSessionPairing.pairingId,
    })).toBeNull();
    expect(await scope.actor.mutation(api.desktopPairing.approve, {
      pairingId: expiredSessionPairing.pairingId,
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeFalse();

    await t.run(async (ctx) => {
      const expirationTime = Date.now() + 60_000;
      await ctx.db.patch(scope.sessionId, { expirationTime });
      await ctx.db.patch(scope.passwordProofId, {
        authenticatedAt: Date.now(),
        expiresAt: expirationTime,
      });
    });
    const expiredRequest = await t.mutation(internal.desktopPairing.start, {
      challenge: secret(3),
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("desktopPairingRequests")
        .withIndex("by_pairing_id", (index) => index.eq("pairingId", expiredRequest.pairingId))
        .unique();
      if (row === null) throw new Error("Missing expiry fixture.");
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    expect(await scope.actor.mutation(api.desktopPairing.approve, {
      pairingId: expiredRequest.pairingId,
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeFalse();
    expect(await t.query(internal.desktopPairing.status, {
      pairingId: expiredRequest.pairingId,
    })).toMatchObject({ status: "expired" });

    const revoked = await t.mutation(internal.desktopPairing.start, { challenge: secret(4) });
    expect(await scope.actor.mutation(api.desktopPairing.approve, {
      pairingId: revoked.pairingId,
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeTrue();
    await t.run(async (ctx) => {
      await ctx.db.patch(scope.membershipId, { status: "removed" });
    });
    expect(await t.mutation(internal.desktopPairing.consumeApproved, {
      pairingId: revoked.pairingId,
      expectedChallenge: secret(4),
    })).toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.patch(scope.membershipId, { status: "active" });
    });
    const valid = await t.mutation(internal.desktopPairing.start, { challenge: secret(5) });
    expect(await scope.actor.mutation(api.desktopPairing.approve, {
      pairingId: valid.pairingId,
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    })).toBeTrue();
    const consumed = await t.mutation(internal.desktopPairing.consumeApproved, {
      pairingId: valid.pairingId,
      expectedChallenge: secret(5),
    });
    expect(consumed).not.toBeNull();
    expect(await t.mutation(internal.desktopPairing.consumeApproved, {
      pairingId: valid.pairingId,
      expectedChallenge: secret(5),
    })).toBeNull();
    if (consumed === null) throw new Error("Pairing did not create its exact session.");
    await t.run(async (ctx) => {
      await ctx.db.delete(scope.workspaceId);
    });
    expect(await t.query(internal.desktopPairing.authenticationForSession, {
      sessionId: consumed.sessionId,
    })).toBeNull();
  });

  test("rotates one exact session atomically and preserves unrelated sessions", async () => {
    const t = convexTest(schema, modules);
    const scope = await seedScope(t);
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const oldSelectionId = await ctx.db.insert("authSessionSelections", {
        sessionId: scope.sessionId,
        userId: scope.userId,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        createdAt: now,
        updatedAt: now,
      });
      const oldRefreshId = await ctx.db.insert("authRefreshTokens", {
        sessionId: scope.sessionId,
        expirationTime: now + 60_000,
      });
      const otherSessionId = await ctx.db.insert("authSessions", {
        userId: scope.userId,
        expirationTime: now + 60_000,
      });
      const otherSelectionId = await ctx.db.insert("authSessionSelections", {
        sessionId: otherSessionId,
        userId: scope.userId,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        createdAt: now,
        updatedAt: now,
      });
      return { oldRefreshId, oldSelectionId, otherSelectionId, otherSessionId };
    });
    const first = await scope.actor.mutation(api.desktopPairing.prepareScopeRotation, {
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    });
    const second = await scope.actor.mutation(api.desktopPairing.prepareScopeRotation, {
      organizationId: "org_00000000000000000000001001",
      workspaceId: "wsp_00000000000000000000001001",
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) throw new Error("Missing rotation fixture.");
    expect(await t.mutation(internal.desktopPairing.consumeScopeRotation, {
      credential: first.credential,
    })).toBeNull();
    const rotated = await t.mutation(internal.desktopPairing.consumeScopeRotation, {
      credential: second.credential,
    });
    expect(rotated).not.toBeNull();
    if (rotated === null) throw new Error("Rotation did not create a session.");
    const state = await t.run(async (ctx) => ({
      oldSession: await ctx.db.get(scope.sessionId),
      oldSelection: await ctx.db.get(seeded.oldSelectionId),
      oldRefresh: await ctx.db.get(seeded.oldRefreshId),
      oldPasswordProof: await ctx.db.get(scope.passwordProofId),
      otherSession: await ctx.db.get(seeded.otherSessionId),
      otherSelection: await ctx.db.get(seeded.otherSelectionId),
      rotatedSession: await ctx.db.get(rotated.sessionId),
      rotatedSelection: await ctx.db
        .query("authSessionSelections")
        .withIndex("by_session", (index) => index.eq("sessionId", rotated.sessionId))
        .unique(),
      rotatedPasswordProof: await ctx.db
        .query("passwordSessionProofs")
        .withIndex("by_session", (index) => index.eq("sessionId", rotated.sessionId))
        .unique(),
    }));
    expect(state).toMatchObject({
      oldSession: null,
      oldSelection: null,
      oldRefresh: null,
      oldPasswordProof: null,
      otherSession: { _id: seeded.otherSessionId },
      otherSelection: { _id: seeded.otherSelectionId },
      rotatedSession: { _id: rotated.sessionId, userId: scope.userId },
      rotatedPasswordProof: null,
      rotatedSelection: {
        sessionId: rotated.sessionId,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
      },
    });
    expect(await t.mutation(internal.desktopPairing.consumeScopeRotation, {
      credential: second.credential,
    })).toBeNull();
  });

  test("drains expired pairing, rotation, claim, and orphan-selection backlogs", async () => {
    const t = convexTest(schema, modules);
    const scope = await seedScope(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const orphanSessionId = await ctx.db.insert("authSessions", {
        userId: scope.userId,
        expirationTime: now - 1,
      });
      await ctx.db.insert("authSessionSelections", {
        sessionId: orphanSessionId,
        userId: scope.userId,
        organizationId: scope.organizationId,
        createdAt: now - 1,
        updatedAt: now - 1,
      });
      await ctx.db.delete(orphanSessionId);
      for (let index = 0; index < 129; index += 1) {
        await ctx.db.insert("desktopPairingRequests", {
          pairingId: `pair_${String(index).padStart(26, "0")}`,
          challenge: secret(index + 1),
          comparisonCode: "2345-6789",
          status: "expired",
          createdAt: 1,
          expiresAt: now - 25 * 60 * 60 * 1_000,
        });
        await ctx.db.insert("authSessionRotationRequests", {
          credentialDigest: `rotation-${String(index)}`,
          userId: scope.userId,
          oldSessionId: scope.sessionId,
          organizationId: scope.organizationId,
          createdAt: 1,
          expiresAt: now - 1,
        });
        await ctx.db.insert("passwordMigrationClaims", {
          claimProofDigest: `claim-${String(index)}`,
          userId: scope.userId,
          createdAt: 1,
          expiresAt: now - 1,
        });
        await ctx.db.insert("passwordSignUpReservations", {
          emailDigest: `expired-sign-up-${String(index)}`,
          createdAt: 1,
          expiresAt: now - 1,
        });
        const expiredProofSessionId = await ctx.db.insert("authSessions", {
          userId: scope.userId,
          expirationTime: now - 1,
        });
        await ctx.db.insert("passwordSessionProofs", {
          sessionId: expiredProofSessionId,
          userId: scope.userId,
          authenticatedAt: 1,
          expiresAt: now - 1,
        });
        await ctx.db.delete(expiredProofSessionId);
      }
    });
    expect(await t.mutation(internal.desktopPairing.retireExpired, {})).toMatchObject({
      hasMore: true,
    });
    expect(await t.mutation(internal.desktopPairing.retireExpired, {})).toMatchObject({
      hasMore: false,
    });
    expect(await t.run(async (ctx) => ({
      pairings: await ctx.db.query("desktopPairingRequests").collect(),
      rotations: await ctx.db.query("authSessionRotationRequests").collect(),
      claims: await ctx.db.query("passwordMigrationClaims").collect(),
      passwordProofs: await ctx.db.query("passwordSessionProofs").collect(),
      signUpReservations: await ctx.db.query("passwordSignUpReservations").collect(),
      selections: await ctx.db.query("authSessionSelections").collect(),
    }))).toEqual({
      pairings: [],
      rotations: [],
      claims: [],
      passwordProofs: [expect.objectContaining({ _id: scope.passwordProofId })],
      signUpReservations: [],
      selections: [],
    });
  });
});
