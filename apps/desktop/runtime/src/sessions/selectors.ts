import type {
  SessionInteractionState,
  SessionItemState,
  SessionState,
  SessionTextBuffer,
  SessionThreadState,
  SessionTurnState,
} from "./model";
import { sessionEntityKey } from "./model";

export interface SessionItemView {
  readonly id: string;
  readonly kind: SessionItemState["display"]["kind"];
  readonly overflowed: boolean;
  readonly status: SessionItemState["status"];
  readonly text: string | null;
  readonly toolActivity: string | null;
}

export interface SessionTurnView {
  readonly activity: SessionTurnState["activity"];
  readonly completedAt: string | null;
  readonly id: string;
  readonly items: readonly SessionItemView[];
  readonly startedAt: string | null;
  readonly status: SessionTurnState["status"];
}

export interface SessionThreadView {
  readonly accountProfileId: string;
  readonly archived: boolean;
  readonly id: string;
  readonly status: SessionThreadState["status"];
  readonly title: string | null;
  readonly turns: readonly SessionTurnView[];
  readonly updatedAt: string;
}

export interface SessionThreadSummaryView {
  readonly accountProfileId: string;
  readonly archived: boolean;
  readonly id: string;
  readonly status: SessionThreadState["status"];
  readonly title: string | null;
  readonly updatedAt: string;
}

export interface SessionSelectors {
  readonly selectItem: (
    state: SessionState,
    accountProfileId: string,
    itemId: string,
  ) => SessionItemView | null;
  readonly selectPendingInteractions: (
    state: SessionState,
    accountProfileId: string,
  ) => readonly SessionInteractionState[];
  readonly selectThread: (
    state: SessionState,
    accountProfileId: string,
    threadId: string,
  ) => SessionThreadView | null;
  readonly selectThreadState: (
    state: SessionState,
    accountProfileId: string,
    threadId: string,
  ) => SessionThreadState | null;
  readonly selectThreadSummaries: (
    state: SessionState,
    accountProfileId: string,
  ) => readonly SessionThreadSummaryView[];
}

interface TurnCacheEntry {
  readonly itemStates: readonly (SessionItemState | undefined)[];
  readonly view: SessionTurnView;
}

interface ThreadCacheEntry {
  readonly turnViews: readonly SessionTurnView[];
  readonly view: SessionThreadView;
}

export function createSessionSelectors(): SessionSelectors {
  const textCache = new WeakMap<SessionTextBuffer, string | null>();
  const itemCache = new WeakMap<SessionItemState, SessionItemView>();
  const turnCache = new WeakMap<SessionTurnState, TurnCacheEntry>();
  const threadCache = new WeakMap<SessionThreadState, ThreadCacheEntry>();
  const summaryCache = new WeakMap<
    SessionState["threads"],
    Map<string, readonly SessionThreadSummaryView[]>
  >();
  const interactionCache = new WeakMap<
    SessionState["interactions"],
    Map<string, readonly SessionInteractionState[]>
  >();

  const materializeText = (buffer: SessionTextBuffer): string | null => {
    if (textCache.has(buffer)) return textCache.get(buffer) ?? null;
    const value = buffer.chunks.join("");
    textCache.set(buffer, value);
    return value;
  };

  const itemView = (item: SessionItemState): SessionItemView => {
    const cached = itemCache.get(item);
    if (cached !== undefined) return cached;
    const view: SessionItemView = Object.freeze({
      id: item.id,
      kind: item.display.kind,
      overflowed: item.text?.overflowed ?? false,
      status: item.status,
      text: item.text === null ? null : materializeText(item.text),
      toolActivity: item.display.kind === "tool" ? item.display.activity : null,
    });
    itemCache.set(item, view);
    return view;
  };

  const turnView = (state: SessionState, turnKey: string): SessionTurnView | null => {
    const turn = state.turns[turnKey];
    if (turn === undefined) return null;
    const itemStates = turn.itemKeys.map((key) => state.items.get(key));
    const cached = turnCache.get(turn);
    if (
      cached !== undefined && sameReferences(cached.itemStates, itemStates)
    ) return cached.view;
    const view: SessionTurnView = Object.freeze({
      activity: turn.activity,
      completedAt: turn.completedAt,
      id: turn.id,
      items: Object.freeze(itemStates.flatMap((item) =>
        item === undefined ? [] : [itemView(item)]
      )),
      startedAt: turn.startedAt,
      status: turn.status,
    });
    turnCache.set(turn, { itemStates, view });
    return view;
  };

  const selectThread = (
    state: SessionState,
    accountProfileId: string,
    threadId: string,
  ): SessionThreadView | null => {
    const key = sessionEntityKey(accountProfileId, threadId);
    const thread = state.threads[key];
    if (thread === undefined) return null;
    const turnViews = thread.turnKeys.flatMap((turnKey) => {
      const view = turnView(state, turnKey);
      return view === null ? [] : [view];
    });
    const cached = threadCache.get(thread);
    if (
      cached !== undefined && sameReferences(cached.turnViews, turnViews)
    ) return cached.view;
    const view: SessionThreadView = Object.freeze({
      accountProfileId,
      archived: thread.archived,
      id: thread.id,
      status: thread.status,
      title: thread.title,
      turns: Object.freeze(turnViews),
      updatedAt: thread.updatedAt,
    });
    threadCache.set(thread, { turnViews, view });
    return view;
  };

  return {
    selectItem(state, accountProfileId, itemId) {
      const item = state.items.get(sessionEntityKey(accountProfileId, itemId));
      return item === undefined ? null : itemView(item);
    },
    selectPendingInteractions(state, accountProfileId) {
      const byAccount = interactionCache.get(state.interactions);
      const cached = byAccount?.get(accountProfileId);
      if (cached !== undefined) return cached;
      const value = Object.freeze(Object.values(state.interactions)
        .filter((interaction) =>
          interaction.accountProfileId === accountProfileId &&
          interaction.outcome === "pending"
        )
        .toSorted((left, right) =>
          left.expiresAt - right.expiresAt || left.id.localeCompare(right.id)
        ));
      if (byAccount === undefined) {
        interactionCache.set(state.interactions, new Map([[accountProfileId, value]]));
      } else {
        byAccount.set(accountProfileId, value);
      }
      return value;
    },
    selectThread,
    selectThreadState(state, accountProfileId, threadId) {
      return state.threads[sessionEntityKey(accountProfileId, threadId)] ?? null;
    },
    selectThreadSummaries(state, accountProfileId) {
      const byAccount = summaryCache.get(state.threads);
      const cached = byAccount?.get(accountProfileId);
      if (cached !== undefined) return cached;
      const value: readonly SessionThreadSummaryView[] = Object.freeze(
        Object.values(state.threads)
          .filter((thread) => thread.accountProfileId === accountProfileId)
          .toSorted((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
          )
          .map((thread) => Object.freeze({
            accountProfileId,
            archived: thread.archived,
            id: thread.id,
            status: thread.status,
            title: thread.title,
            updatedAt: thread.updatedAt,
          })),
      );
      if (byAccount === undefined) {
        summaryCache.set(state.threads, new Map([[accountProfileId, value]]));
      } else {
        byAccount.set(accountProfileId, value);
      }
      return value;
    },
  };
}

function sameReferences<Value>(
  left: readonly Value[],
  right: readonly Value[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
