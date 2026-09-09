import * as stylex from "@stylexjs/stylex";
import { useCallback, useEffect, useMemo, useState, type PointerEvent, type ReactNode } from "react";

import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog, DialogFooter, DialogTitle } from "./ui/dialog";
import { DropdownMenu, type DropdownMenuItem } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { DragHandleIcon, KebabIcon } from "./icons";
import { StateIndicator } from "./state-indicator";
import { StreamingTail } from "./streaming-tail";
import { SubagentChips } from "./subagent-chips";
import { useSubmitCommand } from "../data/commands";
import { useSessionModel } from "../data/session-model-hook";
import type { SessionHead } from "../data/wire";
import { shortSessionLabel, type SessionCardSummary } from "../model/session-view";
import { sessionCardStyles } from "./session-card.stylex";

/**
 * What the grid tells one card about the reader's arrangement.
 *
 * The card owns no ordering state. It reports a drag gesture and a keyboard
 * step upward, and it renders whatever the grid says about the arrangement in
 * progress, so the whole arrangement stays in one reducer.
 */
export type SessionCardOrdering = Readonly<{
  /** Whether the reader has arranged anything, so the reset item is offered. */
  arranged: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  /** This card is the one under the pointer, so it shows where the drop lands. */
  dropTarget: boolean;
  /** This card is the one being dragged. */
  dragging: boolean;
  onDragStart: (sessionPublicId: string, event: PointerEvent<HTMLElement>) => void;
  onMove: (sessionPublicId: string, direction: "left" | "right") => void;
  onReset: () => void;
}>;

export type SessionCardProps = Readonly<{
  head: SessionHead;
  onOpen: (sessionPublicId: string) => void;
  onSummary: (summary: SessionCardSummary) => void;
  ordering: SessionCardOrdering;
  selected: boolean;
}>;

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : "The command was not accepted.";
}

/**
 * One grid card.
 *
 * The card owns its own subscriptions, because a session's state lives in its
 * encrypted streams and not on the head the grid paginates. It reports the three
 * facts the grid needs for ordering back up through `onSummary`: whether it
 * wants a human, whether it is working, and when it last moved.
 */
export function SessionCard({
  head,
  onOpen,
  onSummary,
  ordering,
  selected,
}: SessionCardProps): ReactNode {
  const { metadata, model } = useSessionModel(head, { history: "tail" });
  const submit = useSubmitCommand();

  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showId, setShowId] = useState(false);

  const publicId = head.publicId;
  const title = model.title ?? shortSessionLabel(publicId);
  const lastActivityAt = Math.max(model.lastActivityAt, head.updatedAt);
  const archived = metadata.archived;
  const retired = metadata.retiredProvider === "devin";

  const summary = useMemo<SessionCardSummary>(() => ({
    archived,
    ...(retired ? { retiredProvider: "devin" as const } : {}),
    attention: model.attention,
    lastActivityAt,
    metadataRevision: head.metadataRevision,
    publicId,
    state: model.state,
    title,
  }), [
    archived,
    head.metadataRevision,
    lastActivityAt,
    model.attention,
    model.state,
    publicId,
    title,
    retired,
  ]);

  useEffect(() => { onSummary(summary); }, [onSummary, summary]);

  const run = useCallback((
    payload: Parameters<typeof submit>[0]["payload"],
    pending: string,
  ) => {
    if (retired) return;
    setBusy(true);
    setNotice(pending);
    void submit({
      executionDevicePublicId: head.executionDevicePublicId,
      payload,
      sessionPublicId: publicId,
    })
      .then(() => { setNotice(null); })
      .catch((failure: unknown) => { setNotice(failureMessage(failure)); })
      .finally(() => { setBusy(false); });
  }, [head.executionDevicePublicId, publicId, retired, submit]);

  const copyId = useCallback(() => {
    // `clipboard-write` is not denied by the app's permissions policy, but a
    // browser may still refuse it outside a secure context or a user gesture it
    // recognises. The dialog is the fallback, never a silent failure.
    void navigator.clipboard.writeText(publicId)
      .then(() => { setNotice("Session id copied."); })
      .catch(() => { setShowId(true); });
  }, [publicId]);

  const menuItems: readonly DropdownMenuItem[] = [
    {
      disabled: !ordering.canMoveLeft,
      id: "move-left",
      label: "Move left",
      onSelect: () => { ordering.onMove(publicId, "left"); },
    },
    {
      disabled: !ordering.canMoveRight,
      id: "move-right",
      label: "Move right",
      onSelect: () => { ordering.onMove(publicId, "right"); },
    },
    {
      disabled: busy || retired,
      id: "archive",
      label: "Archive",
      onSelect: () => { run({ archived: true, kind: "archive_session" }, "Archiving."); },
    },
    {
      disabled: busy || retired,
      id: "rename",
      label: "Rename",
      onSelect: () => {
        setRenameValue(model.title ?? "");
        setRenaming(true);
      },
    },
    { id: "copy", label: "Copy id", onSelect: copyId },
    ...(ordering.arranged
      ? [{ id: "reset-order", label: "Reset card order", onSelect: ordering.onReset }]
      : []),
  ];

  return (
    <Card
      data-session-id={publicId}
      xstyle={[
        sessionCardStyles.card,
        model.attention ? sessionCardStyles.attention : selected ? sessionCardStyles.selected : null,
        ordering.dragging ? sessionCardStyles.dragging : null,
        ordering.dropTarget ? sessionCardStyles.selected : null,
      ]}
    >
      <div {...stylex.props(sessionCardStyles.header)}>
        {/*
          The handle is the only place a drag starts, so a tap anywhere else on
          the card still opens the session. `touch-none` hands the gesture to
          the pointer handlers instead of the scroller, and the 44 px box is the
          mobile target the plan asks for.
        */}
        <button
          aria-label={`Reorder ${title}. Use the arrow keys, or the card menu.`}
          {...stylex.props(sessionCardStyles.dragHandle)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            ordering.onMove(publicId, event.key === "ArrowLeft" ? "left" : "right");
          }}
          onPointerDown={(event) => { ordering.onDragStart(publicId, event); }}
          type="button"
        >
          <DragHandleIcon />
        </button>
        <button
          {...stylex.props(sessionCardStyles.openButton)}
          onClick={() => { onOpen(publicId); }}
          type="button"
        >
          <span {...stylex.props(sessionCardStyles.title)}>{title}</span>
          <StateIndicator state={model.state} />
          {retired ? <span {...stylex.props(sessionCardStyles.quiet)}>Devin retired · read-only</span> : null}
          {model.lastPrompt === null ? null : (
            <span {...stylex.props(sessionCardStyles.lastPrompt)}>{model.lastPrompt}</span>
          )}
        </button>
        <div {...stylex.props(sessionCardStyles.menu)}>
          <DropdownMenu
            items={menuItems}
            label={`Session actions for ${title}`}
            trigger={<KebabIcon />}
          />
        </div>
      </div>

      <SubagentChips sessionTitle={title} subagents={model.subagents} />

      {notice === null ? null : (
        <p {...stylex.props(sessionCardStyles.notice)} role="status">{notice}</p>
      )}

      <StreamingTail label={`Streaming output for ${title}`} text={model.streamingText} />

      <Dialog
        label="Rename session"
        onClose={() => { setRenaming(false); }}
        open={renaming}
      >
        <DialogTitle>Rename session</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const next = renameValue.trim();
            setRenaming(false);
            run(
              { kind: "rename_session", name: next.length === 0 ? null : next },
              "Renaming.",
            );
          }}
        >
          <Input
            aria-label="Session name"
            xstyle={sessionCardStyles.dialogInput}
            maxLength={200}
            onChange={(event) => { setRenameValue(event.target.value); }}
            placeholder="Leave empty to clear the name"
            value={renameValue}
          />
          <DialogFooter>
            <Button onClick={() => { setRenaming(false); }} variant="secondary">Cancel</Button>
            <Button type="submit">Rename</Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog label="Session id" onClose={() => { setShowId(false); }} open={showId}>
        <DialogTitle>Session id</DialogTitle>
        <p {...stylex.props(sessionCardStyles.dialogValue)}>{publicId}</p>
        <DialogFooter>
          <Button onClick={() => { setShowId(false); }} variant="secondary">Close</Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
