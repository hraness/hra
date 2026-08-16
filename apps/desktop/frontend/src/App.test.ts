import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  runtimeProtocolVersion,
  type RuntimeDispatchResponse,
} from "../../contracts/runtime";
import App, { focusMainContent, inheritedRepositoryIsUnavailable } from "./App";
import { chatRouteFromHash, chatRouteHash } from "./features/chat/model";

function relativeLuminance(hex: string): number {
  const [red = 0, green = 0, blue = 0] = hex.match(/[0-9a-f]{2}/giu)
    ?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
  const linear = (channel: number) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test("the desktop product is a lean panes and settings shell", () => {
  const html = renderToStaticMarkup(createElement(App, {
    runtimeShellFactory: () => null,
  }));

  expect(html).toContain("HRA");
  expect(html).toContain('class="hra-visually-hidden"');
  expect(html).not.toContain("hra-wordmark");
  expect(html).toContain('href="#settings"');
  expect(html).toContain("Settings");
  expect(html).toContain('aria-label="New pane"');
  expect(html).toContain('class="hra-icon"');
  expect(html).not.toContain("new-pane-button__label");
  expect(html).toContain("Starting HRA");
  expect(html).not.toContain("Tasks");
  expect(html).not.toContain("Workspaces");
  expect(html).not.toContain("Cloud sync");
  expect(html).not.toContain("Queue");
  expect(html).not.toContain("Steer");
});

test("only the two canonical product hashes are addressable", () => {
  expect(chatRouteFromHash("#panes")).toBe("panes");
  expect(chatRouteFromHash("#settings")).toBe("settings");
  expect(chatRouteFromHash("")).toBe("panes");
  expect(chatRouteFromHash("#unknown")).toBe("panes");
  expect(chatRouteHash("panes")).toBe("#panes");
  expect(chatRouteHash("settings")).toBe("#settings");
});

test("each product route owns one route-specific level-one heading", async () => {
  const app = await Bun.file(new URL("./App.tsx", import.meta.url)).text();
  const settings = await Bun.file(
    new URL("./features/accounts/SubscriptionsSettings.tsx", import.meta.url),
  ).text();

  expect(app).toContain('<h1 className="hra-visually-hidden">Sessions</h1>');
  expect(app).toContain('<h1 className="hra-visually-hidden">Settings</h1>');
  expect(settings).toContain('<h2 id="subscriptions-title">Codex subscriptions</h2>');
  expect(settings).not.toContain('<h1 id="subscriptions-title">');
});

test("the main content target can be focused without changing the product route", () => {
  let focused = false;
  expect(focusMainContent({
    getElementById: (id) => id === "main-content" ? ({
      focus: () => { focused = true; },
    } as unknown as HTMLElement) : null,
  })).toBeTrue();
  expect(focused).toBeTrue();
  expect(focusMainContent({ getElementById: () => null })).toBeFalse();
});

test("the pane grid is square, auto-filling, contained, and locally scrollable", async () => {
  const css = await Bun.file(new URL("./index.css", import.meta.url)).text();

  expect(css).toContain("grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 22rem))");
  expect(css).toMatch(/\.chat-pane\s*\{[^}]*aspect-ratio:\s*1;/su);
  const paneRule = /\.chat-pane\s*\{[^}]*\}/su.exec(css)?.[0] ?? "";
  expect(paneRule).not.toContain("height: calc(100svh");
  expect(css).toMatch(/\.chat-pane\s*\{[^}]*contain:\s*layout paint style;[^}]*content-visibility:\s*auto;/su);
  expect(css).toMatch(/\.chat-pane__transcript\s*\{[^}]*overflow:\s*auto;[^}]*overscroll-behavior:\s*contain;/su);
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
});

test("every visible product interactive retains a 24px floor at minimum UI scale", async () => {
  const css = await Bun.file(new URL("./index.css", import.meta.url)).text();

  expect(css).toContain("--interactive-min-height: 24px;");
  expect(css).toMatch(
    /:where\(\s*body\[data-hra-surface="product"\] button,\s*body\[data-hra-surface="product"\] input,\s*body\[data-hra-surface="product"\] select,\s*body\[data-hra-surface="product"\] textarea\s*\)\s*\{[^}]*min-height:\s*var\(--interactive-min-height\);/su,
  );
  expect(css).toMatch(
    /\.hra-skip-link,\s*\.hra-nav a\s*\{[^}]*min-height:\s*var\(--interactive-min-height\);/su,
  );
  expect(css).toMatch(
    /\.new-pane-button,\s*\.settings-add,\s*\.pane-send,\s*\.pane-retry\s*\{[^}]*min-height:\s*max\(1\.85rem,\s*var\(--interactive-min-height\)\);/su,
  );
  expect(css).toMatch(
    /\.pane-title,\s*\.pane-title-input\s*\{[^}]*min-height:\s*max\(1\.5rem,\s*var\(--interactive-min-height\)\);/su,
  );
  expect(css).toMatch(
    /\.pane-menu,\s*\.pane-project,\s*\.pane-title-save\s*\{[^}]*min-height:\s*var\(--interactive-min-height\);/su,
  );
  expect(css).not.toContain(".subscription-select");
  expect(css).toMatch(
    /\.model-toggle__option\s*\{[^}]*min-height:\s*max\(1\.5rem,\s*var\(--interactive-min-height\)\);/su,
  );
  expect(css).toMatch(
    /\.settings-note button,\s*\.subscription-actions button\s*\{[^}]*min-height:\s*var\(--interactive-min-height\);/su,
  );
  expect(css).toMatch(
    /\.chat-markdown__content a\s*\{[^}]*padding-block:\s*max\(0px,\s*calc\(12px - 0\.5em\)\);[^}]*line-height:\s*max\(1\.62em,\s*var\(--interactive-min-height\)\);/su,
  );
});

test("pane title editing writes each draft once and fences pending destinations", async () => {
  const source = await Bun.file(
    new URL("./features/chat/ChatPane.tsx", import.meta.url),
  ).text();

  expect(source.match(/setDraft\(value\);/gu)).toHaveLength(1);
  expect(source).toContain("onActivateAnnouncement();");
  expect(source).toContain("fenceTitlePendingInteraction(event);");
  expect(source).toContain("onClickCapture={fenceTitlePendingInteraction}");
  expect(source).toContain("onChangeCapture={fenceTitlePendingInteraction}");
  expect(source).toContain("onSubmitCapture={fenceTitlePendingInteraction}");
  expect(source).toContain('aria-label="Save pane title"');
  expect(source).toContain("onPointerDown={(event) => event.preventDefault()}");
  expect(source).toContain("finishEdit();");
  expect(source).toContain("onPress={finishEdit}");
});

test("pane activity uses one semantic border and user messages reset it to neutral", async () => {
  const css = await Bun.file(new URL("./index.css", import.meta.url)).text();
  expect(css).toMatch(/data-pane-activity="thinkingCompleted"[^}]*activity-thinking/su);
  expect(css).toMatch(/data-pane-activity="toolStarted"[^}]*activity-tool/su);
  expect(css).toMatch(/data-pane-activity="responseCompleted"[^}]*activity-response/su);
  expect(css).toMatch(/data-pane-activity="idle"[\s\S]*data-pane-activity="messageSent"[^}]*activity-idle/su);
  expect(css).toMatch(/data-pane-state="attention"[\s\S]*data-pane-error="true"[^}]*danger/su);
  const colors = [
    "activity-idle",
    "activity-thinking",
    "activity-tool",
    "activity-response",
    "danger",
  ].map((name) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu").exec(css)?.[1]);
  expect(colors.every((color) => color !== undefined)).toBeTrue();
  expect(new Set(colors).size).toBe(colors.length);
});

test("the shell gates panes on signed-in subscriptions and reuses the last repository", async () => {
  const app = await Bun.file(new URL("./App.tsx", import.meta.url)).text();
  expect(app).toContain('subscriptionGate === "missing" ? "settings" : route');
  expect(app).toContain('subscriptionGate !== "available"');
  expect(app).toContain("if (lastRepository !== null)");
  expect(app).toContain("repositoryId: lastRepository.id");
  expect(app).toContain("if (!inheritedRepositoryIsUnavailable(response))");
  expect(app).not.toContain("subscribeChatSignals");
  expect(app).not.toContain("sessionAudioFactory");
  expect(app.match(/reasoningEffort: "max"/gu)).toHaveLength(2);
  expect(app).not.toContain('reasoningEffort: "ultra"');
});

test("a stale inherited repository falls back to project selection", () => {
  const failure = (code: "not_found" | "conflict", message: string) => {
    const response: RuntimeDispatchResponse = {
      version: runtimeProtocolVersion,
      operationId: "op_staleRepository01",
      ok: false,
      error: { code, message, retryable: false, action: "none" },
    };
    return response;
  };

  expect(inheritedRepositoryIsUnavailable(
    failure("not_found", "This repository is unavailable."),
  )).toBeTrue();
  expect(inheritedRepositoryIsUnavailable(
    failure("not_found", "This pane is unavailable."),
  )).toBeFalse();
  expect(inheritedRepositoryIsUnavailable(
    failure("conflict", "This repository is unavailable."),
  )).toBeFalse();
});

test("faint normal text retains WCAG AA contrast across every product surface", async () => {
  const css = await Bun.file(new URL("./index.css", import.meta.url)).text();
  const token = (name: string) => {
    const value = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu").exec(css)?.[1];
    if (value === undefined) throw new Error(`Missing --${name} color token.`);
    return value;
  };
  const faint = token("faint");
  for (const surface of ["background", "surface", "surface-raised", "surface-hover"]) {
    expect(contrastRatio(faint, token(surface))).toBeGreaterThanOrEqual(4.5);
  }
  expect(css).toContain("min-width: 320px");
});

test("project onboarding is available only through the rendered New pane flow", async () => {
  const manifest = await Bun.file(new URL("../../app.zon", import.meta.url)).text();
  const runtimeHost = await Bun.file(
    new URL("../../src/runtime_host.zig", import.meta.url),
  ).text();
  expect(manifest.match(/hra\.project\.add/gu)).toHaveLength(1);
  expect(manifest).toContain('.name = "hra.project.add"');
  expect(manifest).not.toContain("Open Project");
  expect(manifest).not.toMatch(/\.id = "hra\.project\.add", \.key = "o"/u);
  expect(runtimeHost).not.toContain("beginNativeProjectOnboarding");
});

test("the design gallery remains independent from the native product shell", async () => {
  const source = await Bun.file(new URL("./main.tsx", import.meta.url)).text();
  expect(source).toContain("isDesignRoute(window.location.pathname)");
  expect(source).toContain('designRoute ? "design" : "product"');
  expect(source).not.toContain("agent-tasks-ui/styles.css");
});
