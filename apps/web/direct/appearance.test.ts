import { describe, expect, test } from "bun:test";

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text();
}

describe("Agent Tasks lab appearance", () => {
  test("uses the shared light-first appearance runtime without fixed-dark literals", async () => {
    const [document, main, stylesheet, workbench] = await Promise.all([
      source("./index.html"),
      source("./main.tsx"),
      source("./workbench.css"),
      source("./workbench.tsx"),
    ]);

    expect(document).toContain('data-theme="light"');
    expect(main).toContain("<DesignThemeProvider>");
    expect(main).toContain("<ThemeColorSync />");
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
