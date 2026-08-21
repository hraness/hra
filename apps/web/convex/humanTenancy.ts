import {
  agentScopeValues,
  createAgentEnrollmentResponseSchema,
  createAgentResponseSchema,
  createOrganizationResponseSchema,
  createWorkspaceResponseSchema,
  disableAgentResponseSchema,
  MAX_AGENT_CREDENTIAL_LIFETIME_MS,
  MIN_AGENT_CREDENTIAL_LIFETIME_MS,
  organizationNameSchema,
  revokeAgentCredentialResponseSchema,
  workspaceNameSchema,
  workspaceSlugSchema,
  taskKeyPrefixSchema,
  type AgentScope,
  type WorkspaceRole,
} from "@hraness/agent-tasks-protocol";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { digestArrayBuffer, encodeDigest } from "./crypto";
import {
  assertRequestMetadata,
  domainFailure,
  randomCrockford,
  type DomainError,
} from "./domain";
import { appendSecurityEvent } from "./events";
import {
  authorizeOrganizationHuman,
  authorizeWorkspaceHuman,
  readHumanIdentity,
} from "./humanAuthorization";
import {
  agentScopeValidator,
  domainErrorValidator,
  ENROLLMENT_LIFETIME_MS,
  MAX_COMMAND_RECEIPT_BYTES,
} from "./model";
const IDEMPOTENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const ALL_WORKSPACE_ROLES = ["planner", "reviewer", "viewer"] as const;
const CREDENTIAL_SESSION_REVOCATION_BATCH = 64;

const organizationRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
);
const organizationViewValidator = v.object({
  id: v.string(),
  name: v.string(),
  role: organizationRoleValidator,
  status: v.literal("active"),
});
const workspaceRoleValidator = v.union(
  v.literal("planner"),
  v.literal("reviewer"),
  v.literal("viewer"),
);
const workspaceViewValidator = v.object({
  id: v.string(),
  organizationId: v.string(),
  slug: v.string(),
  name: v.string(),
  taskKeyPrefix: v.string(),
  roles: v.array(workspaceRoleValidator),
});
const enrollmentAdminViewValidator = v.object({ locator: v.string(), expiresAt: v.number() });
const agentAdminViewValidator = v.object({
  id: v.string(),
  workspaceId: v.string(),
  name: v.string(),
  status: v.literal("active"),
  scopes: v.array(agentScopeValidator),
});
export const agentLifecycleViewValidator = v.object({
  id: v.string(),
  workspaceId: v.string(),
  name: v.string(),
  status: v.union(v.literal("active"), v.literal("disabled")),
  scopes: v.array(agentScopeValidator),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export const agentCredentialViewValidator = v.union(
  v.object({
    id: v.string(),
    agentId: v.string(),
    workspaceId: v.string(),
    scopes: v.array(agentScopeValidator),
    status: v.literal("active"),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastUsedAt: v.number(),
  }),
  v.object({
    id: v.string(),
    agentId: v.string(),
    workspaceId: v.string(),
    scopes: v.array(agentScopeValidator),
    status: v.literal("expired"),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastUsedAt: v.number(),
  }),
  v.object({
    id: v.string(),
    agentId: v.string(),
    workspaceId: v.string(),
    scopes: v.array(agentScopeValidator),
    status: v.literal("revoked"),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastUsedAt: v.number(),
    revokedAt: v.number(),
  }),
);
export const revokedAgentCredentialViewValidator = v.object({
  id: v.string(),
  agentId: v.string(),
  workspaceId: v.string(),
  scopes: v.array(agentScopeValidator),
  status: v.literal("revoked"),
  createdAt: v.number(),
  expiresAt: v.number(),
  lastUsedAt: v.number(),
  revokedAt: v.number(),
});
export const activeAgentSessionViewValidator = v.object({
  agentId: v.string(),
  workspaceId: v.string(),
  credentialId: v.string(),
  status: v.literal("active"),
  createdAt: v.number(),
  lastSeenAt: v.number(),
  idleExpiresAt: v.number(),
});
const workspaceAccessValidator = v.union(
  v.object({ status: v.literal("active"), roles: v.array(workspaceRoleValidator) }),
  v.object({ status: v.literal("none"), roles: v.array(workspaceRoleValidator) }),
);
export const workspaceMemberViewValidator = v.object({
  id: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
  organizationRole: organizationRoleValidator,
  workspaceAccess: workspaceAccessValidator,
});

const listOrganizationsResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      organizations: v.array(organizationViewValidator),
      cursor: v.union(v.string(), v.null()),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
const createOrganizationResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ organization: organizationViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
export const listWorkspacesResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      workspaces: v.array(workspaceViewValidator),
      cursor: v.union(v.string(), v.null()),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
const createWorkspaceResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ workspace: workspaceViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
const createAgentResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ agent: agentAdminViewValidator, enrollment: enrollmentAdminViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
const createAgentEnrollmentResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ enrollment: enrollmentAdminViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
export const listAgentsResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      agents: v.array(agentLifecycleViewValidator),
      cursor: v.union(v.string(), v.null()),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
const getAgentResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ agent: agentLifecycleViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
export const listAgentCredentialsResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      credentials: v.array(agentCredentialViewValidator),
      cursor: v.union(v.string(), v.null()),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
export const revokeAgentCredentialResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ credential: revokedAgentCredentialViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
export const listAgentSessionsResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      sessions: v.array(activeAgentSessionViewValidator),
      cursor: v.union(v.string(), v.null()),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
export const disableAgentResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ agent: agentLifecycleViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
export const listWorkspaceMembersResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      members: v.array(workspaceMemberViewValidator),
      cursor: v.union(v.string(), v.null()),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
export const setWorkspaceRolesResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ member: workspaceMemberViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export interface HumanReceiptIdentity {
  readonly kind: "account" | "organization";
  readonly principalId: string;
  readonly organizationId?: Id<"organizations">;
}

export type HumanReceiptLookup<Data> =
  | { readonly kind: "none" }
  | {
      readonly kind: "replay";
      readonly data: Data;
      readonly receiptId: Id<"humanCommandReceipts">;
      readonly requestId: string;
    }
  | { readonly kind: "failure"; readonly error: DomainError };

export async function lookupHumanReceipt<Data>(
  ctx: MutationCtx,
  args: {
    identity: HumanReceiptIdentity;
    operation: string;
    idempotencyKey: string;
    requestDigest: string;
    requestId: string;
    parse: (value: unknown) => Data | null;
  },
): Promise<HumanReceiptLookup<Data>> {
  const receipt = await ctx.db
    .query("humanCommandReceipts")
    .withIndex("by_principal_operation_key", (query) =>
      query
        .eq("principalKind", args.identity.kind)
        .eq("principalId", args.identity.principalId)
        .eq("organizationId", args.identity.organizationId)
        .eq("operation", args.operation)
        .eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (receipt === null) return { kind: "none" };
  const storedDigest =
    typeof receipt.requestDigest === "string"
      ? receipt.requestDigest
      : encodeDigest(receipt.requestDigest);
  if (
    storedDigest !== args.requestDigest ||
    receipt.organizationId !== args.identity.organizationId
  ) {
    return { kind: "failure", error: domainFailure("IDEMPOTENCY_CONFLICT", args.requestId).error };
  }
  try {
    const data = args.parse(JSON.parse(receipt.responseJson) as unknown);
    return data === null
      ? { kind: "failure", error: domainFailure("INTERNAL_ERROR", args.requestId).error }
      : {
          kind: "replay",
          data,
          receiptId: receipt._id,
          requestId: receipt.requestId,
        };
  } catch {
    return { kind: "failure", error: domainFailure("INTERNAL_ERROR", args.requestId).error };
  }
}

export async function storeHumanReceipt<Data>(
  ctx: MutationCtx,
  args: {
    identity: HumanReceiptIdentity;
    operation: string;
    idempotencyKey: string;
    requestDigest: string;
    requestId: string;
    data: Data;
    now: number;
  },
): Promise<Id<"humanCommandReceipts">> {
  const responseJson = JSON.stringify(args.data);
  if (new TextEncoder().encode(responseJson).length > MAX_COMMAND_RECEIPT_BYTES) {
    throw new Error("Human command receipt exceeds its bounded response limit.");
  }
  const requestDigest = digestArrayBuffer(args.requestDigest);
  if (requestDigest === null) throw new Error("Human command receipt digest is invalid.");
  return await ctx.db.insert("humanCommandReceipts", {
    principalKind: args.identity.kind,
    principalId: args.identity.principalId,
    ...(args.identity.organizationId === undefined
      ? {}
      : { organizationId: args.identity.organizationId }),
    operation: args.operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest,
    requestId: args.requestId,
    responseJson,
    createdAt: args.now,
    expiresAt: args.now + IDEMPOTENCY_WINDOW_MS,
  });
}

function randomHumanId(prefix: "org" | "wsp" | "agt"): string {
  return `${prefix}_${randomCrockford(26)}`;
}

function workspaceView(
  workspace: Doc<"workspaces">,
  organization: Doc<"organizations">,
  roles: readonly WorkspaceRole[],
) {
  return {
    id: workspace.publicId,
    organizationId: organization.publicId,
    slug: workspace.slug,
    name: workspace.name,
    taskKeyPrefix: workspace.taskKeyPrefix,
    roles: [...new Set(roles)],
  };
}

function parseWithSchema<Data>(schema: { safeParse(value: unknown): { success: boolean; data?: Data } }) {
  return (value: unknown): Data | null => {
    const parsed = schema.safeParse(value);
    return parsed.success && parsed.data !== undefined ? parsed.data : null;
  };
}

export const listWorkspaces = internalQuery({
  args: { cursor: v.optional(v.string()), limit: v.number(), requestId: v.string() },
  returns: listWorkspacesResultValidator,
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 100 ||
      (args.cursor !== undefined && (args.cursor.length === 0 || args.cursor.length > 8_192))
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorized = await authorizeOrganizationHuman(ctx, { requestId: args.requestId });
    if (!authorized.ok) return authorized;
    const { authorization } = authorized;
    if (authorization.role === "owner" || authorization.role === "admin") {
      const page = await ctx.db
        .query("workspaces")
        .withIndex("by_organization_status_and_public_id", (query) =>
          query.eq("organizationId", authorization.organization._id).eq("status", "active"),
        )
        .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
      return {
        ok: true as const,
        data: {
          workspaces: page.page.map((workspace) =>
            workspaceView(workspace, authorization.organization, ALL_WORKSPACE_ROLES),
          ),
          cursor: page.isDone ? null : page.continueCursor,
        },
        requestId: args.requestId,
      };
    }
    const page = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_user_organization_status_and_workspace", (query) =>
        query
          .eq("userId", authorization.user._id)
          .eq("organizationId", authorization.organization._id)
          .eq("status", "active"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    const pageWorkspaces = [];
    for (const membership of page.page) {
      const workspace = await ctx.db.get(membership.workspaceId);
      if (
        workspace === null ||
        workspace.organizationId !== authorization.organization._id ||
        workspace.status !== "active"
      ) {
        throw new Error("Active workspace membership points outside an active workspace.");
      }
      pageWorkspaces.push(workspaceView(workspace, authorization.organization, membership.roles));
    }
    return {
      ok: true as const,
      data: { workspaces: pageWorkspaces, cursor: page.isDone ? null : page.continueCursor },
      requestId: args.requestId,
    };
  },
});

export const createWorkspace = internalMutation({
  args: {
    name: v.string(),
    slug: v.string(),
    taskKeyPrefix: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: createWorkspaceResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizeOrganizationHuman(ctx, {
      requestId: args.requestId,
      allowedRoles: ["owner", "admin"],
    });
    if (!authorized.ok) return authorized;
    const parsed = {
      name: workspaceNameSchema.safeParse(args.name),
      slug: workspaceSlugSchema.safeParse(args.slug),
      taskKeyPrefix: taskKeyPrefixSchema.safeParse(args.taskKeyPrefix),
    };
    if (
      !parsed.name.success ||
      parsed.name.data === undefined ||
      !parsed.slug.success ||
      parsed.slug.data === undefined ||
      !parsed.taskKeyPrefix.success ||
      parsed.taskKeyPrefix.data === undefined
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const workspaceName = parsed.name.data;
    const workspaceSlug = parsed.slug.data;
    const taskKeyPrefix = parsed.taskKeyPrefix.data;
    const identity = {
      kind: "organization" as const,
      principalId: authorized.authorization.subject,
      organizationId: authorized.authorization.organization._id,
    };
    const receipt = await lookupHumanReceipt(ctx, {
      identity,
      operation: "workspaces.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseWithSchema(createWorkspaceResponseSchema),
    });
    if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_organization_and_slug", (query) =>
        query
          .eq("organizationId", authorized.authorization.organization._id)
          .eq("slug", workspaceSlug),
      )
      .unique();
    if (existing !== null) return domainFailure("VALIDATION_ERROR", args.requestId);
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId: authorized.authorization.organization._id,
      publicId: randomHumanId("wsp"),
      slug: workspaceSlug,
      name: workspaceName,
      taskKeyPrefix,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMemberships", {
      organizationId: authorized.authorization.organization._id,
      workspaceId,
      userId: authorized.authorization.user._id,
      roles: [...ALL_WORKSPACE_ROLES],
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceUsage", {
      organizationId: authorized.authorization.organization._id,
      workspaceId,
      activeTasks: 0,
      totalTasks: 0,
      activeAgents: 0,
      updatedAt: now,
    });
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null) throw new Error("Workspace creation failed.");
    const data = {
      workspace: workspaceView(workspace, authorized.authorization.organization, ALL_WORKSPACE_ROLES),
    };
    await storeHumanReceipt(ctx, {
      identity,
      operation: "workspaces.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});

async function createEnrollment(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    workspaceId: Id<"workspaces">;
    agentId: Id<"agents">;
    grantId: Id<"agentWorkspaceGrants">;
    userId: Id<"users">;
    locator: string;
    verifierDigest: ArrayBuffer;
    pepperVersion: string;
    scopes: AgentScope[];
    credentialLifetimeMs: number;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("agentEnrollments")
    .withIndex("by_locator", (query) => query.eq("locator", args.locator))
    .unique();
  if (existing !== null) return null;
  const expiresAt = args.now + ENROLLMENT_LIFETIME_MS;
  await ctx.db.insert("agentEnrollments", {
    locator: args.locator,
    organizationId: args.organizationId,
    workspaceId: args.workspaceId,
    agentId: args.agentId,
    grantId: args.grantId,
    createdByUserId: args.userId,
    verifierDigest: args.verifierDigest,
    pepperVersion: args.pepperVersion,
    scopes: args.scopes,
    credentialLifetimeMs: args.credentialLifetimeMs,
    status: "active",
    expiresAt,
    createdAt: args.now,
  });
  return { locator: args.locator, expiresAt };
}

export const createAgent = internalMutation({
  args: {
    workspacePublicId: v.string(),
    name: v.string(),
    scopes: v.array(agentScopeValidator),
    enrollmentLocator: v.string(),
    enrollmentVerifierDigest: v.bytes(),
    enrollmentPepperVersion: v.string(),
    credentialLifetimeMs: v.number(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: createAgentResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizeOrganizationHuman(ctx, {
      requestId: args.requestId,
      allowedRoles: ["owner", "admin"],
    });
    if (!authorized.ok) return authorized;
    if (
      args.scopes.length === 0 ||
      new Set(args.scopes).size !== args.scopes.length ||
      !args.scopes.every((scope) => agentScopeValues.includes(scope)) ||
      !Number.isSafeInteger(args.credentialLifetimeMs) ||
      args.credentialLifetimeMs < MIN_AGENT_CREDENTIAL_LIFETIME_MS ||
      args.credentialLifetimeMs > MAX_AGENT_CREDENTIAL_LIFETIME_MS
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const identity = {
      kind: "organization" as const,
      principalId: authorized.authorization.subject,
      organizationId: authorized.authorization.organization._id,
    };
    const receipt = await lookupHumanReceipt(ctx, {
      identity,
      operation: "agents.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseWithSchema(createAgentResponseSchema),
    });
    if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
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
    const usage = await ctx.db
      .query("workspaceUsage")
      .withIndex("by_workspace", (query) => query.eq("workspaceId", workspace._id))
      .unique();
    if (usage === null) return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
    const conflictingEnrollment = await ctx.db
      .query("agentEnrollments")
      .withIndex("by_locator", (query) => query.eq("locator", args.enrollmentLocator))
      .unique();
    if (conflictingEnrollment !== null) {
      return domainFailure("ENROLLMENT_CONFLICT", args.requestId);
    }
    const agentId = await ctx.db.insert("agents", {
      organizationId: authorized.authorization.organization._id,
      createdByUserId: authorized.authorization.user._id,
      publicId: randomHumanId("agt"),
      name: args.name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const grantId = await ctx.db.insert("agentWorkspaceGrants", {
      organizationId: authorized.authorization.organization._id,
      workspaceId: workspace._id,
      agentId,
      status: "active",
      scopes: args.scopes,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(usage._id, {
      activeAgents: usage.activeAgents + 1,
      updatedAt: now,
    });
    const enrollment = await createEnrollment(ctx, {
      organizationId: authorized.authorization.organization._id,
      workspaceId: workspace._id,
      agentId,
      grantId,
      userId: authorized.authorization.user._id,
      locator: args.enrollmentLocator,
      verifierDigest: args.enrollmentVerifierDigest,
      pepperVersion: args.enrollmentPepperVersion,
      scopes: args.scopes,
      credentialLifetimeMs: args.credentialLifetimeMs,
      now,
    });
    if (enrollment === null) return domainFailure("ENROLLMENT_CONFLICT", args.requestId);
    const agent = await ctx.db.get(agentId);
    if (agent === null) throw new Error("Agent creation failed.");
    await appendSecurityEvent(ctx, {
      organizationId: authorized.authorization.organization._id,
      workspaceId: workspace._id,
      agentId,
      type: "agent.enrollment_created",
      actor: { kind: "human", userId: authorized.authorization.user.publicId },
      command: {
        kind: "client",
        idempotencyKey: args.idempotencyKey,
        requestId: args.requestId,
      },
      payload: { enrollmentLocator: enrollment.locator },
      now,
    });
    const data = {
      agent: {
        id: agent.publicId,
        workspaceId: workspace.publicId,
        name: agent.name,
        status: "active" as const,
        scopes: args.scopes,
      },
      enrollment,
    };
    await storeHumanReceipt(ctx, {
      identity,
      operation: "agents.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export const createAgentEnrollment = internalMutation({
  args: {
    agentPublicId: v.string(),
    workspacePublicId: v.string(),
    scopes: v.optional(v.array(agentScopeValidator)),
    enrollmentLocator: v.string(),
    enrollmentVerifierDigest: v.bytes(),
    enrollmentPepperVersion: v.string(),
    credentialLifetimeMs: v.number(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: createAgentEnrollmentResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizeOrganizationHuman(ctx, {
      requestId: args.requestId,
      allowedRoles: ["owner", "admin"],
    });
    if (!authorized.ok) return authorized;
    if (
      !Number.isSafeInteger(args.credentialLifetimeMs) ||
      args.credentialLifetimeMs < MIN_AGENT_CREDENTIAL_LIFETIME_MS ||
      args.credentialLifetimeMs > MAX_AGENT_CREDENTIAL_LIFETIME_MS ||
      (args.scopes !== undefined &&
        (args.scopes.length === 0 || new Set(args.scopes).size !== args.scopes.length))
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const identity = {
      kind: "organization" as const,
      principalId: authorized.authorization.subject,
      organizationId: authorized.authorization.organization._id,
    };
    const receipt = await lookupHumanReceipt(ctx, {
      identity,
      operation: "agents.enrollments.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseWithSchema(createAgentEnrollmentResponseSchema),
    });
    if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const [agent, workspace] = await Promise.all([
      ctx.db
        .query("agents")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.agentPublicId))
        .unique(),
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspacePublicId))
        .unique(),
    ]);
    if (
      agent === null ||
      workspace === null ||
      agent.organizationId !== authorized.authorization.organization._id ||
      workspace.organizationId !== authorized.authorization.organization._id ||
      agent.status !== "active" ||
      workspace.status !== "active"
    ) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    const grant = await ctx.db
      .query("agentWorkspaceGrants")
      .withIndex("by_workspace_and_agent", (query) =>
        query.eq("workspaceId", workspace._id).eq("agentId", agent._id),
      )
      .unique();
    if (grant === null || grant.status !== "active") return domainFailure("NOT_FOUND", args.requestId);
    const scopes = args.scopes ?? grant.scopes;
    const granted = new Set(grant.scopes);
    if (
      scopes.length === 0 ||
      new Set(scopes).size !== scopes.length ||
      !scopes.every((scope) => granted.has(scope))
    ) {
      return domainFailure("AUTHORIZATION_DENIED", args.requestId);
    }
    const enrollment = await createEnrollment(ctx, {
      organizationId: authorized.authorization.organization._id,
      workspaceId: workspace._id,
      agentId: agent._id,
      grantId: grant._id,
      userId: authorized.authorization.user._id,
      locator: args.enrollmentLocator,
      verifierDigest: args.enrollmentVerifierDigest,
      pepperVersion: args.enrollmentPepperVersion,
      scopes,
      credentialLifetimeMs: args.credentialLifetimeMs,
      now,
    });
    if (enrollment === null) return domainFailure("ENROLLMENT_CONFLICT", args.requestId);
    await appendSecurityEvent(ctx, {
      organizationId: authorized.authorization.organization._id,
      workspaceId: workspace._id,
      agentId: agent._id,
      type: "agent.enrollment_created",
      actor: { kind: "human", userId: authorized.authorization.user.publicId },
      command: {
        kind: "client",
        idempotencyKey: args.idempotencyKey,
        requestId: args.requestId,
      },
      payload: { enrollmentLocator: enrollment.locator },
      now,
    });
    const data = { enrollment };
    await storeHumanReceipt(ctx, {
      identity,
      operation: "agents.enrollments.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});

type HumanAdminReadCtx = QueryCtx | MutationCtx;
type PageArgs = { readonly cursor?: string; readonly limit: number; readonly requestId: string };

function validPage(args: PageArgs): boolean {
  return Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 100;
}

function pageCursor(page: { readonly isDone: boolean; readonly continueCursor: string }): string | null {
  return page.isDone ? null : page.continueCursor;
}

function lifecycleAgentView(
  agent: Doc<"agents">,
  workspace: Doc<"workspaces">,
  grant: Doc<"agentWorkspaceGrants">,
) {
  return {
    id: agent.publicId,
    workspaceId: workspace.publicId,
    name: agent.name,
    status: agent.status,
    scopes: grant.scopes,
    createdAt: agent.createdAt,
    updatedAt: Math.max(agent.updatedAt, grant.updatedAt),
  };
}

function credentialAdminView(
  credential: Doc<"agentCredentials">,
  agent: Doc<"agents">,
  workspace: Doc<"workspaces">,
  now: number,
) {
  const base = {
    id: credential.locator,
    agentId: agent.publicId,
    workspaceId: workspace.publicId,
    scopes: credential.scopes,
    createdAt: credential.createdAt,
    expiresAt: credential.expiresAt,
    lastUsedAt: credential.lastUsedAt,
  };
  if (credential.status === "revoked") {
    if (credential.revokedAt === undefined) return null;
    return { ...base, status: "revoked" as const, revokedAt: credential.revokedAt };
  }
  return { ...base, status: credential.expiresAt <= now ? ("expired" as const) : ("active" as const) };
}

async function resolveAdminAgent(
  ctx: HumanAdminReadCtx,
  args: {
    organizationId: Id<"organizations">;
    workspace: Doc<"workspaces">;
    agentPublicId: string;
  },
) {
  const agent = await ctx.db
    .query("agents")
    .withIndex("by_public_id", (query) => query.eq("publicId", args.agentPublicId))
    .unique();
  if (agent === null || agent.organizationId !== args.organizationId) return null;
  const grant = await ctx.db
    .query("agentWorkspaceGrants")
    .withIndex("by_workspace_and_agent", (query) =>
      query.eq("workspaceId", args.workspace._id).eq("agentId", agent._id),
    )
    .unique();
  if (
    grant === null ||
    grant.organizationId !== args.organizationId ||
    grant.status !== "active"
  ) {
    return null;
  }
  return { agent, grant };
}

export async function listAgentsForHuman(ctx: HumanAdminReadCtx, args: PageArgs & {
  readonly workspacePublicId: string;
}) {
  if (!validPage(args)) return domainFailure("VALIDATION_ERROR", args.requestId);
  const authorized = await authorizeWorkspaceHuman(ctx, {
    requestId: args.requestId,
    workspacePublicId: args.workspacePublicId,
  });
  if (!authorized.ok) return authorized;
  const page = await ctx.db
    .query("agentWorkspaceGrants")
    .withIndex("by_workspace_status_and_agent", (query) =>
      query.eq("workspaceId", authorized.authorization.workspace._id).eq("status", "active"),
    )
    .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
  const agents = [];
  for (const grant of page.page) {
    const agent = await ctx.db.get(grant.agentId);
    if (
      agent === null ||
      agent.organizationId !== authorized.authorization.organization._id ||
      grant.organizationId !== authorized.authorization.organization._id
    ) {
      continue;
    }
    agents.push(lifecycleAgentView(agent, authorized.authorization.workspace, grant));
  }
  return {
    ok: true as const,
    data: { agents, cursor: pageCursor(page) },
    requestId: args.requestId,
  };
}

export async function getAgentForHuman(ctx: HumanAdminReadCtx, args: {
  readonly workspacePublicId: string;
  readonly agentPublicId: string;
  readonly requestId: string;
}) {
  const authorized = await authorizeWorkspaceHuman(ctx, {
    requestId: args.requestId,
    workspacePublicId: args.workspacePublicId,
  });
  if (!authorized.ok) return authorized;
  const resolved = await resolveAdminAgent(ctx, {
    organizationId: authorized.authorization.organization._id,
    workspace: authorized.authorization.workspace,
    agentPublicId: args.agentPublicId,
  });
  if (resolved === null) return domainFailure("NOT_FOUND", args.requestId);
  return {
    ok: true as const,
    data: {
      agent: lifecycleAgentView(
        resolved.agent,
        authorized.authorization.workspace,
        resolved.grant,
      ),
    },
    requestId: args.requestId,
  };
}

export async function listAgentCredentialsForHuman(ctx: HumanAdminReadCtx, args: PageArgs & {
  readonly workspacePublicId: string;
  readonly agentPublicId: string;
}) {
  if (!validPage(args)) return domainFailure("VALIDATION_ERROR", args.requestId);
  const authorized = await authorizeWorkspaceHuman(ctx, {
    requestId: args.requestId,
    workspacePublicId: args.workspacePublicId,
  });
  if (!authorized.ok) return authorized;
  const resolved = await resolveAdminAgent(ctx, {
    organizationId: authorized.authorization.organization._id,
    workspace: authorized.authorization.workspace,
    agentPublicId: args.agentPublicId,
  });
  if (resolved === null) return domainFailure("NOT_FOUND", args.requestId);
  const page = await ctx.db
    .query("agentCredentials")
    .withIndex("by_workspace_and_agent", (query) =>
      query
        .eq("workspaceId", authorized.authorization.workspace._id)
        .eq("agentId", resolved.agent._id),
    )
    .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
  const now = Date.now();
  const credentials = page.page.flatMap((credential) => {
    if (credential.organizationId !== authorized.authorization.organization._id) return [];
    const view = credentialAdminView(
      credential,
      resolved.agent,
      authorized.authorization.workspace,
      now,
    );
    return view === null ? [] : [view];
  });
  return {
    ok: true as const,
    data: { credentials, cursor: pageCursor(page) },
    requestId: args.requestId,
  };
}

export async function listAgentSessionsForHuman(ctx: HumanAdminReadCtx, args: PageArgs & {
  readonly workspacePublicId: string;
  readonly agentPublicId: string;
}) {
  if (!validPage(args)) return domainFailure("VALIDATION_ERROR", args.requestId);
  const authorized = await authorizeWorkspaceHuman(ctx, {
    requestId: args.requestId,
    workspacePublicId: args.workspacePublicId,
  });
  if (!authorized.ok) return authorized;
  const resolved = await resolveAdminAgent(ctx, {
    organizationId: authorized.authorization.organization._id,
    workspace: authorized.authorization.workspace,
    agentPublicId: args.agentPublicId,
  });
  if (resolved === null) return domainFailure("NOT_FOUND", args.requestId);
  if (resolved.agent.status === "disabled") {
    return {
      ok: true as const,
      data: { sessions: [], cursor: null },
      requestId: args.requestId,
    };
  }
  const page = await ctx.db
    .query("agentSessions")
    .withIndex("by_workspace_agent_and_status", (query) =>
      query
        .eq("workspaceId", authorized.authorization.workspace._id)
        .eq("agentId", resolved.agent._id)
        .eq("status", "active"),
    )
    .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
  const now = Date.now();
  const sessions = [];
  for (const session of page.page) {
    if (
      session.organizationId !== authorized.authorization.organization._id ||
      session.idleExpiresAt <= now
    ) {
      continue;
    }
    const credential = await ctx.db.get(session.credentialId);
    if (
      credential === null ||
      credential.organizationId !== authorized.authorization.organization._id ||
      credential.workspaceId !== authorized.authorization.workspace._id ||
      credential.agentId !== resolved.agent._id ||
      credential.status !== "active" ||
      credential.expiresAt <= now
    ) {
      continue;
    }
    sessions.push({
      agentId: resolved.agent.publicId,
      workspaceId: authorized.authorization.workspace.publicId,
      credentialId: credential.locator,
      status: "active" as const,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      idleExpiresAt: session.idleExpiresAt,
    });
  }
  return {
    ok: true as const,
    data: { sessions, cursor: pageCursor(page) },
    requestId: args.requestId,
  };
}

export async function listWorkspaceMembersForHuman(ctx: HumanAdminReadCtx, args: PageArgs & {
  readonly workspacePublicId: string;
}) {
  if (!validPage(args)) return domainFailure("VALIDATION_ERROR", args.requestId);
  const authorized = await authorizeWorkspaceHuman(ctx, {
    requestId: args.requestId,
    workspacePublicId: args.workspacePublicId,
    requireOrganizationAdmin: true,
  });
  if (!authorized.ok) return authorized;
  const page = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_organization_status_and_user", (query) =>
      query
        .eq("organizationId", authorized.authorization.organization._id)
        .eq("status", "active"),
    )
    .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
  const members = [];
  for (const organizationMembership of page.page) {
    const user = await ctx.db.get(organizationMembership.userId);
    if (user === null || user.status !== "active") continue;
    const workspaceMembership = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_workspace_and_user", (query) =>
        query
          .eq("workspaceId", authorized.authorization.workspace._id)
          .eq("userId", user._id),
      )
      .unique();
    members.push({
      id: user.publicId,
      name: user.name,
      ...(user.email === undefined ? {} : { email: user.email }),
      organizationRole: organizationMembership.role,
      workspaceAccess:
        workspaceMembership !== null && workspaceMembership.status === "active"
          ? { status: "active" as const, roles: workspaceMembership.roles }
          : { status: "none" as const, roles: [] },
    });
  }
  return {
    ok: true as const,
    data: { members, cursor: pageCursor(page) },
    requestId: args.requestId,
  };
}

async function revokeCredentialSessionBatch(
  ctx: MutationCtx,
  credentialId: Id<"agentCredentials">,
  revokedAt: number,
): Promise<boolean> {
  const sessions = await ctx.db
    .query("agentSessions")
    .withIndex("by_credential_and_status", (query) =>
      query.eq("credentialId", credentialId).eq("status", "active"),
    )
    .take(CREDENTIAL_SESSION_REVOCATION_BATCH);
  for (const session of sessions) {
    await ctx.db.patch(session._id, { status: "revoked", revokedAt });
  }
  return sessions.length === CREDENTIAL_SESSION_REVOCATION_BATCH;
}

export async function revokeAgentCredentialForHuman(ctx: MutationCtx, args: {
  readonly workspacePublicId: string;
  readonly agentPublicId: string;
  readonly credentialLocator: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly requestId: string;
}) {
  const now = Date.now();
  const metadata = assertRequestMetadata({ ...args, now });
  if (!metadata.ok) return { ok: false as const, error: metadata.error };
  const authorized = await authorizeWorkspaceHuman(ctx, {
    requestId: args.requestId,
    workspacePublicId: args.workspacePublicId,
    requireOrganizationAdmin: true,
  });
  if (!authorized.ok) return authorized;
  const identity = {
    kind: "organization" as const,
    principalId: authorized.authorization.subject,
    organizationId: authorized.authorization.organization._id,
  };
  const receipt = await lookupHumanReceipt(ctx, {
    identity,
    operation: "agents.credentials.revoke",
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    parse: parseWithSchema(revokeAgentCredentialResponseSchema),
  });
  if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
  if (receipt.kind === "replay") {
    return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
  }
  const resolved = await resolveAdminAgent(ctx, {
    organizationId: authorized.authorization.organization._id,
    workspace: authorized.authorization.workspace,
    agentPublicId: args.agentPublicId,
  });
  if (resolved === null) return domainFailure("NOT_FOUND", args.requestId);
  const credential = await ctx.db
    .query("agentCredentials")
    .withIndex("by_locator", (query) => query.eq("locator", args.credentialLocator))
    .unique();
  if (
    credential === null ||
    credential.organizationId !== authorized.authorization.organization._id ||
    credential.workspaceId !== authorized.authorization.workspace._id ||
    credential.agentId !== resolved.agent._id
  ) {
    return domainFailure("NOT_FOUND", args.requestId);
  }
  if (credential.status !== "revoked") {
    await ctx.db.patch(credential._id, { status: "revoked", revokedAt: now });
  }
  const revokedAt = credential.status === "revoked" ? credential.revokedAt : now;
  if (revokedAt === undefined) return domainFailure("INTERNAL_ERROR", args.requestId);
  const sessionsRemain = await revokeCredentialSessionBatch(ctx, credential._id, revokedAt);
  if (sessionsRemain) {
    await ctx.scheduler.runAfter(
      0,
      internal.humanTenancy.cleanupRevokedCredentialSessions,
      { credentialId: credential._id, revokedAt },
    );
  }
  const data = {
    credential: {
      id: credential.locator,
      agentId: resolved.agent.publicId,
      workspaceId: authorized.authorization.workspace.publicId,
      scopes: credential.scopes,
      status: "revoked" as const,
      createdAt: credential.createdAt,
      expiresAt: credential.expiresAt,
      lastUsedAt: credential.lastUsedAt,
      revokedAt,
    },
  };
  await appendSecurityEvent(ctx, {
    organizationId: authorized.authorization.organization._id,
    workspaceId: authorized.authorization.workspace._id,
    agentId: resolved.agent._id,
    type: "agent.credential_revoked",
    actor: { kind: "human", userId: authorized.authorization.user.publicId },
    command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
    payload: { credentialId: credential.locator },
    now,
  });
  await storeHumanReceipt(ctx, {
    identity,
    operation: "agents.credentials.revoke",
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    data,
    now,
  });
  return { ok: true as const, data, requestId: args.requestId };
}

export async function disableAgentForHuman(ctx: MutationCtx, args: {
  readonly workspacePublicId: string;
  readonly agentPublicId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly requestId: string;
}) {
  const now = Date.now();
  const metadata = assertRequestMetadata({ ...args, now });
  if (!metadata.ok) return { ok: false as const, error: metadata.error };
  const authorized = await authorizeWorkspaceHuman(ctx, {
    requestId: args.requestId,
    workspacePublicId: args.workspacePublicId,
    requireOrganizationAdmin: true,
  });
  if (!authorized.ok) return authorized;
  const identity = {
    kind: "organization" as const,
    principalId: authorized.authorization.subject,
    organizationId: authorized.authorization.organization._id,
  };
  const receipt = await lookupHumanReceipt(ctx, {
    identity,
    operation: "agents.disable",
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    parse: parseWithSchema(disableAgentResponseSchema),
  });
  if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
  if (receipt.kind === "replay") {
    return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
  }
  const resolved = await resolveAdminAgent(ctx, {
    organizationId: authorized.authorization.organization._id,
    workspace: authorized.authorization.workspace,
    agentPublicId: args.agentPublicId,
  });
  if (resolved === null) return domainFailure("NOT_FOUND", args.requestId);
  const grants = await ctx.db
    .query("agentWorkspaceGrants")
    .withIndex("by_agent_and_workspace", (query) => query.eq("agentId", resolved.agent._id))
    .take(2);
  if (grants.length > 1) return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
  const usage = await ctx.db
    .query("workspaceUsage")
    .withIndex("by_workspace", (query) =>
      query.eq("workspaceId", authorized.authorization.workspace._id),
    )
    .unique();
  if (usage === null) return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
  const updatedAt = resolved.agent.status === "disabled" ? resolved.agent.updatedAt : now;
  if (resolved.agent.status !== "disabled") {
    if (usage.activeAgents <= 0) return domainFailure("INTERNAL_ERROR", args.requestId);
    await ctx.db.patch(resolved.agent._id, { status: "disabled", updatedAt });
    await ctx.db.patch(usage._id, {
      activeAgents: usage.activeAgents - 1,
      updatedAt,
    });
  }
  const data = {
    agent: {
      ...lifecycleAgentView(resolved.agent, authorized.authorization.workspace, resolved.grant),
      status: "disabled" as const,
      updatedAt: Math.max(updatedAt, resolved.grant.updatedAt),
    },
  };
  await appendSecurityEvent(ctx, {
    organizationId: authorized.authorization.organization._id,
    workspaceId: authorized.authorization.workspace._id,
    agentId: resolved.agent._id,
    type: "agent.disabled",
    actor: { kind: "human", userId: authorized.authorization.user.publicId },
    command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
    now,
  });
  await storeHumanReceipt(ctx, {
    identity,
    operation: "agents.disable",
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    data,
    now,
  });
  return { ok: true as const, data, requestId: args.requestId };
}

export async function setWorkspaceRolesForHuman(ctx: MutationCtx, args: {
  readonly workspacePublicId: string;
  readonly userPublicId: string;
  readonly roles: WorkspaceRole[];
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly requestId: string;
}) {
  const now = Date.now();
  const metadata = assertRequestMetadata({ ...args, now });
  if (!metadata.ok) return { ok: false as const, error: metadata.error };
  if (
    args.roles.length > ALL_WORKSPACE_ROLES.length ||
    new Set(args.roles).size !== args.roles.length ||
    !args.roles.every((role) => ALL_WORKSPACE_ROLES.includes(role))
  ) {
    return domainFailure("VALIDATION_ERROR", args.requestId);
  }
  const authorized = await authorizeWorkspaceHuman(ctx, {
    requestId: args.requestId,
    workspacePublicId: args.workspacePublicId,
    requireOrganizationAdmin: true,
  });
  if (!authorized.ok) return authorized;
  const identity = {
    kind: "organization" as const,
    principalId: authorized.authorization.subject,
    organizationId: authorized.authorization.organization._id,
  };
  const parseMemberResponse = (value: unknown) => {
    if (typeof value !== "object" || value === null || !("member" in value)) return null;
    const candidate = value.member;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("id" in candidate) ||
      typeof candidate.id !== "string" ||
      !("name" in candidate) ||
      typeof candidate.name !== "string" ||
      !("organizationRole" in candidate) ||
      !["owner", "admin", "member"].includes(String(candidate.organizationRole)) ||
      !("workspaceAccess" in candidate) ||
      typeof candidate.workspaceAccess !== "object" ||
      candidate.workspaceAccess === null ||
      !("status" in candidate.workspaceAccess) ||
      !["active", "none"].includes(String(candidate.workspaceAccess.status)) ||
      !("roles" in candidate.workspaceAccess) ||
      !Array.isArray(candidate.workspaceAccess.roles) ||
      !candidate.workspaceAccess.roles.every(
        (role) => typeof role === "string" && ALL_WORKSPACE_ROLES.includes(role as WorkspaceRole),
      )
    ) {
      return null;
    }
    return value as {
      member: {
        id: string;
        name: string;
        email?: string;
        organizationRole: "owner" | "admin" | "member";
        workspaceAccess:
          | { status: "active"; roles: WorkspaceRole[] }
          | { status: "none"; roles: WorkspaceRole[] };
      };
    };
  };
  const receipt = await lookupHumanReceipt(ctx, {
    identity,
    operation: "workspace.roles.set",
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    parse: parseMemberResponse,
  });
  if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
  if (receipt.kind === "replay") {
    return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_public_id", (query) => query.eq("publicId", args.userPublicId))
    .unique();
  if (user === null || user.status !== "active") return domainFailure("NOT_FOUND", args.requestId);
  const organizationMembership = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_organization_and_user", (query) =>
      query
        .eq("organizationId", authorized.authorization.organization._id)
        .eq("userId", user._id),
    )
    .unique();
  if (organizationMembership === null || organizationMembership.status !== "active") {
    return domainFailure("NOT_FOUND", args.requestId);
  }
  const workspaceMembership = await ctx.db
    .query("workspaceMemberships")
    .withIndex("by_workspace_and_user", (query) =>
      query.eq("workspaceId", authorized.authorization.workspace._id).eq("userId", user._id),
    )
    .unique();
  const status = args.roles.length === 0 ? ("removed" as const) : ("active" as const);
  if (workspaceMembership === null) {
    await ctx.db.insert("workspaceMemberships", {
      organizationId: authorized.authorization.organization._id,
      workspaceId: authorized.authorization.workspace._id,
      userId: user._id,
      roles: args.roles,
      status,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    if (
      workspaceMembership.organizationId !== authorized.authorization.organization._id ||
      workspaceMembership.userId !== user._id
    ) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    await ctx.db.patch(workspaceMembership._id, { roles: args.roles, status, updatedAt: now });
  }
  const data = {
    member: {
      id: user.publicId,
      name: user.name,
      ...(user.email === undefined ? {} : { email: user.email }),
      organizationRole: organizationMembership.role,
      workspaceAccess:
        status === "active"
          ? { status: "active" as const, roles: args.roles }
          : { status: "none" as const, roles: [] },
    },
  };
  await appendSecurityEvent(ctx, {
    organizationId: authorized.authorization.organization._id,
    workspaceId: authorized.authorization.workspace._id,
    type: "workspace.membership_roles_set",
    actor: { kind: "human", userId: authorized.authorization.user.publicId },
    command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
    payload: { memberId: user.publicId, roles: args.roles, status },
    now,
  });
  await storeHumanReceipt(ctx, {
    identity,
    operation: "workspace.roles.set",
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    data,
    now,
  });
  return { ok: true as const, data, requestId: args.requestId };
}

export const cleanupRevokedCredentialSessions = internalMutation({
  args: { credentialId: v.id("agentCredentials"), revokedAt: v.number() },
  returns: v.object({ updated: v.number(), complete: v.boolean() }),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.credentialId);
    if (
      credential === null ||
      credential.status !== "revoked" ||
      credential.revokedAt !== args.revokedAt
    ) {
      return { updated: 0, complete: true };
    }
    const sessions = await ctx.db
      .query("agentSessions")
      .withIndex("by_credential_and_status", (query) =>
        query.eq("credentialId", credential._id).eq("status", "active"),
      )
      .take(CREDENTIAL_SESSION_REVOCATION_BATCH);
    for (const session of sessions) {
      await ctx.db.patch(session._id, { status: "revoked", revokedAt: args.revokedAt });
    }
    if (sessions.length === CREDENTIAL_SESSION_REVOCATION_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.humanTenancy.cleanupRevokedCredentialSessions,
        args,
      );
    }
    return {
      updated: sessions.length,
      complete: sessions.length < CREDENTIAL_SESSION_REVOCATION_BATCH,
    };
  },
});

export const listAgents = internalQuery({
  args: {
    workspacePublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: listAgentsResultValidator,
  handler: listAgentsForHuman,
});

export const getAgent = internalQuery({
  args: { workspacePublicId: v.string(), agentPublicId: v.string(), requestId: v.string() },
  returns: getAgentResultValidator,
  handler: getAgentForHuman,
});

export const listAgentCredentials = internalQuery({
  args: {
    workspacePublicId: v.string(),
    agentPublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: listAgentCredentialsResultValidator,
  handler: listAgentCredentialsForHuman,
});

export const listAgentSessions = internalQuery({
  args: {
    workspacePublicId: v.string(),
    agentPublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: listAgentSessionsResultValidator,
  handler: listAgentSessionsForHuman,
});

export const listWorkspaceMembers = internalQuery({
  args: {
    workspacePublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: listWorkspaceMembersResultValidator,
  handler: listWorkspaceMembersForHuman,
});

export const revokeAgentCredential = internalMutation({
  args: {
    workspacePublicId: v.string(),
    agentPublicId: v.string(),
    credentialLocator: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: revokeAgentCredentialResultValidator,
  handler: revokeAgentCredentialForHuman,
});

export const disableAgent = internalMutation({
  args: {
    workspacePublicId: v.string(),
    agentPublicId: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: disableAgentResultValidator,
  handler: disableAgentForHuman,
});

export const setWorkspaceRoles = internalMutation({
  args: {
    workspacePublicId: v.string(),
    userPublicId: v.string(),
    roles: v.array(workspaceRoleValidator),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: setWorkspaceRolesResultValidator,
  handler: setWorkspaceRolesForHuman,
});

/** Convex-owned organization list for an authenticated account. */
export const listOrganizationsOwned = internalQuery({
  args: { cursor: v.optional(v.string()), limit: v.number(), requestId: v.string() },
  returns: listOrganizationsResultValidator,
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100 ||
      (args.cursor !== undefined && (args.cursor.length === 0 || args.cursor.length > 8_192))
    ) return domainFailure("VALIDATION_ERROR", args.requestId);
    const identified = await readHumanIdentity(ctx, args.requestId, false);
    if (!identified.ok) return identified;
    const page = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_user_and_organization", (index) =>
        index.eq("userId", identified.identity.userId))
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    const organizations = [];
    for (const membership of page.page) {
      if (membership.status !== "active") continue;
      const organization = await ctx.db.get(membership.organizationId);
      if (organization === null || organization.status !== "active") continue;
      organizations.push({
        id: organization.publicId,
        name: organization.name,
        role: membership.role,
        status: "active" as const,
      });
    }
    return {
      ok: true as const,
      data: { organizations, cursor: page.isDone ? null : page.continueCursor },
      requestId: args.requestId,
    };
  },
});

/** Creates the organization and owner membership in one Convex transaction. */
export const createOrganizationOwned = internalMutation({
  args: {
    name: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: createOrganizationResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const identified = await readHumanIdentity(ctx, args.requestId, false);
    if (!identified.ok) return identified;
    const parsedName = organizationNameSchema.safeParse(args.name);
    if (!parsedName.success) return domainFailure("VALIDATION_ERROR", args.requestId);
    const user = await ctx.db.get(identified.identity.userId);
    if (user === null || user.status !== "active") {
      return domainFailure("AUTHENTICATION_FAILED", args.requestId);
    }
    const identity = { kind: "account" as const, principalId: user.publicId };
    const receipt = await lookupHumanReceipt(ctx, {
      identity,
      operation: "organizations.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseWithSchema(createOrganizationResponseSchema),
    });
    if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const organizationId = await ctx.db.insert("organizations", {
      publicId: randomHumanId("org"),
      name: parsedName.data,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("organizationMemberships", {
      organizationId,
      userId: user._id,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const data = {
      organization: {
        id: (await ctx.db.get(organizationId))!.publicId,
        name: parsedName.data,
        role: "owner" as const,
        status: "active" as const,
      },
    };
    await storeHumanReceipt(ctx, {
      identity,
      operation: "organizations.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});
