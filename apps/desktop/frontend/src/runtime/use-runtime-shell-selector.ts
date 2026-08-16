import {
  useDebugValue,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type { RuntimeShell, RuntimeShellState } from "./shell";

export type RuntimeShellSelector<Selection> = (
  snapshot: RuntimeShellState,
) => Selection;

export type RuntimeShellSelectionEquality<Selection> = (
  left: Selection,
  right: Selection,
) => boolean;

type CommittedSelection<Selection> =
  | Readonly<{ hasValue: false }>
  | Readonly<{ hasValue: true; value: Selection }>;

interface CommittedSelectionBox<Selection> {
  current: CommittedSelection<Selection>;
}

const fallbackSnapshot = Object.freeze({
  state: "connecting",
} as const satisfies RuntimeShellState);
const noOp = () => undefined;
const subscribeFallback = () => noOp;

function objectIs<Selection>(left: Selection, right: Selection): boolean {
  return Object.is(left, right);
}

export function getRuntimeShellFallbackSnapshot(): RuntimeShellState {
  return fallbackSnapshot;
}

/**
 * Cache selected values across root revisions. A changed root can retain the
 * exact previous selection when the supplied equality relation says its view
 * did not change.
 */
export function createSelectorSnapshotReader<Snapshot, Selection>(
  getSnapshot: () => Snapshot,
  selector: (snapshot: Snapshot) => Selection,
  isEqual: RuntimeShellSelectionEquality<Selection>,
  getCommittedSelection: (() => CommittedSelection<Selection>) | null = null,
): () => Selection {
  let initialized = false;
  let previousSnapshot: Snapshot;
  let previousSelection: Selection;

  return () => {
    const snapshot = getSnapshot();
    if (initialized && Object.is(snapshot, previousSnapshot)) {
      return previousSelection;
    }

    const selection = selector(snapshot);
    if (!initialized) {
      initialized = true;
      previousSnapshot = snapshot;
      const committed = getCommittedSelection?.();
      if (
        committed?.hasValue === true &&
        isEqual(committed.value, selection)
      ) {
        previousSelection = committed.value;
        return previousSelection;
      }
      previousSelection = selection;
      return selection;
    }

    previousSnapshot = snapshot;
    if (isEqual(previousSelection, selection)) return previousSelection;
    previousSelection = selection;
    return selection;
  };
}

/** Read one equality-checked view from a RuntimeShell external store. */
export function useRuntimeShellSelector<Selection>(
  shell: RuntimeShell | null,
  selector: RuntimeShellSelector<Selection>,
  isEqual: RuntimeShellSelectionEquality<Selection> = objectIs,
): Selection {
  const [committed] = useState<CommittedSelectionBox<Selection>>(() => ({
    current: { hasValue: false },
  }));
  const getSnapshot = shell?.getSnapshot ?? getRuntimeShellFallbackSnapshot;
  const subscribe = shell?.subscribe ?? subscribeFallback;
  const [getSelection, getServerSelection] = useMemo(() => [
    createSelectorSnapshotReader(
      getSnapshot,
      selector,
      isEqual,
      () => committed.current,
    ),
    createSelectorSnapshotReader(
      getRuntimeShellFallbackSnapshot,
      selector,
      isEqual,
      () => committed.current,
    ),
  ] as const, [committed, getSnapshot, isEqual, selector]);
  const selection = useSyncExternalStore(
    subscribe,
    getSelection,
    getServerSelection,
  );

  useEffect(() => {
    committed.current = { hasValue: true, value: selection };
  }, [committed, selection]);
  useDebugValue(selection);
  return selection;
}
