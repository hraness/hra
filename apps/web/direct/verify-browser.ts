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

import { agentTasksDirectDefinition } from "./scenarios";
const DEFAULT_BASE_URL = "http://127.0.0.1:5176";
const SERVER_START_TIMEOUT_MS = 30_000;
const DIRECT_ROOT_ASSET_PATHS = new Set([
  "/main.tsx",
  "/mount.ts",
  "/runtime.tsx",
  "/scenarios.ts",
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
    window.__agentTasksDirectVerifierQuiet = undefined;
    return false;
  }
  const key = [
    snapshot.activationHash,
    snapshot.generation,
    snapshot.revision,
    snapshot.activity.started,
    snapshot.activity.settled,
  ].join(":");
  const previous = window.__agentTasksDirectVerifierQuiet;
  if (previous?.key !== key) {
    window.__agentTasksDirectVerifierQuiet = { key, since: Date.now() };
    return false;
  }
  return Date.now() - previous.since >= 150;
})()`;

const remainingWorkSchema = z.object({
  disposed: z.boolean(),
  scripts: z.object({
    commands: z.number().int().nonnegative(),
    interactions: z.number().int().nonnegative(),
    pages: z.number().int().nonnegative(),
  }),
});
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
type ProbeSnapshot = Readonly<
  Omit<DirectProbeSnapshot, "remainingWork">
  & { readonly remainingWork: z.infer<typeof remainingWorkSchema> }
>;
interface CoveragePolicyEntry {
  readonly claim: string;
  readonly key: string;
  readonly mode: "direct" | "fixture" | "mixed";
  readonly scenarios: readonly string[];
}
type NetworkRequest = z.infer<typeof networkSchema>["requests"][number];
type ScenarioAction =
  | "accept-conflict"
  | "answer-question"
  | "approve-interaction"
  | "create"
  | "create-race"
  | "load-more"
  | "none"
  | "reject"
  | "resolve-ambiguity"
  | "retry"
  | "stop-queued";

interface ScenarioDefinition {
  readonly action: ScenarioAction;
  readonly expectedBeforeAction?: readonly string[];
  readonly expectedText: readonly string[];
  readonly forbiddenControls?: readonly string[];
  readonly id: string;
  readonly scriptsMustBeConsumed: boolean;
  readonly viewport: { readonly height: number; readonly width: number };
  readonly verifyMinimalChrome?: boolean;
  readonly verifyNeedsInputFirst?: boolean;
  readonly verifyPendingIsolation?: boolean;
  readonly verifyReadOnly?: boolean;
  readonly verifyStreaming?: boolean;
  readonly verifyToolTimer?: boolean;
}

interface ScenarioEvidence {
  readonly active: DirectBrowserContract["manifest"]["active"];
  readonly catalogHash: string;
  readonly expectedBeforeAction: readonly string[];
  readonly expectedText: readonly string[];
  readonly id: string;
  readonly networkRequests: number;
  readonly probe: ProbeSnapshot;
  readonly screenshot: string;
  readonly url: string;
}

interface ScenarioVerification {
  readonly evidence: ScenarioEvidence;
  readonly manifest: DirectBrowserContract["manifest"];
}

const scenarios = [
  {
    action: "none",
    expectedText: ["No ready tasks", "Nothing can be claimed right now"],
    id: "tasks-empty-ready",
    scriptsMustBeConsumed: false,
    viewport: { width: 820, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Attention view unavailable", "SERVICE_UNAVAILABLE", "Reference req_direct_query"],
    id: "tasks-query-failed",
    scriptsMustBeConsumed: false,
    viewport: { width: 390, height: 844 },
  },
  {
    action: "none",
    expectedText: ["Tasks", "Fence credential revocation", "Ready to review", "Agent access was revoked", "Details"],
    id: "tasks-rich-review",
    scriptsMustBeConsumed: false,
    verifyMinimalChrome: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Runner offline", "Fence credential revocation"],
    id: "runner-offline",
    scriptsMustBeConsumed: false,
    viewport: { width: 820, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Runner offline", "Fence credential revocation"],
    id: "runner-heartbeat-expired",
    scriptsMustBeConsumed: false,
    viewport: { width: 390, height: 844 },
  },
  {
    action: "none",
    expectedText: ["Runner busy", "Checking the dispatch lease before editing.", "The lease is sound; I’m applying the change.", "Calling tools", "10s"],
    id: "runner-run-streaming",
    scriptsMustBeConsumed: false,
    verifyStreaming: true,
    verifyToolTimer: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Runner needs setup", "Fence credential revocation"],
    id: "runner-blocked-account",
    scriptsMustBeConsumed: false,
    viewport: { width: 820, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Runner needs setup", "Fence credential revocation"],
    id: "runner-blocked-credential",
    scriptsMustBeConsumed: false,
    viewport: { width: 390, height: 844 },
  },
  {
    action: "none",
    expectedText: ["Runner ready", "Fence credential revocation"],
    id: "runner-ready",
    scriptsMustBeConsumed: false,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Runner draining", "Fence credential revocation"],
    id: "runner-draining",
    scriptsMustBeConsumed: false,
    viewport: { width: 820, height: 1_000 },
  },
  {
    action: "create-race",
    expectedText: ["Runner ready", "Trace provider reconciliation drift", "Queued", "Done."],
    id: "tasks-readiness-race",
    scriptsMustBeConsumed: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "none",
    expectedText: [
      "Needs attention",
      "This attempt and its submission are immutable.",
      "Retry",
    ],
    id: "runner-worktree-failed",
    scriptsMustBeConsumed: false,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Recovery required", "Do not retry", "Resolve ambiguity"],
    id: "runner-start-ambiguous",
    scriptsMustBeConsumed: false,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "approve-interaction",
    expectedBeforeAction: [
      "Waiting for attention",
      "Allow Codex to edit files?",
      "Allow once",
      "Don’t allow",
      "Stop run",
    ],
    expectedText: ["Continuing…", "Waiting for this Mac…", "Done."],
    id: "runner-waiting-approval",
    scriptsMustBeConsumed: true,
    viewport: { width: 390, height: 844 },
  },
  {
    action: "answer-question",
    expectedBeforeAction: [
      "Which gate should run before merge?",
      "Full repository gate",
      "Narrow package gate",
      "Continue",
    ],
    expectedText: ["Continuing…", "Waiting for this Mac…", "Done."],
    id: "runner-waiting-question",
    scriptsMustBeConsumed: true,
    verifyMinimalChrome: true,
    verifyNeedsInputFirst: true,
    viewport: { width: 820, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Ready to review", "Details"],
    forbiddenControls: ["Accept", "Reject"],
    id: "tasks-review-observer",
    scriptsMustBeConsumed: false,
    viewport: { width: 820, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Task input changed", "Waiting for attention", "Stop run"],
    id: "runner-input-changed",
    scriptsMustBeConsumed: false,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Submitted for review", "Ready to review"],
    id: "runner-run-submitted",
    scriptsMustBeConsumed: false,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "stop-queued",
    expectedText: ["Cancelled", "Retry", "Done."],
    id: "runner-queued-cancel",
    scriptsMustBeConsumed: true,
    viewport: { width: 820, height: 1_000 },
  },
  {
    action: "retry",
    expectedText: ["Queued", "Stop run", "Done."],
    id: "runner-failed-retry",
    scriptsMustBeConsumed: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "retry",
    expectedText: ["Queued", "Stop run", "Done."],
    id: "runner-cancelled-retry",
    scriptsMustBeConsumed: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "resolve-ambiguity",
    expectedText: ["Cancelled", "Retry", "Done."],
    id: "runner-ambiguous-resolve",
    scriptsMustBeConsumed: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "reject",
    expectedText: ["Submission rejected", "Done."],
    id: "tasks-review-rejected",
    scriptsMustBeConsumed: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "accept-conflict",
    expectedText: ["The task changed after this view loaded.", "Command not completed", "Ready to review"],
    id: "tasks-review-conflict",
    scriptsMustBeConsumed: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "none",
    expectedText: ["Repair the stale claim projection", "Claim lease expired", "Details"],
    id: "tasks-expired-claim",
    scriptsMustBeConsumed: false,
    viewport: { width: 820, height: 1_000 },
  },
  {
    action: "create",
    expectedText: ["Trace provider reconciliation drift", "Queued", "Done."],
    id: "tasks-create-success",
    scriptsMustBeConsumed: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "create",
    expectedText: ["Trace provider reconciliation drift", "Queued", "Done."],
    id: "tasks-create-pending-isolation",
    scriptsMustBeConsumed: true,
    verifyPendingIsolation: true,
    viewport: { width: 1_440, height: 1_000 },
  },
  {
    action: "load-more",
    expectedText: ["Fence credential revocation", "Repair the stale claim projection", "Run the provider reconciliation load test", "Claim lease expired"],
    id: "tasks-pagination-scope",
    scriptsMustBeConsumed: true,
    viewport: { width: 390, height: 844 },
  },
  {
    action: "none",
    expectedText: ["Tasks", "Fence credential revocation", "Details"],
    id: "tasks-viewer-read-only",
    scriptsMustBeConsumed: false,
    verifyReadOnly: true,
    viewport: { width: 390, height: 844 },
  },
] as const satisfies readonly ScenarioDefinition[];

export function parseArguments(arguments_: readonly string[]): BrowserVerificationArguments {
  return parseBaseUrlArguments(arguments_, DEFAULT_BASE_URL);
}

export function canAutomaticallyStartServer(baseUrl: string): boolean {
  return canAutomaticallyStartLocalServer(baseUrl);
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
    const embedded = parsed.protocol === "data:";
    const assetPath = embedded
      || parsed.pathname === "/"
      || DIRECT_ROOT_ASSET_PATHS.has(parsed.pathname)
      || parsed.pathname.startsWith("/@fs/")
      || parsed.pathname.startsWith("/@id/")
      || parsed.pathname.startsWith("/@vite/")
      || parsed.pathname === "/@react-refresh"
      || parsed.pathname.startsWith("/app/")
      || parsed.pathname.startsWith("/direct/")
      || parsed.pathname.startsWith("/node_modules/");
    return (!embedded && parsed.origin !== origin)
      || request.method !== "GET"
      || request.status === undefined
      || request.status < 200
      || request.status >= 400
      || !assetPath;
  });
}

export function remainingScripts(probe: ProbeSnapshot): number {
  return probe.remainingWork.scripts.commands
    + probe.remainingWork.scripts.interactions
    + probe.remainingWork.scripts.pages;
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
    remainingWork: parseData(
      remainingWorkSchema,
      parsed.value.remainingWork,
      "Agent Tasks remaining work",
    ),
  });
}

async function clickButton(browser: AgentBrowser, label: string): Promise<void> {
  await browser.run(["find", "role", "button", "click", "--name", label]);
}

async function runAction(browser: AgentBrowser, action: ScenarioAction): Promise<void> {
  if (action === "none") return;
  if (action === "load-more") {
    await browser.run(["click", ".task-load-more__control"]);
    await browser.run(["scrollintoview", '[data-task-key="AT-45EF6GH"]']);
    await browser.run(["click", '[data-task-key="AT-45EF6GH"]']);
    return;
  }
  if (action === "approve-interaction") {
    await clickButton(browser, "Allow once");
    return;
  }
  if (action === "answer-question") {
    await browser.run(["click", '.task-interaction-option:first-child input[type="checkbox"]']);
    await browser.run(["wait", "--fn", `(() => [...document.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Continue" && !button.disabled))()`]);
    await browser.run(["scrollintoview", '.task-interaction-form button[type="submit"]']);
    await browser.run(["click", '.task-interaction-form button[type="submit"]']);
    return;
  }
  if (action === "create" || action === "create-race") {
    await clickButton(browser, "New task");
    await browser.run(["wait", "--text", "Create a task"]);
    await browser.run(["fill", '.task-editor input[maxlength="512"]', "Trace provider reconciliation drift"]);
    await browser.run(["fill", ".task-editor textarea", "Capture one deterministic control-plane regression."]);
    await browser.run(["fill", '.task-editor input[placeholder*="backend"]', "reconciliation, direct"]);
    if (action === "create-race") await browser.run(["wait", "--text", "Create and dispatch"]);
    await browser.run(["click", '.task-editor button[type="submit"]']);
    return;
  }
  if (action === "stop-queued") {
    await clickButton(browser, "Stop run run_direct_primary0001");
    return;
  }
  if (action === "retry") {
    await clickButton(browser, "Retry run run_direct_primary0001");
    return;
  }
  if (action === "resolve-ambiguity") {
    await clickButton(browser, "Resolve ambiguity");
    await browser.run(["wait", "--text", "Confirm the local run has stopped?"]);
    await clickButton(browser, "Confirm stopped");
    return;
  }
  if (action === "reject") {
    await clickButton(browser, "Reject");
    await browser.run(["wait", "--text", "Reject this submission?"]);
    await browser.run(["fill", ".task-confirm-dialog textarea", "Evidence does not prove sibling credential isolation."]);
    await clickButton(browser, "Reject submission");
    return;
  }
  await clickButton(browser, "Accept");
  await browser.run(["wait", "--text", "Accept this immutable submission?"]);
  await clickButton(browser, "Accept submission");
}

async function verifyPendingIsolation(browser: AgentBrowser, scenarioId: string): Promise<void> {
  await browser.run(["wait", "--fn", `(() => {
    const submitHost = document.querySelector('.task-editor__actions .jungle-button[data-variant="primary"]');
    return submitHost?.getAttribute('data-pending') === 'true';
  })()`]);
  const evidence = await browser.evaluate(`(() => {
    const normalizedText = (element) => (element?.textContent || "").replace(/\\s+/g, " ").trim();
    const submitHost = document.querySelector('.task-editor__actions .jungle-button[data-variant="primary"]');
    const submit = submitHost?.querySelector('button');
    const stop = document.querySelector('button[aria-label="Stop run run_direct_primary0001"]');
    const stopHost = stop?.closest('.jungle-button');
    const pendingHosts = [...document.querySelectorAll('.jungle-button[data-pending="true"]')];
    const result = {
      pendingHostCount: pendingHosts.length,
      stopDisabled: stop instanceof HTMLButtonElement
        && stop.disabled
        && stopHost?.getAttribute('data-disabled') === 'true',
      stopLabel: normalizedText(stop),
      stopPending: stop?.getAttribute('aria-busy') === 'true'
        || stopHost?.getAttribute('data-pending') === 'true',
      submitBusy: submitHost?.getAttribute('aria-busy') === 'true',
      submitLabel: normalizedText(submit),
      submitPending: submitHost?.getAttribute('data-pending') === 'true',
    };
    return {
      ...result,
      ok: result.pendingHostCount === 1
        && result.stopDisabled
        && result.stopLabel === 'Stop run'
        && !result.stopPending
        && result.submitBusy
        && result.submitLabel === 'Create and dispatch'
        && result.submitPending,
    };
  })()`);
  if (
    typeof evidence !== "object"
    || evidence === null
    || !("ok" in evidence)
    || evidence.ok !== true
  ) {
    throw new Error(`${scenarioId} leaked pending paint across controls: ${JSON.stringify(evidence)}.`);
  }
}

function assertProbe(
  probe: ProbeSnapshot,
  scenarioId: string,
  scriptsMustBeConsumed: boolean,
): void {
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
  if (scriptsMustBeConsumed && remainingScripts(probe) !== 0) {
    throw new Error(`${scenarioId} did not consume its exact scripts: ${JSON.stringify(probe.remainingWork)}`);
  }
}

async function verifyScenario(options: Readonly<{
  baseUrl: string;
  browser: AgentBrowser;
  definition: ScenarioDefinition;
  repositoryRoot: string;
  runDirectory: string;
}>): Promise<ScenarioVerification> {
  const { baseUrl, browser, definition, repositoryRoot, runDirectory } = options;
  const url = scenarioUrl(baseUrl, definition.id);
  await browser.run(["set", "viewport", String(definition.viewport.width), String(definition.viewport.height)]);
  await browser.run(["errors", "--clear"]);
  await browser.run(["console", "--clear"]);
  await browser.run(["network", "requests", "--clear"]);
  await browser.run(["open", url]);
  await browser.run(["wait", "--fn", "typeof window.__direct?.snapshot === 'function'"]);
  const authoredScenario = agentTasksDirectDefinition.scenarios.resolve(definition.id);
  if (!authoredScenario.ok) throw new Error(authoredScenario.error.message);
  const contract = await readDirectBrowserContract(browser, {
    source: "scenario",
    scenario: definition.id,
    route: authoredScenario.value.route,
  });
  await browser.run(["wait", "--fn", STABLE_PROBE_EXPRESSION]);
  for (const expected of definition.expectedBeforeAction ?? []) {
    await browser.run(["wait", "--text", expected]);
  }
  if (definition.verifyNeedsInputFirst === true) {
    const inputFirst = await browser.evaluate(`(() => {
      const rows = [...document.querySelectorAll("[data-task-key]")];
      const first = rows[0];
      const interactionRegion = document.querySelector('.task-interactions');
      const alerts = [...document.querySelectorAll('[role="alert"]')]
        .filter((element) => element.textContent?.includes("Needs your input"));
      return first instanceof HTMLElement
        && first.dataset.taskKey === "AT-12AB3CD"
        && first.dataset.needsInput === "true"
        && (first.textContent || "").includes("Needs you")
        && (first.textContent || "").includes("Which gate should run before merge?")
        && interactionRegion?.getAttribute("aria-live") === null
        && interactionRegion?.querySelector("form") !== null
        && alerts.length === 1;
    })()`);
    if (inputFirst !== true) {
      throw new Error(`${definition.id} did not place pending HITL first with quiet interactive controls.`);
    }
  }
  await runAction(browser, definition.action);
  if (definition.verifyPendingIsolation === true) {
    await verifyPendingIsolation(browser, definition.id);
  }
  await browser.run(["wait", "--fn", STABLE_PROBE_EXPRESSION]);

  const firstProbe = await readProbe(browser);
  assertProbe(firstProbe, definition.id, definition.scriptsMustBeConsumed);
  for (const expected of definition.expectedText) await browser.run(["wait", "--text", expected]);
  await Bun.sleep(200);
  const secondProbe = await readProbe(browser);
  assertProbe(secondProbe, definition.id, definition.scriptsMustBeConsumed);
  if (JSON.stringify(firstProbe) !== JSON.stringify(secondProbe)) {
    throw new Error(`${definition.id} canonical probe changed after its stability gate.`);
  }

  const body = await browser.readBodyText();
  const missing = definition.expectedText.filter((expected) => !body.includes(expected));
  if (missing.length > 0) throw new Error(`${definition.id} is missing visible text: ${missing.join(", ")}`);
  if (definition.verifyMinimalChrome === true) {
    const minimalChrome = await browser.evaluate(`(() => {
      const visible = (element) => element instanceof HTMLElement
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== "hidden";
      const details = document.querySelector(".task-advanced details");
      const visibleLegacy = [...document.querySelectorAll(".task-detail__timestamps, .task-run-phase, .task-detail .task-eyebrow")]
        .filter(visible)
        .map((element) => ({
          className: element.className,
          detailsOpen: element.closest("details")?.open ?? null,
          text: element.textContent?.trim(),
        }));
      const result = {
        details: details instanceof HTMLDetailsElement,
        detailsOpen: details instanceof HTMLDetailsElement && details.open,
        filter: document.querySelector(".task-filter.jungle-select-field") !== null,
        header: document.querySelector(".task-workspace__header h2")?.textContent?.trim() === "Tasks",
        legacyNavigation: document.querySelector(".task-view-navigation") !== null,
        visibleLegacy,
      };
      return { ...result, ok: result.details && !result.detailsOpen && result.filter && result.header && !result.legacyNavigation && result.visibleLegacy.length === 0 };
    })()`);
    if (
      typeof minimalChrome !== "object" ||
      minimalChrome === null ||
      !("ok" in minimalChrome) ||
      minimalChrome.ok !== true
    ) {
      throw new Error(`${definition.id} exposed non-minimal default chrome: ${JSON.stringify(minimalChrome)}.`);
    }
  }
  if (definition.verifyStreaming === true) {
    const streaming = await browser.evaluate(`(() => {
      const thinking = [...document.querySelectorAll('[data-stream-kind="thinking"]')];
      const response = [...document.querySelectorAll('[data-stream-kind="response"]')];
      const transcript = document.querySelector('.task-transcript');
      const announcement = document.querySelector('.task-stream-announcement');
      return thinking.length === 1
        && thinking[0]?.textContent?.includes("Checking the dispatch lease before editing.")
        && response.length === 1
        && response[0]?.textContent?.includes("The lease is sound; I’m applying the change.")
        && transcript?.getAttribute("aria-live") === null
        && announcement?.getAttribute("aria-live") === "polite"
        && announcement?.getAttribute("aria-atomic") === "true";
    })()`);
    if (streaming !== true) throw new Error(`${definition.id} did not render a coalesced bounded public display.`);
  }
  if (definition.verifyToolTimer === true) {
    const toolTimer = await browser.evaluate(`(() => {
      const indicators = [...document.querySelectorAll('[data-stream-kind="tools"]')];
      const row = document.querySelector('[data-task-key="AT-12AB3CD"] .task-list-item__live');
      return indicators.length === 1
        && indicators[0]?.textContent?.includes("Calling tools")
        && indicators[0]?.textContent?.includes("10s")
        && indicators[0]?.getAttribute("role") === null
        && indicators[0]?.querySelector('[aria-hidden="true"]')?.textContent?.includes("10s")
        && row?.textContent?.includes("Calling tools")
        && row?.textContent?.includes("10s");
    })()`);
    if (toolTimer !== true) throw new Error(`${definition.id} did not render the anonymous tool timer.`);
  }
  if ((definition.forbiddenControls?.length ?? 0) > 0) {
    const exposedControls = await browser.evaluate(`(() => {
      const forbidden = ${JSON.stringify(definition.forbiddenControls ?? [])};
      return [...document.querySelectorAll('button, input[type="submit"]')]
        .filter((element) => !element.disabled)
        .map((element) => (element.getAttribute("aria-label") || element.textContent || "").trim())
        .filter((label) => forbidden.includes(label));
    })()`);
    if (!Array.isArray(exposedControls) || exposedControls.length > 0) {
      throw new Error(`${definition.id} exposed forbidden controls: ${JSON.stringify(exposedControls)}`);
    }
  }
  const noHorizontalOverflow = await browser.evaluate(
    `(() => {
      const frame = document.querySelector(".direct-frame-only");
      const root = document.documentElement;
      const viewportWidth = root.clientWidth;
      return root.scrollWidth <= viewportWidth + 1
        && document.body.scrollWidth <= viewportWidth + 1
        && window.scrollX === 0
        && (!(frame instanceof HTMLElement) || frame.getBoundingClientRect().width <= viewportWidth + 1);
    })()`,
  );
  if (noHorizontalOverflow !== true) throw new Error(`${definition.id} overflowed horizontally.`);
  if (definition.verifyReadOnly === true) {
    const mutationControls = await browser.evaluate(`(() => {
      const readControl = ".task-filter, .task-list, .task-load-more, .task-link-card, .task-advanced summary";
      return [...document.querySelectorAll('button, input, select, textarea, [contenteditable="true"]')]
        .filter((element) => {
          const disabled = element instanceof HTMLButtonElement
            || element instanceof HTMLInputElement
            || element instanceof HTMLSelectElement
            || element instanceof HTMLTextAreaElement
            ? element.disabled
            : element.getAttribute("aria-disabled") === "true";
          return !disabled && element.closest(readControl) === null;
        })
        .map((element) => ({
          ariaLabel: element.getAttribute("aria-label"),
          tag: element.tagName.toLowerCase(),
          text: element.textContent?.trim().slice(0, 80) ?? "",
        }));
    })()`);
    if (!Array.isArray(mutationControls) || mutationControls.length > 0) {
      throw new Error(`The read-only scenario exposed enabled mutation controls: ${JSON.stringify(mutationControls)}`);
    }
  }

  const browserErrors = parseData(browserErrorsSchema, await browser.run(["errors"]), "browser errors").errors;
  if (browserErrors.length > 0) {
    throw new Error(`${definition.id} reported page errors: ${browserErrors.map(renderUnknown).join("; ")}`);
  }
  const messages = parseData(consoleSchema, await browser.run(["console"]), "browser console").messages;
  const consoleFailures = messages.filter(({ type }) => type === "error" || type === "assert");
  if (consoleFailures.length > 0) {
    throw new Error(`${definition.id} reported console failures: ${consoleFailures.map(({ type, text }) => `${type}: ${text}`).join("; ")}`);
  }
  const network = parseData(networkSchema, await browser.run(["network", "requests"]), "browser network").requests;
  const rejected = externalOrFailedRequests(network, baseUrl);
  if (rejected.length > 0) {
    throw new Error(`${definition.id} made failed, mutating, or external requests: ${JSON.stringify(rejected)}`);
  }

  const screenshotPath = join(runDirectory, `${definition.id}.png`);
  await browser.run(["screenshot", screenshotPath]);
  if ((await stat(screenshotPath)).size < 1_024) throw new Error(`${definition.id} screenshot is unexpectedly small.`);
  const finalContract = bindDirectBrowserContractEvidence(
    contract,
    await readDirectBrowserContract(browser, {
      source: "scenario",
      scenario: definition.id,
      route: authoredScenario.value.route,
    }),
    secondProbe,
  );
  return {
    evidence: {
      active: finalContract.manifest.active,
      catalogHash: finalContract.manifest.catalogHash,
      expectedBeforeAction: definition.expectedBeforeAction ?? [],
      expectedText: definition.expectedText,
      id: definition.id,
      networkRequests: network.length,
      probe: secondProbe,
      screenshot: relative(repositoryRoot, screenshotPath),
      url,
    },
    manifest: finalContract.manifest,
  };
}

export function directServerCommand(workspaceRoot: string, port: string): readonly string[] {
  return Object.freeze([
    join(workspaceRoot, "node_modules/.bin/vite"),
    "--config",
    "direct/vite.config.ts",
    "--port",
    port,
  ]);
}

function startServer(repositoryRoot: string, baseUrl: string) {
  const port = new URL(baseUrl).port || "80";
  const workspaceRoot = join(repositoryRoot, "apps/web");
  return spawnVerificationServer({
    command: directServerCommand(workspaceRoot, port),
    cwd: workspaceRoot,
    env: { CI: "1" },
  });
}

async function run(repositoryRoot: string, baseUrl: string): Promise<string> {
  const artifactRun = await createArtifactRun({
    artifactRoot: join(repositoryRoot, "artifacts/direct/hra-web"),
  });
  const server = await acquireVerificationServer({
    baseUrl,
    label: "Agent Tasks Direct server",
    reuseExistingLocalServer: false,
    startupTimeoutMs: SERVER_START_TIMEOUT_MS,
    startServer: () => startServer(repositoryRoot, baseUrl),
  });
  const browser = createAgentBrowser({ repositoryRoot, sessionPrefix: "atc" });
  const evidence: ScenarioEvidence[] = [];
  const sessionManifests: DirectBrowserContract["manifest"][] = [];
  let failure: unknown = null;
  let coverage: readonly CoverageEntry[] = [];
  try {
    for (const definition of scenarios) {
      console.log(`Verifying ${definition.id}...`);
      const verified = await verifyScenario({
        baseUrl,
        browser,
        definition,
        repositoryRoot,
        runDirectory: artifactRun.runDirectory,
      });
      evidence.push(verified.evidence);
      sessionManifests.push(verified.manifest);
    }
    const parsedCoverage = parseDefinitionCoverageSnapshot(
      bindDirectScenarioCatalog(sessionManifests),
      agentTasksDirectDefinition,
    );
    if (!parsedCoverage.ok) {
      throw new Error(`coverage catalog is invalid: ${parsedCoverage.error.message}`);
    }
    coverage = parsedCoverage.value.entries;
    const coverageViolations = coveragePolicyViolations(
      coverage,
      new Set(agentTasksDirectDefinition.scenarios.list().map(({ id }) => String(id))),
      new Set(evidence.map(({ id }) => id)),
    );
    if (coverageViolations.length > 0) {
      throw new Error(`Coverage policy failed: ${coverageViolations.join("; ")}`);
    }
    const cited = new Set(coverage.flatMap(({ scenarios: ids }) => ids.map(String)));
    const uncited = evidence.map(({ id }) => id).filter((id) => !cited.has(id));
    if (uncited.length > 0) throw new Error(`Coverage does not cite verified scenarios: ${uncited.join(", ")}`);
    if (!coverage.some(({ mode }) => mode === "direct")) {
      throw new Error("Coverage must keep provider and production-backend evidence explicit.");
    }
  } catch (reason) {
    failure = reason;
  }

  const cleanupFailures: unknown[] = [];
  try { await browser.close(); } catch (reason) { cleanupFailures.push(reason); }
  if (server.source === "started") {
    try { await stopVerificationServer(server.server); } catch (reason) { cleanupFailures.push(reason); }
  }
  if (failure !== null || cleanupFailures.length > 0) {
    throw new AggregateError(
      failure === null ? cleanupFailures : [failure, ...cleanupFailures],
      `Agent Tasks browser verification failed: ${renderUnknown(failure ?? cleanupFailures[0])}`,
    );
  }

  await writeJsonAtomically(artifactRun.manifestPath, {
    $schema: "hra.direct.web-verification/v1",
    baseUrl,
    coverage,
    coverageResults: coverage.map((entry) => ({
      key: entry.key,
      result: classifyCoverageEvidence(entry, {
        exercisedScenarios: new Set(evidence.map(({ id }) => id)),
      }),
      scenarios: entry.scenarios,
    })),
    generatedAt: artifactRun.generatedAt,
    product: "hra-web",
    scenarios: evidence,
    server: server.source,
  });
  return artifactRun.manifestPath;
}

function usage(): string {
  return [
    "Usage: bun run direct/verify-browser.ts [--base-url URL]",
    "",
    `Default URL: ${DEFAULT_BASE_URL}`,
    "Reuses a reachable server or starts and stops the isolated Agent Tasks Vite lab.",
  ].join("\n");
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.kind === "help") {
    console.log(usage());
    return;
  }
  const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const manifest = await run(repositoryRoot, arguments_.baseUrl);
  console.log(`Agent Tasks Direct browser verification passed. Manifest: ${manifest}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (reason) {
    console.error(reason instanceof Error ? reason.message : String(reason));
    process.exitCode = 1;
  }
}
