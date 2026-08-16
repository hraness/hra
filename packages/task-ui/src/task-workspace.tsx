"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  taskPrioritySchema,
  taskTypeValues,
  type PortableRunInteractionResponse as RunInteractionResponse,
  type PortableRunProjection as TaskRunView,
  type RunInteractionProjection as RunInteractionView,
  type SubmissionEvidenceInput,
  type TaskPriority,
  type TaskReferenceInput,
  type TaskReferenceView,
  type TaskStatus,
  type TaskType,
  type TaskView,
} from "@hraness/agent-tasks-domain";
import type { RunnerPresenceView } from "@hraness/agent-tasks-protocol";
import {
  Button,
  CheckboxField,
  Disclosure,
  DialogTrigger,
  EmptyState as DesignEmptyState,
  Icon,
  IconButton,
  InlineAlert,
  ListBox,
  ListBoxItem,
  Modal,
  PageIntro,
  PressableCard,
  SelectField,
  Spinner,
  TextAreaField,
  TextField,
} from "@hra-internal/design-kit/react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  type CreateTaskInput,
  type TaskWorkspaceActionResult,
  type TaskWorkspaceActor,
  type TaskWorkspaceDetail,
  type TaskWorkspaceError,
  type TaskWorkspaceGraphEdge,
  type TaskWorkspaceLink,
  type TaskWorkspaceListItem,
  type RunInteractionQuestionDraft,
  type TaskWorkspaceProps,
  type TaskWorkspaceRecoveryKind,
  type TaskWorkspaceSubmission,
  type UpdateTaskInput,
  actorLabel,
  detailRecoveryKinds,
  elapsedTaskTime,
  effectiveRunnerPresence,
  initialTaskWorkspaceUiState,
  safeHttpsUrl,
  setRunInteractionOption,
  setRunInteractionOtherText,
  prioritizeTasksNeedingInput,
  taskTranscriptMessages,
  taskWorkspaceErrorCopy,
  taskWorkspaceRecoveryGuidance,
  taskWorkspaceReducer,
  taskWorkspaceViewLabels,
  taskWorkspaceViews,
} from "./task-workspace-state";

type ExecuteAction = (
  label: string,
  action: () => Promise<TaskWorkspaceActionResult>,
) => Promise<TaskWorkspaceActionResult>;

const pendingOperationLabels = {
  acceptSubmission: "Accept submission",
  cancelTask: "Cancel task",
  createTask: "Create task",
  rejectSubmission: "Reject submission",
  reopenTask: "Reopen task",
  resolveAmbiguousRun: "Resolve ambiguous run",
  stopRun: "Stop run",
  updateTask: "Update task",
} as const;

const priorityLabels: Readonly<Record<TaskPriority, string>> = {
  0: "Urgent",
  1: "High",
  2: "Normal",
  3: "Low",
  4: "Someday",
};

function timestamp(value: number): { dateTime: string; label: string } | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  };
}

function Time({ value }: { value: number }) {
  const formatted = timestamp(value);
  return formatted === null ? (
    <span>Unknown time</span>
  ) : (
    <time dateTime={formatted.dateTime}>{formatted.label}</time>
  );
}

function RelativeLease({ now, until }: { now: number; until: number }) {
  const remaining = until - now;
  if (remaining <= 0) return <span className="task-lease-expired">Expired</span>;
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return <span>{minutes}m remaining</span>;
}

function Actor({ actor }: { actor: TaskWorkspaceActor }) {
  const suffix = actor.kind === "agent" && actor.status === "disabled" ? " · disabled" : "";
  return (
    <span className={`task-actor task-actor--${actor.kind}`}>
      <span aria-hidden="true" />
      {actorLabel(actor)}{suffix}
    </span>
  );
}

function TaskStatusPill({ status }: { status: TaskStatus }) {
  return <span className={`task-status task-status--${status}`}>{status.replaceAll("_", " ")}</span>;
}

function Priority({ priority }: { priority: TaskPriority }) {
  return (
    <span className={`task-priority task-priority--${priority}`} title={`${priorityLabels[priority]} priority`}>
      <span aria-hidden="true">P{priority}</span>
      <span className="jungle-visually-hidden">{priorityLabels[priority]} priority</span>
    </span>
  );
}

function ErrorState({ error, title }: { error: TaskWorkspaceError; title: string }) {
  return (
    <div className="task-inline-state-region" role="alert">
      <InlineAlert className="task-inline-state task-inline-state--error" title={title} tone="danger">
        <p>{taskWorkspaceErrorCopy(error.code)}</p>
        <small>
          {error.code}
          {error.reference === undefined ? "" : ` · Reference ${error.reference}`}
        </small>
      </InlineAlert>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="task-inline-state" role="status">
      <Spinner aria-hidden="true" size="small" />
      <span>{label}</span>
    </div>
  );
}

const runnerPresenceCopy = {
  offline: {
    label: "Runner offline",
    detail: "Tasks stay queued until a runner reconnects.",
  },
  blocked: {
    label: "Runner needs setup",
    detail: "Connect an account and project before running work.",
  },
  ready: {
    label: "Runner ready",
    detail: "A connected Codex account can accept work.",
  },
  busy: {
    label: "Runner busy",
    detail: "New work will queue behind the active Codex runs.",
  },
  draining: {
    label: "Runner draining",
    detail: "The runner is finishing active work without accepting another task.",
  },
} as const;

function RunnerPresence({ now, presence }: { now: number; presence: RunnerPresenceView }) {
  const effective = effectiveRunnerPresence(presence, now);
  const copy = runnerPresenceCopy[effective.state];
  return (
    <div className={`task-runner-presence task-runner-presence--${effective.state}`} role="status">
      <span aria-hidden="true" className="task-runner-presence__dot" />
      <strong>{copy.label}</strong>
      <span className="jungle-visually-hidden">{copy.detail}</span>
    </div>
  );
}

function EmptyState({ children, title }: { children: ReactNode; title: string }) {
  return (
    <DesignEmptyState
      className="task-empty-state"
      description={children}
      icon="∅"
      title={title}
    />
  );
}

function Notice({
  notice,
  onDismiss,
}: {
  notice: ReturnType<typeof taskWorkspaceReducer>["notice"];
  onDismiss: () => void;
}) {
  if (notice === null) return null;
  if (notice.kind === "success") {
    return <p className="jungle-visually-hidden" role="status">Done.</p>;
  }
  return (
    <div
      className="task-notice task-notice--error"
      role="alert"
    >
      <span>
        {taskWorkspaceErrorCopy(notice.error.code)}
      </span>
      <IconButton
        aria-label="Dismiss command notice"
        onPress={onDismiss}
        size="compact"
        tooltip="Dismiss notice"
      >
        <Icon icon={Cancel01Icon} />
      </IconButton>
    </div>
  );
}

function RecoveryCallouts({ kinds }: { kinds: readonly TaskWorkspaceRecoveryKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <aside aria-label="Recovery guidance" className="task-recovery-stack">
      {kinds.map((kind) => {
        const guidance = taskWorkspaceRecoveryGuidance[kind];
        return (
          <div className={`task-recovery task-recovery--${kind}`} key={kind} role="note">
            <span aria-hidden="true">!</span>
            <div>
              <strong>{guidance.title}</strong>
              <p>{guidance.body}</p>
            </div>
          </div>
        );
      })}
    </aside>
  );
}

function taskAvailability(task: TaskView, now: number): string {
  if (task.status === "cancelled") return "Cancelled";
  if (task.cancelledBlockerCount > 0) return "Needs attention";
  if (task.unresolvedBlockerCount > 0) return `${task.unresolvedBlockerCount} blocker${task.unresolvedBlockerCount === 1 ? "" : "s"}`;
  if (task.availableAt > now) return "Deferred";
  if (task.status === "in_review") return "Review pending";
  if (task.isReady) return "Ready";
  return task.status.replaceAll("_", " ");
}

type TaskLiveLine = Readonly<{
  elapsedSince?: number;
  text: string;
  tone: "attention" | "done" | "muted" | "working";
}>;

function taskLiveLine(item: TaskWorkspaceListItem, now: number): TaskLiveLine {
  if (item.humanInput !== null) {
    return {
      elapsedSince: item.humanInput.oldestRequestedAt,
      text: `Needs you · ${item.humanInput.preview}`,
      tone: "attention",
    };
  }
  const display = item.run?.latestDisplay;
  if (display?.kind === "codex.reasoning_summary.delta" && display.displayText !== undefined) {
    return { text: `Thinking · ${display.displayText}`, tone: "working" };
  }
  if (display?.kind === "codex.assistant_message.delta" && display.displayText !== undefined) {
    return { text: display.displayText, tone: "working" };
  }
  if (display?.kind === "codex.tool_activity.started" && item.run?.phase === "running") {
    return { elapsedSince: display.observedAt, text: "Calling tools", tone: "working" };
  }
  if (item.run !== null) {
    switch (item.run.phase) {
      case "queued": return { text: "Queued", tone: "muted" };
      case "leased":
      case "provisioning":
      case "starting": return { elapsedSince: item.run.updatedAt, text: "Getting ready", tone: "working" };
      case "running": return { elapsedSince: item.run.updatedAt, text: "Thinking", tone: "working" };
      case "waiting": return { elapsedSince: item.run.updatedAt, text: "Continuing…", tone: "working" };
      case "submitted": return { text: "Ready to review", tone: "attention" };
      case "failed":
      case "ambiguous": return { text: "Needs attention", tone: "attention" };
      case "cancel_requested": return { elapsedSince: item.run.updatedAt, text: "Stopping", tone: "muted" };
      case "cancelled": return { text: "Cancelled", tone: "muted" };
    }
  }
  if (item.task.status === "done") return { text: "Done", tone: "done" };
  return { text: taskAvailability(item.task, now), tone: "muted" };
}

function TaskListItem({
  item,
  now,
}: {
  item: TaskWorkspaceListItem;
  now: number;
}) {
  const line = taskLiveLine(item, now);
  return (
    <>
      <strong>{item.task.title}</strong>
      <span className={`task-list-item__live task-list-item__live--${line.tone}`}>
        <span>{line.text}</span>
        {line.elapsedSince === undefined ? null : (
          <span aria-label={`Elapsed ${elapsedTaskTime(now, line.elapsedSince)}`}>
            {elapsedTaskTime(now, line.elapsedSince)}
          </span>
        )}
      </span>
    </>
  );
}

function asPriority(value: string): TaskPriority | null {
  const parsed = taskPrioritySchema.safeParse(Number(value));
  return parsed.success ? parsed.data : null;
}

function asTaskType(value: string): TaskType | null {
  return taskTypeValues.find((candidate) => candidate === value) ?? null;
}

function localDateTimeValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

export function createTaskSubmitLabel(
  repositoryId: string,
  repositories: TaskWorkspaceProps["runner"]["repositories"],
  runnerAccepting = true,
): "Create and dispatch" | "Create and queue" {
  return runnerAccepting &&
      repositories.some((repository) => repository.id === repositoryId && repository.ready)
    ? "Create and dispatch"
    : "Create and queue";
}

function TaskEditor({
  busy,
  detail,
  isPending,
  mode,
  now,
  onCancel,
  onCreate,
  onUpdate,
  runner,
}: {
  busy: boolean;
  detail?: TaskWorkspaceDetail;
  isPending: boolean;
  mode: "create" | "edit";
  now: number;
  onCancel: () => void;
  onCreate: (input: CreateTaskInput) => Promise<void>;
  onUpdate: (input: UpdateTaskInput) => Promise<void>;
  runner: TaskWorkspaceProps["runner"];
}) {
  const formTitleId = useId();
  const runnerAccepting = effectiveRunnerPresence(runner.presence, now).state === "ready";
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(detail?.task.title ?? "");
  const [description, setDescription] = useState(detail?.description ?? "");
  const [type, setType] = useState<TaskType>(detail?.task.type ?? "task");
  const [priority, setPriority] = useState<TaskPriority>(detail?.task.priority ?? 2);
  const [availableAt, setAvailableAt] = useState(
    mode === "create" ? "" : localDateTimeValue(detail?.task.availableAt),
  );
  const [labels, setLabels] = useState(detail?.labels.join(", ") ?? "");
  const [parentKey, setParentKey] = useState(detail?.parent?.key ?? "");
  const [repositoryId, setRepositoryId] = useState(runner.repositories[0]?.id ?? "");

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0) return;
    if (mode === "edit" && detail !== undefined) {
      await onUpdate({
        description,
        priority,
        revision: detail.task.revision,
        taskKey: detail.task.key,
        title: normalizedTitle,
        type,
      });
      return;
    }
    const parsedAvailableAt = availableAt.length === 0 ? undefined : new Date(availableAt).getTime();
    const parsedLabels = [...new Set(labels.split(",").map((label) => label.trim().toLowerCase()).filter(Boolean))];
    await onCreate({
      ...(parsedAvailableAt === undefined || !Number.isFinite(parsedAvailableAt)
        ? {}
        : { availableAt: parsedAvailableAt }),
      description,
      labels: parsedLabels,
      ...(parentKey.trim().length === 0 ? {} : { parentKey: parentKey.trim().toUpperCase() }),
      priority,
      ...(repositoryId.length === 0 ? {} : { repositoryId }),
      title: normalizedTitle,
      type,
    });
  };

  return (
    <section aria-labelledby={formTitleId} className="task-editor">
      <div className="task-editor__heading">
        <div>
          <p className="task-eyebrow">{mode === "create" ? "New work item" : "Edit task"}</p>
          <h2 id={formTitleId}>{mode === "create" ? "Create a task" : `Edit ${detail?.task.key ?? "task"}`}</h2>
        </div>
        <Button className="task-text-button" isDisabled={busy} onPress={onCancel} size="compact" variant="quiet">
          Close editor
        </Button>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <TextField
          className="task-field task-field--wide"
          inputRef={titleRef}
          isRequired
          label="Title"
          maxLength={512}
          onChange={setTitle}
          size="compact"
          value={title}
        />
        <TextAreaField
          className="task-field task-field--wide"
          label="Description"
          onChange={setDescription}
          size="compact"
          textAreaProps={{ rows: 5 }}
          value={description}
        />
        <SelectField
          className="task-field"
          label="Type"
          onChange={(value) => {
            const parsed = asTaskType(value);
            if (parsed !== null) setType(parsed);
          }}
          options={taskTypeValues.map((value) => ({ id: value, label: value }))}
          size="compact"
          value={type}
        />
        <SelectField
          className="task-field"
          label="Priority"
          onChange={(value) => {
            const parsed = asPriority(value);
            if (parsed !== null) setPriority(parsed);
          }}
          options={([0, 1, 2, 3, 4] as const).map((value) => ({
            id: String(value),
            label: `P${value} · ${priorityLabels[value]}`,
          }))}
          size="compact"
          value={String(priority)}
        />
        {mode === "create" ? (
          <>
            <TextField
              className="task-field"
              label="Available after"
              onChange={setAvailableAt}
              size="compact"
              type="datetime-local"
              value={availableAt}
            />
            <TextField
              className="task-field"
              label="Parent task key"
              onChange={setParentKey}
              placeholder="AT-123ABCD"
              size="compact"
              value={parentKey}
            />
            <TextField
              className="task-field task-field--wide"
              label={<>Labels <small>comma separated</small></>}
              onChange={setLabels}
              placeholder="backend, auth, urgent"
              size="compact"
              value={labels}
            />
            <SelectField
              className="task-field task-field--wide"
              description={runner.repositories.length === 0
                ? "Add a project or repository mapping before running work."
                : undefined}
              label="Repository"
              onChange={setRepositoryId}
              options={runner.repositories.length === 0
                ? [{ id: "", label: "No repository mapped" }]
                : runner.repositories.map((repository) => ({
                    id: repository.id,
                    label: `${repository.name}${repository.ready && runnerAccepting
                      ? " · ready"
                      : " · queues until a runner reconnects"}`,
                  }))}
              required
              size="compact"
              value={repositoryId}
            />
          </>
        ) : null}
        <div className="task-editor__actions">
          <Button isDisabled={busy} onPress={onCancel} type="button" variant="quiet">Cancel</Button>
          <Button
            isDisabled={busy || title.trim().length === 0 || (mode === "create" && repositoryId.length === 0)}
            isPending={isPending}
            type="submit"
            variant="primary"
          >
            {mode === "create"
              ? createTaskSubmitLabel(repositoryId, runner.repositories, runnerAccepting)
              : "Save changes"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function ConfirmTaskAction({
  body,
  busy,
  confirmLabel,
  danger = false,
  isPending,
  onConfirm,
  reasonLabel,
  reviewAction,
  title,
  trigger,
}: {
  body: string;
  busy: boolean;
  confirmLabel: string;
  danger?: boolean;
  isPending: boolean;
  onConfirm: (reason: string) => Promise<TaskWorkspaceActionResult>;
  reasonLabel?: string;
  reviewAction?: "accept" | "reject";
  title: string;
  trigger: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<TaskWorkspaceError | null>(null);

  const reset = () => {
    setReason("");
    setFailure(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>, close: () => void) => {
    event.preventDefault();
    if (reasonLabel !== undefined && reason.trim().length === 0) return;
    setFailure(null);
    const result = await onConfirm(reason.trim());
    if (result.ok) {
      reset();
      close();
      return;
    }
    setFailure(result.error);
  };

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return;
        setOpen(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <Button
        data-task-review-action={reviewAction}
        isDisabled={busy}
        onPress={() => {
          reset();
          setOpen(true);
        }}
        size="compact"
        variant={danger ? "danger" : "quiet"}
      >
        {trigger}
      </Button>
      <Modal
        className="task-confirm-dialog"
        description={body}
        isCloseDisabled={busy}
        isDismissable={!busy}
        isKeyboardDismissDisabled={busy}
        size="small"
        title={title}
      >
        {({ close }) => (
          <form onSubmit={(event) => void submit(event, close)}>
            {reasonLabel === undefined ? null : (
              <TextAreaField
                autoFocus
                className="task-field task-field--wide"
                isRequired
                label={reasonLabel}
                onChange={setReason}
                size="compact"
                textAreaProps={{ maxLength: 16_384, rows: 4 }}
                value={reason}
              />
            )}
            {failure === null ? null : <ErrorState error={failure} title="Command not completed" />}
            <div className="task-button-row task-button-row--end">
              <Button autoFocus={reasonLabel === undefined} isDisabled={busy} onPress={close} type="button" variant="quiet">Cancel</Button>
              <Button isDisabled={busy} isPending={isPending} type="submit" variant={danger ? "danger" : "primary"}>
                {confirmLabel}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </DialogTrigger>
  );
}

function TaskLinkButton({ link, onSelect }: { link: TaskWorkspaceLink; onSelect: () => void }) {
  return (
    <PressableCard className="task-link-card" onPress={onSelect}>
      <span><code>{link.key}</code><Priority priority={link.priority} /></span>
      <strong>{link.title}</strong>
      <TaskStatusPill status={link.status} />
    </PressableCard>
  );
}

function GraphEdge({
  edge,
  disabled,
  label,
  onRemove,
  onSelect,
  removable,
}: {
  edge: TaskWorkspaceGraphEdge;
  disabled: boolean;
  label: string;
  onRemove: () => void;
  onSelect: () => void;
  removable: boolean;
}) {
  return (
    <li className="task-graph-edge">
      <span className="task-graph-edge__kind">{label}</span>
      <TaskLinkButton link={edge.task} onSelect={onSelect} />
      {removable ? (
        <Button className="task-text-button" isDisabled={disabled} onPress={onRemove} size="compact" variant="quiet">
          Remove edge
        </Button>
      ) : null}
    </li>
  );
}

function TaskGraph({
  actions,
  busy,
  canManage,
  detail,
  execute,
}: {
  actions: TaskWorkspaceProps["actions"];
  busy: boolean;
  canManage: boolean;
  detail: TaskWorkspaceDetail;
  execute: ExecuteAction;
}) {
  const [blockerKey, setBlockerKey] = useState("");
  const [parentKey, setParentKey] = useState("");
  const task = detail.task;
  const select = actions.selectTask;

  return (
    <section aria-labelledby="task-graph-heading" className="task-detail-section">
      <div className="task-section-heading">
        <div><p className="task-eyebrow">Work graph</p><h3 id="task-graph-heading">Relationships</h3></div>
        <p>Dependencies block readiness; hierarchy groups work without changing readiness.</p>
      </div>
      <div className="task-graph-grid">
        <div className="task-graph-column">
          <h4>Parent</h4>
          {detail.parent === null ? <p className="task-muted">No parent task</p> : (
            <div className="task-graph-parent">
              <TaskLinkButton link={detail.parent} onSelect={() => select(detail.parent?.key ?? null)} />
              {canManage ? (
                <Button
                  className="task-text-button"
                  isDisabled={busy}
                  onPress={() => void execute("Clear parent", () => actions.clearParent({ revision: task.revision, taskKey: task.key }))}
                  size="compact"
                  variant="quiet"
                >Clear parent</Button>
              ) : null}
            </div>
          )}
          {canManage ? (
            <form
              className="task-compact-form"
              onSubmit={(event) => {
                event.preventDefault();
                const normalized = parentKey.trim().toUpperCase();
                if (normalized.length === 0) return;
                void (async () => {
                  const result = await execute("Set parent", () => actions.setParent({ parentKey: normalized, revision: task.revision, taskKey: task.key }));
                  if (result.ok) setParentKey("");
                })();
              }}
            >
              <TextField
                className="task-compact-field"
                label="Set parent by key"
                onChange={setParentKey}
                placeholder="AT-123ABCD"
                size="compact"
                value={parentKey}
              />
              <Button isDisabled={busy || parentKey.trim().length === 0} size="compact" type="submit" variant="quiet">Set parent</Button>
            </form>
          ) : null}
          <h4>Children <span>{detail.children.length}</span></h4>
          {detail.children.length === 0 ? <p className="task-muted">No child tasks</p> : (
            <ul className="task-link-list">
              {detail.children.map((child) => <li key={child.key}><TaskLinkButton link={child} onSelect={() => select(child.key)} /></li>)}
            </ul>
          )}
        </div>
        <div className="task-graph-column">
          <h4>Blocked by <span>{detail.blockers.length}</span></h4>
          {detail.blockers.length === 0 ? <p className="task-muted">No unresolved dependency edges</p> : (
            <ul className="task-link-list">
              {detail.blockers.map((edge) => (
                <GraphEdge
                  edge={edge}
                  disabled={busy}
                  key={edge.task.key}
                  label={edge.task.status === "cancelled" ? "cancelled blocker" : "blocker"}
                  onRemove={() => void execute("Remove blocker", () => actions.removeBlocker({ blockedTaskKey: task.key, blockerKey: edge.task.key, revision: task.revision }))}
                  onSelect={() => select(edge.task.key)}
                  removable={canManage}
                />
              ))}
            </ul>
          )}
          {canManage ? (
            <form
              className="task-compact-form"
              onSubmit={(event) => {
                event.preventDefault();
                const normalized = blockerKey.trim().toUpperCase();
                if (normalized.length === 0) return;
                void (async () => {
                  const result = await execute("Add blocker", () => actions.addBlocker({ blockerKey: normalized, revision: task.revision, taskKey: task.key }));
                  if (result.ok) setBlockerKey("");
                })();
              }}
            >
              <TextField
                className="task-compact-field"
                label="Add blocker by key"
                onChange={setBlockerKey}
                placeholder="AT-123ABCD"
                size="compact"
                value={blockerKey}
              />
              <Button isDisabled={busy || blockerKey.trim().length === 0} size="compact" type="submit" variant="quiet">Add blocker</Button>
            </form>
          ) : null}
          <h4>Blocks <span>{detail.dependents.length}</span></h4>
          {detail.dependents.length === 0 ? <p className="task-muted">No dependent tasks</p> : (
            <ul className="task-link-list">
              {detail.dependents.map((edge) => (
                <GraphEdge
                  edge={edge}
                  disabled={busy}
                  key={edge.task.key}
                  label="dependent"
                  onRemove={() => void execute("Remove dependent edge", () => actions.removeBlocker({ blockedTaskKey: edge.task.key, blockerKey: task.key, revision: edge.task.revision }))}
                  onSelect={() => select(edge.task.key)}
                  removable={canManage}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function ClaimCard({
  agents,
  detail,
  now,
}: {
  agents: TaskWorkspaceProps["agents"];
  detail: TaskWorkspaceDetail;
  now: number;
}) {
  if (detail.task.status !== "in_progress") return null;
  const claim = detail.task.currentClaim;
  const agent = agents.find(({ id }) => id === claim.agentId);
  const expired = claim.leaseUntil <= now;
  return (
    <section aria-labelledby="claim-heading" className={`task-claim-card ${expired ? "task-claim-card--expired" : ""}`}>
      <div>
        <p className="task-eyebrow">Exclusive write authority</p>
        <h3 id="claim-heading">Current claim</h3>
      </div>
      <dl>
        <div><dt>Persistent agent</dt><dd>{agent === undefined ? claim.agentId : agent.name}</dd></div>
        <div><dt>Lease</dt><dd><RelativeLease now={now} until={claim.leaseUntil} /> · <Time value={claim.leaseUntil} /></dd></div>
        <div><dt>Fence</dt><dd><code>{claim.fence}</code></dd></div>
        <div><dt>Lease generation</dt><dd><code>{claim.leaseGeneration}</code></dd></div>
      </dl>
      <p>
        {expired
          ? "This fence is stale. Refresh and reclaim before accepting more writes from the process."
          : "Only commands carrying this current fence may mutate claimed work."}
      </p>
    </section>
  );
}

function Evidence({ evidence }: { evidence: SubmissionEvidenceInput }) {
  const candidateUrl = "url" in evidence ? safeHttpsUrl(evidence.url) : null;
  let label: string;
  switch (evidence.kind) {
    case "commit": label = `Commit ${evidence.sha}`; break;
    case "pull_request": label = "Pull request"; break;
    case "artifact": label = `Artifact · ${evidence.name}`; break;
    case "url": label = evidence.label; break;
    case "test": label = `Test · ${evidence.command}`; break;
    case "note": label = evidence.text; break;
  }
  return (
    <li className="task-evidence">
      <span>{evidence.kind.replaceAll("_", " ")}</span>
      {candidateUrl === null ? <code>{label}</code> : <a href={candidateUrl} rel="noreferrer" target="_blank">{label}<span className="jungle-visually-hidden"> (opens in a new tab)</span></a>}
    </li>
  );
}

function SubmissionCard({
  busy,
  capabilities,
  execute,
  pendingOperationLabel,
  submission,
  actions,
}: {
  actions: TaskWorkspaceProps["actions"];
  busy: boolean;
  capabilities: TaskWorkspaceProps["capabilities"];
  execute: ExecuteAction;
  pendingOperationLabel: string | null;
  submission: TaskWorkspaceSubmission;
}) {
  const reviewable = submission.status === "pending" && capabilities.canReview;
  return (
    <section aria-labelledby="submission-heading" className="task-submission-card">
      <header>
        <h3 id="submission-heading">{reviewable ? "Ready to review" : "Result"}</h3>
      </header>
      <p className="task-submission-summary">{submission.summary}</p>
      {submission.reviewReason === undefined ? null : (
        <blockquote className="task-review-reason"><strong>Review reason</strong><p>{submission.reviewReason}</p></blockquote>
      )}
      {reviewable ? (
        <div className="task-review-actions">
          <ConfirmTaskAction
            body="Acceptance closes the task as done and preserves this exact submission as the reviewed record."
            busy={busy}
            confirmLabel="Accept submission"
            isPending={pendingOperationLabel === pendingOperationLabels.acceptSubmission}
            onConfirm={() => execute(pendingOperationLabels.acceptSubmission, () => actions.acceptSubmission({ reviewRevision: submission.reviewRevision, submissionId: submission.id, taskKey: submission.taskKey }))}
            reviewAction="accept"
            title="Accept this immutable submission?"
            trigger="Accept"
          />
          <ConfirmTaskAction
            body="Rejection preserves this evidence, reopens work, and requires a new claim and a new submission."
            busy={busy}
            confirmLabel="Reject submission"
            danger
            isPending={pendingOperationLabel === pendingOperationLabels.rejectSubmission}
            onConfirm={(reason) => execute(pendingOperationLabels.rejectSubmission, () => actions.rejectSubmission({ reason, reviewRevision: submission.reviewRevision, submissionId: submission.id, taskKey: submission.taskKey }))}
            reasonLabel="Reason for rejection"
            reviewAction="reject"
            title="Reject this submission?"
            trigger="Reject"
          />
        </div>
      ) : null}
      <Disclosure className="task-submission-evidence" size="compact" title={`Evidence · ${submission.evidence.length}`}>
        <p className="task-submission-freeze">
          Frozen at review revision {submission.reviewRevision}. Later edits cannot rewrite this result.
        </p>
        <div className="task-submission-byline"><Actor actor={submission.submittedBy} /><Time value={submission.submittedAt} /></div>
        <ul className="task-evidence-list">{submission.evidence.map((item, index) => <Evidence evidence={item} key={`${item.kind}-${index}`} />)}</ul>
      </Disclosure>
    </section>
  );
}

function referenceLabel(reference: TaskReferenceView): string {
  switch (reference.kind) {
    case "repository": return reference.repositoryId;
    case "pull_request": return "Pull request";
    case "commit": return `Commit ${reference.sha}`;
    case "artifact": return reference.name;
    case "url": return reference.label;
  }
}

function referenceUrl(reference: TaskReferenceView): string | null {
  if ("url" in reference) return safeHttpsUrl(reference.url);
  return null;
}

function References({
  actions,
  busy,
  canEdit,
  detail,
  execute,
}: {
  actions: TaskWorkspaceProps["actions"];
  busy: boolean;
  canEdit: boolean;
  detail: TaskWorkspaceDetail;
  execute: ExecuteAction;
}) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  return (
    <section aria-labelledby="references-heading" className="task-detail-section">
      <div className="task-section-heading"><div><p className="task-eyebrow">External context</p><h3 id="references-heading">References</h3></div><span>{detail.references.length}</span></div>
      {detail.references.length === 0 ? <p className="task-muted">No repositories, changes, artifacts, or links attached.</p> : (
        <ul className="task-reference-list">
          {detail.references.map((reference) => {
            const safeUrl = referenceUrl(reference);
            return (
              <li key={reference.id}>
                <span>{reference.kind.replaceAll("_", " ")}</span>
                {safeUrl === null ? <code>{referenceLabel(reference)}</code> : <a href={safeUrl} rel="noreferrer" target="_blank">{referenceLabel(reference)}<span className="jungle-visually-hidden"> (opens in a new tab)</span></a>}
                {canEdit ? (
                  <Button
                    className="task-text-button"
                    isDisabled={busy}
                    onPress={() => void execute("Remove reference", () => actions.removeReference({ referenceId: reference.id, revision: detail.task.revision, taskKey: detail.task.key }))}
                    size="compact"
                    variant="quiet"
                  >Remove</Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit ? (
        <form
          className="task-reference-form"
          onSubmit={(event) => {
            event.preventDefault();
            const safeUrl = safeHttpsUrl(url);
            if (label.trim().length === 0 || safeUrl === null) return;
            const reference: TaskReferenceInput = { kind: "url", label: label.trim(), url: safeUrl };
            void (async () => {
              const result = await execute("Add reference", () => actions.addReference({ reference, revision: detail.task.revision, taskKey: detail.task.key }));
              if (result.ok) {
                setLabel("");
                setUrl("");
              }
            })();
          }}
        >
          <TextField className="task-field" label="Link label" maxLength={160} onChange={setLabel} size="compact" value={label} />
          <TextField className="task-field" label="HTTPS URL" onChange={setUrl} placeholder="https://…" size="compact" type="url" value={url} />
          <Button isDisabled={busy || label.trim().length === 0 || safeHttpsUrl(url) === null} size="compact" type="submit" variant="quiet">Attach link</Button>
        </form>
      ) : null}
    </section>
  );
}

function Comments({
  actions,
  busy,
  canComment,
  detail,
  execute,
}: {
  actions: TaskWorkspaceProps["actions"];
  busy: boolean;
  canComment: boolean;
  detail: TaskWorkspaceDetail;
  execute: ExecuteAction;
}) {
  const [body, setBody] = useState("");
  return (
    <section aria-labelledby="comments-heading" className="task-detail-section">
      <div className="task-section-heading"><div><p className="task-eyebrow">Coordination</p><h3 id="comments-heading">Comments</h3></div><span>{detail.comments.length}</span></div>
      {detail.comments.length === 0 ? <p className="task-muted">No coordination notes yet.</p> : (
        <ol className="task-comment-list">
          {detail.comments.map((comment) => (
            <li key={comment.id}>
              <div><Actor actor={comment.actor} /><Time value={comment.createdAt} /></div>
              <p>{comment.body}</p>
            </li>
          ))}
        </ol>
      )}
      {canComment ? (
        <form
          className="task-comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            const normalized = body.trim();
            if (normalized.length === 0) return;
            void execute("Add comment", async () => {
              const result = await actions.addComment({ body: normalized, taskKey: detail.task.key });
              if (result.ok) setBody("");
              return result;
            });
          }}
        >
          <TextAreaField
            className="task-field task-field--wide"
            label="Add a human supervision note"
            onChange={setBody}
            placeholder="Record a decision, handoff, or review context…"
            size="compact"
            textAreaProps={{ rows: 3 }}
            value={body}
          />
          <Button isDisabled={busy || body.trim().length === 0} size="compact" type="submit" variant="primary">Add comment</Button>
        </form>
      ) : null}
    </section>
  );
}

function Events({ detail }: { detail: TaskWorkspaceDetail }) {
  return (
    <section aria-labelledby="events-heading" className="task-events">
      <div className="task-section-heading"><div><p className="task-eyebrow">Append-only history</p><h3 id="events-heading">Task events</h3></div><span>{detail.events.length}</span></div>
      {detail.events.length === 0 ? <EmptyState title="No events">This task has no published lifecycle events.</EmptyState> : (
        <ol>
          {detail.events.map((event) => (
            <li key={event.id}>
              <span className="task-event-rail" aria-hidden="true" />
              <div className="task-event-heading"><code>{event.type}</code><span>r{event.taskRevision}</span><Time value={event.createdAt} /></div>
              <p>{event.summary}</p>
              <Actor actor={event.actor} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const runPhaseCopy: Readonly<Record<TaskRunView["phase"], string>> = {
  queued: "Queued",
  leased: "Claimed by runner",
  provisioning: "Preparing execution workspace",
  starting: "Starting Codex",
  running: "Codex working",
  waiting: "Waiting for attention",
  submitted: "Submitted for review",
  failed: "Needs attention",
  cancel_requested: "Stopping",
  cancelled: "Cancelled",
  ambiguous: "Recovery required",
};

const runEventCopy: Readonly<Record<string, string>> = {
  "run.queued": "Queued for runner",
  "worktree.preparing": "Preparing execution workspace",
  "worktree.ready": "Execution workspace ready",
  "codex.starting": "Starting Codex",
  "codex.running": "Codex is working",
  "codex.planning": "Planning the change",
  "codex.editing": "Editing the workspace",
  "codex.testing": "Running checks",
  "codex.waiting_for_approval": "Waiting for approval",
  "codex.waiting_for_input": "Waiting for input",
  "run.submitted": "Submitted for review",
  "run.failed": "Run needs attention",
  "run.cancelled": "Run cancelled",
  "run.lease_lost": "Runner connection was lost",
};

function activeToolStartedAt(events: TaskRunView["events"]): number | null {
  let startedAt: number | null = null;
  for (const event of events) {
    const kind: string = event.kind;
    if (kind === "codex.tool_activity.started") startedAt = event.observedAt;
    if (kind === "codex.tool_activity.completed") startedAt = null;
  }
  return startedAt;
}

const stoppableRunPhases = [
  "queued",
  "leased",
  "provisioning",
  "starting",
  "running",
  "waiting",
  "cancel_requested",
] as const satisfies readonly TaskRunView["phase"][];

const taskMutationBlockingRunPhases = [
  "queued",
  "leased",
  "provisioning",
  "starting",
  "running",
  "waiting",
  "cancel_requested",
  "ambiguous",
] as const satisfies readonly TaskRunView["phase"][];

function UserInputInteraction({
  busy,
  interaction,
  onRespond,
}: {
  busy: boolean;
  interaction: RunInteractionView & {
    request: Extract<RunInteractionView["request"], { kind: "user_input" }>;
  };
  onRespond: (response: RunInteractionResponse) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Readonly<Record<string, RunInteractionQuestionDraft>>>(() =>
    Object.fromEntries(interaction.request.questions.map((question) => [
      question.id,
      { otherText: "", selectedOptionIds: [] },
    ])),
  );
  const submitting = useRef(false);
  const complete = interaction.request.questions.every((question) => {
    const answer = answers[question.id];
    return answer !== undefined && (
      answer.selectedOptionIds.length > 0 ||
      (question.allowOther && answer.otherText.trim().length > 0)
    );
  });
  const submitResponse = () => {
    if (!complete || busy || submitting.current) return;
    submitting.current = true;
    void onRespond({
      kind: "user_input",
      answers: interaction.request.questions.map((question) => {
        const answer = answers[question.id];
        if (answer === undefined) throw new Error("missing interaction answer");
        const otherText = answer.otherText.trim();
        return {
          questionId: question.id,
          selectedOptionIds: [...answer.selectedOptionIds],
          ...(otherText.length === 0 ? {} : { otherText }),
        };
      }),
    }).finally(() => {
      submitting.current = false;
    });
  };
  return (
    <form
      className="task-interaction-form"
      onSubmit={(event) => {
        event.preventDefault();
        submitResponse();
      }}
    >
      {interaction.request.questions.map((question) => {
        const draft = answers[question.id] ?? { otherText: "", selectedOptionIds: [] };
        return (
          <fieldset key={question.id}>
            <legend><span>{question.header}</span>{question.prompt}</legend>
            {question.options.length === 0 ? null : (
              <div className="task-interaction-options">
                {question.options.map((option) => (
                  <CheckboxField
                    checked={draft.selectedOptionIds.includes(option.id)}
                    className="task-interaction-option"
                    description={option.description}
                    disabled={busy}
                    key={option.id}
                    label={option.label}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: setRunInteractionOption(
                          current[question.id] ?? { otherText: "", selectedOptionIds: [] },
                          option.id,
                          checked,
                        ),
                      }));
                    }}
                  />
                ))}
              </div>
            )}
            {question.allowOther ? (
              <TextField
                className="task-interaction-other"
                isDisabled={busy}
                label={question.options.length === 0 ? "Answer" : "Something else"}
                maxLength={2_000}
                onChange={(otherText) => setAnswers((current) => ({
                  ...current,
                  [question.id]: setRunInteractionOtherText(
                    current[question.id] ?? { otherText: "", selectedOptionIds: [] },
                    otherText,
                  ),
                }))}
                value={draft.otherText}
              />
            ) : null}
          </fieldset>
        );
      })}
      <Button
        isDisabled={busy || !complete}
        onPress={submitResponse}
        type="submit"
        variant="primary"
      >
        Continue
      </Button>
    </form>
  );
}

function RunInteractions({
  actions,
  busy,
  canRespond,
  execute,
  interactionNow,
  run,
}: {
  actions: TaskWorkspaceProps["actions"];
  busy: boolean;
  canRespond: boolean;
  execute: ExecuteAction;
  interactionNow: number;
  run: TaskRunView;
}) {
  const pendingInteractions = run.interactions
    .filter((interaction) =>
      interaction.state === "pending" && interaction.request.expiresAt > interactionNow,
    )
    .sort((left, right) =>
      left.request.createdAt - right.request.createdAt
      || left.request.id.localeCompare(right.request.id),
    );
  if (pendingInteractions.length === 0) return null;
  const firstRequest = pendingInteractions[0]?.request;
  const firstPrompt = firstRequest?.kind === "user_input"
    ? firstRequest.questions[0]?.prompt ?? "Codex has a question."
    : "Codex needs approval to edit files.";
  return (
    <>
      <p className="jungle-visually-hidden" role="alert">Needs your input. {firstPrompt}</p>
      <div aria-label="Run needs input" className="task-interactions">
        {pendingInteractions.map((interaction) => {
          const respond = async (response: RunInteractionResponse) => {
            await execute("Answer run", () => actions.respondToRunInteraction({
              interactionId: interaction.request.id,
              request: interaction.request,
              response,
              runId: run.id,
            }));
          };
          return (
            <section className="task-interaction" key={interaction.request.id}>
              <div className="task-interaction__heading">
                <div>
                  <p>Needs you</p>
                  <h4>{interaction.request.kind === "user_input" ? "Codex has a question" : "Allow Codex to edit files?"}</h4>
                </div>
              </div>
              {interaction.request.kind === "file_change_approval" ? (
                <p>Allow these edits once in this task’s isolated workspace.</p>
              ) : null}
              {!canRespond ? (
                <p className="task-muted">A workspace planner must answer this request.</p>
              ) : interaction.request.kind === "user_input" ? (
                <UserInputInteraction
                  busy={busy}
                  interaction={{ ...interaction, request: interaction.request }}
                  onRespond={respond}
                />
              ) : (
                <div className="task-interaction-actions">
                  <Button isDisabled={busy} onPress={() => void respond({ kind: "file_change_approval", decision: "approve_once" })} variant="primary">Allow once</Button>
                  <Button isDisabled={busy} onPress={() => void respond({ kind: "file_change_approval", decision: "decline" })} variant="quiet">Don’t allow</Button>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

function TaskStreamAnnouncement({ update }: { update: string | null }) {
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (update === null) return;
    const timer = window.setTimeout(() => {
      setAnnouncement((current) => current === update ? current : update);
    }, update === "Calling tools." ? 0 : 800);
    return () => window.clearTimeout(timer);
  }, [update]);
  return (
    <p aria-atomic="true" aria-live="polite" className="jungle-visually-hidden task-stream-announcement">
      {announcement}
    </p>
  );
}

function latestTaskStreamAnnouncement(
  run: TaskRunView,
  messages: ReturnType<typeof taskTranscriptMessages>,
): string | null {
  const latestDisplayEvent = [...run.events].reverse().find((event) =>
    event.kind === "codex.reasoning_summary.delta"
    || event.kind === "codex.assistant_message.delta"
    || event.kind === "codex.tool_activity.started"
    || event.kind === "codex.tool_activity.completed",
  );
  if (latestDisplayEvent === undefined || latestDisplayEvent.kind === "codex.tool_activity.completed") {
    return null;
  }
  if (latestDisplayEvent.kind === "codex.tool_activity.started") return "Calling tools.";
  const message = messages.at(-1);
  if (message === undefined) return null;
  return `${message.kind === "thinking" ? "Thinking" : "Codex"}: ${message.text}`;
}

function RunTimeline({
  actions,
  busy,
  canDispatch,
  canStop,
  execute,
  now,
  pendingOperationLabel,
  runs,
  submissionStatus,
  taskRevision,
}: {
  actions: TaskWorkspaceProps["actions"];
  busy: boolean;
  canDispatch: boolean;
  canStop: boolean;
  execute: ExecuteAction;
  now: number;
  pendingOperationLabel: string | null;
  runs: readonly TaskRunView[];
  submissionStatus:
    NonNullable<TaskWorkspaceDetail["submission"]>["status"] | null;
  taskRevision: number;
}) {
  const run = runs[0];
  if (run === undefined) {
    return (
      <section aria-labelledby="run-heading" className="task-stream task-stream--empty">
        <h3 id="run-heading">Ready when you are</h3>
        <p>This task has not started yet.</p>
      </section>
    );
  }
  const canRequestStop = canStop && stoppableRunPhases.some((phase) => phase === run.phase);
  const canRetry = canDispatch && (
    run.phase === "failed" ||
    run.phase === "cancelled" ||
    (run.phase === "submitted" && submissionStatus === "rejected")
  );
  const canAbandon = canDispatch && run.phase === "ambiguous";
  const stopRequested = run.phase === "cancel_requested" || run.desiredState === "stop";
  const stopLabel = pendingOperationLabels.stopRun;
  const messages = taskTranscriptMessages(run.events);
  const toolStartedAt = run.phase === "running" ? activeToolStartedAt(run.events) : null;
  const streamAnnouncement = latestTaskStreamAnnouncement(run, messages);
  const lastStatusEvent = [...run.events]
    .reverse()
    .find((event) => runEventCopy[event.kind] !== undefined);
  const interactionContinuing = run.phase === "waiting" &&
    run.interactions.some(({ state }) => state === "answered");
  const phaseHeading = interactionContinuing ? "Continuing…" : runPhaseCopy[run.phase];
  const quietStatus = interactionContinuing
    ? "Waiting for this Mac…"
    : lastStatusEvent === undefined
    ? "Waiting for the first update…"
    : runEventCopy[lastStatusEvent.kind];
  return (
    <section aria-labelledby="run-heading" className="task-stream">
      <div className="task-stream__bar">
        <h3 id="run-heading">{phaseHeading}</h3>
        <div className="task-stream__actions">
          {canRequestStop ? (
            <Button
              aria-label={stopRequested ? `Stop requested for run ${run.id}` : `${stopLabel} ${run.id}`}
              isDisabled={busy || stopRequested}
              isPending={pendingOperationLabel === stopLabel}
              onPress={() => void execute(stopLabel, () => actions.requestRunStop({ runId: run.id }))}
              variant="quiet"
            >
              {stopLabel}
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              aria-label={`Retry run ${run.id}`}
              isDisabled={busy}
              onPress={() => void execute("Retry run", () => actions.retryRun({
                runId: run.id,
                taskRevision,
              }))}
              variant="primary"
            >
              Retry
            </Button>
          ) : null}
          {canAbandon ? (
            <ConfirmTaskAction
              body="Continue only after checking the runner and confirming this Codex session is no longer running. This preserves its worktree and history, records a cancelled resolution, and releases the task for an explicit retry."
              busy={busy}
              confirmLabel="Confirm stopped"
              danger
              isPending={pendingOperationLabel === pendingOperationLabels.resolveAmbiguousRun}
              onConfirm={() => execute(pendingOperationLabels.resolveAmbiguousRun, () => actions.abandonAmbiguousRun({
                reason: "confirmed_cancelled",
                runId: run.id,
                taskRevision,
              }))}
              title="Confirm the local run has stopped?"
              trigger="Resolve ambiguity"
            />
          ) : null}
        </div>
      </div>
      {run.phase === "ambiguous" ? (
        <p className="task-run-guidance" role="alert">
          The runner lost proof of the local outcome. Do not retry until you confirm the session stopped.
        </p>
      ) : null}
      {run.phase === "failed" ||
      run.phase === "cancelled" ||
      (run.phase === "submitted" && submissionStatus === "rejected") ? (
        <p className="task-run-guidance">
          This attempt and its submission are immutable. Retry creates a new queued run and keeps this history intact.
        </p>
      ) : null}
      <RunInteractions
        actions={actions}
        busy={busy}
        canRespond={canDispatch}
        execute={execute}
        interactionNow={now}
        run={run}
      />
      <TaskStreamAnnouncement update={streamAnnouncement} />
      <div className="task-transcript" aria-label="Codex updates">
        {messages.length === 0 ? null : (
          <ol>
            {messages.map((message) => (
              <li className={`task-transcript__${message.kind}`} data-stream-kind={message.kind} key={message.id}>
                <span className="jungle-visually-hidden">{message.kind === "thinking" ? "Thinking: " : "Codex: "}</span>
                <p>{message.text}</p>
              </li>
            ))}
          </ol>
        )}
        {toolStartedAt === null ? null : (
          <p className="task-tool-activity" data-stream-kind="tools">
            <span>Calling tools</span>
            <span aria-hidden="true">
              {elapsedTaskTime(now, toolStartedAt)}
            </span>
          </p>
        )}
        {messages.length === 0 && toolStartedAt === null && quietStatus !== phaseHeading ? (
          <p className="task-stream__quiet-status">
            {quietStatus}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Labels({
  actions,
  busy,
  canEdit,
  detail,
  execute,
}: {
  actions: TaskWorkspaceProps["actions"];
  busy: boolean;
  canEdit: boolean;
  detail: TaskWorkspaceDetail;
  execute: ExecuteAction;
}) {
  const [label, setLabel] = useState("");
  return (
    <div className="task-label-editor">
      <ul aria-label="Task labels">
        {detail.labels.map((value) => (
          <li key={value}>
            <span>{value}</span>
            {canEdit ? (
              <IconButton
                aria-label={`Remove ${value} label`}
                className="task-label-remove"
                isDisabled={busy}
                onPress={() => void execute("Remove label", () => actions.removeLabel({ label: value, revision: detail.task.revision, taskKey: detail.task.key }))}
                size="compact"
                tooltip={`Remove ${value}`}
              >
                <Icon icon={Cancel01Icon} />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const normalized = label.trim().toLowerCase();
            if (normalized.length === 0) return;
            void (async () => {
              const result = await execute("Add label", () => actions.addLabel({ label: normalized, revision: detail.task.revision, taskKey: detail.task.key }));
              if (result.ok) setLabel("");
            })();
          }}
        >
          <TextField
            className="task-label-input"
            id="task-add-label"
            label="Add label"
            onChange={setLabel}
            placeholder="add label"
            showLabel={false}
            size="compact"
            value={label}
          />
          <Button className="task-label-add" isDisabled={busy || label.trim().length === 0} size="compact" type="submit" variant="quiet">Add</Button>
        </form>
      ) : null}
    </div>
  );
}

function WorkControls({
  actions,
  agents,
  busy,
  capabilities,
  detail,
  execute,
}: {
  actions: TaskWorkspaceProps["actions"];
  agents: TaskWorkspaceProps["agents"];
  busy: boolean;
  capabilities: TaskWorkspaceProps["capabilities"];
  detail: TaskWorkspaceDetail;
  execute: ExecuteAction;
}) {
  const [availableAt, setAvailableAt] = useState(localDateTimeValue(detail.task.availableAt));
  const task = detail.task;
  return (
    <section aria-labelledby="work-controls-heading" className="task-work-controls">
      <div className="task-section-heading"><div><p className="task-eyebrow">Planner controls</p><h3 id="work-controls-heading">Routing</h3></div></div>
      <div className="task-routing-grid">
        <SelectField
          className="task-field"
          disabled={!capabilities.canAssign || busy || task.status === "cancelled"}
          label="Assigned persistent agent"
          onChange={(value) => {
              const agentId = value.length === 0 ? null : value;
              void execute("Assign task", () => actions.setAssignee({ agentId, revision: task.revision, taskKey: task.key }));
          }}
          options={[
            { id: "", label: "Unassigned" },
            ...agents.map((agent) => ({
              disabled: agent.status === "disabled",
              id: agent.id,
              label: `${agent.name}${agent.status === "disabled" ? " · disabled" : ""}`,
            })),
          ]}
          size="compact"
          value={task.assigneeAgentId ?? ""}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = new Date(availableAt).getTime();
            if (!Number.isFinite(parsed)) return;
            void execute("Defer task", () => actions.deferTask({ availableAt: parsed, revision: task.revision, taskKey: task.key }));
          }}
        >
          <TextField
            className="task-field"
            isDisabled={!capabilities.canEdit || busy || task.status === "cancelled"}
            label="Available after"
            onChange={setAvailableAt}
            size="compact"
            type="datetime-local"
            value={availableAt}
          />
          <Button
            isDisabled={!capabilities.canEdit || busy || task.status === "cancelled" || availableAt.length === 0}
            size="compact"
            type="submit"
            variant="quiet"
          >Update schedule</Button>
        </form>
      </div>
    </section>
  );
}

function TaskDetailView({
  actions,
  agents,
  busy,
  capabilities,
  detail,
  execute,
  now,
  onEdit,
  pendingOperationLabel,
}: {
  actions: TaskWorkspaceProps["actions"];
  agents: TaskWorkspaceProps["agents"];
  busy: boolean;
  capabilities: TaskWorkspaceProps["capabilities"];
  detail: TaskWorkspaceDetail;
  execute: ExecuteAction;
  now: number;
  onEdit: () => void;
  pendingOperationLabel: string | null;
}) {
  const task = detail.task;
  const recoveries = detailRecoveryKinds(detail, now);
  const latestRun = detail.runs[0];
  const dispatchBlocksTaskMutation = latestRun !== undefined &&
    taskMutationBlockingRunPhases.some((phase) => phase === latestRun.phase);
  const mutableCapabilities = dispatchBlocksTaskMutation
    ? {
        ...capabilities,
        canAssign: false,
        canCancel: false,
        canEdit: false,
        canManageGraph: false,
        canManageLabels: false,
        canManageReferences: false,
        canReopen: false,
      }
    : capabilities;
  return (
    <article aria-labelledby="task-detail-title" className="task-detail">
      <header className="task-detail__header">
        <div className="task-detail__identity">
          <h2 id="task-detail-title">{task.title}</h2>
        </div>
      </header>
      {dispatchBlocksTaskMutation ? (
        <p className="task-run-guidance" role="note">
          Task fields are locked while this dispatch may own local effects. Stop or resolve the run before changing its inputs.
        </p>
      ) : null}
      <RecoveryCallouts kinds={recoveries} />
      {detail.description.trim().length === 0 ? null : (
        <section aria-label="Task brief" className="task-brief"><p>{detail.description}</p></section>
      )}
      <RunTimeline
        actions={actions}
        busy={busy}
        canDispatch={capabilities.canCreate}
        canStop={capabilities.canCancel}
        execute={execute}
        now={now}
        pendingOperationLabel={pendingOperationLabel}
        runs={detail.runs}
        submissionStatus={detail.submission?.status ?? null}
        taskRevision={task.revision}
      />
      {detail.submission?.status === "pending" ? (
        <SubmissionCard actions={actions} busy={busy} capabilities={capabilities} execute={execute} pendingOperationLabel={pendingOperationLabel} submission={detail.submission} />
      ) : null}
      <Disclosure className="task-advanced" size="compact" title="Details">
        <div className="task-detail__commands">
          {mutableCapabilities.canEdit && task.status !== "cancelled" ? <Button onPress={onEdit} size="compact" variant="quiet">Edit</Button> : null}
          {mutableCapabilities.canCancel && task.status !== "cancelled" && task.status !== "done" ? (
            <ConfirmTaskAction
              body="Cancellation fences active claims and stops new work. History, evidence, comments, and dependency edges stay visible for recovery."
              busy={busy}
              confirmLabel="Cancel task"
              danger
              isPending={pendingOperationLabel === pendingOperationLabels.cancelTask}
              onConfirm={(reason) => execute(pendingOperationLabels.cancelTask, () => actions.cancelTask({ reason, revision: task.revision, taskKey: task.key }))}
              reasonLabel="Reason for cancellation"
              title={`Cancel ${task.key}?`}
              trigger="Cancel task"
            />
          ) : null}
          {mutableCapabilities.canReopen && task.status === "cancelled" ? (
            <ConfirmTaskAction
              body="Reopening returns the task to planning with history intact. Review cancelled blockers and stale assignments before allowing an agent to claim it."
              busy={busy}
              confirmLabel="Reopen task"
              isPending={pendingOperationLabel === pendingOperationLabels.reopenTask}
              onConfirm={() => execute(pendingOperationLabels.reopenTask, () => actions.reopenTask({ revision: task.revision, taskKey: task.key }))}
              title={`Reopen ${task.key}?`}
              trigger="Reopen"
            />
          ) : null}
        </div>
        <dl className="task-details-meta">
          <div><dt>Task</dt><dd><code>{task.key}</code></dd></div>
          <div><dt>Status</dt><dd>{task.status.replaceAll("_", " ")}</dd></div>
          <div><dt>Priority</dt><dd>{priorityLabels[task.priority]}</dd></div>
          <div><dt>Updated</dt><dd><Time value={task.updatedAt} /></dd></div>
        </dl>
        <Labels actions={actions} busy={busy} canEdit={mutableCapabilities.canManageLabels && task.status !== "cancelled"} detail={detail} execute={execute} />
        {detail.truncatedCollections.length === 0 ? null : (
          <p className="task-result-limit" role="note">
            This detail shows bounded {detail.truncatedCollections.join(", ")} results. Additional history remains available from the workspace authority.
          </p>
        )}
        <WorkControls
          actions={actions}
          agents={agents}
          busy={busy}
          capabilities={mutableCapabilities}
          detail={detail}
          execute={execute}
          key={`${detail.task.key}:${String(detail.task.availableAt)}`}
        />
        <ClaimCard agents={agents} detail={detail} now={now} />
        {detail.submission === null || detail.submission.status === "pending" ? null : <SubmissionCard actions={actions} busy={busy} capabilities={capabilities} execute={execute} pendingOperationLabel={pendingOperationLabel} submission={detail.submission} />}
        <TaskGraph actions={actions} busy={busy} canManage={mutableCapabilities.canManageGraph && task.status !== "cancelled"} detail={detail} execute={execute} />
        <References actions={actions} busy={busy} canEdit={mutableCapabilities.canManageReferences && task.status !== "cancelled"} detail={detail} execute={execute} />
        <Comments actions={actions} busy={busy} canComment={capabilities.canComment} detail={detail} execute={execute} />
        <Events detail={detail} />
      </Disclosure>
    </article>
  );
}

export function TaskWorkspace(props: TaskWorkspaceProps) {
  const { actions, agents, capabilities, counts, now, read, runner, viewer, workspace } = props;
  const [ui, dispatch] = useReducer(taskWorkspaceReducer, initialTaskWorkspaceUiState);
  const operationId = useRef(0);
  const activeOperationId = useRef<number | null>(null);
  const execute = useCallback<ExecuteAction>(async (label, action) => {
    if (activeOperationId.current !== null) {
      return { error: { code: "OPERATION_IN_PROGRESS" }, ok: false };
    }
    const id = operationId.current + 1;
    operationId.current = id;
    activeOperationId.current = id;
    dispatch({ id, label, type: "operation.started" });
    let result: TaskWorkspaceActionResult;
    try {
      result = await action();
    } catch {
      result = { error: { code: "CLIENT_UNAVAILABLE" }, ok: false };
    }
    if (activeOperationId.current === id) activeOperationId.current = null;
    dispatch({ id, result, type: "operation.finished" });
    return result;
  }, []);
  const busy = ui.pendingOperation !== null;
  const pendingOperationLabel = ui.pendingOperation?.label ?? null;

  const selectedTaskKey = read.kind === "ready" && read.selection.kind !== "none"
    ? read.selection.kind === "ready" ? read.selection.detail.task.key : read.selection.taskKey
    : null;
  const selectedDetail = read.kind === "ready" && read.selection.kind === "ready"
    ? read.selection.detail
    : null;
  const editingDetail = ui.composer?.kind === "edit" && selectedDetail?.task.key === ui.composer.taskKey
    ? selectedDetail
    : undefined;
  const prioritizedTasks = read.kind === "ready" ? prioritizeTasksNeedingInput(read.tasks, now) : [];
  const pendingInputCount = prioritizedTasks.filter(({ humanInput }) => humanInput !== null).length;

  return (
    <section aria-label={`${workspace.name} task control plane`} className="task-workspace">
      <PageIntro
        actions={<div className="task-workspace__header-actions">
          <Actor actor={viewer} />
          <RunnerPresence now={now} presence={runner.presence} />
          <SelectField
            className="task-filter"
            label="Task view"
            onChange={(view) => {
                dispatch({ type: "composer.close" });
                dispatch({ panel: "work", type: "panel.select" });
                actions.viewChanged(view);
            }}
            options={taskWorkspaceViews.map((view) => ({
              id: view,
              label: `${taskWorkspaceViewLabels[view]} · ${counts[view].value}${counts[view].capped ? "+" : ""}`,
            }))}
            showLabel={false}
            size="compact"
            surface="pane"
            value={read.view}
          />
          {capabilities.canCreate ? (
            <Button isDisabled={busy} onPress={() => dispatch({ type: "composer.create" })} variant="primary">New task</Button>
          ) : null}
        </div>}
        className="task-workspace__header"
        title="Tasks"
        titleAs="h2"
      />

      <Notice notice={ui.notice} onDismiss={() => dispatch({ type: "notice.dismissed" })} />
      {ui.pendingOperation === null ? null : <p className="task-operation-status" role="status"><Spinner aria-hidden="true" size="small" />{ui.pendingOperation.label}…</p>}

      {ui.composer?.kind === "create" ? (
        <TaskEditor
          busy={busy}
          isPending={pendingOperationLabel === pendingOperationLabels.createTask}
          mode="create"
          now={now}
          onCancel={() => dispatch({ type: "composer.close" })}
          onCreate={async (input) => { await execute(pendingOperationLabels.createTask, () => actions.createTask(input)); }}
          onUpdate={() => Promise.resolve()}
          runner={runner}
        />
      ) : null}
      {ui.composer?.kind === "edit" && editingDetail !== undefined ? (
        <TaskEditor
          busy={busy}
          detail={editingDetail}
          isPending={pendingOperationLabel === pendingOperationLabels.updateTask}
          mode="edit"
          now={now}
          onCancel={() => dispatch({ type: "composer.close" })}
          onCreate={() => Promise.resolve()}
          onUpdate={async (input) => { await execute(pendingOperationLabels.updateTask, () => actions.updateTask(input)); }}
          runner={runner}
        />
      ) : null}

      {read.kind === "loading" ? <LoadingState label={`Loading ${taskWorkspaceViewLabels[read.view].toLowerCase()} tasks…`} /> : null}
      {read.kind === "error" ? <ErrorState error={read.error} title={`${taskWorkspaceViewLabels[read.view]} view unavailable`} /> : null}
      {read.kind === "ready" ? (
        prioritizedTasks.length === 0 ? (
          <EmptyState title={`No ${taskWorkspaceViewLabels[read.view].toLowerCase()} tasks`}>
            {read.view === "ready" ? "Nothing can be claimed right now. Check blocked, deferred, or attention views for the next planning action." : "This workspace has no tasks in the selected view."}
          </EmptyState>
        ) : (
          <div className="task-workspace__body">
            <aside className="task-list-pane">
              <p className="jungle-visually-hidden" aria-live="polite">
                {pendingInputCount === 0
                  ? "No tasks need your input."
                  : `${pendingInputCount} task${pendingInputCount === 1 ? " needs" : "s need"} your input.`}
              </p>
              <ListBox
                aria-label={`${taskWorkspaceViewLabels[read.view]} tasks`}
                className="task-list"
                onSelectionChange={(keys) => {
                  if (keys === "all") return;
                  const key = [...keys][0];
                  const item = prioritizedTasks.find(({ task }) => task.key === key);
                  if (item === undefined) return;
                  dispatch({ type: "composer.close" });
                  dispatch({ panel: "work", type: "panel.select" });
                  actions.selectTask(item.task.key);
                }}
                selectedKeys={selectedTaskKey === null ? new Set() : new Set([selectedTaskKey])}
                selectionMode="single"
              >
                {prioritizedTasks.map((item) => (
                  <ListBoxItem
                    className="task-list-item"
                    data-needs-input={item.humanInput === null ? undefined : "true"}
                    data-task-key={item.task.key}
                    id={item.task.key}
                    key={item.task.key}
                    textValue={`${item.task.title}${item.humanInput === null ? "" : ` Needs you ${item.humanInput.preview}`}`}
                  >
                    <TaskListItem
                      item={item}
                      now={now}
                    />
                  </ListBoxItem>
                ))}
              </ListBox>
              {read.cursor === null ? null : (
                <Button
                  className="task-load-more"
                  controlClassName="task-load-more__control"
                  onPress={() => actions.loadMore(read.cursor ?? "", read.view)}
                  variant="quiet"
                >
                  Load more
                </Button>
              )}
            </aside>
            <div className="task-detail-pane">
              {read.selection.kind === "none" ? <EmptyState title="Choose a task">Its live progress and any questions will appear here.</EmptyState> : null}
              {read.selection.kind === "loading" ? <LoadingState label={`Loading ${read.selection.taskKey}…`} /> : null}
              {read.selection.kind === "error" ? <ErrorState error={read.selection.error} title={`${read.selection.taskKey} unavailable`} /> : null}
              {read.selection.kind === "ready" ? (
                <TaskDetailView
                  actions={actions}
                  agents={agents}
                  busy={busy}
                  capabilities={capabilities}
                  detail={read.selection.detail}
                  execute={execute}
                  key={read.selection.detail.task.key}
                  now={now}
                  onEdit={() => {
                    if (selectedDetail !== null) {
                      dispatch({ taskKey: selectedDetail.task.key, type: "composer.edit" });
                    }
                  }}
                  pendingOperationLabel={pendingOperationLabel}
                />
              ) : null}
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}
