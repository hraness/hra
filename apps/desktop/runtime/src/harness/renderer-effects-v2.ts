import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  accountProfileIdSchema,
  chatPaneIdSchema,
  chatTurnIdSchema,
  harnessChildProjectionSchema,
  runtimeChatTurnPromptUtf8ByteLimit,
  type ChatPaneProjection,
  type HarnessChildProjection,
} from "../../../contracts/runtime";
import type {
  ChatHarnessActorTurnPort,
  ChatProjectionSink,
  ChatRepository,
  ChatRepositoryPort,
} from "../chat/types";
import type { SessionService } from "../sessions/session-service";
import { harnessObserverPaneId } from "../state/chat-pane-store";
import type { ChatPaneStore } from "../state/chat-pane-store";
import {
  actorIdSchema,
  actorResultSchema,
  actorSchema,
  actorTurnSchema,
  type Actor,
  type ActorResult,
  type ActorTurn,
} from "./actor-domain";
import type { PersistentActorCoordinator } from "./persistent-actors";
import type { PersistentActorLivenessPortV2 } from "./persistent-actor-liveness-v2";
import type { HarnessContextOperationValuePortV2 } from "./context-value-ports-v2";
import {
  deriveHarnessChildActions,
  deriveHarnessChildState,
  deriveHarnessParentProjectionRevision,
  harnessChildSemanticDigest,
  type HarnessRendererActorCoordinatorPort,
  type HarnessRendererChatAttachmentPort,
} from "./renderer-authority-v2";
import type {
  HarnessProjectionWitnessV2,
  HarnessRendererSQLiteAdapterV2,
} from "./renderer-sqlite-adapter-v2";
import {
  actorIncarnationRecordSchema,
  actorPaneBindingSchema,
  actorSessionBindingRecordV2Schema,
  type ActorIncarnationRecord,
  type ActorPaneBinding,
  type ActorSessionBindingRecordV2,
} from "./sqlite-authority-v2";
import type { HarnessSQLiteAuthorityV2 } from "./sqlite-authority-v2";

const MAX_RESPONSE_UTF8_BYTES = 1024 * 1024;
const CHILD_PAGE_SIZE = 51;
const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);
const revisionSchema = z.number().int().positive().safe();
const absolutePathSchema = z.string().min(1).max(4_096).startsWith("/");
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const effectInputSchema = z.object({
  parentPaneId: chatPaneIdSchema,
  parentActorId: actorIdSchema,
  childActorId: actorIdSchema,
  expectedParentRevision: revisionSchema,
  expectedChildRevision: revisionSchema,
}).strict();

const attachedTurnInputSchema = z.object({
  paneId: chatPaneIdSchema,
  chatTurnId: chatTurnIdSchema,
  prompt: z.string().min(1).refine(
    (value) => !value.includes("\0") &&
      Buffer.byteLength(value, "utf8") <= runtimeChatTurnPromptUtf8ByteLimit,
    "attached actor prompt is invalid",
  ),
  createdAt: timestampSchema,
}).strict();

const sessionEventRouteInputSchema = z.object({
  accountProfileId: accountProfileIdSchema,
  threadId: z.string().min(1).max(512).refine(
    (value) => !value.includes("\0"),
    "owned thread identity contains NUL",
  ),
  turnId: z.string().min(1).max(512).refine(
    (value) => !value.includes("\0"),
    "owned turn identity contains NUL",
  ),
}).strict();

const sessionEventReverseRouteSchema = z.object({
  actorId: actorIdSchema,
  admissionGeneration: z.number().int().positive().safe(),
  generation: z.number().int().positive().safe(),
  providerThreadId: z.string().min(1).max(512).refine(
    (value) => !value.includes("\0"),
    "provider thread identity contains NUL",
  ),
  threadId: sessionEventRouteInputSchema.shape.threadId,
  turnId: sessionEventRouteInputSchema.shape.turnId,
}).strict().superRefine((route, context) => {
  if (route.generation < route.admissionGeneration) {
    context.addIssue({
      code: "custom",
      message: "the routed generation cannot precede actor admission",
      path: ["generation"],
    });
  }
});

const projectRowSchema = z.object({
  project_id: z.string().min(1).max(128),
  canonical_repository_path: absolutePathSchema,
}).strict();

const actorResultRowSchema = z.object({
  result_id: actorResultSchema.shape.id,
  epoch_id: actorResultSchema.shape.epochId,
  actor_id: actorResultSchema.shape.actorId,
  turn_id: actorResultSchema.shape.turnId,
  terminal_attempt_id: actorResultSchema.shape.terminalAttemptId,
  outcome: actorResultSchema.shape.outcome,
  value_id: actorResultSchema.shape.valueId,
  actor_result_ordinal: actorResultSchema.shape.actorResultOrdinal,
  root_completion_sequence: actorResultSchema.shape.rootCompletionSequence,
  created_at: timestampSchema,
}).strict();

const responseSchema = z.string().refine(
  (value) => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_RESPONSE_UTF8_BYTES,
  "actor response must fit the renderer projection bound",
);
const attachmentSchema = z.object({
  threadId: z.string().min(1).max(512).refine(
    (value) => !value.includes("\0"),
    "owned thread identity contains NUL",
  ),
  restartThreadId: z.string().min(1).max(512).refine(
    (value) => !value.includes("\0"),
    "restart thread identity contains NUL",
  ),
}).strict();

const sessionRouteRowSchema = z.object({
  actor_id: actorIdSchema,
  incarnation_id: actorIncarnationRecordSchema.shape.id,
  pane_id: chatPaneIdSchema,
  process_generation: z.number().int().positive().safe(),
  provider_thread_id: attachmentSchema.shape.restartThreadId,
  session_account_profile_id: accountProfileIdSchema,
  session_actor_id: actorIdSchema,
  session_admission_generation: z.number().int().positive().safe(),
  session_live_generation: z.number().int().positive().safe(),
  session_provider_thread_id: attachmentSchema.shape.restartThreadId,
}).strict().superRefine((row, context) => {
  if (row.session_live_generation < row.session_admission_generation) {
    context.addIssue({
      code: "custom",
      message: "the routed live generation cannot precede admission",
      path: ["session_live_generation"],
    });
  }
});

export interface HarnessRendererActorResponsePort {
  /** Reads one exact encrypted actor-result value without exposing its ID. */
  readActorResponse(input: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    valueId: string;
  }>): Promise<unknown>;
}

export interface HarnessRendererEffectsV2Options {
  readonly database: Database;
  readonly actors: HarnessSQLiteAuthorityV2;
  readonly renderer: HarnessRendererSQLiteAdapterV2;
  readonly panes: ChatPaneStore;
  readonly sessions: Pick<SessionService,
    "readHarnessActorChatAttachment" | "readHarnessActorChatEventRoute" |
    "readHarnessActorChatTurnAttachment">;
  readonly repositories: ChatRepositoryPort;
  readonly coordinator: Pick<PersistentActorCoordinator,
    "quiesceActorForStop" | "send">;
  readonly liveness: Pick<PersistentActorLivenessPortV2, "ensureCurrent">;
  readonly values: HarnessContextOperationValuePortV2;
  readonly responses: HarnessRendererActorResponsePort;
  readonly projection: Pick<ChatProjectionSink, "paneChanged">;
  readonly now?: () => Date;
}

export class HarnessRendererEffectsV2Error extends Error {
  readonly code:
    | "authority_conflict"
    | "invalid_state"
    | "not_found"
    | "revision_conflict";

  constructor(
    code: HarnessRendererEffectsV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessRendererEffectsV2Error";
    this.code = code;
  }
}

interface ChildEvidence {
  readonly actor: Actor;
  readonly incarnation: ActorIncarnationRecord | null;
  readonly latestTurn: ActorTurn | null;
  readonly binding: ActorPaneBinding | null;
  readonly witness: HarnessProjectionWitnessV2;
  readonly projection: Omit<HarnessChildProjection, "revision">;
}

interface OpenPreflight {
  readonly attachment: Readonly<{ threadId: string; restartThreadId: string }>;
  readonly child: ChildEvidence;
  readonly latestResult: ActorResult | null;
  readonly repository: ChatRepository;
  readonly response: string | null;
  readonly sessionBinding: ActorSessionBindingRecordV2;
}

/**
 * Owns provider-facing preflight and each renderer mutation's one durable
 * commit. No provider call runs under SQLite. A lost response is replayed only
 * when the complete durable outcome is exactly one semantic step ahead.
 */
export class HarnessRendererEffectsV2
  implements HarnessRendererChatAttachmentPort, HarnessRendererActorCoordinatorPort,
    ChatHarnessActorTurnPort {
  readonly #database: Database;
  readonly #actors: HarnessSQLiteAuthorityV2;
  readonly #renderer: HarnessRendererSQLiteAdapterV2;
  readonly #panes: ChatPaneStore;
  readonly #sessions: HarnessRendererEffectsV2Options["sessions"];
  readonly #repositories: ChatRepositoryPort;
  readonly #coordinator: HarnessRendererEffectsV2Options["coordinator"];
  readonly #liveness: HarnessRendererEffectsV2Options["liveness"];
  readonly #values: HarnessContextOperationValuePortV2;
  readonly #responses: HarnessRendererActorResponsePort;
  readonly #projection: Pick<ChatProjectionSink, "paneChanged">;
  readonly #now: () => Date;

  constructor(options: HarnessRendererEffectsV2Options) {
    this.#database = options.database;
    this.#actors = options.actors;
    this.#renderer = options.renderer;
    this.#panes = options.panes;
    this.#sessions = options.sessions;
    this.#repositories = options.repositories;
    this.#coordinator = options.coordinator;
    this.#liveness = options.liveness;
    this.#values = options.values;
    this.#responses = options.responses;
    this.#projection = options.projection;
    this.#now = options.now ?? (() => new Date());
  }

  listPaneIds(input: Readonly<{
    afterPaneId: string | null;
    limit: number;
  }>): readonly string[] {
    return this.#renderer.listPaneIds(input);
  }

  routeSessionEvent(inputValue: Readonly<{
    accountProfileId: string;
    threadId: string;
    turnId: string;
  }>): string | null {
    const input = sessionEventRouteInputSchema.parse(inputValue);
    const routeValue = this.#sessions.readHarnessActorChatEventRoute(input);
    if (routeValue === null) return null;
    const route = sessionEventReverseRouteSchema.parse(routeValue);
    if (route.threadId !== input.threadId || route.turnId !== input.turnId) {
      conflict("the reverse session route returned another owned event");
    }
    const candidateRows: unknown[] = this.#database.query(`
      SELECT incarnation.actor_id, incarnation.incarnation_id,
        binding.pane_id, incarnation.process_generation,
        incarnation.provider_thread_id,
        session.account_profile_id AS session_account_profile_id,
        session.actor_id AS session_actor_id,
        session.admission_generation AS session_admission_generation,
        session.live_generation AS session_live_generation,
        session.provider_thread_id AS session_provider_thread_id
      FROM harness_actor_incarnations AS incarnation
      JOIN harness_actor_pane_bindings AS binding
        ON binding.actor_id = incarnation.actor_id
        AND binding.state = 'attached'
      JOIN harness_actor_session_bindings AS session
        ON session.incarnation_id = incarnation.incarnation_id
        AND session.state = 'bound'
      WHERE incarnation.actor_id = ?1
        AND incarnation.state IN ('idle', 'running')
        AND incarnation.provider_thread_id IS NOT NULL
      ORDER BY incarnation.incarnation_id LIMIT 2
    `).all(route.actorId);
    if (candidateRows.length === 0) return null;
    if (candidateRows.length !== 1) {
      conflict("the reverse session route names multiple live incarnations");
    }
    const match = sessionRouteRowSchema.parse(candidateRows[0]);
    if (
      route.actorId !== match.actor_id ||
      route.providerThreadId !== match.provider_thread_id ||
      route.admissionGeneration !== match.process_generation ||
      route.generation !== match.session_live_generation ||
      match.session_actor_id !== match.actor_id ||
      match.session_account_profile_id !== input.accountProfileId ||
      match.session_admission_generation !== match.process_generation ||
      match.session_provider_thread_id !== match.provider_thread_id
    ) conflict("the routed actor session lost its exact admission lineage");
    const actor = this.#actors.readActor(match.actor_id);
    const actorPaneBinding = this.#actors.readPaneBindingForActor(match.actor_id);
    const pane = this.#panes.get(match.pane_id);
    if (
      actor === null || actor.parentActorId === null || actor.state !== "active" ||
      actorPaneBinding?.paneId !== match.pane_id ||
      pane?.projection.interactionMode !== "harnessObserver"
    ) conflict("the routed actor session lost its exact pane authority");
    const binding = {
      accountProfileId: input.accountProfileId,
      threadId: input.threadId,
      restartThreadId: match.provider_thread_id,
    } as const;
    try {
      const publication = this.#rebindPane(
        match.pane_id,
        input.accountProfileId,
        binding,
      );
      // Session routing is a synchronous ownership lookup. The durable rebind
      // above is complete before this promise is returned; projection commit
      // remains admitted to the lossless coordinator and is restart-replayable.
      void publication.catch(() => undefined);
    } catch (cause: unknown) {
      const committed = this.#panes.get(match.pane_id)?.binding;
      if (
        committed?.accountProfileId !== binding.accountProfileId ||
        committed.threadId !== binding.threadId ||
        committed.restartThreadId !== binding.restartThreadId
      ) throw cause;
      // Publication is replayable. The exact durable route must still admit
      // this first event into ChatService's bounded early-event buffer.
    }
    return match.pane_id;
  }

  async startTurn(inputValue: Readonly<{
    paneId: string;
    chatTurnId: string;
    prompt: string;
    createdAt: string;
  }>): ReturnType<ChatHarnessActorTurnPort["startTurn"]> {
    const input = attachedTurnInputSchema.parse(inputValue);
    const actorValue = this.#actors.readActorForPane(input.paneId);
    if (actorValue === null) notFound("the attached actor is unavailable");
    const actor = actorSchema.parse(actorValue);
    if (actor.parentActorId === null) {
      invalidState("root chat panes use root admission, not attached actor messaging");
    }
    const idempotencyKey = attachedTurnIdempotencyKey(
      input.paneId,
      input.chatTurnId,
    );
    const durableReplay = this.#readLatestTurn(actor)?.idempotencyKey === idempotencyKey;
    if (durableReplay) this.#renderer.synchronizeProjectionWitness(actor.id);
    const before = this.#readChildEvidence(actor);
    const replayTurn = before.latestTurn?.idempotencyKey === idempotencyKey
      ? before.latestTurn
      : null;
    if (
      before.binding?.paneId !== input.paneId ||
      (!before.projection.canMessage && replayTurn === null) ||
      (replayTurn !== null && (
        before.actor.state !== "active" || replayTurn.state === "ambiguous"
      ))
    ) invalidState("the attached actor has no message authority");
    if (replayTurn === null || !isDefinitiveTurn(replayTurn)) {
      if (before.incarnation === null) {
        conflict("the attached actor turn lost its live incarnation");
      }
      await this.#rebindPaneToIncarnation(input.paneId, before.incarnation);
    }

    const operationId = attachedInputOperationId(actor.id, input.chatTurnId);
    const valueId = attachedInputValueId(actor.id, input.chatTurnId);
    const valueIdentity = Object.freeze({
      epochId: actor.epochId,
      ownerActorId: actor.parentActorId,
      sourceTurnId: null,
      valueId,
      kind: "text" as const,
      purpose: "currentInput" as const,
    });
    const stored = await this.#values.putExact({
      operationId,
      ...valueIdentity,
      plaintext: input.prompt,
      quotaLimitBytes: actor.budget.byteBudget,
      name: null,
    });
    if (
      stored.value.epochId !== valueIdentity.epochId ||
      stored.value.ownerActorId !== valueIdentity.ownerActorId ||
      stored.value.sourceTurnId !== null ||
      stored.value.valueId !== valueId || stored.value.kind !== "text" ||
      stored.value.purpose !== "currentInput" ||
      stored.value.utf8Bytes !== Buffer.byteLength(input.prompt, "utf8")
    ) conflict("attached actor input storage returned another immutable identity");
    const opened = await this.#values.openExact(valueIdentity);
    if (
      opened.plaintext !== input.prompt ||
      opened.value.valueId !== valueId ||
      opened.value.ownerActorId !== actor.parentActorId
    ) conflict("attached actor input replay did not match its exact plaintext");

    const current = this.#readChildEvidence(this.#actors.readActor(actor.id) ?? actor);
    if (
      exactJson(current.actor) !== exactJson(before.actor) ||
      exactJson(current.incarnation) !== exactJson(before.incarnation) ||
      exactJson(current.latestTurn) !== exactJson(before.latestTurn) ||
      exactJson(current.binding) !== exactJson(before.binding) ||
      exactJson(current.witness) !== exactJson(before.witness) ||
      (replayTurn === null
        ? !current.projection.canMessage
        : current.latestTurn?.idempotencyKey !== idempotencyKey)
    ) revisionConflict("the attached actor changed while its input was prepared");

    let view: Awaited<ReturnType<PersistentActorCoordinator["send"]>>;
    try {
      view = await this.#coordinator.send({
        callerActorId: actor.parentActorId,
        actorId: actor.id,
        idempotencyKey,
        inputValueId: valueId,
      });
    } catch (cause: unknown) {
      const recoveredActor = this.#actors.readActor(actor.id);
      if (recoveredActor === null) throw cause;
      const recoveredTurn = this.#readLatestTurn(recoveredActor);
      if (recoveredTurn?.idempotencyKey !== idempotencyKey) throw cause;
      // A lost coordinator response after durable admission is replayable. Do
      // not let ChatService invent a failed local turn while the exact actor
      // attempt is still running or reconciling.
      this.#renderer.synchronizeProjectionWitness(actor.id);
      view = {
        turn: recoveredTurn,
        result: this.#actors.readActorResultForTurn(recoveredTurn.id),
      };
    }
    const turn = actorTurnSchema.parse(view.turn);
    const result = actorResultSchema.nullable().parse(view.result);
    if (
      turn.actorId !== actor.id || turn.epochId !== actor.epochId ||
      turn.idempotencyKey !== idempotencyKey ||
      (result !== null && (
        result.turnId !== turn.id || result.actorId !== actor.id ||
        result.epochId !== actor.epochId
      ))
    ) conflict("persistent actor messaging returned another logical turn");
    this.#renderer.synchronizeProjectionWitness(actor.id);

    const incarnation = this.#actors.readActiveIncarnationForActor(actor.id);
    const attempt = result?.terminalAttemptId === null || result === null
      ? (incarnation === null
          ? null
          : this.#actors.readActorAttempt(actorAttemptId(turn.id, incarnation.id)))
      : this.#actors.readActorAttempt(result.terminalAttemptId);
    if (isDefinitiveTurn(turn)) {
      if (result === null || result.outcome !== resultOutcomeForTurn(turn)) {
        conflict("the terminal actor turn lacks its exact result");
      }
      if (turn.state === "succeeded") {
        if (result.valueId === null) {
          conflict("the successful actor turn lacks its exact result value");
        }
        const responseValue = await this.#responses.readActorResponse({
          epochId: result.epochId,
          actorId: result.actorId,
          turnId: result.turnId,
          valueId: result.valueId,
        });
        return Object.freeze({
          kind: "settled",
          actorTurnId: turn.id,
          outcome: "succeeded",
          responseMarkdown: responseValue === null
            ? null
            : responseSchema.parse(responseValue),
        });
      }
      return Object.freeze({
        kind: "settled",
        actorTurnId: turn.id,
        outcome: turn.state,
      });
    }
    if (attempt?.providerTurnId !== null && attempt?.providerTurnId !== undefined) {
      const attemptIncarnation = this.#actors.readActorIncarnation(
        attempt.incarnationId,
      );
      if (
        attemptIncarnation === null ||
        attemptIncarnation.actorId !== actor.id ||
        attemptIncarnation.accountProfileId !== attempt.accountProfileId ||
        attemptIncarnation.processGeneration !== attempt.processGeneration ||
        attemptIncarnation.providerThreadId === null
      ) conflict("the actor attempt lost its exact incarnation");
      const sessionBinding = this.#requireLiveSessionBinding(attemptIncarnation);
      const session = this.#sessions.readHarnessActorChatAttachment({
        accountProfileId: attempt.accountProfileId,
        expectedGeneration: sessionBinding.liveGeneration,
        providerThreadId: attemptIncarnation.providerThreadId,
      });
      if (session === null) {
        conflict("the actor incarnation is absent from its exact gateway session");
      }
      const attachment = this.#sessions.readHarnessActorChatTurnAttachment({
        accountProfileId: attempt.accountProfileId,
        expectedGeneration: sessionBinding.liveGeneration,
        providerThreadId: attemptIncarnation.providerThreadId,
        providerTurnId: attempt.providerTurnId,
      });
      if (attachment === null || attachment.threadId !== session.threadId) {
        conflict("the actor turn is absent from its exact gateway session");
      }
      await this.#rebindPane(input.paneId, attempt.accountProfileId, session);
      return Object.freeze({
        kind: "accepted",
        actorTurnId: turn.id,
        providerTurnId: attachment.turnId,
      });
    }
    if (turn.state === "ambiguous") {
      conflict("the actor turn has an ambiguous provider effect");
    }
    return Object.freeze({
      kind: "recovering",
      actorTurnId: turn.id,
    });
  }

  async reconcileTurn(inputValue: Readonly<{
    paneId: string;
    chatTurnId: string;
    prompt: string;
    createdAt: string;
  }>): ReturnType<ChatHarnessActorTurnPort["reconcileTurn"]> {
    const input = attachedTurnInputSchema.parse(inputValue);
    const pane = this.#panes.require(input.paneId);
    if (
      pane.projection.interactionMode !== "harnessObserver" ||
      pane.projection.turn?.id !== input.chatTurnId ||
      pane.projection.turn.startedAt !== input.createdAt ||
      pane.activePrompt !== input.prompt
    ) invalidState("the attached actor terminal hint is stale");

    // The SessionService lifecycle callback is only a liveness hint. Durable
    // actor reconciliation re-reads the exact provider attempt, result value,
    // quota proof, and token accounting before the idempotent turn replay can
    // change renderer state.
    await this.#liveness.ensureCurrent();
    return await this.startTurn(input);
  }

  async openChild(inputValue: Readonly<{
    parentPaneId: string;
    parentActorId: string;
    childActorId: string;
    expectedParentRevision: number;
    expectedChildRevision: number;
  }>): Promise<Readonly<{
    parentPaneId: string;
    parentActorId: string;
    parentRevision: number;
    childActorId: string;
    childWitness: HarnessProjectionWitnessV2;
    binding: ActorPaneBinding;
    pane: ChatPaneProjection;
  }>> {
    const input = effectInputSchema.parse(inputValue);
    const replay = this.#readOpenReplay(input);
    if (replay !== null) {
      await this.#projection.paneChanged(replay.pane);
      return replay;
    }
    const preflight = await this.#preflightOpen(input);
    const outcome = this.#database.transaction(() => {
      const { parent, child } = this.#requireExactLineage(input);
      this.#assertParentRevision(parent, input.expectedParentRevision);
      const current = this.#readChildEvidence(child);
      this.#assertWitnessRevision(current, input.expectedChildRevision);
      this.#assertOpenEligible(current);
      this.#assertPreflightStillCurrent(current, preflight);
      this.#assertRepositoryStillCurrent(parent, preflight.repository);

      const pane = this.#panes.createAttachedHarnessSession({
        actorId: child.id,
        repository: preflight.repository,
        binding: {
          accountProfileId: current.incarnation!.accountProfileId,
          threadId: preflight.attachment.threadId,
          restartThreadId: preflight.attachment.restartThreadId,
        },
        title: child.title,
        now: this.#now(),
      }).pane;
      const binding = this.#actors.attachActorPaneInTransaction({
        bindingId: actorPaneBindingId(child.id),
        actorId: child.id,
        paneId: pane.id,
        attachedAt: this.#now().toISOString(),
      });
      let projectedPane = pane;
      if (preflight.response !== null) {
        const latestTurn = current.latestTurn;
        if (latestTurn === null || latestTurn.state !== "succeeded") {
          conflict("a renderer response cannot outlive its successful actor turn");
        }
        projectedPane = this.#panes.seedAttachedHarnessLatestResponse({
          paneId: pane.id,
          turnId: observerTurnId(latestTurn.id),
          markdown: preflight.response,
          startedAt: new Date(Date.parse(latestTurn.startedAt!)),
          completedAt: new Date(Date.parse(latestTurn.settledAt!)),
          now: this.#now(),
        }).pane;
      } else if (
        current.latestTurn?.state === "failed" ||
        current.latestTurn?.state === "quotaRejected" ||
        current.latestTurn?.state === "cancelled"
      ) {
        projectedPane = this.#panes.seedAttachedHarnessLatestFailure({
          paneId: pane.id,
          turnId: observerTurnId(current.latestTurn.id),
          attention: attachedActorAttention(current.latestTurn.state),
          startedAt: new Date(Date.parse(current.latestTurn.startedAt!)),
          completedAt: new Date(Date.parse(current.latestTurn.settledAt!)),
          now: this.#now(),
        }).pane;
      }
      const projection = this.#semanticProjection(child, current.incarnation, current.latestTurn, binding);
      const childWitness = this.#renderer.writeProjectionWitnessInTransaction({
        actorId: child.id,
        expectedRevision: input.expectedChildRevision,
        projection,
      });
      const parentRevision = this.#parentRevision(parent);
      if (parentRevision !== input.expectedParentRevision + 1) {
        conflict("opening the child did not advance its parent exactly once");
      }
      return Object.freeze({
        parentPaneId: input.parentPaneId,
        parentActorId: parent.id,
        parentRevision,
        childActorId: child.id,
        childWitness,
        binding,
        pane: projectedPane,
      });
    })();
    await this.#projection.paneChanged(outcome.pane);
    return outcome;
  }

  async requestAndSettleStop(inputValue: Readonly<{
    parentPaneId: string;
    parentActorId: string;
    childActorId: string;
    expectedParentRevision: number;
    expectedChildRevision: number;
  }>): Promise<Readonly<{
    parentPaneId: string;
    parentActorId: string;
    parentRevision: number;
    child: Actor;
    childWitness: HarnessProjectionWitnessV2;
  }>> {
    const input = effectInputSchema.parse(inputValue);
    const replay = this.#readStopReplay(input);
    if (replay !== null) return replay;
    const { child } = this.#requireExactLineage(input);
    const before = this.#readChildEvidence(child, false);
    if (
      before.actor.state !== "stopRequested" &&
      before.witness.semanticDigest !== harnessChildSemanticDigest(before.projection)
    ) conflict("the child witness does not bind its durable semantic state");
    this.#assertWitnessRevision(before, input.expectedChildRevision);
    if (before.projection.state === "stopped" || before.projection.state === "quarantined") {
      invalidState("the actor is already terminal");
    }
    const quiesced = actorSchema.parse(await this.#coordinator.quiesceActorForStop({
      callerActorId: input.parentActorId,
      actorId: input.childActorId,
    }));
    if (quiesced.id !== child.id || quiesced.state !== "stopRequested") {
      conflict("actor quiescence returned an incoherent lifecycle state");
    }

    return this.#database.transaction(() => {
      const { parent, child: currentChild } = this.#requireExactLineage(input);
      this.#assertParentRevision(parent, input.expectedParentRevision);
      // Quiescence deliberately changes incarnation-derived action authority
      // before this transaction advances the semantic witness.
      const current = this.#readChildEvidence(currentChild, false);
      this.#assertWitnessRevision(current, input.expectedChildRevision);
      if (current.actor.state !== "stopRequested") {
        conflict("actor lost its durable stop intent before settlement");
      }
      const stopped = this.#actors.settleActorStop({
        actorId: current.actor.id,
        expectedRevision: current.actor.revision,
        nextState: "stopped",
        now: this.#now().toISOString(),
      });
      const after = this.#readChildEvidence(stopped, false);
      const projection = this.#semanticProjection(
        stopped,
        after.incarnation,
        after.latestTurn,
        after.binding,
      );
      const childWitness = this.#renderer.writeProjectionWitnessInTransaction({
        actorId: stopped.id,
        expectedRevision: input.expectedChildRevision,
        projection,
      });
      const parentRevision = this.#parentRevision(parent);
      if (parentRevision !== input.expectedParentRevision + 1) {
        conflict("stopping the child did not advance its parent exactly once");
      }
      return Object.freeze({
        parentPaneId: input.parentPaneId,
        parentActorId: parent.id,
        parentRevision,
        child: stopped,
        childWitness,
      });
    })();
  }

  async #preflightOpen(
    input: z.infer<typeof effectInputSchema>,
  ): Promise<OpenPreflight> {
    const { parent, child } = this.#requireExactLineage(input);
    this.#assertParentRevision(parent, input.expectedParentRevision);
    const evidence = this.#readChildEvidence(child);
    this.#assertWitnessRevision(evidence, input.expectedChildRevision);
    this.#assertOpenEligible(evidence);
    const incarnation = evidence.incarnation!;
    const sessionBinding = this.#requireLiveSessionBinding(incarnation);
    const attachmentValue = this.#sessions.readHarnessActorChatAttachment({
      accountProfileId: incarnation.accountProfileId,
      expectedGeneration: sessionBinding.liveGeneration,
      providerThreadId: incarnation.providerThreadId!,
    });
    if (attachmentValue === null) {
      invalidState("the actor session is unavailable in its exact runtime generation");
    }
    const attachment = attachmentSchema.parse(attachmentValue);
    const parentPane = this.#panes.require(input.parentPaneId);
    const epoch = this.#actors.readActorEpoch(parent.epochId);
    if (epoch === null || epoch.id !== child.epochId) notFound("the actor epoch is unavailable");
    if (parentPane.projection.repository.id !== epoch.projectId) {
      conflict("the parent pane and actor epoch name different projects");
    }
    const repositoryValue = await this.#repositories.resolve(parentPane.projection.repository.id);
    if (repositoryValue === null) notFound("the actor repository is unavailable");
    const repository = repositorySchema().parse(repositoryValue);
    this.#assertRepositoryStillCurrent(parent, repository);

    const latestResult = this.#readLatestResult(child.id);
    if (
      (evidence.latestTurn === null) !== (latestResult === null) ||
      (latestResult !== null && evidence.latestTurn?.id !== latestResult.turnId)
    ) conflict("the actor's latest turn and result are incoherent");
    if (latestResult !== null && evidence.latestTurn !== null) {
      if (
        !isDefinitiveTurn(evidence.latestTurn) ||
        latestResult.outcome !== resultOutcomeForTurn(evidence.latestTurn)
      ) conflict("the actor's latest turn and result name different outcomes");
    }
    let response: string | null = null;
    if (latestResult?.outcome === "succeeded") {
      if (latestResult.valueId === null || evidence.latestTurn?.state !== "succeeded") {
        conflict("the successful actor result lacks its exact terminal turn value");
      }
      const value = await this.#responses.readActorResponse({
        epochId: latestResult.epochId,
        actorId: latestResult.actorId,
        turnId: latestResult.turnId,
        valueId: latestResult.valueId,
      });
      response = value === null ? null : responseSchema.parse(value);
    }
    return Object.freeze({
      attachment,
      child: evidence,
      latestResult,
      repository,
      response,
      sessionBinding,
    });
  }

  #readOpenReplay(input: z.infer<typeof effectInputSchema>) {
    const { parent, child } = this.#requireExactLineage(input);
    const current = this.#readChildEvidence(child);
    const parentRevision = this.#parentRevision(parent);
    if (
      parentRevision !== input.expectedParentRevision + 1 ||
      current.witness.revision !== input.expectedChildRevision + 1 ||
      current.binding === null
    ) return null;
    const pane = this.#panes.get(current.binding.paneId);
    if (
      pane === null || pane.projection.interactionMode !== "harnessObserver" ||
      pane.projection.id !== harnessObserverPaneId(child.id) ||
      current.projection.openedPaneId !== pane.projection.id ||
      current.projection.canOpen || !current.projection.canMessage ||
      current.witness.semanticDigest !== harnessChildSemanticDigest(current.projection)
    ) conflict("the committed child attachment cannot be replayed exactly");
    return Object.freeze({
      parentPaneId: input.parentPaneId,
      parentActorId: parent.id,
      parentRevision,
      childActorId: child.id,
      childWitness: current.witness,
      binding: current.binding,
      pane: pane.projection,
    });
  }

  #readStopReplay(input: z.infer<typeof effectInputSchema>) {
    const { parent, child } = this.#requireExactLineage(input);
    const current = this.#readChildEvidence(child, false);
    const parentRevision = this.#parentRevision(parent);
    if (
      parentRevision !== input.expectedParentRevision + 1 ||
      current.witness.revision !== input.expectedChildRevision + 1 ||
      current.actor.state !== "stopped"
    ) return null;
    if (
      current.projection.state !== "stopped" || current.projection.canOpen ||
      current.projection.canMessage || current.projection.canStop ||
      current.witness.semanticDigest !== harnessChildSemanticDigest(current.projection)
    ) conflict("the committed actor stop cannot be replayed exactly");
    return Object.freeze({
      parentPaneId: input.parentPaneId,
      parentActorId: parent.id,
      parentRevision,
      child: current.actor,
      childWitness: current.witness,
    });
  }

  #requireExactLineage(input: z.infer<typeof effectInputSchema>): Readonly<{
    parent: Actor;
    child: Actor;
  }> {
    const parent = this.#actors.readActor(input.parentActorId);
    const child = this.#actors.readActor(input.childActorId);
    const paneActor = this.#actors.readActorForPane(input.parentPaneId);
    if (parent === null || child === null || paneActor === null) {
      notFound("the renderer actor lineage is unavailable");
    }
    if (
      paneActor.id !== parent.id || child.parentActorId !== parent.id ||
      child.epochId !== parent.epochId || child.depth !== parent.depth + 1
    ) conflict("the renderer actor lineage is incoherent");
    return { parent, child };
  }

  #readChildEvidence(actorValue: Actor, assertWitness = true): ChildEvidence {
    const actor = actorSchema.parse(actorValue);
    const incarnation = actorIncarnationRecordSchema.nullable().parse(
      this.#actors.readActiveIncarnationForActor(actor.id),
    );
    const latestTurn = this.#readLatestTurn(actor);
    const binding = actorPaneBindingSchema.nullable().parse(
      this.#actors.readPaneBindingForActor(actor.id),
    );
    const witness = witnessSchema().parse(this.#renderer.readProjectionWitness(actor.id));
    const projection = this.#semanticProjection(actor, incarnation, latestTurn, binding);
    if (
      assertWitness &&
      witness.semanticDigest !== harnessChildSemanticDigest(projection)
    ) {
      conflict("the child witness does not bind its durable semantic state");
    }
    return { actor, incarnation, latestTurn, binding, witness, projection };
  }

  #readLatestTurn(actor: Actor): ActorTurn | null {
    const values: unknown[] = this.#database.query(`
      SELECT turn_id FROM harness_actor_turns
      WHERE actor_id = ?1 ORDER BY ordinal DESC LIMIT 2
    `).all(actor.id);
    if (values.length === 0) {
      if (actor.nextTurnOrdinal !== 1) conflict("actor turn ordinal lost its latest turn");
      return null;
    }
    const ids = values.map((value) => z.object({
      turn_id: actorTurnSchema.shape.id,
    }).strict().parse(value).turn_id);
    if (new Set(ids).size !== ids.length) conflict("latest actor turn is duplicated");
    const turn = this.#actors.readActorTurn(ids[0]!);
    if (
      turn === null || turn.actorId !== actor.id || turn.epochId !== actor.epochId ||
      turn.ordinal !== actor.nextTurnOrdinal - 1
    ) conflict("latest actor turn does not match its owning actor");
    return actorTurnSchema.parse(turn);
  }

  #readLatestResult(actorId: string): ActorResult | null {
    const row: unknown = this.#database.query(`
      SELECT result_id, epoch_id, actor_id, turn_id, terminal_attempt_id,
        outcome, value_id, actor_result_ordinal, root_completion_sequence, created_at
      FROM harness_actor_results WHERE actor_id = ?1
      ORDER BY actor_result_ordinal DESC LIMIT 1
    `).get(actorId);
    if (row === null) return null;
    const value = actorResultRowSchema.parse(row);
    return actorResultSchema.parse({
      id: value.result_id,
      epochId: value.epoch_id,
      actorId: value.actor_id,
      turnId: value.turn_id,
      terminalAttemptId: value.terminal_attempt_id,
      outcome: value.outcome,
      valueId: value.value_id,
      actorResultOrdinal: value.actor_result_ordinal,
      rootCompletionSequence: value.root_completion_sequence,
      createdAt: value.created_at,
    });
  }

  #semanticProjection(
    actor: Actor,
    incarnation: ActorIncarnationRecord | null,
    latestTurn: ActorTurn | null,
    binding: ActorPaneBinding | null,
  ): Omit<HarnessChildProjection, "revision"> {
    const state = deriveHarnessChildState({ actor, incarnation, latestTurn });
    const actions = deriveHarnessChildActions({
      actor,
      incarnation,
      latestTurn,
      binding,
    });
    const parsed = harnessChildProjectionSchema.parse({
      id: actor.id,
      revision: 1,
      title: actor.title,
      state,
      openedPaneId: binding?.paneId ?? null,
      ...actions,
      canStop: state !== "stopped" && state !== "quarantined",
    });
    return {
      id: parsed.id,
      title: parsed.title,
      state: parsed.state,
      openedPaneId: parsed.openedPaneId,
      canOpen: parsed.canOpen,
      canMessage: parsed.canMessage,
      canStop: parsed.canStop,
    };
  }

  #assertOpenEligible(evidence: ChildEvidence): void {
    if (!evidence.projection.canOpen) {
      invalidState("only a proven-idle unattached actor can be opened");
    }
  }

  #assertPreflightStillCurrent(current: ChildEvidence, preflight: OpenPreflight): void {
    const latestResult = this.#readLatestResult(current.actor.id);
    const sessionBinding = current.incarnation === null
      ? null
      : this.#requireLiveSessionBinding(current.incarnation);
    if (
      exactJson(current.actor) !== exactJson(preflight.child.actor) ||
      exactJson(current.incarnation) !== exactJson(preflight.child.incarnation) ||
      exactJson(current.latestTurn) !== exactJson(preflight.child.latestTurn) ||
      exactJson(current.witness) !== exactJson(preflight.child.witness) ||
      exactJson(latestResult) !== exactJson(preflight.latestResult) ||
      exactJson(sessionBinding) !== exactJson(preflight.sessionBinding)
    ) revisionConflict("the actor changed after renderer preflight");
  }

  #assertRepositoryStillCurrent(parent: Actor, repository: ChatRepository): void {
    const epoch = this.#actors.readActorEpoch(parent.epochId);
    if (epoch === null || epoch.projectId !== repository.id) {
      conflict("the actor epoch and repository identity conflict");
    }
    const projectValue: unknown = this.#database.query(`
      SELECT project_id, canonical_repository_path FROM projects
      WHERE project_id = ?1
    `).get(epoch.projectId);
    const project = projectRowSchema.parse(projectValue);
    if (project.canonical_repository_path !== repository.workingDirectory) {
      conflict("the actor repository path changed after admission");
    }
  }

  #assertParentRevision(parent: Actor, expected: number): void {
    if (this.#parentRevision(parent) !== expected) {
      revisionConflict("the parent projection revision changed");
    }
  }

  #parentRevision(parent: Actor): number {
    const children = this.#actors.listActorChildren({
      parentActorId: parent.id,
      afterActorId: null,
      limit: CHILD_PAGE_SIZE,
    });
    if (children.length === 0 || children.length > 50) {
      conflict("the parent child set is outside its durable bound");
    }
    return deriveHarnessParentProjectionRevision(children.map((child) =>
      witnessSchema().parse(this.#renderer.readProjectionWitness(child.id)).revision
    ));
  }

  #assertWitnessRevision(evidence: ChildEvidence, expected: number): void {
    if (evidence.witness.revision !== expected) {
      revisionConflict("the child projection revision changed");
    }
  }

  #rebindPaneToIncarnation(
    paneId: string,
    incarnation: ActorIncarnationRecord,
  ): Promise<void> {
    if (incarnation.providerThreadId === null) {
      conflict("the message-authorized actor incarnation lacks its provider thread");
    }
    const sessionBinding = this.#requireLiveSessionBinding(incarnation);
    const session = this.#sessions.readHarnessActorChatAttachment({
      accountProfileId: incarnation.accountProfileId,
      expectedGeneration: sessionBinding.liveGeneration,
      providerThreadId: incarnation.providerThreadId,
    });
    if (session === null) {
      conflict("the message-authorized actor session is unavailable");
    }
    return this.#rebindPane(paneId, incarnation.accountProfileId, session);
  }

  #requireLiveSessionBinding(
    incarnation: ActorIncarnationRecord,
  ): ActorSessionBindingRecordV2 {
    const bindingValue = this.#actors.readActorSessionBinding(incarnation.id);
    if (bindingValue === null) {
      conflict("the actor incarnation lacks its durable session binding");
    }
    const binding = actorSessionBindingRecordV2Schema.parse(bindingValue);
    if (
      (incarnation.state !== "idle" && incarnation.state !== "running") ||
      incarnation.providerThreadId === null || binding.state !== "bound" ||
      binding.incarnationId !== incarnation.id ||
      binding.actorId !== incarnation.actorId ||
      binding.accountProfileId !== incarnation.accountProfileId ||
      binding.admissionGeneration !== incarnation.processGeneration ||
      binding.providerThreadId !== incarnation.providerThreadId ||
      binding.liveGeneration < binding.admissionGeneration
    ) {
      conflict("the actor incarnation lacks its exact live session successor binding");
    }
    return binding;
  }

  #rebindPane(
    paneId: string,
    accountProfileId: string,
    session: Readonly<{ threadId: string; restartThreadId: string }>,
  ): Promise<void> {
    const before = this.#panes.require(paneId).projection;
    const pane = this.#panes.rebindAttachedHarnessSession({
      paneId: chatPaneIdSchema.parse(paneId),
      binding: {
        accountProfileId,
        threadId: session.threadId,
        restartThreadId: session.restartThreadId,
      },
      now: this.#now(),
    });
    return pane.revision === before.revision
      ? Promise.resolve()
      : Promise.resolve(this.#projection.paneChanged(pane));
  }
}

function repositorySchema() {
  return z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(160),
    workingDirectory: absolutePathSchema,
  }).strict();
}

function witnessSchema() {
  return z.object({
    actorId: actorIdSchema,
    revision: revisionSchema,
    semanticDigest: digestSchema,
  }).strict();
}

function actorPaneBindingId(actorId: string): string {
  return `hpanebinding_${digest("oprte.harness.actor-pane-binding.v2", actorId).slice(0, 40)}`;
}

function observerTurnId(actorTurnId: string): string {
  return `chatturn_${digest("oprte.harness.observer-turn.v2", actorTurnId).slice(0, 40)}`;
}

function attachedInputOperationId(actorId: string, chatTurnId: string): string {
  return `rendererinputop_${digestParts(
    "oprte.harness.renderer-attached-input-operation.v2",
    [actorId, chatTurnId],
  ).slice(0, 48)}`;
}

function attachedInputValueId(actorId: string, chatTurnId: string): string {
  return `ctxval_${digestParts(
    "oprte.harness.renderer-attached-input-value.v2",
    [actorId, chatTurnId],
  ).slice(0, 48)}`;
}

function attachedTurnIdempotencyKey(paneId: string, chatTurnId: string): string {
  return `renderer-message-${digestParts(
    "oprte.harness.renderer-attached-turn.v2",
    [paneId, chatTurnId],
  ).slice(0, 48)}`;
}

function actorAttemptId(turnId: string, incarnationId: string): string {
  const hash = createHash("sha256").update("oprte.attempt.v2\0", "utf8");
  hash.update(turnId, "utf8").update("\0", "utf8");
  hash.update(incarnationId, "utf8").update("\0", "utf8");
  return `hattempt_${hash.digest("base64url").slice(0, 48)}`;
}

function resultOutcomeForTurn(
  turn: ActorTurn & Readonly<{
    state: "succeeded" | "failed" | "cancelled" | "quotaRejected";
  }>,
): ActorResult["outcome"] {
  return turn.state;
}

function isDefinitiveTurn(
  turn: ActorTurn,
): turn is ActorTurn & Readonly<{
  state: "succeeded" | "failed" | "cancelled" | "quotaRejected";
}> {
  return turn.state === "succeeded" || turn.state === "failed" ||
    turn.state === "cancelled" || turn.state === "quotaRejected";
}

function attachedActorAttention(
  outcome: "cancelled" | "failed" | "quotaRejected",
) {
  switch (outcome) {
    case "quotaRejected":
      return Object.freeze({
        code: "all_accounts_exhausted" as const,
        message: "The actor's latest turn reached the available Codex usage limit. You can send another message later.",
        retryable: true,
      });
    case "cancelled":
      return Object.freeze({
        code: "turn_failed" as const,
        message: "The actor's latest turn was cancelled. You can send another message.",
        retryable: true,
      });
    case "failed":
      return Object.freeze({
        code: "turn_failed" as const,
        message: "The actor's latest turn failed. You can send another message.",
        retryable: true,
      });
  }
}

function digest(domain: string, identity: string): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(identity, "utf8")
    .digest("hex");
}

function digestParts(domain: string, identities: readonly string[]): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const identity of identities) {
    hash.update("\0", "utf8").update(identity, "utf8");
  }
  return hash.digest("hex");
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}

function invalidState(message: string): never {
  throw new HarnessRendererEffectsV2Error("invalid_state", message);
}

function notFound(message: string): never {
  throw new HarnessRendererEffectsV2Error("not_found", message);
}

function revisionConflict(message: string): never {
  throw new HarnessRendererEffectsV2Error("revision_conflict", message);
}

function conflict(message: string): never {
  throw new HarnessRendererEffectsV2Error("authority_conflict", message);
}
