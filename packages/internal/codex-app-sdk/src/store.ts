export type StoreListener = () => void;
export type Unsubscribe = () => void;

export interface ExternalStore<Snapshot> {
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: StoreListener) => Unsubscribe;
}

export type StoreReducer<Snapshot, Action> = (
  snapshot: Snapshot,
  action: Action,
) => Snapshot;

export interface ListenerFailure {
  readonly error: unknown;
}

export interface ReducerStoreOptions<Snapshot> {
  readonly isEqual?: (left: Snapshot, right: Snapshot) => boolean;
  readonly onListenerFailure?: (failure: ListenerFailure) => void;
}

export interface StoreCommit<Snapshot> {
  readonly changed: boolean;
  readonly snapshot: Snapshot;
  readonly listenerFailureCount: number;
}

export interface ReducerStore<Snapshot, Action>
  extends ExternalStore<Snapshot> {
  readonly dispatch: (action: Action) => StoreCommit<Snapshot>;
}

function objectIs<Value>(left: Value, right: Value): boolean {
  return Object.is(left, right);
}

/**
 * Creates a synchronous immutable-root store compatible with React's
 * useSyncExternalStore contract.
 *
 * The reducer owns value construction. Returning the current root is a no-op.
 * A changed root is committed before a stable listener copy is notified.
 */
export function createReducerStore<Snapshot, Action>(
  initialSnapshot: Snapshot,
  reducer: StoreReducer<Snapshot, Action>,
  options: ReducerStoreOptions<Snapshot> = {},
): ReducerStore<Snapshot, Action> {
  let snapshot = initialSnapshot;
  const subscriptions = new Set<Readonly<{ listener: StoreListener }>>();
  const isEqual = options.isEqual ?? objectIs;

  const getSnapshot = (): Snapshot => snapshot;

  const subscribe = (listener: StoreListener): Unsubscribe => {
    const subscription = Object.freeze({ listener });
    subscriptions.add(subscription);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      subscriptions.delete(subscription);
    };
  };

  const reportListenerFailure = (error: unknown): void => {
    try {
      options.onListenerFailure?.(Object.freeze({ error }));
    } catch {
      // Error reporting is isolated for the same reason as listeners.
    }
  };

  const dispatch = (action: Action): StoreCommit<Snapshot> => {
    const nextSnapshot = reducer(snapshot, action);
    if (isEqual(snapshot, nextSnapshot)) {
      return Object.freeze({
        changed: false,
        snapshot,
        listenerFailureCount: 0,
      });
    }

    snapshot = nextSnapshot;
    let listenerFailureCount = 0;
    const committedSubscriptions = [...subscriptions];
    for (const subscription of committedSubscriptions) {
      try {
        subscription.listener();
      } catch (error) {
        listenerFailureCount += 1;
        reportListenerFailure(error);
      }
    }

    return Object.freeze({
      changed: true,
      snapshot,
      listenerFailureCount,
    });
  };

  return Object.freeze({ dispatch, getSnapshot, subscribe });
}
