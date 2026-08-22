import { describe, expect, test } from "bun:test";
import { colors } from "@hra-internal/design-kit";
import {
  defaultDesignTheme,
  designThemes,
} from "@hra-internal/design-kit/react";
import { runInNewContext } from "node:vm";

import {
  directAppearanceBootstrapAttribute,
  directAppearanceBootstrapMarker,
  directAppearanceBootstrapScript,
  directAppearanceBootstrapState,
  directAppearanceThemes,
  directAppearanceThemeColors,
  directDefaultAppearanceTheme,
  injectDirectAppearanceBootstrap,
} from "./appearance-bootstrap";
import { builtDirectAppearanceViolations } from "./verify-built-appearance";

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text();
}

function browserColor(hex: string): string {
  const channels = /^#(?<red>[\da-f]{2})(?<green>[\da-f]{2})(?<blue>[\da-f]{2})$/iu.exec(hex)?.groups;
  if (channels === undefined) throw new TypeError(`Expected a six-digit color; received ${hex}.`);
  return `rgb(${Number.parseInt(channels.red ?? "", 16)}, ${Number.parseInt(channels.green ?? "", 16)}, ${Number.parseInt(channels.blue ?? "", 16)})`;
}

function builtLikeDirectDocument(documentSource: string): string {
  return injectDirectAppearanceBootstrap(documentSource).replace(
    "</head>",
    '<link rel="stylesheet" href="./assets/app.css"></head>',
  );
}

function executeAppearanceBootstrap(
  storedPreference: string | null,
  systemPrefersDark: boolean,
) {
  let storedValue = storedPreference;
  const initialDataset: Record<string, string> = { theme: "light" };
  const root = { dataset: initialDataset };
  const insertedMetas: Array<Record<string, unknown>> = [];
  const insertedStyles: Array<Record<string, unknown>> = [];
  const firstAdaptiveMeta = { content: colors.light.background, name: "theme-color" };
  const head = {
    append: (element: Record<string, unknown>) => {
      insertedStyles.push(element);
    },
    insertBefore: (meta: Record<string, unknown>, before: unknown) => {
      expect(before).toBe(firstAdaptiveMeta);
      insertedMetas.push(meta);
    },
    querySelector: (selector: string) => selector === 'meta[name="theme-color"]'
      ? firstAdaptiveMeta
      : null,
  };
  const browserWindow: Record<string, unknown> = {};
  const storage = {
    getItem: () => storedValue,
    setItem: (_key: string, value: string) => {
      storedValue = value;
    },
  };
  runInNewContext(directAppearanceBootstrapScript, {
    document: {
      createElement: (tagName: string) => tagName === "style"
        ? { dataset: {}, textContent: "" }
        : { content: "", dataset: {}, name: "" },
      documentElement: root,
      head,
    },
    getComputedStyle: () => ({
      backgroundColor: browserColor(
        root.dataset.theme === "dark" ? colors.dark.background : colors.light.background,
      ),
    }),
    localStorage: storage,
    matchMedia: () => ({ matches: systemPrefersDark }),
    window: browserWindow,
  });
  const receiptDescriptor = Object.getOwnPropertyDescriptor(
    browserWindow,
    "__hraAppearanceBootstrap",
  );
  return {
    evidence: browserWindow.__hraAppearanceBootstrap,
    insertedBackground: insertedStyles[0],
    insertedMeta: insertedMetas[0],
    receipt: {
      configurable: receiptDescriptor?.configurable,
      enumerable: receiptDescriptor?.enumerable,
      frozen: Object.isFrozen(browserWindow.__hraAppearanceBootstrap),
      writable: receiptDescriptor?.writable,
    },
    root: root.dataset,
    storedValue,
  };
}

describe("Agent Tasks lab appearance", () => {
  test("keeps the light fallback and injects one classic bootstrap before app code", async () => {
    const [document, main, stylesheet, vite, verifier, workbench] = await Promise.all([
      source("./index.html"),
      source("./main.tsx"),
      source("./workbench.css"),
      source("./vite.config.ts"),
      source("./verify-browser.ts"),
      source("./workbench.tsx"),
    ]);
    const transformedDocument = injectDirectAppearanceBootstrap(document);
    const builtDocument = builtLikeDirectDocument(document);

    expect(defaultDesignTheme).toBe("system");
    expect(directDefaultAppearanceTheme).toBe(defaultDesignTheme);
    expect(directAppearanceThemes).toEqual(designThemes);
    expect(directAppearanceThemeColors).toEqual({
      dark: colors.dark.background,
      light: colors.light.background,
    });
    expect(document).toContain('<html lang="en" data-theme="light">');
    expect(document).toContain(
      '<meta name="theme-color" content="#fbf6f2" media="(prefers-color-scheme: light)" />',
    );
    expect(document).toContain(
      '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />',
    );
    expect(document).toContain(directAppearanceBootstrapMarker);
    expect(document).not.toContain('src="/appearance-bootstrap.ts"');
    expect(transformedDocument).not.toContain(directAppearanceBootstrapMarker);
    expect(transformedDocument).toContain(`<script ${directAppearanceBootstrapAttribute}="">`);
    expect(builtDirectAppearanceViolations(builtDocument)).toEqual([]);
    expect(vite).toContain("directAppearanceBootstrapPlugin()");
    expect(vite).toContain("handler: injectDirectAppearanceBootstrap");
    expect(main).toContain("window.__hraAppearanceBootstrap");
    expect(main).toContain(
      "dataset.hraAppearanceBeforeApp = rootThemeBeforeApp",
    );
    expect(main).toContain(
      "dataset.hraBackgroundBeforeApp = bodyBackgroundBeforeApp",
    );
    expect(main).toContain(
      "dataset.hraThemeColorBeforeApp = bootstrapThemeColor.content",
    );
    expect(main).toContain("<AppearanceBootstrapHandoff />");
    expect(main).toContain("<DesignThemeProvider>");
    expect(main).toContain("<ThemeColorSync />");
    expect(verifier).toContain("verifyAppearanceBootstrap");
    expect(main.indexOf('import "../app/globals.css"')).toBeLessThan(
      main.indexOf('import "@hraness/agent-tasks-ui/styles.css"'),
    );
    expect(main.indexOf('import "@hraness/agent-tasks-ui/styles.css"')).toBeLessThan(
      main.indexOf('import "./workbench.css"'),
    );
    expect(workbench).toContain("<ThemeMenuButton />");
    expect(workbench).not.toContain("<ThemeToggle");
    expect(workbench.indexOf("<ThemeMenuButton />")).toBeGreaterThan(
      workbench.indexOf(">reset</Button>"),
    );
    expect(stylesheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    expect(stylesheet).not.toMatch(/rgba?\(/u);
  });

  test("normalizes missing, invalid, and System preferences before opposing OS paint", () => {
    expect(directAppearanceBootstrapState(null, true)).toEqual({
      preference: "system",
      resolvedTheme: "dark",
      themeColor: colors.dark.background,
    });
    expect(directAppearanceBootstrapState("sepia", false)).toEqual({
      preference: "system",
      resolvedTheme: "light",
      themeColor: colors.light.background,
    });
    expect(directAppearanceBootstrapState("system", true)).toEqual({
      preference: "system",
      resolvedTheme: "dark",
      themeColor: colors.dark.background,
    });
    expect(directAppearanceBootstrapState("light", true)).toEqual({
      preference: "light",
      resolvedTheme: "light",
      themeColor: colors.light.background,
    });
    expect(directAppearanceBootstrapState("dark", false)).toEqual({
      preference: "dark",
      resolvedTheme: "dark",
      themeColor: colors.dark.background,
    });

    expect(executeAppearanceBootstrap(null, true)).toEqual({
      evidence: {
        backgroundColor: browserColor(colors.dark.background),
        preference: "system",
        resolvedTheme: "dark",
        schema: "hra.appearance-bootstrap/v1",
        storageRepaired: false,
        storedValue: null,
        themeColor: colors.dark.background,
      },
      insertedBackground: {
        dataset: { hraAppearanceBootstrapBackground: "" },
        textContent: `html{background-color:${colors.dark.background}!important;color-scheme:dark}body{background-color:${colors.dark.background}!important}`,
      },
      insertedMeta: {
        content: colors.dark.background,
        dataset: { hraAppearanceBootstrapThemeColor: "" },
        name: "theme-color",
      },
      receipt: {
        configurable: false,
        enumerable: false,
        frozen: true,
        writable: false,
      },
      root: {
        hraAppearanceBootstrap: "dark",
        hraAppearanceBootstrapPreference: "system",
        hraAppearanceBootstrapThemeColor: colors.dark.background,
        jellyMode: "dark",
        theme: "dark",
      },
      storedValue: null,
    });
    expect(executeAppearanceBootstrap("sepia", false)).toEqual({
      evidence: {
        backgroundColor: browserColor(colors.light.background),
        preference: "system",
        resolvedTheme: "light",
        schema: "hra.appearance-bootstrap/v1",
        storageRepaired: true,
        storedValue: "system",
        themeColor: colors.light.background,
      },
      insertedBackground: {
        dataset: { hraAppearanceBootstrapBackground: "" },
        textContent: `html{background-color:${colors.light.background}!important;color-scheme:light}body{background-color:${colors.light.background}!important}`,
      },
      insertedMeta: {
        content: colors.light.background,
        dataset: { hraAppearanceBootstrapThemeColor: "" },
        name: "theme-color",
      },
      receipt: {
        configurable: false,
        enumerable: false,
        frozen: true,
        writable: false,
      },
      root: {
        hraAppearanceBootstrap: "light",
        hraAppearanceBootstrapPreference: "system",
        hraAppearanceBootstrapThemeColor: colors.light.background,
        jellyMode: "light",
        theme: "light",
      },
      storedValue: "system",
    });
    expect(executeAppearanceBootstrap("system", true).evidence).toMatchObject({
      preference: "system",
      resolvedTheme: "dark",
      storedValue: "system",
      themeColor: colors.dark.background,
    });
    expect(executeAppearanceBootstrap("light", true).root.theme).toBe("light");
    expect(executeAppearanceBootstrap("dark", false).root.theme).toBe("dark");
  });

  test("fails closed when Vite cannot replace exactly one head marker", () => {
    expect(() => injectDirectAppearanceBootstrap("<html></html>")).toThrow("received 0");
    expect(() => injectDirectAppearanceBootstrap(
      `${directAppearanceBootstrapMarker}${directAppearanceBootstrapMarker}`,
    )).toThrow("received 2");
  });

  test("reports missing fallback, classic-script, and ordering contracts in built HTML", async () => {
    const invalid = `<html><head><link rel="stylesheet" href="app.css"><script type="module"></script></head></html>`;
    expect(builtDirectAppearanceViolations(invalid)).toContain(
      "built Direct HTML lost the concrete light SSR fallback",
    );
    expect(builtDirectAppearanceViolations(invalid)).toContain(
      "built Direct HTML has 0 appearance bootstrap scripts instead of 1",
    );

    const valid = builtLikeDirectDocument(await source("./index.html"));
    expect(builtDirectAppearanceViolations(valid)).toEqual([]);
    expect(builtDirectAppearanceViolations(
      valid.replace('<link rel="stylesheet" href="./assets/app.css">', ""),
    )).toContain("built Direct HTML is missing its stylesheet");
    expect(builtDirectAppearanceViolations(
      valid.replace('<script type="module" src="/main.tsx"></script>', ""),
    )).toContain("built Direct HTML is missing its app module");
  });

  test("reuses the production workspace inset inside every task fixture frame", async () => {
    const [runtime, stylesheet] = await Promise.all([
      source("./runtime.tsx"),
      source("./workbench.css"),
    ]);

    expect(runtime).toMatch(/<div className="workspace-panel">\s*<TaskWorkspace/su);
    expect(stylesheet).toContain(".direct-frame-only > .workspace-panel");
    expect(stylesheet).not.toContain(".direct-frame-only > .task-workspace");
  });
});
