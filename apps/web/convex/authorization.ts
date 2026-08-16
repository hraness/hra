import type { AgentScope } from "@hraness/agent-tasks-protocol";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { domainFailure, type DomainError } from "./domain";
import {
  AGENT_SESSION_HEARTBEAT_MS,
  AGENT_SESSION_IDLE_MS,
} from "./model";

type ReadCtx = QueryCtx | MutationCtx;

export interface AuthorizedAgent {
  readonly credentialId: Id<"agentCredentials">;
  readonly credentialPublicId: string;
  readonly sessionId: Id<"agentSessions">;
  readonly agentId: Id<"agents">;
  readonly agentPublicId: string;
  readonly agentName: string;
  readonly organizationId: Id<"organizations">;
  readonly organizationPublicId: string;
  readonly organizationName: string;
  readonly workspaceId: Id<"workspaces">;
  readonly workspacePublicId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly scopes: AgentScope[];
  readonly sessionPublicId: string;
}

export type AuthorizationResult =
  | { readonly ok: true; readonly authorization: AuthorizedAgent }
  | { readonly ok: false; readonly error: DomainError };

export async function authorizeAgent(
  ctx: ReadCtx,
  args: {
    credentialId: Id<"agentCredentials">;
    sessionPublicId: string;
    requestId: string;
    requiredScope: AgentScope;
    now: number;
  },
): Promise<AuthorizationResult> {
  const credential = await ctx.db.get(args.credentialId);
  if (credential === null || credential.status !== "active" || credential.expiresAt <= args.now) {
    return domainFailure("AUTHENTICATION_FAILED", "Agent authentication failed.", args.requestId);
  }
  const session = await ctx.db
    .query("agentSessions")
    .withIndex("by_public_id", (query) => query.eq("publicId", args.sessionPublicId))
    .unique();
  if (
    session === null ||
    session.credentialId !== credential._id ||
    session.organizationId !== credential.organizationId ||
    session.agentId !== credential.agentId ||
    session.workspaceId !== credential.workspaceId ||
    session.status !== "active" ||
    session.idleExpiresAt <= args.now
  ) {
    return domainFailure("SESSION_INVALID", "The agent session is invalid or expired.", args.requestId);
  }
  const [agent, grant, workspace, organization] = await Promise.all([
    ctx.db.get(credential.agentId),
    ctx.db.get(credential.grantId),
    ctx.db.get(credential.workspaceId),
    ctx.db.get(credential.organizationId),
  ]);
  if (
    agent === null ||
    grant === null ||
    workspace === null ||
    organization === null ||
    agent.status !== "active" ||
    grant.status !== "active" ||
    workspace.status !== "active" ||
    organization.status !== "active" ||
    agent.organizationId !== organization._id ||
    workspace.organizationId !== organization._id ||
    grant.organizationId !== organization._id ||
    grant.workspaceId !== workspace._id ||
    grant.agentId !== agent._id
  ) {
    return domainFailure("AUTHORIZATION_DENIED", "Agent authorization failed.", args.requestId);
  }
  const granted = new Set(grant.scopes);
  const scopes = credential.scopes.filter((scope) => granted.has(scope));
  if (!scopes.includes(args.requiredScope)) {
    return domainFailure("SCOPE_REQUIRED", "The agent lacks a required scope.", args.requestId, {
      requiredScope: args.requiredScope,
    });
  }
  return {
    ok: true,
    authorization: {
      credentialId: credential._id,
      credentialPublicId: credential.locator,
      sessionId: session._id,
      agentId: agent._id,
      agentPublicId: agent.publicId,
      agentName: agent.name,
      organizationId: organization._id,
      organizationPublicId: organization.publicId,
      organizationName: organization.name,
      workspaceId: workspace._id,
      workspacePublicId: workspace.publicId,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
      scopes,
      sessionPublicId: session.publicId,
    },
  };
}

export async function touchAuthorizedAgent(
  ctx: MutationCtx,
  authorization: AuthorizedAgent,
  now: number,
): Promise<void> {
  const session = await ctx.db.get(authorization.sessionId);
  if (session !== null && session.lastSeenAt <= now - AGENT_SESSION_HEARTBEAT_MS) {
    await ctx.db.patch(session._id, {
      lastSeenAt: now,
      idleExpiresAt: now + AGENT_SESSION_IDLE_MS,
    });
  }
  const credential = await ctx.db.get(authorization.credentialId);
  if (credential !== null && credential.lastUsedAt <= now - AGENT_SESSION_HEARTBEAT_MS) {
    await ctx.db.patch(credential._id, { lastUsedAt: now });
  }
}
