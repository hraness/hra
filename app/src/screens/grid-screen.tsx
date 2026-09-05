import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { ComposerAttachmentChips } from "../components/attachment-chips";
import { AttachIcon, SettingsIcon } from "../components/icons";
import { SessionCard } from "../components/session-card";
import { ChoiceGroup } from "../components/settings-list";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useCardOrder } from "../data/card-order";
import { useSubmitCommand } from "../data/commands";
import { useComposerAttachments } from "../data/composer-attachments";
import { holdSentAttachment } from "../data/sent-attachments";
import { useDeviceCommandState, useSubmitDeviceCommand } from "../data/device-commands";
import { useDeviceRegistries } from "../data/registry";
import { useSessionHeads } from "../data/session-heads";
import { useCustody } from "../custody/custody-context";
import { navigate } from "../routing/router";
import { sessionRoute, settingsRoute } from "../routing/route";
import {
  defaultSessionStartPreset,
  deviceCommandNotice,
  sessionStartCommand,
  sessionStartTargetHint,
  sessionStartTargetLabel,
  sessionStartTargets,
  type PresetChoice,
} from "../model/device-commands";
import {
  attachmentAcceptAttribute,
  attachmentSendSupported,
  buildSendPayload,
} from "../model/attachments";
import {
  orderSessionCards,
  resolveComposerTarget,
  type SessionCardSummary,
} from "../model/session-view";

function sameSummary(left: SessionCardSummary, right: SessionCardSummary): boolean {
  return left.archived === right.archived
    && left.attention === right.attention
    && left.lastActivityAt === right.lastActivityAt
    && left.metadataRevision === right.metadataRevision
    && left.state === right.state
    && left.title === right.title;
}

const presetOptions: readonly Readonly<{ label: string; value: PresetChoice }>[] = [
  { label: "Sol Low", value: "low" },
  { label: "Sol High", value: "high" },
  { label: "Sol Ultra", value: "ultra" },
];

/** The card under the pointer during a drag, resolved from the DOM. */
function cardUnderPointer(clientX: number, clientY: number): string | null {
  const element = document.elementFromPoint(clientX, clientY);
  const host = element?.closest("[data-session-id]") ?? null;
  return host?.getAttribute("data-session-id") ?? null;
}

/**
 * The grid.
 *
 * Cards report their folded state upward, the ladder in `orderSessionCards`
 * decides the order, and the cards themselves stay mounted across a reorder
 * because they are keyed by session id: a card that floats to the front keeps
 * its subscription and its scroll position rather than remounting.
 *
 * Ordering is manual once the reader drags a card. There is no grid layout
 * library: `react-grid-layout` positions with style attributes and
 * `style-src 'self'` refuses them, so the drag is Pointer Events over the
 * ordinary CSS grid — the same code path for mouse, pen, and touch — and the
 * arrangement is a sequence of session ids, not a set of coordinates. Every
 * visual state of the drag is a class.
 *
 * The composer has two modes. With a session selected it steers that session,
 * as it has since W2. With nothing selected it starts a real session on a
 * machine through the `session_start` device command, addressed by the account
 * and project public ids the device registry projects — never by a path.
 *
 * Attachments belong to the steer mode only, and the paste, the drop, and the
 * picker are wired up only there. A start is a device command carrying a prompt,
 * with no field for a file and no session yet to hold one, so a reader who
 * attaches something while starting is told to open the session and attach it
 * there rather than having it dropped in silence.
 */
export function GridScreen({
  onSelect,
  selectedSessionId,
}: Readonly<{
  onSelect: (sessionPublicId: string) => void;
  selectedSessionId: string | null;
}>): ReactNode {
  const custody = useCustody();
  const { heads, isLoading, loadMore, status } = useSessionHeads();
  const submit = useSubmitCommand();
  const submitDeviceCommand = useSubmitDeviceCommand();
  const registries = useDeviceRegistries();
  const cardOrder = useCardOrder();

  const [summaries, setSummaries] = useState<Readonly<Record<string, SessionCardSummary>>>({});
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [startCommandId, setStartCommandId] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [projectPublicId, setProjectPublicId] = useState<string | null>(null);
  const [preset, setPreset] = useState<PresetChoice>(defaultSessionStartPreset);
  const attach = useComposerAttachments();
  const pickerRef = useRef<HTMLInputElement>(null);

  const startCommand = useDeviceCommandState(startCommandId);
  const startNotice = deviceCommandNotice(startCommand);

  const reportSummary = useCallback((summary: SessionCardSummary) => {
    setSummaries((current) => {
      const previous = current[summary.publicId];
      if (previous !== undefined && sameSummary(previous, summary)) return current;
      return { ...current, [summary.publicId]: summary };
    });
  }, []);

  const headById = useMemo(
    () => new Map(heads.map((head) => [head.publicId, head])),
    [heads],
  );

  // Only sessions the current page actually carries take part in the ordering,
  // so a head that left the page cannot keep a stale card in the ladder.
  const known = useMemo(
    () => heads
      .map((head) => {
        const summary = summaries[head.publicId];
        return summary?.metadataRevision === head.metadataRevision ? summary : undefined;
      })
      .filter((summary): summary is SessionCardSummary => summary !== undefined),
    [heads, summaries],
  );

  const ordered = useMemo(
    () => orderSessionCards(known, cardOrder.order),
    [cardOrder.order, known],
  );
  const steerTarget = useMemo(
    () => selectedSessionId === null
      ? null
      : resolveComposerTarget(ordered, selectedSessionId),
    [ordered, selectedSessionId],
  );
  const starting = selectedSessionId === null;

  const targets = useMemo(() => sessionStartTargets(registries.machines), [registries.machines]);
  const startTarget = useMemo(
    () => targets.find((entry) =>
      `${entry.targetDevicePublicId}:${entry.accountPublicId}` === targetKey)
      ?? targets[0]
      ?? null,
    [targetKey, targets],
  );
  // The picker follows the registry: an account or project that disappears
  // between renders is replaced rather than left addressing something gone.
  const project = useMemo(
    () => startTarget?.projects.find((entry) => entry.publicId === projectPublicId)
      ?? startTarget?.projects[0]
      ?? null,
    [projectPublicId, startTarget],
  );

  // Once the started session shows up in the grid, the command notice has done
  // its job and the composer goes quiet again.
  useEffect(() => {
    if (startCommand?.state === "applied" && heads.length > 0) {
      const timer = setTimeout(() => { setStartCommandId(null); }, 15_000);
      return () => { clearTimeout(timer); };
    }
    return undefined;
  }, [heads.length, startCommand?.state]);

  const open = useCallback((sessionPublicId: string) => {
    onSelect(sessionPublicId);
    navigate(sessionRoute(sessionPublicId));
  }, [onSelect]);

  const canSubmit = message.trim().length > 0
    && !sending
    && !attach.busy
    && (starting
      ? startTarget !== null && project !== null
      : steerTarget !== null && headById.get(steerTarget.publicId) !== undefined);

  const send = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const text = message.trim();
    if (!canSubmit) return;
    // A new session is a device command carrying a prompt and nothing else, so
    // there is nowhere for an attachment to ride. Say so rather than dropping
    // it silently: the reader can open the session and attach there.
    if (starting && attach.attachments.length > 0) {
      setNotice("A new session starts with text only. Open it, then attach files there.");
      return;
    }
    if (attach.sendRefusal !== null) {
      setNotice(attach.sendRefusal);
      return;
    }
    if (attach.attachments.length > 0 && !attachmentSendSupported()) {
      setNotice("This build does not carry attachments to the machine yet.");
      return;
    }
    setSending(true);
    setNotice(null);
    const run = starting && startTarget !== null && project !== null
      ? submitDeviceCommand({
          payload: sessionStartCommand({
            accountPublicId: startTarget.accountPublicId,
            preset,
            projectPublicId: project.publicId,
            prompt: text,
            provider: startTarget.provider,
          }),
          targetDevicePublicId: startTarget.targetDevicePublicId,
        }).then((commandPublicId) => {
          setStartCommandId(commandPublicId);
          setMessage("");
        })
      : (() => {
          const head = steerTarget === null ? undefined : headById.get(steerTarget.publicId);
          if (head === undefined) return Promise.resolve();
          const attachments = attach.attachments;
          return submit({
            executionDevicePublicId: head.executionDevicePublicId,
            payload: buildSendPayload({ attachments, message: text }),
            sessionPublicId: head.publicId,
          }).then(() => {
            for (const item of attachments) {
              if (item.kind !== "image") continue;
              holdSentAttachment({
                bytes: item.bytes,
                digest: item.digest,
                mediaType: item.mediaType,
              });
            }
            setMessage("");
            attach.clear();
            setNotice(`Sent to ${steerTarget?.title ?? "the session"}.`);
          });
        })();
    void run
      .catch((failure: unknown) => {
        setNotice(failure instanceof Error ? failure.message : "The command was not accepted.");
      })
      .finally(() => { setSending(false); });
  };

  const rendered = useMemo(() => {
    const visible = ordered
      .map((summary) => headById.get(summary.publicId))
      .filter((head): head is NonNullable<typeof head> => head !== undefined);
    // A head whose card has not reported yet is still rendered, otherwise
    // nothing would ever mount to report.
    const reported = new Set(known.map((summary) => summary.publicId));
    return [...visible, ...heads.filter((head) => !reported.has(head.publicId))];
  }, [headById, heads, known, ordered]);

  // The sequence the reader is actually looking at. Every reorder is expressed
  // against it, so a drop lands where the card appeared to be dropped even
  // while the automatic ladder is still moving cards that were never arranged.
  const displayed = useMemo(() => rendered.map((head) => head.publicId), [rendered]);
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;

  const [drag, setDrag] = useState<Readonly<{ activeId: string; overId: string | null }> | null>(
    null,
  );
  const dragRef = useRef<
    Readonly<{ activeId: string; overId: string | null; pointerId: number }> | null
  >(null);
  const dragging = drag !== null;
  const { move: moveCard, nudge } = cardOrder;

  /** The keyboard path, from the card menu or the handle's arrow keys. */
  const moveInDisplayedOrder = useCallback((
    sessionPublicId: string,
    direction: "left" | "right",
  ) => {
    nudge(displayedRef.current, sessionPublicId, direction);
  }, [nudge]);

  const beginDrag = useCallback((
    sessionPublicId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    // A secondary mouse button opens a context menu; it does not drag.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // The default action would start a text selection and a scroll. Suppressing
    // it also suppresses the focus that follows a press, so the handle takes
    // focus explicitly and its arrow keys keep working after a drag.
    event.preventDefault();
    event.currentTarget.focus();
    dragRef.current = {
      activeId: sessionPublicId,
      overId: sessionPublicId,
      pointerId: event.pointerId,
    };
    setDrag({ activeId: sessionPublicId, overId: sessionPublicId });
  }, []);

  // The gesture is followed on the document rather than on the card, so a
  // finger that leaves the card, or a pointer that is cancelled by the browser,
  // still ends the drag exactly once.
  useEffect(() => {
    if (!dragging) return;
    const onPointerMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current === null || event.pointerId !== current.pointerId) return;
      event.preventDefault();
      const overId = cardUnderPointer(event.clientX, event.clientY);
      if (overId === current.overId) return;
      dragRef.current = { ...current, overId };
      setDrag({ activeId: current.activeId, overId });
    };
    const onPointerUp = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current === null || event.pointerId !== current.pointerId) return;
      dragRef.current = null;
      setDrag(null);
      const overId = cardUnderPointer(event.clientX, event.clientY) ?? current.overId;
      if (overId !== null) moveCard(displayedRef.current, current.activeId, overId);
    };
    const onPointerCancel = () => {
      dragRef.current = null;
      setDrag(null);
    };
    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [dragging, moveCard]);

  const hint = starting
    ? startTarget === null || project === null
      ? "No machine here can start a session yet. Sign an account in on a machine, add a project, and leave `hra remote allow device-commands` set."
      : sessionStartTargetHint(startTarget)
    : steerTarget === null
      ? "Nothing to send to yet."
      : `Steers ${steerTarget.title}. Clear the selection to start a new session.`;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col pt-[env(safe-area-inset-top)]">
      <header
        className={[
          "sticky top-0 z-20 flex flex-col gap-2 border-b border-line bg-surface",
          "px-[max(1rem,env(safe-area-inset-left))] py-3",
        ].join(" ")}
      >
        <div className="flex items-center gap-2">
          <Button
            aria-label="Settings"
            onClick={() => { navigate(settingsRoute); }}
            size="icon"
            variant="ghost"
          >
            <SettingsIcon />
          </Button>
          <form
            className="flex flex-1 items-center gap-2"
            onDragLeave={attach.onDragLeave}
            onDragOver={starting ? undefined : attach.onDragOver}
            onDrop={starting ? undefined : attach.onDrop}
            onSubmit={send}
          >
            <input
              accept={attachmentAcceptAttribute}
              aria-hidden="true"
              className="hidden"
              multiple
              onChange={attach.onPick}
              ref={pickerRef}
              tabIndex={-1}
              type="file"
            />
            {starting ? null : (
              <Button
                aria-label="Attach a file"
                disabled={steerTarget === null}
                onClick={() => { pickerRef.current?.click(); }}
                size="icon"
                variant="ghost"
              >
                <AttachIcon />
              </Button>
            )}
            <Input
              aria-label="Start a new session"
              disabled={starting ? startTarget === null : steerTarget === null}
              onChange={(event) => { setMessage(event.target.value); }}
              onPaste={starting ? undefined : attach.onPaste}
              placeholder="Start a new session"
              value={message}
            />
            <Button disabled={!canSubmit} type="submit">
              {starting ? "Start" : "Send"}
            </Button>
          </form>
          <Button onClick={custody.lock} size="small" variant="ghost">Lock</Button>
        </div>
        {starting && startTarget !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-ink-muted">
              <span>Account</span>
              <select
                className="min-h-11 rounded-md border border-line bg-surface-input px-2 text-sm text-ink"
                onChange={(event) => {
                  setTargetKey(event.target.value);
                  setProjectPublicId(null);
                }}
                value={`${startTarget.targetDevicePublicId}:${startTarget.accountPublicId}`}
              >
                {targets.map((entry) => (
                  <option
                    key={`${entry.targetDevicePublicId}:${entry.accountPublicId}`}
                    value={`${entry.targetDevicePublicId}:${entry.accountPublicId}`}
                  >
                    {sessionStartTargetLabel(entry)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs text-ink-muted">
              <span>Project</span>
              <select
                className="min-h-11 rounded-md border border-line bg-surface-input px-2 text-sm text-ink"
                onChange={(event) => { setProjectPublicId(event.target.value); }}
                value={project?.publicId ?? ""}
              >
                {startTarget.projects.map((entry) => (
                  <option key={entry.publicId} value={entry.publicId}>{entry.label}</option>
                ))}
              </select>
            </label>
            <ChoiceGroup
              label="Model"
              onSelect={setPreset}
              options={presetOptions}
              value={preset}
            />
          </div>
        ) : null}
        <p className="text-xs text-ink-muted">{hint}</p>
        {startNotice === null ? null : (
          <p
            className={startNotice.tone === "error"
              ? "text-xs text-danger"
              : "text-xs text-ink-muted"}
            role="status"
          >
            {startNotice.text}
          </p>
        )}
        {notice === null ? null : (
          <p className="text-xs text-ink-muted" role="status">{notice}</p>
        )}
        {attach.notice === null ? null : (
          <p className="text-xs text-danger" role="status">{attach.notice}</p>
        )}
        <ComposerAttachmentChips attachments={attach.attachments} onRemove={attach.remove} />
      </header>

      <main className="flex-1 px-[max(1rem,env(safe-area-inset-left))] py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {isLoading && heads.length === 0 ? (
          <p className="text-sm text-ink-muted">Loading sessions.</p>
        ) : null}
        {!isLoading && heads.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No sessions yet. Type a prompt above to start one on a machine.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))]">
          {rendered.map((head) => (
            <SessionCard
              head={head}
              key={head.publicId}
              onOpen={open}
              onSummary={reportSummary}
              ordering={{
                arranged: cardOrder.arranged,
                canMoveLeft: cardOrder.canMove(displayed, head.publicId, "left"),
                canMoveRight: cardOrder.canMove(displayed, head.publicId, "right"),
                dragging: drag?.activeId === head.publicId,
                dropTarget: drag !== null
                  && drag.overId === head.publicId
                  && drag.activeId !== head.publicId,
                onDragStart: beginDrag,
                onMove: moveInDisplayedOrder,
                onReset: cardOrder.reset,
              }}
              selected={head.publicId === selectedSessionId}
            />
          ))}
        </div>
        {status === "CanLoadMore" ? (
          <div className="mt-4 flex justify-center">
            <Button onClick={() => { loadMore(24); }} variant="secondary">Load more</Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
