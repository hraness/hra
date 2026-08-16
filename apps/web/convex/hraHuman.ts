import {
  HRA_STABLE_PROJECTION_CURSOR_PREFIX,
  dispatchIdSchema,
  hraProjectionCursorTokenSchema,
  runInteractionIdSchema,
  runInteractionRequestDigestSchema,
  runInteractionRequestSchema,
  workspacePublicIdSchema,
  type RunInteractionRequest,
} from "@hraness/agent-tasks-protocol";
import {
  taskPublicIdSchema,
  taskWorkspaceMutationResultSchema,
  workspaceNameSchema,
  type TaskWorkspaceMutationResult,
} from "@hraness/agent-tasks-domain";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import {
  runnerAuthorityClockMatches,
  runnerAuthorityTupleMatches,
} from "./dispatchLaws";
import { domainFailure, taskView } from "./domain";
import {
  authorizeOrganizationHuman,
  authorizeWorkspaceHuman,
} from "./humanAuthorization";
import {
  humanTaskMutationDigest,
  runHumanTaskMutation,
} from "./humanTaskMutations";
import { countHumanTaskViews } from "./humanTaskQueries";
import {
  advanceWorkspaceProjection,
  workspaceProjectionHead,
} from "./hraProjection";
import {
  domainErrorValidator,
  runInteractionRequestValidator,
} from "./model";

const MAX_CURSOR_BYTES = 8_192;
const COUNT_SCAN_LIMIT = 1_000;
const ALL_WORKSPACE_ROLES = ["planner", "reviewer", "viewer"] as const;

const interactionReplyAuthorityResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      workspaceId: v.string(),
      runId: v.string(),
      interactionId: v.string(),
      requestDigest: v.string(),
      projectionHead: v.number(),
      request: runInteractionRequestValidator,
    }),
    requestId: v.string(),
  }),
  v.object({
    ok: v.literal(false),
    error: domainErrorValidator,
  }),
);

/**
 * Fail-closed public/private tuple check shared by the authenticated reply
 * authority query and its deterministic regressions.
 */
export function hraPendingReplyAuthorityMatches(input: Readonly<{
  now: number;
  authorization: {
    organizationId: string;
    workspaceId: string;
  };
  requested: {
    runId: string;
    interactionId: string;
    requestDigest: string;
  };
  dispatch: {
    id: string;
    organizationId: string;
    workspaceId: string;
    publicId: string;
    runnerId: string;
    runnerPublicId: string;
    bootId: string;
    bootGeneration: number;
    claimId: string;
    claimFence: number;
    leaseUntil: number;
    desiredState: string;
    phase: string;
  };
  interaction: {
    organizationId: string;
    workspaceId: string;
    dispatchId: string;
    publicId: string;
    runnerId: string;
    runnerPublicId: string;
    bootId: string;
    bootGeneration: number;
    claimId: string;
    claimFence: number;
    requestDigest: string;
    state: string;
    expiresAt: number;
  };
  runner: {
    id: string;
    organizationId: string;
    workspaceId: string;
    publicId: string;
    bootId: string;
    bootGeneration: number;
    leaseUntil: number;
  };
  request: RunInteractionRequest;
}>): boolean {
  return Number.isSafeInteger(input.now) &&
    input.now >= 0 &&
    input.dispatch.organizationId === input.authorization.organizationId &&
    input.dispatch.workspaceId === input.authorization.workspaceId &&
    input.dispatch.publicId === input.requested.runId &&
    input.interaction.organizationId === input.authorization.organizationId &&
    input.interaction.workspaceId === input.authorization.workspaceId &&
    input.interaction.dispatchId === input.dispatch.id &&
    input.interaction.publicId === input.requested.interactionId &&
    input.interaction.requestDigest === input.requested.requestDigest &&
    input.interaction.state === "pending" &&
    input.interaction.expiresAt > input.now &&
    input.dispatch.leaseUntil > input.now &&
    input.dispatch.desiredState === "run" &&
    (input.dispatch.phase === "running" || input.dispatch.phase === "waiting") &&
    input.dispatch.runnerId === input.runner.id &&
    input.dispatch.runnerPublicId === input.runner.publicId &&
    input.runner.organizationId === input.authorization.organizationId &&
    input.runner.workspaceId === input.authorization.workspaceId &&
    input.runner.bootId === input.dispatch.bootId &&
    input.runner.bootGeneration === input.dispatch.bootGeneration &&
    input.runner.leaseUntil > input.now &&
    input.interaction.runnerId === input.dispatch.runnerId &&
    input.interaction.runnerPublicId === input.runner.publicId &&
    input.interaction.bootId === input.dispatch.bootId &&
    input.interaction.bootGeneration === input.dispatch.bootGeneration &&
    input.interaction.claimId === input.dispatch.claimId &&
    input.interaction.claimFence === input.dispatch.claimFence &&
    input.request.id === input.interaction.publicId &&
    input.request.expiresAt === input.interaction.expiresAt &&
    input.request.reply.runnerId === input.runner.publicId &&
    input.request.reply.bootId === input.dispatch.bootId &&
    input.request.reply.bootGeneration === input.dispatch.bootGeneration &&
    input.request.reply.claimId === input.dispatch.claimId &&
    input.request.reply.claimFence === input.dispatch.claimFence &&
    input.request.reply.requestDigest === input.requested.requestDigest;
}

function hraPersistedInteractionRequest(
  request: RunInteractionRequest,
): Doc<"taskRunInteractions">["request"] {
  if (request.kind === "file_change_approval") return request;
  return {
    ...request,
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === undefined
          ? {}
          : { description: option.description }),
      })),
    })),
  };
}

type HRACursorState =
  | Readonly<{
      kind: "workspaces";
      organizationId: string;
      userId: string;
      profile: "administrator" | "member";
      continuation: string;
    }>
  | Readonly<{
      kind: "repositories";
      organizationId: string;
      userId: string;
      workspaceId: string;
      projectionHead: number;
      continuation: string;
    }>
  | Readonly<{
      kind: "task_list";
      organizationId: string;
      userId: string;
      workspaceId: string;
      projectionHead: number;
      view: string;
      assignedAgentId?: string;
      continuation: string;
    }>
  | Readonly<{
      kind: "invalidations";
      organizationId: string;
      userId: string;
      workspaceId: string;
      projectionHead: number;
      lastRevision: number;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > MAX_CURSOR_BYTES) {
    return null;
  }
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = `${normalized}${"=".repeat((4 - normalized.length % 4) % 4)}`;
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

export function encodeHRACursor(state: HRACursorState): string {
  return hraProjectionCursorTokenSchema.parse(
    `${HRA_STABLE_PROJECTION_CURSOR_PREFIX}${base64UrlEncode(JSON.stringify(state))}`,
  );
}

export function decodeHRACursor(value: string): HRACursorState | null {
  const parsedToken = hraProjectionCursorTokenSchema.safeParse(value);
  if (!parsedToken.success) return null;
  const decoded = base64UrlDecode(
    parsedToken.data.slice(HRA_STABLE_PROJECTION_CURSOR_PREFIX.length),
  );
  if (decoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.kind !== "string" ||
    typeof parsed.organizationId !== "string" ||
    typeof parsed.userId !== "string"
  ) {
    return null;
  }
  if (
    parsed.kind === "workspaces" &&
    (parsed.profile === "administrator" || parsed.profile === "member") &&
    typeof parsed.continuation === "string"
  ) {
    return {
      kind: parsed.kind,
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      profile: parsed.profile,
      continuation: parsed.continuation,
    };
  }
  if (
    parsed.kind === "repositories" &&
    typeof parsed.workspaceId === "string" &&
    Number.isSafeInteger(parsed.projectionHead) &&
    typeof parsed.projectionHead === "number" &&
    parsed.projectionHead >= 1 &&
    typeof parsed.continuation === "string"
  ) {
    return {
      kind: parsed.kind,
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      workspaceId: parsed.workspaceId,
      projectionHead: parsed.projectionHead,
      continuation: parsed.continuation,
    };
  }
  if (
    parsed.kind === "task_list" &&
    typeof parsed.workspaceId === "string" &&
    Number.isSafeInteger(parsed.projectionHead) &&
    typeof parsed.projectionHead === "number" &&
    parsed.projectionHead >= 1 &&
    typeof parsed.view === "string" &&
    typeof parsed.continuation === "string" &&
    (parsed.assignedAgentId === undefined ||
      typeof parsed.assignedAgentId === "string")
  ) {
    return {
      kind: parsed.kind,
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      workspaceId: parsed.workspaceId,
      projectionHead: parsed.projectionHead,
      view: parsed.view,
      ...(parsed.assignedAgentId === undefined
        ? {}
        : { assignedAgentId: parsed.assignedAgentId }),
      continuation: parsed.continuation,
    };
  }
  if (
    parsed.kind === "invalidations" &&
    typeof parsed.workspaceId === "string" &&
    Number.isSafeInteger(parsed.projectionHead) &&
    typeof parsed.projectionHead === "number" &&
    parsed.projectionHead >= 1 &&
    Number.isSafeInteger(parsed.lastRevision) &&
    typeof parsed.lastRevision === "number" &&
    parsed.lastRevision >= 0
  ) {
    return {
      kind: parsed.kind,
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      workspaceId: parsed.workspaceId,
      projectionHead: parsed.projectionHead,
      lastRevision: parsed.lastRevision,
    };
  }
  return null;
}

async function workspaceCounts(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  now: number,
) {
  const rows = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_updated", (query) =>
      query.eq("workspaceId", workspace._id))
    .take(COUNT_SCAN_LIMIT + 1);
  if (
    rows.slice(0, COUNT_SCAN_LIMIT).some((task) =>
      task.organizationId !== workspace.organizationId ||
      task.workspaceId !== workspace._id)
  ) {
    throw new Error("HRA workspace count crossed its tenant.");
  }
  return countHumanTaskViews(
    rows.slice(0, COUNT_SCAN_LIMIT),
    now,
    rows.length > COUNT_SCAN_LIMIT,
  );
}

async function workspaceSummary(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  now: number,
) {
  const [revision, counts] = await Promise.all([
    workspaceProjectionHead(ctx, workspace._id),
    workspaceCounts(ctx, workspace, now),
  ]);
  return {
    id: workspace.publicId,
    name: workspace.name,
    slug: workspace.slug,
    keyPrefix: workspace.taskKeyPrefix,
    revision,
    authority: {
      kind: "cloud" as const,
      cloudWorkspaceId: workspace.publicId,
    },
    counts,
  };
}

function profileForRole(role: string): "administrator" | "member" {
  return role === "owner" || role === "admin"
    ? "administrator"
    : "member";
}

export const listWorkspaces = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorized = await authorizeOrganizationHuman(ctx, {
      requestId: args.requestId,
    });
    if (!authorized.ok) return authorized;
    const { authorization } = authorized;
    const profile = profileForRole(authorization.role);
    const decoded = args.cursor === undefined
      ? null
      : decodeHRACursor(args.cursor);
    if (
      args.cursor !== undefined &&
      (
        decoded?.kind !== "workspaces" ||
        decoded.organizationId !== authorization.organization.publicId ||
        decoded.userId !== authorization.user.publicId ||
        decoded.profile !== profile
      )
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const continuation = decoded?.kind === "workspaces"
      ? decoded.continuation
      : null;
    const now = Date.now();
    const workspaces: Doc<"workspaces">[] = [];
    let next: string | null = null;
    if (profile === "administrator") {
      const page = await ctx.db
        .query("workspaces")
        .withIndex("by_organization_status_and_public_id", (query) =>
          query
            .eq("organizationId", authorization.organization._id)
            .eq("status", "active"))
        .paginate({ cursor: continuation, numItems: args.limit });
      workspaces.push(...page.page);
      next = page.isDone ? null : page.continueCursor;
    } else {
      const page = await ctx.db
        .query("workspaceMemberships")
        .withIndex("by_user_organization_status_and_workspace", (query) =>
          query
            .eq("userId", authorization.user._id)
            .eq("organizationId", authorization.organization._id)
            .eq("status", "active"))
        .paginate({ cursor: continuation, numItems: args.limit });
      for (const membership of page.page) {
        const workspace = await ctx.db.get(membership.workspaceId);
        if (
          workspace === null ||
          workspace.organizationId !== authorization.organization._id ||
          workspace.status !== "active"
        ) {
          throw new Error("HRA workspace membership projection is invalid.");
        }
        workspaces.push(workspace);
      }
      next = page.isDone ? null : page.continueCursor;
    }
    return {
      ok: true as const,
      data: {
        workspaces: await Promise.all(
          workspaces.map(async (workspace) =>
            await workspaceSummary(ctx, workspace, now)),
        ),
        cursor: next === null
          ? null
          : {
              version: 1 as const,
              token: encodeHRACursor({
                kind: "workspaces",
                organizationId: authorization.organization.publicId,
                userId: authorization.user.publicId,
                profile,
                continuation: next,
              }),
              scope: { kind: "workspaces" as const },
            },
      },
      requestId: args.requestId,
    };
  },
});

export const workspace = internalQuery({
  args: { workspaceId: v.string(), requestId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const authorized = await authorizeWorkspaceHuman(ctx, {
      workspacePublicId: args.workspaceId,
      requestId: args.requestId,
    });
    if (!authorized.ok) return authorized;
    const { authorization } = authorized;
    const head = await workspaceProjectionHead(
      ctx,
      authorization.workspace._id,
    );
    const workspaceRoles =
      authorization.role === "owner" || authorization.role === "admin"
        ? [...ALL_WORKSPACE_ROLES]
        : [...(authorization.workspaceMembership?.roles ?? [])];
    return {
      ok: true as const,
      data: {
        workspace: await workspaceSummary(
          ctx,
          authorization.workspace,
          Date.now(),
        ),
        projectionHead: head,
        identity: {
          organizationId: authorization.organization.publicId,
          userId: authorization.user.publicId,
        },
        viewer: {
          id: authorization.user.publicId,
          kind: "human" as const,
          name: authorization.user.name,
        },
        organizationRole: authorization.role,
        workspaceRoles,
      },
      requestId: args.requestId,
    };
  },
});

export const taskIdentity = internalQuery({
  args: {
    workspaceId: v.string(),
    taskId: v.optional(v.string()),
    key: v.optional(v.string()),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (
      (args.taskId === undefined) === (args.key === undefined) ||
      (
        args.taskId !== undefined &&
        !taskPublicIdSchema.safeParse(args.taskId).success
      )
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      workspacePublicId: args.workspaceId,
      requestId: args.requestId,
    });
    if (!authorized.ok) return authorized;
    const task = args.taskId === undefined
      ? await ctx.db
          .query("tasks")
          .withIndex("by_workspace_and_key", (query) =>
            query
              .eq("workspaceId", authorized.authorization.workspace._id)
              .eq("key", args.key ?? ""))
          .unique()
      : await ctx.db
          .query("tasks")
          .withIndex("by_workspace_and_public_id", (query) =>
            query
              .eq("workspaceId", authorized.authorization.workspace._id)
              .eq("publicId", args.taskId ?? ""))
          .unique();
    if (
      task === null ||
      task.organizationId !== authorized.authorization.organization._id ||
      task.workspaceId !== authorized.authorization.workspace._id
    ) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    return {
      ok: true as const,
      data: {
        task: taskView(task),
        projectionHead: await workspaceProjectionHead(
          ctx,
          authorized.authorization.workspace._id,
        ),
      },
      requestId: args.requestId,
    };
  },
});

export const interactionIdentity = internalQuery({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    interactionId: v.string(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const authorized = await authorizeWorkspaceHuman(ctx, {
      workspacePublicId: args.workspaceId,
      requestId: args.requestId,
    });
    if (!authorized.ok) return authorized;
    const [dispatch, interaction] = await Promise.all([
      ctx.db
        .query("taskDispatches")
        .withIndex("by_public_id", (query) =>
          query.eq("publicId", args.runId))
        .unique(),
      ctx.db
        .query("taskRunInteractions")
        .withIndex("by_public_id", (query) =>
          query.eq("publicId", args.interactionId))
        .unique(),
    ]);
    const { organization, workspace } = authorized.authorization;
    if (
      dispatch === null ||
      interaction === null ||
      dispatch.organizationId !== organization._id ||
      dispatch.workspaceId !== workspace._id ||
      interaction.organizationId !== organization._id ||
      interaction.workspaceId !== workspace._id ||
      interaction.dispatchId !== dispatch._id
    ) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    return {
      ok: true as const,
      data: {
        requestDigest: interaction.requestDigest,
        projectionHead: await workspaceProjectionHead(ctx, workspace._id),
      },
      requestId: args.requestId,
    };
  },
});

export const interactionReplyAuthority = internalQuery({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    interactionId: v.string(),
    requestDigest: v.string(),
    projectionHead: v.number(),
    requestId: v.string(),
  },
  returns: interactionReplyAuthorityResultValidator,
  handler: async (ctx, args) => {
    if (
      !workspacePublicIdSchema.safeParse(args.workspaceId).success ||
      !dispatchIdSchema.safeParse(args.runId).success ||
      !runInteractionIdSchema.safeParse(args.interactionId).success ||
      !runInteractionRequestDigestSchema.safeParse(args.requestDigest).success ||
      !Number.isSafeInteger(args.projectionHead) ||
      args.projectionHead < 1
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      workspacePublicId: args.workspaceId,
      requestId: args.requestId,
    });
    if (!authorized.ok) return authorized;
    const { organization, workspace } = authorized.authorization;
    const projectionHead = await workspaceProjectionHead(ctx, workspace._id);
    if (projectionHead !== args.projectionHead) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        currentRevision: projectionHead,
      });
    }
    const [dispatch, interaction] = await Promise.all([
      ctx.db
        .query("taskDispatches")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
        .unique(),
      ctx.db
        .query("taskRunInteractions")
        .withIndex("by_public_id", (query) =>
          query.eq("publicId", args.interactionId))
        .unique(),
    ]);
    if (
      dispatch === null ||
      interaction === null ||
      !("runnerId" in dispatch) ||
      dispatch.organizationId !== organization._id ||
      dispatch.workspaceId !== workspace._id ||
      interaction.organizationId !== organization._id ||
      interaction.workspaceId !== workspace._id ||
      interaction.dispatchId !== dispatch._id ||
      interaction.requestDigest !== args.requestDigest
    ) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    const parsedRequest = runInteractionRequestSchema.safeParse(
      interaction.request,
    );
    if (
      !parsedRequest.success ||
      parsedRequest.data.id !== interaction.publicId ||
      parsedRequest.data.expiresAt !== interaction.expiresAt ||
      parsedRequest.data.reply.requestDigest !== interaction.requestDigest
    ) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const now = Date.now();
    if (
      interaction.state !== "pending" ||
      interaction.expiresAt <= now ||
      dispatch.leaseUntil <= now ||
      dispatch.desiredState !== "run" ||
      (dispatch.phase !== "running" && dispatch.phase !== "waiting")
    ) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        currentRevision: projectionHead,
      });
    }
    const [runner, authorities, responseRows] = await Promise.all([
      ctx.db.get(dispatch.runnerId),
      ctx.db
        .query("dispatchRunnerAuthorities")
        .withIndex("by_workspace", (query) =>
          query.eq("workspaceId", workspace._id))
        .take(2),
      ctx.db
        .query("taskRunInteractionResponses")
        .withIndex("by_interaction", (query) =>
          query.eq("interactionId", interaction._id))
        .take(1),
    ]);
    if (authorities.length > 1 || responseRows.length !== 0) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const authority = authorities[0];
    if (
      runner === null ||
      authority === undefined ||
      !runnerAuthorityTupleMatches({
        authorityOrganizationId: authority.organizationId,
        authorityWorkspaceId: authority.workspaceId,
        authorityRunnerId: authority.runnerId,
        authorityRunnerPublicId: authority.runnerPublicId,
        authorityInstallationId: authority.installationId,
        runnerOrganizationId: runner.organizationId,
        runnerWorkspaceId: runner.workspaceId,
        runnerId: runner._id,
        runnerPublicId: runner.publicId,
        runnerInstallationId: runner.installationId,
      }) ||
      !runnerAuthorityClockMatches({
        authorityGeneration: authority.generation,
        authorityLeaseUntil: authority.leaseUntil,
        runnerLeaseUntil: runner.leaseUntil,
      }) ||
      authority.leaseUntil <= now ||
      !hraPendingReplyAuthorityMatches({
        now,
        authorization: {
          organizationId: organization._id,
          workspaceId: workspace._id,
        },
        requested: {
          runId: args.runId,
          interactionId: args.interactionId,
          requestDigest: args.requestDigest,
        },
        dispatch: {
          id: dispatch._id,
          organizationId: dispatch.organizationId,
          workspaceId: dispatch.workspaceId,
          publicId: dispatch.publicId,
          runnerId: dispatch.runnerId,
          runnerPublicId: dispatch.runnerPublicId,
          bootId: dispatch.bootId,
          bootGeneration: dispatch.bootGeneration,
          claimId: dispatch.taskClaimPublicId,
          claimFence: dispatch.claimFence,
          leaseUntil: dispatch.leaseUntil,
          desiredState: dispatch.desiredState,
          phase: dispatch.phase,
        },
        interaction: {
          organizationId: interaction.organizationId,
          workspaceId: interaction.workspaceId,
          dispatchId: interaction.dispatchId,
          publicId: interaction.publicId,
          runnerId: interaction.runnerId,
          runnerPublicId: interaction.runnerPublicId,
          bootId: interaction.bootId,
          bootGeneration: interaction.bootGeneration,
          claimId: interaction.claimPublicId,
          claimFence: interaction.claimFence,
          requestDigest: interaction.requestDigest,
          state: interaction.state,
          expiresAt: interaction.expiresAt,
        },
        runner: {
          id: runner._id,
          organizationId: runner.organizationId,
          workspaceId: runner.workspaceId,
          publicId: runner.publicId,
          bootId: runner.bootId,
          bootGeneration: runner.bootGeneration,
          leaseUntil: runner.leaseUntil,
        },
        request: parsedRequest.data,
      })
    ) {
      return domainFailure("CLAIM_STALE", args.requestId);
    }
    return {
      ok: true as const,
      data: {
        workspaceId: workspace.publicId,
        runId: dispatch.publicId,
        interactionId: interaction.publicId,
        requestDigest: interaction.requestDigest,
        projectionHead,
        request: hraPersistedInteractionRequest(parsedRequest.data),
      },
      requestId: args.requestId,
    };
  },
});

export const invalidations = internalQuery({
  args: {
    workspaceId: v.string(),
    afterProjectionHead: v.number(),
    cursor: v.optional(v.string()),
    cursorProjectionHead: v.optional(v.number()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const authorized = await authorizeWorkspaceHuman(ctx, {
      workspacePublicId: args.workspaceId,
      requestId: args.requestId,
    });
    if (!authorized.ok) return authorized;
    const { authorization } = authorized;
    const head = await workspaceProjectionHead(
      ctx,
      authorization.workspace._id,
    );
    const decoded = args.cursor === undefined
      ? null
      : decodeHRACursor(args.cursor);
    if (
      !Number.isSafeInteger(args.afterProjectionHead) ||
      args.afterProjectionHead < 0 ||
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 100 ||
      (
        args.cursor !== undefined &&
        (
          decoded?.kind !== "invalidations" ||
          decoded.organizationId !== authorization.organization.publicId ||
          decoded.userId !== authorization.user.publicId ||
          decoded.workspaceId !== authorization.workspace.publicId ||
          decoded.projectionHead !== args.cursorProjectionHead ||
          decoded.projectionHead !== head ||
          decoded.lastRevision < args.afterProjectionHead
        )
      )
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const after = decoded?.kind === "invalidations"
      ? decoded.lastRevision
      : args.afterProjectionHead;
    const rows = await ctx.db
      .query("workspaceInvalidations")
      .withIndex("by_workspace_and_revision", (query) =>
        query
          .eq("workspaceId", authorization.workspace._id)
          .gt("projectionRevision", after))
      .order("asc")
      .take(args.limit + 1);
    if (
      rows.some((row) =>
        row.organizationId !== authorization.organization._id ||
        row.workspaceId !== authorization.workspace._id ||
        row.workspacePublicId !== authorization.workspace.publicId)
    ) {
      throw new Error("HRA invalidation projection crossed its tenant.");
    }
    const page = rows.slice(0, args.limit);
    const hasMore = rows.length > args.limit;
    const lastRevision =
      page.at(-1)?.projectionRevision ?? after;
    return {
      ok: true as const,
      data: {
        workspaceId: authorization.workspace.publicId,
        afterProjectionHead: args.afterProjectionHead,
        projectionHead: head,
        invalidations: page.map((row) => ({
          workspaceId: row.workspacePublicId,
          projectionRevision: row.projectionRevision,
          scope: "workspace" as const,
        })),
        cursor: hasMore
          ? {
              version: 1 as const,
              token: encodeHRACursor({
                kind: "invalidations",
                organizationId: authorization.organization.publicId,
                userId: authorization.user.publicId,
                workspaceId: authorization.workspace.publicId,
                projectionHead: head,
                lastRevision,
              }),
              workspaceId: authorization.workspace.publicId,
              projectionHead: head,
              scope: { kind: "invalidations" as const },
            }
          : null,
        hasMore,
      },
      requestId: args.requestId,
    };
  },
});

export const renameWorkspace = internalMutation({
  args: {
    workspaceId: v.string(),
    name: v.string(),
    idempotencyKey: v.string(),
    hraOperationId: v.string(),
    expectedProjectionHead: v.number(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const parsedName = workspaceNameSchema.safeParse(args.name);
    if (!parsedName.success) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const requestDigest = humanTaskMutationDigest("workspace.rename", {
      workspaceId: args.workspaceId,
      name: parsedName.data,
    });
    return await runHumanTaskMutation(ctx, {
      ...args,
      requestDigest,
    }, {
      capability: "planner",
      operation: "workspace.rename",
      parseReceipt: (value: unknown) => {
        if (!isRecord(value) || typeof value.name !== "string") return null;
        return { name: value.name };
      },
      execute: async (command) => {
        const workspace = command.authorization.workspace;
        if (workspace.name === parsedName.data) {
          return domainFailure("TASK_STATE_CONFLICT", args.requestId);
        }
        await ctx.db.patch(workspace._id, {
          name: parsedName.data,
          updatedAt: command.now,
        });
        await advanceWorkspaceProjection(ctx, workspace, command.now);
        return { ok: true as const, data: { name: parsedName.data } };
      },
    });
  },
});

export function hraMutationResult(input: {
  operationId: string;
  workspaceId: string;
  commandKind: TaskWorkspaceMutationResult["commandKind"];
  workspaceRevision: number;
  projectionRevision: number;
  result: TaskWorkspaceMutationResult["result"];
}): TaskWorkspaceMutationResult {
  return taskWorkspaceMutationResultSchema.parse(input);
}
