import { beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import { invitePublicIdFromCapabilityDigest } from "../src/cloud/inviteAuthority";

import schema from "./schema";
import { modules } from "./test.setup";

const genesis = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);
const status = makeFunctionReference<"query", Record<string, never>, unknown>(
  "admissionControl:status",
);
const transition = makeFunctionReference<
  "mutation",
  { expectedGeneration: number; mutationId: string; state: "frozen" | "open" },
  unknown
>("admissionControl:transition");
const recordInvite = makeFunctionReference<
  "mutation",
  {
    capabilityDigest: string;
    lifetimeMs: number;
    publicId: string;
    purpose: "identity";
  },
  unknown
>("authInvites:recordIssue");
const reserveEmail = makeFunctionReference<
  "mutation",
  { emailDigest: string; kind: "send" },
  unknown
>("authDelivery:reserveEmailAttempt");

const freezeId = "018bcfe5-6800-7000-8000-000000000901";
const resumeId = "018bcfe5-6800-7000-8000-000000000902";
const digest = "a".repeat(64);

describe("hosted authentication admission control", () => {
  let runtime: ReturnType<typeof convexTest>;

  beforeEach(async () => {
    runtime = convexTest(schema, modules);
    await runtime.mutation(genesis, {});
  });

  test("genesis creates one open generation-zero authority", async () => {
    expect(await runtime.query(status, {})).toMatchObject({
      generation: 0,
      state: "open",
    });
    expect(await runtime.run(async (ctx) => {
      const rows = await ctx.db.query("serviceControl").collect() as unknown as readonly unknown[];
      return rows.length;
    })).toBe(1);
  });

  test("freeze is generation-fenced, exactly replayable, and resumable", async () => {
    const frozen = await runtime.mutation(transition, {
      expectedGeneration: 0,
      mutationId: freezeId,
      state: "frozen",
    });
    expect(frozen).toMatchObject({ changed: true, generation: 1, replay: false, state: "frozen" });
    expect(await runtime.mutation(transition, {
      expectedGeneration: 0,
      mutationId: freezeId,
      state: "frozen",
    })).toMatchObject({ changed: true, generation: 1, replay: true, state: "frozen" });
    await expect(runtime.mutation(transition, {
      expectedGeneration: 0,
      mutationId: resumeId,
      state: "open",
    })).rejects.toThrow("AUTH_ADMISSION_AUTHORITY_STALE");
    expect(await runtime.mutation(transition, {
      expectedGeneration: 1,
      mutationId: resumeId,
      state: "open",
    })).toMatchObject({ changed: true, generation: 2, replay: false, state: "open" });
    await expect(runtime.mutation(transition, {
      expectedGeneration: 2,
      mutationId: "018bcfe5-6800-7000-8000-000000000904",
      state: "open",
    })).rejects.toThrow("AUTH_ADMISSION_AUTHORITY_STALE");
  });

  test("concurrent transitions from one generation admit at most one winner", async () => {
    const results = await Promise.allSettled([
      runtime.mutation(transition, {
        expectedGeneration: 0,
        mutationId: freezeId,
        state: "frozen",
      }),
      runtime.mutation(transition, {
        expectedGeneration: 0,
        mutationId: resumeId,
        state: "frozen",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await runtime.query(status, {})).toMatchObject({ generation: 1, state: "frozen" });
  });

  test("freeze blocks invite and OTP admission without deleting recovery state", async () => {
    await runtime.mutation(transition, {
      expectedGeneration: 0,
      mutationId: freezeId,
      state: "frozen",
    });
    await expect(runtime.mutation(recordInvite, {
      capabilityDigest: digest,
      lifetimeMs: 24 * 60 * 60 * 1_000,
      publicId: invitePublicIdFromCapabilityDigest(digest),
      purpose: "identity",
    })).rejects.toThrow("AUTH_ADMISSION_FROZEN");
    await expect(runtime.mutation(reserveEmail, {
      emailDigest: digest,
      kind: "send",
    })).rejects.toThrow("AUTH_ADMISSION_FROZEN");
    expect(await runtime.run(async (ctx) => ({
      attempts: await ctx.db.query("authEmailAttemptEvents").collect(),
      invites: await ctx.db.query("authInvites").collect(),
    }))).toEqual({ attempts: [], invites: [] });
  });

  test("missing, duplicate, or corrupt control authority fails closed", async () => {
    await runtime.run(async (ctx) => {
      const row = await ctx.db.query("serviceControl").unique() as unknown as
        | Readonly<{ _id: string }>
        | null;
      if (row === null) throw new Error("missing fixture authority");
      await ctx.db.delete(row._id as never);
    });
    await expect(runtime.query(status, {}))
      .rejects.toThrow("AUTH_ADMISSION_AUTHORITY_CORRUPT");

    const corrupt = convexTest(schema, modules);
    await corrupt.mutation(genesis, {});
    await corrupt.run(async (ctx) => {
      const row = await ctx.db.query("serviceControl").unique() as unknown as
        | Readonly<{ _id: string }>
        | null;
      if (row === null) throw new Error("missing fixture authority");
      await ctx.db.patch(row._id as never, { authAdmissionGeneration: -1 });
    });
    await expect(corrupt.query(status, {}))
      .rejects.toThrow("AUTH_ADMISSION_AUTHORITY_CORRUPT");

    const duplicate = convexTest(schema, modules);
    await duplicate.mutation(genesis, {});
    await duplicate.run(async (ctx) => {
      await ctx.db.insert("serviceControl", {
        authAdmissionGeneration: 0,
        authAdmissions: "open",
        key: "global",
        updatedAt: Date.now(),
      });
    });
    await expect(duplicate.query(status, {}))
      .rejects.toThrow("AUTH_ADMISSION_AUTHORITY_CORRUPT");
  });
});
