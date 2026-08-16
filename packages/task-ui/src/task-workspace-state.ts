import type {
  PortableRunInteractionRequest,
  PortableRunInteractionResponse,
  PortableRunProjection,
  ProjectionActor,
  TaskHumanInputView,
  TaskPriority,
  TaskReferenceInput,
  TaskType,
  TaskWorkspaceComment as DomainTaskWorkspaceComment,
  TaskWorkspaceCount as DomainTaskWorkspaceCount,
  TaskWorkspaceDetail as DomainTaskWorkspaceDetail,
  TaskWorkspaceEvent as DomainTaskWorkspaceEvent,
  TaskWorkspaceGraphEdge as DomainTaskWorkspaceGraphEdge,
  TaskWorkspaceLink as DomainTaskWorkspaceLink,
  TaskWorkspaceListItem as DomainTaskWorkspaceListItem,
  TaskWorkspaceRecovery as DomainTaskWorkspaceRecovery,
  TaskWorkspaceSubmission as DomainTaskWorkspaceSubmission,
  TaskWorkspaceViewer as DomainTaskWorkspaceViewer,
} from "@hraness/agent-tasks-domain";
import {
  taskWorkspaceDetailCollectionValues,
  taskWorkspaceRecoveryKindValues,
  taskWorkspaceViewValues,
} from "@hraness/agent-tasks-domain";
import type {
  RunnerPresenceView,
} from "@hraness/agent-tasks-protocol";

/** Backend-neutral state and action port shared by hosted and local task surfaces. */

export const taskWorkspaceViews = taskWorkspaceViewValues;

export type TaskWorkspaceView = (typeof taskWorkspaceViews)[number];

export type TaskWorkspaceActor = ProjectionActor;
export type TaskWorkspaceViewer = DomainTaskWorkspaceViewer;

export type TaskWorkspaceAgent = Readonly<{
  id: string;
  name: string;
  status: "active" | "disabled";
}>;

export type TaskWorkspaceLink = DomainTaskWorkspaceLink;
export type TaskWorkspaceGraphEdge = DomainTaskWorkspaceGraphEdge;
export type TaskWorkspaceComment = DomainTaskWorkspaceComment;
export type TaskWorkspaceEvent = DomainTaskWorkspaceEvent;
export type TaskWorkspaceSubmission = DomainTaskWorkspaceSubmission;

export const taskWorkspaceDetailCollections =
  taskWorkspaceDetailCollectionValues;

export type TaskWorkspaceDetailCollection =
  (typeof taskWorkspaceDetailCollections)[number];

export const taskWorkspaceRecoveryKinds = taskWorkspaceRecoveryKindValues;

export type TaskWorkspaceRecoveryKind = (typeof taskWorkspaceRecoveryKinds)[number];

export type TaskWorkspaceRecovery = DomainTaskWorkspaceRecovery;
export type TaskWorkspaceDetail = DomainTaskWorkspaceDetail;

export type TaskWorkspaceError = Readonly<{
  code: string;
  reference?: string;
}>;

export type TaskWorkspaceSelection =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "loading"; taskKey: string }>
  | Readonly<{ error: TaskWorkspaceError; kind: "error"; taskKey: string }>
  | Readonly<{ detail: TaskWorkspaceDetail; kind: "ready" }>;

export type TaskWorkspaceCount = DomainTaskWorkspaceCount;

export type TaskHumanInputSummary = TaskHumanInputView;

export type TaskListDisplayKind = PortableRunProjection["events"][number]["kind"];

export type TaskWorkspaceListItem = DomainTaskWorkspaceListItem;

/** Expires stale previews, then stably partitions pending input without inventing cross-page order. */
export function prioritizeTasksNeedingInput(
  tasks: readonly TaskWorkspaceListItem[],
  now: number,
): readonly TaskWorkspaceListItem[] {
  return tasks
    .map((item, index) => {
      const activeItem = item.humanInput !== null && item.humanInput.expiresAt <= now
        ? { ...item, humanInput: null }
        : item;
      return { index, input: activeItem.humanInput, item: activeItem };
    })
    .sort((left, right) => {
      if (left.input === null && right.input !== null) return 1;
      if (left.input !== null && right.input === null) return -1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

/** Compact, monotonic elapsed copy for live work without noisy timestamps. */
export function elapsedTaskTime(now: number, startedAt: number): string {
  if (!Number.isFinite(now) || !Number.isFinite(startedAt)) return "0s";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds === 0
    ? `${minutes}m`
    : `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export type TaskTranscriptMessage = Readonly<{
  id: string;
  kind: "response" | "thinking";
  text: string;
}>;

/** Coalesces transport deltas without joining text across a status/tool boundary. */
export function taskTranscriptMessages(
  events: PortableRunProjection["events"],
): readonly TaskTranscriptMessage[] {
  const messages: TaskTranscriptMessage[] = [];
  let canAppend = false;
  for (const event of events) {
    if (
      event.kind !== "codex.reasoning_summary.delta" &&
      event.kind !== "codex.assistant_message.delta"
    ) {
      canAppend = false;
      continue;
    }
    const kind = event.kind === "codex.reasoning_summary.delta" ? "thinking" : "response";
    const previous = messages.at(-1);
    if (canAppend && previous !== undefined && previous.kind === kind) {
      messages[messages.length - 1] = {
        id: previous.id,
        kind,
        text: previous.text + event.displayText,
      };
      continue;
    }
    messages.push({ id: event.id, kind, text: event.displayText });
    canAppend = true;
  }
  return messages;
}

export type TaskWorkspaceCounts = Readonly<Record<TaskWorkspaceView, TaskWorkspaceCount>>;

export type TaskWorkspaceReadState =
  | Readonly<{ kind: "loading"; view: TaskWorkspaceView }>
  | Readonly<{ error: TaskWorkspaceError; kind: "error"; view: TaskWorkspaceView }>
  | Readonly<{
      cursor: string | null;
      kind: "ready";
      selection: TaskWorkspaceSelection;
      tasks: readonly TaskWorkspaceListItem[];
      view: TaskWorkspaceView;
    }>;

export type TaskWorkspaceCapabilities = Readonly<{
  canAssign: boolean;
  canCancel: boolean;
  canComment: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canManageGraph: boolean;
  canManageLabels: boolean;
  canManageReferences: boolean;
  canReopen: boolean;
  canReview: boolean;
}>;

export type TaskWorkspaceActionResult =
  | Readonly<{ ok: true; requestId: string }>
  | Readonly<{ error: TaskWorkspaceError; ok: false }>;

export type RunInteractionQuestionDraft = Readonly<{
  otherText: string;
  selectedOptionIds: readonly string[];
}>;

export function setRunInteractionOption(
  draft: RunInteractionQuestionDraft,
  optionId: string,
  checked: boolean,
): RunInteractionQuestionDraft {
  const selected = new Set(draft.selectedOptionIds);
  if (checked) selected.add(optionId);
  else selected.delete(optionId);
  return { ...draft, selectedOptionIds: [...selected] };
}

export function setRunInteractionOtherText(
  draft: RunInteractionQuestionDraft,
  otherText: string,
): RunInteractionQuestionDraft {
  return { ...draft, otherText };
}

export type CreateTaskInput = Readonly<{
  availableAt?: number;
  description: string;
  labels: readonly string[];
  parentKey?: string;
  priority: TaskPriority;
  repositoryId?: string;
  title: string;
  type: TaskType;
}>;

export type UpdateTaskInput = Readonly<{
  description: string;
  priority: TaskPriority;
  revision: number;
  taskKey: string;
  title: string;
  type: TaskType;
}>;

export type TaskWorkspaceActions = Readonly<{
  abandonAmbiguousRun: (input: Readonly<{
    reason: "confirmed_cancelled" | "declared_failed";
    runId: string;
    taskRevision: number;
  }>) => Promise<TaskWorkspaceActionResult>;
  acceptSubmission: (input: Readonly<{
    reviewRevision: number;
    submissionId: string;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  addBlocker: (input: Readonly<{
    blockerKey: string;
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  addComment: (input: Readonly<{
    body: string;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  addLabel: (input: Readonly<{
    label: string;
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  addReference: (input: Readonly<{
    reference: TaskReferenceInput;
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  cancelTask: (input: Readonly<{
    reason: string;
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  clearParent: (input: Readonly<{
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  createTask: (input: CreateTaskInput) => Promise<TaskWorkspaceActionResult>;
  deferTask: (input: Readonly<{
    availableAt: number;
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  loadMore: (cursor: string, view: TaskWorkspaceView) => void;
  rejectSubmission: (input: Readonly<{
    reason: string;
    reviewRevision: number;
    submissionId: string;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  removeBlocker: (input: Readonly<{
    blockedTaskKey: string;
    blockerKey: string;
    revision: number;
  }>) => Promise<TaskWorkspaceActionResult>;
  removeLabel: (input: Readonly<{
    label: string;
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  removeReference: (input: Readonly<{
    referenceId: string;
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  reopenTask: (input: Readonly<{
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  respondToRunInteraction: (input: Readonly<{
    interactionId: string;
    request: PortableRunInteractionRequest;
    response: PortableRunInteractionResponse;
    runId: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  requestRunStop: (input: Readonly<{
    runId: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  retryRun: (input: Readonly<{
    runId: string;
    taskRevision: number;
  }>) => Promise<TaskWorkspaceActionResult>;
  selectTask: (taskKey: string | null) => void;
  setAssignee: (input: Readonly<{
    agentId: string | null;
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  setParent: (input: Readonly<{
    parentKey: string;
    revision: number;
    taskKey: string;
  }>) => Promise<TaskWorkspaceActionResult>;
  updateTask: (input: UpdateTaskInput) => Promise<TaskWorkspaceActionResult>;
  viewChanged: (view: TaskWorkspaceView) => void;
}>;

export type TaskWorkspaceProps = Readonly<{
  actions: TaskWorkspaceActions;
  agents: readonly TaskWorkspaceAgent[];
  capabilities: TaskWorkspaceCapabilities;
  counts: TaskWorkspaceCounts;
  now: number;
  read: TaskWorkspaceReadState;
  runner: Readonly<{
    presence: RunnerPresenceView;
    repositories: readonly Readonly<{
      id: string;
      name: string;
      ready: boolean;
    }>[];
  }>;
  viewer: TaskWorkspaceViewer;
  workspace: Readonly<{
    id: string;
    keyPrefix: string;
    name: string;
    slug: string;
  }>;
}>;

export type TaskWorkspaceUiState = Readonly<{
  composer: null | Readonly<{ kind: "create" }> | Readonly<{ kind: "edit"; taskKey: string }>;
  detailPanel: "work" | "activity";
  notice:
    | null
    | Readonly<{ kind: "success"; requestId: string }>
    | Readonly<{ error: TaskWorkspaceError; kind: "error" }>;
  pendingOperation: null | Readonly<{ id: number; label: string }>;
}>;

export type TaskWorkspaceUiEvent =
  | Readonly<{ type: "composer.create" }>
  | Readonly<{ taskKey: string; type: "composer.edit" }>
  | Readonly<{ type: "composer.close" }>
  | Readonly<{ panel: "work" | "activity"; type: "panel.select" }>
  | Readonly<{ id: number; label: string; type: "operation.started" }>
  | Readonly<{ id: number; result: TaskWorkspaceActionResult; type: "operation.finished" }>
  | Readonly<{ type: "notice.dismissed" }>;

export const initialTaskWorkspaceUiState: TaskWorkspaceUiState = {
  composer: null,
  detailPanel: "work",
  notice: null,
  pendingOperation: null,
};

export function effectiveRunnerPresence(
  presence: RunnerPresenceView,
  serverNow: number,
): RunnerPresenceView {
  if (presence.state === "offline" || presence.leaseUntil > serverNow) return presence;
  return { state: "offline", serverTime: serverNow };
}

export function taskWorkspaceReducer(
  state: TaskWorkspaceUiState,
  event: TaskWorkspaceUiEvent,
): TaskWorkspaceUiState {
  switch (event.type) {
    case "composer.create":
      return state.pendingOperation === null
        ? { ...state, composer: { kind: "create" }, notice: null }
        : state;
    case "composer.edit":
      return state.pendingOperation === null
        ? { ...state, composer: { kind: "edit", taskKey: event.taskKey }, notice: null }
        : state;
    case "composer.close":
      return state.pendingOperation === null ? { ...state, composer: null } : state;
    case "panel.select":
      return { ...state, detailPanel: event.panel };
    case "operation.started":
      return {
        ...state,
        notice: null,
        pendingOperation: { id: event.id, label: event.label },
      };
    case "operation.finished": {
      if (state.pendingOperation?.id !== event.id) return state;
      return {
        ...state,
        composer: event.result.ok ? null : state.composer,
        notice: event.result.ok
          ? { kind: "success", requestId: event.result.requestId }
          : { error: event.result.error, kind: "error" },
        pendingOperation: null,
      };
    }
    case "notice.dismissed":
      return { ...state, notice: null };
  }
}

export const taskWorkspaceViewLabels: Readonly<Record<TaskWorkspaceView, string>> = {
  all: "All",
  ready: "Ready",
  blocked: "Blocked",
  deferred: "Deferred",
  attention: "Attention",
  assigned: "Assigned",
  review: "Review",
};

export const taskWorkspaceRecoveryGuidance: Readonly<
  Record<TaskWorkspaceRecoveryKind, Readonly<{ body: string; title: string }>>
> = {
  access_revoked: {
    title: "Agent access was revoked",
    body: "Running process sessions cannot resume with that authority. Use another active credential or enroll a replacement in a trusted terminal; never paste bearer material into this page.",
  },
  task_cancelled: {
    title: "Task cancelled; history retained",
    body: "Claims are fenced and new work is stopped, but comments, evidence, events, and graph edges remain auditable. Reopen only if the original intent still applies.",
  },
  submission_rejected: {
    title: "Submission rejected",
    body: "The rejected submission and evidence stay immutable. Address the review reason, claim the reopened task again, and create a new submission rather than rewriting the old one.",
  },
  claim_expired: {
    title: "Claim lease expired",
    body: "The old fence is stale and must not be reused. Discard uncommitted task writes, refresh the task, and claim it again before submitting new work.",
  },
  cancelled_blocker: {
    title: "Cancelled blocker needs a decision",
    body: "Cancellation does not silently satisfy a dependency. Remove or replace the blocker edge when the dependency is no longer required, or reopen the blocker if its work still matters.",
  },
};

export function actorLabel(actor: TaskWorkspaceActor): string {
  switch (actor.kind) {
    case "human":
      return `Human · ${actor.name}`;
    case "agent":
      return `Agent · ${actor.name}`;
    case "local_owner":
      return `Local owner · ${actor.name}`;
    case "system":
      return `System · ${actor.jobKind.replaceAll("_", " ")}`;
  }
}

export function taskWorkspaceErrorCopy(code: string): string {
  switch (code) {
    case "AUTHORIZATION_DENIED":
    case "WORKSPACE_ROLE_REQUIRED":
      return "Your current human role does not permit this operation.";
    case "CLAIM_STALE":
      return taskWorkspaceRecoveryGuidance.claim_expired.body;
    case "TASK_STATE_CONFLICT":
      return "The task changed after this view loaded. Refresh its detail before retrying.";
    case "PROJECTION_MISMATCH":
      return "The task graph projection needs repair before this command is safe.";
    case "NOT_FOUND":
      return "The task or related record is no longer visible in this workspace.";
    default:
      return "The control plane could not complete this operation.";
  }
}

export function detailRecoveryKinds(
  detail: TaskWorkspaceDetail,
  now: number,
): readonly TaskWorkspaceRecoveryKind[] {
  const kinds = new Set<TaskWorkspaceRecoveryKind>(detail.recoveries.map(({ kind }) => kind));
  if (detail.task.status === "cancelled") kinds.add("task_cancelled");
  if (detail.task.cancelledBlockerCount > 0) kinds.add("cancelled_blocker");
  if (detail.submission?.status === "rejected") kinds.add("submission_rejected");
  if (detail.task.status === "in_progress" && detail.task.currentClaim.leaseUntil <= now) {
    kinds.add("claim_expired");
  }
  return taskWorkspaceRecoveryKinds.filter((kind) => kinds.has(kind));
}

export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
