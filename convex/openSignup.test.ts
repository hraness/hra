import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";

import {
  authAttemptPolicies,
  newIdentityAdmissionWindowLimit,
  newIdentityAdmissionWindowMs,
  unverifiedLifetimeSendLimit,
} from "./authPolicy";
import {
  digestInviteCapability,
  generateInviteAuthority,
  minimumInviteLifetimeMs,
} from "./authInvites";
import { adjustParentAttributedQuotaForPatch } from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type Reservation = Readonly<{
  authEpoch: number;
  inviteBinding: "bound" | "not_required" | "replay";
}>;
type CreatedAccount = Readonly<{
  account: Readonly<{ _id: Id<"authAccounts"> }>;
  user: Readonly<{ _id: Id<"users"> }>;
}>;

const authModules = {
  ...modules,
  "./auth.ts": async () => await import("./auth"),
};

const quotaGenesis = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);
const status = makeFunctionReference<"query", Record<string, never>, unknown>(
  "admissionControl:status",
);
const transition = makeFunctionReference<
  "mutation",
  {
    expectedGeneration: number;
    mutationId: string;
    newIdentityAdmissions?: "invite_only" | "open";
    state: "frozen" | "open";
  },
  unknown
>("admissionControl:transition");
const recordIssue = makeFunctionReference<"mutation", Args, unknown>(
  "authInvites:recordIssue",
);
const inviteStatus = makeFunctionReference<"query", Args, unknown>("authInvites:status");
const reserve = makeFunctionReference<"mutation", Args, Reservation>(
  "authDelivery:reserveEmailAttempt",
);
const storeChallenge = makeFunctionReference<"mutation", Args, Id<"authOtpChallenges">>(
  "authDelivery:storeOtpChallenge",
);
const consume = makeFunctionReference<"mutation", Args, Id<"users">>(
  "authDelivery:consumeOtpChallenge",
);
const authStore = makeFunctionReference<"mutation", Args, CreatedAccount>("auth:store");

const openSignupId = "018bcfe5-6800-7000-8000-000000000911";
const closeSignupId = "018bcfe5-6800-7000-8000-000000000912";
const freezeId = "018bcfe5-6800-7000-8000-000000000913";
const rejected = "Authentication could not be completed.";
const emailA = "a".repeat(64);
const emailB = "b".repeat(64);
const codeA = "c".repeat(64);
const codeB = "d".repeat(64);
const hourMs = 60 * 60 * 1_000;

async function inviteOnlyRuntime() {
  const runtime = convexTest(schema, authModules);
  await runtime.mutation(quotaGenesis, {});
  return runtime;
}

type Runtime = Awaited<ReturnType<typeof inviteOnlyRuntime>>;

async function openRuntime() {
  const runtime = await inviteOnlyRuntime();
  await runtime.mutation(transition, {
    expectedGeneration: 0,
    mutationId: openSignupId,
    newIdentityAdmissions: "open",
    state: "open",
  });
  return runtime;
}

async function closeSignup(runtime: Runtime): Promise<void> {
  await runtime.mutation(transition, {
    expectedGeneration: 1,
    mutationId: closeSignupId,
    newIdentityAdmissions: "invite_only",
    state: "open",
  });
}

async function createAccount(runtime: Runtime, email: string): Promise<CreatedAccount> {
  return await runtime.mutation(authStore, {
    args: {
      account: { id: email },
      profile: { email },
      provider: "hra-control-plane-otp-v1",
      shouldLinkViaEmail: true,
      type: "createAccountFromCredentials",
    },
  });
}

async function signUpWithoutInvite(
  runtime: Runtime,
  input: Readonly<{ codeDigest: string; email: string; emailDigest: string }>,
) {
  const reservation = await runtime.mutation(reserve, {
    emailDigest: input.emailDigest,
    kind: "send",
  });
  const created = await createAccount(runtime, input.email);
  await runtime.mutation(storeChallenge, {
    accountId: created.account._id,
    authEpoch: reservation.authEpoch,
    codeDigest: input.codeDigest,
    emailDigest: input.emailDigest,
    expiresAt: Date.now() + 60_000,
    userId: created.user._id,
  });
  const userId = await runtime.mutation(consume, {
    authEpoch: reservation.authEpoch,
    codeDigest: input.codeDigest,
    emailDigest: input.emailDigest,
  });
  return { created, reservation, userId };
}

async function subjects(runtime: Runtime) {
  return await runtime.run(async (ctx) => await ctx.db.query("authSubjects").collect());
}

async function subjectFor(runtime: Runtime, emailDigest: string) {
  const matches = (await subjects(runtime))
    .filter((subject) => subject.emailDigest === emailDigest);
  expect(matches.length).toBeLessThan(2);
  return matches[0] ?? null;
}

async function controlRow(runtime: Runtime) {
  return await runtime.run(async (ctx) => await ctx.db.query("serviceControl").unique());
}

async function patchControl(
  runtime: Runtime,
  patch: Readonly<Record<string, unknown>>,
): Promise<void> {
  await runtime.run(async (ctx) => {
    const row = await ctx.db.query("serviceControl").unique();
    if (row === null) throw new Error("missing fixture authority");
    await ctx.db.patch(row._id, patch as never);
  });
}

async function seedAttempts(
  runtime: Runtime,
  input: Readonly<{ count: number; createdAt: number; emailDigest?: string }>,
): Promise<void> {
  await runtime.run(async (ctx) => {
    for (let index = 0; index < input.count; index += 1) {
      await ctx.db.insert("authEmailAttemptEvents", {
        authEpoch: 1,
        createdAt: input.createdAt,
        emailDigest: input.emailDigest
          ?? `${index.toString(16).padStart(4, "0")}${"e".repeat(60)}`,
        expiresAt: input.createdAt + authAttemptPolicies.send.retentionMs,
        kind: "send",
      });
    }
  });
}

describe("open sign-up admission", () => {
  test("invite-only is the default and refuses a first send without an invitation", async () => {
    const runtime = await inviteOnlyRuntime();
    expect(await runtime.query(status, {}))
      .toMatchObject({ newIdentityAdmissions: "invite_only" });
    await expect(runtime.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .rejects.toThrow(rejected);
    expect(await subjectFor(runtime, emailA)).toBeNull();
    expect((await controlRow(runtime))?.newIdentityWindowCount).toBeUndefined();
  });

  test("open admission creates the subject without an invite and verifies it", async () => {
    const runtime = await openRuntime();
    const { created, reservation, userId } = await signUpWithoutInvite(runtime, {
      codeDigest: codeA,
      email: "open@example.com",
      emailDigest: emailA,
    });
    expect(reservation).toEqual({ authEpoch: 1, inviteBinding: "not_required" });
    expect(userId).toBe(created.user._id);

    const subject = await subjectFor(runtime, emailA);
    expect(subject).toMatchObject({
      admittedBy: "open",
      authEpoch: 1,
      status: "active",
      userId: created.user._id,
    });
    expect(subject?.admissionInviteId).toBeUndefined();
    expect(subject?.verifiedAt).toBeNumber();
    expect(await runtime.run(async (ctx) =>
      (await ctx.db.query("authInvites").collect()).length)).toBe(0);
    expect(await runtime.run(async (ctx) =>
      (await ctx.db.query("storageUsageService").unique())?.identities)).toBe(1);
    expect(await controlRow(runtime)).toMatchObject({ newIdentityWindowCount: 1 });
  });

  test("frozen admission still refuses open sign-up before any row is written", async () => {
    const runtime = await openRuntime();
    await runtime.mutation(transition, {
      expectedGeneration: 1,
      mutationId: freezeId,
      state: "frozen",
    });
    await expect(runtime.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .rejects.toThrow("AUTH_ADMISSION_FROZEN");
    expect(await runtime.run(async (ctx) => ({
      attempts: (await ctx.db.query("authEmailAttemptEvents").collect()).length,
      subjects: (await ctx.db.query("authSubjects").collect()).length,
    }))).toEqual({ attempts: 0, subjects: 0 });
  });

  test("invitations still bind and consume while sign-up is open", async () => {
    const runtime = await openRuntime();
    const authority = await generateInviteAuthority("identity");
    const capabilityDigest = await digestInviteCapability(authority.capability, "identity");
    await runtime.mutation(recordIssue, {
      capabilityDigest,
      lifetimeMs: minimumInviteLifetimeMs,
      publicId: authority.publicId,
      purpose: "identity",
    });
    const reservation = await runtime.mutation(reserve, {
      emailDigest: emailB,
      inviteCapabilityDigest: capabilityDigest,
      kind: "send",
    });
    expect(reservation).toEqual({ authEpoch: 1, inviteBinding: "bound" });
    const invited = await subjectFor(runtime, emailB);
    expect(invited?.admissionInviteId).toBeDefined();
    expect(invited?.admittedBy).toBeUndefined();

    const created = await createAccount(runtime, "invited@example.com");
    await runtime.mutation(storeChallenge, {
      accountId: created.account._id,
      authEpoch: 1,
      codeDigest: codeB,
      emailDigest: emailB,
      expiresAt: Date.now() + 60_000,
      userId: created.user._id,
    });
    expect(await runtime.mutation(consume, {
      authEpoch: 1,
      codeDigest: codeB,
      emailDigest: emailB,
    })).toBe(created.user._id);
    expect(await runtime.query(inviteStatus, { publicId: authority.publicId }))
      .toMatchObject({ state: "consumed" });
  });

  test("only an open-admitted subject may proceed without an invitation", async () => {
    const runtime = await openRuntime();
    await runtime.mutation(reserve, { emailDigest: emailA, kind: "send" });
    const created = await createAccount(runtime, "legacy@example.com");
    const subject = await subjectFor(runtime, emailA);
    if (subject === null) throw new Error("missing fixture subject");
    await runtime.run(async (ctx) => {
      await ctx.db.patch(subject._id, { admittedBy: undefined });
    });
    await expect(runtime.mutation(storeChallenge, {
      accountId: created.account._id,
      authEpoch: 1,
      codeDigest: codeA,
      emailDigest: emailA,
      expiresAt: Date.now() + 60_000,
      userId: created.user._id,
    })).rejects.toThrow(rejected);
  });

  test("closing sign-up refuses new sends but honours an outstanding open admission", async () => {
    const runtime = await openRuntime();
    await runtime.mutation(reserve, { emailDigest: emailA, kind: "send" });
    await closeSignup(runtime);
    expect(await runtime.query(status, {}))
      .toMatchObject({ generation: 2, newIdentityAdmissions: "invite_only" });
    await expect(runtime.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .rejects.toThrow(rejected);
    await expect(runtime.mutation(reserve, { emailDigest: emailB, kind: "send" }))
      .rejects.toThrow(rejected);
    expect(await subjectFor(runtime, emailB)).toBeNull();

    const created = await createAccount(runtime, "outstanding@example.com");
    expect(await runtime.mutation(storeChallenge, {
      accountId: created.account._id,
      authEpoch: 1,
      codeDigest: codeA,
      emailDigest: emailA,
      expiresAt: Date.now() + 60_000,
      userId: created.user._id,
    })).toBeString();
  });

  test("one verified email owns exactly one identity", async () => {
    const runtime = await openRuntime();
    const { created } = await signUpWithoutInvite(runtime, {
      codeDigest: codeA,
      email: "single@example.com",
      emailDigest: emailA,
    });
    await runtime.mutation(reserve, { emailDigest: emailB, kind: "send" });
    await expect(runtime.mutation(storeChallenge, {
      accountId: created.account._id,
      authEpoch: 1,
      codeDigest: codeB,
      emailDigest: emailB,
      expiresAt: Date.now() + 60_000,
      userId: created.user._id,
    })).rejects.toThrow(rejected);
    expect((await subjects(runtime))
      .filter((subject) => subject.userId === created.user._id).length).toBe(1);
  });
});

describe("open sign-up abuse controls", () => {
  test("charges a lifetime send ceiling to an address that never verifies", async () => {
    const runtime = await openRuntime();
    await runtime.mutation(reserve, { emailDigest: emailA, kind: "send" });
    expect(await subjectFor(runtime, emailA))
      .toMatchObject({ unverifiedSendCount: 1 });

    const subject = await subjectFor(runtime, emailA);
    if (subject === null) throw new Error("missing fixture subject");
    await runtime.run(async (ctx) => {
      await ctx.db.patch(subject._id, {
        unverifiedSendCount: unverifiedLifetimeSendLimit - 1,
      });
      for (const attempt of await ctx.db.query("authEmailAttemptEvents").collect()) {
        await ctx.db.delete(attempt._id);
      }
    });
    await runtime.mutation(reserve, { emailDigest: emailA, kind: "send" });
    expect(await subjectFor(runtime, emailA))
      .toMatchObject({ unverifiedSendCount: unverifiedLifetimeSendLimit });
    await runtime.run(async (ctx) => {
      for (const attempt of await ctx.db.query("authEmailAttemptEvents").collect()) {
        await ctx.db.delete(attempt._id);
      }
    });
    await expect(runtime.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .rejects.toThrow(rejected);
  });

  test("a verified address is not charged against the unverified lifetime ceiling", async () => {
    const runtime = await openRuntime();
    await signUpWithoutInvite(runtime, {
      codeDigest: codeA,
      email: "verified@example.com",
      emailDigest: emailA,
    });
    await runtime.run(async (ctx) => {
      for (const attempt of await ctx.db.query("authEmailAttemptEvents").collect()) {
        await ctx.db.delete(attempt._id);
      }
    });
    await runtime.mutation(reserve, { emailDigest: emailA, kind: "send" });
    expect(await subjectFor(runtime, emailA))
      .toMatchObject({ unverifiedSendCount: 1 });
  });

  test("a backfilled verification releases the unverified lifetime ceiling", async () => {
    const runtime = await openRuntime();
    await runtime.mutation(reserve, { emailDigest: emailA, kind: "send" });
    const created = await createAccount(runtime, "backfill@example.com");
    await runtime.mutation(storeChallenge, {
      accountId: created.account._id,
      authEpoch: 1,
      codeDigest: codeA,
      emailDigest: emailA,
      expiresAt: Date.now() + 60_000,
      userId: created.user._id,
    });
    // The user is verified, but the subject row has not mirrored the timestamp
    // yet. The reservation backfills it and must not charge the ceiling.
    await runtime.run(async (ctx) => {
      const user = await ctx.db.get(created.user._id);
      if (user === null) throw new Error("missing fixture user");
      const patch = { emailVerificationTime: Date.now() };
      await adjustParentAttributedQuotaForPatch(
        ctx,
        created.user._id,
        "identity",
        user,
        patch,
      );
      await ctx.db.patch(user._id, patch);
      for (const subject of await ctx.db.query("authSubjects").collect()) {
        await ctx.db.patch(subject._id, {
          unverifiedSendCount: unverifiedLifetimeSendLimit,
        });
      }
      for (const attempt of await ctx.db.query("authEmailAttemptEvents").collect()) {
        await ctx.db.delete(attempt._id);
      }
    });
    expect(await runtime.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .toEqual({ authEpoch: 1, inviteBinding: "not_required" });
    expect(await subjectFor(runtime, emailA)).toMatchObject({
      unverifiedSendCount: unverifiedLifetimeSendLimit,
      verifiedAt: expect.any(Number) as unknown as number,
    });
  });

  test("bounds sends per address in both the short and the daily window", async () => {
    const short = await openRuntime();
    for (let index = 0; index < authAttemptPolicies.send.perEmail[0].limit; index += 1) {
      await short.mutation(reserve, { emailDigest: emailA, kind: "send" });
    }
    await expect(short.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .rejects.toThrow(rejected);

    const daily = await openRuntime();
    await daily.mutation(reserve, { emailDigest: emailA, kind: "send" });
    const [shortWindow, dailyWindow] = authAttemptPolicies.send.perEmail;
    await daily.run(async (ctx) => {
      for (const attempt of await ctx.db.query("authEmailAttemptEvents").collect()) {
        await ctx.db.patch(attempt._id, {
          createdAt: Date.now() - shortWindow.windowMs - 1,
        });
      }
    });
    await seedAttempts(daily, {
      count: dailyWindow.limit - 1,
      createdAt: Date.now() - shortWindow.windowMs - 1,
      emailDigest: emailA,
    });
    await expect(daily.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .rejects.toThrow(rejected);
  });

  test("bounds sends service-wide per hour and per day", async () => {
    const hourly = await openRuntime();
    await seedAttempts(hourly, {
      count: authAttemptPolicies.send.global[0].limit,
      createdAt: Date.now(),
    });
    await expect(hourly.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .rejects.toThrow(rejected);
    // The refusal rolls back the whole reservation, so a service-wide burst
    // never leaves a half-admitted identity behind.
    expect(await subjectFor(hourly, emailA)).toBeNull();
    expect((await controlRow(hourly))?.newIdentityWindowCount).toBeUndefined();

    const daily = await openRuntime();
    await seedAttempts(daily, {
      count: authAttemptPolicies.send.global[1].limit,
      createdAt: Date.now() - 2 * hourMs,
    });
    await expect(daily.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .rejects.toThrow(rejected);
  });

  test("bounds newly admitted identities per rolling day and rolls the window over", async () => {
    const runtime = await openRuntime();
    const now = Date.now();
    await patchControl(runtime, {
      newIdentityWindowCount: newIdentityAdmissionWindowLimit,
      newIdentityWindowStartedAt: now,
    });
    await expect(runtime.mutation(reserve, { emailDigest: emailA, kind: "send" }))
      .rejects.toThrow("AUTH_NEW_IDENTITY_ADMISSION_LIMIT");
    expect(await subjectFor(runtime, emailA)).toBeNull();

    await patchControl(runtime, {
      newIdentityWindowStartedAt: now - newIdentityAdmissionWindowMs - 1,
    });
    await runtime.mutation(reserve, { emailDigest: emailA, kind: "send" });
    expect(await subjectFor(runtime, emailA)).not.toBeNull();
    expect(await controlRow(runtime)).toMatchObject({ newIdentityWindowCount: 1 });

    // A later send by an already admitted identity charges nothing.
    await runtime.mutation(reserve, { emailDigest: emailA, kind: "send" });
    expect(await controlRow(runtime)).toMatchObject({ newIdentityWindowCount: 1 });
  });

  test("counts an invited admission against the same daily identity window", async () => {
    const runtime = await openRuntime();
    const authority = await generateInviteAuthority("identity");
    const capabilityDigest = await digestInviteCapability(authority.capability, "identity");
    await runtime.mutation(recordIssue, {
      capabilityDigest,
      lifetimeMs: minimumInviteLifetimeMs,
      publicId: authority.publicId,
      purpose: "identity",
    });
    await patchControl(runtime, {
      newIdentityWindowCount: newIdentityAdmissionWindowLimit,
      newIdentityWindowStartedAt: Date.now(),
    });
    await expect(runtime.mutation(reserve, {
      emailDigest: emailB,
      inviteCapabilityDigest: capabilityDigest,
      kind: "send",
    })).rejects.toThrow("AUTH_NEW_IDENTITY_ADMISSION_LIMIT");
    expect(await subjectFor(runtime, emailB)).toBeNull();
  });
});
