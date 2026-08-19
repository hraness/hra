import {
  runtimeChatReasoningTailUtf8ByteLimit,
  runtimeChatPaneLimit,
  runtimeChatResponseTailUtf8ByteLimit,
  runtimeAccountProfileLimit,
  runtimeRetainedAccountLocalDataLimit,
  type ChatPaneProjection,
  type ChatPaneStateProjection,
  type ChatUtf8Tail,
  type RemoteSessionSummaryProjection,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "./runtime";

export type RuntimeProjectionEvent = RuntimeEvent["event"];

/**
 * Apply one portable domain transition without delivery-policy decisions.
 * Callers own duplicate, gap, and snapshot-invalidation behavior.
 */
export function reduceRuntimeProjectionEvent(
  snapshot: RuntimeSnapshot,
  event: RuntimeProjectionEvent,
): RuntimeSnapshot {
  switch (event.type) {
    case "runtime.changed":
      return { ...snapshot, runtime: structuredClone(event.runtime) };
    case "runner.changed":
      return { ...snapshot, runner: structuredClone(event.runner) };
    case "account.upserted":
      return {
        ...snapshot,
        accounts: upsertById(
          snapshot.accounts,
          event.account,
          runtimeAccountProfileLimit,
          "account profile",
        ),
      };
    case "account.removed":
      return {
        ...snapshot,
        accounts: removeById(snapshot.accounts, event.accountProfileId),
      };
    case "chat.pane.upserted":
      return upsertChatPane(snapshot, event.pane, event.revision);
    case "chat.pane.stateChanged":
      return changeChatPaneState(snapshot, event.pane, event.revision);
    case "chat.pane.removed":
      return removeChatPane(snapshot, event.paneId, event.revision);
    case "chat.panes.reordered":
      return reorderChatPanes(snapshot, event.orderedPaneIds);
    case "chat.turn.delta":
      return appendChatTurnDelta(snapshot, event);
    case "chat.messageQueue.changed":
      // The compact event is an invalidation marker. RuntimeProjection installs
      // the complete queue into its authoritative snapshot before publishing
      // it, and the renderer rehydrates instead of fabricating missing text.
      return snapshot;
    case "accountLocalData.upserted":
      return {
        ...snapshot,
        retainedAccountLocalData: upsertById(
          snapshot.retainedAccountLocalData,
          event.localData,
          runtimeRetainedAccountLocalDataLimit,
          "retained account local data",
        ),
      };
    case "accountLocalData.removed":
      return {
        ...snapshot,
        retainedAccountLocalData: removeById(
          snapshot.retainedAccountLocalData,
          event.accountProfileId,
        ),
      };
    case "humanAccount.changed":
      return {
        ...snapshot,
        humanAccount: structuredClone(event.humanAccount),
      };
    case "sessionSync.statusChanged": {
      const previousStatus = snapshot.sessionSync.status;
      const sameActiveScope = previousStatus.state === "active"
        && event.status.state === "active"
        && previousStatus.scopeGeneration === event.status.scopeGeneration
        && previousStatus.currentDeviceId === event.status.currentDeviceId;
      return {
        ...snapshot,
        sessionSync: {
          localGridSlots: snapshot.sessionSync.localGridSlots,
          status: structuredClone(event.status),
          remoteSessions: sameActiveScope
            ? snapshot.sessionSync.remoteSessions
            : [],
        },
      };
    }
    case "sessionSync.localGrid.changed":
      return installLocalGridSlots(snapshot, event.slots);
    case "sessionSync.remote.upserted":
      return upsertRemoteSession(snapshot, event.session);
    case "sessionSync.remote.removed":
      return {
        ...snapshot,
        sessionSync: {
          ...snapshot.sessionSync,
          remoteSessions: snapshot.sessionSync.remoteSessions.filter(
            ({ sessionId }) => sessionId !== event.sessionId,
          ),
        },
      };
    case "sessionSync.remote.cleared":
      return {
        ...snapshot,
        sessionSync: { ...snapshot.sessionSync, remoteSessions: [] },
      };
    case "snapshot.invalidated":
    case "operation.completed":
    case "task.invalidated":
      return snapshot;
    default:
      return assertNever(event);
  }
}

function upsertRemoteSession(
  snapshot: RuntimeSnapshot,
  session: RemoteSessionSummaryProjection,
): RuntimeSnapshot {
  if (snapshot.sessionSync.status.state !== "active") {
    throw new RangeError("Cannot install a remote session while sync is inactive");
  }
  const sessions = snapshot.sessionSync.remoteSessions;
  const index = sessions.findIndex(({ sessionId }) =>
    sessionId === session.sessionId
  );
  if (sessions.some((candidate, candidateIndex) =>
    candidate.gridPosition === session.gridPosition && candidateIndex !== index
  ) || snapshot.sessionSync.localGridSlots.some(({ gridPosition }) =>
    gridPosition === session.gridPosition
  )) {
    throw new RangeError(
      `Remote sync grid position ${session.gridPosition} is already occupied`,
    );
  }
  const replacement = structuredClone(session);
  const remoteSessions = index < 0
    ? [...sessions, replacement]
    : replaceAt(sessions, index, replacement);
  return {
    ...snapshot,
    sessionSync: { ...snapshot.sessionSync, remoteSessions },
  };
}

function installLocalGridSlots(
  snapshot: RuntimeSnapshot,
  slots: RuntimeSnapshot["sessionSync"]["localGridSlots"],
): RuntimeSnapshot {
  const paneIds = new Set<string>();
  const positions = new Set<number>(
    snapshot.sessionSync.remoteSessions.map(({ gridPosition }) => gridPosition),
  );
  for (const slot of slots) {
    if (paneIds.has(slot.paneId) || positions.has(slot.gridPosition)) {
      throw new RangeError("Session sync local grid slots conflict");
    }
    paneIds.add(slot.paneId);
    positions.add(slot.gridPosition);
  }
  return {
    ...snapshot,
    sessionSync: {
      ...snapshot.sessionSync,
      localGridSlots: structuredClone(slots),
    },
  };
}

function changeChatPaneState(
  snapshot: RuntimeSnapshot,
  state: ChatPaneStateProjection,
  revision: number,
): RuntimeSnapshot {
  const index = snapshot.chat.panes.findIndex(({ id }) => id === state.id);
  if (index < 0) {
    throw new RangeError(`Cannot change state for unknown chat pane ${state.id}`);
  }
  const pane = snapshot.chat.panes[index]!;
  const expectedRevision = incrementSafe(pane.revision, "chat pane revision");
  requireExactChatPaneRevision(pane.id, expectedRevision, revision);
  if (state.revision !== revision) {
    throw new RangeError(
      `Chat pane ${pane.id} state revision ${state.revision} does not match event revision ${revision}`,
    );
  }
  if (pane.turn?.id !== state.turn?.id) {
    throw new RangeError(
      `Chat pane ${pane.id} state events cannot replace its latest turn`,
    );
  }
  if (state.interactionMode !== pane.interactionMode) {
    throw new RangeError(`Chat pane ${pane.id} cannot change its interaction mode`);
  }
  requireValidActivityAdvance(pane, state);

  const turn = state.turn === null
    ? null
    : {
      ...structuredClone(state.turn),
      responseMarkdown: structuredClone(pane.turn!.responseMarkdown),
      reasoningSummary: structuredClone(pane.turn!.reasoningSummary),
      reasoningSummaryVerified: pane.turn!.reasoningSummaryVerified,
    };
  const replacement: ChatPaneProjection = {
    ...pane,
    ...structuredClone(state),
    // Chat owns pane lifecycle; only the atomic harness installer owns this
    // decoration. A normal turn update must not erase recursive state.
    harness: pane.harness,
    turn,
  };
  return updateChat(
    snapshot,
    replaceAt(snapshot.chat.panes, index, replacement),
  );
}

function upsertChatPane(
  snapshot: RuntimeSnapshot,
  pane: ChatPaneProjection,
  revision: number,
): RuntimeSnapshot {
  const index = snapshot.chat.panes.findIndex(({ id }) => id === pane.id);
  const expectedRevision = index < 0
    ? 1
    : incrementSafe(snapshot.chat.panes[index]!.revision, "chat pane revision");
  requireExactChatPaneRevision(pane.id, expectedRevision, revision);
  if (pane.revision !== revision) {
    throw new RangeError(
      `Chat pane ${pane.id} projection revision ${pane.revision} does not match event revision ${revision}`,
    );
  }

  if (index < 0 && snapshot.chat.panes.length >= runtimeChatPaneLimit) {
    throw new RangeError(`Chat pane capacity ${runtimeChatPaneLimit} is full`);
  }
  if (index >= 0) requireValidActivityAdvance(snapshot.chat.panes[index]!, pane);
  const replacement = structuredClone({
    ...pane,
    // Existing harness state advances only through installHarnessState. New
    // panes may carry their initial decoration during bootstrap.
    ...(index < 0 ? {} : { harness: snapshot.chat.panes[index]!.harness }),
  });
  const panes = index < 0
    ? [...snapshot.chat.panes, replacement]
    : replaceAt(snapshot.chat.panes, index, replacement);
  return updateChat(snapshot, panes);
}

function removeChatPane(
  snapshot: RuntimeSnapshot,
  paneId: string,
  revision: number,
): RuntimeSnapshot {
  const index = snapshot.chat.panes.findIndex(({ id }) => id === paneId);
  if (index < 0) {
    throw new RangeError(`Cannot remove unknown chat pane ${paneId}`);
  }
  const expectedRevision = incrementSafe(
    snapshot.chat.panes[index]!.revision,
    "chat pane revision",
  );
  requireExactChatPaneRevision(paneId, expectedRevision, revision);
  return updateChat(snapshot, [
    ...snapshot.chat.panes.slice(0, index),
    ...snapshot.chat.panes.slice(index + 1),
  ]);
}

function reorderChatPanes(
  snapshot: RuntimeSnapshot,
  orderedPaneIds: readonly string[],
): RuntimeSnapshot {
  if (orderedPaneIds.length !== snapshot.chat.panes.length) {
    throw new RangeError("Chat pane order does not cover the live pane set");
  }
  const panesById = new Map(snapshot.chat.panes.map((pane) => [pane.id, pane] as const));
  if (
    panesById.size !== orderedPaneIds.length
    || orderedPaneIds.some((paneId) => !panesById.has(paneId))
  ) {
    throw new RangeError("Chat pane order does not exactly match the live pane set");
  }
  return updateChat(
    snapshot,
    orderedPaneIds.map((paneId) => structuredClone(panesById.get(paneId)!)),
  );
}

function appendChatTurnDelta(
  snapshot: RuntimeSnapshot,
  event: Extract<RuntimeProjectionEvent, { readonly type: "chat.turn.delta" }>,
): RuntimeSnapshot {
  const paneIndex = snapshot.chat.panes.findIndex(({ id }) => id === event.paneId);
  if (paneIndex < 0) {
    throw new RangeError(`Cannot append to unknown chat pane ${event.paneId}`);
  }
  const pane = snapshot.chat.panes[paneIndex]!;
  const expectedRevision = incrementSafe(pane.revision, "chat pane revision");
  requireExactChatPaneRevision(pane.id, expectedRevision, event.revision);
  if (pane.turn?.id !== event.turnId) {
    throw new RangeError(
      `Chat pane ${pane.id} does not own turn ${event.turnId}`,
    );
  }
  if (
    (pane.state !== "starting" &&
      pane.state !== "streaming" &&
      pane.state !== "continuing") ||
    (pane.turn.status !== "starting" &&
      pane.turn.status !== "streaming" &&
      pane.turn.status !== "continuing")
  ) {
    throw new RangeError(
      `Chat turn ${event.turnId} is terminal and cannot accept deltas`,
    );
  }

  const current = pane.turn[event.channel];
  if (event.startUtf8Offset !== current.totalUtf8Bytes) {
    throw new RangeError(
      `Chat ${event.channel} delta for ${event.turnId} must start at UTF-8 byte ` +
        `${current.totalUtf8Bytes}; received ${event.startUtf8Offset}`,
    );
  }
  const maxTailUtf8Bytes = event.channel === "responseMarkdown"
    ? runtimeChatResponseTailUtf8ByteLimit
    : runtimeChatReasoningTailUtf8ByteLimit;
  const appended = appendUtf8Tail(current, event.delta, maxTailUtf8Bytes);
  const turn = {
    ...pane.turn,
    [event.channel]: appended,
  };
  const updatedPane: ChatPaneProjection = {
    ...pane,
    revision: event.revision,
    turn,
  };
  return updateChat(
    snapshot,
    replaceAt(snapshot.chat.panes, paneIndex, updatedPane),
  );
}

function appendUtf8Tail(
  current: ChatUtf8Tail,
  delta: string,
  maxTailUtf8Bytes: number,
): ChatUtf8Tail {
  const deltaUtf8Bytes = new TextEncoder().encode(delta).byteLength;
  const totalUtf8Bytes = incrementSafeBy(
    current.totalUtf8Bytes,
    deltaUtf8Bytes,
    "chat turn UTF-8 byte count",
  );
  const tail = utf8Suffix(`${current.tail}${delta}`, maxTailUtf8Bytes);
  const tailUtf8Bytes = new TextEncoder().encode(tail).byteLength;
  return {
    tail,
    totalUtf8Bytes,
    truncatedPrefix: totalUtf8Bytes > tailUtf8Bytes,
  };
}

function utf8Suffix(value: string, maxUtf8Bytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxUtf8Bytes) return value;
  let start = bytes.byteLength - maxUtf8Bytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
}

function requireExactChatPaneRevision(
  paneId: string,
  expected: number,
  received: number,
): void {
  if (received !== expected) {
    throw new RangeError(
      `Chat pane ${paneId} revision must advance to ${expected}; received ${received}`,
    );
  }
}

function requireValidActivityAdvance(
  current: ChatPaneProjection,
  next: ChatPaneStateProjection,
): void {
  const difference = next.activity.ordinal - current.activity.ordinal;
  if (difference < 0 || difference > 1) {
    throw new RangeError(
      `Chat pane ${current.id} activity ordinal must stay fixed or advance once`,
    );
  }
  if (
    difference === 0 &&
    (
      next.activity.kind !== current.activity.kind
    )
  ) {
    throw new RangeError(
      `Chat pane ${current.id} activity cannot change without advancing its ordinal`,
    );
  }
}

function updateChat(
  snapshot: RuntimeSnapshot,
  panes: ChatPaneProjection[],
): RuntimeSnapshot {
  return {
    ...snapshot,
    chat: {
      revision: incrementSafe(snapshot.chat.revision, "chat projection revision"),
      panes,
    },
  };
}

function replaceAt<Value>(values: Value[], index: number, value: Value): Value[] {
  const updated = [...values];
  updated[index] = value;
  return updated;
}

/** Return the next representable Native delivery sequence. */
export function nextRuntimeProjectionSequence(snapshot: RuntimeSnapshot): number {
  return incrementSafe(snapshot.lastSequence, "runtime projection sequence");
}

/**
 * Apply one already-accepted contiguous envelope and advance both counters.
 * The continuity assertion prevents adapters from bypassing checked delivery.
 */
export function advanceRuntimeProjection(
  snapshot: RuntimeSnapshot,
  envelope: RuntimeEvent,
): RuntimeSnapshot {
  const expectedSequence = nextRuntimeProjectionSequence(snapshot);
  if (envelope.sequence !== expectedSequence) {
    throw new RangeError(
      `Runtime projection sequence must advance from ${snapshot.lastSequence} ` +
        `to ${expectedSequence}; received ${envelope.sequence}`,
    );
  }
  const revision = incrementSafe(snapshot.revision, "runtime projection revision");
  const reduced = reduceRuntimeProjectionEvent(snapshot, envelope.event);
  return {
    ...reduced,
    revision,
    lastSequence: envelope.sequence,
  };
}

function upsertById<Value extends { readonly id: string }>(
  values: Value[],
  value: Value,
  limit: number,
  label: string,
): Value[] {
  const replacement = structuredClone(value);
  const index = values.findIndex(({ id }) => id === value.id);
  if (index < 0) {
    if (values.length >= limit) throw new RangeError(`${label} capacity is full`);
    return [...values, replacement];
  }
  const updated = [...values];
  updated[index] = replacement;
  return updated;
}

function removeById<Value extends { readonly id: string }>(
  values: Value[],
  id: string,
): Value[] {
  const index = values.findIndex((value) => value.id === id);
  if (index < 0) return values;
  return [...values.slice(0, index), ...values.slice(index + 1)];
}

function incrementSafe(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exhausted`);
  }
  return value + 1;
}

function incrementSafeBy(value: number, increment: number, label: string): number {
  if (
    !Number.isSafeInteger(value) || value < 0 ||
    !Number.isSafeInteger(increment) || increment < 0 ||
    value > Number.MAX_SAFE_INTEGER - increment
  ) {
    throw new RangeError(`${label} exhausted`);
  }
  return value + increment;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime projection event: ${JSON.stringify(value)}`);
}
