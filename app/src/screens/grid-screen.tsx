import { useCallback, useMemo, useState, type ReactNode } from "react";

import { SettingsIcon } from "../components/icons";
import { SessionCard } from "../components/session-card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useSubmitCommand } from "../data/commands";
import { useSessionHeads } from "../data/session-heads";
import { useCustody } from "../custody/custody-context";
import { navigate } from "../routing/router";
import { sessionRoute, settingsRoute } from "../routing/route";
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

/**
 * The grid.
 *
 * Cards report their folded state upward, the ladder in `orderSessionCards`
 * decides the order, and the cards themselves stay mounted across a reorder
 * because they are keyed by session id: a card that floats to the front keeps
 * its subscription and its scroll position rather than remounting.
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

  const [summaries, setSummaries] = useState<Readonly<Record<string, SessionCardSummary>>>({});
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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

  const ordered = useMemo(() => orderSessionCards(known), [known]);
  const target = useMemo(
    () => resolveComposerTarget(ordered, selectedSessionId),
    [ordered, selectedSessionId],
  );

  const open = useCallback((sessionPublicId: string) => {
    onSelect(sessionPublicId);
    navigate(sessionRoute(sessionPublicId));
  }, [onSelect]);

  const send = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const text = message.trim();
    const head = target === null ? undefined : headById.get(target.publicId);
    if (head === undefined || text.length === 0 || sending) return;
    setSending(true);
    setNotice(null);
    void submit({
      executionDevicePublicId: head.executionDevicePublicId,
      payload: { kind: "send_or_steer", message: text },
      sessionPublicId: head.publicId,
    })
      .then(() => {
        setMessage("");
        setNotice(`Sent to ${target?.title ?? "the session"}.`);
      })
      .catch((failure: unknown) => {
        setNotice(failure instanceof Error ? failure.message : "The command was not accepted.");
      })
      .finally(() => { setSending(false); });
  };

  const visible = ordered
    .map((summary) => headById.get(summary.publicId))
    .filter((head): head is NonNullable<typeof head> => head !== undefined);
  // A head whose card has not reported yet is still rendered, otherwise nothing
  // would ever mount to report.
  const reported = new Set(known.map((summary) => summary.publicId));
  const pending = heads.filter((head) => !reported.has(head.publicId));
  const rendered = [...visible, ...pending];

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
          <form className="flex flex-1 items-center gap-2" onSubmit={send}>
            <Input
              aria-label="Start a new session"
              disabled={target === null}
              onChange={(event) => { setMessage(event.target.value); }}
              placeholder="Start a new session"
              value={message}
            />
            <Button disabled={target === null || sending || message.trim().length === 0} type="submit">
              Send
            </Button>
          </form>
          <Button onClick={custody.lock} size="small" variant="ghost">Lock</Button>
        </div>
        <p className="text-xs text-ink-muted">
          {target === null
            ? "Nothing to send to yet."
            : `Starting a new session from the web arrives with device commands. For now this steers ${target.title}.`}
        </p>
        {notice === null ? null : (
          <p className="text-xs text-ink-muted" role="status">{notice}</p>
        )}
      </header>

      <main className="flex-1 px-[max(1rem,env(safe-area-inset-left))] py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {isLoading && heads.length === 0 ? (
          <p className="text-sm text-ink-muted">Loading sessions.</p>
        ) : null}
        {!isLoading && heads.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No sessions yet. Start one from a machine with hra installed.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))]">
          {rendered.map((head) => (
            <SessionCard
              head={head}
              key={head.publicId}
              onOpen={open}
              onSummary={reportSummary}
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
