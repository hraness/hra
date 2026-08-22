#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "@hra-internal/schema";
import {
  classifyCoverageEvidence,
  parseDirectProbeSnapshot,
  parseDefinitionCoverageSnapshot,
  type DirectProbeSnapshot,
  type CoverageEntry,
} from "@hraness/direct/testing";
import {
  acquireVerificationServer,
  bindDirectBrowserContractEvidence,
  bindDirectScenarioCatalog,
  canAutomaticallyStartLocalServer,
  createAgentBrowser,
  createArtifactRun,
  normalizeRootHttpOrigin,
  parseBaseUrlArguments,
  readDirectBrowserContract,
  renderUnknown,
  spawnVerificationServer,
  stopVerificationServer,
  writeJsonAtomically,
  type AgentBrowser,
  type BrowserVerificationArguments,
  type DirectBrowserContract,
} from "@hraness/direct/tooling/browser-verification";
import {
  attentionPresentations,
  denseRemoteSessionCount,
  manyChatPaneCount,
  hraDirectDefinition,
  parallelFirstRenderBudgetMs,
  parallelScriptedDeltaCount,
  parallelSettlementBudgetMs,
  parallelStreamExpectedResponses,
  parallelStreamFinalMarker,
  parallelStreamPaneCount,
  parallelStreamRounds,
} from "./scenarios";
import { remoteSessionMountLimit } from "../src/features/chat/PaneGrid";
import { legacyOprteUiScaleStorageKey } from "../src/ui-scale";

const DEFAULT_BASE_URL = "http://127.0.0.1:5174";
const SERVER_START_TIMEOUT_MS = 30_000;
const DIRECT_ROOT_ASSET_PATHS = new Set([
  "/compact-chat-surface.tsx",
  "/main.tsx",
  "/runtime.ts",
  "/scenarios.ts",
  "/transport.ts",
  "/workbench.css",
  "/workbench.tsx",
  "/world.ts",
]);
const STABLE_PROBE_EXPRESSION = `(() => {
  const bridge = window.__direct;
  if (bridge === undefined || typeof bridge.snapshot !== "function") return false;
  const snapshot = bridge.snapshot();
  const quiet = snapshot.isQuiescent === true
    && snapshot.activity.active === 0
    && Object.values(snapshot.pending).every((value) => value === 0);
  if (!quiet) {
    window.__hraDirectVerifierQuiet = undefined;
    return false;
  }
  const key = [
    snapshot.activationHash,
    snapshot.generation,
    snapshot.revision,
    snapshot.activity.started,
    snapshot.activity.settled,
  ].join(":");
  const previous = window.__hraDirectVerifierQuiet;
  if (previous?.key !== key) {
    window.__hraDirectVerifierQuiet = { key, since: Date.now() };
    return false;
  }
  return Date.now() - previous.since >= 150;
})()`;

const browserErrorsSchema = z.object({ errors: z.array(z.unknown()) });
const consoleSchema = z.object({
  messages: z.array(z.object({ type: z.string(), text: z.string() })),
});
const networkSchema = z.object({
  requests: z.array(z.object({
    method: z.string(),
    status: z.number().int().optional(),
    url: z.string(),
  })),
});
const uiScaleMeasurementSchema = z.object({
  rootFontSizePx: z.number().finite(),
  uiScale: z.string(),
}).strict();
const remainingWorkSchema = z.object({
  cancelledScriptedEvents: z.number().int().nonnegative(),
  disposed: z.boolean(),
  pendingSnapshotTransfers: z.number().int().nonnegative(),
  scriptedEvents: z.number().int().nonnegative(),
  snapshotReads: z.number().int().nonnegative(),
}).strict();
const responsiveSurfaceMeasurementSchema = z.object({
  clientWidth: z.number().finite().nonnegative(),
  label: z.string().min(1),
  left: z.number().finite(),
  right: z.number().finite(),
  scrollWidth: z.number().finite().nonnegative(),
});
const requiredResponsiveSurfaceLabels = [
  "outer Direct frame",
  "app frame",
  "app header",
  "main content",
] as const;
const responsiveLayoutMeasurementSchema = z.object({
  ariaHiddenFocusableControls: z.array(z.string()),
  clientHeight: z.number().finite().nonnegative(),
  clientWidth: z.number().finite().nonnegative(),
  controls: z.array(z.object({
    bottom: z.number().finite(),
    height: z.number().finite().nonnegative(),
    label: z.string(),
    left: z.number().finite(),
    right: z.number().finite(),
    top: z.number().finite(),
  })),
  scrollX: z.number().finite(),
  scrollWidth: z.number().finite().nonnegative(),
  surfaces: z.array(responsiveSurfaceMeasurementSchema).min(1),
});
const parallelPerformanceMeasurementSchema = z.object({
  exactResponsePaneCount: z.number().int().nonnegative(),
  firstStreamMutationMs: z.number().finite().nonnegative().nullable(),
  mismatchedResponsePaneIds: z.array(z.string().min(1)).max(parallelStreamPaneCount),
  remoteIdentitiesPreserved: z.boolean(),
  remoteMutationCount: z.number().int().nonnegative(),
  remotePaneCount: z.number().int().positive(),
  remotePanesConnected: z.boolean(),
  remoteTextPreserved: z.boolean(),
  scriptedDeltaCount: z.number().int().positive(),
  settlementMs: z.number().finite().nonnegative(),
  streamMutationCount: z.number().int().nonnegative(),
  streamMutationBatchCount: z.number().int().nonnegative(),
  streamPaneCount: z.number().int().positive(),
  updatedStreamPaneCount: z.number().int().nonnegative(),
}).strict();
const remoteSummaryWindowEvidenceSchema = z.object({
  localTitles: z.array(z.string()),
  orderedKinds: z.array(z.enum(["local", "remote"])),
  rows: z.array(z.object({
    accessibleName: z.string(),
    collisionLine: z.string(),
    state: z.string(),
    title: z.string(),
    titleFirst: z.boolean(),
    triggerName: z.string(),
  }).strict()),
}).strict();
export type HRADirectRemainingWork = z.infer<typeof remainingWorkSchema>;
type ProbeSnapshot = Omit<DirectProbeSnapshot, "remainingWork"> & {
  readonly remainingWork: HRADirectRemainingWork;
};
type NetworkRequest = z.infer<typeof networkSchema>["requests"][number];
export type ResponsiveLayoutMeasurement = z.infer<typeof responsiveLayoutMeasurementSchema>;
export type ParallelPerformanceMeasurement = z.infer<typeof parallelPerformanceMeasurementSchema>;
export type ParallelComposerMeasurement = Readonly<{
  composerCount: number;
  disabledComposerCount: number;
  disabledSendButtonCount: number;
}>;
type RemoteSummaryWindowEvidence = z.infer<typeof remoteSummaryWindowEvidenceSchema>;
interface CoveragePolicyEntry {
  readonly claim: string;
  readonly key: string;
  readonly mode: "direct" | "fixture" | "mixed";
  readonly scenarios: readonly string[];
}
type ScenarioAction =
  | "prepare-draft"
  | "create-pane"
  | "open-attention"
  | "exercise-malleable-chat"
  | "exercise-scheduled-chat"
  | "exercise-compact-controls"
  | "exercise-local-under-sync-fault"
  | "exercise-session-sync-recovery-disable"
  | "none"
  | "open-settings"
  | "open-settings-login"
  | "open-settings-sync"
  | "page-remote-summaries"
  | "reorder-panes"
  | "recover-human-account"
  | "recover-attention"
  | "scale-compact-120"
  | "scale-compact-150"
  | "send-follow-up";
type PreQuiescenceAction = "observe-parallel-streaming" | "none";

interface ScenarioDefinition {
  readonly browserLane?: "forced-touch-reduced" | "standard";
  readonly id: string;
  readonly expectedBeforeAction?: readonly string[];
  readonly expectedText: readonly string[];
  readonly expectedUiScale?: string;
  readonly expectedVisibleControls?: readonly string[];
  readonly forbiddenText?: readonly string[];
  readonly action: ScenarioAction;
  readonly preQuiescence?: PreQuiescenceAction;
  readonly viewport: { readonly height: number; readonly width: number };
}

interface ScenarioEvidence {
  readonly active: DirectBrowserContract["manifest"]["active"];
  readonly catalogHash: string;
  readonly id: string;
  readonly url: string;
  readonly expectedBeforeAction: readonly string[];
  readonly expectedText: readonly string[];
  readonly probe: ProbeSnapshot;
  readonly networkRequests: number;
  readonly parallelPerformance: ParallelPerformanceMeasurement | null;
  readonly responsiveLayout: ResponsiveLayoutMeasurement;
  readonly rootFontSizePx: number;
  readonly screenshot: string;
  readonly uiScale: string;
}

interface ScenarioVerification {
  readonly evidence: ScenarioEvidence;
  readonly manifest: DirectBrowserContract["manifest"];
}

const scenarios = [
  {
    id: "chat-draft",
    action: "prepare-draft",
    expectedBeforeAction: ["HRA"],
    expectedText: ["Direct pane", "hra"],
    expectedUiScale: "0.8",
    expectedVisibleControls: [
      "New pane",
      "More actions for Direct pane",
    ],
    forbiddenText: ["Queue", "Steer", "Approval", "Tasks", "Accounts"],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "chat-streaming",
    action: "none",
    expectedText: [
      "Streaming turn",
      "Checking the release state and the current public route.",
      "In progress",
      "The signed artifact is being verified",
    ],
    forbiddenText: ["Allow once", "Approve", "Queue", "Steer"],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "chat-scheduled",
    action: "exercise-scheduled-chat",
    expectedBeforeAction: [
      "Scheduled release audit",
      "Scheduled · due now",
      "Documents",
    ],
    expectedText: [
      "Scheduled release audit",
      "Scheduled · due now",
      "Direct could not interpret that schedule.",
      "Documents",
    ],
    expectedVisibleControls: [
      "Shared folder access: Documents. Choose folder",
      "Turn off scheduling",
      "Update schedule for Scheduled release audit",
      "More actions for Scheduled release audit",
    ],
    forbiddenText: ["FREQ=DAILY", "Attach images", "Queue", "Steer"],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "chat-compact-malleable",
    action: "exercise-malleable-chat",
    browserLane: "forced-touch-reduced",
    expectedUiScale: "2",
    expectedBeforeAction: [
      "Steer the active turn with the accessibility findings.",
      "Then tighten the 26rem layout.",
    ],
    expectedText: [
      "Malleable metaharness",
      "Thinking",
      "Checking queue order, touch targets, and image custody.",
      "Compact answer",
      "Markdown stays safe",
      "Routing audit",
      "Direct verification",
      "Attachment vault",
      "Then tighten the compact layout.",
      "compact-layout.png",
      "2h 1m 45s",
    ],
    expectedVisibleControls: [
      "More actions for Malleable metaharness",
      "Attach images",
      "Remove compact-layout.png",
      "Edit queued message",
      "Remove queued message",
      "Send queued message now",
      "Stop Malleable metaharness",
      "Queue message for Malleable metaharness",
    ],
    forbiddenText: ["Latest tool", "Luna", "Sol Max", "providerId"],
    viewport: { width: 390, height: 844 },
  },
  {
    id: "chat-completed",
    action: "send-follow-up",
    expectedBeforeAction: [
      "Release HRA",
      "Verified reasoning",
      "Completion reconciliation confirmed the exact provider summary.",
      "Release ready",
      "The latest response is rendered as Markdown.",
      "Signed",
      "Verified",
      "Published",
    ],
    expectedText: ["Direct response", "Completed: Follow up after release"],
    forbiddenText: [
      "Queue",
      "Steer",
      "Unverified provider reasoning",
      "This must stay hidden.",
    ],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "chat-attention",
    action: "recover-attention",
    expectedBeforeAction: [
      ...attentionPresentations.flatMap(({ message, title }) => [title, message]),
    ],
    expectedText: [
      "Direct response",
      ...attentionPresentations.map(({ prompt }) => `Completed: ${prompt}`),
    ],
    forbiddenText: ["Allow once", "Approve", "Queue", "Steer", "Submit answer"],
    viewport: { width: 1_760, height: 900 },
  },
  {
    id: "attention-mission-control",
    action: "open-attention",
    expectedBeforeAction: ["Release delivery"],
    expectedText: [
      "Attention",
      "Local recovery, decisions, and reviews",
      "Recovery",
      "Message delivery is uncertain",
      "Needs you",
      "2 tasks need attention",
      "Review",
      "1 task is ready for review",
    ],
    expectedVisibleControls: [
      "Attention, 3 items",
      "Refresh attention",
      "Close attention",
    ],
    forbiddenText: ["providerSession", "/Users/"],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "chat-compact-320",
    action: "exercise-compact-controls",
    expectedText: [
      "Compact routed response",
      "Compact route complete.",
    ],
    expectedVisibleControls: [
      "New pane",
      "More actions for Compact routed response",
      "Send",
    ],
    forbiddenText: ["Queue", "Steer", "Tasks", "Accounts"],
    viewport: { width: 320, height: 720 },
  },
  {
    id: "chat-compact-639",
    action: "scale-compact-120",
    expectedText: ["Compact 639"],
    expectedUiScale: "1.2",
    expectedVisibleControls: [
      "New pane",
      "More actions for Compact 639",
      "Send",
    ],
    forbiddenText: ["Queue", "Steer", "Tasks", "Accounts"],
    viewport: { width: 639, height: 820 },
  },
  {
    id: "chat-compact-415",
    action: "scale-compact-150",
    expectedText: ["Compact 415"],
    expectedUiScale: "1.5",
    expectedVisibleControls: [
      "New pane",
      "More actions for Compact 415",
      "Send",
    ],
    forbiddenText: ["Queue", "Steer", "Tasks", "Accounts"],
    viewport: { width: 415, height: 780 },
  },
  {
    id: "chat-many-panes",
    action: "none",
    expectedText: ["Parallel pane 1"],
    forbiddenText: ["Queue", "Steer", "Tasks", "Accounts"],
    viewport: { width: 1_760, height: 900 },
  },
  {
    id: "chat-parallel-streaming",
    action: "none",
    preQuiescence: "observe-parallel-streaming",
    expectedText: [
      "Live lane 1",
      "Lane 1:",
      `pulse 1/${String(parallelStreamRounds)}`,
      `pulse ${String(parallelStreamRounds)}/${String(parallelStreamRounds)}`,
    ],
    forbiddenText: ["Queue", "Steer", "Tasks", "Accounts"],
    viewport: { width: 1_120, height: 900 },
  },
  {
    id: "chat-create-pane",
    action: "create-pane",
    expectedBeforeAction: ["Create a pane to start."],
    expectedText: ["HRA", "hra"],
    expectedVisibleControls: ["New pane"],
    forbiddenText: ["/Users/", "Library/Application Support", "Choose folder"],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "chat-create-pane-inherit",
    action: "create-pane",
    expectedBeforeAction: ["Existing example pane"],
    expectedText: ["Existing example pane", "example"],
    expectedVisibleControls: ["New pane"],
    forbiddenText: ["Choose folder", "hra"],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "chat-pane-order",
    action: "reorder-panes",
    expectedBeforeAction: ["First pane", "Second pane", "Third pane"],
    expectedText: ["First pane", "Second pane", "Third pane"],
    expectedVisibleControls: [
      "More actions for First pane",
      "More actions for Second pane",
      "More actions for Third pane",
    ],
    forbiddenText: ["Automatic subscription"],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "settings-no-subscriptions",
    action: "none",
    expectedText: ["Codex subscriptions"],
    expectedVisibleControls: ["Add subscription"],
    forbiddenText: ["New pane", "Create a pane to start.", "Message Codex"],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "harness-settings",
    action: "open-settings",
    expectedText: [
      "Harness",
      "Recursive sessions",
      "Allow Codex to delegate work to persistent child sessions.",
      "Context quota",
      "16 MiB",
      "Refinement suggestions",
      "review-only improvement proposals",
      "never applies them automatically",
      "Suggest",
      "Prefer exact context slices",
    ],
    expectedVisibleControls: [
      "Recursive sessions",
      "Context quota",
    ],
    forbiddenText: [
      "providerId",
      "filesystemPath",
      "heapContents",
      "programSource",
      "trialRecord",
      "transcript",
      "arbitraryCommand",
    ],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "harness-children-mixed",
    action: "none",
    expectedBeforeAction: ["Recursive session"],
    expectedText: [
      "Starting child",
      "Running child",
      "Waiting child",
    ],
    expectedVisibleControls: ["More actions for Recursive session"],
    forbiddenText: [
      "providerId",
      "filesystemPath",
      "heapContents",
      "programSource",
      "trialRecord",
      "transcript",
      "arbitraryCommand",
    ],
    viewport: { width: 1_120, height: 780 },
  },
  {
    id: "settings-browser-login",
    action: "open-settings-login",
    expectedText: [
      "Codex subscriptions",
      "Personal",
      "Signing in",
      "Work",
      "builder@work.example",
      "64% weekly remaining",
      "Codex 3",
      "HRA Cloud",
      "Sign in to connect this Mac to HRA Cloud",
    ],
    expectedVisibleControls: [
      "Add subscription",
      "Open sign-in for Personal",
      "Cancel sign-in for Personal",
      "Log out Work",
      "Open sign-in for Codex 3",
      "Cancel sign-in for Codex 3",
      "Pair this Mac with HRA Cloud",
    ],
    forbiddenText: ["Use device code", "Workspace", "Task", "Text size", "Token usage"],
    viewport: { width: 860, height: 780 },
  },
  {
    id: "settings-human-credential-recovery",
    action: "recover-human-account",
    expectedText: [
      "Codex subscriptions",
      "HRA Cloud",
      "Pairing this Mac",
    ],
    expectedVisibleControls: [
      "Add subscription",
      "Cancel HRA Cloud pairing",
    ],
    forbiddenText: [
      "Keychain slot",
      "credential generation",
      "Use device code",
      "Workspace",
      "Token usage",
    ],
    viewport: { width: 860, height: 780 },
  },
  {
    id: "settings-session-sync-disabled",
    action: "open-settings-sync",
    expectedText: ["Devices", "This device", "Enable encrypted sync"],
    expectedVisibleControls: ["Enable encrypted sync"],
    forbiddenText: ["lastSeenAt", "Keychain item", "providerId", "/Users/"],
    viewport: { width: 860, height: 780 },
  },
  {
    id: "settings-session-sync-active",
    action: "exercise-session-sync-recovery-disable",
    expectedText: ["Devices", "This device", "Enable encrypted sync"],
    expectedVisibleControls: ["Enable encrypted sync"],
    forbiddenText: ["lastSeenAt", "Keychain item", "providerId", "/Users/"],
    viewport: { width: 860, height: 780 },
  },
  {
    id: "settings-session-sync-enrolling",
    action: "open-settings-sync",
    expectedText: ["Devices", "New Mac", "Waiting for approval on another device", "123 456"],
    forbiddenText: ["lastSeenAt", "Keychain item", "providerId", "/Users/"],
    viewport: { width: 860, height: 780 },
  },
  {
    id: "settings-session-sync-unavailable",
    action: "open-settings-sync",
    expectedText: ["Devices", "Session sync is temporarily unavailable."],
    expectedVisibleControls: ["Retry session sync"],
    forbiddenText: ["lastSeenAt", "Keychain item", "providerId", "/Users/"],
    viewport: { width: 860, height: 780 },
  },
  ...([{
    id: "session-sync-fault-cloud",
    title: "Cloud fault local",
  }, {
    id: "session-sync-fault-auth",
    title: "Auth fault local",
  }, {
    id: "session-sync-fault-keychain",
    title: "Keychain fault local",
  }, {
    id: "session-sync-fault-network",
    title: "Network fault local",
  }] as const).map(({ id, title }) => ({
    id,
    action: "exercise-local-under-sync-fault" as const,
    expectedBeforeAction: [title],
    expectedText: [title, "HRA", "Direct response", "Completed: Local send remains available."],
    forbiddenText: ["Queue", "Steer", "providerId", "/Users/"],
    viewport: { width: 1_120, height: 780 },
  })),
  {
    id: "remote-session-summaries-512",
    action: "page-remote-summaries",
    browserLane: "forced-touch-reduced",
    expectedBeforeAction: ["Parallel pane 1"],
    expectedText: ["1–48 of 448"],
    forbiddenText: [
      "accountProfileId",
      "providerId",
      "raw",
      "transcript",
      "/Users/",
      "Application Support",
    ],
    viewport: { width: 568, height: 320 },
  },
] as const satisfies readonly ScenarioDefinition[];

export const browserJourneyScenarioIds = Object.freeze(
  scenarios.map(({ id }) => id),
);
export const browserJourneyScenarioRequirements = Object.freeze(
  (scenarios as readonly ScenarioDefinition[]).map(({
    expectedUiScale,
    expectedVisibleControls,
    id,
    viewport,
  }) => Object.freeze({
    expectedUiScale: expectedUiScale ?? "1",
    expectedVisibleControls: Object.freeze([...(expectedVisibleControls ?? [])]),
    id,
    viewport,
  })),
);

export function parseArguments(arguments_: readonly string[]): BrowserVerificationArguments {
  return parseBaseUrlArguments(arguments_, DEFAULT_BASE_URL);
}

export function externalOrFailedRequests(
  requests: readonly NetworkRequest[],
  baseUrl: string,
): readonly NetworkRequest[] {
  const origin = normalizeRootHttpOrigin(baseUrl);
  return requests.filter((request) => {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return true;
    }
    const sameOriginBlob = parsed.protocol === "blob:" && parsed.origin === origin;
    const sameOriginHttp = ["http:", "https:"].includes(parsed.protocol) &&
      parsed.origin === origin;
    const assetPath = sameOriginBlob || (
      sameOriginHttp && (
        parsed.pathname === "/"
        || DIRECT_ROOT_ASSET_PATHS.has(parsed.pathname)
        || parsed.pathname.startsWith("/@fs/")
        || parsed.pathname.startsWith("/@id/")
        || parsed.pathname.startsWith("/@vite/")
        || parsed.pathname === "/@react-refresh"
        || parsed.pathname.startsWith("/node_modules/")
      )
    );
    return (!sameOriginBlob && !sameOriginHttp)
      || request.method !== "GET"
      || request.status === undefined
      || request.status < 200
      || request.status >= 400
      || !assetPath;
  });
}

function expectedRemoteSummaryWindowRows(start: number): RemoteSummaryWindowEvidence["rows"] {
  return Array.from({ length: 48 }, (_, offset) => {
    const index = start + offset;
    const cell = manyChatPaneCount + index + 1;
    const originDeviceName = Math.floor(index / manyChatPaneCount) % 2 === 0
      ? "Travel Mac"
      : "Office Mac";
    const repositoryDisplayName = index % 3 === 0 ? "Example" : "HRA";
    const state = index % 11 === 0
      ? "attention"
      : index % 3 === 0
        ? "working"
        : "ready";
    const stateLabel = state === "attention"
      ? "Needs attention"
      : state === "working"
        ? "Working"
        : "Ready";
    const title = `Parallel pane ${String((index % manyChatPaneCount) + 1)}`;
    const titleIndex = index % manyChatPaneCount;
    const collisionCandidates = [{ device: "Studio Mac", repository: "hra" }];
    for (let group = 0; group < denseRemoteSessionCount / manyChatPaneCount; group += 1) {
      const candidateIndex = titleIndex + group * manyChatPaneCount;
      collisionCandidates.push({
        device: group % 2 === 0 ? "Travel Mac" : "Office Mac",
        repository: candidateIndex % 3 === 0 ? "Example" : "HRA",
      });
    }
    const selectedCollision = collisionCandidates[1 + Math.floor(index / manyChatPaneCount)];
    if (selectedCollision === undefined) {
      throw new Error(`Remote summary ${String(index)} is outside the dense fixture`);
    }
    const deviceRepository = `${selectedCollision.device} · ${selectedCollision.repository}`;
    const uniqueCollisionLines = [
      {
        value: selectedCollision.device,
        count: collisionCandidates.filter(({ device }) =>
          device === selectedCollision.device
        ).length,
      },
      {
        value: selectedCollision.repository,
        count: collisionCandidates.filter(({ repository }) =>
          repository === selectedCollision.repository
        ).length,
      },
      {
        value: deviceRepository,
        count: collisionCandidates.filter(({ device, repository }) =>
          `${device} · ${repository}` === deviceRepository
        ).length,
      },
    ].filter(({ count }) => count === 1)
      .toSorted((left, right) => left.value.length - right.value.length);
    return {
      accessibleName: [
        `Remote session: ${title}`,
        `repository ${repositoryDisplayName}`,
        `owner ${originDeviceName}`,
        `state ${stateLabel}`,
        `cell ${String(cell)}`,
        "encrypted remote summary",
        "view only",
      ].join(", "),
      collisionLine: uniqueCollisionLines[0]?.value ?? `Position ${String(cell)}`,
      state,
      title,
      titleFirst: true,
      triggerName: `Device: ${originDeviceName}, ${stateLabel}`,
    };
  });
}

async function readRemoteSummaryWindow(
  browser: AgentBrowser,
): Promise<RemoteSummaryWindowEvidence> {
  return parseData(
    remoteSummaryWindowEvidenceSchema,
    await browser.evaluate(`(() => {
      const grid = document.querySelector('.pane-grid');
      if (!(grid instanceof HTMLElement)) return null;
      const children = [...grid.children];
      const remotePanes = children.filter((child) => child.matches('.remote-session-pane'));
      return {
        localTitles: children
          .filter((child) => child.matches('.chat-pane'))
          .map((child) => child.querySelector('.pane-title')?.textContent?.trim() ?? ''),
        orderedKinds: children.map((child) => child.matches('.chat-pane') ? 'local' : 'remote'),
        rows: remotePanes.map((pane) => {
          const header = pane.querySelector('.remote-session-pane__header');
          const title = pane.querySelector('.remote-session-pane__header strong');
          const collision = pane.querySelector('.remote-session-pane__collision');
          const trigger = pane.querySelector('.remote-session-pane__device-trigger');
          return {
            accessibleName: pane.getAttribute('aria-label') ?? '',
            collisionLine: collision?.textContent?.trim() ?? '',
            state: pane.getAttribute('data-session-state') ?? '',
            title: title?.textContent?.trim() ?? '',
            titleFirst: header?.firstElementChild === title,
            triggerName: trigger?.getAttribute('aria-label') ?? '',
          };
        }),
      };
    })()`),
    "remote summary window evidence",
  );
}

function assertRemoteSummaryWindow(
  evidence: RemoteSummaryWindowEvidence,
  start: number,
): void {
  const expectedLocalTitles = Array.from(
    { length: manyChatPaneCount },
    (_, index) => `Parallel pane ${String(index + 1)}`,
  );
  const expectedKinds = [
    ...Array.from({ length: manyChatPaneCount }, () => "local" as const),
    ...Array.from({ length: 48 }, () => "remote" as const),
  ];
  const expectedRows = expectedRemoteSummaryWindowRows(start);
  if (JSON.stringify(evidence.localTitles) !== JSON.stringify(expectedLocalTitles)) {
    throw new Error(`Remote summary window changed local cell order: ${JSON.stringify(evidence.localTitles)}`);
  }
  if (JSON.stringify(evidence.orderedKinds) !== JSON.stringify(expectedKinds)) {
    throw new Error(`Remote summary window changed local/remote cell order: ${JSON.stringify(evidence.orderedKinds)}`);
  }
  if (JSON.stringify(evidence.rows) !== JSON.stringify(expectedRows)) {
    throw new Error(
      `Remote summary window ${String(start + 1)}–${String(start + 48)} has incorrect title-first identities or collision lines: ${JSON.stringify(evidence.rows)}`,
    );
  }
}

export function coveragePolicyViolations(
  coverage: readonly CoveragePolicyEntry[],
  knownScenarioIds: ReadonlySet<string>,
  verifiedScenarioIds: ReadonlySet<string>,
): readonly string[] {
  const violations: string[] = [];
  for (const entry of coverage) {
    if (entry.mode === "direct") {
      if (entry.scenarios.length !== 0) {
        violations.push(`${entry.key}: direct evidence must not cite fixture scenarios`);
      }
      continue;
    }
    if (entry.scenarios.length === 0) violations.push(`${entry.key}: ${entry.mode} evidence requires a scenario`);
    for (const scenario of entry.scenarios) {
      if (!knownScenarioIds.has(scenario)) violations.push(`${entry.key}: unknown scenario ${scenario}`);
      else if (!verifiedScenarioIds.has(scenario)) violations.push(`${entry.key}: scenario ${scenario} was not browser-verified`);
    }
  }
  return violations;
}

export function parseHRADirectRemainingWork(
  input: unknown,
): HRADirectRemainingWork {
  return parseData(remainingWorkSchema, input, "HRA Direct remaining work");
}

export function remainingWorkViolations(
  remainingWork: HRADirectRemainingWork,
): readonly string[] {
  const violations: string[] = [];
  if (remainingWork.disposed) violations.push("deterministic transport is disposed");
  for (const counter of [
    "pendingSnapshotTransfers",
    "scriptedEvents",
    "cancelledScriptedEvents",
  ] as const) {
    const value = remainingWork[counter];
    if (value !== 0) violations.push(`${counter} must be zero, received ${String(value)}`);
  }
  return violations;
}

export function canAutomaticallyStartServer(baseUrl: string): boolean {
  return canAutomaticallyStartLocalServer(baseUrl);
}

export function responsiveLayoutFailures(
  measurement: ResponsiveLayoutMeasurement,
  expectedVisibleControls?: string | readonly string[],
  requiredSurfaceLabels: readonly string[] = requiredResponsiveSurfaceLabels,
  minimumControlHeight = 24,
): readonly string[] {
  const failures: string[] = [];
  if (measurement.scrollWidth > measurement.clientWidth + 1) {
    failures.push(`document is ${Math.round(measurement.scrollWidth - measurement.clientWidth)}px wider than its viewport`);
  }
  if (Math.abs(measurement.scrollX) > 0.5) {
    failures.push(`window is horizontally scrolled by ${Math.round(measurement.scrollX)}px`);
  }
  for (const label of measurement.ariaHiddenFocusableControls) {
    failures.push(`${label} is focusable inside an aria-hidden subtree`);
  }
  for (const label of requiredSurfaceLabels) {
    if (!measurement.surfaces.some((surface) => surface.label === label)) {
      failures.push(`${label} is missing from responsive evidence`);
    }
  }
  for (const surface of measurement.surfaces) {
    if (surface.left < -0.5 || surface.right > measurement.clientWidth + 0.5) {
      failures.push(`${surface.label} leaves the horizontal viewport`);
    }
  }
  for (const control of measurement.controls) {
    if (control.left < -0.5 || control.right > measurement.clientWidth + 0.5) {
      failures.push(`${control.label} leaves the horizontal viewport`);
    }
    if (control.height + 0.5 < minimumControlHeight) {
      failures.push(`${control.label} is only ${Math.round(control.height)}px tall`);
    }
  }
  const visibleControls = expectedVisibleControls === undefined
    ? []
    : typeof expectedVisibleControls === "string"
      ? [expectedVisibleControls]
      : expectedVisibleControls;
  for (const expectedVisibleControl of visibleControls) {
    const primary = measurement.controls.find(({ label }) => label.includes(expectedVisibleControl));
    if (primary === undefined) {
      failures.push(`${expectedVisibleControl} is missing from the rendered controls`);
    } else if (primary.top < -0.5 || primary.bottom > measurement.clientHeight + 0.5) {
      failures.push(`${expectedVisibleControl} is outside the initial vertical viewport`);
    }
  }
  return failures;
}

export function parallelPerformanceFailures(
  measurement: ParallelPerformanceMeasurement,
  expected: Readonly<{
    firstRenderBudgetMs: number;
    minimumStreamMutationBatches: number;
    scriptedDeltaCount: number;
    settlementBudgetMs: number;
    streamPaneCount: number;
  }> = {
    firstRenderBudgetMs: parallelFirstRenderBudgetMs,
    minimumStreamMutationBatches: parallelStreamRounds,
    scriptedDeltaCount: parallelScriptedDeltaCount,
    settlementBudgetMs: parallelSettlementBudgetMs,
    streamPaneCount: parallelStreamPaneCount,
  },
): readonly string[] {
  const failures: string[] = [];
  if (measurement.scriptedDeltaCount !== expected.scriptedDeltaCount) {
    failures.push(
      `expected ${String(expected.scriptedDeltaCount)} scripted deltas, received ${String(measurement.scriptedDeltaCount)}`,
    );
  }
  if (measurement.streamPaneCount !== expected.streamPaneCount) {
    failures.push(
      `expected ${String(expected.streamPaneCount)} streaming panes, received ${String(measurement.streamPaneCount)}`,
    );
  }
  if (measurement.updatedStreamPaneCount !== measurement.streamPaneCount) {
    failures.push(
      `${String(measurement.updatedStreamPaneCount)} of ${String(measurement.streamPaneCount)} streaming panes rendered their scripted deltas`,
    );
  }
  if (
    measurement.exactResponsePaneCount !== measurement.streamPaneCount ||
    measurement.mismatchedResponsePaneIds.length > 0
  ) {
    failures.push(
      `${String(measurement.exactResponsePaneCount)} of ${String(measurement.streamPaneCount)} streaming panes rendered their exact full response; mismatches: ${measurement.mismatchedResponsePaneIds.join(", ") || "unknown"}`,
    );
  }
  if (measurement.streamMutationCount < measurement.scriptedDeltaCount) {
    failures.push(
      `streaming pane subtrees recorded ${String(measurement.streamMutationCount)} mutations for ${String(measurement.scriptedDeltaCount)} deltas`,
    );
  }
  if (measurement.streamMutationBatchCount < expected.minimumStreamMutationBatches) {
    failures.push(
      `streaming panes settled in only ${String(measurement.streamMutationBatchCount)} mutation batches; expected at least ${String(expected.minimumStreamMutationBatches)}`,
    );
  }
  if (measurement.firstStreamMutationMs === null) {
    failures.push("streaming panes never rendered a first mutation");
  } else if (measurement.firstStreamMutationMs > expected.firstRenderBudgetMs) {
    failures.push(
      `first streaming render took ${Math.round(measurement.firstStreamMutationMs)}ms; budget is ${String(expected.firstRenderBudgetMs)}ms`,
    );
  }
  if (measurement.settlementMs > expected.settlementBudgetMs) {
    failures.push(
      `parallel streaming settled in ${Math.round(measurement.settlementMs)}ms; budget is ${String(expected.settlementBudgetMs)}ms`,
    );
  }
  if (measurement.remotePaneCount !== remoteSessionMountLimit) {
    failures.push(
      `expected ${String(remoteSessionMountLimit)} mounted remote panes, received ${String(measurement.remotePaneCount)}`,
    );
  }
  if (!measurement.remotePanesConnected || !measurement.remoteIdentitiesPreserved) {
    failures.push("the mounted remote panes did not preserve their connected DOM identities");
  }
  if (!measurement.remoteTextPreserved || measurement.remoteMutationCount !== 0) {
    failures.push(
      `the mounted remote panes changed during parallel streaming (${String(measurement.remoteMutationCount)} mutations)`,
    );
  }
  return failures;
}

export function parallelComposerFailures(
  measurement: ParallelComposerMeasurement,
  expectedComposerCount = parallelStreamPaneCount,
): readonly string[] {
  const failures: string[] = [];
  if (measurement.composerCount !== expectedComposerCount) {
    failures.push(
      `expected ${String(expectedComposerCount)} active composers, received ${String(measurement.composerCount)}`,
    );
  }
  if (measurement.disabledComposerCount !== 0) {
    failures.push(
      `${String(measurement.disabledComposerCount)} of ${String(expectedComposerCount)} parallel active composers are disabled`,
    );
  }
  if (measurement.disabledSendButtonCount !== expectedComposerCount) {
    failures.push(
      `expected ${String(expectedComposerCount)} disabled empty send controls, received ${String(measurement.disabledSendButtonCount)}`,
    );
  }
  return failures;
}

function scenarioUrl(baseUrl: string, id: string): string {
  const url = new URL("/", `${normalizeRootHttpOrigin(baseUrl)}/`);
  url.searchParams.set("__direct_scenario", id);
  url.searchParams.set("directFrame", "1");
  return url.href;
}

function parseData<Value>(schema: z.ZodType<Value>, input: unknown, label: string): Value {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(`${label} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

async function readProbe(browser: AgentBrowser): Promise<ProbeSnapshot> {
  const parsed = parseDirectProbeSnapshot(
    await browser.evaluate("window.__direct.snapshot()"),
  );
  if (!parsed.ok) throw new Error(`canonical probe is invalid: ${parsed.error.message}`);
  return Object.freeze({
    ...parsed.value,
    remainingWork: parseHRADirectRemainingWork(parsed.value.remainingWork),
  });
}

async function clickButton(browser: AgentBrowser, label: string): Promise<void> {
  await browser.run(["find", "role", "button", "click", "--name", label]);
}

async function clickMenuItem(browser: AgentBrowser, label: string): Promise<void> {
  await browser.run(["find", "role", "menuitem", "click", "--name", label]);
}

async function waitForVisibleText(browser: AgentBrowser, expected: string): Promise<void> {
  await browser.run([
    "wait",
    "--fn",
    `document.body.innerText.includes(${JSON.stringify(expected)})`,
  ]);
}

async function waitForStableProbe(browser: AgentBrowser): Promise<void> {
  await browser.run(["wait", "--fn", STABLE_PROBE_EXPRESSION]);
}

async function setUiScale(
  browser: AgentBrowser,
  steps: number,
  expectedScale: string,
): Promise<void> {
  const dispatched = await browser.evaluate(`(() => {
    const key = (key, code) => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code,
      key,
      metaKey: true,
    }));
    key("0", "Digit0");
    const steps = ${String(steps)};
    const keyValue = steps < 0 ? "-" : "+";
    const code = steps < 0 ? "Minus" : "Equal";
    for (let index = 0; index < Math.abs(steps); index += 1) key(keyValue, code);
    return true;
  })()`);
  if (dispatched !== true) throw new Error("Could not dispatch the text-scale shortcuts.");
  await browser.run([
    "wait",
    "--fn",
    `document.documentElement.style.getPropertyValue('--ui-scale') === ${JSON.stringify(expectedScale)}`,
  ]);
  await browser.run([
    "wait",
    "--fn",
    `(() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(legacyOprteUiScaleStorageKey)}) || 'null')?.scale === ${expectedScale}; } catch { return false; } })()`,
  ]);
  await browser.run([
    "wait",
    "--fn",
    `Math.abs(Number.parseFloat(getComputedStyle(document.documentElement).fontSize) - 16 * Number(${JSON.stringify(expectedScale)})) <= 0.1`,
  ]);
}

async function beginParallelStreamObservation(browser: AgentBrowser): Promise<void> {
  await browser.run([
    "wait",
    "--fn",
    `(() => {
      const panes = [...document.querySelectorAll('.chat-pane')];
      const streams = panes.filter((pane) => pane.getAttribute('data-pane-state') === 'streaming');
      const remotePanes = [...document.querySelectorAll('.remote-session-pane')];
      const control = remotePanes
        .find((pane) => pane.querySelector('strong')?.textContent?.trim() === 'Control pane');
      return panes.length === ${String(parallelStreamPaneCount)}
        && streams.length === ${String(parallelStreamPaneCount)}
        && remotePanes.length === ${String(remoteSessionMountLimit)}
        && control instanceof HTMLElement
        && streams.every((pane) => pane.querySelector('.pane-response') === null);
    })()`,
  ]);
  const started = await browser.evaluate(`(() => {
    const panes = [...document.querySelectorAll('.chat-pane')];
    const streams = panes.filter((pane) => pane.getAttribute('data-pane-state') === 'streaming');
    const remotePanes = [...document.querySelectorAll('.remote-session-pane')];
    if (remotePanes.length !== ${String(remoteSessionMountLimit)}
      || streams.length !== ${String(parallelStreamPaneCount)}
      || streams.some((pane) => pane.querySelector('.pane-response') !== null)) return false;
    const observation = {
      remoteMutationCount: 0,
      remotePanes,
      remoteTexts: remotePanes.map((pane) => pane.textContent),
      startedAt: performance.now(),
      firstStreamMutationAt: null,
      streamMutationCount: 0,
      streamMutationBatchCount: 0,
      streams,
    };
    const remoteObserver = new MutationObserver((records) => {
      observation.remoteMutationCount += records.length;
    });
    const streamObserver = new MutationObserver((records) => {
      if (records.length === 0) return;
      observation.firstStreamMutationAt ??= performance.now();
      observation.streamMutationCount += records.length;
      observation.streamMutationBatchCount += 1;
    });
    for (const remotePane of remotePanes) {
      remoteObserver.observe(remotePane, { attributes: true, characterData: true, childList: true, subtree: true });
    }
    for (const stream of streams) {
      streamObserver.observe(stream, { attributes: true, characterData: true, childList: true, subtree: true });
    }
    window.__hraParallelStreamObservation = { observation, remoteObserver, streamObserver };
    return true;
  })()`);
  if (started !== true) {
    throw new Error("Parallel stream deltas began before sibling-isolation observation was installed.");
  }
}

async function finishParallelStreamObservation(
  browser: AgentBrowser,
  scriptedDeltaCount: number,
): Promise<ParallelPerformanceMeasurement> {
  return parseData(
    parallelPerformanceMeasurementSchema,
    await browser.evaluate(`(() => {
      const tracked = window.__hraParallelStreamObservation;
      if (tracked === undefined) throw new Error('Parallel stream observation is missing.');
      const { observation, remoteObserver, streamObserver } = tracked;
      observation.remoteMutationCount += remoteObserver.takeRecords().length;
      const finalStreamRecords = streamObserver.takeRecords();
      if (finalStreamRecords.length > 0) {
        observation.firstStreamMutationAt ??= performance.now();
        observation.streamMutationCount += finalStreamRecords.length;
        observation.streamMutationBatchCount += 1;
      }
      remoteObserver.disconnect();
      streamObserver.disconnect();
      const currentRemotePanes = [...document.querySelectorAll('.remote-session-pane')];
      const updatedStreamPaneCount = observation.streams.filter((pane) =>
        pane.textContent?.includes(${JSON.stringify(parallelStreamFinalMarker)})
      ).length;
      const expectedResponses = ${JSON.stringify(parallelStreamExpectedResponses)};
      const mismatchedResponsePaneIds = [];
      let exactResponsePaneCount = 0;
      for (const [index, pane] of observation.streams.entries()) {
        const expectedPaneId = 'pane_live_lane_' + String(index + 1);
        const paneId = pane.getAttribute('data-pane-id');
        const response = pane.querySelector('.pane-response')?.textContent ?? '';
        if (paneId === expectedPaneId && response === expectedResponses[index]) {
          exactResponsePaneCount += 1;
        } else {
          mismatchedResponsePaneIds.push(paneId ?? '<missing:' + String(index) + '>');
        }
      }
      const result = {
        exactResponsePaneCount,
        firstStreamMutationMs: observation.firstStreamMutationAt === null
          ? null
          : observation.firstStreamMutationAt - observation.startedAt,
        mismatchedResponsePaneIds,
        remoteIdentitiesPreserved: currentRemotePanes.length === observation.remotePanes.length
          && currentRemotePanes.every((pane, index) => pane === observation.remotePanes[index]),
        remoteMutationCount: observation.remoteMutationCount,
        remotePaneCount: observation.remotePanes.length,
        remotePanesConnected: observation.remotePanes.every((pane) => pane.isConnected),
        remoteTextPreserved: observation.remotePanes.every(
          (pane, index) => pane.textContent === observation.remoteTexts[index],
        ),
        scriptedDeltaCount: ${String(scriptedDeltaCount)},
        settlementMs: performance.now() - observation.startedAt,
        streamMutationCount: observation.streamMutationCount,
        streamMutationBatchCount: observation.streamMutationBatchCount,
        streamPaneCount: observation.streams.length,
        updatedStreamPaneCount,
      };
      delete window.__hraParallelStreamObservation;
      return result;
    })()`),
    "parallel streaming performance measurement",
  );
}

async function runAction(
  browser: AgentBrowser,
  action: ScenarioAction,
): Promise<void> {
  switch (action) {
    case "none":
      return;
    case "open-attention": {
      await clickButton(browser, "Attention, 3 items");
      await waitForVisibleText(browser, "Local recovery, decisions, and reviews");
      const drawerText = await browser.evaluate(
        "document.querySelector('.attention-drawer')?.textContent ?? ''",
      );
      if (typeof drawerText !== "string" || drawerText.includes("Private queued text")) {
        throw new Error("The attention drawer exposed private queue content.");
      }
      return;
    }
    case "prepare-draft": {
      await clickButton(browser, "Choose project for HRA");
      await browser.run(["wait", "--fn", "document.querySelector('.chat-pane__repository')?.textContent?.trim() === 'hra'"]);
      await waitForStableProbe(browser);
      await clickButton(browser, "More actions for HRA");
      await clickMenuItem(browser, "Rename pane");
      await browser.run(["wait", "--fn", "document.querySelector('.pane-title-input') !== null"]);
      await browser.run(["fill", ".pane-title-input", "Direct pane"]);
      await clickButton(browser, "Save pane title");
      await waitForVisibleText(browser, "Direct pane");
      await browser.run(["wait", "--fn", "document.querySelector('.pane-title-input') === null"]);
      await waitForStableProbe(browser);
      await setUiScale(browser, -2, "0.8");
      return;
    }
    case "exercise-malleable-chat":
      await clickButton(browser, "Send queued message now");
      await browser.run([
        "wait",
        "--fn",
        "!document.body.innerText.includes('Steer the active turn with the accessibility findings.')",
      ]);
      await clickButton(browser, "Edit queued message");
      await browser.run(["fill", ".pane-queue-row__editor", "Then tighten the compact layout."]);
      await clickButton(browser, "Save queued message");
      await waitForVisibleText(browser, "Then tighten the compact layout.");
      await waitForStableProbe(browser);
      await setUiScale(browser, 6, "1.5");
      await browser.evaluate(
        "document.documentElement.style.setProperty('--ui-scale', '2'); true",
      );
      await browser.run([
        "wait",
        "--fn",
        `document.documentElement.style.getPropertyValue('--ui-scale') === '2'
          && Math.abs(Number.parseFloat(getComputedStyle(document.documentElement).fontSize) - 32) <= 0.1`,
      ]);
      return;
    case "exercise-scheduled-chat": {
      await clickButton(browser, "Shared folder access: Documents. Choose folder");
      await waitForStableProbe(browser);
      await clickButton(browser, "Turn off scheduling");
      await browser.run([
        "wait",
        "--fn",
        "document.querySelector('.chat-pane[data-pane-scheduled=true]') === null",
      ]);
      await clickButton(browser, "Schedule this chat");
      await browser.run(["fill", "textarea", "Every day at 9, summarize open pull requests"]);
      await browser.run(["press", "Enter"]);
      await browser.run([
        "wait",
        "--fn",
        "document.querySelector('.chat-pane[data-pane-scheduled=true]') !== null && document.querySelector('textarea')?.value === ''",
      ]);
      await browser.run(["fill", "textarea", "invalid schedule"]);
      await browser.run(["press", "Enter"]);
      await waitForVisibleText(browser, "Direct could not interpret that schedule.");
      await waitForStableProbe(browser);
      return;
    }
    case "send-follow-up":
      await browser.run(["fill", "textarea", "Follow up after release"]);
      await browser.run(["press", "Enter"]);
      await waitForVisibleText(browser, "Completed: Follow up after release");
      await waitForStableProbe(browser);
      return;
    case "recover-attention":
      for (const { paneId, prompt, title } of attentionPresentations) {
        const selector = `#prompt-${paneId}`;
        await browser.run(["fill", selector, prompt]);
        const submitted = await browser.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(selector)});
          const button = input?.closest('form')?.querySelector('.pane-send');
          if (!(button instanceof HTMLButtonElement)) return false;
          button.click();
          return true;
        })()`);
        if (submitted !== true) throw new Error(`Could not submit ${title}.`);
        await waitForVisibleText(browser, `Completed: ${prompt}`);
        await waitForStableProbe(browser);
      }
      return;
    case "scale-compact-120":
      await setUiScale(browser, 2, "1.2");
      await waitForStableProbe(browser);
      await browser.run(["fill", "textarea", "Compact controls remain usable."]);
      return;
    case "scale-compact-150":
      await setUiScale(browser, 4, "1.5");
      await waitForStableProbe(browser);
      await browser.run(["fill", "textarea", "Compact controls remain usable."]);
      return;
    case "create-pane":
      {
        const before = await browser.evaluate("document.querySelectorAll('.chat-pane').length");
        if (typeof before !== "number") throw new Error("Could not read the pane count.");
      await clickButton(browser, "New pane");
        await browser.run([
          "wait",
          "--fn",
          `document.querySelectorAll('.chat-pane').length === ${String(before + 1)}`,
        ]);
      await waitForStableProbe(browser);
      return;
      }
    case "reorder-panes": {
      await clickButton(browser, "More actions for First pane");
      await clickMenuItem(browser, "Move later");
      await browser.run([
        "wait",
        "--fn",
        "[...document.querySelectorAll('.chat-pane')].map(pane => pane.getAttribute('data-pane-id')).join(',') === 'pane_order000002,pane_order000001,pane_order000003'",
      ]);
      const dragged = await browser.evaluate(`(() => {
        const source = document.querySelector('.chat-pane[data-pane-id="pane_order000003"] .chat-pane__header');
        const target = document.querySelector('.chat-pane[data-pane-id="pane_order000002"]');
        if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) return false;
        const transfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
        return true;
      })()`);
      if (dragged !== true) throw new Error("Could not drag the third pane to the first local slot.");
      await browser.run([
        "wait",
        "--fn",
        "[...document.querySelectorAll('.chat-pane')].map(pane => pane.getAttribute('data-pane-id')).join(',') === 'pane_order000003,pane_order000002,pane_order000001'",
      ]);
      await waitForStableProbe(browser);
      return;
    }
    case "exercise-compact-controls":
      await browser.run(["fill", "textarea", "Compact controls remain usable."]);
      return;
    case "exercise-local-under-sync-fault": {
      const originalPaneId = await browser.evaluate(
        "document.querySelector('.chat-pane')?.getAttribute('data-pane-id') ?? null",
      );
      if (typeof originalPaneId !== "string" || originalPaneId.length === 0) {
        throw new Error("The sync-fault journey has no original local pane.");
      }
      await clickButton(browser, "New pane");
      await browser.run(["wait", "--fn", "document.querySelectorAll('.chat-pane').length === 2"]);
      const sent = await browser.evaluate(`(() => {
        const pane = document.querySelector(
          '.chat-pane[data-pane-id=' + JSON.stringify(${JSON.stringify(originalPaneId)}) + ']'
        );
        const input = pane?.querySelector('textarea');
        const button = pane?.querySelector('.pane-send');
        if (!(input instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) {
          return false;
        }
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        setter?.call(input, 'Local send remains available.');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        button.click();
        return true;
      })()`);
      if (sent !== true) throw new Error("Could not send through the original local pane.");
      await waitForVisibleText(browser, "Completed: Local send remains available.");
      await waitForStableProbe(browser);
      return;
    }
    case "open-settings": {
      const opened = await browser.evaluate(`(() => {
        const settings = document.querySelector('[href="#settings"]');
        if (!(settings instanceof HTMLElement)) return false;
        settings.click();
        return true;
      })()`);
      if (opened !== true) throw new Error("Could not open Harness settings.");
      await waitForVisibleText(browser, "Prefer exact context slices");
      await waitForStableProbe(browser);
      return;
    }
    case "open-settings-login": {
      const opened = await browser.evaluate(`(() => {
        const settings = document.querySelector('[href="#settings"]');
        if (!(settings instanceof HTMLElement)) return false;
        settings.click();
        return true;
      })()`);
      if (opened !== true) throw new Error("Could not open Settings.");
      await waitForVisibleText(browser, "Codex subscriptions");
      await clickButton(browser, "Add subscription");
      await waitForVisibleText(browser, "Codex 3");
      await waitForStableProbe(browser);
      await clickButton(browser, "Open sign-in for Codex 3");
      await waitForStableProbe(browser);
      return;
    }
    case "recover-human-account": {
      const opened = await browser.evaluate(`(() => {
        const settings = document.querySelector('[href="#settings"]');
        if (!(settings instanceof HTMLElement)) return false;
        settings.click();
        return true;
      })()`);
      if (opened !== true) throw new Error("Could not open credential recovery Settings.");
      await waitForVisibleText(
        browser,
        "Human credential recovery is required before signing in.",
      );
      await clickButton(browser, "Retry HRA Cloud credential check");
      await waitForVisibleText(browser, "Reconnect after update");
      await waitForStableProbe(browser);
      await clickButton(browser, "Review HRA Cloud reconnect");
      await waitForVisibleText(
        browser,
        "The previous credential stays protected in Keychain but cannot be reused by the new pairing flow.",
      );
      const consentFocused = await browser.evaluate(`(() => {
        const confirmation = document.querySelector(
          '[role="group"][aria-label="Confirm HRA Cloud reconnect"]',
        );
        const active = document.activeElement;
        return confirmation instanceof HTMLElement &&
          active instanceof HTMLElement &&
          active.getAttribute('aria-label') === 'Confirm HRA Cloud reconnect';
      })()`);
      if (consentFocused !== true) {
        throw new Error("Credential reconnect consent did not focus its exact confirmation action.");
      }
      await clickButton(browser, "Cancel HRA Cloud reconnect");
      await browser.run([
        "wait",
        "--fn",
        "document.querySelector('[role=group][aria-label=\"Confirm HRA Cloud reconnect\"]') === null",
      ]);
      await clickButton(browser, "Review HRA Cloud reconnect");
      await clickButton(browser, "Confirm HRA Cloud reconnect");
      await waitForVisibleText(browser, "Not connected");
      await browser.run([
        "wait",
        "--fn",
        "document.querySelector('[role=group][aria-label=\"Confirm HRA Cloud reconnect\"]') === null",
      ]);
      await waitForStableProbe(browser);
      await clickButton(browser, "Pair this Mac with HRA Cloud");
      await waitForVisibleText(browser, "Pairing this Mac");
      await waitForStableProbe(browser);
      return;
    }
    case "open-settings-sync": {
      const opened = await browser.evaluate(`(() => {
        const settings = document.querySelector('[href="#settings"]');
        if (!(settings instanceof HTMLElement)) return false;
        settings.click();
        return true;
      })()`);
      if (opened !== true) throw new Error("Could not open session-sync settings.");
      await waitForVisibleText(browser, "Devices");
      await waitForStableProbe(browser);
      return;
    }
    case "exercise-session-sync-recovery-disable": {
      const opened = await browser.evaluate(`(() => {
        const settings = document.querySelector('[href="#settings"]');
        if (!(settings instanceof HTMLElement)) return false;
        settings.click();
        return true;
      })()`);
      if (opened !== true) throw new Error("Could not open active session-sync settings.");
      for (const expected of [
        "Studio Mac",
        "Travel Mac",
        "Office Mac",
        "Waiting for approval",
        "New Mac",
        "123 456",
        "Recovery kit",
        "Device approval and revocation are unavailable in this build.",
        "Approval is unavailable in this build.",
        "Recovery import and rotation are unavailable in this build.",
      ]) await waitForVisibleText(browser, expected);
      await waitForStableProbe(browser);
      await clickButton(browser, "Reveal recovery kit");
      await browser.run([
        "wait",
        "--fn",
        "document.querySelector('pre[aria-label=\"Recovery kit\"]')?.textContent === 'DIRECT-RECOVERY-KIT-' + 'R'.repeat(64)",
      ]);
      const revealed = await browser.evaluate(`(() => {
        const kit = document.querySelector('pre[aria-label="Recovery kit"]');
        const hide = document.querySelector('button[aria-label="Hide recovery kit"]');
        return kit instanceof HTMLElement
          && kit.textContent === 'DIRECT-RECOVERY-KIT-' + 'R'.repeat(64)
          && hide instanceof HTMLButtonElement
          && hide.disabled === false;
      })()`);
      if (revealed !== true) throw new Error("Active sync did not reveal its bounded recovery kit.");
      await clickButton(browser, "Turn off session sync");
      await waitForVisibleText(browser, "Enable encrypted sync");
      await browser.run([
        "wait",
        "--fn",
        "document.querySelector('pre[aria-label=\"Recovery kit\"]') === null",
      ]);
      await waitForStableProbe(browser);
      return;
    }
    case "page-remote-summaries": {
      const initial = await browser.evaluate(`(() => ({
        forcedColors: matchMedia('(forced-colors: active)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        local: document.querySelectorAll('.chat-pane').length,
        remote: document.querySelectorAll('.remote-session-pane').length,
        mounted: Number(document.querySelector('.pane-grid')?.getAttribute('data-remote-mounted')),
        viewport: window.innerWidth + 'x' + window.innerHeight,
      }))()`);
      const expectedEnvironment = {
        forcedColors: true,
        local: 64,
        mounted: 48,
        reducedMotion: true,
        remote: 48,
        viewport: "568x320",
      };
      if (JSON.stringify(initial) !== JSON.stringify(expectedEnvironment)) {
        throw new Error(`Remote density environment is incomplete: ${JSON.stringify(initial)}`);
      }
      const firstWindow = await readRemoteSummaryWindow(browser);
      assertRemoteSummaryWindow(firstWindow, 0);
      const touchDispatch = await browser.evaluate(`(async () => {
        const trigger = document.querySelector('.remote-session-pane__device-trigger');
        const tip = document.querySelector('.remote-session-pane__device-tooltip');
        if (!(trigger instanceof HTMLButtonElement) || !(tip instanceof HTMLElement)) return null;
        trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = trigger.getBoundingClientRect();
        const dispatched = trigger.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          isPrimary: true,
          pointerId: 17,
          pointerType: 'touch',
        }));
        return {
          accessibleName: trigger.getAttribute('aria-label'),
          controlsTooltip: trigger.getAttribute('aria-controls') === tip.id,
          dispatchCancelled: dispatched === false,
          height: box.height,
          semanticButton: trigger.type === 'button',
          touchAction: getComputedStyle(trigger).touchAction,
          width: box.width,
        };
      })()`);
      if (JSON.stringify(touchDispatch) !== JSON.stringify({
        accessibleName: "Device: Travel Mac, Needs attention",
        controlsTooltip: true,
        dispatchCancelled: true,
        height: 44,
        semanticButton: true,
        touchAction: "manipulation",
        width: 44,
      })) throw new Error(`Remote touch target evidence is incomplete: ${JSON.stringify(touchDispatch)}`);
      await browser.run([
        "wait",
        "--fn",
        "document.querySelector('.remote-session-pane__device-trigger')?.getAttribute('aria-expanded') === 'true' && getComputedStyle(document.querySelector('.remote-session-pane__device-tooltip')).opacity === '1'",
      ]);
      const tooltip = await browser.evaluate(`(() => {
        const trigger = document.querySelector('.remote-session-pane__device-trigger');
        const tip = document.querySelector('.remote-session-pane__device-tooltip');
        if (!(trigger instanceof HTMLElement) || !(tip instanceof HTMLElement)) return null;
        return {
          describedBy: trigger.getAttribute('aria-describedby') === tip.id,
          expanded: trigger.getAttribute('aria-expanded'),
          focused: document.activeElement === trigger,
          opacity: getComputedStyle(tip).opacity,
          text: tip.textContent?.trim() ?? '',
          touchAction: getComputedStyle(trigger).touchAction,
        };
      })()`);
      if (JSON.stringify(tooltip) !== JSON.stringify({
        describedBy: true,
        expanded: "true",
        focused: true,
        opacity: "1",
        text: "Travel Mac · Needs attention",
        touchAction: "manipulation",
      })) throw new Error(`Remote tooltip/touch evidence is incomplete: ${JSON.stringify(tooltip)}`);
      const escaped = await browser.evaluate(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Escape',
        }));
        return true;
      })()`);
      if (escaped !== true) throw new Error("Remote touch tooltip could not receive Escape.");
      await browser.run([
        "wait",
        "--fn",
        "document.querySelector('.remote-session-pane__device-trigger')?.getAttribute('aria-expanded') === 'false'",
      ]);
      await clickButton(browser, "Next remote summaries");
      await waitForVisibleText(browser, "49–96 of 448");
      await browser.run([
        "wait",
        "--fn",
        "document.activeElement?.getAttribute('aria-label') === 'Next remote summaries'",
      ]);
      const secondWindow = await readRemoteSummaryWindow(browser);
      assertRemoteSummaryWindow(secondWindow, 48);
      await clickButton(browser, "Previous remote summaries");
      await waitForVisibleText(browser, "1–48 of 448");
      const restoredFirstWindow = await readRemoteSummaryWindow(browser);
      assertRemoteSummaryWindow(restoredFirstWindow, 0);
      if (JSON.stringify(restoredFirstWindow) !== JSON.stringify(firstWindow)) {
        throw new Error("Remote summary identities or stable cell order changed after paging.");
      }
      await waitForStableProbe(browser);
      return;
    }
  }
}

async function verifyResponsiveLayout(
  browser: AgentBrowser,
  scenarioId: string,
  expectedVisibleControls?: readonly string[],
): Promise<ResponsiveLayoutMeasurement> {
  const measurement = parseData(
    responsiveLayoutMeasurementSchema,
    await browser.evaluate(`(() => {
      const root = document.documentElement;
      const compactChatSurface = document.querySelector('.direct-compact-chat') !== null;
      const surface = (label, selector, required = true) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          if (required) throw new Error(label + " is missing");
          return null;
        }
        const rectangle = element.getBoundingClientRect();
        return {
          clientWidth: element.clientWidth,
          label,
          left: rectangle.left,
          right: rectangle.right,
          scrollWidth: element.scrollWidth,
        };
      };
      const isVisuallyHidden = (element) => {
        for (
          let candidate = element;
          candidate instanceof HTMLElement;
          candidate = candidate.parentElement
        ) {
          if (candidate.getAttribute("aria-hidden") === "true") return true;
          if (candidate.hasAttribute("inert")) return true;
          if (candidate.classList.contains("hra-visually-hidden")) return true;
          if (candidate.matches(".hra-skip-link:not(:focus)")) return true;
          const style = getComputedStyle(candidate);
          const rectangle = candidate.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden") return true;
          // React Aria intentionally places dismissal and native form controls
          // inside its one-pixel screen-reader wrapper. They retain a client
          // rect but are not consumer-visible pointer targets.
          if (
            style.position === "absolute" &&
            style.overflow === "hidden" &&
            rectangle.width <= 1.5 &&
            rectangle.height <= 1.5
          ) return true;
        }
        return false;
      };
      const semanticTarget = (element) => {
        if (
          element instanceof HTMLInputElement &&
          ["checkbox", "radio", "file"].includes(element.type)
        ) {
          const label = [...(element.labels ?? [])].find(
            (candidate) =>
              candidate instanceof HTMLElement &&
              candidate.getClientRects().length > 0 &&
              !isVisuallyHidden(candidate),
          );
          if (label instanceof HTMLElement) return label;
        }
        const interactiveAncestor = element.parentElement?.closest(
          "button, a[href], summary, select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=option], [role=tab]",
        );
        return interactiveAncestor instanceof HTMLElement
          ? interactiveAncestor
          : element;
      };
      const accessibleControlLabel = (element) => {
        const explicitLabel = element.getAttribute("aria-label");
        if (explicitLabel?.trim()) return explicitLabel.trim();
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement
        ) {
          const associatedLabel = [...(element.labels ?? [])]
            .map((label) => label.textContent?.trim() ?? "")
            .find(Boolean);
          if (associatedLabel) return associatedLabel;
        }
        return (element.textContent || element.tagName).trim();
      };
      const selectors = [
        "button",
        "a[href]",
        "summary",
        "select",
        "textarea",
        "input:not([type=hidden])",
        "[role=button]",
        "[role=link]",
        "[role=checkbox]",
        "[role=radio]",
        "[role=switch]",
        "[role=menuitem]",
        "[role=option]",
        "[role=tab]",
      ].join(",");
      const targets = new Set(
        [...document.querySelectorAll(selectors)]
          .map(semanticTarget)
          .filter((element) =>
            element instanceof HTMLElement &&
            element.getClientRects().length > 0 &&
            !isVisuallyHidden(element)
          ),
      );
      const controls = [...targets]
        .map((element) => {
          const rectangle = element.getBoundingClientRect();
          return {
            bottom: rectangle.bottom,
            height: rectangle.height,
            label: accessibleControlLabel(element).slice(0, 80),
            left: rectangle.left,
            right: rectangle.right,
            top: rectangle.top,
          };
        });
      const ariaHiddenFocusableControls = [
        ...document.querySelectorAll(
          '[aria-hidden="true"], [aria-hidden="true"] *',
        ),
      ].filter((element) => {
        if (!(element instanceof HTMLElement) || element.tabIndex < 0) {
          return false;
        }
        const rectangle = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          element.getClientRects().length > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !element.closest("[inert]") &&
          (rectangle.width > 1.5 || rectangle.height > 1.5)
        );
      }).map((element) =>
        (element.getAttribute("aria-label") || element.textContent || element.tagName)
          .trim()
          .slice(0, 80)
      );
      return {
        ariaHiddenFocusableControls,
        clientHeight: root.clientHeight,
        clientWidth: root.clientWidth,
        controls,
        scrollX: window.scrollX,
        scrollWidth: root.scrollWidth,
        surfaces: [
          surface("outer Direct frame", ".direct-frame-only"),
          surface("app frame", ".hra-app", !compactChatSurface),
          surface("app header", ".hra-header", !compactChatSurface),
          surface("main content", "#main-content", !compactChatSurface),
          surface("compact chat surface", ".direct-compact-chat", compactChatSurface),
          surface("pane grid", ".pane-grid", false),
          surface("settings", ".settings-page", false),
        ].filter(Boolean),
      };
    })()`),
    "responsive layout measurement",
  );
  const failures = responsiveLayoutFailures(
    measurement,
    expectedVisibleControls,
    scenarioId === "chat-compact-malleable"
      ? ["outer Direct frame", "compact chat surface"]
      : requiredResponsiveSurfaceLabels,
    scenarioId === "chat-compact-malleable" ? 44 : 24,
  );
  if (failures.length > 0) {
    throw new Error(
      `${scenarioId} failed responsive layout checks: ${failures.join("; ")}; controls: ${JSON.stringify(measurement.controls)}; surfaces: ${JSON.stringify(measurement.surfaces)}`,
    );
  }
  return measurement;
}

const scenarioUiStateSchema = z.object({
  attachmentActionCount: z.number().int().nonnegative(),
  attachmentBlobPreviewCount: z.number().int().nonnegative(),
  attachmentPreviewCount: z.number().int().nonnegative(),
  autoContainedPanes: z.number().int().nonnegative(),
  containedPanes: z.number().int().nonnegative(),
  composerPlaceholders: z.array(z.string()),
  composerSendContained: z.number().int().nonnegative(),
  composerValues: z.array(z.string()),
  disabledComposers: z.number().int().nonnegative(),
  disabledSendButtons: z.number().int().nonnegative(),
  draggableHeaders: z.number().int().nonnegative(),
  durationInsideLiveRegionCount: z.number().int().nonnegative(),
  durationLabels: z.array(z.string()),
  durationTexts: z.array(z.string()),
  gridColumnCount: z.number().int().nonnegative(),
  harnessProposalInteractiveControls: z.number().int().nonnegative(),
  harnessProposalTitles: z.array(z.string()),
  harnessQuotaValues: z.array(z.string()),
  harnessRefinementControls: z.array(z.object({
    label: z.string(),
    selected: z.boolean(),
  }).strict()),
  harnessSettingsControls: z.array(z.object({
    label: z.string(),
    pressed: z.string().nullable(),
    tag: z.string(),
    value: z.string().nullable(),
  }).strict()),
  harnessSettingsCount: z.number().int().nonnegative(),
  harnessSelectedSwitches: z.number().int().nonnegative(),
  hash: z.string(),
  humanReconnectConfirmationCount: z.number().int().nonnegative(),
  identityAccentCount: z.number().int().nonnegative(),
  labelledPaneCount: z.number().int().nonnegative(),
  labelledTranscriptCount: z.number().int().nonnegative(),
  markdownHeadings: z.array(z.string()),
  navigationTargets: z.array(z.string()),
  paneActivities: z.array(z.string()),
  paneCount: z.number().int().nonnegative(),
  paneHeaderTopAligned: z.number().int().nonnegative(),
  paneOrder: z.array(z.string()),
  paneRepositories: z.array(z.string()),
  paneStates: z.array(z.string()),
  paneViewportEscapes: z.number().int().nonnegative(),
  queueHeadCount: z.number().int().nonnegative(),
  queueMessageCount: z.number().int().nonnegative(),
  queueSteerCount: z.number().int().nonnegative(),
  queueTexts: z.array(z.string()),
  reasoningMarkdownHeadings: z.array(z.string()),
  responseCount: z.number().int().nonnegative(),
  remoteCapabilityCount: z.number().int().nonnegative(),
  remoteMounted: z.number().int().nonnegative(),
  remoteMutationControlCount: z.number().int().nonnegative(),
  remotePaneCount: z.number().int().nonnegative(),
  remoteTooltipCount: z.number().int().nonnegative(),
  remoteTriggerCount: z.number().int().nonnegative(),
  routingChromeCount: z.number().int().nonnegative(),
  scheduleStatusCount: z.number().int().nonnegative(),
  scheduleStatusTexts: z.array(z.string()),
  scheduleToggleCount: z.number().int().nonnegative(),
  scheduledPaneCount: z.number().int().nonnegative(),
  selectedScheduleToggleCount: z.number().int().nonnegative(),
  semanticBorderCount: z.number().int().nonnegative(),
  settingsCount: z.number().int().nonnegative(),
  subagentControlCount: z.number().int().nonnegative(),
  subagentRegionCount: z.number().int().nonnegative(),
  subagents: z.array(z.object({
    state: z.string(),
    title: z.string(),
  }).strict()),
  thinkingActivityLabels: z.array(z.string()),
  thinkingCount: z.number().int().nonnegative(),
  titleInputCount: z.number().int().nonnegative(),
  transcriptLogCount: z.number().int().nonnegative(),
  toolActivityCount: z.number().int().nonnegative(),
  squarePaneCount: z.number().int().nonnegative(),
  subscriptionSelectorCount: z.number().int().nonnegative(),
  viewportContent: z.string(),
}).strict();

async function verifyScenarioSemantics(
  browser: AgentBrowser,
  scenarioId: string,
): Promise<void> {
  const state = parseData(
    scenarioUiStateSchema,
    await browser.evaluate(`(() => {
      const panes = [...document.querySelectorAll('.chat-pane')];
      const remotePanes = [...document.querySelectorAll('.remote-session-pane')];
      const grid = document.querySelector('.pane-grid');
      const gridBox = grid instanceof HTMLElement ? grid.getBoundingClientRect() : null;
      const gridColumns = grid instanceof HTMLElement
        ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean)
        : [];
      const hasStableLabel = (element) => {
        const ids = (element.getAttribute('aria-labelledby') || '').split(/\\s+/u).filter(Boolean);
        return ids.length > 0 && ids.every((id) => {
          const label = document.getElementById(id);
          return label !== null && (label.textContent?.trim().length ?? 0) > 0;
        });
      };
      const resolvedToken = (name) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(' + name + ')';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const activityColors = {
        idle: resolvedToken('--activity-idle'),
        messageSent: resolvedToken('--activity-idle'),
        thinkingCompleted: resolvedToken('--activity-thinking'),
        toolStarted: resolvedToken('--activity-tool'),
        responseCompleted: resolvedToken('--activity-response'),
      };
      const controlLabel = (control) => {
        const ariaLabel = control.getAttribute('aria-label')?.trim();
        if (ariaLabel) return ariaLabel;
        if (
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
        ) {
          const label = [...(control.labels ?? [])].find((candidate) =>
            candidate.textContent?.trim()
          );
          if (label) return label.textContent?.trim() || '';
        }
        return control.textContent?.trim() || '';
      };
      return {
        attachmentActionCount: document.querySelectorAll('.pane-attach').length,
        attachmentBlobPreviewCount: [...document.querySelectorAll('.pane-attachments img')]
          .filter((image) => image.getAttribute('src')?.startsWith('blob:')).length,
        attachmentPreviewCount: document.querySelectorAll('.pane-attachments img').length,
        autoContainedPanes: panes.filter((pane) => getComputedStyle(pane).contentVisibility === 'auto').length,
        containedPanes: panes.filter((pane) => {
          const containment = getComputedStyle(pane).contain;
          return containment === 'content'
            || containment === 'strict'
            || ['layout', 'paint', 'style'].every((value) => containment.includes(value));
        }).length,
        composerPlaceholders: [...document.querySelectorAll('.chat-pane__composer textarea')]
          .map((control) => control.getAttribute('placeholder') || ''),
        composerSendContained: [...document.querySelectorAll('.chat-pane__composer form')]
          .filter((form) => {
            const send = form.querySelector('.pane-send');
            if (!(send instanceof HTMLElement)) return false;
            const formBox = form.getBoundingClientRect();
            const sendBox = send.getBoundingClientRect();
            return sendBox.left >= formBox.left - 0.5
              && sendBox.right <= formBox.right + 0.5
              && sendBox.top >= formBox.top - 0.5
              && sendBox.bottom <= formBox.bottom + 0.5;
          }).length,
        composerValues: [...document.querySelectorAll('.chat-pane__composer textarea')]
          .map((control) => control instanceof HTMLTextAreaElement ? control.value : ''),
        disabledComposers: [...document.querySelectorAll('.chat-pane__composer textarea:disabled')].length,
        disabledSendButtons: document.querySelectorAll('.pane-send:disabled').length,
        draggableHeaders: document.querySelectorAll('.chat-pane__header[draggable=true]').length,
        durationInsideLiveRegionCount: [...document.querySelectorAll('.pane-turn-elapsed')]
          .filter((duration) => duration.closest('[aria-live]') !== null).length,
        durationLabels: [...document.querySelectorAll('.pane-turn-elapsed')]
          .map((duration) => duration.getAttribute('aria-label') || ''),
        durationTexts: [...document.querySelectorAll('.pane-turn-elapsed')]
          .map((duration) => duration.textContent?.trim() || ''),
        gridColumnCount: gridColumns.length,
        harnessProposalInteractiveControls: document.querySelectorAll('.harness-proposal-list button, .harness-proposal-list a[href], .harness-proposal-list input, .harness-proposal-list select, .harness-proposal-list textarea, .harness-proposal-list [role=button], .harness-proposal-list [role=link]').length,
        harnessProposalTitles: [...document.querySelectorAll('.harness-proposal-list li')]
          .map((element) => element.textContent?.trim() || ''),
        harnessQuotaValues: [...document.querySelectorAll('.harness-quota select')]
          .map((control) => control instanceof HTMLSelectElement ? control.value : ''),
        harnessRefinementControls: [...document.querySelectorAll('.harness-mode__option')]
          .map((control) => ({
            label: controlLabel(control),
            selected: control.getAttribute('aria-pressed') === 'true',
          })),
        harnessSettingsControls: [...document.querySelectorAll('.harness-settings button, .harness-settings a[href], .harness-settings input, .harness-settings select, .harness-settings textarea, .harness-settings [role=button], .harness-settings [role=link]')]
          .map((control) => ({
            label: controlLabel(control),
            pressed: control.getAttribute('aria-pressed'),
            tag: control.tagName.toLowerCase(),
            value: control instanceof HTMLSelectElement ? control.value : null,
          })),
        harnessSettingsCount: document.querySelectorAll('.harness-settings').length,
        harnessSelectedSwitches: document.querySelectorAll('.harness-recursive input[role=switch]:checked').length,
        hash: window.location.hash,
        humanReconnectConfirmationCount: document.querySelectorAll(
          '[role="group"][aria-label="Confirm HRA Cloud reconnect"]',
        ).length,
        identityAccentCount: panes.filter((pane) =>
          pane instanceof HTMLElement && pane.style.getPropertyValue('--pane-identity-strong').trim().length > 0
        ).length,
        labelledPaneCount: panes.filter(hasStableLabel).length,
        labelledTranscriptCount: [...document.querySelectorAll('.chat-pane__transcript[role=log]')]
          .filter(hasStableLabel).length,
        markdownHeadings: [...document.querySelectorAll('.pane-response h1, .pane-response h2, .pane-response h3')]
          .map((heading) => heading.textContent?.trim() || ''),
        navigationTargets: [...document.querySelectorAll('.hra-nav a')]
          .map((link) => link.getAttribute('href') || ''),
        paneActivities: panes.map((pane) => pane.getAttribute('data-pane-activity') || ''),
        paneCount: panes.length,
        paneHeaderTopAligned: panes.filter((pane) => {
          const header = pane.querySelector('.chat-pane__header');
          if (!(header instanceof HTMLElement)) return false;
          return header.getBoundingClientRect().top - pane.getBoundingClientRect().top <= 12;
        }).length,
        paneOrder: panes.map((pane) => pane.getAttribute('data-pane-id') || ''),
        paneRepositories: panes.map((pane) =>
          pane.querySelector('.chat-pane__repository')?.textContent?.trim() || ''
        ),
        paneStates: panes.map((pane) => pane.getAttribute('data-pane-state') || ''),
        paneViewportEscapes: panes.filter((pane) => {
          if (gridBox === null) return true;
          const box = pane.getBoundingClientRect();
          return box.left < gridBox.left - 0.5 || box.right > gridBox.right + 0.5;
        }).length,
        queueHeadCount: document.querySelectorAll('.pane-queue-row[data-queue-head]').length,
        queueMessageCount: document.querySelectorAll('.pane-queue-row').length,
        queueSteerCount: document.querySelectorAll('.pane-queue-action--steer').length,
        queueTexts: [...document.querySelectorAll('.pane-queue-row__text')]
          .map((row) => row.textContent?.trim() || ''),
        reasoningMarkdownHeadings: [...document.querySelectorAll('.pane-reasoning h1, .pane-reasoning h2, .pane-reasoning h3')]
          .map((heading) => heading.textContent?.trim() || ''),
        responseCount: document.querySelectorAll('.pane-response').length,
        remoteCapabilityCount: remotePanes.filter((pane) =>
          pane.getAttribute('data-observation-capability') === 'summary-v1'
        ).length,
        remoteMounted: Number(
          document.querySelector('.pane-grid')?.getAttribute('data-remote-mounted') || '0'
        ),
        remoteMutationControlCount: remotePanes.reduce((count, pane) => count +
          pane.querySelectorAll([
            'button:not(.remote-session-pane__device-trigger)',
            'a[href]',
            'input',
            'select',
            'textarea',
            '.pane-rename',
            '.pane-send',
          ].join(',')).length, 0),
        remotePaneCount: remotePanes.length,
        remoteTooltipCount: document.querySelectorAll('.remote-session-pane__device-tooltip[role=tooltip]').length,
        remoteTriggerCount: document.querySelectorAll('button.remote-session-pane__device-trigger[aria-expanded]').length,
        routingChromeCount: document.querySelectorAll('.pane-route, .pane-route-description').length,
        scheduleStatusCount: document.querySelectorAll('.pane-schedule-status').length,
        scheduleStatusTexts: [...document.querySelectorAll('.pane-schedule-status')]
          .map((status) => status.textContent?.trim() || ''),
        scheduleToggleCount: document.querySelectorAll('.pane-schedule-toggle').length,
        scheduledPaneCount: document.querySelectorAll('.chat-pane[data-pane-scheduled=true]').length,
        selectedScheduleToggleCount: document.querySelectorAll(
          '.pane-schedule-toggle[aria-pressed=true]',
        ).length,
        semanticBorderCount: panes.filter((pane) => {
          const activity = pane.getAttribute('data-pane-activity');
          const expected = pane.getAttribute('data-pane-error') === 'true'
            ? resolvedToken('--danger')
            : activityColors[activity];
          return expected !== undefined && getComputedStyle(pane).borderColor === expected;
        }).length,
        settingsCount: document.querySelectorAll('.settings-page').length,
        subagentControlCount: document.querySelectorAll('.pane-subagents button, .pane-subagents a[href], .pane-subagents input, .pane-subagents textarea, .pane-subagents [role=button], .pane-subagents [role=link]').length,
        subagentRegionCount: document.querySelectorAll('.pane-subagents[aria-label="Active subagents"]').length,
        subagents: [...document.querySelectorAll('.pane-subagents li')].map((row) => ({
          state: row.getAttribute('data-subagent-state') || '',
          title: row.querySelector('.pane-subagent__title')?.textContent?.trim() || '',
        })),
        thinkingActivityLabels: [...document.querySelectorAll('.pane-reasoning')]
          .map((activity) => activity.getAttribute('aria-label') || ''),
        thinkingCount: document.querySelectorAll('.pane-reasoning').length,
        titleInputCount: document.querySelectorAll('.pane-title-input').length,
        transcriptLogCount: document.querySelectorAll('.chat-pane__transcript[role=log]').length,
        toolActivityCount: document.querySelectorAll('.pane-tool').length,
        squarePaneCount: panes.filter((pane) => {
          const box = pane.getBoundingClientRect();
          return box.width > 0 && Math.abs(box.width - box.height) <= 1.5;
        }).length,
        subscriptionSelectorCount: document.querySelectorAll('.subscription-select').length,
        viewportContent: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
      };
    })()`),
    `${scenarioId} semantic UI state`,
  );

  const failures: string[] = [];
  if (
    state.navigationTargets.length > 1 ||
    state.navigationTargets.some((target) => target !== "#panes" && target !== "#settings")
  ) {
    failures.push(`navigation targets are ${state.navigationTargets.join(",") || "missing"}`);
  }
  if (state.labelledPaneCount !== state.paneCount) {
    failures.push(`${String(state.labelledPaneCount)} of ${String(state.paneCount)} panes have a stable accessible label`);
  }
  if (state.labelledTranscriptCount !== state.transcriptLogCount) {
    failures.push(`${String(state.labelledTranscriptCount)} of ${String(state.transcriptLogCount)} transcript logs have a stable accessible label`);
  }
  if (state.transcriptLogCount > 1) {
    failures.push(`${String(state.transcriptLogCount)} transcripts expose simultaneous live-log announcements`);
  }
  if (
    scenarioId !== "chat-compact-malleable" &&
    state.paneCount > 0 &&
    state.squarePaneCount !== state.paneCount
  ) {
    failures.push(`${String(state.squarePaneCount)} of ${String(state.paneCount)} panes are square`);
  }
  if (state.paneCount > 0 && state.semanticBorderCount !== state.paneCount) {
    failures.push(`${String(state.semanticBorderCount)} of ${String(state.paneCount)} panes use their semantic activity border`);
  }
  if (state.paneCount > 0 && state.paneHeaderTopAligned !== state.paneCount) {
    failures.push(`${String(state.paneHeaderTopAligned)} of ${String(state.paneCount)} pane headers begin at the top edge`);
  }
  if (state.paneCount > 0 && state.draggableHeaders !== state.paneCount) {
    failures.push(`${String(state.draggableHeaders)} of ${String(state.paneCount)} local pane headers are draggable`);
  }
  if (state.subscriptionSelectorCount !== 0) {
    failures.push(`${String(state.subscriptionSelectorCount)} per-pane subscription selectors remain`);
  }
  if (state.routingChromeCount !== 0) {
    failures.push(`${String(state.routingChromeCount)} user-facing routing controls remain`);
  }
  if (state.toolActivityCount !== 0) {
    failures.push(`${String(state.toolActivityCount)} tool-call presentations remain`);
  }
  if (state.durationInsideLiveRegionCount !== 0) {
    failures.push("turn duration is nested inside a live region");
  }
  if (state.durationLabels.some((label, index) => {
    const text = state.durationTexts[index] ?? "";
    return label !== `Current turn duration ${text}` &&
      label !== `Last turn duration ${text}`;
  })) {
    failures.push("turn duration accessible name omits its current or last value");
  }
  if (!state.viewportContent.split(",").map((value) => value.trim()).includes("viewport-fit=cover")) {
    failures.push("the Direct viewport does not opt into safe-area coverage");
  }
  if (state.composerPlaceholders.some((placeholder) => placeholder !== "")) {
    failures.push("a pane composer still exposes placeholder copy");
  }
  if (state.composerSendContained !== state.composerPlaceholders.length) {
    failures.push("a send button is not contained by its composer surface");
  }
  switch (scenarioId) {
    case "attention-mission-control":
      if (state.paneCount !== 1 || state.paneStates[0] !== "ready") {
        failures.push("mission control did not retain its one local ready pane");
      }
      break;
    case "chat-draft":
      if (state.paneCount !== 1 || state.paneStates[0] !== "ready") failures.push("configured draft is not one ready pane");
      if (state.titleInputCount !== 0) failures.push("title editor did not close after explicit commit");
      if (state.disabledComposers !== 0) failures.push("draft composer is disabled");
      if (state.paneActivities[0] !== "idle") failures.push("non-message configuration changed the neutral activity");
      break;
    case "chat-streaming":
      if (state.paneCount !== 1 || state.paneStates[0] !== "streaming") failures.push("streaming pane did not remain active");
      if (state.disabledComposers !== 0) failures.push("active pane composer cannot accept an ordinary queued message");
      if (state.thinkingCount !== 1 || state.responseCount !== 1) failures.push("streaming Markdown activity is incomplete");
      if (state.thinkingActivityLabels[0] !== "Thinking") failures.push("streaming reasoning is not named semantically");
      if (!state.markdownHeadings.includes("In progress")) failures.push("streaming Markdown heading is not semantic");
      if (state.paneActivities[0] !== "toolStarted") failures.push("tool activity border is not current");
      break;
    case "chat-scheduled":
      if (state.paneCount !== 1 || state.paneStates[0] !== "ready") {
        failures.push("scheduled journey is not one ready pane");
      }
      if (
        state.scheduledPaneCount !== 1 ||
        state.scheduleStatusCount !== 1 ||
        state.scheduleStatusTexts[0] !== "Scheduled · due now" ||
        state.scheduleToggleCount !== 1 ||
        state.selectedScheduleToggleCount !== 1
      ) failures.push("scheduled chat state is not durably selected with one concise next run");
      if (state.attachmentActionCount !== 0) {
        failures.push("schedule mode exposed the attachment path");
      }
      if (state.queueMessageCount !== 0 || state.composerValues[0] !== "invalid schedule") {
        failures.push("schedule interpretation failure changed the editable draft or message queue");
      }
      break;
    case "chat-compact-malleable": {
      const expectedSubagents = [
        { state: "running", title: "Routing audit" },
        { state: "waiting", title: "Direct verification" },
        { state: "starting", title: "Attachment vault" },
      ];
      if (state.paneCount !== 1 || state.paneStates[0] !== "streaming") failures.push("malleable fixture is not one active pane");
      if (state.thinkingCount !== 1 || state.responseCount !== 1) failures.push("malleable Markdown thinking and answer are incomplete");
      if (!state.reasoningMarkdownHeadings.includes("Thinking")) failures.push("reasoning Markdown heading is not semantic");
      if (!state.markdownHeadings.includes("Compact answer")) failures.push("answer Markdown heading is not semantic");
      if (
        state.queueMessageCount !== 1 ||
        state.queueHeadCount !== 1 ||
        state.queueSteerCount !== 1 ||
        state.queueTexts.join("") !== "Then tighten the compact layout."
      ) failures.push("FIFO queue did not retain one editable, removable, steerable head");
      if (
        state.subagentRegionCount !== 1 ||
        state.subagentControlCount !== 0 ||
        JSON.stringify(state.subagents) !== JSON.stringify(expectedSubagents)
      ) failures.push("pinned active subagents are not the exact action-free active projection");
      if (state.attachmentPreviewCount !== 1 || state.attachmentBlobPreviewCount !== 1) failures.push("gateway-vended image preview is missing or unsafe");
      if (state.durationTexts.join("") !== "2h 1m 45s") failures.push("logical turn duration is not deterministic");
      if (state.identityAccentCount !== 1) failures.push("durable pane identity tokens are missing");
      if (state.disabledComposers !== 0) failures.push("active composer cannot accept an ordinary queued message");
      if (state.containedPanes !== 1 || state.autoContainedPanes !== 1) failures.push("malleable pane is not independently contained");
      break;
    }
    case "chat-completed":
      if (state.paneCount !== 1 || state.paneStates[0] !== "ready") failures.push("sent turn did not reach its terminal ready state");
      if (state.disabledComposers !== 0 || state.responseCount !== 1) failures.push("terminal pane did not expose one enabled latest response");
      if (state.thinkingCount !== 0 || state.toolActivityCount !== 0) failures.push("terminal pane retained transient activity");
      if (state.reasoningMarkdownHeadings.length !== 0) failures.push("unverified terminal reasoning became visible");
      if (!state.markdownHeadings.includes("Direct response")) failures.push("terminal Markdown response is not semantic");
      if (state.paneActivities[0] !== "responseCompleted") failures.push("response border did not replace the message reset");
      break;
    case "chat-attention":
      if (
        state.paneCount !== attentionPresentations.length ||
        state.paneStates.some((paneState) => paneState !== "ready")
      ) failures.push("not every attention presentation recovered to ready");
      if (
        state.disabledComposers !== 0 ||
        state.responseCount !== attentionPresentations.length
      ) failures.push("attention recovery did not expose one enabled latest response per pane");
      if (
        state.markdownHeadings.filter((heading) => heading === "Direct response").length !==
          attentionPresentations.length
      ) failures.push("attention recovery Markdown responses are incomplete");
      break;
    case "chat-compact-320":
    case "chat-compact-639":
    case "chat-compact-415":
      if (state.paneCount !== 1 || state.paneStates[0] !== "ready") failures.push("compact journey is not one ready pane");
      if (state.gridColumnCount !== 1 || state.paneViewportEscapes !== 0) failures.push("compact pane is not contained in one grid column");
      if (state.disabledComposers !== 0 || state.disabledSendButtons !== 0) failures.push("compact controls are unexpectedly disabled");
      if (state.composerValues[0] !== "Compact controls remain usable.") failures.push("compact composer did not accept input");
      break;
    case "chat-many-panes":
      if (state.paneCount !== manyChatPaneCount) failures.push(`expected ${String(manyChatPaneCount)} panes, received ${String(state.paneCount)}`);
      if (state.paneStates.some((paneState) => paneState !== "ready")) failures.push("not every dense-grid pane is ready");
      if (state.responseCount !== manyChatPaneCount) failures.push("dense-grid responses are incomplete");
      if (state.gridColumnCount < 4) failures.push(`expected an adaptive dense grid, received ${String(state.gridColumnCount)} columns`);
      if (
        state.containedPanes !== manyChatPaneCount
        || state.autoContainedPanes !== manyChatPaneCount
      ) failures.push("pane containment or content visibility is incomplete");
      if (state.paneViewportEscapes !== 0) failures.push(`${String(state.paneViewportEscapes)} panes escape the grid`);
      break;
    case "chat-parallel-streaming":
      if (
        state.paneCount !== parallelStreamPaneCount
        || state.paneStates.filter((value) => value === "streaming").length
          !== parallelStreamPaneCount
        || state.remotePaneCount !== 48
      ) {
        failures.push("parallel fixture does not retain 64 active local streams and the bounded 48-of-448 remote window");
      }
      failures.push(...parallelComposerFailures({
        composerCount: state.composerPlaceholders.length,
        disabledComposerCount: state.disabledComposers,
        disabledSendButtonCount: state.disabledSendButtons,
      }));
      if (state.responseCount !== parallelStreamPaneCount) {
        failures.push("parallel deltas did not render one response per local stream");
      }
      if (
        state.containedPanes !== parallelStreamPaneCount
        || state.autoContainedPanes !== parallelStreamPaneCount
        || state.paneViewportEscapes !== 0
      ) failures.push("parallel panes are not independently contained");
      if (
        state.remoteCapabilityCount !== 48
        || state.remoteMutationControlCount !== 0
      ) failures.push("parallel remote summaries expose local mutation authority or an incomplete mount window");
      break;
    case "chat-create-pane":
      if (state.paneCount !== 1 || state.paneStates[0] !== "ready") failures.push("pathless project add did not create one ready pane");
      break;
    case "chat-create-pane-inherit":
      if (state.paneCount !== 2 || state.paneStates.some((paneState) => paneState !== "ready")) {
        failures.push("inherited pane creation did not retain two ready panes");
      }
      if (state.paneRepositories.join(",") !== "example,example") {
        failures.push(`new pane repositories are ${state.paneRepositories.join(",") || "missing"}`);
      }
      break;
    case "chat-pane-order":
      if (state.paneOrder.join(",") !== "pane_order000003,pane_order000002,pane_order000001") {
        failures.push(`pane order is ${state.paneOrder.join(",") || "missing"}`);
      }
      break;
    case "settings-no-subscriptions":
      if (
        state.hash !== "#settings" || state.settingsCount !== 1 || state.paneCount !== 0
        || state.navigationTargets.length !== 0
      ) failures.push("zero-subscription routing exposes something other than Settings");
      break;
    case "harness-settings":
      if (state.hash !== "#settings" || state.settingsCount !== 1) failures.push("Harness settings is not the active canonical route");
      if (state.paneCount !== 0 || state.harnessSettingsCount !== 1) failures.push("Harness settings leaked pane UI or failed to render exactly once");
      if (state.harnessSelectedSwitches !== 1) failures.push("Recursive sessions is not selected");
      if (state.harnessQuotaValues.join(",") !== "16777216") failures.push("Harness context quota is not the exact 16 MiB value");
      if (JSON.stringify(state.harnessRefinementControls) !== JSON.stringify([
        { label: "Off", selected: false },
        { label: "Suggest", selected: true },
      ])) failures.push("Harness refinement does not expose exactly Off and selected Suggest");
      if (JSON.stringify(state.harnessSettingsControls) !== JSON.stringify([
        { label: "Recursive sessions", pressed: null, tag: "input", value: null },
        { label: "Context quota", pressed: null, tag: "select", value: "16777216" },
        { label: "Off", pressed: "false", tag: "button", value: null },
        { label: "Suggest", pressed: "true", tag: "button", value: null },
      ])) failures.push("Harness settings exposes controls outside the exact minimal surface");
      if (state.harnessProposalTitles.join(",") !== "Prefer exact context slices") failures.push("Harness proposal titles are not the exact bounded projection");
      if (state.harnessProposalInteractiveControls !== 0) failures.push("Harness proposals expose interactive authority");
      break;
    case "harness-children-mixed": {
      const expectedChildren = [
        { state: "starting", title: "Starting child" },
        { state: "running", title: "Running child" },
        { state: "waiting", title: "Waiting child" },
      ];
      if (state.paneCount !== 1 || state.subagentRegionCount !== 1) failures.push("active subagent stack is not pinned to its sole pane");
      if (state.subagentControlCount !== 0) failures.push("active subagent stack exposes per-child action authority");
      if (JSON.stringify(state.subagents) !== JSON.stringify(expectedChildren)) failures.push("active subagent stack does not expose the exact ordered active states");
      break;
    }
    case "settings-browser-login":
      if (state.hash !== "#settings" || state.settingsCount !== 1) failures.push("Settings is not the active canonical route");
      if (state.paneCount !== 0) failures.push("pane UI leaked into Settings");
      break;
    case "settings-human-credential-recovery":
      if (state.hash !== "#settings" || state.settingsCount !== 1) failures.push("Credential recovery Settings is not the active canonical route");
      if (state.paneCount !== 0) failures.push("pane UI leaked into credential recovery Settings");
      if (state.humanReconnectConfirmationCount !== 0) failures.push("credential recovery consent remained mounted after settlement");
      break;
    case "settings-session-sync-disabled":
    case "settings-session-sync-active":
    case "settings-session-sync-enrolling":
    case "settings-session-sync-unavailable":
      if (state.hash !== "#settings" || state.settingsCount !== 1) {
        failures.push("session-sync Settings is not the active canonical route");
      }
      if (state.paneCount !== 0 || state.remotePaneCount !== 0) {
        failures.push("pane UI leaked into session-sync Settings");
      }
      break;
    case "session-sync-fault-cloud":
    case "session-sync-fault-auth":
    case "session-sync-fault-keychain":
    case "session-sync-fault-network":
      if (state.paneCount !== 2 || state.paneStates.some((value) => value !== "ready")) {
        failures.push("a session-sync fault blocked local pane creation or settlement");
      }
      if (state.responseCount !== 1 || state.disabledComposers !== 0) {
        failures.push("a session-sync fault blocked the local send result");
      }
      break;
    case "remote-session-summaries-512":
      if (state.paneCount !== 64 || state.remotePaneCount !== 48 || state.remoteMounted !== 48) {
        failures.push("the 512-slot grid did not retain 64 local panes and a 48-item remote mount window");
      }
      if (
        state.remoteCapabilityCount !== 48
        || state.remoteMutationControlCount !== 0
        || state.remoteTooltipCount !== 48
        || state.remoteTriggerCount !== 48
      ) failures.push("remote summaries expose mutation authority or incomplete accessible metadata");
      if (state.paneViewportEscapes !== 0) failures.push("dense local panes escape the landscape grid");
      break;
  }
  if (failures.length > 0) {
    throw new Error(`${scenarioId} failed semantic UI checks: ${failures.join("; ")}; state: ${JSON.stringify(state)}`);
  }
}

function assertProbe(probe: ProbeSnapshot, scenarioId: string): void {
  if (!probe.isQuiescent || probe.activity.active !== 0) {
    throw new Error(`${scenarioId} did not become quiescent: ${JSON.stringify(probe)}`);
  }
  if (probe.activity.started !== probe.activity.settled) {
    throw new Error(`${scenarioId} leaked activity: ${JSON.stringify(probe.activity)}`);
  }
  if (Object.values(probe.pending).some((value) => value !== 0)) {
    throw new Error(`${scenarioId} retained pending activity: ${JSON.stringify(probe.pending)}`);
  }
  const violations = Object.entries(probe.violations).filter(([, value]) => value !== 0);
  if (violations.length > 0) {
    throw new Error(`${scenarioId} reported Direct violations: ${JSON.stringify(violations)}`);
  }
  const productWorkViolations = remainingWorkViolations(probe.remainingWork);
  if (productWorkViolations.length > 0) {
    throw new Error(`${scenarioId} retained product work: ${productWorkViolations.join("; ")}`);
  }
}

async function verifyScenario(options: {
  readonly baseUrl: string;
  readonly browser: AgentBrowser;
  readonly definition: ScenarioDefinition;
  readonly repositoryRoot: string;
  readonly runDirectory: string;
}): Promise<ScenarioVerification> {
  const { baseUrl, browser, definition, repositoryRoot, runDirectory } = options;
  const url = scenarioUrl(baseUrl, definition.id);
  if ((definition.browserLane ?? "standard") === "forced-touch-reduced") {
    await browser.run(["set", "media", "light", "reduced-motion"]);
  } else {
    await browser.run(["set", "media", "light"]);
  }
  await browser.run(["set", "viewport", String(definition.viewport.width), String(definition.viewport.height)]);
  await browser.run(["errors", "--clear"]);
  await browser.run(["console", "--clear"]);
  await browser.run(["network", "requests", "--clear"]);
  await browser.run(["open", url]);
  await browser.run(["wait", "--fn", "typeof window.__direct?.snapshot === 'function'"]);
  const authoredScenario = hraDirectDefinition.scenarios.resolve(definition.id);
  if (!authoredScenario.ok) throw new Error(authoredScenario.error.message);
  if ((definition.preQuiescence ?? "none") === "observe-parallel-streaming") {
    await beginParallelStreamObservation(browser);
  }
  const contract = await readDirectBrowserContract(browser, {
    source: "scenario",
    scenario: definition.id,
    route: authoredScenario.value.route,
  });
  await waitForStableProbe(browser);
  let parallelPerformance: ParallelPerformanceMeasurement | null = null;
  if ((definition.preQuiescence ?? "none") === "observe-parallel-streaming") {
    for (const expected of definition.expectedText) {
      await waitForVisibleText(browser, expected);
    }
    const scriptedDeltaCount = authoredScenario.value.world.gateway.events.filter(
      ({ event }) => event.event.type === "chat.turn.delta",
    ).length;
    parallelPerformance = await finishParallelStreamObservation(browser, scriptedDeltaCount);
    const failures = parallelPerformanceFailures(parallelPerformance);
    if (failures.length > 0) {
      throw new Error(
        `${definition.id} failed parallel performance checks: ${failures.join("; ")}; evidence: ${JSON.stringify(parallelPerformance)}`,
      );
    }
  }

  for (const expected of definition.expectedBeforeAction ?? []) {
    await waitForVisibleText(browser, expected);
  }

  await runAction(browser, definition.action);

  const { rootFontSizePx, uiScale } = parseData(
    uiScaleMeasurementSchema,
    await browser.evaluate(`(() => ({
      rootFontSizePx: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
      uiScale: document.documentElement.style.getPropertyValue('--ui-scale') || '1',
    }))()`),
    `${definition.id} text scale measurement`,
  );
  if (definition.expectedUiScale !== undefined && uiScale !== definition.expectedUiScale) {
    throw new Error(
      `${definition.id} expected UI scale ${definition.expectedUiScale}, received ${uiScale}`,
    );
  }
  if (
    definition.expectedUiScale !== undefined &&
    Math.abs(rootFontSizePx - 16 * Number(definition.expectedUiScale)) > 0.1
  ) {
    throw new Error(
      `${definition.id} did not render its ${definition.expectedUiScale} text scale; root font size is ${String(rootFontSizePx)}px`,
    );
  }

  for (const expected of definition.expectedText) {
    await waitForVisibleText(browser, expected);
  }
  await verifyScenarioSemantics(browser, definition.id);
  const responsiveLayout = await verifyResponsiveLayout(
    browser,
    definition.id,
    definition.expectedVisibleControls,
  );
  await waitForStableProbe(browser);
  const firstProbe = await readProbe(browser);
  assertProbe(firstProbe, definition.id);
  await Bun.sleep(200);
  const secondProbe = await readProbe(browser);
  assertProbe(secondProbe, definition.id);
  if (JSON.stringify(firstProbe) !== JSON.stringify(secondProbe)) {
    throw new Error(`${definition.id} canonical probe changed after its stability gate.`);
  }

  const body = await browser.readBodyText();
  const missing = definition.expectedText.filter((expected) => !body.includes(expected));
  if (missing.length > 0) {
    throw new Error(`${definition.id} is missing visible text: ${missing.join(", ")}`);
  }
  const forbidden = (definition.forbiddenText ?? []).filter((text) => body.includes(text));
  if (forbidden.length > 0) {
    throw new Error(`${definition.id} exposes forbidden session controls: ${forbidden.join(", ")}`);
  }
  const browserErrors = parseData(browserErrorsSchema, await browser.run(["errors"]), "browser errors").errors;
  if (browserErrors.length > 0) {
    throw new Error(`${definition.id} reported page errors: ${browserErrors.map(renderUnknown).join("; ")}`);
  }
  const consoleMessages = parseData(consoleSchema, await browser.run(["console"]), "browser console").messages;
  const consoleFailures = consoleMessages.filter(({ type }) => type === "error" || type === "assert");
  if (consoleFailures.length > 0) {
    throw new Error(`${definition.id} reported console failures: ${consoleFailures.map(({ type, text }) => `${type}: ${text}`).join("; ")}`);
  }

  const network = parseData(networkSchema, await browser.run(["network", "requests"]), "browser network").requests;
  const rejectedRequests = externalOrFailedRequests(network, baseUrl);
  if (rejectedRequests.length > 0) {
    throw new Error(`${definition.id} made failed or external requests: ${JSON.stringify(rejectedRequests)}`);
  }

  const screenshotPath = join(runDirectory, `${definition.id}.png`);
  await browser.run(["screenshot", screenshotPath]);
  if ((await stat(screenshotPath)).size < 1_024) {
    throw new Error(`${definition.id} screenshot is unexpectedly small.`);
  }
  const finalContract = bindDirectBrowserContractEvidence(
    contract,
    await readDirectBrowserContract(browser, {
      source: "scenario",
      scenario: definition.id,
      route: authoredScenario.value.route,
    }),
    secondProbe,
  );
  if (uiScale !== "1") await setUiScale(browser, 0, "1");
  return {
    evidence: {
      active: finalContract.manifest.active,
      catalogHash: finalContract.manifest.catalogHash,
      id: definition.id,
      url,
      expectedBeforeAction: definition.expectedBeforeAction ?? [],
      expectedText: definition.expectedText,
      probe: secondProbe,
      networkRequests: network.length,
      parallelPerformance,
      responsiveLayout,
      rootFontSizePx,
      screenshot: relative(repositoryRoot, screenshotPath),
      uiScale,
    },
    manifest: finalContract.manifest,
  };
}

export function directServerCommand(workspaceRoot: string, port: string): readonly string[] {
  return Object.freeze([
    join(workspaceRoot, "node_modules/.bin/vite"),
    "--config",
    "frontend/direct/vite.config.ts",
    "--port",
    port,
  ]);
}

function startServer(repositoryRoot: string, baseUrl: string) {
  const port = new URL(baseUrl).port || "80";
  const workspaceRoot = join(repositoryRoot, "apps/desktop");
  return spawnVerificationServer({
    command: directServerCommand(workspaceRoot, port),
    cwd: workspaceRoot,
    env: { CI: "1" },
  });
}

async function run(repositoryRoot: string, baseUrl: string): Promise<string> {
  const artifactRoot = join(repositoryRoot, "artifacts/direct/hra");
  const artifactRun = await createArtifactRun({ artifactRoot });
  const server = await acquireVerificationServer({
    baseUrl,
    label: "HRA Direct server",
    readinessPath: "/main.tsx",
    reuseExistingLocalServer: false,
    startupTimeoutMs: SERVER_START_TIMEOUT_MS,
    startServer: () => startServer(repositoryRoot, baseUrl),
  });
  const browser = createAgentBrowser({ repositoryRoot, sessionPrefix: "oc" });
  const forcedTouchBrowser = createAgentBrowser({
    repositoryRoot,
    sessionPrefix: "oc-a11y",
    launchArguments: ["--force-high-contrast", "--disable-extensions"],
  });
  const evidence: ScenarioEvidence[] = [];
  const sessionManifests: DirectBrowserContract["manifest"][] = [];
  let failure: unknown = null;
  let coverage: readonly CoverageEntry[] = [];
  try {
    for (const definition of scenarios) {
      console.log(`Verifying ${definition.id}...`);
      const browserLane = "browserLane" in definition
        ? definition.browserLane
        : "standard";
      const scenarioBrowser = browserLane ===
          "forced-touch-reduced"
        ? forcedTouchBrowser
        : browser;
      const verified = await verifyScenario({
        baseUrl,
        browser: scenarioBrowser,
        definition,
        repositoryRoot,
        runDirectory: artifactRun.runDirectory,
      });
      evidence.push(verified.evidence);
      sessionManifests.push(verified.manifest);
    }
    const parsedCoverage = parseDefinitionCoverageSnapshot(
      bindDirectScenarioCatalog(sessionManifests),
      hraDirectDefinition,
    );
    if (!parsedCoverage.ok) {
      throw new Error(`coverage catalog is not definition-bound: ${parsedCoverage.error.message}`);
    }
    coverage = parsedCoverage.value.entries;
    const coverageViolations = coveragePolicyViolations(
      coverage,
      new Set(hraDirectDefinition.scenarios.list().map(({ id }) => String(id))),
      new Set(evidence.map(({ id }) => id)),
    );
    if (coverageViolations.length > 0) {
      throw new Error(`Coverage policy failed: ${coverageViolations.join("; ")}`);
    }
    const cited = new Set(
      coverage.flatMap(({ scenarios: scenarioIds }) => scenarioIds.map(String)),
    );
    const uncited = evidence.map(({ id }) => id).filter((id) => !cited.has(id));
    if (uncited.length > 0) throw new Error(`Coverage does not cite verified scenarios: ${uncited.join(", ")}`);
    if (!coverage.some(({ mode }) => mode === "direct")) {
      throw new Error("Coverage must keep direct native evidence visible.");
    }
  } catch (reason) {
    failure = reason;
  }

  const cleanupFailures: unknown[] = [];
  try {
    await browser.close();
  } catch (reason) {
    cleanupFailures.push(reason);
  }
  try {
    await forcedTouchBrowser.close();
  } catch (reason) {
    cleanupFailures.push(reason);
  }
  if (server.source === "started") {
    try {
      await stopVerificationServer(server.server);
    } catch (reason) {
      cleanupFailures.push(reason);
    }
  }
  if (failure !== null || cleanupFailures.length > 0) {
    throw new AggregateError(
      failure === null ? cleanupFailures : [failure, ...cleanupFailures],
      `HRA browser verification failed: ${renderUnknown(failure ?? cleanupFailures[0])}`,
    );
  }

  await writeJsonAtomically(artifactRun.manifestPath, {
    $schema: "hra.direct.web-verification/v1",
    product: "hra",
    baseUrl,
    generatedAt: artifactRun.generatedAt,
    scenarios: evidence,
    coverage,
    coverageResults: coverage.map((entry) => ({
      key: entry.key,
      result: classifyCoverageEvidence(entry, {
        exercisedScenarios: new Set(evidence.map(({ id }) => id)),
      }),
      scenarios: entry.scenarios,
    })),
    server: server.source,
  });
  return artifactRun.manifestPath;
}

function usage(): string {
  return [
    "Usage: bun run frontend/direct/verify-browser.ts [--base-url URL]",
    "",
    `Default URL: ${DEFAULT_BASE_URL}`,
    "Reuses a reachable server or starts and stops HRA's isolated Vite lab.",
  ].join("\n");
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.kind === "help") {
    console.log(usage());
    return;
  }
  const repositoryRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
  const manifest = await run(repositoryRoot, arguments_.baseUrl);
  console.log(`HRA Direct browser verification passed. Manifest: ${manifest}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (reason) {
    console.error(reason instanceof Error ? reason.message : String(reason));
    process.exitCode = 1;
  }
}
