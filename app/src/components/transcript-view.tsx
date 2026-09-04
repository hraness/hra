import { memo, useState, type ReactNode } from "react";

import { ChevronIcon } from "./icons";
import { StaticMarkdown, StreamingMarkdown } from "../markdown/markdown";
import { turnSummaryLine } from "../model/session-view";
import type { TranscriptEntry } from "../model/transcript";

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

const UserBubble = memo(function UserBubble({
  actor,
  text,
}: Readonly<{ actor: "human" | "autorespond"; text: string }>): ReactNode {
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-[0.7rem] tracking-wide text-ink-muted uppercase">
        {actor === "autorespond" ? "autorespond" : "you"}
      </span>
      <div className="max-w-[85%] rounded-lg rounded-tr-sm border border-line bg-surface-input px-3 py-2 text-sm break-words whitespace-pre-wrap">
        {text}
      </div>
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
    <p className="border-t border-line pt-2 text-xs text-ink-muted">
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
    <div className="rounded-md border border-line">
      <button
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-1 px-3 text-left text-xs text-ink-muted"
        onClick={() => { setOpen((current) => !current); }}
        type="button"
      >
        <ChevronIcon open={open} />
        Thinking
      </button>
      {open ? (
        <p className="border-t border-line px-3 py-2 text-xs break-words whitespace-pre-wrap text-ink-muted">
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
      return <UserBubble actor={entry.actor} key={entry.key} text={entry.text} />;
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
  return <div className="flex flex-col gap-4">{items}</div>;
}
