import type {
  DispatchBinding,
  DispatchStore,
} from "../state/dispatch-store";
import type { LocalDispatchCapabilities } from "./local-capabilities";
import {
  canTransitionDispatch,
  terminalDispatchStages,
  type DispatchStage,
  type PublicRunEventKind,
} from "./model";
import type {
  DispatchRevocationPort,
  DispatchRevocationReason,
} from "./runner";

export interface DispatchRevocationStore {
  read(runId: string): DispatchBinding | null;
  transition(input: {
    readonly runId: string;
    readonly to: DispatchStage;
    readonly failureCode?: string;
  }): DispatchBinding;
  appendPublicEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunEventKind;
  }): unknown;
  failAfterProvenInteractionStop?(input: {
    readonly runId: string;
    readonly failureCode: string;
    readonly eventId: string;
  }): boolean;
  reconcileTerminalStage?(runId: string): void;
}

export interface DispatchSessionRevocationPort {
  interruptGatewayThread(threadId: string): Promise<"idle" | "interrupted">;
  stopGatewayAccount?(accountProfileId: string): Promise<void>;
}

export interface DispatchCapacityReleasePort {
  releaseRun(runId: string): unknown;
}

/**
 * Converts a cloud lease or stop revocation into one durable local outcome.
 * A user stop is reported as cancelled only after the coordinator can prove
 * that no turn exists or that the bound turn is idle/interrupted. Otherwise
 * the run stays ambiguous locally and is surfaced as lease-lost remotely.
 */
export class DispatchRevocationCoordinator implements DispatchRevocationPort {
  readonly #capabilities: DispatchCapacityReleasePort;
  readonly #sessions: DispatchSessionRevocationPort;
  readonly #store: DispatchRevocationStore;

  constructor(options: {
    readonly capabilities: DispatchCapacityReleasePort;
    readonly sessions: DispatchSessionRevocationPort;
    readonly store: DispatchRevocationStore;
  }) {
    this.#capabilities = options.capabilities;
    this.#sessions = options.sessions;
    this.#store = options.store;
  }

  async revoke(runId: string, reason: DispatchRevocationReason): Promise<void> {
    const initial = this.#store.read(runId);
    if (initial === null) {
      this.#capabilities.releaseRun(runId);
      return;
    }

    const stopped = await this.#stopLocally(initial);
    const current = this.#store.read(runId);
    if (current === null) return;
    if (terminalDispatchStages.has(current.stage)) {
      try {
        this.#store.reconcileTerminalStage?.(runId);
      } catch {
        // A terminal event can commit before its invalidation hint throws.
        // The caller's durable release proof decides whether this is releasable.
      }
      // Locally-authored terminal state is not cloud-terminal proof. Its slot
      // remains retained until the runner durably publishes and acknowledges
      // the terminal outbox event. A cloud-terminal heartbeat is the one
      // exception because the server has already retired the run.
      if (reason === "cloud_terminal" && stopped) {
        this.#capabilities.releaseRun(runId);
      }
      return;
    }

    if (reason === "cloud_terminal") {
      // The cloud has already reached a terminal state. Stop and retire local
      // work without publishing a competing terminal event. If interruption
      // is ambiguous, preserve the slot so a later release heartbeat retries.
      this.#transitionIfAllowed(current, stopped ? "lease_lost" : "ambiguous");
      if (stopped) this.#capabilities.releaseRun(runId);
      return;
    }

    if (reason === "stop_requested" && stopped) {
      this.#transitionIfAllowed(current, "cancelled");
      this.#event(runId, 7, "run.cancelled");
      return;
    }

    if (
      (reason === "interaction_limit" ||
        reason === "interaction_resolution_ambiguous" ||
        reason === "invalid_interaction_response") &&
      stopped
    ) {
      if (this.#store.failAfterProvenInteractionStop !== undefined) {
        try {
          if (this.#store.failAfterProvenInteractionStop({
            runId,
            failureCode: reason,
            eventId: `${runId}:9`,
          })) return;
        } catch (error: unknown) {
          // A post-commit invalidation can throw after the whole terminal
          // outcome is durable. Preserve its slot so an exact retry performs
          // the release instead of rewriting that terminal as ambiguous.
          if (this.#store.read(runId)?.stage === "failed") throw error;
          this.#retainAmbiguous(runId);
          return;
        }
        this.#retainAmbiguous(runId);
        return;
      }
      if (canTransitionDispatch(current.stage, "failed")) {
        this.#store.transition({
          runId,
          to: "failed",
          failureCode: reason,
        });
      }
      this.#event(runId, 9, "run.failed");
      return;
    }

    const unresolvedMutation =
      reason === "stop_requested"
      || reason === "interaction_limit"
      || reason === "interaction_resolution_ambiguous"
      || reason === "invalid_interaction_response";
    if (
      unresolvedMutation
      && canTransitionDispatch(current.stage, "ambiguous")
    ) {
      this.#store.transition({ runId, to: "ambiguous" });
    } else {
      this.#transitionIfAllowed(current, "lease_lost");
    }
    this.#event(runId, 8, "run.lease_lost");
  }

  async #stopLocally(binding: DispatchBinding): Promise<boolean> {
    if (binding.stage === "reserved" || binding.stage === "worktree_ready") return true;
    if (binding.threadId !== null) {
      try {
        await this.#sessions.interruptGatewayThread(binding.threadId);
        return true;
      } catch {
        // A gateway restart can lose the in-memory owned-thread projection.
        // Fall through to stopping this account's isolated app-server.
      }
    }
    if (
      binding.accountProfileId !== null &&
      this.#sessions.stopGatewayAccount !== undefined
    ) {
      try {
        await this.#sessions.stopGatewayAccount(binding.accountProfileId);
        return true;
      } catch {
        // Preserve capacity when neither exact interruption nor isolated
        // process shutdown can prove the turn stopped.
      }
    }
    return false;
  }

  #transitionIfAllowed(binding: DispatchBinding, to: DispatchStage): void {
    if (binding.stage === to || terminalDispatchStages.has(binding.stage)) return;
    if (canTransitionDispatch(binding.stage, to)) {
      this.#store.transition({ runId: binding.runId, to });
    }
  }

  #retainAmbiguous(runId: string): void {
    const current = this.#store.read(runId);
    if (current === null || terminalDispatchStages.has(current.stage)) return;
    if (canTransitionDispatch(current.stage, "ambiguous")) {
      this.#store.transition({ runId, to: "ambiguous" });
    } else if (current.stage !== "ambiguous") {
      this.#transitionIfAllowed(current, "lease_lost");
    }
    this.#event(runId, 8, "run.lease_lost");
  }

  #event(runId: string, ordinal: number, kind: PublicRunEventKind): void {
    this.#store.appendPublicEvent({
      runId,
      eventId: `${runId}:${String(ordinal)}`,
      kind,
    });
  }
}

export function createDispatchRevocationCoordinator(options: {
  readonly capabilities: LocalDispatchCapabilities;
  readonly sessions: DispatchSessionRevocationPort;
  readonly store: DispatchStore;
}): DispatchRevocationCoordinator {
  return new DispatchRevocationCoordinator(options);
}
