import { describe, expect, test } from "bun:test";
import {
  createCoverageCatalogSnapshot,
} from "@hraness/direct/core";
import { parseDefinitionCoverageSnapshot } from "@hraness/direct/testing";

import {
  browserJourneyScenarioRequirements,
  browserJourneyScenarioIds,
  canAutomaticallyStartServer,
  coveragePolicyViolations,
  directServerCommand,
  externalOrFailedRequests,
  parseArguments,
  parseHRADirectRemainingWork,
  parallelComposerFailures,
  parallelPerformanceFailures,
  remainingWorkViolations,
  responsiveLayoutFailures,
} from "./verify-browser";
import {
  hraDirectDefinition,
  parallelFirstRenderBudgetMs,
  parallelScriptedDeltaCount,
  parallelSettlementBudgetMs,
  parallelStreamPaneCount,
  parallelStreamRounds,
} from "./scenarios";

const surfaceLabels = [
  "outer Direct frame",
  "app frame",
  "app header",
  "main content",
] as const;

function surfaces(width: number) {
  return surfaceLabels.map((label) => ({
    clientWidth: width,
    label,
    left: 0,
    right: width,
    scrollWidth: width,
  }));
}

describe("HRA browser verifier policy", () => {
  test("normalizes a credential-free origin and rejects ambiguous arguments", () => {
    expect(parseArguments([])).toEqual({ kind: "run", baseUrl: "http://127.0.0.1:5174" });
    expect(parseArguments(["--base-url", "https://fixtures.example/"])).toEqual({
      kind: "run",
      baseUrl: "https://fixtures.example",
    });
    expect(parseArguments(["--help"])).toEqual({ kind: "help" });
    expect(() => parseArguments(["--base-url", "https://user:secret@example.com"])).toThrow(
      "cannot contain credentials",
    );
    expect(() => parseArguments(["--unknown"])).toThrow("Unknown argument");
  });

  test("owns the Vite listener directly instead of a package-script wrapper", () => {
    expect(directServerCommand("/repo/apps/desktop", "5174")).toEqual([
      "/repo/apps/desktop/node_modules/.bin/vite",
      "--config",
      "frontend/direct/vite.config.ts",
      "--port",
      "5174",
    ]);
  });

  test("accepts only successful same-origin GET requests", () => {
    const requests = [
      { method: "GET", status: 200, url: "http://127.0.0.1:5174/main.tsx" },
      {
        method: "GET",
        status: 200,
        url: "http://127.0.0.1:5174/compact-chat-surface.tsx",
      },
      { method: "GET", status: 399, url: "http://127.0.0.1:5174/@vite/client" },
      {
        method: "GET",
        status: 200,
        url: "blob:http://127.0.0.1:5174/fixture-preview",
      },
      {
        method: "POST",
        status: 200,
        url: "blob:http://127.0.0.1:5174/non-get-preview",
      },
      {
        method: "GET",
        status: 404,
        url: "blob:http://127.0.0.1:5174/missing-preview",
      },
      {
        method: "GET",
        status: 200,
        url: "blob:https://fixtures.example/foreign-preview",
      },
      { method: "GET", status: 200, url: "blob:not-an-origin" },
      { method: "GET", status: 200, url: "data:image/png;base64,AA==" },
      { method: "GET", status: 200, url: "http://127.0.0.1:5174/api/unmapped" },
      { method: "POST", status: 200, url: "http://127.0.0.1:5174/api" },
      { method: "GET", status: 404, url: "http://127.0.0.1:5174/missing" },
      { method: "GET", status: 200, url: "https://deployment.convex.cloud/query" },
      { method: "GET", url: "http://127.0.0.1:5174/unresolved" },
      { method: "GET", status: 199, url: "http://127.0.0.1:5174/informational" },
    ];

    expect(externalOrFailedRequests(requests, "http://127.0.0.1:5174")).toEqual(
      requests.slice(4),
    );
  });

  test("requires every non-direct coverage scenario to have browser evidence", () => {
    const known = new Set(["chat-draft"]);
    expect(coveragePolicyViolations([
      { claim: "Rendered UI", key: "fixture", mode: "fixture", scenarios: ["chat-draft"] },
      { claim: "Native host", key: "direct", mode: "direct", scenarios: [] },
    ], known, known)).toEqual([]);
    expect(coveragePolicyViolations([
      { claim: "Missing run", key: "fixture", mode: "fixture", scenarios: ["chat-draft"] },
      { claim: "Bad direct", key: "direct", mode: "direct", scenarios: ["chat-draft"] },
      { claim: "Missing scenario", key: "mixed-empty", mode: "mixed", scenarios: [] },
      { claim: "Unknown", key: "unknown", mode: "mixed", scenarios: ["missing"] },
    ], known, new Set())).toEqual([
      "fixture: scenario chat-draft was not browser-verified",
      "direct: direct evidence must not cite fixture scenarios",
      "mixed-empty: mixed evidence requires a scenario",
      "unknown: unknown scenario missing",
    ]);
  });

  test("browser journey exactly covers the authored pane and settings evidence", () => {
    const authored = [...new Set(
      createCoverageCatalogSnapshot(hraDirectDefinition.coverage).entries
        .filter(({ mode }) => mode !== "direct")
        .flatMap(({ scenarios }) => scenarios),
    )].sort();
    expect([...browserJourneyScenarioIds].map(String).sort()).toEqual(
      authored.map(String),
    );
    expect(new Set(browserJourneyScenarioIds).size).toBe(browserJourneyScenarioIds.length);
  });

  test("renders compact journeys below both breakpoints with scaled primary controls", () => {
    const minimumScale = browserJourneyScenarioRequirements.find(({ id }) => id === "chat-draft");
    const compact320 = browserJourneyScenarioRequirements.find(({ id }) => id === "chat-compact-320");
    const compact639 = browserJourneyScenarioRequirements.find(({ id }) => id === "chat-compact-639");
    const compact415 = browserJourneyScenarioRequirements.find(({ id }) => id === "chat-compact-415");
    const malleable = browserJourneyScenarioRequirements.find(
      ({ id }) => id === "chat-compact-malleable",
    );
    expect(minimumScale).toEqual({
      expectedUiScale: "0.8",
      expectedVisibleControls: [
        "New pane",
        "More actions for Direct pane",
      ],
      id: "chat-draft",
      viewport: { width: 1_120, height: 780 },
    });
    expect(compact320).toEqual({
      expectedUiScale: "1",
      expectedVisibleControls: [
        "New pane",
        "More actions for Compact routed response",
        "Send",
      ],
      id: "chat-compact-320",
      viewport: { width: 320, height: 720 },
    });
    expect(compact639).toEqual({
      expectedUiScale: "1.2",
      expectedVisibleControls: [
        "New pane",
        "More actions for Compact 639",
        "Send",
      ],
      id: "chat-compact-639",
      viewport: { width: 639, height: 820 },
    });
    expect(compact415).toEqual({
      expectedUiScale: "1.5",
      expectedVisibleControls: [
        "New pane",
        "More actions for Compact 415",
        "Send",
      ],
      id: "chat-compact-415",
      viewport: { width: 415, height: 780 },
    });
    expect(malleable).toEqual({
      expectedUiScale: "2",
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
      id: "chat-compact-malleable",
      viewport: { width: 390, height: 844 },
    });
  });

  test("proves account actions and explicit HRA Cloud sign-in through accessible names", () => {
    expect(
      browserJourneyScenarioRequirements.find(({ id }) => id === "settings-browser-login"),
    ).toEqual({
      expectedUiScale: "1",
      expectedVisibleControls: [
        "Add subscription",
        "Open sign-in for Personal",
        "Cancel sign-in for Personal",
        "Log out Work",
        "Open sign-in for Codex 3",
        "Cancel sign-in for Codex 3",
        "Pair this Mac with HRA Cloud",
      ],
      id: "settings-browser-login",
      viewport: { width: 860, height: 780 },
    });
  });

  test("binds human credential recovery to retry, explicit consent, and fresh sign-in", () => {
    expect(
      browserJourneyScenarioRequirements.find(
        ({ id }) => id === "settings-human-credential-recovery",
      ),
    ).toEqual({
      expectedUiScale: "1",
      expectedVisibleControls: [
        "Add subscription",
        "Cancel HRA Cloud pairing",
      ],
      id: "settings-human-credential-recovery",
      viewport: { width: 860, height: 780 },
    });
  });

  test("keeps unshipped sync administration fail-closed in the active-device journey", () => {
    expect(
      browserJourneyScenarioRequirements.find(({ id }) => id === "settings-session-sync-active"),
    ).toEqual({
      expectedUiScale: "1",
      expectedVisibleControls: ["Enable encrypted sync"],
      id: "settings-session-sync-active",
      viewport: { width: 860, height: 780 },
    });
  });

  test("binds browser coverage exactly to authored entries, modes, and claims", () => {
    const expected = createCoverageCatalogSnapshot(hraDirectDefinition.coverage);
    const deletion = { ...expected, entries: expected.entries.slice(1) };
    const modeDrift = {
      ...expected,
      entries: expected.entries.map((entry, index) => index === 0
        ? { ...entry, mode: entry.mode === "fixture" ? "mixed" : "fixture" }
        : entry),
    };
    const claimDrift = {
      ...expected,
      entries: expected.entries.map((entry, index) => index === 0
        ? { ...entry, claim: `${entry.claim} Drifted.` }
        : entry),
    };

    expect(parseDefinitionCoverageSnapshot(expected, hraDirectDefinition)).toEqual({
      ok: true,
      value: expected,
    });
    for (const drifted of [deletion, modeDrift, claimDrift]) {
      expect(parseDefinitionCoverageSnapshot(drifted, hraDirectDefinition)).toMatchObject({
        ok: false,
        error: { code: "coverage-mismatch" },
      });
    }
  });

  test("strictly parses and rejects disposed or non-quiescent product work", () => {
    const quiet = {
      cancelledScriptedEvents: 0,
      disposed: false,
      pendingSnapshotTransfers: 0,
      scriptedEvents: 0,
      snapshotReads: 2,
    };

    expect(parseHRADirectRemainingWork(quiet)).toEqual(quiet);
    expect(remainingWorkViolations(quiet)).toEqual([]);
    expect(() => parseHRADirectRemainingWork({ ...quiet, unexpected: 0 })).toThrow(
      "HRA Direct remaining work is invalid",
    );
    expect(() => parseHRADirectRemainingWork({ ...quiet, scriptedEvents: -1 })).toThrow(
      "HRA Direct remaining work is invalid",
    );
    expect(remainingWorkViolations({
      ...quiet,
      cancelledScriptedEvents: 1,
      disposed: true,
      pendingSnapshotTransfers: 2,
      scriptedEvents: 3,
    })).toEqual([
      "deterministic transport is disposed",
      "pendingSnapshotTransfers must be zero, received 2",
      "scriptedEvents must be zero, received 3",
      "cancelledScriptedEvents must be zero, received 1",
    ]);
  });

  test("auto-starts only on the configured local IPv4-compatible origins", () => {
    expect(canAutomaticallyStartServer("http://127.0.0.1:5174")).toBeTrue();
    expect(canAutomaticallyStartServer("http://localhost:5174")).toBeTrue();
    expect(canAutomaticallyStartServer("http://[::1]:5174")).toBeFalse();
    expect(canAutomaticallyStartServer("https://127.0.0.1:5174")).toBeFalse();
    expect(canAutomaticallyStartServer("http://fixtures.example:5174")).toBeFalse();
  });

  test("reports document overflow, viewport escape, and undersized consumer controls", () => {
    expect(responsiveLayoutFailures({
      ariaHiddenFocusableControls: [],
      clientHeight: 720,
      clientWidth: 480,
      scrollWidth: 520,
      scrollX: 2,
      surfaces: surfaces(480).map((surface) => surface.label === "app header"
        ? { ...surface, clientWidth: 464, right: 500, scrollWidth: 500 }
        : surface),
      controls: [
        { label: "New account", left: 16, right: 464, top: 20, bottom: 64, height: 44 },
        { label: "Tiny control", left: 450, right: 494, top: 20, bottom: 40, height: 20 },
      ],
    })).toEqual([
      "document is 40px wider than its viewport",
      "window is horizontally scrolled by 2px",
      "app header leaves the horizontal viewport",
      "Tiny control leaves the horizontal viewport",
      "Tiny control is only 20px tall",
    ]);
    expect(responsiveLayoutFailures({
      ariaHiddenFocusableControls: [],
      clientHeight: 720,
      clientWidth: 480,
      scrollWidth: 480,
      scrollX: 0,
      surfaces: surfaces(480),
      controls: [{ label: "New account", left: 16, right: 464, top: 20, bottom: 64, height: 44 }],
    })).toEqual([]);
    expect(responsiveLayoutFailures({
      ariaHiddenFocusableControls: ["Unexpected hidden action"],
      clientHeight: 720,
      clientWidth: 480,
      scrollWidth: 480,
      scrollX: 0,
      surfaces: surfaces(480),
      controls: [],
    })).toEqual([
      "Unexpected hidden action is focusable inside an aria-hidden subtree",
    ]);
    expect(responsiveLayoutFailures({
      ariaHiddenFocusableControls: [],
      clientHeight: 720,
      clientWidth: 480,
      scrollWidth: 480,
      scrollX: 0,
      surfaces: surfaces(480),
      controls: [{ label: "Touch action", left: 16, right: 60, top: 20, bottom: 60, height: 40 }],
    }, undefined, undefined, 44)).toEqual([
      "Touch action is only 40px tall",
    ]);
  });

  test("ignores contained component paint overscan while semantic boxes remain responsive", () => {
    expect(responsiveLayoutFailures({
      ariaHiddenFocusableControls: [],
      clientHeight: 720,
      clientWidth: 720,
      scrollWidth: 720,
      scrollX: 0,
      surfaces: surfaces(720).map((surface) => ({
        ...surface,
        scrollWidth: surface.label === "main content" ? surface.clientWidth + 48 : surface.clientWidth + 24,
      })),
      controls: [{ label: "New pane", left: 648, right: 696, top: 14, bottom: 62, height: 48 }],
    })).toEqual([]);
  });

  test("requires the primary action inside the initial vertical viewport", () => {
    const primaryControl = {
      label: "Add subscription",
      left: 166,
      right: 372,
      top: 612,
      bottom: 660,
      height: 48,
    };
    const measurement = {
      ariaHiddenFocusableControls: [],
      clientHeight: 640,
      clientWidth: 720,
      scrollWidth: 720,
      scrollX: 0,
      surfaces: surfaces(720),
      controls: [primaryControl],
    };

    expect(responsiveLayoutFailures(measurement, "Add subscription")).toEqual([
      "Add subscription is outside the initial vertical viewport",
    ]);
    expect(responsiveLayoutFailures(measurement, "New pane")).toEqual([
      "New pane is missing from the rendered controls",
    ]);
    expect(responsiveLayoutFailures({
      ...measurement,
      controls: [{ ...primaryControl, top: 560, bottom: 608 }],
    }, "Add subscription")).toEqual([]);
  });

  test("measures static titles without padded wrappers or retired model controls", async () => {
    const source = await Bun.file(new URL("./verify-browser.ts", import.meta.url)).text();

    expect(source).not.toContain("element.closest('.chat-pane__identity')");
    expect(source).not.toContain(".model-toggle");
    expect(source).not.toContain("!element.matches('.hra-wordmark')");
    expect(source).not.toContain(".pane-title-button:disabled");
    expect(source).toContain(".pane-title");
  });

  test("dispatches a real touch pointer event to the product-owned summary control", async () => {
    const source = await Bun.file(new URL("./verify-browser.ts", import.meta.url)).text();

    expect(source).not.toContain("data-verification-pointer");
    expect(source).toContain("new PointerEvent('pointerdown'");
    expect(source).toContain("pointerType: 'touch'");
    expect(source).toContain("dispatchCancelled: true");
    expect(source).toContain("height: 44");
    expect(source).toContain("width: 44");
    expect(source).toContain("assertRemoteSummaryWindow(firstWindow, 0)");
    expect(source).toContain("assertRemoteSummaryWindow(secondWindow, 48)");
    expect(source).toContain("assertRemoteSummaryWindow(restoredFirstWindow, 0)");
    expect(source).toContain("Remote session: $" + "{title}");
    expect(source).toContain(
      "collisionLine: uniqueCollisionLines[0]?.value ?? `Position $" +
        "{String(cell)}`",
    );
    expect(source).not.toContain('["set", "device"');
  });

  test("requires sustained bounded parallel deltas and unchanged mounted remote subtrees", () => {
    const passing = {
      exactResponsePaneCount: parallelStreamPaneCount,
      firstStreamMutationMs: parallelFirstRenderBudgetMs - 1,
      mismatchedResponsePaneIds: [],
      remoteIdentitiesPreserved: true,
      remoteMutationCount: 0,
      remotePaneCount: 48,
      remotePanesConnected: true,
      remoteTextPreserved: true,
      scriptedDeltaCount: parallelScriptedDeltaCount,
      settlementMs: parallelSettlementBudgetMs - 1,
      streamMutationCount: parallelScriptedDeltaCount,
      streamMutationBatchCount: parallelStreamRounds,
      streamPaneCount: parallelStreamPaneCount,
      updatedStreamPaneCount: parallelStreamPaneCount,
    };
    expect(parallelPerformanceFailures(passing)).toEqual([]);
    expect(parallelPerformanceFailures({
      ...passing,
      firstStreamMutationMs: parallelFirstRenderBudgetMs + 1,
    })).toEqual([
      "first streaming render took 2501ms; budget is 2500ms",
    ]);
    expect(parallelPerformanceFailures({
      ...passing,
      firstStreamMutationMs: null,
      exactResponsePaneCount: parallelStreamPaneCount - 1,
      mismatchedResponsePaneIds: ["pane_live_lane_23"],
      remoteIdentitiesPreserved: false,
      remoteMutationCount: 2,
      remotePaneCount: 47,
      remotePanesConnected: false,
      remoteTextPreserved: false,
      scriptedDeltaCount: parallelScriptedDeltaCount - 1,
      settlementMs: parallelSettlementBudgetMs + 1,
      streamMutationCount: 0,
      streamMutationBatchCount: 1,
      updatedStreamPaneCount: parallelStreamPaneCount - 1,
    })).toEqual([
      `expected ${String(parallelScriptedDeltaCount)} scripted deltas, received ${String(parallelScriptedDeltaCount - 1)}`,
      `${String(parallelStreamPaneCount - 1)} of ${String(parallelStreamPaneCount)} streaming panes rendered their scripted deltas`,
      `${String(parallelStreamPaneCount - 1)} of ${String(parallelStreamPaneCount)} streaming panes rendered their exact full response; mismatches: pane_live_lane_23`,
      `streaming pane subtrees recorded 0 mutations for ${String(parallelScriptedDeltaCount - 1)} deltas`,
      `streaming panes settled in only 1 mutation batches; expected at least ${String(parallelStreamRounds)}`,
      "streaming panes never rendered a first mutation",
      "parallel streaming settled in 4001ms; budget is 4000ms",
      "expected 48 mounted remote panes, received 47",
      "the mounted remote panes did not preserve their connected DOM identities",
      "the mounted remote panes changed during parallel streaming (2 mutations)",
    ]);
  });

  test("keeps all parallel composers queueable while empty sends remain disabled", () => {
    const passing = {
      composerCount: parallelStreamPaneCount,
      disabledComposerCount: 0,
      disabledSendButtonCount: parallelStreamPaneCount,
    };

    expect(parallelComposerFailures(passing)).toEqual([]);
    expect(parallelComposerFailures({
      ...passing,
      composerCount: parallelStreamPaneCount - 1,
      disabledComposerCount: 1,
      disabledSendButtonCount: parallelStreamPaneCount - 1,
    })).toEqual([
      `expected ${String(parallelStreamPaneCount)} active composers, received ${String(parallelStreamPaneCount - 1)}`,
      `1 of ${String(parallelStreamPaneCount)} parallel active composers are disabled`,
      `expected ${String(parallelStreamPaneCount)} disabled empty send controls, received ${String(parallelStreamPaneCount - 1)}`,
    ]);
  });
});
