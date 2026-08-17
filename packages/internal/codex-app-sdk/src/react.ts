import {
  useDebugValue,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type { ExternalStore } from "./store.js";

export type SelectionEquality<Selection> = (
  left: Selection,
  right: Selection,
) => boolean;

export interface UseExternalStoreSelectorOptions<Snapshot, Selection> {
  readonly isEqual?: SelectionEquality<Selection>;
  readonly getServerSnapshot?: () => Snapshot;
}

type CommittedSelection<Selection> =
  | Readonly<{ hasValue: false }>
  | Readonly<{ hasValue: true; value: Selection }>;

interface CommittedSelectionBox<Selection> {
  current: CommittedSelection<Selection>;
}

function objectIs<Selection>(
  left: Selection,
  right: Selection,
): boolean {
  return Object.is(left, right);
}

/**
 * Caches one projection across root revisions and selector replacement.
 * Equal values retain the exact identity that React already committed.
 */
export function createExternalStoreSelectorReader<Snapshot, Selection>(
  getSnapshot: () => Snapshot,
  selector: (snapshot: Snapshot) => Selection,
  isEqual: SelectionEquality<Selection> = objectIs,
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

export function useExternalStoreSelector<Snapshot, Selection>(
  store: ExternalStore<Snapshot>,
  selector: (snapshot: Snapshot) => Selection,
  options: UseExternalStoreSelectorOptions<Snapshot, Selection> = {},
): Selection {
  const [committed] = useState<CommittedSelectionBox<Selection>>(() => ({
    current: { hasValue: false },
  }));
  const isEqual = options.isEqual ?? objectIs;
  const getServerSnapshot = options.getServerSnapshot ?? store.getSnapshot;
  const [getSelection, getServerSelection] = useMemo(
    () => [
      createExternalStoreSelectorReader(
        store.getSnapshot,
        selector,
        isEqual,
        () => committed.current,
      ),
      createExternalStoreSelectorReader(
        getServerSnapshot,
        selector,
        isEqual,
        () => committed.current,
      ),
    ] as const,
    [committed, getServerSnapshot, isEqual, selector, store.getSnapshot],
  );
  const selection = useSyncExternalStore(
    store.subscribe,
    getSelection,
    getServerSelection,
  );

  useEffect(() => {
    committed.current = { hasValue: true, value: selection };
  }, [committed, selection]);
  useDebugValue(selection);
  return selection;
}
