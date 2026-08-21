import { expect, test } from "bun:test";

import {
  breakpoints,
  colors,
  controlRadius,
  elevation,
  fontWeights,
  interaction,
  layout,
  motion,
  radius,
  spacing,
  stacking,
  typeScale,
  typography,
} from "./index";

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match?.[1] === undefined) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

function declarations(body: string): ReadonlyMap<string, string> {
  return new Map(
    body
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const separator = declaration.indexOf(":");
        if (separator < 0) throw new Error(`Invalid CSS declaration: ${declaration}`);
        return [
          declaration.slice(0, separator).trim(),
          declaration.slice(separator + 1).trim(),
        ] as const;
      }),
  );
}

function cssName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function rem(pixels: number): string {
  return `${pixels / 16}rem`;
}

function pixelValue(value: string | undefined): number {
  if (value === undefined) throw new Error("Missing CSS length token");
  if (value === "0") return 0;
  if (value.endsWith("rem")) return Number.parseFloat(value) * 16;
  if (value.endsWith("px")) return Number.parseFloat(value);
  throw new Error(`Unsupported CSS length: ${value}`);
}

function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (match === null) throw new Error(`Expected an sRGB hex color, received ${hex}`);
  const channels = match.slice(1).map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

const css = await Bun.file(new URL("./tokens.css", import.meta.url)).text();
const resetCss = await Bun.file(new URL("./reset.css", import.meta.url)).text();
const stylesCss = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const plainSiteCss = await Bun.file(
  new URL("./plain-site.css", import.meta.url),
).text();
const light = declarations(ruleBody(css, ":root"));
const dark = declarations(ruleBody(css, ".dark"));

test("the private design kit composes the public UI core before private recipes", () => {
  expect(css).toContain('@import "@hraness/ui/tokens.css";');
  expect(resetCss).toContain('@import "@hraness/ui/reset.css";');

  const publicComponents = stylesCss.indexOf(
    '@import "@hraness/ui/components.css";',
  );
  const privateComponents = stylesCss.indexOf('@import "./components.css";');
  expect(publicComponents).toBeGreaterThanOrEqual(0);
  expect(privateComponents).toBeGreaterThan(publicComponents);
});

test("CSS and TypeScript themes expose identical semantic color values", () => {
  for (const [role, value] of Object.entries(colors.light)) {
    expect(light.get(`--${cssName(role)}`)).toBe(value);
  }
  for (const [role, value] of Object.entries(colors.dark)) {
    expect(dark.get(`--${cssName(role)}`)).toBe(value);
  }
});

test("caption text and same-canvas control boundaries meet text and non-text contrast", () => {
  for (const theme of [colors.light, colors.dark]) {
    expect(contrastRatio(theme.surface, theme.surfaceHover)).toBeGreaterThanOrEqual(1.12);
    for (const canvas of [theme.background, theme.surface, theme.card]) {
      expect(contrastRatio(theme.faint, canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.controlBorder, canvas)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(theme.focus, canvas)).toBeGreaterThanOrEqual(3);
    }
  }
});

test("plain-site syntax roles stay aligned and readable in both themes", () => {
  const plainLight = declarations(ruleBody(plainSiteCss, ".plain-site"));
  const plainDark = declarations(ruleBody(
    plainSiteCss,
    ':root[data-theme="dark"] .plain-site,\n.plain-site[data-theme="dark"]',
  ));
  const syntaxRoles = {
    keyword: "warning",
    string: "success",
    number: "danger",
    name: "info",
  } as const;

  for (const [syntaxRole, colorRole] of Object.entries(syntaxRoles)) {
    const lightValue = plainLight.get(`--plain-syntax-${syntaxRole}`);
    const darkValue = plainDark.get(`--plain-syntax-${syntaxRole}`);
    expect(lightValue).toBe(colors.light[colorRole]);
    expect(darkValue).toBe(colors.dark[colorRole]);
    if (lightValue === undefined || darkValue === undefined) {
      throw new Error(`Missing plain-site syntax color: ${syntaxRole}`);
    }
    expect(contrastRatio(lightValue, colors.light.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkValue, colors.dark.background)).toBeGreaterThanOrEqual(4.5);
  }
});

test("plain-site keeps short-page footers at the viewport edge without fixed positioning", () => {
  const document = declarations(ruleBody(plainSiteCss, "body.plain-site"));
  const main = declarations(ruleBody(plainSiteCss, "body.plain-site > main"));
  const footer = declarations(ruleBody(plainSiteCss, ".plain-footer"));

  expect(document.get("display")).toBe("flex");
  expect(document.get("flex-direction")).toBe("column");
  expect(plainSiteCss).toMatch(
    /body\.plain-site\s*\{[^}]*min-block-size:\s*100vh;[^}]*min-block-size:\s*100svh;[^}]*min-block-size:\s*100dvh;/su,
  );
  expect(main.get("flex")).toBe("1 0 auto");
  expect(footer.get("flex")).toBe("0 0 auto");
  expect(footer.get("inline-size")).toBe("100%");
  expect(footer.has("position")).toBeFalse();
});

test("CSS and TypeScript type scales stay aligned", () => {
  for (const [role, value] of Object.entries(typeScale)) {
    expect(light.get(`--text-${cssName(role)}`)).toBe(rem(value));
  }
  expect(light.get("--font-text")).toBe(typography.fontText);
  expect(light.get("--font-heading")).toBe(typography.fontHeading);
  expect(light.get("--font-mono")).toBe(typography.fontMono);
  expect(light.get("--font-sans")).toBe("var(--font-text)");
});

test("CSS and TypeScript spacing, radius, layout, interaction, and weight tokens stay aligned", () => {
  const spaceNames = [0, 1, 2, 3, 4, 5, 6, 8, 12, 16] as const;
  for (const [index, value] of spacing.entries()) {
    expect(light.get(`--space-${String(spaceNames[index])}`)).toBe(value === 0 ? "0" : rem(value));
  }
  for (const [role, value] of Object.entries(radius)) {
    expect(pixelValue(light.get(`--radius-${cssName(role)}`))).toBe(value);
  }
  expect(pixelValue(light.get("--control-radius"))).toBe(controlRadius);
  expect(light.get("--layout-chrome-inset")).toBe(rem(layout.chromeInset));
  expect(light.get("--layout-edge-inset")).toBe(rem(layout.edgeInset));
  expect(light.get("--interactive-target-compact")).toBe(rem(interaction.compactTarget));
  expect(light.get("--interactive-target-min")).toBe(rem(interaction.minimumTarget));
  expect(light.get("--control-height")).toBe(rem(interaction.controlHeight));
  expect(light.get("--control-height-primary")).toBe(rem(interaction.primaryControlHeight));
  expect(light.get("--control-height-transport")).toBe(
    rem(interaction.transportControlHeight),
  );
  for (const [role, value] of Object.entries(stacking)) {
    expect(light.get(`--z-${cssName(role)}`)).toBe(String(value));
  }
  for (const [role, value] of Object.entries(fontWeights)) {
    expect(light.get(`--font-weight-${cssName(role)}`)).toBe(String(value));
  }
});

test("persistent bars use the compact chrome inset on both axes", async () => {
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const bars = declarations(ruleBody(
    zov2,
    ".jungle-top-bar,\n.jungle-bottom-bar",
  ));
  const stickyTopBar = declarations(ruleBody(
    zov2,
    '.jungle-top-bar:where([data-position="sticky"])',
  ));
  const glassTopBar = declarations(ruleBody(
    zov2,
    '.jungle-top-bar:where([data-surface="glass"])',
  ));
  const dockedFooter = declarations(ruleBody(zov2, ".jungle-docked-footer__content"));
  const compactDockedFooter = declarations(ruleBody(
    zov2,
    '.jungle-docked-footer__content[data-density="compact"]',
  ));
  const compactDockedFooterFocus = declarations(ruleBody(
    zov2,
    '.jungle-docked-footer__content[data-density="compact"] :is(\n  .jungle-button__control,\n  .jungle-icon-button__control,\n  .jungle-pressable\n):is([data-focus-visible], :focus-visible)',
  ));

  expect(bars.get("padding")).toBe("var(--layout-chrome-inset)");
  expect(bars.has("padding-block")).toBeFalse();
  expect(bars.has("padding-inline")).toBeFalse();
  expect(stickyTopBar.get("position")).toBe("sticky");
  expect(stickyTopBar.get("z-index")).toBe("var(--z-chrome)");
  expect(stickyTopBar.get("inset-block-start")).toBe("0");
  expect(stickyTopBar.get("padding-top")).toBe(
    "max(var(--layout-chrome-inset), env(safe-area-inset-top))",
  );
  expect(stickyTopBar.get("padding-right")).toBe(
    "max(var(--layout-chrome-inset), env(safe-area-inset-right))",
  );
  expect(stickyTopBar.get("padding-left")).toBe(
    "max(var(--layout-chrome-inset), env(safe-area-inset-left))",
  );
  expect(glassTopBar.get("background")).toBe("var(--background)");
  expect(zov2).toContain(
    "@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))",
  );
  expect(zov2).toMatch(
    /@supports[\s\S]*?\.jungle-top-bar:where\(\[data-surface="glass"\]\)\s*\{[^}]*background:\s*color-mix\(in oklch, var\(--background\) 90%, transparent\);[^}]*-webkit-backdrop-filter:\s*blur\(18px\) saturate\(1\.08\);[^}]*backdrop-filter:\s*blur\(18px\) saturate\(1\.08\);/u,
  );
  expect(zov2).toMatch(
    /@media \(forced-colors: active\) \{[\s\S]*?\.jungle-top-bar\[data-surface="glass"\]\s*\{[^}]*border-bottom-color:\s*CanvasText;[^}]*background:\s*Canvas;[^}]*-webkit-backdrop-filter:\s*none;[^}]*backdrop-filter:\s*none;/u,
  );
  expect(dockedFooter.get("padding")).toBe("var(--layout-chrome-inset)");
  expect(dockedFooter.get("padding-right")).toBe(
    "max(var(--layout-chrome-inset), env(safe-area-inset-right))",
  );
  expect(dockedFooter.get("padding-bottom")).toBe(
    "max(var(--layout-chrome-inset), env(safe-area-inset-bottom))",
  );
  expect(dockedFooter.get("padding-left")).toBe(
    "max(var(--layout-chrome-inset), env(safe-area-inset-left))",
  );
  expect(compactDockedFooter.get("padding-top")).toBe("var(--space-1)");
  expect(compactDockedFooter.get("padding-bottom")).toBe(
    "max(var(--space-1), env(safe-area-inset-bottom))",
  );
  expect(compactDockedFooterFocus.get("outline-offset")).toBe("-3px");
  expect(compactDockedFooterFocus.get("box-shadow")).toBe("none");
});

test("CSS and TypeScript motion, elevation, and breakpoint tokens stay aligned", () => {
  for (const [role, value] of Object.entries(motion.duration)) {
    expect(light.get(`--motion-duration-${cssName(role)}`)).toBe(`${String(value)}ms`);
  }
  for (const [role, value] of Object.entries(motion.distance)) {
    expect(light.get(`--motion-distance-${cssName(role)}`)).toBe(`${String(value)}px`);
  }
  for (const [role, value] of Object.entries(motion.easing)) {
    expect(light.get(`--motion-easing-${cssName(role)}`)).toBe(value);
  }
  for (const [role, value] of Object.entries(elevation)) {
    expect(light.get(`--elevation-${cssName(role)}`)).toBe(value);
  }
  for (const [role, value] of Object.entries(breakpoints)) {
    expect(light.get(`--breakpoint-${cssName(role)}`)).toBe(rem(value));
  }
});

test("the zov2 browser layer exposes every shared shell and feedback seam", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  for (const className of [
    "jungle-theme-toggle",
    "jungle-page-intro",
    "jungle-inline-alert",
    "jungle-data-table",
    "jungle-navigation-rail",
    "jungle-app-shell",
    "jungle-animated-rail-stage",
    "jungle-chat-composer",
  ]) {
    expect(zov2).toContain(`.${className}`);
  }
  expect(zov2).toContain("@media (prefers-reduced-motion: reduce)");
  expect(zov2).toContain("@media (forced-colors: active)");
  const tooltip = declarations(ruleBody(zov2, ".jungle-tooltip"));
  const tooltipBase = declarations(ruleBody(components, ".jungle-tooltip"));
  const modal = declarations(ruleBody(components, ".jungle-modal-overlay"));
  const dock = declarations(ruleBody(zov2, ".jungle-docked-footer"));
  expect(tooltip.get("z-index")).toBe("var(--z-tooltip)");
  expect(tooltipBase.get("pointer-events")).toBe("none");
  expect(modal.get("z-index")).toBe("var(--z-modal, 2000)");
  expect(dock.get("z-index")).toBe("var(--z-chrome)");
  for (const property of ["background", "border", "border-radius", "box-shadow", "color"]) {
    expect(tooltip.has(property)).toBeFalse();
  }
});

test("procedural effects preserve semantic canvases and accessible motion fallbacks", async () => {
  const effects = await Bun.file(new URL("./effects.css", import.meta.url)).text();
  const backdrop = declarations(ruleBody(effects, ".jungle-procedural-backdrop"));
  const particleField = declarations(
    ruleBody(effects, ".jungle-particle-halo__particles"),
  );

  expect(backdrop.get("position")).toBe("absolute");
  expect(backdrop.get("background")).toBe("var(--background)");
  expect(backdrop.get("pointer-events")).toBe("none");
  expect(particleField.get("pointer-events")).toBe("none");
  expect(effects).toContain("@media (prefers-reduced-motion: reduce)");
  expect(effects).toContain(".jungle-particle-halo__particle {\n    animation: none;");
  expect(effects).toContain("@media (forced-colors: active)");
  expect(effects).toContain(".jungle-particle-halo__particles {\n    display: none;");
});

test("breadcrumb and pagination links keep full-size rounded touch targets", async () => {
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const breadcrumbs = declarations(ruleBody(zov2, ".jungle-breadcrumbs a"));
  const pagination = declarations(ruleBody(zov2, [
    ".jungle-pagination a",
    ".jungle-pagination__boundary",
    ".jungle-pagination__ellipsis",
  ].join(",\n")));
  const focus = declarations(ruleBody(zov2, [
    ".jungle-breadcrumbs a:focus-visible",
    ".jungle-pagination a:focus-visible",
  ].join(",\n")));

  for (const target of [breadcrumbs, pagination]) {
    expect(target.get("min-width")).toBe("var(--interactive-target-min)");
    expect(target.get("min-height")).toBe("var(--interactive-target-min)");
    expect(target.get("border-radius")).toBe("var(--control-radius)");
  }
  expect(breadcrumbs.get("touch-action")).toBe("manipulation");
  expect(focus.get("outline")).toBe("2px solid var(--focus)");
  expect(focus.get("outline-offset")).toBe("2px");
});

test("settings cards use padded rounded tonal grouping without divider chrome", async () => {
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const card = declarations(ruleBody(zov2, ".jungle-settings-card"));
  const body = declarations(ruleBody(zov2, ".jungle-settings-card__body"));

  expect(card.get("gap")).toBe("var(--space-4)");
  expect(card.get("padding")).toBe("var(--space-5)");
  expect(card.get("border")).toBe("0");
  expect(card.get("border-radius")).toBe("var(--jelly-radius-card)");
  expect(card.get("background")).toBe("var(--surface)");
  expect(body.get("min-width")).toBe("0");
  expect(body.has("border-top")).toBeFalse();
});

test("empty, loading, and alert surfaces use tonal contrast without decorative chrome", async () => {
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const empty = declarations(ruleBody(zov2, ".jungle-empty-state"));
  const icon = declarations(ruleBody(zov2, ".jungle-empty-state__icon"));
  const routeContent = declarations(ruleBody(zov2, ".jungle-route-state__content"));
  const loading = declarations(ruleBody(zov2, ".jungle-route-state__loading"));
  const alert = declarations(ruleBody(zov2, ".jungle-inline-alert"));

  expect(empty.get("border")).toBe("0");
  expect(empty.get("border-radius")).toBe("var(--jelly-radius-card)");
  expect(empty.get("background")).toBe("var(--surface)");
  expect(icon.get("border")).toBe("0");
  expect(icon.get("border-radius")).toBe("var(--radius-round)");
  expect(icon.get("background")).toBe("var(--surface-raised)");
  expect(routeContent.get("grid-row")).toBe("2");
  expect(loading.get("border")).toBe("0");
  expect(loading.get("box-shadow")).toBe("none");
  expect(alert.get("border")).toBe("0");
});

test("app shell focus targets clear sticky top and bottom bars", async () => {
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const targets = declarations(ruleBody(zov2, [
    ".jungle-app-shell__page :where(",
    "  a[href],",
    "  button:not(:disabled),",
    "  input:not(:disabled),",
    "  select:not(:disabled),",
    "  textarea:not(:disabled),",
    "  [tabindex]:not([tabindex=\"-1\"])",
    ")",
  ].join("\n")));

  expect(targets.get("scroll-margin-block-start")).toBe("calc(var(--top-bar-height) + var(--space-3))");
  expect(targets.get("scroll-margin-block-end")).toBe("calc(var(--bottom-bar-height) + var(--space-4))");
});

test("explicit light themes reset every mode-dependent token after legacy dark roots", () => {
  const explicitLight = declarations(ruleBody(
    css,
    ':root[data-theme="light"],\n[data-theme="light"]',
  ));
  for (const [role, value] of Object.entries(colors.light)) {
    expect(explicitLight.get(`--${cssName(role)}`)).toBe(value);
  }
  expect(css.indexOf('[data-theme="light"]')).toBeGreaterThan(css.indexOf(".dark"));
  expect(css).toContain(':root[data-theme="dark"]');
  expect(css).toContain(':root[data-theme="light"]');
  expect(css).toContain(':root[data-verification-pointer="coarse"]');
  expect(css).toContain("@media (pointer: coarse)");
});

test("shared component styles expose the reusable status and disclosure seams", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  for (const className of [
    "jungle-button",
    "jungle-icon",
    "jungle-fader",
    "jungle-status-dot",
    "jungle-badge",
    "jungle-disclosure",
    "jungle-toolbar",
    "jungle-visually-hidden",
  ]) {
    expect(components).toContain(`.${className}`);
  }
  expect(components).not.toContain('data-tone="waiting"');
  expect(components).not.toContain('data-tone="blocked"');
  expect(declarations(ruleBody(components, ".jungle-badge")).get("border")).toBe("0");
  expect(declarations(ruleBody(components, ".jungle-list-box")).get("border")).toBe("0");
  const disclosure = declarations(ruleBody(jelly, "jelly-card.jungle-disclosure"));
  expect(disclosure.get("overflow")).toBe("visible");
});

test("button geometry centers visible clusters and keeps icon hosts congruent at every size", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const glyphOnlyHost = declarations(
    ruleBody(components, ".jungle-button[data-glyph-only]"),
  );
  const compactGlyphHost = declarations(
    ruleBody(
      components,
      '.jungle-button[data-glyph-only][data-size="compact"]',
    ),
  );
  const largeGlyphHost = declarations(
    ruleBody(
      components,
      '.jungle-button[data-glyph-only][data-size="large"]',
    ),
  );
  const largeIconHost = declarations(
    ruleBody(jelly, 'jelly-card.jungle-icon-button[data-size="large"]'),
  );
  const largeIconControl = declarations(
    ruleBody(
      jelly,
      ':where(.jungle-icon-button[data-size="large"]) > .jungle-icon-button__control',
    ),
  );
  const glyphLabel = declarations(
    ruleBody(
      jelly,
      '.jungle-button[data-label-style="glyph"] > .jungle-button__control',
    ),
  );
  const glyphOnlyControl = declarations(
    ruleBody(
      jelly,
      ".jungle-button[data-glyph-only] > .jungle-button__control",
    ),
  );
  const iconLinkHost = declarations(
    ruleBody(jelly, "jelly-card.jungle-icon-link"),
  );
  const largeIconLink = declarations(
    ruleBody(
      jelly,
      '.jungle-icon-link[data-size="large"] .jungle-icon-link__control,\njelly-card.jungle-icon-link[data-size="large"]',
    ),
  );
  const largeIconToggleHost = declarations(
    ruleBody(
      jelly,
      'jelly-card.jungle-toggle-button[data-icon-only][data-size="large"]',
    ),
  );
  const iconToggleControl = declarations(
    ruleBody(
      jelly,
      ".jungle-toggle-button[data-icon-only] > .jungle-button__control",
    ),
  );
  const emptyPendingLeading = declarations(
    ruleBody(
      jelly,
      ".jungle-button__control[data-pending-leading-empty]\n  > .jungle-button__leading:empty",
    ),
  );
  const emptyPendingLabel = declarations(
    ruleBody(
      jelly,
      ".jungle-button__control[data-pending-leading-empty]\n  > .jungle-button__label",
    ),
  );

  expect(largeIconHost.get("--jungle-icon-button-size"))
    .toBe("var(--control-height-primary, 3.5rem)");
  expect(glyphOnlyHost.get("--jungle-glyph-control-size"))
    .toBe("var(--interactive-target-min, 3rem)");
  expect(glyphOnlyHost.get("width")).toBe("var(--jungle-glyph-control-size)");
  expect(glyphOnlyHost.get("height")).toBe("var(--jungle-glyph-control-size)");
  expect(compactGlyphHost.get("--jungle-glyph-control-size"))
    .toBe("var(--interactive-target-compact, 2.5rem)");
  expect(largeGlyphHost.get("--jungle-glyph-control-size"))
    .toBe("var(--control-height-primary, 3.5rem)");
  expect(glyphOnlyControl.get("width")).toBe("var(--jungle-glyph-control-size)");
  expect(glyphOnlyControl.get("height")).toBe("var(--jungle-glyph-control-size)");
  expect(glyphOnlyControl.get("padding")).toBe("0");
  expect(largeIconControl.get("width")).toBe("var(--control-height-primary, 3.5rem)");
  expect(largeIconControl.get("height")).toBe("var(--control-height-primary, 3.5rem)");
  expect(glyphLabel.get("font-size")).toBe("var(--text-control-glyph, 1.25rem)");
  expect(iconLinkHost.get("flex")).toBe("0 0 var(--jungle-icon-button-size)");
  expect(largeIconLink.get("--jungle-icon-button-size"))
    .toBe("var(--control-height-primary, 3.5rem)");
  expect(largeIconToggleHost.get("--jungle-icon-toggle-size"))
    .toBe("var(--control-height-primary, 3.5rem)");
  expect(iconToggleControl.get("width")).toBe("var(--jungle-icon-toggle-size)");
  expect(iconToggleControl.get("height")).toBe("var(--jungle-icon-toggle-size)");
  expect(iconToggleControl.get("padding")).toBe("0");
  expect(emptyPendingLeading.get("display")).toBe("inline-grid");
  expect(emptyPendingLeading.has("visibility")).toBe(false);
  expect(emptyPendingLabel.get("position")).toBe("relative");
  expect(emptyPendingLabel.get("inset-inline-start")).toContain("/ -2");
  expect(emptyPendingLabel.has("transform")).toBe(false);
  expect(jelly).not.toContain(":has(> .jungle-button__leading:empty)");
  expect(jelly).not.toContain("--jungle-button-pending-reserve");
  expect(jelly).not.toContain(".jungle-button__trailing");
});

test("Jelly badges expose semantic fills with one contrasting host and shadow label", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const badge = declarations(ruleBody(jelly, "jelly-badge.jungle-badge"));
  const part = declarations(ruleBody(jelly, "jelly-badge.jungle-badge::part(badge)"));
  const fallback = declarations(ruleBody(jelly, "jelly-badge.jungle-badge:not(:defined)"));

  expect(badge.get("--jelly-fill")).toBe("var(--surface-raised)");
  expect(badge.get("--jelly-label")).toBe("var(--foreground)");
  expect(badge.get("color")).toBe("var(--jelly-label)");
  expect(part.get("color")).toBe("var(--jelly-label)");
  expect(fallback.get("background")).toBe("var(--jelly-fill)");
  expect(fallback.get("color")).toBe("var(--jelly-label)");
  for (const [tone, fill] of [
    ["danger", "var(--danger)"],
    ["success", "var(--success)"],
    ["warning", "var(--warning)"],
  ] as const) {
    const semantic = declarations(ruleBody(
      jelly,
      `jelly-badge.jungle-badge[data-tone="${tone}"]`,
    ));
    expect(semantic.get("--jelly-fill")).toBe(fill);
    expect(semantic.get("--jelly-label")).toBe("var(--background)");
    expect(semantic.get("color")).toBe("var(--jelly-label)");
  }
});

test("Jelly surfaces inherit HRA semantics instead of exposing upstream palette choices", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const bridge = declarations(ruleBody(jelly, ":root"));
  const surface = declarations(ruleBody(jelly, ".jungle-jelly-surface"));

  expect(bridge.get("--jelly-font-text")).toBe("var(--font-text)");
  expect(bridge.get("--jelly-color-background-default")).toBe("var(--background)");
  expect(bridge.get("--jelly-color-background-surface")).toBe("var(--surface)");
  expect(bridge.get("--jelly-color-background-accent")).toBe("var(--foreground)");
  expect(bridge.get("--jelly-color-foreground-on-accent")).toBe("var(--background)");
  expect(bridge.get("--jelly-color-border-focus")).toBe("var(--foreground)");
  expect(surface.get("border-radius")).toBe("var(--jelly-radius)");
  expect(jelly).toContain(".jungle-jelly-surface:not(:defined)");
  expect(jelly).toContain('jelly-card.jungle-jelly-surface[data-interaction="passive"]');
  expect(jelly).toContain(".jungle-disclosure__content");
  const compositeSurface = declarations(ruleBody(
    jelly,
    "jelly-card.jungle-toggle-group__surface",
  ));
  expect(compositeSurface.get("overflow")).toBe("visible");
  expect(jelly).toContain(".jungle-jelly-surface[data-disabled]");
  expect(jelly).not.toMatch(/jungle-jelly-surface:has\([^)]*disabled/u);
  expect(jelly.match(/user-select: text;/gu)).toHaveLength(2);
  expect(jelly).toContain("@media (forced-colors: active)");
  expect(jelly).not.toContain("https://jelly-ui.com");
});

test("Jelly canvas radius roles stay pixel-resolved for the upstream numeric parser", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const bridge = declarations(ruleBody(jelly, ":root"));
  expect(bridge.get("--jelly-radius-compact")).toBe("8px");
  expect(bridge.get("--jelly-radius-control")).toBe("16px");
  expect(bridge.get("--jelly-radius-card")).toBe("20px");
  expect(bridge.get("--jelly-radius-overlay")).toBe("24px");

  const assignments = [...jelly.matchAll(/--jelly-radius\s*:\s*(?<value>[^;]+);/gu)]
    .map((match) => match.groups?.value?.trim());
  expect(assignments.length).toBeGreaterThan(10);
  for (const value of assignments) {
    expect(value).toMatch(
      /^(?:\d+(?:\.\d+)?px|var\(--(?:jelly-radius-(?:compact|control|card|overlay)|radius-round)\))$/u,
    );
  }
});

test("Jelly badges expose a forced-colors host and shadow-part contract", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const forcedColors = jelly.slice(jelly.indexOf("@media (forced-colors: active)"));
  const host = declarations(ruleBody(forcedColors, "jelly-badge.jungle-badge"));
  const badge = declarations(ruleBody(forcedColors, "jelly-badge.jungle-badge::part(badge)"));

  expect(host.get("color")).toBe("CanvasText");
  expect(host.get("forced-color-adjust")).toBe("auto");
  expect(badge.get("border")).toBe("1px solid CanvasText");
  expect(badge.get("background")).toBe("Canvas");
  expect(badge.get("color")).toBe("CanvasText");
  expect(badge.get("forced-color-adjust")).toBe("auto");
});

test("hydrated Jelly buttons restore a system-color boundary in forced colors", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const forcedColors = jelly.slice(jelly.indexOf("@media (forced-colors: active)"));
  const controls = declarations(ruleBody(
    forcedColors,
    "jelly-card.jungle-jelly-surface.jungle-button:defined,\n  jelly-card.jungle-jelly-surface.jungle-icon-button:defined",
  ));
  expect(controls.get("border")).toBe("1px solid CanvasText");
  expect(controls.get("background")).toBe("Canvas");
  expect(controls.get("color")).toBe("CanvasText");
  expect(controls.get("forced-color-adjust")).toBe("auto");
});

test("forced-color split actions use one durable perimeter and one target seam", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const forcedColors = jelly.slice(jelly.indexOf("@media (forced-colors: active)"));
  const group = declarations(ruleBody(forcedColors, ".jungle-split-button"));
  const perimeter = declarations(ruleBody(forcedColors, ".jungle-split-button::after"));
  const segments = declarations(ruleBody(
    forcedColors,
    ".jungle-split-button\n    > jelly-card.jungle-jelly-surface:is(.jungle-button, .jungle-icon-button):defined",
  ));
  const seam = declarations(ruleBody(
    forcedColors,
    ".jungle-split-button__menu > .jungle-icon-button__control",
  ));

  expect(group.get("position")).toBe("relative");
  expect(group.get("background")).toBe("Canvas");
  expect(group.get("box-shadow")).toBe("none");
  expect(group.get("forced-color-adjust")).toBe("auto");
  expect(perimeter.get("position")).toBe("absolute");
  expect(perimeter.get("z-index")).toBe("2");
  expect(perimeter.get("inset")).toBe("0");
  expect(perimeter.get("border")).toBe("1px solid CanvasText");
  expect(perimeter.get("border-radius")).toBe("inherit");
  expect(perimeter.get("content")).toBe('""');
  expect(perimeter.get("forced-color-adjust")).toBe("auto");
  expect(perimeter.get("pointer-events")).toBe("none");
  expect(segments.get("border")).toBe("0");
  expect(segments.get("background")).toBe("Canvas");
  expect(segments.get("color")).toBe("CanvasText");
  expect(segments.get("forced-color-adjust")).toBe("auto");
  expect(seam.get("border-inline-start")).toBe("1px solid CanvasText");
});

test("disabled toggle-group items retain a system-color boundary in forced colors", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const forcedColors = components.slice(components.indexOf("@media (forced-colors: active)"));
  const item = declarations(ruleBody(forcedColors, ".jungle-toggle-group__item[data-disabled]"));

  expect(item.get("border-color")).toBe("GrayText");
  expect(item.get("background")).toBe("Canvas");
  expect(item.get("color")).toBe("GrayText");
  expect(item.get("forced-color-adjust")).toBe("auto");
});

test("forced-colors field placeholders use unfaded system text", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const forcedColors = components.slice(components.indexOf("@media (forced-colors: active)"));
  const placeholder = declarations(ruleBody(
    forcedColors,
    ".jungle-search-field__input::placeholder,\n  .jungle-field__input::placeholder,\n  .jungle-number-field__input::placeholder",
  ));

  expect(placeholder.get("color")).toBe("CanvasText");
  expect(placeholder.get("opacity")).toBe("1");
});

test("forced colors repaint every native and composite focus indicator with a system color", async () => {
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const forcedColors = zov2.slice(zov2.indexOf("@media (forced-colors: active)"));
  const focus = declarations(ruleBody(
    forcedColors,
    ":focus-visible,\n  [data-focus-visible],\n  .jungle-search-field__control:has(.jungle-search-field__input:is(:focus-visible, [data-focus-visible])),\n  .jungle-field__surface:has(.jungle-field__input:is(:focus-visible, [data-focus-visible])),\n  .jungle-number-field:focus-within .jungle-number-field__control,\n  .jungle-checkbox-field__surface:has(.jungle-checkbox-field__input:focus-visible)",
  ));

  expect(focus.get("outline-color")).toBe("CanvasText !important");
});

test("modal headers keep close controls compact, inline, and collision free", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const semanticClose = declarations(ruleBody(components, ".jungle-modal__close"));
  const jellyClose = declarations(ruleBody(
    jelly,
    "jelly-card.jungle-icon-button.jungle-modal__close",
  ));
  const header = declarations(ruleBody(components, ".jungle-modal__header"));
  const heading = declarations(ruleBody(components, ".jungle-modal__heading"));
  const footer = declarations(ruleBody(components, ".jungle-modal__footer"));
  const restingClose = declarations(ruleBody(
    zov2,
    '.jungle-jelly-surface.jungle-modal__close[data-tone="quiet"]:not([data-hovered]):not([data-focus-within]):not([data-pressed])',
  ));
  const modalHost = declarations(ruleBody(jelly, "jelly-card.jungle-modal__surface"));
  const modalContent = declarations(ruleBody(
    jelly,
    ".jungle-modal__surface > .jungle-modal",
  ));

  expect(semanticClose.get("position")).toBe("relative");
  expect(semanticClose.get("align-self")).toBe("start");
  expect(jellyClose.get("position")).toBe("relative");
  expect(jellyClose.get("align-self")).toBe("start");
  expect(header.get("grid-template-columns")).toBe("minmax(0, 1fr) auto");
  expect(header.get("align-items")).toBe("start");
  expect(header.get("width")).toBe("100%");
  expect(header.get("padding")).toBe("var(--jungle-modal-inset) var(--jungle-modal-inset) var(--space-4, 1rem)");
  expect(heading.get("min-width")).toBe("0");
  expect(heading.get("width")).toBe("100%");
  expect(heading.get("gap")).toBe("var(--space-2, 0.5rem)");
  expect(footer.get("padding")).toBe("0 var(--jungle-modal-inset) var(--jungle-modal-inset)");
  expect(components).toMatch(/@media \(max-width:\s*600px\)[\s\S]*?\.jungle-modal-overlay\s*\{[^}]*--jungle-modal-inset:\s*var\(--space-4, 1rem\);/u);
  expect(components).toMatch(/\.jungle-modal-overlay\s*\{[^}]*--jungle-modal-edge-clearance:\s*var\(--space-6, 1.5rem\);/u);
  expect(components).toMatch(/@media \(max-width:\s*600px\)[\s\S]*?\.jungle-modal-overlay\s*\{[^}]*padding:\s*var\(--jungle-modal-edge-clearance\);/u);
  expect(components).toMatch(/@media \(max-width:\s*600px\)[\s\S]*?\.jungle-modal\s*\{[^}]*max-height:\s*calc\(100dvh - \(2 \* var\(--jungle-modal-edge-clearance\)\)\);/u);
  expect(components).not.toMatch(/\.jungle-modal__header\s*\{[^}]*interactive-target/u);
  expect(restingClose.get("--jelly-fill")).toBe("transparent");
  expect(modalHost.get("overflow")).toBe("clip");
  expect(modalHost.get("overflow-clip-margin")).toBe(
    "var(--jungle-modal-edge-clearance)",
  );
  expect(modalContent.get("border")).toBe("0");
  expect(modalContent.get("background")).toBe("transparent");
  expect(zov2).not.toContain(".jungle-modal__surface::part(jelly)");
  expect(zov2).not.toContain(".jungle-modal__surface > .jungle-modal");
});

test("composed Jelly buttons keep the painted host and semantic hit target congruent", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const sizedHosts = declarations(ruleBody(
    jelly,
    "jelly-card.jungle-button[data-size],\njelly-card.jungle-icon-button[data-size]",
  ));
  const buttonControl = declarations(ruleBody(jelly, ".jungle-button__control"));
  const compactControl = declarations(ruleBody(
    jelly,
    ':where(.jungle-button[data-size="compact"]) > .jungle-button__control',
  ));
  const upgradedPaint = declarations(ruleBody(
    jelly,
    "jelly-card.jungle-jelly-surface.jungle-button:defined,\n"
      + "jelly-card.jungle-jelly-surface.jungle-icon-button:defined",
  ));

  expect(sizedHosts.get("min-height")).toBe("0");
  expect(sizedHosts.get("padding")).toBe("0");
  expect(buttonControl.get("width")).toBe("100%");
  expect(compactControl.get("min-height")).toBe("var(--interactive-target-compact, 2.5rem)");
  expect(components).toContain(
    '.jungle-button:not(.jungle-jelly-surface)[data-variant="danger"]',
  );
  expect(components).not.toMatch(/(?:^|\n)\.jungle-button\[data-variant="danger"\]/u);
  const dangerSurface = declarations(ruleBody(
    jelly,
    '.jungle-jelly-surface[data-tone="danger"]',
  ));
  expect(dangerSurface.get("--jelly-fill")).toBe("var(--danger)");
  expect(dangerSurface.get("--jelly-label")).toBe("var(--background)");
  const hydratedPill = declarations(ruleBody(zov2, "jelly-card.jungle-button:defined"));
  expect(hydratedPill.get("background")).toBe("transparent");
  expect(hydratedPill.get("border-color")).toBe("transparent");
  expect(zov2).toContain("jelly-card.jungle-button,\njelly-card.jungle-field__surface");
  expect(zov2).toContain("--jelly-radius: var(--jelly-radius-control)");
  expect(upgradedPaint.get("border-color")).toBe("transparent");
  expect(upgradedPaint.get("background")).toBe("transparent");
  expect(upgradedPaint.get("transform")).toBe("none");

  const selectedToggle = declarations(ruleBody(
    jelly,
    ".jungle-button__control.jungle-toggle-button[data-selected]",
  ));
  const selectedDangerHost = declarations(ruleBody(
    jelly,
    '.jungle-button[data-variant="danger"]:has(> .jungle-toggle-button[data-selected])',
  ));
  const selectedDangerZovHost = declarations(ruleBody(
    zov2,
    '.jungle-button.jungle-toggle-button[data-variant="danger"]:has(\n'
      + "  > .jungle-button__control.jungle-toggle-button[data-selected]\n"
      + ")",
  ));
  expect(selectedToggle.get("border-color")).toBe("transparent");
  expect(selectedToggle.get("background")).toBe("transparent");
  expect(selectedToggle.get("color")).toBe("inherit");
  expect(selectedDangerHost.get("--jelly-fill")).toBe("var(--danger)");
  expect(selectedDangerZovHost.get("--jelly-fill")).toBe("var(--danger)");
  expect(selectedDangerZovHost.get("--jelly-label")).toBe("var(--background)");
  expect(selectedDangerZovHost.get("color")).toBe("var(--background)");
});

test("Jelly semantic controls retain a native focus-visible fallback before hydration", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const gallery = await Bun.file(new URL("./design-gallery.css", import.meta.url)).text();
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const reset = await Bun.file(new URL("./reset.css", import.meta.url)).text();
  const root = declarations(ruleBody(jelly, ":root"));
  const selectors = [
    ".jungle-button__control:is([data-focus-visible], :focus-visible)",
    ".jungle-icon-button__control:is([data-focus-visible], :focus-visible)",
    ".jungle-pressable-card__control:is([data-focus-visible], :focus-visible)",
    ".jungle-link-card__control:is([data-focus-visible], :focus-visible)",
    ".jungle-icon-link__control:is([data-focus-visible], :focus-visible)",
  ] as const;
  for (const selector of selectors) expect(jelly).toContain(selector);
  expect(root.get("--jelly-focus-ring")).toBe("var(--focus)");
  for (const stylesheet of [components, gallery, jelly, reset]) {
    expect(stylesheet).not.toContain("outline: 2px solid var(--foreground)");
  }
  for (const group of [
    `${selectors[0]},\n${selectors[1]}`,
    `${selectors[2]},\n${selectors[3]},\n${selectors[4]}`,
  ]) {
    const focus = declarations(ruleBody(jelly, group));
    expect(focus.get("outline")).toBe("2px solid var(--jelly-focus-ring)");
    expect(focus.get("outline-offset")).toBe("3px");
  }
});

test("every compact semantic target shares the coarse-pointer override", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const compactTarget = "var(--interactive-target-compact, 2.5rem)";

  for (const selector of [
    '.jungle-button[data-size="compact"]',
    '.jungle-icon-button[data-size="compact"]',
    '.jungle-search-field[data-size="compact"] .jungle-search-field__control',
    '.jungle-tabs[data-size="compact"] .jungle-tabs__tab',
  ]) {
    expect(ruleBody(components, selector)).toContain(compactTarget);
  }
  for (const selector of [
    'jelly-card.jungle-icon-button[data-size="compact"]',
    '.jungle-icon-link[data-size="compact"] .jungle-icon-link__control',
    '.jungle-select-field[data-size="compact"] .jungle-select-field__control',
  ]) {
    expect(ruleBody(jelly, selector)).toContain(compactTarget);
  }
  expect(components).not.toMatch(/min-height:\s*2\.5rem/u);
  expect(jelly).not.toMatch(/(?:width|height|min-height):\s*2\.5rem/u);
});

test("disabled composites use explicit colors without compounded opacity", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const genericDisabledSurface = declarations(ruleBody(
    jelly,
    ".jungle-jelly-surface[data-disabled],\n.jungle-jelly-surface[data-pending]",
  ));

  expect(genericDisabledSurface.has("opacity")).toBeFalse();
  expect(jelly).not.toMatch(
    /jelly-card\.jungle-(?:button|icon-button)\[data-(?:disabled|pending)\][^{]*\{[^}]*opacity\s*:/u,
  );
  expect(ruleBody(components, ".jungle-field[data-disabled],\n.jungle-number-field[data-disabled]"))
    .toContain("color: var(--jungle-disabled-foreground)");
  expect(genericDisabledSurface.get("--jelly-label"))
    .toBe("var(--jungle-disabled-foreground)");
  expect(ruleBody(
    jelly,
    ".jungle-select-field__surface[data-disabled] .jungle-select-field__control,\n.jungle-file-field__surface[data-disabled] .jungle-file-field__input",
  )).toContain("opacity: 1");
  expect(ruleBody(
    jelly,
    ".jungle-checkbox-field:has(.jungle-checkbox-field__input:disabled)",
  )).not.toContain("opacity");
  expect(ruleBody(components, ".jungle-search-field[data-disabled]")).not.toContain("opacity");
  expect(jelly).toContain(".jungle-checkbox-field:has(.jungle-checkbox-field__input:disabled)");
  expect(jelly).toContain("border: 1px solid CanvasText");

  const fader = declarations(ruleBody(components, ".jungle-fader[data-disabled]"));
  const disabledCollectionItem = declarations(ruleBody(
    components,
    ".jungle-list-box__item[data-disabled],\n.jungle-menu__item[data-disabled]",
  ));
  const disabledTab = declarations(ruleBody(
    components,
    ".jungle-tabs__tab[data-disabled]",
  ));
  expect(fader.has("opacity")).toBeFalse();
  expect(fader.get("color")).toBe("var(--muted)");
  expect(disabledCollectionItem.has("opacity")).toBeFalse();
  expect(disabledCollectionItem.get("color")).toBe("var(--faint)");
  expect(disabledTab.get("color")).toBe("var(--faint)");
  expect(disabledTab.get("cursor")).toBe("not-allowed");
});

test("checkbox Jelly paint contains one centered fixed-size indicator", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const card = declarations(ruleBody(
    jelly,
    "jelly-card.jungle-checkbox-field__surface::part(card)",
  ));
  const indicator = declarations(ruleBody(jelly, ".jungle-checkbox-field__indicator"));

  expect(card.get("box-sizing")).toBe("border-box");
  expect(card.get("display")).toBe("grid");
  expect(card.get("width")).toBe("100%");
  expect(card.get("height")).toBe("100%");
  expect(card.get("padding")).toBe("0");
  expect(card.get("place-items")).toBe("center");
  expect(indicator.get("display")).toBe("block");
  expect(indicator.get("width")).toBe("1rem");
  expect(indicator.get("height")).toBe("1rem");
});

test("menu items size and align themselves from their content shape", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const item = [...components.matchAll(/\.jungle-menu__item\s*\{(?<body>[^}]*)\}/gu)]
    .map((match) => declarations(match.groups?.body ?? ""))
    .find((candidate) => candidate.has("min-height"));
  if (item === undefined) throw new Error("Missing intrinsic menu item geometry");
  const descriptiveItem = declarations(ruleBody(
    components,
    '.jungle-menu__item[data-has-description="true"]',
  ));
  const leading = declarations(ruleBody(components, ".jungle-menu__leading"));
  const descriptiveLeading = declarations(ruleBody(
    components,
    '.jungle-menu__item[data-has-description="true"] .jungle-menu__leading',
  ));

  expect(item.get("min-height")).toBe("var(--interactive-target-min, 3rem)");
  expect(item.get("align-items")).toBe("center");
  expect(item.get("padding")).toBe("var(--space-2, 0.5rem) var(--space-3, 0.75rem)");
  expect(descriptiveItem.get("align-items")).toBe("flex-start");
  expect(leading.get("align-self")).toBe("center");
  expect(leading.get("line-height")).toBe("0");
  expect(descriptiveLeading.get("align-self")).toBe("flex-start");
  expect(descriptiveLeading.get("margin-top")).toBe("0.0625rem");
});

test("number fields keep focus visible outside their passive Jelly backdrop", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const focusWithin = declarations(ruleBody(
    components,
    ".jungle-number-field:focus-within .jungle-number-field__control",
  ));

  expect(focusWithin.get("outline")).toBe("2px solid var(--focus)");
  expect(focusWithin.get("outline-offset")).toBe("2px");
  expect(components).toContain("outline: 2px solid Highlight");
});

test("collection items keep keyboard focus inside their scroll container", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const segmentedFocus = declarations(ruleBody(
    components,
    ".jungle-segmented-control__item[data-focus-visible],\n.jungle-list-box__item[data-focus-visible]",
  ));

  expect(segmentedFocus.get("outline-offset")).toBe("-2px");
});

test("compact icon theme toggles do not clip their fixed focus targets", async () => {
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const control = declarations(ruleBody(
    zov2,
    '.jungle-theme-toggle[data-display="icons"] .jungle-segmented-control',
  ));

  expect(control.get("overflow")).toBe("visible");
});

test("list-box items keep keyboard focus inside their scroll container", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const focusVisible = declarations(ruleBody(
    components,
    ".jungle-list-box__item[data-focus-visible]",
  ));

  expect(focusVisible.get("outline-offset")).toBe("-2px");
});

test("segmented controls own one visible selection surface across compositions", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const control = declarations(ruleBody(components, ".jungle-segmented-control"));
  const selected = declarations(ruleBody(
    components,
    ".jungle-segmented-control__item[data-selected]",
  ));

  expect(control.get("--jungle-segmented-control-selection-fill")).toBe("var(--background)");
  expect(selected.get("background")).toBe("var(--jungle-segmented-control-selection-fill)");
  expect(selected.get("color")).toBe(
    "var(--jungle-segmented-control-selection-label, var(--foreground))",
  );
  expect(selected.has("box-shadow")).toBeTrue();
  expect(components).toContain("--jungle-segmented-control-item-hover-fill");
  expect(components).toContain("--jungle-collection-item-hover-fill");
  expect(components).toContain("--jungle-collection-item-selected-fill");
});

test("Jelly choice surfaces keep consumer margins outside their painted bounds", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const segmentedControl = declarations(ruleBody(
    jelly,
    "jelly-card.jungle-segmented-control__surface > .jungle-segmented-control",
  ));
  const toggleGroup = declarations(ruleBody(
    jelly,
    "jelly-card.jungle-toggle-group__surface > .jungle-toggle-group",
  ));

  expect(segmentedControl.get("margin")).toBe("0");
  expect(toggleGroup.get("margin")).toBe("0");
});

test("search fields key their Jelly host ring to the input focus-visible state", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const focusVisible = declarations(ruleBody(
    components,
    ".jungle-search-field__control:has(.jungle-search-field__input[data-focus-visible])",
  ));

  expect(focusVisible.get("outline")).toBe("2px solid var(--focus)");
  expect(focusVisible.get("outline-offset")).toBe("2px");
});

test("text inputs and textareas expose keyboard focus on the painted Jelly host", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const focusVisible = declarations(ruleBody(
    components,
    ".jungle-field__surface:has(.jungle-field__input[data-focus-visible])",
  ));

  expect(focusVisible.get("outline")).toBe("2px solid var(--focus)");
  expect(focusVisible.get("outline-offset")).toBe("2px");
  expect(zov2).not.toContain(".jungle-field__input[data-focused]");
  expect(zov2).not.toMatch(
    /\.jungle-field__input,\s*\.jungle-search-field__control/u,
  );
  expect(declarations(ruleBody(
    zov2,
    ".jungle-field.jungle-field--multiline .jungle-field__input",
  )).get("min-height")).toBe("7.5rem");
});

test("upgraded Jelly search fields preserve the padded semantic flex row", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const card = declarations(ruleBody(
    jelly,
    "jelly-card.jungle-search-field__control::part(card)",
  ));
  const input = declarations(ruleBody(
    jelly,
    ".jungle-search-field__control .jungle-search-field__input",
  ));

  expect(card.get("display")).toBe("flex");
  expect(card.get("width")).toBe("100%");
  expect(card.get("min-width")).toBe("0");
  expect(card.get("min-height")).toBe("inherit");
  expect(card.get("align-items")).toBe("center");
  expect(card.get("gap")).toBe("var(--space-2, 0.5rem)");
  expect(card.get("padding-inline")).toBe("max(0.75rem, var(--space-3, 0.75rem))");
  expect(input.get("flex")).toBe("1 1 0");
});

test("upgraded Jelly text fields keep the shadow card flush with the native field", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const card = declarations(ruleBody(
    jelly,
    "jelly-card.jungle-field__surface::part(card)",
  ));

  expect(card.get("box-sizing")).toBe("border-box");
  expect(card.get("width")).toBe("100%");
  expect(card.get("min-width")).toBe("0");
  expect(card.get("min-height")).toBe("inherit");
  expect(card.get("padding")).toBe("0");
});

test("field surface variants change Jelly fill without covering the canvas", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const zov2 = await Bun.file(new URL("./zov2.css", import.meta.url)).text();
  const tone = declarations(ruleBody(jelly, '.jungle-jelly-surface[data-tone="field"]'));
  const finalTone = declarations(ruleBody(zov2, '.jungle-jelly-surface[data-tone="field"]'));
  const card = ruleBody(jelly, [
    '.jungle-field[data-surface="card"] > jelly-card.jungle-field__surface',
    '.jungle-search-field[data-surface="card"] > jelly-card.jungle-search-field__control',
    '.jungle-number-field[data-surface="card"] jelly-card.jungle-number-field__surface',
    '.jungle-select-field[data-surface="card"] > jelly-card.jungle-select-field__surface',
  ].join(",\n"));
  const pane = ruleBody(jelly, [
    '.jungle-field[data-surface="pane"] > jelly-card.jungle-field__surface',
    '.jungle-search-field[data-surface="pane"] > jelly-card.jungle-search-field__control',
    '.jungle-number-field[data-surface="pane"] jelly-card.jungle-number-field__surface',
    '.jungle-select-field[data-surface="pane"] > jelly-card.jungle-select-field__surface',
  ].join(",\n"));
  const upgraded = declarations(ruleBody(jelly, [
    "jelly-card.jungle-field__surface:defined > .jungle-field__input",
    "jelly-card.jungle-jelly-surface.jungle-search-field__control:defined",
  ].join(",\n")));

  expect(tone.get("--jelly-fill")).toContain("--jungle-field-surface-fill");
  expect(finalTone.get("--jelly-fill")).toBe("var(--jungle-field-surface-fill, var(--background))");
  expect(declarations(card).get("--jungle-field-surface-fill")).toBe("var(--surface)");
  expect(declarations(pane).get("--jungle-field-surface-fill")).toBe("var(--surface-hover)");
  expect(upgraded.get("border-color")).toBe("transparent");
  expect(upgraded.get("background")).toBe("transparent");
});

test("select fields implement compact, default, and large semantic heights", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const base = declarations(ruleBody(
    jelly,
    ".jungle-select-field__control,\n.jungle-file-field__input",
  ));
  const compact = declarations(ruleBody(
    jelly,
    '.jungle-select-field[data-size="compact"] .jungle-select-field__control',
  ));
  const large = declarations(ruleBody(
    jelly,
    '.jungle-select-field[data-size="large"] .jungle-select-field__control',
  ));

  expect(base.get("min-height")).toBe("var(--interactive-target-min)");
  expect(compact.get("min-height")).toBe("var(--interactive-target-compact, 2.5rem)");
  expect(large.get("min-height")).toBe("var(--control-height-primary, 3.5rem)");
  expect(large.get("padding-inline")).toBe("var(--space-4, 1rem) 3rem");
});

test("disclosures implement distinct size padding and target contracts", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const host = declarations(ruleBody(jelly, "jelly-card.jungle-disclosure"));
  const recipes = [
    {
      size: "compact",
      block: "var(--space-2)",
      inline: "var(--space-3)",
      target: "var(--interactive-target-compact, 2.5rem)",
    },
    {
      size: "default",
      block: "var(--space-4)",
      inline: "var(--space-4)",
      target: "var(--interactive-target-min, 3rem)",
    },
    {
      size: "large",
      block: "var(--space-4)",
      inline: "var(--space-6)",
      target: "var(--control-height-primary, 3.5rem)",
    },
  ] as const;

  expect(host.get("padding")).toBe("0");

  for (const recipe of recipes) {
    const size = declarations(ruleBody(
      jelly,
      `:where(jelly-card.jungle-disclosure[data-size="${recipe.size}"])`,
    ));
    const summary = declarations(ruleBody(
      jelly,
      `.jungle-disclosure[data-size="${recipe.size}"] .jungle-disclosure__summary`,
    ));
    expect(size.get("--jungle-disclosure-padding-block")).toBe(recipe.block);
    expect(size.get("--jungle-disclosure-padding-inline")).toBe(recipe.inline);
    expect(summary.get("min-height")).toBe(recipe.target);
  }
});

test("overlay layout bounds Jelly deformation while semantic content remains contained", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const menuSurface = declarations(ruleBody(jelly, "jelly-card.jungle-menu__surface"));
  const menuPopover = declarations(ruleBody(jelly, ".jungle-menu-popover"));
  const modalSurface = declarations(ruleBody(jelly, "jelly-card.jungle-modal__surface"));
  const menuContent = declarations(ruleBody(components, ".jungle-menu"));
  const modalContent = declarations(ruleBody(components, ".jungle-modal"));
  const modalOverlay = declarations(ruleBody(components, ".jungle-modal-overlay"));

  expect(menuSurface.get("overflow")).toBe("visible");
  expect(menuSurface.get("border-radius")).toBe("var(--jelly-radius-overlay)");
  expect(menuPopover.get("overflow")).toBe("visible");
  expect(menuPopover.has("contain")).toBeFalse();
  expect(modalSurface.get("overflow")).toBe("clip");
  expect(modalSurface.get("overflow-clip-margin")).toBe(
    "var(--jungle-modal-edge-clearance)",
  );
  expect(modalSurface.has("contain")).toBeFalse();
  expect(modalSurface.get("min-width")).toBe("0");
  expect(modalSurface.get("max-width")).toBe("var(--jungle-modal-max-width)");
  expect(modalOverlay.get("--jungle-modal-edge-clearance")).toBe("var(--space-6, 1.5rem)");
  expect(modalOverlay.get("--jungle-modal-inset")).toBe("var(--space-6, 1.5rem)");
  expect(modalOverlay.get("grid-template-columns")).toBe("minmax(0, 1fr)");
  expect(modalOverlay.get("overflow-x")).toBe("clip");
  expect(modalOverlay.get("padding")).toContain("var(--jungle-modal-edge-clearance)");
  expect(components).not.toContain("padding: var(--space-2, 0.5rem);\n  }\n\n  .jungle-modal");
  expect(menuContent.get("overflow")).toBe("auto");
  expect(modalContent.get("overflow")).toBe("hidden");
  expect(modalContent.get("min-width")).toBe("0");
});

test("modal Jelly bleed stays inside the spacing that already belongs to the overlay", async () => {
  const jelly = await Bun.file(new URL("./jelly.css", import.meta.url)).text();
  const bodySurface = declarations(ruleBody(
    jelly,
    ".jungle-modal__body .jungle-jelly-surface,\n.jungle-modal__footer .jungle-jelly-surface",
  ));

  expect(bodySurface.get("overflow")).toBe("clip");
  expect(bodySurface.get("overflow-clip-margin")).toBe("var(--jungle-modal-inset)");
  expect(bodySurface.has("padding")).toBeFalse();
  expect(bodySurface.has("margin")).toBeFalse();
});

test("the vertical fader contains its thumb while the track owns a full touch target", async () => {
  const components = await Bun.file(new URL("./components.css", import.meta.url)).text();
  const track = declarations(ruleBody(components, ".jungle-fader__track"));
  const trackHitArea = declarations(ruleBody(components, ".jungle-fader__track::after"));
  const thumb = declarations(ruleBody(components, ".jungle-fader__thumb"));
  const thumbHitArea = declarations(ruleBody(components, ".jungle-fader__thumb::before"));
  const compact = declarations(ruleBody(
    components,
    '.jungle-fader[data-density="compact"]',
  ));
  const compactFocus = declarations(ruleBody(
    components,
    '.jungle-fader[data-density="compact"] .jungle-fader__thumb[data-focus-visible]',
  ));
  const horizontalTrack = declarations(ruleBody(
    components,
    '.jungle-fader[data-orientation="horizontal"] .jungle-fader__track',
  ));
  const horizontalTrackHitArea = declarations(ruleBody(
    components,
    '.jungle-fader[data-orientation="horizontal"] .jungle-fader__track::after',
  ));

  expect(track.get("width")).toBe("var(--interactive-target-min, 3rem)");
  expect(track.get("height")).toBe(
    "calc(\n    var(--jungle-fader-track-length) - var(--jungle-fader-thumb-block-size)\n  )",
  );
  expect(track.get("margin-block")).toBe(
    "var(--jungle-fader-thumb-block-offset)",
  );
  expect(track.get("touch-action")).toBe("none");
  expect(trackHitArea.get("top")).toBe(
    "calc(-1 * var(--jungle-fader-thumb-block-offset))",
  );
  expect(trackHitArea.get("bottom")).toBe(
    "calc(-1 * var(--jungle-fader-thumb-block-offset))",
  );
  expect(trackHitArea.get("pointer-events")).toBe("auto");
  expect(thumb.get("z-index")).toBe("1");
  expect(thumbHitArea.get("width")).toBe("var(--interactive-target-min, 3rem)");
  expect(thumbHitArea.get("height")).toBe("var(--interactive-target-min, 3rem)");
  expect(thumbHitArea.get("pointer-events")).toBe("none");
  expect(compact.get("--jungle-fader-track-length")).toBe(
    "var(--interactive-target-min, 3rem)",
  );
  expect(compact.get("--jungle-fader-thumb-block-size")).toBe("0.75rem");
  expect(compact.get("--jungle-fader-thumb-block-offset")).toBe("0.375rem");
  expect(compact.get("--jungle-fader-thumb-inline-size")).toBe("1.5rem");
  expect(compactFocus.get("outline-offset")).toBe("-0.25rem");
  expect(horizontalTrack.get("height")).toBe("var(--interactive-target-min, 3rem)");
  expect(horizontalTrack.get("margin-block")).toBe("0");
  expect(horizontalTrackHitArea.get("top")).toBe("0");
  expect(horizontalTrackHitArea.get("bottom")).toBe("0");
});
