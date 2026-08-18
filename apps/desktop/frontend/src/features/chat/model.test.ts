import { expect, test } from "bun:test";

import {
  runtimeChatDomainCommandSchema,
  runtimeProtocolVersion,
  runtimeChatTurnPromptUtf8ByteLimit,
  runtimeSnapshotSchema,
  remoteSessionSummaryProjectionSchema,
  type ChatPaneProjection,
  type RemoteSessionSummaryProjection,
  type RuntimeDispatchResponse,
} from "../../../../contracts/runtime";
import { emptyRuntimeSnapshot } from "../../runtime/test-fixtures";
import {
  dispatchPaneTitleMutation,
  fencePendingPaneTitleInteraction,
  isNearPaneBottom,
  preservePendingPaneTitleFocus,
  type PaneTitleMutationPort,
} from "./ChatPane";
import {
  composerEnterAction,
  createPaneCommand,
  createPaneId,
  createTitleDebouncer,
  createTurnId,
  normalizePaneTitle,
  openHarnessChildCommand,
  paneAccessibleName,
  paneAccessibleNameUtf16CodeUnitLimit,
  paneCanCompose,
  paneCanRename,
  paneCanRetryRetainedPrompt,
  paneIsActive,
  paneStatusLabel,
  paneWorkspaceStatus,
  paneTitleBlurAction,
  paneTitleDebounceMs,
  paneTitleErrorId,
  reconcilePaneTitleCommit,
  recoverPaneWorkspaceCommand,
  reorderPanesCommand,
  resolveLocalPaneGridSlots,
  rootTurnRoutePresentation,
  remoteSessionIdsEqual,
  remoteSessionRowEqual,
  selectAccountCreationAvailable,
  selectHarness,
  selectPaneRepositoryCommand,
  selectPane,
  selectPaneCanMessage,
  selectPaneIds,
  selectRemoteSessionIds,
  selectRemoteSessionGridSlots,
  selectRemoteSessionRow,
  selectLastLocalPaneRepository,
  selectSubscriptionGate,
  retryTurnCommand,
  startTurnCommand,
  stopTurnCommand,
  stopHarnessChildCommand,
  titleCommitFailureShouldRefocus,
  updateHarnessSettingsCommand,
  validatedPrompt,
  type TimeoutScheduler,
} from "./model";

function remoteSession(
  index: number,
  overrides: Partial<RemoteSessionSummaryProjection> = {},
): RemoteSessionSummaryProjection {
  return remoteSessionSummaryProjectionSchema.parse({
    sessionId: `syncsession_${index.toString(36).padStart(32, "0")}`,
    originDeviceId: `syncdevice_${(index % 3).toString(36).padStart(32, "0")}`,
    originDeviceName: `Mac ${index % 3}`,
    gridPosition: index,
    sourceRevision: 1,
    title: `Summary ${index + 1}`,
    repositoryDisplayName: `Repo ${index % 5}`,
    state: "ready",
    updatedAt: 100 + index,
    ...overrides,
  });
}

function shellStateWithRemoteSessions(
  remoteSessions: readonly RemoteSessionSummaryProjection[],
  options: Readonly<{
    localGridSlots?: readonly Readonly<{ paneId: string; gridPosition: number }>[];
    panes?: readonly ChatPaneProjection[];
  }> = {},
) {
  return {
    state: "ready" as const,
    snapshot: runtimeSnapshotSchema.parse({
      ...emptyRuntimeSnapshot(),
      chat: { revision: 1, panes: options.panes ?? [] },
      sessionSync: {
        status: {
          state: "active" as const,
          revision: 1,
          scopeGeneration: 1,
          currentDeviceId: `syncdevice_${"c".repeat(32)}`,
          deviceName: "Studio Mac",
          health: "current" as const,
          retryable: false,
          notice: null,
          recovery: "ready" as const,
          devices: [{
            id: `syncdevice_${"c".repeat(32)}`,
            name: "Studio Mac",
            status: "active" as const,
            current: true,
            connection: "online" as const,
          }],
          pendingEnrollments: [],
        },
        localGridSlots: options.localGridSlots ?? [],
        remoteSessions,
      },
    }),
  };
}

function pane(overrides: Partial<ChatPaneProjection> = {}): ChatPaneProjection {
  return {
    id: "pane_example0001",
    revision: 1,
    title: "HRA",
    repository: { id: "repo_example0001", name: "hra" },
    accountProfileId: null,
    interactionMode: "chat",
    state: "ready",
    activity: { ordinal: 0, kind: "idle" },
    workspace: {
      mode: "managedWorktree",
      state: "ready",
      revision: 1,
      recoveryKind: null,
    },
    turn: null,
    attention: null,
    recoverablePrompt: false,
    harness: null,
    ...overrides,
  };
}

const resolvedStandardRoute = {
  policyVersion: 1,
  classificationReason: "conservativeDefault",
  workClass: "standard",
  requestedProfile: "solMax",
  selectedProfile: "solMax",
  profileFallbackReason: null,
  requestedServiceTier: "standard",
  selectedServiceTier: "standard",
  serviceTierFallbackReason: null,
} as const;

function shellState(panes: ChatPaneProjection[]) {
  return {
    state: "ready" as const,
    snapshot: {
      ...emptyRuntimeSnapshot(),
      chat: { revision: 1, panes },
    },
  };
}

function revisionConflict(): RuntimeDispatchResponse {
  return {
    version: runtimeProtocolVersion,
    operationId: "op_00000000000000000000000000",
    ok: false,
    error: {
      code: "revision_conflict",
      message: "The pane revision changed.",
      retryable: true,
      action: "retry",
    },
  };
}

function paneResponse(value: ChatPaneProjection): RuntimeDispatchResponse {
  return {
    version: runtimeProtocolVersion,
    operationId: "op_00000000000000000000000000",
    ok: true,
    result: { type: "chatPane", pane: value },
  };
}

test("renderer-owned pane and turn IDs stay opaque and canonical", () => {
  const randomUuid = () => "12345678-1234-1234-1234-123456789abc";
  expect(createPaneId(randomUuid)).toBe("pane_12345678123412341234123456789abc");
  expect(createTurnId(randomUuid)).toBe("chatturn_12345678123412341234123456789abc");
});

test("pane accessible identities are exact, collision-safe, bounded, and path-free", () => {
  expect(paneAccessibleName({
    gridPosition: 0,
    kind: "local",
    ownerDeviceName: "This Mac",
    repositoryDisplayName: "Example",
    stateLabel: "Ready",
    title: "Release",
  })).toBe(
    "Chat pane: Release, repository Example, owner This Mac, state Ready, cell 1",
  );
  expect(paneAccessibleName({
    gridPosition: 8,
    kind: "remote",
    ownerDeviceName: "Travel Mac",
    repositoryDisplayName: "Example",
    stateLabel: "Needs attention",
    title: "Release",
  })).toBe(
    "Remote session: Release, repository Example, owner Travel Mac, state Needs attention, cell 9, encrypted remote summary, view only",
  );

  const duplicateA = paneAccessibleName({
    gridPosition: 2,
    kind: "local",
    ownerDeviceName: "This Mac",
    repositoryDisplayName: "Example",
    stateLabel: "Ready",
    title: "Release",
  });
  const duplicateB = paneAccessibleName({
    gridPosition: 3,
    kind: "local",
    ownerDeviceName: "This Mac",
    repositoryDisplayName: "Example",
    stateLabel: "Ready",
    title: "Release",
  });
  expect(duplicateA).not.toBe(duplicateB);
  expect(duplicateA).toEndWith("cell 3");
  expect(duplicateB).toEndWith("cell 4");

  const bounded = paneAccessibleName({
    gridPosition: Number.MAX_SAFE_INTEGER,
    kind: "remote",
    ownerDeviceName: `Device\0${"d".repeat(2_000)}`,
    repositoryDisplayName: `/Users/example/private/${"r".repeat(2_000)}`,
    stateLabel: "Error",
    title: "t".repeat(2_000),
  });
  expect(bounded.length).toBeLessThanOrEqual(paneAccessibleNameUtf16CodeUnitLimit);
  expect(bounded).not.toContain("\0");
  expect(bounded).not.toContain("/Users/example/private");
});

test("chat command builders expose no user model or speed preferences", () => {
  expect(createPaneCommand({
    paneId: "pane_example0001",
    repositoryId: "repo_example0001",
  })).toEqual({
    type: "chat.pane.create",
    paneId: "pane_example0001",
    repositoryId: "repo_example0001",
  });
  expect(recoverPaneWorkspaceCommand({
    paneId: "pane_example0001",
    expectedRevision: 4,
  })).toEqual({
    type: "chat.pane.workspace.recover",
    paneId: "pane_example0001",
    expectedRevision: 4,
  });
  expect(selectPaneRepositoryCommand({
    paneId: "pane_example0001",
    expectedRevision: 4,
    repositoryId: "repo_example0002",
  })).toEqual({
    type: "chat.pane.repository.select",
    paneId: "pane_example0001",
    expectedRevision: 4,
    repositoryId: "repo_example0002",
  });
  expect(startTurnCommand({
    paneId: "pane_example0001",
    expectedRevision: 4,
    turnId: "chatturn_example0001",
    prompt: "Ship it",
  })).toEqual({
    type: "chat.turn.start",
    paneId: "pane_example0001",
    expectedRevision: 4,
    turnId: "chatturn_example0001",
    prompt: "Ship it",
  });
  const retry = retryTurnCommand({
    paneId: "pane_example0001",
    expectedRevision: 5,
    priorFailedTurnId: "chatturn_example0001",
    turnId: "chatturn_example0002",
  });
  expect(retry).toEqual({
    type: "chat.turn.retry",
    paneId: "pane_example0001",
    expectedRevision: 5,
    priorFailedTurnId: "chatturn_example0001",
    turnId: "chatturn_example0002",
  });
  expect(Object.hasOwn(retry, "prompt")).toBeFalse();
  expect(stopTurnCommand({
    paneId: "pane_example0001",
    expectedRevision: 7,
    turnId: "chatturn_example0001",
  })).toEqual({
    type: "chat.turn.stop",
    paneId: "pane_example0001",
    expectedRevision: 7,
    turnId: "chatturn_example0001",
  });
  expect(reorderPanesCommand({
    expectedOrderedPaneIds: ["pane_example0001", "pane_example0002"],
    orderedPaneIds: ["pane_example0002", "pane_example0001"],
  })).toEqual({
    type: "chat.panes.reorder",
    expectedOrderedPaneIds: ["pane_example0001", "pane_example0002"],
    orderedPaneIds: ["pane_example0002", "pane_example0001"],
  });
});

test("route presentation stays content-free and names HRA dispatch fallbacks", () => {
  expect(rootTurnRoutePresentation(null)).toBeNull();
  expect(rootTurnRoutePresentation({
    policyVersion: 1,
    classificationReason: "boundedLeafCue",
    workClass: "boundedLeaf",
    requestedProfile: "lunaMax",
    selectedProfile: "lunaMax",
    profileFallbackReason: null,
    requestedServiceTier: "fast",
    selectedServiceTier: "fast",
    serviceTierFallbackReason: null,
  })).toEqual({
    accessibleLabel:
      "HRA requested Luna Max at Fast and selected Luna Max at Fast for dispatch.",
    label: "Route · Luna Max · Fast",
  });
  expect(rootTurnRoutePresentation({
    policyVersion: 1,
    classificationReason: "boundedLeafCue",
    workClass: "boundedLeaf",
    requestedProfile: "lunaMax",
    selectedProfile: null,
    profileFallbackReason: null,
    requestedServiceTier: "fast",
    selectedServiceTier: null,
    serviceTierFallbackReason: null,
  })).toEqual({
    accessibleLabel: "HRA has not resolved this turn's dispatch route.",
    label: "Route · Unresolved",
  });
  expect(rootTurnRoutePresentation({
    policyVersion: 1,
    classificationReason: "boundedLeafCue",
    workClass: "boundedLeaf",
    requestedProfile: "lunaMax",
    selectedProfile: "solMax",
    profileFallbackReason: "lunaUnavailable",
    requestedServiceTier: "fast",
    selectedServiceTier: "standard",
    serviceTierFallbackReason: "fastUnavailable",
  })).toEqual({
    accessibleLabel:
      "HRA requested Luna Max at Fast and selected Sol Max at Standard for dispatch. Luna configuration was unavailable on the selected subscription and Fast service was unavailable on the selected subscription, so HRA used its fallback before dispatch.",
    label: "Route · Sol Max · Standard",
  });
});

test("Enter submits while Shift+Enter and IME composition preserve the draft", () => {
  expect(composerEnterAction({ key: "Enter", shiftKey: false, isComposing: false }))
    .toBe("submit");
  expect(composerEnterAction({ key: "Enter", shiftKey: true, isComposing: false }))
    .toBe("newline");
  expect(composerEnterAction({ key: "Enter", shiftKey: false, isComposing: true }))
    .toBe("ignore");
  expect(composerEnterAction({ key: "a", shiftKey: false, isComposing: false }))
    .toBe("ignore");
});

test("explicit pane order reuses local anchors without moving remote anchors", () => {
  expect(resolveLocalPaneGridSlots(
    ["pane_three", "pane_one", "pane_two"],
    [
      { paneId: "pane_one", gridPosition: 0 },
      { paneId: "pane_two", gridPosition: 2 },
      { paneId: "pane_three", gridPosition: 5 },
    ],
    [
      { sessionId: remoteSession(1).sessionId, gridPosition: 1 },
      { sessionId: remoteSession(4).sessionId, gridPosition: 4 },
    ],
  )).toEqual([
    { paneId: "pane_three", gridPosition: 0 },
    { paneId: "pane_one", gridPosition: 2 },
    { paneId: "pane_two", gridPosition: 5 },
  ]);
});

test("subscription gating waits for hydration and the new pane inherits the visually last repository", () => {
  expect(selectSubscriptionGate({ state: "connecting" })).toBe("loading");
  const first = pane({
    id: "pane_example0001",
    repository: { id: "repo_00000000000000000000000001", name: "One" },
  });
  const last = pane({
    id: "pane_example0002",
    repository: { id: "repo_00000000000000000000000002", name: "Two" },
  });
  const base = shellStateWithRemoteSessions([], {
    panes: [first, last],
    localGridSlots: [
      { paneId: first.id, gridPosition: 1 },
      { paneId: last.id, gridPosition: 3 },
    ],
  });
  const state = {
    ...base,
    snapshot: {
      ...base.snapshot,
      accounts: [{
        id: "acct_example0001",
        revision: 1,
        label: "Codex",
        selected: true,
        identityLabel: "builder@example.com",
        planLabel: "Pro",
        usageRemainingPercent: 75,
        authState: "signedIn" as const,
        login: { state: "idle" as const },
        runtime: { state: "ready" as const, generation: 1 },
      }],
    },
  };
  expect(selectSubscriptionGate(state)).toBe("available");
  expect(selectLastLocalPaneRepository(state)).toEqual(last.repository);
  const missing = {
    ...state,
    snapshot: { ...state.snapshot, accounts: [] },
  };
  expect(selectSubscriptionGate(missing)).toBe("missing");
});

test("retained prompt retry authority is exact, ordinary, failed, and renderer-safe", () => {
  const failedTurn = {
    id: "chatturn_example0001",
    status: "failed" as const,
    startedAt: "2026-08-03T12:00:00.000Z",
    completedAt: "2026-08-03T12:00:01.000Z",
    continuationCount: 0,
    responseMarkdown: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
    reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
    tools: [],
    routing: resolvedStandardRoute,
  };
  const recoverable = pane({
    state: "attention",
    turn: failedTurn,
    attention: { code: "turn_failed", message: "Retry.", retryable: true },
    recoverablePrompt: true,
  });
  expect(paneCanRetryRetainedPrompt(recoverable)).toBeTrue();
  expect(paneCanRetryRetainedPrompt({ ...recoverable, recoverablePrompt: false })).toBeFalse();
  expect(paneCanRetryRetainedPrompt({
    ...recoverable,
    attention: { ...recoverable.attention!, retryable: false },
    recoverablePrompt: false,
  })).toBeFalse();
  expect(paneCanRetryRetainedPrompt({
    ...recoverable,
    interactionMode: "harnessObserver",
    workspace: null,
    recoverablePrompt: false,
  })).toBeFalse();
});

test("the three harness command builders preserve every renderer revision fence", () => {
  expect(updateHarnessSettingsCommand({
    expectedHarnessRevision: 4,
    expectedRevision: 3,
    recursiveSessionsEnabled: true,
    contextQuotaBytes: 32 * 1024 * 1024,
    refinementMode: "suggest",
  })).toEqual({
    type: "harness.settings.update",
    expectedHarnessRevision: 4,
    expectedRevision: 3,
    recursiveSessionsEnabled: true,
    contextQuotaBytes: 32 * 1024 * 1024,
    refinementMode: "suggest",
  });
  const child = {
    parentPaneId: "pane_parent0001",
    childId: "hactor_child0001",
    expectedParentRevision: 7,
    expectedChildRevision: 2,
  };
  expect(openHarnessChildCommand(child)).toEqual({ type: "harness.child.open", ...child });
  expect(stopHarnessChildCommand(child)).toEqual({ type: "harness.child.stop", ...child });
});

test("the global harness selector retains identity across unrelated pane updates", () => {
  const harness = {
    revision: 1,
    settings: {
      revision: 1,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 8 * 1024 * 1024,
      refinementMode: "suggest" as const,
    },
    proposals: [],
  };
  const before = shellState([pane()]);
  before.snapshot.harness = harness;
  const after = shellState([pane({ revision: 2, title: "Renamed" })]);
  after.snapshot.harness = harness;
  expect(selectHarness(before)).toBe(harness);
  expect(selectHarness(after)).toBe(harness);
});

test("account creation reserves durable renderer capacity for retained local data", () => {
  const account = (index: number) => ({
    id: `acct_capacity${String(index).padStart(4, "0")}`,
    revision: 1,
    label: `Account ${index}`,
    selected: false,
    identityLabel: null,
    planLabel: null,
    usageRemainingPercent: null,
    authState: "signedOut" as const,
    login: { state: "idle" as const },
    runtime: { state: "stopped" as const, generation: 0 },
  });
  const retained = (index: number) => ({
    id: `acct_retained${String(index).padStart(4, "0")}`,
    revision: 2,
    label: `Removed ${index}`,
    removedAt: "2026-08-08T00:00:00.000Z",
  });
  const state = (accountCount: number, retainedCount: number) => ({
    state: "ready" as const,
    snapshot: {
      ...emptyRuntimeSnapshot(),
      accounts: Array.from({ length: accountCount }, (_, index) => account(index)),
      retainedAccountLocalData: Array.from(
        { length: retainedCount },
        (_, index) => retained(index),
      ),
    },
  });

  expect(selectAccountCreationAvailable(state(63, 0))).toBeTrue();
  expect(selectAccountCreationAvailable(state(64, 0))).toBeFalse();
  expect(selectAccountCreationAvailable(state(63, 1))).toBeFalse();
  expect(selectAccountCreationAvailable(state(1, 63))).toBeFalse();
});

test("one interleaved remote update invalidates only that summary row", () => {
  const fixtures = Array.from({ length: 64 }, (_, index) => remoteSession(index));
  const updatedIndex = 31;
  const before = shellStateWithRemoteSessions(fixtures);
  const beforeSessions = before.snapshot.sessionSync.remoteSessions;
  const afterSessions = beforeSessions.map((session, index) => index === updatedIndex
    ? remoteSession(index, {
        sourceRevision: session.sourceRevision + 1,
        state: "working",
        updatedAt: 999,
      })
    : session);
  const after = {
    state: "ready" as const,
    snapshot: {
      ...before.snapshot,
      sessionSync: { ...before.snapshot.sessionSync, remoteSessions: afterSessions },
    },
  };
  const beforeIds = selectRemoteSessionIds(before);
  const afterIds = selectRemoteSessionIds(after);
  expect(remoteSessionIdsEqual(beforeIds, afterIds)).toBeTrue();

  const changedRows = beforeIds.filter((sessionId) => !remoteSessionRowEqual(
    selectRemoteSessionRow(before, sessionId),
    selectRemoteSessionRow(after, sessionId),
  ));
  expect(changedRows).toEqual([beforeSessions[updatedIndex]!.sessionId]);
  expect(afterSessions.filter((session, index) => (
    index !== updatedIndex && session !== beforeSessions[index]
  ))).toHaveLength(0);
});

test("remote row selectors share one state-scoped derivation at the maximum window", () => {
  const fixtures = Array.from({ length: 448 }, (_, index) => remoteSession(index, {
    title: "Colliding title",
    originDeviceName: "Shared device",
    repositoryDisplayName: "Shared repository",
  }));
  const state = shellStateWithRemoteSessions(fixtures);
  const firstPass = fixtures.map(({ sessionId }) => selectRemoteSessionRow(state, sessionId));
  const secondPass = fixtures.map(({ sessionId }) => selectRemoteSessionRow(state, sessionId));

  expect(secondPass.every((row, index) => row === firstPass[index])).toBeTrue();
  expect(firstPass[0]?.collisionLine).toBe("Position 1");
  expect(firstPass.at(-1)?.collisionLine).toBe("Position 448");
});

test("forty-eight mounted row selectors read one snapshot context once", () => {
  const fixtures = Array.from({ length: 448 }, (_, index) => remoteSession(index));
  const state = shellStateWithRemoteSessions(fixtures);
  let contextReads = 0;
  const observed = new Proxy(state, {
    get(target, property, receiver) {
      if (property === "state" || property === "snapshot") contextReads += 1;
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  const mounted = fixtures.slice(0, 48);
  expect(selectRemoteSessionRow(observed, mounted[0]!.sessionId)).not.toBeNull();
  expect(contextReads).toBeGreaterThan(0);
  const readsAfterFirstRow = contextReads;
  for (const { sessionId } of mounted.slice(1)) {
    expect(selectRemoteSessionRow(observed, sessionId)).not.toBeNull();
  }
  expect(contextReads).toBe(readsAfterFirstRow);
});

test("local stream-only snapshots retain the remote row derivation", () => {
  const remote = remoteSession(1, { title: "Remote" });
  const local = pane({
    title: "Local",
    repository: {
      id: "repo_00000000000000000000000000",
      name: "example",
    },
  });
  const before = shellStateWithRemoteSessions([remote], { panes: [local] });
  const beforeRow = selectRemoteSessionRow(before, remote.sessionId);
  const beforeSlots = selectRemoteSessionGridSlots(before);
  const after = {
    state: "ready" as const,
    snapshot: {
      ...before.snapshot,
      chat: {
        ...before.snapshot.chat,
        revision: before.snapshot.chat.revision + 1,
        panes: [{ ...local, revision: local.revision + 1 }],
      },
    },
  };

  expect(selectRemoteSessionRow(after, remote.sessionId)).toBe(beforeRow);
  expect(selectRemoteSessionGridSlots(after)).toBe(beforeSlots);
});

test("a session-sync scope generation change leaves no stale remote selector state", () => {
  const remote = remoteSession(4, { title: "Old vault summary" });
  const before = shellStateWithRemoteSessions([remote]);
  expect(selectRemoteSessionIds(before)).toEqual([remote.sessionId]);
  expect(selectRemoteSessionRow(before, remote.sessionId)?.session).toEqual(remote);

  const after = {
    state: "ready" as const,
    snapshot: runtimeSnapshotSchema.parse({
      ...before.snapshot,
      revision: before.snapshot.revision + 1,
      sessionSync: {
        ...before.snapshot.sessionSync,
        status: {
          ...before.snapshot.sessionSync.status,
          revision: 2,
          scopeGeneration: 2,
        },
        localGridSlots: [],
        remoteSessions: [],
      },
    }),
  };
  expect(selectRemoteSessionIds(after)).toEqual([]);
  expect(selectRemoteSessionRow(after, remote.sessionId)).toBeNull();
});

test("duplicate titles use the shortest unique visible collision line", () => {
  const first = remoteSession(1, {
    title: "Release",
    originDeviceName: "A",
    repositoryDisplayName: "Long repository name",
  });
  const second = remoteSession(2, {
    title: "Release",
    originDeviceName: "B",
    repositoryDisplayName: "Another long repository name",
  });
  const unique = remoteSession(3, { title: "Unique" });
  const state = shellStateWithRemoteSessions([first, second, unique]);
  expect(selectRemoteSessionRow(state, first.sessionId)).toMatchObject({
    collisionLine: "A",
    session: first,
  });
  expect(selectRemoteSessionRow(state, second.sessionId)).toMatchObject({
    collisionLine: "B",
    session: second,
  });
  expect(selectRemoteSessionRow(state, unique.sessionId)).toMatchObject({
    collisionLine: null,
    session: unique,
  });
});

test("remote title collisions include local panes in shortest context selection", () => {
  const remote = remoteSession(8, {
    title: "Release",
    originDeviceName: "Travel Mac",
    repositoryDisplayName: "Other",
  });
  const local = pane({ title: "Release", repository: {
    id: "repo_00000000000000000000000000",
    name: "Example",
  } });
  const state = shellStateWithRemoteSessions([remote], {
    localGridSlots: [{ paneId: local.id, gridPosition: 0 }],
    panes: [local],
  });
  expect(selectRemoteSessionRow(state, remote.sessionId)).toMatchObject({
    collisionLine: "Other",
    session: remote,
  });
});

test("same repository and device collisions fall back to the stable grid ordinal", () => {
  const remote = remoteSession(7, {
    title: "Release",
    originDeviceName: "Studio Mac",
    repositoryDisplayName: "hra",
  });
  const local = pane({
    title: "Release",
    repository: {
      id: "repo_00000000000000000000000000",
      name: "hra",
    },
  });
  const state = shellStateWithRemoteSessions([remote], {
    localGridSlots: [{ paneId: local.id, gridPosition: 0 }],
    panes: [local],
  });
  expect(selectRemoteSessionRow(state, remote.sessionId)).toMatchObject({
    collisionLine: "Position 8",
    session: remote,
  });
});

test("message authority is ordinary-chat local and attached-actor fail-closed", () => {
  const ordinary = pane();
  expect(selectPaneCanMessage(shellState([ordinary]), ordinary.id)).toBeTrue();
  for (const workspace of [
    {
      mode: "managedWorktree" as const,
      state: "preparing" as const,
      revision: 2,
      recoveryKind: null,
    },
    {
      mode: "managedWorktree" as const,
      state: "waitingCapacity" as const,
      revision: 3,
      recoveryKind: "capacityUnavailable" as const,
    },
    {
      mode: "managedWorktree" as const,
      state: "recoveryRequired" as const,
      revision: 4,
      recoveryKind: "bindingMismatch" as const,
    },
  ]) {
    const unavailable = pane({ workspace });
    expect(selectPaneCanMessage(shellState([unavailable]), unavailable.id)).toBeFalse();
  }

  const observer = pane({
    id: "pane_observer0001",
    interactionMode: "harnessObserver",
    workspace: null,
  });
  const parent = pane({
    id: "pane_parent0001",
    harness: {
      revision: 1,
      descendants: {
        count: 1,
        truncated: false,
        children: [{
          id: "hactor_child0001",
          revision: 1,
          title: "Child",
          state: "idle",
          openedPaneId: observer.id,
          canOpen: false,
          canMessage: true,
          canStop: true,
        }],
      },
    },
  });
  expect(selectPaneCanMessage(shellState([parent, observer]), observer.id)).toBeTrue();
  expect(selectPaneCanMessage(shellState([observer]), observer.id)).toBeFalse();

  const denied = pane({
    ...parent,
    harness: {
      ...parent.harness!,
      descendants: {
        ...parent.harness!.descendants,
        children: parent.harness!.descendants.children.map((child) => ({
          ...child,
          canMessage: false,
        })),
      },
    },
  });
  expect(selectPaneCanMessage(shellState([denied, observer]), observer.id)).toBeFalse();

  const conflicting = pane({
    ...parent,
    id: "pane_parent0002",
  });
  expect(selectPaneCanMessage(
    shellState([parent, conflicting, observer]),
    observer.id,
  )).toBeFalse();
});

test("workspace status stays concise and retries only recoverable states", () => {
  expect(paneWorkspaceStatus(pane())).toBeNull();
  expect(paneWorkspaceStatus(pane({
    workspace: {
      mode: "managedWorktree",
      state: "preparing",
      revision: 2,
      recoveryKind: null,
    },
  }))).toEqual({
    message: "Preparing isolated workspace…",
    retryable: false,
  });
  expect(paneWorkspaceStatus(pane({
    workspace: {
      mode: "managedWorktree",
      state: "waitingCapacity",
      revision: 3,
      recoveryKind: "insufficientDisk",
    },
  }))).toEqual({
    message: "Workspace is waiting for capacity.",
    retryable: true,
  });
  expect(paneWorkspaceStatus(pane({
    workspace: {
      mode: "legacyUnbound",
      state: "recoveryRequired",
      revision: 1,
      recoveryKind: "legacyUnbound",
    },
  }))).toEqual({
    message: "Create an isolated workspace.",
    retryable: true,
  });
});

test("title edits distinguish idle saves from explicit finish and flush exactly once", () => {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  const scheduler: TimeoutScheduler = {
    clear: (handle) => callbacks.delete(handle as number),
    set: (callback, delay) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      delays.push(delay);
      return handle;
    },
  };
  const commits: Array<{
    commit: { revision: number; title: string };
    reason: "finish" | "idle";
  }> = [];
  const debouncer = createTitleDebouncer(
    (commit, reason) => commits.push({ commit, reason }),
    scheduler,
  );

  debouncer.schedule({ revision: 1, title: "O" });
  debouncer.schedule({ revision: 1, title: "OP" });
  debouncer.schedule({ revision: 1, title: "HRA" });
  expect(callbacks.size).toBe(1);
  expect(delays).toEqual([
    paneTitleDebounceMs,
    paneTitleDebounceMs,
    paneTitleDebounceMs,
  ]);
  debouncer.flush();
  debouncer.flush();
  expect(commits).toEqual([{
    commit: { revision: 1, title: "HRA" },
    reason: "finish",
  }]);

  debouncer.schedule({ revision: 2, title: "Idle save" });
  expect(callbacks.size).toBe(1);
  const idleCallback = callbacks.values().next().value;
  if (idleCallback === undefined) throw new Error("Expected one idle title callback");
  idleCallback();
  expect(commits.at(-1)).toEqual({
    commit: { revision: 2, title: "Idle save" },
    reason: "idle",
  });

  debouncer.schedule({ revision: 3, title: "Discarded" });
  debouncer.cancel();
  expect(callbacks.size).toBe(0);
  expect(commits).toHaveLength(2);
});

test("title commit reconciliation preserves editing and never clobbers newer input", () => {
  const idle = reconcilePaneTitleCommit({
    baseline: { revision: 1, title: "Original" },
    commit: { revision: 1, title: "First save" },
    committedPane: { revision: 2, title: "First save" },
    draft: "First save",
    reason: "idle",
  });
  expect(idle).toEqual({
    baseline: { revision: 2, title: "First save" },
    draft: "First save",
    finishEditing: false,
  });

  const continued = reconcilePaneTitleCommit({
    baseline: { revision: 1, title: "Original" },
    commit: { revision: 1, title: "First save" },
    committedPane: { revision: 2, title: "First save" },
    draft: "Continued typing",
    reason: "finish",
  });
  expect(continued).toEqual({
    baseline: { revision: 2, title: "First save" },
    draft: "Continued typing",
    finishEditing: false,
  });

  expect(reconcilePaneTitleCommit({
    baseline: idle.baseline,
    commit: { revision: idle.baseline.revision, title: "Final title" },
    committedPane: { revision: 3, title: "Final title" },
    draft: " Final title ",
    reason: "finish",
  })).toEqual({
    baseline: { revision: 3, title: "Final title" },
    draft: "Final title",
    finishEditing: true,
  });

  expect(reconcilePaneTitleCommit({
    baseline: { revision: 4, title: "Newer remote title" },
    commit: { revision: 1, title: "Stale save" },
    committedPane: { revision: 2, title: "Stale save" },
    draft: "Stale save",
    reason: "finish",
  })).toEqual({
    baseline: { revision: 4, title: "Newer remote title" },
    draft: "Stale save",
    finishEditing: false,
  });
});

test("title normalization preserves complete Unicode code points and rejects malformed UTF-16", () => {
  const prefix = "a".repeat(159);
  expect(normalizePaneTitle(`${prefix}🙂`)).toBe(prefix);
  expect(normalizePaneTitle(`${prefix}b🙂`)).toBe(`${prefix}b`);

  for (const malformed of ["title\ud800", "title\udfff", "\ud800title", "\udfff title"]) {
    expect(normalizePaneTitle(malformed)).toBeNull();
    expect(runtimeChatDomainCommandSchema.safeParse({
      type: "chat.pane.rename",
      paneId: "pane_example0001",
      expectedRevision: 1,
      title: malformed,
    }).success).toBeFalse();
  }
});

test("a failed title commit refocuses only after the in-place control is writable", () => {
  const error = "The pane changed before the title could be saved.";
  expect(paneTitleErrorId("pane_example0001")).toBe(
    "pane-title-error-pane_example0001",
  );
  expect(titleCommitFailureShouldRefocus({ editing: true, error, pending: true })).toBeFalse();
  expect(titleCommitFailureShouldRefocus({ editing: true, error, pending: false })).toBeTrue();
  expect(titleCommitFailureShouldRefocus({ editing: false, error, pending: false })).toBeFalse();
  expect(titleCommitFailureShouldRefocus({ editing: true, error: null, pending: false })).toBeFalse();
});

test("title blur preserves DOM focus and fences destination events only while saving", () => {
  expect(paneTitleBlurAction({
    draft: "Renamed",
    error: null,
    pending: true,
    title: "Original",
  })).toBe("preserve");
  expect(paneTitleBlurAction({
    draft: "Renamed",
    error: null,
    pending: false,
    title: "Original",
  })).toBe("commit-and-preserve");
  expect(paneTitleBlurAction({
    draft: " Original ",
    error: null,
    pending: false,
    title: "Original",
  })).toBe("finish");
  expect(paneTitleBlurAction({
    draft: "Renamed",
    error: "The save failed.",
    pending: false,
    title: "Original",
  })).toBe("release");

  let focusOptions: FocusOptions | undefined;
  expect(preservePendingPaneTitleFocus({
    focus: (options) => { focusOptions = options; },
  })).toBeTrue();
  expect(focusOptions).toEqual({ preventScroll: true });
  expect(preservePendingPaneTitleFocus(null)).toBeFalse();

  let prevented = 0;
  let stopped = 0;
  const interaction = {
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
  };
  expect(fencePendingPaneTitleInteraction(false, interaction)).toBeFalse();
  expect({ prevented, stopped }).toEqual({ prevented: 0, stopped: 0 });
  expect(fencePendingPaneTitleInteraction(true, interaction)).toBeTrue();
  expect({ prevented, stopped }).toEqual({ prevented: 1, stopped: 1 });
});

test("title rename cancels every active turn interleaving without reconnect authority", async () => {
  for (const state of ["starting", "streaming", "continuing"] as const) {
    const initial = pane();
    let current = shellState([initial]);
    let dispatches = 0;
    const port: PaneTitleMutationPort = {
      dispatch: () => {
        dispatches += 1;
        current = shellState([{ ...initial, revision: 2, state }]);
        return Promise.resolve(revisionConflict());
      },
      getState: () => current,
    };

    expect(await dispatchPaneTitleMutation(
      port,
      initial.id,
      initial.revision,
      "Renamed during transition",
    )).toBeNull();
    expect(dispatches).toBe(1);
  }
});

test("settled and attention title conflicts retry once from local authoritative state", async () => {
  for (const state of ["ready", "attention"] as const) {
    const initial = pane();
    const refreshed = pane({ revision: 2, state });
    const renamed = pane({ revision: 3, state, title: "Direct pane" });
    let current = shellState([initial]);
    const attemptedRevisions: number[] = [];
    const port: PaneTitleMutationPort = {
      dispatch: (command) => {
        if (command.type !== "chat.pane.rename") {
          return Promise.reject(new Error("Expected a title rename."));
        }
        attemptedRevisions.push(command.expectedRevision);
        if (attemptedRevisions.length === 1) {
          current = shellState([refreshed]);
          return Promise.resolve(revisionConflict());
        }
        return Promise.resolve(paneResponse(renamed));
      },
      getState: () => current,
    };

    expect(await dispatchPaneTitleMutation(
      port,
      initial.id,
      initial.revision,
      renamed.title,
    )).toEqual(renamed);
    expect(attemptedRevisions).toEqual([1, 2]);
  }
});

test("pane-local conflicts never reconnect streaming siblings", async () => {
  const source = await Bun.file(new URL("./ChatPane.tsx", import.meta.url)).text();

  expect(source).not.toContain("shell.reconnect(");
  expect(source).toContain("resolvePaneRevisionConflict(current, revision)");
});

test("a stream in pane A leaves pane B selection referentially isolated", () => {
  const paneA = pane({ id: "pane_example0001" });
  const paneB = pane({ id: "pane_example0002", title: "Soundfish" });
  const before = {
    state: "ready" as const,
    snapshot: {
      ...emptyRuntimeSnapshot(),
      chat: { revision: 2, panes: [paneA, paneB] },
    },
  };
  const after = {
    state: "ready" as const,
    snapshot: {
      ...before.snapshot,
      revision: 2,
      chat: {
        revision: 3,
        panes: [{ ...paneA, revision: 2, state: "streaming" as const }, paneB],
      },
    },
  };

  expect(selectPane(before, paneB.id)).toBe(paneB);
  expect(selectPane(after, paneB.id)).toBe(paneB);
  expect(selectPaneIds(before)).toEqual(selectPaneIds(after));
});

test("sixty-four pane subscribers share one linear index build per pane array", () => {
  const values = Array.from({ length: 64 }, (_, index) => pane({
    id: `pane_budget${String(index).padStart(8, "0")}`,
    title: `Budget pane ${String(index + 1)}`,
  }));
  let paneReads = 0;
  const observed = new Proxy(values, {
    get: (target, property, receiver): unknown => {
      if (typeof property === "string" && /^\d+$/u.test(property)) paneReads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const state = shellState(observed);

  for (const candidate of values) expect(selectPane(state, candidate.id)).toBe(candidate);
  for (const candidate of values.toReversed()) expect(selectPane(state, candidate.id)).toBe(candidate);
  expect(selectPane(state, "pane_missing0001")).toBeNull();
  expect(paneReads).toBe(64);
});

test("attention is recoverable while active states disable unimplemented queueing", () => {
  expect(paneCanCompose("attention")).toBeTrue();
  expect(paneCanCompose("ready")).toBeTrue();
  expect(paneCanRename("attention")).toBeTrue();
  expect(paneCanRename("ready")).toBeTrue();
  for (const state of ["starting", "streaming", "continuing"] as const) {
    expect(paneIsActive(state)).toBeTrue();
    expect(paneCanCompose(state)).toBeFalse();
    expect(paneCanRename(state)).toBeFalse();
    expect(paneStatusLabel(state).length).toBeGreaterThan(0);
  }
});

test("prompt and scroll guards retain intentional whitespace and reader position", () => {
  expect(validatedPrompt("   ")).toEqual({ ok: false, message: "Write a message first." });
  expect(validatedPrompt("message\0tail")).toEqual({
    ok: false,
    message: "The message contains unsupported text.",
  });
  expect(validatedPrompt("  keep formatting\n")).toEqual({
    ok: true,
    prompt: "  keep formatting\n",
  });
  expect(validatedPrompt("x".repeat(runtimeChatTurnPromptUtf8ByteLimit))).toMatchObject({
    ok: true,
  });
  expect(validatedPrompt("x".repeat(runtimeChatTurnPromptUtf8ByteLimit + 1))).toEqual({
    ok: false,
    message: "The message is too large to send.",
  });
  expect(normalizePaneTitle("  Pane name  ")).toBe("Pane name");
  expect(isNearPaneBottom({ clientHeight: 300, scrollHeight: 1_000, scrollTop: 644 })).toBeTrue();
  expect(isNearPaneBottom({ clientHeight: 300, scrollHeight: 1_000, scrollTop: 500 })).toBeFalse();
});
