import {
  chatPaneProjectionSchema,
  chatPaneStateProjectionSchema,
  runtimeEventSchema,
  runtimeEventUtf8ByteLimit,
  runtimeProtocolVersion,
  type ChatPaneProjection,
  type ChatPaneStateProjection,
  type RuntimeEvent,
} from "./runtime";

export type RuntimeEventDeliveryClass =
  | "state-recoverable"
  | "transient-exact";

/**
 * The delivery contract for every renderer event kind.
 *
 * State-recoverable events are represented by a later atomic runtime snapshot.
 * Transient-exact events are outside that snapshot and must survive every queue
 * barrier until the renderer accepts them.
 */
export const runtimeEventDeliveryClassByType = {
  "runtime.changed": "state-recoverable",
  "runner.changed": "state-recoverable",
  "execution.changed": "state-recoverable",
  "account.upserted": "state-recoverable",
  "account.removed": "state-recoverable",
  "chat.pane.upserted": "state-recoverable",
  "chat.pane.stateChanged": "state-recoverable",
  "chat.pane.removed": "state-recoverable",
  "chat.panes.reordered": "state-recoverable",
  "chat.turn.delta": "state-recoverable",
  "chat.messageQueue.changed": "state-recoverable",
  "accountLocalData.upserted": "state-recoverable",
  "accountLocalData.removed": "state-recoverable",
  "humanAccount.changed": "state-recoverable",
  "sessionSync.statusChanged": "state-recoverable",
  "sessionSync.localGrid.changed": "state-recoverable",
  "sessionSync.remote.upserted": "state-recoverable",
  "sessionSync.remote.removed": "state-recoverable",
  "sessionSync.remote.cleared": "state-recoverable",
  "snapshot.invalidated": "state-recoverable",
  "operation.completed": "transient-exact",
  "task.invalidated": "transient-exact",
} as const satisfies Readonly<
  Record<RuntimeEvent["event"]["type"], RuntimeEventDeliveryClass>
>;

/**
 * Encode mutable pane lifecycle and tool state without repeating response or
 * reasoning tails. The strict event parser is the final transport-size proof.
 */
export function runtimeChatPaneStateChangedEvent(
  sequence: number,
  input: ChatPaneProjection,
): RuntimeEvent["event"] {
  const state = runtimeChatPaneStateProjection(input);
  const candidate = {
    version: runtimeProtocolVersion,
    sequence,
    event: {
      type: "chat.pane.stateChanged" as const,
      revision: state.revision,
      pane: state,
    },
  };
  if (
    new TextEncoder().encode(JSON.stringify(candidate)).byteLength <=
      runtimeEventUtf8ByteLimit
  ) {
    return runtimeEventSchema.parse(candidate).event;
  }
  return runtimeEventSchema.parse({
    version: runtimeProtocolVersion,
    sequence,
    event: {
      type: "snapshot.invalidated",
      reason: "projectionOverflow",
    },
  }).event;
}

/** Build the authoritative compact pane state even when Native delivery must
 * fall back to a snapshot invalidation. */
export function runtimeChatPaneStateProjection(
  input: ChatPaneProjection,
): ChatPaneStateProjection {
  const pane = chatPaneProjectionSchema.parse(input);
  return chatPaneStateProjectionSchema.parse({
    id: pane.id,
    paletteIndex: pane.paletteIndex,
    revision: pane.revision,
    title: pane.title,
    accountProfileId: pane.accountProfileId,
    interactionMode: pane.interactionMode,
    state: pane.state,
    activity: pane.activity,
    workspace: pane.workspace,
    turn: pane.turn === null
      ? null
      : {
        id: pane.turn.id,
        status: pane.turn.status,
        startedAt: pane.turn.startedAt,
        completedAt: pane.turn.completedAt,
        continuationCount: pane.turn.continuationCount,
        tools: pane.turn.tools,
        providerSubagents: pane.turn.providerSubagents,
        routing: pane.turn.routing,
    },
    attention: pane.attention,
    recoverablePrompt: pane.recoverablePrompt,
    canStartFreshContext: pane.canStartFreshContext,
    schedule: pane.schedule,
  });
}

export function runtimeEventDeliveryClass(
  event: RuntimeEvent["event"],
): RuntimeEventDeliveryClass {
  return runtimeEventDeliveryClassByType[event.type];
}

/**
 * Choose the bounded Native delivery for an already-installed authoritative
 * pane projection. Large latest-turn tails belong in the next atomic snapshot,
 * so they invalidate instead of crossing the 7,168-byte window-event boundary.
 */
export function runtimeChatPaneUpsertEventOrInvalidation(
  sequence: number,
  input: ChatPaneProjection,
): RuntimeEvent["event"] {
  const pane = chatPaneProjectionSchema.parse(input);
  const upsert = {
    version: runtimeProtocolVersion,
    sequence,
    event: {
      type: "chat.pane.upserted" as const,
      revision: pane.revision,
      pane,
    },
  };
  if (new TextEncoder().encode(JSON.stringify(upsert)).byteLength <= runtimeEventUtf8ByteLimit) {
    return runtimeEventSchema.parse(upsert).event;
  }
  return runtimeEventSchema.parse({
    version: runtimeProtocolVersion,
    sequence,
    event: {
      type: "snapshot.invalidated",
      reason: "projectionOverflow",
    },
  }).event;
}
