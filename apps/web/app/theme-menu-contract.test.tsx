import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StandaloneThemeHeader } from "./standalone-theme-header";

async function source(relativePath: string): Promise<string> {
  return Bun.file(new URL(relativePath, import.meta.url)).text();
}

function themeMenuUsages(value: string): number {
  return value.match(/<ThemeMenuButton\b/gu)?.length ?? 0;
}

test("the shared standalone header owns one final appearance action", () => {
  const html = renderToStaticMarkup(<StandaloneThemeHeader />);

  expect(html.match(/<header\b/gu)).toHaveLength(1);
  expect(html.match(/data-hraness-appearance-menu=""/gu)).toHaveLength(1);
  expect(html).toMatch(
    /<header\b[\s\S]*<div class="jungle-top-bar__actions">[\s\S]*data-hraness-appearance-menu=""[\s\S]*<\/div><\/header>$/u,
  );
});

test("public and gallery surfaces keep the sole menu as their final header action", async () => {
  const [
    landing,
    alternatives,
    comparison,
    download,
    designPage,
    gallery,
  ] = await Promise.all([
    source("./page.tsx"),
    source("./alternatives/page.tsx"),
    source("./alternatives/[slug]/page.tsx"),
    source("./download/page.tsx"),
    source("./design/page.tsx"),
    source("../../../packages/internal/design-kit/src/react/design-gallery.tsx"),
  ]);

  for (const page of [landing, alternatives, comparison, download, designPage]) {
    expect(themeMenuUsages(page)).toBe(1);
    expect(page).not.toContain("<ThemeToggle");
  }
  expect(landing).toMatch(/Open HRA<\/Link>\s*<ThemeMenuButton \/>\s*<\/div>/u);
  expect(alternatives).toMatch(
    /GitHub<\/a>\s*<\/nav>\s*<ThemeMenuButton \/>\s*<\/div>/u,
  );
  expect(comparison).toMatch(
    /Download<\/Link>\s*<\/nav>\s*<ThemeMenuButton \/>\s*<\/div>/u,
  );
  expect(download).toMatch(/Open control plane[\s\S]*?<\/Link>\s*<ThemeMenuButton \/>\s*<\/div>/u);
  expect(designPage).toContain("actions={<ThemeMenuButton />}");
  expect(designPage).not.toContain('position="sticky"');
  expect(gallery).not.toContain("<ThemeToggle");
  expect(gallery).not.toContain("<PublicSegmentedControl");
});

test("authenticated and standalone states avoid footer, action-row, and duplicate selectors", async () => {
  const [admin, globalError, ...standaloneStates] = await Promise.all([
    source("./admin-shell.tsx"),
    source("./global-error.tsx"),
    source("./app/page.tsx"),
    source("./error.tsx"),
    source("./loading.tsx"),
    source("./not-found.tsx"),
    source("./admin-error-boundary.tsx"),
  ]);

  expect(themeMenuUsages(admin)).toBe(1);
  expect(admin).toContain("actions={<ThemeMenuButton />}");
  expect(admin).not.toMatch(/className="hra-rail-footer"[\s\S]{0,240}?ThemeMenuButton/u);
  for (const state of standaloneStates) {
    expect(state.match(/<StandaloneThemeHeader \/>/gu)).toHaveLength(1);
    expect(state).not.toContain("<ThemeMenuButton");
    expect(state).not.toContain("<ThemeToggle");
  }
  expect(globalError).not.toContain("ThemeMenuButton");
  expect(globalError).not.toContain("ThemeToggle");
});
