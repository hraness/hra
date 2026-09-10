import { AppearanceButton } from "../components/appearance";
import * as stylex from "@stylexjs/stylex";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ComposerAttachmentChips } from "../components/attachment-chips";
import { AttachIcon, BackIcon, KebabIcon, StopIcon } from "../components/icons";
import { InteractionPanel } from "../components/interaction-panel";
import { ScheduledTasksBadge } from "../components/scheduled-tasks-badge";
import { StateIndicator } from "../components/state-indicator";
import { TranscriptView } from "../components/transcript-view";
import { Button } from "../components/ui/button";
import { Sheet } from "../components/ui/sheet";
import { Textarea } from "../components/ui/textarea";
import { useCommandState, useSubmitCommand } from "../data/commands";
import { useComposerAttachments } from "../data/composer-attachments";
import { holdSentAttachment } from "../data/sent-attachments";
import { useSessionHead } from "../data/session-heads";
import { useSessionModel } from "../data/session-model-hook";
import type { RemoteCommandPayload } from "../oompa/cloud";
import {
  attachmentAcceptAttribute,
  attachmentSendSupported,
  buildSendPayload,
  defaultMessageForAttachments,
} from "../model/attachments";
import {
  buildDefaultSetProviderPayload,
  providerSwitchDisabledReason,
  providerSwitchNote,
  providerSwitchNotice,
  providerSwitchOptions,
  providerSwitchSupported,
  sessionPresetOptionsForProvider,
  type SessionProvider,
} from "../model/provider-switch";
import {
  sessionFastCommand,
  sessionFastCommandNotice,
  sessionPresetCommand,
} from "../model/settings-commands";
import { deriveTranscript } from "../model/transcript";
import {
  interactionCommandPublicId,
  interactionInstanceKey,
  shortSessionLabel,
} from "../model/session-view";
import { navigateBack } from "../routing/router";
import { sessionScreenStyles } from "./session-screen.stylex";

type ApprovalMode = "auto:all" | "auto:workspace" | "manual";

const approvalOptions: readonly (readonly [ApprovalMode, string])[] = [
  ["auto:all", "Auto (all)"],
  ["auto:workspace", "Auto (workspace)"],
  ["manual", "Manual"],
];

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : "The command was not accepted.";
}

function ChoiceRow({
  disabled = false,
  label,
  onSelect,
  selected,
}: Readonly<{
  disabled?: boolean;
  label: string;
  onSelect: () => void;
  selected: boolean;
}>): ReactNode {
  return (
    <button
      aria-pressed={selected}
      {...stylex.props(
        sessionScreenStyles.choice,
        selected ? sessionScreenStyles.choiceSelected : sessionScreenStyles.choiceIdle,
      )}
      disabled={disabled}
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
  const { compactEvents, historyLoading, liveModel, metadata, model } = useSessionModel(
    head,
    { history: "full" },
  );
  const submit = useSubmitCommand();

  const [menuOpen, setMenuOpen] = useState(false);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode | null>(null);
  const [fastRequest, setFastRequest] = useState<Readonly<{
    commandPublicId: string;
    enabled: boolean;
    sessionPublicId: string;
  }> | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [decisionCommand, setDecisionCommand] = useState<Readonly<{
    interactionKey: string;
    publicId: string;
  }> | null>(null);
  const [provider, setProvider] = useState<SessionProvider | null>(null);
  const [providerCommandId, setProviderCommandId] = useState<string | null>(null);
  const attach = useComposerAttachments();
  const pickerRef = useRef<HTMLInputElement>(null);

  const title = model.title ?? shortSessionLabel(sessionPublicId);
  const retired = metadata.retiredProvider === "devin";
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
  const currentInteractionKey = interaction === null
    ? null
    : interactionInstanceKey(interaction);
  const decisionCommandId = interactionCommandPublicId(decisionCommand, interaction);

  const run = useCallback(async (payload: RemoteCommandPayload): Promise<string | null> => {
    if (head === null || retired) return null;
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
  }, [head, retired, sessionPublicId, submit]);

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

  const providerCommand = useCommandState(providerCommandId);
  const fastRequestForSession = fastRequest?.sessionPublicId === sessionPublicId
    ? fastRequest
    : null;
  const fastCommand = useCommandState(fastRequestForSession?.commandPublicId ?? null);
  const fastNotice = sessionFastCommandNotice(
    fastCommand,
    fastRequestForSession?.enabled ?? null,
  );
  const presetOptions = sessionPresetOptionsForProvider(provider);
  const providerDisabledReason = retired ? "Devin support is retired; this session is read-only." : providerSwitchDisabledReason({
    sending,
    supported: providerSwitchSupported(),
    turnActive: model.turnActive,
  });
  const providerNotice = providerSwitchNotice(providerCommand, provider);

  const attachments = attach.attachments;
  const typed = message.trim();
  // Attachments alone are a message: with nothing typed, the file names are the
  // text, which is factual rather than a sentence invented on the reader's
  // behalf. The daemon refuses an empty message, so something has to be there.
  const outgoing = typed.length > 0 ? typed : defaultMessageForAttachments(attachments);
  const canSend = head !== null && !retired && !sending && !attach.busy && outgoing.length > 0;

  const send = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!canSend) return;
    if (attach.sendRefusal !== null) {
      setNotice(attach.sendRefusal);
      return;
    }
    if (attachments.length > 0 && !attachmentSendSupported()) {
      setNotice(
        "This build does not carry attachments to the machine yet. "
        + "Send the message without them, or update the machine.",
      );
      return;
    }
    void run(buildSendPayload({ attachments, message: outgoing }))
      .then((commandPublicId) => {
        if (commandPublicId === null) return;
        // Only this tab can show these bytes again, and only until it reloads.
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
      });
  };

  return (
    <div {...stylex.props(sessionScreenStyles.root)}>
      <header {...stylex.props(sessionScreenStyles.header)}>
        <Button aria-label="Back to the grid" onClick={navigateBack} size="icon" variant="ghost">
          <BackIcon />
        </Button>
        <div {...stylex.props(sessionScreenStyles.titleBlock)}>
          <h1 {...stylex.props(sessionScreenStyles.title)}>{title}</h1>
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
        <AppearanceButton />
      </header>

      <ScheduledTasksBadge sessionPublicId={sessionPublicId} />

      <div
        {...stylex.props(sessionScreenStyles.scroller)}
        onScroll={onScroll}
        ref={scroller}
      >
        {head === null ? (
          <p {...stylex.props(sessionScreenStyles.quietBody)}>Loading the session.</p>
        ) : (
          <>
            {historyLoading && entries.length === 0 ? (
              <p {...stylex.props(sessionScreenStyles.quietBody)}>Loading the transcript.</p>
            ) : null}
            <TranscriptView entries={entries} thinkingText={liveModel.thinkingText} />
          </>
        )}
      </div>

      <div {...stylex.props(sessionScreenStyles.composer)}>
        {retired ? <p {...stylex.props(sessionScreenStyles.quiet)}>Devin support is retired. This session is read-only.</p> : null}
        {interaction === null || retired ? null : (
          <InteractionPanel
            commandPublicId={decisionCommandId}
            interaction={interaction}
            key={interactionInstanceKey(interaction)}
            onResolve={async (payload) => {
              const commandPublicId = await run(payload);
              if (commandPublicId !== null && currentInteractionKey !== null) {
                setDecisionCommand({
                  interactionKey: currentInteractionKey,
                  publicId: commandPublicId,
                });
              }
              return commandPublicId;
            }}
            submitting={sending}
          />
        )}
        {notice === null ? null : (
          <p {...stylex.props(sessionScreenStyles.quiet)} role="status">{notice}</p>
        )}
        {attach.notice === null ? null : (
          <p {...stylex.props(sessionScreenStyles.danger)} role="status">{attach.notice}</p>
        )}
        <ComposerAttachmentChips attachments={attachments} onRemove={attach.remove} />
        {attach.busy ? (
          <p {...stylex.props(sessionScreenStyles.quiet)} role="status">Preparing the attachments.</p>
        ) : null}
        <form
          {...stylex.props(sessionScreenStyles.form, attach.dragging && sessionScreenStyles.dragActive)}
          onDragLeave={attach.onDragLeave}
          onDragOver={attach.onDragOver}
          onDrop={attach.onDrop}
          onSubmit={send}
        >
          <input
            accept={attachmentAcceptAttribute}
            aria-hidden="true"
            {...stylex.props(sessionScreenStyles.fileInput)}
            multiple
            onChange={attach.onPick}
            ref={pickerRef}
            tabIndex={-1}
            type="file"
          />
          <Button
            aria-label="Attach a file"
            disabled={head === null || retired}
            onClick={() => { pickerRef.current?.click(); }}
            size="icon"
            variant="ghost"
          >
            <AttachIcon />
          </Button>
          <Textarea
            aria-label="Message this session"
            disabled={head === null || retired}
            onChange={(event) => { setMessage(event.target.value); }}
            onPaste={attach.onPaste}
            placeholder="Send or steer. Paste or drop an image or a text file to attach it."
            value={message}
          />
          {model.turnActive ? (
            <Button
              aria-label="Stop the turn"
              disabled={sending || retired}
              onClick={() => { void run({ kind: "stop" }); }}
              size="icon"
              variant="secondary"
            >
              <StopIcon />
            </Button>
          ) : null}
          <Button disabled={!canSend} type="submit">
            Send
          </Button>
        </form>
      </div>

      <Sheet label="Session menu" onClose={() => { setMenuOpen(false); }} open={menuOpen}>
        <h2 {...stylex.props(sessionScreenStyles.heading)}>Model</h2>
        <p {...stylex.props(sessionScreenStyles.menuDescription)}>
          Applies to future turns. The daemon holds the current value; this browser
          does not infer or highlight it.
        </p>
        <div {...stylex.props(sessionScreenStyles.menuOptions)}>
          {presetOptions.map(({ label, value }) => (
            <ChoiceRow
              disabled={retired}
              key={value}
              label={label}
              onSelect={() => {
                setMenuOpen(false);
                void run(sessionPresetCommand(value));
              }}
              selected={false}
            />
          ))}
        </div>

        <h2 {...stylex.props(sessionScreenStyles.heading, sessionScreenStyles.headingSpaced)}>Fast (Codex only)</h2>
        <p {...stylex.props(sessionScreenStyles.menuDescription)}>
          Applies to future turns; Claude Code has no Fast mode. The daemon
          holds the current value, so this browser highlights only a change the machine
          confirmed.
        </p>
        <div {...stylex.props(sessionScreenStyles.menuOptions)}>
          {([true, false] as const).map((enabled) => (
            <ChoiceRow
              disabled={head === null || retired || sending || model.turnActive}
              key={String(enabled)}
              label={enabled ? "On" : "Off"}
              onSelect={() => {
                setMenuOpen(false);
                const requestedSessionPublicId = sessionPublicId;
                void run(sessionFastCommand(enabled)).then((commandPublicId) => {
                  if (commandPublicId === null) return;
                  setFastRequest({
                    commandPublicId,
                    enabled,
                    sessionPublicId: requestedSessionPublicId,
                  });
                });
              }}
              selected={fastNotice?.applied === true && fastRequestForSession?.enabled === enabled}
            />
          ))}
        </div>
        {fastNotice === null ? null : (
          <p {...stylex.props(sessionScreenStyles.quiet, sessionScreenStyles.status)} role="status">{fastNotice.text}</p>
        )}

        <h2 {...stylex.props(sessionScreenStyles.heading, sessionScreenStyles.headingSpaced)}>Approvals</h2>
        <p {...stylex.props(sessionScreenStyles.menuDescription)}>
          Applies to this session. The daemon holds the current value, so nothing
          is highlighted until you set one from here.
        </p>
        <div {...stylex.props(sessionScreenStyles.menuOptions)}>
          {approvalOptions.map(([value, label]) => (
            <ChoiceRow
              disabled={retired}
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

        <h2 {...stylex.props(sessionScreenStyles.heading, sessionScreenStyles.headingSpaced)}>Provider</h2>
        <p {...stylex.props(sessionScreenStyles.menuDescription)}>{providerSwitchNote}</p>
        <div {...stylex.props(sessionScreenStyles.menuOptions)}>
          {providerSwitchOptions.map((option) => (
            <ChoiceRow
              disabled={providerDisabledReason !== null}
              key={option.provider}
              label={option.label}
              onSelect={() => {
                setProvider(option.provider);
                void run(buildDefaultSetProviderPayload(option.provider))
                  .then((commandPublicId) => { setProviderCommandId(commandPublicId); });
              }}
              selected={provider === option.provider}
            />
          ))}
        </div>
        {providerDisabledReason === null ? null : (
          <p {...stylex.props(sessionScreenStyles.quiet, sessionScreenStyles.status)}>{providerDisabledReason}</p>
        )}
        {providerNotice === null ? null : (
          <p {...stylex.props(sessionScreenStyles.quiet, sessionScreenStyles.status)} role="status">{providerNotice.text}</p>
        )}
      </Sheet>
    </div>
  );
}
