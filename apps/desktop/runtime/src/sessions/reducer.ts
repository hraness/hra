import type {
  CodexFact,
  CodexItemSnapshot,
  CodexThreadSnapshot,
  CodexTurnSnapshot,
} from "../codex";
import { boundedCodexDisplayText, MAX_CODEX_FACT_ENCODED_BYTES } from "../codex";
import { deleteSessionEntity, setSessionEntity } from "./entity-map";
import {
  MAX_SESSION_ITEM_TEXT_UTF8_BYTES,
  createSessionState,
  emptySessionTextBuffer,
  sessionAccountKey,
  sessionEntityKey,
  type SessionAccountState,
  type SessionFactCursor,
  type SessionHydrationState,
  type SessionInteractionState,
  type SessionItemDisplay,
  type SessionItemState,
  type SessionOperationState,
  type SessionState,
  type SessionTextBuffer,
  type SessionThreadState,
  type SessionTurnState,
} from "./model";
import { SESSION_RETENTION_POLICY } from "./retention-policy";

export const MAX_SESSION_FACT_ENCODED_BYTES = MAX_CODEX_FACT_ENCODED_BYTES;

export class SessionFactInvariantError extends Error {
  constructor() {
    super("The owned Codex fact violates the session-model invariant.");
    this.name = "SessionFactInvariantError";
  }
}

export function reduceSessionFact(
  previous: SessionState,
  fact: CodexFact,
): SessionState {
  const applied = applySessionFact(previous, fact);
  const next = needsRetentionPass(previous, applied, [fact])
    ? compactSessionState(applied)
    : applied;
  return next === previous ? previous : withNextRevision(previous, next);
}

/** Folds a hydration batch into one externally observable model revision. */
export function reduceSessionFacts(
  previous: SessionState,
  facts: readonly CodexFact[],
): SessionState {
  assertFactBatchBound(facts);
  let next = previous;
  const advancedCursors = new Map<string, SessionFactCursor>();
  for (const fact of facts) {
    assertFactMetadata(fact);
    const key = sessionAccountKey(fact.accountProfileId);
    const current = advancedCursors.get(key) ?? previous.cursors[key];
    if (current !== undefined && compareFactToCursor(fact, current) <= 0) continue;
    if (current !== undefined && fact.generation > current.generation) {
      next = clearPriorGenerationVolatileState(next, fact.accountProfileId);
    }
    advancedCursors.set(key, factCursor(fact));
    next = applyAcceptedSessionFact(next, fact);
  }
  if (advancedCursors.size > 0) {
    const cursors: Record<string, SessionFactCursor> = { ...previous.cursors };
    for (const [key, cursor] of advancedCursors) cursors[key] = cursor;
    next = { ...next, cursors: Object.freeze(cursors) };
  }
  if (needsRetentionPass(previous, next, facts)) next = compactSessionState(next);
  return next === previous ? previous : withNextRevision(previous, next);
}

/** Removes every retained session value owned by one deleted account. */
export function purgeSessionAccount(
  previous: SessionState,
  accountProfileId: string,
): SessionState {
  let next = previous;
  for (const [threadKey, thread] of Object.entries(next.threads)) {
    if (thread.accountProfileId === accountProfileId) {
      next = forgetThread(next, threadKey);
    }
  }
  for (const [turnKey, turn] of Object.entries(next.turns)) {
    if (turn.accountProfileId === accountProfileId) {
      next = deleteTurnByKey(next, turnKey);
    }
  }
  for (const [itemKey, item] of next.items.entries()) {
    if (item.accountProfileId === accountProfileId) {
      next = deleteItemState(next, itemKey);
    }
  }
  const accountKey = sessionAccountKey(accountProfileId);
  next = {
    ...next,
    accounts: deleteRecord(next.accounts, accountKey),
    cursors: deleteRecord(next.cursors, accountKey),
    hydration: retainOtherAccounts(next.hydration, accountProfileId),
    interactions: retainOtherAccounts(next.interactions, accountProfileId),
    operations: retainOtherAccounts(next.operations, accountProfileId),
    threadTombstones: retainOtherAccounts(next.threadTombstones, accountProfileId),
  };
  return sameSessionStateReferences(previous, next)
    ? previous
    : withNextRevision(previous, next);
}

/** Returns the ordered facts whose account cursor can advance from a snapshot. */
export function acceptedSessionFacts(
  previous: SessionState,
  facts: readonly CodexFact[],
): readonly CodexFact[] {
  assertFactBatchBound(facts);
  const cursors = new Map<string, SessionFactCursor>();
  const accepted: CodexFact[] = [];
  for (const fact of facts) {
    assertFactMetadata(fact);
    const key = sessionAccountKey(fact.accountProfileId);
    const current = cursors.get(key) ?? previous.cursors[key];
    if (current !== undefined && compareFactToCursor(fact, current) <= 0) continue;
    const cursor = factCursor(fact);
    cursors.set(key, cursor);
    accepted.push(fact);
  }
  return Object.freeze(accepted);
}

function applySessionFact(previous: SessionState, fact: CodexFact): SessionState {
  assertFactMetadata(fact);
  const accepted = advanceCursor(previous, fact);
  if (accepted === null) return previous;
  const current = previous.cursors[sessionAccountKey(fact.accountProfileId)];
  const prepared = current !== undefined && fact.generation > current.generation
    ? clearPriorGenerationVolatileState(accepted, fact.accountProfileId)
    : accepted;
  return applyAcceptedSessionFact(prepared, fact);
}

/** Applies a fact whose ordering metadata has already passed the cursor fence. */
function applyAcceptedSessionFact(previous: SessionState, fact: CodexFact): SessionState {
  const accountProfileId = fact.accountProfileId;

  switch (fact.type) {
    case "runtime.changed":
      return upsertAccount(previous, accountProfileId, { runtime: fact.availability });
    case "account.changed":
      return upsertAccount(previous, accountProfileId, {
        availability: fact.availability,
      });
    case "account.login_completed":
      return upsertAccount(previous, accountProfileId, {
        availability: fact.success ? "unknown" : "signed_out",
      });
    case "account.profile_updated":
      return upsertAccount(previous, accountProfileId, {
        availability: fact.signedIn ? "signed_in" : "signed_out",
      });
    case "account.rate_limits_updated":
      return previous;
    case "thread.snapshot":
      return applyThreadSnapshot(previous, fact, fact.thread);
    case "thread.archived":
      return updateThread(previous, accountProfileId, fact.threadId, (thread) =>
        thread.archived === fact.archived && (!fact.archived || thread.status === "idle")
          ? thread
          : {
              ...thread,
              archived: fact.archived,
              status: fact.archived ? "idle" : thread.status,
            });
    case "thread.deleted":
      return deleteThread(previous, fact);
    case "thread.title_changed":
      return updateThread(previous, accountProfileId, fact.threadId, (thread) =>
        thread.title === fact.title ? thread : { ...thread, title: fact.title });
    case "thread.status_changed":
      return updateThread(previous, accountProfileId, fact.threadId, (thread) =>
        thread.status === fact.status ? thread : { ...thread, status: fact.status });
    case "turn.snapshot":
      return applyStandaloneTurnSnapshot(previous, fact, fact.turn);
    case "turn.started":
      return applyTurnStarted(previous, fact);
    case "turn.activity":
      return updateTurn(previous, accountProfileId, fact.turnId, (turn) =>
        turn.activity === fact.activity ? turn : { ...turn, activity: fact.activity });
    case "turn.completed":
      return applyTurnCompleted(previous, fact);
    case "turn.token_usage":
    case "turn.model_rerouted":
      return previous;
    case "item.started":
      return applyItemStarted(previous, fact);
    case "item.delta":
      return applyItemDelta(previous, fact);
    case "item.completed":
      return applyItemCompleted(previous, fact, fact.item);
    case "interaction.requested":
      return applyInteractionRequested(previous, fact);
    case "interaction.settled":
      return applyInteractionSettled(previous, fact);
    case "server_request.resolved":
      return previous;
    case "operation.changed":
      return applyOperation(previous, fact);
    case "hydration.changed":
      return applyHydration(previous, fact);
  }
}

function assertFactMetadata(fact: CodexFact): void {
  if (
    !Number.isSafeInteger(fact.generation) || fact.generation <= 0 ||
    !Number.isSafeInteger(fact.streamPosition) || fact.streamPosition <= 0 ||
    !Number.isSafeInteger(fact.factIndex) || fact.factIndex < 0 ||
    !Number.isSafeInteger(fact.encodedBytes) || fact.encodedBytes < 0 ||
    fact.encodedBytes > MAX_SESSION_FACT_ENCODED_BYTES
  ) {
    throw new SessionFactInvariantError();
  }
}

function assertFactBatchBound(facts: readonly CodexFact[]): void {
  if (facts.length > SESSION_RETENTION_POLICY.maxFactsPerBatch) {
    throw new SessionFactInvariantError();
  }
}

function advanceCursor(previous: SessionState, fact: CodexFact): SessionState | null {
  const key = sessionAccountKey(fact.accountProfileId);
  const current = previous.cursors[key];
  if (current !== undefined && compareFactToCursor(fact, current) <= 0) return null;
  const cursor = factCursor(fact);
  return {
    ...previous,
    cursors: setRecord(previous.cursors, key, cursor),
  };
}

function factCursor(fact: CodexFact): SessionFactCursor {
  return {
    generation: fact.generation,
    streamPosition: fact.streamPosition,
    factIndex: fact.factIndex,
  };
}

function compareFactToCursor(fact: CodexFact, cursor: SessionFactCursor): number {
  if (fact.generation !== cursor.generation) {
    return fact.generation < cursor.generation ? -1 : 1;
  }
  if (fact.streamPosition !== cursor.streamPosition) {
    return fact.streamPosition < cursor.streamPosition ? -1 : 1;
  }
  if (fact.factIndex === cursor.factIndex) return 0;
  return fact.factIndex < cursor.factIndex ? -1 : 1;
}

function upsertAccount(
  previous: SessionState,
  accountProfileId: string,
  patch: Partial<Pick<SessionAccountState, "availability" | "runtime">>,
): SessionState {
  const key = sessionAccountKey(accountProfileId);
  const current = previous.accounts[key];
  const next: SessionAccountState = {
    accountProfileId,
    availability: patch.availability ?? current?.availability ?? "unknown",
    runtime: patch.runtime ?? current?.runtime ?? "stopped",
  };
  if (current !== undefined && sameAccount(current, next)) return previous;
  return { ...previous, accounts: setRecord(previous.accounts, key, next) };
}

function applyThreadSnapshot(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "thread.snapshot" }>,
  snapshot: CodexThreadSnapshot,
): SessionState {
  const threadKey = sessionEntityKey(fact.accountProfileId, snapshot.id);
  const tombstone = previous.threadTombstones[threadKey];
  if (tombstone !== undefined && tombstone.cursor.generation >= fact.generation) {
    return previous;
  }
  let next = tombstone === undefined
    ? previous
    : {
        ...previous,
        threadTombstones: deleteRecord(previous.threadTombstones, threadKey),
      };
  const current = next.threads[threadKey];
  const preservedTurnKeys = current?.turnKeys ?? [];
  let turnKeys = preservedTurnKeys;

  if (snapshot.turns !== null) {
    const authoritativeTurnKeys: string[] = [];
    const authoritativeTurnKeySet = new Set<string>();
    for (const turn of snapshot.turns) {
      const turnKey = sessionEntityKey(fact.accountProfileId, turn.id);
      if (authoritativeTurnKeySet.has(turnKey)) throw new SessionFactInvariantError();
      authoritativeTurnKeySet.add(turnKey);
      authoritativeTurnKeys.push(turnKey);
      next = upsertTurnSnapshot(next, fact.accountProfileId, threadKey, turn);
    }
    for (const oldTurnKey of preservedTurnKeys) {
      if (!authoritativeTurnKeySet.has(oldTurnKey)) next = deleteTurnByKey(next, oldTurnKey);
    }
    turnKeys = Object.freeze(authoritativeTurnKeys);
  }

  const thread: SessionThreadState = {
    accountProfileId: fact.accountProfileId,
    archived: snapshot.archived,
    createdAt: snapshot.createdAt,
    cwd: snapshot.cwd,
    id: snapshot.id,
    status: snapshot.status,
    title: snapshot.title,
    turnKeys,
    updatedAt: snapshot.updatedAt,
  };
  const observed = next.threads[threadKey];
  if (observed !== undefined && sameThread(observed, thread)) return next;
  return { ...next, threads: setRecord(next.threads, threadKey, thread) };
}

function applyStandaloneTurnSnapshot(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "turn.snapshot" }>,
  snapshot: CodexTurnSnapshot,
): SessionState {
  const threadKey = sessionEntityKey(fact.accountProfileId, fact.threadId);
  const thread = previous.threads[threadKey];
  if (thread === undefined) return previous;
  let next = upsertTurnSnapshot(previous, fact.accountProfileId, threadKey, snapshot);
  const turnKey = sessionEntityKey(fact.accountProfileId, snapshot.id);
  if (!thread.turnKeys.includes(turnKey)) {
    const latest = next.threads[threadKey];
    if (latest !== undefined) {
      next = {
        ...next,
        threads: setRecord(next.threads, threadKey, {
          ...latest,
          turnKeys: Object.freeze([...latest.turnKeys, turnKey]),
        }),
      };
    }
  }
  return next;
}

function upsertTurnSnapshot(
  previous: SessionState,
  accountProfileId: string,
  threadKey: string,
  snapshot: CodexTurnSnapshot,
): SessionState {
  const turnKey = sessionEntityKey(accountProfileId, snapshot.id);
  const current = previous.turns[turnKey];
  if (current !== undefined && current.threadKey !== threadKey) {
    throw new SessionFactInvariantError();
  }
  let next = previous;
  let itemKeys: readonly string[] = current?.itemKeys ?? Object.freeze([]);
  if (snapshot.items !== null) {
    const authoritativeItemKeys: string[] = [];
    const authoritativeItemKeySet = new Set<string>();
    for (const item of snapshot.items) {
      const itemKey = sessionEntityKey(accountProfileId, item.id);
      if (authoritativeItemKeySet.has(itemKey)) throw new SessionFactInvariantError();
      authoritativeItemKeySet.add(itemKey);
      authoritativeItemKeys.push(itemKey);
      next = upsertCompletedItem(next, accountProfileId, threadKey, turnKey, item);
    }
    for (const oldItemKey of current?.itemKeys ?? []) {
      if (!authoritativeItemKeySet.has(oldItemKey)) {
        next = deleteItemState(next, oldItemKey);
      }
    }
    itemKeys = Object.freeze(authoritativeItemKeys);
  }
  const quotaProof = snapshot.quotaProof ?? current?.quotaProof;
  const turn: SessionTurnState = {
    accountProfileId,
    activity: snapshot.status === "active" ? current?.activity ?? null : null,
    completedAt: snapshot.completedAt,
    id: snapshot.id,
    itemKeys,
    ...(quotaProof === undefined ? {} : { quotaProof }),
    startedAt: snapshot.startedAt,
    status: snapshot.status,
    threadKey,
  };
  const observed = next.turns[turnKey];
  if (observed !== undefined && sameTurn(observed, turn)) return next;
  return { ...next, turns: setRecord(next.turns, turnKey, turn) };
}

function applyTurnStarted(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "turn.started" }>,
): SessionState {
  const threadKey = sessionEntityKey(fact.accountProfileId, fact.threadId);
  const thread = previous.threads[threadKey];
  if (thread === undefined) return previous;
  const turnKey = sessionEntityKey(fact.accountProfileId, fact.turnId);
  const current = previous.turns[turnKey];
  if (current !== undefined && current.threadKey !== threadKey) {
    throw new SessionFactInvariantError();
  }
  if (current?.status !== undefined && current.status !== "active") return previous;
  const turn: SessionTurnState = current === undefined
    ? {
        accountProfileId: fact.accountProfileId,
        activity: "running",
        completedAt: null,
        id: fact.turnId,
        itemKeys: Object.freeze([]),
        startedAt: fact.startedAt,
        status: "active",
        threadKey,
      }
    : {
        ...current,
        activity: current.activity ?? "running",
        startedAt: fact.startedAt,
      };
  let next = sameTurn(current, turn)
    ? previous
    : { ...previous, turns: setRecord(previous.turns, turnKey, turn) };
  const latestThread = next.threads[threadKey];
  if (latestThread !== undefined) {
    const hasTurn = latestThread.turnKeys.includes(turnKey);
    const updated: SessionThreadState = {
      ...latestThread,
      status: "active",
      turnKeys: hasTurn
        ? latestThread.turnKeys
        : Object.freeze([...latestThread.turnKeys, turnKey]),
    };
    if (!sameThread(latestThread, updated)) {
      next = { ...next, threads: setRecord(next.threads, threadKey, updated) };
    }
  }
  return next;
}

function applyTurnCompleted(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "turn.completed" }>,
): SessionState {
  const turnKey = sessionEntityKey(fact.accountProfileId, fact.turnId);
  const current = previous.turns[turnKey];
  if (current === undefined) return previous;
  const turn: SessionTurnState = {
    ...current,
    activity: null,
    completedAt: fact.completedAt,
    status: fact.status,
  };
  let next = sameTurn(current, turn)
    ? previous
    : { ...previous, turns: setRecord(previous.turns, turnKey, turn) };
  const thread = next.threads[current.threadKey];
  if (thread !== undefined && thread.status === "active") {
    const anotherActive = thread.turnKeys.some((key) =>
      key !== turnKey && next.turns[key]?.status === "active"
    );
    if (!anotherActive) {
      next = {
        ...next,
        threads: setRecord(next.threads, current.threadKey, {
          ...thread,
          status: fact.status === "failed" ? "system_error" : "idle",
        }),
      };
    }
  }
  return next;
}

function applyItemStarted(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "item.started" }>,
): SessionState {
  const linked = linkedTurn(previous, fact.accountProfileId, fact.threadId, fact.turnId);
  if (linked === null) return previous;
  const itemKey = sessionEntityKey(fact.accountProfileId, fact.itemId);
  const current = previous.items.get(itemKey);
  if (current !== undefined) {
    if (current.threadKey !== linked.threadKey || current.turnKey !== linked.turnKey) {
      throw new SessionFactInvariantError();
    }
    return previous;
  }
  const display: SessionItemDisplay = fact.kind === "tool"
    ? { kind: "tool", activity: fact.activity ?? "other" }
    : { kind: fact.kind };
  const item: SessionItemState = {
    accountProfileId: fact.accountProfileId,
    display,
    id: fact.itemId,
    status: "streaming",
    text: fact.kind === "tool" ? null : emptySessionTextBuffer(),
    threadKey: linked.threadKey,
    turnKey: linked.turnKey,
  };
  return linkItem(setItemState(previous, itemKey, item), linked.turnKey, itemKey);
}

function applyItemDelta(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "item.delta" }>,
): SessionState {
  const linked = linkedTurn(previous, fact.accountProfileId, fact.threadId, fact.turnId);
  if (linked === null) return previous;
  const itemKey = sessionEntityKey(fact.accountProfileId, fact.itemId);
  const current = previous.items.get(itemKey);
  if (
    current !== undefined &&
    (current.threadKey !== linked.threadKey || current.turnKey !== linked.turnKey)
  ) {
    throw new SessionFactInvariantError();
  }
  if (current?.status === "completed" || current?.status === "failed" || current?.status === "interrupted") {
    return previous;
  }
  const base: SessionItemState = current ?? {
    accountProfileId: fact.accountProfileId,
    display: { kind: fact.channel },
    id: fact.itemId,
    status: "streaming",
    text: emptySessionTextBuffer(),
    threadKey: linked.threadKey,
    turnKey: linked.turnKey,
  };
  if (
    base.display.kind !== fact.channel ||
    base.text === null
  ) return previous;
  const text = appendText(base.text, fact.delta, fact.truncated);
  const nextItem = text === base.text ? base : { ...base, text };
  let next = nextItem === current
    ? previous
    : setItemState(previous, itemKey, nextItem);
  next = linkItem(next, linked.turnKey, itemKey);
  return next;
}

function applyItemCompleted(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "item.completed" }>,
  snapshot: CodexItemSnapshot,
): SessionState {
  const linked = linkedTurn(previous, fact.accountProfileId, fact.threadId, fact.turnId);
  if (linked === null) return previous;
  const itemKey = sessionEntityKey(fact.accountProfileId, snapshot.id);
  let next = upsertCompletedItem(
    previous,
    fact.accountProfileId,
    linked.threadKey,
    linked.turnKey,
    snapshot,
  );
  next = linkItem(next, linked.turnKey, itemKey);
  return next;
}

function upsertCompletedItem(
  previous: SessionState,
  accountProfileId: string,
  threadKey: string,
  turnKey: string,
  snapshot: CodexItemSnapshot,
): SessionState {
  const itemKey = sessionEntityKey(accountProfileId, snapshot.id);
  const display = displayFromSnapshot(snapshot);
  const textValue = "text" in snapshot ? snapshot.text : null;
  const status = snapshot.kind === "error"
    ? "failed"
    : snapshot.kind === "tool"
      ? snapshot.status
      : "completed";
  const item: SessionItemState = {
    accountProfileId,
    display,
    id: snapshot.id,
    status,
    text: textValue === null
      ? null
      : completeText(textValue, "truncated" in snapshot && snapshot.truncated),
    threadKey,
    turnKey,
  };
  const current = previous.items.get(itemKey);
  if (
    current !== undefined &&
    (current.threadKey !== threadKey || current.turnKey !== turnKey)
  ) {
    throw new SessionFactInvariantError();
  }
  if (current !== undefined && sameItem(current, item)) return previous;
  return setItemState(previous, itemKey, item);
}

function applyInteractionRequested(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "interaction.requested" }>,
): SessionState {
  const linked = linkedTurn(previous, fact.accountProfileId, fact.threadId, fact.turnId);
  if (linked === null) return previous;
  const key = sessionEntityKey(fact.accountProfileId, fact.interactionId);
  const interaction: SessionInteractionState = {
    accountProfileId: fact.accountProfileId,
    expiresAt: fact.expiresAt,
    id: fact.interactionId,
    kind: fact.kind,
    outcome: "pending",
    threadKey: linked.threadKey,
    turnKey: linked.turnKey,
  };
  const current = previous.interactions[key];
  if (current !== undefined) {
    if (sameInteraction(current, interaction)) return previous;
    throw new SessionFactInvariantError();
  }
  return {
    ...previous,
    interactions: setRecord(previous.interactions, key, interaction),
  };
}

function applyInteractionSettled(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "interaction.settled" }>,
): SessionState {
  const key = sessionEntityKey(fact.accountProfileId, fact.interactionId);
  const current = previous.interactions[key];
  if (current === undefined) return previous;
  if (current.outcome === fact.outcome) return previous;
  if (current.outcome !== "pending") return previous;
  return {
    ...previous,
    interactions: deleteRecord(previous.interactions, key),
  };
}

function applyOperation(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "operation.changed" }>,
): SessionState {
  const key = sessionEntityKey(fact.accountProfileId, fact.operationId);
  const operation: SessionOperationState = {
    accountProfileId: fact.accountProfileId,
    id: fact.operationId,
    operation: fact.operation,
    outcome: fact.outcome,
    threadKey: fact.threadId === null
      ? null
      : sessionEntityKey(fact.accountProfileId, fact.threadId),
  };
  const current = previous.operations[key];
  if (
    current !== undefined &&
    (current.operation !== operation.operation || current.threadKey !== operation.threadKey)
  ) throw new SessionFactInvariantError();
  if (fact.outcome === "confirmed" || fact.outcome === "rejected") {
    return current === undefined
      ? previous
      : { ...previous, operations: deleteRecord(previous.operations, key) };
  }
  if (current !== undefined && sameOperation(current, operation)) return previous;
  return { ...previous, operations: setRecord(previous.operations, key, operation) };
}

function applyHydration(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "hydration.changed" }>,
): SessionState {
  if (!Number.isSafeInteger(fact.attempt) || fact.attempt < 0) {
    throw new SessionFactInvariantError();
  }
  const key = fact.threadId === null
    ? sessionAccountKey(fact.accountProfileId)
    : sessionEntityKey(fact.accountProfileId, fact.threadId);
  const hydration: SessionHydrationState = {
    accountProfileId: fact.accountProfileId,
    attempt: fact.attempt,
    origin: fact.origin,
    status: fact.status,
    threadKey: fact.threadId === null
      ? null
      : sessionEntityKey(fact.accountProfileId, fact.threadId),
  };
  const current = previous.hydration[key];
  if (current !== undefined && sameHydration(current, hydration)) return previous;
  return { ...previous, hydration: setRecord(previous.hydration, key, hydration) };
}

function deleteThread(
  previous: SessionState,
  fact: Extract<CodexFact, { type: "thread.deleted" }>,
): SessionState {
  const threadKey = sessionEntityKey(fact.accountProfileId, fact.threadId);
  const thread = previous.threads[threadKey];
  if (thread === undefined) return previous;
  let next = previous;
  for (const turnKey of thread?.turnKeys ?? []) next = deleteTurnByKey(next, turnKey);
  next = {
    ...next,
    hydration: deleteRecord(next.hydration, threadKey),
    threadDisplayTextUtf8Bytes: deleteSessionEntity(
      next.threadDisplayTextUtf8Bytes,
      threadKey,
    ),
    threads: deleteRecord(next.threads, threadKey),
    threadTombstones: setRecord(next.threadTombstones, threadKey, {
      accountProfileId: fact.accountProfileId,
      cursor: {
        generation: fact.generation,
        streamPosition: fact.streamPosition,
        factIndex: fact.factIndex,
      },
      threadId: fact.threadId,
    }),
  };
  for (const [key, operation] of Object.entries(next.operations)) {
    if (operation.threadKey === threadKey) {
      next = { ...next, operations: deleteRecord(next.operations, key) };
    }
  }
  return next;
}

function clearPriorGenerationVolatileState(
  previous: SessionState,
  accountProfileId: string,
): SessionState {
  const hydration = retainOtherAccounts(previous.hydration, accountProfileId);
  const interactions = retainOtherAccounts(previous.interactions, accountProfileId);
  const operations = retainOtherAccounts(previous.operations, accountProfileId);
  const threadTombstones = retainOtherAccounts(
    previous.threadTombstones,
    accountProfileId,
  );
  return hydration === previous.hydration && interactions === previous.interactions &&
      operations === previous.operations && threadTombstones === previous.threadTombstones
    ? previous
    : { ...previous, hydration, interactions, operations, threadTombstones };
}

function retainOtherAccounts<Value extends Readonly<{ accountProfileId: string }>>(
  record: Readonly<Record<string, Value>>,
  accountProfileId: string,
): Readonly<Record<string, Value>> {
  let changed = false;
  const retained: Record<string, Value> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value.accountProfileId === accountProfileId) {
      changed = true;
    } else {
      retained[key] = value;
    }
  }
  return changed ? Object.freeze(retained) : record;
}

function needsRetentionPass(
  previous: SessionState,
  next: SessionState,
  facts: readonly CodexFact[],
): boolean {
  if (next === previous) return false;
  if (
    next.retainedDisplayTextUtf8Bytes >
      SESSION_RETENTION_POLICY.maxDisplayBytesTotal ||
    next.items.size !== previous.items.size
  ) return true;
  for (const fact of facts) {
    switch (fact.type) {
      case "thread.snapshot":
      case "thread.deleted":
      case "turn.snapshot":
      case "turn.started":
      case "turn.completed":
      case "item.started":
      case "item.completed":
      case "interaction.requested":
      case "interaction.settled":
      case "operation.changed":
        return true;
      case "item.delta": {
        const thread = next.threads[sessionEntityKey(
          fact.accountProfileId,
          fact.threadId,
        )];
        if (
          thread !== undefined &&
          (next.threadDisplayTextUtf8Bytes.get(sessionEntityKey(
            fact.accountProfileId,
            fact.threadId,
          )) ?? 0) >
            SESSION_RETENTION_POLICY.maxDisplayBytesPerThread
        ) return true;
        break;
      }
      case "runtime.changed":
      case "account.changed":
      case "account.login_completed":
      case "account.profile_updated":
      case "account.rate_limits_updated":
      case "thread.archived":
      case "thread.title_changed":
      case "thread.status_changed":
      case "turn.activity":
      case "turn.token_usage":
      case "turn.model_rerouted":
      case "server_request.resolved":
      case "hydration.changed":
        break;
    }
  }
  return false;
}

/** Applies deterministic, authority-preserving live-state retention bounds. */
export function compactSessionState(previous: SessionState): SessionState {
  let next = previous;
  const accountIds = sessionAccountIds(next);
  for (const accountProfileId of accountIds) {
    assertAccountVolatileBounds(next, accountProfileId);
    next = compactAccountMetadata(next, accountProfileId);
    next = compactAccountHistory(next, accountProfileId);
  }
  for (const [threadKey] of Object.entries(next.threads)) {
    next = compactThreadDisplay(next, threadKey);
  }
  next = compactGlobalDisplay(next);
  assertSessionRetentionConsistency(next);
  return next;
}

function sessionAccountIds(state: SessionState): readonly string[] {
  const ids = new Set<string>();
  for (const value of Object.values(state.accounts)) ids.add(value.accountProfileId);
  for (const value of Object.values(state.threads)) ids.add(value.accountProfileId);
  for (const value of Object.values(state.interactions)) ids.add(value.accountProfileId);
  for (const value of Object.values(state.operations)) ids.add(value.accountProfileId);
  for (const value of Object.values(state.threadTombstones)) ids.add(value.accountProfileId);
  for (const value of state.items.values()) ids.add(value.accountProfileId);
  return Object.freeze([...ids].toSorted());
}

function assertAccountVolatileBounds(
  state: SessionState,
  accountProfileId: string,
): void {
  const pendingInteractions = Object.values(state.interactions).filter(
    (value) => value.accountProfileId === accountProfileId,
  ).length;
  const pendingOperations = Object.values(state.operations).filter(
    (value) => value.accountProfileId === accountProfileId,
  ).length;
  const tombstones = Object.values(state.threadTombstones).filter(
    (value) => value.accountProfileId === accountProfileId,
  ).length;
  if (
    pendingInteractions > SESSION_RETENTION_POLICY.maxPendingInteractionsPerAccount ||
    pendingOperations > SESSION_RETENTION_POLICY.maxPendingOperationsPerAccount ||
    tombstones > SESSION_RETENTION_POLICY.maxThreadTombstonesPerAccount
  ) throw new SessionFactInvariantError();
}

function compactAccountMetadata(
  previous: SessionState,
  accountProfileId: string,
): SessionState {
  const threads = Object.entries(previous.threads)
    .filter(([, thread]) => thread.accountProfileId === accountProfileId)
    .toSorted((left, right) => compareRetainedThreads(left[1], right[1]));
  if (threads.length <= SESSION_RETENTION_POLICY.maxMetadataThreadsPerAccount) {
    return previous;
  }
  const mandatory = mandatoryThreadKeys(previous, accountProfileId);
  if (mandatory.size > SESSION_RETENTION_POLICY.maxMetadataThreadsPerAccount) {
    throw new SessionFactInvariantError();
  }
  const retained = new Set<string>(mandatory);
  for (const [threadKey] of threads) {
    if (retained.size >= SESSION_RETENTION_POLICY.maxMetadataThreadsPerAccount) break;
    retained.add(threadKey);
  }
  let next = previous;
  for (const [threadKey] of threads) {
    if (!retained.has(threadKey)) next = forgetThread(next, threadKey);
  }
  return next;
}

function compactAccountHistory(
  previous: SessionState,
  accountProfileId: string,
): SessionState {
  const histories = Object.entries(previous.threads)
    .filter(([, thread]) =>
      thread.accountProfileId === accountProfileId && thread.turnKeys.length > 0
    )
    .toSorted((left, right) => compareRetainedThreads(left[1], right[1]));
  if (histories.length <= SESSION_RETENTION_POLICY.maxHistoryThreadsPerAccount) {
    return previous;
  }
  const authority = mandatoryThreadKeys(previous, accountProfileId);
  const mandatory = new Set(histories.flatMap(([threadKey]) =>
    authority.has(threadKey) ? [threadKey] : []
  ));
  if (mandatory.size > SESSION_RETENTION_POLICY.maxHistoryThreadsPerAccount) {
    throw new SessionFactInvariantError();
  }
  const retained = new Set<string>(mandatory);
  for (const [threadKey] of histories) {
    if (retained.size >= SESSION_RETENTION_POLICY.maxHistoryThreadsPerAccount) break;
    retained.add(threadKey);
  }
  let next = previous;
  for (const [threadKey] of histories) {
    if (!retained.has(threadKey)) next = forgetThreadHistory(next, threadKey);
  }
  return next;
}

function mandatoryThreadKeys(
  state: SessionState,
  accountProfileId: string,
): Set<string> {
  const mandatory = new Set<string>();
  for (const [threadKey, thread] of Object.entries(state.threads)) {
    if (
      thread.accountProfileId === accountProfileId &&
      (thread.status === "active" || thread.turnKeys.some(
        (turnKey) => state.turns[turnKey]?.status === "active",
      ))
    ) mandatory.add(threadKey);
  }
  for (const interaction of Object.values(state.interactions)) {
    if (interaction.accountProfileId === accountProfileId) {
      mandatory.add(interaction.threadKey);
    }
  }
  for (const operation of Object.values(state.operations)) {
    if (operation.accountProfileId === accountProfileId && operation.threadKey !== null) {
      mandatory.add(operation.threadKey);
    }
  }
  return mandatory;
}

function compareRetainedThreads(
  left: SessionThreadState,
  right: SessionThreadState,
): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function compactThreadDisplay(
  previous: SessionState,
  threadKey: string,
): SessionState {
  const thread = previous.threads[threadKey];
  if (thread === undefined) return previous;
  const activeTurns = thread.turnKeys.filter(
    (turnKey) => previous.turns[turnKey]?.status === "active",
  );
  if (activeTurns.length > SESSION_RETENTION_POLICY.maxActiveTurnsPerThread) {
    throw new SessionFactInvariantError();
  }
  const orderedKeys: string[] = [];
  const mandatory = new Set<string>();
  for (const turnKey of thread.turnKeys) {
    const turn = previous.turns[turnKey];
    if (turn === undefined) continue;
    let activeItems = 0;
    for (const itemKey of turn.itemKeys) {
      const item = previous.items.get(itemKey);
      if (item === undefined) continue;
      orderedKeys.push(itemKey);
      if (item.status === "streaming") {
        mandatory.add(itemKey);
        activeItems += 1;
      }
    }
    if (activeItems > SESSION_RETENTION_POLICY.maxActiveItemsPerTurn) {
      throw new SessionFactInvariantError();
    }
  }
  let mandatoryBytes = 0;
  for (const itemKey of mandatory) {
    mandatoryBytes += previous.items.get(itemKey)?.text?.utf8Bytes ?? 0;
  }
  if (
    mandatory.size > SESSION_RETENTION_POLICY.maxDisplayItemsPerThread ||
    mandatoryBytes > SESSION_RETENTION_POLICY.maxDisplayBytesPerThread
  ) throw new SessionFactInvariantError();

  const retained = new Set(mandatory);
  let retainedBytes = mandatoryBytes;
  for (const itemKey of [...orderedKeys].reverse()) {
    if (retained.has(itemKey)) continue;
    const item = previous.items.get(itemKey);
    if (item === undefined) continue;
    const bytes = item.text?.utf8Bytes ?? 0;
    if (
      retained.size >= SESSION_RETENTION_POLICY.maxDisplayItemsPerThread ||
      retainedBytes + bytes > SESSION_RETENTION_POLICY.maxDisplayBytesPerThread
    ) continue;
    retained.add(itemKey);
    retainedBytes += bytes;
  }
  let next = previous;
  for (const itemKey of orderedKeys) {
    if (!retained.has(itemKey)) next = forgetItem(next, itemKey);
  }
  return removeDanglingItemKeys(next, threadKey);
}

function compactGlobalDisplay(previous: SessionState): SessionState {
  if (
    previous.retainedDisplayTextUtf8Bytes <=
    SESSION_RETENTION_POLICY.maxDisplayBytesTotal
  ) return previous;
  let mandatoryBytes = 0;
  const candidates: Readonly<{ itemKey: string; threadUpdatedAt: string }> [] = [];
  for (const [itemKey, item] of previous.items.entries()) {
    if (item.status === "streaming") {
      mandatoryBytes += item.text?.utf8Bytes ?? 0;
    } else {
      candidates.push({
        itemKey,
        threadUpdatedAt: previous.threads[item.threadKey]?.updatedAt ?? "",
      });
    }
  }
  if (mandatoryBytes > SESSION_RETENTION_POLICY.maxDisplayBytesTotal) {
    throw new SessionFactInvariantError();
  }
  candidates.sort((left, right) =>
    left.threadUpdatedAt.localeCompare(right.threadUpdatedAt) ||
    left.itemKey.localeCompare(right.itemKey)
  );
  let next = previous;
  for (const { itemKey } of candidates) {
    if (
      next.retainedDisplayTextUtf8Bytes <=
      SESSION_RETENTION_POLICY.maxDisplayBytesTotal
    ) break;
    next = forgetItem(next, itemKey);
  }
  if (
    next.retainedDisplayTextUtf8Bytes >
    SESSION_RETENTION_POLICY.maxDisplayBytesTotal
  ) throw new SessionFactInvariantError();
  return next;
}

function forgetThread(previous: SessionState, threadKey: string): SessionState {
  const thread = previous.threads[threadKey];
  if (thread === undefined) return previous;
  let next = previous;
  for (const turnKey of thread.turnKeys) next = deleteTurnByKey(next, turnKey);
  next = {
    ...next,
    hydration: deleteRecord(next.hydration, threadKey),
    threadDisplayTextUtf8Bytes: deleteSessionEntity(
      next.threadDisplayTextUtf8Bytes,
      threadKey,
    ),
    threads: deleteRecord(next.threads, threadKey),
  };
  for (const [key, interaction] of Object.entries(next.interactions)) {
    if (interaction.threadKey === threadKey) {
      next = { ...next, interactions: deleteRecord(next.interactions, key) };
    }
  }
  for (const [key, operation] of Object.entries(next.operations)) {
    if (operation.threadKey === threadKey) {
      next = { ...next, operations: deleteRecord(next.operations, key) };
    }
  }
  return next;
}

function forgetThreadHistory(previous: SessionState, threadKey: string): SessionState {
  const thread = previous.threads[threadKey];
  if (thread === undefined || thread.turnKeys.length === 0) return previous;
  let next = previous;
  for (const turnKey of thread.turnKeys) next = deleteTurnByKey(next, turnKey);
  const current = next.threads[threadKey];
  return current === undefined
    ? next
    : {
        ...next,
        threads: setRecord(next.threads, threadKey, {
          ...current,
          turnKeys: Object.freeze([]),
        }),
      };
}

function forgetItem(previous: SessionState, itemKey: string): SessionState {
  const item = previous.items.get(itemKey);
  if (item === undefined) return previous;
  let next = deleteItemState(previous, itemKey);
  const turn = next.turns[item.turnKey];
  if (turn !== undefined && turn.itemKeys.includes(itemKey)) {
    next = {
      ...next,
      turns: setRecord(next.turns, item.turnKey, {
        ...turn,
        itemKeys: Object.freeze(turn.itemKeys.filter((key) => key !== itemKey)),
      }),
    };
  }
  return next;
}

function removeDanglingItemKeys(
  previous: SessionState,
  threadKey: string,
): SessionState {
  const thread = previous.threads[threadKey];
  if (thread === undefined) return previous;
  let next = previous;
  for (const turnKey of thread.turnKeys) {
    const turn = next.turns[turnKey];
    if (turn === undefined) continue;
    const itemKeys = turn.itemKeys.filter((itemKey) => next.items.get(itemKey) !== undefined);
    if (itemKeys.length !== turn.itemKeys.length) {
      next = {
        ...next,
        turns: setRecord(next.turns, turnKey, {
          ...turn,
          itemKeys: Object.freeze(itemKeys),
        }),
      };
    }
  }
  return next;
}

function assertSessionRetentionConsistency(state: SessionState): void {
  let retainedBytes = 0;
  for (const [, item] of state.items.entries()) {
    retainedBytes += item.text?.utf8Bytes ?? 0;
    const turn = state.turns[item.turnKey];
    if (
      turn === undefined || turn.threadKey !== item.threadKey ||
      !turn.itemKeys.includes(sessionEntityKey(item.accountProfileId, item.id))
    ) throw new SessionFactInvariantError();
  }
  if (retainedBytes !== state.retainedDisplayTextUtf8Bytes) {
    throw new SessionFactInvariantError();
  }
  for (const [threadKey, thread] of Object.entries(state.threads)) {
    if (
      threadDisplayTextBytes(state, thread.turnKeys) !==
      (state.threadDisplayTextUtf8Bytes.get(threadKey) ?? 0)
    ) {
      throw new SessionFactInvariantError();
    }
    for (const turnKey of thread.turnKeys) {
      if (state.turns[turnKey]?.threadKey !== threadKey) {
        throw new SessionFactInvariantError();
      }
    }
  }
}

function deleteTurnByKey(previous: SessionState, turnKey: string): SessionState {
  const turn = previous.turns[turnKey];
  if (turn === undefined) return previous;
  let next = previous;
  for (const itemKey of turn.itemKeys) next = deleteItemState(next, itemKey);
  let interactions = previous.interactions;
  for (const [key, interaction] of Object.entries(interactions)) {
    if (interaction.turnKey === turnKey) interactions = deleteRecord(interactions, key);
  }
  return {
    ...next,
    interactions,
    turns: deleteRecord(next.turns, turnKey),
  };
}

function setItemState(
  previous: SessionState,
  itemKey: string,
  item: SessionItemState,
): SessionState {
  const current = previous.items.get(itemKey);
  if (current === item) return previous;
  if (
    current !== undefined &&
    (current.threadKey !== item.threadKey || current.turnKey !== item.turnKey)
  ) {
    throw new SessionFactInvariantError();
  }
  const retainedDelta = itemTextBytes(item) - (current === undefined ? 0 : itemTextBytes(current));
  const retainedDisplayTextUtf8Bytes = previous.retainedDisplayTextUtf8Bytes + retainedDelta;
  if (!Number.isSafeInteger(retainedDisplayTextUtf8Bytes) || retainedDisplayTextUtf8Bytes < 0) {
    throw new SessionFactInvariantError();
  }
  let next: SessionState = {
    ...previous,
    items: setSessionEntity(previous.items, itemKey, item),
    retainedDisplayTextUtf8Bytes,
  };
  if (retainedDelta !== 0) {
    const threadBytes = (next.threadDisplayTextUtf8Bytes.get(item.threadKey) ?? 0) +
      retainedDelta;
    if (!Number.isSafeInteger(threadBytes) || threadBytes < 0) {
      throw new SessionFactInvariantError();
    }
    next = {
      ...next,
      threadDisplayTextUtf8Bytes: threadBytes === 0
        ? deleteSessionEntity(next.threadDisplayTextUtf8Bytes, item.threadKey)
        : setSessionEntity(next.threadDisplayTextUtf8Bytes, item.threadKey, threadBytes),
    };
  }
  return next;
}

function deleteItemState(previous: SessionState, itemKey: string): SessionState {
  const current = previous.items.get(itemKey);
  if (current === undefined) return previous;
  const retainedDelta = itemTextBytes(current);
  let next: SessionState = {
    ...previous,
    items: deleteSessionEntity(previous.items, itemKey),
    retainedDisplayTextUtf8Bytes: previous.retainedDisplayTextUtf8Bytes - retainedDelta,
  };
  if (retainedDelta !== 0) {
    const threadBytes =
      (next.threadDisplayTextUtf8Bytes.get(current.threadKey) ?? 0) - retainedDelta;
    next = {
      ...next,
      threadDisplayTextUtf8Bytes: threadBytes === 0
        ? deleteSessionEntity(next.threadDisplayTextUtf8Bytes, current.threadKey)
        : setSessionEntity(next.threadDisplayTextUtf8Bytes, current.threadKey, threadBytes),
    };
  }
  if (
    next.retainedDisplayTextUtf8Bytes < 0 ||
    (next.threadDisplayTextUtf8Bytes.get(current.threadKey) ?? 0) < 0
  ) {
    throw new SessionFactInvariantError();
  }
  return next;
}

function itemTextBytes(item: SessionItemState): number {
  return item.text?.utf8Bytes ?? 0;
}

function threadDisplayTextBytes(
  state: SessionState,
  turnKeys: readonly string[],
): number {
  let bytes = 0;
  for (const turnKey of turnKeys) {
    const turn = state.turns[turnKey];
    if (turn === undefined) continue;
    for (const itemKey of turn.itemKeys) {
      bytes += state.items.get(itemKey)?.text?.utf8Bytes ?? 0;
      if (!Number.isSafeInteger(bytes)) throw new SessionFactInvariantError();
    }
  }
  return bytes;
}

function updateThread(
  previous: SessionState,
  accountProfileId: string,
  threadId: string,
  update: (thread: SessionThreadState) => SessionThreadState,
): SessionState {
  const key = sessionEntityKey(accountProfileId, threadId);
  const current = previous.threads[key];
  if (current === undefined) return previous;
  const next = update(current);
  return next === current
    ? previous
    : { ...previous, threads: setRecord(previous.threads, key, next) };
}

function updateTurn(
  previous: SessionState,
  accountProfileId: string,
  turnId: string,
  update: (turn: SessionTurnState) => SessionTurnState,
): SessionState {
  const key = sessionEntityKey(accountProfileId, turnId);
  const current = previous.turns[key];
  if (current === undefined) return previous;
  const next = update(current);
  return next === current
    ? previous
    : { ...previous, turns: setRecord(previous.turns, key, next) };
}

function linkedTurn(
  state: SessionState,
  accountProfileId: string,
  threadId: string,
  turnId: string,
): Readonly<{ threadKey: string; turnKey: string }> | null {
  const threadKey = sessionEntityKey(accountProfileId, threadId);
  const turnKey = sessionEntityKey(accountProfileId, turnId);
  const thread = state.threads[threadKey];
  const turn = state.turns[turnKey];
  return thread !== undefined && turn?.threadKey === threadKey
    ? { threadKey, turnKey }
    : null;
}

function linkItem(state: SessionState, turnKey: string, itemKey: string): SessionState {
  const turn = state.turns[turnKey];
  if (turn === undefined || turn.itemKeys.includes(itemKey)) return state;
  return {
    ...state,
    turns: setRecord(state.turns, turnKey, {
      ...turn,
      itemKeys: Object.freeze([...turn.itemKeys, itemKey]),
    }),
  };
}

function displayFromSnapshot(snapshot: CodexItemSnapshot): SessionItemDisplay {
  switch (snapshot.kind) {
    case "assistant_text":
      return { kind: "assistant_text" };
    case "user_text":
      return { kind: "user_text", clientMessageId: snapshot.clientMessageId };
    case "reasoning_summary":
      return { kind: "reasoning_summary" };
    case "tool":
      return { kind: "tool", activity: snapshot.activity };
    case "error":
      return { kind: "error", category: snapshot.category };
  }
}

function appendText(
  previous: SessionTextBuffer,
  delta: string,
  truncated: boolean,
): SessionTextBuffer {
  if (previous.complete || previous.overflowed || delta.length === 0) return previous;
  if (previous.deltaCount >= SESSION_RETENTION_POLICY.maxStreamingDeltasPerItem) {
    return { ...previous, overflowed: true };
  }
  const deltaBytes = utf8Bytes(delta);
  if (previous.utf8Bytes + deltaBytes > MAX_SESSION_ITEM_TEXT_UTF8_BYTES) {
    return { ...previous, overflowed: true };
  }
  const chunks = appendStreamingChunk(previous.chunks, delta);
  return {
    chunks,
    complete: false,
    deltaCount: previous.deltaCount + 1,
    overflowed: truncated,
    utf8Bytes: previous.utf8Bytes + deltaBytes,
  };
}

function completeText(text: string, truncated = false): SessionTextBuffer {
  const bounded = boundedCodexDisplayText(text, MAX_SESSION_ITEM_TEXT_UTF8_BYTES);
  return {
    chunks: Object.freeze(bounded.text.length === 0 ? [] : [bounded.text]),
    complete: true,
    deltaCount: 0,
    overflowed: truncated || bounded.truncated,
    utf8Bytes: utf8Bytes(bounded.text),
  };
}

const STREAMING_TEXT_CHUNK_UTF8_BYTES = 16 * 1_024;

function appendStreamingChunk(
  previous: readonly string[],
  delta: string,
): readonly string[] {
  const tail = previous.at(-1);
  if (tail !== undefined && utf8Bytes(tail) + utf8Bytes(delta) <= STREAMING_TEXT_CHUNK_UTF8_BYTES) {
    return Object.freeze([...previous.slice(0, -1), tail + delta]);
  }
  return Object.freeze([...previous, delta]);
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function setRecord<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
  value: Value,
): Readonly<Record<string, Value>> {
  if (record[key] === value) return record;
  return Object.freeze({ ...record, [key]: value });
}

function deleteRecord<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Readonly<Record<string, Value>> {
  if (!Object.hasOwn(record, key)) return record;
  const next = { ...record };
  delete next[key];
  return Object.freeze(next);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left === right || (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function sameAccount(left: SessionAccountState, right: SessionAccountState): boolean {
  return left.accountProfileId === right.accountProfileId &&
    left.availability === right.availability && left.runtime === right.runtime;
}

function sameThread(left: SessionThreadState, right: SessionThreadState): boolean {
  return left.accountProfileId === right.accountProfileId &&
    left.archived === right.archived && left.createdAt === right.createdAt &&
    left.cwd === right.cwd && left.id === right.id && left.status === right.status &&
    left.title === right.title && sameArray(left.turnKeys, right.turnKeys) &&
    left.updatedAt === right.updatedAt;
}

function sameTurn(
  left: SessionTurnState | undefined,
  right: SessionTurnState,
): boolean {
  return left !== undefined && left.accountProfileId === right.accountProfileId &&
    left.activity === right.activity && left.completedAt === right.completedAt &&
    left.id === right.id && sameArray(left.itemKeys, right.itemKeys) &&
    left.quotaProof === right.quotaProof &&
    left.startedAt === right.startedAt && left.status === right.status &&
    left.threadKey === right.threadKey;
}

function sameDisplay(left: SessionItemDisplay, right: SessionItemDisplay): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "user_text":
      return right.kind === "user_text" && left.clientMessageId === right.clientMessageId;
    case "tool":
      return right.kind === "tool" && left.activity === right.activity;
    case "error":
      return right.kind === "error" && left.category === right.category;
    case "assistant_text":
    case "reasoning_summary":
      return true;
  }
}

function sameText(left: SessionTextBuffer | null, right: SessionTextBuffer | null): boolean {
  return left === right || (
    left !== null && right !== null && left.complete === right.complete &&
    left.deltaCount === right.deltaCount && left.overflowed === right.overflowed &&
    left.utf8Bytes === right.utf8Bytes && sameArray(left.chunks, right.chunks)
  );
}

function sameItem(left: SessionItemState, right: SessionItemState): boolean {
  return left.accountProfileId === right.accountProfileId &&
    sameDisplay(left.display, right.display) && left.id === right.id &&
    left.status === right.status && sameText(left.text, right.text) &&
    left.threadKey === right.threadKey && left.turnKey === right.turnKey;
}

function sameInteraction(
  left: SessionInteractionState,
  right: SessionInteractionState,
): boolean {
  return left.accountProfileId === right.accountProfileId &&
    left.expiresAt === right.expiresAt && left.id === right.id &&
    left.kind === right.kind && left.outcome === right.outcome &&
    left.threadKey === right.threadKey && left.turnKey === right.turnKey;
}

function sameOperation(left: SessionOperationState, right: SessionOperationState): boolean {
  return left.accountProfileId === right.accountProfileId && left.id === right.id &&
    left.operation === right.operation && left.outcome === right.outcome &&
    left.threadKey === right.threadKey;
}

function sameHydration(left: SessionHydrationState, right: SessionHydrationState): boolean {
  return left.accountProfileId === right.accountProfileId && left.attempt === right.attempt &&
    left.origin === right.origin && left.status === right.status &&
    left.threadKey === right.threadKey;
}

function withNextRevision(previous: SessionState, next: SessionState): SessionState {
  if (!Number.isSafeInteger(previous.revision) || previous.revision < 0 ||
    previous.revision === Number.MAX_SAFE_INTEGER) {
    throw new SessionFactInvariantError();
  }
  return { ...next, revision: previous.revision + 1 };
}

function sameSessionStateReferences(left: SessionState, right: SessionState): boolean {
  return left.accounts === right.accounts && left.cursors === right.cursors &&
    left.hydration === right.hydration && left.interactions === right.interactions &&
    left.items === right.items && left.operations === right.operations &&
    left.retainedDisplayTextUtf8Bytes === right.retainedDisplayTextUtf8Bytes &&
    left.threadTombstones === right.threadTombstones &&
    left.threadDisplayTextUtf8Bytes === right.threadDisplayTextUtf8Bytes &&
    left.threads === right.threads &&
    left.turns === right.turns;
}

export { createSessionState };
