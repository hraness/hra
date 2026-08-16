import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import { IconButton } from "../../ui";

import type { ChatPaneProjection } from "../../../../contracts/runtime";
import type { RuntimeShell, RuntimeShellState } from "../../runtime";
import { useRuntimeShellSelector } from "../../runtime";
import { RuntimeRetryButton } from "../RuntimeRetryButton";
import { ChatPane } from "./ChatPane";
import { RemoteSessionPane } from "./RemoteSessionPane";
import {
  paneIdsEqual,
  paneIsActive,
  paneStatusLabel,
  paneWorkspaceStatus,
  localPaneGridSlotsEqual,
  remoteSessionGridSlotsEqual,
  remoteSessionRowEqual,
  reorderPanesCommand,
  runtimeAvailabilityEqual,
  selectPaneIds,
  selectPane,
  selectLocalPaneGridSlots,
  resolveLocalPaneGridSlots,
  selectRemoteSessionGridSlots,
  selectRemoteSessionRow,
  selectRuntimeAvailability,
  type LocalPaneGridSlot,
  type RemoteSessionId,
  type RemoteSessionGridSlot,
} from "./model";

export const remoteSessionMountLimit = 48;
const paneAnnouncementDelayMs = 250;

export interface PaneAnnouncementBaseline {
  readonly activityOrdinal: number | null;
  readonly attentionMessage: string | null;
  readonly availability: string;
  readonly paneId: string | null;
  readonly paneState: ChatPaneProjection["state"] | null;
  readonly paneTitle: string | null;
  readonly workspaceMessage: string | null;
}

export function nextPaneAnnouncement(
  previous: PaneAnnouncementBaseline | null,
  current: PaneAnnouncementBaseline,
): string | null {
  if (previous === null || previous.paneId !== current.paneId) return null;
  if (current.availability !== previous.availability && current.availability !== "ready") {
    return current.availability === "connecting"
      ? "Connecting to the local runtime."
      : current.availability;
  }
  if (current.paneId === null || current.paneTitle === null || current.paneState === null) {
    return null;
  }
  if (
    current.attentionMessage !== previous.attentionMessage
    && current.attentionMessage !== null
  ) return `${current.paneTitle}: ${current.attentionMessage}`;
  if (
    current.workspaceMessage !== previous.workspaceMessage
    && current.workspaceMessage !== null
  ) return `${current.paneTitle}: ${current.workspaceMessage}`;
  if (
    previous.paneState !== null
    && paneIsActive(previous.paneState)
    && current.paneState === "ready"
  ) return `${current.paneTitle} finished.`;
  if (current.paneState !== previous.paneState && current.paneState !== "ready") {
    return `${current.paneTitle}: ${paneStatusLabel(current.paneState)}.`;
  }
  if (
    current.activityOrdinal !== previous.activityOrdinal
    && current.activityOrdinal !== null
    && current.activityOrdinal > 0
  ) return `${current.paneTitle} updated.`;
  return null;
}

function PaneAnnouncements({
  activePaneId,
  availability,
  shell,
}: Readonly<{
  activePaneId: string | null;
  availability: ReturnType<typeof selectRuntimeAvailability>;
  shell: RuntimeShell;
}>) {
  const paneSelector = useCallback(
    (state: RuntimeShellState) => activePaneId === null ? null : selectPane(state, activePaneId),
    [activePaneId],
  );
  const pane = useRuntimeShellSelector(shell, paneSelector);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const baselineRef = useRef<PaneAnnouncementBaseline | null>(null);
  const availabilityLabel = availability.kind === "unavailable"
    ? availability.message
    : availability.kind;
  const activityOrdinal = pane?.activity.ordinal ?? null;
  const attentionMessage = pane?.attention?.message ?? null;
  const paneId = pane?.id ?? activePaneId;
  const paneState = pane?.state ?? null;
  const paneTitle = pane?.title ?? null;
  const workspaceMessage = pane === null ? null : paneWorkspaceStatus(pane)?.message ?? null;

  useEffect(() => {
    const current: PaneAnnouncementBaseline = {
      activityOrdinal,
      attentionMessage,
      availability: availabilityLabel,
      paneId,
      paneState,
      paneTitle,
      workspaceMessage,
    };
    const previous = baselineRef.current;
    baselineRef.current = current;
    const next = nextPaneAnnouncement(previous, current);
    setAnnouncement(null);
    if (next === null) return;
    const timer = setTimeout(() => setAnnouncement(next), paneAnnouncementDelayMs);
    return () => clearTimeout(timer);
  }, [
    activityOrdinal,
    attentionMessage,
    availabilityLabel,
    paneId,
    paneState,
    paneTitle,
    workspaceMessage,
  ]);

  return (
    <div aria-atomic="true" aria-live="polite" className="hra-visually-hidden" role="status">
      {announcement}
    </div>
  );
}

export function boundedRemoteSessionWindow(
  sessionIds: readonly RemoteSessionId[],
  requestedStart: number,
): Readonly<{ ids: readonly RemoteSessionId[]; start: number }> {
  const lastStart = Math.max(
    0,
    Math.floor(Math.max(0, sessionIds.length - 1) / remoteSessionMountLimit)
      * remoteSessionMountLimit,
  );
  const start = Math.min(
    lastStart,
    Math.max(0, Math.floor(requestedStart / remoteSessionMountLimit) * remoteSessionMountLimit),
  );
  return {
    ids: sessionIds.slice(start, start + remoteSessionMountLimit),
    start,
  };
}

export type UnifiedPaneGridItem =
  | Readonly<{ kind: "local"; paneId: string; gridPosition: number }>
  | Readonly<{
      kind: "remote";
      sessionId: RemoteSessionId;
      gridPosition: number;
    }>;

export function unifiedPaneGridItems(
  paneIds: readonly string[],
  persistedLocalSlots: readonly LocalPaneGridSlot[],
  remoteSlots: readonly RemoteSessionGridSlot[],
  mountedRemoteIds: readonly RemoteSessionId[],
): readonly UnifiedPaneGridItem[] {
  const mounted = new Set<RemoteSessionId>(mountedRemoteIds);
  const localSlots = resolveLocalPaneGridSlots(
    paneIds,
    persistedLocalSlots,
    remoteSlots,
  );
  return [
    ...localSlots.map(({ paneId, gridPosition }) => ({
      kind: "local" as const,
      paneId,
      gridPosition,
    })),
    ...remoteSlots
      .filter(({ sessionId }) => mounted.has(sessionId))
      .map(({ sessionId, gridPosition }) => ({
        kind: "remote" as const,
        sessionId,
        gridPosition,
      })),
  ].sort((left, right) => (
    left.gridPosition - right.gridPosition
    || (left.kind === right.kind ? 0 : left.kind === "local" ? -1 : 1)
    || (left.kind === "local" && right.kind === "local"
      ? left.paneId.localeCompare(right.paneId)
      : left.kind === "remote" && right.kind === "remote"
        ? left.sessionId.localeCompare(right.sessionId)
        : 0)
  ));
}

export interface PaneGridProps {
  readonly shell: RuntimeShell;
}

export function movePaneInOrder(
  orderedPaneIds: readonly string[],
  paneId: string,
  targetIndex: number,
): readonly string[] {
  const sourceIndex = orderedPaneIds.indexOf(paneId);
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= orderedPaneIds.length) {
    return orderedPaneIds;
  }
  const next = [...orderedPaneIds];
  next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, paneId);
  return next;
}

const RemoteSessionRow = memo(function RemoteSessionRow({
  sessionId,
  shell,
}: {
  readonly sessionId: RemoteSessionId;
  readonly shell: RuntimeShell;
}) {
  const selector = useCallback(
    (state: RuntimeShellState) => selectRemoteSessionRow(state, sessionId),
    [sessionId],
  );
  const row = useRuntimeShellSelector(shell, selector, remoteSessionRowEqual);
  return row === null ? null : (
    <RemoteSessionPane
      collisionLine={row.collisionLine}
      session={row.session}
    />
  );
});

function RemoteSessionPagination({
  onStartChange,
  sessionCount,
  window,
}: Readonly<{
  onStartChange: (start: number) => void;
  sessionCount: number;
  window: ReturnType<typeof boundedRemoteSessionWindow>;
}>) {
  if (sessionCount <= remoteSessionMountLimit) return null;
  const end = window.start + window.ids.length;
  return (
    <nav aria-label="Remote summary pages" className="remote-session-window__pagination">
      <IconButton
        aria-label="Previous remote summaries"
        isDisabled={window.start === 0}
        onPress={() => onStartChange(window.start - remoteSessionMountLimit)}
        size="compact"
        tooltip="Previous remote summaries"
        type="button"
        variant="quiet"
      >
        <span aria-hidden="true">←</span>
      </IconButton>
      <span>{window.start + 1}–{end} of {sessionCount}</span>
      <IconButton
        aria-label="Next remote summaries"
        isDisabled={end >= sessionCount}
        onPress={() => onStartChange(window.start + remoteSessionMountLimit)}
        size="compact"
        tooltip="Next remote summaries"
        type="button"
        variant="quiet"
      >
        <span aria-hidden="true">→</span>
      </IconButton>
    </nav>
  );
}

export function PaneGrid({ shell }: PaneGridProps) {
  const [activeAnnouncementPaneId, setActiveAnnouncementPaneId] = useState<string | null>(null);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [reorderPending, setReorderPending] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState<string | null>(null);
  const [requestedRemoteStart, setRequestedRemoteStart] = useState(0);
  const paneIds = useRuntimeShellSelector(shell, selectPaneIds, paneIdsEqual);
  const localSlots = useRuntimeShellSelector(
    shell,
    selectLocalPaneGridSlots,
    localPaneGridSlotsEqual,
  );
  const remoteSlots = useRuntimeShellSelector(
    shell,
    selectRemoteSessionGridSlots,
    remoteSessionGridSlotsEqual,
  );
  const remoteSessionIds = remoteSlots.map(({ sessionId }) => sessionId);
  const remoteWindow = boundedRemoteSessionWindow(
    remoteSessionIds,
    requestedRemoteStart,
  );
  const gridItems = unifiedPaneGridItems(
    paneIds,
    localSlots,
    remoteSlots,
    remoteWindow.ids,
  );
  const orderedLocalPaneIds = gridItems.flatMap((item) => (
    item.kind === "local" ? [item.paneId] : []
  ));
  const availability = useRuntimeShellSelector(
    shell,
    selectRuntimeAvailability,
    runtimeAvailabilityEqual,
  );
  useEffect(() => {
    if (requestedRemoteStart !== remoteWindow.start) {
      setRequestedRemoteStart(remoteWindow.start);
    }
  }, [remoteWindow.start, requestedRemoteStart]);

  const dispatchOrder = useCallback(async (orderedPaneIds: readonly string[]) => {
    if (reorderPending || paneIdsEqual(orderedPaneIds, orderedLocalPaneIds)) return;
    setReorderPending(true);
    setReorderError(null);
    setReorderAnnouncement(null);
    try {
      const response = await shell.dispatch(reorderPanesCommand({
        expectedOrderedPaneIds: orderedLocalPaneIds,
        orderedPaneIds,
      }));
      if (!response.ok) {
        setReorderError(response.error.message);
        return;
      }
      setReorderAnnouncement("Pane order updated.");
    } catch (reason: unknown) {
      setReorderError(
        reason instanceof Error ? reason.message : "The pane order could not be updated.",
      );
    } finally {
      setReorderPending(false);
    }
  }, [orderedLocalPaneIds, reorderPending, shell]);

  const movePane = useCallback((paneId: string, targetIndex: number) => {
    void dispatchOrder(movePaneInOrder(orderedLocalPaneIds, paneId, targetIndex));
  }, [dispatchOrder, orderedLocalPaneIds]);

  const startPaneDrag = useCallback((
    paneId: string,
    event: ReactDragEvent<HTMLElement>,
  ) => {
    if (reorderPending) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", paneId);
    setDraggedPaneId(paneId);
    setReorderError(null);
  }, [reorderPending]);

  const dropPane = useCallback((
    targetPaneId: string,
    event: ReactDragEvent<HTMLElement>,
  ) => {
    const sourcePaneId = draggedPaneId || event.dataTransfer.getData("text/plain");
    setDraggedPaneId(null);
    if (sourcePaneId.length === 0 || sourcePaneId === targetPaneId) return;
    event.preventDefault();
    const targetIndex = orderedLocalPaneIds.indexOf(targetPaneId);
    if (targetIndex >= 0) movePane(sourcePaneId, targetIndex);
  }, [draggedPaneId, movePane, orderedLocalPaneIds]);

  if (paneIds.length === 0 && remoteSessionIds.length === 0) {
    return (
      <div
        className="panes-empty"
      >
        <p role="status">
          {availability.kind === "connecting"
            ? "Connecting to Codex…"
            : availability.kind === "unavailable"
              ? availability.message
              : "Create a pane to start."}
          {availability.kind === "unavailable" && availability.reconnectable
            ? <RuntimeRetryButton shell={shell} />
            : null}
        </p>
      </div>
    );
  }

  return (
    <>
      {availability.kind === "unavailable" ? (
        <div className="runtime-notice">
          <span>{availability.message}</span>
          {availability.reconnectable ? <RuntimeRetryButton shell={shell} /> : null}
        </div>
      ) : null}
      {reorderError === null ? null : (
        <p className="pane-grid__reorder-error" role="alert">{reorderError}</p>
      )}
      <div
        aria-label="Local chat panes and encrypted remote session summaries"
        className="pane-grid"
        data-remote-mounted={remoteWindow.ids.length}
      >
        {gridItems.map((item) => item.kind === "local" ? (() => {
          const localIndex = orderedLocalPaneIds.indexOf(item.paneId);
          return (
            <ChatPane
              announcementActive={activeAnnouncementPaneId === item.paneId}
              canMoveEarlier={localIndex > 0}
              canMoveLater={localIndex >= 0 && localIndex < orderedLocalPaneIds.length - 1}
              draggable={!reorderPending}
              dragging={draggedPaneId === item.paneId}
              gridPosition={item.gridPosition}
              key={`local:${item.paneId}`}
              onActivateAnnouncement={() => setActiveAnnouncementPaneId(item.paneId)}
              onDragEnd={() => setDraggedPaneId(null)}
              onDragOver={(event) => {
                if (draggedPaneId !== null && draggedPaneId !== item.paneId) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDragStart={(event) => startPaneDrag(item.paneId, event)}
              onDrop={(event) => dropPane(item.paneId, event)}
              onMoveEarlier={() => movePane(item.paneId, localIndex - 1)}
              onMoveLater={() => movePane(item.paneId, localIndex + 1)}
              paneId={item.paneId}
              reorderPending={reorderPending}
              shell={shell}
            />
          );
        })() : (
          <RemoteSessionRow
            key={`remote:${item.sessionId}`}
            sessionId={item.sessionId}
            shell={shell}
          />
        ))}
      </div>
      <PaneAnnouncements
        activePaneId={activeAnnouncementPaneId}
        availability={availability}
        shell={shell}
      />
      <div aria-live="polite" className="hra-visually-hidden" role="status">
        {reorderAnnouncement}
      </div>
      <RemoteSessionPagination
        onStartChange={setRequestedRemoteStart}
        sessionCount={remoteSessionIds.length}
        window={remoteWindow}
      />
    </>
  );
}
