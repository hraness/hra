import {
  classifyCodexEnvelope,
  classifyCodexJsonLine,
  type CodexEnvelope,
  type CodexEnvelopeFaultReason,
  type CodexRequestId,
} from "./envelope";
import { CodexJsonlDecoder } from "./jsonl";
import type { CodexJsonlFaultReason } from "./jsonl";
import type { CodexJsonlWriter } from "./writer";
const MAX_SETTLED_REQUESTS = 1_024;
export const MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION = 64;
export const MAX_CODEX_SERVER_REQUEST_IDS_PER_GENERATION = 4_096;
export const MAX_CODEX_STREAM_POSITION = Number.MAX_SAFE_INTEGER;

export type CodexStreamPosition = number;

export function nextCodexStreamPosition(
  current: number,
): CodexStreamPosition | null {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error("Codex stream position must be a non-negative safe integer");
  }
  return current === MAX_CODEX_STREAM_POSITION
    ? null
    : current + 1;
}

type Awaitable<T> = T | Promise<T>;

export type CodexRequestIntent = "read" | "ambiguousMutation";

export interface CodexRequestOptions {
  readonly intent: CodexRequestIntent;
  readonly timeoutMs?: number;
}

export interface CodexNotification {
  readonly generation: number;
  readonly method: string;
  readonly params: unknown;
  readonly streamPosition: CodexStreamPosition;
}

export interface CodexServerRequest {
  readonly generation: number;
  readonly id: CodexRequestId;
  readonly method: string;
  readonly params: unknown;
  readonly requestInstanceId: number;
  readonly streamPosition: CodexStreamPosition;
}

export interface CodexResponseAtPosition<T> {
  readonly generation: number;
  readonly result: T;
  readonly streamPosition: CodexStreamPosition;
}

export type CodexServerResponse =
  | Readonly<{ type: "result"; result: unknown }>
  | Readonly<{
      type: "error";
      code: number;
      message: string;
    }>;

export type CodexProtocolDiagnostic =
  | Readonly<{
      type: "request_timeout";
      generation: number;
      intent: CodexRequestIntent;
      method: string;
    }>
  | Readonly<{
      type: "unknown_notification";
      generation: number;
      method: string;
    }>
  | Readonly<{
      type: "invalid_envelope";
      generation: number;
      reason: CodexEnvelopeFaultReason | CodexJsonlFaultReason;
    }>
  | Readonly<{
      type: "duplicate_response";
      generation: number;
      requestIdType: "number" | "string";
    }>
  | Readonly<{
      type: "orphan_response";
      generation: number;
      requestIdType: "number" | "string";
    }>
  | Readonly<{
      type: "stale_generation";
      generation: number;
      observedGeneration: number;
    }>
  | Readonly<{
      type: "stream_position_exhausted";
      generation: number;
    }>
  | Readonly<{
      type: "invalid_inbound_payload";
      generation: number;
      source: "notification" | "server_request";
      method: string;
    }>
  | Readonly<{
      type: "invalid_inbound_payload";
      generation: number;
      source: "response";
      operation: string;
    }>;

export interface CodexExpiredServerRequestFault {
  readonly type: "server_request_expired";
  readonly generation: number;
  readonly method: string;
  readonly requestId?: CodexRequestId;
  readonly reason:
    | "unsupported_method"
    | "duplicate_id"
    | "generation_ended"
    | "response_write_failed"
    | "resolved_elsewhere"
    | "invalid_params"
    | "duplicate_call"
    | "replay_conflict"
    | "capacity_exceeded";
}

export interface CodexRpcCallbacks {
  readonly onNotification?: (notification: CodexNotification) => Awaitable<void>;
  readonly onServerRequest?: (request: CodexServerRequest) => Awaitable<void>;
  readonly onDiagnostic?: (diagnostic: CodexProtocolDiagnostic) => Awaitable<void>;
  readonly onServerRequestExpired?: (
    fault: CodexExpiredServerRequestFault,
  ) => Awaitable<void>;
}

export interface CodexRawProtocolPolicy {
  readonly notificationMethods: readonly string[];
  readonly serverRequestMethods: readonly string[];
  readonly classifyRemoteError: (
    error: Readonly<Record<string, unknown>>,
  ) => CodexRemoteResponseError["kind"];
}

export type CodexGenerationEndReason =
  | "process_exited"
  | "protocol_fault"
  | "restart_requested"
  | "stopped";

export class CodexRequestExpiredError extends Error {
  readonly generation: number;
  readonly intent: CodexRequestIntent;
  readonly reason: CodexGenerationEndReason | "timeout";
  readonly automaticReplay = false;

  constructor(
    generation: number,
    intent: CodexRequestIntent,
    reason: CodexGenerationEndReason | "timeout",
  ) {
    super("The Codex request expired without a confirmed response.");
    this.name = "CodexRequestExpiredError";
    this.generation = generation;
    this.intent = intent;
    this.reason = reason;
  }
}

export class CodexRemoteResponseError extends Error {
  readonly code: number | null;
  readonly kind: "authentication_invalid" | "other";

  constructor(code: number | null, kind: "authentication_invalid" | "other" = "other") {
    super("Codex returned a protocol error response.");
    this.name = "CodexRemoteResponseError";
    this.code = code;
    this.kind = kind;
  }
}


interface PendingRequest {
  readonly intent: CodexRequestIntent;
  readonly method: string;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: CodexResponseAtPosition<unknown>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function requestKey(generation: number, id: CodexRequestId): string {
  return `${generation}:${typeof id}:${String(id)}`;
}

function requestIdType(id: CodexRequestId): "number" | "string" {
  return typeof id === "number" ? "number" : "string";
}

function safeMethodName(method: string): string {
  const characters = [...method].slice(0, 160);
  const safe = characters
    .map((character) => (/^[A-Za-z0-9/_.:-]$/u.test(character) ? character : "?"))
    .join("");
  return safe.length === 0 ? "unknown" : safe;
}

export class CodexRpcCore {
  readonly #callbacks: CodexRpcCallbacks;
  readonly #decoder: CodexJsonlDecoder;
  readonly #generation: number;
  readonly #notificationMethods: ReadonlySet<string>;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #serverRequests = new Map<string, CodexServerRequest>();
  readonly #seenServerRequestKeys = new Set<string>();
  readonly #settlingServerRequests = new Map<string, CodexServerRequest>();
  readonly #settled = new Map<string, true>();
  readonly #serverRequestMethods: ReadonlySet<string>;
  readonly #classifyRemoteError: CodexRawProtocolPolicy["classifyRemoteError"];
  readonly #writer: CodexJsonlWriter;
  #ended = false;
  #nextRequestId = 1;
  #nextServerRequestInstanceId: number | null = 1;
  #streamPosition = 0;

  constructor(
    generation: number,
    writer: CodexJsonlWriter,
    callbacks: CodexRpcCallbacks,
    protocolPolicy: CodexRawProtocolPolicy,
  ) {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error("Codex process generation must be a positive safe integer");
    }
    this.#generation = generation;
    this.#writer = writer;
    this.#callbacks = callbacks;
    this.#classifyRemoteError = protocolPolicy.classifyRemoteError;
    this.#notificationMethods = new Set(protocolPolicy.notificationMethods);
    this.#serverRequestMethods = new Set(protocolPolicy.serverRequestMethods);
    this.#decoder = new CodexJsonlDecoder();
  }

  get generation(): number {
    return this.#generation;
  }

  async request(
    method: string,
    params: unknown,
    options: CodexRequestOptions,
  ): Promise<unknown> {
    return (await this.requestWithResponsePosition(method, params, options)).result;
  }

  async requestWithResponsePosition(
    method: string,
    params: unknown,
    options: CodexRequestOptions,
  ): Promise<CodexResponseAtPosition<unknown>> {
    this.#throwIfEnded();
    if (method.length === 0) throw new Error("Codex request method must not be empty");
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Codex request timeout must be a positive safe integer");
    }
    const id = `hra-${this.#generation}-${this.#nextRequestId++}`;
    const key = requestKey(this.#generation, id);
    const response = new Promise<CodexResponseAtPosition<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(key);
        if (pending === undefined) return;
        this.#pending.delete(key);
        this.#rememberSettled(key);
        this.#reportRequestTimeout(pending);
        reject(new CodexRequestExpiredError(this.#generation, pending.intent, "timeout"));
      }, timeoutMs);
      this.#pending.set(key, {
        intent: options.intent,
        method: safeMethodName(method),
        reject,
        resolve,
        timer,
      });
    });

    try {
      await this.#writer.write(
        params === undefined ? { id, method } : { id, method, params },
      );
    } catch {
      await this.expire("process_exited");
    }
    return await response;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.#throwIfEnded();
    if (method.length === 0) throw new Error("Codex notification method must not be empty");
    try {
      await this.#writer.write(
        params === undefined ? { method } : { method, params },
      );
    } catch {
      await this.expire("process_exited");
      throw new Error("Codex notification could not be written");
    }
  }

  #reportRequestTimeout(pending: PendingRequest): void {
    try {
      // Invoke the observer before rejecting the request. The production
      // process observer synchronously faults this exact generation, so a
      // caller reacting to the rejection cannot race another request through
      // the live-but-unresponsive child. Diagnostics are still observational:
      // a rejected or stalled observer cannot delay the request deadline.
      void Promise.resolve(this.#callbacks.onDiagnostic?.({
        type: "request_timeout",
        generation: this.#generation,
        intent: pending.intent,
        method: pending.method,
      })).catch(() => undefined);
    } catch {
      // The timeout remains terminal evidence even if an observer throws.
    }
  }

  async receiveChunk(sourceGeneration: number, chunk: Uint8Array): Promise<void> {
    if (!(await this.#acceptGeneration(sourceGeneration))) return;
    let lines: readonly string[];
    try {
      lines = this.#decoder.push(chunk);
    } catch (error: unknown) {
      const reason = error instanceof Error && "reason" in error
        ? this.#jsonlReason(error.reason)
        : "invalid_utf8";
      await this.#invalidEnvelope(reason);
      return;
    }
    for (const line of lines) await this.receiveLine(sourceGeneration, line);
  }

  async finish(sourceGeneration: number): Promise<void> {
    if (!(await this.#acceptGeneration(sourceGeneration))) return;
    let lines: readonly string[];
    try {
      lines = this.#decoder.finish();
    } catch (error: unknown) {
      const reason = error instanceof Error && "reason" in error
        ? this.#jsonlReason(error.reason)
        : "invalid_utf8";
      await this.#invalidEnvelope(reason);
      return;
    }
    for (const line of lines) await this.receiveLine(sourceGeneration, line);
  }

  async receiveLine(sourceGeneration: number, line: string): Promise<void> {
    if (!(await this.#acceptGeneration(sourceGeneration))) return;
    const classified = classifyCodexJsonLine(line);
    if (!classified.ok) {
      await this.#invalidEnvelope(classified.reason);
      return;
    }
    await this.#receiveEnvelope(classified.envelope);
  }

  async receiveValue(sourceGeneration: number, value: unknown): Promise<void> {
    if (!(await this.#acceptGeneration(sourceGeneration))) return;
    const classified = classifyCodexEnvelope(value);
    if (!classified.ok) {
      await this.#invalidEnvelope(classified.reason);
      return;
    }
    await this.#receiveEnvelope(classified.envelope);
  }

  async respond(
    request: CodexServerRequest,
    response: CodexServerResponse,
  ): Promise<CodexStreamPosition> {
    this.#throwIfEnded();
    const key = requestKey(request.generation, request.id);
    const active = this.#serverRequests.get(key);
    if (request.generation !== this.#generation || active !== request) {
      throw new Error("Codex server request is no longer active");
    }
    this.#serverRequests.delete(key);
    this.#settlingServerRequests.set(key, request);
    try {
      await this.#writer.write(
        response.type === "result"
          ? { id: request.id, result: response.result }
          : {
              id: request.id,
              error: { code: response.code, message: response.message },
            },
      );
    } catch {
      const stillOwned = this.#settlingServerRequests.get(key) === request;
      try {
        if (stillOwned) {
          this.#settlingServerRequests.delete(key);
          await this.#callbacks.onServerRequestExpired?.({
            type: "server_request_expired",
            generation: this.#generation,
            method: safeMethodName(request.method),
            requestId: request.id,
            reason: "response_write_failed",
          });
        }
      } finally {
        await this.expire("process_exited");
      }
      throw new Error("Codex server-request response could not be written");
    }
    if (this.#settlingServerRequests.get(key) !== request) {
      throw new Error("Codex server request expired while its response was settling");
    }
    this.#settlingServerRequests.delete(key);
    const streamPosition = nextCodexStreamPosition(this.#streamPosition);
    if (streamPosition === null) {
      try {
        await this.#callbacks.onDiagnostic?.({
          type: "stream_position_exhausted",
          generation: this.#generation,
        });
      } catch {
        // Diagnostics cannot change the terminal protocol outcome.
      } finally {
        await this.expire("protocol_fault");
      }
      throw new Error("Codex stream position exhausted after a server-request response");
    }
    this.#streamPosition = streamPosition;
    return streamPosition;
  }

  async resolveServerRequest(id: CodexRequestId): Promise<boolean> {
    this.#throwIfEnded();
    const key = requestKey(this.#generation, id);
    const request = this.#serverRequests.get(key);
    if (request === undefined) return false;
    this.#serverRequests.delete(key);
    try {
      await this.#callbacks.onServerRequestExpired?.({
        type: "server_request_expired",
        generation: this.#generation,
        method: safeMethodName(request.method),
        requestId: request.id,
        reason: "resolved_elsewhere",
      });
    } catch {
      // The provider resolution remains authoritative if a projection fails.
    }
    return true;
  }

  async expire(reason: CodexGenerationEndReason): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    for (const [key, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new CodexRequestExpiredError(this.#generation, pending.intent, reason));
      this.#rememberSettled(key);
    }
    this.#pending.clear();
    const requests = [
      ...this.#serverRequests.values(),
      ...this.#settlingServerRequests.values(),
    ];
    this.#serverRequests.clear();
    this.#settlingServerRequests.clear();
    for (const request of requests) {
      try {
        await this.#callbacks.onServerRequestExpired?.({
          type: "server_request_expired",
          generation: this.#generation,
          method: safeMethodName(request.method),
          requestId: request.id,
          reason: "generation_ended",
        });
      } catch {
        // Expiration remains terminal even if a projection callback fails.
      }
    }
  }

  async #receiveEnvelope(envelope: CodexEnvelope): Promise<void> {
    const streamPosition = nextCodexStreamPosition(this.#streamPosition);
    if (streamPosition === null) {
      try {
        await this.#callbacks.onDiagnostic?.({
          type: "stream_position_exhausted",
          generation: this.#generation,
        });
      } finally {
        await this.expire("protocol_fault");
      }
      return;
    }
    this.#streamPosition = streamPosition;
    switch (envelope.type) {
      case "notification":
        await this.#receiveNotification(
          envelope.method,
          envelope.params,
          streamPosition,
        );
        return;
      case "request":
        await this.#receiveServerRequest(envelope, streamPosition);
        return;
      case "success":
        await this.#receiveResponse(
          envelope.id,
          { type: "success", result: envelope.result },
          streamPosition,
        );
        return;
      case "error":
        await this.#receiveResponse(
          envelope.id,
          { type: "error", error: envelope.error },
          streamPosition,
        );
    }
  }

  async #receiveNotification(
    method: string,
    params: unknown,
    streamPosition: CodexStreamPosition,
  ): Promise<void> {
    if (!this.#notificationMethods.has(method)) {
      await this.#callbacks.onDiagnostic?.({
        type: "unknown_notification",
        generation: this.#generation,
        method: safeMethodName(method),
      });
      return;
    }
    await this.#callbacks.onNotification?.({
      generation: this.#generation,
      method,
      params,
      streamPosition,
    });
  }

  async #receiveServerRequest(
    envelope: Extract<CodexEnvelope, { type: "request" }>,
    streamPosition: CodexStreamPosition,
  ): Promise<void> {
    if (!this.#serverRequestMethods.has(envelope.method)) {
      try {
        try {
          await this.#writer.write({
            id: envelope.id,
            error: { code: -32_601, message: "Method not found" },
          });
        } catch {
          await this.expire("process_exited");
          throw new Error("Codex method-not-found response could not be written");
        }
      } finally {
        await this.#callbacks.onServerRequestExpired?.({
          type: "server_request_expired",
          generation: this.#generation,
          method: safeMethodName(envelope.method),
          requestId: envelope.id,
          reason: "unsupported_method",
        });
      }
      return;
    }

    const key = requestKey(this.#generation, envelope.id);
    if (this.#seenServerRequestKeys.has(key)) {
      await this.#rejectTerminalServerRequest(
        envelope,
        "duplicate_id",
        "Codex reused a server-request identifier",
      );
      return;
    }
    if (this.#seenServerRequestKeys.size >= MAX_CODEX_SERVER_REQUEST_IDS_PER_GENERATION) {
      await this.#rejectTerminalServerRequest(
        envelope,
        "capacity_exceeded",
        "Codex exceeded the server-request generation limit",
      );
      return;
    }
    this.#seenServerRequestKeys.add(key);
    if (
      this.#serverRequests.size + this.#settlingServerRequests.size >=
        MAX_ACTIVE_CODEX_SERVER_REQUESTS_PER_GENERATION ||
      this.#nextServerRequestInstanceId === null
    ) {
      try {
        await this.#writer.write({
          id: envelope.id,
          error: { code: -32_000, message: "Server request capacity exceeded" },
        });
      } catch {
        await this.expire("process_exited");
        throw new Error("Codex capacity response could not be written");
      }
      await this.#callbacks.onServerRequestExpired?.({
        type: "server_request_expired",
        generation: this.#generation,
        method: safeMethodName(envelope.method),
        requestId: envelope.id,
        reason: "capacity_exceeded",
      });
      return;
    }
    const requestInstanceId = this.#nextServerRequestInstanceId;
    this.#nextServerRequestInstanceId = requestInstanceId === Number.MAX_SAFE_INTEGER
      ? null
      : requestInstanceId + 1;
    const request: CodexServerRequest = {
      generation: this.#generation,
      id: envelope.id,
      method: envelope.method,
      params: envelope.params,
      requestInstanceId,
      streamPosition,
    };
    this.#serverRequests.set(key, request);
    await this.#callbacks.onServerRequest?.(request);
  }

  async #rejectTerminalServerRequest(
    envelope: Extract<CodexEnvelope, { type: "request" }>,
    reason: "duplicate_id" | "capacity_exceeded",
    message: string,
  ): Promise<void> {
    let writeFailed = false;
    try {
      await this.#writer.write({
        id: envelope.id,
        error: { code: -32_600, message },
      });
    } catch {
      writeFailed = true;
    }
    try {
      await this.#callbacks.onServerRequestExpired?.({
        type: "server_request_expired",
        generation: this.#generation,
        method: safeMethodName(envelope.method),
        requestId: envelope.id,
        reason,
      });
    } catch {
      // Authority termination cannot depend on an observer.
    }
    try {
      await this.#callbacks.onDiagnostic?.({
        type: "invalid_inbound_payload",
        generation: this.#generation,
        source: "server_request",
        method: safeMethodName(envelope.method),
      });
    } catch {
      // The terminal protocol fault remains authoritative.
    } finally {
      await this.expire(writeFailed ? "process_exited" : "protocol_fault");
    }
    if (writeFailed) {
      throw new Error("Codex terminal server-request response could not be written");
    }
  }

  async #receiveResponse(
    id: CodexRequestId,
    response:
      | Readonly<{ type: "success"; result: unknown }>
      | Readonly<{ type: "error"; error: Readonly<Record<string, unknown>> }>,
    streamPosition: CodexStreamPosition,
  ): Promise<void> {
    const key = requestKey(this.#generation, id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      await this.#callbacks.onDiagnostic?.({
        type: this.#settled.has(key) ? "duplicate_response" : "orphan_response",
        generation: this.#generation,
        requestIdType: requestIdType(id),
      });
      return;
    }
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    this.#rememberSettled(key);
    if (response.type === "success") {
      pending.resolve({
        generation: this.#generation,
        result: response.result,
        streamPosition,
      });
      return;
    }
    const code = typeof response.error.code === "number" && Number.isFinite(response.error.code)
      ? response.error.code
      : null;
    let kind: CodexRemoteResponseError["kind"] = "other";
    try {
      kind = this.#classifyRemoteError(response.error);
    } catch {
      // A compatibility classifier cannot prevent deterministic settlement.
    }
    pending.reject(new CodexRemoteResponseError(code, kind));
  }

  async #acceptGeneration(sourceGeneration: number): Promise<boolean> {
    if (sourceGeneration === this.#generation && !this.#ended) return true;
    await this.#callbacks.onDiagnostic?.({
      type: "stale_generation",
      generation: this.#generation,
      observedGeneration: sourceGeneration,
    });
    return false;
  }

  async #invalidEnvelope(
    reason: CodexEnvelopeFaultReason | CodexJsonlFaultReason,
  ): Promise<void> {
    try {
      await this.#callbacks.onDiagnostic?.({
        type: "invalid_envelope",
        generation: this.#generation,
        reason,
      });
    } finally {
      await this.expire("protocol_fault");
    }
  }

  #jsonlReason(value: unknown): CodexJsonlFaultReason {
    return value === "decoder_finished" || value === "invalid_utf8" || value === "line_too_large"
      ? value
      : "invalid_utf8";
  }

  #rememberSettled(key: string): void {
    this.#settled.delete(key);
    this.#settled.set(key, true);
    if (this.#settled.size <= MAX_SETTLED_REQUESTS) return;
    const oldest = this.#settled.keys().next().value;
    if (oldest !== undefined) this.#settled.delete(oldest);
  }

  #throwIfEnded(): void {
    if (this.#ended) throw new Error("Codex process generation has ended");
  }
}
