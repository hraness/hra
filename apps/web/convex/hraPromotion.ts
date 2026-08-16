import {
  advancePromotionFamilyDigest,
  initialPromotionFamilyProgressMap,
  promotionAbortReceiptV2Digest,
  promotionAbortReceiptV2Schema,
  promotionActivationReceiptV2Digest,
  promotionActivationReceiptV2Schema,
  promotionBatchOrderDisposition,
  promotionBatchReceiptV2Schema,
  promotionBatchReplayDisposition,
  promotionBatchV2Schema,
  promotionCleanupProgressSchema,
  promotionEntityFamilyValues,
  promotionEntityIdentity,
  promotionEntitySchema,
  promotionFamilyInitialDigest,
  promotionManifestV2Schema,
  promotionUploadProgressSchema,
  workspacePromotionStateV2Schema,
  type PromotionEntity,
  type PromotionManifestV2,
  type PromotionUploadProgress,
} from "@hraness/agent-tasks-domain";
import {
  startHRAPromotionRequestSchema,
  acceptHRAPromotionBatchRequestSchema,
  activateHRAPromotionRequestSchema,
  abortHRAPromotionRequestSchema,
} from "@hraness/agent-tasks-protocol";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  assertRequestMetadata,
  domainFailure,
  randomCrockford,
} from "./domain";
import { authorizeOrganizationHuman } from "./humanAuthorization";
import { humanTaskMutationDigest } from "./humanTaskMutations";

const VALIDATION_PAGE_SIZE = 100;
const RECEIPT_CURSOR_PREFIX = "promotion_receipts_v1_";
const CLEANUP_CURSOR_PREFIX = "promotion_cleanup_v1_";
// These operation names are inputs to persisted idempotency receipt digests.
// New HRA code keeps their v1 bytes stable for replay compatibility.
const STABLE_PROMOTION_IDEMPOTENCY_OPERATIONS = {
  abort: "kitchen.promotions.abort",
  activate: "kitchen.promotions.activate",
  batch: "kitchen.promotions.batch",
  cleanup: "kitchen.promotions.cleanup",
  start: "kitchen.promotions.start",
} as const;

type PromotionReadCtx = QueryCtx | MutationCtx;

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
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 8_192) return null;
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

type PromotionCursor = Readonly<{
  promotionId: string;
  organizationId: string;
  userId: string;
  continuation: string;
}>;

function encodePromotionCursor(
  prefix: typeof RECEIPT_CURSOR_PREFIX | typeof CLEANUP_CURSOR_PREFIX,
  cursor: PromotionCursor,
): string {
  return `${prefix}${base64UrlEncode(JSON.stringify(cursor))}`;
}

function decodePromotionCursor(
  value: string,
  prefix: typeof RECEIPT_CURSOR_PREFIX | typeof CLEANUP_CURSOR_PREFIX,
): PromotionCursor | null {
  if (!value.startsWith(prefix)) return null;
  const decoded = base64UrlDecode(value.slice(prefix.length));
  if (decoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.promotionId !== "string" ||
    typeof parsed.organizationId !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.continuation !== "string"
  ) {
    return null;
  }
  return {
    promotionId: parsed.promotionId,
    organizationId: parsed.organizationId,
    userId: parsed.userId,
    continuation: parsed.continuation,
  };
}

function parseManifest(
  session: Readonly<{ manifestJson: string }>,
): PromotionManifestV2 {
  return promotionManifestV2Schema.parse(
    JSON.parse(session.manifestJson) as unknown,
  );
}

function parseProgress(
  session: Readonly<{ progressJson: string }>,
): PromotionUploadProgress {
  return promotionUploadProgressSchema.parse(
    JSON.parse(session.progressJson) as unknown,
  );
}

/**
 * Empty families are represented by their canonical digest and do not require
 * an invented empty batch. This advances only the fixed family cursor.
 */
export function completeEmptyPromotionFamilies(
  manifest: PromotionManifestV2,
  input: PromotionUploadProgress,
): PromotionUploadProgress {
  const progress = structuredClone(input);
  while (progress.activeFamilyIndex < promotionEntityFamilyValues.length) {
    const family = promotionEntityFamilyValues[progress.activeFamilyIndex];
    if (family === undefined || manifest.counts[family] !== 0) break;
    progress.families[family] = {
      ...progress.families[family],
      complete: true,
    };
    progress.activeFamilyIndex += 1;
  }
  return promotionUploadProgressSchema.parse(progress);
}

function initialProgress(manifest: PromotionManifestV2): PromotionUploadProgress {
  return completeEmptyPromotionFamilies(manifest, {
    activeFamilyIndex: 0,
    receiptCount: 0,
    acceptedEntityCount: 0,
    families: initialPromotionFamilyProgressMap(),
  });
}

async function activeStoredPromotionAuthorization(
  ctx: PromotionReadCtx,
  session: Doc<"promotionSessions">,
): Promise<boolean> {
  const [organization, user, membership] = await Promise.all([
    ctx.db.get(session.organizationId),
    ctx.db.get(session.startedByUserId),
    ctx.db.get(session.authorizationMembershipId),
  ]);
  return (
    organization !== null &&
    user !== null &&
    membership !== null &&
    organization.status === "active" &&
    user.status === "active" &&
    organization._id === session.organizationId &&
    organization.publicId === session.organizationPublicId &&
    user._id === session.startedByUserId &&
    user.workosUserId === session.startedByWorkosUserId &&
    membership._id === session.authorizationMembershipId &&
    membership.organizationId === session.organizationId &&
    membership.userId === session.startedByUserId &&
    membership.status === "active" &&
    (membership.role === "owner" || membership.role === "admin")
  );
}

async function authorizePromotion(
  ctx: PromotionReadCtx,
  promotionId: string,
  requestId: string,
) {
  const authorized = await authorizeOrganizationHuman(ctx, { requestId });
  if (!authorized.ok) return authorized;
  const session = await ctx.db
    .query("promotionSessions")
    .withIndex("by_public_id", (query) => query.eq("publicId", promotionId))
    .unique();
  if (
    session === null ||
    session.organizationId !== authorized.authorization.organization._id ||
    session.organizationPublicId !==
      authorized.authorization.organization.publicId ||
    session.startedByUserId !== authorized.authorization.user._id ||
    session.authorizationMembershipId !==
      authorized.authorization.membership._id
  ) {
    return domainFailure("NOT_FOUND", requestId);
  }
  return {
    ok: true as const,
    authorization: authorized.authorization,
    session,
  };
}

type PublicPromotionSession = Pick<
  Doc<"promotionSessions">,
  | "state"
  | "publicId"
  | "sourceWorkspacePublicId"
  | "stagingWorkspacePublicId"
  | "manifestRoot"
  | "manifestJson"
  | "progressJson"
  | "activationReceiptJson"
  | "abortReceiptJson"
  | "rejectionCode"
>;

export function publicPromotionState(session: PublicPromotionSession) {
  const manifest = parseManifest(session);
  if (session.state === "activated") {
    if (session.activationReceiptJson === undefined) {
      throw new Error("Activated promotion lost its decision proof.");
    }
    return workspacePromotionStateV2Schema.parse({
      schemaVersion: 2,
      promotionId: session.publicId,
      manifest,
      stagingWorkspaceId: session.stagingWorkspacePublicId,
      localWritable: false,
      state: "activated",
      activationReceipt: JSON.parse(session.activationReceiptJson) as unknown,
    });
  }
  if (session.state === "aborted") {
    if (session.abortReceiptJson === undefined) {
      throw new Error("Aborted promotion lost its decision proof.");
    }
    return workspacePromotionStateV2Schema.parse({
      schemaVersion: 2,
      state: "aborted",
      promotionId: session.publicId,
      sourceWorkspaceId: session.sourceWorkspacePublicId,
      manifestRoot: session.manifestRoot,
      stagingWorkspaceId: session.stagingWorkspacePublicId,
      abortReceipt: JSON.parse(session.abortReceiptJson) as unknown,
      localWritable: true,
    });
  }
  if (session.state === "rejected") {
    if (session.rejectionCode === undefined) {
      throw new Error("Rejected promotion lost its rejection proof.");
    }
    return workspacePromotionStateV2Schema.parse({
      schemaVersion: 2,
      promotionId: session.publicId,
      manifest,
      stagingWorkspaceId: session.stagingWorkspacePublicId,
      localWritable: false,
      state: "rejected",
      rejectionCode: session.rejectionCode,
      progress: parseProgress(session),
    });
  }
  return workspacePromotionStateV2Schema.parse({
    schemaVersion: 2,
    promotionId: session.publicId,
    manifest,
    stagingWorkspaceId: session.stagingWorkspacePublicId,
    localWritable: false,
    state: session.state,
    progress: parseProgress(session),
  });
}

export const start = internalMutation({
  args: {
    body: v.any(),
    idempotencyKey: v.string(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const parsed = startHRAPromotionRequestSchema.safeParse(args.body);
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", args.requestId);
    const requestDigest = humanTaskMutationDigest(
      STABLE_PROMOTION_IDEMPOTENCY_OPERATIONS.start,
      parsed.data,
    );
    const metadata = assertRequestMetadata({
      idempotencyKey: args.idempotencyKey,
      requestDigest,
      requestId: args.requestId,
      now: Date.now(),
    });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizeOrganizationHuman(ctx, {
      requestId: args.requestId,
      allowedRoles: ["owner", "admin"],
    });
    if (!authorized.ok) return authorized;
    if (
      parsed.data.organizationId !==
      authorized.authorization.organization.publicId
    ) {
      return domainFailure("ORGANIZATION_MISMATCH", args.requestId);
    }
    const manifest = parsed.data.manifest;
    if (manifest.counts.task_bodies !== manifest.counts.tasks) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const existing = await ctx.db
      .query("promotionSessions")
      .withIndex("by_public_id", (query) =>
        query.eq("publicId", manifest.promotionId))
      .unique();
    if (existing !== null) {
      if (
        existing.organizationId !== authorized.authorization.organization._id ||
        existing.startedByUserId !== authorized.authorization.user._id
      ) {
        return domainFailure("NOT_FOUND", args.requestId);
      }
      if (
        existing.manifestRoot !== manifest.rootDigest ||
        existing.manifestJson !== JSON.stringify(manifest) ||
        existing.startIdempotencyKey !== args.idempotencyKey ||
        existing.startRequestDigest !== requestDigest
      ) {
        return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
      }
      return {
        ok: true as const,
        data: {
          promotionId: existing.publicId,
          stagingWorkspaceId: existing.stagingWorkspacePublicId,
          state: "receiving" as const,
        },
        requestId: args.requestId,
      };
    }
    const now = Date.now();
    const stagingWorkspacePublicId = `wsp_${randomCrockford(26)}`;
    const stagingWorkspaceId = await ctx.db.insert("workspaces", {
      organizationId: authorized.authorization.organization._id,
      publicId: stagingWorkspacePublicId,
      slug: `staging-${randomCrockford(16).toLowerCase()}`,
      name: "HRA import staging",
      taskKeyPrefix: "TMP",
      status: "staging",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceUsage", {
      organizationId: authorized.authorization.organization._id,
      workspaceId: stagingWorkspaceId,
      activeTasks: 0,
      totalTasks: 0,
      activeAgents: 0,
      updatedAt: now,
    });
    const progress = initialProgress(manifest);
    const sessionId = await ctx.db.insert("promotionSessions", {
      publicId: manifest.promotionId,
      organizationId: authorized.authorization.organization._id,
      organizationPublicId: authorized.authorization.organization.publicId,
      startedByUserId: authorized.authorization.user._id,
      startedByWorkosUserId:
        authorized.authorization.user.workosUserId ??
        authorized.authorization.subject,
      authorizationMembershipId: authorized.authorization.membership._id,
      sourceWorkspacePublicId: manifest.sourceWorkspaceId,
      stagingWorkspaceId,
      stagingWorkspacePublicId,
      manifestRoot: manifest.rootDigest,
      manifestJson: JSON.stringify(manifest),
      progressJson: JSON.stringify(progress),
      startIdempotencyKey: args.idempotencyKey,
      startRequestDigest: requestDigest,
      state: "receiving",
      decisionSequence: 0,
      createdAt: now,
      updatedAt: now,
    });
    if (
      progress.activeFamilyIndex === promotionEntityFamilyValues.length
    ) {
      await ctx.db.patch(sessionId, {
        state: "validating",
        validationFamilyIndex: 0,
        validationCount: 0,
        validationDigest: promotionFamilyInitialDigest(
          promotionEntityFamilyValues[0] ?? "workspace_metadata",
        ),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.hraPromotion.validatePage,
        { sessionId },
      );
    }
    return {
      ok: true as const,
      data: {
        promotionId: manifest.promotionId,
        stagingWorkspaceId: stagingWorkspacePublicId,
        state: "receiving" as const,
      },
      requestId: args.requestId,
    };
  },
});

export const acceptBatch = internalMutation({
  args: {
    promotionId: v.string(),
    body: v.any(),
    idempotencyKey: v.string(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const parsed = acceptHRAPromotionBatchRequestSchema.safeParse(args.body);
    if (
      !parsed.success ||
      parsed.data.batch.promotionId !== args.promotionId
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const metadata = assertRequestMetadata({
      idempotencyKey: args.idempotencyKey,
      requestDigest: humanTaskMutationDigest(
        STABLE_PROMOTION_IDEMPOTENCY_OPERATIONS.batch,
        parsed.data,
      ),
      requestId: args.requestId,
      now: Date.now(),
    });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizePromotion(
      ctx,
      args.promotionId,
      args.requestId,
    );
    if (!authorized.ok) return authorized;
    if (
      authorized.authorization.role !== "owner" &&
      authorized.authorization.role !== "admin"
    ) {
      return domainFailure("WORKSPACE_ROLE_REQUIRED", args.requestId);
    }
    const { session } = authorized;
    const batch = promotionBatchV2Schema.parse(parsed.data.batch);
    const existing = await ctx.db
      .query("promotionBatchReceipts")
      .withIndex("by_session_and_batch", (query) =>
        query
          .eq("promotionSessionId", session._id)
          .eq("batchId", batch.batchId))
      .unique();
    if (existing !== null) {
      const receipt = promotionBatchReceiptV2Schema.parse(
        JSON.parse(existing.receiptJson) as unknown,
      );
      const disposition = promotionBatchReplayDisposition(receipt, batch);
      return disposition === "replay"
        ? {
            ok: true as const,
            data: { receipt },
            requestId: args.requestId,
          }
        : domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
    }
    if (session.state !== "receiving") {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId);
    }
    const manifest = parseManifest(session);
    const progress = parseProgress(session);
    if (promotionBatchOrderDisposition(progress, batch) !== "accept") {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId);
    }
    const advanced = advancePromotionFamilyDigest(
      batch.family,
      {
        count: batch.previousFamilyCount,
        digest: batch.previousFamilyDigest,
        lastEntityIdentity: batch.previousEntityIdentity,
      },
      batch.items,
    );
    if (advanced.count > manifest.counts[batch.family]) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const now = Date.now();
    for (const item of batch.items) {
      const identity = promotionEntityIdentity(item);
      const duplicate = await ctx.db
        .query("promotionStagedEntities")
        .withIndex("by_session_family_identity", (query) =>
          query
            .eq("promotionSessionId", session._id)
            .eq("family", batch.family)
            .eq("identity", identity))
        .unique();
      if (duplicate !== null) {
        return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
      }
    }
    for (const item of batch.items) {
      await ctx.db.insert("promotionStagedEntities", {
        promotionSessionId: session._id,
        promotionPublicId: session.publicId,
        family: batch.family,
        identity: promotionEntityIdentity(item),
        entityJson: JSON.stringify(item),
        acceptedAt: now,
      });
    }
    const familyProgress = progress.families[batch.family];
    const completesFamily =
      advanced.count === manifest.counts[batch.family];
    if (
      completesFamily &&
      advanced.digest !== manifest.familyDigests[batch.family]
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    progress.families[batch.family] = {
      family: batch.family,
      acceptedBatchCount: familyProgress.acceptedBatchCount + 1,
      acceptedEntityCount: advanced.count,
      cumulativeDigest: advanced.digest,
      lastEntityIdentity: advanced.lastEntityIdentity,
      complete: completesFamily,
    };
    progress.receiptCount += 1;
    progress.acceptedEntityCount += batch.items.length;
    if (completesFamily) progress.activeFamilyIndex += 1;
    const completed = completeEmptyPromotionFamilies(manifest, progress);
    const cumulativeCounts = Object.fromEntries(
      promotionEntityFamilyValues.map((family) => [
        family,
        completed.families[family].acceptedEntityCount,
      ]),
    );
    const receipt = promotionBatchReceiptV2Schema.parse({
      schemaVersion: 2,
      promotionId: session.publicId,
      batchId: batch.batchId,
      family: batch.family,
      ordinal: batch.ordinal,
      itemCount: batch.items.length,
      requestDigest: batch.requestDigest,
      acceptedRequestDigest: batch.requestDigest,
      previousFamilyCount: batch.previousFamilyCount,
      previousFamilyDigest: batch.previousFamilyDigest,
      cumulativeFamilyCount: advanced.count,
      cumulativeFamilyDigest: advanced.digest,
      lastEntityIdentity: advanced.lastEntityIdentity,
      acceptedAt: now,
      cumulativeCounts,
    });
    await ctx.db.insert("promotionBatchReceipts", {
      promotionSessionId: session._id,
      promotionPublicId: session.publicId,
      batchId: batch.batchId,
      family: batch.family,
      ordinal: batch.ordinal,
      requestDigest: batch.requestDigest,
      receiptJson: JSON.stringify(receipt),
      acceptedAt: now,
    });
    const uploadComplete =
      completed.activeFamilyIndex === promotionEntityFamilyValues.length;
    await ctx.db.patch(session._id, {
      progressJson: JSON.stringify(completed),
      ...(uploadComplete
        ? {
            state: "validating" as const,
            validationFamilyIndex: 0,
            validationCount: 0,
            validationDigest: promotionFamilyInitialDigest(
              promotionEntityFamilyValues[0] ?? "workspace_metadata",
            ),
            validationLastIdentity: undefined,
          }
        : {}),
      updatedAt: now,
    });
    if (uploadComplete) {
      await ctx.scheduler.runAfter(
        0,
        internal.hraPromotion.validatePage,
        { sessionId: session._id },
      );
    }
    return {
      ok: true as const,
      data: { receipt },
      requestId: args.requestId,
    };
  },
});

export const validatePage = internalMutation({
  args: { sessionId: v.id("promotionSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null || session.state !== "validating") return null;
    const now = Date.now();
    if (!(await activeStoredPromotionAuthorization(ctx, session))) {
      await ctx.db.patch(session._id, {
        state: "rejected",
        rejectionCode: "authorization_lost",
        updatedAt: now,
      });
      return null;
    }
    const manifest = parseManifest(session);
    const familyIndex = session.validationFamilyIndex ?? 0;
    if (familyIndex >= promotionEntityFamilyValues.length) {
      await ctx.db.patch(session._id, {
        state: "projecting",
        projectionFamilyIndex: 0,
        projectionCursor: undefined,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.hraPromotionProjection.projectPage,
        { sessionId: session._id },
      );
      return null;
    }
    const family = promotionEntityFamilyValues[familyIndex];
    if (family === undefined) throw new Error("Promotion family index is invalid.");
    const page = await ctx.db
      .query("promotionStagedEntities")
      .withIndex("by_session_family_identity", (query) =>
        query
          .eq("promotionSessionId", session._id)
          .eq("family", family))
      .paginate({
        cursor: session.validationCursor ?? null,
        numItems: VALIDATION_PAGE_SIZE,
      });
    let checkpoint = {
      count: session.validationCount ?? 0,
      digest:
        session.validationDigest ?? promotionFamilyInitialDigest(family),
      lastEntityIdentity: session.validationLastIdentity ?? null,
    };
    try {
      const entities = page.page.map((row) => {
        const entity = promotionEntitySchema.parse(
          JSON.parse(row.entityJson) as unknown,
        );
        if (
          entity.family !== family ||
          promotionEntityIdentity(entity) !== row.identity ||
          row.promotionSessionId !== session._id ||
          row.promotionPublicId !== session.publicId
        ) {
          throw new Error("staged entity identity mismatch");
        }
        return entity;
      });
      checkpoint = advancePromotionFamilyDigest(
        family,
        checkpoint,
        entities,
      );
    } catch {
      await ctx.db.patch(session._id, {
        state: "rejected",
        rejectionCode: "staged_entity_invalid",
        updatedAt: now,
      });
      return null;
    }
    if (!page.isDone) {
      await ctx.db.patch(session._id, {
        validationCursor: page.continueCursor,
        validationCount: checkpoint.count,
        validationDigest: checkpoint.digest,
        ...(checkpoint.lastEntityIdentity === null
          ? { validationLastIdentity: undefined }
          : { validationLastIdentity: checkpoint.lastEntityIdentity }),
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.hraPromotion.validatePage,
        { sessionId: session._id },
      );
      return null;
    }
    if (
      checkpoint.count !== manifest.counts[family] ||
      checkpoint.digest !== manifest.familyDigests[family]
    ) {
      await ctx.db.patch(session._id, {
        state: "rejected",
        rejectionCode: "family_digest_mismatch",
        updatedAt: now,
      });
      return null;
    }
    const nextIndex = familyIndex + 1;
    await ctx.db.patch(session._id, {
      validationFamilyIndex: nextIndex,
      validationCursor: undefined,
      validationCount: 0,
      validationDigest: nextIndex < promotionEntityFamilyValues.length
        ? promotionFamilyInitialDigest(
            promotionEntityFamilyValues[nextIndex] ??
              "workspace_metadata",
          )
        : undefined,
      validationLastIdentity: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.hraPromotion.validatePage,
      { sessionId: session._id },
    );
    return null;
  },
});

export const lookup = internalQuery({
  args: { promotionId: v.string(), requestId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const authorized = await authorizePromotion(
      ctx,
      args.promotionId,
      args.requestId,
    );
    if (!authorized.ok) return authorized;
    return {
      ok: true as const,
      data: { promotion: publicPromotionState(authorized.session) },
      requestId: args.requestId,
    };
  },
});

export const listReceipts = internalQuery({
  args: {
    promotionId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const authorized = await authorizePromotion(
      ctx,
      args.promotionId,
      args.requestId,
    );
    if (!authorized.ok) return authorized;
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const decoded = args.cursor === undefined
      ? null
      : decodePromotionCursor(args.cursor, RECEIPT_CURSOR_PREFIX);
    if (
      args.cursor !== undefined &&
      (
        decoded === null ||
        decoded.promotionId !== authorized.session.publicId ||
        decoded.organizationId !==
          authorized.authorization.organization.publicId ||
        decoded.userId !== authorized.authorization.user.publicId
      )
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const page = await ctx.db
      .query("promotionBatchReceipts")
      .withIndex("by_session_and_accepted", (query) =>
        query.eq("promotionSessionId", authorized.session._id))
      .paginate({
        cursor: decoded?.continuation ?? null,
        numItems: args.limit,
      });
    const items = page.page.map((row) =>
      promotionBatchReceiptV2Schema.parse(
        JSON.parse(row.receiptJson) as unknown,
      ));
    return {
      ok: true as const,
      data: {
        promotionId: authorized.session.publicId,
        items,
        cursor: page.isDone
          ? null
          : encodePromotionCursor(RECEIPT_CURSOR_PREFIX, {
              promotionId: authorized.session.publicId,
              organizationId:
                authorized.authorization.organization.publicId,
              userId: authorized.authorization.user.publicId,
              continuation: page.continueCursor,
            }),
        hasMore: !page.isDone,
      },
      requestId: args.requestId,
    };
  },
});

export const activate = internalMutation({
  args: {
    promotionId: v.string(),
    body: v.any(),
    idempotencyKey: v.string(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const parsed = activateHRAPromotionRequestSchema.safeParse(args.body);
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", args.requestId);
    const requestDigest = humanTaskMutationDigest(
      STABLE_PROMOTION_IDEMPOTENCY_OPERATIONS.activate,
      parsed.data,
    );
    const metadata = assertRequestMetadata({
      idempotencyKey: args.idempotencyKey,
      requestDigest,
      requestId: args.requestId,
      now: Date.now(),
    });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizePromotion(
      ctx,
      args.promotionId,
      args.requestId,
    );
    if (!authorized.ok) return authorized;
    const { session } = authorized;
    const manifest = parseManifest(session);
    if (
      parsed.data.manifestRoot !== manifest.rootDigest ||
      JSON.stringify(parsed.data.counts) !== JSON.stringify(manifest.counts) ||
      JSON.stringify(parsed.data.familyDigests) !==
        JSON.stringify(manifest.familyDigests)
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    if (session.state === "activated") {
      if (
        session.activationReceiptJson === undefined ||
        session.activationIdempotencyKey === undefined ||
        session.activationRequestDigest === undefined
      ) {
        throw new Error("Activated promotion lost its proof.");
      }
      if (
        session.activationIdempotencyKey !== args.idempotencyKey ||
        session.activationRequestDigest !== requestDigest
      ) {
        return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
      }
      return {
        ok: true as const,
        data: {
          receipt: promotionActivationReceiptV2Schema.parse(
            JSON.parse(session.activationReceiptJson) as unknown,
          ),
        },
        requestId: args.requestId,
      };
    }
    if (
      session.state !== "ready" ||
      !(await activeStoredPromotionAuthorization(ctx, session))
    ) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId);
    }
    const workspace = await ctx.db.get(session.stagingWorkspaceId);
    if (
      workspace === null ||
      workspace.organizationId !== session.organizationId ||
      workspace.publicId !== session.stagingWorkspacePublicId ||
      workspace.status !== "staging"
    ) {
      throw new Error("Promotion staging workspace is invalid.");
    }
    const existingMembership = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_workspace_and_user", (query) =>
        query
          .eq("workspaceId", workspace._id)
          .eq("userId", session.startedByUserId))
      .unique();
    if (existingMembership !== null) {
      throw new Error("Staging workspace became visible before activation.");
    }
    const now = Date.now();
    const decisionSequence = session.decisionSequence + 1;
    const receiptInput = {
      schemaVersion: 2 as const,
      issuer: "convex_promotion_authority" as const,
      serverReceiptId: `promotion_receipt_${randomCrockford(26)}`,
      promotionId: session.publicId,
      sourceWorkspaceId: session.sourceWorkspacePublicId,
      destinationWorkspaceId: session.stagingWorkspacePublicId,
      acceptedManifestRoot: manifest.rootDigest,
      acceptedCounts: manifest.counts,
      acceptedFamilyDigests: manifest.familyDigests,
      decision: "activated" as const,
      decisionSequence,
      activatedAt: now,
    };
    const receipt = promotionActivationReceiptV2Schema.parse({
      ...receiptInput,
      receiptDigest: promotionActivationReceiptV2Digest(receiptInput),
    });
    await ctx.db.insert("workspaceMemberships", {
      organizationId: session.organizationId,
      workspaceId: workspace._id,
      userId: session.startedByUserId,
      roles: ["planner", "reviewer", "viewer"],
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(workspace._id, {
      status: "active",
      updatedAt: now,
    });
    await ctx.db.insert("workspaceProjectionHeads", {
      organizationId: session.organizationId,
      workspaceId: workspace._id,
      workspacePublicId: workspace.publicId,
      revision: 1,
      lastSemanticAt: now,
    });
    await ctx.db.insert("workspaceInvalidations", {
      organizationId: session.organizationId,
      workspaceId: workspace._id,
      workspacePublicId: workspace.publicId,
      projectionRevision: 1,
      scope: "workspace",
      createdAt: now,
    });
    await ctx.db.insert("promotionDecisionProofs", {
      promotionSessionId: session._id,
      promotionPublicId: session.publicId,
      decision: "activated",
      decisionSequence,
      proofJson: JSON.stringify(receipt),
      createdAt: now,
    });
    await ctx.db.insert("promotionCleanupTombstones", {
      promotionSessionId: session._id,
      promotionPublicId: session.publicId,
      scope: "staging_rows",
      state: "pending",
      deletedEntityCount: 0,
      cursor: encodePromotionCursor(CLEANUP_CURSOR_PREFIX, {
        promotionId: session.publicId,
        organizationId: session.organizationPublicId,
        userId: authorized.authorization.user.publicId,
        continuation: "start",
      }),
      decisionProofRetained: true,
      updatedAt: now,
    });
    await ctx.db.patch(session._id, {
      state: "activated",
      activationReceiptJson: JSON.stringify(receipt),
      activationIdempotencyKey: args.idempotencyKey,
      activationRequestDigest: requestDigest,
      decisionSequence,
      updatedAt: now,
    });
    return {
      ok: true as const,
      data: { receipt },
      requestId: args.requestId,
    };
  },
});

export const abort = internalMutation({
  args: {
    promotionId: v.string(),
    body: v.any(),
    idempotencyKey: v.string(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const parsed = abortHRAPromotionRequestSchema.safeParse(args.body);
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", args.requestId);
    const requestDigest = humanTaskMutationDigest(
      STABLE_PROMOTION_IDEMPOTENCY_OPERATIONS.abort,
      parsed.data,
    );
    const metadata = assertRequestMetadata({
      idempotencyKey: args.idempotencyKey,
      requestDigest,
      requestId: args.requestId,
      now: Date.now(),
    });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizePromotion(
      ctx,
      args.promotionId,
      args.requestId,
    );
    if (!authorized.ok) return authorized;
    const { session } = authorized;
    if (parsed.data.manifestRoot !== session.manifestRoot) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    if (session.state === "aborted") {
      if (
        session.abortReceiptJson === undefined ||
        session.abortIdempotencyKey === undefined ||
        session.abortRequestDigest === undefined
      ) {
        throw new Error("Aborted promotion lost its proof.");
      }
      if (
        session.abortIdempotencyKey !== args.idempotencyKey ||
        session.abortRequestDigest !== requestDigest
      ) {
        return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
      }
      return {
        ok: true as const,
        data: {
          receipt: promotionAbortReceiptV2Schema.parse(
            JSON.parse(session.abortReceiptJson) as unknown,
          ),
        },
        requestId: args.requestId,
      };
    }
    if (session.state === "activated") {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId);
    }
    const workspace = await ctx.db.get(session.stagingWorkspaceId);
    if (
      workspace === null ||
      workspace.status !== "staging" ||
      workspace.organizationId !== session.organizationId
    ) {
      throw new Error("Abort staging workspace is invalid.");
    }
    const now = Date.now();
    const decisionSequence = session.decisionSequence + 1;
    const receiptInput = {
      schemaVersion: 2 as const,
      issuer: "convex_promotion_authority" as const,
      serverReceiptId: `promotion_receipt_${randomCrockford(26)}`,
      promotionId: session.publicId,
      sourceWorkspaceId: session.sourceWorkspacePublicId,
      stagingWorkspaceId: session.stagingWorkspacePublicId,
      manifestRoot: session.manifestRoot,
      decision: "aborted_before_activation" as const,
      decisionSequence,
      abortedAt: now,
    };
    const receipt = promotionAbortReceiptV2Schema.parse({
      ...receiptInput,
      receiptDigest: promotionAbortReceiptV2Digest(receiptInput),
    });
    await ctx.db.patch(workspace._id, { status: "disabled", updatedAt: now });
    await ctx.db.insert("promotionDecisionProofs", {
      promotionSessionId: session._id,
      promotionPublicId: session.publicId,
      decision: "aborted_before_activation",
      decisionSequence,
      proofJson: JSON.stringify(receipt),
      createdAt: now,
    });
    await ctx.db.insert("promotionCleanupTombstones", {
      promotionSessionId: session._id,
      promotionPublicId: session.publicId,
      scope: "all_promotion_owned_rows",
      state: "pending",
      deletedEntityCount: 0,
      cursor: encodePromotionCursor(CLEANUP_CURSOR_PREFIX, {
        promotionId: session.publicId,
        organizationId: session.organizationPublicId,
        userId: authorized.authorization.user.publicId,
        continuation: "start",
      }),
      decisionProofRetained: true,
      updatedAt: now,
    });
    await ctx.db.patch(session._id, {
      state: "aborted",
      abortReceiptJson: JSON.stringify(receipt),
      abortIdempotencyKey: args.idempotencyKey,
      abortRequestDigest: requestDigest,
      decisionSequence,
      updatedAt: now,
    });
    return {
      ok: true as const,
      data: { receipt },
      requestId: args.requestId,
    };
  },
});

function cleanupProgress(
  tombstone: Doc<"promotionCleanupTombstones">,
) {
  return {
    promotionId: tombstone.promotionPublicId,
    scope: tombstone.scope,
    state: tombstone.state,
    deletedEntityCount: tombstone.deletedEntityCount,
    cursor: tombstone.state === "complete"
      ? null
      : tombstone.cursor ?? `${CLEANUP_CURSOR_PREFIX}pending`,
    decisionProofRetained: true as const,
  };
}

export const cleanupStatus = internalQuery({
  args: { promotionId: v.string(), requestId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const authorized = await authorizePromotion(
      ctx,
      args.promotionId,
      args.requestId,
    );
    if (!authorized.ok) return authorized;
    const tombstone = await ctx.db
      .query("promotionCleanupTombstones")
      .withIndex("by_session", (query) =>
        query.eq("promotionSessionId", authorized.session._id))
      .unique();
    if (tombstone === null) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId);
    }
    return {
      ok: true as const,
      data: { cleanup: cleanupProgress(tombstone) },
      requestId: args.requestId,
    };
  },
});

export const advanceCleanup = internalMutation({
  args: {
    promotionId: v.string(),
    limit: v.number(),
    idempotencyKey: v.string(),
    requestId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 500) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const requestDigest = humanTaskMutationDigest(
      STABLE_PROMOTION_IDEMPOTENCY_OPERATIONS.cleanup,
      { promotionId: args.promotionId, limit: args.limit },
    );
    const metadata = assertRequestMetadata({
      idempotencyKey: args.idempotencyKey,
      requestDigest,
      requestId: args.requestId,
      now: Date.now(),
    });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizePromotion(
      ctx,
      args.promotionId,
      args.requestId,
    );
    if (!authorized.ok) return authorized;
    const existingReceipt = await ctx.db
      .query("promotionCleanupReceipts")
      .withIndex("by_session_and_key", (query) =>
        query
          .eq("promotionSessionId", authorized.session._id)
          .eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existingReceipt !== null) {
      if (existingReceipt.requestDigest !== requestDigest) {
        return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
      }
      return {
        ok: true as const,
        data: {
          cleanup: promotionCleanupProgressSchema.parse(
            JSON.parse(existingReceipt.responseJson) as unknown,
          ),
        },
        requestId: args.requestId,
      };
    }
    const tombstone = await ctx.db
      .query("promotionCleanupTombstones")
      .withIndex("by_session", (query) =>
        query.eq("promotionSessionId", authorized.session._id))
      .unique();
    if (tombstone === null) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId);
    }
    if (tombstone.state === "complete") {
      const cleanup = cleanupProgress(tombstone);
      await ctx.db.insert("promotionCleanupReceipts", {
        promotionSessionId: authorized.session._id,
        promotionPublicId: authorized.session.publicId,
        idempotencyKey: args.idempotencyKey,
        requestDigest,
        responseJson: JSON.stringify(cleanup),
        createdAt: Date.now(),
      });
      return {
        ok: true as const,
        data: { cleanup },
        requestId: args.requestId,
      };
    }
    let remaining = args.limit;
    let deleted = 0;
    const staged = await ctx.db
      .query("promotionStagedEntities")
      .withIndex("by_session", (query) =>
        query.eq("promotionSessionId", authorized.session._id))
      .take(remaining);
    for (const row of staged) await ctx.db.delete(row._id);
    deleted += staged.length;
    remaining -= staged.length;
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const receipts = await ctx.db
        .query("promotionBatchReceipts")
        .withIndex("by_session", (query) =>
          query.eq("promotionSessionId", authorized.session._id))
        .take(remaining);
      for (const row of receipts) await ctx.db.delete(row._id);
      deleted += receipts.length;
      remaining -= receipts.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const importedRuns = await ctx.db
        .query("promotionImportedRunSummaries")
        .withIndex("by_session", (query) =>
          query.eq("promotionSessionId", authorized.session._id))
        .take(remaining);
      for (const row of importedRuns) await ctx.db.delete(row._id);
      deleted += importedRuns.length;
      remaining -= importedRuns.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const importedSubmissions = await ctx.db
        .query("promotionImportedSubmissions")
        .withIndex("by_session", (query) =>
          query.eq("promotionSessionId", authorized.session._id))
        .take(remaining);
      for (const row of importedSubmissions) await ctx.db.delete(row._id);
      deleted += importedSubmissions.length;
      remaining -= importedSubmissions.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const links = await ctx.db
        .query("promotionTaskRepositoryLinks")
        .withIndex("by_session", (query) =>
          query.eq("promotionSessionId", authorized.session._id))
        .take(remaining);
      for (const row of links) await ctx.db.delete(row._id);
      deleted += links.length;
      remaining -= links.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const submissions = await ctx.db
        .query("taskSubmissions")
        .withIndex("by_workspace_status_submitted", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of submissions) await ctx.db.delete(row._id);
      deleted += submissions.length;
      remaining -= submissions.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const taskRepositoryLinks = await ctx.db
        .query("taskRepositoryLinks")
        .withIndex("by_workspace_task_repository", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of taskRepositoryLinks) {
        await ctx.db.delete(row._id);
      }
      deleted += taskRepositoryLinks.length;
      remaining -= taskRepositoryLinks.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const references = await ctx.db
        .query("taskReferences")
        .withIndex("by_workspace_task_status_created", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of references) await ctx.db.delete(row._id);
      deleted += references.length;
      remaining -= references.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const comments = await ctx.db
        .query("taskComments")
        .withIndex("by_workspace_task_created", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of comments) await ctx.db.delete(row._id);
      deleted += comments.length;
      remaining -= comments.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const labels = await ctx.db
        .query("taskLabels")
        .withIndex("by_workspace_task_created", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of labels) await ctx.db.delete(row._id);
      deleted += labels.length;
      remaining -= labels.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const dependencies = await ctx.db
        .query("taskDependencies")
        .withIndex("by_workspace_blocker_created", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of dependencies) await ctx.db.delete(row._id);
      deleted += dependencies.length;
      remaining -= dependencies.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const bodies = await ctx.db
        .query("taskBodies")
        .withIndex("by_workspace_and_task", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of bodies) await ctx.db.delete(row._id);
      deleted += bodies.length;
      remaining -= bodies.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const cancellations = await ctx.db
        .query("taskCancellations")
        .withIndex("by_workspace_task_cancelled", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of cancellations) await ctx.db.delete(row._id);
      deleted += cancellations.length;
      remaining -= cancellations.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const workspaceLabels = await ctx.db
        .query("workspaceLabels")
        .withIndex("by_workspace_and_name", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of workspaceLabels) await ctx.db.delete(row._id);
      deleted += workspaceLabels.length;
      remaining -= workspaceLabels.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_workspace_updated", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of tasks) await ctx.db.delete(row._id);
      deleted += tasks.length;
      remaining -= tasks.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const repositories = await ctx.db
        .query("workspaceRepositories")
        .withIndex("by_workspace_status_created", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of repositories) await ctx.db.delete(row._id);
      deleted += repositories.length;
      remaining -= repositories.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const grants = await ctx.db
        .query("agentWorkspaceGrants")
        .withIndex("by_workspace_and_agent", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .take(remaining);
      for (const row of grants) await ctx.db.delete(row._id);
      deleted += grants.length;
      remaining -= grants.length;
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const executor = await ctx.db
        .query("agents")
        .withIndex("by_public_id", (query) =>
          query.eq(
            "publicId",
            `imported_local_codex_${authorized.session.publicId}`,
          ))
        .unique();
      if (
        executor !== null &&
        executor.organizationId !== authorized.session.organizationId
      ) {
        throw new Error("Promotion cleanup executor crossed its tenant.");
      }
      if (executor !== null) {
        await ctx.db.delete(executor._id);
        deleted += 1;
        remaining -= 1;
      }
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const usage = await ctx.db
        .query("workspaceUsage")
        .withIndex("by_workspace", (query) =>
          query.eq("workspaceId", authorized.session.stagingWorkspaceId))
        .unique();
      if (
        usage !== null &&
        usage.organizationId !== authorized.session.organizationId
      ) {
        throw new Error("Promotion cleanup usage crossed its tenant.");
      }
      if (usage !== null) {
        await ctx.db.delete(usage._id);
        deleted += 1;
        remaining -= 1;
      }
    }
    if (
      remaining > 0 &&
      tombstone.scope === "all_promotion_owned_rows"
    ) {
      const workspace = await ctx.db.get(
        authorized.session.stagingWorkspaceId,
      );
      if (
        workspace !== null &&
        (
          workspace.organizationId !== authorized.session.organizationId ||
          workspace.status !== "disabled"
        )
      ) {
        throw new Error("Promotion cleanup workspace is not disabled staging.");
      }
      if (workspace !== null) {
        await ctx.db.delete(workspace._id);
        deleted += 1;
      }
    }
    const [stagedLeft, receiptsLeft, runsLeft, submissionsLeft, linksLeft] =
      await Promise.all([
        ctx.db
          .query("promotionStagedEntities")
          .withIndex("by_session", (query) =>
            query.eq("promotionSessionId", authorized.session._id))
          .first(),
        tombstone.scope === "all_promotion_owned_rows"
          ? ctx.db
              .query("promotionBatchReceipts")
              .withIndex("by_session", (query) =>
                query.eq("promotionSessionId", authorized.session._id))
              .first()
          : null,
        tombstone.scope === "all_promotion_owned_rows"
          ? ctx.db
              .query("promotionImportedRunSummaries")
              .withIndex("by_session", (query) =>
                query.eq("promotionSessionId", authorized.session._id))
              .first()
          : null,
        tombstone.scope === "all_promotion_owned_rows"
          ? ctx.db
              .query("promotionImportedSubmissions")
              .withIndex("by_session", (query) =>
                query.eq("promotionSessionId", authorized.session._id))
              .first()
          : null,
        tombstone.scope === "all_promotion_owned_rows"
          ? ctx.db
              .query("promotionTaskRepositoryLinks")
              .withIndex("by_session", (query) =>
                query.eq("promotionSessionId", authorized.session._id))
              .first()
          : null,
      ]);
    const workspaceLeft = tombstone.scope === "all_promotion_owned_rows"
      ? await ctx.db.get(authorized.session.stagingWorkspaceId)
      : null;
    const complete =
      stagedLeft === null &&
      receiptsLeft === null &&
      runsLeft === null &&
      submissionsLeft === null &&
      linksLeft === null &&
      workspaceLeft === null;
    const now = Date.now();
    await ctx.db.patch(tombstone._id, {
      state: complete ? "complete" : "running",
      deletedEntityCount:
        tombstone.deletedEntityCount + staged.length,
      cursor: complete
        ? undefined
        : encodePromotionCursor(CLEANUP_CURSOR_PREFIX, {
            promotionId: authorized.session.publicId,
            organizationId:
              authorized.authorization.organization.publicId,
            userId: authorized.authorization.user.publicId,
            continuation: [
              tombstone.deletedEntityCount + staged.length,
              deleted,
              now,
            ].join(":"),
          }),
      updatedAt: now,
    });
    const updated = await ctx.db.get(tombstone._id);
    if (updated === null) throw new Error("Promotion cleanup tombstone vanished.");
    const cleanup = cleanupProgress(updated);
    await ctx.db.insert("promotionCleanupReceipts", {
      promotionSessionId: authorized.session._id,
      promotionPublicId: authorized.session.publicId,
      idempotencyKey: args.idempotencyKey,
      requestDigest,
      responseJson: JSON.stringify(cleanup),
      createdAt: now,
    });
    return {
      ok: true as const,
      data: { cleanup },
      requestId: args.requestId,
    };
  },
});

export type { PromotionEntity };
