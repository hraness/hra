import type { Infer } from "convex/values";
import { v } from "convex/values";

import { mutation, query, type QueryCtx } from "./_generated/server";
import { domainFailure } from "./domain";
import { humanAdminRequestFingerprint } from "./humanAdminFingerprint";
import { authorizeOrganizationHuman } from "./humanAuthorization";
import {
  disableAgentForHuman,
  disableAgentResultValidator,
  listAgentCredentialsForHuman,
  listAgentCredentialsResultValidator,
  listAgentSessionsForHuman,
  listAgentSessionsResultValidator,
  listAgentsForHuman,
  listAgentsResultValidator,
  listWorkspaceMembersForHuman,
  listWorkspaceMembersResultValidator,
  listWorkspacesResultValidator,
  revokeAgentCredentialForHuman,
  revokeAgentCredentialResultValidator,
  setWorkspaceRolesForHuman,
  setWorkspaceRolesResultValidator,
} from "./humanTenancy";
import { domainErrorValidator } from "./model";

const QUERY_REQUEST_ID = "req_00000000000000000000000000";
const DEFAULT_PAGE_SIZE = 100;
const ALL_WORKSPACE_ROLES = ["planner", "reviewer", "viewer"] as const;

const organizationRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
);
const workspaceRoleValidator = v.union(
  v.literal("planner"),
  v.literal("reviewer"),
  v.literal("viewer"),
);
const currentContextResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      user: v.object({ id: v.string(), name: v.string(), email: v.optional(v.string()) }),
      organization: v.object({
        id: v.string(),
        name: v.string(),
        role: organizationRoleValidator,
        status: v.literal("active"),
      }),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

function pageLimit(limit: number | undefined): number {
  return limit ?? DEFAULT_PAGE_SIZE;
}

function mutationRequestId(idempotencyKey: string): string {
  const suffix = idempotencyKey
    .toUpperCase()
    .replaceAll(/[^0-9A-F]/gu, "")
    .padEnd(26, "0")
    .slice(0, 26);
  return `req_${suffix}`;
}

export const currentContext = query({
  args: {},
  returns: currentContextResultValidator,
  handler: async (ctx) => {
    const authorized = await authorizeOrganizationHuman(ctx, { requestId: QUERY_REQUEST_ID });
    if (!authorized.ok) return authorized;
    return {
      ok: true as const,
      data: {
        user: {
          id: authorized.authorization.user.publicId,
          name: authorized.authorization.user.name,
          ...(authorized.authorization.user.email === undefined
            ? {}
            : { email: authorized.authorization.user.email }),
        },
        organization: {
          id: authorized.authorization.organization.publicId,
          name: authorized.authorization.organization.name,
          role: authorized.authorization.role,
          status: "active" as const,
        },
      },
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export type ListWorkspacesArgs = Readonly<{ cursor?: string; limit?: number }>;
export type ListWorkspacesResult = Infer<typeof listWorkspacesResultValidator>;

export async function listWorkspacesForHuman(
  ctx: QueryCtx,
  args: ListWorkspacesArgs,
): Promise<ListWorkspacesResult> {
  const limit = pageLimit(args.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
  }
  const authorized = await authorizeOrganizationHuman(ctx, { requestId: QUERY_REQUEST_ID });
  if (!authorized.ok) return authorized;

  if (authorized.authorization.role === "member") {
    const page = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_user_organization_status_and_workspace", (index) =>
        index
          .eq("userId", authorized.authorization.user._id)
          .eq("organizationId", authorized.authorization.organization._id)
          .eq("status", "active"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const workspaces = [];
    for (const membership of page.page) {
      if (membership.organizationId !== authorized.authorization.organization._id) continue;
      const workspace = await ctx.db.get(membership.workspaceId);
      if (
        workspace === null ||
        workspace.organizationId !== authorized.authorization.organization._id ||
        workspace.status !== "active"
      ) {
        throw new Error("Active workspace membership points outside an active workspace.");
      }
      workspaces.push({
        id: workspace.publicId,
        organizationId: authorized.authorization.organization.publicId,
        slug: workspace.slug,
        name: workspace.name,
        taskKeyPrefix: workspace.taskKeyPrefix,
        roles: [...membership.roles],
      });
    }
    return {
      ok: true,
      data: { workspaces, cursor: page.isDone ? null : page.continueCursor },
      requestId: QUERY_REQUEST_ID,
    };
  }

  const page = await ctx.db
    .query("workspaces")
    .withIndex("by_organization_status_and_public_id", (index) =>
      index
        .eq("organizationId", authorized.authorization.organization._id)
        .eq("status", "active"),
    )
    .paginate({ cursor: args.cursor ?? null, numItems: limit });
  const workspaces = page.page.map((workspace) => ({
      id: workspace.publicId,
      organizationId: authorized.authorization.organization.publicId,
      slug: workspace.slug,
      name: workspace.name,
      taskKeyPrefix: workspace.taskKeyPrefix,
      roles: [...ALL_WORKSPACE_ROLES],
    }));
  return {
    ok: true,
    data: { workspaces, cursor: page.isDone ? null : page.continueCursor },
    requestId: QUERY_REQUEST_ID,
  };
}

export const listWorkspaces = query({
  args: { cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: listWorkspacesResultValidator,
  handler: listWorkspacesForHuman,
});

export const listMembers = query({
  args: {
    workspaceId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: listWorkspaceMembersResultValidator,
  handler: async (ctx, args) =>
    await listWorkspaceMembersForHuman(ctx, {
      workspacePublicId: args.workspaceId,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      limit: pageLimit(args.limit),
      requestId: QUERY_REQUEST_ID,
    }),
});

export const listAgents = query({
  args: {
    workspaceId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: listAgentsResultValidator,
  handler: async (ctx, args) =>
    await listAgentsForHuman(ctx, {
      workspacePublicId: args.workspaceId,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      limit: pageLimit(args.limit),
      requestId: QUERY_REQUEST_ID,
    }),
});

export const listAgentCredentials = query({
  args: {
    workspaceId: v.string(),
    agentId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: listAgentCredentialsResultValidator,
  handler: async (ctx, args) =>
    await listAgentCredentialsForHuman(ctx, {
      workspacePublicId: args.workspaceId,
      agentPublicId: args.agentId,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      limit: pageLimit(args.limit),
      requestId: QUERY_REQUEST_ID,
    }),
});

export const listAgentSessions = query({
  args: {
    workspaceId: v.string(),
    agentId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: listAgentSessionsResultValidator,
  handler: async (ctx, args) =>
    await listAgentSessionsForHuman(ctx, {
      workspacePublicId: args.workspaceId,
      agentPublicId: args.agentId,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      limit: pageLimit(args.limit),
      requestId: QUERY_REQUEST_ID,
    }),
});

export const setWorkspaceRoles = mutation({
  args: {
    workspaceId: v.string(),
    userId: v.string(),
    roles: v.array(workspaceRoleValidator),
    idempotencyKey: v.string(),
  },
  returns: setWorkspaceRolesResultValidator,
  handler: async (ctx, args) =>
    await setWorkspaceRolesForHuman(ctx, {
      workspacePublicId: args.workspaceId,
      userPublicId: args.userId,
      roles: args.roles,
      idempotencyKey: args.idempotencyKey,
      requestDigest: humanAdminRequestFingerprint(
        JSON.stringify(["workspace.roles.set", args.workspaceId, args.userId, args.roles]),
      ),
      requestId: mutationRequestId(args.idempotencyKey),
    }),
});

export const revokeAgentCredential = mutation({
  args: {
    workspaceId: v.string(),
    agentId: v.string(),
    credentialId: v.string(),
    idempotencyKey: v.string(),
  },
  returns: revokeAgentCredentialResultValidator,
  handler: async (ctx, args) =>
    await revokeAgentCredentialForHuman(ctx, {
      workspacePublicId: args.workspaceId,
      agentPublicId: args.agentId,
      credentialLocator: args.credentialId,
      idempotencyKey: args.idempotencyKey,
      requestDigest: humanAdminRequestFingerprint(
        JSON.stringify([
          "agents.credentials.revoke",
          args.workspaceId,
          args.agentId,
          args.credentialId,
        ]),
      ),
      requestId: mutationRequestId(args.idempotencyKey),
    }),
});

export const disableAgent = mutation({
  args: { workspaceId: v.string(), agentId: v.string(), idempotencyKey: v.string() },
  returns: disableAgentResultValidator,
  handler: async (ctx, args) =>
    await disableAgentForHuman(ctx, {
      workspacePublicId: args.workspaceId,
      agentPublicId: args.agentId,
      idempotencyKey: args.idempotencyKey,
      requestDigest: humanAdminRequestFingerprint(
        JSON.stringify(["agents.disable", args.workspaceId, args.agentId]),
      ),
      requestId: mutationRequestId(args.idempotencyKey),
    }),
});
