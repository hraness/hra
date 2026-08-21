import type { OrganizationRole } from "@hraness/agent-tasks-protocol";
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { domainFailure, type DomainError } from "./domain";

type ReadCtx = QueryCtx | MutationCtx;

export interface HumanIdentity {
  readonly subject: string;
  readonly userId: Id<"users">;
  readonly sessionId: Id<"authSessions">;
  readonly organizationId?: Id<"organizations">;
  readonly workspaceId?: Id<"workspaces">;
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

export async function readHumanIdentity(
  ctx: ReadCtx,
  requestId: string,
  organizationRequired: boolean,
): Promise<HumanIdentityResult> {
  let userId: Id<"users"> | null;
  let sessionId: Id<"authSessions"> | null;
  try {
    [userId, sessionId] = await Promise.all([
      getAuthUserId(ctx),
      getAuthSessionId(ctx),
    ]);
  } catch {
    return domainFailure("AUTHENTICATION_FAILED", requestId);
  }
  if (userId === null || sessionId === null) {
    return domainFailure("AUTHENTICATION_FAILED", requestId);
  }
  const [user, session, selection] = await Promise.all([
    ctx.db.get(userId),
    ctx.db.get(sessionId),
    ctx.db
      .query("authSessionSelections")
      .withIndex("by_session", (index) => index.eq("sessionId", sessionId))
      .unique(),
  ]);
  if (
    user === null || user.status !== "active" ||
    session === null || session.userId !== user._id || session.expirationTime <= Date.now() ||
    (selection !== null && selection.userId !== user._id)
  ) return domainFailure("AUTHENTICATION_FAILED", requestId);
  if (organizationRequired && selection === null) {
    return domainFailure("ORGANIZATION_REQUIRED", requestId);
  }
  return {
    ok: true,
    identity: {
      subject: user.publicId,
      userId: user._id,
      sessionId,
      ...(selection === null ? {} : { organizationId: selection.organizationId }),
      ...(selection?.workspaceId === undefined ? {} : { workspaceId: selection.workspaceId }),
      ...(user.email === undefined ? {} : { email: user.email }),
      ...(user.name === undefined ? {} : { name: user.name }),
    },
  };
}

export async function findHumanUser(ctx: ReadCtx, publicId: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_public_id", (query) => query.eq("publicId", publicId))
    .unique();
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
  const organizationId = identified.identity.organizationId;
  if (organizationId === undefined) {
    return domainFailure("ORGANIZATION_REQUIRED", args.requestId);
  }
  const [user, organization] = await Promise.all([
    ctx.db.get(identified.identity.userId),
    ctx.db.get(organizationId),
  ]);
  if (
    organization === null || organization.status !== "active" ||
    user === null || user.status !== "active"
  ) {
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
 * Reloads the selected organization membership before resolving a workspace.
 * Selector failures and missing access intentionally collapse to NOT_FOUND.
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
    authorized.authorization.workspaceId === undefined ||
    workspace._id !== authorized.authorization.workspaceId ||
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
