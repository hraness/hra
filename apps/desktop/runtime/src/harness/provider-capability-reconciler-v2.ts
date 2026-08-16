import { z } from "@hra-internal/schema";

import type { SessionTurnLifecycle } from "../sessions/session-service";
import type { SessionState } from "../sessions/model";

type MaybePromise<T> = T | Promise<T>;

const accountProfileIdSchema = z.string().min(1).max(96);

export interface HarnessProviderCapabilityRuntimePortV2 {
  configuredAccountProfileIds(): readonly string[];
  generation(accountProfileId: string): number | null;
  isRunning(accountProfileId: string): boolean;
  supportsDynamicTool(accountProfileId: string): boolean;
  restart(accountProfileId: string): Promise<unknown>;
  stop(accountProfileId: string): Promise<void>;
}

export interface HarnessProviderCapabilitySessionPortV2 {
  getSnapshot(): SessionState;
}

export class HarnessProviderCapabilityReconcilerV2Error extends Error {
  readonly code: "closed" | "reconciliation_failed";

  constructor(
    code: HarnessProviderCapabilityReconcilerV2Error["code"],
    cause?: unknown,
  ) {
    super(code === "closed"
      ? "Provider capability reconciliation is closed."
      : "Provider capability reconciliation failed closed.",
    cause === undefined ? undefined : { cause });
    this.name = "HarnessProviderCapabilityReconcilerV2Error";
    this.code = code;
  }
}

/**
 * Converges already-running account processes after the recursive-session
 * setting changes. New processes read the current setting at launch. Existing
 * processes restart only after Chat has drained the terminal observation and
 * SessionService proves that the account has no active execution.
 */
export class HarnessProviderCapabilityReconcilerV2 {
  readonly #runtimes: HarnessProviderCapabilityRuntimePortV2;
  readonly #sessions: HarnessProviderCapabilitySessionPortV2;
  readonly #settleChat: () => MaybePromise<void>;
  readonly #pending = new Map<string, boolean>();
  #desired: boolean;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: Readonly<{
    initialEnabled: boolean;
    runtimes: HarnessProviderCapabilityRuntimePortV2;
    sessions: HarnessProviderCapabilitySessionPortV2;
    settleChat: () => MaybePromise<void>;
  }>) {
    this.#desired = z.boolean().parse(input.initialEnabled);
    this.#runtimes = input.runtimes;
    this.#sessions = input.sessions;
    this.#settleChat = input.settleChat;
  }

  settingsChanged(enabledValue: boolean): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    const enabled = z.boolean().parse(enabledValue);
    this.#desired = enabled;
    for (const accountProfileId of this.#accountProfileIds()) {
      this.#pending.set(accountProfileId, enabled);
    }
    return this.#schedule();
  }

  /** Terminal facts are retry hints; durable Session state remains authority. */
  observe(event: SessionTurnLifecycle): void {
    if (this.#closed || event.status === "inProgress") return;
    const accountProfileId = accountProfileIdSchema.parse(
      event.accountProfileId,
    );
    this.#pending.set(accountProfileId, this.#desired);
    void this.#schedule().catch(() => undefined);
  }

  close(): void {
    this.#closed = true;
    this.#pending.clear();
  }

  settled(): Promise<void> {
    return this.#tail;
  }

  #schedule(): Promise<void> {
    const result = this.#tail.then(() => this.#drain());
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #drain(): Promise<void> {
    if (this.#closed || this.#pending.size === 0) return;
    try {
      await this.#settleChat();
      if (this.#closed) return;
      for (const [accountProfileId, desired] of [...this.#pending]) {
        if (this.#closed) return;
        if (this.#pending.get(accountProfileId) !== desired) continue;
        if (accountExecutionActive(this.#sessions.getSnapshot(), accountProfileId)) {
          continue;
        }
        if (!this.#runtimes.isRunning(accountProfileId)) {
          this.#deleteExact(accountProfileId, desired);
          continue;
        }
        if (this.#runtimes.supportsDynamicTool(accountProfileId) === desired) {
          this.#deleteExact(accountProfileId, desired);
          continue;
        }
        const generation = this.#runtimes.generation(accountProfileId);
        if (generation === null || generation < 1) {
          await this.#runtimes.stop(accountProfileId);
          this.#deleteExact(accountProfileId, desired);
          continue;
        }
        try {
          await this.#runtimes.restart(accountProfileId);
        } catch (cause: unknown) {
          await this.#stopAfterFailure(accountProfileId, cause);
          this.#deleteExact(accountProfileId, desired);
          continue;
        }
        if (
          this.#runtimes.isRunning(accountProfileId) &&
          this.#runtimes.supportsDynamicTool(accountProfileId) !== desired
        ) {
          await this.#runtimes.stop(accountProfileId);
        }
        this.#deleteExact(accountProfileId, desired);
      }
    } catch (cause: unknown) {
      throw cause instanceof HarnessProviderCapabilityReconcilerV2Error
        ? cause
        : new HarnessProviderCapabilityReconcilerV2Error(
            "reconciliation_failed",
            cause,
          );
    }
  }

  async #stopAfterFailure(
    accountProfileId: string,
    restartFailure: unknown,
  ): Promise<void> {
    try {
      await this.#runtimes.stop(accountProfileId);
    } catch (stopFailure: unknown) {
      throw new HarnessProviderCapabilityReconcilerV2Error(
        "reconciliation_failed",
        new AggregateError([restartFailure, stopFailure]),
      );
    }
  }

  #accountProfileIds(): readonly string[] {
    const parsed = z.array(accountProfileIdSchema).max(50).safeParse(
      this.#runtimes.configuredAccountProfileIds(),
    );
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
      throw new HarnessProviderCapabilityReconcilerV2Error(
        "reconciliation_failed",
      );
    }
    return parsed.data.toSorted();
  }

  #deleteExact(accountProfileId: string, desired: boolean): void {
    if (this.#pending.get(accountProfileId) === desired) {
      this.#pending.delete(accountProfileId);
    }
  }
}

function accountExecutionActive(
  state: SessionState,
  accountProfileId: string,
): boolean {
  return Object.values(state.turns).some(
    (turn) => turn.accountProfileId === accountProfileId && turn.status === "active",
  ) || Object.values(state.threads).some(
    (thread) =>
      thread.accountProfileId === accountProfileId && thread.status === "active",
  ) || Object.values(state.interactions).some(
    (interaction) =>
      interaction.accountProfileId === accountProfileId &&
      interaction.outcome === "pending",
  );
}

function closedError(): HarnessProviderCapabilityReconcilerV2Error {
  return new HarnessProviderCapabilityReconcilerV2Error("closed");
}
