import {
  organizationNameSchema,
  workosMembershipIdSchema,
  workosOrganizationIdSchema,
  workosUserIdSchema,
  type OrganizationRole,
} from "@hraness/agent-tasks-protocol";
import { v, type Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { randomCrockford } from "./domain";
import { workosOwnerRoleSlug } from "./workos";

export const membershipStatusValidator = v.union(
  v.literal("active"),
  v.literal("inactive"),
  v.literal("pending"),
  v.literal("removed"),
);

export const organizationObservationValidator = v.object({
  kind: v.literal("organization"),
  workosOrganizationId: v.string(),
  name: v.string(),
  externalId: v.optional(v.string()),
  status: v.union(v.literal("active"), v.literal("disabled")),
  providerUpdatedAt: v.number(),
  observedAt: v.number(),
  hardDeleted: v.optional(v.literal(true)),
});

export const membershipObservationValidator = v.object({
  kind: v.literal("organization_membership"),
  workosMembershipId: v.string(),
  workosOrganizationId: v.string(),
  workosUserId: v.string(),
  organizationName: v.string(),
  status: membershipStatusValidator,
  roleSlugs: v.array(v.string()),
  providerUpdatedAt: v.number(),
  observedAt: v.number(),
  hardDeleted: v.optional(v.literal(true)),
});

export const missingMembershipObservationValidator = v.object({
  kind: v.literal("organization_membership_missing"),
  workosMembershipId: v.string(),
  observedAt: v.number(),
});

export const missingOrganizationObservationValidator = v.object({
  kind: v.literal("organization_missing"),
  workosOrganizationId: v.string(),
  observedAt: v.number(),
});

export type OrganizationObservation = Infer<typeof organizationObservationValidator>;
export type MembershipObservation = Infer<typeof membershipObservationValidator>;
export type MissingMembershipObservation = Infer<typeof missingMembershipObservationValidator>;
export type MissingOrganizationObservation = Infer<typeof missingOrganizationObservationValidator>;

function randomOrganizationId(): string {
  return `org_${randomCrockford(26)}`;
}

export function mapOrganizationRole(roleSlugs: readonly string[]): OrganizationRole {
  if (roleSlugs.includes(workosOwnerRoleSlug()) || roleSlugs.includes("owner")) return "owner";
  if (roleSlugs.includes("admin")) return "admin";
  return "member";
}

function organizationRoleRestrictionRank(role: OrganizationRole): number {
  switch (role) {
    case "owner":
      return 0;
    case "admin":
      return 1;
    case "member":
      return 2;
  }
}

export function membershipRestrictionRank(
  status: MembershipObservation["status"],
  role: OrganizationRole,
): number {
  const statusRank = (() => {
    switch (status) {
      case "active":
        return 0;
      case "pending":
        return 1;
      case "inactive":
        return 2;
      case "removed":
        return 3;
    }
  })();
  // Multiplying by the role cardinality keeps status strictly dominant while
  // still making member > admin > owner restrictive on an exact active tie.
  return statusRank * 3 + organizationRoleRestrictionRank(role);
}

function organizationRestrictionRank(status: Doc<"organizations">["status"]): number {
  return status === "active" ? 0 : 1;
}

export function shouldApplyIdentityObservation(args: {
  incomingUpdatedAt: number;
  incomingObservedAt: number;
  incomingRestrictionRank: number;
  currentUpdatedAt?: number;
  currentObservedAt?: number;
  currentRestrictionRank: number;
}): boolean {
  if (args.currentUpdatedAt === undefined) return true;
  if (args.incomingUpdatedAt !== args.currentUpdatedAt) {
    return args.incomingUpdatedAt > args.currentUpdatedAt;
  }
  const currentObservedAt = args.currentObservedAt ?? 0;
  if (args.incomingObservedAt !== currentObservedAt) {
    return args.incomingObservedAt > currentObservedAt;
  }
  return args.incomingRestrictionRank >= args.currentRestrictionRank;
}

export function shouldApplyIdentityResourceObservation(args: {
  incomingUpdatedAt: number;
  incomingObservedAt: number;
  incomingRestrictionRank: number;
  incomingHardDeleted: boolean;
  currentUpdatedAt?: number;
  currentObservedAt?: number;
  currentRestrictionRank: number;
  currentHardDeletedAt?: number;
}): boolean {
  if (args.currentHardDeletedAt !== undefined) {
    if (!args.incomingHardDeleted) return false;
  } else if (args.incomingHardDeleted) {
    // Signed deletion provenance is terminal for this exact provider resource.
    // Timestamp ordering resumes only between repeated hard-deletion deliveries.
    return true;
  }
  return shouldApplyIdentityObservation(args);
}

export type MembershipGenerationDecision = "same" | "rebind" | "collision";

export function missingIdentityResourceDecision(args: {
  lifecycleApplies: boolean;
  currentQuarantined: boolean;
}): { readonly applyLifecycle: boolean; readonly clearQuarantine: boolean } {
  return {
    applyLifecycle: args.lifecycleApplies,
    clearQuarantine: args.currentQuarantined,
  };
}

export function isRetiredMembershipGeneration(
  retiredMembershipId: string | undefined,
  incomingMembershipId: string,
): boolean {
  return retiredMembershipId === incomingMembershipId;
}

export function classifyMembershipGeneration(args: {
  currentMembershipId?: string;
  currentStatus: MembershipObservation["status"];
  incomingMembershipId: string;
  incomingStatus: MembershipObservation["status"];
  incomingHardDeleted: boolean;
  currentQuarantined?: boolean;
}): MembershipGenerationDecision {
  if (
    args.currentMembershipId === undefined ||
    args.currentMembershipId === args.incomingMembershipId
  ) {
    return "same";
  }
  return args.currentStatus === "removed" &&
    args.incomingStatus === "active" &&
    !args.incomingHardDeleted
    ? "rebind"
    : "collision";
}

async function ensureObservedOrganization(
  ctx: MutationCtx,
  observation: MembershipObservation,
  now: number,
): Promise<Doc<"organizations">> {
  let organization = await ctx.db
    .query("organizations")
    .withIndex("by_workos_organization_id", (query) =>
      query.eq("workosOrganizationId", observation.workosOrganizationId),
    )
    .unique();
  if (organization === null) {
    const organizationId = await ctx.db.insert("organizations", {
      publicId: randomOrganizationId(),
      workosOrganizationId: observation.workosOrganizationId,
      name: observation.organizationName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    organization = await ctx.db.get(organizationId);
  }
  if (organization === null) throw new Error("WorkOS organization projection disappeared.");
  return organization;
}

async function ensureObservedUser(
  ctx: MutationCtx,
  workosUserId: string,
  now: number,
): Promise<Doc<"users">> {
  let user = await ctx.db
    .query("users")
    .withIndex("by_workos_user_id", (query) => query.eq("workosUserId", workosUserId))
    .unique();
  if (user === null) {
    user = await ctx.db
      .query("users")
      .withIndex("by_public_id", (query) => query.eq("publicId", workosUserId))
      .unique();
  }
  if (user === null) {
    const userId = await ctx.db.insert("users", {
      publicId: workosUserId,
      workosUserId,
      name: workosUserId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    user = await ctx.db.get(userId);
  } else if (user.workosUserId === undefined) {
    await ctx.db.patch(user._id, { workosUserId, updatedAt: now });
    user = await ctx.db.get(user._id);
  }
  if (user === null) throw new Error("WorkOS user projection disappeared.");
  return user;
}

export async function applyOrganizationObservation(
  ctx: MutationCtx,
  observation: OrganizationObservation,
  now: number,
): Promise<"applied" | "stale"> {
  const parsedName = organizationNameSchema.safeParse(observation.name);
  if (
    !workosOrganizationIdSchema.safeParse(observation.workosOrganizationId).success ||
    !parsedName.success
  ) {
    throw new Error("Invalid WorkOS organization observation.");
  }
  let organization = await ctx.db
    .query("organizations")
    .withIndex("by_workos_organization_id", (query) =>
      query.eq("workosOrganizationId", observation.workosOrganizationId),
    )
    .unique();
  if (organization === null && observation.externalId !== undefined) {
    organization = await ctx.db
      .query("organizations")
      .withIndex("by_workos_external_id", (query) =>
        query.eq("workosExternalId", observation.externalId),
      )
      .unique();
    if (
      organization !== null &&
      organization.workosOrganizationId !== undefined &&
      organization.workosOrganizationId !== observation.workosOrganizationId
    ) {
      throw new Error("WorkOS organization external ID collision.");
    }
  }
  if (organization === null) {
    const organizationId = await ctx.db.insert("organizations", {
      publicId: randomOrganizationId(),
      workosOrganizationId: observation.workosOrganizationId,
      ...(observation.externalId === undefined
        ? {}
        : { workosExternalId: observation.externalId }),
      name: parsedName.data,
      status: observation.status,
      workosUpdatedAt: observation.providerUpdatedAt,
      workosObservedAt: observation.observedAt,
      ...(observation.hardDeleted === true
        ? { workosHardDeletedAt: observation.providerUpdatedAt }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
    organization = await ctx.db.get(organizationId);
    if (organization === null) throw new Error("WorkOS organization projection failed.");
  } else {
    const applies = shouldApplyIdentityResourceObservation({
      incomingUpdatedAt: observation.providerUpdatedAt,
      incomingObservedAt: observation.observedAt,
      incomingRestrictionRank: observation.status === "disabled" ? 1 : 0,
      incomingHardDeleted: observation.hardDeleted === true,
      ...(organization.workosUpdatedAt === undefined
        ? {}
        : { currentUpdatedAt: organization.workosUpdatedAt }),
      ...(organization.workosObservedAt === undefined
        ? {}
        : { currentObservedAt: organization.workosObservedAt }),
      currentRestrictionRank: organizationRestrictionRank(organization.status),
      ...(organization.workosHardDeletedAt === undefined
        ? {}
        : { currentHardDeletedAt: organization.workosHardDeletedAt }),
    });
    if (!applies) return "stale";
    await ctx.db.patch(organization._id, {
      workosOrganizationId: observation.workosOrganizationId,
      ...(observation.externalId === undefined
        ? {}
        : { workosExternalId: observation.externalId }),
      name: parsedName.data,
      status: observation.status,
      failureCode: undefined,
      workosUpdatedAt: observation.providerUpdatedAt,
      workosObservedAt: observation.observedAt,
      workosHardDeletedAt:
        observation.hardDeleted === true ? observation.providerUpdatedAt : undefined,
      workosQuarantinedAt: undefined,
      updatedAt: now,
    });
  }
  return "applied";
}

async function findMembershipProjection(
  ctx: MutationCtx,
  args: {
    workosMembershipId: string;
    organizationId: Id<"organizations">;
    userId: Id<"users">;
  },
): Promise<Doc<"organizationMemberships"> | null> {
  const byProviderId = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_workos_membership_id", (query) =>
      query.eq("workosMembershipId", args.workosMembershipId),
    )
    .unique();
  if (byProviderId !== null) {
    if (
      byProviderId.organizationId !== args.organizationId ||
      byProviderId.userId !== args.userId
    ) {
      throw new Error("WorkOS membership ID collision.");
    }
    return byProviderId;
  }
  return await ctx.db
    .query("organizationMemberships")
    .withIndex("by_organization_and_user", (query) =>
      query.eq("organizationId", args.organizationId).eq("userId", args.userId),
    )
    .unique();
}

export async function applyMembershipObservation(
  ctx: MutationCtx,
  observation: MembershipObservation,
  now: number,
): Promise<"applied" | "stale"> {
  if (
    !workosMembershipIdSchema.safeParse(observation.workosMembershipId).success ||
    !workosOrganizationIdSchema.safeParse(observation.workosOrganizationId).success ||
    !workosUserIdSchema.safeParse(observation.workosUserId).success
  ) {
    throw new Error("Invalid WorkOS membership observation.");
  }
  const retired = await ctx.db
    .query("workosMembershipRetirements")
    .withIndex("by_workos_membership_id", (query) =>
      query.eq("workosMembershipId", observation.workosMembershipId),
    )
    .unique();
  if (
    retired !== null &&
    isRetiredMembershipGeneration(retired.workosMembershipId, observation.workosMembershipId)
  ) {
    return "stale";
  }
  const organization = await ensureObservedOrganization(ctx, observation, now);
  const user = await ensureObservedUser(ctx, observation.workosUserId, now);
  const membership = await findMembershipProjection(ctx, {
    workosMembershipId: observation.workosMembershipId,
    organizationId: organization._id,
    userId: user._id,
  });
  const role = mapOrganizationRole(observation.roleSlugs);
  if (membership === null) {
    await ctx.db.insert("organizationMemberships", {
      organizationId: organization._id,
      userId: user._id,
      workosMembershipId: observation.workosMembershipId,
      workosRoleSlugs: observation.roleSlugs,
      role,
      status: observation.status,
      workosUpdatedAt: observation.providerUpdatedAt,
      workosObservedAt: observation.observedAt,
      ...(observation.hardDeleted === true
        ? {
            workosHardDeletedAt: observation.providerUpdatedAt,
            workosHardDeletedMembershipId: observation.workosMembershipId,
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
  } else {
    const generation = classifyMembershipGeneration({
      ...(membership.workosMembershipId === undefined
        ? {}
        : { currentMembershipId: membership.workosMembershipId }),
      currentStatus: membership.status,
      incomingMembershipId: observation.workosMembershipId,
      incomingStatus: observation.status,
      incomingHardDeleted: observation.hardDeleted === true,
      ...(membership.workosQuarantinedAt === undefined ? {} : { currentQuarantined: true }),
    });
    if (generation === "collision") {
      throw new Error("WorkOS membership generation collision.");
    }
    const currentMembershipId = membership.workosMembershipId;
    if (generation === "rebind" && currentMembershipId !== undefined) {
      const retiredMembershipId = currentMembershipId;
      const priorRetirement = await ctx.db
        .query("workosMembershipRetirements")
        .withIndex("by_workos_membership_id", (query) =>
          query.eq("workosMembershipId", retiredMembershipId),
        )
        .unique();
      if (priorRetirement === null) {
        await ctx.db.insert("workosMembershipRetirements", {
          workosMembershipId: retiredMembershipId,
          organizationId: membership.organizationId,
          userId: membership.userId,
          replacementWorkosMembershipId: observation.workosMembershipId,
          ...(membership.workosHardDeletedAt === undefined
            ? {}
            : { hardDeletedAt: membership.workosHardDeletedAt }),
          retiredAt: now,
        });
      } else if (
        priorRetirement.organizationId !== membership.organizationId ||
        priorRetirement.userId !== membership.userId ||
        priorRetirement.replacementWorkosMembershipId !== observation.workosMembershipId
      ) {
        throw new Error("WorkOS membership retirement collision.");
      }
      await ctx.db.patch(membership._id, {
        workosMembershipId: observation.workosMembershipId,
        workosRoleSlugs: observation.roleSlugs,
        role,
        status: observation.status,
        workosUpdatedAt: observation.providerUpdatedAt,
        workosObservedAt: observation.observedAt,
        workosHardDeletedAt: undefined,
        workosHardDeletedMembershipId: undefined,
        workosQuarantinedAt: undefined,
        updatedAt: now,
      });
      return "applied";
    }
    const currentHardDeletedAt =
      membership.workosHardDeletedMembershipId === observation.workosMembershipId
        ? membership.workosHardDeletedAt
        : undefined;
    const applies = shouldApplyIdentityResourceObservation({
      incomingUpdatedAt: observation.providerUpdatedAt,
      incomingObservedAt: observation.observedAt,
      incomingRestrictionRank: membershipRestrictionRank(observation.status, role),
      incomingHardDeleted: observation.hardDeleted === true,
      ...(membership.workosUpdatedAt === undefined
        ? {}
        : { currentUpdatedAt: membership.workosUpdatedAt }),
      ...(membership.workosObservedAt === undefined
        ? {}
        : { currentObservedAt: membership.workosObservedAt }),
      currentRestrictionRank: membershipRestrictionRank(membership.status, membership.role),
      ...(currentHardDeletedAt === undefined
        ? {}
        : { currentHardDeletedAt }),
    });
    if (!applies) return "stale";
    await ctx.db.patch(membership._id, {
      workosMembershipId: observation.workosMembershipId,
      workosRoleSlugs: observation.roleSlugs,
      role,
      status: observation.status,
      workosUpdatedAt: observation.providerUpdatedAt,
      workosObservedAt: observation.observedAt,
      workosHardDeletedAt:
        observation.hardDeleted === true ? observation.providerUpdatedAt : undefined,
      workosHardDeletedMembershipId:
        observation.hardDeleted === true ? observation.workosMembershipId : undefined,
      workosQuarantinedAt: undefined,
      updatedAt: now,
    });
  }
  return "applied";
}

export async function applyMissingMembershipObservation(
  ctx: MutationCtx,
  observation: MissingMembershipObservation,
  now: number,
): Promise<"applied" | "stale"> {
  const membership = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_workos_membership_id", (query) =>
      query.eq("workosMembershipId", observation.workosMembershipId),
    )
    .unique();
  if (membership === null) return "stale";
  const currentHardDeletedAt =
    membership.workosHardDeletedMembershipId === observation.workosMembershipId
      ? membership.workosHardDeletedAt
      : undefined;
  const applies = shouldApplyIdentityResourceObservation({
    incomingUpdatedAt: membership.workosUpdatedAt ?? 0,
    incomingObservedAt: observation.observedAt,
    incomingRestrictionRank: membershipRestrictionRank("removed", "member"),
    incomingHardDeleted: false,
    ...(membership.workosUpdatedAt === undefined
      ? {}
      : { currentUpdatedAt: membership.workosUpdatedAt }),
    ...(membership.workosObservedAt === undefined
      ? {}
      : { currentObservedAt: membership.workosObservedAt }),
    currentRestrictionRank: membershipRestrictionRank(membership.status, membership.role),
    ...(currentHardDeletedAt === undefined ? {} : { currentHardDeletedAt }),
  });
  const decision = missingIdentityResourceDecision({
    lifecycleApplies: applies,
    currentQuarantined: membership.workosQuarantinedAt !== undefined,
  });
  if (!decision.applyLifecycle) {
    if (decision.clearQuarantine) {
      await ctx.db.patch(membership._id, { workosQuarantinedAt: undefined, updatedAt: now });
    }
    return "stale";
  }
  await ctx.db.patch(membership._id, {
    status: "removed",
    workosObservedAt: observation.observedAt,
    workosQuarantinedAt: undefined,
    updatedAt: now,
  });
  return "applied";
}

export async function applyMissingOrganizationObservation(
  ctx: MutationCtx,
  observation: MissingOrganizationObservation,
  now: number,
): Promise<"applied" | "stale"> {
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_workos_organization_id", (query) =>
      query.eq("workosOrganizationId", observation.workosOrganizationId),
    )
    .unique();
  if (organization === null) return "stale";
  const applies = shouldApplyIdentityResourceObservation({
    incomingUpdatedAt: organization.workosUpdatedAt ?? 0,
    incomingObservedAt: observation.observedAt,
    incomingRestrictionRank: 1,
    incomingHardDeleted: false,
    ...(organization.workosUpdatedAt === undefined
      ? {}
      : { currentUpdatedAt: organization.workosUpdatedAt }),
    ...(organization.workosObservedAt === undefined
      ? {}
      : { currentObservedAt: organization.workosObservedAt }),
    currentRestrictionRank: organizationRestrictionRank(organization.status),
    ...(organization.workosHardDeletedAt === undefined
      ? {}
      : { currentHardDeletedAt: organization.workosHardDeletedAt }),
  });
  const decision = missingIdentityResourceDecision({
    lifecycleApplies: applies,
    currentQuarantined: organization.workosQuarantinedAt !== undefined,
  });
  if (!decision.applyLifecycle) {
    if (decision.clearQuarantine) {
      await ctx.db.patch(organization._id, { workosQuarantinedAt: undefined, updatedAt: now });
    }
    return "stale";
  }
  await ctx.db.patch(organization._id, {
    status: "disabled",
    failureCode: undefined,
    workosObservedAt: observation.observedAt,
    workosQuarantinedAt: undefined,
    updatedAt: now,
  });
  return "applied";
}
