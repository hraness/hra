import {
  workosOrganizationIdSchema,
  workosUserIdSchema,
  type OrganizationRole,
} from "@hraness/agent-tasks-protocol";
import type { Auth } from "convex/server";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { env } from "./_generated/server";
import { domainFailure, type DomainError } from "./domain";

type AuthCtx = { readonly auth: Auth };
type ReadCtx = QueryCtx | MutationCtx;

export interface HumanIdentity {
  readonly subject: string;
  readonly issuer: string;
  readonly sessionId: string;
  readonly organizationId?: string;
  readonly email?: string;
  readonly name?: string;
}

export interface AuthorizedHuman extends HumanIdentity {
  readonly user: Doc<"users">;
  readonly organization: Doc<"organizations">;
  readonly membership: Doc<"organizationMemberships">;
  readonly role: OrganizationRole;
}

export interface AuthorizedWorkspaceHuman extends AuthorizedHuman {
  readonly workspace: Doc<"workspaces">;
  readonly workspaceMembership?: Doc<"workspaceMemberships">;
}

export type HumanIdentityResult =
  | { readonly ok: true; readonly identity: HumanIdentity }
  | { readonly ok: false; readonly error: DomainError };

export type HumanAuthorizationResult =
  | { readonly ok: true; readonly authorization: AuthorizedHuman }
  | { readonly ok: false; readonly error: DomainError };

export type WorkspaceHumanAuthorizationResult =
  | { readonly ok: true; readonly authorization: AuthorizedWorkspaceHuman }
  | { readonly ok: false; readonly error: DomainError };

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function acceptedProductionIssuers(): readonly string[] {
  const clientId = env.WORKOS_CLIENT_ID;
  return clientId === undefined || clientId.length === 0
    ? []
    : ["https://api.workos.com/", `https://api.workos.com/user_management/${clientId}`];
}

function isAcceptedIssuer(issuer: string): boolean {
  if (acceptedProductionIssuers().includes(issuer)) return true;
  const localIssuer = env.TASKCTL_LOCAL_FIXTURE_ISSUER;
  const localJwks = env.TASKCTL_LOCAL_FIXTURE_JWKS_URL;
  return (
    env.TASKCTL_LOCAL_FIXTURES_ENABLED === "true" &&
    localIssuer !== undefined &&
    localJwks !== undefined &&
    issuer === localIssuer &&
    isLoopbackUrl(localIssuer) &&
    isLoopbackUrl(localJwks)
  );
}

export async function readHumanIdentity(
  ctx: AuthCtx,
  requestId: string,
  organizationRequired: boolean,
): Promise<HumanIdentityResult> {
  let identity;
  try {
    identity = await ctx.auth.getUserIdentity();
  } catch {
    return domainFailure("AUTHENTICATION_FAILED", requestId);
  }
  if (
    identity === null ||
    !isAcceptedIssuer(identity.issuer) ||
    !workosUserIdSchema.safeParse(identity.subject).success
  ) {
    return domainFailure("AUTHENTICATION_FAILED", requestId);
  }
  const sessionId = identity["sid"];
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 512) {
    return domainFailure("AUTHENTICATION_FAILED", requestId);
  }
  const organizationClaim = identity["org_id"];
  if (organizationClaim !== undefined) {
    if (
      typeof organizationClaim !== "string" ||
      !workosOrganizationIdSchema.safeParse(organizationClaim).success
    ) {
      return domainFailure("AUTHENTICATION_FAILED", requestId);
    }
  } else if (organizationRequired) {
    return domainFailure("ORGANIZATION_REQUIRED", requestId);
  }
  return {
    ok: true,
    identity: {
      subject: identity.subject,
      issuer: identity.issuer,
      sessionId,
      ...(organizationClaim === undefined ? {} : { organizationId: organizationClaim }),
      ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(identity.name === undefined ? {} : { name: identity.name }),
    },
  };
}

export async function findHumanUser(ctx: ReadCtx, workosUserId: string) {
  const byWorkos = await ctx.db
    .query("users")
    .withIndex("by_workos_user_id", (query) => query.eq("workosUserId", workosUserId))
    .unique();
  if (byWorkos !== null) return byWorkos;
  return await ctx.db
    .query("users")
    .withIndex("by_public_id", (query) => query.eq("publicId", workosUserId))
    .unique();
}

export async function upsertHumanUser(
  ctx: MutationCtx,
  identity: HumanIdentity,
  now: number,
) {
  const existing = await findHumanUser(ctx, identity.subject);
  const name = identity.name ?? identity.email ?? identity.subject;
  if (existing !== null) {
    await ctx.db.patch(existing._id, {
      workosUserId: identity.subject,
      name,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      status: "active",
      updatedAt: now,
    });
    const updated = await ctx.db.get(existing._id);
    if (updated === null) throw new Error("Human user disappeared during synchronization.");
    return updated;
  }
  const userId = await ctx.db.insert("users", {
    publicId: identity.subject,
    workosUserId: identity.subject,
    name,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const user = await ctx.db.get(userId);
  if (user === null) throw new Error("Human user could not be created.");
  return user;
}

export async function authorizeOrganizationHuman(
  ctx: ReadCtx,
  args: {
    requestId: string;
    allowedRoles?: readonly OrganizationRole[];
  },
): Promise<HumanAuthorizationResult> {
  const identified = await readHumanIdentity(ctx, args.requestId, true);
  if (!identified.ok) return identified;
  const workosOrganizationId = identified.identity.organizationId;
  if (workosOrganizationId === undefined) {
    return domainFailure("ORGANIZATION_REQUIRED", args.requestId);
  }
  const [user, organization] = await Promise.all([
    findHumanUser(ctx, identified.identity.subject),
    ctx.db
      .query("organizations")
      .withIndex("by_workos_organization_id", (query) =>
        query.eq("workosOrganizationId", workosOrganizationId),
      )
      .unique(),
  ]);
  if (organization === null) return domainFailure("ORGANIZATION_MISMATCH", args.requestId);
  if (organization.workosOrganizationId !== workosOrganizationId) {
    return domainFailure("ORGANIZATION_MISMATCH", args.requestId);
  }
  if (organization.status === "provisioning") {
    return domainFailure("PROVISIONING_IN_PROGRESS", args.requestId, { retryAfterMs: 1_000 });
  }
  if (organization.status === "failed") {
    return domainFailure("PROVISIONING_FAILED", args.requestId);
  }
  if (organization.status !== "active" || user === null || user.status !== "active") {
    return domainFailure("MEMBERSHIP_INACTIVE", args.requestId);
  }
  const membership = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_organization_and_user", (query) =>
      query.eq("organizationId", organization._id).eq("userId", user._id),
    )
    .unique();
  if (membership === null || membership.status !== "active") {
    return domainFailure("MEMBERSHIP_INACTIVE", args.requestId);
  }
  if (args.allowedRoles !== undefined && !args.allowedRoles.includes(membership.role)) {
    return domainFailure("WORKSPACE_ROLE_REQUIRED", args.requestId);
  }
  return {
    ok: true,
    authorization: {
      ...identified.identity,
      user,
      organization,
      membership,
      role: membership.role,
    },
  };
}

/**
 * Resolves a workspace only after the WorkOS organization claim and current
 * organization membership have been reloaded. Selector failures and missing
 * workspace access intentionally collapse to NOT_FOUND.
 */
export async function authorizeWorkspaceHuman(
  ctx: ReadCtx,
  args: {
    requestId: string;
    workspacePublicId: string;
    requireOrganizationAdmin?: boolean;
  },
): Promise<WorkspaceHumanAuthorizationResult> {
  const authorized = await authorizeOrganizationHuman(ctx, {
    requestId: args.requestId,
    ...(args.requireOrganizationAdmin === true
      ? { allowedRoles: ["owner", "admin"] }
      : {}),
  });
  if (!authorized.ok) return authorized;
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_public_id", (query) => query.eq("publicId", args.workspacePublicId))
    .unique();
  if (
    workspace === null ||
    workspace.organizationId !== authorized.authorization.organization._id ||
    workspace.status !== "active"
  ) {
    return domainFailure("NOT_FOUND", args.requestId);
  }
  if (
    authorized.authorization.role === "owner" ||
    authorized.authorization.role === "admin"
  ) {
    return {
      ok: true,
      authorization: { ...authorized.authorization, workspace },
    };
  }
  const workspaceMembership = await ctx.db
    .query("workspaceMemberships")
    .withIndex("by_workspace_and_user", (query) =>
      query.eq("workspaceId", workspace._id).eq("userId", authorized.authorization.user._id),
    )
    .unique();
  if (workspaceMembership === null || workspaceMembership.status !== "active") {
    return domainFailure("NOT_FOUND", args.requestId);
  }
  return {
    ok: true,
    authorization: { ...authorized.authorization, workspace, workspaceMembership },
  };
}
