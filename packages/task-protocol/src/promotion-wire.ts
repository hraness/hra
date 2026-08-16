import {
  MAX_PROMOTION_RECEIPT_PAGE_SIZE,
  promotionAbortReceiptV2Schema,
  promotionActivationReceiptV2Schema,
  promotionBatchReceiptPageSchema,
  promotionBatchReceiptV2Schema,
  promotionBatchV2Schema,
  promotionCleanupProgressSchema,
  promotionEntityCountsSchema,
  promotionFamilyDigestMapSchema,
  promotionIdSchema,
  promotionManifestV2Schema,
  sha256DigestSchema,
  workspacePromotionStateV2Schema,
  workspacePublicIdSchema,
} from "@hraness/agent-tasks-domain";
import { z } from "@hra-internal/schema";

import { successEnvelopeSchema } from "./errors";
import { organizationIdSchema } from "./model";

export const HRA_PROMOTION_MAX_REQUEST_BYTES = 512 * 1_024;

export function serializedHRAPromotionRequestBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function requestWithinPromotionLimit(value: unknown): boolean {
  return serializedHRAPromotionRequestBytes(value) <=
    HRA_PROMOTION_MAX_REQUEST_BYTES;
}

export const hraPromotionRouteParamsSchema = z.object({
  promotionId: promotionIdSchema,
}).strict();

export const startHRAPromotionRequestSchema = z.object({
  organizationId: organizationIdSchema,
  manifest: promotionManifestV2Schema,
}).strict().refine(
  requestWithinPromotionLimit,
  "promotion start request exceeds the portable 512 KiB limit",
);
export type StartHRAPromotionRequest = z.infer<
  typeof startHRAPromotionRequestSchema
>;

export const startHRAPromotionResponseSchema = z.object({
  promotionId: promotionIdSchema,
  stagingWorkspaceId: workspacePublicIdSchema,
  state: z.literal("receiving"),
}).strict();
export const startHRAPromotionEnvelopeSchema = successEnvelopeSchema(
  startHRAPromotionResponseSchema,
);

export const acceptHRAPromotionBatchRequestSchema = z.object({
  batch: promotionBatchV2Schema,
}).strict().refine(
  requestWithinPromotionLimit,
  "promotion batch request exceeds the portable 512 KiB limit",
);
export type AcceptHRAPromotionBatchRequest = z.infer<
  typeof acceptHRAPromotionBatchRequestSchema
>;

export const acceptHRAPromotionBatchResponseSchema = z.object({
  receipt: promotionBatchReceiptV2Schema,
}).strict();
export const acceptHRAPromotionBatchEnvelopeSchema = successEnvelopeSchema(
  acceptHRAPromotionBatchResponseSchema,
);

export const lookupHRAPromotionResponseSchema = z.object({
  promotion: workspacePromotionStateV2Schema,
}).strict();
export const lookupHRAPromotionEnvelopeSchema = successEnvelopeSchema(
  lookupHRAPromotionResponseSchema,
);

export const activateHRAPromotionRequestSchema = z.object({
  manifestRoot: sha256DigestSchema,
  counts: promotionEntityCountsSchema,
  familyDigests: promotionFamilyDigestMapSchema,
}).strict().refine(
  requestWithinPromotionLimit,
  "promotion activation request exceeds the portable 512 KiB limit",
);
export type ActivateHRAPromotionRequest = z.infer<
  typeof activateHRAPromotionRequestSchema
>;

export const activateHRAPromotionResponseSchema = z.object({
  receipt: promotionActivationReceiptV2Schema,
}).strict();
export const activateHRAPromotionEnvelopeSchema = successEnvelopeSchema(
  activateHRAPromotionResponseSchema,
);

export const abortHRAPromotionRequestSchema = z.object({
  manifestRoot: sha256DigestSchema,
}).strict();
export type AbortHRAPromotionRequest = z.infer<
  typeof abortHRAPromotionRequestSchema
>;

export const abortHRAPromotionResponseSchema = z.object({
  receipt: promotionAbortReceiptV2Schema,
}).strict();
export const abortHRAPromotionEnvelopeSchema = successEnvelopeSchema(
  abortHRAPromotionResponseSchema,
);

export const listHRAPromotionReceiptsQuerySchema = z.object({
  cursor: z.string()
    .min(1)
    .max(8_192)
    .regex(/^promotion_receipts_v1_[A-Za-z0-9_-]+$/u)
    .optional(),
  limit: z.string()
    .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_PROMOTION_RECEIPT_PAGE_SIZE))
    .optional()
    .transform((value) => value ?? 100),
}).strict();

export const listHRAPromotionReceiptsResponseSchema =
  promotionBatchReceiptPageSchema;
export const listHRAPromotionReceiptsEnvelopeSchema = successEnvelopeSchema(
  listHRAPromotionReceiptsResponseSchema,
);

export const advanceHRAPromotionCleanupRequestSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
}).strict();
export type AdvanceHRAPromotionCleanupRequest = z.input<
  typeof advanceHRAPromotionCleanupRequestSchema
>;

export const hraPromotionCleanupResponseSchema = z.object({
  cleanup: promotionCleanupProgressSchema,
}).strict();
export const hraPromotionCleanupEnvelopeSchema = successEnvelopeSchema(
  hraPromotionCleanupResponseSchema,
);

function promotionPath(promotionId: string): string {
  const parsed = hraPromotionRouteParamsSchema.parse({ promotionId });
  return `/v1/hra/promotions/${encodeURIComponent(parsed.promotionId)}`;
}

function legacyOprtePromotionPath(promotionId: string): string {
  const parsed = hraPromotionRouteParamsSchema.parse({ promotionId });
  return `/v1/oprte/promotions/${encodeURIComponent(parsed.promotionId)}`;
}

function legacyKitchenPromotionPath(promotionId: string): string {
  const parsed = hraPromotionRouteParamsSchema.parse({ promotionId });
  return `/v1/kitchen/promotions/${encodeURIComponent(parsed.promotionId)}`;
}

export const hraPromotionApiRoutes = {
  start: "/v1/hra/promotions",
  lookup: promotionPath,
  batches: (promotionId: string): string =>
    `${promotionPath(promotionId)}/batches`,
  activate: (promotionId: string): string =>
    `${promotionPath(promotionId)}/activate`,
  abort: (promotionId: string): string =>
    `${promotionPath(promotionId)}/abort`,
  receipts: (promotionId: string): string =>
    `${promotionPath(promotionId)}/receipts`,
  cleanup: (promotionId: string): string =>
    `${promotionPath(promotionId)}/cleanup`,
  cleanupStatus: (promotionId: string): string =>
    `${promotionPath(promotionId)}/cleanup/status`,
} as const;

function legacyPromotionApiRoutes(
  start: "/v1/oprte/promotions" | "/v1/kitchen/promotions",
  pathBuilder: (promotionId: string) => string,
) {
  return {
    start,
    lookup: pathBuilder,
    batches: (promotionId: string): string =>
      `${pathBuilder(promotionId)}/batches`,
    activate: (promotionId: string): string =>
      `${pathBuilder(promotionId)}/activate`,
    abort: (promotionId: string): string =>
      `${pathBuilder(promotionId)}/abort`,
    receipts: (promotionId: string): string =>
      `${pathBuilder(promotionId)}/receipts`,
    cleanup: (promotionId: string): string =>
      `${pathBuilder(promotionId)}/cleanup`,
    cleanupStatus: (promotionId: string): string =>
      `${pathBuilder(promotionId)}/cleanup/status`,
  } as const;
}

/** Input-only alias retained for clients deployed before the HRA cutover. */
export const legacyOprtePromotionApiRoutes = legacyPromotionApiRoutes(
  "/v1/oprte/promotions",
  legacyOprtePromotionPath,
);

/** Input-only alias retained for the original Kitchen route family. */
export const legacyKitchenPromotionApiRoutes = legacyPromotionApiRoutes(
  "/v1/kitchen/promotions",
  legacyKitchenPromotionPath,
);

/** @deprecated Use legacyKitchenPromotionApiRoutes. */
export const legacyPredecessorPromotionApiRoutes = legacyKitchenPromotionApiRoutes;

const hraPromotionRouteMatchSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("start") }).strict(),
  z.object({
    operation: z.enum([
      "lookup",
      "accept_batch",
      "activate",
      "abort",
      "list_receipts",
      "advance_cleanup",
      "cleanup_status",
    ]),
    promotionId: promotionIdSchema,
  }).strict(),
]);
export type HRAPromotionRouteMatch = z.infer<
  typeof hraPromotionRouteMatchSchema
>;

/** Parses only the fixed HRA promotion surface; near-miss paths fail closed. */
export function parseHRAPromotionRoute(input: Readonly<{
  method: string;
  pathname: string;
}>): HRAPromotionRouteMatch | null {
  const method = input.method.toUpperCase();
  if (
    input.pathname === hraPromotionApiRoutes.start
    || input.pathname === legacyOprtePromotionApiRoutes.start
    || input.pathname === legacyPredecessorPromotionApiRoutes.start
  ) {
    return method === "POST" ? { operation: "start" } : null;
  }
  const match = /^\/v1\/(?:hra|oprte|kitchen)\/promotions\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/u
    .exec(input.pathname);
  if (match === null) return null;
  let promotionId: string;
  try {
    promotionId = decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
  const parsedParams = hraPromotionRouteParamsSchema.safeParse({
    promotionId,
  });
  if (!parsedParams.success) return null;
  const suffix = match[2];
  const final = match[3];
  const operation =
    suffix === undefined && method === "GET" ? "lookup"
      : suffix === "batches" && final === undefined && method === "POST"
        ? "accept_batch"
        : suffix === "activate" && final === undefined && method === "POST"
          ? "activate"
          : suffix === "abort" && final === undefined && method === "POST"
            ? "abort"
            : suffix === "receipts" && final === undefined && method === "GET"
              ? "list_receipts"
              : suffix === "cleanup" && final === undefined && method === "POST"
                ? "advance_cleanup"
                : suffix === "cleanup" && final === "status" && method === "GET"
                  ? "cleanup_status"
                  : null;
  return operation === null
    ? null
    : hraPromotionRouteMatchSchema.parse({
      operation,
      promotionId: parsedParams.data.promotionId,
    });
}

const promotionOperationMetadata = {
  authorization: "oprte-human-bearer",
  credentials: "authorization_header_only",
  session: false,
} as const;

export const hraPromotionApiOperations = {
  start: {
    ...promotionOperationMetadata,
    method: "POST",
    path: hraPromotionApiRoutes.start,
    idempotency: true,
    requestSchema: startHRAPromotionRequestSchema,
    responseSchema: startHRAPromotionEnvelopeSchema,
    maxRequestBytes: HRA_PROMOTION_MAX_REQUEST_BYTES,
  },
  lookup: {
    ...promotionOperationMetadata,
    method: "GET",
    path: hraPromotionApiRoutes.lookup,
    pathParamsSchema: hraPromotionRouteParamsSchema,
    idempotency: false,
    responseSchema: lookupHRAPromotionEnvelopeSchema,
  },
  acceptBatch: {
    ...promotionOperationMetadata,
    method: "POST",
    path: hraPromotionApiRoutes.batches,
    pathParamsSchema: hraPromotionRouteParamsSchema,
    idempotency: true,
    requestSchema: acceptHRAPromotionBatchRequestSchema,
    responseSchema: acceptHRAPromotionBatchEnvelopeSchema,
    maxItems: 500,
    maxRequestBytes: HRA_PROMOTION_MAX_REQUEST_BYTES,
  },
  activate: {
    ...promotionOperationMetadata,
    method: "POST",
    path: hraPromotionApiRoutes.activate,
    pathParamsSchema: hraPromotionRouteParamsSchema,
    idempotency: true,
    requestSchema: activateHRAPromotionRequestSchema,
    responseSchema: activateHRAPromotionEnvelopeSchema,
    maxRequestBytes: HRA_PROMOTION_MAX_REQUEST_BYTES,
  },
  abort: {
    ...promotionOperationMetadata,
    method: "POST",
    path: hraPromotionApiRoutes.abort,
    pathParamsSchema: hraPromotionRouteParamsSchema,
    idempotency: true,
    requestSchema: abortHRAPromotionRequestSchema,
    responseSchema: abortHRAPromotionEnvelopeSchema,
  },
  listReceipts: {
    ...promotionOperationMetadata,
    method: "GET",
    path: hraPromotionApiRoutes.receipts,
    pathParamsSchema: hraPromotionRouteParamsSchema,
    idempotency: false,
    querySchema: listHRAPromotionReceiptsQuerySchema,
    responseSchema: listHRAPromotionReceiptsEnvelopeSchema,
  },
  advanceCleanup: {
    ...promotionOperationMetadata,
    method: "POST",
    path: hraPromotionApiRoutes.cleanup,
    pathParamsSchema: hraPromotionRouteParamsSchema,
    idempotency: true,
    requestSchema: advanceHRAPromotionCleanupRequestSchema,
    responseSchema: hraPromotionCleanupEnvelopeSchema,
  },
  cleanupStatus: {
    ...promotionOperationMetadata,
    method: "GET",
    path: hraPromotionApiRoutes.cleanupStatus,
    pathParamsSchema: hraPromotionRouteParamsSchema,
    idempotency: false,
    responseSchema: hraPromotionCleanupEnvelopeSchema,
  },
} as const;
