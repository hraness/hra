import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  chatPaneIdSchema,
  harnessChildProjectionSchema,
  harnessProposalSummaryProjectionSchema,
  harnessSettingsProjectionSchema,
  runtimeChatPaneLimit,
  runtimeHarnessProposalProjectionLimit,
  type HarnessChildProjection,
} from "../../../contracts/runtime";
import {
  actorIdSchema,
  actorTurnIdSchema,
  type Actor,
  type ActorTurn,
} from "./actor-domain";
import {
  deriveHarnessChildActions,
  deriveHarnessChildState,
  harnessChildSemanticDigest,
  type HarnessRendererActorReadPort,
  type HarnessRendererProposalReadPort,
  type HarnessRendererSettingsAuthorityPort,
} from "./renderer-authority-v2";
import {
  HarnessSQLiteAuthorityV2,
  type ActorIncarnationRecord,
  type ActorPaneBinding,
} from "./sqlite-authority-v2";

const PROJECTION_WITNESS_TABLE = "harness_actor_projection_witnesses";
const MIB = 1024 * 1024;
export const harnessProjectionReconciliationPageLimit = 128;

const revisionSchema = z.number().int().positive().safe();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const storedBooleanSchema = z.union([z.literal(0), z.literal(1)]);

const settingsRowSchema = z.object({
  singleton: z.literal(1),
  revision: revisionSchema,
  recursive_sessions_enabled: storedBooleanSchema,
  context_quota_bytes: harnessSettingsProjectionSchema.shape.contextQuotaBytes,
  refinement_mode: harnessSettingsProjectionSchema.shape.refinementMode,
  updated_at: timestampSchema,
}).strict();

const proposalRowSchema = z.object({
  proposal_id: harnessProposalSummaryProjectionSchema.shape.id,
  revision: revisionSchema,
  title: harnessProposalSummaryProjectionSchema.shape.title,
}).strict();

const preparedProposalRowSchema = z.object({
  proposal_id: harnessProposalSummaryProjectionSchema.shape.id,
}).strict();

const paneIdRowSchema = z.object({ pane_id: chatPaneIdSchema }).strict();
const actorIdRowSchema = z.object({ actor_id: actorIdSchema }).strict();
const turnIdRowSchema = z.object({ turn_id: actorTurnIdSchema }).strict();

const projectionWitnessRowSchema = z.object({
  actor_id: actorIdSchema,
  revision: revisionSchema,
  semantic_digest: digestSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

const settingsUpdateSchema = z.object({
  expectedHarnessRevision: revisionSchema,
  expectedSettingsRevision: revisionSchema,
  recursiveSessionsEnabled: z.boolean(),
  contextQuotaBytes: z.number().int().min(MIB).max(64 * MIB)
    .refine((value) => value % MIB === 0, "context quota must use whole MiB"),
  refinementMode: harnessSettingsProjectionSchema.shape.refinementMode,
}).strict();

const proposalListSchema = z.object({
  afterProposalId: harnessProposalSummaryProjectionSchema.shape.id.nullable(),
  limit: z.number().int().min(1).max(runtimeHarnessProposalProjectionLimit),
}).strict();

const paneListSchema = z.object({
  afterPaneId: chatPaneIdSchema.nullable(),
  limit: z.number().int().min(1).max(runtimeChatPaneLimit),
}).strict();

const childListSchema = z.object({
  parentActorId: actorIdSchema,
  afterActorId: actorIdSchema.nullable(),
  limit: z.number().int().min(1).max(51),
}).strict();

const actorListSchema = z.object({
  afterActorId: actorIdSchema.nullable(),
  limit: z.number().int().min(1).max(harnessProjectionReconciliationPageLimit),
}).strict();

const childSemanticProjectionSchema = z.object({
  id: harnessChildProjectionSchema.shape.id,
  title: harnessChildProjectionSchema.shape.title,
  state: harnessChildProjectionSchema.shape.state,
  openedPaneId: harnessChildProjectionSchema.shape.openedPaneId,
  canOpen: z.boolean(),
  canMessage: z.boolean(),
  canStop: z.boolean(),
}).strict().superRefine((projection, context) => {
  const parsed = harnessChildProjectionSchema.safeParse({
    ...projection,
    revision: 1,
  });
  if (parsed.success) return;
  context.addIssue({
    code: "custom",
    message: "renderer child action projection is incoherent",
  });
});

const witnessWriteSchema = z.object({
  actorId: actorIdSchema,
  expectedRevision: revisionSchema.nullable(),
  projection: childSemanticProjectionSchema,
}).strict();

const witnessSchemaProbeRowSchema = z.object({
  cid: z.number().int().nonnegative().safe(),
  name: z.string(),
  type: z.enum(["TEXT", "INTEGER"]),
  notnull: z.literal(1),
  dflt_value: z.null(),
  pk: z.union([z.literal(0), z.literal(1)]),
}).strict();

export interface HarnessProjectionWitnessV2 {
  readonly actorId: string;
  readonly revision: number;
  readonly semanticDigest: string;
}

export interface HarnessRendererSQLiteAdapterV2Options {
  readonly actors?: HarnessSQLiteAuthorityV2;
  readonly now?: () => Date;
}

export class HarnessRendererSQLiteAdapterV2Error extends Error {
  readonly code:
    | "corrupt_state"
    | "invalid_state"
    | "not_found"
    | "revision_conflict"
    | "schema_unavailable";

  constructor(
    code: HarnessRendererSQLiteAdapterV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessRendererSQLiteAdapterV2Error";
    this.code = code;
  }
}

/**
 * Renderer-safe SQLite read and CAS authority.
 *
 * This adapter deliberately owns no provider effect and emits no provider,
 * account, or filesystem identity. Chat attachment and actor settlement stay
 * injected into `HarnessRendererAuthorityV2`; those effect adapters must wrap
 * their chat/actor changes and `writeProjectionWitness` in one outer SQLite
 * transaction on this same database connection.
 */
export class HarnessRendererSQLiteAdapterV2 implements
  HarnessRendererSettingsAuthorityPort,
  HarnessRendererProposalReadPort,
  HarnessRendererActorReadPort {
  readonly #database: Database;
  readonly #actors: HarnessSQLiteAuthorityV2;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: HarnessRendererSQLiteAdapterV2Options = {},
  ) {
    this.#database = database;
    this.#actors = options.actors ?? new HarnessSQLiteAuthorityV2(database);
    this.#now = options.now ?? (() => new Date());
    this.#assertProjectionWitnessSchema();
  }

  read(): Readonly<{
    settings: z.infer<typeof harnessSettingsProjectionSchema>;
    harnessRevision: number;
  }> {
    return this.#readSettingsState();
  }

  update(inputValue: Readonly<{
    expectedHarnessRevision: number;
    expectedSettingsRevision: number;
    recursiveSessionsEnabled: boolean;
    contextQuotaBytes: number;
    refinementMode: "off" | "suggest";
  }>): Readonly<{
    settings: z.infer<typeof harnessSettingsProjectionSchema>;
    harnessRevision: number;
  }> {
    const input = settingsUpdateSchema.parse(inputValue);
    if (input.refinementMode === "suggest" && !input.recursiveSessionsEnabled) {
      throw new HarnessRendererSQLiteAdapterV2Error(
        "corrupt_state",
        "suggest mode requires recursive sessions",
      );
    }
    const updatedAt = this.#timestamp();
    return this.#database.transaction(() => {
      const current = this.#readSettingsState();
      if (
        current.harnessRevision !== input.expectedHarnessRevision ||
        current.settings.revision !== input.expectedSettingsRevision
      ) revisionConflict();
      if (current.settings.revision === Number.MAX_SAFE_INTEGER) {
        corrupt("settings revision cannot advance beyond the safe integer bound");
      }
      if (
        current.settings.refinementMode === "suggest" &&
        input.refinementMode === "off"
      ) {
        const preparedProposal: unknown = this.#database.query(`
          SELECT proposal_id
          FROM harness_proposals
          WHERE state = 'prepared'
          ORDER BY proposal_id
          LIMIT 1
        `).get();
        if (preparedProposal !== null) {
          parseStored(
            preparedProposalRowSchema,
            preparedProposal,
            "prepared proposal identity",
          );
          invalidState(
            "suggest mode cannot be disabled while a proposal is being published",
          );
        }
      }

      const changed = this.#database.query(`
        UPDATE harness_settings SET
          revision = revision + 1,
          recursive_sessions_enabled = ?2,
          context_quota_bytes = ?3,
          refinement_mode = ?4,
          updated_at = ?5
        WHERE singleton = 1 AND revision = ?1
      `).run(
        input.expectedSettingsRevision,
        input.recursiveSessionsEnabled ? 1 : 0,
        input.contextQuotaBytes,
        input.refinementMode,
        updatedAt,
      );
      if (changed.changes !== 1) revisionConflict();

      const next = this.#readSettingsState();
      if (
        next.settings.revision !== input.expectedSettingsRevision + 1 ||
        next.harnessRevision !== input.expectedHarnessRevision + 1 ||
        next.settings.recursiveSessionsEnabled !==
          input.recursiveSessionsEnabled ||
        next.settings.contextQuotaBytes !== input.contextQuotaBytes ||
        next.settings.refinementMode !== input.refinementMode
      ) corrupt("settings CAS committed an incoherent projection");
      return next;
    })();
  }

  list(inputValue: Readonly<{
    afterProposalId: string | null;
    limit: number;
  }>): readonly z.infer<typeof harnessProposalSummaryProjectionSchema>[] {
    const input = proposalListSchema.parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT proposal_id, revision, title
      FROM harness_proposals
      WHERE state = 'active' AND proposal_id > COALESCE(?1, '')
      ORDER BY proposal_id
      LIMIT ?2
    `).all(input.afterProposalId, input.limit);
    const proposals = rows.map((row) => parseProposalRow(row));
    assertStrictlyIncreasing(
      proposals.map(({ id }) => id),
      input.afterProposalId,
      "proposal",
    );
    return Object.freeze(proposals);
  }

  listPaneIds(inputValue: Readonly<{
    afterPaneId: string | null;
    limit: number;
  }>): readonly string[] {
    const input = paneListSchema.parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT pane_id FROM chat_panes
      WHERE pane_id > COALESCE(?1, '')
      ORDER BY pane_id
      LIMIT ?2
    `).all(input.afterPaneId, input.limit);
    const paneIds = rows.map((row) => parseStored(
      paneIdRowSchema,
      row,
      "chat pane identity",
    ).pane_id);
    assertStrictlyIncreasing(paneIds, input.afterPaneId, "chat pane");
    return Object.freeze(paneIds);
  }

  readActorForPane(paneIdValue: string): Actor | null {
    return this.#actors.readActorForPane(chatPaneIdSchema.parse(paneIdValue));
  }

  /** Canonical bounded enumeration used by the projection reconciler. */
  listActorIds(inputValue: Readonly<{
    afterActorId: string | null;
    limit: number;
  }>): readonly string[] {
    const input = actorListSchema.parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT actor_id FROM harness_actors
      WHERE actor_id > COALESCE(?1, '')
      ORDER BY actor_id
      LIMIT ?2
    `).all(input.afterActorId, input.limit);
    const actorIds = rows.map((row) => parseStored(
      actorIdRowSchema,
      row,
      "actor identity",
    ).actor_id);
    assertStrictlyIncreasing(actorIds, input.afterActorId, "actor");
    return Object.freeze(actorIds);
  }

  listActorChildren(inputValue: Readonly<{
    parentActorId: string;
    afterActorId: string | null;
    limit: number;
  }>): readonly Actor[] {
    const input = childListSchema.parse(inputValue);
    const children = this.#actors.listActorChildren(input);
    assertStrictlyIncreasing(
      children.map(({ id }) => id),
      input.afterActorId,
      "child actor",
    );
    return children;
  }

  readActiveIncarnationForActor(
    actorIdValue: string,
  ): ActorIncarnationRecord | null {
    return this.#actors.readActiveIncarnationForActor(
      actorIdSchema.parse(actorIdValue),
    );
  }

  readLatestActorTurnForActor(actorIdValue: string): ActorTurn | null {
    const actorId = actorIdSchema.parse(actorIdValue);
    if (this.#actors.readActor(actorId) === null) notFound("actor is unavailable");
    const rows: unknown[] = this.#database.query(`
      SELECT turn_id FROM harness_actor_turns
      WHERE actor_id = ?1
      ORDER BY ordinal DESC
      LIMIT 2
    `).all(actorId);
    if (rows.length === 0) return null;
    const ids = rows.map((row) => parseStored(
      turnIdRowSchema,
      row,
      "actor turn identity",
    ).turn_id);
    if (new Set(ids).size !== ids.length) {
      corrupt("latest actor turn enumeration contains a duplicate");
    }
    const turn = this.#actors.readActorTurn(ids[0]!);
    if (turn === null || turn.actorId !== actorId) {
      corrupt("latest actor turn is unavailable or belongs to another actor");
    }
    return turn;
  }

  readPaneBindingForActor(actorIdValue: string): ActorPaneBinding | null {
    return this.#actors.readPaneBindingForActor(
      actorIdSchema.parse(actorIdValue),
    );
  }

  readProjectionWitness(
    actorIdValue: string,
  ): HarnessProjectionWitnessV2 | null {
    const actorId = actorIdSchema.parse(actorIdValue);
    const value: unknown = this.#database.query(`
      SELECT actor_id, revision, semantic_digest, created_at, updated_at
      FROM harness_actor_projection_witnesses
      WHERE actor_id = ?1
    `).get(actorId);
    return value === null ? null : projectionWitness(parseWitnessRow(value));
  }

  /**
   * Creates or advances the renderer witness. Equal semantic state is a true
   * no-op, including the one-step replay of a just-committed effect. Any other
   * stale caller fails without changing the durable counter.
   */
  writeProjectionWitness(inputValue: Readonly<{
    actorId: string;
    expectedRevision: number | null;
    projection: Omit<HarnessChildProjection, "revision">;
  }>): HarnessProjectionWitnessV2 {
    return this.#database.transaction(() =>
      this.writeProjectionWitnessInTransaction(inputValue)
    )();
  }

  /**
   * Converges one witness to the actor's canonical semantic projection.
   *
   * The projection read, prior-witness read, and idempotent CAS share one
   * SQLite transaction. A missing actor or incoherent projection source aborts
   * the transaction, so callers never refresh from a partial observation.
   */
  synchronizeProjectionWitness(
    actorIdValue: string,
  ): HarnessProjectionWitnessV2 {
    const actorId = actorIdSchema.parse(actorIdValue);
    return this.#database.transaction(() => {
      const projection = this.#readCurrentSemanticProjection(actorId);
      const current = this.#readProjectionWitnessRow(actorId);
      return this.writeProjectionWitnessInTransaction({
        actorId,
        expectedRevision: current?.revision ?? null,
        projection,
      });
    })();
  }

  /** Transaction-free form for a renderer effect's one outer commit. */
  writeProjectionWitnessInTransaction(inputValue: Readonly<{
    actorId: string;
    expectedRevision: number | null;
    projection: Omit<HarnessChildProjection, "revision">;
  }>): HarnessProjectionWitnessV2 {
    const input = witnessWriteSchema.parse(inputValue);
    if (input.projection.id !== input.actorId) {
      corrupt("projection witness actor identity is incoherent");
    }
    const semanticDigest = harnessChildSemanticDigest(input.projection);
    const now = this.#timestamp();
    const currentProjection = this.#readCurrentSemanticProjection(input.actorId);
    if (JSON.stringify(currentProjection) !== JSON.stringify(input.projection)) {
      corrupt("projection witness input does not match durable semantic state");
    }
    const current = this.#readProjectionWitnessRow(input.actorId);
    if (current === null) {
      if (input.expectedRevision !== null) revisionConflict();
      this.#database.query(`
        INSERT INTO harness_actor_projection_witnesses (
          actor_id, revision, semantic_digest, created_at, updated_at
        ) VALUES (?1, 1, ?2, ?3, ?3)
      `).run(input.actorId, semanticDigest, now);
      return projectionWitness(this.#requireProjectionWitnessRow(input.actorId));
    }

    const same = current.semantic_digest === semanticDigest;
    const exactExpectation = input.expectedRevision === current.revision;
    const oneStepReplay = input.expectedRevision !== null && same &&
      input.expectedRevision + 1 === current.revision;
    const createReplay = input.expectedRevision === null && same &&
      current.revision === 1;
    if (!exactExpectation && !oneStepReplay && !createReplay) {
      revisionConflict();
    }
    if (same) return projectionWitness(current);
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      corrupt("projection witness cannot exceed the safe integer bound");
    }
    const changed = this.#database.query(`
      UPDATE harness_actor_projection_witnesses SET
        revision = revision + 1,
        semantic_digest = ?3,
        updated_at = ?4
      WHERE actor_id = ?1 AND revision = ?2
        AND semantic_digest = ?5
    `).run(
      input.actorId,
      current.revision,
      semanticDigest,
      now,
      current.semantic_digest,
    );
    if (changed.changes !== 1) revisionConflict();
    const next = this.#requireProjectionWitnessRow(input.actorId);
    if (
      next.revision !== current.revision + 1 ||
      next.semantic_digest !== semanticDigest
    ) corrupt("projection witness CAS committed an incoherent state");
    return projectionWitness(next);
  }

  #readSettingsState(): Readonly<{
    settings: z.infer<typeof harnessSettingsProjectionSchema>;
    harnessRevision: number;
  }> {
    const values: unknown[] = this.#database.query(`
      SELECT singleton, revision, recursive_sessions_enabled,
        context_quota_bytes, refinement_mode, updated_at
      FROM harness_settings
      WHERE singleton = 1
      LIMIT 2
    `).all();
    if (values.length !== 1) corrupt("harness settings singleton is unavailable");
    const row = parseStored(settingsRowSchema, values[0], "harness settings");
    const proposals = this.#readAllActiveProposals();
    return Object.freeze({
      settings: harnessSettingsProjectionSchema.parse({
        revision: row.revision,
        recursiveSessionsEnabled: row.recursive_sessions_enabled === 1,
        contextQuotaBytes: row.context_quota_bytes,
        refinementMode: row.refinement_mode,
      }),
      harnessRevision: checkedRevisionSum([
        row.revision,
        ...proposals.map(({ revision }) => revision),
      ]),
    });
  }

  #readAllActiveProposals(): readonly z.infer<
    typeof harnessProposalSummaryProjectionSchema
  >[] {
    const rows: unknown[] = this.#database.query(`
      SELECT proposal_id, revision, title
      FROM harness_proposals
      WHERE state = 'active'
      ORDER BY proposal_id
      LIMIT ?1
    `).all(runtimeHarnessProposalProjectionLimit + 1);
    if (rows.length > runtimeHarnessProposalProjectionLimit) {
      corrupt("active proposal count exceeds the renderer bound");
    }
    const proposals = rows.map((row) => parseProposalRow(row));
    assertStrictlyIncreasing(
      proposals.map(({ id }) => id),
      null,
      "proposal",
    );
    return Object.freeze(proposals);
  }

  #readProjectionWitnessRow(
    actorId: string,
  ): z.infer<typeof projectionWitnessRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT actor_id, revision, semantic_digest, created_at, updated_at
      FROM harness_actor_projection_witnesses
      WHERE actor_id = ?1
    `).get(actorId);
    return value === null ? null : parseWitnessRow(value);
  }

  #readCurrentSemanticProjection(
    actorId: string,
  ): Omit<HarnessChildProjection, "revision"> {
    const actor = this.#actors.readActor(actorId);
    if (actor === null) notFound("actor is unavailable");
    const incarnation = this.#actors.readActiveIncarnationForActor(actorId);
    const latestTurn = this.readLatestActorTurnForActor(actorId);
    const binding = this.#actors.readPaneBindingForActor(actorId);
    if (
      (actor.nextTurnOrdinal === 1) !== (latestTurn === null) ||
      (latestTurn !== null &&
        (latestTurn.actorId !== actor.id || latestTurn.epochId !== actor.epochId ||
          latestTurn.ordinal !== actor.nextTurnOrdinal - 1)) ||
      (incarnation !== null && incarnation.actorId !== actor.id) ||
      (binding !== null &&
        (binding.actorId !== actor.id || binding.state !== "attached"))
    ) corrupt("actor projection sources are incoherent");
    const state = deriveHarnessChildState({ actor, incarnation, latestTurn });
    const actions = deriveHarnessChildActions({
      actor,
      incarnation,
      latestTurn,
      binding,
    });
    return childSemanticProjectionSchema.parse({
      id: actor.id,
      title: actor.title,
      state,
      openedPaneId: binding?.paneId ?? null,
      ...actions,
      canStop: state !== "stopped" && state !== "quarantined",
    });
  }

  #requireProjectionWitnessRow(
    actorId: string,
  ): z.infer<typeof projectionWitnessRowSchema> {
    const witness = this.#readProjectionWitnessRow(actorId);
    if (witness === null) corrupt("projection witness disappeared during CAS");
    return witness;
  }

  #assertProjectionWitnessSchema(): void {
    let rows: unknown[];
    try {
      rows = this.#database.query(`
        SELECT cid, name, type, "notnull", dflt_value, pk
        FROM pragma_table_info('${PROJECTION_WITNESS_TABLE}')
        ORDER BY cid
      `).all();
    } catch (cause: unknown) {
      throw new HarnessRendererSQLiteAdapterV2Error(
        "schema_unavailable",
        "renderer projection witness storage is unavailable",
        cause,
      );
    }
    const columns = rows.map((row) => parseStored(
      witnessSchemaProbeRowSchema,
      row,
      "projection witness schema",
    ));
    const expected = [
      { cid: 0, name: "actor_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: "semantic_digest", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ];
    if (JSON.stringify(columns) !== JSON.stringify(expected)) {
      throw new HarnessRendererSQLiteAdapterV2Error(
        "schema_unavailable",
        "renderer projection witness storage is unavailable",
      );
    }
  }

  #timestamp(): string {
    let value: string;
    try {
      value = this.#now().toISOString();
    } catch (cause: unknown) {
      throw new HarnessRendererSQLiteAdapterV2Error(
        "corrupt_state",
        "renderer authority clock is invalid",
        cause,
      );
    }
    return timestampSchema.parse(value);
  }
}

function parseProposalRow(
  value: unknown,
): z.infer<typeof harnessProposalSummaryProjectionSchema> {
  const row = parseStored(proposalRowSchema, value, "active proposal");
  return harnessProposalSummaryProjectionSchema.parse({
    id: row.proposal_id,
    revision: row.revision,
    title: row.title,
  });
}

function parseWitnessRow(
  value: unknown,
): z.infer<typeof projectionWitnessRowSchema> {
  const row = parseStored(
    projectionWitnessRowSchema,
    value,
    "projection witness",
  );
  if (row.updated_at < row.created_at) {
    corrupt("projection witness timestamps are incoherent");
  }
  return row;
}

function projectionWitness(
  row: z.infer<typeof projectionWitnessRowSchema>,
): HarnessProjectionWitnessV2 {
  return Object.freeze({
    actorId: row.actor_id,
    revision: row.revision,
    semanticDigest: row.semantic_digest,
  });
}

function checkedRevisionSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += revisionSchema.parse(value);
    if (!Number.isSafeInteger(total) || total <= 0) {
      corrupt("renderer projection revision exceeds the safe integer bound");
    }
  }
  if (values.length === 0) corrupt("renderer projection revision has no source");
  return total;
}

function assertStrictlyIncreasing(
  values: readonly string[],
  after: string | null,
  label: string,
): void {
  let previous = after;
  for (const value of values) {
    if (previous !== null && value <= previous) {
      corrupt(`${label} enumeration is duplicated or out of order`);
    }
    previous = value;
  }
}

function parseStored<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
  label: string,
): T {
  try {
    return schema.parse(value);
  } catch (cause: unknown) {
    throw new HarnessRendererSQLiteAdapterV2Error(
      "corrupt_state",
      `stored ${label} is invalid`,
      cause,
    );
  }
}

function corrupt(message: string): never {
  throw new HarnessRendererSQLiteAdapterV2Error("corrupt_state", message);
}

function notFound(message: string): never {
  throw new HarnessRendererSQLiteAdapterV2Error("not_found", message);
}

function revisionConflict(): never {
  throw new HarnessRendererSQLiteAdapterV2Error(
    "revision_conflict",
    "renderer projection revision changed",
  );
}

function invalidState(message: string): never {
  throw new HarnessRendererSQLiteAdapterV2Error("invalid_state", message);
}
