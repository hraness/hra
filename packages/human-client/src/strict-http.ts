export const DEFAULT_HUMAN_HTTP_TIMEOUT_MS = 15_000;
export const MAX_HUMAN_HTTP_TIMEOUT_MS = 60_000;
export const DEFAULT_HUMAN_REQUEST_BYTES = 2 * 1_024 * 1_024;
export const MAX_HUMAN_REQUEST_BYTES = 8 * 1_024 * 1_024;
export const MAX_HUMAN_REQUEST_URL_BYTES = 16 * 1_024;
export const DEFAULT_HUMAN_RESPONSE_BYTES = 2 * 1_024 * 1_024;
export const MAX_HUMAN_RESPONSE_BYTES = 8 * 1_024 * 1_024;

const REQUEST_TIMED_OUT = Symbol("human HTTP request timed out");

export interface FetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface WireSchema<Value> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: Value }
    | { readonly success: false };
}

export interface StrictTransportFailure {
  readonly code: "SERVICE_UNAVAILABLE";
  readonly reason:
    | "invalid_request"
    | "network"
    | "timeout"
    | "redirect"
    | "oversized_response"
    | "invalid_response";
  readonly message: string;
}

export type StrictJsonResult<Success, Failure> =
  | { readonly ok: true; readonly status: number; readonly data: Success }
  | {
      readonly ok: false;
      readonly kind: "http";
      readonly status: number;
      readonly data: Failure;
    }
  | {
      readonly ok: false;
      readonly kind: "transport";
      readonly error: StrictTransportFailure;
    };

export type StrictRequestBody<Request> =
  | {
      readonly kind: "json";
      readonly value: unknown;
      readonly schema: WireSchema<Request>;
    }
  | {
      readonly kind: "form";
      readonly value: URLSearchParams;
    };

export interface StrictJsonRoute<Request, Success, Failure> {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: string;
  readonly successSchema: WireSchema<Success>;
  readonly failureSchema: WireSchema<Failure>;
  readonly body?: StrictRequestBody<Request>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly bearerToken?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface StrictHumanHttpClientOptions {
  readonly apiUrl: string;
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export type BoundedJsonFailureReason =
  | "oversized_response"
  | "invalid_response";

export type BoundedJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: BoundedJsonFailureReason };

function exactLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function normalizeApiOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (url.protocol === "http:" && !exactLoopbackHostname(url.hostname)) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    url.pathname = "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function jsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function validByteLimit(value: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

export async function readBoundedJsonResponse(
  response: Response,
  options: {
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
    readonly requireJsonContentType?: boolean;
  },
): Promise<BoundedJsonResult> {
  if (!validByteLimit(options.maxBytes, MAX_HUMAN_RESPONSE_BYTES)) {
    return { ok: false, reason: "invalid_response" };
  }
  if (
    options.requireJsonContentType === true &&
    !jsonContentType(response.headers.get("content-type"))
  ) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "invalid_response" };
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "invalid_response" };
    }
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "oversized_response" };
    }
  }

  const reader = response.body?.getReader();
  if (reader === undefined) return { ok: false, reason: "invalid_response" };

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let source = "";
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (options.signal?.aborted === true) {
        return { ok: false, reason: "invalid_response" };
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        return { ok: false, reason: "invalid_response" };
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "oversized_response" };
      }
      source += decoder.decode(chunk.value, { stream: true });
    }
    source += decoder.decode();
    const value: unknown = JSON.parse(source);
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "invalid_response" };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

function transportFailure(
  reason: StrictTransportFailure["reason"],
): StrictJsonResult<never, never> {
  const message =
    reason === "timeout"
      ? "the human service request timed out"
      : reason === "network"
        ? "could not reach the human service"
        : reason === "redirect"
          ? "the human service redirect was rejected"
          : reason === "oversized_response"
            ? "the human service response was too large"
            : reason === "invalid_request"
              ? "the human service request was invalid"
              : "the human service returned an invalid response";
  return {
    ok: false,
    kind: "transport",
    error: { code: "SERVICE_UNAVAILABLE", reason, message },
  };
}

function safePath(origin: string, path: string): URL | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  try {
    const url = new URL(path, `${origin}/`);
    if (
      url.origin !== origin ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function safeHeaders(
  source: Readonly<Record<string, string>> | undefined,
): Headers | null {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(source ?? {})) {
      const normalized = name.toLowerCase();
      if (
        normalized === "authorization" ||
        normalized === "cookie" ||
        normalized === "host" ||
        normalized === "content-length"
      ) {
        return null;
      }
      headers.set(name, value);
    }
    return headers;
  } catch {
    return null;
  }
}

export class StrictHumanHttpClient {
  readonly #apiUrl: string;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;

  constructor(options: StrictHumanHttpClientOptions) {
    const apiUrl = normalizeApiOrigin(options.apiUrl);
    if (apiUrl === null) {
      throw new TypeError("human API URL must be an absolute safe HTTP(S) origin");
    }
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_HUMAN_HTTP_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > MAX_HUMAN_HTTP_TIMEOUT_MS
    ) {
      throw new TypeError(
        "request timeout must be an integer from 1 to 60000 milliseconds",
      );
    }
    const maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_HUMAN_RESPONSE_BYTES;
    if (!validByteLimit(maxResponseBytes, MAX_HUMAN_RESPONSE_BYTES)) {
      throw new TypeError(
        `response limit must be an integer from 1 to ${MAX_HUMAN_RESPONSE_BYTES} bytes`,
      );
    }
    const maxRequestBytes =
      options.maxRequestBytes ?? DEFAULT_HUMAN_REQUEST_BYTES;
    if (!validByteLimit(maxRequestBytes, MAX_HUMAN_REQUEST_BYTES)) {
      throw new TypeError(
        `request limit must be an integer from 1 to ${MAX_HUMAN_REQUEST_BYTES} bytes`,
      );
    }
    this.#apiUrl = apiUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxRequestBytes = maxRequestBytes;
    this.#maxResponseBytes = maxResponseBytes;
  }

  async request<Request, Success, Failure>(
    route: StrictJsonRoute<Request, Success, Failure>,
  ): Promise<StrictJsonResult<Success, Failure>> {
    const url = safePath(this.#apiUrl, route.path);
    const headers = safeHeaders(route.headers);
    if (url === null || headers === null) {
      return transportFailure("invalid_request");
    }
    try {
      for (const [name, value] of Object.entries(route.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, value);
      }
    } catch {
      return transportFailure("invalid_request");
    }
    if (
      new TextEncoder().encode(url.toString()).byteLength >
        MAX_HUMAN_REQUEST_URL_BYTES
    ) {
      return transportFailure("invalid_request");
    }

    let body: string | URLSearchParams | undefined;
    try {
      if (route.body?.kind === "json") {
        const parsed = route.body.schema.safeParse(route.body.value);
        if (!parsed.success) return transportFailure("invalid_request");
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(parsed.data);
        if (body === undefined) return transportFailure("invalid_request");
      } else if (route.body?.kind === "form") {
        headers.set("Content-Type", "application/x-www-form-urlencoded");
        body = route.body.value;
      }
      if (route.bearerToken !== undefined) {
        headers.set("Authorization", `Bearer ${route.bearerToken}`);
      }
    } catch {
      return transportFailure("invalid_request");
    }

    const maxRequestBytes = route.maxRequestBytes ?? this.#maxRequestBytes;
    if (
      !validByteLimit(maxRequestBytes, MAX_HUMAN_REQUEST_BYTES) ||
      maxRequestBytes > this.#maxRequestBytes
    ) {
      return transportFailure("invalid_request");
    }
    if (
      body !== undefined &&
      new TextEncoder().encode(
        typeof body === "string" ? body : body.toString(),
      ).byteLength > maxRequestBytes
    ) {
      return transportFailure("invalid_request");
    }
    const maxBytes = route.maxResponseBytes ?? this.#maxResponseBytes;
    if (
      !validByteLimit(maxBytes, MAX_HUMAN_RESPONSE_BYTES) ||
      maxBytes > this.#maxResponseBytes
    ) {
      return transportFailure("invalid_request");
    }

    const controller = new AbortController();
    const perform = async (): Promise<StrictJsonResult<Success, Failure>> => {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: route.method,
          headers,
          redirect: "error",
          signal: controller.signal,
          ...(body === undefined ? {} : { body }),
        });
      } catch {
        return controller.signal.aborted
          ? transportFailure("timeout")
          : transportFailure("network");
      }

      if (
        (response.status >= 300 && response.status < 400) ||
        response.type === "opaqueredirect"
      ) {
        await response.body?.cancel().catch(() => undefined);
        return transportFailure("redirect");
      }
      if (response.url.length > 0) {
        try {
          if (new URL(response.url).origin !== this.#apiUrl) {
            await response.body?.cancel().catch(() => undefined);
            return transportFailure("redirect");
          }
        } catch {
          await response.body?.cancel().catch(() => undefined);
          return transportFailure("invalid_response");
        }
      }

      const parsedBody = await readBoundedJsonResponse(response, {
        maxBytes,
        signal: controller.signal,
        requireJsonContentType: true,
      });
      if (!parsedBody.ok) return transportFailure(parsedBody.reason);
      if (response.ok) {
        const parsed = route.successSchema.safeParse(parsedBody.value);
        return parsed.success
          ? { ok: true, status: response.status, data: parsed.data }
          : transportFailure("invalid_response");
      }
      const parsed = route.failureSchema.safeParse(parsedBody.value);
      return parsed.success
        ? {
            ok: false,
            kind: "http",
            status: response.status,
            data: parsed.data,
          }
        : transportFailure("invalid_response");
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<typeof REQUEST_TIMED_OUT>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(REQUEST_TIMED_OUT);
      }, this.#requestTimeoutMs);
    });
    const result = await Promise.race([perform(), timeoutResult]);
    if (timeout !== undefined) clearTimeout(timeout);
    return result === REQUEST_TIMED_OUT
      ? transportFailure("timeout")
      : result;
  }
}
