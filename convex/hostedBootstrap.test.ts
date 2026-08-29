import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";
import { convexTest } from "convex-test";

import {
  digestInviteCapability,
  generateInviteAuthority,
  identityInviteLifetimeMs,
  invitePublicIdFromCapabilityDigest,
} from "../src/cloud/inviteAuthority";

import {
  consumeBoundIdentityInvite,
  minimumInviteLifetimeMs,
} from "./authInvites";
import {
  adjustServiceQuotaForPatch,
  logicalDocumentBytes,
  releaseServiceQuotaForDelete,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type HostedGenesisResult = Readonly<{
  enforcement: "hard";
  invite: Readonly<{
    expiresAt: number;
    publicId: string;
    purpose: "identity";
    state: "issued";
  }>;
  replay: boolean;
}>;
type HostedBootstrapStatus = Readonly<{
  occupiedTableCount: number;
  serviceControlCount: 0 | 1 | 2;
  state: "inconsistent" | "ready" | "uninitialized";
}>;

const hostedGenesis = makeFunctionReference<"mutation", Args, HostedGenesisResult>(
  "quota:genesisHostedAuthority",
);
const genericGenesis = makeFunctionReference<"mutation", Args, unknown>(
  "quota:genesisHardAuthority",
);
const hostedBootstrapStatus = makeFunctionReference<"query", Args, HostedBootstrapStatus>(
  "quota:hostedBootstrapStatus",
);
const recordIssue = makeFunctionReference<"mutation", Args, unknown>(
  "authInvites:recordIssue",
);
const admissionStatus = makeFunctionReference<"query", Args, unknown>(
  "admissionControl:status",
);

const prepare = async () => {
  const authority = await generateInviteAuthority("identity");
  return {
    ...authority,
    capabilityDigest: await digestInviteCapability(authority.capability, "identity"),
  };
};

const genesisArguments = (authority: Awaited<ReturnType<typeof prepare>>) => ({
  capabilityDigest: authority.capabilityDigest,
  lifetimeMs: identityInviteLifetimeMs,
  publicId: authority.publicId,
});

describe("atomic hosted authority bootstrap", () => {
  test("reports only the exact active first hosted-bootstrap frame as ready", async () => {
    const empty = convexTest(schema, modules);
    expect(await empty.query(hostedBootstrapStatus, {})).toEqual({
      occupiedTableCount: 0,
      serviceControlCount: 0,
      state: "uninitialized",
    });

    const runtime = convexTest(schema, modules);
    const authority = await prepare();
    await runtime.mutation(hostedGenesis, genesisArguments(authority));
    expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
      occupiedTableCount: 3,
      serviceControlCount: 1,
      state: "ready",
    });
  });

  test("does not report a generic hard authority plus a plausible invite as hosted-ready", async () => {
    const runtime = convexTest(schema, modules);
    const authority = await prepare();
    await runtime.mutation(genericGenesis, {});
    await runtime.run(async (ctx) => {
      const now = Date.now();
      const inviteId = await ctx.db.insert("authInvites", {
        admissionExpiresAt: now + identityInviteLifetimeMs,
        capabilityDigest: authority.capabilityDigest,
        createdAt: now,
        expiresAt: now + identityInviteLifetimeMs,
        publicId: authority.publicId,
        purpose: "identity",
        requestedLifetimeMs: identityInviteLifetimeMs,
        state: "issued",
        updatedAt: now,
      });
      const [invite, quota] = await Promise.all([
        ctx.db.get(inviteId),
        ctx.db.query("storageUsageService").unique(),
      ]);
      if (invite === null || quota === null) throw new Error("missing generic bootstrap fixture");
      const bytes = logicalDocumentBytes(invite);
      await ctx.db.patch(quota._id, {
        logicalBytes: bytes,
        records: 1,
        serviceLogicalBytes: bytes,
        serviceRecords: 1,
        updatedAt: now,
      });
    });

    expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
      occupiedTableCount: 3,
      serviceControlCount: 1,
      state: "inconsistent",
    });
  });

  test("treats mismatched bootstrap binding and quota byte drift as inconsistent", async () => {
    const runtime = convexTest(schema, modules);
    const authority = await prepare();
    const other = await prepare();
    await runtime.mutation(hostedGenesis, genesisArguments(authority));
    await runtime.run(async (ctx) => {
      const control = await ctx.db.query("serviceControl").unique();
      if (control === null) throw new Error("missing hosted bootstrap control");
      await ctx.db.patch(control._id, {
        bootstrapInviteCapabilityDigest: other.capabilityDigest,
        bootstrapInvitePublicId: other.publicId,
      });
    });
    expect(await runtime.query(hostedBootstrapStatus, {})).toMatchObject({
      occupiedTableCount: 3,
      state: "inconsistent",
    });

    await runtime.run(async (ctx) => {
      const quota = await ctx.db.query("storageUsageService").unique();
      if (quota === null) throw new Error("missing hosted bootstrap quota");
      await ctx.db.patch(quota._id, {
        logicalBytes: quota.logicalBytes + 1,
      });
    });
    expect(await runtime.query(hostedBootstrapStatus, {})).toMatchObject({
      occupiedTableCount: 3,
      state: "inconsistent",
    });
  });

  test("treats an expired issued bootstrap invite as inconsistent", async () => {
    const runtime = convexTest(schema, modules);
    const authority = await prepare();
    await runtime.mutation(hostedGenesis, genesisArguments(authority));
    await runtime.run(async (ctx) => {
      const [control, invite] = await Promise.all([
        ctx.db.query("serviceControl").unique(),
        ctx.db.query("authInvites").unique(),
      ]);
      if (control === null || invite === null) throw new Error("missing hosted bootstrap fixture");
      const createdAt = Date.now() - identityInviteLifetimeMs - 10_000;
      const expiresAt = createdAt + identityInviteLifetimeMs;
      await Promise.all([
        ctx.db.patch(control._id, {
          bootstrapCompletedAt: createdAt,
          updatedAt: createdAt,
        }),
        ctx.db.patch(invite._id, {
          admissionExpiresAt: expiresAt,
          createdAt,
          expiresAt,
          updatedAt: createdAt,
        }),
      ]);
    });
    expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
      occupiedTableCount: 3,
      serviceControlCount: 1,
      state: "inconsistent",
    });
  });

  test("creates one quota authority, bootstrap binding, and charged first invite", async () => {
    const runtime = convexTest(schema, modules);
    const authority = await prepare();
    const result = await runtime.mutation(hostedGenesis, genesisArguments(authority));
    expect(result).toMatchObject({
      enforcement: "hard",
      invite: { publicId: authority.publicId, purpose: "identity", state: "issued" },
      replay: false,
    });

    const rows = await runtime.run(async (ctx) => ({
      control: await ctx.db.query("serviceControl").collect(),
      invites: await ctx.db.query("authInvites").collect(),
      quota: await ctx.db.query("storageUsageService").collect(),
    }));
    expect(rows.control).toHaveLength(1);
    expect(rows.invites).toHaveLength(1);
    expect(rows.quota).toHaveLength(1);
    expect(rows.control[0]).toMatchObject({
      authAdmissionGeneration: 0,
      authAdmissions: "open",
      bootstrapInviteCapabilityDigest: authority.capabilityDigest,
      bootstrapInviteLifetimeMs: identityInviteLifetimeMs,
      bootstrapInvitePublicId: authority.publicId,
    });
    expect(rows.control[0]?.bootstrapAcceptedAt).toBeUndefined();
    const invite = rows.invites[0];
    if (invite === undefined) throw new Error("missing bootstrap invite");
    const inviteBytes = logicalDocumentBytes(invite);
    expect(rows.quota[0]).toMatchObject({
      enforcement: "hard",
      identities: 0,
      logicalBytes: inviteBytes,
      records: 1,
      serviceLogicalBytes: inviteBytes,
      serviceRecords: 1,
      userLogicalBytes: 0,
      userRecords: 0,
    });
  });

  test("replays only the exact request without adding rows or quota", async () => {
    const runtime = convexTest(schema, modules);
    const authority = await prepare();
    const first = await runtime.mutation(hostedGenesis, genesisArguments(authority));
    expect(await runtime.mutation(hostedGenesis, genesisArguments(authority)))
      .toEqual({ ...first, replay: true });
    expect(await runtime.run(async (ctx) => ({
      controls: (await ctx.db.query("serviceControl").collect()).length,
      invites: (await ctx.db.query("authInvites").collect()).length,
      quota: await ctx.db.query("storageUsageService").unique(),
    }))).toMatchObject({
      controls: 1,
      invites: 1,
      quota: { records: 1, serviceRecords: 1 },
    });
  });

  test("serializes different prepared requests to exactly one winner", async () => {
    const runtime = convexTest(schema, modules);
    const first = await prepare();
    const second = await prepare();
    const results = await Promise.allSettled([
      runtime.mutation(hostedGenesis, genesisArguments(first)),
      runtime.mutation(hostedGenesis, genesisArguments(second)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("missing winner");
    const rows = await runtime.run(async (ctx) => ({
      control: await ctx.db.query("serviceControl").unique(),
      invites: await ctx.db.query("authInvites").collect(),
      quota: await ctx.db.query("storageUsageService").unique(),
    }));
    expect(rows.invites).toHaveLength(1);
    expect(rows.invites[0]?.publicId).toBe(winner.value.invite.publicId);
    expect(rows.control?.bootstrapInvitePublicId).toBe(winner.value.invite.publicId);
    expect(rows.quota).toMatchObject({ records: 1, serviceRecords: 1 });
  });

  test("refuses invalid mapping and partial binding without creating a second authority", async () => {
    const empty = convexTest(schema, modules);
    const authority = await prepare();
    await expect(empty.mutation(hostedGenesis, {
      ...genesisArguments(authority),
      publicId: invitePublicIdFromCapabilityDigest("f".repeat(64)),
    })).rejects.toThrow("HOSTED_BOOTSTRAP_AUTHORITY_REFUSED");
    expect(await empty.run(async (ctx) => ({
      controls: (await ctx.db.query("serviceControl").collect()).length,
      invites: (await ctx.db.query("authInvites").collect()).length,
      quota: (await ctx.db.query("storageUsageService").collect()).length,
    }))).toEqual({ controls: 0, invites: 0, quota: 0 });

    const corrupt = convexTest(schema, modules);
    await corrupt.mutation(hostedGenesis, genesisArguments(authority));
    await corrupt.run(async (ctx) => {
      const control = await ctx.db.query("serviceControl").unique();
      if (control === null) throw new Error("missing control");
      await ctx.db.patch(control._id, { bootstrapInviteCapabilityDigest: undefined });
    });
    await expect(corrupt.query(admissionStatus, {}))
      .rejects.toThrow("AUTH_ADMISSION_AUTHORITY_CORRUPT");
    await expect(corrupt.mutation(hostedGenesis, genesisArguments(authority)))
      .rejects.toThrow("HOSTED_BOOTSTRAP_AUTHORITY_REFUSED");
  });

  test("durably unlocks friend issuance after bootstrap acceptance and receipt cleanup", async () => {
    const runtime = convexTest(schema, modules);
    const bootstrap = await prepare();
    const friend = await prepare();
    await runtime.mutation(hostedGenesis, genesisArguments(bootstrap));

    await expect(runtime.mutation(recordIssue, {
      capabilityDigest: friend.capabilityDigest,
      lifetimeMs: minimumInviteLifetimeMs,
      publicId: friend.publicId,
      purpose: "identity",
    })).rejects.toThrow("Invite operation could not be completed.");

    const emailDigest = "e".repeat(64);
    await runtime.run(async (ctx) => {
      const invite = await ctx.db.query("authInvites")
        .withIndex("by_public_id", (query) => query.eq("publicId", bootstrap.publicId))
        .unique();
      if (invite === null) throw new Error("missing bootstrap invite");
      const now = Date.now();
      const boundPatch = {
        boundAt: now,
        boundEmailDigest: emailDigest,
        state: "bound_to_email" as const,
        updatedAt: now,
      };
      await adjustServiceQuotaForPatch(ctx, invite, boundPatch);
      await ctx.db.patch(invite._id, boundPatch);
      await consumeBoundIdentityInvite(ctx, {
        emailDigest,
        inviteId: invite._id as Id<"authInvites">,
      });
      const consumed = await ctx.db.get(invite._id);
      if (consumed === null) throw new Error("missing consumed bootstrap invite");
      await releaseServiceQuotaForDelete(ctx, consumed);
      await ctx.db.delete(consumed._id);
    });

    const control = await runtime.run(async (ctx) =>
      await ctx.db.query("serviceControl").unique());
    expect(control?.bootstrapAcceptedAt).toBeNumber();
    expect(await runtime.mutation(recordIssue, {
      capabilityDigest: friend.capabilityDigest,
      lifetimeMs: minimumInviteLifetimeMs,
      publicId: friend.publicId,
      purpose: "identity",
    })).toMatchObject({ publicId: friend.publicId, replay: false, state: "issued" });
    expect(await runtime.run(async (ctx) =>
      (await ctx.db.query("authInvites").collect()).map((invite) => invite.publicId)))
      .toEqual([friend.publicId]);
  });
});
