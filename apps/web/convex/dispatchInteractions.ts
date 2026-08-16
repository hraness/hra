import {
  createRunInteractionRequestDigest,
  interactionRequestPayload,
  MAX_RUN_INTERACTIONS_PER_RUN,
  MAX_RUN_INTERACTION_RESPONSES,
  MAX_RUN_INTERACTION_TTL_MS,
  MAX_RUN_INTERACTION_VIEWS,
  dispatchIdSchema,
  runInteractionIdSchema,
  runInteractionRequestSchema,
  sealedRunInteractionResponseSchema,
  syncRunInteractionsRequestSchema,
  type RunInteractionRequest,
  type SealedRunInteractionResponse,
} from "@hraness/agent-tasks-protocol";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "./_generated/server";
import { authorizeAgent, touchAuthorizedAgent } from "./authorization";
import {
  domainFailure,
  randomRequestId,
} from "./domain";
import {
  humanTaskMutationDigest,
  runHumanTaskMutation,
  validPublicScope,
} from "./humanTaskMutations";
import { advanceWorkspaceProjectionById } from "./hraProjection";
import {
  domainErrorValidator,
  runInteractionRequestValidator,
  sealedRunInteractionResponseValidator,
} from "./model";
import {
  boundedRunInteractionPage,
  pendingExpiredInteractionPage,
  planRunInteractionBatchAdmission,
  runInteractionDeliveryProjectionMatches,
  runInteractionResponseProjectionMatches,
  runInteractionSettlementDisposition,
} from "./dispatchInteractionLaws";
import { runnerAuthorityClockMatches } from "./dispatchLaws";
import {
  deriveHumanInputProjection,
  storedHumanInputProjection,
} from "./humanTaskProjection";
import {
  agentRateLimitFailure,
  consumeAuthorizedAgentRateLimit,
} from "./rateLimits";

const MAX_INTERACTION_CLOCK_SKEW_MS = 30_000;

const answerReceiptValidator = v.object({
  interactionId: v.string(),
  responseRevision: v.number(),
  state: v.literal("answered"),
});

const answerResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: answerReceiptValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const syncResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      serverTime: v.number(),
      acceptedInteractionIds: v.array(v.string()),
      acceptedSettlementIds: v.array(v.string()),
      responses: v.array(v.object({
        interactionId: v.string(),
        responseRevision: v.number(),
        sealedResponse: sealedRunInteractionResponseValidator,
      })),
      expiredInteractions: v.array(v.object({
        interactionId: v.string(),
        responseRevision: v.optional(v.number()),
      })),
      hasMoreResponses: v.boolean(),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

type BoundDispatch = Extract<
  Doc<"taskDispatches">,
  { runnerId: Id<"dispatchRunners"> }
>;

function isBoundDispatch(dispatch: Doc<"taskDispatches">): dispatch is BoundDispatch {
  return "runnerId" in dispatch && "bootId" in dispatch && "claimFence" in dispatch;
}

function runnerOwnsDispatch(
  runner: Doc<"dispatchRunners">,
  dispatch: BoundDispatch,
  request: ReturnType<typeof syncRunInteractionsRequestSchema.parse>,
  now: number,
): boolean {
  return (
    runner._id === dispatch.runnerId &&
    runner.publicId === request.runnerId &&
    dispatch.runnerPublicId === runner.publicId &&
    runner.bootId === request.bootId &&
    runner.bootGeneration === request.bootGeneration &&
    runner.leaseUntil > now &&
    dispatch.bootId === request.bootId &&
    dispatch.bootGeneration === request.bootGeneration &&
    dispatch.taskClaimPublicId === request.claimId &&
    dispatch.claimFence === request.claimFence &&
    dispatch.leaseUntil > now &&
    dispatch.desiredState === "run" &&
    (dispatch.phase === "starting" || dispatch.phase === "running" || dispatch.phase === "waiting")
  );
}

async function currentAuthorityOwnsRunner(
  ctx: MutationCtx,
  runner: Doc<"dispatchRunners">,
  now: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query("dispatchRunnerAuthorities")
    .withIndex("by_workspace", (query) => query.eq("workspaceId", runner.workspaceId))
    .take(2);
  const authority = rows[0];
  return rows.length === 1 && authority !== undefined && (
    authority.organizationId === runner.organizationId &&
    authority.workspaceId === runner.workspaceId &&
    authority.runnerId === runner._id &&
    authority.runnerPublicId === runner.publicId &&
    authority.installationId === runner.installationId &&
    runnerAuthorityClockMatches({
      authorityGeneration: authority.generation,
      authorityLeaseUntil: authority.leaseUntil,
      runnerLeaseUntil: runner.leaseUntil,
    }) &&
    authority.leaseUntil > now
  );
}

function persistedRequest(
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
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    })),
  };
}

function persistedSealedResponse(
  response: SealedRunInteractionResponse,
): Doc<"taskRunInteractionResponses">["sealedResponse"] {
  return {
    version: 1,
    algorithm: "P256-HKDF-SHA256-A256GCM",
    keyId: response.keyId,
    workspaceId: response.workspaceId,
    ephemeralPublicKey: response.ephemeralPublicKey,
    nonce: response.nonce,
    ciphertext: response.ciphertext,
  };
}

function compactedRequest(request: RunInteractionRequest): RunInteractionRequest {
  if (request.kind === "file_change_approval") return request;
  const firstQuestion = request.questions[0];
  if (firstQuestion === undefined) throw new Error("Validated interaction is missing its question");
  return {
    ...request,
    questions: [{
      id: firstQuestion.id,
      header: "Completed",
      prompt: "Response details were removed.",
      allowOther: true,
      options: [],
    }],
  };
}

function parseAnswerReceipt(value: unknown) {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return (
    runInteractionIdSchema.safeParse(candidate.interactionId).success &&
    Number.isSafeInteger(candidate.responseRevision) &&
    candidate.responseRevision === 1 &&
    candidate.state === "answered"
  ) ? {
      interactionId: candidate.interactionId as string,
      responseRevision: 1,
      state: "answered" as const,
    } : null;
}

async function responseRows(
  ctx: MutationCtx,
  interactionId: Id<"taskRunInteractions">,
) {
  return await ctx.db
    .query("taskRunInteractionResponses")
    .withIndex("by_interaction", (query) => query.eq("interactionId", interactionId))
    .take(2);
}

/** Rebuilds the bounded task summary from authoritative pending rows. */
export async function refreshTaskHumanInputProjection(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
): Promise<void> {
  const task = await ctx.db.get(taskId);
  if (task === null) throw new Error("Run interaction lost its task projection target.");
  const pending = await ctx.db
    .query("taskRunInteractions")
    .withIndex("by_task_state_created", (query) =>
      query.eq("taskId", taskId).eq("state", "pending"))
    .take(MAX_RUN_INTERACTION_VIEWS + 1);
  if (
    pending.length > MAX_RUN_INTERACTION_VIEWS ||
    pending.some((interaction) =>
      interaction.taskId !== taskId ||
      interaction.organizationId !== task.organizationId ||
      interaction.workspaceId !== task.workspaceId ||
      interaction.state !== "pending")
  ) {
    throw new Error("Pending human-input rows disagree with their task tenant.");
  }
  const parsedPending = pending.map((interaction) => {
    const request = runInteractionRequestSchema.safeParse(interaction.request);
    if (!request.success) throw new Error("Pending human-input request is malformed.");
    if (
      request.data.id !== interaction.publicId ||
      request.data.expiresAt !== interaction.expiresAt
    ) {
      throw new Error("Pending human-input request disagrees with its durable locator.");
    }
    return { publicId: interaction.publicId, request: request.data };
  });
  await ctx.db.patch(
    taskId,
    storedHumanInputProjection(deriveHumanInputProjection(parsedPending)),
  );
}

export async function expireOpenInteractions(
  ctx: MutationCtx,
  dispatchId: Id<"taskDispatches">,
  now: number,
): Promise<boolean> {
  const dispatch = await ctx.db.get(dispatchId);
  if (dispatch === null) throw new Error("Run interaction cleanup lost its dispatch.");
  const [pending, answered] = await Promise.all([
    ctx.db
      .query("taskRunInteractions")
      .withIndex("by_dispatch_state_created", (query) =>
        query.eq("dispatchId", dispatchId).eq("state", "pending"))
      .take(MAX_RUN_INTERACTION_VIEWS + 1),
    ctx.db
      .query("taskRunInteractions")
      .withIndex("by_dispatch_state_created", (query) =>
        query.eq("dispatchId", dispatchId).eq("state", "answered"))
      .take(MAX_RUN_INTERACTION_VIEWS + 1),
  ]);
  const interactions = [...pending, ...answered];
  if (
    pending.length > MAX_RUN_INTERACTION_VIEWS ||
    answered.length > MAX_RUN_INTERACTION_VIEWS ||
    interactions.length > MAX_RUN_INTERACTION_VIEWS
  ) {
    throw new Error("Open run interaction projection exceeded its bounded limit.");
  }
  if (interactions.some((interaction) =>
    interaction.organizationId !== dispatch.organizationId ||
    interaction.workspaceId !== dispatch.workspaceId ||
    interaction.dispatchId !== dispatch._id ||
    (interaction.taskId !== undefined && interaction.taskId !== dispatch.taskId))) {
    throw new Error("Open run interaction projection crossed a task tenant boundary.");
  }
  if (interactions.length === 0) return false;
  const responseRowsByInteraction = await Promise.all(
    interactions.map(async (interaction) => ({
      interaction,
      rows: await responseRows(ctx, interaction._id),
    })),
  );
  if (responseRowsByInteraction.some(({ interaction, rows }) =>
    rows.length > 1 || rows.some((row) =>
      row.organizationId !== dispatch.organizationId ||
      row.workspaceId !== dispatch.workspaceId ||
      row.dispatchId !== dispatch._id ||
      row.interactionId !== interaction._id))) {
    throw new Error("Open run interaction response projection is corrupt.");
  }
  for (const { interaction, rows } of responseRowsByInteraction) {
    for (const row of rows) await ctx.db.delete(row._id);
    await ctx.db.patch(interaction._id, {
      taskId: dispatch.taskId,
      request: persistedRequest(compactedRequest(runInteractionRequestSchema.parse(interaction.request))),
      state: "expired",
      resolvedAt: now,
      updatedAt: now,
    });
  }
  await refreshTaskHumanInputProjection(ctx, dispatch.taskId);
  return true;
}

export const syncRunInteractions = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    requestId: v.string(),
    runId: v.string(),
    runnerId: v.string(),
    bootId: v.string(),
    bootGeneration: v.number(),
    claimId: v.string(),
    claimFence: v.number(),
    upserts: v.array(runInteractionRequestValidator),
    settlements: v.array(v.object({
      interactionId: v.string(),
      responseRevision: v.optional(v.number()),
      outcome: v.union(v.literal("applied"), v.literal("expired")),
      reason: v.optional(v.union(
        v.literal("local_deadline"),
        v.literal("provider_expired"),
        v.literal("cloud_expired"),
      )),
    })),
  },
  returns: syncResultValidator,
  handler: async (ctx, args) => {
    const parsed = syncRunInteractionsRequestSchema.safeParse({
      runnerId: args.runnerId,
      bootId: args.bootId,
      bootGeneration: args.bootGeneration,
      claimId: args.claimId,
      claimFence: args.claimFence,
      upserts: args.upserts,
      settlements: args.settlements,
    });
    if (!parsed.success || !dispatchIdSchema.safeParse(args.runId).success) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const now = Date.now();
    const authorized = await authorizeAgent(ctx, {
      credentialId: args.credentialId,
      sessionPublicId: args.sessionPublicId,
      requestId: args.requestId,
      requiredScope: "runs:report",
      now,
    });
    if (!authorized.ok) return authorized;
    const rateLimitFailure = agentRateLimitFailure(
      await consumeAuthorizedAgentRateLimit(ctx, {
        authorization: authorized.authorization,
        routeClass: "agent_write",
        requestId: args.requestId,
        now,
      }),
      args.requestId,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const [runner, dispatch] = await Promise.all([
      ctx.db.query("dispatchRunners").withIndex("by_public_id", (query) =>
        query.eq("publicId", parsed.data.runnerId)).unique(),
      ctx.db.query("taskDispatches").withIndex("by_public_id", (query) =>
        query.eq("publicId", args.runId)).unique(),
    ]);
    if (
      runner === null ||
      dispatch === null ||
      !isBoundDispatch(dispatch) ||
      runner.organizationId !== authorized.authorization.organizationId ||
      runner.workspaceId !== authorized.authorization.workspaceId ||
      runner.agentId !== authorized.authorization.agentId ||
      dispatch.organizationId !== authorized.authorization.organizationId ||
      dispatch.workspaceId !== authorized.authorization.workspaceId ||
      !runnerOwnsDispatch(runner, dispatch, parsed.data, now) ||
      !(await currentAuthorityOwnsRunner(ctx, runner, now))
    ) {
      return domainFailure("CLAIM_STALE", args.requestId);
    }

    const [pendingRows, answeredRows] = await Promise.all([
      ctx.db
        .query("taskRunInteractions")
        .withIndex("by_dispatch_state_created", (query) =>
          query.eq("dispatchId", dispatch._id).eq("state", "pending"))
        .take(MAX_RUN_INTERACTION_VIEWS + 1),
      ctx.db
        .query("taskRunInteractions")
        .withIndex("by_dispatch_state_created", (query) =>
          query.eq("dispatchId", dispatch._id).eq("state", "answered"))
        .take(MAX_RUN_INTERACTION_VIEWS + 1),
    ]);
    const openInteractionCount = pendingRows.length + answeredRows.length;
    if (
      pendingRows.length > MAX_RUN_INTERACTION_VIEWS ||
      answeredRows.length > MAX_RUN_INTERACTION_VIEWS ||
      openInteractionCount > MAX_RUN_INTERACTION_VIEWS
    ) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const lifetimeRows = await ctx.db
      .query("taskRunInteractions")
      .withIndex("by_dispatch_and_created", (query) => query.eq("dispatchId", dispatch._id))
      .take(MAX_RUN_INTERACTIONS_PER_RUN + 1);
    if (lifetimeRows.length > MAX_RUN_INTERACTIONS_PER_RUN) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    if (lifetimeRows.some((interaction) =>
      interaction.organizationId !== dispatch.organizationId ||
      interaction.workspaceId !== dispatch.workspaceId ||
      interaction.dispatchId !== dispatch._id ||
      interaction.runnerId !== runner._id ||
      interaction.runnerPublicId !== runner.publicId ||
      interaction.bootId !== parsed.data.bootId ||
      interaction.bootGeneration !== parsed.data.bootGeneration ||
      interaction.claimPublicId !== parsed.data.claimId ||
      interaction.claimFence !== parsed.data.claimFence ||
      !runInteractionIdSchema.safeParse(interaction.publicId).success
    )) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }

    type PreparedSettlement = Readonly<{
      disposition: "apply" | "replay";
      interaction: Doc<"taskRunInteractions">;
      parsedRequest?: RunInteractionRequest;
      rows: readonly Doc<"taskRunInteractionResponses">[];
      target: "expired" | "resolved";
    }>;
    type PreparedUpsert = Readonly<{
      digest: string;
      request: RunInteractionRequest;
      state: "expired" | "pending";
    }>;

    // Convex commits writes even when a handler returns a typed domain failure.
    // Resolve and validate the complete mixed batch before deleting ciphertext,
    // compacting requests, or inserting a new interaction.
    const preparedSettlements: PreparedSettlement[] = [];
    for (const settlement of parsed.data.settlements) {
      const interaction = await ctx.db
        .query("taskRunInteractions")
        .withIndex("by_public_id", (query) => query.eq("publicId", settlement.interactionId))
        .unique();
      if (
        interaction === null ||
        interaction.organizationId !== dispatch.organizationId ||
        interaction.workspaceId !== dispatch.workspaceId ||
        interaction.dispatchId !== dispatch._id ||
        interaction.runnerId !== runner._id ||
        interaction.runnerPublicId !== runner.publicId ||
        interaction.bootId !== parsed.data.bootId ||
        interaction.bootGeneration !== parsed.data.bootGeneration ||
        interaction.claimPublicId !== parsed.data.claimId ||
        interaction.claimFence !== parsed.data.claimFence
      ) {
        return domainFailure("CLAIM_STALE", args.requestId);
      }
      const target = settlement.outcome === "applied" ? "resolved" as const : "expired" as const;
      const disposition = runInteractionSettlementDisposition({
        durableState: interaction.state,
        settlement: settlement.outcome === "applied"
          ? settlement
          : {
              interactionId: settlement.interactionId,
              outcome: "expired",
              reason: settlement.reason,
              ...(settlement.responseRevision === undefined
                ? {}
                : { responseRevision: settlement.responseRevision }),
            },
        ...(interaction.responseRevision === undefined
          ? {}
          : { durableResponseRevision: interaction.responseRevision }),
      });
      if (disposition === "reject") {
        return domainFailure("TASK_STATE_CONFLICT", args.requestId);
      }
      const rows = await responseRows(ctx, interaction._id);
      if (
        rows.some((row) =>
          row.organizationId !== dispatch.organizationId ||
          row.workspaceId !== dispatch.workspaceId ||
          row.dispatchId !== dispatch._id ||
          row.interactionId !== interaction._id
        ) ||
        !runInteractionResponseProjectionMatches({
          durableState: interaction.state,
          responseRevisions: rows.map(({ responseRevision }) => responseRevision),
          ...(interaction.responseRevision === undefined
            ? {}
            : { durableResponseRevision: interaction.responseRevision }),
        })
      ) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      const request = disposition === "apply"
        ? runInteractionRequestSchema.safeParse(interaction.request)
        : null;
      if (request !== null && !request.success) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      preparedSettlements.push({
        disposition,
        interaction,
        ...(request?.success === true ? { parsedRequest: request.data } : {}),
        rows,
        target,
      });
    }

    const preparedUpserts: PreparedUpsert[] = [];
    for (const request of parsed.data.upserts) {
      const computedRequestDigest = await createRunInteractionRequestDigest(
        interactionRequestPayload(request),
      );
      if (
        request.createdAt > now + MAX_INTERACTION_CLOCK_SKEW_MS ||
        request.createdAt < now - MAX_RUN_INTERACTION_TTL_MS - MAX_INTERACTION_CLOCK_SKEW_MS ||
        request.expiresAt > now + MAX_RUN_INTERACTION_TTL_MS + MAX_INTERACTION_CLOCK_SKEW_MS ||
        request.reply.runnerId !== parsed.data.runnerId ||
        request.reply.bootId !== parsed.data.bootId ||
        request.reply.bootGeneration !== parsed.data.bootGeneration ||
        request.reply.claimId !== parsed.data.claimId ||
        request.reply.claimFence !== parsed.data.claimFence ||
        request.reply.requestDigest !== computedRequestDigest
      ) {
        return domainFailure("VALIDATION_ERROR", args.requestId);
      }
      const digest = humanTaskMutationDigest("dispatch.interaction.upsert", request);
      const existing = await ctx.db
        .query("taskRunInteractions")
        .withIndex("by_public_id", (query) => query.eq("publicId", request.id))
        .unique();
      if (existing !== null) {
        if (
          existing.organizationId !== dispatch.organizationId ||
          existing.workspaceId !== dispatch.workspaceId ||
          existing.dispatchId !== dispatch._id ||
          existing.runnerId !== runner._id ||
          existing.bootId !== parsed.data.bootId ||
          existing.bootGeneration !== parsed.data.bootGeneration ||
          existing.claimPublicId !== parsed.data.claimId ||
          existing.claimFence !== parsed.data.claimFence ||
          existing.requestDigest !== digest
        ) {
          return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
        }
        continue;
      }
      const state = request.expiresAt <= now ? "expired" as const : "pending" as const;
      preparedUpserts.push({ digest, request, state });
    }

    const admission = planRunInteractionBatchAdmission({
      lifetimeInteractionCount: lifetimeRows.length,
      maximumOpenInteractions: MAX_RUN_INTERACTION_VIEWS,
      newInteractionStates: preparedUpserts.map(({ state }) => state),
      openInteractionCount,
      settlements: preparedSettlements.map(({ disposition, interaction }) => ({
        disposition,
        durableState: interaction.state,
      })),
    });
    if (admission.kind === "invalid") {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    if (admission.kind === "terminal_limit") {
      return domainFailure("RUN_INTERACTION_LIMIT", args.requestId);
    }
    if (admission.kind === "capacity_full") {
      return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
    }

    const settledAnsweredIds = new Set(preparedSettlements
      .filter(({ disposition, interaction }) =>
        disposition === "apply" && interaction.state === "answered")
      .map(({ interaction }) => interaction._id));
    const responsePage = boundedRunInteractionPage(
      answeredRows.filter((interaction) => !settledAnsweredIds.has(interaction._id)),
      MAX_RUN_INTERACTION_RESPONSES,
    );
    const responses: Array<{
      interactionId: string;
      responseRevision: number;
      sealedResponse: Doc<"taskRunInteractionResponses">["sealedResponse"];
    }> = [];
    for (const interaction of responsePage.items) {
      const rows = await responseRows(ctx, interaction._id);
      const row = rows[0];
      const sealed = row === undefined
        ? null
        : sealedRunInteractionResponseSchema.safeParse(row.sealedResponse);
      const durableRequest = runInteractionRequestSchema.safeParse(interaction.request);
      if (
        row === undefined ||
        sealed === null ||
        !sealed.success ||
        !durableRequest.success ||
        row.organizationId !== dispatch.organizationId ||
        row.workspaceId !== dispatch.workspaceId ||
        row.dispatchId !== dispatch._id ||
        row.interactionId !== interaction._id ||
        !runInteractionDeliveryProjectionMatches({
          authority: {
            workspaceId: authorized.authorization.workspacePublicId,
            runnerId: runner.publicId,
            bootId: dispatch.bootId,
            bootGeneration: dispatch.bootGeneration,
            claimId: dispatch.taskClaimPublicId,
            claimFence: dispatch.claimFence,
          },
          reply: durableRequest.data.reply,
          sealed: sealed.data,
        }) ||
        !runInteractionResponseProjectionMatches({
          durableState: interaction.state,
          responseRevisions: rows.map(({ responseRevision }) => responseRevision),
          ...(interaction.responseRevision === undefined
            ? {}
            : { durableResponseRevision: interaction.responseRevision }),
        })
      ) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      responses.push({
        interactionId: interaction.publicId,
        responseRevision: row.responseRevision,
        sealedResponse: persistedSealedResponse(sealed.data),
      });
    }

    const acceptedSettlementPublicIds = new Set(preparedSettlements
      .map(({ interaction }) => interaction.publicId));
    const existingExpiredInteractions = pendingExpiredInteractionPage(
      lifetimeRows.filter((interaction) =>
        interaction.state === "expired" &&
        !acceptedSettlementPublicIds.has(interaction.publicId)),
      MAX_RUN_INTERACTIONS_PER_RUN,
    ).map((interaction) => ({
      interactionId: interaction.publicId,
      ...(interaction.responseRevision === undefined
        ? {}
        : { responseRevision: interaction.responseRevision }),
    }));
    const newExpiredInteractions = preparedUpserts
      .filter(({ state }) => state === "expired")
      .map(({ request }) => ({ interactionId: request.id }));
    const expiredPage = boundedRunInteractionPage(
      [...existingExpiredInteractions, ...newExpiredInteractions],
      MAX_RUN_INTERACTION_RESPONSES,
    );
    const expiredInteractions = [...expiredPage.items];

    const acceptedSettlementIds = preparedSettlements.map(({ interaction }) =>
      interaction.publicId);
    for (const prepared of preparedSettlements) {
      for (const row of prepared.rows) await ctx.db.delete(row._id);
      if (prepared.disposition === "apply") {
        if (prepared.parsedRequest === undefined) {
          throw new Error("Prepared interaction settlement lost its parsed request.");
        }
        await ctx.db.patch(prepared.interaction._id, {
          taskId: dispatch.taskId,
          request: persistedRequest(compactedRequest(prepared.parsedRequest)),
          state: prepared.target,
          resolvedAt: now,
          ...(prepared.target === "expired" ? { settlementAcknowledgedAt: now } : {}),
          updatedAt: now,
        });
      } else if (prepared.interaction.state === "expired") {
        await ctx.db.patch(prepared.interaction._id, {
          taskId: dispatch.taskId,
          settlementAcknowledgedAt: now,
          updatedAt: now,
        });
      }
    }

    for (const { digest, request, state } of preparedUpserts) {
      const interactionId = await ctx.db.insert("taskRunInteractions", {
        organizationId: dispatch.organizationId,
        workspaceId: dispatch.workspaceId,
        dispatchId: dispatch._id,
        taskId: dispatch.taskId,
        publicId: request.id,
        runnerId: runner._id,
        runnerPublicId: runner.publicId,
        bootId: parsed.data.bootId,
        bootGeneration: parsed.data.bootGeneration,
        claimPublicId: parsed.data.claimId,
        claimFence: parsed.data.claimFence,
        request: persistedRequest(state === "expired" ? compactedRequest(request) : request),
        requestDigest: digest,
        state,
        expiresAt: request.expiresAt,
        ...(state === "expired" ? { resolvedAt: now } : {}),
        createdAt: now,
        updatedAt: now,
      });
      if (state === "pending") {
        await ctx.scheduler.runAt(
          request.expiresAt,
          internal.dispatchInteractions.expireRunInteraction,
          { interactionId, expectedExpiresAt: request.expiresAt },
        );
      }
    }
    for (const interaction of lifetimeRows) {
      if (interaction.taskId === undefined) {
        await ctx.db.patch(interaction._id, { taskId: dispatch.taskId });
      }
    }
    await refreshTaskHumanInputProjection(ctx, dispatch.taskId);
    if (
      preparedUpserts.length > 0 ||
      preparedSettlements.some(({ disposition }) => disposition === "apply")
    ) {
      await advanceWorkspaceProjectionById(ctx, dispatch.workspaceId, now);
    }
    const acceptedInteractionIds = parsed.data.upserts.map(({ id }) => id);
    await touchAuthorizedAgent(ctx, authorized.authorization, now);
    return {
      ok: true as const,
      data: {
        serverTime: now,
        acceptedInteractionIds,
        acceptedSettlementIds,
        responses,
        expiredInteractions,
        hasMoreResponses: responsePage.hasMore || expiredPage.hasMore,
      },
      requestId: args.requestId,
    };
  },
});

export const expireRunInteraction = internalMutation({
  args: {
    interactionId: v.id("taskRunInteractions"),
    expectedExpiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const interaction = await ctx.db.get(args.interactionId);
    const now = Date.now();
    if (
      interaction === null ||
      interaction.expiresAt !== args.expectedExpiresAt ||
      interaction.expiresAt > now ||
      (interaction.state !== "pending" && interaction.state !== "answered")
    ) {
      return null;
    }
    const rows = await responseRows(ctx, interaction._id);
    for (const row of rows) await ctx.db.delete(row._id);
    const request = runInteractionRequestSchema.parse(interaction.request);
    const dispatch = await ctx.db.get(interaction.dispatchId);
    if (
      dispatch === null ||
      dispatch.organizationId !== interaction.organizationId ||
      dispatch.workspaceId !== interaction.workspaceId
    ) {
      throw new Error("Expiring interaction lost its tenant-scoped dispatch.");
    }
    await ctx.db.patch(interaction._id, {
      taskId: dispatch.taskId,
      request: persistedRequest(compactedRequest(request)),
      state: "expired",
      resolvedAt: now,
      updatedAt: now,
    });
    await refreshTaskHumanInputProjection(ctx, dispatch.taskId);
    await advanceWorkspaceProjectionById(
      ctx,
      interaction.workspaceId,
      now,
    );
    return null;
  },
});

export const respondToRunInteraction = mutation({
  args: {
    workspaceId: v.string(),
    idempotencyKey: v.string(),
    runId: v.string(),
    interactionId: v.string(),
    sealedResponse: sealedRunInteractionResponseValidator,
    hraOperationId: v.optional(v.string()),
    expectedProjectionHead: v.optional(v.number()),
  },
  returns: answerResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    const sealedResponse = sealedRunInteractionResponseSchema.safeParse(args.sealedResponse);
    if (
      !validPublicScope(args) ||
      !dispatchIdSchema.safeParse(args.runId).success ||
      !runInteractionIdSchema.safeParse(args.interactionId).success ||
      !sealedResponse.success ||
      sealedResponse.data.workspaceId !== args.workspaceId
    ) {
      return domainFailure("VALIDATION_ERROR", requestId);
    }
    return await runHumanTaskMutation(ctx, {
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey,
      requestDigest: humanTaskMutationDigest("dispatch.interaction.respond", {
        runId: args.runId,
        interactionId: args.interactionId,
        sealedResponse: sealedResponse.data,
      }),
      requestId,
      ...(args.hraOperationId === undefined
        ? {}
        : { hraOperationId: args.hraOperationId }),
      ...(args.expectedProjectionHead === undefined
        ? {}
        : { expectedProjectionHead: args.expectedProjectionHead }),
    }, {
      capability: "dispatch",
      hostedAttemptOperation: "interaction.respond",
      hostedAttemptIntent: () => ({
        kind: "interaction.respond",
        interactionId: args.interactionId,
        runId: args.runId,
      }),
      operation: "dispatch.interaction.respond",
      parseReceipt: parseAnswerReceipt,
      execute: async ({ authorization, now }) => {
        const [dispatch, interaction] = await Promise.all([
          ctx.db.query("taskDispatches").withIndex("by_public_id", (query) =>
            query.eq("publicId", args.runId)).unique(),
          ctx.db.query("taskRunInteractions").withIndex("by_public_id", (query) =>
            query.eq("publicId", args.interactionId)).unique(),
        ]);
        if (
          dispatch === null ||
          interaction === null ||
          !isBoundDispatch(dispatch) ||
          dispatch.organizationId !== authorization.organization._id ||
          dispatch.workspaceId !== authorization.workspace._id ||
          interaction.organizationId !== dispatch.organizationId ||
          interaction.workspaceId !== dispatch.workspaceId ||
          interaction.dispatchId !== dispatch._id
        ) {
          return domainFailure("NOT_FOUND", requestId);
        }
        if (
          interaction.state !== "pending" ||
          interaction.expiresAt <= now ||
          dispatch.leaseUntil <= now ||
          dispatch.desiredState !== "run" ||
          (dispatch.phase !== "running" && dispatch.phase !== "waiting")
        ) {
          return domainFailure("TASK_STATE_CONFLICT", requestId);
        }
        const runner = await ctx.db.get(dispatch.runnerId);
        if (
          runner === null ||
          interaction.runnerId !== dispatch.runnerId ||
          interaction.runnerPublicId !== runner.publicId ||
          interaction.bootId !== dispatch.bootId ||
          interaction.bootGeneration !== dispatch.bootGeneration ||
          interaction.claimPublicId !== dispatch.taskClaimPublicId ||
          interaction.claimFence !== dispatch.claimFence ||
          !(await currentAuthorityOwnsRunner(ctx, runner, now))
        ) {
          return domainFailure("CLAIM_STALE", requestId);
        }
        const request = runInteractionRequestSchema.safeParse(interaction.request);
        if (
          !request.success ||
          sealedResponse.data.workspaceId !== authorization.workspace.publicId ||
          sealedResponse.data.keyId !== request.data.reply.keyId ||
          request.data.reply.runnerId !== runner.publicId ||
          request.data.reply.bootId !== dispatch.bootId ||
          request.data.reply.bootGeneration !== dispatch.bootGeneration ||
          request.data.reply.claimId !== dispatch.taskClaimPublicId ||
          request.data.reply.claimFence !== dispatch.claimFence
        ) {
          return domainFailure("VALIDATION_ERROR", requestId);
        }
        const rows = await responseRows(ctx, interaction._id);
        if (rows.length !== 0) return domainFailure("PROJECTION_MISMATCH", requestId);
        const responseRevision = 1;
        await ctx.db.insert("taskRunInteractionResponses", {
          organizationId: dispatch.organizationId,
          workspaceId: dispatch.workspaceId,
          dispatchId: dispatch._id,
          interactionId: interaction._id,
          responseRevision,
          sealedResponse: persistedSealedResponse(sealedResponse.data),
          createdAt: now,
        });
        await ctx.db.patch(interaction._id, {
          taskId: dispatch.taskId,
          state: "answered",
          responseRevision,
          respondedByUserId: authorization.user._id,
          respondedAt: now,
          updatedAt: now,
        });
        await refreshTaskHumanInputProjection(ctx, dispatch.taskId);
        await advanceWorkspaceProjectionById(ctx, dispatch.workspaceId, now);
        return {
          ok: true as const,
          data: { interactionId: interaction.publicId, responseRevision, state: "answered" as const },
        };
      },
    });
  },
});
