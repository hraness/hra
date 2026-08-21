import { describe, expect, test } from "bun:test";

const sourceImport = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](?<specifier>\.[^"']+)["']/gu;

async function resolveSource(from: URL, specifier: string): Promise<URL> {
  for (const extension of ["", ".ts", ".tsx"]) {
    const candidate = new URL(`${specifier}${extension}`, from);
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${from.pathname}`);
}

async function productionSourceGraph(entry: URL): Promise<ReadonlyMap<string, string>> {
  const pending = [entry];
  const graph = new Map<string, string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || graph.has(current.href)) continue;
    const source = await Bun.file(current).text();
    graph.set(current.href, source);
    for (const match of source.matchAll(sourceImport)) {
      const specifier = match.groups?.specifier;
      if (specifier !== undefined) pending.push(await resolveSource(current, specifier));
    }
  }
  return graph;
}

describe("task UI package boundary", () => {
  test("keeps fixtures solely behind the fixture subpath", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      exports?: Record<string, string>;
    };
    const graph = await productionSourceGraph(new URL("./index.ts", import.meta.url));
    const root = graph.get(new URL("./index.ts", import.meta.url).href) ?? "";

    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./fixtures": "./src/fixtures.ts",
      "./styles.css": "./src/styles.css",
    });
    expect(root).not.toContain("fixture");
    expect([...graph.keys()].some((path) => path.includes("fixture"))).toBeFalse();
    expect(await Bun.file(new URL("./fixtures.ts", import.meta.url)).text())
      .toBe('export * from "./task-workspace-fixtures";\n');
  });

  test("keeps the production source graph provider and authority neutral", async () => {
    const graph = await productionSourceGraph(new URL("./index.ts", import.meta.url));
    const production = [...graph.values()].join("\n");

    for (const forbidden of [
      "next/",
      "convex/",
      "@convex-dev/auth",
      "@auth/",
      "identity-provider",
      "Native",
      "SQLite",
      "node:fs",
      "bun:sqlite",
      "_generated/api",
      "task-workspace-fixtures",
    ]) {
      expect(production).not.toContain(forbidden);
    }
  });

  test("keeps icon actions on the intrinsic accessible-tooltip contract", async () => {
    const workspace = await Bun.file(new URL("./task-workspace.tsx", import.meta.url)).text();

    expect(workspace).toMatch(
      /<IconButton\s+aria-label="Dismiss command notice"[\s\S]*?tooltip="Dismiss notice"/u,
    );
    expect(workspace).toMatch(
      /<IconButton\s+aria-label=\{`Remove \$\{value\} label`\}[\s\S]*?tooltip=\{`Remove \$\{value\}`\}/u,
    );
    expect(workspace).not.toContain("<Tooltip");
  });
});
