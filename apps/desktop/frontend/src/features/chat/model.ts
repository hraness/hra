import {
  runtimeAccountProfileLimit,
  runtimeChatMessageUtf8ByteLimit,
  runtimeRetainedAccountLocalDataLimit,
  type AccountSummary,
  type ChatMessageId,
  type ChatPaneProjection,
  type ChatPaneActivityKind,
  type ChatPaneState,
  type ChatScheduleProjection,
  type ExecutionProjection,
  type HarnessSnapshot,
  type HumanAccountSnapshot,
  type LocalSessionGridSlotProjection,
  type RemoteSessionSummaryProjection,
  type RuntimeChatDomainCommand,
  type RuntimeChatMessageLedgerCommand,
  type RuntimeError,
  type RuntimeHarnessDomainCommand,
} from "../../../../contracts/runtime";
import type { RuntimeShellState } from "../../runtime";

export const paneTitleDebounceMs = 350;
export const paneTitleUtf16CodeUnitLimit = 160;

const paneTitleEncoder = new TextEncoder();
const paneTitleDecoder = new TextDecoder("utf-8", { fatal: true });

export type ChatRoute = "panes" | "settings";

export function chatRouteFromHash(hash: string): ChatRoute {
  return hash === "#settings" ? "settings" : "panes";
}

export function chatRouteHash(route: ChatRoute): `#${ChatRoute}` {
  return `#${route}`;
}

function opaqueId(prefix: "chatmsg" | "pane", randomUuid: () => string): string {
  return `${prefix}_${randomUuid().replaceAll("-", "")}`;
}

export function createPaneId(
  randomUuid: () => string = () => crypto.randomUUID(),
): ChatPaneProjection["id"] {
  return opaqueId("pane", randomUuid);
}

export function createMessageId(
  randomUuid: () => string = () => crypto.randomUUID(),
): ChatMessageId {
  return opaqueId("chatmsg", randomUuid);
}

export function normalizePaneTitle(value: string): string | null {
  if (
    value.includes("\0")
    || paneTitleDecoder.decode(paneTitleEncoder.encode(value)) !== value
  ) return null;
  const trimmed = value.trim();
  let title = "";
  for (const codePoint of trimmed) {
    if (title.length + codePoint.length > paneTitleUtf16CodeUnitLimit) break;
    title += codePoint;
  }
  return title.length === 0 ? null : title;
}

export function paneTitleErrorId(paneId: string): string {
  return `pane-title-error-${paneId}`;
}

export function titleCommitFailureShouldRefocus(input: Readonly<{
  editing: boolean;
  error: string | null;
  pending: boolean;
}>): boolean {
  return input.editing && input.error !== null && !input.pending;
}

export type PaneTitleBlurAction =
  | "commit-and-preserve"
  | "finish"
  | "preserve"
  | "release";

export function paneTitleBlurAction(input: Readonly<{
  draft: string;
  error: string | null;
  pending: boolean;
  title: string;
}>): PaneTitleBlurAction {
  if (input.pending) return "preserve";
  if (input.error !== null) return "release";
  const normalized = normalizePaneTitle(input.draft);
  return normalized === null || normalized === input.title
    ? "finish"
    : "commit-and-preserve";
}

export function validatedPrompt(value: string):
  | Readonly<{ ok: true; prompt: string }>
  | Readonly<{ ok: false; message: string }> {
  if (value.trim().length === 0) {
    return { ok: false, message: "Write a message first." };
  }
  if (value.includes("\0")) {
    return { ok: false, message: "The message contains unsupported text." };
  }
  if (new TextEncoder().encode(value).byteLength > runtimeChatMessageUtf8ByteLimit) {
    return { ok: false, message: "The message is too large to send." };
  }
  return { ok: true, prompt: value };
}

export type ComposerMode = "chat" | "schedule";

export function composerMode(
  schedule: ChatScheduleProjection | null,
  scheduleDraftMode: boolean,
): ComposerMode {
  return schedule !== null || scheduleDraftMode ? "schedule" : "chat";
}

export function formatNextRunRelative(
  nextRunAt: string,
  nowUnixMilliseconds: number,
): string {
  const next = Date.parse(nextRunAt);
  if (!Number.isFinite(next) || !Number.isFinite(nowUnixMilliseconds)) return "time unavailable";
  const remainingMilliseconds = next - nowUnixMilliseconds;
  if (remainingMilliseconds <= 0) return "due now";
  const seconds = Math.max(1, Math.ceil(remainingMilliseconds / 1_000));
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)}d`;
}

export type ComposerEnterAction = "ignore" | "newline" | "submit";

export function composerEnterAction(input: Readonly<{
  isComposing: boolean;
  key: string;
  shiftKey: boolean;
}>): ComposerEnterAction {
  if (input.key !== "Enter" || input.isComposing) return "ignore";
  return input.shiftKey ? "newline" : "submit";
}

export function paneIsActive(state: ChatPaneState): boolean {
  return state === "starting" || state === "streaming" || state === "continuing";
}

export function paneCanCompose(state: ChatPaneState): boolean {
  return state === "ready" || state === "attention";
}

export function paneCanRename(state: ChatPaneState): boolean {
  return state === "ready" || state === "attention";
}

export type PaneWorkspaceStatus = Readonly<{
  message: string;
  retryable: boolean;
}>;

export function paneWorkspaceStatus(
  pane: ChatPaneProjection,
): PaneWorkspaceStatus | null {
  if (pane.interactionMode === "harnessObserver") return null;
  const workspace = pane.workspace;
  if (workspace === null || workspace.mode === "legacyUnbound") {
    return { message: "Create an isolated workspace.", retryable: true };
  }
  switch (workspace.state) {
    case "ready":
      return null;
    case "preparing":
      return { message: "Preparing isolated workspace…", retryable: false };
    case "waitingCapacity":
      return { message: "Workspace is waiting for capacity.", retryable: true };
    case "recoveryRequired":
      return { message: "Workspace needs recovery.", retryable: true };
    case "preserved":
      return { message: "Workspace is preserved.", retryable: false };
  }
}

export type PaneActivityAccent = "neutral" | "response" | "thinking" | "tool";

export const paneAccessibleNameUtf16CodeUnitLimit = 640;

export interface PaneAccessibleNameInput {
  readonly gridPosition: number;
  readonly kind: "local" | "remote";
  readonly ownerDeviceName: string;
  readonly repositoryDisplayName: string | null;
  readonly stateLabel: string;
  readonly title: string;
}

function boundedAccessibleText(value: string, limit: number): string {
  let displaySafe = "";
  for (const codePoint of value) {
    const scalar = codePoint.codePointAt(0) ?? 0;
    displaySafe += scalar <= 31
      || (scalar >= 127 && scalar <= 159)
      || scalar === 0x2028
      || scalar === 0x2029
      ? " "
      : codePoint;
  }
  const normalized = displaySafe
    .replace(/\s+/gu, " ")
    .trim();
  let result = "";
  for (const codePoint of normalized) {
    if (result.length + codePoint.length > limit) break;
    result += codePoint;
  }
  return result.length === 0 ? "Unknown" : result;
}

function boundedRepositoryAccessibleText(value: string | null): string {
  if (value === null) return "No repository";
  const normalized = value.trim();
  if (
    normalized.startsWith("/")
    || normalized.startsWith("~")
    || /^[a-z]:[\\/]/iu.test(normalized)
  ) return "Private repository";
  return boundedAccessibleText(normalized, 120);
}

/**
 * Builds one bounded, path-free accessible identity for both local panes and
 * remote summaries. The durable grid position is always present, so equal
 * titles remain distinguishable without adding visible metadata to the grid.
 */
export function paneAccessibleName(input: PaneAccessibleNameInput): string {
  const position = Number.isSafeInteger(input.gridPosition)
    && input.gridPosition >= 0
    && input.gridPosition < 512
    ? input.gridPosition + 1
    : 1;
  const name = [
    `${input.kind === "local" ? "Chat pane" : "Remote session"}: ${boundedAccessibleText(input.title, 200)}`,
    `repository ${boundedRepositoryAccessibleText(input.repositoryDisplayName)}`,
    `owner ${boundedAccessibleText(input.ownerDeviceName, 64)}`,
    `state ${boundedAccessibleText(input.stateLabel, 48)}`,
    `cell ${position}`,
    ...(input.kind === "remote" ? ["encrypted remote summary", "view only"] : []),
  ].join(", ");
  return boundedAccessibleText(name, paneAccessibleNameUtf16CodeUnitLimit);
}

export function paneActivityAccent(kind: ChatPaneActivityKind): PaneActivityAccent {
  switch (kind) {
    case "idle":
    case "messageSent":
      return "neutral";
    case "thinkingCompleted":
      return "thinking";
    case "toolStarted":
      return "tool";
    case "responseCompleted":
      return "response";
  }
}

export type PaneRevisionConflictResolution =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "retry"; revision: number }>
  | Readonly<{ kind: "stale" }>;

export function resolvePaneRevisionConflict(
  pane: ChatPaneProjection | null,
  attemptedRevision: number,
): PaneRevisionConflictResolution {
  if (pane === null) return { kind: "missing" };
  if (!paneCanRename(pane.state)) return { kind: "cancelled" };
  return pane.revision > attemptedRevision
    ? { kind: "retry", revision: pane.revision }
    : { kind: "stale" };
}

export function paneStatusLabel(state: ChatPaneState): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "streaming":
      return "Working";
    case "continuing":
      return "Preparing account change";
    case "attention":
      return "Needs attention";
  }
}

export function selectPaneIds(state: RuntimeShellState): readonly string[] {
  if (state.state === "connecting") return [];
  return state.snapshot?.chat.panes.map(({ id }) => id) ?? [];
}

export function paneIdsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left === right || (
    left.length === right.length && left.every((id, index) => id === right[index])
  );
}

export function selectRemoteSessions(
  state: RuntimeShellState,
): readonly RemoteSessionSummaryProjection[] {
  if (state.state === "connecting") return [];
  return state.snapshot?.sessionSync.remoteSessions ?? [];
}

export type RemoteSessionId = RemoteSessionSummaryProjection["sessionId"];

export interface RemoteSessionGridSlot {
  readonly sessionId: RemoteSessionId;
  readonly gridPosition: number;
}

export type LocalPaneGridSlot = LocalSessionGridSlotProjection;

export function selectLocalPaneGridSlots(
  state: RuntimeShellState,
): readonly LocalPaneGridSlot[] {
  if (state.state === "connecting") return [];
  return state.snapshot?.sessionSync.localGridSlots ?? [];
}

export function localPaneGridSlotsEqual(
  left: readonly LocalPaneGridSlot[],
  right: readonly LocalPaneGridSlot[],
): boolean {
  return left === right || (
    left.length === right.length
    && left.every((slot, index) => (
      slot.paneId === right[index]?.paneId
      && slot.gridPosition === right[index]?.gridPosition
    ))
  );
}

/**
 * The ordered pane IDs are mapped onto the sorted local position anchors. This
 * lets an explicit local reorder move panes without moving any remote anchor.
 * A pane that has not entered sync yet appends after every durable slot.
 */
export function resolveLocalPaneGridSlots(
  paneIds: readonly string[],
  persistedSlots: readonly LocalPaneGridSlot[],
  remoteSlots: readonly RemoteSessionGridSlot[],
): readonly LocalPaneGridSlot[] {
  const panes = new Set(paneIds);
  const localPositionAnchors = persistedSlots
    .filter(({ paneId }) => panes.has(paneId))
    .map(({ gridPosition }) => gridPosition)
    .toSorted((left, right) => left - right);
  const highestDurablePosition = Math.max(
    -1,
    ...persistedSlots.map(({ gridPosition }) => gridPosition),
    ...remoteSlots.map(({ gridPosition }) => gridPosition),
  );
  return paneIds.map((paneId, index) => ({
    paneId,
    gridPosition: localPositionAnchors[index] ?? highestDurablePosition +
      1 + index - localPositionAnchors.length,
  }));
}

const remoteSessionGridSlotsBySessions = new WeakMap<
  object,
  readonly RemoteSessionGridSlot[]
>();

export function selectRemoteSessionGridSlots(
  state: RuntimeShellState,
): readonly RemoteSessionGridSlot[] {
  const sessions = selectRemoteSessions(state);
  const cached = remoteSessionGridSlotsBySessions.get(sessions);
  if (cached !== undefined) return cached;
  const slots = [...sessions]
    .sort((left, right) => (
      left.gridPosition - right.gridPosition
      || left.sessionId.localeCompare(right.sessionId)
    ))
    .map(({ sessionId, gridPosition }) => ({ sessionId, gridPosition }));
  remoteSessionGridSlotsBySessions.set(sessions, slots);
  return slots;
}

export function remoteSessionGridSlotsEqual(
  left: readonly RemoteSessionGridSlot[],
  right: readonly RemoteSessionGridSlot[],
): boolean {
  return left === right || (
    left.length === right.length
    && left.every((slot, index) => (
      slot.sessionId === right[index]?.sessionId
      && slot.gridPosition === right[index]?.gridPosition
    ))
  );
}

export interface RemoteSessionRowSelection {
  readonly collisionLine: string | null;
  readonly session: RemoteSessionSummaryProjection;
}

export function selectRemoteSessionIds(state: RuntimeShellState): readonly RemoteSessionId[] {
  return selectRemoteSessionGridSlots(state).map(({ sessionId }) => sessionId);
}

export function remoteSessionIdsEqual(
  left: readonly RemoteSessionId[],
  right: readonly RemoteSessionId[],
): boolean {
  return left === right || (
    left.length === right.length && left.every((id, index) => id === right[index])
  );
}

interface SessionTitleCollisionCandidate {
  readonly device: string;
  readonly gridPosition: number;
  readonly repository: string;
  readonly title: string;
}

interface TitleCollisionIndex {
  readonly count: number;
  readonly devices: ReadonlyMap<string, number>;
  readonly repositories: ReadonlyMap<string, number>;
  readonly deviceRepositories: ReadonlyMap<string, number>;
}

function incrementCollisionCount(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function shortestUniqueCollisionLine(
  session: SessionTitleCollisionCandidate,
  collisions: TitleCollisionIndex,
): string {
  const deviceRepository = `${session.device} · ${session.repository}`;
  const candidates = [
    {
      value: session.device,
      count: collisions.devices.get(session.device) ?? 0,
    },
    {
      value: session.repository,
      count: collisions.repositories.get(session.repository) ?? 0,
    },
    {
      value: deviceRepository,
      count: collisions.deviceRepositories.get(deviceRepository) ?? 0,
    },
  ].filter(({ count }) => count === 1)
    .toSorted((left, right) => left.value.length - right.value.length);
  return candidates[0]?.value ?? `Position ${session.gridPosition + 1}`;
}

interface RemoteSessionRowsIndex {
  readonly byId: ReadonlyMap<RemoteSessionId, RemoteSessionRowSelection>;
}

const remoteSessionRowsBySessions = new WeakMap<object, Readonly<{
  contextSignature: string;
  index: RemoteSessionRowsIndex;
}>>();
const remoteSessionRowsByState = new WeakMap<object, RemoteSessionRowsIndex>();

function remoteSessionRowsIndex(state: RuntimeShellState): RemoteSessionRowsIndex {
  const stateObject = state;
  const stateCached = remoteSessionRowsByState.get(stateObject);
  if (stateCached !== undefined) return stateCached;
  const sessions = selectRemoteSessions(state);
  const snapshot = state.state === "connecting" ? null : state.snapshot;
  const panes = snapshot?.chat.panes ?? [];
  const currentDeviceName = snapshot?.sessionSync.status.state === "active"
    ? snapshot.sessionSync.status.deviceName
    : "This device";
  const persistedLocalSlots = snapshot?.sessionSync.localGridSlots ?? [];
  const contextSignature = JSON.stringify({
    currentDeviceName,
    panes: panes.map(({ id, repository, title }) => [id, repository.name, title]),
    persistedLocalSlots: persistedLocalSlots.map(({ gridPosition, paneId }) => [
      paneId,
      gridPosition,
    ]),
  });
  const cached = remoteSessionRowsBySessions.get(sessions);
  if (cached?.contextSignature === contextSignature) {
    remoteSessionRowsByState.set(stateObject, cached.index);
    return cached.index;
  }
  const localSlots = resolveLocalPaneGridSlots(
    panes.map(({ id }) => id),
    persistedLocalSlots,
    selectRemoteSessionGridSlots(state),
  );
  const localPosition = new Map(
    localSlots.map(({ paneId, gridPosition }) => [paneId, gridPosition] as const),
  );
  const candidates: SessionTitleCollisionCandidate[] = [
    ...panes.map((pane) => ({
      device: currentDeviceName,
      gridPosition: localPosition.get(pane.id) ?? Number.MAX_SAFE_INTEGER,
      repository: pane.repository.name,
      title: pane.title,
    })),
    ...sessions.map((session) => ({
      device: session.originDeviceName,
      gridPosition: session.gridPosition,
      repository: session.repositoryDisplayName ?? "No repository",
      title: session.title,
    })),
  ];
  const collisionsByTitle = new Map<string, {
    count: number;
    devices: Map<string, number>;
    repositories: Map<string, number>;
    deviceRepositories: Map<string, number>;
  }>();
  for (const candidate of candidates) {
    let collisions = collisionsByTitle.get(candidate.title);
    if (collisions === undefined) {
      collisions = {
        count: 0,
        devices: new Map(),
        repositories: new Map(),
        deviceRepositories: new Map(),
      };
      collisionsByTitle.set(candidate.title, collisions);
    }
    collisions.count += 1;
    incrementCollisionCount(collisions.devices, candidate.device);
    incrementCollisionCount(collisions.repositories, candidate.repository);
    incrementCollisionCount(
      collisions.deviceRepositories,
      `${candidate.device} · ${candidate.repository}`,
    );
  }
  const byId = new Map<RemoteSessionId, RemoteSessionRowSelection>();
  for (const session of sessions) {
    const selected = {
      device: session.originDeviceName,
      gridPosition: session.gridPosition,
      repository: session.repositoryDisplayName ?? "No repository",
      title: session.title,
    };
    const collisions = collisionsByTitle.get(session.title);
    byId.set(session.sessionId, {
      session,
      collisionLine: collisions !== undefined && collisions.count > 1
        ? shortestUniqueCollisionLine(selected, collisions)
        : null,
    });
  }
  const index = { byId };
  remoteSessionRowsBySessions.set(sessions, { contextSignature, index });
  remoteSessionRowsByState.set(stateObject, index);
  return index;
}

export function selectRemoteSessionRow(
  state: RuntimeShellState,
  sessionId: RemoteSessionId,
): RemoteSessionRowSelection | null {
  return remoteSessionRowsIndex(state).byId.get(sessionId) ?? null;
}

export function remoteSessionRowEqual(
  left: RemoteSessionRowSelection | null,
  right: RemoteSessionRowSelection | null,
): boolean {
  return left === right || (
    left !== null
    && right !== null
    && left.session === right.session
    && left.collisionLine === right.collisionLine
  );
}

export function remoteSessionsEqual(
  left: readonly RemoteSessionSummaryProjection[],
  right: readonly RemoteSessionSummaryProjection[],
): boolean {
  return left === right || (
    left.length === right.length
    && left.every((session, index) => session === right[index])
  );
}

const paneIndexByArray = new WeakMap<
  readonly ChatPaneProjection[],
  ReadonlyMap<ChatPaneProjection["id"], ChatPaneProjection>
>();

function indexedPanes(
  panes: readonly ChatPaneProjection[],
): ReadonlyMap<ChatPaneProjection["id"], ChatPaneProjection> {
  const cached = paneIndexByArray.get(panes);
  if (cached !== undefined) return cached;
  const indexed = new Map<ChatPaneProjection["id"], ChatPaneProjection>();
  for (const pane of panes) indexed.set(pane.id, pane);
  paneIndexByArray.set(panes, indexed);
  return indexed;
}

export function selectPane(
  state: RuntimeShellState,
  paneId: string,
): ChatPaneProjection | null {
  if (state.state === "connecting") return null;
  const panes = state.snapshot?.chat.panes;
  return panes === undefined ? null : indexedPanes(panes).get(paneId) ?? null;
}

/**
 * Resolves message authority only from renderer-safe projection fields.
 * Ordinary chat panes carry their authority in interactionMode. Attached
 * actor panes must have exactly one parent child projection granting the
 * action; missing or conflicting parent evidence fails closed.
 */
export function selectPaneCanMessage(
  state: RuntimeShellState,
  paneId: string,
): boolean {
  if (state.state === "connecting") return false;
  const panes = state.snapshot?.chat.panes;
  if (panes === undefined) return false;
  const pane = indexedPanes(panes).get(paneId);
  if (pane === undefined) return false;
  if (pane.interactionMode === "chat") {
    return pane.workspace?.mode === "managedWorktree" &&
      pane.workspace.state === "ready";
  }
  let authority: boolean | null = null;
  for (const parent of panes) {
    for (const child of parent.harness?.descendants.children ?? []) {
      if (child.openedPaneId !== paneId) continue;
      if (authority !== null) return false;
      authority = child.canMessage;
    }
  }
  return authority === true;
}

export type SubscriptionGate = "available" | "loading" | "missing";

export function selectSubscriptionGate(state: RuntimeShellState): SubscriptionGate {
  if (state.state === "connecting" || state.snapshot === null) return "loading";
  return state.snapshot.accounts.some(({ authState }) => authState === "signedIn")
    ? "available"
    : "missing";
}

export type PaneRepository = ChatPaneProjection["repository"];

export function selectLastLocalPaneRepository(
  state: RuntimeShellState,
): PaneRepository | null {
  if (state.state === "connecting" || state.snapshot === null) return null;
  const panes = state.snapshot.chat.panes;
  if (panes.length === 0) return null;
  const slots = resolveLocalPaneGridSlots(
    panes.map(({ id }) => id),
    state.snapshot.sessionSync.localGridSlots,
    state.snapshot.sessionSync.remoteSessions.map(({ sessionId, gridPosition }) => ({
      sessionId,
      gridPosition,
    })),
  );
  const lastPaneId = slots.toSorted((left, right) => (
    right.gridPosition - left.gridPosition || right.paneId.localeCompare(left.paneId)
  ))[0]?.paneId;
  return panes.find(({ id }) => id === lastPaneId)?.repository ?? null;
}

export function paneRepositoriesEqual(
  left: PaneRepository | null,
  right: PaneRepository | null,
): boolean {
  return left === right || (
    left !== null && right !== null && left.id === right.id && left.name === right.name
  );
}

export function accountsEqual(
  left: readonly AccountSummary[],
  right: readonly AccountSummary[],
): boolean {
  return left === right || (
    left.length === right.length && left.every((account, index) => account === right[index])
  );
}

export function selectAllAccounts(state: RuntimeShellState): readonly AccountSummary[] {
  if (state.state === "connecting") return [];
  return state.snapshot?.accounts ?? [];
}

const connectingHumanAccount: HumanAccountSnapshot = {
  state: "unavailable",
  revision: 0,
  reason: "configuration_missing",
};

export function selectHumanAccount(
  state: RuntimeShellState,
): HumanAccountSnapshot {
  if (state.state === "connecting") return connectingHumanAccount;
  return state.snapshot?.humanAccount ?? connectingHumanAccount;
}

export function selectAccountCreationAvailable(state: RuntimeShellState): boolean {
  if (state.state === "connecting" || state.snapshot === null) return false;
  return state.snapshot.accounts.length < runtimeAccountProfileLimit &&
    state.snapshot.accounts.length + state.snapshot.retainedAccountLocalData.length <
      runtimeRetainedAccountLocalDataLimit;
}

export function selectHarness(state: RuntimeShellState): HarnessSnapshot | null {
  if (state.state === "connecting") return null;
  return state.snapshot?.harness ?? null;
}

export function harnessEqual(
  left: HarnessSnapshot | null,
  right: HarnessSnapshot | null,
): boolean {
  return left === right;
}

export type RuntimeAvailability =
  | Readonly<{ kind: "connecting" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "unavailable"; message: string; reconnectable: boolean }>;

export function selectRuntimeAvailability(state: RuntimeShellState): RuntimeAvailability {
  switch (state.state) {
    case "connecting":
      return { kind: "connecting" };
    case "reconnecting":
      return {
        kind: "unavailable",
        message: "Reconnecting to the local runtime…",
        reconnectable: false,
      };
    case "failed":
      return {
        kind: "unavailable",
        message: state.failure.message,
        reconnectable: state.failure.kind !== "transport" ||
          state.failure.canRetry !== false,
      };
    case "ready":
      switch (state.snapshot.runtime.state) {
        case "ready":
          return { kind: "ready" };
        case "starting":
          return { kind: "connecting" };
        case "backingOff":
          return {
            kind: "unavailable",
            message: "The local runtime is restarting…",
            reconnectable: false,
          };
        case "failed":
          return {
            kind: "unavailable",
            message: state.snapshot.runtime.message,
            reconnectable: state.snapshot.runtime.canRestart,
          };
        case "stopped":
          return {
            kind: "unavailable",
            message: "The local runtime is stopped.",
            reconnectable: true,
          };
      }
  }
}

export function runtimeAvailabilityEqual(
  left: RuntimeAvailability,
  right: RuntimeAvailability,
): boolean {
  return left.kind === right.kind && (
    left.kind !== "unavailable" || (
      right.kind === "unavailable" &&
      left.message === right.message &&
      left.reconnectable === right.reconnectable
    )
  );
}

const unavailableExecution: ExecutionProjection = {
  folderAccess: {
    revision: 1,
    displayName: "Documents",
    availability: "missing",
  },
  approvalPolicy: "never",
  approvalsReviewer: "auto_review",
  sandbox: "danger-full-access",
  computerUse: "required",
};

export function selectExecution(state: RuntimeShellState): ExecutionProjection {
  if (state.state === "connecting") return unavailableExecution;
  return state.snapshot?.execution ?? unavailableExecution;
}

export function executionEqual(
  left: ExecutionProjection,
  right: ExecutionProjection,
): boolean {
  return left === right || (
    left.folderAccess.revision === right.folderAccess.revision &&
    left.folderAccess.displayName === right.folderAccess.displayName &&
    left.folderAccess.availability === right.folderAccess.availability &&
    left.approvalPolicy === right.approvalPolicy &&
    left.approvalsReviewer === right.approvalsReviewer &&
    left.sandbox === right.sandbox &&
    left.computerUse === right.computerUse
  );
}

export function createPaneCommand(input: Readonly<{
  paneId: ChatPaneProjection["id"];
  repositoryId: ChatPaneProjection["repository"]["id"];
}>): Extract<RuntimeChatDomainCommand, { readonly type: "chat.pane.create" }> {
  return {
    type: "chat.pane.create",
    paneId: input.paneId,
    repositoryId: input.repositoryId,
  };
}

export function reorderPanesCommand(
  input: Readonly<{
    expectedOrderedPaneIds: readonly ChatPaneProjection["id"][];
    orderedPaneIds: readonly ChatPaneProjection["id"][];
  }>,
): Extract<RuntimeChatDomainCommand, { readonly type: "chat.panes.reorder" }> {
  return {
    type: "chat.panes.reorder",
    expectedOrderedPaneIds: [...input.expectedOrderedPaneIds],
    orderedPaneIds: [...input.orderedPaneIds],
  };
}

export function renamePaneCommand(input: Readonly<{
  paneId: ChatPaneProjection["id"];
  expectedRevision: number;
  title: string;
}>): Extract<RuntimeChatDomainCommand, { readonly type: "chat.pane.rename" }> {
  return { type: "chat.pane.rename", ...input };
}

export function configurePaneScheduleCommand(input: Readonly<{
  paneId: ChatPaneProjection["id"];
  expectedRevision: number;
  instruction: string;
}>): Extract<
  RuntimeChatDomainCommand,
  { readonly type: "chat.pane.schedule.configure" }
> {
  return { type: "chat.pane.schedule.configure", ...input };
}

export function removePaneScheduleCommand(input: Readonly<{
  paneId: ChatPaneProjection["id"];
  expectedRevision: number;
}>): Extract<
  RuntimeChatDomainCommand,
  { readonly type: "chat.pane.schedule.remove" }
> {
  return { type: "chat.pane.schedule.remove", ...input };
}

export function recoverPaneWorkspaceCommand(input: Readonly<{
  paneId: ChatPaneProjection["id"];
  expectedRevision: number;
}>): Extract<RuntimeChatDomainCommand, { readonly type: "chat.pane.workspace.recover" }> {
  return { type: "chat.pane.workspace.recover", ...input };
}

export function selectPaneRepositoryCommand(input: Readonly<{
  paneId: ChatPaneProjection["id"];
  expectedRevision: number;
  repositoryId: ChatPaneProjection["repository"]["id"];
}>): Extract<RuntimeChatDomainCommand, { readonly type: "chat.pane.repository.select" }> {
  return { type: "chat.pane.repository.select", ...input };
}

type MessageLedgerCommand<Type extends RuntimeChatMessageLedgerCommand["type"]> =
  Extract<RuntimeChatMessageLedgerCommand, { readonly type: Type }>;

export function enqueueMessageCommand(
  input: Omit<MessageLedgerCommand<"chat.message.enqueue">, "type">,
): MessageLedgerCommand<"chat.message.enqueue"> {
  return { type: "chat.message.enqueue", ...input };
}

export function editQueuedMessageCommand(
  input: Omit<MessageLedgerCommand<"chat.message.edit">, "type">,
): MessageLedgerCommand<"chat.message.edit"> {
  return { type: "chat.message.edit", ...input };
}

export function removeQueuedMessageCommand(
  input: Omit<MessageLedgerCommand<"chat.message.remove">, "type">,
): MessageLedgerCommand<"chat.message.remove"> {
  return { type: "chat.message.remove", ...input };
}

export function resumeMessageQueueCommand(
  input: Omit<MessageLedgerCommand<"chat.messageQueue.resume">, "type">,
): MessageLedgerCommand<"chat.messageQueue.resume"> {
  return { type: "chat.messageQueue.resume", ...input };
}

export function startFreshProviderContextCommand(
  input: Omit<MessageLedgerCommand<"chat.pane.startFreshContext">, "type">,
): MessageLedgerCommand<"chat.pane.startFreshContext"> {
  return { type: "chat.pane.startFreshContext", ...input };
}

export function discardAmbiguousMessageCommand(
  input: Omit<MessageLedgerCommand<"chat.message.discardAmbiguous">, "type">,
): MessageLedgerCommand<"chat.message.discardAmbiguous"> {
  return { type: "chat.message.discardAmbiguous", ...input };
}

export function steerQueuedMessageCommand(
  input: Omit<MessageLedgerCommand<"chat.message.steerHead">, "type">,
): MessageLedgerCommand<"chat.message.steerHead"> {
  return { type: "chat.message.steerHead", ...input };
}

export function stopTurnCommand(input: Readonly<{
  paneId: ChatPaneProjection["id"];
  expectedRevision: number;
  turnId: NonNullable<ChatPaneProjection["turn"]>["id"];
}>): Extract<RuntimeChatDomainCommand, { readonly type: "chat.turn.stop" }> {
  return { type: "chat.turn.stop", ...input };
}

export function updateHarnessSettingsCommand(input: Readonly<{
  expectedHarnessRevision: number;
  expectedRevision: number;
  recursiveSessionsEnabled: boolean;
  contextQuotaBytes: number;
  refinementMode: HarnessSnapshot["settings"]["refinementMode"];
}>): Extract<RuntimeHarnessDomainCommand, { readonly type: "harness.settings.update" }> {
  return { type: "harness.settings.update", ...input };
}

export function openHarnessChildCommand(input: Readonly<{
  parentPaneId: string;
  childId: string;
  expectedParentRevision: number;
  expectedChildRevision: number;
}>): Extract<RuntimeHarnessDomainCommand, { readonly type: "harness.child.open" }> {
  return { type: "harness.child.open", ...input };
}

export function stopHarnessChildCommand(input: Readonly<{
  parentPaneId: string;
  childId: string;
  expectedParentRevision: number;
  expectedChildRevision: number;
}>): Extract<RuntimeHarnessDomainCommand, { readonly type: "harness.child.stop" }> {
  return { type: "harness.child.stop", ...input };
}

export function isRevisionConflict(error: RuntimeError): boolean {
  return error.code === "conflict" ||
    error.code === "revision_conflict" ||
    error.code === "stale_revision";
}

export interface ScheduledTitleCommit {
  readonly revision: number;
  readonly title: string;
}

export type PaneTitleCommitReason = "finish" | "idle";

export interface PaneTitleBaseline {
  readonly revision: number;
  readonly title: string;
}

export interface PaneTitleCommitReconciliation {
  readonly baseline: PaneTitleBaseline;
  readonly draft: string;
  readonly finishEditing: boolean;
}

export function reconcilePaneTitleCommit(input: Readonly<{
  baseline: PaneTitleBaseline;
  commit: ScheduledTitleCommit;
  committedPane: PaneTitleBaseline;
  draft: string;
  reason: PaneTitleCommitReason;
}>): PaneTitleCommitReconciliation {
  if (
    input.committedPane.revision < input.commit.revision
    || input.committedPane.title !== input.commit.title
  ) {
    throw new RangeError("The saved pane title result does not match its commit.");
  }
  const baseline = input.committedPane.revision > input.baseline.revision
    ? input.committedPane
    : input.baseline;
  const commitIsCurrent = baseline.title === input.commit.title
    && normalizePaneTitle(input.draft) === input.commit.title;
  return {
    baseline,
    draft: commitIsCurrent ? input.commit.title : input.draft,
    finishEditing: input.reason === "finish" && commitIsCurrent,
  };
}

export interface TimeoutScheduler {
  clear(handle: unknown): void;
  set(callback: () => void, delayMs: number): unknown;
}

const browserTimeoutScheduler: TimeoutScheduler = {
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  set: (callback, delayMs) => setTimeout(callback, delayMs),
};

export interface TitleDebouncer {
  cancel(): void;
  flush(): void;
  schedule(commit: ScheduledTitleCommit): void;
}

export function createTitleDebouncer(
  onCommit: (commit: ScheduledTitleCommit, reason: PaneTitleCommitReason) => void,
  scheduler: TimeoutScheduler = browserTimeoutScheduler,
): TitleDebouncer {
  let pending: ScheduledTitleCommit | null = null;
  let handle: unknown = null;

  const cancelTimer = (): void => {
    if (handle === null) return;
    scheduler.clear(handle);
    handle = null;
  };
  const flushPending = (reason: PaneTitleCommitReason): void => {
    cancelTimer();
    const commit = pending;
    pending = null;
    if (commit !== null) onCommit(commit, reason);
  };
  return {
    cancel: () => {
      cancelTimer();
      pending = null;
    },
    flush: () => flushPending("finish"),
    schedule: (commit) => {
      pending = commit;
      cancelTimer();
      handle = scheduler.set(() => flushPending("idle"), paneTitleDebounceMs);
    },
  };
}
