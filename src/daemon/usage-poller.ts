import { createHash } from "node:crypto";

export const USAGE_POLL_MIN_INTERVAL_MS = 50_000;
export const USAGE_POLL_MAX_INTERVAL_MS = 70_000;
export const USAGE_POLL_BACKOFF_MAX_MS = 15 * 60_000;
export const USAGE_POLL_INITIAL_STAGGER_MAX_MS = 20_000;

const stableOffset = (accountId: string, range: number): number => {
  const digest = createHash("sha256").update(accountId).digest();
  return digest.readUInt32BE(0) % range;
};

export const usagePollInterval = (accountId: string): number =>
  USAGE_POLL_MIN_INTERVAL_MS
  + stableOffset(accountId, USAGE_POLL_MAX_INTERVAL_MS - USAGE_POLL_MIN_INTERVAL_MS + 1);

export const usagePollInitialStagger = (accountId: string): number =>
  stableOffset(`initial:${accountId}`, USAGE_POLL_INITIAL_STAGGER_MAX_MS + 1);

export const sleepForUsagePolling = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(resolve), milliseconds);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
};

type PollState = {
  failures: number;
  nextAt: number;
};

export class AccountUsagePoller {
  readonly #listAccountIds: () => readonly string[];
  readonly #poll: (accountId: string, signal: AbortSignal) => Promise<void>;
  readonly #onFailure: (accountId: string, error: unknown, failures: number) => void | Promise<void>;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #states = new Map<string, PollState>();
  readonly #controller = new AbortController();
  #task: Promise<void> | undefined;

  constructor(input: {
    listAccountIds: () => readonly string[];
    poll: (accountId: string, signal: AbortSignal) => Promise<void>;
    onFailure?: (accountId: string, error: unknown, failures: number) => void | Promise<void>;
    now?: () => number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  }) {
    this.#listAccountIds = input.listAccountIds;
    this.#poll = input.poll;
    this.#onFailure = input.onFailure ?? (() => undefined);
    this.#now = input.now ?? Date.now;
    this.#sleep = input.sleep ?? sleepForUsagePolling;
  }

  start(): void {
    if (this.#task !== undefined) return;
    this.#task = this.#run();
  }

  async close(): Promise<void> {
    this.#controller.abort(new Error("Account usage poller stopped."));
    await this.#task?.catch((error: unknown) => {
      if (!this.#controller.signal.aborted) throw error;
    });
  }

  async tick(signal: AbortSignal = this.#controller.signal): Promise<number> {
    if (signal.aborted) throw signal.reason;
    const now = this.#now();
    const accountIds = [...new Set(this.#listAccountIds())].sort();
    const current = new Set(accountIds);
    for (const accountId of this.#states.keys()) {
      if (!current.has(accountId)) this.#states.delete(accountId);
    }
    for (const accountId of accountIds) {
      if (!this.#states.has(accountId)) {
        this.#states.set(accountId, { failures: 0, nextAt: now + usagePollInitialStagger(accountId) });
      }
    }
    const due = accountIds
      .map((accountId) => ({ accountId, state: this.#states.get(accountId) }))
      .filter((entry): entry is { accountId: string; state: PollState } => entry.state !== undefined)
      .sort((left, right) => left.state.nextAt - right.state.nextAt || left.accountId.localeCompare(right.accountId));
    const selected = due[0];
    if (selected === undefined) return 1_000;
    if (selected.state.nextAt > now) return Math.max(1, Math.min(1_000, selected.state.nextAt - now));

    try {
      await this.#poll(selected.accountId, signal);
      selected.state.failures = 0;
      selected.state.nextAt = this.#now() + usagePollInterval(selected.accountId);
    } catch (error: unknown) {
      signal.throwIfAborted();
      selected.state.failures += 1;
      const base = usagePollInterval(selected.accountId);
      const multiplier = Math.min(2 ** selected.state.failures, 16);
      selected.state.nextAt = this.#now() + Math.min(base * multiplier, USAGE_POLL_BACKOFF_MAX_MS);
      await this.#onFailure(selected.accountId, error, selected.state.failures);
    }
    return 0;
  }

  async #run(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      const waitMs = await this.tick(this.#controller.signal);
      if (waitMs > 0) await this.#sleep(waitMs, this.#controller.signal);
    }
  }
}
