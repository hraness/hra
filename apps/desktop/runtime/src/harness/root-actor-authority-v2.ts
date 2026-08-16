import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  chatPaneIdSchema,
  chatTurnIdSchema,
} from "../../../contracts/runtime";
import {
  actorBudgetSchema,
  actorEpochSchema,
  actorIdSchema,
  actorSchema,
  actorTurnIdSchema,
  actorTurnSchema,
  isTerminalActorTurnState,
  type Actor,
  type ActorEpoch,
  type ActorTurn,
} from "./actor-domain";
import {
  contextValueIdSchema,
  recursiveBudgetSchema,
} from "./domain";
import {
  HarnessSQLiteAuthorityV2,
  type ActorPaneBinding,
} from "./sqlite-authority-v2";

const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);
const gatewayIdSchema = z.string().min(1).max(512)
  .refine((value) => !value.includes("\0"), "gateway identity contains NUL");
const titleSchema = z.string().min(1).max(160).refine(
  (value) => value === value.trim() && !value.includes("\0"),
  "root actor title must be trimmed and NUL-free",
);

const preparationSchema = z.object({
  projectId: z.string().min(1).max(128),
  sourceSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
  paneId: chatPaneIdSchema,
  chatTurnId: chatTurnIdSchema,
  title: titleSchema,
  budget: recursiveBudgetSchema,
  createdAt: timestampSchema.optional(),
}).strict();

const admissionSchema = preparationSchema.extend({
  inputValueId: contextValueIdSchema,
}).strict();

const providerCallerSchema = z.object({
  accountProfileId: z.string().min(1).max(96),
  processGeneration: z.number().int().positive().safe(),
  providerThreadId: gatewayIdSchema,
  providerTurnId: gatewayIdSchema,
}).strict();

const rootCallerSchema = z.object({
  projectId: z.string().min(1).max(128),
  gatewayThreadId: gatewayIdSchema,
  gatewayTurnId: gatewayIdSchema,
}).strict();

const rootPaneCandidateSchema = z.object({
  pane_id: chatPaneIdSchema,
  active_turn_id: chatTurnIdSchema,
  canonical_repository_path: z.string().min(1).max(4_096),
}).strict();
const rootRecoveryRowSchema = z.object({
  turn_id: actorTurnIdSchema,
  root_turn_state: z.enum(["prepared", "starting", "running", "reconciling"]),
  binding_id: z.string().min(16).max(96).nullable(),
  pane_id: chatPaneIdSchema.nullable(),
  active_turn_id: chatTurnIdSchema.nullable(),
  interaction_mode: z.enum(["chat", "harnessObserver"]).nullable(),
  pane_state: z.enum([
    "ready",
    "starting",
    "streaming",
    "continuing",
    "attention",
  ]).nullable(),
  chat_turn_status: z.enum([
    "starting",
    "streaming",
    "continuing",
    "completed",
    "failed",
  ]).nullable(),
  turn_completed_at: timestampSchema.nullable(),
  provider_turn_started: z.union([z.literal(0), z.literal(1)]),
}).strict();

const ROOT_RECOVERY_LIMIT = 64;

export interface HarnessRootActorAdmissionV2 {
  readonly epoch: ActorEpoch;
  readonly actor: Actor;
  readonly turn: ActorTurn;
  readonly paneBinding: ActorPaneBinding;
}

export interface HarnessRootActorPreparationV2 {
  readonly epoch: ActorEpoch;
  readonly actor: Actor;
  readonly paneBinding: ActorPaneBinding;
  readonly plannedTurnId: string;
}

export interface HarnessStableActorCallerV2 {
  readonly epoch: ActorEpoch;
  readonly actor: Actor;
  readonly turn: ActorTurn;
  readonly completedThroughTurnId: string | null;
}

export interface HarnessRootActorTurnV2 extends HarnessStableActorCallerV2 {
  readonly paneBinding: ActorPaneBinding;
}

export interface HarnessRootActorRecoveryV2 {
  readonly actorId: string;
  readonly paneId: string;
  readonly turnId: string;
  readonly disposition:
    | "active_after_provider_start"
    | "active_before_provider_start"
    | "completed";
}

export class HarnessRootActorAuthorityV2Error extends Error {
  readonly code:
    | "conflict"
    | "corrupt_state"
    | "invalid_state"
    | "not_found";

  constructor(
    code: HarnessRootActorAuthorityV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessRootActorAuthorityV2Error";
    this.code = code;
  }
}

/**
 * Establishes the stable logical root behind an ordinary chat turn and maps
 * nested provider calls back to their durable actor attempt. Provider
 * identities are accepted only as lookup keys and never enter returned caller
 * identity or RLM admission state.
 */
export class HarnessRootActorAuthorityV2 {
  readonly #database: Database;
  readonly #actors: HarnessSQLiteAuthorityV2;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: Readonly<{
      actors?: HarnessSQLiteAuthorityV2;
      now?: () => Date;
    }> = {},
  ) {
    this.#database = database;
    this.#actors = options.actors ?? new HarnessSQLiteAuthorityV2(database);
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Phase one of root admission. This durable, idempotent phase must complete
   * before the encrypted current-input value is published because values are
   * foreign-keyed to their stable epoch and actor. A crash after this phase
   * leaves only a replayable active root and pane attachment.
   */
  prepareRoot(inputValue: unknown): HarnessRootActorPreparationV2 {
    const input = preparationSchema.parse(inputValue);
    const createdAt = input.createdAt ?? this.#now().toISOString();
    const identities = deriveRootIdentities(input);
    const actorBudget = deriveActorBudget(input.budget);

    try {
      return this.#database.transaction(() => {
        const previouslyAttached = this.#actors.readActorForPane(input.paneId);
        const { epoch, actor } = this.#ensureRoot({
          epochId: identities.epochId,
          actorId: identities.actorId,
          projectId: input.projectId,
          sourceSha: input.sourceSha,
          title: input.title,
          budget: actorBudget,
          createdAt,
        });
        let paneBinding: ActorPaneBinding;
        if (previouslyAttached === null || previouslyAttached.id === actor.id) {
          paneBinding = this.#actors.attachActorPaneInTransaction({
            bindingId: deriveActorPaneBindingId(actor.id),
            actorId: actor.id,
            paneId: input.paneId,
            attachedAt: createdAt,
          });
        } else {
          const previousEpoch = this.#actors.readActorEpoch(
            previouslyAttached.epochId,
          );
          const previousBinding = this.#actors.readPaneBindingForActor(
            previouslyAttached.id,
          );
          if (
            previousEpoch === null || previousBinding === null ||
            previouslyAttached.parentActorId !== null ||
            previousEpoch.rootActorId !== previouslyAttached.id ||
            previousEpoch.projectId !== input.projectId ||
            previousBinding.paneId !== input.paneId ||
            previousBinding.state !== "attached"
          ) corrupt("the pane's previous root lineage is incoherent");
          paneBinding = this.#actors.replaceActorPaneInTransaction({
            paneId: input.paneId,
            expectedBindingId: previousBinding.id,
            expectedBindingRevision: previousBinding.revision,
            nextBindingId: deriveActorPaneBindingId(actor.id),
            nextActorId: actor.id,
            changedAt: createdAt,
          }).current;
        }
        if (paneBinding.state !== "attached") {
          invalidState("root actor pane binding is no longer attached");
        }
        return Object.freeze({
          epoch,
          actor,
          paneBinding,
          plannedTurnId: identities.turnId,
        });
      })();
    } catch (cause: unknown) {
      if (cause instanceof HarnessRootActorAuthorityV2Error) throw cause;
      throw new HarnessRootActorAuthorityV2Error(
        "conflict",
        "root actor preparation conflicts with durable authority",
        cause,
      );
    }
  }

  /**
   * Phase two of root admission. The caller first completes `prepareRoot`,
   * then durably activates the encrypted current-input value. This phase
   * refuses to create a missing root as a side effect.
   */
  admitRoot(inputValue: unknown): HarnessRootActorAdmissionV2 {
    const input = admissionSchema.parse(inputValue);
    const createdAt = input.createdAt ?? this.#now().toISOString();
    const identities = deriveRootIdentities(input);
    const actorBudget = deriveActorBudget(input.budget);

    try {
      return this.#database.transaction(() => {
        const { epoch, actor } = this.#requirePreparedRoot({
          epochId: identities.epochId,
          actorId: identities.actorId,
          projectId: input.projectId,
          sourceSha: input.sourceSha,
          budget: actorBudget,
        });
        const paneBinding = this.#actors.readActorPaneBinding(
          deriveActorPaneBindingId(actor.id),
        );
        if (
          paneBinding === null || paneBinding.actorId !== actor.id ||
          paneBinding.paneId !== input.paneId || paneBinding.state !== "attached"
        ) {
          invalidState("root actor pane preparation is absent or stale");
        }
        const turn = this.#ensureRunningRootTurn({
          turnId: identities.turnId,
          epochId: epoch.id,
          actorId: actor.id,
          inputValueId: input.inputValueId,
          idempotencyKey: deriveRootTurnIdempotencyKey(
            epoch.id,
            input.chatTurnId,
          ),
          createdAt,
        });
        const currentActor = this.#actors.readActor(actor.id);
        if (currentActor === null) corrupt("root actor disappeared during admission");
        return Object.freeze({ epoch, actor: currentActor, turn, paneBinding });
      })();
    } catch (cause: unknown) {
      if (cause instanceof HarnessRootActorAuthorityV2Error) throw cause;
      throw new HarnessRootActorAuthorityV2Error(
        "conflict",
        "root actor admission conflicts with durable authority",
        cause,
      );
    }
  }

  resolveNestedCaller(inputValue: unknown): HarnessStableActorCallerV2 | null {
    const input = providerCallerSchema.parse(inputValue);
    const observation = this.#actors.resolveActorAttemptObservation({
      accountProfileId: input.accountProfileId,
      observationGeneration: input.processGeneration,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
    });
    if (observation === null) return null;
    const { attempt } = observation;
    if (attempt === null || attempt.state !== "running") return null;
    const incarnation = this.#actors.readActorIncarnation(attempt.incarnationId);
    const turn = this.#actors.readActorTurn(attempt.turnId);
    if (incarnation === null || turn === null) corrupt("nested caller lineage is absent");
    const actor = this.#actors.readActor(turn.actorId);
    if (actor === null) corrupt("nested caller actor is absent");
    const epoch = this.#actors.readActorEpoch(actor.epochId);
    if (epoch === null) corrupt("nested caller epoch is absent");
    if (
      incarnation.actorId !== actor.id ||
      incarnation.accountProfileId !== input.accountProfileId ||
      incarnation.processGeneration !== observation.admissionGeneration ||
      incarnation.providerThreadId !== input.providerThreadId ||
      (incarnation.state !== "running" && incarnation.state !== "idle") ||
      attempt.accountProfileId !== input.accountProfileId ||
      attempt.processGeneration !== observation.admissionGeneration ||
      attempt.effectGeneration === null ||
      attempt.effectGeneration !== observation.effectGeneration ||
      attempt.effectGeneration > input.processGeneration ||
      observation.currentObservationGeneration !== input.processGeneration ||
      attempt.providerTurnId !== input.providerTurnId ||
      turn.state !== "running" ||
      turn.epochId !== epoch.id ||
      actor.state !== "active" ||
      epoch.state !== "active"
    ) return null;
    return Object.freeze({
      epoch,
      actor,
      turn,
      completedThroughTurnId:
        this.#actors.readActorCompletedThroughTurnId(turn.id),
    });
  }

  /**
   * Resolves an ordinary live chat turn to its provider-neutral root caller.
   * The legacy SQLite provider columns store gateway-owned session identity.
   * They locate the current pane only; the pane and its stable chat turn derive
   * every returned durable identity.
   */
  resolveRootCaller(inputValue: unknown): HarnessStableActorCallerV2 | null {
    const input = rootCallerSchema.parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT pane.pane_id, pane.active_turn_id,
        repository.canonical_repository_path
      FROM chat_panes AS pane
      JOIN local_repositories AS repository
        ON repository.repository_id = pane.repository_id
      WHERE pane.provider_thread_id = ?1
        AND pane.active_provider_turn_id = ?2
        AND pane.interaction_mode = 'chat'
        AND pane.state IN ('starting', 'streaming', 'continuing')
        AND pane.turn_status IN ('starting', 'streaming', 'continuing')
        AND repository.tombstoned_at IS NULL
      ORDER BY pane.pane_id LIMIT 2
    `).all(input.gatewayThreadId, input.gatewayTurnId);
    let panes: readonly z.infer<typeof rootPaneCandidateSchema>[];
    try {
      panes = z.array(rootPaneCandidateSchema).max(2).parse(rows);
    } catch (cause: unknown) {
      throw new HarnessRootActorAuthorityV2Error(
        "corrupt_state",
        "root caller pane lookup returned invalid state",
        cause,
      );
    }
    if (panes.length > 1) {
      corrupt("multiple active chat panes claim one gateway root turn");
    }
    const pane = panes[0];
    if (pane === undefined) return null;
    if (
      deriveSessionProjectIdForCanonicalPath(pane.canonical_repository_path) !==
        input.projectId
    ) return null;

    const actor = this.#actors.readActorForPane(pane.pane_id);
    if (
      actor === null || actor.parentActorId !== null || actor.depth !== 0 ||
      actor.state !== "active"
    ) return null;
    const paneBinding = this.#actors.readPaneBindingForActor(actor.id);
    const epoch = this.#actors.readActorEpoch(actor.epochId);
    if (
      paneBinding === null || paneBinding.paneId !== pane.pane_id ||
      paneBinding.actorId !== actor.id || paneBinding.state !== "attached" ||
      epoch === null ||
      epoch.rootActorId !== actor.id || epoch.state !== "active"
    ) return null;

    const expectedEpochId = deriveRootEpochId({
      projectId: epoch.projectId,
      sourceSha: epoch.sourceSha,
      paneId: pane.pane_id,
    });
    const expectedActorId = deriveRootActorId(expectedEpochId);
    const expectedTurnId = deriveRootActorTurnId(
      expectedEpochId,
      pane.active_turn_id,
    );
    if (
      epoch.id !== expectedEpochId || actor.id !== expectedActorId ||
      actor.epochId !== epoch.id
    ) return null;
    const turn = this.#actors.readActorTurn(expectedTurnId);
    if (
      turn === null || turn.epochId !== epoch.id || turn.actorId !== actor.id ||
      turn.state !== "running" || turn.desiredState !== "run"
    ) return null;
    return Object.freeze({
      epoch,
      actor,
      turn,
      completedThroughTurnId:
        this.#actors.readActorCompletedThroughTurnId(turn.id),
    });
  }

  /**
   * Reads one stable root turn together with its exact live pane attachment.
   * Provider identities are intentionally absent. A partial lineage is
   * corruption rather than evidence that a terminal notification may settle.
   */
  readRootTurn(turnIdValue: unknown): HarnessRootActorTurnV2 | null {
    const turnId = actorTurnIdSchema.parse(turnIdValue);
    const turn = this.#actors.readActorTurn(turnId);
    if (turn === null) return null;
    const actor = this.#actors.readActor(turn.actorId);
    if (actor === null) corrupt("root actor turn has no actor");
    if (actor.parentActorId !== null) {
      invalidState("only a root actor turn may be read through this authority");
    }
    const epoch = this.#actors.readActorEpoch(actor.epochId);
    const paneBinding = this.#actors.readPaneBindingForActor(actor.id);
    if (epoch === null || paneBinding === null) {
      corrupt("root actor turn lineage or pane attachment is absent");
    }
    if (
      turn.epochId !== epoch.id || epoch.rootActorId !== actor.id ||
      paneBinding.actorId !== actor.id || paneBinding.state !== "attached"
    ) corrupt("root actor turn lineage is inconsistent");
    return Object.freeze({
      epoch,
      actor,
      turn,
      paneBinding,
      completedThroughTurnId:
        this.#actors.readActorCompletedThroughTurnId(turn.id),
    });
  }

  /**
   * Enumerates the bounded provider-neutral root work that survived a gateway
   * restart. The query never selects prompt, response, reasoning, provider,
   * account, repository-path, or context bytes. Every row is joined back to
   * its one attached pane and exact stable chat turn before it can be returned.
   */
  listLiveRootTurnsForRecovery(): readonly HarnessRootActorRecoveryV2[] {
    let rows: readonly z.infer<typeof rootRecoveryRowSchema>[];
    try {
      const values: unknown[] = this.#database.query(`
        SELECT turn.turn_id, turn.state AS root_turn_state,
          binding.binding_id, binding.pane_id, pane.active_turn_id,
          pane.interaction_mode, pane.state AS pane_state,
          pane.turn_status AS chat_turn_status, pane.turn_completed_at,
          CASE WHEN pane.active_provider_turn_id IS NULL THEN 0 ELSE 1 END
            AS provider_turn_started
        FROM harness_actor_turns AS turn
        JOIN harness_actors AS actor ON actor.actor_id = turn.actor_id
          AND actor.parent_actor_id IS NULL
        LEFT JOIN harness_actor_pane_bindings AS binding
          ON binding.actor_id = actor.actor_id AND binding.state = 'attached'
        LEFT JOIN chat_panes AS pane ON pane.pane_id = binding.pane_id
        WHERE turn.state IN ('prepared', 'starting', 'running', 'reconciling')
        ORDER BY turn.turn_id
        LIMIT ?1
      `).all(ROOT_RECOVERY_LIMIT + 1);
      rows = z.array(rootRecoveryRowSchema)
        .max(ROOT_RECOVERY_LIMIT + 1)
        .parse(values);
    } catch (cause: unknown) {
      throw new HarnessRootActorAuthorityV2Error(
        "corrupt_state",
        "live root recovery enumeration returned invalid state",
        cause,
      );
    }
    if (rows.length > ROOT_RECOVERY_LIMIT) {
      corrupt("live root recovery exceeds the bounded pane capacity");
    }

    return Object.freeze(rows.map((row) => this.#recoveryCandidate(row)));
  }

  settleRootTurn(inputValue: Readonly<{
    turnId: string;
    state: "succeeded" | "failed" | "cancelled" | "ambiguous";
    outcomeCode: string;
    settledAt?: string;
  }>): ActorTurn {
    const input = z.object({
      turnId: actorTurnIdSchema,
      state: z.enum(["succeeded", "failed", "cancelled", "ambiguous"]),
      outcomeCode: z.string().min(1).max(96),
      settledAt: timestampSchema.optional(),
    }).strict().parse(inputValue);
    let turn = this.#actors.readActorTurn(input.turnId);
    if (turn === null) notFound("root actor turn does not exist");
    const actor = this.#actors.readActor(turn.actorId);
    if (actor === null || actor.parentActorId !== null) {
      invalidState("only a root actor turn may settle through this authority");
    }
    if (isTerminalActorTurnState(turn.state)) {
      if (turn.state === input.state && turn.outcomeCode === input.outcomeCode) {
        return turn;
      }
      conflict("root actor turn already settled with another outcome");
    }
    if (turn.state !== "running" && turn.state !== "starting") {
      invalidState("root actor turn is not ready to settle");
    }
    if (turn.state === "starting") {
      turn = this.#actors.transitionActorTurn({
        turnId: turn.id,
        expectedRevision: turn.revision,
        nextState: "running",
        now: input.settledAt ?? this.#now().toISOString(),
      });
    }
    return this.#actors.transitionActorTurn({
      turnId: turn.id,
      expectedRevision: turn.revision,
      nextState: input.state,
      outcomeCode: input.outcomeCode,
      now: input.settledAt ?? this.#now().toISOString(),
    });
  }

  #recoveryCandidate(
    row: z.infer<typeof rootRecoveryRowSchema>,
  ): HarnessRootActorRecoveryV2 {
    if (
      row.binding_id === null || row.pane_id === null ||
      row.active_turn_id === null || row.interaction_mode !== "chat" ||
      row.pane_state === null || row.chat_turn_status === null
    ) {
      corrupt("live root recovery lineage is only partially attached");
    }
    const root = this.readRootTurn(row.turn_id);
    if (root === null) corrupt("live root recovery turn disappeared");
    if (
      root.turn.state !== row.root_turn_state ||
      (root.turn.state !== "starting" && root.turn.state !== "running") ||
      root.turn.desiredState !== "run" || root.actor.depth !== 0 ||
      root.actor.state !== "active" || root.epoch.state !== "active" ||
      root.paneBinding.id !== row.binding_id ||
      root.paneBinding.paneId !== row.pane_id ||
      root.epoch.id !== deriveRootEpochId({
        projectId: root.epoch.projectId,
        sourceSha: root.epoch.sourceSha,
        paneId: row.pane_id,
      }) ||
      root.actor.id !== deriveRootActorId(root.epoch.id) ||
      root.turn.id !== deriveRootActorTurnId(
        root.epoch.id,
        row.active_turn_id,
      )
    ) {
      corrupt("live root recovery lineage does not match its pane chat turn");
    }

    let disposition: HarnessRootActorRecoveryV2["disposition"];
    if (
      row.pane_state === "ready" && row.chat_turn_status === "completed" &&
      row.turn_completed_at !== null && row.provider_turn_started === 0
    ) {
      disposition = "completed";
    } else if (
      row.pane_state === row.chat_turn_status &&
      (row.pane_state === "starting" || row.pane_state === "continuing") &&
      row.turn_completed_at === null && row.provider_turn_started === 0
    ) {
      disposition = "active_before_provider_start";
    } else if (
      row.pane_state === "streaming" && row.chat_turn_status === "streaming" &&
      row.turn_completed_at === null && row.provider_turn_started === 1
    ) {
      disposition = "active_after_provider_start";
    } else {
      corrupt("live root recovery pane state is partial or contradictory");
    }
    return Object.freeze({
      actorId: root.actor.id,
      paneId: root.paneBinding.paneId,
      turnId: root.turn.id,
      disposition,
    });
  }

  #ensureRoot(input: Readonly<{
    epochId: string;
    actorId: string;
    projectId: string;
    sourceSha: string;
    title: string;
    budget: z.infer<typeof actorBudgetSchema>;
    createdAt: string;
  }>): Readonly<{ epoch: ActorEpoch; actor: Actor }> {
    const existingEpoch = this.#actors.readActorEpoch(input.epochId);
    const existingActor = this.#actors.readActor(input.actorId);
    if (existingEpoch === null && existingActor === null) {
      const created = this.#actors.createActorEpoch({
        epoch: actorEpochSchema.parse({
          id: input.epochId,
          projectId: input.projectId,
          sourceSha: input.sourceSha,
          rootActorId: input.actorId,
          budget: input.budget,
          tokenReserved: 0,
          byteReserved: 0,
          nextRootCompletionSequence: 1,
          state: "active",
          revision: 1,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          stoppedAt: null,
        }),
        rootActor: actorSchema.parse({
          id: input.actorId,
          epochId: input.epochId,
          parentActorId: null,
          depth: 0,
          title: input.title,
          state: "active",
          budget: input.budget,
          tokenReserved: 0,
          byteReserved: 0,
          nextTurnOrdinal: 1,
          nextResultOrdinal: 1,
          revision: 1,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          stoppedAt: null,
        }),
        dispatchPolicy: {
          policyVersion: 1,
          workClass: "standard",
        },
      });
      return { epoch: created.epoch, actor: created.rootActor };
    }
    if (existingEpoch === null || existingActor === null) {
      corrupt("root actor epoch is only partially present");
    }
    if (
      existingEpoch.rootActorId !== existingActor.id ||
      existingActor.parentActorId !== null ||
      existingActor.epochId !== existingEpoch.id ||
      existingEpoch.projectId !== input.projectId ||
      existingEpoch.sourceSha !== input.sourceSha ||
      exactJson(existingEpoch.budget) !== exactJson(input.budget) ||
      exactJson(existingActor.budget) !== exactJson(input.budget) ||
      existingEpoch.state !== "active" ||
      existingActor.state !== "active"
    ) conflict("root actor identity is bound to another admission");
    return { epoch: existingEpoch, actor: existingActor };
  }

  #requirePreparedRoot(input: Readonly<{
    epochId: string;
    actorId: string;
    projectId: string;
    sourceSha: string;
    budget: z.infer<typeof actorBudgetSchema>;
  }>): Readonly<{ epoch: ActorEpoch; actor: Actor }> {
    const epoch = this.#actors.readActorEpoch(input.epochId);
    const actor = this.#actors.readActor(input.actorId);
    if (epoch === null || actor === null) {
      invalidState("root actor must be prepared before its input is admitted");
    }
    if (
      epoch.rootActorId !== actor.id || actor.parentActorId !== null ||
      actor.epochId !== epoch.id || epoch.projectId !== input.projectId ||
      epoch.sourceSha !== input.sourceSha ||
      exactJson(epoch.budget) !== exactJson(input.budget) ||
      exactJson(actor.budget) !== exactJson(input.budget) ||
      epoch.state !== "active" || actor.state !== "active"
    ) conflict("prepared root identity is bound to another admission");
    return { epoch, actor };
  }

  #ensureRunningRootTurn(input: Readonly<{
    turnId: string;
    epochId: string;
    actorId: string;
    inputValueId: string;
    idempotencyKey: string;
    createdAt: string;
  }>): ActorTurn {
    let turn = this.#actors.readActorTurn(input.turnId);
    if (turn === null) {
      turn = this.#actors.createActorTurn(input);
    } else if (
      turn.epochId !== input.epochId ||
      turn.actorId !== input.actorId ||
      turn.inputValueId !== input.inputValueId ||
      turn.idempotencyKey !== input.idempotencyKey
    ) conflict("root actor turn identity is bound to another input");
    if (turn.state === "prepared") {
      turn = this.#actors.transitionActorTurn({
        turnId: turn.id,
        expectedRevision: turn.revision,
        nextState: "starting",
        now: input.createdAt,
      });
    }
    if (turn.state === "starting") {
      turn = this.#actors.transitionActorTurn({
        turnId: turn.id,
        expectedRevision: turn.revision,
        nextState: "running",
        now: input.createdAt,
      });
    }
    if (turn.state === "reconciling") {
      invalidState("root actor turn requires reconciliation");
    }
    return actorTurnSchema.parse(turn);
  }
}

function deriveRootIdentities(input: Readonly<{
  projectId: string;
  sourceSha: string;
  paneId: string;
  chatTurnId: string;
}>): Readonly<{ epochId: string; actorId: string; turnId: string }> {
  const epochId = deriveRootEpochId(input);
  const actorId = deriveRootActorId(epochId);
  return {
    epochId,
    actorId,
    turnId: deriveRootActorTurnId(epochId, input.chatTurnId),
  };
}

function deriveActorBudget(
  input: z.infer<typeof recursiveBudgetSchema>,
): z.infer<typeof actorBudgetSchema> {
  return actorBudgetSchema.parse({
    maxDepth: input.depthRemaining,
    maxActiveDescendants: input.activeDescendantLimit,
    maxDurableDescendants: input.durableDescendantLimit,
    tokenBudget: input.tokenBudget,
    byteBudget: input.heapByteLimit,
    deadline: input.deadline,
    laneAuthority: input.laneAuthority === "readOnly"
      ? "readOnlySnapshot"
      : "managedWrite",
  });
}

export function deriveRootEpochId(input: Readonly<{
  projectId: string;
  sourceSha: string;
  paneId: string;
}>): string {
  return actorEpochSchema.shape.id.parse(
    `hepoch_${digest("oprte.harness.root-epoch.v2", [
      input.projectId,
      input.sourceSha,
      input.paneId,
    ]).slice(0, 48)}`,
  );
}

export function deriveSessionProjectIdForCanonicalPath(
  canonicalRepositoryPath: string,
): string {
  return `proj_${createHash("sha256")
    .update(canonicalRepositoryPath)
    .digest("hex")
    .slice(0, 24)}`;
}

export function deriveRootActorId(epochId: string): string {
  return actorIdSchema.parse(
    `hactor_${digest("oprte.harness.root-actor.v2", [epochId]).slice(0, 48)}`,
  );
}

export function deriveRootActorTurnId(
  epochId: string,
  chatTurnId: string,
): string {
  return actorTurnIdSchema.parse(
    `hturn_${digest("oprte.harness.root-turn.v2", [
      epochId,
      chatTurnId,
    ]).slice(0, 48)}`,
  );
}

export function deriveActorPaneBindingId(actorId: string): string {
  return `hpanebinding_${digest(
    "oprte.harness.actor-pane-binding.v2",
    [actorId],
  ).slice(0, 40)}`;
}

function deriveRootTurnIdempotencyKey(
  epochId: string,
  chatTurnId: string,
): string {
  return `root_turn_${digest("oprte.harness.root-turn-request.v2", [
    epochId,
    chatTurnId,
  ]).slice(0, 48)}`;
}

function digest(domain: string, identities: readonly string[]): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const identity of identities) {
    hash.update("\0", "utf8").update(identity, "utf8");
  }
  return hash.digest("hex");
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}

function conflict(message: string): never {
  throw new HarnessRootActorAuthorityV2Error("conflict", message);
}

function corrupt(message: string): never {
  throw new HarnessRootActorAuthorityV2Error("corrupt_state", message);
}

function invalidState(message: string): never {
  throw new HarnessRootActorAuthorityV2Error("invalid_state", message);
}

function notFound(message: string): never {
  throw new HarnessRootActorAuthorityV2Error("not_found", message);
}
