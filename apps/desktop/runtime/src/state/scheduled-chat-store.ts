import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "@hra-internal/schema";
import {
  canonicalSessionSyncJson,
  positiveSyncUint64Schema,
  sealedScheduledChatDefinitionSchema,
  scheduledChatEpochMsSchema,
  scheduledChatRunIdSchema,
  scheduledChatTimeZoneSchema,
  canonicalScheduledChatRRuleSchema,
  scheduledChatPutResponseSchema,
  scheduledChatClearedResponseSchema,
  putScheduledChatRequestSchema,
  clearScheduledChatRequestSchema,
  sessionPublicIdSchema,
  syncSha256DigestSchema,
  type PositiveSyncUint64,
  type SealedScheduledChatDefinition,
  type SessionPublicId,
  type SyncSha256Digest,
  type ScheduledChatPutResponse,
  type ScheduledChatClearedResponse,
  type ScheduledChatInventoryEntry,
} from "@hraness/agent-tasks-protocol";
import {
  chatIsoDateTimeSchema,
  chatMessageIdSchema,
  chatPaneIdSchema,
  chatTurnIdSchema,
  chatScheduleProjectionSchema,
  type ChatMessageId,
  type ChatPaneProjection,
  type ChatScheduleProjection,
} from "../../../contracts/runtime";

export const SCHEDULED_CHAT_LOCAL_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const SCHEDULED_CHAT_LOCAL_SCHEMA_V1_SQL = `
  CREATE TABLE chat_scheduled_chats (
    pane_id TEXT PRIMARY KEY
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE
      REFERENCES session_sync_pane_bindings(session_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    generation TEXT NOT NULL CHECK (
      length(generation) BETWEEN 1 AND 20
      AND generation NOT GLOB '*[^0-9]*'
      AND generation != '0'
      AND (length(generation) = 1 OR substr(generation, 1, 1) != '0')
    ),
    key_epoch TEXT NOT NULL CHECK (
      length(key_epoch) BETWEEN 1 AND 20
      AND key_epoch NOT GLOB '*[^0-9]*'
      AND key_epoch != '0'
      AND (length(key_epoch) = 1 OR substr(key_epoch, 1, 1) != '0')
    ),
    rrule TEXT NOT NULL CHECK (
      length(CAST(rrule AS BLOB)) BETWEEN 1 AND 512
      AND instr(rrule, char(0)) = 0
    ),
    time_zone TEXT NOT NULL CHECK (
      length(CAST(time_zone AS BLOB)) BETWEEN 1 AND 96
      AND instr(time_zone, char(0)) = 0
    ),
    next_run_at INTEGER NOT NULL CHECK (
      next_run_at BETWEEN 0 AND 9007199254740991
    ),
    definition_ciphertext_digest TEXT NOT NULL CHECK (
      length(definition_ciphertext_digest) = 71
      AND definition_ciphertext_digest GLOB 'sha256_[0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (
      created_at BETWEEN 0 AND 9007199254740991
    ),
    updated_at INTEGER NOT NULL CHECK (
      updated_at BETWEEN created_at AND 9007199254740991
    )
  ) STRICT;

  CREATE TABLE chat_scheduled_chat_generation_high_water (
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    generation TEXT NOT NULL CHECK (
      length(generation) BETWEEN 1 AND 20
      AND generation NOT GLOB '*[^0-9]*'
      AND generation != '0'
      AND (length(generation) = 1 OR substr(generation, 1, 1) != '0')
    ),
    updated_at INTEGER NOT NULL CHECK (
      updated_at BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (pane_id, session_id)
  ) STRICT;

  CREATE TABLE chat_scheduled_chat_mutations (
    operation_id TEXT PRIMARY KEY CHECK (
      length(operation_id) BETWEEN 11 AND 96
      AND operation_id GLOB 'syncop_[A-Za-z0-9_-]*'
    ),
    pane_id TEXT NOT NULL UNIQUE
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL
      REFERENCES session_sync_pane_bindings(session_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('put', 'clear')),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'effect_started')),
    expected_pane_revision INTEGER NOT NULL CHECK (expected_pane_revision > 0),
    expected_schedule_revision INTEGER CHECK (
      expected_schedule_revision IS NULL OR expected_schedule_revision > 0
    ),
    target_schedule_revision INTEGER CHECK (
      target_schedule_revision IS NULL OR target_schedule_revision > 0
    ),
    target_generation TEXT NOT NULL CHECK (
      length(target_generation) BETWEEN 1 AND 20
      AND target_generation NOT GLOB '*[^0-9]*'
      AND target_generation != '0'
      AND (length(target_generation) = 1 OR substr(target_generation, 1, 1) != '0')
    ),
    request_json TEXT NOT NULL CHECK (
      length(CAST(request_json AS BLOB)) BETWEEN 2 AND 131072
      AND instr(request_json, char(0)) = 0
    ),
    request_digest TEXT NOT NULL CHECK (
      length(request_digest) = 71
      AND request_digest GLOB 'sha256_[0-9a-f]*'
    ),
    rrule TEXT,
    time_zone TEXT,
    next_run_at INTEGER CHECK (
      next_run_at IS NULL OR next_run_at BETWEEN 0 AND 9007199254740991
    ),
    definition_ciphertext_digest TEXT CHECK (
      definition_ciphertext_digest IS NULL OR (
        length(definition_ciphertext_digest) = 71
        AND definition_ciphertext_digest GLOB 'sha256_[0-9a-f]*'
      )
    ),
    created_at INTEGER NOT NULL CHECK (
      created_at BETWEEN 0 AND 9007199254740991
    ),
    updated_at INTEGER NOT NULL CHECK (
      updated_at BETWEEN created_at AND 9007199254740991
    ),
    CHECK (
      (kind = 'put'
        AND target_schedule_revision IS NOT NULL
        AND rrule IS NOT NULL
        AND time_zone IS NOT NULL
        AND next_run_at IS NOT NULL
        AND definition_ciphertext_digest IS NOT NULL)
      OR
      (kind = 'clear'
        AND expected_schedule_revision IS NOT NULL
        AND target_schedule_revision IS NULL
        AND rrule IS NULL
        AND time_zone IS NULL
        AND next_run_at IS NULL
        AND definition_ciphertext_digest IS NULL)
    )
  ) STRICT;

  CREATE TRIGGER chat_scheduled_chat_mutation_identity_immutable
  BEFORE UPDATE OF operation_id, pane_id, session_id, kind,
    expected_pane_revision, expected_schedule_revision,
    target_schedule_revision, target_generation, request_json,
    request_digest, rrule, time_zone, next_run_at,
    definition_ciphertext_digest, created_at
  ON chat_scheduled_chat_mutations
  WHEN NEW.operation_id IS NOT OLD.operation_id
    OR NEW.pane_id IS NOT OLD.pane_id
    OR NEW.session_id IS NOT OLD.session_id
    OR NEW.kind IS NOT OLD.kind
    OR NEW.expected_pane_revision IS NOT OLD.expected_pane_revision
    OR NEW.expected_schedule_revision IS NOT OLD.expected_schedule_revision
    OR NEW.target_schedule_revision IS NOT OLD.target_schedule_revision
    OR NEW.target_generation IS NOT OLD.target_generation
    OR NEW.request_json IS NOT OLD.request_json
    OR NEW.request_digest IS NOT OLD.request_digest
    OR NEW.rrule IS NOT OLD.rrule
    OR NEW.time_zone IS NOT OLD.time_zone
    OR NEW.next_run_at IS NOT OLD.next_run_at
    OR NEW.definition_ciphertext_digest IS NOT OLD.definition_ciphertext_digest
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'scheduled chat mutation identity is immutable');
  END;

  CREATE TRIGGER chat_scheduled_chat_mutation_transition_guard
  BEFORE UPDATE OF state ON chat_scheduled_chat_mutations
  WHEN NOT (
    OLD.state = NEW.state
    OR (OLD.state = 'prepared' AND NEW.state = 'effect_started')
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid scheduled chat mutation transition');
  END;

  CREATE TRIGGER chat_scheduled_chat_pane_update_quarantine
  BEFORE UPDATE ON chat_panes
  WHEN EXISTS (
    SELECT 1 FROM chat_scheduled_chat_mutations AS mutation
    WHERE mutation.pane_id = OLD.pane_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'scheduled chat mutation quarantines pane updates');
  END;

  CREATE TRIGGER chat_scheduled_chat_pane_delete_quarantine
  BEFORE DELETE ON chat_panes
  WHEN EXISTS (
    SELECT 1 FROM chat_scheduled_chat_mutations AS mutation
    WHERE mutation.pane_id = OLD.pane_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'scheduled chat mutation quarantines pane deletion');
  END;

  CREATE TABLE chat_scheduled_chat_runs (
    run_id TEXT PRIMARY KEY CHECK (
      length(run_id) = 34 AND run_id GLOB 'syncrun_[0-9A-HJKMNP-TV-Z]*'
    ),
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    schedule_generation TEXT NOT NULL CHECK (
      length(schedule_generation) BETWEEN 1 AND 20
      AND schedule_generation NOT GLOB '*[^0-9]*'
      AND schedule_generation != '0'
      AND (length(schedule_generation) = 1
        OR substr(schedule_generation, 1, 1) != '0')
    ),
    occurrence_sequence TEXT NOT NULL CHECK (
      length(occurrence_sequence) BETWEEN 1 AND 20
      AND occurrence_sequence NOT GLOB '*[^0-9]*'
      AND occurrence_sequence != '0'
      AND (length(occurrence_sequence) = 1
        OR substr(occurrence_sequence, 1, 1) != '0')
    ),
    scheduled_for INTEGER NOT NULL CHECK (
      scheduled_for BETWEEN 0 AND 9007199254740991
    ),
    message_id TEXT NOT NULL UNIQUE CHECK (
      length(message_id) BETWEEN 15 AND 96
      AND message_id GLOB 'chatmsg_[A-Za-z0-9_-]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('enqueued', 'acknowledged')),
    enqueued_at INTEGER NOT NULL CHECK (
      enqueued_at BETWEEN 0 AND 9007199254740991
    ),
    acknowledged_at INTEGER CHECK (
      acknowledged_at IS NULL
      OR acknowledged_at BETWEEN enqueued_at AND 9007199254740991
    ),
    cancelled_at INTEGER CHECK (
      cancelled_at IS NULL
      OR cancelled_at BETWEEN enqueued_at AND 9007199254740991
    ),
    CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL)),
    UNIQUE (pane_id, session_id, schedule_generation, occurrence_sequence)
  ) STRICT;
`;

export const SCHEDULED_CHAT_DURABLE_OFF_INTENT_SCHEMA_SQL = `
  CREATE TABLE chat_scheduled_chat_desired_off (
    pane_id TEXT PRIMARY KEY
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL
      REFERENCES session_sync_pane_bindings(session_id) ON DELETE RESTRICT,
    target_generation TEXT NOT NULL CHECK (
      length(target_generation) BETWEEN 1 AND 20
      AND target_generation NOT GLOB '*[^0-9]*'
      AND target_generation != '0'
      AND (length(target_generation) = 1
        OR substr(target_generation, 1, 1) != '0')
    ),
    created_at INTEGER NOT NULL CHECK (
      created_at BETWEEN 0 AND 9007199254740991
    ),
    updated_at INTEGER NOT NULL CHECK (
      updated_at BETWEEN created_at AND 9007199254740991
    )
  ) STRICT;

  CREATE TRIGGER chat_scheduled_chat_desired_off_pane_update_quarantine
  BEFORE UPDATE ON chat_panes
  WHEN EXISTS (
    SELECT 1 FROM chat_scheduled_chat_desired_off AS desired
    WHERE desired.pane_id = OLD.pane_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'scheduled chat off intent quarantines pane updates');
  END;

  CREATE TRIGGER chat_scheduled_chat_desired_off_pane_delete_quarantine
  BEFORE DELETE ON chat_panes
  WHEN EXISTS (
    SELECT 1 FROM chat_scheduled_chat_desired_off AS desired
    WHERE desired.pane_id = OLD.pane_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'scheduled chat off intent quarantines pane deletion');
  END;
`;

const activeRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  session_id: sessionPublicIdSchema,
  revision: z.number().int().positive().safe(),
  generation: positiveSyncUint64Schema,
  key_epoch: positiveSyncUint64Schema,
  rrule: canonicalScheduledChatRRuleSchema,
  time_zone: scheduledChatTimeZoneSchema,
  next_run_at: scheduledChatEpochMsSchema,
  definition_ciphertext_digest: syncSha256DigestSchema,
  created_at: scheduledChatEpochMsSchema,
  updated_at: scheduledChatEpochMsSchema,
}).strict();

const generationHighWaterRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  session_id: sessionPublicIdSchema,
  generation: positiveSyncUint64Schema,
  updated_at: scheduledChatEpochMsSchema,
}).strict();

const mutationRowSchema = z.object({
  operation_id: z.string().min(11).max(96).regex(/^syncop_[A-Za-z0-9_-]+$/u),
  pane_id: chatPaneIdSchema,
  session_id: sessionPublicIdSchema,
  kind: z.enum(["put", "clear"]),
  state: z.enum(["prepared", "effect_started"]),
  expected_pane_revision: z.number().int().positive().safe(),
  expected_schedule_revision: z.number().int().positive().safe().nullable(),
  target_schedule_revision: z.number().int().positive().safe().nullable(),
  target_generation: positiveSyncUint64Schema,
  request_json: z.string().min(2).max(131_072),
  request_digest: syncSha256DigestSchema,
  rrule: canonicalScheduledChatRRuleSchema.nullable(),
  time_zone: scheduledChatTimeZoneSchema.nullable(),
  next_run_at: scheduledChatEpochMsSchema.nullable(),
  definition_ciphertext_digest: syncSha256DigestSchema.nullable(),
  created_at: scheduledChatEpochMsSchema,
  updated_at: scheduledChatEpochMsSchema,
}).strict();

const desiredOffRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  session_id: sessionPublicIdSchema,
  target_generation: positiveSyncUint64Schema,
  created_at: scheduledChatEpochMsSchema,
  updated_at: scheduledChatEpochMsSchema,
}).strict();

const runRowSchema = z.object({
  run_id: scheduledChatRunIdSchema,
  pane_id: chatPaneIdSchema,
  session_id: sessionPublicIdSchema,
  schedule_generation: positiveSyncUint64Schema,
  occurrence_sequence: positiveSyncUint64Schema,
  scheduled_for: scheduledChatEpochMsSchema,
  message_id: chatMessageIdSchema,
  state: z.enum(["enqueued", "acknowledged"]),
  enqueued_at: scheduledChatEpochMsSchema,
  acknowledged_at: scheduledChatEpochMsSchema.nullable(),
  cancelled_at: scheduledChatEpochMsSchema.nullable(),
}).strict();

const paneRevisionRowSchema = z.object({
  revision: z.number().int().positive().safe(),
  archived_at: chatIsoDateTimeSchema.nullable(),
  interaction_mode: z.enum(["chat", "harnessObserver"]),
}).strict();

export interface LocalScheduledChat {
  readonly paneId: ChatPaneProjection["id"];
  readonly sessionId: SessionPublicId;
  readonly revision: number;
  readonly generation: PositiveSyncUint64;
  readonly keyEpoch: PositiveSyncUint64;
  readonly rrule: string;
  readonly timeZone: string;
  readonly nextRunAt: number;
  readonly definitionCiphertextDigest: SyncSha256Digest;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LocalScheduledChatGenerationHighWater {
  readonly paneId: ChatPaneProjection["id"];
  readonly sessionId: SessionPublicId;
  readonly generation: PositiveSyncUint64;
  readonly updatedAt: number;
}

export interface LocalScheduledChatMutation {
  readonly operationId: string;
  readonly paneId: ChatPaneProjection["id"];
  readonly sessionId: SessionPublicId;
  readonly kind: "put" | "clear";
  readonly state: "prepared" | "effect_started";
  readonly expectedPaneRevision: number;
  readonly expectedScheduleRevision: number | null;
  readonly targetScheduleRevision: number | null;
  readonly targetGeneration: PositiveSyncUint64;
  readonly request: unknown;
  readonly requestDigest: SyncSha256Digest;
  readonly rrule: string | null;
  readonly timeZone: string | null;
  readonly nextRunAt: number | null;
  readonly definitionCiphertextDigest: SyncSha256Digest | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LocalScheduledChatDesiredOff {
  readonly paneId: ChatPaneProjection["id"];
  readonly sessionId: SessionPublicId;
  readonly targetGeneration: PositiveSyncUint64;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LocalScheduledChatRun {
  readonly runId: string;
  readonly paneId: ChatPaneProjection["id"];
  readonly sessionId: SessionPublicId;
  readonly scheduleGeneration: PositiveSyncUint64;
  readonly occurrenceSequence: PositiveSyncUint64;
  readonly scheduledFor: number;
  readonly messageId: ChatMessageId;
  readonly state: "enqueued" | "acknowledged";
  readonly enqueuedAt: number;
  readonly acknowledgedAt: number | null;
  readonly cancelledAt: number | null;
}

export class ScheduledChatStoreError extends Error {
  readonly code: "conflict" | "corrupt_state" | "invalid_state" | "not_found";

  constructor(code: ScheduledChatStoreError["code"], message: string) {
    super(message);
    this.name = "ScheduledChatStoreError";
    this.code = code;
  }
}

export interface ScheduledChatPaneMutationAuthority {
  assertPaneMutationAllowed(paneId: ChatPaneProjection["id"]): void;
  cancelUnclaimedScheduledMessage(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    messageId: ChatMessageId;
    now: Date;
  }>): boolean;
  settleScheduledClearQueue(input: Readonly<{
    paneId: ChatPaneProjection["id"];
    now: Date;
  }>): boolean;
}

function digestCanonicalJson(value: unknown): SyncSha256Digest {
  return syncSha256DigestSchema.parse(
    `sha256_${createHash("sha256")
      .update(canonicalSessionSyncJson(value), "utf8")
      .digest("hex")}`,
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ScheduledChatStoreError(
      "corrupt_state",
      "The scheduled chat mutation request is invalid.",
    );
  }
}

function localSchedule(row: z.infer<typeof activeRowSchema>): LocalScheduledChat {
  return {
    paneId: row.pane_id,
    sessionId: row.session_id,
    revision: row.revision,
    generation: row.generation,
    keyEpoch: row.key_epoch,
    rrule: row.rrule,
    timeZone: row.time_zone,
    nextRunAt: row.next_run_at,
    definitionCiphertextDigest: row.definition_ciphertext_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function localMutation(
  row: z.infer<typeof mutationRowSchema>,
): LocalScheduledChatMutation {
  const request = parseJson(row.request_json);
  if (
    canonicalSessionSyncJson(request) !== row.request_json
    || digestCanonicalJson(request) !== row.request_digest
  ) {
    throw new ScheduledChatStoreError(
      "corrupt_state",
      "The scheduled chat mutation request authority drifted.",
    );
  }
  return {
    operationId: row.operation_id,
    paneId: row.pane_id,
    sessionId: row.session_id,
    kind: row.kind,
    state: row.state,
    expectedPaneRevision: row.expected_pane_revision,
    expectedScheduleRevision: row.expected_schedule_revision,
    targetScheduleRevision: row.target_schedule_revision,
    targetGeneration: row.target_generation,
    request,
    requestDigest: row.request_digest,
    rrule: row.rrule,
    timeZone: row.time_zone,
    nextRunAt: row.next_run_at,
    definitionCiphertextDigest: row.definition_ciphertext_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function localDesiredOff(
  row: z.infer<typeof desiredOffRowSchema>,
): LocalScheduledChatDesiredOff {
  return {
    paneId: row.pane_id,
    sessionId: row.session_id,
    targetGeneration: row.target_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function localRun(row: z.infer<typeof runRowSchema>): LocalScheduledChatRun {
  if ((row.state === "acknowledged") !== (row.acknowledged_at !== null)) {
    throw new ScheduledChatStoreError(
      "corrupt_state",
      "The scheduled chat run acknowledgment is invalid.",
    );
  }
  return {
    runId: row.run_id,
    paneId: row.pane_id,
    sessionId: row.session_id,
    scheduleGeneration: row.schedule_generation,
    occurrenceSequence: row.occurrence_sequence,
    scheduledFor: row.scheduled_for,
    messageId: row.message_id,
    state: row.state,
    enqueuedAt: row.enqueued_at,
    acknowledgedAt: row.acknowledged_at,
    cancelledAt: row.cancelled_at,
  };
}

export function scheduledChatMessageId(runId: string): ChatMessageId {
  const parsed = scheduledChatRunIdSchema.parse(runId);
  return chatMessageIdSchema.parse(
    `chatmsg_schedule_${createHash("sha256").update(parsed, "utf8").digest("hex").slice(0, 48)}`,
  );
}

export class ScheduledChatStore {
  readonly #database: Database;
  #paneMutationAuthority: ScheduledChatPaneMutationAuthority | null = null;

  constructor(database: Database) {
    this.#database = database;
  }

  transaction<Value>(operation: () => Value): Value {
    return this.#database.transaction(operation)();
  }

  bindPaneMutationAuthority(authority: ScheduledChatPaneMutationAuthority): void {
    if (this.#paneMutationAuthority !== null) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "Scheduled chat pane mutation authority is already bound.",
      );
    }
    this.#paneMutationAuthority = authority;
  }

  get(paneIdValue: string): LocalScheduledChat | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const value: unknown = this.#database.query(`
      SELECT pane_id, session_id, revision, generation, rrule, time_zone,
        key_epoch, next_run_at, definition_ciphertext_digest, created_at, updated_at
      FROM chat_scheduled_chats WHERE pane_id = ?1
    `).get(paneId);
    return value === null ? null : localSchedule(activeRowSchema.parse(value));
  }

  activeSchedules(): readonly LocalScheduledChat[] {
    const values: unknown[] = this.#database.query(`
      SELECT pane_id, session_id, revision, generation, key_epoch,
        rrule, time_zone, next_run_at, definition_ciphertext_digest,
        created_at, updated_at
      FROM chat_scheduled_chats
      ORDER BY pane_id
      LIMIT 65
    `).all();
    if (values.length > 64) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "Too many active scheduled chats are stored.",
      );
    }
    return values.map((value) => localSchedule(activeRowSchema.parse(value)));
  }

  generationHighWater(
    paneIdValue: string,
    sessionIdValue: SessionPublicId,
  ): LocalScheduledChatGenerationHighWater | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const sessionId = sessionPublicIdSchema.parse(sessionIdValue);
    const value: unknown = this.#database.query(`
      SELECT pane_id, session_id, generation, updated_at
      FROM chat_scheduled_chat_generation_high_water
      WHERE pane_id = ?1 AND session_id = ?2
    `).get(paneId, sessionId);
    if (value === null) return null;
    const row = generationHighWaterRowSchema.parse(value);
    return {
      paneId: row.pane_id,
      sessionId: row.session_id,
      generation: row.generation,
      updatedAt: row.updated_at,
    };
  }

  projection(paneIdValue: string): ChatScheduleProjection | null {
    const schedule = this.get(paneIdValue);
    return schedule === null ? null : chatScheduleProjectionSchema.parse({
      revision: schedule.revision,
      rrule: schedule.rrule,
      timeZone: schedule.timeZone,
      nextRunAt: new Date(schedule.nextRunAt).toISOString(),
    });
  }

  mutationForPane(paneIdValue: string): LocalScheduledChatMutation | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const value: unknown = this.#database.query(`
      SELECT operation_id, pane_id, session_id, kind, state,
        expected_pane_revision, expected_schedule_revision,
        target_schedule_revision, target_generation, request_json,
        request_digest, rrule, time_zone, next_run_at,
        definition_ciphertext_digest, created_at, updated_at
      FROM chat_scheduled_chat_mutations WHERE pane_id = ?1
    `).get(paneId);
    return value === null ? null : localMutation(mutationRowSchema.parse(value));
  }

  mutation(operationIdValue: string): LocalScheduledChatMutation | null {
    const operationId = z.string().min(11).max(96)
      .regex(/^syncop_[A-Za-z0-9_-]+$/u).parse(operationIdValue);
    const value: unknown = this.#database.query(`
      SELECT operation_id, pane_id, session_id, kind, state,
        expected_pane_revision, expected_schedule_revision,
        target_schedule_revision, target_generation, request_json,
        request_digest, rrule, time_zone, next_run_at,
        definition_ciphertext_digest, created_at, updated_at
      FROM chat_scheduled_chat_mutations WHERE operation_id = ?1
    `).get(operationId);
    return value === null ? null : localMutation(mutationRowSchema.parse(value));
  }

  pendingMutations(): readonly LocalScheduledChatMutation[] {
    const values: unknown[] = this.#database.query(`
      SELECT operation_id, pane_id, session_id, kind, state,
        expected_pane_revision, expected_schedule_revision,
        target_schedule_revision, target_generation, request_json,
        request_digest, rrule, time_zone, next_run_at,
        definition_ciphertext_digest, created_at, updated_at
      FROM chat_scheduled_chat_mutations
      ORDER BY created_at, operation_id
      LIMIT 65
    `).all();
    if (values.length > 64) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "Too many scheduled chat mutations are pending.",
      );
    }
    return values.map((value) => localMutation(mutationRowSchema.parse(value)));
  }

  desiredOff(paneIdValue: string): LocalScheduledChatDesiredOff | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const value: unknown = this.#database.query(`
      SELECT pane_id, session_id, target_generation, created_at, updated_at
      FROM chat_scheduled_chat_desired_off WHERE pane_id = ?1
    `).get(paneId);
    return value === null
      ? null
      : localDesiredOff(desiredOffRowSchema.parse(value));
  }

  desiredOffIntents(): readonly LocalScheduledChatDesiredOff[] {
    const values: unknown[] = this.#database.query(`
      SELECT pane_id, session_id, target_generation, created_at, updated_at
      FROM chat_scheduled_chat_desired_off
      ORDER BY created_at, pane_id
      LIMIT 65
    `).all();
    if (values.length > 64) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "Too many scheduled chat off intents are pending.",
      );
    }
    return values.map((value) =>
      localDesiredOff(desiredOffRowSchema.parse(value))
    );
  }

  requestDesiredOff(input: Readonly<{
    paneId: string;
    expectedPaneRevision: number;
    now: number;
  }>): LocalScheduledChatDesiredOff | null {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const now = scheduledChatEpochMsSchema.parse(input.now);
    return this.transaction(() => {
      this.#assertPaneMutationAllowed(paneId);
      const existing = this.desiredOff(paneId);
      if (existing !== null) return existing;
      this.#assertPaneRevision(paneId, input.expectedPaneRevision);
      const mutation = this.mutationForPane(paneId);
      const schedule = this.get(paneId);
      if (mutation === null && schedule === null) return null;
      const sessionId = mutation?.sessionId ?? schedule?.sessionId;
      const targetGeneration = mutation?.targetGeneration
        ?? schedule?.generation;
      if (
        sessionId === undefined
        || targetGeneration === undefined
        || (schedule !== null && mutation !== null
          && schedule.sessionId !== mutation.sessionId)
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The pending schedule change has mismatched off authority.",
        );
      }
      this.#database.query(`
        INSERT INTO chat_scheduled_chat_desired_off(
          pane_id, session_id, target_generation, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?4)
      `).run(paneId, sessionId, targetGeneration, now);
      return this.desiredOff(paneId) ?? corruption();
    });
  }

  settleDesiredOffWithoutSchedule(
    paneIdValue: string,
  ): void {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    this.transaction(() => {
      this.#assertPaneMutationAllowed(paneId);
      if (this.mutationForPane(paneId) !== null || this.get(paneId) !== null) {
        throw new ScheduledChatStoreError(
          "invalid_state",
          "The schedule off intent still has cloud work to settle.",
        );
      }
      this.#database.query(`
        DELETE FROM chat_scheduled_chat_desired_off WHERE pane_id = ?1
      `).run(paneId);
    });
  }

  paneRevision(paneIdValue: string): number {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const value: unknown = this.#database.query(`
      SELECT revision, archived_at, interaction_mode
      FROM chat_panes WHERE pane_id = ?1
    `).get(paneId);
    if (value === null) {
      throw new ScheduledChatStoreError("not_found", "This chat no longer exists.");
    }
    const pane = paneRevisionRowSchema.parse(value);
    if (pane.archived_at !== null || pane.interaction_mode !== "chat") {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "Only a live ordinary chat can own a schedule.",
      );
    }
    return pane.revision;
  }

  hasAuthorityBearingState(): boolean {
    const value: unknown = this.#database.query(`
      SELECT EXISTS(
        SELECT 1 FROM chat_scheduled_chats
        UNION ALL
        SELECT 1 FROM chat_scheduled_chat_mutations
        UNION ALL
        SELECT 1 FROM chat_scheduled_chat_desired_off
      ) AS present
    `).get();
    return z.object({ present: z.union([z.literal(0), z.literal(1)]) })
      .strict().parse(value).present === 1;
  }

  hasPendingMutation(): boolean {
    const value: unknown = this.#database.query(`
      SELECT EXISTS(
        SELECT 1 FROM chat_scheduled_chat_mutations
        UNION ALL
        SELECT 1 FROM chat_scheduled_chat_desired_off
      ) AS present
    `).get();
    return z.object({ present: z.union([z.literal(0), z.literal(1)]) })
      .strict().parse(value).present === 1;
  }

  hasDesiredOffIntent(): boolean {
    const value: unknown = this.#database.query(`
      SELECT EXISTS(SELECT 1 FROM chat_scheduled_chat_desired_off) AS present
    `).get();
    return z.object({ present: z.union([z.literal(0), z.literal(1)]) })
      .strict().parse(value).present === 1;
  }

  hasActiveOriginDevice(deviceIdValue: string): boolean {
    const deviceId = z.string().min(1).max(256).parse(deviceIdValue);
    const value: unknown = this.#database.query(`
      SELECT EXISTS(
        SELECT 1
        FROM chat_scheduled_chats AS schedule
        JOIN session_sync_pane_bindings AS binding
          ON binding.session_id = schedule.session_id
        WHERE binding.origin_device_id = ?1
      ) AS present
    `).get(deviceId);
    return z.object({ present: z.union([z.literal(0), z.literal(1)]) })
      .strict().parse(value).present === 1;
  }

  referencedRootKeyEpochs(): readonly PositiveSyncUint64[] {
    const values: unknown[] = this.#database.query(`
      SELECT key_epoch FROM chat_scheduled_chats ORDER BY key_epoch
    `).all();
    const epochs = new Set<PositiveSyncUint64>(values.map((value) =>
      z.object({ key_epoch: positiveSyncUint64Schema }).strict()
        .parse(value).key_epoch
    ));
    for (const mutation of this.pendingMutations()) {
      if (mutation.kind !== "put") continue;
      epochs.add(putScheduledChatRequestSchema.parse(mutation.request)
        .definition.header.keyEpoch);
    }
    return [...epochs].sort((left, right) => {
      const a = BigInt(left);
      const b = BigInt(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  preparePut(input: Readonly<{
    operationId: string;
    paneId: string;
    sessionId: SessionPublicId;
    expectedPaneRevision: number;
    targetGeneration: PositiveSyncUint64;
    request: unknown;
    definition: SealedScheduledChatDefinition;
    nextRunAt: number;
    now: number;
  }>): LocalScheduledChatMutation {
    const definition = sealedScheduledChatDefinitionSchema.parse(input.definition);
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const sessionId = sessionPublicIdSchema.parse(input.sessionId);
    const targetGeneration = positiveSyncUint64Schema.parse(input.targetGeneration);
    if (
      definition.header.sessionId !== sessionId
      || definition.header.generation !== targetGeneration
    ) {
      throw new TypeError("The scheduled chat definition has the wrong local coordinates.");
    }
    const now = scheduledChatEpochMsSchema.parse(input.now);
    const requestJson = canonicalSessionSyncJson(input.request);
    const requestDigest = digestCanonicalJson(input.request);
    return this.transaction(() => {
      this.#assertPaneMutationAllowed(paneId);
      this.#assertPaneRevision(paneId, input.expectedPaneRevision);
      if (this.mutationForPane(paneId) !== null) {
        throw new ScheduledChatStoreError(
          "invalid_state",
          "Another schedule change is still pending for this chat.",
        );
      }
      const current = this.get(paneId);
      const highWater = this.generationHighWater(paneId, sessionId);
      if (
        current !== null && current.sessionId !== sessionId
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The chat schedule belongs to a different synced session.",
        );
      }
      if (
        current !== null
        && (highWater === null || highWater.generation !== current.generation)
      ) {
        throw new ScheduledChatStoreError(
          "corrupt_state",
          "The active scheduled chat lost its generation high-water mark.",
        );
      }
      const previousGeneration = highWater?.generation ?? "0";
      if (
        definition.header.previousGeneration !== previousGeneration
        || BigInt(targetGeneration) !== BigInt(previousGeneration) + 1n
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The scheduled chat generation did not advance from its retained high-water mark.",
        );
      }
      const expectedScheduleRevision = current?.revision ?? null;
      const targetScheduleRevision = (expectedScheduleRevision ?? 0) + 1;
      this.#database.query(`
        INSERT INTO chat_scheduled_chat_mutations(
          operation_id, pane_id, session_id, kind, state,
          expected_pane_revision, expected_schedule_revision,
          target_schedule_revision, target_generation, request_json,
          request_digest, rrule, time_zone, next_run_at,
          definition_ciphertext_digest, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'put', 'prepared', ?4, ?5, ?6, ?7, ?8, ?9,
          ?10, ?11, ?12, ?13, ?14, ?14
        )
      `).run(
        input.operationId,
        paneId,
        sessionId,
        input.expectedPaneRevision,
        expectedScheduleRevision,
        targetScheduleRevision,
        targetGeneration,
        requestJson,
        requestDigest,
        definition.header.rrule,
        definition.header.timeZone,
        scheduledChatEpochMsSchema.parse(input.nextRunAt),
        definition.ciphertextDigest,
        now,
      );
      return this.mutation(input.operationId) ?? corruption();
    });
  }

  prepareClear(input: Readonly<{
    operationId: string;
    paneId: string;
    sessionId: SessionPublicId;
    expectedPaneRevision: number;
    targetGeneration: PositiveSyncUint64;
    request: unknown;
    now: number;
  }>): LocalScheduledChatMutation {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const sessionId = sessionPublicIdSchema.parse(input.sessionId);
    const now = scheduledChatEpochMsSchema.parse(input.now);
    return this.transaction(() => {
      this.#assertPaneMutationAllowed(paneId);
      this.#assertPaneRevision(paneId, input.expectedPaneRevision);
      if (this.mutationForPane(paneId) !== null) {
        throw new ScheduledChatStoreError(
          "invalid_state",
          "Another schedule change is still pending for this chat.",
        );
      }
      const current = this.get(paneId);
      if (current === null || current.sessionId !== sessionId) {
        throw new ScheduledChatStoreError(
          "not_found",
          "This chat no longer has the requested schedule.",
        );
      }
      const highWater = this.generationHighWater(paneId, sessionId);
      if (
        highWater === null
        || highWater.sessionId !== sessionId
        || highWater.generation !== current.generation
        || positiveSyncUint64Schema.parse(input.targetGeneration)
          !== highWater.generation
      ) {
        throw new ScheduledChatStoreError(
          "corrupt_state",
          "The scheduled chat generation high-water mark is invalid.",
        );
      }
      const requestJson = canonicalSessionSyncJson(input.request);
      const requestDigest = digestCanonicalJson(input.request);
      this.#database.query(`
        INSERT INTO chat_scheduled_chat_mutations(
          operation_id, pane_id, session_id, kind, state,
          expected_pane_revision, expected_schedule_revision,
          target_schedule_revision, target_generation, request_json,
          request_digest, rrule, time_zone, next_run_at,
          definition_ciphertext_digest, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'clear', 'prepared', ?4, ?5, NULL, ?6,
          ?7, ?8, NULL, NULL, NULL, NULL, ?9, ?9
        )
      `).run(
        input.operationId,
        paneId,
        sessionId,
        input.expectedPaneRevision,
        current.revision,
        positiveSyncUint64Schema.parse(input.targetGeneration),
        requestJson,
        requestDigest,
        now,
      );
      return this.mutation(input.operationId) ?? corruption();
    });
  }

  markEffectStarted(operationId: string, nowValue: number): LocalScheduledChatMutation {
    const now = scheduledChatEpochMsSchema.parse(nowValue);
    const before = this.mutation(operationId);
    if (before === null) {
      throw new ScheduledChatStoreError("not_found", "The schedule change is no longer pending.");
    }
    this.#assertPaneMutationAllowed(before.paneId);
    const changed = this.#database.query(`
      UPDATE chat_scheduled_chat_mutations
      SET state = 'effect_started', updated_at = ?2
      WHERE operation_id = ?1 AND state = 'prepared'
    `).run(operationId, now);
    const mutation = this.mutation(operationId);
    if (mutation === null || (changed.changes !== 1 && mutation.state !== "effect_started")) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The scheduled chat mutation effect fence changed.",
      );
    }
    return mutation;
  }

  discardPrepared(operationId: string): void {
    const before = this.mutation(operationId);
    if (before !== null) this.#assertPaneMutationAllowed(before.paneId);
    const changed = this.#database.query(`
      DELETE FROM chat_scheduled_chat_mutations
      WHERE operation_id = ?1 AND state = 'prepared'
    `).run(operationId);
    if (changed.changes !== 1 && this.mutation(operationId) !== null) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The scheduled chat mutation already crossed its effect fence.",
      );
    }
    if (changed.changes === 1 && before?.kind === "put") {
      this.#settleDefinitivelyUnappliedPutDesiredOff(before);
    }
  }

  rejectMutationInTransaction(operationId: string): void {
    const before = this.mutation(operationId);
    if (before === null) {
      throw new ScheduledChatStoreError("not_found", "The schedule change is no longer pending.");
    }
    this.#assertPaneMutationAllowed(before.paneId);
    const changed = this.#database.query(`
      DELETE FROM chat_scheduled_chat_mutations
      WHERE operation_id = ?1 AND state = 'effect_started'
    `).run(operationId);
    if (changed.changes !== 1) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The rejected scheduled chat mutation no longer owns its effect fence.",
      );
    }
    if (before.kind === "put") {
      this.#settleDefinitivelyUnappliedPutDesiredOff(before);
    }
  }

  completeMutationInTransaction(
    operationId: string,
    nowValue: number,
    responseValue: ScheduledChatPutResponse | ScheduledChatClearedResponse,
  ): ChatScheduleProjection | null {
    const now = scheduledChatEpochMsSchema.parse(nowValue);
    const mutation = this.mutation(operationId);
    if (mutation === null || mutation.state !== "effect_started") {
      throw new ScheduledChatStoreError(
        "not_found",
        "The scheduled chat mutation is no longer pending.",
      );
    }
    this.#assertPaneMutationAllowed(mutation.paneId);
    const pane = this.#assertPaneRevision(
      mutation.paneId,
      mutation.expectedPaneRevision,
    );
    const current = this.get(mutation.paneId);
    if (
      (current?.revision ?? null) !== mutation.expectedScheduleRevision
      || (current !== null && current.sessionId !== mutation.sessionId)
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The scheduled chat changed before its cloud mutation settled.",
      );
    }
    const desiredOff = this.desiredOff(mutation.paneId);
    if (
      desiredOff !== null
      && (
        desiredOff.sessionId !== mutation.sessionId
        || desiredOff.targetGeneration !== mutation.targetGeneration
      )
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The schedule off intent changed before its cloud mutation settled.",
      );
    }
    if (mutation.kind === "put") {
      const response = scheduledChatPutResponseSchema.parse(responseValue);
      const request = putScheduledChatRequestSchema.parse(mutation.request);
      if (
        mutation.targetScheduleRevision === null
        || mutation.rrule === null
        || mutation.timeZone === null
        || mutation.nextRunAt === null
        || mutation.definitionCiphertextDigest === null
      ) corruption();
      if (
        response.sessionId !== mutation.sessionId
        || response.schedule.generation !== mutation.targetGeneration
        || response.schedule.rrule !== mutation.rrule
        || response.schedule.timeZone !== mutation.timeZone
        || response.ciphertextDigest !== mutation.definitionCiphertextDigest
        || request.definition.header.sessionId !== mutation.sessionId
        || request.definition.header.generation !== mutation.targetGeneration
        || request.definition.ciphertextDigest !== mutation.definitionCiphertextDigest
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The encrypted relay returned a different scheduled chat authority.",
        );
      }
      if (desiredOff !== null) this.#deleteDesiredOff(desiredOff.paneId);
      this.#releaseMutationFence(operationId);
      const previousGeneration = String(BigInt(mutation.targetGeneration) - 1n);
      const priorHighWater = this.generationHighWater(
        mutation.paneId,
        mutation.sessionId,
      );
      if (
        (previousGeneration === "0" && priorHighWater !== null)
        || (previousGeneration !== "0" && (
          priorHighWater?.sessionId !== mutation.sessionId
          || priorHighWater.generation !== previousGeneration
        ))
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The scheduled chat generation high-water mark changed before settlement.",
        );
      }
      this.#database.query(`
        INSERT INTO chat_scheduled_chat_generation_high_water(
          pane_id, session_id, generation, updated_at
        ) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(pane_id, session_id) DO UPDATE SET
          generation = excluded.generation,
          updated_at = excluded.updated_at
        WHERE generation = ?5
      `).run(
        mutation.paneId,
        mutation.sessionId,
        mutation.targetGeneration,
        now,
        previousGeneration,
      );
      const highWater = this.generationHighWater(
        mutation.paneId,
        mutation.sessionId,
      );
      if (
        highWater?.sessionId !== mutation.sessionId
        || highWater.generation !== mutation.targetGeneration
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The scheduled chat generation high-water mark did not advance.",
        );
      }
      this.#database.query(`
        INSERT INTO chat_scheduled_chats(
          pane_id, session_id, revision, generation, key_epoch, rrule, time_zone,
          next_run_at, definition_ciphertext_digest, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
        ON CONFLICT(pane_id) DO UPDATE SET
          session_id = excluded.session_id,
          revision = excluded.revision,
          generation = excluded.generation,
          key_epoch = excluded.key_epoch,
          rrule = excluded.rrule,
          time_zone = excluded.time_zone,
          next_run_at = excluded.next_run_at,
          definition_ciphertext_digest = excluded.definition_ciphertext_digest,
          updated_at = excluded.updated_at
      `).run(
        mutation.paneId,
        mutation.sessionId,
        mutation.targetScheduleRevision,
        mutation.targetGeneration,
        request.definition.header.keyEpoch,
        mutation.rrule,
        mutation.timeZone,
        response.schedule.nextRunAt,
        mutation.definitionCiphertextDigest,
        current?.createdAt ?? now,
      );
    } else {
      const response = scheduledChatClearedResponseSchema.parse(responseValue);
      if (
        response.sessionId !== mutation.sessionId
        || response.generation !== mutation.targetGeneration
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The encrypted relay cleared a different scheduled chat authority.",
        );
      }
      if (desiredOff !== null) this.#deleteDesiredOff(desiredOff.paneId);
      this.#releaseMutationFence(operationId);
      const removed = this.#database.query(`
        DELETE FROM chat_scheduled_chats
        WHERE pane_id = ?1 AND revision = ?2 AND generation = ?3
      `).run(
        mutation.paneId,
        mutation.expectedScheduleRevision,
        mutation.targetGeneration,
      );
      if (removed.changes !== 1) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The scheduled chat removal authority changed.",
        );
      }
      this.#cancelUnclaimedRuns(
        mutation.paneId,
        mutation.sessionId,
        mutation.targetGeneration,
        now,
      );
      this.#paneMutationAuthority?.settleScheduledClearQueue({
        paneId: mutation.paneId,
        now: new Date(now),
      });
    }
    const bumped = this.#database.query(`
      UPDATE chat_panes SET revision = revision + 1, updated_at = ?2
      WHERE pane_id = ?1 AND revision = ?3 AND archived_at IS NULL
    `).run(
      mutation.paneId,
      new Date(now).toISOString(),
      pane.revision,
    );
    if (bumped.changes < 1) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The chat changed before its schedule projection committed.",
      );
    }
    if (mutation.kind === "put" && desiredOff !== null) {
      this.#restoreDesiredOff(desiredOff, now);
    }
    return this.projection(mutation.paneId);
  }

  settleMutationThroughHumanClearInTransaction(input: Readonly<{
    operationId: string;
    expectedSessionId: SessionPublicId;
    expectedGeneration: PositiveSyncUint64;
    expectedCiphertextDigest: SyncSha256Digest;
    now: number;
  }>): ChatScheduleProjection | null {
    const mutation = this.mutation(input.operationId);
    if (mutation === null || mutation.state !== "effect_started") {
      throw new ScheduledChatStoreError(
        "not_found",
        "The encrypted schedule mutation is no longer awaiting recovery.",
      );
    }
    const sessionId = sessionPublicIdSchema.parse(input.expectedSessionId);
    const generation = positiveSyncUint64Schema.parse(input.expectedGeneration);
    const ciphertextDigest = syncSha256DigestSchema.parse(
      input.expectedCiphertextDigest,
    );
    const now = scheduledChatEpochMsSchema.parse(input.now);
    if (
      mutation.sessionId !== sessionId
      || mutation.targetGeneration !== generation
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The human-authorized clear does not match the pending schedule generation.",
      );
    }
    this.#assertPaneMutationAllowed(mutation.paneId);
    const pane = this.#assertPaneRevision(
      mutation.paneId,
      mutation.expectedPaneRevision,
    );
    const current = this.get(mutation.paneId);
    if (
      (current?.revision ?? null) !== mutation.expectedScheduleRevision
      || (current !== null && current.sessionId !== sessionId)
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The local schedule changed before its human-authorized clear settled.",
      );
    }
    const desiredOff = this.desiredOff(mutation.paneId);
    if (
      desiredOff !== null
      && (
        desiredOff.sessionId !== sessionId
        || desiredOff.targetGeneration !== generation
      )
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The durable schedule off intent changed before recovery settled.",
      );
    }
    const highWater = this.generationHighWater(mutation.paneId, sessionId);
    if (mutation.kind === "put") {
      const request = putScheduledChatRequestSchema.parse(mutation.request);
      const previousGeneration = String(BigInt(generation) - 1n);
      if (
        mutation.definitionCiphertextDigest !== ciphertextDigest
        || request.definition.header.sessionId !== sessionId
        || request.definition.header.generation !== generation
        || request.definition.ciphertextDigest !== ciphertextDigest
        || request.definition.header.previousGeneration !== previousGeneration
        || (previousGeneration === "0"
          ? highWater !== null
          : highWater?.generation !== previousGeneration)
        || (current !== null && current.generation !== previousGeneration)
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The human-authorized clear does not match the pending encrypted definition.",
        );
      }
    } else {
      const request = clearScheduledChatRequestSchema.parse(mutation.request);
      if (
        request.sessionId !== sessionId
        || request.expectedGeneration !== generation
        || current === null
        || current.generation !== generation
        || current.definitionCiphertextDigest !== ciphertextDigest
        || highWater?.generation !== generation
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The human-authorized clear does not match the pending encrypted removal.",
        );
      }
    }

    if (desiredOff !== null) this.#deleteDesiredOff(mutation.paneId);
    this.#releaseMutationFence(mutation.operationId);
    this.#cancelUnclaimedRunsThrough(
      mutation.paneId,
      sessionId,
      generation,
      now,
    );
    this.#paneMutationAuthority?.settleScheduledClearQueue({
      paneId: mutation.paneId,
      now: new Date(now),
    });
    this.#database.query(`
      DELETE FROM chat_scheduled_chats
      WHERE pane_id = ?1 AND session_id = ?2
        AND (length(generation) < length(?3)
          OR (length(generation) = length(?3) AND generation <= ?3))
    `).run(mutation.paneId, sessionId, generation);
    this.#database.query(`
      INSERT INTO chat_scheduled_chat_generation_high_water(
        pane_id, session_id, generation, updated_at
      ) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(pane_id, session_id) DO UPDATE SET
        generation = excluded.generation,
        updated_at = excluded.updated_at
      WHERE length(generation) < length(excluded.generation)
        OR (length(generation) = length(excluded.generation)
          AND generation <= excluded.generation)
    `).run(mutation.paneId, sessionId, generation, now);
    if (this.generationHighWater(mutation.paneId, sessionId)?.generation !== generation) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The human-authorized clear did not retain its generation fence.",
      );
    }
    const bumped = this.#database.query(`
      UPDATE chat_panes SET revision = revision + 1, updated_at = ?2
      WHERE pane_id = ?1 AND revision = ?3 AND archived_at IS NULL
    `).run(mutation.paneId, new Date(now).toISOString(), pane.revision);
    if (bumped.changes < 1 || this.get(mutation.paneId) !== null) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The pane changed before its human-authorized schedule clear committed.",
      );
    }
    return null;
  }

  settleRunAcknowledgmentThroughHumanClearInTransaction(input: Readonly<{
    runId: string;
    expectedPaneId: string;
    expectedSessionId: SessionPublicId;
    expectedScheduleGeneration: PositiveSyncUint64;
    expectedOccurrenceSequence: PositiveSyncUint64;
    expectedScheduledFor: number;
    now: number;
  }>): LocalScheduledChatRun {
    const run = this.run(input.runId);
    const paneId = chatPaneIdSchema.parse(input.expectedPaneId);
    const sessionId = sessionPublicIdSchema.parse(input.expectedSessionId);
    const generation = positiveSyncUint64Schema.parse(
      input.expectedScheduleGeneration,
    );
    const occurrenceSequence = positiveSyncUint64Schema.parse(
      input.expectedOccurrenceSequence,
    );
    const scheduledFor = scheduledChatEpochMsSchema.parse(
      input.expectedScheduledFor,
    );
    if (
      run === null
      || run.paneId !== paneId
      || run.sessionId !== sessionId
      || run.scheduleGeneration !== generation
      || run.occurrenceSequence !== occurrenceSequence
      || run.scheduledFor !== scheduledFor
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The human-authorized clear does not match the scheduled run acknowledgment.",
      );
    }
    this.#assertPaneMutationAllowed(paneId);
    if (this.get(paneId) !== null) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "The scheduled run cannot be superseded before its schedule is cleared.",
      );
    }
    if (run.state === "acknowledged") return run;
    const now = scheduledChatEpochMsSchema.parse(input.now);
    const changed = this.#database.query(`
      UPDATE chat_scheduled_chat_runs
      SET state = 'acknowledged', acknowledged_at = ?2
      WHERE run_id = ?1 AND state = 'enqueued'
    `).run(run.runId, now);
    if (changed.changes !== 1) corruption();
    return this.run(run.runId) ?? corruption();
  }

  run(runIdValue: string): LocalScheduledChatRun | null {
    const runId = scheduledChatRunIdSchema.parse(runIdValue);
    const value: unknown = this.#database.query(`
      SELECT run_id, pane_id, schedule_generation, occurrence_sequence,
        session_id, scheduled_for, message_id, state, enqueued_at,
        acknowledged_at, cancelled_at
      FROM chat_scheduled_chat_runs WHERE run_id = ?1
    `).get(runId);
    return value === null ? null : localRun(runRowSchema.parse(value));
  }

  runForMessage(
    paneIdValue: string,
    messageIdValue: ChatMessageId,
  ): LocalScheduledChatRun | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const messageId = chatMessageIdSchema.parse(messageIdValue);
    const value: unknown = this.#database.query(`
      SELECT run_id, pane_id, schedule_generation, occurrence_sequence,
        session_id, scheduled_for, message_id, state, enqueued_at,
        acknowledged_at, cancelled_at
      FROM chat_scheduled_chat_runs
      WHERE pane_id = ?1 AND message_id = ?2
    `).get(paneId, messageId);
    return value === null ? null : localRun(runRowSchema.parse(value));
  }

  runForTurn(
    paneIdValue: string,
    turnIdValue: string,
  ): LocalScheduledChatRun | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const turnId = chatTurnIdSchema.parse(turnIdValue);
    const value: unknown = this.#database.query(`
      SELECT run.run_id, run.pane_id, run.schedule_generation,
        run.occurrence_sequence, run.session_id, run.scheduled_for,
        run.message_id, run.state, run.enqueued_at, run.acknowledged_at,
        run.cancelled_at
      FROM chat_scheduled_chat_runs AS run
      JOIN chat_message_ledger AS message
        ON message.pane_id = run.pane_id
       AND message.message_id = run.message_id
      WHERE run.pane_id = ?1 AND message.claimed_turn_id = ?2
    `).get(paneId, turnId);
    return value === null ? null : localRun(runRowSchema.parse(value));
  }

  enqueueRunInTransaction<Value>(input: Readonly<{
    runId: string;
    paneId: string;
    scheduleGeneration: PositiveSyncUint64;
    occurrenceSequence: PositiveSyncUint64;
    scheduledFor: number;
    definitionCiphertextDigest: SyncSha256Digest;
    now: number;
    enqueue: (messageId: ChatMessageId) => Value;
  }>): Readonly<{
    run: LocalScheduledChatRun;
    disposition: "applied" | "replayed";
    value: Value | null;
  }> {
    const runId = scheduledChatRunIdSchema.parse(input.runId);
    const active = this.get(input.paneId);
    if (
      active === null
      || active.generation !== positiveSyncUint64Schema.parse(input.scheduleGeneration)
      || active.definitionCiphertextDigest !== syncSha256DigestSchema.parse(
        input.definitionCiphertextDigest,
      )
    ) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "This scheduled occurrence no longer belongs to the active chat schedule.",
      );
    }
    if (this.mutationForPane(active.paneId) !== null) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "Wait for the pending schedule change before running this chat.",
      );
    }
    if (this.desiredOff(active.paneId) !== null) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "This scheduled chat is being turned off.",
      );
    }
    const existing = this.run(runId);
    if (existing !== null) {
      if (
        existing.paneId !== input.paneId
        || existing.sessionId !== active.sessionId
        || existing.scheduleGeneration !== input.scheduleGeneration
        || existing.occurrenceSequence !== input.occurrenceSequence
        || existing.scheduledFor !== input.scheduledFor
        || existing.cancelledAt !== null
      ) throw new ScheduledChatStoreError("conflict", "Scheduled chat run identity changed.");
      return { run: existing, disposition: "replayed", value: null };
    }
    this.#assertPaneMutationAllowed(active.paneId);
    const messageId = scheduledChatMessageId(runId);
    const value = input.enqueue(messageId);
    this.#database.query(`
      INSERT INTO chat_scheduled_chat_runs(
        run_id, pane_id, session_id, schedule_generation, occurrence_sequence,
        scheduled_for, message_id, state, enqueued_at, acknowledged_at,
        cancelled_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'enqueued', ?8, NULL, NULL)
    `).run(
      runId,
      active.paneId,
      active.sessionId,
      active.generation,
      positiveSyncUint64Schema.parse(input.occurrenceSequence),
      scheduledChatEpochMsSchema.parse(input.scheduledFor),
      messageId,
      scheduledChatEpochMsSchema.parse(input.now),
    );
    return {
      run: this.run(runId) ?? corruption(),
      disposition: "applied",
      value,
    };
  }

  acknowledgeRunInTransaction(input: Readonly<{
    runId: string;
    expectedPaneId: string;
    expectedSessionId: SessionPublicId;
    expectedScheduleGeneration: PositiveSyncUint64;
    expectedOccurrenceSequence: PositiveSyncUint64;
    expectedScheduledFor: number;
    nextRunAt: number | null;
    now: number;
  }>): LocalScheduledChatRun {
    const run = this.run(input.runId);
    if (
      run === null
      || run.paneId !== chatPaneIdSchema.parse(input.expectedPaneId)
      || run.sessionId !== sessionPublicIdSchema.parse(input.expectedSessionId)
      || run.scheduleGeneration !== positiveSyncUint64Schema.parse(
        input.expectedScheduleGeneration,
      )
      || run.occurrenceSequence !== positiveSyncUint64Schema.parse(
        input.expectedOccurrenceSequence,
      )
      || run.scheduledFor !== scheduledChatEpochMsSchema.parse(
        input.expectedScheduledFor,
      )
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "Scheduled chat run acknowledgment authority changed.",
      );
    }
    if (run.state === "acknowledged") return run;
    this.#assertPaneMutationAllowed(run.paneId);
    const now = scheduledChatEpochMsSchema.parse(input.now);
    const changed = this.#database.query(`
      UPDATE chat_scheduled_chat_runs
      SET state = 'acknowledged', acknowledged_at = ?2
      WHERE run_id = ?1 AND state = 'enqueued'
    `).run(run.runId, now);
    if (changed.changes !== 1) corruption();
    const active = this.get(run.paneId);
    if (active !== null && active.generation === run.scheduleGeneration) {
      if (input.nextRunAt === null) {
        throw new ScheduledChatStoreError(
          "corrupt_state",
          "An active recurring chat schedule must retain a next run.",
        );
      }
      const scheduleChanged = this.#database.query(`
        UPDATE chat_scheduled_chats
        SET next_run_at = ?3, updated_at = ?4
        WHERE pane_id = ?1 AND generation = ?2
      `).run(
        run.paneId,
        run.scheduleGeneration,
        scheduledChatEpochMsSchema.parse(input.nextRunAt),
        now,
      );
      if (scheduleChanged.changes !== 1) corruption();
      const paneChanged = this.#database.query(`
        UPDATE chat_panes SET revision = revision + 1, updated_at = ?2
        WHERE pane_id = ?1 AND archived_at IS NULL
      `).run(run.paneId, new Date(now).toISOString());
      if (paneChanged.changes < 1) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The scheduled chat pane disappeared before its next run advanced.",
        );
      }
    }
    return this.run(run.runId) ?? corruption();
  }

  reconcileInventoryEntryInTransaction(input: Readonly<{
    paneId: string;
    entry: ScheduledChatInventoryEntry;
    now: number;
  }>): Readonly<{
    changed: boolean;
    projection: ChatScheduleProjection | null;
  }> {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const entry = input.entry;
    const sessionId = sessionPublicIdSchema.parse(entry.sessionId);
    const generation = positiveSyncUint64Schema.parse(entry.generation);
    const now = scheduledChatEpochMsSchema.parse(input.now);
    this.#assertPaneMutationAllowed(paneId);
    if (this.mutationForPane(paneId) !== null) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "Recover the pending scheduled chat transition before cloud inventory.",
      );
    }
    const desiredOff = this.desiredOff(paneId);
    if (
      desiredOff !== null
      && (
        entry.state !== "cleared"
        || desiredOff.sessionId !== sessionId
        || desiredOff.targetGeneration !== generation
      )
    ) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "Cloud schedule inventory cannot cross a different durable off intent.",
      );
    }
    if (desiredOff !== null) this.#deleteDesiredOff(paneId);
    const paneValue: unknown = this.#database.query(`
      SELECT revision, archived_at, interaction_mode
      FROM chat_panes WHERE pane_id = ?1
    `).get(paneId);
    if (paneValue === null) {
      throw new ScheduledChatStoreError(
        "not_found",
        "The cloud scheduled chat has no local pane.",
      );
    }
    const pane = paneRevisionRowSchema.parse(paneValue);
    if (pane.archived_at !== null || pane.interaction_mode !== "chat") {
      throw new ScheduledChatStoreError(
        "conflict",
        "The cloud scheduled chat maps to an ineligible local pane.",
      );
    }
    const current = this.get(paneId);
    if (current !== null && current.sessionId !== sessionId) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "Cloud schedule inventory conflicts with the pane's local session.",
      );
    }
    const highWater = this.generationHighWater(paneId, sessionId);
    if (
      highWater !== null
      && BigInt(highWater.generation) > BigInt(generation)
    ) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "Cloud schedule inventory regressed below the local generation fence.",
      );
    }
    if (entry.state === "active") {
      const definition = sealedScheduledChatDefinitionSchema.parse(
        entry.definition,
      );
      if (
        definition.header.sessionId !== sessionId
        || definition.header.generation !== generation
        || definition.header.originDeviceId !== entry.originDeviceId
      ) corruption();
      if (
        current !== null
        && current.generation === generation
        && (
          current.keyEpoch !== definition.header.keyEpoch
          || current.rrule !== definition.header.rrule
          || current.timeZone !== definition.header.timeZone
          || current.definitionCiphertextDigest !== definition.ciphertextDigest
        )
      ) {
        throw new ScheduledChatStoreError(
          "corrupt_state",
          "Cloud schedule inventory changed immutable definition authority.",
        );
      }
      if (
        current !== null
        && current.generation === generation
        && current.nextRunAt === entry.nextRunAt
        && highWater?.generation === generation
      ) return { changed: false, projection: this.projection(paneId) };
      if (current !== null && current.generation !== generation) {
        this.#cancelUnclaimedRunsThrough(
          paneId,
          sessionId,
          generation,
          now,
        );
      }
      this.#database.query(`
        INSERT INTO chat_scheduled_chat_generation_high_water(
          pane_id, session_id, generation, updated_at
        ) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(pane_id, session_id) DO UPDATE SET
          generation = excluded.generation,
          updated_at = excluded.updated_at
        WHERE length(generation) < length(excluded.generation)
          OR (length(generation) = length(excluded.generation)
            AND generation <= excluded.generation)
      `).run(paneId, sessionId, generation, now);
      this.#database.query(`
        INSERT INTO chat_scheduled_chats(
          pane_id, session_id, revision, generation, key_epoch, rrule,
          time_zone, next_run_at, definition_ciphertext_digest,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
        ON CONFLICT(pane_id) DO UPDATE SET
          session_id = excluded.session_id,
          revision = excluded.revision,
          generation = excluded.generation,
          key_epoch = excluded.key_epoch,
          rrule = excluded.rrule,
          time_zone = excluded.time_zone,
          next_run_at = excluded.next_run_at,
          definition_ciphertext_digest = excluded.definition_ciphertext_digest,
          updated_at = excluded.updated_at
      `).run(
        paneId,
        sessionId,
        current === null
          ? 1
          : current.generation === generation
          ? current.revision
          : current.revision + 1,
        generation,
        definition.header.keyEpoch,
        definition.header.rrule,
        definition.header.timeZone,
        scheduledChatEpochMsSchema.parse(entry.nextRunAt),
        definition.ciphertextDigest,
        current?.createdAt ?? now,
      );
    } else {
      if (
        current === null
        && highWater?.generation === generation
      ) return { changed: desiredOff !== null, projection: null };
      this.#cancelUnclaimedRunsThrough(paneId, sessionId, generation, now);
      this.#paneMutationAuthority?.settleScheduledClearQueue({
        paneId,
        now: new Date(now),
      });
      this.#database.query(`
        DELETE FROM chat_scheduled_chats
        WHERE pane_id = ?1 AND session_id = ?2
          AND (length(generation) < length(?3)
            OR (length(generation) = length(?3) AND generation <= ?3))
      `).run(paneId, sessionId, generation);
      this.#database.query(`
        INSERT INTO chat_scheduled_chat_generation_high_water(
          pane_id, session_id, generation, updated_at
        ) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(pane_id, session_id) DO UPDATE SET
          generation = excluded.generation,
          updated_at = excluded.updated_at
        WHERE length(generation) < length(excluded.generation)
          OR (length(generation) = length(excluded.generation)
            AND generation <= excluded.generation)
      `).run(paneId, sessionId, generation, now);
    }
    if (this.generationHighWater(paneId, sessionId)?.generation !== generation) {
      throw new ScheduledChatStoreError(
        "conflict",
        "Cloud schedule inventory did not advance the generation fence.",
      );
    }
    const bumped = this.#database.query(`
      UPDATE chat_panes SET revision = revision + 1, updated_at = ?2
      WHERE pane_id = ?1 AND revision = ?3 AND archived_at IS NULL
    `).run(paneId, new Date(now).toISOString(), pane.revision);
    if (bumped.changes < 1) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The pane changed while cloud schedule inventory reconciled.",
      );
    }
    return { changed: true, projection: this.projection(paneId) };
  }

  purgeTerminalRuns(nowValue: number): number {
    const now = scheduledChatEpochMsSchema.parse(nowValue);
    const cutoff = Math.max(0, now - SCHEDULED_CHAT_LOCAL_RUN_RETENTION_MS);
    return this.transaction(() => {
      const values: unknown[] = this.#database.query(`
        SELECT run.run_id, run.pane_id
        FROM chat_scheduled_chat_runs AS run
        JOIN chat_message_ledger AS message
          ON message.pane_id = run.pane_id
         AND message.message_id = run.message_id
        WHERE run.state = 'acknowledged'
          AND run.acknowledged_at <= ?1
          AND message.state IN ('completed', 'cancelled')
        ORDER BY run.acknowledged_at, run.run_id
        LIMIT 64
      `).all(cutoff);
      const rows = values.map((value) => z.object({
        run_id: scheduledChatRunIdSchema,
        pane_id: chatPaneIdSchema,
      }).strict().parse(value));
      for (const row of rows) {
        this.#assertPaneMutationAllowed(row.pane_id);
        const removed = this.#database.query(`
          DELETE FROM chat_scheduled_chat_runs
          WHERE run_id = ?1 AND state = 'acknowledged'
            AND acknowledged_at <= ?2
        `).run(row.run_id, cutoff);
        if (removed.changes !== 1) corruption();
      }
      return rows.length;
    });
  }

  #assertPaneMutationAllowed(paneId: ChatPaneProjection["id"]): void {
    const authority = this.#paneMutationAuthority;
    if (authority === null) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "Scheduled chat mutation authority is unavailable.",
      );
    }
    authority.assertPaneMutationAllowed(paneId);
  }

  #cancelUnclaimedRuns(
    paneId: ChatPaneProjection["id"],
    sessionId: SessionPublicId,
    generation: PositiveSyncUint64,
    now: number,
  ): void {
    const values: unknown[] = this.#database.query(`
      SELECT run_id, pane_id, session_id, schedule_generation,
        occurrence_sequence, scheduled_for, message_id, state, enqueued_at,
        acknowledged_at, cancelled_at
      FROM chat_scheduled_chat_runs
      WHERE pane_id = ?1 AND session_id = ?2 AND schedule_generation = ?3
        AND cancelled_at IS NULL
      ORDER BY scheduled_for, run_id
    `).all(paneId, sessionId, generation);
    const authority = this.#paneMutationAuthority;
    if (authority === null) corruption();
    for (const value of values) {
      const run = localRun(runRowSchema.parse(value));
      if (!authority.cancelUnclaimedScheduledMessage({
        paneId,
        messageId: run.messageId,
        now: new Date(now),
      })) continue;
      const cancelled = this.#database.query(`
        UPDATE chat_scheduled_chat_runs SET cancelled_at = ?2
        WHERE run_id = ?1 AND cancelled_at IS NULL
      `).run(run.runId, now);
      if (cancelled.changes !== 1) corruption();
    }
  }

  #cancelUnclaimedRunsThrough(
    paneId: ChatPaneProjection["id"],
    sessionId: SessionPublicId,
    generation: PositiveSyncUint64,
    now: number,
  ): void {
    const generations: unknown[] = this.#database.query(`
      SELECT DISTINCT schedule_generation
      FROM chat_scheduled_chat_runs
      WHERE pane_id = ?1 AND session_id = ?2
        AND (length(schedule_generation) < length(?3)
          OR (length(schedule_generation) = length(?3)
            AND schedule_generation <= ?3))
        AND cancelled_at IS NULL
      ORDER BY length(schedule_generation), schedule_generation
    `).all(paneId, sessionId, generation);
    for (const value of generations) {
      const parsed = z.object({
        schedule_generation: positiveSyncUint64Schema,
      }).strict().parse(value);
      this.#cancelUnclaimedRuns(
        paneId,
        sessionId,
        parsed.schedule_generation,
        now,
      );
    }
  }

  #releaseMutationFence(operationId: string): void {
    const removed = this.#database.query(`
      DELETE FROM chat_scheduled_chat_mutations
      WHERE operation_id = ?1 AND state = 'effect_started'
    `).run(operationId);
    if (removed.changes !== 1) corruption();
  }

  #deleteDesiredOff(paneId: string): void {
    const removed = this.#database.query(`
      DELETE FROM chat_scheduled_chat_desired_off WHERE pane_id = ?1
    `).run(paneId);
    if (removed.changes !== 1) corruption();
  }

  #settleDefinitivelyUnappliedPutDesiredOff(
    mutation: LocalScheduledChatMutation,
  ): void {
    const desired = this.desiredOff(mutation.paneId);
    if (
      desired === null
      || desired.sessionId !== mutation.sessionId
      || desired.targetGeneration !== mutation.targetGeneration
    ) return;
    const current = this.get(mutation.paneId);
    if (current === null) {
      this.#deleteDesiredOff(mutation.paneId);
      return;
    }
    if (current.sessionId !== mutation.sessionId) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The rejected schedule update left an off intent for another session.",
      );
    }
    const changed = this.#database.query(`
      UPDATE chat_scheduled_chat_desired_off
      SET target_generation = ?2, updated_at = ?3
      WHERE pane_id = ?1 AND session_id = ?4 AND target_generation = ?5
    `).run(
      mutation.paneId,
      current.generation,
      Math.max(desired.updatedAt, mutation.updatedAt),
      mutation.sessionId,
      mutation.targetGeneration,
    );
    if (changed.changes !== 1) corruption();
  }

  #restoreDesiredOff(
    desired: LocalScheduledChatDesiredOff,
    now: number,
  ): void {
    this.#database.query(`
      INSERT INTO chat_scheduled_chat_desired_off(
        pane_id, session_id, target_generation, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)
    `).run(
      desired.paneId,
      desired.sessionId,
      desired.targetGeneration,
      desired.createdAt,
      Math.max(now, desired.updatedAt),
    );
  }

  #assertPaneRevision(paneId: string, expectedRevision: number) {
    const value: unknown = this.#database.query(`
      SELECT revision, archived_at, interaction_mode
      FROM chat_panes WHERE pane_id = ?1
    `).get(paneId);
    if (value === null) {
      throw new ScheduledChatStoreError("not_found", "This chat no longer exists.");
    }
    const pane = paneRevisionRowSchema.parse(value);
    if (
      pane.archived_at !== null
      || pane.interaction_mode !== "chat"
      || pane.revision !== expectedRevision
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "This chat changed before its schedule could be updated.",
      );
    }
    return pane;
  }
}

function corruption(): never {
  throw new ScheduledChatStoreError(
    "corrupt_state",
    "Stored scheduled chat state is invalid.",
  );
}
