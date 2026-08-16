import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";

import { AnimatedRailStage, railStageMotion } from "./animated-rail-stage";
import { useDesignPortalTheme } from "./design-theme-context";
import {
  DesignThemeProvider,
  normalizeDesignTheme,
  themeColorFor,
  themeToggleItems,
  ThemeToggle,
} from "./theme";

function PortalThemeProbe() {
  const theme = useDesignPortalTheme();
  return <span data-portal-theme={theme}>Portal theme</span>;
}

test("appearance choices are complete, ordered, and labelable", () => {
  expect(themeToggleItems()).toEqual([
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "system", label: "System" },
  ]);
  expect(themeToggleItems({ system: "Device" })).toEqual([
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "system", label: "Device" },
  ]);
});

test("missing and invalid persisted appearance values fall back to light", () => {
  expect(normalizeDesignTheme(undefined)).toBe("light");
  expect(normalizeDesignTheme(null)).toBe("light");
  expect(normalizeDesignTheme("sepia")).toBe("light");
  expect(normalizeDesignTheme({ theme: "dark" })).toBe("light");
  expect(normalizeDesignTheme("dark")).toBe("dark");
  expect(normalizeDesignTheme("system")).toBe("system");
});

test("theme color resolution is dark only for a resolved dark appearance", () => {
  const values = { dark: "#111111", light: "#fafafa" } as const;
  expect(themeColorFor("dark", values)).toBe(values.dark);
  expect(themeColorFor("light", values)).toBe(values.light);
  expect(themeColorFor("system", values)).toBe(values.light);
  expect(themeColorFor(undefined, values)).toBe(values.light);
});

test("the provider and toggle server-render a light-first three-choice surface", () => {
  const html = renderToStaticMarkup(
    <DesignThemeProvider>
      <ThemeToggle />
    </DesignThemeProvider>,
  );

  expect(html).toContain("jungle-design-theme-v1");
  expect(html).toContain('data-ready="false"');
  expect(html).toContain('data-display="icons"');
  expect(html).toContain('data-theme-value="light"');
  expect(html).toContain('aria-label="Appearance"');
  expect(html).toContain('aria-label="Light"');
  expect(html).toContain('aria-label="Dark"');
  expect(html).toContain('aria-label="System"');
  expect(html).not.toContain(">Light<");
  expect(html).not.toContain(">Dark<");
  expect(html).not.toContain(">System<");
  expect(html.match(/data-slot="appearance-icon"/gu)).toHaveLength(3);
  expect(html).toContain('data-selected="true"');
  expect(html).toContain('disabled=""');
});

test("appearance labels remain available for explicit teaching surfaces", () => {
  const html = renderToStaticMarkup(
    <ThemeToggle display="labels" onChange={() => undefined} value="light" />,
  );

  expect(html).toContain('data-display="labels"');
  expect(html).toContain(">Light<");
  expect(html).toContain(">Dark<");
  expect(html).toContain(">System<");
});

test("the menu presentation keeps persistent chrome to one named trigger", () => {
  const html = renderToStaticMarkup(
    <ThemeToggle
      aria-label="Site appearance"
      onChange={() => undefined}
      presentation="menu"
      value="system"
    />,
  );

  expect(html).toContain('data-presentation="menu"');
  expect(html).toContain('data-display="icons"');
  expect(html).toContain('data-theme-value="system"');
  expect(html).toContain('aria-label="Site appearance: System"');
  expect(html.match(/data-slot="appearance-icon"/gu)).toHaveLength(1);
  expect(html).not.toContain('input type="radio"');
  expect(html).not.toContain('class="jungle-segmented-control');
});

test("a controlled theme toggle is hydration-stable and immediately operable", () => {
  const html = renderToStaticMarkup(
    <ThemeToggle onChange={() => undefined} value="system" />,
  );

  expect(html).toContain('data-ready="true"');
  expect(html).toContain('data-theme-value="system"');
  expect(html).not.toContain('aria-busy="true"');
  expect(html).not.toContain('disabled=""');
  expect(html).toMatch(/data-selected="true"[^>]*>[\s\S]*?value="system"/u);
});

test("a forced provider omits preference repair and system selection", () => {
  const html = renderToStaticMarkup(
    <DesignThemeProvider forcedTheme="dark">
      <PortalThemeProbe />
    </DesignThemeProvider>,
  );

  expect(html).toContain('data-portal-theme="dark"');
  expect(html).not.toContain('data-jungle-theme-guard=""');
  expect(html).not.toContain("jungle-theme-toggle");
});

test("the provider owns the Jelly repaint bridge for runtime appearance changes", async () => {
  const source = await Bun.file(new URL("./theme.tsx", import.meta.url)).text();

  expect(source).toContain('import { setJellyThemeMode } from "./jelly-runtime";');
  expect(source).toContain("void setJellyThemeMode(resolvedTheme);");
  expect(source).not.toContain('new CustomEvent("jelly-theme-change")');
  expect(source).toContain("<JellyThemeSync />");
});

test("the provider repairs invalid persisted values before next-themes resolves first paint", () => {
  const html = renderToStaticMarkup(
    <DesignThemeProvider storageKey="appearance-test-key">
      <span>Content</span>
    </DesignThemeProvider>,
  );
  const guard = /<script[^>]*data-jungle-theme-guard=""[^>]*>([\s\S]*?)<\/script>/u.exec(html)?.[1];
  expect(guard).toBeDefined();

  let value: string | null = "sepia";
  const localStorage = {
    getItem: (key: string) => key === "appearance-test-key" ? value : null,
    setItem: (key: string, next: string) => {
      if (key === "appearance-test-key") value = next;
    },
  };
  runInNewContext(guard ?? "", { localStorage });
  expect(value).toBe("light");

  value = "dark";
  runInNewContext(guard ?? "", { localStorage });
  expect(value).toBe("dark");
});

test("rail stages enter and exit in opposite directions at the shared duration", () => {
  expect(railStageMotion(false)).toEqual({
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -10 },
    initial: { opacity: 0, x: 14 },
    transition: { duration: 0.18, ease: "easeOut" },
  });
});

test("rail stages expose their route identity for deterministic composition checks", () => {
  const html = renderToStaticMarkup(
    <AnimatedRailStage stageKey="/workspace/detail">Detail</AnimatedRailStage>,
  );
  expect(html).toContain('data-stage-key="/workspace/detail"');
});

test("reduced motion removes translation and transition time without hiding content", () => {
  expect(railStageMotion(true)).toEqual({
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: 0 },
    initial: { opacity: 1, x: 0 },
    transition: { duration: 0, ease: "easeOut" },
  });
});
