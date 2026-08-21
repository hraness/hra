import { expect, test } from "bun:test";

const stylesheet = await Bun.file(new URL("./globals.css", import.meta.url)).text();
const foundation = await Bun.file(
  new URL("../../../packages/internal/design-kit/src/tokens.css", import.meta.url),
).text();

type Rgb = Readonly<{ blue: number; green: number; red: number }>;

function tokenBlock(pattern: RegExp): string {
  return foundation.match(pattern)?.groups?.body ?? "";
}

function hexToken(block: string, name: string): Rgb {
  const hex = block.match(new RegExp(`--${name}:\\s*#(?<hex>[0-9a-f]{6});`, "iu"))
    ?.groups?.hex;
  if (hex === undefined) throw new Error(`Missing hexadecimal ${name} token`);
  return {
    blue: Number.parseInt(hex.slice(4, 6), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    red: Number.parseInt(hex.slice(0, 2), 16),
  };
}

function relativeLuminance(color: Rgb): number {
  const linear = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0)
    + 0.7152 * (linear[1] ?? 0)
    + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(left: Rgb, right: Rgb): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function firstRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return stylesheet.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "u"))?.groups?.body ?? "";
}

function ruleBodies(selector: string): readonly string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...stylesheet.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "gu"))]
    .map((match) => match[1] ?? "");
}

test("the public landing stays responsive, keyboard-visible, and token-driven", () => {
  expect(firstRule(".landing-header")).toContain("grid-template-columns: 1fr auto 1fr");
  expect(firstRule(".landing-hero")).toContain("grid-template-columns: minmax(0, 1.45fr) minmax(20rem, 0.55fr)");
  expect(firstRule(".landing-card-grid")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  expect(firstRule(".landing-skip-link:focus")).toContain("transform: translateY(0)");
  expect(stylesheet).toMatch(/\.landing-button:focus-visible,[\s\S]*?outline:\s*2px solid var\(--focus\);/u);
  expect(stylesheet).toMatch(/@media \(max-width:\s*38rem\)[\s\S]*?\.landing-card-grid,[\s\S]*?grid-template-columns:\s*1fr;/u);
  expect(stylesheet).toMatch(/@media \(forced-colors:\s*active\)[\s\S]*?\.landing-button,[\s\S]*?border:\s*1px solid CanvasText;/u);
});

test("standalone appearance controls belong to a header instead of absolute or rail chrome", () => {
  expect(firstRule(".state-page")).toContain("grid-template-rows: auto minmax(0, 1fr)");
  expect(firstRule(".standalone-header.jungle-top-bar")).toContain("width: 100%");
  expect(firstRule(".state-card")).toContain("place-self: center");
  expect(stylesheet).not.toContain(".standalone-theme-toggle");
  expect(stylesheet).not.toContain(".hra-rail-footer .jungle-theme-toggle");
});

test("landing accent text uses a semantic foreground with light and dark contrast", () => {
  const landingStyles = stylesheet.slice(stylesheet.indexOf(".landing-page"));
  expect(landingStyles).not.toContain("color: var(--accent);");
  expect(firstRule(".landing-wordmark > span")).toContain("color: var(--accent-ink)");
  expect(firstRule(".landing-eyebrow")).toContain("color: var(--accent-ink)");
  expect(firstRule(".landing-authority-transfer")).toContain("color: var(--accent-ink)");
  expect(stylesheet).toMatch(/\.landing-card > span,\s*\.landing-flow > li > span\s*\{[^}]*color:\s*var\(--accent-ink\);/u);

  const themes = [
    ["light", tokenBlock(/:root\s*\{(?<body>[\s\S]*?)\n\}/u)],
    ["dark", tokenBlock(/:root\[data-theme="dark"\],[\s\S]*?\.dark\s*\{(?<body>[\s\S]*?)\n\}/u)],
  ] as const;
  for (const [theme, block] of themes) {
    const foreground = hexToken(block, "accent-foreground");
    for (const background of ["background", "surface", "surface-raised"] as const) {
      expect(
        contrastRatio(foreground, hexToken(block, background)),
        `${theme} accent foreground on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("brand marks use the local raster asset instead of platform emoji fonts", () => {
  expect(stylesheet).not.toContain("Apple Color Emoji");
  expect(stylesheet).not.toContain("Segoe UI Emoji");
  expect(firstRule(".brand-icon-image")).toContain("object-fit: cover");
  expect(firstRule(".brand-icon-image")).toContain("display: block");
});

test("agent directory uses a flat structural split around sparse pressable rows", () => {
  const directory = firstRule(".agent-directory");
  const list = firstRule(".agent-list");
  const detail = firstRule(".agent-detail");

  expect(directory).toContain("gap: 0");
  expect(directory).not.toMatch(/(?:background|border|overflow)\s*:/u);
  expect(list).toContain("padding: 0 var(--space-6) 0 0");
  expect(list).toContain("border-right: 1px solid var(--line)");
  expect(list).toContain("border-radius: 0");
  expect(list).toContain("background: transparent");
  expect(detail).toContain("padding: 0 0 0 clamp(1rem, 3vw, 1.8rem)");
  expect(stylesheet).toMatch(/@media \(max-width:\s*54rem\)[\s\S]*?\.agent-list\s*\{[^}]*padding:\s*0 var\(--space-1\) var\(--space-4\);[^}]*border-right:\s*0;[^}]*border-bottom:\s*1px solid var\(--line\);[^}]*overflow-x:\s*auto;[^}]*scroll-padding-inline:\s*var\(--space-1\);/u);
  expect(stylesheet).toMatch(/@media \(max-width:\s*54rem\)[\s\S]*?\.agent-detail\s*\{[^}]*padding:\s*var\(--space-6\) 0 0;/u);
});

test("workspace tabs leave their shared Jelly surface and selection paint visible", () => {
  const bar = firstRule(".workspace-surface-navigation .jungle-tabs__bar");
  const workspaceTab = firstRule(".workspace-surface-navigation .jungle-tabs__tab");

  expect(bar).not.toMatch(/(?:background|border|border-radius)\s*:/u);
  expect(workspaceTab).toContain("background: transparent");
  expect(workspaceTab).not.toContain("border-radius:");
  expect(stylesheet).not.toMatch(/\.jungle-tabs__tab\[data-selected\]\s*\{[^}]*background\s*:/u);
});

test("dense membership rows are flat without constraining shared controls", () => {
  const members = firstRule(".member-list");
  const member = firstRule(".member-row");

  expect(members).toContain("gap: 0");
  expect(members).toContain("border-top: 1px solid var(--line)");
  expect(members).toContain("overflow: visible");
  expect(members).not.toContain("background:");
  expect(member).toContain("padding: var(--space-4) 0");
  expect(member).toContain("border-bottom: 1px solid var(--line)");
  expect(member).toContain("border-radius: 0");
  expect(member).toContain("background: transparent");
});

test("dense lifecycle rows remain flat", () => {
  const lifecycleList = firstRule(".lifecycle-list");
  const lifecycleCard = firstRule(".lifecycle-card");
  const sessionRow = firstRule(".lifecycle-card--session");

  expect(lifecycleList).toContain("gap: 0");
  expect(lifecycleList).toContain("border-top: 1px solid var(--line)");
  expect(lifecycleCard).toContain("padding: var(--space-4) 0");
  expect(lifecycleCard).toContain("border: 0");
  expect(lifecycleCard).toContain("border-bottom: 1px solid var(--line)");
  expect(lifecycleCard).toContain("border-radius: 0");
  expect(lifecycleCard).toContain("background: transparent");
  expect(sessionRow).toContain("box-shadow: inset 2px 0 0");
});

test("the workspace panel is the single page-spacing owner", () => {
  const workspaceRules = ruleBodies(".workspace-panel");

  expect(firstRule(".topbar")).toContain("padding: var(--layout-edge-inset)");
  expect(workspaceRules[0]).toContain("padding: clamp(var(--layout-edge-inset), 2.5vw, 2rem)");
  expect(workspaceRules.at(-1)).toContain("padding: var(--layout-edge-inset)");
  expect(stylesheet).toMatch(/@media \(max-width:\s*38rem\)[\s\S]*?\.topbar\s*\{[^}]*padding:\s*var\(--layout-edge-inset\);/u);
  expect(stylesheet).not.toContain("padding: clamp(1.25rem, 3.5vw, 3.5rem)");
});

test("the top bar uses tonal separation without duplicated transport chrome", () => {
  const topbar = firstRule(".topbar.jungle-top-bar");

  expect(topbar).toContain("border-bottom: 0");
  expect(topbar).toContain("background: color-mix");
  expect(stylesheet).not.toContain(".transport-state");
  expect(stylesheet).toMatch(/@media \(forced-colors:\s*active\)[\s\S]*?\.topbar\.jungle-top-bar\s*\{[^}]*border-bottom:\s*1px solid CanvasText;/u);
});

test("confirmation dialogs leave paint and geometry to the shared modal surface", () => {
  const dialog = firstRule(".confirm-dialog.jungle-modal");

  expect(firstRule(".confirm-dialog-surface")).toContain("--jelly-fill: var(--panel)");
  expect(dialog).toContain("border: 0");
  expect(dialog).toContain("border-radius: var(--jelly-radius-overlay)");
  expect(dialog).toContain("background: transparent");
  expect(dialog).toContain("box-shadow: none");
  expect(dialog).not.toContain("padding:");
  expect(stylesheet).not.toContain(".confirm-dialog::backdrop");
});
