import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import * as publicReactApi from "./index";

import {
  DesignSystemGallery,
  designGalleryComponentAnchors,
  designGalleryPatternAnchors,
  designGalleryRecipeExclusions,
  designGallerySections,
  designGalleryVisualRecipeCoverage,
  resolveGalleryTheme,
} from "./design-gallery";

test("the gallery defers appearance selection to its host header", async () => {
  expect(resolveGalleryTheme("system", false)).toBe("light");
  expect(resolveGalleryTheme("system", true)).toBe("dark");
  expect(resolveGalleryTheme("light", true)).toBe("light");
  expect(resolveGalleryTheme("dark", false)).toBe("dark");

  const source = await Bun.file(new URL("./design-gallery.tsx", import.meta.url)).text();
  expect(source).not.toContain("<ThemeToggle");
  expect(source).not.toContain("<PublicSegmentedControl");
  expect(source).not.toContain("setGalleryTheme");

  const html = renderToStaticMarkup(<DesignSystemGallery />);
  expect(html).toContain("Selectable browser surfaces start with System appearance");
  expect(html).not.toContain("hraness-design-theme-toggle");
  expect(html).not.toContain('aria-label="Portable appearance"');
});

test("gallery icon buttons own their tooltips without nested triggers", async () => {
  const source = await Bun.file(new URL("./design-gallery.tsx", import.meta.url)).text();

  expect(source).not.toContain('<Tooltip label="More publish options">');
  expect(source).toContain('title="Review changes before publishing"');
  expect(source).toMatch(
    /<SplitButtonMenuTrigger[\s\S]{0,500}?tooltip="More publish options"[\s\S]{0,200}?<Icon icon=\{MoreHorizontalIcon\}/u,
  );
});

test("the shared gallery exposes every specimen through stable in-page anchors", () => {
  const html = renderToStaticMarkup(<DesignSystemGallery />);

  expect(html).toStartWith('<main class="design-gallery"');
  expect(html.match(/<main\b/gu)).toHaveLength(1);
  expect(html).toContain('data-design-gallery-nested="false"');
  expect(html).not.toContain("hraness-design-theme-toggle");
  expect(html.match(/data-design-section="true"/g)).toHaveLength(designGallerySections.length);
  for (const section of designGallerySections) {
    expect(html).toContain(`id="${section.id}"`);
    expect(html).toContain(`href="#${section.id}"`);
  }
  expect(html.match(/data-design-component-anchor="true"/g)).toHaveLength(
    designGalleryComponentAnchors.length,
  );
  for (const section of designGalleryComponentAnchors) {
    expect(html).toContain(`id="${section.id}"`);
    expect(html).toContain(`href="#${section.id}"`);
  }
  for (const pattern of designGalleryPatternAnchors) {
    expect(html).toContain(`id="${pattern.id}"`);
    expect(html).toContain(`href="#${pattern.id}"`);
  }
  expect(html).toContain("320 px safe");
  expect(html).toContain('data-design-scroll-rail="true"');
  expect(html).toContain("Scrollable Jelly cards keep their canvas gutter");
  expect(html).toContain("More actions");
  expect(html).toContain("Open dialog");
  expect(html).toContain("Contextual utilities share the label or toolbar row they qualify.");
  expect(html).toContain("Tactile press");
  expect(html).toContain("Stable action identity");
  expect(html).toContain("Center visible control content");
  expect(html).toContain("Literal headings");
  expect(html).toContain("Workspace settings");
  expect(html).not.toContain("A compact introduction with deliberately long supporting copy");
  expect(html).toContain("Leading icons and labels center as one cluster");
  expect(html).toContain("one visible selected surface across compositions");
  expect(html).toContain('aria-label="Mute channel"');
  expect(html).toContain('data-label-style="glyph"');
  expect(html).toContain('data-density="compact"');
  expect(html.match(/data-design-glyph-button="true"/gu)).toHaveLength(3);
  expect(html.match(/data-glyph-only="true"/gu)?.length).toBeGreaterThanOrEqual(3);
  expect(html).toContain("One spacing owner");
  expect(html).toContain("Keep structural surfaces rectangular");
  expect(html).toContain("Plain site theme");
  expect(html).toContain(
    "plain-site plain-publication design-gallery__plain-theme",
  );
  expect(html).toContain('class="plain-header__inner"');
  expect(html).toContain('class="plain-wordmark"');
  expect(html).toContain('class="plain-nav"');
  expect(html).toContain('class="plain-publication__entry"');
  expect(html).toContain('class="plain-footer__links"');
  expect(html).toContain(
    "Bounded content uses the fixed card role. Full round belongs only to circles and compact single-line chips.",
  );
  expect(html).toContain(
    "Round is an explicit circle or compact single-line pill, never a multiline container.",
  );
  expect(html).toContain('class="jungle-page-canvas" data-inset="none" data-size="full"');
  expect(html).toContain('data-shape="rectangular"');
  expect(html).toContain('class="jungle-docked-footer" data-position="absolute"');
  expect(html).toContain("Persistent controls stay flush to the bottom and sides.");
  expect(html).toContain("Save changes");
  expect(html).toContain("jungle-button__spinner");
  expect(html).toContain("Pending geometry");
  expect(html).toContain('data-design-pending-geometry="true"');
  expect(html).toContain('data-design-public-ui-core="true"');
  expect(html).toContain("hraness-button__control");
  expect(html).toContain("hraness-field__control");
  expect(html).toContain(
    "Ready and pending keep one label, footprint, DOM order, focus target, and a centered visible-content cluster.",
  );
  const pendingGeometryControls = [...html.matchAll(
    /<button\b[^>]*data-design-pending-state="(ready|pending)"[^>]*>[\s\S]*?<\/button>/gu,
  )].map((match) => ({ markup: match[0], state: match[1] ?? "" }));
  expect(pendingGeometryControls.map(({ state }) => state)).toEqual(["ready"]);
  for (const { markup } of pendingGeometryControls) {
    expect(markup).toContain('class="jungle-button__leading"');
    expect(markup).toContain('<span class="jungle-button__label">Save changes</span>');
    expect(markup).not.toContain("jungle-button__trailing");
    expect(markup).not.toContain("<svg");
  }
  expect(pendingGeometryControls[0]?.markup).not.toContain('aria-busy="true"');
  expect(pendingGeometryControls[0]?.markup).not.toContain('data-pending="true"');
  expect(pendingGeometryControls[0]?.markup).not.toContain("jungle-button__spinner");
  expect(html).toContain("data-design-pending-target");
  expect(html).toContain("data-design-pending-transition");
  expect(html).toContain("Playback lifecycle");
  expect(html).toContain('data-design-playback-transport-states="true"');
  expect(html).toContain(
    "One larger icon command starts playback, cancels startup, and stops playback",
  );
  for (const status of ["idle", "pending", "playing"]) {
    expect(html.match(new RegExp(`data-playback-status="${status}"`, "gu"))).toHaveLength(1);
  }
  expect(html).toContain('aria-label="Idle playback controls"');
  expect(html).toContain('aria-label="Pending playback controls"');
  expect(html).toContain('aria-label="Playing playback controls"');
  expect(html).toContain('aria-label="Publish actions"');
  expect(html).toContain('data-design-split-action="true"');
  const splitSegments = [...html.matchAll(
    /<button\b[^>]*data-design-split-segment="(primary|menu)"[^>]*>[\s\S]*?<\/button>/gu,
  )].map((match) => ({ markup: match[0], segment: match[1] ?? "" }));
  expect(splitSegments.map(({ segment }) => segment)).toEqual(["primary", "menu"]);
  expect(splitSegments[0]?.markup).toContain(">Publish<");
  expect(splitSegments[0]?.markup).not.toContain('aria-label="');
  expect(splitSegments[1]?.markup).toContain('aria-label="More publish options"');
  expect(splitSegments[1]?.markup).toContain("<svg");
  expect(splitSegments[1]?.markup).not.toContain(">More publish options<");
  expect(html).toContain("Each remains a separate keyboard target.");
  const hapticControls = (
    [...html.matchAll(/<button\b[^>]*data-haptic-demo="([^"]+)"[^>]*>/gu)]
      .map((match) => ({ markup: match[0], state: match[1] ?? "" }))
  );
  const hapticMarkup = (state: string) => hapticControls
    .find((control) => control.state === state)?.markup ?? "";
  expect(hapticControls.map(({ state }) => state).sort()).toEqual(["disabled", "enabled"]);
  expect(hapticMarkup("enabled")).not.toContain(' disabled=""');
  expect(hapticMarkup("enabled")).not.toContain('data-pending="true"');
  expect(hapticMarkup("disabled")).toContain(' disabled=""');
  expect(html).toContain('data-design-field-matrix="true"');
  expect(html).toContain("Compact text field");
  expect(html).toContain("Default invalid textarea");
  expect(html).toContain("Large disabled pane search");
  expect(html).toContain("Large disabled pane selection with long content");
  expect(html).toContain("Large disabled pane quantity");
  expect(html).toContain("Disabled checkbox");
  expect(html).toContain("Invalid file input");
  expect(html).toContain('data-design-disclosure-matrix="true"');
  expect(html).toContain("Compact metadata");
  expect(html).toContain("Default closed disclosure");
  expect(html).toContain("Large disclosure with a deliberately long title");
  expect(html).toContain("Interface expression");
  expect(html).toContain("Output level");
  expect(html).toContain("Disabled density");
  expect(html).toContain("Disabled workspace view");
  expect(html).toContain("Tabs with an unavailable destination");
  expect(html).toContain("Unavailable long-content choice");
  expect(html).toContain('data-design-autocomplete="true"');
  expect(html).toContain(">Search interface modes</label>");
  expect(html).toContain('aria-autocomplete="list"');
  expect(html).toContain('data-design-autocomplete-result="true"');
  expect(html).toContain("None · 0");
  expect(html).toContain("Disabled output level");
  expect(html).toContain('data-output-visibility="visually-hidden"');
  expect(html).toContain("Reduced-motion");
  expect(html).toContain("jungle-app-shell");
  expect(html).toContain("jungle-viewport-frame");
  expect(html).toContain("jungle-wrapping-row");
  expect(html).toContain("jungle-accordion");
  expect(html).toContain("jungle-data-table");
  expect(html).toContain("jungle-chat-composer");
  expect(html).toContain("jungle-route-state");
  expect(html).toContain("jungle-aurora-background");
  expect(html).toContain("Equal-axis compact chrome");
  expect(html).not.toContain('aria-live="assertive"');
  expect(html).not.toContain('aria-live="polite"');
  expect(html).not.toContain('role="status"');

  const headingLevels = [...html.matchAll(/<h([1-6])(?:\s|>)/gu)]
    .map((match) => Number(match[1]));
  expect(headingLevels.filter((level) => level === 1)).toHaveLength(1);
  for (const [index, level] of headingLevels.entries()) {
    if (index === 0) continue;
    expect(level).toBeLessThanOrEqual((headingLevels[index - 1] ?? 0) + 1);
  }
});

test("every public visual export has exact rendered fixture evidence", async () => {
  const html = renderToStaticMarkup(<DesignSystemGallery />);
  const markedFixtures = [...html.matchAll(
    /<[^>]+data-design-recipe-fixture="([^"]+)"[^>]+data-design-recipes="([^"]*)"[^>]*>/gu,
  )].map((match) => ({
    fixture: match[1] ?? "",
    recipes: new Set((match[2] ?? "").split(/\s+/u).filter(Boolean)),
  }));
  const recipeNames = designGalleryVisualRecipeCoverage.map(({ recipe }) => recipe);

  expect(new Set(recipeNames).size).toBe(recipeNames.length);
  for (const { fixture, recipe } of designGalleryVisualRecipeCoverage) {
    expect(
      markedFixtures.some((marked) => marked.fixture === fixture && marked.recipes.has(recipe)),
    ).toBeTrue();
  }

  const exclusions = new Set(designGalleryRecipeExclusions.map(({ exportName }) => exportName));
  expect(exclusions.size).toBe(designGalleryRecipeExclusions.length);
  for (const { exportName, reason } of designGalleryRecipeExclusions) {
    expect(reason.length).toBeGreaterThan(24);
    expect(recipeNames).not.toContain(exportName);
  }

  const coveredAndExcluded = [...recipeNames, ...exclusions]
    .map((name) => String(name))
    .sort();
  const publicVisualExports = Object.keys(publicReactApi)
    .filter((name) => /^[A-Z][a-z]/u.test(name))
    .sort();
  expect(coveredAndExcluded).toEqual(publicVisualExports);

  const gallerySource = await Bun.file(
    new URL("./design-gallery.tsx", import.meta.url),
  ).text();
  expect(gallerySource).not.toContain("private font");
  const sourceFile = ts.createSourceFile(
    "design-gallery.tsx",
    gallerySource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const renderedComponentNames = new Set<string>();
  const collectRenderedComponents = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName)) renderedComponentNames.add(node.tagName.text);
    }
    ts.forEachChild(node, collectRenderedComponents);
  };
  collectRenderedComponents(sourceFile);
  for (const recipe of recipeNames) expect(renderedComponentNames).toContain(recipe);
});

test("the gallery can defer its main landmark to an existing product shell", () => {
  const html = renderToStaticMarkup(<DesignSystemGallery isNestedInMain />);

  expect(html).toStartWith('<div class="design-gallery"');
  expect(html).toContain('data-design-gallery-nested="true"');
  expect(html).not.toContain('<main class="design-gallery"');
  expect(html).not.toMatch(/<main\b/u);
  expect(html).not.toContain('aria-label="Design system sections"');
  expect(html).not.toContain('aria-label="Gallery theme"');
  expect(html).not.toContain('class="design-gallery__side-nav"');
  expect(html).not.toContain('class="design-gallery__mobile-nav"');
});

test("gallery CSS owns responsive, coarse-pointer, and forced-color stress policies", async () => {
  const css = await Bun.file(new URL("../design-gallery.css", import.meta.url)).text();
  const jellyCss = await Bun.file(new URL("../jelly.css", import.meta.url)).text();

  expect(css).toContain("@media (max-width: 23rem)");
  expect(css).toContain("@media (pointer: coarse)");
  expect(css).toMatch(
    /\.design-gallery__plain-theme a\s*\{[^}]*min-block-size:\s*max\(\s*var\(--interactive-target-compact\),\s*var\(--plain-link-target-min\)\s*\);[^}]*min-inline-size:\s*max\(\s*var\(--interactive-target-compact\),\s*var\(--plain-link-target-min\)\s*\);/su,
  );
  expect(css).toMatch(
    /:root\[data-verification-pointer="coarse"\] \.design-gallery__side-nav a,[\s\S]*?min-height:\s*var\(--interactive-target-min\);/u,
  );
  expect(css).toContain("@media (forced-colors: active)");
  expect(css).toContain("--design-gallery-inset: clamp(var(--layout-edge-inset), 3vw, var(--space-12))");
  expect(css).toContain("overflow-x: clip");
  expect(css).toContain("scroll-margin-top");
  expect(css).toMatch(
    /\.design-gallery__side-nav\s*\{[^}]*border-right:\s*1px solid var\(--line\);[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/su,
  );
  expect(css).toMatch(
    /\.design-gallery\[data-design-gallery-nested="true"\] \.design-gallery__layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*padding-inline:\s*0;/su,
  );
  expect(css).toMatch(
    /\.design-gallery\[data-design-gallery-nested="true"\]\s*\{[^}]*min-height:\s*0;[^}]*overflow-x:\s*visible;/su,
  );
  expect(css).toContain(".design-gallery__structural-preview");
  expect(css).toMatch(/\.design-gallery__hero > div:first-child\s*\{[^}]*display:\s*grid;/su);
  expect(css).not.toMatch(/\.design-gallery__hero > div\s*\{/su);
  expect(css).toMatch(/\.design-gallery__hero-actions\s*\{[^}]*display:\s*flex;/su);
  expect(css).toMatch(/\.design-gallery :where\(h1, h2, h3, h4, p\)\s*\{[^}]*color:\s*inherit;/su);
  for (const kind of ["display", "title", "heading"]) {
    expect(css).toMatch(
      new RegExp(
        `\\.design-gallery__type-stack \\[data-kind="${kind}"\\]\\s*\\{[^}]*font-family:\\s*var\\(--font-heading\\);`,
        "su",
      ),
    );
  }
  expect(css).toContain(".design-gallery__field-matrix");
  expect(css).toContain(".design-gallery__disclosure-matrix");
  expect(css).toContain(".design-gallery__component-group");
  expect(css).toContain(".design-gallery__shell-preview .jungle-app-shell__rail");
  expect(css).toMatch(/\.design-gallery__shell-preview \.jungle-app-shell__mobile-trigger\s*\{[^}]*top:\s*var\(--space-6\);[^}]*left:\s*var\(--space-6\);/su);
  expect(css).toMatch(/\.design-gallery__shell-preview \.jungle-navigation-rail__header\s*\{[^}]*padding-left:\s*calc\(var\(--space-6\) \+ var\(--interactive-target-compact\) \+ var\(--space-2\)\);/su);
  expect(css).toContain(".design-gallery__route-states > .jungle-route-state");
  expect(css).toContain(".design-gallery__effect-preview .jungle-aurora-background");
  expect(css).toMatch(/\.design-gallery__overlay-stage\s*\{[^}]*padding:\s*clamp\(var\(--layout-edge-inset\), 4vw, var\(--space-8\)\);/su);
  expect(css).toMatch(/\.design-gallery__overlay-stage\s*\{[^}]*padding-inline:\s*calc\(clamp\(var\(--layout-edge-inset\), 4vw, var\(--space-8\)\) \+ var\(--space-4\)\);/su);
  expect(css).toMatch(/\.design-gallery__overlay-stage > \.design-gallery__control-wrap\s*\{[^}]*flex-shrink:\s*0;/su);
  expect(css).toMatch(/\.design-gallery__scroll-rail\s*\{[^}]*padding:\s*var\(--space-6\);[^}]*overflow-x:\s*auto;[^}]*scroll-padding-inline:\s*var\(--space-6\);/su);
  expect(css).not.toMatch(/\.design-gallery__scroll-rail\s*\{[^}]*padding-inline-(?:start|end):/su);
  expect(css).toMatch(/\.design-gallery__rail-card\s*\{[^}]*contain:\s*layout inline-size;/su);
  expect(css).toMatch(/\.design-gallery__rail-card\s*\{[^}]*width:\s*11rem;[^}]*flex:\s*0 0 11rem;/su);
  expect(css).not.toContain(".design-gallery__split-action {");
  expect(jellyCss).toMatch(/\.jungle-split-button\s*\{[^}]*display:\s*inline-flex;[^}]*height:\s*var\(--jungle-split-button-height\);[^}]*gap:\s*0;[^}]*overflow:\s*clip;[^}]*border-radius:\s*var\(--radius-round\);/su);
  expect(jellyCss).toMatch(/\.jungle-split-button > \.jungle-jelly-surface\s*\{[^}]*--jelly-radius:\s*1px;/su);
  expect(jellyCss).toMatch(/\.jungle-split-button__menu > \.jungle-icon-button__control\s*\{[^}]*border-inline-start:\s*1px solid color-mix/su);
  expect(jellyCss).toMatch(/\.jungle-split-button[\s\S]*?:focus-visible[\s\S]*?outline:\s*2px solid var\(--jungle-split-button-focus-ring\);[\s\S]*?outline-offset:\s*-2px;[\s\S]*?box-shadow:\s*none;/u);
  expect(css).toMatch(/\.design-gallery__mobile-nav\s*\{[^}]*overflow-x:\s*auto;[^}]*mask-image:\s*linear-gradient\(to right,/su);
});
