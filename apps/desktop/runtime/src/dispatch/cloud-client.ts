import {
  appendRunEventsEnvelopeSchema,
  appendRunEventsRequestSchema,
  claimDispatchEnvelopeSchema,
  claimDispatchRequestSchema,
  credentialTokenSchema,
  errorEnvelopeSchema,
  MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_ENVELOPE_BYTES,
  MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_REQUEST_BYTES,
  MAX_SERIALIZED_SUBMISSION_ENVELOPE_BYTES,
  hraDispatchRoutes,
  runnerHeartbeatEnvelopeSchema,
  runnerHeartbeatRequestSchema,
  sessionIdSchema,
  startSessionEnvelopeSchema,
  startSessionRequestSchema,
  syncRunInteractionsEnvelopeSchema,
  syncRunInteractionsRequestSchema,
  submitTaskEnvelopeSchema,
  submitTaskRequestSchema,
  taskKeySchema,
  taskctlApiRoutes,
  taskctlHeaders,
  type ClaimedDispatch,
  type CredentialToken,
  type ErrorCode,
  type IdempotencyKey,
  type RequestId,
  type RunnerHeartbeatRequest,
  type RunnerHeartbeatResponse,
  type SessionId,
  type StartSessionResponse,
  type SyncRunInteractionsRequest,
  type SyncRunInteractionsResponse,
  type SubmitTaskRequest,
  type SubmitTaskResponse,
  type TaskKey,
} from "@hraness/agent-tasks-protocol";
import type { z } from "@hra-internal/schema";

const MAX_RESPONSE_BYTES = 128 * 1_024;
const MAX_REQUEST_BYTES = 128 * 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const INTERRUPTED = Symbol("dispatch request interrupted");

type AppendRunEventsRequest = z.infer<typeof appendRunEventsRequestSchema>;
type AppendRunEventsResponse = z.infer<typeof appendRunEventsEnvelopeSchema>["data"];
type ClaimDispatchRequest = z.infer<typeof claimDispatchRequestSchema>;

interface WireSchema<Value> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: Value }
    | { readonly success: false };
}

export interface DispatchFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface DispatchDeadline {
  cancel(): void;
}

export interface DispatchDeadlineScheduler {
  after(milliseconds: number, callback: () => void): DispatchDeadline;
}

export type DispatchCloudFailure =
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "invalid_response" }>
  | Readonly<{
      kind: "remote";
      code: ErrorCode;
      requestId: RequestId;
      retryAfterMs?: number;
    }>;

export type DispatchCloudResult<Value> =
  | Readonly<{ ok: true; data: Value; requestId: RequestId }>
  | Readonly<{ ok: false; error: DispatchCloudFailure }>;

export interface HRADispatchHttpClientOptions {
  readonly apiOrigin: string;
  readonly credential: CredentialToken;
  readonly sessionId: SessionId;
  readonly fetch?: DispatchFetch;
  readonly requestTimeoutMs?: number;
  readonly deadlines?: DispatchDeadlineScheduler;
}

export type HRADispatchSessionClientOptions = Omit<
  HRADispatchHttpClientOptions,
  "sessionId"
>;

interface RequestOptions<RequestBody, ResponseBody> {
  readonly path: string;
  readonly requestSchema: { parse(value: unknown): RequestBody };
  readonly responseSchema: WireSchema<{
    readonly ok: true;
    readonly data: ResponseBody;
    readonly requestId: RequestId;
  }>;
  readonly body: RequestBody;
  readonly idempotencyKey?: IdempotencyKey;
  readonly requestLimitBytes?: number;
  readonly responseLimitBytes?: number;
  readonly signal?: AbortSignal;
  readonly sessionId?: SessionId;
}

const systemDeadlines: DispatchDeadlineScheduler = {
  after(milliseconds, callback) {
    const timeout = setTimeout(callback, milliseconds);
    return { cancel: () => clearTimeout(timeout) };
  },
};

export function normalizeDispatchApiOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      (url.protocol === "http:" && !isLoopback) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return null;
    }
    url.pathname = "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

class DispatchHttpTransport {
  readonly #apiOrigin: string;
  readonly #authorization: string;
  readonly #deadlines: DispatchDeadlineScheduler;
  readonly #fetch: DispatchFetch;
  readonly #requestTimeoutMs: number;

  constructor(options: HRADispatchSessionClientOptions) {
    const apiOrigin = normalizeDispatchApiOrigin(options.apiOrigin);
    if (apiOrigin === null) {
      throw new TypeError("dispatch API must be an HTTPS origin or an exact loopback HTTP origin");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new TypeError("dispatch request timeout must be between 1 and 60000 milliseconds");
    }
    this.#apiOrigin = apiOrigin;
    this.#authorization = credentialTokenSchema.parse(options.credential);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#deadlines = options.deadlines ?? systemDeadlines;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async post<RequestBody, ResponseBody>(
    options: RequestOptions<RequestBody, ResponseBody>,
  ): Promise<DispatchCloudResult<ResponseBody>> {
    if (options.signal?.aborted === true) return { ok: false, error: { kind: "aborted" } };
    const parsedBody = options.requestSchema.parse(options.body);
    const encodedBody = JSON.stringify(parsedBody);
    if (
      new TextEncoder().encode(encodedBody).byteLength >
        (options.requestLimitBytes ?? MAX_REQUEST_BYTES)
    ) {
      return { ok: false, error: { kind: "invalid_response" } };
    }

    const controller = new AbortController();
    let interruptionKind: "aborted" | "timeout" | null = null;
    let interrupt: ((value: typeof INTERRUPTED) => void) | undefined;
    const interruption = new Promise<typeof INTERRUPTED>((resolve) => {
      interrupt = resolve;
    });
    const abortFromCaller = (): void => {
      interruptionKind = "aborted";
      controller.abort();
      interrupt?.(INTERRUPTED);
    };
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const deadline = this.#deadlines.after(this.#requestTimeoutMs, () => {
      interruptionKind = "timeout";
      controller.abort();
      interrupt?.(INTERRUPTED);
    });

    const request = this.#performRequest(
      new URL(options.path, `${this.#apiOrigin}/`),
      encodedBody,
      controller.signal,
      options.responseSchema,
      options.idempotencyKey,
      options.responseLimitBytes ?? MAX_RESPONSE_BYTES,
      options.sessionId,
    );
    const result = await Promise.race([request, interruption]);
    deadline.cancel();
    options.signal?.removeEventListener("abort", abortFromCaller);
    if (result === INTERRUPTED) {
      return {
        ok: false,
        error: { kind: interruptionKind === "timeout" ? "timeout" : "aborted" },
      };
    }
    return result;
  }

  async #performRequest<ResponseBody>(
    url: URL,
    body: string,
    signal: AbortSignal,
    responseSchema: WireSchema<{
      readonly ok: true;
      readonly data: ResponseBody;
      readonly requestId: RequestId;
    }>,
    idempotencyKey?: IdempotencyKey,
    responseLimitBytes = MAX_RESPONSE_BYTES,
    sessionId?: SessionId,
  ): Promise<DispatchCloudResult<ResponseBody>> {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        [taskctlHeaders.authorization]: `Bearer ${this.#authorization}`,
        [taskctlHeaders.contentType]: "application/json",
      };
      if (sessionId !== undefined) headers[taskctlHeaders.session] = sessionId;
      if (idempotencyKey !== undefined) {
        headers[taskctlHeaders.idempotencyKey] = idempotencyKey;
      }
      response = await this.#fetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch {
      return { ok: false, error: { kind: signal.aborted ? "aborted" : "network" } };
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, error: { kind: "invalid_response" } };
    }
    const payload = await readBoundedJson(response, signal, responseLimitBytes);
    if (payload === null) return { ok: false, error: { kind: "invalid_response" } };

    if (response.ok) {
      const parsed = responseSchema.safeParse(payload);
      return parsed.success
        ? { ok: true, data: parsed.data.data, requestId: parsed.data.requestId }
        : { ok: false, error: { kind: "invalid_response" } };
    }
    const parsed = errorEnvelopeSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: { kind: "invalid_response" } };
    return {
      ok: false,
      error: {
        kind: "remote",
        code: parsed.data.error.code,
        requestId: parsed.data.error.requestId,
        ...(parsed.data.error.details.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: parsed.data.error.details.retryAfterMs }),
      },
    };
  }
}

/** Credential-only transport used to mint a fresh short-lived agent session. */
export class HRADispatchSessionClient {
  readonly #transport: DispatchHttpTransport;

  constructor(options: HRADispatchSessionClientOptions) {
    this.#transport = new DispatchHttpTransport(options);
  }

  startSession(
    idempotencyKey: IdempotencyKey,
    signal?: AbortSignal,
  ): Promise<DispatchCloudResult<StartSessionResponse>> {
    return this.#transport.post({
      path: taskctlApiRoutes.sessions,
      requestSchema: startSessionRequestSchema,
      responseSchema: startSessionEnvelopeSchema,
      body: {},
      idempotencyKey,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export class HRADispatchHttpClient {
  readonly #sessionId: SessionId;
  readonly #transport: DispatchHttpTransport;

  constructor(options: HRADispatchHttpClientOptions) {
    this.#sessionId = sessionIdSchema.parse(options.sessionId);
    this.#transport = new DispatchHttpTransport(options);
  }

  heartbeat(
    request: RunnerHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<DispatchCloudResult<RunnerHeartbeatResponse>> {
    return this.#post({
      path: hraDispatchRoutes.heartbeat,
      requestSchema: runnerHeartbeatRequestSchema,
      responseSchema: runnerHeartbeatEnvelopeSchema,
      body: request,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  claim(
    request: ClaimDispatchRequest,
    signal?: AbortSignal,
  ): Promise<DispatchCloudResult<{ readonly run: ClaimedDispatch }>> {
    return this.#post({
      path: hraDispatchRoutes.claim,
      requestSchema: claimDispatchRequestSchema,
      responseSchema: claimDispatchEnvelopeSchema,
      body: request,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  appendEvents(
    runId: string,
    request: AppendRunEventsRequest,
    signal?: AbortSignal,
  ): Promise<DispatchCloudResult<AppendRunEventsResponse>> {
    return this.#post({
      path: hraDispatchRoutes.events(runId),
      requestSchema: appendRunEventsRequestSchema,
      responseSchema: appendRunEventsEnvelopeSchema,
      body: request,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  syncInteractions(
    runId: string,
    request: SyncRunInteractionsRequest,
    signal?: AbortSignal,
  ): Promise<DispatchCloudResult<SyncRunInteractionsResponse>> {
    return this.#post({
      path: hraDispatchRoutes.interactions(runId),
      requestSchema: syncRunInteractionsRequestSchema,
      responseSchema: syncRunInteractionsEnvelopeSchema,
      body: request,
      requestLimitBytes: MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_REQUEST_BYTES,
      responseLimitBytes: MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_ENVELOPE_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  submitTask(
    taskKey: TaskKey,
    request: SubmitTaskRequest,
    idempotencyKey: IdempotencyKey,
    signal?: AbortSignal,
  ): Promise<DispatchCloudResult<SubmitTaskResponse>> {
    return this.#post({
      path: taskctlApiRoutes.submitTask(taskKeySchema.parse(taskKey)),
      requestSchema: submitTaskRequestSchema,
      responseSchema: submitTaskEnvelopeSchema,
      body: request,
      idempotencyKey,
      responseLimitBytes: MAX_SERIALIZED_SUBMISSION_ENVELOPE_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #post<RequestBody, ResponseBody>(
    options: RequestOptions<RequestBody, ResponseBody>,
  ): Promise<DispatchCloudResult<ResponseBody>> {
    return await this.#transport.post({ ...options, sessionId: this.#sessionId });
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) return null;
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) return null;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
