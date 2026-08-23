import { v, type GenericId as Id } from "convex/values";

import {
  invitePublicIdFromCapabilityDigest,
  isInvitePublicId,
  type InvitePurpose,
} from "../src/cloud/inviteAuthority";
import { authOtpLifetimeMs, isAuthDigest } from "./authPolicy";
import {
  recordBootstrapInviteAccepted,
  requireAuthAdmissionsOpen,
} from "./admissionControl";
import {
  adjustServiceQuotaForPatch,
  reserveServiceQuotaForInsert,
} from "./quota";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./server";
import { invitePurpose } from "./validators";

export {
  digestInviteCapability,
  generateInviteAuthority,
  invitePublicIdFromCapabilityDigest,
  invitePublicIdPrefix,
  isInviteCapability,
  isInvitePublicId,
} from "../src/cloud/inviteAuthority";
export type { InvitePurpose } from "../src/cloud/inviteAuthority";

export const minimumInviteLifetimeMs = authOtpLifetimeMs + 60_000;
export const maximumInviteLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
export const terminalInviteReceiptLifetimeMs = 24 * 60 * 60 * 1_000;
const authenticationRejectedMessage = "Authentication could not be completed.";

function rejectAuthentication(): never {
  throw new Error(authenticationRejectedMessage);
}

function rejectInviteTool(): never {
  throw new Error("Invite operation could not be completed.");
}

function isSafeLifetime(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= minimumInviteLifetimeMs
    && value <= maximumInviteLifetimeMs;
}

function admissionExpiry(invite: Readonly<{
  admissionExpiresAt?: number;
  expiresAt: number;
}>): number {
  return invite.admissionExpiresAt ?? invite.expiresAt;
}

type IssueRecord = Readonly<{
  expiresAt: number;
  publicId: string;
  purpose: InvitePurpose;
  replay: boolean;
  state: "issued";
}>;

export const recordIssue = internalMutation({
  args: {
    capabilityDigest: v.string(),
    issuedByUserId: v.optional(v.id("users")),
    lifetimeMs: v.number(),
    publicId: v.string(),
    purpose: invitePurpose,
  },
  handler: async (ctx, args): Promise<IssueRecord> => {
    if (
      !isAuthDigest(args.capabilityDigest)
      || !isInvitePublicId(args.publicId)
      || invitePublicIdFromCapabilityDigest(args.capabilityDigest) !== args.publicId
      || !isSafeLifetime(args.lifetimeMs)
    ) rejectInviteTool();
    const control = await requireAuthAdmissionsOpen(ctx);
    if (
      args.issuedByUserId !== undefined
      && await ctx.db.get(args.issuedByUserId) === null
    ) rejectInviteTool();

    const [byPublicId, byCapability] = await Promise.all([
      ctx.db.query("authInvites")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.publicId))
        .take(2),
      ctx.db.query("authInvites")
        .withIndex("by_capability_digest", (query) =>
          query.eq("capabilityDigest", args.capabilityDigest))
        .take(2),
    ]);
    if (byPublicId.length > 1 || byCapability.length > 1) rejectInviteTool();
    const existing = byPublicId[0] ?? byCapability[0];
    if (existing !== undefined) {
      if (
        byPublicId[0]?._id !== existing._id
        || byCapability[0]?._id !== existing._id
        || existing.publicId !== args.publicId
        || existing.capabilityDigest !== args.capabilityDigest
        || existing.purpose !== args.purpose
        || existing.state !== "issued"
        || existing.issuedByUserId !== args.issuedByUserId
        || (
          existing.requestedLifetimeMs
            ?? admissionExpiry(existing) - existing.createdAt
        ) !== args.lifetimeMs
      ) rejectInviteTool();
      await adjustServiceQuotaForPatch(ctx, existing, {});
      return {
        expiresAt: admissionExpiry(existing),
        publicId: existing.publicId,
        purpose: existing.purpose,
        replay: true,
        state: existing.state,
      };
    }

    if (
      control.bootstrapInvitePublicId !== undefined
      && control.bootstrapAcceptedAt === undefined
    ) {
      rejectInviteTool();
    }

    const now = Date.now();
    const expiresAt = now + args.lifetimeMs;
    const inviteId = await ctx.db.insert("authInvites", {
      admissionExpiresAt: expiresAt,
      capabilityDigest: args.capabilityDigest,
      createdAt: now,
      expiresAt,
      ...(args.issuedByUserId === undefined
        ? {}
        : { issuedByUserId: args.issuedByUserId }),
      publicId: args.publicId,
      purpose: args.purpose,
      requestedLifetimeMs: args.lifetimeMs,
      state: "issued",
      updatedAt: now,
    });
    const invite = await ctx.db.get(inviteId);
    if (invite === null) rejectInviteTool();
    await reserveServiceQuotaForInsert(ctx, invite);
    return {
      expiresAt,
      publicId: args.publicId,
      purpose: args.purpose,
      replay: false,
      state: "issued",
    };
  },
});

function publicStatus(invite: Readonly<{
  admissionExpiresAt?: number;
  boundEmailDigest?: string;
  consumedAt?: number;
  createdAt: number;
  expiresAt: number;
  publicId: string;
  purpose: InvitePurpose;
  state: "bound_to_email" | "consumed" | "issued" | "revoked";
  updatedAt: number;
}>) {
  const expiresAt = admissionExpiry(invite);
  return {
    bound: invite.boundEmailDigest !== undefined,
    consumedAt: invite.consumedAt ?? null,
    createdAt: invite.createdAt,
    expired: expiresAt <= Date.now(),
    expiresAt,
    publicId: invite.publicId,
    purpose: invite.purpose,
    state: invite.state,
    updatedAt: invite.updatedAt,
  };
}

export const status = internalQuery({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    if (!isInvitePublicId(args.publicId)) rejectInviteTool();
    const matches = await ctx.db.query("authInvites")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.publicId))
      .take(2);
    if (matches.length > 1) rejectInviteTool();
    return matches[0] === undefined ? null : publicStatus(matches[0]);
  },
});

export const revoke = internalMutation({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    if (!isInvitePublicId(args.publicId)) rejectInviteTool();
    const matches = await ctx.db.query("authInvites")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.publicId))
      .take(2);
    if (matches.length > 1) rejectInviteTool();
    const invite = matches[0];
    if (invite === undefined) return null;
    if (invite.state === "revoked" || invite.state === "consumed") {
      await adjustServiceQuotaForPatch(ctx, invite, {});
      return { ...publicStatus(invite), replay: true };
    }
    const now = Date.now();
    const patch = {
      expiresAt: Math.max(invite.expiresAt, now + terminalInviteReceiptLifetimeMs),
      revokedAt: now,
      state: "revoked" as const,
      updatedAt: now,
    };
    await adjustServiceQuotaForPatch(ctx, invite, patch);
    await ctx.db.patch(invite._id, patch);
    return { ...publicStatus({ ...invite, ...patch }), replay: false };
  },
});

export async function bindIdentityInviteToEmail(
  ctx: MutationCtx,
  input: Readonly<{
    capabilityDigest: string;
    emailDigest: string;
    expectedInviteId?: Id<"authInvites">;
  }>,
): Promise<Readonly<{ inviteId: Id<"authInvites">; replay: boolean }>> {
  if (!isAuthDigest(input.capabilityDigest) || !isAuthDigest(input.emailDigest)) {
    rejectAuthentication();
  }
  const matches = await ctx.db.query("authInvites")
    .withIndex("by_capability_digest", (query) =>
      query.eq("capabilityDigest", input.capabilityDigest))
    .take(2);
  if (matches.length !== 1) rejectAuthentication();
  const invite = matches[0];
  if (
    invite === undefined
    || invite.purpose !== "identity"
    || admissionExpiry(invite) <= Date.now()
    || (
      input.expectedInviteId !== undefined
      && invite._id !== input.expectedInviteId
    )
  ) rejectAuthentication();

  if (invite.state === "bound_to_email") {
    if (invite.boundEmailDigest !== input.emailDigest) rejectAuthentication();
    const retainUntil = Date.now() + authOtpLifetimeMs;
    if (invite.expiresAt < retainUntil) {
      const patch = { expiresAt: retainUntil, updatedAt: Date.now() };
      await adjustServiceQuotaForPatch(ctx, invite, patch);
      await ctx.db.patch(invite._id, patch);
    } else {
      await adjustServiceQuotaForPatch(ctx, invite, {});
    }
    return { inviteId: invite._id, replay: true };
  }
  if (invite.state !== "issued" || invite.boundEmailDigest !== undefined) {
    rejectAuthentication();
  }
  const now = Date.now();
  const patch = {
    boundAt: now,
    boundEmailDigest: input.emailDigest,
    expiresAt: Math.max(invite.expiresAt, now + authOtpLifetimeMs),
    state: "bound_to_email",
    updatedAt: now,
  } as const;
  await adjustServiceQuotaForPatch(ctx, invite, patch);
  await ctx.db.patch(invite._id, patch);
  return { inviteId: invite._id, replay: false };
}

export async function requireBoundIdentityInvite(
  ctx: MutationCtx,
  input: Readonly<{
    emailDigest: string;
    inviteId: Id<"authInvites">;
  }>,
) {
  const invite = await ctx.db.get(input.inviteId);
  if (
    invite === null
    || invite.purpose !== "identity"
    || invite.state !== "bound_to_email"
    || invite.boundEmailDigest !== input.emailDigest
  ) rejectAuthentication();
  return invite;
}

export async function consumeBoundIdentityInvite(
  ctx: MutationCtx,
  input: Readonly<{
    emailDigest: string;
    inviteId: Id<"authInvites">;
  }>,
): Promise<void> {
  const invite = await requireBoundIdentityInvite(ctx, input);
  const now = Date.now();
  const patch = {
    consumedAt: now,
    expiresAt: Math.max(invite.expiresAt, now + terminalInviteReceiptLifetimeMs),
    state: "consumed",
    updatedAt: now,
  } as const;
  await adjustServiceQuotaForPatch(ctx, invite, patch);
  await recordBootstrapInviteAccepted(ctx, invite, now);
  await ctx.db.patch(invite._id, patch);
}
