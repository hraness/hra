import { v } from "convex/values";

import { isFiniteTimestamp, isSafeNonNegativeInteger, isUuidV7 } from "../src/cloud/contracts";
import {
  identityInviteLifetimeMs,
  invitePublicIdFromCapabilityDigest,
  isInvitePublicId,
} from "../src/cloud/inviteAuthority";
import { isAuthDigest } from "./authPolicy";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./server";
import { authAdmissionState } from "./validators";

export type AuthAdmissionState = "frozen" | "open";

const corrupt = (): never => {
  throw new Error("AUTH_ADMISSION_AUTHORITY_CORRUPT");
};

const stale = (): never => {
  throw new Error("AUTH_ADMISSION_AUTHORITY_STALE");
};

type ControlContext = MutationCtx | QueryCtx;

export type ControlRow = Readonly<{
  _id: string;
  authAdmissionGeneration: number;
  authAdmissions: AuthAdmissionState;
  bootstrapAcceptedAt?: number;
  bootstrapCompletedAt?: number;
  bootstrapInviteCapabilityDigest?: string;
  bootstrapInviteLifetimeMs?: number;
  bootstrapInvitePublicId?: string;
  key: "global";
  lastMutationId?: string;
  updatedAt: number;
}>;

async function readControl(ctx: ControlContext): Promise<ControlRow> {
  const rows = await ctx.db.query("serviceControl")
    .withIndex("by_key", (builder) => builder.eq("key", "global"))
    .take(2);
  const row = rows[0];
  const untrusted = row as unknown as Readonly<Record<string, unknown>> | undefined;
  const bootstrapValues = [
    untrusted?.bootstrapCompletedAt,
    untrusted?.bootstrapInviteCapabilityDigest,
    untrusted?.bootstrapInviteLifetimeMs,
    untrusted?.bootstrapInvitePublicId,
  ];
  const hasBootstrapAuthority = bootstrapValues.some((value) => value !== undefined);
  const bootstrapAcceptedAt = untrusted?.bootstrapAcceptedAt;
  const bootstrapCompletedAt = untrusted?.bootstrapCompletedAt;
  if (
    rows.length !== 1
    || row === undefined
    || untrusted?.key !== "global"
    || !isSafeNonNegativeInteger(untrusted.authAdmissionGeneration)
    || (untrusted.authAdmissions !== "open" && untrusted.authAdmissions !== "frozen")
    || !isFiniteTimestamp(untrusted.updatedAt)
    || (untrusted.authAdmissionGeneration === 0) !== (untrusted.lastMutationId === undefined)
    || (
      untrusted.lastMutationId !== undefined
      && !isUuidV7(untrusted.lastMutationId)
    )
    || (
      hasBootstrapAuthority
      && (
        !isFiniteTimestamp(untrusted.bootstrapCompletedAt)
        || untrusted.bootstrapCompletedAt > untrusted.updatedAt
        || !isAuthDigest(untrusted.bootstrapInviteCapabilityDigest)
        || untrusted.bootstrapInviteLifetimeMs !== identityInviteLifetimeMs
        || !isInvitePublicId(untrusted.bootstrapInvitePublicId)
        || invitePublicIdFromCapabilityDigest(
          untrusted.bootstrapInviteCapabilityDigest,
        ) !== untrusted.bootstrapInvitePublicId
      )
    )
    || (
      bootstrapAcceptedAt !== undefined
      && (
        !hasBootstrapAuthority
        || !isFiniteTimestamp(bootstrapAcceptedAt)
        || !isFiniteTimestamp(bootstrapCompletedAt)
        || bootstrapAcceptedAt < bootstrapCompletedAt
        || bootstrapAcceptedAt > untrusted.updatedAt
      )
    )
  ) return corrupt();
  return row;
}

export async function requireAuthAdmissionsOpen(
  ctx: ControlContext,
): Promise<ControlRow> {
  const control = await readControl(ctx);
  if (control.authAdmissions !== "open") {
    throw new Error("AUTH_ADMISSION_FROZEN");
  }
  return control;
}

export async function recordBootstrapInviteAccepted(
  ctx: MutationCtx,
  invite: Readonly<{
    capabilityDigest: string;
    publicId: string;
    requestedLifetimeMs?: number;
  }>,
  acceptedAt: number,
): Promise<void> {
  const control = await readControl(ctx);
  if (control.bootstrapInvitePublicId === undefined) return;
  if (
    control.bootstrapInviteCapabilityDigest !== invite.capabilityDigest
    || control.bootstrapInvitePublicId !== invite.publicId
    || control.bootstrapInviteLifetimeMs !== invite.requestedLifetimeMs
  ) return;
  if (control.bootstrapAcceptedAt !== undefined) {
    if (control.bootstrapAcceptedAt > acceptedAt) return corrupt();
    return;
  }
  if (
    !isFiniteTimestamp(acceptedAt)
    || control.bootstrapCompletedAt === undefined
    || acceptedAt < control.bootstrapCompletedAt
  ) return corrupt();
  await ctx.db.patch(control._id as never, {
    bootstrapAcceptedAt: acceptedAt,
    updatedAt: Math.max(control.updatedAt, acceptedAt),
  });
}

const publicControl = (control: ControlRow) => ({
  generation: control.authAdmissionGeneration,
  state: control.authAdmissions,
  updatedAt: control.updatedAt,
});

export const status = internalQuery({
  args: {},
  handler: async (ctx) => publicControl(await readControl(ctx)),
});

export const transition = internalMutation({
  args: {
    expectedGeneration: v.number(),
    mutationId: v.string(),
    state: authAdmissionState,
  },
  handler: async (ctx, args) => {
    if (
      !isSafeNonNegativeInteger(args.expectedGeneration)
      || !isUuidV7(args.mutationId)
    ) return stale();
    const current = await readControl(ctx);
    if (current.lastMutationId === args.mutationId) {
      if (
        current.authAdmissionGeneration !== args.expectedGeneration + 1
        || current.authAdmissions !== args.state
      ) return stale();
      return { ...publicControl(current), changed: true, replay: true };
    }
    if (current.authAdmissionGeneration !== args.expectedGeneration) return stale();
    if (current.authAdmissions === args.state) {
      return stale();
    }
    if (current.authAdmissionGeneration >= Number.MAX_SAFE_INTEGER) return corrupt();
    const next = {
      authAdmissionGeneration: current.authAdmissionGeneration + 1,
      authAdmissions: args.state,
      lastMutationId: args.mutationId,
      updatedAt: Date.now(),
    } as const;
    await ctx.db.patch(current._id as never, next);
    return {
      generation: next.authAdmissionGeneration,
      state: next.authAdmissions,
      updatedAt: next.updatedAt,
      changed: true,
      replay: false,
    };
  },
});
