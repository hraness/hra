import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";

import { cloudLimits } from "./contracts";

export const cloudQueries = [
  "accountDeletion:status",
  "account:current",
  "devices:currentRegistration",
  "devices:get",
  "devices:list",
  "devices:listPage",
  "devices:listKeyEnvelopes",
  "presence:current",
  "sessions:listHeads",
  "sessions:listHeadsPage",
  "sessions:getHead",
  "sessions:getChunks",
  "sessions:getLatestChunks",
  "leases:current",
  "commands:listForSession",
  "commands:get",
  "commands:listPendingForTarget",
  "commands:listPendingForTargetPage",
  "commands:listNonterminalForTargetPage",
  "usage:getAccountBinding",
  "usage:listAccounts",
  "usage:listSnapshots",
] as const;

export const cloudMutations = [
  "accountDeletion:request",
  "devices:register",
  "devices:recoverRegistration",
  "devices:approve",
  "devices:beginBind",
  "devices:revoke",
  "presence:connect",
  "presence:heartbeat",
  "presence:disconnect",
  "sessions:create",
  "sessions:beginCompactEpoch",
  "sessions:appendChunk",
  "sessions:updateMetadata",
  "sessions:updateState",
  "leases:acquire",
  "leases:heartbeat",
  "commands:enqueue",
  "commands:acknowledgeReceipt",
  "commands:prepare",
  "commands:markEffectStarted",
  "commands:settle",
  "commands:recoverEffectStarted",
  "commands:cancelPending",
  "usage:upsertAccount",
  "usage:upsertSnapshot",
] as const;

export const cloudActions = [
  "auth:signIn",
  "auth:signOut",
  "devices:finishBind",
] as const;

export type CloudQuery = (typeof cloudQueries)[number];
export type CloudMutation = (typeof cloudMutations)[number];
export type CloudAction = (typeof cloudActions)[number];
export type CloudArgs = Readonly<Record<string, Value>>;
export type AccessTokenProvider = () => Promise<string | null>;

export interface CloudTransport {
  action(name: CloudAction, args: CloudArgs): Promise<unknown>;
  mutation(name: CloudMutation, args: CloudArgs): Promise<unknown>;
  query(name: CloudQuery, args: CloudArgs): Promise<unknown>;
}

export const defaultCloudRequestTimeoutMs = 15_000;

// The largest legitimate response is one full page of detail chunks: each
// chunk carries a ciphertext at the ciphertext bound plus its envelope,
// identifiers, and timestamps (allowed 4 KiB), and the Convex wrapper around
// the page gets 1 MiB. Every other query and mutation returns far less.
const cloudResponseEnvelopeBytes = 4_096;
const cloudResponseWrapperBytes = 1_048_576;
export const maximumCloudResponseBytes =
  cloudLimits.pageSize * (cloudLimits.ciphertextCharacters + cloudResponseEnvelopeBytes)
  + cloudResponseWrapperBytes;

export class CloudRequestDeadlineError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Cloud request deadline exceeded after ${timeoutMs}ms.`);
    this.name = "CloudRequestDeadlineError";
    this.timeoutMs = timeoutMs;
  }
}

export class CloudResponseTooLargeError extends Error {
  readonly code = "CLOUD_RESPONSE_TOO_LARGE" as const;
  readonly maximumBytes: number;

  constructor(maximumBytes: number) {
    super(`Cloud response exceeded ${maximumBytes} bytes.`);
    this.name = "CloudResponseTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

function requireRequestTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new Error("Cloud request timeout must be an integer from 1ms through 120000ms.");
  }
  return value;
}

function requireResponseBound(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumCloudResponseBytes) {
    throw new Error(
      `Cloud response bound must be an integer from 1 through ${maximumCloudResponseBytes} bytes.`,
    );
  }
  return value;
}

const bodylessStatuses = new Set([101, 103, 204, 205, 304]);

// Reads the body through a hard byte cap before the Convex client parses it.
// A declared length over the cap fails before any body byte is read; an
// undeclared or understated length fails at the first byte over the cap.
async function boundResponseBody(response: Response, maximumBytes: number): Promise<Response> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]{1,15}$/u.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudResponseTooLargeError(maximumBytes);
  }
  if (response.body === null || bodylessStatuses.has(response.status)) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CloudResponseTooLargeError(maximumBytes);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function signalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Cloud request was aborted.");
}

function boundedFetch(
  implementation: typeof globalThis.fetch,
  timeoutMs: number,
  maximumResponseBytes: number,
  lifetimeSignal?: AbortSignal,
): typeof globalThis.fetch {
  const execute = async (
    resource: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const upstreamSignals = [...new Set([lifetimeSignal, init?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    ))];
    const alreadyAborted = upstreamSignals.find((signal) => signal.aborted);
    if (alreadyAborted !== undefined) throw signalReason(alreadyAborted);
    const controller = new AbortController();
    let cancelled = false;
    let rejectBoundary!: (reason: Error) => void;
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectBoundary = reject;
    });
    const cancel = (reason: Error): void => {
      if (cancelled) return;
      cancelled = true;
      // Settle our boundary before notifying fetch. This keeps deadline errors
      // stable even when a fetch implementation rejects synchronously on abort.
      rejectBoundary(reason);
      controller.abort(reason);
    };
    const deadline = setTimeout(() => {
      cancel(new CloudRequestDeadlineError(timeoutMs));
    }, timeoutMs);
    const listeners = upstreamSignals.map((signal) => {
      const listener = () => cancel(signalReason(signal));
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
      return { listener, signal };
    });

    try {
      // The deadline covers the body read as well as the headers.
      const request = implementation(resource, { ...init, signal: controller.signal })
        .then((response) => boundResponseBody(response, maximumResponseBytes));
      return await Promise.race([request, boundary]);
    } finally {
      clearTimeout(deadline);
      for (const { listener, signal } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    }
  };
  return Object.assign(execute, { preconnect: implementation.preconnect });
}

function requireAccessToken(value: string): string {
  if (value.length < 32 || value.length > 16_384 || /\s/u.test(value)) {
    throw new Error("Cloud access token is unavailable.");
  }
  return value;
}

/*
 * Convex verifies a presented bearer token before it runs any function, and it
 * rejects an expired one with an authentication error even for calls that need
 * no identity, such as the refresh-token sign-in that replaces that very token.
 * A token whose `exp` claim has passed (with a small skew) is therefore never
 * presented; the call proceeds unauthenticated instead.
 */
export const accessTokenExpirySkewMs = 30_000;

export function accessTokenExpiresAt(token: string): number | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const payload = segments[1];
  if (payload === undefined || payload.length === 0 || payload.length > 8_192) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || !("exp" in decoded)) return null;
  const exp = decoded.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
  return exp * 1_000;
}

export function isExpiredAccessToken(token: string, now: number): boolean {
  const expiresAt = accessTokenExpiresAt(token);
  return expiresAt !== null && expiresAt <= now + accessTokenExpirySkewMs;
}

export function createConvexCloudTransport(input: Readonly<{
  accessToken: AccessTokenProvider;
  deploymentUrl: string;
  fetch?: typeof globalThis.fetch;
  lifetimeSignal?: AbortSignal;
  maximumResponseBytes?: number;
  now?: () => number;
  requestTimeoutMs?: number;
}>): CloudTransport {
  const now = input.now ?? Date.now;
  const requestTimeoutMs = requireRequestTimeout(
    input.requestTimeoutMs ?? defaultCloudRequestTimeoutMs,
  );
  const maximumResponseBytes = requireResponseBound(
    input.maximumResponseBytes ?? maximumCloudResponseBytes,
  );
  const client = new ConvexHttpClient(input.deploymentUrl, {
    fetch: boundedFetch(
      input.fetch ?? globalThis.fetch,
      requestTimeoutMs,
      maximumResponseBytes,
      input.lifetimeSignal,
    ),
    logger: false,
  });

  async function authenticate(): Promise<void> {
    const token = await input.accessToken();
    if (token === null || isExpiredAccessToken(token, now())) {
      client.clearAuth();
      return;
    }
    client.setAuth(requireAccessToken(token));
  }

  return {
    async action(name, args) {
      await authenticate();
      return await client.action(
        makeFunctionReference<"action", CloudArgs, unknown>(name),
        args,
      );
    },
    async mutation(name, args) {
      await authenticate();
      // Mutations are deliberately not retried here. The caller reconciles by
      // its idempotency key after a lost response.
      return await client.mutation(
        makeFunctionReference<"mutation", CloudArgs, unknown>(name),
        args,
      );
    },
    async query(name, args) {
      await authenticate();
      return await client.query(
        makeFunctionReference<"query", CloudArgs, unknown>(name),
        args,
      );
    },
  };
}
