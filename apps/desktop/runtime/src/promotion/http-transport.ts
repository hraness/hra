import {
  HRA_PROMOTION_MAX_REQUEST_BYTES,
  abortHRAPromotionEnvelopeSchema,
  abortHRAPromotionRequestSchema,
  acceptHRAPromotionBatchEnvelopeSchema,
  acceptHRAPromotionBatchRequestSchema,
  activateHRAPromotionEnvelopeSchema,
  activateHRAPromotionRequestSchema,
  advanceHRAPromotionCleanupRequestSchema,
  errorEnvelopeSchema,
  errorHttpStatus,
  hraHumanHeaders,
  hraPromotionApiRoutes,
  hraPromotionCleanupEnvelopeSchema,
  listHRAPromotionReceiptsEnvelopeSchema,
  listHRAPromotionReceiptsQuerySchema,
  lookupHRAPromotionEnvelopeSchema,
  startHRAPromotionEnvelopeSchema,
  startHRAPromotionRequestSchema,
  taskDomain,
  type AbortHRAPromotionRequest,
  type AcceptHRAPromotionBatchRequest,
  type ActivateHRAPromotionRequest,
  type AdvanceHRAPromotionCleanupRequest,
  type ErrorCode,
  type IdempotencyKey,
  type StartHRAPromotionRequest,
} from "@hraness/agent-tasks-protocol";
import {
  StrictHumanHttpClient,
  type FetchLike,
  type HumanOperationResult,
  type HumanSessionCoordinator,
  type StrictTransportFailure,
  type WireSchema,
} from "@hraness/hra-human-client";
import { createHash } from "node:crypto";

import type {
  LocalPromotionIdempotencyKeyStore,
  LocalPromotionTransport,
  LocalPromotionTransportResult,
} from "./contracts";

const DEFAULT_PROMOTION_HTTP_TIMEOUT_MS = 15_000;

interface PromotionHttpFailure {
  readonly code: ErrorCode | "STRICT_TRANSPORT";
  readonly transportReason?: StrictTransportFailure["reason"];
  readonly mutationOutcomeMayBeUnknown?: boolean;
}

interface PromotionRequestOptions<Request, Value> {
  readonly accessToken: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly responseSchema: WireSchema<Readonly<{
    ok: true;
    data: Value;
    requestId: string;
  }>>;
  readonly body?: Readonly<{
    value: unknown;
    schema: WireSchema<Request>;
  }>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly idempotencyKey?: IdempotencyKey;
}

export interface HRAPromotionHttpTransportOptions {
  readonly apiUrl: string;
  readonly session: HumanSessionCoordinator;
  readonly idempotencyKeys: LocalPromotionIdempotencyKeyStore;
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

function requestDigest(value: unknown): string {
  return `sha256_${
    createHash("sha256")
      .update(taskDomain.canonicalPromotionJson(value))
      .digest("hex")
  }`;
}

function mapFailure(
  failure: PromotionHttpFailure,
): LocalPromotionTransportResult<never> {
  if (failure.code === "STRICT_TRANSPORT") {
    if (failure.transportReason === "invalid_request") {
      return { ok: false, kind: "rejected" };
    }
    return failure.mutationOutcomeMayBeUnknown === true
      ? { ok: false, kind: "outcome_unknown" }
      : { ok: false, kind: "offline" };
  }
  if (
    failure.code === "AUTHENTICATION_FAILED" ||
    failure.code === "SESSION_INVALID" ||
    failure.code === "SESSION_REQUIRED"
  ) {
    return { ok: false, kind: "unauthorized" };
  }
  if (failure.code === "NOT_FOUND") {
    return { ok: false, kind: "not_found" };
  }
  if (
    failure.code === "SERVICE_UNAVAILABLE" ||
    failure.code === "RATE_LIMITED" ||
    failure.code === "PROVISIONING_IN_PROGRESS" ||
    failure.code === "PROVISIONING_FAILED" ||
    failure.code === "INTERNAL_ERROR"
  ) {
    return { ok: false, kind: "offline" };
  }
  return { ok: false, kind: "rejected" };
}

/**
 * Credential-aware, strictly decoded adapter for the fixed HRA promotion
 * route surface. Tokens are read only inside HumanSessionCoordinator and never
 * enter promotion state, errors, or renderer-facing values.
 */
export class HRAPromotionHttpTransport implements LocalPromotionTransport {
  readonly #client: StrictHumanHttpClient;
  readonly #session: HumanSessionCoordinator;
  readonly #idempotencyKeys: LocalPromotionIdempotencyKeyStore;
  readonly #now: () => number;

  constructor(options: HRAPromotionHttpTransportOptions) {
    this.#client = new StrictHumanHttpClient({
      apiUrl: options.apiUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      requestTimeoutMs:
        options.requestTimeoutMs ?? DEFAULT_PROMOTION_HTTP_TIMEOUT_MS,
      maxRequestBytes: HRA_PROMOTION_MAX_REQUEST_BYTES,
    });
    this.#session = options.session;
    this.#idempotencyKeys = options.idempotencyKeys;
    this.#now = options.now ?? Date.now;
  }

  async start(
    requestValue: StartHRAPromotionRequest,
  ): Promise<ReturnType<LocalPromotionTransport["start"]> extends Promise<
    infer Result
  > ? Result : never> {
    const request = startHRAPromotionRequestSchema.parse(requestValue);
    return await this.#mutation({
      promotionId: request.manifest.promotionId,
      operationKey: "start",
      path: hraPromotionApiRoutes.start,
      request,
      requestSchema: startHRAPromotionRequestSchema,
      responseSchema: startHRAPromotionEnvelopeSchema,
    });
  }

  async acceptBatch(
    promotionIdValue: string,
    requestValue: AcceptHRAPromotionBatchRequest,
  ): Promise<ReturnType<LocalPromotionTransport["acceptBatch"]> extends Promise<
    infer Result
  > ? Result : never> {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const request = acceptHRAPromotionBatchRequestSchema.parse(requestValue);
    if (request.batch.promotionId !== promotionId) {
      return { ok: false, kind: "rejected" };
    }
    return await this.#mutation({
      promotionId,
      operationKey: `batch:${request.batch.batchId}`,
      path: hraPromotionApiRoutes.batches(promotionId),
      request,
      requestSchema: acceptHRAPromotionBatchRequestSchema,
      responseSchema: acceptHRAPromotionBatchEnvelopeSchema,
    });
  }

  async lookup(
    promotionIdValue: string,
  ): Promise<ReturnType<LocalPromotionTransport["lookup"]> extends Promise<
    infer Result
  > ? Result : never> {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    return await this.#read({
      path: hraPromotionApiRoutes.lookup(promotionId),
      responseSchema: lookupHRAPromotionEnvelopeSchema,
    });
  }

  async activate(
    promotionIdValue: string,
    requestValue: ActivateHRAPromotionRequest,
  ): Promise<ReturnType<LocalPromotionTransport["activate"]> extends Promise<
    infer Result
  > ? Result : never> {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const request = activateHRAPromotionRequestSchema.parse(requestValue);
    return await this.#mutation({
      promotionId,
      operationKey: "activate",
      path: hraPromotionApiRoutes.activate(promotionId),
      request,
      requestSchema: activateHRAPromotionRequestSchema,
      responseSchema: activateHRAPromotionEnvelopeSchema,
    });
  }

  async abort(
    promotionIdValue: string,
    requestValue: AbortHRAPromotionRequest,
  ): Promise<ReturnType<LocalPromotionTransport["abort"]> extends Promise<
    infer Result
  > ? Result : never> {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const request = abortHRAPromotionRequestSchema.parse(requestValue);
    return await this.#mutation({
      promotionId,
      operationKey: "abort",
      path: hraPromotionApiRoutes.abort(promotionId),
      request,
      requestSchema: abortHRAPromotionRequestSchema,
      responseSchema: abortHRAPromotionEnvelopeSchema,
    });
  }

  async listReceipts(
    promotionIdValue: string,
    input: Readonly<{ cursor?: string; limit: number }>,
  ): Promise<ReturnType<LocalPromotionTransport["listReceipts"]> extends Promise<
    infer Result
  > ? Result : never> {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const parsed = listHRAPromotionReceiptsQuerySchema.parse({
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: String(input.limit),
    });
    return await this.#read({
      path: hraPromotionApiRoutes.receipts(promotionId),
      query: {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: String(parsed.limit),
      },
      responseSchema: listHRAPromotionReceiptsEnvelopeSchema,
    });
  }

  async advanceCleanup(
    promotionIdValue: string,
    requestValue: AdvanceHRAPromotionCleanupRequest,
  ): Promise<ReturnType<
    LocalPromotionTransport["advanceCleanup"]
  > extends Promise<infer Result> ? Result : never> {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    const request = advanceHRAPromotionCleanupRequestSchema.parse(
      requestValue,
    );
    return await this.#mutation({
      promotionId,
      operationKey: this.#idempotencyKeys.cleanupHttpOperationKey(promotionId),
      path: hraPromotionApiRoutes.cleanup(promotionId),
      request,
      requestSchema: advanceHRAPromotionCleanupRequestSchema,
      responseSchema: hraPromotionCleanupEnvelopeSchema,
    });
  }

  async cleanupStatus(
    promotionIdValue: string,
  ): Promise<ReturnType<
    LocalPromotionTransport["cleanupStatus"]
  > extends Promise<infer Result> ? Result : never> {
    const promotionId = taskDomain.promotionIdSchema.parse(promotionIdValue);
    return await this.#read({
      path: hraPromotionApiRoutes.cleanupStatus(promotionId),
      responseSchema: hraPromotionCleanupEnvelopeSchema,
    });
  }

  async #mutation<Request, Value>(options: Readonly<{
    promotionId: string;
    operationKey: string;
    path: string;
    request: Request;
    requestSchema: WireSchema<Request>;
    responseSchema: WireSchema<Readonly<{
      ok: true;
      data: Value;
      requestId: string;
    }>>;
  }>): Promise<LocalPromotionTransportResult<Value>> {
    let idempotencyKey: IdempotencyKey;
    try {
      idempotencyKey = this.#idempotencyKeys.getOrCreateHttpIdempotencyKey({
        promotionId: options.promotionId,
        operationKey: options.operationKey,
        requestDigest: requestDigest(options.request),
        now: this.#now(),
      });
    } catch {
      return { ok: false, kind: "rejected" };
    }
    return await this.#execute({
      method: "POST",
      path: options.path,
      body: {
        value: options.request,
        schema: options.requestSchema,
      },
      responseSchema: options.responseSchema,
      idempotencyKey,
    });
  }

  async #read<Value>(options: Readonly<{
    path: string;
    responseSchema: WireSchema<Readonly<{
      ok: true;
      data: Value;
      requestId: string;
    }>>;
    query?: Readonly<Record<string, string | undefined>>;
  }>): Promise<LocalPromotionTransportResult<Value>> {
    return await this.#execute({
      method: "GET",
      path: options.path,
      responseSchema: options.responseSchema,
      ...(options.query === undefined ? {} : { query: options.query }),
    });
  }

  async #execute<Request, Value>(
    options: Omit<PromotionRequestOptions<Request, Value>, "accessToken">,
  ): Promise<LocalPromotionTransportResult<Value>> {
    const result = await this.#session.execute(
      async (accessToken) => await this.#request({
        ...options,
        accessToken,
      }),
    );
    if (result.ok) return { ok: true, value: result.data };
    if (result.kind === "operation") return mapFailure(result.error);
    if (
      result.error.code === "SIGNED_OUT" ||
      result.error.code === "AUTHENTICATION_FAILED"
    ) {
      return { ok: false, kind: "unauthorized" };
    }
    return { ok: false, kind: "offline" };
  }

  async #request<Request, Value>(
    options: PromotionRequestOptions<Request, Value>,
  ): Promise<HumanOperationResult<Value, PromotionHttpFailure>> {
    const result = await this.#client.request({
      method: options.method,
      path: options.path,
      successSchema: options.responseSchema,
      failureSchema: errorEnvelopeSchema,
      bearerToken: options.accessToken,
      maxRequestBytes: HRA_PROMOTION_MAX_REQUEST_BYTES,
      ...(options.body === undefined
        ? {}
        : {
            body: {
              kind: "json" as const,
              value: options.body.value,
              schema: options.body.schema,
            },
          }),
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.idempotencyKey === undefined
        ? {}
        : {
            headers: {
              [hraHumanHeaders.idempotencyKey]: options.idempotencyKey,
            },
          }),
    });
    if (result.ok) return { ok: true, data: result.data.data };
    if (result.kind === "transport") {
      return {
        ok: false,
        error: {
          code: "STRICT_TRANSPORT",
          transportReason: result.error.reason,
          mutationOutcomeMayBeUnknown: options.method === "POST",
        },
      };
    }
    const upstream = result.data.error;
    if (errorHttpStatus[upstream.code] !== result.status) {
      return {
        ok: false,
        error: {
          code: "STRICT_TRANSPORT",
          transportReason: "invalid_response",
          mutationOutcomeMayBeUnknown: options.method === "POST",
        },
      };
    }
    return { ok: false, error: { code: upstream.code } };
  }
}
