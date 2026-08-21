import {
  desktopPairingChallengeSchema,
  desktopPairingIdSchema,
  desktopPairingVerifierSchema,
  organizationIdSchema,
  workspaceIdSchema,
  type WorkspaceRole,
} from "@hraness/agent-tasks-protocol";
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { randomCrockford } from "./domain";
import { sha256Base64Url } from "./crypto";
import {
  AUTH_SCOPE_ROTATION_LIFETIME_MS,
  AUTH_SESSION_TOTAL_DURATION_MS,
  PASSWORD_PAIRING_APPROVAL_WINDOW_MS,
} from "./authPolicy";

const PAIRING_LIFETIME_MS = 10 * 60 * 1_000;
const PAIRING_POLL_INTERVAL_MS = 2_000;
const PAIRING_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_PAIRING_WORKSPACES_PER_ORGANIZATION = 512;
const ALL_WORKSPACE_ROLES = ["planner", "reviewer", "viewer"] as const;

type ReadCtx = QueryCtx | MutationCtx;

async function activeAuthSession(ctx: ReadCtx) {
  let userId: Id<"users"> | null;
  let sessionId: Id<"authSessions"> | null;
  try {
    [userId, sessionId] = await Promise.all([
      getAuthUserId(ctx),
      getAuthSessionId(ctx),
    ]);
  } catch {
    return null;
  }
  if (userId === null || sessionId === null) return null;
  const [user, session] = await Promise.all([
    ctx.db.get(userId),
    ctx.db.get(sessionId),
  ]);
  return user !== null && user.status === "active" &&
      session !== null && session.userId === user._id && session.expirationTime > Date.now()
    ? { user, session }
    : null;
}

async function passwordOriginSession(ctx: ReadCtx) {
  const authenticated = await activeAuthSession(ctx);
  if (authenticated === null) return null;
  const proof = await ctx.db
    .query("passwordSessionProofs")
    .withIndex("by_session", (index) => index.eq("sessionId", authenticated.session._id))
    .unique();
  return proof !== null && proof.userId === authenticated.user._id &&
      proof.authenticatedAt <= Date.now() &&
      proof.expiresAt === authenticated.session.expirationTime &&
      proof.expiresAt > Date.now()
    ? { ...authenticated, passwordAuthenticatedAt: proof.authenticatedAt }
    : null;
}

async function activeRecentPasswordSession(ctx: ReadCtx) {
  const authenticated = await passwordOriginSession(ctx);
  if (authenticated === null) return null;
  return authenticated.passwordAuthenticatedAt + PASSWORD_PAIRING_APPROVAL_WINDOW_MS > Date.now()
    ? authenticated
    : null;
}

const pairingStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("consumed"),
  v.literal("denied"),
  v.literal("expired"),
);

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

const organizationViewValidator = v.object({
  id: v.string(),
  name: v.string(),
  role: organizationRoleValidator,
  status: v.literal("active"),
});

const workspaceViewValidator = v.object({
  id: v.string(),
  organizationId: v.string(),
  slug: v.string(),
  name: v.string(),
  taskKeyPrefix: v.string(),
  roles: v.array(workspaceRoleValidator),
});

function logicalPairingStatus(
  request: Doc<"desktopPairingRequests">,
  now: number,
): Doc<"desktopPairingRequests">["status"] {
  return request.status === "pending" || request.status === "approved"
    ? request.expiresAt <= now ? "expired" : request.status
    : request.status;
}

async function pairingByPublicId(ctx: ReadCtx, pairingId: string) {
  return await ctx.db
    .query("desktopPairingRequests")
    .withIndex("by_pairing_id", (index) => index.eq("pairingId", pairingId))
    .unique();
}

async function activeOrganizationMembership(
  ctx: ReadCtx,
  userId: Id<"users">,
  organizationId: Id<"organizations">,
) {
  const membership = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_organization_and_user", (index) =>
      index.eq("organizationId", organizationId).eq("userId", userId))
    .unique();
  return membership?.status === "active" ? membership : null;
}

async function workspaceRoles(
  ctx: ReadCtx,
  userId: Id<"users">,
  organizationMembership: Doc<"organizationMemberships">,
  workspace: Doc<"workspaces">,
): Promise<readonly WorkspaceRole[] | null> {
  if (
    organizationMembership.role === "owner" ||
    organizationMembership.role === "admin"
  ) {
    return ALL_WORKSPACE_ROLES;
  }
  const membership = await ctx.db
    .query("workspaceMemberships")
    .withIndex("by_workspace_and_user", (index) =>
      index.eq("workspaceId", workspace._id).eq("userId", userId))
    .unique();
  return membership?.status === "active" ? membership.roles : null;
}

async function resolveSelection(
  ctx: ReadCtx,
  args: {
    userId: Id<"users">;
    organizationPublicId: string;
    workspacePublicId?: string;
  },
) {
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_public_id", (index) => index.eq("publicId", args.organizationPublicId))
    .unique();
  if (organization === null || organization.status !== "active") return null;
  const organizationMembership = await activeOrganizationMembership(
    ctx,
    args.userId,
    organization._id,
  );
  if (organizationMembership === null) return null;
  if (args.workspacePublicId === undefined) {
    return { organization, organizationMembership };
  }
  const workspacePublicId = args.workspacePublicId;
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_public_id", (index) => index.eq("publicId", workspacePublicId))
    .unique();
  if (
    workspace === null ||
    workspace.organizationId !== organization._id ||
    workspace.status !== "active"
  ) return null;
  const roles = await workspaceRoles(ctx, args.userId, organizationMembership, workspace);
  if (roles === null) return null;
  return { organization, organizationMembership, workspace, roles };
}

async function writeSessionSelection(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"authSessions">;
    userId: Id<"users">;
    organizationId: Id<"organizations">;
    workspaceId?: Id<"workspaces">;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("authSessionSelections")
    .withIndex("by_session", (index) => index.eq("sessionId", args.sessionId))
    .unique();
  if (existing === null) {
    await ctx.db.insert("authSessionSelections", {
      sessionId: args.sessionId,
      userId: args.userId,
      organizationId: args.organizationId,
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
      createdAt: args.now,
      updatedAt: args.now,
    });
    return;
  }
  await ctx.db.patch(existing._id, {
    userId: args.userId,
    organizationId: args.organizationId,
    workspaceId: args.workspaceId,
    updatedAt: args.now,
  });
}

export const start = internalMutation({
  args: { challenge: v.string() },
  returns: v.object({
    pairingId: v.string(),
    comparisonCode: v.string(),
    expiresAt: v.number(),
    pollIntervalMs: v.number(),
  }),
  handler: async (ctx, args) => {
    const challenge = desktopPairingChallengeSchema.parse(args.challenge);
    let pairingId: string | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = desktopPairingIdSchema.parse(`pair_${randomCrockford(26)}`);
      if (await pairingByPublicId(ctx, candidate) === null) {
        pairingId = candidate;
        break;
      }
    }
    if (pairingId === null) throw new Error("Unable to allocate a desktop pairing request.");
    const rawCode = randomCrockford(8);
    const comparisonCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`;
    const now = Date.now();
    const expiresAt = now + PAIRING_LIFETIME_MS;
    await ctx.db.insert("desktopPairingRequests", {
      pairingId,
      challenge,
      comparisonCode,
      status: "pending",
      createdAt: now,
      expiresAt,
    });
    return { pairingId, comparisonCode, expiresAt, pollIntervalMs: PAIRING_POLL_INTERVAL_MS };
  },
});

export const createPasswordSession = internalMutation({
  args: {
    userId: v.id("users"),
    replacedSessionId: v.optional(v.id("authSessions")),
  },
  returns: v.object({ userId: v.id("users"), sessionId: v.id("authSessions") }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (user === null || user.status !== "active") {
      throw new Error("This HRA account is unavailable.");
    }
    if (args.replacedSessionId !== undefined) {
      const [refreshTokens, selection, proof] = await Promise.all([
        ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (index) => index.eq("sessionId", args.replacedSessionId!))
          .collect(),
        ctx.db
          .query("authSessionSelections")
          .withIndex("by_session", (index) => index.eq("sessionId", args.replacedSessionId!))
          .unique(),
        ctx.db
          .query("passwordSessionProofs")
          .withIndex("by_session", (index) => index.eq("sessionId", args.replacedSessionId!))
          .unique(),
      ]);
      for (const token of refreshTokens) await ctx.db.delete(token._id);
      if (selection !== null) await ctx.db.delete(selection._id);
      if (proof !== null) await ctx.db.delete(proof._id);
      if (await ctx.db.get(args.replacedSessionId) !== null) {
        await ctx.db.delete(args.replacedSessionId);
      }
    }
    const now = Date.now();
    const expirationTime = now + AUTH_SESSION_TOTAL_DURATION_MS;
    const sessionId = await ctx.db.insert("authSessions", {
      userId: user._id,
      expirationTime,
    });
    await ctx.db.insert("passwordSessionProofs", {
      sessionId,
      userId: user._id,
      authenticatedAt: now,
      expiresAt: expirationTime,
    });
    return { userId: user._id, sessionId };
  },
});

export const retireExpired = internalMutation({
  args: { selectionCursor: v.optional(v.string()) },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const [
      pairingRows,
      rotationRows,
      migrationRows,
      passwordProofRows,
      signUpReservationRows,
      selectionPage,
    ] = await Promise.all([
      ctx.db
      .query("desktopPairingRequests")
      .withIndex("by_expiry", (index) =>
        index.lte("expiresAt", Date.now() - PAIRING_RETENTION_MS))
      .take(129),
      ctx.db
        .query("authSessionRotationRequests")
        .withIndex("by_expiry", (index) => index.lte("expiresAt", Date.now()))
        .take(129),
      ctx.db
        .query("passwordMigrationClaims")
        .withIndex("by_expiry", (index) => index.lte("expiresAt", Date.now()))
        .take(129),
      ctx.db
        .query("passwordSessionProofs")
        .withIndex("by_expiry", (index) => index.lte("expiresAt", Date.now()))
        .take(129),
      ctx.db
        .query("passwordSignUpReservations")
        .withIndex("by_expiry", (index) => index.lte("expiresAt", Date.now()))
        .take(129),
      ctx.db.query("authSessionSelections").paginate({
        cursor: args.selectionCursor ?? null,
        numItems: 128,
      }),
    ]);
    const pairingBatch = pairingRows.slice(0, 128);
    const rotationBatch = rotationRows.slice(0, 128);
    const migrationBatch = migrationRows.slice(0, 128);
    const passwordProofBatch = passwordProofRows.slice(0, 128);
    const signUpReservationBatch = signUpReservationRows.slice(0, 128);
    for (const row of pairingBatch) await ctx.db.delete(row._id);
    for (const row of rotationBatch) await ctx.db.delete(row._id);
    for (const row of migrationBatch) await ctx.db.delete(row._id);
    for (const row of passwordProofBatch) await ctx.db.delete(row._id);
    for (const row of signUpReservationBatch) await ctx.db.delete(row._id);
    let orphanSelections = 0;
    for (const selection of selectionPage.page) {
      if (await ctx.db.get(selection.sessionId) !== null) continue;
      await ctx.db.delete(selection._id);
      orphanSelections += 1;
    }
    const indexedHasMore =
      pairingRows.length > 128 || rotationRows.length > 128 || migrationRows.length > 128 ||
      passwordProofRows.length > 128 || signUpReservationRows.length > 128;
    const hasMore = indexedHasMore || !selectionPage.isDone;
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.desktopPairing.retireExpired, {
        ...(!selectionPage.isDone
          ? { selectionCursor: selectionPage.continueCursor }
          : {}),
      });
    }
    return {
      deleted:
        pairingBatch.length + rotationBatch.length + migrationBatch.length +
        passwordProofBatch.length + signUpReservationBatch.length + orphanSelections,
      hasMore,
    };
  },
});

export const readCredentialChallenge = internalQuery({
  args: { pairingId: v.string() },
  returns: v.union(v.object({ challenge: v.string() }), v.null()),
  handler: async (ctx, args) => {
    if (!desktopPairingIdSchema.safeParse(args.pairingId).success) return null;
    const request = await pairingByPublicId(ctx, args.pairingId);
    if (request === null || logicalPairingStatus(request, Date.now()) !== "approved") return null;
    return { challenge: request.challenge };
  },
});

export const status = internalQuery({
  args: { pairingId: v.string() },
  returns: v.union(
    v.object({ status: pairingStatusValidator, retryAfterMs: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    if (!desktopPairingIdSchema.safeParse(args.pairingId).success) return null;
    const request = await pairingByPublicId(ctx, args.pairingId);
    return request === null
      ? null
      : { status: logicalPairingStatus(request, Date.now()), retryAfterMs: PAIRING_POLL_INTERVAL_MS };
  },
});

export const consumeApproved = internalMutation({
  args: { pairingId: v.string(), expectedChallenge: v.string() },
  returns: v.union(
    v.object({ userId: v.id("users"), sessionId: v.id("authSessions") }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    if (
      !desktopPairingIdSchema.safeParse(args.pairingId).success ||
      !desktopPairingChallengeSchema.safeParse(args.expectedChallenge).success
    ) return null;
    const request = await pairingByPublicId(ctx, args.pairingId);
    const now = Date.now();
    if (request === null) return null;
    if (request.expiresAt <= now && (request.status === "pending" || request.status === "approved")) {
      await ctx.db.patch(request._id, { status: "expired" });
      return null;
    }
    if (
      request.status !== "approved" ||
      request.challenge !== args.expectedChallenge ||
      request.userId === undefined ||
      request.organizationId === undefined ||
      request.workspaceId === undefined
    ) return null;
    const [user, organization, workspace] = await Promise.all([
      ctx.db.get(request.userId),
      ctx.db.get(request.organizationId),
      ctx.db.get(request.workspaceId),
    ]);
    if (
      user === null || user.status !== "active" || user.email === undefined ||
      organization === null || organization.status !== "active" ||
      workspace === null || workspace.status !== "active" ||
      workspace.organizationId !== organization._id
    ) return null;
    const organizationMembership = await activeOrganizationMembership(
      ctx,
      user._id,
      organization._id,
    );
    if (organizationMembership === null) return null;
    if (await workspaceRoles(ctx, user._id, organizationMembership, workspace) === null) return null;

    // ConvexCredentials explicitly accepts an existing sessionId. We create it
    // only after reapplying this app's active-user beforeSessionCreation law and
    // exact configured duration; Convex Auth then owns JWT and refresh issuance.
    // A lost token response leaves this one-time request consumed and fails closed.
    const sessionId = await ctx.db.insert("authSessions", {
      userId: user._id,
      expirationTime: now + AUTH_SESSION_TOTAL_DURATION_MS,
    });
    await writeSessionSelection(ctx, {
      sessionId,
      userId: user._id,
      organizationId: organization._id,
      workspaceId: workspace._id,
      now,
    });
    await ctx.db.patch(request._id, {
      status: "consumed",
      authSessionId: sessionId,
      consumedAt: now,
    });
    return { userId: user._id, sessionId };
  },
});

export const approvalContext = query({
  args: { pairingId: v.string() },
  returns: v.union(
    v.object({
      pairingId: v.string(),
      comparisonCode: v.string(),
      expiresAt: v.number(),
      status: pairingStatusValidator,
      organizations: v.array(v.object({
        organization: organizationViewValidator,
        workspaces: v.array(workspaceViewValidator),
        workspacesComplete: v.boolean(),
      })),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const authenticated = await activeRecentPasswordSession(ctx);
    if (authenticated === null || !desktopPairingIdSchema.safeParse(args.pairingId).success) {
      return null;
    }
    const userId = authenticated.user._id;
    const request = await pairingByPublicId(ctx, args.pairingId);
    if (request === null) return null;
    const memberships = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_user_and_organization", (index) => index.eq("userId", userId))
      .collect();
    const organizations = [];
    for (const membership of memberships) {
      if (membership.status !== "active") continue;
      const organization = await ctx.db.get(membership.organizationId);
      if (organization === null || organization.status !== "active") continue;
      const workspaces = await ctx.db
        .query("workspaces")
        .withIndex("by_organization_status_and_public_id", (index) =>
          index.eq("organizationId", organization._id).eq("status", "active"))
        .take(MAX_PAIRING_WORKSPACES_PER_ORGANIZATION + 1);
      const workspacesComplete = workspaces.length <= MAX_PAIRING_WORKSPACES_PER_ORGANIZATION;
      const visibleWorkspaces = [];
      for (const workspace of workspacesComplete ? workspaces : []) {
        const roles = await workspaceRoles(ctx, userId, membership, workspace);
        if (roles === null) continue;
        visibleWorkspaces.push({
          id: workspace.publicId,
          organizationId: organization.publicId,
          slug: workspace.slug,
          name: workspace.name,
          taskKeyPrefix: workspace.taskKeyPrefix,
          roles: [...roles],
        });
      }
      organizations.push({
        organization: {
          id: organization.publicId,
          name: organization.name,
          role: membership.role,
          status: "active" as const,
        },
        workspaces: visibleWorkspaces,
        workspacesComplete,
      });
    }
    return {
      pairingId: request.pairingId,
      comparisonCode: request.comparisonCode,
      expiresAt: request.expiresAt,
      status: logicalPairingStatus(request, Date.now()),
      organizations,
    };
  },
});

export const accountScopes = query({
  args: {},
  returns: v.union(
    v.object({
      user: v.object({ id: v.string(), email: v.optional(v.string()), name: v.optional(v.string()) }),
      selectedOrganizationId: v.optional(v.string()),
      selectedWorkspaceId: v.optional(v.string()),
      organizations: v.array(organizationViewValidator),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const authenticated = await activeAuthSession(ctx);
    if (authenticated === null) return null;
    const user = authenticated.user;
    const userId = user._id;
    const sessionId = authenticated.session._id;
    const selection = await ctx.db
      .query("authSessionSelections")
      .withIndex("by_session", (index) => index.eq("sessionId", sessionId))
      .unique();
    if (selection !== null && selection.userId !== user._id) return null;
    const memberships = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_user_and_organization", (index) => index.eq("userId", userId))
      .collect();
    const organizations = [];
    for (const membership of memberships) {
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
    const selectedOrganization = selection === null
      ? null
      : await ctx.db.get(selection.organizationId);
    const selectedWorkspace = selection?.workspaceId === undefined
      ? null
      : await ctx.db.get(selection.workspaceId);
    const selectedMembership = selection === null
      ? null
      : memberships.find((membership) =>
          membership.organizationId === selection.organizationId &&
          membership.status === "active") ?? null;
    const selectedRoles = selectedWorkspace === null || selectedMembership === null
      ? null
      : await workspaceRoles(ctx, user._id, selectedMembership, selectedWorkspace);
    return {
      user: {
        id: user.publicId,
        ...(user.email === undefined ? {} : { email: user.email }),
        ...(user.name === undefined ? {} : { name: user.name }),
      },
      ...(selectedOrganization === null || selectedOrganization.status !== "active" ||
          selectedMembership === null
        ? {}
        : { selectedOrganizationId: selectedOrganization.publicId }),
      ...(selectedOrganization === null || selectedWorkspace === null ||
          selectedMembership === null || selectedRoles === null ||
          selectedWorkspace.status !== "active" ||
          selectedWorkspace.organizationId !== selectedOrganization._id
        ? {}
        : { selectedWorkspaceId: selectedWorkspace.publicId }),
      organizations,
    };
  },
});

export const approve = mutation({
  args: {
    pairingId: v.string(),
    organizationId: v.string(),
    workspaceId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const authenticated = await activeRecentPasswordSession(ctx);
    if (
      authenticated === null ||
      !desktopPairingIdSchema.safeParse(args.pairingId).success ||
      !organizationIdSchema.safeParse(args.organizationId).success ||
      !workspaceIdSchema.safeParse(args.workspaceId).success
    ) return false;
    const userId = authenticated.user._id;
    const selected = await resolveSelection(ctx, {
      userId,
      organizationPublicId: args.organizationId,
      workspacePublicId: args.workspaceId,
    });
    if (selected === null || selected.workspace === undefined) return false;
    const request = await pairingByPublicId(ctx, args.pairingId);
    const now = Date.now();
    if (request === null || request.status !== "pending" || request.expiresAt <= now) {
      if (request !== null && request.status === "pending" && request.expiresAt <= now) {
        await ctx.db.patch(request._id, { status: "expired" });
      }
      return false;
    }
    await ctx.db.patch(request._id, {
      status: "approved",
      userId,
      organizationId: selected.organization._id,
      workspaceId: selected.workspace._id,
      approvedAt: now,
    });
    return true;
  },
});

export const deny = mutation({
  args: { pairingId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const authenticated = await activeRecentPasswordSession(ctx);
    if (authenticated === null || !desktopPairingIdSchema.safeParse(args.pairingId).success) {
      return false;
    }
    const userId = authenticated.user._id;
    const request = await pairingByPublicId(ctx, args.pairingId);
    const now = Date.now();
    if (request === null || request.status !== "pending" || request.expiresAt <= now) {
      if (request !== null && request.status === "pending" && request.expiresAt <= now) {
        await ctx.db.patch(request._id, { status: "expired" });
      }
      return false;
    }
    await ctx.db.patch(request._id, { status: "denied", userId });
    return true;
  },
});

export const prepareScopeRotation = mutation({
  args: { organizationId: v.string(), workspaceId: v.optional(v.string()) },
  returns: v.union(v.object({ credential: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const authenticated = await activeAuthSession(ctx);
    if (
      authenticated === null ||
      !organizationIdSchema.safeParse(args.organizationId).success ||
      (args.workspaceId !== undefined && !workspaceIdSchema.safeParse(args.workspaceId).success)
    ) return null;
    const userId = authenticated.user._id;
    const oldSessionId = authenticated.session._id;
    const selected = await resolveSelection(ctx, {
      userId,
      organizationPublicId: args.organizationId,
      ...(args.workspaceId === undefined ? {} : { workspacePublicId: args.workspaceId }),
    });
    if (selected === null) return null;
    const outstanding = await ctx.db
      .query("authSessionRotationRequests")
      .withIndex("by_old_session", (index) => index.eq("oldSessionId", oldSessionId))
      .take(4);
    for (const request of outstanding) await ctx.db.delete(request._id);
    const credential = `selection_${randomCrockford(52)}`;
    const now = Date.now();
    await ctx.db.insert("authSessionRotationRequests", {
      credentialDigest: await sha256Base64Url(`hra-scope-selection-v1:${credential}`),
      userId,
      oldSessionId,
      organizationId: selected.organization._id,
      ...(selected.workspace === undefined ? {} : { workspaceId: selected.workspace._id }),
      createdAt: now,
      expiresAt: now + AUTH_SCOPE_ROTATION_LIFETIME_MS,
    });
    return { credential };
  },
});

export const consumeScopeRotation = internalMutation({
  args: { credential: v.string() },
  returns: v.union(
    v.object({ userId: v.id("users"), sessionId: v.id("authSessions") }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    if (!/^selection_[0-9A-HJKMNP-TV-Z]{52}$/u.test(args.credential)) return null;
    const credentialDigest = await sha256Base64Url(
      `hra-scope-selection-v1:${args.credential}`,
    );
    const request = await ctx.db
      .query("authSessionRotationRequests")
      .withIndex("by_credential_digest", (index) =>
        index.eq("credentialDigest", credentialDigest))
      .unique();
    const now = Date.now();
    if (request === null || request.expiresAt <= now) return null;
    const [user, oldSession, organization] = await Promise.all([
      ctx.db.get(request.userId),
      ctx.db.get(request.oldSessionId),
      ctx.db.get(request.organizationId),
    ]);
    if (
      user === null || user.status !== "active" || user.email === undefined ||
      oldSession === null || oldSession.userId !== user._id || oldSession.expirationTime <= now ||
      organization === null || organization.status !== "active"
    ) return null;
    const membership = await activeOrganizationMembership(ctx, user._id, organization._id);
    if (membership === null) return null;
    const workspace = request.workspaceId === undefined
      ? null
      : await ctx.db.get(request.workspaceId);
    if (
      request.workspaceId !== undefined && (workspace === null ||
        workspace.organizationId !== organization._id || workspace.status !== "active" ||
        await workspaceRoles(ctx, user._id, membership, workspace) === null
      )
    ) return null;

    const sessionId = await ctx.db.insert("authSessions", {
      userId: user._id,
      expirationTime: now + AUTH_SESSION_TOTAL_DURATION_MS,
    });
    await writeSessionSelection(ctx, {
      sessionId,
      userId: user._id,
      organizationId: organization._id,
      ...(workspace === null ? {} : { workspaceId: workspace._id }),
      now,
    });
    const refreshTokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (index) => index.eq("sessionId", oldSession._id))
      .collect();
    for (const token of refreshTokens) await ctx.db.delete(token._id);
    const oldSelection = await ctx.db
      .query("authSessionSelections")
      .withIndex("by_session", (index) => index.eq("sessionId", oldSession._id))
      .unique();
    const oldPasswordProof = await ctx.db
      .query("passwordSessionProofs")
      .withIndex("by_session", (index) => index.eq("sessionId", oldSession._id))
      .unique();
    if (oldSelection !== null) await ctx.db.delete(oldSelection._id);
    if (oldPasswordProof !== null) await ctx.db.delete(oldPasswordProof._id);
    await ctx.db.delete(oldSession._id);
    await ctx.db.delete(request._id);
    return { userId: user._id, sessionId };
  },
});

export const selectSession = mutation({
  args: { organizationId: v.string(), workspaceId: v.optional(v.string()) },
  returns: v.union(
    v.object({
      organization: organizationViewValidator,
      workspace: v.optional(workspaceViewValidator),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const authenticated = await passwordOriginSession(ctx);
    if (
      authenticated === null ||
      !organizationIdSchema.safeParse(args.organizationId).success ||
      (args.workspaceId !== undefined && !workspaceIdSchema.safeParse(args.workspaceId).success)
    ) return null;
    const userId = authenticated.user._id;
    const sessionId = authenticated.session._id;
    const selected = await resolveSelection(ctx, {
      userId,
      organizationPublicId: args.organizationId,
      ...(args.workspaceId === undefined ? {} : { workspacePublicId: args.workspaceId }),
    });
    if (selected === null) return null;
    await writeSessionSelection(ctx, {
      sessionId,
      userId,
      organizationId: selected.organization._id,
      ...(selected.workspace === undefined ? {} : { workspaceId: selected.workspace._id }),
      now: Date.now(),
    });
    return {
      organization: {
        id: selected.organization.publicId,
        name: selected.organization.name,
        role: selected.organizationMembership.role,
        status: "active" as const,
      },
      ...(selected.workspace === undefined || selected.roles === undefined
        ? {}
        : {
            workspace: {
              id: selected.workspace.publicId,
              organizationId: selected.organization.publicId,
              slug: selected.workspace.slug,
              name: selected.workspace.name,
              taskKeyPrefix: selected.workspace.taskKeyPrefix,
              roles: [...selected.roles],
            },
          }),
    };
  },
});

export const authenticationForSession = internalQuery({
  args: { sessionId: v.id("authSessions") },
  returns: v.union(
    v.object({
      user: v.object({ id: v.string(), email: v.string(), name: v.optional(v.string()) }),
      organization: organizationViewValidator,
      workspace: v.optional(workspaceViewValidator),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null || session.expirationTime <= Date.now()) return null;
    const selection = await ctx.db
      .query("authSessionSelections")
      .withIndex("by_session", (index) => index.eq("sessionId", args.sessionId))
      .unique();
    if (selection === null || selection.userId !== session.userId) {
      return null;
    }
    const [user, organization, workspace] = await Promise.all([
      ctx.db.get(session.userId),
      ctx.db.get(selection.organizationId),
      selection.workspaceId === undefined ? null : ctx.db.get(selection.workspaceId),
    ]);
    if (
      user === null || user.status !== "active" || user.email === undefined ||
      organization === null || organization.status !== "active" ||
      (selection.workspaceId !== undefined && workspace === null) ||
      (workspace !== null && (
        workspace.status !== "active" || workspace.organizationId !== organization._id
      ))
    ) return null;
    const membership = await activeOrganizationMembership(ctx, user._id, organization._id);
    if (membership === null) return null;
    const roles = workspace === null
      ? null
      : await workspaceRoles(ctx, user._id, membership, workspace);
    if (workspace !== null && roles === null) return null;
    return {
      user: {
        id: user.publicId,
        email: user.email,
        ...(user.name === undefined ? {} : { name: user.name }),
      },
      organization: {
        id: organization.publicId,
        name: organization.name,
        role: membership.role,
        status: "active" as const,
      },
      ...(workspace === null || roles === null
        ? {}
        : {
            workspace: {
              id: workspace.publicId,
              organizationId: organization.publicId,
              slug: workspace.slug,
              name: workspace.name,
              taskKeyPrefix: workspace.taskKeyPrefix,
              roles: [...roles],
            },
          }),
    };
  },
});

export function parseDesktopPairingVerifier(value: unknown): string | null {
  const parsed = desktopPairingVerifierSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
