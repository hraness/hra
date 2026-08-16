import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { checkAgentTasksProductionBoundary } from "./check-production-boundary";

async function withProduct(
  files: Readonly<Record<string, string>>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-tasks-direct-boundary-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(directory, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("Agent Tasks production Direct boundary", () => {
  test("accepts non-empty production source and emitted graphs", async () => {
    await withProduct({
      "app/page.tsx": "export default function Page() { return null; }",
      ".next/server/app/page.js": "production page",
    }, async (directory) => {
      const result = await checkAgentTasksProductionBoundary(directory);
      expect(result.source.scanned).toHaveLength(1);
      expect(result.emitted.scanned).toHaveLength(1);
    });
  });

  test("rejects source imports and emitted browser-lab globals", async () => {
    await withProduct({
      "app/page.tsx": 'import { world } from "../direct/world";',
      ".next/static/chunks/app.js": "window.__direct = {};",
    }, async (directory) => {
      await expect(checkAgentTasksProductionBoundary(directory)).rejects.toThrow(
        "Agent Tasks production assets contain Direct markers",
      );
    });
  });

  test("rejects alias imports and emitted workbench CSS", async () => {
    await withProduct({
      "app/page.tsx": 'import "@/direct/workbench.css";',
      ".next/static/css/app.css": ".direct-workbench{display:grid}",
    }, async (directory) => {
      await expect(checkAgentTasksProductionBoundary(directory)).rejects.toThrow("@/direct");
      await expect(checkAgentTasksProductionBoundary(directory)).rejects.toThrow(
        ".direct-workbench",
      );
    });
  });

  test("rejects markers in secondary source roots and every textual emitted surface", async () => {
    await withProduct({
      "app/page.tsx": "export default function Page() { return null; }",
      "lib/transport.ts": "export const marker = '__direct';",
      ".next/server/app/page.html": "<main data-agent-tasks-direct></main>",
      ".next/server/app/page.rsc": "AgentTasksDirect",
      ".next/static/chunks/app.js.map": '{"sourceRoot":".direct-workbench"}',
    }, async (directory) => {
      await expect(checkAgentTasksProductionBoundary(directory)).rejects.toThrow("lib/transport.ts");
      await expect(checkAgentTasksProductionBoundary(directory)).rejects.toThrow("page.html");
      await expect(checkAgentTasksProductionBoundary(directory)).rejects.toThrow("page.rsc");
      await expect(checkAgentTasksProductionBoundary(directory)).rejects.toThrow("app.js.map");
    });
  });

  test("fails closed when source or emitted output is absent", async () => {
    await withProduct({ "app/page.tsx": "export default function Page() { return null; }" }, async (directory) => {
      await expect(checkAgentTasksProductionBoundary(directory)).rejects.toThrow("emitted Next.js assets");
    });
    await withProduct({ ".next/server/app/page.js": "production page" }, async (directory) => {
      await expect(checkAgentTasksProductionBoundary(directory)).rejects.toThrow("production source files");
    });
  });
});
