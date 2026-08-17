import {
  createExternalStoreSelectorReader,
  useExternalStoreSelector,
  type SelectionEquality,
} from "@hra-internal/codex-app-sdk/react";
import { useMemo } from "react";

import type { HraStore, TaskWorkspaceSnapshot } from "./task-workspace-model";

export type TaskWorkspaceSelector<Selection> = (
  snapshot: TaskWorkspaceSnapshot,
) => Selection;

export type TaskWorkspaceSelectionEquality<Selection> =
  SelectionEquality<Selection>;

export type UseTaskWorkspaceSelectorOptions<Selection> = Readonly<{
  fallbackSnapshot: TaskWorkspaceSnapshot;
  isEqual?: TaskWorkspaceSelectionEquality<Selection>;
  serverSnapshot?: TaskWorkspaceSnapshot;
}>;

const noOp = () => undefined;
const subscribeFallback = () => noOp;

/**
 * Compatibility name for the SDK selector reader used by existing task
 * fixtures and downstream selector laws.
 */
export const createTaskWorkspaceSelectorReader =
  createExternalStoreSelectorReader;

/** Reads one equality-checked projection from a task client external store. */
export function useTaskWorkspaceSelector<Selection>(
  store: HraStore<TaskWorkspaceSnapshot> | null,
  selector: TaskWorkspaceSelector<Selection>,
  options: UseTaskWorkspaceSelectorOptions<Selection>,
): Selection {
  const fallbackSnapshot = options.fallbackSnapshot;
  const serverSnapshot = options.serverSnapshot ?? fallbackSnapshot;
  const fallbackStore = useMemo(
    () => Object.freeze({
      getSnapshot: () => fallbackSnapshot,
      subscribe: subscribeFallback,
    }),
    [fallbackSnapshot],
  );
  const getServerSnapshot = useMemo(
    () => () => serverSnapshot,
    [serverSnapshot],
  );

  return useExternalStoreSelector(
    store ?? fallbackStore,
    selector,
    {
      getServerSnapshot,
      ...(options.isEqual === undefined ? {} : { isEqual: options.isEqual }),
    },
  );
}
