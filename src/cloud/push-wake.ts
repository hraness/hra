import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import {
  isExpiredAccessToken,
  type AccessTokenProvider,
  type CloudQuery,
} from "./client";
import {
  cloudLimits,
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  isRecord,
} from "./contracts";

/*
 * Push wake. The daemon's poll loop sleeps for its adaptive interval or until
 * the hosted deployment reports that the pending-command set for this device
 * changed, whichever comes first. The subscription is a hint only: it never
 * carries authority, and every command it announces is still claimed, bound,
 * and settled by the ordinary cycle, so a wake that races the timer costs one
 * extra cycle and never a second execution.
 */

/** The subscribed query. Kept typed as an allowlisted cloud query on purpose. */
export const pushWakeQuery: CloudQuery = "commands:listPendingForTarget";

/** A wake only needs to notice that the set changed, not read all of it. */
export const pushWakePendingLimit = 8;

export const pushWakeInitialBackoffMs = 1_000;
export const pushWakeMaximumBackoffMs = 30_000;

const maximumRetainedDiagnostics = 8;
const maximumFingerprintEntries = 64;
const maximumFingerprintScalarLength = 128;

export type CloudPushWakeStatus = Readonly<{
  consecutiveFailures: number;
  lastWakeAt: number | null;
  state: "closed" | "failed" | "listening" | "starting";
  wakes: number;
}>;

export interface CloudPushWakePort {
  close(): Promise<void>;
  status(): CloudPushWakeStatus;
  /** Drains the diagnostics recorded since the last drain, newest last. */
  takeDiagnostics(): readonly string[];
  /**
   * Resolves when the pending-command set changed, or when `signal` aborts.
   * A change observed while nobody was waiting is latched, so a wake that
   * arrives during a cycle is not lost.
   */
  wait(signal: AbortSignal): Promise<void>;
}

export type CloudPushWakeSubscription = Readonly<{ close(): Promise<void> }>;

export type CloudPushWakeSubscriber = (handlers: Readonly<{
  /** The subscription itself failed: it is torn down and reopened with backoff. */
  onError: (error: unknown) => void;
  onResult: (value: unknown) => void;
  /** The socket dropped; the client reconnects it, so only a diagnostic is recorded. */
  onTransportError: (error: unknown) => void;
}>) => CloudPushWakeSubscription;

function boundedScalar(value: unknown): string {
  if (typeof value === "string") return value.slice(0, maximumFingerprintScalarLength);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "?";
}

/*
 * A change fingerprint over the server-visible identity of each pending
 * command. Encrypted payloads are deliberately excluded: the wake only needs
 * an edge, and a fingerprint must never depend on ciphertext the daemon has
 * not yet been authorised to decrypt.
 */
export function pendingCommandFingerprint(value: unknown): string {
  if (!Array.isArray(value)) return "invalid";
  const entries: string[] = [];
  for (const entry of (value as readonly unknown[]).slice(0, maximumFingerprintEntries)) {
    if (!isRecord(entry)) {
      entries.push("?");
      continue;
    }
    entries.push([
      boundedScalar(entry.publicId),
      boundedScalar(entry.state),
      boundedScalar(entry.updatedAt),
    ].join(":"));
  }
  entries.sort((left, right) => left.localeCompare(right));
  return `${(value as readonly unknown[]).length}|${entries.join("|")}`;
}

function normalizePushWakeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Cloud push wake failed.";
  if (
    containsAbsolutePath(message)
    || containsUnsafeTerminalScalar(message, true)
    || /(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:sk|re)_[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~-]{8,})/u
      .test(message)
  ) return "Cloud push wake failed with a redacted diagnostic.";
  return message.slice(0, 256);
}

export function pushWakeBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures < 1) return pushWakeInitialBackoffMs;
  const exponent = Math.min(consecutiveFailures - 1, 20);
  return Math.min(pushWakeMaximumBackoffMs, pushWakeInitialBackoffMs * 2 ** exponent);
}

type PushWakeWaiter = { notify(): void };

class SubscribedCloudPushWake implements CloudPushWakePort {
  readonly #now: () => number;
  readonly #subscribe: CloudPushWakeSubscriber;
  readonly #waiters = new Set<PushWakeWaiter>();
  #closed = false;
  #consecutiveFailures = 0;
  #diagnostics: string[] = [];
  #fingerprint: string | null = null;
  #lastWakeAt: number | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #signalled = false;
  #state: CloudPushWakeStatus["state"] = "starting";
  #subscription: CloudPushWakeSubscription | null = null;
  #transportWarned = false;
  #wakes = 0;

  constructor(options: Readonly<{
    lifetimeSignal?: AbortSignal;
    now?: () => number;
    subscribe: CloudPushWakeSubscriber;
  }>) {
    this.#now = options.now ?? Date.now;
    this.#subscribe = options.subscribe;
    const lifetimeSignal = options.lifetimeSignal;
    if (lifetimeSignal !== undefined) {
      if (lifetimeSignal.aborted) {
        this.#closed = true;
        this.#state = "closed";
        return;
      }
      lifetimeSignal.addEventListener("abort", () => { void this.close(); }, { once: true });
    }
    this.#open();
  }

  status(): CloudPushWakeStatus {
    return {
      consecutiveFailures: this.#consecutiveFailures,
      lastWakeAt: this.#lastWakeAt,
      state: this.#state,
      wakes: this.#wakes,
    };
  }

  takeDiagnostics(): readonly string[] {
    const drained = this.#diagnostics;
    this.#diagnostics = [];
    return drained;
  }

  wait(signal: AbortSignal): Promise<void> {
    if (this.#closed || signal.aborted) return Promise.resolve();
    if (this.#signalled) {
      this.#signalled = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiter: PushWakeWaiter = { notify: () => undefined };
      const finish = (): void => {
        this.#waiters.delete(waiter);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      waiter.notify = (): void => {
        this.#signalled = false;
        finish();
      };
      this.#waiters.add(waiter);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = "closed";
    if (this.#retry !== null) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
    const subscription = this.#subscription;
    this.#subscription = null;
    this.#release();
    if (subscription !== null) await subscription.close().catch(() => undefined);
  }

  #open(): void {
    if (this.#closed) return;
    if (this.#consecutiveFailures === 0) this.#state = "starting";
    try {
      this.#subscription = this.#subscribe({
        onError: (error: unknown) => { this.#fail(error); },
        onResult: (value: unknown) => { this.#observe(value); },
        onTransportError: (error: unknown) => { this.#warn(error); },
      });
    } catch (error: unknown) {
      this.#fail(error);
    }
  }

  #observe(value: unknown): void {
    if (this.#closed) return;
    this.#consecutiveFailures = 0;
    this.#transportWarned = false;
    this.#state = "listening";
    const fingerprint = pendingCommandFingerprint(value);
    const baseline = this.#fingerprint === null;
    const changed = this.#fingerprint !== fingerprint;
    this.#fingerprint = fingerprint;
    // The first delivery after a fresh subscription is the current state, not
    // an edge. A reconnection keeps the previous fingerprint so a change that
    // happened during an outage still wakes the loop.
    if (baseline || !changed) return;
    this.#wakes += 1;
    this.#lastWakeAt = this.#now();
    this.#signalled = true;
    this.#release();
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    const subscription = this.#subscription;
    this.#subscription = null;
    if (subscription !== null) void subscription.close().catch(() => undefined);
    if (this.#consecutiveFailures === 0) {
      // One diagnostic per failure episode. Reconnection attempts stay silent
      // so a long outage cannot flood the cycle's diagnostic list.
      this.#diagnostics.push(`push wake: ${normalizePushWakeError(error)}`);
      if (this.#diagnostics.length > maximumRetainedDiagnostics) this.#diagnostics.shift();
    }
    this.#consecutiveFailures += 1;
    this.#state = "failed";
    const delay = pushWakeBackoffMs(this.#consecutiveFailures);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#open();
    }, delay);
  }

  /*
   * A transport-level disconnect is not a subscription failure: the Convex
   * client reconnects the socket itself and replays the subscription. One
   * diagnostic per outage is recorded so the fallback to polling is visible,
   * and the socket is left alone.
   */
  #warn(error: unknown): void {
    if (this.#closed || this.#transportWarned) return;
    this.#transportWarned = true;
    this.#diagnostics.push(`push wake: ${normalizePushWakeError(error)}`);
    if (this.#diagnostics.length > maximumRetainedDiagnostics) this.#diagnostics.shift();
  }

  #release(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter.notify();
  }
}

export function createCloudPushWake(options: Readonly<{
  /** Closing this signal tears the subscription down for good. */
  lifetimeSignal?: AbortSignal;
  now?: () => number;
  subscribe: CloudPushWakeSubscriber;
}>): CloudPushWakePort {
  return new SubscribedCloudPushWake(options);
}

/*
 * The websocket subscriber. It runs the same allowlisted query as the HTTP
 * transport and presents the same bearer token from the same custody slot; an
 * expired token is withheld exactly as the HTTP transport withholds it, so the
 * query fails cleanly and the backoff reconnects once the cycle has refreshed.
 */
export function createConvexPushWakeSubscriber(input: Readonly<{
  accessToken: AccessTokenProvider;
  deploymentUrl: string;
  limit?: number;
  now?: () => number;
}>): CloudPushWakeSubscriber {
  const limit = input.limit ?? pushWakePendingLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cloudLimits.pageSize) {
    throw new Error("Cloud push wake limit is invalid.");
  }
  const now = input.now ?? Date.now;
  return ({ onError, onResult, onTransportError }) => {
    const client = new ConvexClient(input.deploymentUrl, {
      logger: false,
      onServerDisconnectError: (message: string) => { onTransportError(new Error(message)); },
      unsavedChangesWarning: false,
    });
    client.setAuth(async () => {
      const token = await input.accessToken();
      if (token === null || isExpiredAccessToken(token, now())) return null;
      return token;
    });
    const unsubscribe = client.onUpdate(
      makeFunctionReference<"query", { limit: number }, unknown>(pushWakeQuery),
      { limit },
      (value: unknown) => { onResult(value); },
      (error: Error) => { onError(error); },
    );
    return {
      async close(): Promise<void> {
        try {
          unsubscribe();
        } catch {
          // The client may already have torn the subscription down.
        }
        await client.close();
      },
    };
  };
}
