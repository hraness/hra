import { describe, expect, test } from "bun:test";

const stylesheet = await Bun.file(new URL("./styles.css", import.meta.url)).text();

function firstRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return stylesheet.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "u"))?.groups?.body ?? "";
}

function ruleBodies(selector: string): readonly string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...stylesheet.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "gu"))]
    .map((match) => match[1] ?? "");
}

describe("shared task workspace styles", () => {
  test("uses canonical design-kit roles without hosted-app aliases or generic task selectors", () => {
    expect(stylesheet).not.toMatch(
      /var\(--(?:agent|amber|blue|canvas|canvas-raised|human|line-strong|mono|panel|panel-strong|session|text)\)/u,
    );
    const classNames = new Set(
      [...stylesheet.matchAll(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/gu)]
        .map((match) => match[1])
        .filter((name): name is string => name !== undefined),
    );
    expect([...classNames].filter(
      (name) => !name.startsWith("task-") && !name.startsWith("jungle-"),
    )).toEqual([]);
    expect(stylesheet).not.toContain(".topbar");
    expect(stylesheet).not.toContain("@hraness/hra-web");
    expect(stylesheet).not.toContain("apps/web");
    expect(stylesheet).toContain("var(--font-mono)");
    expect(stylesheet).toContain("var(--foreground)");
    expect(stylesheet).toContain("var(--surface-hover)");
    expect(stylesheet).toContain(".task-eyebrow");
    expect(stylesheet).toContain(".task-button-row--end");
    expect(stylesheet).toContain(".task-text-button");
    expect(stylesheet).toContain(".task-result-limit");
  });

  test("keeps task tabs on the shared Jelly selection paint", () => {
    const taskTab = firstRule(".task-detail-tabs .jungle-tabs__tab");
    expect(taskTab).toContain("background: transparent");
    expect(taskTab).not.toContain("border-radius:");
    expect(stylesheet).not.toMatch(/\.jungle-tabs__tab\[data-selected\]\s*\{[^}]*background\s*:/u);
  });

  test("keeps task containers flat without clipping shared controls", () => {
    const workspace = firstRule(".task-workspace__body");
    const listPaneRules = ruleBodies(".task-list-pane");
    const initialListPane = listPaneRules[0] ?? "";
    const flatListPane = listPaneRules.find((rule) => rule.includes("background: transparent")) ?? "";

    expect(workspace).toContain("gap: var(--space-6)");
    expect(workspace).toContain("overflow: visible");
    expect(workspace).not.toMatch(/(?:background|border)\s*:/u);
    expect(initialListPane).not.toMatch(/(?:padding|background|border-radius)\s*:/u);
    expect(flatListPane).toContain("padding: 0");
    expect(flatListPane).toContain("border: 0");
    expect(flatListPane).toContain("border-radius: 0");
    expect(flatListPane).toContain("background: transparent");
    expect(flatListPane).not.toContain("border-right:");
  });

  test("preserves responsive list behavior and bounded filters", () => {
    expect(firstRule(".task-filter")).toContain("width: 8.75rem");
    expect(stylesheet).not.toContain(".task-view-navigation");
    expect(stylesheet).toMatch(
      /@media \(max-width:\s*60rem\)[\s\S]*?\.task-list\s*\{[^}]*contain:\s*layout inline-size;[^}]*overflow-x:\s*auto;/u,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width:\s*42rem\)[\s\S]*?\.task-details-meta\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u,
    );
  });

  test("keeps dense regions flat while sparse repeated content stays rounded", () => {
    const editor = firstRule(".task-editor");
    const claim = firstRule(".task-claim-card");
    const claimFact = firstRule(".task-claim-card dl > div");
    const taskItem = ruleBodies(".task-list-item")
      .filter((rule) => rule.includes("border-radius:"))
      .at(-1) ?? "";
    const graphColumn = firstRule(".task-graph-column");

    expect(editor).toContain("padding: clamp(1rem, 3vw, 1.6rem) 0");
    expect(editor).toContain("border-block: 1px solid");
    expect(editor).toContain("border-radius: 0");
    expect(editor).toContain("background: transparent");
    expect(editor).toContain("box-shadow: none");
    expect(claim).toContain("padding: 1.25rem 0 0");
    expect(claim).toContain("border: 0");
    expect(claim).toContain("border-top: 1px solid");
    expect(claim).toContain("border-radius: 0");
    expect(claim).toContain("background: transparent");
    expect(claimFact).toContain("border-radius: 0.35rem");
    expect(taskItem).toContain("border-radius: 0.7rem");
    expect(graphColumn).toContain("border-radius: 0.45rem");
  });

  test("leaves page spacing to the consumer shell", () => {
    const taskWorkspaceRules = ruleBodies(".task-workspace");
    expect(taskWorkspaceRules.length).toBeGreaterThan(1);
    for (const rule of taskWorkspaceRules) expect(rule).toContain("padding: 0");
    expect(stylesheet).not.toContain("padding: clamp(1.25rem, 3.5vw, 3.5rem)");
  });

  test("keeps task selection tonal and restores a forced-color edge", () => {
    const hover = ruleBodies(".task-list-item:hover").at(-1) ?? "";
    const selected = ruleBodies(".task-list-item[data-selected]")
      .filter((rule) => rule.includes("background:"))
      .at(-1) ?? "";

    expect(hover).toContain("background: color-mix(in srgb, var(--surface-hover) 44%, transparent)");
    expect(hover).toContain("box-shadow: none");
    expect(selected).toContain("border-radius: 0");
    expect(selected).toContain("background: color-mix(in srgb, var(--surface-hover) 72%, transparent)");
    expect(selected).toContain("box-shadow: inset 4px 0 0 var(--primary)");
    expect(stylesheet).toMatch(
      /@media \(forced-colors:\s*active\)[\s\S]*?\.task-list-item\[data-selected\]\s*\{[^}]*border-left:\s*4px solid Highlight;/u,
    );
  });

  test("keeps interaction options inside the full checkbox label", () => {
    const option = firstRule(".task-interaction-option.jungle-checkbox-field");
    const control = firstRule(".task-interaction-option .jungle-checkbox-field__control");

    expect(option).toContain("display: block");
    expect(option).toContain("padding: 0");
    expect(option).toContain("border: 0");
    expect(option).toContain("border-radius: var(--radius-lg)");
    expect(option).toContain("background: color-mix");
    expect(control).toContain("min-width: 0");
    expect(control).toContain("padding: 0.75rem");
    expect(control).toContain("border-radius: inherit");
    expect(stylesheet).not.toMatch(
      /\.task-interaction-option\.jungle-checkbox-field\s*\{[^}]*border-bottom:/u,
    );
  });
});
