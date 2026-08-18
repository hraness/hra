import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  chatPaneIdSchema,
  chatTurnIdSchema,
} from "../../../contracts/runtime";
import {
  HRA_ROOT_TURN_ROUTING_POLICY_VERSION,
  rootTurnRoutingClassificationV1Schema,
  rootTurnRoutingClassificationReasonSchema,
  rootTurnRoutingOperationalOutcomeSchema,
  rootTurnRoutingProfileFallbackReasonSchema,
  rootTurnRoutingProfileSchema,
  rootTurnRoutingReceiptV1Schema,
  rootTurnRoutingServiceTierFallbackReasonSchema,
  rootTurnRoutingServiceTierSchema,
  rootTurnRoutingStateSchema,
  rootTurnRoutingWorkClassSchema,
  type RootTurnRoutingClassificationV1,
  type RootTurnRoutingOperationalOutcomeV1,
  type RootTurnRoutingProfileFallbackReasonV1,
  type RootTurnRoutingProfileV1,
  type RootTurnRoutingReceiptV1,
  type RootTurnRoutingServiceTierFallbackReasonV1,
  type RootTurnRoutingServiceTierV1,
  type RootTurnRoutingStateV1,
} from "../state/root-turn-routing-schema-v1";
import { actorTurnIdSchema } from "./actor-domain";
import { deriveRootActorTurnId } from "./root-actor-authority-v2";

const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);
const generationSchema = z.number().int().positive().safe();
const streamPositionSchema = z.number().int().nonnegative().safe();
const recoveryLimitSchema = z.number().int().positive().max(256);
const rootLineageRowSchema = z.object({
  epoch_id: z.string().min(16).max(96),
  actor_id: z.string().min(16).max(96),
  pane_id: chatPaneIdSchema,
  binding_state: z.literal("attached"),
}).strict();

const receiptRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  chat_turn_id: chatTurnIdSchema,
  root_turn_id: actorTurnIdSchema.nullable(),
  policy_version: z.literal(HRA_ROOT_TURN_ROUTING_POLICY_VERSION),
  classification_reason: rootTurnRoutingClassificationReasonSchema,
  work_class: rootTurnRoutingWorkClassSchema,
  requested_profile: rootTurnRoutingProfileSchema,
  requested_service_tier: rootTurnRoutingServiceTierSchema,
  state: rootTurnRoutingStateSchema,
  selected_profile: rootTurnRoutingProfileSchema.nullable(),
  profile_fallback_reason:
    rootTurnRoutingProfileFallbackReasonSchema.nullable(),
  selected_service_tier: rootTurnRoutingServiceTierSchema.nullable(),
  service_tier_fallback_reason:
    rootTurnRoutingServiceTierFallbackReasonSchema.nullable(),
  operational_outcome: rootTurnRoutingOperationalOutcomeSchema.nullable(),
  accepted_generation: generationSchema.nullable(),
  accepted_stream_position: streamPositionSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  resolved_at: timestampSchema.nullable(),
  effect_started_at: timestampSchema.nullable(),
  accepted_at: timestampSchema.nullable(),
  settled_at: timestampSchema.nullable(),
}).strict();

export type RootTurnRoutingClassificationAdmissionV1 =
  RootTurnRoutingClassificationV1 & Readonly<{ readonly now: Date }>;

export interface RootTurnRoutingAuthorityV1 {
  admitClassification(
    input: RootTurnRoutingClassificationAdmissionV1,
  ): RootTurnRoutingReceiptV1;
  bindRootTurn(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    rootTurnId: string;
    now: Date;
  }>): RootTurnRoutingReceiptV1;
  resolve(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    selectedProfile: RootTurnRoutingProfileV1;
    profileFallbackReason: RootTurnRoutingProfileFallbackReasonV1 | null;
    selectedServiceTier: RootTurnRoutingServiceTierV1;
    serviceTierFallbackReason:
      RootTurnRoutingServiceTierFallbackReasonV1 | null;
    now: Date;
  }>): RootTurnRoutingReceiptV1;
  markEffectStarted(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    now: Date;
  }>): RootTurnRoutingReceiptV1;
  accept(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    acceptedGeneration: number;
    acceptedStreamPosition: number;
    now: Date;
  }>): RootTurnRoutingReceiptV1;
  settle(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    outcome: RootTurnRoutingOperationalOutcomeV1;
    now: Date;
  }>): RootTurnRoutingReceiptV1;
  readTurnRouting(
    paneId: string,
    chatTurnId: string,
  ): RootTurnRoutingReceiptV1 | null;
  readLatestTurnRouting(paneId: string): RootTurnRoutingReceiptV1 | null;
}

export class RootTurnRoutingAuthorityV1Error extends Error {
  readonly code: "conflict" | "corrupt_state" | "invalid_state" | "not_found";

  constructor(
    code: RootTurnRoutingAuthorityV1Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RootTurnRoutingAuthorityV1Error";
    this.code = code;
  }
}

/**
 * Owns the content-free per-root route receipt. Classification admission is
 * exposed in a transaction-neutral form only so ChatPaneStore can commit it
 * with the logical chat turn. Every later provider cut is serialized by the
 * per-pane ChatService lane and additionally guarded by SQLite state CAS.
 */
export class RootTurnRoutingSQLiteAuthorityV1 implements
  RootTurnRoutingAuthorityV1 {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  admitClassification(
    input: RootTurnRoutingClassificationAdmissionV1,
  ): RootTurnRoutingReceiptV1 {
    return this.#wrap("routing classification conflicts with durable evidence", () =>
      this.#database.transaction(() =>
        this.admitClassificationInTransaction(input)
      )()
    );
  }

  /** Must be called only inside the chat turn admission transaction. */
  admitClassificationInTransaction(
    input: RootTurnRoutingClassificationAdmissionV1,
  ): RootTurnRoutingReceiptV1 {
    const classification = rootTurnRoutingClassificationV1Schema.parse({
      paneId: input.paneId,
      chatTurnId: input.chatTurnId,
      policyVersion: input.policyVersion,
      classificationReason: input.classificationReason,
      workClass: input.workClass,
      requestedProfile: input.requestedProfile,
      requestedServiceTier: input.requestedServiceTier,
    });
    const createdAt = exactTimestamp(input.now);
    const existing = this.readTurnRouting(
      classification.paneId,
      classification.chatTurnId,
    );
    if (existing !== null) {
      if (!classificationMatches(existing, classification)) {
        conflict("the chat turn has a different routing classification");
      }
      return existing;
    }
    this.#database.query(`
      INSERT INTO harness_root_turn_routing_receipts (
        pane_id, chat_turn_id, root_turn_id, policy_version,
        classification_reason, work_class, requested_profile,
        requested_service_tier, state, selected_profile,
        profile_fallback_reason, selected_service_tier,
        service_tier_fallback_reason,
        operational_outcome, accepted_generation, accepted_stream_position,
        created_at, updated_at, resolved_at, effect_started_at, accepted_at,
        settled_at
      ) VALUES (
        ?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7,
        'classified', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ?8, ?8, NULL, NULL, NULL, NULL
      )
    `).run(
      classification.paneId,
      classification.chatTurnId,
      classification.policyVersion,
      classification.classificationReason,
      classification.workClass,
      classification.requestedProfile,
      classification.requestedServiceTier,
      createdAt,
    );
    return this.#require(
      classification.paneId,
      classification.chatTurnId,
    );
  }

  bindRootTurn(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    rootTurnId: string;
    now: Date;
  }>): RootTurnRoutingReceiptV1 {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const chatTurnId = chatTurnIdSchema.parse(input.chatTurnId);
    const rootTurnId = actorTurnIdSchema.parse(input.rootTurnId);
    return this.#mutate("root turn binding conflicts with durable evidence", () => {
      const current = this.#require(paneId, chatTurnId);
      if (current.rootTurnId !== null) {
        if (current.rootTurnId !== rootTurnId) {
          conflict("the routing receipt is bound to a different root turn");
        }
        return current;
      }
      if (current.state !== "classified") {
        invalidState("the routing receipt resolved before root binding");
      }
      const lineageValue: unknown = this.#database.query(`
        SELECT turn.epoch_id, turn.actor_id, binding.pane_id,
          binding.state AS binding_state
        FROM harness_actor_turns AS turn
        JOIN harness_actors AS actor ON actor.actor_id = turn.actor_id
        JOIN harness_actor_pane_bindings AS binding
          ON binding.actor_id = actor.actor_id
        WHERE turn.turn_id = ?1
          AND actor.parent_actor_id IS NULL
          AND actor.work_class = 'standard'
          AND binding.state = 'attached'
        LIMIT 2
      `).get(rootTurnId);
      if (lineageValue === null) {
        conflict("the root turn lacks an attached standard-root lineage");
      }
      let lineage: z.infer<typeof rootLineageRowSchema>;
      try {
        lineage = rootLineageRowSchema.parse(lineageValue);
      } catch (cause: unknown) {
        throw new RootTurnRoutingAuthorityV1Error(
          "corrupt_state",
          "the root routing lineage is invalid",
          cause,
        );
      }
      if (
        lineage.pane_id !== paneId ||
        rootTurnId !== deriveRootActorTurnId(lineage.epoch_id, chatTurnId)
      ) {
        conflict("the root turn does not belong to this exact pane chat turn");
      }
      const now = advancingTimestamp(input.now, current.updatedAt);
      const result = this.#database.query(`
        UPDATE harness_root_turn_routing_receipts
        SET root_turn_id = ?1, updated_at = ?2
        WHERE pane_id = ?3 AND chat_turn_id = ?4
          AND root_turn_id IS NULL AND state = 'classified'
      `).run(rootTurnId, now, paneId, chatTurnId);
      if (result.changes !== 1) invalidState("the routing receipt changed before root binding");
      return this.#require(paneId, chatTurnId);
    });
  }

  resolve(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    selectedProfile: RootTurnRoutingProfileV1;
    profileFallbackReason: RootTurnRoutingProfileFallbackReasonV1 | null;
    selectedServiceTier: RootTurnRoutingServiceTierV1;
    serviceTierFallbackReason:
      RootTurnRoutingServiceTierFallbackReasonV1 | null;
    now: Date;
  }>): RootTurnRoutingReceiptV1 {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const chatTurnId = chatTurnIdSchema.parse(input.chatTurnId);
    const selectedProfile = rootTurnRoutingProfileSchema.parse(
      input.selectedProfile,
    );
    const profileFallbackReason = input.profileFallbackReason === null
      ? null
      : rootTurnRoutingProfileFallbackReasonSchema.parse(
          input.profileFallbackReason,
        );
    const selectedServiceTier = rootTurnRoutingServiceTierSchema.parse(
      input.selectedServiceTier,
    );
    const serviceTierFallbackReason = input.serviceTierFallbackReason === null
      ? null
      : rootTurnRoutingServiceTierFallbackReasonSchema.parse(
          input.serviceTierFallbackReason,
        );
    return this.#mutate("root route resolution conflicts with durable evidence", () => {
      const current = this.#require(paneId, chatTurnId);
      assertResolution(
        current,
        selectedProfile,
        profileFallbackReason,
        selectedServiceTier,
        serviceTierFallbackReason,
      );
      if (current.selectedProfile !== null) {
        if (
          current.selectedProfile !== selectedProfile ||
          current.profileFallbackReason !== profileFallbackReason ||
          current.selectedServiceTier !== selectedServiceTier ||
          current.serviceTierFallbackReason !== serviceTierFallbackReason
        ) conflict("the routing receipt has a different resolved route");
        return current;
      }
      if (current.state !== "classified") {
        invalidState("the routing receipt can no longer be resolved");
      }
      const now = advancingTimestamp(input.now, current.updatedAt);
      const result = this.#database.query(`
        UPDATE harness_root_turn_routing_receipts
        SET state = 'resolved', selected_profile = ?1,
            profile_fallback_reason = ?2, selected_service_tier = ?3,
            service_tier_fallback_reason = ?4,
            resolved_at = ?5, updated_at = ?5
        WHERE pane_id = ?6 AND chat_turn_id = ?7
          AND state = 'classified' AND selected_profile IS NULL
          AND selected_service_tier IS NULL
      `).run(
        selectedProfile,
        profileFallbackReason,
        selectedServiceTier,
        serviceTierFallbackReason,
        now,
        paneId,
        chatTurnId,
      );
      if (result.changes !== 1) invalidState("the routing receipt changed before resolution");
      return this.#require(paneId, chatTurnId);
    });
  }

  markEffectStarted(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    now: Date;
  }>): RootTurnRoutingReceiptV1 {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const chatTurnId = chatTurnIdSchema.parse(input.chatTurnId);
    return this.#mutate("root route effect evidence conflicts with durable state", () => {
      const current = this.#require(paneId, chatTurnId);
      if (current.effectStartedAt !== null) return current;
      if (current.state !== "resolved") {
        invalidState("the provider effect requires a resolved root route");
      }
      const now = advancingTimestamp(input.now, current.updatedAt);
      const result = this.#database.query(`
        UPDATE harness_root_turn_routing_receipts
        SET state = 'effectStarted', effect_started_at = ?1, updated_at = ?1
        WHERE pane_id = ?2 AND chat_turn_id = ?3
          AND state = 'resolved' AND effect_started_at IS NULL
      `).run(now, paneId, chatTurnId);
      if (result.changes !== 1) invalidState("the routing receipt changed before provider effect");
      return this.#require(paneId, chatTurnId);
    });
  }

  accept(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    acceptedGeneration: number;
    acceptedStreamPosition: number;
    now: Date;
  }>): RootTurnRoutingReceiptV1 {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const chatTurnId = chatTurnIdSchema.parse(input.chatTurnId);
    const generation = generationSchema.parse(input.acceptedGeneration);
    const streamPosition = streamPositionSchema.parse(
      input.acceptedStreamPosition,
    );
    return this.#mutate("root route acceptance conflicts with durable evidence", () => {
      const current = this.#require(paneId, chatTurnId);
      if (current.acceptedAt !== null) {
        if (
          current.acceptedGeneration !== generation ||
          current.acceptedStreamPosition !== streamPosition
        ) conflict("the routing receipt has a different accepted response cursor");
        return current;
      }
      if (current.state !== "effectStarted") {
        invalidState("the root route has no effect awaiting acceptance");
      }
      const now = advancingTimestamp(input.now, current.updatedAt);
      const result = this.#database.query(`
        UPDATE harness_root_turn_routing_receipts
        SET state = 'accepted', accepted_generation = ?1,
            accepted_stream_position = ?2, accepted_at = ?3,
            updated_at = ?3
        WHERE pane_id = ?4 AND chat_turn_id = ?5
          AND state = 'effectStarted' AND accepted_at IS NULL
      `).run(generation, streamPosition, now, paneId, chatTurnId);
      if (result.changes !== 1) invalidState("the routing receipt changed before acceptance");
      return this.#require(paneId, chatTurnId);
    });
  }

  settle(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    outcome: RootTurnRoutingOperationalOutcomeV1;
    now: Date;
  }>): RootTurnRoutingReceiptV1 {
    return this.#mutate("root route settlement conflicts with durable evidence", () =>
      this.settleInTransaction(input)
    );
  }

  /** Must be called only inside an existing serialized SQLite transaction. */
  settleInTransaction(input: Readonly<{
    paneId: string;
    chatTurnId: string;
    outcome: RootTurnRoutingOperationalOutcomeV1;
    now: Date;
  }>): RootTurnRoutingReceiptV1 {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const chatTurnId = chatTurnIdSchema.parse(input.chatTurnId);
    const outcome = rootTurnRoutingOperationalOutcomeSchema.parse(
      input.outcome,
    );
    const state = stateForOutcome(outcome);
    const current = this.#require(paneId, chatTurnId);
    if (current.settledAt !== null) {
      if (current.state !== state || current.operationalOutcome !== outcome) {
        conflict("the routing receipt has a different terminal outcome");
      }
      return current;
    }
    assertSettlementAllowed(current, outcome);
    const now = advancingTimestamp(input.now, current.updatedAt);
    const result = this.#database.query(`
      UPDATE harness_root_turn_routing_receipts
      SET state = ?1, operational_outcome = ?2,
          settled_at = ?3, updated_at = ?3
      WHERE pane_id = ?4 AND chat_turn_id = ?5
        AND state NOT IN ('terminal', 'ambiguous', 'notApplied')
        AND settled_at IS NULL
    `).run(state, outcome, now, paneId, chatTurnId);
    if (result.changes !== 1) invalidState("the routing receipt changed before settlement");
    return this.#require(paneId, chatTurnId);
  }

  readTurnRouting(
    paneIdValue: string,
    chatTurnIdValue: string,
  ): RootTurnRoutingReceiptV1 | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const chatTurnId = chatTurnIdSchema.parse(chatTurnIdValue);
    const value: unknown = this.#database.query(`
      SELECT * FROM harness_root_turn_routing_receipts
      WHERE pane_id = ?1 AND chat_turn_id = ?2
    `).get(paneId, chatTurnId);
    return value === null ? null : parseReceipt(value);
  }

  readLatestTurnRouting(paneIdValue: string): RootTurnRoutingReceiptV1 | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const value: unknown = this.#database.query(`
      SELECT * FROM harness_root_turn_routing_receipts
      WHERE pane_id = ?1
      ORDER BY created_at DESC, chat_turn_id DESC
      LIMIT 1
    `).get(paneId);
    return value === null ? null : parseReceipt(value);
  }

  listUnsettled(input: Readonly<{ limit: number }>): readonly RootTurnRoutingReceiptV1[] {
    const limit = recoveryLimitSchema.parse(input.limit);
    const values: unknown[] = this.#database.query(`
      SELECT * FROM harness_root_turn_routing_receipts
      WHERE state IN ('classified', 'resolved', 'effectStarted', 'accepted')
      ORDER BY updated_at, pane_id, chat_turn_id
      LIMIT ?1
    `).all(limit);
    return values.map(parseReceipt);
  }

  #require(paneId: string, chatTurnId: string): RootTurnRoutingReceiptV1 {
    const receipt = this.readTurnRouting(paneId, chatTurnId);
    if (receipt === null) {
      throw new RootTurnRoutingAuthorityV1Error(
        "not_found",
        "the root routing receipt is unavailable",
      );
    }
    return receipt;
  }

  #mutate(
    message: string,
    operation: () => RootTurnRoutingReceiptV1,
  ): RootTurnRoutingReceiptV1 {
    return this.#wrap(message, () => this.#database.transaction(operation)());
  }

  #wrap<T>(message: string, operation: () => T): T {
    try {
      return operation();
    } catch (cause: unknown) {
      if (cause instanceof RootTurnRoutingAuthorityV1Error) throw cause;
      throw new RootTurnRoutingAuthorityV1Error("conflict", message, cause);
    }
  }
}

function parseReceipt(value: unknown): RootTurnRoutingReceiptV1 {
  let row: z.infer<typeof receiptRowSchema>;
  try {
    row = receiptRowSchema.parse(value);
  } catch (cause: unknown) {
    throw new RootTurnRoutingAuthorityV1Error(
      "corrupt_state",
      "stored root routing evidence is invalid",
      cause,
    );
  }
  try {
    return rootTurnRoutingReceiptV1Schema.parse({
      paneId: row.pane_id,
      chatTurnId: row.chat_turn_id,
      rootTurnId: row.root_turn_id,
      policyVersion: row.policy_version,
      classificationReason: row.classification_reason,
      workClass: row.work_class,
      requestedProfile: row.requested_profile,
      requestedServiceTier: row.requested_service_tier,
      state: row.state,
      selectedProfile: row.selected_profile,
      profileFallbackReason: row.profile_fallback_reason,
      selectedServiceTier: row.selected_service_tier,
      serviceTierFallbackReason: row.service_tier_fallback_reason,
      operationalOutcome: row.operational_outcome,
      acceptedGeneration: row.accepted_generation,
      acceptedStreamPosition: row.accepted_stream_position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      effectStartedAt: row.effect_started_at,
      acceptedAt: row.accepted_at,
      settledAt: row.settled_at,
    });
  } catch (cause: unknown) {
    throw new RootTurnRoutingAuthorityV1Error(
      "corrupt_state",
      "stored root routing evidence is incoherent",
      cause,
    );
  }
}

function classificationMatches(
  receipt: RootTurnRoutingReceiptV1,
  classification: RootTurnRoutingClassificationV1,
): boolean {
  return receipt.paneId === classification.paneId &&
    receipt.chatTurnId === classification.chatTurnId &&
    receipt.policyVersion === classification.policyVersion &&
    receipt.classificationReason === classification.classificationReason &&
    receipt.workClass === classification.workClass &&
    receipt.requestedProfile === classification.requestedProfile &&
    receipt.requestedServiceTier === classification.requestedServiceTier;
}

function assertResolution(
  current: RootTurnRoutingReceiptV1,
  selectedProfile: RootTurnRoutingProfileV1,
  profileFallbackReason: RootTurnRoutingProfileFallbackReasonV1 | null,
  selectedServiceTier: RootTurnRoutingServiceTierV1,
  serviceTierFallbackReason: RootTurnRoutingServiceTierFallbackReasonV1 | null,
): void {
  if (profileFallbackReason === null) {
    if (selectedProfile !== current.requestedProfile) {
      conflict("a root route may differ from its request only through Luna fallback");
    }
  } else if (
    current.requestedProfile !== "lunaMax" ||
    selectedProfile !== "solMax" ||
    profileFallbackReason !== "lunaUnavailable"
  ) conflict("the root route fallback is incoherent");

  if (serviceTierFallbackReason === null) {
    if (selectedServiceTier !== current.requestedServiceTier) {
      conflict("a root route tier may differ only through Fast fallback");
    }
  } else if (
    current.requestedServiceTier !== "fast" ||
    selectedServiceTier !== "standard" ||
    serviceTierFallbackReason !== "fastUnavailable"
  ) conflict("the root route service-tier fallback is incoherent");
}

function assertSettlementAllowed(
  current: RootTurnRoutingReceiptV1,
  outcome: RootTurnRoutingOperationalOutcomeV1,
): void {
  if (outcome === "notApplied") {
    if (
      current.effectStartedAt !== null ||
      (current.state !== "classified" && current.state !== "resolved")
    ) invalidState("a provider effect cannot settle as not applied");
    return;
  }
  if (outcome === "succeeded" && current.state !== "accepted") {
    invalidState("a successful route requires an accepted provider response");
  }
  if (outcome !== "succeeded" && current.effectStartedAt === null) {
    invalidState("a provider outcome requires a started provider effect");
  }
}

function stateForOutcome(
  outcome: RootTurnRoutingOperationalOutcomeV1,
): RootTurnRoutingStateV1 {
  if (outcome === "notApplied") return "notApplied";
  if (outcome === "ambiguous") return "ambiguous";
  return "terminal";
}

function exactTimestamp(now: Date): string {
  return timestampSchema.parse(now.toISOString());
}

function advancingTimestamp(now: Date, prior: string): string {
  const timestamp = exactTimestamp(now);
  if (timestamp < prior) conflict("root routing time moved backwards");
  return timestamp;
}

function conflict(message: string): never {
  throw new RootTurnRoutingAuthorityV1Error("conflict", message);
}

function invalidState(message: string): never {
  throw new RootTurnRoutingAuthorityV1Error("invalid_state", message);
}
