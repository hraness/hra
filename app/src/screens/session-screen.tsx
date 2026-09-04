import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { BackIcon, KebabIcon, StopIcon } from "../components/icons";
import { InteractionPanel } from "../components/interaction-panel";
import { ScheduledTasksBadge } from "../components/scheduled-tasks-badge";
import { StateIndicator } from "../components/state-indicator";
import { TranscriptView } from "../components/transcript-view";
import { Button } from "../components/ui/button";
import { Sheet } from "../components/ui/sheet";
import { Textarea } from "../components/ui/textarea";
import { useSubmitCommand } from "../data/commands";
import { useSessionHead } from "../data/session-heads";
import { useSessionModel } from "../data/session-model-hook";
import type { ModelPreset, RemoteCommandPayload } from "../hra/cloud";
import { cn } from "../lib/cn";
import { deriveTranscript } from "../model/transcript";
import { shortSessionLabel } from "../model/session-view";
import { navigateBack } from "../routing/router";

type ApprovalMode = "auto:all" | "auto:workspace" | "manual";

const presetOptions: readonly (readonly [ModelPreset, string])[] = [
  ["low", "Sol Low"],
  ["high", "Sol High"],
  ["ultra", "Sol Ultra"],
  ["fable-max", "Claude Fable Max"],
];

const approvalOptions: readonly (readonly [ApprovalMode, string])[] = [
  ["auto:all", "Auto (all)"],
  ["auto:workspace", "Auto (workspace)"],
  ["manual", "Manual"],
];

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : "The command was not accepted.";
}

function ChoiceRow({
  label,
  onSelect,
  selected,
}: Readonly<{ label: string; onSelect: () => void; selected: boolean }>): ReactNode {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex min-h-11 w-full items-center justify-between rounded-md border px-3 text-left text-sm",
        selected ? "border-accent text-accent" : "border-line text-ink",
      )}
      onClick={onSelect}
      type="button"
    >
      {label}
      {selected ? <span aria-hidden="true">✓</span> : null}
    </button>
  );
}

/**
 * The session screen.
 *
 * The transcript is the compact history plus whatever the live tail holds for a
 * turn the compact stream has not closed yet, and every decision the reader can
 * take from here goes out as a durable command bound to the session's execution
 * device. Nothing on this screen executes anything: the daemon is still the only
 * authority, and a command that arrives after the session moved machines fails
 * closed rather than running somewhere else.
 */
export function SessionScreen({
  sessionPublicId,
}: Readonly<{ sessionPublicId: string }>): ReactNode {
  const head = useSessionHead(sessionPublicId);
  const { compactEvents, historyLoading, liveModel, model } = useSessionModel(
    head,
    { history: "full" },
  );
  const submit = useSubmitCommand();

  const [menuOpen, setMenuOpen] = useState(false);
  const [preset, setPreset] = useState<ModelPreset>("ultra");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [decisionCommandId, setDecisionCommandId] = useState<string | null>(null);

  const title = model.title ?? shortSessionLabel(sessionPublicId);
  const entries = useMemo(
    () => deriveTranscript(compactEvents, {
      streamingText: liveModel.streamingText,
      turnId: liveModel.turnId,
    }),
    [compactEvents, liveModel.streamingText, liveModel.turnId],
  );
  // A blocking interaction is holding the turn, so it is the one to answer
  // first; otherwise the most recent one is on top.
  const interaction = model.pendingInteractions.find((entry) => entry.blocking)
    ?? model.pendingInteractions.at(-1)
    ?? null;

  const run = useCallback(async (payload: RemoteCommandPayload): Promise<string | null> => {
    if (head === null) return null;
    setSending(true);
    setNotice(null);
    try {
      return await submit({
        executionDevicePublicId: head.executionDevicePublicId,
        payload,
        sessionPublicId,
      });
    } catch (failure: unknown) {
      setNotice(failureMessage(failure));
      return null;
    } finally {
      setSending(false);
    }
  }, [head, sessionPublicId, submit]);

  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    following.current = distance < 80;
  }, []);

  // Auto-follow, unless the reader scrolled up to read something older.
  useEffect(() => {
    const element = scroller.current;
    if (element === null || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [entries]);

  const send = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const text = message.trim();
    if (text.length === 0 || sending) return;
    void run({ kind: "send_or_steer", message: text })
      .then((commandPublicId) => { if (commandPublicId !== null) setMessage(""); });
  };

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center gap-2 border-b border-line px-[max(0.5rem,env(safe-area-inset-left))] py-2">
        <Button aria-label="Back to the grid" onClick={navigateBack} size="icon" variant="ghost">
          <BackIcon />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <StateIndicator state={model.state} />
        </div>
        <Button
          aria-label="Session menu"
          onClick={() => { setMenuOpen(true); }}
          size="icon"
          variant="ghost"
        >
          <KebabIcon />
        </Button>
      </header>

      <ScheduledTasksBadge sessionPublicId={sessionPublicId} />

      <div
        className="flex-1 overflow-y-auto px-[max(1rem,env(safe-area-inset-left))] py-4"
        onScroll={onScroll}
        ref={scroller}
      >
        {head === null ? (
          <p className="text-sm text-ink-muted">Loading the session.</p>
        ) : (
          <>
            {historyLoading && entries.length === 0 ? (
              <p className="text-sm text-ink-muted">Loading the transcript.</p>
            ) : null}
            <TranscriptView entries={entries} thinkingText={liveModel.thinkingText} />
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-line bg-surface px-[max(1rem,env(safe-area-inset-left))] pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {interaction === null ? null : (
          <InteractionPanel
            commandPublicId={decisionCommandId}
            interaction={interaction}
            onResolve={(payload) => {
              void run(payload).then((commandPublicId) => {
                setDecisionCommandId(commandPublicId);
              });
            }}
            submitting={sending}
          />
        )}
        {notice === null ? null : (
          <p className="text-xs text-ink-muted" role="status">{notice}</p>
        )}
        <form className="flex items-end gap-2" onSubmit={send}>
          <Textarea
            aria-label="Message this session"
            disabled={head === null}
            onChange={(event) => { setMessage(event.target.value); }}
            placeholder="Send or steer"
            value={message}
          />
          {model.turnActive ? (
            <Button
              aria-label="Stop the turn"
              disabled={sending}
              onClick={() => { void run({ kind: "stop" }); }}
              size="icon"
              variant="secondary"
            >
              <StopIcon />
            </Button>
          ) : null}
          <Button disabled={head === null || sending || message.trim().length === 0} type="submit">
            Send
          </Button>
        </form>
      </div>

      <Sheet label="Session menu" onClose={() => { setMenuOpen(false); }} open={menuOpen}>
        <h2 className="text-base font-semibold">Model</h2>
        <div className="mt-2 flex flex-col gap-2">
          {presetOptions.map(([value, label]) => (
            <ChoiceRow
              key={value}
              label={label}
              onSelect={() => {
                setPreset(value);
                setMenuOpen(false);
                void run({ kind: "set_model", preset: value });
              }}
              selected={preset === value}
            />
          ))}
        </div>
        <h2 className="mt-4 text-base font-semibold">Approvals</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Applies to this session. The daemon holds the current value, so nothing
          is highlighted until you set one from here.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {approvalOptions.map(([value, label]) => (
            <ChoiceRow
              key={value}
              label={label}
              onSelect={() => {
                setApprovalMode(value);
                setMenuOpen(false);
                void run({ kind: "set_approval_mode", mode: value, scope: "session" });
              }}
              selected={approvalMode === value}
            />
          ))}
        </div>
      </Sheet>
    </div>
  );
}
