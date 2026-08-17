import {
  isAttemptId,
  type AttemptId,
} from "../client.js";
import {
  assertGeneration,
} from "../lifecycle.js";
import { isMutationFingerprint } from "../persistence.js";
import type {
  BindingStore,
  ChangeFeed,
  ChangeFeedEntry,
  ChangeFeedPage,
  ConditionalWriteResult,
  GenerationStore,
  MutationAttemptDraft,
  MutationAttemptDefinition,
  MutationAttemptCursor,
  MutationAttemptJournal,
  MutationAttemptRecord,
  MutationAttemptSettlement,
  OpenMutationAttempt,
  OpenMutationAttemptPage,
  PreparedMutationAttempt,
  PrepareMutationAttemptResult,
  ProjectionCheckpoint,
  ProjectionCheckpointStore,
  TransitionMutationAttemptResult,
  VersionedValue,
} from "../persistence.js";
import type { Unsubscribe } from "../store.js";

const MAX_KEY_LENGTH = 512;
const MAX_PAGE_SIZE = 1_000;

function assertKey(key: string, label: string): void {
  if (
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    key.trim() !== key
  ) {
    throw new RangeError(
      `${label} must contain 1 to ${String(MAX_KEY_LENGTH)} characters`,
    );
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("expected revision must be a positive safe integer");
  }
}

function assertLimit(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PAGE_SIZE
  ) {
    throw new RangeError(
      `limit must be an integer from 1 to ${String(MAX_PAGE_SIZE)}`,
    );
  }
}

function comparePortableIdentifier(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function present<Value>(
  revision: number,
  value: Value,
): VersionedValue<Value> {
  return Object.freeze({ revision, state: "present", value });
}

function deleted<Value>(revision: number): VersionedValue<Value> {
  return Object.freeze({ revision, state: "deleted" });
}

interface MemoryConditionalStore<Value> {
  readonly get: (key: string) => Promise<VersionedValue<Value> | null>;
  readonly set: (
    key: string,
    value: Value,
    expectedRevision: number | null,
  ) => Promise<ConditionalWriteResult<Value>>;
  readonly delete: (
    key: string,
    expectedRevision: number | null,
  ) => Promise<ConditionalWriteResult<Value>>;
}

function createMemoryConditionalStore<Value>(
  keyLabel: string,
): MemoryConditionalStore<Value> {
  const records = new Map<string, VersionedValue<Value>>();

  const get = (key: string): Promise<VersionedValue<Value> | null> => {
    assertKey(key, keyLabel);
    return Promise.resolve(records.get(key) ?? null);
  };

  const matches = (
    current: VersionedValue<Value> | null,
    expectedRevision: number | null,
  ): boolean => {
    if (expectedRevision === null) return current === null;
    assertRevision(expectedRevision);
    return current?.revision === expectedRevision;
  };

  const set = (
    key: string,
    value: Value,
    expectedRevision: number | null,
  ): Promise<ConditionalWriteResult<Value>> => {
    assertKey(key, keyLabel);
    const current = records.get(key) ?? null;
    if (!matches(current, expectedRevision)) {
      return Promise.resolve(Object.freeze({ status: "conflict", current }));
    }
    const next = present((current?.revision ?? 0) + 1, value);
    records.set(key, next);
    return Promise.resolve(Object.freeze({ status: "applied", current: next }));
  };

  const deleteValue = (
    key: string,
    expectedRevision: number | null,
  ): Promise<ConditionalWriteResult<Value>> => {
    assertKey(key, keyLabel);
    const current = records.get(key) ?? null;
    if (!matches(current, expectedRevision)) {
      return Promise.resolve(Object.freeze({ status: "conflict", current }));
    }
    const next = deleted<Value>((current?.revision ?? 0) + 1);
    records.set(key, next);
    return Promise.resolve(Object.freeze({ status: "applied", current: next }));
  };

  return Object.freeze({ delete: deleteValue, get, set });
}

export function createMemoryBindingStore<Binding>(): BindingStore<Binding> {
  return createMemoryConditionalStore<Binding>("binding key");
}

export function createMemoryProjectionCheckpointStore<Projection>():
  ProjectionCheckpointStore<Projection> {
  return createMemoryConditionalStore<ProjectionCheckpoint<Projection>>(
    "checkpoint key",
  );
}

function freezePrepared<
  Definition extends MutationAttemptDefinition,
>(
  draft: MutationAttemptDraft<Definition>,
): PreparedMutationAttempt<Definition> {
  return Object.freeze({
    state: "prepared",
    revision: 1,
    attemptId: draft.attemptId,
    fingerprint: draft.fingerprint,
    operation: draft.operation,
    sourceId: draft.sourceId,
    preparedAtMs: draft.preparedAtMs,
    recovery: draft.recovery,
  }) as PreparedMutationAttempt<Definition>;
}

function validSettlementTransition<
  Definition extends MutationAttemptDefinition,
>(
  current: MutationAttemptRecord<Definition>,
  settlement: MutationAttemptSettlement<Definition>,
): boolean {
  if (current.state === "settled") return false;
  if (
    current.operation !== settlement.operation ||
    settlement.outcome.attemptId !== settlement.attemptId
  ) {
    return false;
  }
  if (current.state === "prepared") {
    return (
      settlement.outcome.status === "cancelled" ||
      settlement.outcome.status === "rejected"
    );
  }
  return true;
}

export function createMemoryMutationAttemptJournal<
  Definition extends MutationAttemptDefinition,
>(): MutationAttemptJournal<Definition> {
  const attempts = new Map<
    AttemptId,
    MutationAttemptRecord<Definition>
  >();

  const prepare = (
    draft: MutationAttemptDraft<Definition>,
  ): Promise<PrepareMutationAttemptResult<Definition>> => {
    if (!isMutationFingerprint(draft.fingerprint)) {
      throw new RangeError("mutation fingerprint is invalid");
    }
    assertKey(draft.operation, "operation");
    assertKey(draft.sourceId, "source ID");
    assertTimestamp(draft.preparedAtMs, "preparedAtMs");
    const existing = attempts.get(draft.attemptId);
    if (existing !== undefined) {
      if (
        existing.fingerprint !== draft.fingerprint ||
        existing.operation !== draft.operation ||
        existing.sourceId !== draft.sourceId
      ) {
        return Promise.resolve(
          Object.freeze({ status: "collision", current: existing }),
        );
      }
      return Promise.resolve(
        Object.freeze({ status: "existing", record: existing }),
      );
    }
    const record = freezePrepared(draft);
    attempts.set(
      draft.attemptId,
      record as MutationAttemptRecord<Definition>,
    );
    return Promise.resolve(
      Object.freeze({ status: "created", record }),
    );
  };

  const markEffectStarted = (
    attemptId: AttemptId,
    expectedRevision: number,
    effectStartedAtMs: number,
  ): Promise<TransitionMutationAttemptResult<Definition>> => {
    assertRevision(expectedRevision);
    assertTimestamp(effectStartedAtMs, "effectStartedAtMs");
    const current = attempts.get(attemptId);
    if (current === undefined) {
      return Promise.resolve(Object.freeze({ status: "missing" }));
    }
    if (current.revision !== expectedRevision) {
      return Promise.resolve(
        Object.freeze({ status: "conflict", current }),
      );
    }
    if (current.state !== "prepared") {
      return Promise.resolve(
        Object.freeze({ status: "invalid-transition", current }),
      );
    }
    if (effectStartedAtMs < current.preparedAtMs) {
      throw new RangeError("effectStartedAtMs cannot precede preparedAtMs");
    }
    const record = Object.freeze({
      state: "effect-started" as const,
      revision: current.revision + 1,
      attemptId: current.attemptId,
      fingerprint: current.fingerprint,
      operation: current.operation,
      sourceId: current.sourceId,
      preparedAtMs: current.preparedAtMs,
      recovery: current.recovery,
      effectStartedAtMs,
    });
    const storedRecord = record as MutationAttemptRecord<Definition>;
    attempts.set(attemptId, storedRecord);
    return Promise.resolve(
      Object.freeze({ status: "applied", record: storedRecord }),
    );
  };

  const settle = (
    settlement: MutationAttemptSettlement<Definition>,
  ): Promise<TransitionMutationAttemptResult<Definition>> => {
    const {
      attemptId,
      expectedRevision,
      outcome,
      settledAtMs,
    } = settlement;
    assertRevision(expectedRevision);
    assertTimestamp(settledAtMs, "settledAtMs");
    const current = attempts.get(attemptId);
    if (current === undefined) {
      return Promise.resolve(Object.freeze({ status: "missing" }));
    }
    if (current.revision !== expectedRevision) {
      return Promise.resolve(
        Object.freeze({ status: "conflict", current }),
      );
    }
    if (
      !validSettlementTransition(current, settlement)
    ) {
      return Promise.resolve(
        Object.freeze({ status: "invalid-transition", current }),
      );
    }
    const earliestSettlement =
      current.state === "effect-started"
        ? current.effectStartedAtMs
        : current.preparedAtMs;
    if (settledAtMs < earliestSettlement) {
      throw new RangeError(
        "settledAtMs cannot precede the attempt's current state",
      );
    }
    const record = Object.freeze({
      state: "settled" as const,
      revision: current.revision + 1,
      attemptId: current.attemptId,
      fingerprint: current.fingerprint,
      operation: current.operation,
      sourceId: current.sourceId,
      preparedAtMs: current.preparedAtMs,
      recovery: current.recovery,
      effectStartedAtMs:
        current.state === "effect-started"
          ? current.effectStartedAtMs
          : null,
      settledAtMs,
      outcome,
    });
    const storedRecord = record as MutationAttemptRecord<Definition>;
    attempts.set(attemptId, storedRecord);
    return Promise.resolve(
      Object.freeze({ status: "applied", record: storedRecord }),
    );
  };

  const get = (
    attemptId: AttemptId,
  ): Promise<MutationAttemptRecord<Definition> | null> =>
    Promise.resolve(attempts.get(attemptId) ?? null);

  const listOpen = (request: Readonly<{
    sourceId: string | null;
    after: MutationAttemptCursor | null;
    limit: number;
  }>): Promise<OpenMutationAttemptPage<Definition>> => {
    assertLimit(request.limit);
    if (request.sourceId !== null) {
      assertKey(request.sourceId, "source ID");
    }
    if (request.after !== null) {
      assertTimestamp(request.after.preparedAtMs, "attempt cursor preparedAtMs");
      if (!isAttemptId(request.after.attemptId)) {
        throw new RangeError("attempt cursor ID is invalid");
      }
    }
    const records = [...attempts.values()]
      .filter(
        (record): record is OpenMutationAttempt<Definition> =>
          record.state !== "settled" &&
          (request.sourceId === null || record.sourceId === request.sourceId),
      )
      .sort((left, right) => {
        if (left.preparedAtMs !== right.preparedAtMs) {
          return left.preparedAtMs - right.preparedAtMs;
        }
        return comparePortableIdentifier(left.attemptId, right.attemptId);
      })
      .filter((record) =>
        request.after === null ||
        record.preparedAtMs > request.after.preparedAtMs ||
        (
          record.preparedAtMs === request.after.preparedAtMs &&
          comparePortableIdentifier(
            record.attemptId,
            request.after.attemptId,
          ) > 0
        ))
      .slice(0, request.limit + 1);
    const hasMore = records.length > request.limit;
    const page = records.slice(0, request.limit);
    const last = page.at(-1);
    return Promise.resolve(Object.freeze({
      attempts: Object.freeze(page),
      nextCursor: last === undefined
        ? null
        : Object.freeze({
            preparedAtMs: last.preparedAtMs,
            attemptId: last.attemptId,
          }),
      hasMore,
    }));
  };

  return Object.freeze({
    get,
    listOpen,
    markEffectStarted,
    prepare,
    settle,
  });
}

export function createMemoryGenerationStore(): GenerationStore {
  const generations = new Map<string, number>();

  const read = (scope: string): Promise<number | null> => {
    assertKey(scope, "generation scope");
    return Promise.resolve(generations.get(scope) ?? null);
  };

  const reserve = (
    scope: string,
    minimumExclusive: number,
  ): Promise<number> => {
    assertKey(scope, "generation scope");
    assertGeneration(minimumExclusive, "minimum generation");
    const floor = Math.max(generations.get(scope) ?? 0, minimumExclusive);
    if (floor === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("generation space is exhausted");
    }
    const generation = floor + 1;
    generations.set(scope, generation);
    return Promise.resolve(generation);
  };

  return Object.freeze({ read, reserve });
}

export interface MemoryChangeFeed<Change>
  extends ChangeFeed<number, Change> {
  readonly append: (change: Change) => ChangeFeedEntry<number, Change>;
}

export function createMemoryChangeFeed<Change>(): MemoryChangeFeed<Change> {
  const entries: ChangeFeedEntry<number, Change>[] = [];
  const subscriptions = new Set<Readonly<{ listener: () => void }>>();
  let cursor = 0;

  const append = (change: Change): ChangeFeedEntry<number, Change> => {
    if (cursor === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("change-feed cursor space is exhausted");
    }
    cursor += 1;
    const entry = Object.freeze({ cursor, change });
    entries.push(entry);
    for (const subscription of [...subscriptions]) {
      try {
        subscription.listener();
      } catch {
        // Testing behavior matches the listener-isolation production contract.
      }
    }
    return entry;
  };

  const read = (request: Readonly<{
    after: number | null;
    limit: number;
  }>): Promise<ChangeFeedPage<number, Change>> => {
    assertLimit(request.limit);
    const after = request.after ?? 0;
    assertGeneration(after, "change-feed cursor");
    const available = entries.filter((entry) => entry.cursor > after);
    const pageEntries = available.slice(0, request.limit);
    const last = pageEntries.at(-1);
    return Promise.resolve(
      Object.freeze({
        entries: Object.freeze(pageEntries),
        nextCursor: last?.cursor ?? request.after,
        hasMore: available.length > pageEntries.length,
      }),
    );
  };

  const subscribe = (listener: () => void): Unsubscribe => {
    const subscription = Object.freeze({ listener });
    subscriptions.add(subscription);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      subscriptions.delete(subscription);
    };
  };

  return Object.freeze({ append, read, subscribe });
}
