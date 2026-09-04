import { v } from "convex/values";

import { isFiniteTimestamp, isSafeNonNegativeInteger, isUuidV7 } from "../src/cloud/contracts";
import {
  identityInviteLifetimeMs,
  invitePublicIdFromCapabilityDigest,
  isInvitePublicId,
} from "../src/cloud/inviteAuthority";
import {
  isAuthDigest,
  newIdentityAdmissionWindowLimit,
  newIdentityAdmissionWindowMs,
} from "./authPolicy";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./server";
import { authAdmissionState, newIdentityAdmissionState } from "./validators";

export type AuthAdmissionState = "frozen" | "open";
export type NewIdentityAdmissionState = "invite_only" | "open";

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
  newIdentityAdmissions?: NewIdentityAdmissionState;
  newIdentityWindowCount?: number;
  newIdentityWindowStartedAt?: number;
  updatedAt: number;
}>;

// An absent stored value is the invite-only default: a deployment that has
// never been opened, and a deployment written before this control existed,
// both refuse a new identity without an invitation.
export function newIdentityAdmissionsOf(
  control: ControlRow,
): NewIdentityAdmissionState {
  return control.newIdentityAdmissions ?? "invite_only";
}

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
  const newIdentityAdmissions = untrusted?.newIdentityAdmissions;
  const newIdentityWindowCount = untrusted?.newIdentityWindowCount;
  const newIdentityWindowStartedAt = untrusted?.newIdentityWindowStartedAt;
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
    || (
      newIdentityAdmissions !== undefined
      && newIdentityAdmissions !== "invite_only"
      && newIdentityAdmissions !== "open"
    )
    || (newIdentityWindowStartedAt === undefined)
      !== (newIdentityWindowCount === undefined)
    || (
      newIdentityWindowStartedAt !== undefined
      && (
        !isFiniteTimestamp(newIdentityWindowStartedAt)
        || !isSafeNonNegativeInteger(newIdentityWindowCount)
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

/**
 * Charges one newly admitted identity against the service-wide rolling window.
 * Every path that inserts a first `authSubjects` row calls this, invited or
 * open, so the cap bounds total admissions rather than one entry point.
 */
export async function recordNewIdentityAdmission(
  ctx: MutationCtx,
  control: ControlRow,
  now: number,
): Promise<void> {
  if (!isFiniteTimestamp(now)) return corrupt();
  const startedAt = control.newIdentityWindowStartedAt;
  const stored = control.newIdentityWindowCount;
  const inWindow = startedAt !== undefined
    && stored !== undefined
    && now >= startedAt
    && now - startedAt < newIdentityAdmissionWindowMs;
  const admitted = inWindow ? stored : 0;
  if (admitted >= newIdentityAdmissionWindowLimit) {
    throw new Error("AUTH_NEW_IDENTITY_ADMISSION_LIMIT");
  }
  await ctx.db.patch(control._id as never, {
    newIdentityWindowCount: admitted + 1,
    newIdentityWindowStartedAt: inWindow ? startedAt : now,
  });
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
  newIdentityAdmissions: newIdentityAdmissionsOf(control),
  state: control.authAdmissions,
  updatedAt: control.updatedAt,
});

export const status = internalQuery({
  args: {},
  handler: async (ctx) => publicControl(await readControl(ctx)),
});

// Both controls share one generation fence and one mutation identity. A
// transition that changes either field advances the generation, so an operator
// can never apply a new-identity change against a stale view of the break-glass
// state, and a replay stays exactly recognisable.
export const transition = internalMutation({
  args: {
    expectedGeneration: v.number(),
    mutationId: v.string(),
    newIdentityAdmissions: v.optional(newIdentityAdmissionState),
    state: authAdmissionState,
  },
  handler: async (ctx, args) => {
    if (
      !isSafeNonNegativeInteger(args.expectedGeneration)
      || !isUuidV7(args.mutationId)
    ) return stale();
    const current = await readControl(ctx);
    const currentNewIdentities = newIdentityAdmissionsOf(current);
    const nextNewIdentities = args.newIdentityAdmissions ?? currentNewIdentities;
    if (current.lastMutationId === args.mutationId) {
      if (
        current.authAdmissionGeneration !== args.expectedGeneration + 1
        || current.authAdmissions !== args.state
        || currentNewIdentities !== nextNewIdentities
      ) return stale();
      return { ...publicControl(current), changed: true, replay: true };
    }
    if (current.authAdmissionGeneration !== args.expectedGeneration) return stale();
    if (
      current.authAdmissions === args.state
      && currentNewIdentities === nextNewIdentities
    ) {
      return stale();
    }
    if (current.authAdmissionGeneration >= Number.MAX_SAFE_INTEGER) return corrupt();
    const next = {
      authAdmissionGeneration: current.authAdmissionGeneration + 1,
      authAdmissions: args.state,
      lastMutationId: args.mutationId,
      newIdentityAdmissions: nextNewIdentities,
      updatedAt: Date.now(),
    } as const;
    await ctx.db.patch(current._id as never, next);
    return {
      generation: next.authAdmissionGeneration,
      newIdentityAdmissions: next.newIdentityAdmissions,
      state: next.authAdmissions,
      updatedAt: next.updatedAt,
      changed: true,
      replay: false,
    };
  },
});
