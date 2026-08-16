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
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuTrigger,
  TextAreaField,
  TextField,
  ToggleButton,
} from "../../ui";

import {
  runtimeChatTurnPromptUtf8ByteLimit,
  type ChatPaneProjection,
  type ChatReasoningEffort,
  type ChatServiceTier,
  type ChatToolCategory,
  type HarnessChildProjection,
  type RuntimeChatDomainCommand,
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
  composerEnterAction,
  configurePaneCommand,
  createTitleDebouncer,
  createTurnId,
  isRevisionConflict,
  normalizePaneTitle,
  openHarnessChildCommand,
  paneAccessibleName,
  paneCanCompose,
  paneCanRename,
  paneCanRetryRetainedPrompt,
  paneIsActive,
  paneStatusLabel,
  paneWorkspaceStatus,
  paneTitleBlurAction,
  paneTitleErrorId,
  paneTitleUtf16CodeUnitLimit,
  reconcilePaneTitleCommit,
  renamePaneCommand,
  resolvePaneRevisionConflict,
  runtimeAvailabilityEqual,
  selectRuntimeAvailability,
  selectPane,
  selectPaneCanMessage,
  selectPaneRepositoryCommand,
  retryTurnCommand,
  stopHarnessChildCommand,
  stopTurnCommand,
  startTurnCommand,
  titleCommitFailureShouldRefocus,
  toolCategoryLabel,
  validatedPrompt,
  type ScheduledTitleCommit,
  type TitleDebouncer,
} from "./model";

class PaneCommandError extends Error {
  readonly runtimeError: RuntimeError | null;

  constructor(message: string, runtimeError: RuntimeError | null = null) {
    super(message);
    this.name = "PaneCommandError";
    this.runtimeError = runtimeError;
  }
}

function commandErrorMessage(reason: unknown): string {
  if (reason instanceof PaneCommandError) return reason.message;
  return reason instanceof Error
    ? reason.message
    : "The local runtime did not complete the request.";
}

function paneFromResponse(response: RuntimeDispatchResponse): ChatPaneProjection {
  if (!response.ok) throw new PaneCommandError(response.error.message, response.error);
  if (response.result.type !== "chatPane") {
    throw new PaneCommandError("The local runtime returned the wrong pane result.");
  }
  return response.result.pane;
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
    if (response.ok) return paneFromResponse(response);
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

export function dispatchRetainedPromptRetry(
  shell: PaneRetryMutationPort,
  pane: ChatPaneProjection,
  turnId: NonNullable<ChatPaneProjection["turn"]>["id"],
): Promise<ChatPaneProjection> {
  const priorFailedTurnId = pane.turn?.id;
  if (!paneCanRetryRetainedPrompt(pane) || priorFailedTurnId === undefined) {
    return Promise.reject(new PaneCommandError(
      "This pane no longer has the exact failed message available to retry.",
    ));
  }
  return dispatchPaneMutationWithRetry(
    shell,
    pane.id,
    pane.revision,
    (expectedRevision) => retryTurnCommand({
      paneId: pane.id,
      expectedRevision,
      priorFailedTurnId,
      turnId,
    }),
    (current) => paneCanRetryRetainedPrompt(current) &&
      current.turn?.id === priorFailedTurnId,
  );
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
    if (response.ok) return paneFromResponse(response);
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
            if (event.key === "Escape") {
              event.preventDefault();
              finishInvalidEdit();
            } else if (event.key === "Enter") {
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

interface ModelToggleProps {
  readonly disabled: boolean;
  readonly onChange: (effort: ChatReasoningEffort) => void;
  readonly value: ChatReasoningEffort;
}

function ModelToggle({ disabled, onChange, value }: ModelToggleProps) {
  return (
    <div aria-label="Sol reasoning effort" className="model-toggle" role="group">
      {(["ultra", "max"] as const).map((effort) => (
        <ToggleButton
          className="model-toggle__option-shell"
          controlClassName="model-toggle__option"
          isDisabled={disabled}
          isSelected={value === effort}
          key={effort}
          onPress={() => onChange(effort)}
          size="compact"
          variant="quiet"
        >
          {effort === "ultra" ? "Ultra" : "Max"}
        </ToggleButton>
      ))}
    </div>
  );
}

interface FastModeToggleProps {
  readonly disabled: boolean;
  readonly onChange: (tier: ChatServiceTier) => void;
  readonly value: ChatServiceTier;
}

function FastModeToggle({ disabled, onChange, value }: FastModeToggleProps) {
  const fast = value === "fast";
  return (
    <ToggleButton
      aria-label={`${fast ? "Disable" : "Enable"} Fast mode; Fast uses more credits`}
      className="fast-mode-toggle-shell"
      controlClassName="fast-mode-toggle"
      isDisabled={disabled}
      isSelected={fast}
      onPress={() => onChange(fast ? "standard" : "fast")}
      size="compact"
      variant="quiet"
    >
      Fast
    </ToggleButton>
  );
}

function toolCategoryIcon(category: ChatToolCategory) {
  switch (category) {
    case "command":
      return "command" as const;
    case "filesystem":
      return "folder" as const;
    case "network":
      return "network" as const;
    case "search":
      return "search" as const;
    case "other":
      return "sparkle" as const;
  }
}

function TurnActivity({ pane }: { readonly pane: ChatPaneProjection }) {
  const turn = pane.turn;
  if (turn === null) return null;
  const active = paneIsActive(pane.state);
  const latestTool = turn.tools.at(-1) ?? null;
  const hasActivity = turn.reasoningSummary.tail.length > 0 ||
    turn.tools.length > 0 || turn.responseMarkdown.tail.length > 0;

  return (
    <>
      {active && turn.reasoningSummary.tail.length > 0 ? (
        <section className="pane-reasoning" aria-label="Thinking">
          <div aria-hidden="true" className="pane-activity-label">
            <span className="activity-pulse" aria-hidden="true" />
          </div>
          {turn.reasoningSummary.truncatedPrefix ? (
            <p className="pane-truncation">Earlier thinking was omitted.</p>
          ) : null}
          <p>{turn.reasoningSummary.tail}</p>
        </section>
      ) : null}
      {active && latestTool !== null ? (
        <div
          aria-label={`Latest tool: ${toolCategoryLabel(latestTool.category)}, ${latestTool.status === "running" ? "running" : "done"}`}
          className="pane-tool"
          data-status={latestTool.status}
        >
          <HRAIcon name={toolCategoryIcon(latestTool.category)} />
          <span aria-hidden="true" className="tool-status-spinner" />
        </div>
      ) : null}
      {turn.responseMarkdown.tail.length > 0 ? (
        <article aria-label="Latest response" className="pane-response">
          <MarkdownResponse content={turn.responseMarkdown} streaming={active} />
        </article>
      ) : null}
      {active && !hasActivity ? (
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
  const [pendingAction, setPendingAction] = useState<
    "configure" | "harness" | "remove" | "repository" | "retry" | "send" | "stop" | null
  >(null);
  const [harnessPanelOpen, setHarnessPanelOpen] = useState(false);
  const [pendingHarnessChildId, setPendingHarnessChildId] = useState<string | null>(null);
  const [titlePending, setTitlePending] = useState(false);
  const [titleEditRequest, setTitleEditRequest] = useState(0);
  const titlePendingRef = useRef(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const active = paneIsActive(pane.state);
  const acceptsUserInteraction = paneAcceptsUserInteraction(pane);
  const paneHarness = pane.harness ?? null;
  const descendants = paneHarness?.descendants ?? null;
  const runtimeReady = runtimeAvailability.kind === "ready";
  const configurable = runtimeReady
    && acceptsUserInteraction
    && paneCanCompose(pane.state)
    && pendingAction === null
    && !titlePending;
  const titleEditable = runtimeReady
    && paneCanRename(pane.state)
    && pendingAction === null;
  const turn = pane.turn;
  const canRetryRetainedPrompt = paneCanRetryRetainedPrompt(pane);
  const pristine = turn === null;
  const scrollKey = [
    pane.state,
    turn?.reasoningSummary.totalUtf8Bytes ?? 0,
    turn?.responseMarkdown.totalUtf8Bytes ?? 0,
    turn?.tools.map(({ id, status }) => `${id}:${status}`).join(",") ?? "",
  ].join(":");
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

  const configure = useCallback(async (configuration: Readonly<{
    reasoningEffort: ChatReasoningEffort;
    serviceTier: ChatServiceTier;
  }>) => {
    if (!configurable) return;
    setPendingAction("configure");
    setLocalError(null);
    try {
      await dispatchPaneMutationWithRetry(
        shell,
        pane.id,
        pane.revision,
        (expectedRevision) => configurePaneCommand({
          paneId: pane.id,
          expectedRevision,
          ...configuration,
        }),
      );
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  }, [configurable, pane.id, pane.revision, shell]);

  const recoverWorkspace = useCallback(() => {
    if (workspaceStatus?.retryable !== true) return;
    void configure({
      reasoningEffort: pane.reasoningEffort,
      serviceTier: pane.serviceTier,
    });
  }, [configure, pane.reasoningEffort, pane.serviceTier, workspaceStatus]);

  const send = useCallback(async () => {
    if (
      !runtimeReady
      || !canMessage
      || !paneCanCompose(pane.state)
      || pendingAction !== null
      || titlePending
    ) return;
    const validation = validatedPrompt(prompt);
    if (!validation.ok) {
      setLocalError(validation.message);
      return;
    }
    const turnId = createTurnId();
    setPendingAction("send");
    setLocalError(null);
    try {
      await dispatchPaneMutationWithRetry(
        shell,
        pane.id,
        pane.revision,
        (expectedRevision) => startTurnCommand({
          paneId: pane.id,
          expectedRevision,
          turnId,
          prompt: validation.prompt,
        }),
      );
      setPrompt("");
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  }, [canMessage, pane.id, pane.revision, pane.state, pendingAction, prompt, runtimeReady, shell, titlePending]);

  const retryRetainedPrompt = useCallback(async () => {
    if (
      !runtimeReady || !canMessage || !paneCanRetryRetainedPrompt(pane) ||
      pendingAction !== null || titlePending
    ) return;
    const turnId = createTurnId();
    setPendingAction("retry");
    setLocalError(null);
    try {
      await dispatchRetainedPromptRetry(shell, pane, turnId);
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  }, [canMessage, pane, pendingAction, runtimeReady, shell, titlePending]);

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
      paneFromResponse(response);
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  }, [active, pane.id, pane.interactionMode, pane.revision, pane.turn, pendingAction, runtimeReady, shell, titlePending]);

  const runChildAction = useCallback(async (
    child: HarnessChildProjection,
    action: "open" | "stop",
  ) => {
    if (!runtimeReady || pendingAction !== null || titlePending) return;
    setPendingAction("harness");
    setPendingHarnessChildId(child.id);
    setLocalError(null);
    try {
      const response = await shell.dispatch(action === "open"
        ? openHarnessChildCommand({
            parentPaneId: pane.id,
            childId: child.id,
            expectedParentRevision: pane.revision,
            expectedChildRevision: child.revision,
          })
        : stopHarnessChildCommand({
            parentPaneId: pane.id,
            childId: child.id,
            expectedParentRevision: pane.revision,
            expectedChildRevision: child.revision,
          }));
      if (!response.ok) throw new PaneCommandError(response.error.message, response.error);
    } catch (reason: unknown) {
      setLocalError(commandErrorMessage(reason));
    } finally {
      setPendingHarnessChildId(null);
      setPendingAction(null);
    }
  }, [pane.id, pane.revision, pendingAction, runtimeReady, shell, titlePending]);

  const attentionMessage = pane.attention?.message ?? null;
  const composerError = localError ?? attentionMessage ?? workspaceStatus?.message ?? (
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
      data-pane-harness-panel={harnessPanelOpen && paneHarness !== null ? "true" : undefined}
      data-pane-interaction-mode={pane.interactionMode}
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
            {descendants === null ? null : (
              <IconButton
                aria-label={`${harnessPanelOpen ? "Hide" : "Show"} ${descendants.count} recursive ${descendants.count === 1 ? "session" : "sessions"} for ${pane.title}`}
                aria-expanded={harnessPanelOpen}
                className="pane-harness-button-shell"
                controlClassName="pane-harness-button"
                isDisabled={titlePending}
                onPress={() => setHarnessPanelOpen((open) => !open)}
                size="compact"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="branch" />
                <span aria-hidden="true">{descendants.count}</span>
              </IconButton>
            )}
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
                isPending={pendingAction === "configure"}
                onPress={recoverWorkspace}
                size="compact"
                type="button"
                variant="quiet"
              >
                <HRAIcon name="rollback" />
              </IconButton>
            ) : null}
            <span className="chat-pane__repository">{pane.repository.name}</span>
          </div>
        </div>
        <div className="chat-pane__header-actions">
          {pane.interactionMode === "chat" && active && turn !== null ? (
            <IconButton
              aria-label={`Stop ${pane.title}`}
              className="pane-stop-shell"
              controlClassName="pane-stop"
              isDisabled={!runtimeReady || pendingAction !== null || titlePending}
              isPending={pendingAction === "stop"}
              onPress={() => void stop()}
              size="compact"
              tooltip={`Stop ${pane.title}`}
              type="button"
              variant="quiet"
            >
              <HRAIcon name="stop" />
            </IconButton>
          ) : null}
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
                  ...(pane.interactionMode === "harnessObserver" && !titleEditable
                    ? ["rename"]
                    : []),
                  ...(!canMoveEarlier || reorderPending ? ["move-earlier"] : []),
                  ...(!canMoveLater || reorderPending ? ["move-later"] : []),
                  ...(pane.interactionMode === "chat" && active ? ["close"] : []),
                ]}
                onAction={(key) => {
                  if (key === "rename" && pane.interactionMode === "harnessObserver") {
                    setTitleEditRequest((request) => request + 1);
                  } else if (key === "move-earlier") onMoveEarlier();
                  else if (key === "move-later") onMoveLater();
                  else if (key === "close" && pane.interactionMode === "chat") void remove();
                }}
              >
                {pane.interactionMode === "harnessObserver" ? (
                  <MenuItem id="rename" textValue="Rename pane">
                    Rename pane
                  </MenuItem>
                ) : null}
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

      {!harnessPanelOpen || paneHarness === null ? null : (
        <div className="pane-harness-panel">
          {descendants === null ? null : (
            <ul aria-label={`Recursive sessions for ${pane.title}`}>
              {descendants.children.map((child) => (
                <li key={child.id}>
                  <span className="pane-harness-child-title">{child.title}</span>
                  <span className="pane-harness-child-state">{child.state}</span>
                  <span className="pane-harness-child-actions">
                    <IconButton
                      aria-label={`Open ${child.title}`}
                      controlClassName="pane-harness-icon-button"
                      isDisabled={
                        !runtimeReady || pendingAction !== null || titlePending ||
                        !child.canOpen
                      }
                      isPending={pendingHarnessChildId === child.id && pendingAction === "harness"}
                      onPress={() => void runChildAction(child, "open")}
                      size="compact"
                      type="button"
                      variant="quiet"
                    >
                      <HRAIcon name="open" />
                    </IconButton>
                    <IconButton
                      aria-label={`Stop ${child.title}`}
                      controlClassName="pane-harness-icon-button"
                      isDisabled={
                        !runtimeReady || pendingAction !== null || titlePending || !child.canStop
                      }
                      isPending={pendingHarnessChildId === child.id && pendingAction === "harness"}
                      onPress={() => void runChildAction(child, "stop")}
                      size="compact"
                      type="button"
                      variant="quiet"
                    >
                      <HRAIcon name="stop" />
                    </IconButton>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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

      {!canMessage && composerError !== null ? (
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
        {!canMessage || composerError === null ? null : (
          <p
            aria-atomic="true"
            className="pane-error"
            id={composerErrorId}
            role="alert"
          >
            {composerError}
          </p>
        )}
        {!canMessage ? null : <form
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void send();
          }}
        >
          <TextAreaField
            className="pane-prompt-field"
            isDisabled={!runtimeReady || active || pendingAction === "send" || pendingAction === "retry" || titlePending}
            label={`Message ${pane.title}`}
            onChange={(value) => {
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
              maxLength: runtimeChatTurnPromptUtf8ByteLimit,
              onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                const action = composerEnterAction({
                  isComposing: event.nativeEvent.isComposing,
                  key: event.key,
                  shiftKey: event.shiftKey,
                });
                if (action !== "submit") return;
                event.preventDefault();
                void send();
              },
              rows: 2,
            }}
            value={prompt}
          />
          {canRetryRetainedPrompt ? (
            <IconButton
              aria-label={pendingAction === "retry"
                ? `Retrying failed message for ${pane.title}`
                : `Retry failed message for ${pane.title}`}
              className="pane-retry-shell"
              controlClassName="pane-retry"
              isDisabled={!runtimeReady || pendingAction !== null || titlePending}
              onPress={() => void retryRetainedPrompt()}
              size="compact"
              type="button"
              variant="quiet"
            >
              <HRAIcon
                className={pendingAction === "retry"
                  ? "hra-icon pane-retry__icon--pending"
                  : "hra-icon"}
                name="refresh"
              />
            </IconButton>
          ) : null}
          <IconButton
            aria-label={pendingAction === "send" ? `Sending message to ${pane.title}` : `Send message to ${pane.title}`}
            className="pane-send-shell"
            controlClassName="pane-send"
            isDisabled={
              !runtimeReady
              || active
              || pendingAction !== null
              || titlePending
              || prompt.trim().length === 0
            }
            size="compact"
            type="submit"
            variant="quiet"
          >
            <HRAIcon name="send" />
          </IconButton>
        </form>}
        <div className="chat-pane__controls">
          <Button
            aria-label={`Rename ${pane.title}`}
            className="pane-rename-shell"
            controlClassName="pane-rename"
            isDisabled={!titleEditable}
            onPress={() => setTitleEditRequest((request) => request + 1)}
            size="compact"
            type="button"
            variant="quiet"
          >
            <HRAIcon name="edit" />
            <span>Rename</span>
          </Button>
          <div className="pane-model-controls">
            <ModelToggle
              disabled={!configurable}
              onChange={(reasoningEffort) => void configure({
                reasoningEffort,
                serviceTier: pane.serviceTier,
              })}
              value={pane.reasoningEffort}
            />
            <FastModeToggle
              disabled={!configurable}
              onChange={(serviceTier) => void configure({
                reasoningEffort: pane.reasoningEffort,
                serviceTier,
              })}
              value={pane.serviceTier}
            />
          </div>
        </div>
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
}: ChatPaneProps) {
  const selector = useMemo(
    () => (state: Parameters<typeof selectPane>[0]) => selectPane(state, paneId),
    [paneId],
  );
  const pane = useRuntimeShellSelector(shell, selector);
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
      />;
}

export const ChatPane = memo(ChatPaneContainer);
ChatPane.displayName = "ChatPane";
