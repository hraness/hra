import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import type { ActorContinuationIntentIdentityPortV2 } from
  "./actor-continuation-intent-identity-v2";
import type {
  PersistentActorContinuationAmbiguityCode,
  PersistentActorContinuationIntent,
  PersistentActorContinuationIntentMetadata,
  PersistentActorContinuationIntentPort,
  PersistentActorContinuationIntentState,
} from "./codex-persistent-actor-provider";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const intentIdSchema = z.string().length(78)
  .regex(/^hcontinuation_[0-9a-f]{64}$/u);
const isoTimestampSchema = z.string().datetime({ offset: true });
const metadataSchema = z.object({
  actorId: z.string().min(16).max(96).regex(/^hactor_[A-Za-z0-9_-]+$/u),
  actorTurnId: z.string().min(14).max(96).regex(/^hturn_[A-Za-z0-9_-]+$/u),
  clientUserMessageId: z.string().min(16).max(128)
    .refine((value) => !value.includes("\0")),
  historyDigest: digestSchema,
  historyItemCount: z.number().int().positive().max(1_024),
  historyUtf8Bytes: z.number().int().positive().max(16 * 1024 * 1024),
  sourceAccountProfileId: z.string().min(1).max(96)
    .refine((value) => !value.includes("\0")),
  sourceProcessGeneration: z.number().int().positive().safe(),
  sourceProviderThreadId: z.string().min(1).max(512)
    .refine((value) => !value.includes("\0")),
  sourceProviderTurnId: z.string().min(1).max(512)
    .refine((value) => !value.includes("\0")),
  targetAccountProfileId: z.string().min(1).max(96)
    .refine((value) => !value.includes("\0")),
  targetProcessGeneration: z.number().int().positive().safe(),
  targetProviderThreadId: z.string().min(1).max(512)
    .refine((value) => !value.includes("\0")),
}).strict();
const stateSchema = z.enum([
  "prepared",
  "injectionEffectStarted",
  "injected",
  "continueDispatchPrepared",
  "continueDispatchEffectStarted",
  "ambiguous",
  "supersededApplied",
  "supersededNotApplied",
]);
const ambiguityCodeSchema = z.enum([
  "history_identity_mismatch",
  "injection_readback_mismatch",
  "continue_definitively_absent_after_dispatch",
]);
const rowSchema = z.object({
  intent_id: intentIdSchema,
  actor_id: metadataSchema.shape.actorId,
  actor_turn_id: metadataSchema.shape.actorTurnId,
  target_process_generation: metadataSchema.shape.targetProcessGeneration,
  source_identity_digest: digestSchema,
  effect_identity_digest: digestSchema,
  metadata_digest: digestSchema,
  predecessor_intent_id: intentIdSchema.nullable(),
  recovery_proof_digest: digestSchema.nullable(),
  state: stateSchema,
  revision: z.number().int().positive().safe(),
  exact_readback_verified: z.union([z.literal(0), z.literal(1)]),
  absence_proof_digest: digestSchema.nullable(),
  ambiguity_code: ambiguityCodeSchema.nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  settled_at: isoTimestampSchema.nullable(),
}).strict();

export interface PersistentActorContinuationSQLiteAuthorityV2Options {
  readonly identities: ActorContinuationIntentIdentityPortV2;
  readonly now?: () => Date;
}

export class PersistentActorContinuationSQLiteAuthorityV2Error extends Error {
  readonly code: "conflict" | "unavailable";

  constructor(
    code: PersistentActorContinuationSQLiteAuthorityV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PersistentActorContinuationSQLiteAuthorityV2Error";
    this.code = code;
  }
}

/**
 * Durable, content-free continuation effect authority. SQLite receives only
 * HRA actor lineage, a keyed metadata handle, stages, and bounded evidence.
 */
export class PersistentActorContinuationSQLiteAuthorityV2
  implements PersistentActorContinuationIntentPort {
  readonly #database: Database;
  readonly #identities: ActorContinuationIntentIdentityPortV2;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: PersistentActorContinuationSQLiteAuthorityV2Options,
  ) {
    this.#database = database;
    this.#identities = options.identities;
    this.#now = options.now ?? (() => new Date());
  }

  async prepareInjection(
    inputValue: PersistentActorContinuationIntentMetadata,
  ): Promise<PersistentActorContinuationIntent> {
    const prepared = await this.#prepare(inputValue);
    return this.#database.transaction(() => {
      const existing = this.#readRow(prepared.intentId);
      if (existing !== null) {
        return this.#project(
          this.#requireMatchingRow(prepared),
          prepared.metadata,
        );
      }
      const collision: unknown = this.#database.query(`
        SELECT intent_id FROM harness_actor_continuation_intents
        WHERE source_identity_digest = ?1
          OR effect_identity_digest = ?2
          OR metadata_digest = ?3
        LIMIT 1
      `).get(
        prepared.sourceIdentityDigest,
        prepared.effectIdentityDigest,
        prepared.metadataDigest,
      );
      if (collision !== null) this.#conflict();
      const now = this.#timestamp();
      this.#database.query(`
        INSERT INTO harness_actor_continuation_intents (
          intent_id, actor_id, actor_turn_id, target_process_generation,
          source_identity_digest, effect_identity_digest, metadata_digest,
          predecessor_intent_id, recovery_proof_digest,
          state, revision, exact_readback_verified,
          absence_proof_digest, ambiguity_code,
          created_at, updated_at, settled_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL,
          'prepared', 1, 0, NULL, NULL, ?8, ?8, NULL
        )
      `).run(
        prepared.intentId,
        prepared.metadata.actorId,
        prepared.metadata.actorTurnId,
        prepared.metadata.targetProcessGeneration,
        prepared.sourceIdentityDigest,
        prepared.effectIdentityDigest,
        prepared.metadataDigest,
        now,
      );
      return this.#project(
        this.#requireRow(prepared.intentId),
        prepared.metadata,
      );
    })();
  }

  async readInjection(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
  }>): Promise<PersistentActorContinuationIntent | null> {
    const prepared = await this.#prepare(input.metadata);
    const row = this.#readRow(prepared.intentId);
    return row === null
      ? null
      : this.#project(this.#requireMatchingRow(prepared), prepared.metadata);
  }

  /**
   * Resolves the newest durable member of one source lineage. The caller
   * supplies every private field except the historical target generation;
   * that generation is read from SQLite and the complete keyed identity is
   * recomputed before any row is projected.
   */
  async readLatestInjection(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
  }>): Promise<PersistentActorContinuationIntent | null> {
    const current = await this.#prepare(input.metadata);
    const value: unknown = this.#database.query(`
      SELECT * FROM harness_actor_continuation_intents
      WHERE source_identity_digest = ?1
      ORDER BY target_process_generation DESC, created_at DESC
      LIMIT 1
    `).get(current.sourceIdentityDigest);
    if (value === null) return null;
    const row = rowSchema.parse(value);
    const historicalMetadata = metadataSchema.parse({
      ...current.metadata,
      targetProcessGeneration: row.target_process_generation,
    });
    const historical = await this.#prepare(historicalMetadata);
    return this.#project(
      this.#requireMatchingRow(historical),
      historical.metadata,
    );
  }

  async markInjectionEffectStarted(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
  }>): Promise<PersistentActorContinuationIntent> {
    return await this.#transition(input, "prepared", "injectionEffectStarted", {
      exactReadbackVerified: 0,
      absenceProofDigest: null,
      ambiguityCode: null,
    });
  }

  async settleInjectionApplied(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
    exactReadbackDigest: string;
  }>): Promise<PersistentActorContinuationIntent> {
    const metadata = metadataSchema.parse(input.metadata);
    if (digestSchema.parse(input.exactReadbackDigest) !== metadata.historyDigest) {
      this.#conflict();
    }
    return await this.#transition(
      { ...input, metadata },
      "injectionEffectStarted",
      "injected",
      {
        exactReadbackVerified: 1,
        absenceProofDigest: null,
        ambiguityCode: null,
      },
    );
  }

  async prepareContinueDispatch(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
  }>): Promise<PersistentActorContinuationIntent> {
    return await this.#transition(input, "injected", "continueDispatchPrepared", {
      exactReadbackVerified: 1,
      absenceProofDigest: null,
      ambiguityCode: null,
    });
  }

  async markContinueDispatchEffectStarted(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
    absenceProofDigest: string;
  }>): Promise<PersistentActorContinuationIntent> {
    return await this.#transition(
      input,
      "continueDispatchPrepared",
      "continueDispatchEffectStarted",
      {
        exactReadbackVerified: 1,
        absenceProofDigest: digestSchema.parse(input.absenceProofDigest),
        ambiguityCode: null,
      },
    );
  }

  async fenceInjectionAmbiguous(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
    proofCode: PersistentActorContinuationAmbiguityCode;
  }>): Promise<PersistentActorContinuationIntent> {
    const prepared = await this.#prepare(input.metadata);
    const expectedRevision = z.number().int().positive().safe()
      .parse(input.expectedRevision);
    const proofCode = ambiguityCodeSchema.parse(input.proofCode);
    return this.#database.transaction(() => {
      const current = this.#requireMatchingRow(prepared);
      if (current.revision !== expectedRevision || current.state === "ambiguous") {
        this.#conflict();
      }
      const now = this.#timestamp();
      const changed = this.#database.query(`
        UPDATE harness_actor_continuation_intents SET
          state = 'ambiguous', revision = revision + 1,
          ambiguity_code = ?3, updated_at = ?4, settled_at = ?4
        WHERE intent_id = ?1 AND revision = ?2
      `).run(prepared.intentId, expectedRevision, proofCode, now);
      if (changed.changes !== 1) this.#conflict();
      return this.#project(
        this.#requireRow(prepared.intentId),
        prepared.metadata,
      );
    })();
  }

  /**
   * Atomically closes one generation-local effect owner and, when recovery
   * still needs work, installs its strictly newer successor. A successor whose
   * exact history was already observed is advanced through the ordinary
   * prepared -> effect-started -> injected evidence path in the same SQLite
   * transaction, so no restart can expose it as permission to inject twice.
   */
  async supersedeForRecovery(input: Readonly<{
    predecessorMetadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
    recoveryProofDigest: string;
    predecessorState: "supersededApplied" | "supersededNotApplied";
    successorMetadata: PersistentActorContinuationIntentMetadata | null;
    successorHistoryApplied: boolean;
  }>): Promise<Readonly<{
    predecessor: PersistentActorContinuationIntent;
    successor: PersistentActorContinuationIntent | null;
  }>> {
    const predecessor = await this.#prepare(input.predecessorMetadata);
    const expectedRevision = z.number().int().positive().safe()
      .parse(input.expectedRevision);
    const recoveryProofDigest = digestSchema.parse(input.recoveryProofDigest);
    const predecessorState = z.enum([
      "supersededApplied",
      "supersededNotApplied",
    ]).parse(input.predecessorState);
    const successor = input.successorMetadata === null
      ? null
      : await this.#prepare(input.successorMetadata);
    if (
      (successor === null && (
        predecessorState !== "supersededApplied" ||
        input.successorHistoryApplied
      )) ||
      (successor !== null && (
        successor.metadata.targetProcessGeneration <=
          predecessor.metadata.targetProcessGeneration ||
        successor.sourceIdentityDigest !== predecessor.sourceIdentityDigest ||
        successor.metadata.actorId !== predecessor.metadata.actorId ||
        successor.metadata.actorTurnId !== predecessor.metadata.actorTurnId
      ))
    ) this.#conflict();

    return this.#database.transaction(() => {
      const current = this.#requireMatchingRow(predecessor);
      if (
        current.revision !== expectedRevision ||
        current.state === "ambiguous" ||
        current.state === "supersededApplied" ||
        current.state === "supersededNotApplied"
      ) this.#conflict();
      if (successor !== null && this.#readRow(successor.intentId) !== null) {
        this.#conflict();
      }
      const now = this.#timestamp();
      const settled = this.#database.query(`
        UPDATE harness_actor_continuation_intents SET
          state = ?3, revision = revision + 1,
          recovery_proof_digest = ?4,
          ambiguity_code = NULL, updated_at = ?5, settled_at = ?5
        WHERE intent_id = ?1 AND revision = ?2
      `).run(
        predecessor.intentId,
        expectedRevision,
        predecessorState,
        recoveryProofDigest,
        now,
      );
      if (settled.changes !== 1) this.#conflict();

      if (successor !== null) {
        this.#database.query(`
          INSERT INTO harness_actor_continuation_intents (
            intent_id, actor_id, actor_turn_id, target_process_generation,
            source_identity_digest, effect_identity_digest, metadata_digest,
            predecessor_intent_id, recovery_proof_digest,
            state, revision, exact_readback_verified,
            absence_proof_digest, ambiguity_code,
            created_at, updated_at, settled_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
            'prepared', 1, 0, NULL, NULL, ?10, ?10, NULL
          )
        `).run(
          successor.intentId,
          successor.metadata.actorId,
          successor.metadata.actorTurnId,
          successor.metadata.targetProcessGeneration,
          successor.sourceIdentityDigest,
          successor.effectIdentityDigest,
          successor.metadataDigest,
          predecessor.intentId,
          recoveryProofDigest,
          now,
        );
        if (input.successorHistoryApplied) {
          const started = this.#database.query(`
            UPDATE harness_actor_continuation_intents SET
              state = 'injectionEffectStarted', revision = 2,
              updated_at = ?2
            WHERE intent_id = ?1 AND revision = 1 AND state = 'prepared'
          `).run(successor.intentId, now);
          if (started.changes !== 1) this.#conflict();
          const injected = this.#database.query(`
            UPDATE harness_actor_continuation_intents SET
              state = 'injected', revision = 3,
              exact_readback_verified = 1, updated_at = ?2
            WHERE intent_id = ?1 AND revision = 2
              AND state = 'injectionEffectStarted'
          `).run(successor.intentId, now);
          if (injected.changes !== 1) this.#conflict();
        }
      }

      return Object.freeze({
        predecessor: this.#project(
          this.#requireRow(predecessor.intentId),
          predecessor.metadata,
        ),
        successor: successor === null
          ? null
          : this.#project(
              this.#requireRow(successor.intentId),
              successor.metadata,
            ),
      });
    })();
  }

  async #transition(
    input: Readonly<{
      metadata: PersistentActorContinuationIntentMetadata;
      expectedRevision: number;
    }>,
    expectedState: PersistentActorContinuationIntentState,
    nextState: PersistentActorContinuationIntentState,
    evidence: Readonly<{
      exactReadbackVerified: 0 | 1;
      absenceProofDigest: string | null;
      ambiguityCode: PersistentActorContinuationAmbiguityCode | null;
    }>,
  ): Promise<PersistentActorContinuationIntent> {
    const prepared = await this.#prepare(input.metadata);
    const expectedRevision = z.number().int().positive().safe()
      .parse(input.expectedRevision);
    return this.#database.transaction(() => {
      const current = this.#requireMatchingRow(prepared);
      if (
        current.revision !== expectedRevision ||
        current.state !== expectedState
      ) this.#conflict();
      const now = this.#timestamp();
      const changed = this.#database.query(`
        UPDATE harness_actor_continuation_intents SET
          state = ?3, revision = revision + 1,
          exact_readback_verified = ?4,
          absence_proof_digest = ?5, ambiguity_code = ?6,
          updated_at = ?7, settled_at = NULL
        WHERE intent_id = ?1 AND revision = ?2
      `).run(
        prepared.intentId,
        expectedRevision,
        nextState,
        evidence.exactReadbackVerified,
        evidence.absenceProofDigest,
        evidence.ambiguityCode,
        now,
      );
      if (changed.changes !== 1) this.#conflict();
      return this.#project(
        this.#requireRow(prepared.intentId),
        prepared.metadata,
      );
    })();
  }

  async #prepare(metadataValue: PersistentActorContinuationIntentMetadata) {
    const metadata = metadataSchema.parse(metadataValue);
    const lineageValue: unknown = this.#database.query(`
      SELECT turn.epoch_id
      FROM harness_actor_turns AS turn
      WHERE turn.turn_id = ?1 AND turn.actor_id = ?2
    `).get(metadata.actorTurnId, metadata.actorId);
    const lineage = z.object({ epoch_id: z.string().min(16).max(96) })
      .strict().parse(lineageValue);
    let sourceIdentityDigest: string;
    let effectIdentityDigest: string;
    let metadataDigest: string;
    try {
      const identity = z.object({
        sourceIdentityDigest: digestSchema,
        effectIdentityDigest: digestSchema,
        metadataDigest: digestSchema,
      }).strict().parse(await this.#identities.digest({
        epochId: lineage.epoch_id,
        metadata,
      }));
      sourceIdentityDigest = identity.sourceIdentityDigest;
      effectIdentityDigest = identity.effectIdentityDigest;
      metadataDigest = identity.metadataDigest;
    } catch (cause: unknown) {
      throw new PersistentActorContinuationSQLiteAuthorityV2Error(
        "unavailable",
        "Actor continuation identity custody is unavailable.",
        cause,
      );
    }
    return Object.freeze({
      intentId: intentIdSchema.parse(`hcontinuation_${effectIdentityDigest}`),
      metadata,
      sourceIdentityDigest,
      effectIdentityDigest,
      metadataDigest,
    });
  }

  #requireMatchingRow(prepared: Readonly<{
    intentId: string;
    metadata: PersistentActorContinuationIntentMetadata;
    sourceIdentityDigest: string;
    effectIdentityDigest: string;
    metadataDigest: string;
  }>) {
    const row = this.#requireRow(prepared.intentId);
    if (
      row.source_identity_digest !== prepared.sourceIdentityDigest ||
      row.effect_identity_digest !== prepared.effectIdentityDigest ||
      row.actor_id !== prepared.metadata.actorId ||
      row.actor_turn_id !== prepared.metadata.actorTurnId ||
      row.target_process_generation !==
        prepared.metadata.targetProcessGeneration
    ) this.#conflict();
    if (row.metadata_digest !== prepared.metadataDigest) {
      this.#fenceMetadataMismatch(row);
      this.#conflict();
    }
    return row;
  }

  #fenceMetadataMismatch(row: z.infer<typeof rowSchema>) {
    if (
      row.state === "ambiguous" ||
      row.state === "supersededApplied" ||
      row.state === "supersededNotApplied"
    ) return;
    const now = this.#timestamp();
    const changed = this.#database.query(`
      UPDATE harness_actor_continuation_intents SET
        state = 'ambiguous', revision = revision + 1,
        ambiguity_code = 'history_identity_mismatch',
        updated_at = ?3, settled_at = ?3
      WHERE intent_id = ?1 AND revision = ?2
    `).run(row.intent_id, row.revision, now);
    if (changed.changes !== 1) this.#conflict();
    this.#requireRow(row.intent_id);
  }

  #readRow(intentId: string) {
    const value: unknown = this.#database.query(`
      SELECT * FROM harness_actor_continuation_intents WHERE intent_id = ?1
    `).get(intentId);
    return value === null ? null : rowSchema.parse(value);
  }

  #requireRow(intentId: string) {
    const row = this.#readRow(intentId);
    if (row === null) this.#conflict();
    return row;
  }

  #project(
    row: z.infer<typeof rowSchema>,
    metadata: PersistentActorContinuationIntentMetadata,
  ): PersistentActorContinuationIntent {
    return Object.freeze({
      ...metadata,
      intentId: row.intent_id,
      state: row.state,
      revision: row.revision,
      predecessorIntentId: row.predecessor_intent_id,
      recoveryProofDigest: row.recovery_proof_digest,
      exactReadbackDigest: row.exact_readback_verified === 1
        ? metadata.historyDigest
        : null,
      absenceProofDigest: row.absence_proof_digest,
      ambiguityCode: row.ambiguity_code,
    });
  }

  #timestamp(): string {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new PersistentActorContinuationSQLiteAuthorityV2Error(
        "unavailable",
        "Actor continuation clock is unavailable.",
      );
    }
    return isoTimestampSchema.parse(now.toISOString());
  }

  #conflict(): never {
    throw new PersistentActorContinuationSQLiteAuthorityV2Error(
      "conflict",
      "Actor continuation intent changed or conflicts with durable evidence.",
    );
  }
}
