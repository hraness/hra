import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { authorizeAgent, touchAuthorizedAgent } from "./authorization";
import {
  assertRequestMetadata,
  domainFailure,
  lookupReceipt,
  randomPublicId,
  storeReceipt,
} from "./domain";
import { appendSecurityEvent } from "./events";
import {
  AGENT_SESSION_IDLE_MS,
  CREDENTIAL_LIFETIME_MS,
  domainErrorValidator,
  redeemEnrollmentDataValidator,
  startSessionDataValidator,
} from "./model";
import {
  agentRateLimitFailure,
  consumeAuthorizedAgentRateLimit,
} from "./rateLimits";

const enrollmentVerifierValidator = v.union(
  v.object({ id: v.id("agentEnrollments"), verifierDigest: v.bytes(), pepperVersion: v.string() }),
  v.null(),
);
const credentialVerifierValidator = v.union(
  v.object({ id: v.id("agentCredentials"), verifierDigest: v.bytes(), pepperVersion: v.string() }),
  v.null(),
);

const redeemResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: redeemEnrollmentDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const sessionResultValidator = v.union(
  v.object({ ok: v.literal(true), data: startSessionDataValidator, requestId: v.string() }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const touchResultValidator = v.union(
  v.object({ ok: v.literal(true), data: v.object({}), requestId: v.string() }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRedeemData(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.agentId !== "string" ||
    typeof value.credentialId !== "string" ||
    typeof value.credentialExpiresAt !== "number" ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === "string")
  ) {
    return null;
  }
  return {
    agentId: value.agentId,
    credentialId: value.credentialId,
    credentialExpiresAt: value.credentialExpiresAt,
    scopes: value.scopes as Array<
      | "tasks:read"
      | "tasks:create"
      | "tasks:edit"
      | "tasks:assign"
      | "tasks:claim"
      | "tasks:submit"
      | "tasks:review"
      | "dependencies:write"
      | "comments:write"
      | "dispatch:execute"
      | "runtime:heartbeat"
      | "runs:report"
    >,
  };
}

function parseSessionData(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    return null;
  }
  return { sessionId: value.sessionId, expiresAt: value.expiresAt };
}

export const enrollmentVerifier = internalQuery({
  args: { locator: v.string() },
  returns: enrollmentVerifierValidator,
  handler: async (ctx, args) => {
    const enrollment = await ctx.db
      .query("agentEnrollments")
      .withIndex("by_locator", (query) => query.eq("locator", args.locator))
      .unique();
    return enrollment === null
      ? null
      : {
          id: enrollment._id,
          verifierDigest: enrollment.verifierDigest,
          pepperVersion: enrollment.pepperVersion,
        };
  },
});

export const credentialVerifier = internalQuery({
  args: { locator: v.string() },
  returns: credentialVerifierValidator,
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query("agentCredentials")
      .withIndex("by_locator", (query) => query.eq("locator", args.locator))
      .unique();
    return credential === null
      ? null
      : {
          id: credential._id,
          verifierDigest: credential.verifierDigest,
          pepperVersion: credential.pepperVersion,
        };
  },
});

export const redeemEnrollment = internalMutation({
  args: {
    enrollmentId: v.id("agentEnrollments"),
    credentialLocator: v.string(),
    credentialVerifierDigest: v.bytes(),
    credentialPepperVersion: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: redeemResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };

    const enrollment = await ctx.db.get(args.enrollmentId);
    if (enrollment === null) {
      return domainFailure("AUTHENTICATION_FAILED", "Authentication failed.", args.requestId);
    }
    const [agent, grant, workspace, organization] = await Promise.all([
      ctx.db.get(enrollment.agentId),
      ctx.db.get(enrollment.grantId),
      ctx.db.get(enrollment.workspaceId),
      ctx.db.get(enrollment.organizationId),
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
      grant.agentId !== agent._id ||
      grant.workspaceId !== workspace._id ||
      agent.organizationId !== organization._id ||
      workspace.organizationId !== organization._id
    ) {
      return domainFailure("AUTHORIZATION_DENIED", "This principal is not authorized for the operation.", args.requestId);
    }

    if (enrollment.expiresAt <= now) {
      return domainFailure("ENROLLMENT_EXPIRED", "The agent enrollment has expired.", args.requestId);
    }

    const identity = {
      kind: "enrollment" as const,
      publicId: enrollment.locator,
      organizationId: organization._id,
      workspaceId: workspace._id,
    };
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "agent.enrollments.redeem",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseRedeemData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    if (enrollment.status === "redeemed") {
      return domainFailure("ENROLLMENT_REDEEMED", "The agent enrollment was already redeemed.", args.requestId);
    }
    if (enrollment.status !== "active") {
      return domainFailure("AUTHENTICATION_FAILED", "Authentication failed.", args.requestId);
    }
    const existingCredential = await ctx.db
      .query("agentCredentials")
      .withIndex("by_locator", (query) => query.eq("locator", args.credentialLocator))
      .unique();
    if (existingCredential !== null) {
      return domainFailure("ENROLLMENT_CONFLICT", "The enrollment conflicts with an existing redemption.", args.requestId);
    }
    const grantedScopes = new Set(grant.scopes);
    const scopes = enrollment.scopes.filter((scope) => grantedScopes.has(scope));
    if (scopes.length === 0) {
      return domainFailure("AUTHORIZATION_DENIED", "This principal is not authorized for the operation.", args.requestId);
    }
    const credentialExpiresAt = now + (enrollment.credentialLifetimeMs ?? CREDENTIAL_LIFETIME_MS);
    const credentialId = await ctx.db.insert("agentCredentials", {
      locator: args.credentialLocator,
      organizationId: organization._id,
      workspaceId: workspace._id,
      agentId: agent._id,
      grantId: grant._id,
      verifierDigest: args.credentialVerifierDigest,
      pepperVersion: args.credentialPepperVersion,
      scopes,
      status: "active",
      expiresAt: credentialExpiresAt,
      lastUsedAt: now,
      createdAt: now,
    });
    await ctx.db.patch(enrollment._id, {
      status: "redeemed",
      redeemedAt: now,
      credentialId,
    });
    const command = {
      kind: "client" as const,
      idempotencyKey: args.idempotencyKey,
      requestId: args.requestId,
    };
    await appendSecurityEvent(ctx, {
      organizationId: organization._id,
      workspaceId: workspace._id,
      agentId: agent._id,
      type: "agent.enrollment_redeemed",
      actor: {
        kind: "agent",
        agentId: agent.publicId,
        credentialId: args.credentialLocator,
      },
      command,
      payload: { credentialId: args.credentialLocator },
      now,
    });
    const data = {
      agentId: agent.publicId,
      credentialId: args.credentialLocator,
      credentialExpiresAt,
      scopes,
    };
    await storeReceipt(ctx, {
      identity,
      operation: "agent.enrollments.redeem",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export const startSession = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: sessionResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const credential = await ctx.db.get(args.credentialId);
    if (credential === null || credential.status !== "active" || credential.expiresAt <= now) {
      return domainFailure("AUTHENTICATION_FAILED", "Authentication failed.", args.requestId);
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
      credential.organizationId !== organization._id ||
      credential.workspaceId !== workspace._id ||
      credential.agentId !== agent._id ||
      credential.grantId !== grant._id ||
      agent.organizationId !== organization._id ||
      workspace.organizationId !== organization._id ||
      grant.organizationId !== organization._id ||
      grant.agentId !== agent._id ||
      grant.workspaceId !== workspace._id
    ) {
      return domainFailure("AUTHORIZATION_DENIED", "This principal is not authorized for the operation.", args.requestId);
    }
    const grantedScopes = new Set(grant.scopes);
    if (!credential.scopes.some((scope) => grantedScopes.has(scope))) {
      return domainFailure("AUTHORIZATION_DENIED", "This principal is not authorized for the operation.", args.requestId);
    }
    const rateLimitFailure = agentRateLimitFailure(
      await consumeAuthorizedAgentRateLimit(ctx, {
        authorization: {
          credentialId: credential._id,
          workspaceId: workspace._id,
        },
        routeClass: "agent_session",
        requestId: args.requestId,
        now,
      }),
      args.requestId,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = {
      kind: "agent" as const,
      publicId: credential.locator,
      organizationId: organization._id,
      workspaceId: workspace._id,
    };
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "agent.sessions.start",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseSessionData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    let sessionPublicId = randomPublicId("ses");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await ctx.db
        .query("agentSessions")
        .withIndex("by_public_id", (query) => query.eq("publicId", sessionPublicId))
        .unique();
      if (existing === null) break;
      sessionPublicId = randomPublicId("ses");
    }
    const expiresAt = now + AGENT_SESSION_IDLE_MS;
    await ctx.db.insert("agentSessions", {
      publicId: sessionPublicId,
      organizationId: organization._id,
      workspaceId: workspace._id,
      agentId: agent._id,
      credentialId: credential._id,
      status: "active",
      lastSeenAt: now,
      idleExpiresAt: expiresAt,
      createdAt: now,
    });
    await ctx.db.patch(credential._id, { lastUsedAt: now });
    await appendSecurityEvent(ctx, {
      organizationId: organization._id,
      workspaceId: workspace._id,
      agentId: agent._id,
      type: "agent.session_started",
      actor: {
        kind: "agent",
        agentId: agent.publicId,
        credentialId: credential.locator,
        sessionId: sessionPublicId,
      },
      command: {
        kind: "client",
        idempotencyKey: args.idempotencyKey,
        requestId: args.requestId,
      },
      payload: {},
      now,
    });
    const data = { sessionId: sessionPublicId, expiresAt };
    await storeReceipt(ctx, {
      identity,
      operation: "agent.sessions.start",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export const touchSession = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    requestId: v.string(),
  },
  returns: touchResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    // The public operation has already consumed its read/write bucket. This
    // mutation only coalesces session and credential last-seen timestamps; a
    // second agent_session debit would make read throughput depend on the
    // heartbeat implementation detail.
    await touchAuthorizedAgent(ctx, authorization.authorization, now);
    return { ok: true as const, data: {}, requestId: args.requestId };
  },
});
