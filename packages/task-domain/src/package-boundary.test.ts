import { describe, expect, test } from "bun:test";

const sourceImport = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;

async function productionSources(): Promise<readonly Readonly<{
  name: string;
  text: string;
}>[]> {
  const sourceDirectory = new URL(".", import.meta.url).pathname;
  const glob = new Bun.Glob("*.ts");
  const names = [...glob.scanSync({ cwd: sourceDirectory, onlyFiles: true })]
    .filter((name) => !name.endsWith(".test.ts"));
  return Promise.all(names.map(async (name) => ({
    name,
    text: await Bun.file(new URL(`./${name}`, import.meta.url)).text(),
  })));
}

describe("task-domain package boundary", () => {
  test("is a leaf package with exactly one production dependency", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ "@hra-internal/schema": "workspace:*" });
  });

  test("production source imports only the schema package and local modules", async () => {
    const sources = await productionSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const { text } of sources) {
      for (const match of text.matchAll(sourceImport)) {
        const specifier = match[1];
        expect(
          specifier === "@hra-internal/schema" || specifier?.startsWith("./") === true,
        ).toBeTrue();
      }
    }
  });

  test("has no provider, transport, storage, token, or cryptographic imports", async () => {
    const production = await productionSources();
    const imports = production.flatMap(({ text }) =>
      [...text.matchAll(sourceImport)].map((match) => match[1] ?? ""));
    for (const forbidden of [
      "convex",
      "workos",
      "next",
      "sqlite",
      "node:fs",
      "crypto",
      "tokens",
      "http",
    ]) {
      expect(imports.some((specifier) => specifier.toLowerCase().includes(forbidden))).toBeFalse();
    }
  });

  test("contains no cloud tenant or client-request event contracts", async () => {
    const production = (await productionSources()).map(({ text }) => text).join("\n");
    for (const forbidden of [
      "organizationId",
      "idempotencyKey",
      "requestId",
      "uuidV7",
      "eventCommandSchema",
    ]) {
      expect(production).not.toContain(forbidden);
    }
  });

  test("exports only production roots and exposes no fixture or provider subpath", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      exports: Record<string, string>;
    };
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./model": "./src/model.ts",
    });
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      expect(`${subpath}:${target}`).not.toMatch(/(?:test|fixture|convex|workos|provider)/iu);
    }
  });
});
