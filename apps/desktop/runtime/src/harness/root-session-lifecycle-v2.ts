import { z } from "@hra-internal/schema";

import { chatPaneIdSchema } from "../../../contracts/runtime";
import type { SessionTurnLifecycle } from "../sessions/session-service";
import {
  actorTurnIdSchema,
  isTerminalActorTurnState,
  type ActorTurn,
} from "./actor-domain";
import type { RecursiveBudget } from "./domain";
import type {
  HarnessRootActorAuthorityV2,
  HarnessRootActorAdmissionV2,
  HarnessRootActorPreparationV2,
  HarnessRootActorRecoveryV2,
} from "./root-actor-authority-v2";

const accountProfileIdSchema = z.string().min(1).max(96);
const canonicalTimestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);
const providerIdSchema = z.string().min(1).max(512)
  .refine((value) => !value.includes("\0"), "provider identity contains NUL");
const exactResolutionSchema = z.object({
  kind: z.literal("exact"),
  accountProfileId: accountProfileIdSchema,
  paneId: chatPaneIdSchema,
  providerThreadId: providerIdSchema,
  providerTurnId: providerIdSchema,
  rootTurnId: actorTurnIdSchema,
}).strict();
const ambiguousResolutionSchema = z.object({
  kind: z.literal("ambiguous"),
  accountProfileId: accountProfileIdSchema,
  providerThreadId: providerIdSchema,
  providerTurnId: providerIdSchema,
  candidateRootTurnIds: z.array(actorTurnIdSchema).min(2).max(16),
}).strict().superRefine((value, context) => {
  if (new Set(value.candidateRootTurnIds).size !== value.candidateRootTurnIds.length) {
    context.addIssue({
      code: "custom",
      message: "ambiguous root candidates must be distinct",
      path: ["candidateRootTurnIds"],
    });
  }
});
const lifecycleResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("foreign") }).strict(),
  exactResolutionSchema,
  ambiguousResolutionSchema,
]);

export interface HarnessRootPreparationInputV2 {
  readonly projectId: string;
  readonly sourceSha: string;
  readonly paneId: string;
  /** HRA-owned chat turn identity, stable across account continuation. */
  readonly chatTurnId: string;
  readonly title: string;
  readonly budget: RecursiveBudget;
  readonly createdAt?: string;
}

export interface HarnessRootTurnAdmissionInputV2
  extends HarnessRootPreparationInputV2 {
  readonly inputValueId: string;
}

/**
 * Resolves ephemeral SessionService identities to the one stable logical root
 * turn that is currently attached to the pane. It must report ambiguity
 * explicitly instead of choosing a candidate by order.
 */
export interface HarnessRootSessionLookupV2 {
  resolveCurrentRootTurn(event: SessionTurnLifecycle): Promise<unknown>;
}

export interface HarnessRootProjectionReconcilerV2 {
  reconcile(input: Readonly<{
    actorId: string;
    paneId: string;
  }>): void | Promise<void>;
}

export type HarnessRootLifecycleObservationV2 =
  | "duplicate"
  | "foreign"
  | "ignored_active"
  | "settled"
  | "stale";

export type HarnessRootPreProviderFailureV2 =
  | "provider_start_ambiguous"
  | "provider_unavailable";

export interface HarnessRecoveredRootTurnV2 {
  readonly actorId: string;
  readonly paneId: string;
  readonly turnId: string;
  readonly disposition: HarnessRootActorRecoveryV2["disposition"];
  readonly state: "ambiguous" | "failed" | "succeeded";
  readonly outcomeCode:
    | "codex_completed"
    | "codex_provider_start_ambiguous"
    | "codex_runtime_restarted_after_provider_start";
}

export class HarnessRootSessionLifecycleV2Error extends Error {
  readonly code:
    | "ambiguous_lineage"
    | "closed"
    | "corrupt_lineage"
    | "lookup_conflict";

  constructor(
    code: HarnessRootSessionLifecycleV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessRootSessionLifecycleV2Error";
    this.code = code;
  }
}

/**
 * Serialized composition seam between ordinary root chat turns and the v2
 * actor authority. Provider identities exist only during lookup and are never
 * used to derive or persist an epoch, actor, or logical turn identity.
 */
export class HarnessRootSessionLifecycleV2 {
  readonly #authority: HarnessRootActorAuthorityV2;
  readonly #lookup: HarnessRootSessionLookupV2;
  readonly #projections: HarnessRootProjectionReconcilerV2;
  #acceptingAdmissions = true;
  #acceptingObservations = true;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: Readonly<{
    authority: HarnessRootActorAuthorityV2;
    lookup: HarnessRootSessionLookupV2;
    projections: HarnessRootProjectionReconcilerV2;
  }>) {
    this.#authority = options.authority;
    this.#lookup = options.lookup;
    this.#projections = options.projections;
  }

  prepareRoot(
    input: HarnessRootPreparationInputV2,
  ): Promise<HarnessRootActorPreparationV2> {
    return this.#serializeAdmission(async () => {
      const prepared = this.#authority.prepareRoot(input);
      await this.#reconcile(prepared.actor.id, prepared.paneBinding.paneId);
      return prepared;
    });
  }

  admitRootTurn(
    input: HarnessRootTurnAdmissionInputV2,
  ): Promise<HarnessRootActorAdmissionV2> {
    return this.#serializeAdmission(async () => {
      const admitted = this.#authority.admitRoot(input);
      await this.#reconcile(admitted.actor.id, admitted.paneBinding.paneId);
      return admitted;
    });
  }

  observe(
    event: SessionTurnLifecycle,
  ): Promise<HarnessRootLifecycleObservationV2> {
    if (event.status === "inProgress") {
      return this.#acceptingObservations
        ? Promise.resolve("ignored_active")
        : Promise.reject(closedError());
    }
    return this.#serializeObservation(() => this.#observeTerminal(event));
  }

  /**
   * Settles every provider-neutral root turn left live by the prior gateway
   * before generic child reconciliation or chat restart cleanup can run.
   */
  reconcileOnBoot(): Promise<readonly HarnessRecoveredRootTurnV2[]> {
    return this.#serializeObservation(async () => {
      const recovered: HarnessRecoveredRootTurnV2[] = [];
      for (const candidate of this.#authority.listLiveRootTurnsForRecovery()) {
        const settlement = recoverySettlementFor(candidate.disposition);
        const turn = this.#authority.settleRootTurn({
          turnId: candidate.turnId,
          state: settlement.state,
          outcomeCode: settlement.outcomeCode,
        });
        assertRecoverySettlement(turn, settlement);
        await this.#reconcile(candidate.actorId, candidate.paneId);
        recovered.push(Object.freeze({ ...candidate, ...settlement }));
      }
      return Object.freeze(recovered);
    });
  }

  /**
   * Terminalizes an admitted root before any provider turn exists. This is a
   * provider-neutral escape hatch for a definitively unavailable provider or
   * an ambiguous start boundary; it cannot name or derive provider identity.
   */
  settleBeforeProvider(inputValue: Readonly<{
    turnId: string;
    paneId: string;
    failure: HarnessRootPreProviderFailureV2;
    settledAt?: string;
  }>): Promise<ActorTurn> {
    const input = z.object({
      turnId: actorTurnIdSchema,
      paneId: chatPaneIdSchema,
      failure: z.enum(["provider_start_ambiguous", "provider_unavailable"]),
      settledAt: canonicalTimestampSchema.optional(),
    }).strict().parse(inputValue);
    return this.#serializeObservation(async () => {
      const root = this.#authority.readRootTurn(input.turnId);
      if (root === null || root.paneBinding.paneId !== input.paneId) {
        throw new HarnessRootSessionLifecycleV2Error(
          "corrupt_lineage",
          "pre-provider settlement does not name the attached root turn",
        );
      }
      const settlement = preProviderSettlementFor(input.failure);
      const settled = this.#authority.settleRootTurn({
        turnId: root.turn.id,
        ...settlement,
        ...(input.settledAt === undefined
          ? {}
          : { settledAt: input.settledAt }),
      });
      if (
        settled.state !== settlement.state ||
        settled.outcomeCode !== settlement.outcomeCode
      ) {
        throw new HarnessRootSessionLifecycleV2Error(
          "corrupt_lineage",
          "root authority returned a different pre-provider settlement",
        );
      }
      await this.#reconcile(root.actor.id, root.paneBinding.paneId);
      return settled;
    });
  }

  /** Resolves after every operation admitted before this call has settled. */
  settled(): Promise<void> {
    return this.#tail;
  }

  /** Stops new root preparation/admission without dropping terminal facts. */
  closeAdmission(): void {
    this.#acceptingAdmissions = false;
  }

  /** Stops terminal observation synchronously after its provider source stops. */
  closeObservation(): void {
    this.#acceptingObservations = false;
  }

  async #observeTerminal(
    event: SessionTurnLifecycle,
  ): Promise<HarnessRootLifecycleObservationV2> {
    const resolved = lifecycleResolutionSchema.parse(
      await this.#lookup.resolveCurrentRootTurn(event),
    );
    if (resolved.kind === "foreign") return "foreign";
    if (
      resolved.accountProfileId !== event.accountProfileId ||
      resolved.providerThreadId !== event.threadId ||
      resolved.providerTurnId !== event.turnId
    ) {
      throw new HarnessRootSessionLifecycleV2Error(
        "lookup_conflict",
        "root lifecycle lookup did not echo the exact provider event",
      );
    }
    if (resolved.kind === "ambiguous") {
      throw new HarnessRootSessionLifecycleV2Error(
        "ambiguous_lineage",
        "multiple stable root turns claim the same provider lifecycle event",
      );
    }

    let root;
    try {
      root = this.#authority.readRootTurn(resolved.rootTurnId);
    } catch (cause: unknown) {
      throw new HarnessRootSessionLifecycleV2Error(
        "corrupt_lineage",
        "resolved root lifecycle lineage is not a valid attached root",
        cause,
      );
    }
    if (root === null || root.paneBinding.paneId !== resolved.paneId) {
      throw new HarnessRootSessionLifecycleV2Error(
        "corrupt_lineage",
        "resolved root lifecycle lineage is absent or attached elsewhere",
      );
    }

    const settlement = settlementFor(event);
    if (isTerminalActorTurnState(root.turn.state)) {
      if (
        root.turn.state !== settlement.state ||
        root.turn.outcomeCode !== settlement.outcomeCode
      ) return "stale";
      await this.#reconcile(root.actor.id, root.paneBinding.paneId);
      return "duplicate";
    }
    if (root.turn.state !== "running" && root.turn.state !== "starting") {
      throw new HarnessRootSessionLifecycleV2Error(
        "corrupt_lineage",
        "only the exact live root logical turn may consume a terminal event",
      );
    }

    const settled = this.#authority.settleRootTurn({
      turnId: root.turn.id,
      ...settlement,
    });
    assertExactSettlement(settled, settlement);
    await this.#reconcile(root.actor.id, root.paneBinding.paneId);
    return "settled";
  }

  #reconcile(actorId: string, paneId: string): Promise<void> {
    return Promise.resolve(this.#projections.reconcile({ actorId, paneId }));
  }

  #serializeAdmission<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#acceptingAdmissions) return Promise.reject(closedError());
    return this.#append(operation);
  }

  #serializeObservation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#acceptingObservations) return Promise.reject(closedError());
    return this.#append(operation);
  }

  #append<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function recoverySettlementFor(
  disposition: HarnessRootActorRecoveryV2["disposition"],
): Readonly<{
  state: "ambiguous" | "failed" | "succeeded";
  outcomeCode: HarnessRecoveredRootTurnV2["outcomeCode"];
}> {
  switch (disposition) {
    case "completed":
      return { state: "succeeded", outcomeCode: "codex_completed" };
    case "active_after_provider_start":
      return {
        state: "failed",
        outcomeCode: "codex_runtime_restarted_after_provider_start",
      };
    case "active_before_provider_start":
      return {
        state: "ambiguous",
        outcomeCode: "codex_provider_start_ambiguous",
      };
  }
}

function settlementFor(event: SessionTurnLifecycle): Readonly<{
  state: "succeeded" | "failed" | "cancelled";
  outcomeCode: string;
}> {
  switch (event.status) {
    case "completed":
      return { state: "succeeded", outcomeCode: "codex_completed" };
    case "interrupted":
      return { state: "cancelled", outcomeCode: "codex_interrupted" };
    case "failed":
      return event.quotaProof === "provider_usage_limit_exceeded"
        ? { state: "failed", outcomeCode: "codex_usage_limit_exceeded" }
        : { state: "failed", outcomeCode: "codex_failed" };
    case "inProgress":
      throw new HarnessRootSessionLifecycleV2Error(
        "corrupt_lineage",
        "an active turn cannot be settled",
      );
  }
}

function preProviderSettlementFor(
  failure: HarnessRootPreProviderFailureV2,
): Readonly<{
  state: "ambiguous" | "failed";
  outcomeCode: string;
}> {
  return failure === "provider_start_ambiguous"
    ? { state: "ambiguous", outcomeCode: "codex_provider_start_ambiguous" }
    : { state: "failed", outcomeCode: "codex_provider_unavailable_before_start" };
}

function assertExactSettlement(
  turn: ActorTurn,
  expected: Readonly<{
    state: "succeeded" | "failed" | "cancelled";
    outcomeCode: string;
  }>,
): void {
  if (turn.state !== expected.state || turn.outcomeCode !== expected.outcomeCode) {
    throw new HarnessRootSessionLifecycleV2Error(
      "corrupt_lineage",
      "root authority returned a different terminal settlement",
    );
  }
}

function assertRecoverySettlement(
  turn: ActorTurn,
  expected: Readonly<{
    state: "ambiguous" | "failed" | "succeeded";
    outcomeCode: HarnessRecoveredRootTurnV2["outcomeCode"];
  }>,
): void {
  if (turn.state !== expected.state || turn.outcomeCode !== expected.outcomeCode) {
    throw new HarnessRootSessionLifecycleV2Error(
      "corrupt_lineage",
      "root authority returned a different restart settlement",
    );
  }
}

function closedError(): HarnessRootSessionLifecycleV2Error {
  return new HarnessRootSessionLifecycleV2Error(
    "closed",
    "root session lifecycle is closed",
  );
}
