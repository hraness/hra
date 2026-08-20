import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
  type UIEvent,
} from "react";

import {
  IconButton,
  Menu,
  MenuItem,
  MenuTrigger,
  TextAreaField,
  TextField,
} from "../../ui";

import {
  runtimeChatMessageUtf8ByteLimit,
  type ChatBlockedMessageProjection,
  type ChatMessageContent,
  type ChatPaneProjection,
  type ChatQueuedMessageProjection,
  type RuntimeChatDomainCommand,
  type RuntimeChatMessageLedgerCommand,
  type RuntimeChatMessageQueueResult,
  type RuntimeDispatchResponse,
  type RuntimeError,
} from "../../../../contracts/runtime";
import {
  type RuntimeShell,
  useRuntimeShellSelector,
} from "../../runtime";
import { MarkdownResponse } from "./MarkdownResponse";
import { HRAIcon } from "./Icon";
import {
  ActiveSubagentStack,
  capturePastedImages,
  CompactComposerBar,
  compactComposerDelivery,
  paneIdentityStyle,
  QueuedMessageStack,
  ScheduledChatStatus,
  ScheduleModeToggle,
  TurnElapsed,
  type CompactChatPaneSurface,
} from "./CompactChatSurface";
import {
  composerMode,
  composerEnterAction,
  configurePaneScheduleCommand,
  createTitleDebouncer,
  createMessageId,
  discardAmbiguousMessageCommand,
  editQueuedMessageCommand,
  enqueueMessageCommand,
  isRevisionConflict,
  normalizePaneTitle,
  paneAccessibleName,
  paneCanCompose,
  paneCanRename,
  paneIsActive,
  paneStatusLabel,
  paneWorkspaceStatus,
  paneTitleBlurAction,
  paneTitleErrorId,
  paneTitleUtf16CodeUnitLimit,
  reconcilePaneTitleCommit,
  recoverPaneWorkspaceCommand,
  removePaneScheduleCommand,
  removeQueuedMessageCommand,
  renamePaneCommand,
  resolvePaneRevisionConflict,
  runtimeAvailabilityEqual,
  selectRuntimeAvailability,
  selectPane,
  selectPaneCanMessage,
  selectPaneRepositoryCommand,
  resumeMessageQueueCommand,
  startFreshProviderContextCommand,
  stopTurnCommand,
  steerQueuedMessageCommand,
  titleCommitFailureShouldRefocus,
  validatedPrompt,
  type ScheduledTitleCommit,
  type TitleDebouncer,
} from "./model";
import { useLiveChatAttachments } from "./use-live-chat-attachments";

class PaneCommandError extends Error {
  readonly runtimeError: RuntimeError | null;

  constructor(message: string, runtimeError: RuntimeError | null = null) {
    super(message);
    this.name = "PaneCommandError";
    this.runtimeError = runtimeError;
  }
}

type ComposerEnqueueDelivery = Extract<
  RuntimeChatMessageLedgerCommand,
  { readonly type: "chat.message.enqueue" }
>["delivery"];

export interface FrozenComposerRequest {
  readonly contentSignature: string;
  readonly delivery: ComposerEnqueueDelivery;
  readonly messageId: string;
  readonly steerModifier: boolean;
}

export function freezeComposerRequest(input: Readonly<{
  existing: FrozenComposerRequest | null;
  currentMessageId: string;
  contentSignature: string;
  steerModifier: boolean;
  delivery: FrozenComposerRequest["delivery"];
  createMessageId: () => string;
}>): Readonly<{ frozen: FrozenComposerRequest; currentMessageId: string }> {
  if (
    input.existing !== null &&
    input.existing.contentSignature === input.contentSignature &&
    input.existing.steerModifier === input.steerModifier
  ) {
    return { frozen: input.existing, currentMessageId: input.currentMessageId };
  }
  const currentMessageId = input.existing === null
    ? input.currentMessageId
    : input.createMessageId();
  return {
    currentMessageId,
    frozen: {
      contentSignature: input.contentSignature,
      delivery: input.delivery,
      messageId: currentMessageId,
      steerModifier: input.steerModifier,
    },
  };
}

export function settleComposerRequest(
  disposition: RuntimeChatMessageQueueResult["disposition"],
  createMessageId: () => string,
): Readonly<{ clearDraft: boolean; nextMessageId: string }> {
  return {
    clearDraft: disposition !== "notApplied",
    nextMessageId: createMessageId(),
  };
}

export function composerSubmissionAction(input: Readonly<{
  isComposing: boolean;
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  active: boolean;
  hasQueuedHead: boolean;
}>): "none" | "sendComposer" | "steerQueuedHead" {
  if (composerEnterAction(input) !== "submit") return "none";
  return (input.metaKey || input.ctrlKey) && input.active && input.hasQueuedHead
    ? "steerQueuedHead"
    : "sendComposer";
}

export function paneTitleKeyAction(input: Readonly<{
  isComposing: boolean;
  key: string;
}>): "cancel" | "commit" | null {
  if (input.isComposing) return null;
  if (input.key === "Escape") return "cancel";
  return input.key === "Enter" ? "commit" : null;
}

function commandErrorMessage(reason: unknown): string {
  if (reason instanceof PaneCommandError) return reason.message;
  return reason instanceof Error
    ? reason.message
    : "The local runtime did not complete the request.";
}

function paneFromResponse(
  response: RuntimeDispatchResponse,
  currentPane: ChatPaneProjection | null,
): ChatPaneProjection {
  if (!response.ok) throw new PaneCommandError(response.error.message, response.error);
  if (response.result.type === "chatPane") return response.result.pane;
  if (
    response.result.type === "chatPaneReplay" &&
    currentPane !== null &&
    currentPane.id === response.result.paneId &&
    currentPane.revision >= response.result.appliedRevision
  ) {
    return currentPane;
  }
  throw new PaneCommandError("The local runtime returned the wrong pane result.");
}

export interface PaneRetryMutationPort {
  readonly dispatch: RuntimeShell["dispatch"];
  readonly getState: RuntimeShell["getState"];
}

async function dispatchPaneMutationWithRetry(
  shell: PaneRetryMutationPort,
  paneId: string,
  initialRevision: number,
  commandForRevision: (revision: number) => RuntimeChatDomainCommand,
  revisionRetryStillAuthorized: (pane: ChatPaneProjection) => boolean = () => true,
): Promise<ChatPaneProjection> {
  let revision = initialRevision;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await shell.dispatch(commandForRevision(revision));
    if (response.ok) {
      return paneFromResponse(response, selectPane(shell.getState(), paneId));
    }
    if (attempt > 0 || !isRevisionConflict(response.error)) {
      throw new PaneCommandError(response.error.message, response.error);
    }
    const current = selectPane(shell.getState(), paneId);
    const resolution = resolvePaneRevisionConflict(current, revision);
    switch (resolution.kind) {
      case "cancelled":
        throw new PaneCommandError("This pane started working before the request could finish.");
      case "missing":
        throw new PaneCommandError("This pane no longer exists.");
      case "stale":
        throw new PaneCommandError("The pane changed before the request could finish.");
      case "retry":
        if (current === null || !revisionRetryStillAuthorized(current)) {
          throw new PaneCommandError("The failed turn changed before the retry could finish.");
        }
        revision = resolution.revision;
        break;
    }
  }
  throw new PaneCommandError("The pane changed before the request could finish.");
}

export async function dispatchMessageQueueMutation(
  shell: Pick<RuntimeShell, "dispatch">,
  command: RuntimeChatMessageLedgerCommand,
): Promise<RuntimeChatMessageQueueResult> {
  const response = await shell.dispatch(command);
  if (!response.ok) throw new PaneCommandError(response.error.message, response.error);
  if (response.result.type !== "chatMessageQueue" || response.result.paneId !== command.paneId) {
    throw new PaneCommandError("The local runtime returned the wrong message queue result.");
  }
  return response.result;
}

export interface PaneTitleMutationPort {
  readonly dispatch: RuntimeShell["dispatch"];
  readonly getState: RuntimeShell["getState"];
}

export async function dispatchPaneTitleMutation(
  shell: PaneTitleMutationPort,
  paneId: string,
  initialRevision: number,
  title: string,
): Promise<ChatPaneProjection | null> {
  let revision = initialRevision;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await shell.dispatch(renamePaneCommand({
      paneId,
      expectedRevision: revision,
      title,
    }));
    if (response.ok) {
      return paneFromResponse(response, selectPane(shell.getState(), paneId));
    }
    if (!isRevisionConflict(response.error)) {
      throw new PaneCommandError(response.error.message, response.error);
    }
    const resolution = resolvePaneRevisionConflict(
      selectPane(shell.getState(), paneId),
      revision,
    );
    if (resolution.kind === "cancelled") return null;
    if (resolution.kind === "missing") {
      throw new PaneCommandError("This pane no longer exists.");
    }
    if (resolution.kind === "stale" || attempt > 0) {
      throw new PaneCommandError("The pane changed before the title could be saved.");
    }
    revision = resolution.revision;
  }
  throw new PaneCommandError("The pane changed before the title could be saved.");
}

export function isNearPaneBottom(input: Readonly<{
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}>, threshold = 56): boolean {
  return input.scrollHeight - input.scrollTop - input.clientHeight <= threshold;
}

interface PaneTitleFocusTarget {
  focus(options?: FocusOptions): void;
}

export function preservePendingPaneTitleFocus(
  input: PaneTitleFocusTarget | null,
): boolean {
  if (input === null) return false;
  input.focus({ preventScroll: true });
  return true;
}

interface PreventablePaneTitleInteraction {
  preventDefault(): void;
  stopPropagation(): void;
}

export function fencePendingPaneTitleInteraction(
  pending: boolean,
  event: PreventablePaneTitleInteraction,
): boolean {
  if (!pending) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function paneAcceptsUserInteraction(pane: ChatPaneProjection): boolean {
  return pane.interactionMode === "chat";
}

export function scheduleOffRequiresCommand(
  schedule: ChatPaneProjection["schedule"],
  configureSubmitted: boolean,
): boolean {
  return schedule !== null || configureSubmitted;
}

function usePaneAutoScroll(dependencyKey: string) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const shouldStickRef = useRef(true);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    shouldStickRef.current = isNearPaneBottom(event.currentTarget);
  }, []);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript === null || !shouldStickRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [dependencyKey]);

  return { onScroll, transcriptRef } as const;
}

interface InlinePaneTitleProps {
  readonly editable: boolean;
  readonly editRequest: number;
  readonly onCommit: (commit: ScheduledTitleCommit) => Promise<ChatPaneProjection>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly paneId: string;
  readonly revision: number;
  readonly title: string;
}

function InlinePaneTitle({
  editable,
  editRequest,
  onCommit,
  onPendingChange,
  paneId,
  revision,
  title,
}: InlinePaneTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const baselineRef = useRef({ revision, title });
  const draftRef = useRef(title);
  const pendingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editRequestRef = useRef(editRequest);
  const errorId = paneTitleErrorId(paneId);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const onPendingChangeRef = useRef(onPendingChange);
  onPendingChangeRef.current = onPendingChange;
  const commitGenerationRef = useRef(0);
  const debouncerRef = useRef<TitleDebouncer | null>(null);
  if (debouncerRef.current === null) {
    debouncerRef.current = createTitleDebouncer((commit, reason) => {
      const generation = commitGenerationRef.current + 1;
      commitGenerationRef.current = generation;
      pendingRef.current = true;
      setPending(true);
      onPendingChangeRef.current(true);
      setError(null);
      void commitRef.current(commit)
        .then((committedPane) => {
          if (commitGenerationRef.current !== generation) return;
          const reconciliation = reconcilePaneTitleCommit({
            baseline: baselineRef.current,
            commit,
            committedPane,
            draft: draftRef.current,
            reason,
          });
          baselineRef.current = reconciliation.baseline;
          draftRef.current = reconciliation.draft;
          setDraft(reconciliation.draft);
          if (reconciliation.finishEditing) setEditing(false);
        })
        .catch((reason: unknown) => {
          if (commitGenerationRef.current !== generation) return;
          setError(commandErrorMessage(reason));
        })
        .finally(() => {
          if (commitGenerationRef.current !== generation) return;
          pendingRef.current = false;
          setPending(false);
          onPendingChangeRef.current(false);
        });
    });
  }

  useLayoutEffect(() => {
    const previous = baselineRef.current;
    if (
      revision < previous.revision
      || (revision === previous.revision && title !== previous.title)
    ) return;
    if (revision === previous.revision) return;
    baselineRef.current = { revision, title };
    if (!editing || draftRef.current === previous.title) {
      draftRef.current = title;
      setDraft(title);
    }
  }, [editing, revision, title]);
  useEffect(() => {
    if (editRequest === editRequestRef.current) return;
    editRequestRef.current = editRequest;
    if (!editable) return;
    draftRef.current = baselineRef.current.title;
    setDraft(baselineRef.current.title);
    setError(null);
    setEditing(true);
  }, [editRequest, editable]);
  useEffect(() => {
    if (editable) return;
    commitGenerationRef.current += 1;
    debouncerRef.current?.cancel();
    pendingRef.current = false;
    draftRef.current = baselineRef.current.title;
    setDraft(baselineRef.current.title);
    setError(null);
    setPending(false);
    setEditing(false);
    onPendingChangeRef.current(false);
  }, [editable]);
  useEffect(() => {
    if (!titleCommitFailureShouldRefocus({ editing, error, pending })) return;
    preservePendingPaneTitleFocus(inputRef.current);
  }, [editing, error, pending]);
  useLayoutEffect(() => {
    if (!pending) return;
    preservePendingPaneTitleFocus(inputRef.current);
  }, [pending]);
  useEffect(() => () => {
    commitGenerationRef.current += 1;
    debouncerRef.current?.cancel();
    pendingRef.current = false;
  }, []);

  const preserveFocusWhilePending = (input: HTMLInputElement): void => {
    preservePendingPaneTitleFocus(input);
    queueMicrotask(() => {
      if (pendingRef.current) preservePendingPaneTitleFocus(inputRef.current);
    });
  };

  const schedule = (value: string): void => {
    if (!editable) return;
    draftRef.current = value;
    setDraft(value);
    setError(null);
    const normalized = normalizePaneTitle(value);
    if (normalized === null || normalized === baselineRef.current.title) {
      debouncerRef.current?.cancel();
      return;
    }
    debouncerRef.current?.schedule({
      revision: baselineRef.current.revision,
      title: normalized,
    });
  };

  const finishInvalidEdit = (): void => {
    commitGenerationRef.current += 1;
    debouncerRef.current?.cancel();
    draftRef.current = baselineRef.current.title;
    setDraft(baselineRef.current.title);
    setError(null);
    setEditing(false);
  };

  const finishEdit = (): void => {
    if (pendingRef.current) return;
    const normalized = normalizePaneTitle(draftRef.current);
    if (normalized === null) {
      setError("Enter a title.");
    } else if (normalized === baselineRef.current.title) {
      finishInvalidEdit();
    } else {
      schedule(draftRef.current);
      debouncerRef.current?.flush();
    }
  };

  if (!editing) {
    return <strong className="pane-title">{title}</strong>;
  }

  return (
    <span className="pane-title-edit">
      <TextField
        {...(pending ? { "aria-busy": true } : {})}
        {...(error === null ? {} : {
          "aria-describedby": errorId,
          "aria-invalid": true,
        })}
        autoFocus
        className="pane-title-field"
        inputClassName="pane-title-input"
        inputProps={{
          maxLength: paneTitleUtf16CodeUnitLimit,
          onBlur: (event) => {
            const action = paneTitleBlurAction({
              draft: draftRef.current,
              error,
              pending: pendingRef.current,
              title: baselineRef.current.title,
            });
            switch (action) {
              case "preserve":
                fencePendingPaneTitleInteraction(true, event);
                preserveFocusWhilePending(event.currentTarget);
                return;
              case "commit-and-preserve":
                schedule(draftRef.current);
                debouncerRef.current?.flush();
                fencePendingPaneTitleInteraction(true, event);
                preserveFocusWhilePending(event.currentTarget);
                return;
              case "finish":
                finishInvalidEdit();
                return;
              case "release":
                return;
            }
          },
          onFocus: (event) => event.currentTarget.select(),
          onKeyDown: (event) => {
            if (pendingRef.current) return;
            const action = paneTitleKeyAction({
              isComposing: event.nativeEvent.isComposing,
              key: event.key,
            });
            if (action === "cancel") {
              event.preventDefault();
              finishInvalidEdit();
            } else if (action === "commit") {
              event.preventDefault();
              finishEdit();
            }
          },
        }}
        inputRef={inputRef}
        isDisabled={!editable}
        isReadOnly={pending}
        label="Pane title"
        onChange={schedule}
        showLabel={false}
        size="compact"
        surface="pane"
        value={draft}
      />
      <span
        className="pane-title-save-fence"
        onPointerDown={(event) => event.preventDefault()}
      >
        <IconButton
          aria-label="Save pane title"
          className="pane-title-save-shell"
          controlClassName="pane-title-save"
          isPending={pending}
          onPress={finishEdit}
          size="compact"
          type="button"
          variant="quiet"
        >
          <HRAIcon name="check" />
        </IconButton>
      </span>
      {error === null ? null : (
        <span
          aria-atomic="true"
          className="pane-title-error"
          id={errorId}
          role="alert"
        >
          {error}
        </span>
      )}
    </span>
  );
}

function TurnActivity({ pane }: { readonly pane: ChatPaneProjection }) {
  const turn = pane.turn;
  if (turn === null) return null;
  const active = paneIsActive(pane.state);
  const reasoningVisible = active || turn.reasoningSummaryVerified === true;
  const hasVisibleActivity = (reasoningVisible && turn.reasoningSummary.tail.length > 0) ||
    turn.responseMarkdown.tail.length > 0;

  return (
    <>
      {reasoningVisible && turn.reasoningSummary.tail.length > 0 ? (
        <section className="pane-reasoning" aria-label="Thinking">
          <div aria-hidden="true" className="pane-activity-label">
            <span className="activity-pulse" aria-hidden="true" />
          </div>
          <MarkdownResponse
            content={turn.reasoningSummary}
            streaming={active}
            variant="reasoning"
          />
        </section>
      ) : null}
      {turn.responseMarkdown.tail.length > 0 ? (
        <article aria-label="Latest response" className="pane-response">
          <MarkdownResponse
            content={turn.responseMarkdown}
            streaming={active}
            variant="response"
          />
        </article>
      ) : null}
      {active && !hasVisibleActivity ? (
        <p aria-label="Working" className="pane-working">
          <span aria-hidden="true" className="activity-pulse" />
        </p>
      ) : null}
    </>
  );
}

interface ChatPaneViewProps {
  readonly announcementActive?: boolean;
  readonly canMoveEarlier?: boolean;
  readonly canMoveLater?: boolean;
  readonly draggable?: boolean;
  readonly dragging?: boolean;
  readonly gridPosition: number;
  readonly onActivateAnnouncement?: () => void;
  readonly onDragEnd?: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDragOver?: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDragStart?: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDrop?: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onMoveEarlier?: () => void;
  readonly onMoveLater?: () => void;
  readonly reorderPending?: boolean;
  readonly pane: ChatPaneProjection;
  readonly shell: RuntimeShell;
  readonly surface?: CompactChatPaneSurface;
}

export function ChatPaneView({
  announcementActive = false,
  canMoveEarlier = false,
  canMoveLater = false,
  draggable = false,
  dragging = false,
  gridPosition,
  onActivateAnnouncement = () => undefined,
  onDragEnd = () => undefined,
  onDragOver = () => undefined,
  onDragStart = () => undefined,
  onDrop = () => undefined,
  onMoveEarlier = () => undefined,
  onMoveLater = () => undefined,
  reorderPending = false,
  pane,
  shell,
  surface,
}: ChatPaneViewProps) {
  const runtimeAvailability = useRuntimeShellSelector(
    shell,
    selectRuntimeAvailability,
    runtimeAvailabilityEqual,
  );
  const messageAuthoritySelector = useMemo(
    () => (state: Parameters<typeof selectPaneCanMessage>[0]) =>
      selectPaneCanMessage(state, pane.id),
    [pane.id],
  );
  const canMessage = useRuntimeShellSelector(
    shell,
    messageAuthoritySelector,
  );
  const workspaceStatus = paneWorkspaceStatus(pane);
  const [prompt, setPrompt] = useState("");
  const [scheduleDraftMode, setScheduleDraftMode] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "queue" | "remove" | "repository" | "schedule" | "send" | "stop" | "workspace" | null
  >(null);
  const [titlePending, setTitlePending] = useState(false);
  const [titleEditRequest, setTitleEditRequest] = useState(0);
  const titlePendingRef = useRef(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const scheduleConfigureSubmittedRef = useRef(false);
  const draftMessageIdRef = useRef(createMessageId());
  const frozenComposerRequestRef = useRef<FrozenComposerRequest | null>(null);
  const attachmentIdentityRef = useRef(
    surface?.attachments.map(({ id }) => id).join("\0") ?? "",
  );
  const active = paneIsActive(pane.state);
  const promptMode = composerMode(pane.schedule, scheduleDraftMode);
  const scheduling = promptMode === "schedule";
  const composerCanDraft = canMessage && (paneCanCompose(pane.state) || active);
  // An active schedule must always retain its turn-off control, even when the
  // managed workspace is unavailable and ordinary message admission is closed.
  const showComposerForm = canMessage || active || pane.schedule !== null;
  const acceptsUserInteraction = paneAcceptsUserInteraction(pane);
  const paneHarness = pane.harness ?? null;
  const descendants = paneHarness?.descendants ?? null;
  const runtimeReady = runtimeAvailability.kind === "ready";
  const configurable = runtimeReady
    && acceptsUserInteraction
    && paneCanCompose(pane.state)
    && pendingAction === null
    && !titlePending;
  const scheduleCanDraft = configurable && canMessage;
  const titleEditable = runtimeReady
    && paneCanRename(pane.state)
    && pendingAction === null;
  const turn = pane.turn;
  const pristine = turn === null;
  const scrollKey = [
    pane.state,
    turn?.reasoningSummary.totalUtf8Bytes ?? 0,
    turn?.responseMarkdown.totalUtf8Bytes ?? 0,
  ].join(":");

  useEffect(() => {
    if (pane.schedule !== null) setScheduleDraftMode(false);
  }, [pane.schedule]);

  useEffect(() => {
    const identity = surface?.attachments.map(({ id }) => id).join("\0") ?? "";
    if (attachmentIdentityRef.current === identity) return;
    attachmentIdentityRef.current = identity;
    draftMessageIdRef.current = createMessageId();
    frozenComposerRequestRef.current = null;
  }, [surface?.attachments]);
  const { onScroll, transcriptRef } = usePaneAutoScroll(scrollKey);
  const paneLabelId = `chat-pane-label-${pane.id}`;
  const transcriptLabelId = `chat-pane-transcript-label-${pane.id}`;
  const composerErrorId = `chat-pane-composer-error-${pane.id}`;

  const onTitlePendingChange = useCallback((nextPending: boolean) => {
    titlePendingRef.current = nextPending;
    setTitlePending(nextPending);
  }, []);
  const fenceTitlePendingInteraction = useCallback((event: SyntheticEvent<HTMLElement>) => {
    fencePendingPaneTitleInteraction(titlePendingRef.current, event);
  }, []);

  const commitTitle = useCallback(async (commit: ScheduledTitleCommit) => {
    if (!titleEditable) {
      throw new PaneCommandError("This pane started working before the title could finish saving.");
    }
    const normalized = normalizePaneTitle(commit.title);
    if (normalized === null) throw new PaneCommandError("Enter a title.");
    if (normalized === pane.title && pane.revision >= commit.revision) return pane;
    const committedPane = await dispatchPaneTitleMutation(
      shell,
      pane.id,
      commit.revision,
      normalized,
    );
    if (committedPane === null) {
      throw new PaneCommandError("This pane started working before the title could finish saving.");
    }
    return committedPane;
  }, [pane, shell, titleEditable]);

  const recoverWorkspace = useCallback(async () => {
    if (workspaceStatus?.retryable !== true) return;
    if (!configurable) return;
    setPendingAction("workspace");
    setLocalError(null);
    try {
      await dispatchPaneMutationWithRetry(
        shell,
        pane.id,
        pane.revision,
        (expectedRevision) => recoverPaneWorkspaceCommand({
          paneId: pane.id,
          expectedRevision,
        }),
      );
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  }, [configurable, pane.id, pane.revision, shell, workspaceStatus]);

  const send = useCallback(async (steerModifier = false) => {
    if (scheduling) {
      if (!scheduleCanDraft) return;
      const validation = validatedPrompt(prompt);
      if (!validation.ok) {
        setLocalError(
          validation.message === "Write a message first."
            ? "Describe the schedule first."
            : validation.message,
        );
        return;
      }
      const scheduleRevision = pane.schedule?.revision ?? null;
      scheduleConfigureSubmittedRef.current = true;
      setPendingAction("schedule");
      setLocalError(null);
      try {
        await dispatchPaneMutationWithRetry(
          shell,
          pane.id,
          pane.revision,
          (expectedRevision) => configurePaneScheduleCommand({
            paneId: pane.id,
            expectedRevision,
            instruction: validation.prompt,
          }),
          (currentPane) => (currentPane.schedule?.revision ?? null) === scheduleRevision,
        );
        setPrompt("");
      } catch (reason: unknown) {
        setLocalError(commandErrorMessage(reason));
      } finally {
        setPendingAction(null);
      }
      return;
    }
    if (
      !runtimeReady
      || !canMessage
      || (!paneCanCompose(pane.state) && !active)
      || pendingAction !== null
      || titlePending
    ) return;
    const readyAttachments = surface?.attachments.filter(({ status }) => status === "ready") ?? [];
    if (surface?.attachments.some(({ status }) => status === "failed") === true) {
      setLocalError("Remove the failed attachment before sending.");
      return;
    }
    if (
      surface !== undefined &&
      readyAttachments.length !== surface.attachments.length
    ) {
      setLocalError("Wait for every attachment to finish processing.");
      return;
    }
    const validation = validatedPrompt(prompt);
    if (!validation.ok && readyAttachments.length === 0) {
      setLocalError(validation.message);
      return;
    }
    setPendingAction("send");
    setLocalError(null);
    try {
      const attachmentRefs = readyAttachments.map(({ id }) => id);
      const content = {
        text: validation.ok ? validation.prompt : "",
        attachmentRefs,
      };
      const contentSignature = JSON.stringify(content);
      const requestedDelivery = compactComposerDelivery({
        active,
        queueEmpty: pane.messageQueue.messages.length === 0 &&
          pane.messageQueue.blockedMessage === null &&
          pane.messageQueue.pauseReason === null,
        steerModifier,
      });
      const resolved = freezeComposerRequest({
        existing: frozenComposerRequestRef.current,
        currentMessageId: draftMessageIdRef.current,
        contentSignature,
        steerModifier,
        delivery: requestedDelivery === "steerHead" && turn !== null
          ? { kind: "steerHead", expectedTurnId: turn.id }
          : { kind: "queue" },
        createMessageId,
      });
      const frozen = resolved.frozen;
      draftMessageIdRef.current = resolved.currentMessageId;
      frozenComposerRequestRef.current = frozen;
      const result = await dispatchMessageQueueMutation(
        shell,
        enqueueMessageCommand({
          paneId: pane.id,
          expectedQueueRevision: pane.messageQueue.revision,
          messageId: frozen.messageId,
          content,
          delivery: frozen.delivery,
        }),
      );
      const settlement = settleComposerRequest(result.disposition, createMessageId);
      draftMessageIdRef.current = settlement.nextMessageId;
      frozenComposerRequestRef.current = null;
      if (!settlement.clearDraft) {
        setLocalError("The steering request was not applied. Send again to retry.");
        return;
      }
      surface?.onAttachmentsEnqueued?.(attachmentRefs);
      setPrompt("");
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  }, [active, canMessage, pane.id, pane.messageQueue, pane.revision, pane.schedule, pane.state, pendingAction, prompt, runtimeReady, scheduleCanDraft, scheduling, shell, surface, titlePending, turn]);

  const toggleScheduleMode = useCallback(async (selected: boolean) => {
    if (!configurable) return;
    setLocalError(null);
    if (selected) {
      setScheduleDraftMode(true);
      return;
    }
    if (!scheduleOffRequiresCommand(
      pane.schedule,
      scheduleConfigureSubmittedRef.current,
    )) {
      setScheduleDraftMode(false);
      return;
    }
    const scheduleRevision = pane.schedule?.revision ?? null;
    setPendingAction("schedule");
    try {
      await dispatchPaneMutationWithRetry(
        shell,
        pane.id,
        pane.revision,
        (expectedRevision) => removePaneScheduleCommand({
          paneId: pane.id,
          expectedRevision,
        }),
        (currentPane) => currentPane.schedule !== null && (
          scheduleRevision === null
          || currentPane.schedule.revision >= scheduleRevision
        ),
      );
      scheduleConfigureSubmittedRef.current = false;
      setScheduleDraftMode(false);
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  }, [configurable, pane.id, pane.revision, pane.schedule, shell]);

  const mutateQueue = useCallback(async (command: RuntimeChatMessageLedgerCommand) => {
    if (!runtimeReady || pendingAction !== null || titlePending) {
      throw new PaneCommandError("Wait for the current chat action to finish.");
    }
    setPendingAction("queue");
    setLocalError(null);
    try {
      await dispatchMessageQueueMutation(shell, command);
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
      throw reason;
    } finally {
      setPendingAction(null);
    }
  }, [pendingAction, runtimeReady, shell, titlePending]);

  const editQueuedMessage = useCallback(async (
    message: ChatQueuedMessageProjection,
    content: ChatMessageContent,
  ) => {
    await mutateQueue(editQueuedMessageCommand({
      paneId: pane.id,
      expectedQueueRevision: pane.messageQueue.revision,
      messageId: message.id,
      expectedMessageRevision: message.revision,
      content,
    }));
  }, [mutateQueue, pane.id, pane.messageQueue.revision]);

  const removeQueuedMessage = useCallback((message: ChatQueuedMessageProjection) => {
    void mutateQueue(removeQueuedMessageCommand({
      paneId: pane.id,
      expectedQueueRevision: pane.messageQueue.revision,
      messageId: message.id,
      expectedMessageRevision: message.revision,
    })).catch(() => undefined);
  }, [mutateQueue, pane.id, pane.messageQueue.revision]);

  const resumeMessageQueue = useCallback(() => {
    void mutateQueue(resumeMessageQueueCommand({
      paneId: pane.id,
      expectedQueueRevision: pane.messageQueue.revision,
    })).catch(() => undefined);
  }, [mutateQueue, pane.id, pane.messageQueue.revision]);

  const startFreshProviderContext = useCallback(() => {
    void mutateQueue(startFreshProviderContextCommand({
      paneId: pane.id,
      expectedRevision: pane.revision,
      expectedQueueRevision: pane.messageQueue.revision,
    })).catch(() => undefined);
  }, [mutateQueue, pane.id, pane.messageQueue.revision, pane.revision]);

  const discardAmbiguousMessage = useCallback((message: ChatBlockedMessageProjection) => {
    void mutateQueue(discardAmbiguousMessageCommand({
      paneId: pane.id,
      expectedQueueRevision: pane.messageQueue.revision,
      messageId: message.id,
      expectedMessageRevision: message.revision,
    })).catch(() => undefined);
  }, [mutateQueue, pane.id, pane.messageQueue.revision]);

  const steerQueuedMessage = useCallback((message: ChatQueuedMessageProjection) => {
    if (!active || turn === null) return;
    void mutateQueue(steerQueuedMessageCommand({
      paneId: pane.id,
      expectedQueueRevision: pane.messageQueue.revision,
      messageId: message.id,
      expectedMessageRevision: message.revision,
      expectedTurnId: turn.id,
    })).catch(() => undefined);
  }, [active, mutateQueue, pane.id, pane.messageQueue.revision, turn]);

  const selectRepository = useCallback(async () => {
    if (!acceptsUserInteraction || !pristine || !configurable) return;
    setPendingAction("repository");
    setLocalError(null);
    try {
      const project = await shell.addProject();
      switch (project.status) {
        case "cancelled":
          return;
        case "failed":
          throw new PaneCommandError(project.error.message);
        case "created":
          await dispatchPaneMutationWithRetry(
            shell,
            pane.id,
            pane.revision,
            (expectedRevision) => selectPaneRepositoryCommand({
              paneId: pane.id,
              expectedRevision,
              repositoryId: project.repository.id,
            }),
          );
          return;
      }
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  }, [acceptsUserInteraction, configurable, pane.id, pane.revision, pristine, shell]);

  const remove = useCallback(async () => {
    if (!runtimeReady || active || pendingAction !== null || titlePending) return;
    setPendingAction("remove");
    setLocalError(null);
    try {
      const response = await shell.dispatch({
        type: "chat.pane.remove",
        paneId: pane.id,
        expectedRevision: pane.revision,
      });
      if (!response.ok) throw new PaneCommandError(response.error.message, response.error);
      if (response.result.type !== "chatPaneRemoved") {
        throw new PaneCommandError("The local runtime returned the wrong removal result.");
      }
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
      setPendingAction(null);
    }
  }, [active, pane.id, pane.revision, pendingAction, runtimeReady, shell, titlePending]);

  const stop = useCallback(async () => {
    if (
      !runtimeReady || !active || pane.interactionMode !== "chat" ||
      pane.turn === null || pendingAction !== null || titlePending
    ) return;
    setPendingAction("stop");
    setLocalError(null);
    try {
      const response = await shell.dispatch(stopTurnCommand({
        paneId: pane.id,
        expectedRevision: pane.revision,
        turnId: pane.turn.id,
      }));
      paneFromResponse(response, selectPane(shell.getState(), pane.id));
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  }, [active, pane.id, pane.interactionMode, pane.revision, pane.turn, pendingAction, runtimeReady, shell, titlePending]);

  const attentionMessage = pane.attention?.message ?? null;
  const composerError = localError ?? surface?.attachmentError ?? attentionMessage ?? workspaceStatus?.message ?? (
    runtimeAvailability.kind === "unavailable" ? runtimeAvailability.message : null
  );
  const accessibleStateLabel = composerError !== null && pane.state === "ready"
    ? "Needs attention"
    : paneStatusLabel(pane.state);
  const accessibleName = paneAccessibleName({
    gridPosition,
    kind: "local",
    ownerDeviceName: "This Mac",
    repositoryDisplayName: pane.repository.name,
    stateLabel: accessibleStateLabel,
    title: pane.title,
  });

  return (
    <section
      aria-busy={titlePending || undefined}
      aria-labelledby={paneLabelId}
      className="chat-pane"
      data-pane-activity={pane.activity.kind}
      data-pane-dragging={dragging ? "true" : undefined}
      data-pane-error={composerError === null ? undefined : "true"}
      data-pane-id={pane.id}
      data-pane-harness={paneHarness === null ? undefined : "true"}
      data-pane-interaction-mode={pane.interactionMode}
      data-pane-scheduled={pane.schedule === null ? undefined : "true"}
      data-pane-state={pane.state}
      onChangeCapture={fenceTitlePendingInteraction}
      onClickCapture={fenceTitlePendingInteraction}
      onFocusCapture={onActivateAnnouncement}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDownCapture={(event) => {
        onActivateAnnouncement();
        fenceTitlePendingInteraction(event);
      }}
      onSubmitCapture={fenceTitlePendingInteraction}
      style={paneIdentityStyle(pane.paletteIndex)}
    >
      <span className="hra-visually-hidden" id={paneLabelId}>
        {accessibleName}
      </span>
      <span className="hra-visually-hidden" id={transcriptLabelId}>
        Transcript for {pane.title}
      </span>
      <header
        className="chat-pane__header"
        draggable={draggable || undefined}
        onDragEnd={onDragEnd}
        onDragStart={onDragStart}
      >
        <div className="chat-pane__identity">
          <div className="chat-pane__title-row">
            <InlinePaneTitle
              editable={titleEditable}
              editRequest={titleEditRequest}
              onCommit={commitTitle}
              onPendingChange={onTitlePendingChange}
              paneId={pane.id}
              revision={pane.revision}
              title={pane.title}
            />
          </div>
          <div className="chat-pane__repository-row">
            {acceptsUserInteraction && pristine ? (
              <IconButton
                aria-label={`Choose project for ${pane.title}`}
                className="pane-project-shell"
                controlClassName="pane-project"
                isDisabled={!configurable}
                isPending={pendingAction === "repository"}
                onPress={() => void selectRepository()}
                size="compact"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="folder" />
              </IconButton>
            ) : null}
            {workspaceStatus?.retryable === true ? (
              <IconButton
                aria-label={`Recover isolated workspace for ${pane.title}`}
                className="pane-project-shell"
                controlClassName="pane-project"
                isDisabled={!configurable}
                isPending={pendingAction === "workspace"}
                onPress={() => void recoverWorkspace()}
                size="compact"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="rollback" />
              </IconButton>
            ) : null}
            <span className="chat-pane__repository">{pane.repository.name}</span>
            <ScheduledChatStatus
              {...(surface?.nowUnixMilliseconds === undefined
                ? {}
                : { nowUnixMilliseconds: surface.nowUnixMilliseconds })}
              schedule={pane.schedule}
            />
          </div>
        </div>
        <div className="chat-pane__header-actions">
          <MenuTrigger>
              <IconButton
                aria-label={`More actions for ${pane.title}`}
                className="pane-menu-shell"
                controlClassName="pane-menu"
                isDisabled={!runtimeReady || pendingAction !== null || titlePending}
                size="compact"
                tooltip={`More actions for ${pane.title}`}
                type="button"
                variant="quiet"
              >
                <HRAIcon name="more" />
              </IconButton>
              <Menu
                aria-label={`Actions for ${pane.title}`}
                disabledKeys={[
                  ...(!titleEditable ? ["rename"] : []),
                  ...(!canMoveEarlier || reorderPending ? ["move-earlier"] : []),
                  ...(!canMoveLater || reorderPending ? ["move-later"] : []),
                  ...(pane.interactionMode === "chat" && active ? ["close"] : []),
                ]}
                onAction={(key) => {
                  if (key === "rename") {
                    setTitleEditRequest((request) => request + 1);
                  } else if (key === "move-earlier") onMoveEarlier();
                  else if (key === "move-later") onMoveLater();
                  else if (key === "close" && pane.interactionMode === "chat") void remove();
                }}
              >
                <MenuItem id="rename" textValue="Rename pane">
                  Rename pane
                </MenuItem>
                <MenuItem id="move-earlier" textValue="Move earlier">
                  Move earlier
                </MenuItem>
                <MenuItem id="move-later" textValue="Move later">
                  Move later
                </MenuItem>
                {pane.interactionMode === "chat" ? (
                  <MenuItem id="close" textValue="Close pane" variant="danger">
                    Close pane
                  </MenuItem>
                ) : null}
              </Menu>
            </MenuTrigger>
        </div>
      </header>

      <div
        aria-labelledby={transcriptLabelId}
        className="chat-pane__transcript"
        onScroll={onScroll}
        ref={transcriptRef}
        role={announcementActive ? "log" : undefined}
        aria-live={announcementActive ? "polite" : undefined}
      >
        {turn === null ? null : <TurnActivity pane={pane} />}
      </div>

      {!composerCanDraft && composerError !== null ? (
        <p
          aria-atomic="true"
          className="pane-error"
          id={composerErrorId}
          role="alert"
        >
          {composerError}
        </p>
      ) : null}
      {pane.interactionMode !== "chat" ? null : <footer className="chat-pane__composer">
        {descendants === null && turn?.providerSubagents.agents.length === 0 &&
            turn.providerSubagents.overflowCount === 0 ? null : (
          <ActiveSubagentStack
            children={descendants?.children ?? []}
            provider={turn?.providerSubagents ?? { agents: [], overflowCount: 0 }}
          />
        )}
        <QueuedMessageStack
          discardAmbiguousDisabled={active}
          disabled={pendingAction !== null || titlePending || !runtimeReady}
          onDiscardAmbiguous={discardAmbiguousMessage}
          onEdit={editQueuedMessage}
          onRemove={removeQueuedMessage}
          {...(pane.canStartFreshContext === true
            ? { onStartFresh: startFreshProviderContext }
            : pane.state === "attention" &&
                pane.attention?.code === "runtime_unavailable" &&
                pane.attention.retryable === false
              ? {}
              : { onResume: resumeMessageQueue })}
          {...(!active || turn === null ? {} : { onSteerHead: steerQueuedMessage })}
          queue={pane.messageQueue}
        />
        {!composerCanDraft || composerError === null ? null : (
          <p
            aria-atomic="true"
            className="pane-error"
            id={composerErrorId}
            role="alert"
          >
            {composerError}
          </p>
        )}
        {!showComposerForm ? null : <form
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void send(false);
          }}
        >
          <CompactComposerBar
            attachments={scheduling ? [] : surface?.attachments ?? []}
            {...(scheduling || surface?.onAttachFiles === undefined
              ? {}
              : { onAttachFiles: surface.onAttachFiles })}
            {...(scheduling || surface?.onRemoveAttachment === undefined
              ? {}
              : { onRemoveAttachment: surface.onRemoveAttachment })}
            left={(
              <ScheduleModeToggle
                disabled={!configurable}
                onChange={(selected) => void toggleScheduleMode(selected)}
                selected={scheduling}
              />
            )}
            right={(
              <>
                <TurnElapsed
                  {...(surface?.nowUnixMilliseconds === undefined
                    ? {}
                    : { nowUnixMilliseconds: surface.nowUnixMilliseconds })}
                  turn={turn}
                />
                {active && turn !== null ? (
                  <IconButton
                    aria-label={`Stop ${pane.title}`}
                    controlClassName="pane-stop"
                    isDisabled={!runtimeReady || pendingAction !== null || titlePending}
                    isPending={pendingAction === "stop"}
                    onPress={() => void stop()}
                    size="compact"
                    type="button"
                    variant="quiet"
                  >
                    <HRAIcon name="stop" />
                  </IconButton>
                ) : null}
                <IconButton
                  aria-label={scheduling
                    ? pendingAction === "schedule"
                      ? `Updating schedule for ${pane.title}`
                      : `${pane.schedule === null ? "Schedule" : "Update schedule for"} ${pane.title}`
                    : pendingAction === "send"
                      ? `${active ? "Queueing" : "Sending"} message for ${pane.title}`
                      : `${active ? "Queue" : "Send"} message for ${pane.title}`}
                  controlClassName="pane-send"
                  isDisabled={
                    !runtimeReady
                    || (scheduling ? !scheduleCanDraft : !composerCanDraft)
                    || pendingAction !== null
                    || titlePending
                    || (
                      prompt.trim().length === 0 &&
                      (scheduling ||
                        (surface?.attachments.filter(({ status }) => status === "ready").length ?? 0) === 0)
                    )
                  }
                  size="compact"
                  type="submit"
                  variant="quiet"
                >
                  <HRAIcon name={scheduling ? "clock" : "send"} />
                </IconButton>
              </>
            )}
          >
            <TextAreaField
              className="pane-prompt-field"
              isDisabled={
                !runtimeReady
                || (scheduling ? !scheduleCanDraft : !composerCanDraft)
                || pendingAction !== null
                || titlePending
              }
              label={scheduling ? `Schedule ${pane.title}` : `Message ${pane.title}`}
              onChange={(value) => {
                if (value !== prompt) {
                  draftMessageIdRef.current = createMessageId();
                  frozenComposerRequestRef.current = null;
                }
                setPrompt(value);
                if (localError !== null) setLocalError(null);
              }}
              resize="none"
              showLabel={false}
              size="compact"
              surface="pane"
              textAreaClassName="pane-prompt"
              textAreaProps={{
                "aria-describedby": composerError === null ? undefined : composerErrorId,
                "aria-invalid": localError === null ? undefined : true,
                id: `prompt-${pane.id}`,
                maxLength: runtimeChatMessageUtf8ByteLimit,
                onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                  if (scheduling) {
                    const action = composerEnterAction({
                      isComposing: event.nativeEvent.isComposing,
                      key: event.key,
                      shiftKey: event.shiftKey,
                    });
                    if (action !== "submit") return;
                    event.preventDefault();
                    void send(false);
                    return;
                  }
                  const action = composerSubmissionAction({
                    isComposing: event.nativeEvent.isComposing,
                    key: event.key,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    active,
                    hasQueuedHead: pane.messageQueue.messages.length > 0,
                  });
                  if (action === "none") return;
                  event.preventDefault();
                  const steerModifier = event.metaKey || event.ctrlKey;
                  const queuedHead = pane.messageQueue.messages[0];
                  if (action === "steerQueuedHead" && queuedHead !== undefined) {
                    steerQueuedMessage(queuedHead);
                    return;
                  }
                  void send(steerModifier);
                },
                onPaste: scheduling
                  ? undefined
                  : (event) => capturePastedImages(event, surface?.onAttachFiles),
                rows: 2,
              }}
              value={prompt}
            />
          </CompactComposerBar>
        </form>}
      </footer>}
    </section>
  );
}

export interface ChatPaneProps {
  readonly announcementActive?: boolean;
  readonly canMoveEarlier?: boolean;
  readonly canMoveLater?: boolean;
  readonly draggable?: boolean;
  readonly dragging?: boolean;
  readonly gridPosition: number;
  readonly onActivateAnnouncement?: () => void;
  readonly onDragEnd?: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDragOver?: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDragStart?: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDrop?: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onMoveEarlier?: () => void;
  readonly onMoveLater?: () => void;
  readonly paneId: string;
  readonly reorderPending?: boolean;
  readonly shell: RuntimeShell;
  readonly surface?: CompactChatPaneSurface;
}

function ChatPaneContainer({
  announcementActive,
  canMoveEarlier = false,
  canMoveLater = false,
  draggable = false,
  dragging = false,
  gridPosition,
  onActivateAnnouncement,
  onDragEnd = () => undefined,
  onDragOver = () => undefined,
  onDragStart = () => undefined,
  onDrop = () => undefined,
  onMoveEarlier = () => undefined,
  onMoveLater = () => undefined,
  paneId,
  reorderPending = false,
  shell,
  surface,
}: ChatPaneProps) {
  const selector = useMemo(
    () => (state: Parameters<typeof selectPane>[0]) => selectPane(state, paneId),
    [paneId],
  );
  const pane = useRuntimeShellSelector(shell, selector);
  const liveAttachmentSurface = useLiveChatAttachments({
    enabled: surface === undefined,
    pane,
    shell,
  });
  const resolvedSurface = surface ?? liveAttachmentSurface;
  return pane === null
    ? null
    : <ChatPaneView
        announcementActive={announcementActive ?? false}
        canMoveEarlier={canMoveEarlier}
        canMoveLater={canMoveLater}
        draggable={draggable}
        dragging={dragging}
        gridPosition={gridPosition}
        onActivateAnnouncement={onActivateAnnouncement ?? (() => undefined)}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragStart={onDragStart}
        onDrop={onDrop}
        onMoveEarlier={onMoveEarlier}
        onMoveLater={onMoveLater}
        pane={pane}
        reorderPending={reorderPending}
        shell={shell}
        {...(resolvedSurface === undefined ? {} : { surface: resolvedSurface })}
      />;
}

export const ChatPane = memo(ChatPaneContainer);
ChatPane.displayName = "ChatPane";
