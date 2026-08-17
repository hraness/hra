import type {
  SessionTurnLifecycle,
} from "../sessions/session-service";
import type { DispatchAccountReservationArbiter } from "../dispatch/account-reservations";
import {
  LocalCompletionBlockedByInteractionError,
  type LocalRunExecutionStore,
} from "../state/local-run-execution-store";

/**
 * Routes only an exact locally-owned account/thread/turn lifecycle. A terminal
 * callback emitted synchronously during turn/start is retained until the
 * coordinator has durably bound the turn ID.
 */
export class LocalRunCompletionAdapter {
  readonly #accounts: DispatchAccountReservationArbiter;
  readonly #pending = new Map<string, SessionTurnLifecycle>();
  readonly #store: LocalRunExecutionStore;
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(options: {
    readonly accounts: DispatchAccountReservationArbiter;
    readonly store: LocalRunExecutionStore;
  }) {
    this.#accounts = options.accounts;
    this.#store = options.store;
  }

  observe(event: SessionTurnLifecycle): void {
    if (event.status === "inProgress") return;
    const key = lifecycleKey(event);
    this.#pending.set(key, event);
    this.#start(key, event);
  }

  retryPending(): void {
    for (const [key, event] of this.#pending) this.#start(key, event);
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  hasUnsettledWork(): boolean {
    return this.#inFlight.size > 0;
  }

  #start(key: string, event: SessionTurnLifecycle): void {
    if (this.#inFlight.has(key)) return;
    const task = this.#reconcile(event)
      .then((settled) => {
        if (settled) this.#pending.delete(key);
      })
      .finally(() => {
        if (this.#inFlight.get(key) === task) this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, task);
    void task.catch(() => undefined);
  }

  async #reconcile(event: SessionTurnLifecycle): Promise<boolean> {
    const binding = this.#store.readByTurn(event);
    if (binding === null) {
      return this.#store.readTurnStartingByThread(event) === null;
    }
    if (
      binding.stage === "completed"
      || binding.stage === "failed"
      || binding.stage === "cancelled"
      || binding.stage === "lease_lost"
    ) {
      try {
        this.#store.reconcileTerminalStage(binding.runId);
      } catch {
        // A committed event may still have lost only its invalidation hint.
      }
      return this.#releaseDurable(binding.runId);
    }
    if (binding.stage === "ambiguous") return true;
    if (binding.stage !== "running" && binding.stage !== "waiting") return true;
    if (!this.#terminalLifecycleReady(binding.runId)) return false;
    if (!(await this.#store.assertCurrent({
      claimFence: binding.claimFence,
      claimId: binding.claimId,
      runId: binding.runId,
      runtimeBootId: binding.runtimeBootId,
      runtimePublicId: binding.runtimePublicId,
    }))) {
      if (!this.#terminalLifecycleReady(binding.runId)) return false;
      return this.#loseLease(binding.runId, "local_completion_fence_stale");
    }
    if (!this.#terminalLifecycleReady(binding.runId)) return false;
    switch (event.status) {
      case "completed":
        try {
          this.#store.submitCompleted(binding.runId);
        } catch (error: unknown) {
          if (error instanceof LocalCompletionBlockedByInteractionError) {
            return false;
          }
          const current = this.#store.read(binding.runId);
          if (current?.stage !== "completed") {
            return this.#loseLease(
              binding.runId,
              "local_completion_submission_rejected",
            );
          }
        }
        return this.#releaseDurable(binding.runId);
      case "failed":
        this.#store.transition({
          runId: binding.runId,
          to: "failed",
          failureCode: "codex_turn_failed",
        });
        this.#store.appendPublicEvent({
          runId: binding.runId,
          eventId: `${binding.runId}:9`,
          kind: "run.failed",
        });
        return this.#releaseDurable(binding.runId);
      case "interrupted":
        this.#store.transition({ runId: binding.runId, to: "cancelled" });
        this.#store.appendPublicEvent({
          runId: binding.runId,
          eventId: `${binding.runId}:7`,
          kind: "run.cancelled",
        });
        return this.#releaseDurable(binding.runId);
      case "inProgress":
        return true;
    }
  }

  #loseLease(runId: string, failureCode: string): boolean {
    try {
      const current = this.#store.read(runId);
      if (
        current !== null
        && current.stage !== "completed"
        && current.stage !== "failed"
        && current.stage !== "cancelled"
        && current.stage !== "lease_lost"
        && current.stage !== "ambiguous"
      ) {
        this.#store.transition({
          runId,
          to: "lease_lost",
          failureCode,
        });
        this.#store.appendPublicEvent({
          runId,
          eventId: `${runId}:8`,
          kind: "run.lease_lost",
        });
      }
    } catch {
      // A later boot recovers any binding that could not be durably settled.
    }
    return this.#releaseDurable(runId);
  }

  #releaseDurable(runId: string): boolean {
    if (!this.#store.releaseCapacity(runId)) return false;
    this.#accounts.releaseRun(runId);
    return true;
  }

  #terminalLifecycleReady(runId: string): boolean {
    try {
      this.#store.assertTerminalLifecycleReady(runId);
      return true;
    } catch (error: unknown) {
      if (error instanceof LocalCompletionBlockedByInteractionError) {
        return false;
      }
      throw error;
    }
  }
}

function lifecycleKey(event: SessionTurnLifecycle): string {
  return `${event.accountProfileId}\0${event.threadId}\0${event.turnId}`;
}
