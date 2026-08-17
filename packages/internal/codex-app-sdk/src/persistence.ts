import type {
  AttemptId,
  DispatchOutcome,
} from "./client.js";
import type { SourceCoordinate } from "./coordinates.js";
import type { Unsubscribe } from "./store.js";

declare const mutationFingerprintBrand: unique symbol;

const MAX_MUTATION_FINGERPRINT_LENGTH = 512;
const MUTATION_FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export type MutationFingerprint = string & {
  readonly [mutationFingerprintBrand]: "MutationFingerprint";
};

export function isMutationFingerprint(
  value: string,
): value is MutationFingerprint {
  return (
    value.length > 0 &&
    value.length <= MAX_MUTATION_FINGERPRINT_LENGTH &&
    MUTATION_FINGERPRINT_PATTERN.test(value)
  );
}

export function createMutationFingerprint(
  value: string,
): MutationFingerprint {
  if (!isMutationFingerprint(value)) {
    throw new RangeError(
      `mutation fingerprint must contain 1 to ${String(MAX_MUTATION_FINGERPRINT_LENGTH)} portable identifier characters`,
    );
  }
  return value;
}

export type VersionedValue<Value> =
  | Readonly<{
      revision: number;
      state: "present";
      value: Value;
    }>
  | Readonly<{
      revision: number;
      state: "deleted";
    }>;

export type ConditionalWriteResult<Value> =
  | Readonly<{
      status: "applied";
      current: VersionedValue<Value> | null;
    }>
  | Readonly<{
      status: "conflict";
      current: VersionedValue<Value> | null;
    }>;

export interface BindingStore<Binding> {
  readonly get: (key: string) => Promise<VersionedValue<Binding> | null>;
  readonly set: (
    key: string,
    value: Binding,
    expectedRevision: number | null,
  ) => Promise<ConditionalWriteResult<Binding>>;
  readonly delete: (
    key: string,
    expectedRevision: number | null,
  ) => Promise<ConditionalWriteResult<Binding>>;
}

export interface ProjectionCheckpoint<Projection> {
  readonly schema: Readonly<{
    name: string;
    version: number;
  }>;
  readonly contentPolicy: string;
  readonly source: SourceCoordinate;
  readonly createdAtMs: number;
  readonly projection: Projection;
}

export interface ProjectionCheckpointStore<Projection> {
  readonly get: (
    key: string,
  ) => Promise<VersionedValue<ProjectionCheckpoint<Projection>> | null>;
  readonly set: (
    key: string,
    checkpoint: ProjectionCheckpoint<Projection>,
    expectedRevision: number | null,
  ) => Promise<ConditionalWriteResult<ProjectionCheckpoint<Projection>>>;
  readonly delete: (
    key: string,
    expectedRevision: number | null,
  ) => Promise<ConditionalWriteResult<ProjectionCheckpoint<Projection>>>;
}

export type MutationAttemptDefinition<
  Operation extends string = string,
  Recovery = unknown,
  Resolution = unknown,
> = Readonly<{
  operation: Operation;
  recovery: Recovery;
  resolution: Resolution;
}>;

type AnyMutationAttemptDefinition = MutationAttemptDefinition<
  string,
  unknown,
  unknown
>;

type MutationAttemptBase<
  Definition extends AnyMutationAttemptDefinition,
> = Readonly<{
  readonly attemptId: AttemptId;
  readonly fingerprint: MutationFingerprint;
  readonly operation: Definition["operation"];
  readonly sourceId: string;
  readonly preparedAtMs: number;
  readonly recovery: Definition["recovery"];
}>;

export type PreparedMutationAttempt<
  Definition extends AnyMutationAttemptDefinition,
> = Definition extends AnyMutationAttemptDefinition
  ? MutationAttemptBase<Definition> &
      Readonly<{
        state: "prepared";
        revision: number;
      }>
  : never;

export type EffectStartedMutationAttempt<
  Definition extends AnyMutationAttemptDefinition,
> = Definition extends AnyMutationAttemptDefinition
  ? MutationAttemptBase<Definition> &
      Readonly<{
        state: "effect-started";
        revision: number;
        effectStartedAtMs: number;
      }>
  : never;

export type SettledMutationAttempt<
  Definition extends AnyMutationAttemptDefinition,
> = Definition extends AnyMutationAttemptDefinition
  ? MutationAttemptBase<Definition> &
      Readonly<{
        state: "settled";
        revision: number;
        effectStartedAtMs: number | null;
        settledAtMs: number;
        outcome: DispatchOutcome<Definition["resolution"]>;
      }>
  : never;

export type MutationAttemptRecord<
  Definition extends AnyMutationAttemptDefinition,
> = Definition extends AnyMutationAttemptDefinition
  ?
      | PreparedMutationAttempt<Definition>
      | EffectStartedMutationAttempt<Definition>
      | SettledMutationAttempt<Definition>
  : never;

export type OpenMutationAttempt<
  Definition extends AnyMutationAttemptDefinition,
> = Definition extends AnyMutationAttemptDefinition
  ?
      | PreparedMutationAttempt<Definition>
      | EffectStartedMutationAttempt<Definition>
  : never;

export interface MutationAttemptCursor {
  readonly preparedAtMs: number;
  readonly attemptId: AttemptId;
}

export interface OpenMutationAttemptPage<
  Definition extends AnyMutationAttemptDefinition,
> {
  readonly attempts: readonly OpenMutationAttempt<Definition>[];
  readonly nextCursor: MutationAttemptCursor | null;
  readonly hasMore: boolean;
}

export type MutationAttemptDraft<
  Definition extends AnyMutationAttemptDefinition,
> = Definition extends AnyMutationAttemptDefinition
  ? Readonly<{
      attemptId: AttemptId;
      /**
       * A deterministic, non-sensitive identifier for the intended effect and
       * recovery identity. Prefer opaque IDs or a keyed digest.
       */
      fingerprint: MutationFingerprint;
      operation: Definition["operation"];
      sourceId: string;
      preparedAtMs: number;
      recovery: Definition["recovery"];
    }>
  : never;

export type MutationAttemptSettlement<
  Definition extends AnyMutationAttemptDefinition,
> = Definition extends AnyMutationAttemptDefinition
  ? Readonly<{
      operation: Definition["operation"];
      attemptId: AttemptId;
      expectedRevision: number;
      outcome: DispatchOutcome<Definition["resolution"]>;
      settledAtMs: number;
    }>
  : never;

export type PrepareMutationAttemptResult<
  Definition extends AnyMutationAttemptDefinition,
> =
  | Readonly<{
      status: "created";
      record: PreparedMutationAttempt<Definition>;
    }>
  | Readonly<{
      status: "existing";
      record: MutationAttemptRecord<Definition>;
    }>
  | Readonly<{
      status: "collision";
      current: MutationAttemptRecord<Definition>;
    }>;

export type TransitionMutationAttemptResult<
  Definition extends AnyMutationAttemptDefinition,
> =
  | Readonly<{
      status: "applied";
      record: MutationAttemptRecord<Definition>;
    }>
  | Readonly<{
      status: "conflict";
      current: MutationAttemptRecord<Definition>;
    }>
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "invalid-transition";
      current: MutationAttemptRecord<Definition>;
    }>;

export interface MutationAttemptJournal<
  Definition extends AnyMutationAttemptDefinition,
> {
  /**
   * Durably creates the attempt before any provider effect is allowed to begin.
   */
  readonly prepare: (
    draft: MutationAttemptDraft<Definition>,
  ) => Promise<PrepareMutationAttemptResult<Definition>>;

  /**
   * Durably records the conservative crash boundary immediately before effect.
   */
  readonly markEffectStarted: (
    attemptId: AttemptId,
    expectedRevision: number,
    effectStartedAtMs: number,
  ) => Promise<TransitionMutationAttemptResult<Definition>>;

  /**
   * Settles only the exact operation, attempt ID, and expected revision.
   * A prepared attempt may settle as rejected or cancelled because no effect
   * began. An effect-started attempt may settle with any explicit outcome.
   * Settled attempts are terminal. Timestamps cannot move backwards.
   */
  readonly settle: (
    settlement: MutationAttemptSettlement<Definition>,
  ) => Promise<TransitionMutationAttemptResult<Definition>>;

  readonly get: (
    attemptId: AttemptId,
  ) => Promise<MutationAttemptRecord<Definition> | null>;

  readonly listOpen: (request: Readonly<{
    sourceId: string | null;
    after: MutationAttemptCursor | null;
    limit: number;
  }>) => Promise<OpenMutationAttemptPage<Definition>>;
}

export interface GenerationStore {
  readonly read: (scope: string) => Promise<number | null>;

  /**
   * Atomically returns a generation greater than the durable value and floor.
   */
  readonly reserve: (
    scope: string,
    minimumExclusive: number,
  ) => Promise<number>;
}

export interface ChangeFeedEntry<Cursor, Change> {
  readonly cursor: Cursor;
  readonly change: Change;
}

export interface ChangeFeedPage<Cursor, Change> {
  readonly entries: readonly ChangeFeedEntry<Cursor, Change>[];
  readonly nextCursor: Cursor | null;
  readonly hasMore: boolean;
}

export interface ChangeFeed<Cursor, Change> {
  readonly read: (request: Readonly<{
    after: Cursor | null;
    limit: number;
  }>) => Promise<ChangeFeedPage<Cursor, Change>>;

  /**
   * Signals that a later read may return new entries. It does not carry data.
   */
  readonly subscribe: (listener: () => void) => Unsubscribe;
}
