import { describe, expect, test } from "bun:test";

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text();
}

describe("Agent Tasks lab appearance", () => {
  test("uses the shared system-first runtime with a concrete light bootstrap fallback", async () => {
    const [document, main, stylesheet, verifier, workbench] = await Promise.all([
      source("./index.html"),
      source("./main.tsx"),
      source("./workbench.css"),
      source("./verify-browser.ts"),
      source("./workbench.tsx"),
    ]);

    expect(document).toContain('data-theme="light"');
    expect(document).toContain('<meta name="theme-color" content="#fbf6f2" media="(prefers-color-scheme: light)" />');
    expect(document).toContain('<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />');
    expect(main).toContain("<DesignThemeProvider>");
    expect(main).toContain("<ThemeColorSync />");
    expect(verifier).toContain('{ expectedColor: colors.light.background, os: "dark", preference: "light" }');
    expect(verifier).toContain('{ expectedColor: colors.dark.background, os: "light", preference: "dark" }');
    expect(verifier).toContain('media !== "not all"');
    expect(verifier).toContain("evidence.matchingColors.length !== 1");
    expect(main.indexOf('import "../app/globals.css"')).toBeLessThan(
      main.indexOf('import "@hraness/agent-tasks-ui/styles.css"'),
    );
    expect(main.indexOf('import "@hraness/agent-tasks-ui/styles.css"')).toBeLessThan(
      main.indexOf('import "./workbench.css"'),
    );
    expect(workbench).toContain("<ThemeToggle");
    expect(stylesheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    expect(stylesheet).not.toMatch(/rgba?\(/u);
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
