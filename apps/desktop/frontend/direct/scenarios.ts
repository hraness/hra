import {
  defineDirect,
  type ScenarioDefinitionInput,
} from "@hraness/direct";
import { LOGICAL_RUNTIME_SCHEMA } from "@hraness/direct/core";
import { syncDeviceIdSchema } from "@hraness/agent-tasks-protocol";

import {
  runtimeProtocolVersion,
  remoteSessionSummaryProjectionSchema,
  runtimeSnapshotSchema,
  type ChatPaneProjection,
  type ChatRootTurnRoutingProjection,
  type ChatUtf8Tail,
  type HarnessChildProjection,
  type HarnessChildState,
  type HarnessSnapshot,
  type RemoteSessionSummaryProjection,
  type SessionSyncStatusProjection,
} from "../../contracts/runtime";
import {
  createHRADirectWorld,
  emptySnapshot,
  fixtureAccount,
  fixtureLocalWorkspace,
  HRA_DIRECT_TIME,
  HRA_DIRECT_TIMESTAMP,
  hraDirectTaskIds,
  parseHRADirectWorld,
  signedInAccount,
  type HRADirectWorld,
} from "./world";

export type HRADirectRoute = "/";
export type HRADirectViewport = "compact" | "wide";

export interface HRAScenarioMetadata {
  readonly group: "Accounts" | "Dispatch" | "Gateway" | "Harness" | "Panes" | "Recovery";
  readonly viewport: HRADirectViewport;
}

const logicalRuntime = {
  schema: LOGICAL_RUNTIME_SCHEMA,
  nowMs: HRA_DIRECT_TIME,
  nextOperation: 1,
  acceleration: 100,
} as const;

const managedWorkspace = {
  mode: "managedWorktree",
  state: "ready",
  revision: 1,
  recoveryKind: null,
} as const;

const personal = {
  ...signedInAccount({
    id: "acct_personal01",
    label: "Personal",
    identityLabel: "builder@personal.example",
    selected: true,
  }),
  usageRemainingPercent: 78,
};
const work = {
  ...signedInAccount({
    id: "acct_work00001",
    label: "Work",
    identityLabel: "builder@work.example",
    selected: false,
  }),
  usageRemainingPercent: 64,
};

function snapshotWithAccounts(accounts: HRADirectWorld["gateway"]["snapshots"][number]["accounts"]) {
  return runtimeSnapshotSchema.parse({ ...emptySnapshot(), accounts });
}

function chatTail(tail: string): ChatUtf8Tail {
  return {
    tail,
    totalUtf8Bytes: new TextEncoder().encode(tail).byteLength,
    truncatedPrefix: false,
  };
}

const directStandardRoute = {
  policyVersion: 1,
  classificationReason: "conservativeDefault",
  workClass: "standard",
  requestedProfile: "solMax",
  selectedProfile: "solMax",
  profileFallbackReason: null,
  requestedServiceTier: "standard",
  selectedServiceTier: "standard",
  serviceTierFallbackReason: null,
} as const satisfies ChatRootTurnRoutingProjection;

function chatPane(
  id: string,
  overrides: Partial<ChatPaneProjection> = {},
): ChatPaneProjection {
  const pane: ChatPaneProjection = {
    id,
    paletteIndex: 0,
    revision: 1,
    title: "HRA",
    repository: {
      id: hraDirectTaskIds.repository,
      name: "hra",
    },
    accountProfileId: null,
    interactionMode: "chat",
    state: "ready",
    activity: { ordinal: 0, kind: "idle" },
    workspace: managedWorkspace,
    turn: null,
    attention: null,
    recoverablePrompt: false,
    canStartFreshContext: false,
    messageQueue: { revision: 1, pauseReason: null, blockedMessage: null, messages: [] },
    attachments: { drafts: [], referenced: [] },
    harness: null,
    ...overrides,
  };
  return pane.turn !== null && pane.interactionMode === "chat" &&
      pane.turn.routing === null
    ? { ...pane, turn: { ...pane.turn, routing: directStandardRoute } }
    : pane;
}

function snapshotWithChat(
  panes: readonly ChatPaneProjection[],
  accounts: HRADirectWorld["gateway"]["snapshots"][number]["accounts"] = [personal, work],
) {
  return runtimeSnapshotSchema.parse({
    ...emptySnapshot(),
    accounts,
    chat: { revision: 1, panes },
  });
}

const directCurrentSyncDeviceId = syncDeviceIdSchema.parse(`syncdevice_${"c".repeat(32)}`);
const directTravelSyncDeviceId = syncDeviceIdSchema.parse(`syncdevice_${"t".repeat(32)}`);
const directOfficeSyncDeviceId = syncDeviceIdSchema.parse(`syncdevice_${"o".repeat(32)}`);
const directCandidateSyncDeviceId = syncDeviceIdSchema.parse(`syncdevice_${"n".repeat(32)}`);

const activeSessionSyncStatus = runtimeSnapshotSchema.parse({
  ...emptySnapshot(),
  sessionSync: {
    status: {
      state: "active",
      revision: 7,
      scopeGeneration: 1,
      currentDeviceId: directCurrentSyncDeviceId,
      deviceName: "Studio Mac",
      health: "current",
      retryable: false,
      notice: null,
      recovery: "ready",
      devices: [{
        id: directCurrentSyncDeviceId,
        name: "Studio Mac",
        status: "active",
        current: true,
        connection: "online",
      }, {
        id: directTravelSyncDeviceId,
        name: "Travel Mac",
        status: "active",
        current: false,
        connection: "offline",
      }, {
        id: directOfficeSyncDeviceId,
        name: "Office Mac",
        status: "active",
        current: false,
        connection: "unknown",
      }],
      pendingEnrollments: [{
        requestId: `syncenroll_${"e".repeat(32)}`,
        deviceId: directCandidateSyncDeviceId,
        name: "New Mac",
        pairingCode: "123456",
        requestedAt: HRA_DIRECT_TIME,
        expiresAt: HRA_DIRECT_TIME + 600_000,
      }],
    },
    remoteSessions: [],
  },
}).sessionSync.status as Extract<SessionSyncStatusProjection, { readonly state: "active" }>;

function directRemoteSummary(
  index: number,
  options: Readonly<{
    gridPosition?: number;
    origin?: "office" | "travel";
    title?: string;
  }> = {},
): RemoteSessionSummaryProjection {
  const origin = options.origin ?? (index % 2 === 0 ? "travel" : "office");
  return remoteSessionSummaryProjectionSchema.parse({
    sessionId: `syncsession_${index.toString(36).padStart(32, "0")}`,
    originDeviceId: origin === "travel"
      ? directTravelSyncDeviceId
      : directOfficeSyncDeviceId,
    originDeviceName: origin === "travel" ? "Travel Mac" : "Office Mac",
    gridPosition: options.gridPosition ?? index,
    sourceRevision: 1,
    title: options.title ?? `Remote task ${Math.floor(index / 2) + 1}`,
    repositoryDisplayName: index % 3 === 0 ? "Example" : "HRA",
    state: index % 11 === 0 ? "attention" : index % 3 === 0 ? "working" : "ready",
    updatedAt: HRA_DIRECT_TIME - index,
  });
}

function snapshotWithSessionSync(
  status: SessionSyncStatusProjection,
  remoteSessions: readonly RemoteSessionSummaryProjection[] = [],
  localPanes: readonly ChatPaneProjection[] = [],
) {
  return runtimeSnapshotSchema.parse({
    ...emptySnapshot(),
    accounts: [personal, work],
    chat: { revision: 1, panes: localPanes },
    sessionSync: {
      status,
      localGridSlots: localPanes.map(({ id }, gridPosition) => ({
        paneId: id,
        gridPosition,
      })),
      remoteSessions,
    },
  });
}

function sessionSyncFaultWorld(
  reason: Extract<SessionSyncStatusProjection, { readonly state: "unavailable" }>["reason"],
  paneId: string,
  title: string,
): HRADirectWorld {
  const workspace = fixtureLocalWorkspace(1);
  return createHRADirectWorld({
    gateway: {
      snapshots: [snapshotWithSessionSync({
        state: "unavailable",
        reason,
        retryable: reason !== "cloudConfigurationMissing",
      }, [], [chatPane(paneId, { title })])],
      encoding: { kind: "chunked", chunkBytes: 257 },
      events: [],
    },
    task: {
      initialStateId: "empty",
      mutationTransitions: [],
      projectAdd: {
        version: runtimeProtocolVersion,
        status: "created",
        repository: {
          id: hraDirectTaskIds.repository,
          name: "hra",
          createdAt: HRA_DIRECT_TIME,
        },
        workspace,
      },
      states: [{
        id: "empty",
        projectionJson: JSON.stringify({
          workspaces: [workspace],
          contexts: [],
          repositories: [],
          pages: [],
          details: [],
        }),
      }],
    },
  });
}

const signedOut = fixtureAccount({
  id: "acct_personal01",
  label: "Personal",
  selected: true,
});
export const maximumAccountLabel = "A".repeat(80);
const maximumLabelAccount = fixtureAccount({
  id: "acct_maxlabel01",
  label: maximumAccountLabel,
  selected: true,
});
const browserLogin = fixtureAccount({
  ...signedOut,
  authState: "signingIn",
  login: { state: "waitingForBrowser", startedAt: HRA_DIRECT_TIMESTAMP },
});
const humanCredentialRecoverySnapshot = runtimeSnapshotSchema.parse({
  ...snapshotWithChat([], [personal, work]),
  humanAccount: {
    state: "error",
    revision: 7,
    code: "CREDENTIAL_RECOVERY_REQUIRED",
    message: "Human credential recovery is required before signing in.",
    retryable: false,
    profile: null,
  },
});
const failedWork = fixtureAccount({
  ...work,
  selected: true,
  runtime: {
    state: "failed",
    generation: 4,
    message: "The isolated Work runtime failed its compatibility check.",
    canRestart: true,
  },
});
const healthyPersonal = fixtureAccount({ ...personal, selected: false });
const expiredCredentialAccount = fixtureAccount({
  ...personal,
  revision: 2,
  authState: "expired",
  login: { state: "idle" },
});
const recoveredCredentialAccount = fixtureAccount({
  ...personal,
  revision: 3,
  identityLabel: "builder@recovered.example",
});
const recoveryAccount = fixtureAccount({
  id: "acct_recovered1",
  label: "Recovered",
  selected: true,
});
const recoverySnapshot = runtimeSnapshotSchema.parse({
  ...emptySnapshot(undefined, 2),
  revision: 2,
  accounts: [recoveryAccount],
});
const completedReasoningMarkdown =
  "### Verified reasoning\n\nCompletion reconciliation confirmed the exact provider summary.";
const completedChatPane = chatPane("pane_completed001", {
  activity: { ordinal: 4, kind: "responseCompleted" },
  revision: 4,
  title: "Release HRA",
  accountProfileId: personal.id,
  turn: {
    id: "chatturn_completed001",
    status: "completed",
    startedAt: HRA_DIRECT_TIMESTAMP,
    completedAt: HRA_DIRECT_TIMESTAMP,
    continuationCount: 0,
    responseMarkdown: chatTail(
      "## Release ready\n\nThe **latest response** is rendered as Markdown.\n\n- Signed\n- Verified\n- Published",
    ),
    reasoningSummary: chatTail(completedReasoningMarkdown),
    reasoningSummaryVerified: true,
    tools: [],
    providerSubagents: { agents: [], overflowCount: 0 },
    routing: null,
  },
});

type AttentionPresentation = Readonly<{
  code: NonNullable<ChatPaneProjection["attention"]>["code"];
  message: string;
  paneId: ChatPaneProjection["id"];
  prompt: string;
  recoverablePrompt: boolean;
  title: string;
  turnId: NonNullable<ChatPaneProjection["turn"]>["id"];
}>;

export const attentionPresentations = Object.freeze([
  {
    code: "all_accounts_exhausted",
    message: "Every connected Codex account is unavailable or near its usage limit. You can send another message later.",
    paneId: "pane_attentionquota01",
    prompt: "Retry quota work",
    recoverablePrompt: false,
    title: "Quota attention",
    turnId: "chatturn_attentionquota01",
  },
  {
    code: "continuation_failed",
    message: "Earlier context could not be transferred safely, so HRA cleared it. Send your message again to start fresh.",
    paneId: "pane_attentioncontinue",
    prompt: "Restart with cleared context",
    recoverablePrompt: false,
    title: "Continuation attention",
    turnId: "chatturn_attentioncontinue",
  },
  {
    code: "approval_required",
    message: "Codex requested an interaction that HRA cannot answer safely. Send another message to continue.",
    paneId: "pane_attentionapproval",
    prompt: "Continue without interaction",
    recoverablePrompt: false,
    title: "Approval attention",
    turnId: "chatturn_attentionapproval",
  },
  {
    code: "runtime_unavailable",
    message: "The local runtime could not continue this turn. You can send another message.",
    paneId: "pane_attentionruntime1",
    prompt: "Retry after runtime recovery",
    recoverablePrompt: false,
    title: "Runtime attention",
    turnId: "chatturn_attentionruntime1",
  },
  {
    code: "turn_failed",
    message: "The turn could not finish. You can send another message.",
    paneId: "pane_attentionturn001",
    prompt: "Retry failed turn",
    recoverablePrompt: true,
    title: "Turn attention",
    turnId: "chatturn_attentionturn001",
  },
] as const satisfies readonly AttentionPresentation[]);

const attentionChatPanes = attentionPresentations.map((presentation, index) => chatPane(
  presentation.paneId,
  {
    revision: 3,
    title: presentation.title,
    state: "attention",
    turn: {
      id: presentation.turnId,
      status: "failed",
      startedAt: HRA_DIRECT_TIMESTAMP,
      completedAt: HRA_DIRECT_TIMESTAMP,
      continuationCount: index === 1 ? 1 : 0,
      responseMarkdown: chatTail(`Preserved partial response for ${presentation.title.toLowerCase()}.`),
      reasoningSummary: chatTail(""),
      reasoningSummaryVerified: false,
      tools: [],
      providerSubagents: { agents: [], overflowCount: 0 },
      routing: null,
    },
    attention: {
      code: presentation.code,
      message: presentation.message,
      retryable: true,
    },
    recoverablePrompt: presentation.recoverablePrompt,
  },
));

const streamingInitialPane = chatPane("pane_streaming001", {
  activity: { ordinal: 1, kind: "messageSent" },
  title: "Streaming turn",
  state: "starting",
  turn: {
    id: "chatturn_streaming001",
    status: "starting",
    startedAt: HRA_DIRECT_TIMESTAMP,
    completedAt: null,
    continuationCount: 0,
    responseMarkdown: chatTail(""),
    reasoningSummary: chatTail(""),
    reasoningSummaryVerified: false,
    tools: [],
    providerSubagents: { agents: [], overflowCount: 0 },
    routing: null,
  },
});

const streamingReasoningText = "Checking the release state and the current public route.";

const streamingReasoningPane: ChatPaneProjection = {
  ...streamingInitialPane,
  revision: 2,
  state: "streaming",
  activity: { ordinal: 2, kind: "thinkingCompleted" },
  turn: {
    ...streamingInitialPane.turn!,
    status: "streaming",
  },
};

const streamingToolPane: ChatPaneProjection = {
  ...streamingReasoningPane,
  revision: 4,
  activity: { ordinal: 3, kind: "toolStarted" },
  turn: {
    ...streamingReasoningPane.turn!,
    reasoningSummary: chatTail(streamingReasoningText),
    tools: [{
      id: "chattool_search0001",
      category: "search",
      status: "running",
    }, {
      id: "chattool_files00001",
      category: "filesystem",
      status: "completed",
    }],
  },
};

const compactChatPane = chatPane("pane_compact_malleable", {
  paletteIndex: 5,
  revision: 5,
  title: "Malleable metaharness",
  state: "streaming",
  activity: { ordinal: 3, kind: "toolStarted" },
  accountProfileId: personal.id,
  harness: {
    revision: 2,
    descendants: {
      count: 4,
      truncated: false,
      children: [{
        id: "hactor_compactroute01",
        revision: 2,
        title: "Routing audit",
        state: "running",
        openedPaneId: null,
        canOpen: false,
        canMessage: false,
        canStop: true,
      }, {
        id: "hactor_compactdirect1",
        revision: 1,
        title: "Direct verification",
        state: "waiting",
        openedPaneId: null,
        canOpen: false,
        canMessage: false,
        canStop: true,
      }, {
        id: "hactor_compactreview1",
        revision: 3,
        title: "Accessibility review",
        state: "idle",
        openedPaneId: null,
        canOpen: true,
        canMessage: false,
        canStop: true,
      }, {
        id: "hactor_compactstartup",
        revision: 1,
        title: "Attachment vault",
        state: "starting",
        openedPaneId: null,
        canOpen: false,
        canMessage: false,
        canStop: true,
      }],
    },
  },
  messageQueue: {
    revision: 4,
    pauseReason: null,
    blockedMessage: null,
    messages: [{
      id: "chatmsg_compactdirect01",
      ordinal: 1,
      revision: 2,
      text: "Steer the active turn with the accessibility findings.",
      attachmentRefs: [],
    }, {
      id: "chatmsg_compactdirect02",
      ordinal: 2,
      revision: 1,
      text: "Then tighten the 26rem layout.",
      attachmentRefs: [],
    }],
  },
  turn: {
    id: "chatturn_compactmalleable",
    status: "streaming",
    startedAt: HRA_DIRECT_TIMESTAMP,
    completedAt: null,
    continuationCount: 0,
    reasoningSummary: chatTail(
      "### Thinking\n\nChecking **queue order**, touch targets, and image custody.",
    ),
    reasoningSummaryVerified: false,
    responseMarkdown: chatTail(
      "## Compact answer\n\nThe pane keeps a dense, readable surface.\n\n- Markdown stays safe\n- Tools stay hidden",
    ),
    tools: [{
      id: "chattool_compacthidden1",
      category: "filesystem",
      status: "running",
    }],
    providerSubagents: { agents: [], overflowCount: 0 },
    routing: null,
  },
});

export const manyChatPaneCount = 64;
export const denseRemoteSessionCount = 448;
export const denseGridSessionCount = manyChatPaneCount + denseRemoteSessionCount;

const denseRemoteSessions = Array.from(
  { length: denseRemoteSessionCount },
  (_, index) => directRemoteSummary(index, {
    gridPosition: manyChatPaneCount + index,
    origin: Math.floor(index / manyChatPaneCount) % 2 === 0
      ? "travel"
      : "office",
    title: `Parallel pane ${(index % manyChatPaneCount) + 1}`,
  }),
);

export function manyChatPaneId(position: number): string {
  if (!Number.isSafeInteger(position) || position < 1 || position > manyChatPaneCount) {
    throw new RangeError(`Many-pane position must be between 1 and ${String(manyChatPaneCount)}.`);
  }
  return `pane_grid${String(position).padStart(8, "0")}`;
}

const automaticRouteFixtures = Object.freeze([
  {
    policyVersion: 1,
    classificationReason: "boundedLeafCue",
    workClass: "boundedLeaf",
    requestedProfile: "lunaMax",
    selectedProfile: "lunaMax",
    profileFallbackReason: null,
    requestedServiceTier: "fast",
    selectedServiceTier: "fast",
    serviceTierFallbackReason: null,
  },
  {
    policyVersion: 1,
    classificationReason: "conservativeDefault",
    workClass: "standard",
    requestedProfile: "solMax",
    selectedProfile: "solMax",
    profileFallbackReason: null,
    requestedServiceTier: "standard",
    selectedServiceTier: "standard",
    serviceTierFallbackReason: null,
  },
  {
    policyVersion: 1,
    classificationReason: "largeChangeCue",
    workClass: "largeChange",
    requestedProfile: "solUltra",
    selectedProfile: "solUltra",
    profileFallbackReason: null,
    requestedServiceTier: "standard",
    selectedServiceTier: "standard",
    serviceTierFallbackReason: null,
  },
  {
    policyVersion: 1,
    classificationReason: "boundedLeafCue",
    workClass: "boundedLeaf",
    requestedProfile: "lunaMax",
    selectedProfile: "solMax",
    profileFallbackReason: "lunaUnavailable",
    requestedServiceTier: "fast",
    selectedServiceTier: "standard",
    serviceTierFallbackReason: "fastUnavailable",
  },
] as const satisfies readonly ChatRootTurnRoutingProjection[]);

const manyChatPanes = Array.from({ length: manyChatPaneCount }, (_, index) => chatPane(
  manyChatPaneId(index + 1),
  {
    title: `Parallel pane ${index + 1}`,
    turn: {
      id: `chatturn_grid${String(index + 1).padStart(8, "0")}`,
      status: "completed",
      startedAt: HRA_DIRECT_TIMESTAMP,
      completedAt: HRA_DIRECT_TIMESTAMP,
      continuationCount: 0,
      responseMarkdown: chatTail(`Pane ${index + 1} is ready.`),
      reasoningSummary: chatTail(""),
      reasoningSummaryVerified: false,
      tools: [],
      providerSubagents: { agents: [], overflowCount: 0 },
      routing: automaticRouteFixtures[index] ?? null,
    },
  },
));

export const parallelStreamPaneCount = 64;
export const parallelStreamRounds = 2;
export const parallelScriptedDeltaCount = parallelStreamPaneCount * parallelStreamRounds;
export const parallelFirstRenderBudgetMs = 2_500;
export const parallelSettlementBudgetMs = 4_000;
export const parallelStreamFinalMarker =
  `pulse ${String(parallelStreamRounds)}/${String(parallelStreamRounds)}`;

function parallelStreamDelta(lane: number, round: number): string {
  const pulse = `pulse ${String(round + 1)}/${String(parallelStreamRounds)}`;
  const sustainedBody = "detail ".repeat(128);
  return round === 0
    ? `Lane ${String(lane)}: ${sustainedBody}${pulse}`
    : ` · ${sustainedBody}${pulse}`;
}

export const parallelStreamExpectedResponses = Object.freeze(
  Array.from({ length: parallelStreamPaneCount }, (_, paneIndex) =>
    Array.from({ length: parallelStreamRounds }, (_, round) =>
      parallelStreamDelta(paneIndex + 1, round)
    ).join("")),
);

const parallelStreamPanes = Array.from({ length: parallelStreamPaneCount }, (_, index) => {
  const lane = index + 1;
  return chatPane(
    `pane_live_lane_${lane}`,
    {
      title: `Live lane ${lane}`,
      state: "streaming",
      turn: {
        id: `chatturn_live_lane_${lane}`,
        status: "streaming",
        startedAt: HRA_DIRECT_TIMESTAMP,
        completedAt: null,
        continuationCount: 0,
        responseMarkdown: chatTail(""),
        reasoningSummary: chatTail(""),
        reasoningSummaryVerified: false,
        tools: [],
        providerSubagents: { agents: [], overflowCount: 0 },
        routing: null,
      },
    },
  );
});
const parallelControlRemoteSession = directRemoteSummary(0, {
  gridPosition: parallelStreamPaneCount,
  title: "Control pane",
});
const parallelRemoteSessions = [
  parallelControlRemoteSession,
  ...denseRemoteSessions.slice(1),
];
const parallelDeltaEvents: HRADirectWorld["gateway"]["events"] = Array.from(
  { length: parallelStreamRounds },
  (_, round) => parallelStreamPanes.map((pane, paneIndex) => ({
    delayMs: round === 0 && paneIndex === 0 ? 120_000 : 500,
    event: {
      version: runtimeProtocolVersion,
      sequence: round * parallelStreamPaneCount + paneIndex + 1,
      event: {
        type: "chat.turn.delta" as const,
        paneId: pane.id,
        turnId: pane.turn!.id,
        revision: round + 2,
        channel: "responseMarkdown" as const,
        startUtf8Offset: new TextEncoder().encode(
          Array.from({ length: round }, (_, priorRound) =>
            parallelStreamDelta(paneIndex + 1, priorRound)
          ).join(""),
        ).byteLength,
        delta: parallelStreamDelta(paneIndex + 1, round),
      },
    },
  })),
).flat();
const parallelStreamEvents: HRADirectWorld["gateway"]["events"] =
  parallelDeltaEvents;

const harnessSettings = {
  revision: 2,
  recursiveSessionsEnabled: true,
  contextQuotaBytes: 16 * 1024 * 1024,
  refinementMode: "suggest",
} as const;

function harnessSnapshot(
  overrides: Partial<HarnessSnapshot> = {},
): HarnessSnapshot {
  return {
    revision: 3,
    settings: harnessSettings,
    proposals: [{
      id: "hproposal_exactcontext01",
      revision: 1,
      title: "Prefer exact context slices",
    }],
    ...overrides,
  };
}

function snapshotWithHarness(
  panes: readonly ChatPaneProjection[],
  harness: HarnessSnapshot = harnessSnapshot(),
  lastSequence = 0,
) {
  return runtimeSnapshotSchema.parse({
    ...emptySnapshot(),
    revision: lastSequence + 1,
    lastSequence,
    accounts: [personal, work],
    chat: { revision: 1, panes },
    harness,
  });
}

function harnessChild(
  suffix: string,
  state: HarnessChildState,
): HarnessChildProjection {
  const canStop = state !== "stopped" && state !== "quarantined";
  return {
    id: `hactor_${suffix}`,
    revision: 1,
    title: `${state[0]!.toUpperCase()}${state.slice(1)} child`,
    state,
    openedPaneId: null,
    canOpen: false,
    canMessage: false,
    canStop,
  };
}

function harnessParentPane(
  id: string,
  children: readonly HarnessChildProjection[],
): ChatPaneProjection {
  return chatPane(id, {
    title: "Recursive session",
    harness: {
      revision: 1,
      descendants: {
        count: children.length,
        truncated: false,
        children: [...children],
      },
    },
  });
}

const scenarioInputs = [
  {
    id: "chat-draft",
    title: "New chat pane",
    description: "A new pane exposes one minimal composer, a clear Rename affordance, automatic account routing, and no user model or speed controls.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([chatPane("pane_draft000001", {
          repository: {
            id: "repo_00000000000000000000000009",
            name: "example",
          },
        })])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
      task: {
        initialStateId: "empty",
        mutationTransitions: [],
        projectAdd: {
          version: runtimeProtocolVersion,
          status: "created",
          repository: {
            id: hraDirectTaskIds.repository,
            name: "hra",
            createdAt: HRA_DIRECT_TIME,
          },
          workspace: fixtureLocalWorkspace(1),
        },
        states: [{
          id: "empty",
          projectionJson: JSON.stringify({
            workspaces: [fixtureLocalWorkspace(1)],
            contexts: [],
            repositories: [],
            pages: [],
            details: [],
          }),
        }],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-streaming",
    title: "Streaming chat pane",
    description: "The real shell projects bounded active reasoning and response Markdown deltas while provider tool activity remains hidden.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([streamingInitialPane])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [{
          delayMs: 1,
          event: {
            version: runtimeProtocolVersion,
            sequence: 1,
            event: {
              type: "chat.pane.upserted",
              revision: streamingReasoningPane.revision,
              pane: streamingReasoningPane,
            },
          },
        }, {
          delayMs: 1,
          event: {
            version: runtimeProtocolVersion,
            sequence: 2,
            event: {
              type: "chat.turn.delta",
              paneId: streamingReasoningPane.id,
              turnId: "chatturn_streaming001",
              revision: 3,
              channel: "reasoningSummary",
              startUtf8Offset: 0,
              delta: streamingReasoningText,
            },
          },
        }, {
          delayMs: 1,
          event: {
            version: runtimeProtocolVersion,
            sequence: 3,
            event: {
              type: "chat.pane.upserted",
              revision: streamingToolPane.revision,
              pane: streamingToolPane,
            },
          },
        }, {
          delayMs: 1,
          event: {
            version: runtimeProtocolVersion,
            sequence: 4,
            event: {
              type: "chat.turn.delta",
              paneId: streamingToolPane.id,
              turnId: "chatturn_streaming001",
              revision: 5,
              channel: "responseMarkdown",
              startUtf8Offset: 0,
              delta: "## In progress\n\nThe signed artifact is being verified",
            },
          },
        }],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-completed",
    title: "Completed chat pane",
    description: "A settled pane renders the latest response plus completion-verified Markdown reasoning while unverified terminal reasoning stays hidden.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([completedChatPane])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-compact-malleable",
    title: "Malleable compact chat",
    description: "The real chat pane composes Markdown thinking and answer, pinned subagents, FIFO queue controls, one image preview, duration, and touch-safe composer chrome.",
    route: "/",
    world: createHRADirectWorld({
      surface: {
        kind: "compactChat",
        paneId: compactChatPane.id,
        nowUnixMilliseconds: HRA_DIRECT_TIME + 7_305_000,
        attachments: [{
          id: "attachment_compactdirect01",
          name: "compact-layout.png",
          mimeType: "image/png",
          byteSize: 2_048,
        }],
      },
      gateway: {
        snapshots: [snapshotWithChat([compactChatPane])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-attention",
    title: "Recoverable chat attention",
    description: "Quota, continuation, approval, runtime, and turn failures each stay concise and leave their composer enabled for a new message.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat(attentionChatPanes)],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-compact-320",
    title: "Compact pane at 320 px",
    description: "The real pane and every primary control remain contained at the narrow release viewport.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([chatPane("pane_compact_320", {
          title: "Compact routed response",
          activity: { ordinal: 1, kind: "responseCompleted" },
          turn: {
            id: "chatturn_compact_320",
            status: "completed",
            startedAt: HRA_DIRECT_TIMESTAMP,
            completedAt: HRA_DIRECT_TIMESTAMP,
            continuationCount: 0,
            responseMarkdown: chatTail("Compact route complete."),
            reasoningSummary: chatTail(""),
            reasoningSummaryVerified: false,
            tools: [],
            providerSubagents: { agents: [], overflowCount: 0 },
            routing: automaticRouteFixtures[3],
          },
        })])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-compact-639",
    title: "Compact pane at 639 px",
    description: "The real pane, navigation, and compact composer remain usable below the 640 px breakpoint at 120% text size.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([chatPane("pane_compact_639", { title: "Compact 639" })])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-compact-415",
    title: "Compact pane at 415 px",
    description: "The real pane and every primary control remain contained below 416 px at the maximum 150% text size.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([chatPane("pane_compact_415", { title: "Compact 415" })])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-many-panes",
    title: "Many parallel panes",
    description: "Sixty-four independently contained panes exercise responsive density and offscreen rendering.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat(manyChatPanes)],
        encoding: { kind: "chunked", chunkBytes: 1_024 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-parallel-streaming",
    title: "Parallel streaming isolation",
    description: "Sixty-four active local panes receive deterministic interleaved deltas while a 448-summary remote directory preserves its mounted DOM identities.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithSessionSync(
          { ...activeSessionSyncStatus, pendingEnrollments: [] },
          parallelRemoteSessions,
          parallelStreamPanes,
        )],
        encoding: { kind: "chunked", chunkBytes: 4_096 },
        events: parallelStreamEvents,
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-create-pane",
    title: "Create a pane",
    description: "The New pane action consumes a pathless native project result before creating one renderer-safe pane.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
      task: {
        initialStateId: "empty",
        mutationTransitions: [],
        projectAdd: {
          version: runtimeProtocolVersion,
          status: "created",
          repository: {
            id: hraDirectTaskIds.repository,
            name: "hra",
            createdAt: HRA_DIRECT_TIME,
          },
          workspace: fixtureLocalWorkspace(1),
        },
        states: [{
          id: "empty",
          projectionJson: JSON.stringify({
            workspaces: [fixtureLocalWorkspace(1)],
            contexts: [],
            repositories: [],
            pages: [],
            details: [],
          }),
        }],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-create-pane-inherit",
    title: "Create a pane in the last repository",
    description: "New pane reuses the visually last local pane repository without reopening the native project chooser.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([chatPane("pane_inherit000001", {
          title: "Existing example pane",
          repository: {
            id: "repo_00000000000000000000000009",
            name: "example",
          },
        })])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
      task: {
        initialStateId: "empty",
        mutationTransitions: [],
        projectAdd: {
          version: runtimeProtocolVersion,
          status: "created",
          repository: {
            id: hraDirectTaskIds.repository,
            name: "hra",
            createdAt: HRA_DIRECT_TIME,
          },
          workspace: fixtureLocalWorkspace(1),
        },
        states: [{
          id: "empty",
          projectionJson: JSON.stringify({
            workspaces: [fixtureLocalWorkspace(1)],
            contexts: [],
            repositories: [],
            pages: [],
            details: [],
          }),
        }],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "chat-pane-order",
    title: "Reorder local panes",
    description: "Pointer drag and keyboard-accessible menu actions share the durable typed local-pane reorder boundary.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([
          chatPane("pane_order000001", { title: "First pane" }),
          chatPane("pane_order000002", { title: "Second pane" }),
          chatPane("pane_order000003", { title: "Third pane" }),
        ])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "settings-no-subscriptions",
    title: "Settings without subscriptions",
    description: "With no signed-in Codex subscription, Settings is the only destination and pane creation is absent.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([], [])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "harness-settings",
    title: "Recursive harness settings",
    description: "Settings controls recursive sessions, bounded context quota, Off or Suggest refinement, and read-only proposal titles.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithHarness([])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "harness-children-mixed",
    title: "Mixed recursive children",
    description: "One bounded branch view distinguishes every persistent actor state with only per-child Open and Stop controls.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithHarness([harnessParentPane(
          "pane_childrenmixed",
          [
            harnessChild("starting0001", "starting"),
            harnessChild("running0002", "running"),
            harnessChild("waiting0001", "waiting"),
            harnessChild("idle00000001", "idle"),
            harnessChild("failed00002", "failed"),
            harnessChild("stopped0001", "stopped"),
            harnessChild("quarantine01", "quarantined"),
          ],
        )])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "settings-browser-login",
    title: "Browser subscription sign-in",
    description: "Settings presents connected subscriptions with bounded remaining capacity, the existing browser sign-in continuation, and a distinct HRA Cloud sign-in action.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithChat([], [browserLogin, work])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "settings-human-credential-recovery",
    title: "Human credential recovery",
    description: "Settings non-destructively reinspects permanent credential custody faults, obtains explicit preservation consent, and returns the installation to browser sign-in.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [humanCredentialRecoverySnapshot],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "settings-session-sync-disabled",
    title: "Session sync opt-in",
    description: "Settings keeps encrypted remote observation disabled until this Mac explicitly opts in.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithSessionSync({
          state: "disabled",
          revision: 0,
          deviceName: "Studio Mac",
        })],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "settings-session-sync-active",
    title: "Active sync devices",
    description: "Settings shows three bounded device summaries, identifies unavailable administration, and keeps recovery reveal and sync disable available.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithSessionSync(
          activeSessionSyncStatus,
          Array.from({ length: 4 }, (_, index) => directRemoteSummary(index)),
        )],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "settings-session-sync-unavailable",
    title: "Session sync unavailable",
    description: "A relay outage remains isolated to encrypted remote observation and exposes one bounded retry action.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithSessionSync({
          state: "unavailable",
          reason: "serviceUnavailable",
          retryable: true,
        })],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "session-sync-fault-cloud",
    title: "Cloud configuration fault isolation",
    description: "Missing cloud configuration cannot block a local pane creation or message send.",
    route: "/",
    world: sessionSyncFaultWorld(
      "cloudConfigurationMissing",
      "pane_sync_fault_cloud",
      "Cloud fault local",
    ),
    runtime: logicalRuntime,
  },
  {
    id: "session-sync-fault-auth",
    title: "Authentication fault isolation",
    description: "Expired sync authentication cannot block a local pane creation or message send.",
    route: "/",
    world: sessionSyncFaultWorld(
      "signedOut",
      "pane_sync_fault_auth",
      "Auth fault local",
    ),
    runtime: logicalRuntime,
  },
  {
    id: "session-sync-fault-keychain",
    title: "Keychain fault isolation",
    description: "Unavailable sync key custody cannot block a local pane creation or message send.",
    route: "/",
    world: sessionSyncFaultWorld(
      "keychainUnavailable",
      "pane_sync_fault_keychain",
      "Keychain fault local",
    ),
    runtime: logicalRuntime,
  },
  {
    id: "session-sync-fault-network",
    title: "Network fault isolation",
    description: "An unavailable sync relay cannot block a local pane creation or message send.",
    route: "/",
    world: sessionSyncFaultWorld(
      "serviceUnavailable",
      "pane_sync_fault_network",
      "Network fault local",
    ),
    runtime: logicalRuntime,
  },
  {
    id: "settings-session-sync-enrolling",
    title: "Pair this Mac",
    description: "The candidate Mac shows the same locally verified six-digit code used by an approving device.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithSessionSync({
          state: "enrolling",
          revision: 3,
          deviceId: directCandidateSyncDeviceId,
          deviceName: "New Mac",
          requestId: `syncenroll_${"e".repeat(32)}`,
          pairingCode: "123456",
          phase: "awaitingApproval",
          retryable: false,
        })],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "remote-session-summaries-512",
    title: "512 local and remote summaries",
    description: "Sixty-four local panes and 448 encrypted remote summaries share one stable 512-slot grid while the remote directory mounts through a bounded window.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithSessionSync(
          { ...activeSessionSyncStatus, pendingEnrollments: [] },
          denseRemoteSessions,
          manyChatPanes,
        )],
        encoding: { kind: "chunked", chunkBytes: 4_096 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "empty-ready",
    title: "Empty ready product",
    description: "The real pane and subscription shell with a ready gateway and no profiles.",
    route: "/",
    world: createHRADirectWorld(),
    runtime: logicalRuntime,
  },
  {
    id: "gateway-starting",
    title: "Gateway starting",
    description: "The bundled runtime is present but account mutations remain paused.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [emptySnapshot({ state: "starting", generation: 0 })],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "gateway-failed",
    title: "Gateway failed",
    description: "A global runtime integrity failure remains visible and fail-closed.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [emptySnapshot({
          state: "failed",
          generation: 0,
          message: "The bundled Codex runtime did not pass its integrity check.",
          canRestart: false,
        })],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "renderer-boundary",
    title: "Renderer projection boundary",
    description: "The strict renderer snapshot contains no task page, session, usage, model catalog, or worktree fields.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithAccounts([personal])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "account-signed-out",
    title: "Signed-out profile",
    description: "A signed-out profile offers the lean browser OAuth action.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithAccounts([signedOut])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "account-maximum-label",
    title: "Maximum account label",
    description: "An unbroken 80-character account label wraps without widening the window.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithAccounts([maximumLabelAccount])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "login-browser",
    title: "Browser sign-in",
    description: "A browser login is waiting without exposing its authority URL.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithAccounts([browserLogin])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "profiles-isolated",
    title: "Two isolated profiles",
    description: "Two local Codex identities remain independently manageable.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithAccounts([personal, work])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "credential-expired",
    title: "Codex credential expired",
    description: "An expired account is blocked until a human reconnects it locally.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithAccounts([expiredCredentialAccount])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "credential-recovery",
    title: "Codex credential recovery",
    description: "A bounded account event restores eligibility without exposing credentials.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithAccounts([expiredCredentialAccount])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [{
          delayMs: 250,
          event: {
            version: runtimeProtocolVersion,
            sequence: 1,
            event: { type: "account.upserted", account: recoveredCredentialAccount },
          },
        }],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "profile-sibling-failed",
    title: "One failed sibling",
    description: "One account runtime fails while its healthy sibling remains intact.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [snapshotWithAccounts([healthyPersonal, failedWork])],
        encoding: { kind: "chunked", chunkBytes: 257 },
        events: [],
      },
    }),
    runtime: logicalRuntime,
  },
  {
    id: "transport-recovery",
    title: "Sequence-gap recovery",
    description: "An out-of-sequence account event forces an authoritative resnapshot.",
    route: "/",
    world: createHRADirectWorld({
      gateway: {
        snapshots: [runtimeSnapshotSchema.parse({
          ...emptySnapshot(),
          accounts: [recoveryAccount],
        }), recoverySnapshot],
        encoding: { kind: "chunked", chunkBytes: 97 },
        events: [{
          delayMs: 250,
          event: {
            version: runtimeProtocolVersion,
            sequence: 2,
            event: { type: "account.upserted", account: recoveryAccount },
          },
        }],
      },
    }),
    runtime: logicalRuntime,
  },
] as const satisfies readonly ScenarioDefinitionInput<HRADirectWorld, HRADirectRoute>[];

type HRAScenarioId = (typeof scenarioInputs)[number]["id"];

export const hraScenarioMetadata = {
  "chat-draft": { group: "Panes", viewport: "wide" },
  "chat-streaming": { group: "Panes", viewport: "wide" },
  "chat-completed": { group: "Panes", viewport: "wide" },
  "chat-compact-malleable": { group: "Panes", viewport: "compact" },
  "chat-attention": { group: "Recovery", viewport: "wide" },
  "chat-compact-320": { group: "Panes", viewport: "compact" },
  "chat-compact-639": { group: "Panes", viewport: "compact" },
  "chat-compact-415": { group: "Panes", viewport: "compact" },
  "chat-many-panes": { group: "Panes", viewport: "wide" },
  "chat-parallel-streaming": { group: "Panes", viewport: "wide" },
  "chat-create-pane": { group: "Panes", viewport: "wide" },
  "chat-create-pane-inherit": { group: "Panes", viewport: "wide" },
  "chat-pane-order": { group: "Panes", viewport: "wide" },
  "settings-no-subscriptions": { group: "Accounts", viewport: "wide" },
  "harness-settings": { group: "Harness", viewport: "wide" },
  "harness-children-mixed": { group: "Harness", viewport: "wide" },
  "settings-browser-login": { group: "Accounts", viewport: "wide" },
  "settings-human-credential-recovery": { group: "Recovery", viewport: "wide" },
  "settings-session-sync-disabled": { group: "Accounts", viewport: "wide" },
  "settings-session-sync-active": { group: "Accounts", viewport: "wide" },
  "settings-session-sync-enrolling": { group: "Accounts", viewport: "wide" },
  "settings-session-sync-unavailable": { group: "Recovery", viewport: "wide" },
  "session-sync-fault-cloud": { group: "Recovery", viewport: "wide" },
  "session-sync-fault-auth": { group: "Recovery", viewport: "wide" },
  "session-sync-fault-keychain": { group: "Recovery", viewport: "wide" },
  "session-sync-fault-network": { group: "Recovery", viewport: "wide" },
  "remote-session-summaries-512": { group: "Panes", viewport: "wide" },
  "empty-ready": { group: "Gateway", viewport: "wide" },
  "gateway-starting": { group: "Gateway", viewport: "wide" },
  "gateway-failed": { group: "Gateway", viewport: "wide" },
  "renderer-boundary": { group: "Dispatch", viewport: "compact" },
  "account-signed-out": { group: "Accounts", viewport: "wide" },
  "account-maximum-label": { group: "Accounts", viewport: "compact" },
  "login-browser": { group: "Accounts", viewport: "wide" },
  "profiles-isolated": { group: "Accounts", viewport: "wide" },
  "credential-expired": { group: "Recovery", viewport: "wide" },
  "credential-recovery": { group: "Recovery", viewport: "wide" },
  "profile-sibling-failed": { group: "Accounts", viewport: "wide" },
  "transport-recovery": { group: "Recovery", viewport: "compact" },
} as const satisfies Readonly<Record<HRAScenarioId, HRAScenarioMetadata>>;

const hraScenarioMetadataById = new Map<string, HRAScenarioMetadata>(
  Object.entries(hraScenarioMetadata),
);

export function getHRAScenarioMetadata(
  scenario: string,
): HRAScenarioMetadata | undefined {
  return hraScenarioMetadataById.get(scenario);
}

export const hraDirectDefinition = defineDirect({
  parseWorld: parseHRADirectWorld,
  defaultScenario: "chat-draft",
  scenarios: scenarioInputs,
  coverage: [
    { key: "chat.pane.draft", mode: "fixture", claim: "A new pane exposes one minimal composer, compact pane actions, automatic account routing, and no user-facing model or speed configuration.", scenarios: ["chat-draft"] },
    { key: "chat.pane.streaming", mode: "fixture", claim: "Ordered shell events render bounded reasoning and response Markdown through one safe renderer while provider tool activity remains intentionally absent from chat UI.", scenarios: ["chat-streaming"] },
    { key: "chat.pane.latest-response", mode: "fixture", claim: "A settled pane renders the latest assistant Markdown response plus only completion-reconciled verified Markdown reasoning; raw or unverified terminal reasoning stays hidden and the composer re-enables.", scenarios: ["chat-completed"] },
    { key: "chat.pane.attention-recovery", mode: "fixture", claim: "The rendered quota, continuation, approval, runtime, and turn attention presentations remain concise, expose no HITL answer controls, and each permit a later message.", scenarios: ["chat-attention"] },
    { key: "chat.pane.create", mode: "mixed", claim: "The real New pane control opens the pathless native chooser only for the first pane, then reuses the visually last local repository through the typed pane-create command.", scenarios: ["chat-create-pane", "chat-create-pane-inherit"] },
    { key: "chat.pane.order", mode: "mixed", claim: "Local panes reorder through both pointer drag and keyboard-accessible menu affordances, persist through the typed command/event boundary, and leave remote anchors fixed.", scenarios: ["chat-pane-order"] },
    { key: "chat.pane.compact-responsive", mode: "fixture", claim: "The rendered pane, navigation, Markdown, pinned stacks, attachment preview, and composer remain horizontally contained at 320 px, at 639 px and 120% text size, at 415 px and 150% text size, and at the 26rem/200% contract.", scenarios: ["chat-compact-malleable", "chat-compact-320", "chat-compact-639", "chat-compact-415"] },
    { key: "chat.pane.parallel-performance", mode: "fixture", claim: "Sixty-four simultaneous local streams receive deterministic interleaved deltas within explicit first-render and settlement budgets while a 448-summary remote directory preserves all 48 mounted DOM identities; sixty-four settled panes separately prove dense-grid containment.", scenarios: ["chat-parallel-streaming", "chat-many-panes"] },
    { key: "chat.turn.routing", mode: "fixture", claim: "Automatic routing remains absent from user configuration and chat chrome across Luna Max Fast, Sol Max Standard, Sol Ultra Standard, and fallback fixtures.", scenarios: ["chat-many-panes", "chat-compact-320"] },
    { key: "chat.pane.inline-title", mode: "mixed", claim: "The compact pane actions menu opens the real revision-bound title editor; persistence conflict handling remains gateway integration evidence.", scenarios: ["chat-draft"] },
    { key: "chat.pane.queue-steer", mode: "fixture", claim: "A complete FIFO queue projects editable and removable rows, exposes steering only on its head, and keeps the active composer available for ordinary queueing.", scenarios: ["chat-compact-malleable"] },
    { key: "chat.pane.attachment-preview", mode: "mixed", claim: "The deterministic frontend fixture renders one blob preview with remove and paste/chooser affordances; focused live integration tests prove gateway custody, restart-safe vault persistence, exact leases, and ordered provider image delivery.", scenarios: ["chat-compact-malleable"] },
    { key: "chat.pane.elapsed", mode: "fixture", claim: "One logical HRA turn duration renders beside the submit and Stop controls outside every live region.", scenarios: ["chat-compact-malleable"] },
    { key: "chat.pane.identity-status", mode: "fixture", claim: "The typed frontend palette port selects a golden-angle identity accent while text, glyphs, and semantic outlines retain status independently of hue; durable palette projection remains integration evidence.", scenarios: ["chat-compact-malleable"] },
    { key: "chat.subscription-gate", mode: "fixture", claim: "Without a signed-in Codex subscription, the canonical route is Settings and no panes destination or creation affordance is rendered.", scenarios: ["settings-no-subscriptions"] },
    { key: "harness.ordinary-zero-chrome", mode: "fixture", claim: "An ordinary chat pane receives an explicit null harness projection and renders no recursive controls.", scenarios: ["chat-draft"] },
    { key: "harness.recursive-children", mode: "fixture", claim: "One bounded parent projection distinguishes persistent actor states in a pinned compact list without prompts, provider identities, filesystem paths, or per-child action chrome.", scenarios: ["harness-children-mixed", "chat-compact-malleable"] },
    { key: "harness.settings", mode: "fixture", claim: "Settings exposes only recursive sessions, bounded context quota, Off or Suggest refinement, and read-only proposal titles.", scenarios: ["harness-settings"] },
    { key: "harness.renderer-boundary", mode: "mixed", claim: "Strict harness projections contain only settings, proposal titles with identity/revision, and bounded child summaries without provider IDs, filesystem paths, transcripts, values, programs, trials, or arbitrary commands.", scenarios: ["harness-children-mixed", "harness-settings"] },
    { key: "settings.subscription-browser-login", mode: "mixed", claim: "The lean Settings surface shows bounded remaining capacity, creates and reconnects Codex subscriptions through browser sign-in, and keeps HRA Cloud attachment explicit and separate.", scenarios: ["settings-browser-login"] },
    { key: "settings.human-credential-recovery", mode: "mixed", claim: "The real Settings surface non-destructively retries credential inspection, fences stale revisions, requires explicit inline preservation consent, and returns retired human custody to browser sign-in; Keychain and SQLite transitions remain native integration evidence.", scenarios: ["settings-human-credential-recovery"] },
    { key: "settings.session-sync-security", mode: "mixed", claim: "Encrypted remote observation is explicit opt-in; enrolling and active Settings project the six-digit comparison while unavailable approval and revocation stay fail-closed; active Settings reveal recovery material and disable sync; cloud, authentication, Keychain, or network faults cannot block local pane creation or message send.", scenarios: ["settings-session-sync-disabled", "settings-session-sync-enrolling", "settings-session-sync-active", "settings-session-sync-unavailable", "session-sync-fault-cloud", "session-sync-fault-auth", "session-sync-fault-keychain", "session-sync-fault-network"] },
    { key: "renderer.remote-summary-window", mode: "fixture", claim: "A 512-slot grid of 64 local panes plus 448 remote summaries stays title-first and collision-disambiguated; remote summary-v1 cells remain read-only and mount through a bounded 48-item window.", scenarios: ["remote-session-summaries-512"] },
    { key: "renderer.chat-boundary", mode: "mixed", claim: "The strict renderer projection exposes bounded latest-turn text and derived subscription remaining percentage without rendering tool calls, prompts, raw protocol items, private paths, credentials, raw usage details, or transcripts.", scenarios: ["chat-completed", "chat-streaming"] },
    { key: "transport.chunked.snapshot", mode: "fixture", claim: "Chat scenarios traverse strict chunk parsing and UTF-8 assembly through the real bridge and shell.", scenarios: ["chat-draft", "chat-many-panes"] },
    { key: "transport.ordered-chat-deltas", mode: "fixture", claim: "Exact revision and UTF-8 offsets govern ordered reasoning and response deltas.", scenarios: ["chat-streaming"] },
    { key: "harness.provider-recursion.direct", mode: "direct", claim: "Real Codex subagent spawning, provider session continuity, and process supervision require packaged runtime evidence.", scenarios: [] },
    { key: "harness.native-persistence.direct", mode: "direct", claim: "Encrypted Context Heap persistence, key custody, crash recovery, and native deletion require packaged runtime evidence.", scenarios: [] },
    { key: "native.zig.bridge.direct", mode: "direct", claim: "Zig command registration, WebView delivery, and native transport require packaged-app evidence.", scenarios: [] },
    { key: "native.gateway.direct", mode: "direct", claim: "The compiled gateway, Codex supervision, SQLite, and private account homes require integration evidence.", scenarios: [] },
  ],
});
