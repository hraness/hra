import * as stylex from "@stylexjs/stylex";
import { memo, useState, type ReactNode } from "react";

import { MessageAttachmentChips } from "./attachment-chips";
import { ChevronIcon } from "./icons";
import { StaticMarkdown, StreamingMarkdown } from "../markdown/markdown";
import type { AttachmentManifestEntry } from "../model/attachments";
import { turnSummaryLine } from "../model/session-view";
import type { TranscriptEntry } from "../model/transcript";
import { transcriptStyles } from "./transcript-view.stylex";

type UserMessageActor = Extract<TranscriptEntry, { kind: "user" }>["actor"];

const userMessageActorLabel: Readonly<Record<UserMessageActor, string>> = {
  automation: "automation",
  autorespond: "autorespond",
  human: "you",
  peer_session: "peer session",
  provider_switch: "provider handoff",
  unknown: "other sender",
};

/**
 * A closed assistant message. Memoised on its text, which never changes once
 * the compact stream has written it, so a delta arriving in the turn below
 * re-renders one block instead of the whole transcript.
 */
const ClosedMessage = memo(function ClosedMessage(
  { text }: Readonly<{ text: string }>,
): ReactNode {
  return <StaticMarkdown text={text} />;
});

/**
 * A sent message. Attachments render as a chip row under the bubble, never as
 * the image itself: the projection carries a manifest and no bytes, so the only
 * picture available is one this tab sent and still holds, which the chip
 * resolves for itself.
 */
const UserBubble = memo(function UserBubble({
  actor,
  attachments,
  text,
}: Readonly<{
  actor: UserMessageActor;
  attachments: readonly AttachmentManifestEntry[] | null;
  text: string;
}>): ReactNode {
  return (
    <div {...stylex.props(transcriptStyles.userBubble)}>
      <span {...stylex.props(transcriptStyles.userActor)}>
        {userMessageActorLabel[actor]}
      </span>
      <div {...stylex.props(transcriptStyles.userText)}>
        {text}
      </div>
      {attachments === null ? null : <MessageAttachmentChips attachments={attachments} />}
    </div>
  );
});

const TurnMarker = memo(function TurnMarker({
  filesTouched,
  gitActions,
  runtimeMs,
}: Readonly<{
  filesTouched: number;
  gitActions: readonly string[];
  runtimeMs: number;
}>): ReactNode {
  return (
    <p {...stylex.props(transcriptStyles.turnMarker)}>
      {turnSummaryLine({ filesTouched, gitActions, runtimeMs })}
    </p>
  );
});

/**
 * The collapsible reasoning summary.
 *
 * Summaries are uploaded only when the session has show-thinking on, so an
 * empty string means the reader never asked for them and the block is absent
 * rather than empty. Raw reasoning is never projected at all.
 */
export function ThinkingBlock({ text }: Readonly<{ text: string }>): ReactNode {
  const [open, setOpen] = useState(false);
  if (text.length === 0) return null;
  return (
    <div {...stylex.props(transcriptStyles.thinking)}>
      <button
        aria-expanded={open}
        {...stylex.props(transcriptStyles.thinkingButton)}
        onClick={() => { setOpen((current) => !current); }}
        type="button"
      >
        <ChevronIcon open={open} />
        Thinking
      </button>
      {open ? (
        <p {...stylex.props(transcriptStyles.thinkingText)}>
          {text}
        </p>
      ) : null}
    </div>
  );
}

export type TranscriptViewProps = Readonly<{
  entries: readonly TranscriptEntry[];
  thinkingText: string;
}>;

function renderEntry(entry: TranscriptEntry): ReactNode {
  switch (entry.kind) {
    case "user":
      return (
        <UserBubble
          actor={entry.actor}
          attachments={entry.attachments}
          key={entry.key}
          text={entry.text}
        />
      );
    case "turn_summary":
      return (
        <TurnMarker
          filesTouched={entry.filesTouched}
          gitActions={entry.gitActions}
          key={entry.key}
          runtimeMs={entry.runtimeMs}
        />
      );
    case "assistant":
      return entry.streaming
        ? <StreamingMarkdown key={entry.key} text={entry.text} />
        : <ClosedMessage key={entry.key} text={entry.text} />;
  }
}

/**
 * The transcript.
 *
 * The reasoning summary belongs to the turn in flight, so it is placed
 * immediately above the streaming message, or at the end when the turn has
 * produced no text yet. It renders nothing at all when the session has
 * show-thinking off, which is the default.
 */
export function TranscriptView({ entries, thinkingText }: TranscriptViewProps): ReactNode {
  const streamingIndex = entries
    .findIndex((entry) => entry.kind === "assistant" && entry.streaming);
  const items: ReactNode[] = [];
  entries.forEach((entry, index) => {
    if (index === streamingIndex) items.push(<ThinkingBlock key="thinking" text={thinkingText} />);
    items.push(renderEntry(entry));
  });
  if (streamingIndex < 0) items.push(<ThinkingBlock key="thinking" text={thinkingText} />);
  return <div {...stylex.props(transcriptStyles.transcript)}>{items}</div>;
}
