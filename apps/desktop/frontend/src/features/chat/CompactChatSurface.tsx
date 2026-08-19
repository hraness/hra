import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type ReactNode,
} from "react";

import { IconButton } from "../../ui";

import type {
  ChatBlockedMessageProjection,
  ChatMessageContent,
  ChatMessageAttachmentId,
  ChatMessageQueuePauseReason,
  ChatMessageQueueProjection,
  ChatQueuedMessageProjection,
  ChatProviderSubagentsProjection,
  ChatTurnProjection,
  HarnessChildProjection,
} from "../../../../contracts/runtime";
import { HRAIcon } from "./Icon";

export const paneIdentityGoldenAngleDegrees = 137.507_764_050_037_85;
export const paneIdentityInitialHueDegrees = 255;

const paneIdentityOklchScale = Object.freeze({
  ink: Object.freeze({ light: "0.38 0.11", dark: "0.86 0.095" }),
  soft: Object.freeze({ light: "0.95 0.028", dark: "0.27 0.045" }),
  strong: Object.freeze({ light: "0.60 0.16", dark: "0.74 0.13" }),
  onStrong: Object.freeze({ light: "0.99 0.008", dark: "0.17 0.025" }),
});

type PaneIdentityStyle = CSSProperties & Readonly<{
  "--pane-identity-hue": string;
  "--pane-identity-ink": string;
  "--pane-identity-on-strong": string;
  "--pane-identity-soft": string;
  "--pane-identity-strong": string;
  "--pane-identity": string;
}>;

/**
 * Palette indices are durable gateway facts. This helper deliberately accepts
 * no pane ID or grid position fallback, because either would make identity
 * color change or silently invent a second persistence authority.
 */
export function paneIdentityHue(paletteIndex: number): number {
  if (!Number.isSafeInteger(paletteIndex) || paletteIndex < 0) {
    throw new Error("Pane palette index must be a nonnegative safe integer.");
  }
  return (
    paneIdentityInitialHueDegrees + paletteIndex * paneIdentityGoldenAngleDegrees
  ) % 360;
}

export function paneIdentityStyle(paletteIndex: number | null): CSSProperties | undefined {
  if (paletteIndex === null) return undefined;
  const hue = paneIdentityHue(paletteIndex).toFixed(3);
  const token = (scale: { readonly dark: string; readonly light: string }): string =>
    `light-dark(oklch(${scale.light} ${hue}), oklch(${scale.dark} ${hue}))`;
  const style: PaneIdentityStyle = {
    "--pane-identity-hue": hue,
    "--pane-identity-ink": token(paneIdentityOklchScale.ink),
    "--pane-identity-soft": token(paneIdentityOklchScale.soft),
    "--pane-identity-strong": token(paneIdentityOklchScale.strong),
    "--pane-identity-on-strong": token(paneIdentityOklchScale.onStrong),
    "--pane-identity": "var(--pane-identity-strong)",
  };
  return style;
}

export function formatTurnElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(hours > 0 || minutes > 0 ? [`${minutes}m`] : []),
    `${seconds}s`,
  ].join(" ");
}

export interface CoarseTurnClockEnvironment {
  readonly cancelInterval: (handle: ReturnType<typeof setInterval>) => void;
  readonly listenForVisibilityChange: (listener: () => void) => () => void;
  readonly now: () => number;
  readonly scheduleInterval: (listener: () => void) => ReturnType<typeof setInterval>;
  readonly visible: () => boolean;
}

export interface CoarseTurnClockStore {
  readonly getServerSnapshot: () => number;
  readonly getSnapshot: () => number;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * One coarse clock serves every pane and fully sleeps while the page is
 * hidden. Keeping visibility and timer ownership in this store avoids one
 * interval per pane and makes the lifecycle law independently testable.
 */
export function createCoarseTurnClock(
  environment: CoarseTurnClockEnvironment,
): CoarseTurnClockStore {
  const listeners = new Set<() => void>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopListeningForVisibility: (() => void) | null = null;
  let now = environment.now();

  const publishNow = (): void => {
    const next = environment.now();
    if (Math.floor(next / 1_000) === Math.floor(now / 1_000)) return;
    now = next;
    for (const listener of listeners) listener();
  };

  const stopInterval = (): void => {
    if (interval === null) return;
    environment.cancelInterval(interval);
    interval = null;
  };

  const startInterval = (): void => {
    if (interval !== null || listeners.size === 0 || !environment.visible()) return;
    interval = environment.scheduleInterval(publishNow);
  };

  const visibilityChanged = (): void => {
    if (!environment.visible()) {
      stopInterval();
      return;
    }
    publishNow();
    startInterval();
  };

  return Object.freeze<CoarseTurnClockStore>({
    getSnapshot: () => now,
    getServerSnapshot: () => 0,
    subscribe(listener: () => void): () => void {
      const firstSubscriber = listeners.size === 0;
      listeners.add(listener);
      if (firstSubscriber) {
        stopListeningForVisibility = environment.listenForVisibilityChange(
          visibilityChanged,
        );
        now = environment.now();
        startInterval();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size !== 0) return;
        stopInterval();
        stopListeningForVisibility?.();
        stopListeningForVisibility = null;
      };
    },
  });
}

const coarseTurnClock = createCoarseTurnClock({
  cancelInterval: (handle) => clearInterval(handle),
  listenForVisibilityChange: (listener) => {
    if (typeof document === "undefined") return () => undefined;
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  now: () => Date.now(),
  scheduleInterval: (listener) => setInterval(listener, 1_000),
  visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
});

function useCoarseTurnNow(active: boolean): number {
  const subscribe = useCallback(
    (listener: () => void) => active
      ? coarseTurnClock.subscribe(listener)
      : () => undefined,
    [active],
  );
  return useSyncExternalStore(
    subscribe,
    coarseTurnClock.getSnapshot,
    coarseTurnClock.getServerSnapshot,
  );
}

export function turnElapsedMilliseconds(
  turn: Pick<ChatTurnProjection, "completedAt" | "startedAt">,
  now: number,
): number {
  const startedAt = Date.parse(turn.startedAt);
  const endedAt = turn.completedAt === null ? now : Date.parse(turn.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, endedAt - startedAt);
}

export const TurnElapsed = memo(function TurnElapsed({
  nowUnixMilliseconds,
  turn,
}: Readonly<{
  nowUnixMilliseconds?: number;
  turn: ChatTurnProjection | null;
}>) {
  const active = turn !== null && turn.completedAt === null;
  const coarseNow = useCoarseTurnNow(active && nowUnixMilliseconds === undefined);
  if (turn === null) return null;
  const now = nowUnixMilliseconds ?? coarseNow;
  const formatted = formatTurnElapsed(turnElapsedMilliseconds(turn, now));
  const durationContext = turn.completedAt === null ? "Current" : "Last";
  return (
    <time
      aria-label={`${durationContext} turn duration ${formatted}`}
      className="pane-turn-elapsed"
      dateTime={`PT${Math.floor(turnElapsedMilliseconds(turn, now) / 1_000)}S`}
      title={turn.completedAt === null ? "Current turn duration" : "Last turn duration"}
    >
      {formatted}
    </time>
  );
});

function visibleSubagent(child: HarnessChildProjection): boolean {
  return child.state === "starting" || child.state === "running" || child.state === "waiting";
}

export function visibleSubagents(
  children: readonly HarnessChildProjection[],
): readonly HarnessChildProjection[] {
  return children.filter(visibleSubagent);
}

const subagentStateLabel: Readonly<Record<HarnessChildProjection["state"], string>> = {
  failed: "failed",
  idle: "idle",
  quarantined: "quarantined",
  running: "running",
  starting: "starting",
  stopped: "stopped",
  waiting: "waiting",
};

export const ActiveSubagentStack = memo(function ActiveSubagentStack({
  children,
  provider,
}: Readonly<{
  children: readonly HarnessChildProjection[];
  provider: ChatProviderSubagentsProjection;
}>) {
  const visible = visibleSubagents(children);
  if (
    visible.length === 0 && provider.agents.length === 0 &&
    provider.overflowCount === 0
  ) return null;
  return (
    <section aria-label="Active subagents" className="pane-subagents">
      <ul>
        {provider.agents.map((agent) => (
          <li
            data-subagent-source="provider"
            data-subagent-state={agent.status}
            key={agent.id}
          >
            <span aria-hidden="true" className="pane-subagent__status" />
            <span className="pane-subagent__title">{agent.label}</span>
            <span className="pane-subagent__state">{agent.status}</span>
          </li>
        ))}
        {provider.overflowCount === 0 ? null : (
          <li data-subagent-source="provider" data-subagent-state="running">
            <span aria-hidden="true" className="pane-subagent__status" />
            <span className="pane-subagent__title">
              +{provider.overflowCount} active
            </span>
          </li>
        )}
        {visible.map((child) => (
          <li
            data-subagent-source="hra"
            data-subagent-state={child.state}
            key={child.id}
          >
            <span aria-hidden="true" className="pane-subagent__status" />
            <span className="pane-subagent__title">{child.title}</span>
            <span className="pane-subagent__state">{subagentStateLabel[child.state]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
});

export interface CompactAttachmentPreview {
  readonly byteSize: number;
  readonly id: ChatMessageAttachmentId;
  readonly mimeType: string;
  readonly name: string;
  readonly previewUrl: string | null;
  readonly status: "failed" | "processing" | "ready";
}

export function safeAttachmentPreviewUrl(value: string | null): string | null {
  if (value === null || value.length > 4_096 || !value.startsWith("blob:")) return null;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f || /\s/u.test(character)) return null;
  }
  return value;
}

export function isRasterImagePreviewMimeType(value: string): boolean {
  return value === "image/png";
}

function compactByteSize(byteSize: number): string {
  if (!Number.isFinite(byteSize) || byteSize < 0) return "0 B";
  if (byteSize < 1_024) return `${Math.floor(byteSize)} B`;
  if (byteSize < 1_048_576) return `${Math.max(1, Math.round(byteSize / 1_024))} KB`;
  return `${Math.max(1, Math.round(byteSize / 1_048_576))} MB`;
}

export const AttachmentPreviewStack = memo(function AttachmentPreviewStack({
  attachments,
  onRemove,
}: Readonly<{
  attachments: readonly CompactAttachmentPreview[];
  onRemove?: (attachmentId: ChatMessageAttachmentId) => void;
}>) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Message attachments" className="pane-attachments">
      {attachments.map((attachment) => {
        const previewUrl = isRasterImagePreviewMimeType(attachment.mimeType)
          ? safeAttachmentPreviewUrl(attachment.previewUrl)
          : null;
        return (
          <li data-attachment-status={attachment.status} key={attachment.id}>
            {previewUrl === null ? (
              <span aria-hidden="true" className="pane-attachment__file">
                <HRAIcon name="folder" />
              </span>
            ) : (
              <img alt="" src={previewUrl} />
            )}
            <span className="pane-attachment__identity">
              <span className="pane-attachment__name">{attachment.name}</span>
              <span className="pane-attachment__meta">
                {attachment.status} · {compactByteSize(attachment.byteSize)}
              </span>
            </span>
            {onRemove === undefined ? null : (
              <IconButton
                aria-label={`Remove ${attachment.name}`}
                controlClassName="pane-attachment__remove"
                onPress={() => onRemove(attachment.id)}
                size="compact"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="close" />
              </IconButton>
            )}
          </li>
        );
      })}
    </ul>
  );
});

export interface PastedImage {
  readonly file: File;
  readonly type: string;
}

export function pastedImagesFromClipboard(
  items: Iterable<Pick<DataTransferItem, "getAsFile" | "kind" | "type">>,
): readonly PastedImage[] {
  const images: PastedImage[] = [];
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file !== null) images.push({ file, type: item.type });
  }
  return images;
}

export function capturePastedImages(
  event: ReactClipboardEvent<HTMLTextAreaElement>,
  onImages: ((files: readonly File[]) => void) | undefined,
): boolean {
  if (onImages === undefined) return false;
  const images = pastedImagesFromClipboard(event.clipboardData.items);
  if (images.length === 0) return false;
  event.preventDefault();
  onImages(images.map(({ file }) => file));
  return true;
}

function queuePauseLabel(reason: ChatMessageQueuePauseReason): string {
  switch (reason) {
    case "ambiguousEffect":
      return "Delivery outcome unknown.";
    case "attention":
      return "Queue paused while this pane needs attention.";
    case "runtimeRestart":
      return "Queue paused after the runtime restarted.";
    case "stop":
      return "Queue paused after Stop.";
  }
}

interface QueuedMessageRowProps {
  readonly disabled: boolean;
  readonly head: boolean;
  readonly message: ChatQueuedMessageProjection;
  readonly onEdit?: (
    message: ChatQueuedMessageProjection,
    content: ChatMessageContent,
  ) => Promise<void>;
  readonly onRemove?: (message: ChatQueuedMessageProjection) => void;
  readonly onSteer?: (message: ChatQueuedMessageProjection) => void;
}

export function queuedMessageEditKeyAction(input: Readonly<{
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}>): "cancel" | "save" | null {
  if (input.isComposing) return null;
  if (input.key === "Escape") return "cancel";
  return input.key === "Enter" && (input.metaKey || input.ctrlKey)
    ? "save"
    : null;
}

export function queuedMessageEditSettlement(input: Readonly<{
  draft: string;
  outcome: "confirmed" | "failed";
  errorMessage?: string;
}>): Readonly<{
  draft: string;
  editing: boolean;
  error: string | null;
}> {
  return input.outcome === "confirmed"
    ? { draft: input.draft, editing: false, error: null }
    : {
        draft: input.draft,
        editing: true,
        error: input.errorMessage ?? "The queued message could not be saved.",
      };
}

const QueuedMessageRow = memo(function QueuedMessageRow({
  disabled,
  head,
  message,
  onEdit,
  onRemove,
  onSteer,
}: QueuedMessageRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (editing) return;
    setDraft(message.text);
  }, [editing, message.text]);
  const save = async (): Promise<void> => {
    if (
      onEdit === undefined ||
      saving ||
      (draft.trim().length === 0 && message.attachmentRefs.length === 0)
    ) return;
    setSaving(true);
    setError(null);
    try {
      await onEdit(message, {
        text: draft,
        attachmentRefs: message.attachmentRefs,
      });
      const settlement = queuedMessageEditSettlement({
        draft,
        outcome: "confirmed",
      });
      setDraft(settlement.draft);
      setError(settlement.error);
      setEditing(settlement.editing);
    } catch (reason: unknown) {
      const settlement = queuedMessageEditSettlement({
        draft,
        outcome: "failed",
        ...(reason instanceof Error ? { errorMessage: reason.message } : {}),
      });
      setDraft(settlement.draft);
      setError(settlement.error);
      setEditing(settlement.editing);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="pane-queue-row" data-queue-head={head || undefined}>
      {editing ? (
        <textarea
          aria-label="Edit queued message"
          autoFocus
          className="pane-queue-row__editor"
          disabled={disabled || saving}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            const action = queuedMessageEditKeyAction({
              isComposing: event.nativeEvent.isComposing,
              key: event.key,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
            });
            if (action === "cancel") {
              event.preventDefault();
              setDraft(message.text);
              setError(null);
              setEditing(false);
            } else if (action === "save") {
              event.preventDefault();
              void save();
            }
          }}
          rows={2}
          value={draft}
        />
      ) : (
        <span className="pane-queue-row__text">
          {message.text.trim().length === 0 ? "Attachment" : message.text}
          {message.attachmentRefs.length === 0
            ? null
            : ` · ${message.attachmentRefs.length} ${message.attachmentRefs.length === 1 ? "file" : "files"}`}
        </span>
      )}
      <span className="pane-queue-row__actions">
        {editing ? (
          <>
            <IconButton
              aria-label="Save queued message"
              controlClassName="pane-queue-action"
              isDisabled={disabled || saving || (draft.trim().length === 0 && message.attachmentRefs.length === 0)}
              isPending={saving}
              onPress={() => void save()}
              size="compact"
              type="button"
              variant="quiet"
            >
              <HRAIcon name="check" />
            </IconButton>
            <IconButton
              aria-label="Cancel queued message edit"
              controlClassName="pane-queue-action"
              isDisabled={disabled || saving}
              onPress={() => {
                setDraft(message.text);
                setError(null);
                setEditing(false);
              }}
              size="compact"
              type="button"
              variant="quiet"
            >
              <HRAIcon name="close" />
            </IconButton>
          </>
        ) : (
          <>
            {onEdit === undefined ? null : (
              <IconButton
                aria-label="Edit queued message"
                controlClassName="pane-queue-action"
                isDisabled={disabled}
                onPress={() => setEditing(true)}
                size="compact"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="edit" />
              </IconButton>
            )}
            {onRemove === undefined ? null : (
              <IconButton
                aria-label="Remove queued message"
                controlClassName="pane-queue-action"
                isDisabled={disabled}
                onPress={() => onRemove(message)}
                size="compact"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="close" />
              </IconButton>
            )}
            {!head || onSteer === undefined ? null : (
              <IconButton
                aria-label="Send queued message now"
                controlClassName="pane-queue-action pane-queue-action--steer"
                isDisabled={disabled}
                onPress={() => onSteer(message)}
                size="compact"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="send" />
              </IconButton>
            )}
          </>
        )}
      </span>
      {error === null ? null : (
        <span className="pane-queue-row__error" role="alert">{error}</span>
      )}
    </li>
  );
});

export const QueuedMessageStack = memo(function QueuedMessageStack({
  discardAmbiguousDisabled = false,
  disabled = false,
  onDiscardAmbiguous,
  onEdit,
  onRemove,
  onResume,
  onStartFresh,
  onSteerHead,
  queue,
}: Readonly<{
  discardAmbiguousDisabled?: boolean;
  disabled?: boolean;
  onDiscardAmbiguous?: (message: ChatBlockedMessageProjection) => void;
  onEdit?: QueuedMessageRowProps["onEdit"];
  onRemove?: QueuedMessageRowProps["onRemove"];
  onResume?: () => void;
  onStartFresh?: () => void;
  onSteerHead?: QueuedMessageRowProps["onSteer"];
  queue: ChatMessageQueueProjection;
}>) {
  const blockedMessage = queue.blockedMessage;
  if (
    queue.messages.length === 0 && queue.pauseReason === null &&
    blockedMessage === null
  ) return null;
  return (
    <section
      aria-label="Queued messages"
      className="pane-queue"
      data-queue-pause-reason={queue.pauseReason ?? undefined}
    >
      {queue.pauseReason === null ? null : (
        <div className="pane-queue__pause" role="status">
          <span>{queuePauseLabel(queue.pauseReason)}</span>
          {onStartFresh === undefined ? null : (
            <button disabled={disabled} onClick={onStartFresh} type="button">
              Start fresh
            </button>
          )}
          {onStartFresh !== undefined || onResume === undefined ||
              queue.pauseReason === "ambiguousEffect" ? null : (
            <button disabled={disabled} onClick={onResume} type="button">Resume</button>
          )}
        </div>
      )}
      {blockedMessage === null ? null : (
        <div aria-label="Message with unknown delivery outcome" className="pane-queue-blocked">
          <span className="pane-queue-row__text">
            {blockedMessage.text.trim().length === 0
              ? "Attachment"
              : blockedMessage.text}
            {blockedMessage.attachmentRefs.length === 0
              ? null
              : ` · ${blockedMessage.attachmentRefs.length} ${blockedMessage.attachmentRefs.length === 1 ? "image" : "images"}`}
          </span>
          {onDiscardAmbiguous === undefined ? null : (
            <button
              aria-label="Discard message with unknown delivery outcome"
              className="pane-queue-discard"
              disabled={disabled || discardAmbiguousDisabled}
              onClick={() => onDiscardAmbiguous(blockedMessage)}
              type="button"
            >
              Discard
            </button>
          )}
        </div>
      )}
      {queue.messages.length === 0 ? null : (
        <ol>
          {queue.messages.map((message, index) => (
            <QueuedMessageRow
              disabled={disabled}
              head={index === 0}
              key={message.id}
              message={message}
              {...(onEdit === undefined ? {} : { onEdit })}
              {...(onRemove === undefined ? {} : { onRemove })}
              {...(
                onSteerHead === undefined || queue.pauseReason !== null
                  ? {}
                  : { onSteer: onSteerHead }
              )}
            />
          ))}
        </ol>
      )}
    </section>
  );
});

export type CompactComposerDelivery = "queue" | "steerHead";

export interface CompactChatPaneSurface {
  readonly attachments: readonly CompactAttachmentPreview[];
  readonly attachmentError?: string | null;
  readonly nowUnixMilliseconds?: number;
  readonly onAttachFiles?: (files: readonly File[]) => void;
  readonly onAttachmentsEnqueued?: (attachmentIds: readonly ChatMessageAttachmentId[]) => void;
  readonly onRemoveAttachment?: (attachmentId: ChatMessageAttachmentId) => void;
}

export function compactComposerDelivery(input: Readonly<{
  active: boolean;
  queueEmpty: boolean;
  steerModifier: boolean;
}>): CompactComposerDelivery {
  return input.active && input.steerModifier && input.queueEmpty ? "steerHead" : "queue";
}

export function CompactAttachmentButton({
  onFiles,
}: Readonly<{ onFiles?: (files: readonly File[]) => void }>) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (onFiles === undefined) return null;
  return (
    <>
      <input
        accept="image/*"
        className="hra-visually-hidden pane-attachment-input"
        multiple
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
        ref={inputRef}
        type="file"
      />
      <IconButton
        aria-label="Attach images"
        controlClassName="pane-attach"
        onPress={() => inputRef.current?.click()}
        size="compact"
        type="button"
        variant="quiet"
      >
        <HRAIcon name="plus" />
      </IconButton>
    </>
  );
}

export function CompactComposerBar({
  attachments,
  children,
  onAttachFiles,
  onRemoveAttachment,
  right,
}: Readonly<{
  attachments: readonly CompactAttachmentPreview[];
  children: ReactNode;
  onAttachFiles?: (files: readonly File[]) => void;
  onRemoveAttachment?: (attachmentId: ChatMessageAttachmentId) => void;
  right: ReactNode;
}>) {
  return (
    <div className="pane-composer-box">
      <AttachmentPreviewStack
        attachments={attachments}
        {...(onRemoveAttachment === undefined ? {} : { onRemove: onRemoveAttachment })}
      />
      {children}
      <div className="pane-composer-bar">
        <span className="pane-composer-bar__left">
          <CompactAttachmentButton
            {...(onAttachFiles === undefined ? {} : { onFiles: onAttachFiles })}
          />
        </span>
        <span className="pane-composer-bar__right">{right}</span>
      </div>
    </div>
  );
}
