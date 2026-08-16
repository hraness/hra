import { z } from "@hra-internal/schema";

import {
  chatPaneIdSchema,
  type ChatPaneProjection,
} from "../../../contracts/runtime";
import { actorIdSchema } from "./actor-domain";
import type {
  PersistentActorLivenessBindingTargetV2,
} from "./persistent-actor-liveness-binding-v2";
import type {
  HarnessRootProjectionReconcilerV2,
} from "./root-session-lifecycle-v2";

type MaybePromise<Value> = Value | Promise<Value>;

const witnessSchema = z.object({
  actorId: actorIdSchema,
  revision: z.number().int().positive().safe(),
  semanticDigest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const reconciliationInputSchema = z.object({
  actorId: actorIdSchema,
  paneId: chatPaneIdSchema,
}).strict();

export interface HarnessBootProjectionWitnessAuthorityV2 {
  synchronizeProjectionWitness(actorId: string): MaybePromise<unknown>;
}

export interface HarnessReadyActorProjectionReconcilerV2 {
  reconcileActor(actorId: string): MaybePromise<unknown>;
}

export interface HarnessChatBootstrapSourceV2 {
  initialize(): readonly ChatPaneProjection[];
}

export interface HarnessChatBootstrapProjectionV2 {
  installBootstrapChatState(
    panes: readonly ChatPaneProjection[],
  ): "installed";
}

export interface HarnessChatBootstrapLivenessBindingV2 {
  bind(target: PersistentActorLivenessBindingTargetV2): "bound";
}

type State =
  | "awaitingChat"
  | "recoveringChat"
  | "chatReady"
  | "activatingLiveness"
  | "ready"
  | "failed";

export class HarnessBootAwareRootProjectionV2Error extends Error {
  readonly code: "corrupt_state" | "invalid_state" | "recovery_failed";

  constructor(
    code: HarnessBootAwareRootProjectionV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessBootAwareRootProjectionV2Error";
    this.code = code;
  }
}

/**
 * Prevents root recovery from refreshing renderer panes before ChatService has
 * installed its bootstrap projection. Durable witnesses still converge first;
 * the lifecycle's later all-actor reconciliation performs the first refresh.
 */
export class HarnessBootAwareRootProjectionV2
  implements HarnessRootProjectionReconcilerV2 {
  readonly #authority: HarnessBootProjectionWitnessAuthorityV2;
  readonly #reconciler: HarnessReadyActorProjectionReconcilerV2;
  readonly #chat: HarnessChatBootstrapSourceV2;
  readonly #projection: HarnessChatBootstrapProjectionV2;
  readonly #liveness: HarnessChatBootstrapLivenessBindingV2;
  readonly #createLiveness: () => PersistentActorLivenessBindingTargetV2;
  #state: State = "awaitingChat";

  constructor(input: Readonly<{
    authority: HarnessBootProjectionWitnessAuthorityV2;
    reconciler: HarnessReadyActorProjectionReconcilerV2;
    chat: HarnessChatBootstrapSourceV2;
    projection: HarnessChatBootstrapProjectionV2;
    liveness: HarnessChatBootstrapLivenessBindingV2;
    createLiveness: () => PersistentActorLivenessBindingTargetV2;
  }>) {
    this.#authority = input.authority;
    this.#reconciler = input.reconciler;
    this.#chat = input.chat;
    this.#projection = input.projection;
    this.#liveness = input.liveness;
    this.#createLiveness = input.createLiveness;
  }

  get ready(): boolean {
    return this.#state === "ready";
  }

  async reconcile(inputValue: Readonly<{
    actorId: string;
    paneId: string;
  }>): Promise<void> {
    const input = reconciliationInputSchema.parse(inputValue);
    if (this.#state === "failed") {
      throw new HarnessBootAwareRootProjectionV2Error(
        "invalid_state",
        "root projection recovery is permanently unavailable",
      );
    }
    const value = this.#state === "chatReady" ||
        this.#state === "activatingLiveness" || this.#state === "ready"
      ? await this.#reconciler.reconcileActor(input.actorId)
      : await this.#authority.synchronizeProjectionWitness(input.actorId);
    const witness = parseWitness(value);
    if (witness.actorId !== input.actorId) {
      throw new HarnessBootAwareRootProjectionV2Error(
        "corrupt_state",
        "root projection witness belongs to another actor",
      );
    }
  }

  recoverInterruptedAfterRootRecovery(): Promise<unknown> {
    if (this.#state !== "awaitingChat") {
      return Promise.reject(new HarnessBootAwareRootProjectionV2Error(
        "invalid_state",
        "chat bootstrap recovery may run exactly once",
      ));
    }
    this.#state = "recoveringChat";
    try {
      const panes = this.#chat.initialize();
      if (this.#projection.installBootstrapChatState(panes) !== "installed") {
        throw new HarnessBootAwareRootProjectionV2Error(
          "corrupt_state",
          "chat bootstrap projection did not confirm installation",
        );
      }
      // The timer-owning liveness pump remains absent until durable actor
      // sessions and actor effects have both completed their serialized boot
      // reconciliation. Starting it here could race stale generation state.
      this.#state = "chatReady";
      return Promise.resolve(panes);
    } catch (cause: unknown) {
      this.#state = "failed";
      return Promise.reject(new HarnessBootAwareRootProjectionV2Error(
        "recovery_failed",
        "chat bootstrap recovery failed before renderer projection was ready",
        cause,
      ));
    }
  }

  /** Starts periodic liveness only after actor-session/effect recovery. */
  activateLiveness(): Promise<void> {
    if (this.#state !== "chatReady") {
      return Promise.reject(new HarnessBootAwareRootProjectionV2Error(
        "invalid_state",
        "persistent actor liveness may activate exactly once after chat recovery",
      ));
    }
    this.#state = "activatingLiveness";
    let liveness: PersistentActorLivenessBindingTargetV2 | null = null;
    try {
      liveness = this.#createLiveness();
      if (this.#liveness.bind(liveness) !== "bound") {
        throw new HarnessBootAwareRootProjectionV2Error(
          "corrupt_state",
          "persistent actor liveness did not confirm binding",
        );
      }
      this.#state = "ready";
      return Promise.resolve();
    } catch (cause: unknown) {
      this.#state = "failed";
      const failure = new HarnessBootAwareRootProjectionV2Error(
        "recovery_failed",
        "persistent actor liveness activation failed after actor recovery",
        cause,
      );
      if (liveness === null) return Promise.reject(failure);
      try {
        return liveness.close().then(
          () => Promise.reject(failure),
          (closeCause: unknown) => Promise.reject(
            new HarnessBootAwareRootProjectionV2Error(
              "recovery_failed",
              "liveness activation and orphan cleanup both failed",
              new AggregateError([cause, closeCause]),
            ),
          ),
        );
      } catch (closeCause: unknown) {
        return Promise.reject(new HarnessBootAwareRootProjectionV2Error(
          "recovery_failed",
          "liveness activation and orphan cleanup both failed",
          new AggregateError([cause, closeCause]),
        ));
      }
    }
  }
}

function parseWitness(value: unknown): z.infer<typeof witnessSchema> {
  try {
    return witnessSchema.parse(value);
  } catch (cause: unknown) {
    throw new HarnessBootAwareRootProjectionV2Error(
      "corrupt_state",
      "projection authority returned an invalid witness",
      cause,
    );
  }
}
