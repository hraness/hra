import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";

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

export class CloudRequestDeadlineError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Cloud request deadline exceeded after ${timeoutMs}ms.`);
    this.name = "CloudRequestDeadlineError";
    this.timeoutMs = timeoutMs;
  }
}

function requireRequestTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new Error("Cloud request timeout must be an integer from 1ms through 120000ms.");
  }
  return value;
}

function signalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Cloud request was aborted.");
}

function boundedFetch(
  implementation: typeof globalThis.fetch,
  timeoutMs: number,
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
      const request = implementation(resource, { ...init, signal: controller.signal });
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

export function createConvexCloudTransport(input: Readonly<{
  accessToken: AccessTokenProvider;
  deploymentUrl: string;
  fetch?: typeof globalThis.fetch;
  lifetimeSignal?: AbortSignal;
  requestTimeoutMs?: number;
}>): CloudTransport {
  const requestTimeoutMs = requireRequestTimeout(
    input.requestTimeoutMs ?? defaultCloudRequestTimeoutMs,
  );
  const client = new ConvexHttpClient(input.deploymentUrl, {
    fetch: boundedFetch(
      input.fetch ?? globalThis.fetch,
      requestTimeoutMs,
      input.lifetimeSignal,
    ),
    logger: false,
  });

  async function authenticate(): Promise<void> {
    const token = await input.accessToken();
    if (token === null) {
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
