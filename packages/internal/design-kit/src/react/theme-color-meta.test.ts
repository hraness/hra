import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  acquireThemeColorMeta,
  themeColorSyncActiveAttribute,
  themeColorSyncDisabledAttribute,
} from "./theme-color-meta";

const lightMedia = "(prefers-color-scheme: light)";
const darkMedia = "(prefers-color-scheme: dark)";

function adaptiveDocument() {
  return parseHTML(`<!doctype html><html><head>
    <meta name="theme-color" content="#fafafa" media="${lightMedia}">
    <meta name="theme-color" content="#111111" media="${darkMedia}">
  </head><body></body></html>`).document;
}

function themeColorMetas(document: Document): HTMLMetaElement[] {
  return Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
}

function matchesOperatingSystem(meta: HTMLMetaElement, prefersDark: boolean): boolean {
  if (!meta.hasAttribute("media")) return true;
  if (meta.media === darkMedia) return prefersDark;
  if (meta.media === lightMedia) return !prefersDark;
  return false;
}

function matchingThemeColors(document: Document, prefersDark: boolean): HTMLMetaElement[] {
  return themeColorMetas(document).filter((meta) => matchesOperatingSystem(meta, prefersDark));
}

describe("resolved theme-color metadata", () => {
  test.each([
    { content: "#fafafa", label: "OS dark with explicit Light", prefersDark: true },
    { content: "#111111", label: "OS light with explicit Dark", prefersDark: false },
  ])("lets $label take over with exactly one matching meta", ({ content, prefersDark }) => {
    const document = adaptiveDocument();
    const serverMetas = themeColorMetas(document);
    const systemFirstPaint = matchingThemeColors(document, prefersDark);
    expect(systemFirstPaint).toHaveLength(1);
    expect(systemFirstPaint[0]?.content).toBe(prefersDark ? "#111111" : "#fafafa");

    const registration = acquireThemeColorMeta(
      document,
      "theme-color",
      Symbol("resolved"),
      content,
    );
    const resolved = matchingThemeColors(document, prefersDark);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.content).toBe(content);
    expect(resolved[0]?.hasAttribute("media")).toBe(false);
    expect(themeColorMetas(document)[0]).toBe(resolved[0]);
    expect(serverMetas.map((meta) => meta.media)).toEqual(["not all", "not all"]);

    registration.release();
    expect(themeColorMetas(document)).toEqual(serverMetas);
    expect(serverMetas.map((meta) => meta.media)).toEqual([lightMedia, darkMedia]);
    expect(serverMetas.every((meta) => !meta.hasAttribute(themeColorSyncDisabledAttribute))).toBe(true);
  });

  test("keeps one active meta until the last mount releases and falls back to the prior mount", () => {
    const document = adaptiveDocument();
    const light = acquireThemeColorMeta(document, "theme-color", Symbol("light"), "#fafafa");
    const dark = acquireThemeColorMeta(document, "theme-color", Symbol("dark"), "#111111");

    expect(matchingThemeColors(document, true).map((meta) => meta.content)).toEqual(["#111111"]);
    dark.release();
    expect(matchingThemeColors(document, true).map((meta) => meta.content)).toEqual(["#fafafa"]);
    expect(themeColorMetas(document).filter((meta) => !meta.hasAttribute("media"))).toHaveLength(1);

    light.release();
    expect(matchingThemeColors(document, true).map((meta) => meta.content)).toEqual(["#111111"]);
    expect(themeColorMetas(document).filter((meta) => !meta.hasAttribute("media"))).toHaveLength(0);
  });

  test("disables later head insertions and restores their exact prior media", async () => {
    const document = adaptiveDocument();
    const registration = acquireThemeColorMeta(
      document,
      "theme-color",
      Symbol("observer"),
      "#fafafa",
    );
    const late = document.createElement("meta");
    late.name = "theme-color";
    late.content = "#abcdef";
    document.head.prepend(late);
    await Promise.resolve();

    expect(themeColorMetas(document)[0]?.hasAttribute(themeColorSyncActiveAttribute)).toBe(true);
    expect(late.media).toBe("not all");
    expect(late.hasAttribute(themeColorSyncDisabledAttribute)).toBe(true);
    expect(matchingThemeColors(document, true).map((meta) => meta.content)).toEqual(["#fafafa"]);

    registration.release();
    expect(late.hasAttribute("media")).toBe(false);
    expect(late.hasAttribute(themeColorSyncDisabledAttribute)).toBe(false);
    expect(late.content).toBe("#abcdef");
  });

  test("retains ownership when head reconciliation strips markers or rewrites media", async () => {
    const document = adaptiveDocument();
    const serverMetas = themeColorMetas(document);
    const registration = acquireThemeColorMeta(
      document,
      "theme-color",
      Symbol("head-reconciliation"),
      "#fafafa",
    );
    const active = themeColorMetas(document)[0];
    if (active === undefined || serverMetas[0] === undefined) {
      throw new Error("The theme-color fixture is incomplete.");
    }

    active.removeAttribute(themeColorSyncActiveAttribute);
    serverMetas[0].removeAttribute(themeColorSyncDisabledAttribute);
    serverMetas[0].media = "(width > 1px)";
    await Promise.resolve();

    const replacement = document.head.querySelector<HTMLMetaElement>(
      `meta[${themeColorSyncActiveAttribute}]`,
    );
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(active);
    expect(active.media).toBe("not all");
    expect(serverMetas[0].hasAttribute(themeColorSyncDisabledAttribute)).toBe(true);
    expect(serverMetas[0].media).toBe("not all");
    if (replacement === null) throw new Error("The active theme-color replacement is missing.");
    replacement.content = "#badbad";
    await Promise.resolve();
    expect(replacement.content).toBe("#fafafa");

    registration.release();
    expect(active.isConnected).toBe(false);
    expect(replacement?.isConnected).toBe(false);
    expect(serverMetas.map((meta) => meta.media)).toEqual([lightMedia, darkMedia]);
  });
});
