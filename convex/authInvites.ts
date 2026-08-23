import { makeFunctionReference } from "convex/server";
import { v, type GenericId as Id } from "convex/values";

import {
  identityInviteCapabilityPrefix,
  identityInviteSecretLength,
  isIdentityInviteCapability,
} from "../src/cloud/authCredentials";
import { authOtpLifetimeMs, isAuthDigest } from "./authPolicy";
import {
  adjustServiceQuotaForPatch,
  reserveServiceQuotaForInsert,
} from "./quota";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./server";
import { invitePurpose } from "./validators";

export type InvitePurpose = "device" | "identity";

export const minimumInviteLifetimeMs = authOtpLifetimeMs + 60_000;
export const maximumInviteLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
export const terminalInviteReceiptLifetimeMs = 24 * 60 * 60 * 1_000;
export const invitePublicIdPrefix = "invite_";

const deviceInviteCapabilityPrefix = "hra_invite_device_v1_";
const invitePublicIdPattern = /^invite_[A-Za-z0-9_-]{32}$/u;
const deviceInviteCapabilityPattern =
  /^hra_invite_device_v1_[A-Za-z0-9_-]{43}$/u;
const authenticationRejectedMessage = "Authentication could not be completed.";
const base64UrlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

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

export function isInvitePublicId(value: unknown): value is string {
  return typeof value === "string" && invitePublicIdPattern.test(value);
}

export function isInviteCapability(
  value: unknown,
  purpose: InvitePurpose,
): value is string {
  return purpose === "identity"
    ? isIdentityInviteCapability(value)
    : typeof value === "string" && deviceInviteCapabilityPattern.test(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      encoded += base64UrlAlphabet.charAt((buffer >>> bits) & 63);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += base64UrlAlphabet.charAt((buffer << (6 - bits)) & 63);
  return encoded;
}

export function generateInviteAuthority(purpose: InvitePurpose): Readonly<{
  capability: string;
  publicId: string;
}> {
  const capabilitySecret = encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const publicIdSecret = encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(24)),
  );
  if (
    capabilitySecret.length !== identityInviteSecretLength
    || publicIdSecret.length !== 32
  ) rejectInviteTool();
  return {
    capability: `${purpose === "identity"
      ? identityInviteCapabilityPrefix
      : deviceInviteCapabilityPrefix}${capabilitySecret}`,
    publicId: `${invitePublicIdPrefix}${publicIdSecret}`,
  };
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function digestInviteCapability(
  capability: string,
  purpose: InvitePurpose,
): Promise<string> {
  if (!isInviteCapability(capability, purpose)) rejectAuthentication();
  const bytes = new TextEncoder().encode(
    `hra-control-plane-invite-capability:v1:${purpose}:${capability}`,
  );
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

function admissionExpiry(invite: Readonly<{
  admissionExpiresAt?: number;
  expiresAt: number;
}>): number {
  return invite.admissionExpiresAt ?? invite.expiresAt;
}

type RecordIssueArgs = Readonly<{
  capabilityDigest: string;
  issuedByUserId?: Id<"users">;
  lifetimeMs: number;
  publicId: string;
  purpose: InvitePurpose;
}>;

type IssueRecord = Readonly<{
  expiresAt: number;
  publicId: string;
  purpose: InvitePurpose;
  replay: boolean;
  state: "issued";
}>;

const recordIssueReference = makeFunctionReference<
  "mutation",
  RecordIssueArgs,
  IssueRecord
>("authInvites:recordIssue");

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
      || !isSafeLifetime(args.lifetimeMs)
    ) rejectInviteTool();
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

export const issue = internalAction({
  args: {
    issuedByUserId: v.optional(v.id("users")),
    lifetimeMs: v.number(),
    purpose: invitePurpose,
  },
  handler: async (ctx, args) => {
    if (!isSafeLifetime(args.lifetimeMs)) rejectInviteTool();
    const authority = generateInviteAuthority(args.purpose);
    const recorded = await ctx.runMutation(recordIssueReference, {
      capabilityDigest: await digestInviteCapability(
        authority.capability,
        args.purpose,
      ),
      lifetimeMs: args.lifetimeMs,
      publicId: authority.publicId,
      purpose: args.purpose,
      ...(args.issuedByUserId === undefined
        ? {}
        : { issuedByUserId: args.issuedByUserId }),
    });
    return { ...recorded, capability: authority.capability };
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
  await ctx.db.patch(invite._id, patch);
}
