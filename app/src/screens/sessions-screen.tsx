import { useState } from "react";

import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import { useCustody } from "../custody/custody-context";
import { useSubmitCommand } from "../data/commands";
import { useSessionHeads } from "../data/session-heads";
import { useSessionModel } from "../data/session-model-hook";
import type { SessionHead } from "../data/wire";
import { streamingTailLines } from "../env";
import type { SessionStateValue } from "../hra/cloud";
import { streamingTail } from "../model/session-model";

const stateTone: Readonly<Record<SessionStateValue, BadgeTone>> = {
  aborted: "danger",
  done: "neutral",
  done_caveats: "danger",
  done_followups: "neutral",
  needs_action: "attention",
  needs_answer: "attention",
  needs_approval: "attention",
  working: "accent",
};

function shortId(publicId: string): string {
  return publicId.slice(0, 12);
}

function SessionRow({
  head,
  onSelect,
  selected,
}: Readonly<{ head: SessionHead; onSelect: () => void; selected: boolean }>) {
  const { model } = useSessionModel(head, { includeHistory: selected });
  const tail = streamingTail(model.streamingText, streamingTailLines);

  return (
    <Card
      className={[
        selected ? "border-accent" : "",
        model.attention ? "border-attention attention-glow" : "",
      ].join(" ")}
    >
      <button
        aria-current={selected}
        className="flex w-full flex-col gap-2 p-3 text-left"
        onClick={onSelect}
        type="button"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">
            {model.title ?? shortId(head.publicId)}
          </span>
          <Badge tone={stateTone[model.state]}>{model.state}</Badge>
        </span>
        {model.lastPrompt === null ? null : (
          <span className="line-clamp-2 text-xs text-ink-muted">{model.lastPrompt}</span>
        )}
        {model.subagents.length === 0 ? null : (
          <span className="text-xs text-ink-muted">
            {model.subagents.length} subagent{model.subagents.length === 1 ? "" : "s"} running
          </span>
        )}
      </button>
      <pre
        aria-label="Streaming output"
        className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-line px-3 py-2 font-mono text-xs text-ink-muted"
        role="log"
      >
        {tail.length === 0 ? "No live output yet." : tail}
      </pre>
    </Card>
  );
}

/**
 * The round one screen: a plain list of sessions with their live streaming tail,
 * and one input that steers the selected session. It exists to prove the whole
 * pipeline end to end, from the daemon's live uploader through the encrypted
 * projection to a browser that decrypts it and submits a durable command back.
 */
export function SessionsScreen() {
  const custody = useCustody();
  const { heads, isLoading, loadMore, status } = useSessionHeads();
  const submit = useSubmitCommand();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = heads.find((head) => head.publicId === selectedId)
    ?? heads[0]
    ?? null;

  const send = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const text = message.trim();
    if (selected === null || text.length === 0 || sending) return;
    setSending(true);
    setNotice(null);
    void submit({
      executionDevicePublicId: selected.executionDevicePublicId,
      payload: { kind: "send_or_steer", message: text },
      sessionPublicId: selected.publicId,
    })
      .then((commandPublicId) => {
        setMessage("");
        setNotice(`Queued command ${shortId(commandPublicId)}.`);
      })
      .catch((failure: unknown) => {
        setNotice(failure instanceof Error ? failure.message : "The command was not accepted.");
      })
      .finally(() => { setSending(false); });
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h1 className="text-sm font-semibold">Sessions</h1>
        <Button onClick={custody.lock} size="small" variant="ghost">Lock</Button>
      </header>

      <main className="flex flex-1 flex-col gap-3 p-4">
        {isLoading && heads.length === 0 ? (
          <p className="text-sm text-ink-muted">Loading sessions.</p>
        ) : null}
        {!isLoading && heads.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No sessions yet. Start one from a machine with hra installed.
          </p>
        ) : null}
        {heads.map((head) => (
          <SessionRow
            head={head}
            key={head.publicId}
            onSelect={() => { setSelectedId(head.publicId); }}
            selected={selected?.publicId === head.publicId}
          />
        ))}
        {status === "CanLoadMore" ? (
          <Button onClick={() => { loadMore(24); }} variant="secondary">Load more</Button>
        ) : null}
      </main>

      <form
        className="sticky bottom-0 flex flex-col gap-2 border-t border-line bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
        onSubmit={send}
      >
        {notice === null ? null : (
          <p className="text-xs text-ink-muted" role="status">{notice}</p>
        )}
        <Textarea
          aria-label="Message the selected session"
          disabled={selected === null}
          onChange={(event) => { setMessage(event.target.value); }}
          placeholder={selected === null
            ? "Select a session"
            : `Steer ${shortId(selected.publicId)}`}
          value={message}
        />
        <Button disabled={selected === null || sending || message.trim().length === 0} type="submit">
          Send
        </Button>
      </form>
    </div>
  );
}
