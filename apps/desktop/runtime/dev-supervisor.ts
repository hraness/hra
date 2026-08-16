import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";

import {
  devSessionIdFromBytes,
  type DevReadinessHttpResponse,
  type DevSessionId,
  HRA_DEV_FRONTEND_HOST,
  HRA_DEV_FRONTEND_PORT,
  HRA_DEV_READY_URL,
  parseDevReadinessResponse,
} from "./dev-protocol";

export type ListenerProbeResult =
  | { readonly kind: "refused" }
  | { readonly kind: "reachable" }
  | { readonly detail: string; readonly kind: "indeterminate" };

export type ReadinessProbeResult =
  | { readonly kind: "unreachable" }
  | { readonly kind: "response"; readonly response: DevReadinessHttpResponse };

export interface DevReadinessWaitOptions {
  readonly expectedSessionId: DevSessionId;
  readonly probe: () => Promise<ReadinessProbeResult>;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

export type DevShutdownSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export type DevAppSpawnOutcome<T> =
  | Readonly<{ readonly kind: "spawned"; readonly value: T }>
  | Readonly<{ readonly kind: "not-authorized" }>
  | Readonly<{ readonly kind: "shutdown"; readonly signal: DevShutdownSignal }>
  | Readonly<{ readonly code: number; readonly kind: "vite-exit" }>;

const DEFAULT_LISTENER_PROBE_TIMEOUT_MS = 350;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 100;
const READY_REQUEST_TIMEOUT_MS = 750;
const MAX_READY_BODY_BYTES = 512;

export function createDevSessionId(
  random: (size: number) => Uint8Array = randomBytes,
): DevSessionId {
  return devSessionIdFromBytes(random(32));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

export async function probeFixedDevListener(
  timeoutMs = DEFAULT_LISTENER_PROBE_TIMEOUT_MS,
): Promise<ListenerProbeResult> {
  return await new Promise((resolve) => {
    const socket = createConnection({
      host: HRA_DEV_FRONTEND_HOST,
      port: HRA_DEV_FRONTEND_PORT,
    });
    let settled = false;
    const finish = (result: ListenerProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        kind: "indeterminate",
        detail: `connection probe exceeded ${timeoutMs}ms`,
      });
    }, timeoutMs);
    socket.once("connect", () => finish({ kind: "reachable" }));
    socket.once("error", (error) => {
      if (errorCode(error) === "ECONNREFUSED") {
        finish({ kind: "refused" });
        return;
      }
      finish({ kind: "indeterminate", detail: String(error) });
    });
  });
}

export function listenerAllowsViteStart(result: ListenerProbeResult): boolean {
  return result.kind === "refused";
}

export function attemptDevAppSpawn<T>(
  input: Readonly<{
    readonly authorized: boolean;
    readonly shutdownSignal?: DevShutdownSignal;
    readonly viteExitCode?: number;
  }>,
  spawn: () => T,
): DevAppSpawnOutcome<T> {
  if (input.shutdownSignal !== undefined) {
    return { kind: "shutdown", signal: input.shutdownSignal };
  }
  if (input.viteExitCode !== undefined) {
    return { code: input.viteExitCode, kind: "vite-exit" };
  }
  if (!input.authorized) return { kind: "not-authorized" };

  // The final latches and spawn callback are read synchronously in one event
  // loop turn, so a delivered shutdown or Vite exit cannot cross this gate.
  return { kind: "spawned", value: spawn() };
}

export async function assertFixedDevPortAvailable(
  probe: () => Promise<ListenerProbeResult> = probeFixedDevListener,
): Promise<void> {
  const result = await probe();
  if (result.kind === "refused") return;
  const detail = result.kind === "reachable"
    ? "a listener is already reachable"
    : `listener ownership could not be disproved (${result.detail})`;
  throw new Error(
    `Refusing to start HRA development: ${detail} on ${HRA_DEV_FRONTEND_HOST}:${HRA_DEV_FRONTEND_PORT}. Stop it and retry; HRA never reuses an existing server.`,
  );
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return duration;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function readinessRetryDelay(
  now: number,
  deadline: number,
  intervalMs: number,
): number | null {
  if (now >= deadline) return null;
  return Math.min(intervalMs, deadline - now);
}

export async function waitForDevReadiness(
  options: DevReadinessWaitOptions,
): Promise<void> {
  const timeoutMs = positiveDuration(options.timeoutMs, DEFAULT_READY_TIMEOUT_MS, "timeoutMs");
  const intervalMs = positiveDuration(options.intervalMs, DEFAULT_READY_INTERVAL_MS, "intervalMs");
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const deadline = now() + timeoutMs;

  while (true) {
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new Error("HRA development readiness was cancelled.");
    }
    const outcome = await options.probe();
    if (outcome.kind === "response") {
      // Any HTTP response proves that a listener won the fixed-port race. It
      // must immediately prove ownership with the exact launch nonce.
      parseDevReadinessResponse(outcome.response, options.expectedSessionId);
      return;
    }
    const delay = readinessRetryDelay(now(), deadline, intervalMs);
    if (delay === null) {
      throw new Error(`HRA Vite readiness timed out after ${timeoutMs}ms.`);
    }
    await wait(delay);
  }
}

async function boundedResponseBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_READY_BODY_BYTES) {
        throw new Error("HRA Vite readiness exceeded its size limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export async function probeDevReadinessHttp(): Promise<ReadinessProbeResult> {
  try {
    const response = await fetch(HRA_DEV_READY_URL, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS),
    });
    return {
      kind: "response",
      response: {
        status: response.status,
        headers: {
          "cache-control": response.headers.get("cache-control") ?? undefined,
          "content-type": response.headers.get("content-type") ?? undefined,
          "x-content-type-options": response.headers.get("x-content-type-options") ?? undefined,
        },
        body: await boundedResponseBody(response),
      },
    };
  } catch {
    return { kind: "unreachable" };
  }
}
