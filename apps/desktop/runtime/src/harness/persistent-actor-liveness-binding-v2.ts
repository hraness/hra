import type { SessionTurnLifecycle } from "../sessions/session-service";
import type {
  PersistentActorLivenessDemandV2,
  PersistentActorLivenessWakeV2,
  PersistentActorLivenessPortV2,
  PersistentActorLivenessWakePortV2,
} from "./persistent-actor-liveness-v2";

export interface PersistentActorLivenessBindingTargetV2
  extends PersistentActorLivenessPortV2, PersistentActorLivenessWakePortV2 {
  observe(event: SessionTurnLifecycle): void;
  settled(): Promise<void>;
  close(): Promise<void>;
}

type BindingState =
  | Readonly<{ kind: "unbound" }>
  | Readonly<{
      kind: "bound";
      target: PersistentActorLivenessBindingTargetV2;
    }>
  | Readonly<{
      kind: "closed";
      target: PersistentActorLivenessBindingTargetV2 | null;
      closePromise: Promise<void>;
    }>;

export class PersistentActorLivenessBindingV2Error extends Error {
  readonly code: "already_bound" | "closed" | "not_bound";

  constructor(code: PersistentActorLivenessBindingV2Error["code"]) {
    super({
      already_bound: "Persistent actor liveness is already bound.",
      closed: "Persistent actor liveness is closed.",
      not_bound: "Persistent actor liveness is not bound.",
    }[code]);
    this.name = "PersistentActorLivenessBindingV2Error";
    this.code = code;
  }
}

/**
 * Stable bind-once seam for the coordinator's liveness cycle.
 *
 * Main may install this object into the coordinator and renderer effects before
 * Chat has recovered its panes. The real timer-owning pump is bound only after
 * that bootstrap barrier. Closing an unbound seam is a terminal no-op so an
 * initialization failure never has to construct a pump merely to tear it down.
 */
export class PersistentActorLivenessBindingV2
  implements PersistentActorLivenessBindingTargetV2 {
  #state: BindingState = Object.freeze({ kind: "unbound" });
  #globalReconciliationRequestedWhileUnbound = false;
  readonly #incarnationWakesWhileUnbound = new Set<string>();

  bind(target: PersistentActorLivenessBindingTargetV2): "bound" {
    if (this.#state.kind === "bound") {
      throw new PersistentActorLivenessBindingV2Error("already_bound");
    }
    if (this.#state.kind === "closed") {
      throw new PersistentActorLivenessBindingV2Error("closed");
    }
    this.#state = Object.freeze({ kind: "bound", target });
    if (this.#globalReconciliationRequestedWhileUnbound) {
      this.#globalReconciliationRequestedWhileUnbound = false;
      this.#incarnationWakesWhileUnbound.clear();
      target.requestReconciliation();
    } else if (this.#incarnationWakesWhileUnbound.size > 0) {
      const incarnationIds = [...this.#incarnationWakesWhileUnbound].toSorted();
      this.#incarnationWakesWhileUnbound.clear();
      target.requestReconciliation({ incarnationIds });
    }
    return "bound";
  }

  observe(event: SessionTurnLifecycle): void {
    if (this.#state.kind === "closed") throw this.#unavailableError();
    // Account hydration can publish lifecycle hints after the complete graph
    // is bound but before chat bootstrap installs the timer-owning pump. Boot
    // reconciliation reads durable actor state, so these hints are redundant;
    // dropping them avoids unwinding SessionService during startup.
    if (this.#state.kind === "unbound") return;
    this.#target().observe(event);
  }

  ensureCurrent(input: PersistentActorLivenessDemandV2 = {}): Promise<void> {
    if (this.#state.kind === "closed") {
      return Promise.reject(this.#unavailableError());
    }
    const target = this.#targetOrNull();
    return target === null
      ? Promise.reject(this.#unavailableError())
      : target.ensureCurrent(input);
  }

  requestReconciliation(input: PersistentActorLivenessWakeV2 = {}): void {
    if (this.#state.kind === "closed") return;
    if (this.#state.kind === "unbound") {
      const incarnationIds = input.incarnationIds ?? [];
      if (incarnationIds.length === 0) {
        this.#globalReconciliationRequestedWhileUnbound = true;
        this.#incarnationWakesWhileUnbound.clear();
      } else if (!this.#globalReconciliationRequestedWhileUnbound) {
        for (const incarnationId of incarnationIds) {
          this.#incarnationWakesWhileUnbound.add(incarnationId);
        }
      }
      return;
    }
    this.#state.target.requestReconciliation(input);
  }

  settled(): Promise<void> {
    const state = this.#state;
    if (state.kind === "closed") return state.closePromise;
    const target = this.#targetOrNull();
    return target === null
      ? Promise.reject(new PersistentActorLivenessBindingV2Error("not_bound"))
      : target.settled();
  }

  close(): Promise<void> {
    const state = this.#state;
    if (state.kind === "closed") return state.closePromise;
    if (state.kind === "unbound") {
      const closePromise = Promise.resolve();
      this.#state = Object.freeze({
        kind: "closed",
        target: null,
        closePromise,
      });
      return closePromise;
    }
    // Obtain the exact delegated promise before committing the terminal state.
    // A synchronous delegate failure therefore leaves the binding retryable.
    const closePromise = state.target.close();
    this.#state = Object.freeze({
      kind: "closed",
      target: state.target,
      closePromise,
    });
    return closePromise;
  }

  #target(): PersistentActorLivenessBindingTargetV2 {
    const target = this.#targetOrNull();
    if (target !== null) return target;
    throw this.#unavailableError();
  }

  #targetOrNull(): PersistentActorLivenessBindingTargetV2 | null {
    return this.#state.kind === "bound"
      ? this.#state.target
      : null;
  }

  #unavailableError(): PersistentActorLivenessBindingV2Error {
    return new PersistentActorLivenessBindingV2Error(
      this.#state.kind === "closed" ? "closed" : "not_bound",
    );
  }
}
