import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectImportGraph, findImportCycles } from "./check-import-cycles";

const sourceRoot = join(import.meta.dirname, "..", "src");

async function withFixture(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void> | void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hra-import-cycles-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("import cycle check", () => {
  test("src has zero file-level import cycles", () => {
    const graph = collectImportGraph(sourceRoot);
    expect(graph.size).toBeGreaterThan(50);
    expect(findImportCycles(graph)).toEqual([]);
  });

  test("reports a two-file cycle including type-only and dynamic edges", async () => {
    await withFixture({
      "a.ts": 'import type { B } from "./b.ts";\nexport type A = { b: B };\n',
      "b.ts": 'export type B = { a: import("./a").A };\nexport const load = () => import("./a");\n',
      "leaf.ts": "export const leaf = 1;\n",
      "c/index.ts": 'export { leaf } from "../leaf";\n',
      "d.ts": 'import { leaf } from "./c";\nexport const d = leaf;\n',
    }, (root) => {
      const graph = collectImportGraph(root);
      expect(graph.get("d.ts")).toEqual(["c/index.ts"]);
      expect(graph.get("c/index.ts")).toEqual(["leaf.ts"]);
      expect(findImportCycles(graph)).toEqual([["a.ts", "b.ts"]]);
    });
  });

  test("ignores package specifiers, self imports, and unresolved relative paths", async () => {
    await withFixture({
      "a.ts": 'import { z } from "zod";\nimport "./a";\nimport { x } from "./missing";\nexport const a = z;\n',
    }, (root) => {
      const graph = collectImportGraph(root);
      expect(graph.get("a.ts")).toEqual([]);
      expect(findImportCycles(graph)).toEqual([]);
    });
  });

  test("finds a longer cycle once and sorts its members", async () => {
    await withFixture({
      "x.ts": 'import "./y";\n',
      "y.ts": 'import "./z";\n',
      "z.ts": 'import "./x";\nimport "./w";\n',
      "w.ts": "export {};\n",
    }, (root) => {
      expect(findImportCycles(collectImportGraph(root))).toEqual([["x.ts", "y.ts", "z.ts"]]);
    });
  });
});
