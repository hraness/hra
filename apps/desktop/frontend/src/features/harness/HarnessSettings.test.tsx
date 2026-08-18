import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { emptyRuntimeSnapshot } from "../../runtime/test-fixtures";
import type { RuntimeShell, RuntimeShellState } from "../../runtime";
import { selectHarness, selectRuntimeAvailability } from "../chat/model";
import {
  harnessSettingsMutationEnabled,
  HarnessSettings,
} from "./HarnessSettings";

function shellWith(snapshot = emptyRuntimeSnapshot()): RuntimeShell {
  return {
    getSnapshot: () => ({ state: "ready" as const, snapshot }),
    subscribe: () => () => undefined,
  } as unknown as RuntimeShell;
}

test("harness settings explains recursive work and review-only refinement", async () => {
  const source = await Bun.file(new URL("./HarnessSettings.tsx", import.meta.url)).text();

  expect(source).toContain("<SwitchField");
  expect(source).toContain('label="Recursive sessions"');
  expect(source).toContain("Allow Codex to delegate work to persistent child sessions.");
  expect(source).not.toContain('controlClassName="harness-switch"');
  expect(source).not.toContain("<button");
  expect(source).toContain('label="Context quota"');
  expect(source).not.toContain("automaticFastMode");
  expect(source).not.toContain("Automatic Fast");
  expect(source).toContain("Array.from({ length: 64 }");
  expect(source).toContain("<strong>Refinement suggestions</strong>");
  expect(source).toContain("review-only improvement proposals");
  expect(source).toContain("never applies them automatically");
  expect(source).toContain('["off", "suggest"]');
  expect(source).toContain('(mode === "suggest" && !harness.settings.recursiveSessionsEnabled)');
  expect(source).toContain('{ refinementMode: "off" as const }');
  expect(source).not.toMatch(/canary|decide|reject|rollback/iu);
  expect(source).not.toMatch(/dataPreview|data\.preview|data\.delete|tree\.stop|goal/iu);
  expect(source).not.toMatch(/providerId|threadId|filesystemPath|transcript|heapValue/iu);
});

test("ordinary products with no harness projection receive zero settings chrome", () => {
  expect(renderToStaticMarkup(createElement(HarnessSettings, {
    shell: shellWith(),
  }))).toBe("");
});

test("the compact native quota select retains its shared dropdown affordance", async () => {
  const css = await Bun.file(new URL("../../index.css", import.meta.url)).text();
  const rule = css.match(/\.harness-quota select\s*\{(?<body>[^}]*)\}/u)?.groups?.body;

  expect(rule).toContain("background-color: var(--surface-raised)");
  expect(rule).not.toMatch(/(?:^|;)\s*background\s*:/u);
});

test("maps proposal titles into a read-only list without action controls", async () => {
  const source = await Bun.file(new URL("./HarnessSettings.tsx", import.meta.url)).text();
  expect(source).toContain('aria-label="Harness proposals"');
  expect(source).toContain("harness.proposals.map((proposal)");
  expect(source).toContain("<span>{proposal.title}</span>");
  expect(source).not.toMatch(/reviewHarness|decideHarness|candidateId/iu);
});

test("retained harness state never authorizes mutation while the runtime is unavailable", () => {
  const snapshot = {
    ...emptyRuntimeSnapshot(),
    harness: {
      revision: 1,
      settings: {
        revision: 1,
        recursiveSessionsEnabled: true,
        contextQuotaBytes: 8 * 1024 * 1024,
        refinementMode: "suggest" as const,
      },
      proposals: [],
    },
  };
  const states: readonly RuntimeShellState[] = [
    { state: "reconnecting", snapshot, gap: null },
    {
      state: "failed",
      snapshot,
      failure: {
        kind: "transport",
        message: "Runtime unavailable",
        canRetry: true,
      },
    },
  ];

  for (const state of states) {
    expect(selectHarness(state)).toBe(snapshot.harness);
    expect(harnessSettingsMutationEnabled(selectRuntimeAvailability(state))).toBe(false);
  }
  expect(harnessSettingsMutationEnabled(selectRuntimeAvailability({
    state: "ready",
    snapshot,
  }))).toBe(true);
});
