import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  checkHraProductionIconBoundary,
} from "../production-icon-boundary";
import {
  type HraWebpackConfig,
  HraProductionIconModuleBoundaryPlugin,
  isForbiddenHraIconModuleIdentifier,
  withHraProductionIconBoundary,
} from "../next.config";

async function withProduct(
  files: Readonly<Record<string, string>>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hra-web-icon-boundary-"));
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

describe("HRA web production icon boundary", () => {
  test("accepts a non-empty icon-free Next.js output", async () => {
    await withProduct({
      ".next/server/app/page.js": "export default function Page() { return null; }",
      ".next/static/chunks/app.js": "self.webpackChunk_N_E = [];",
    }, async (directory) => {
      const result = await checkHraProductionIconBoundary(directory);
      expect(result.emitted.scanned).toHaveLength(2);
    });
  });

  test("rejects package paths and renderer markers in emitted assets", async () => {
    await withProduct({
      ".next/server/app/page.js.nft.json": '{"files":["node_modules/@hugeicons/react/index.js"]}',
      ".next/static/chunks/app.js": "renderer.displayName = 'HugeiconsIcon';",
    }, async (directory) => {
      await expect(checkHraProductionIconBoundary(directory)).rejects.toThrow(
        "forbidden icon markers",
      );
    });
  });

  test("rejects resolved package module identifiers on every platform", () => {
    expect(isForbiddenHraIconModuleIdentifier(
      "/repo/node_modules/.bun/@hugeicons+react@1.1.9/node_modules/@hugeicons/react/index.js",
    )).toBeTrue();
    expect(isForbiddenHraIconModuleIdentifier(
      "C:\\repo\\node_modules\\@hugeicons\\core-free-icons\\index.js",
    )).toBeTrue();
    expect(isForbiddenHraIconModuleIdentifier(
      "/repo/apps/web/app/hra-icon-runtime.tsx",
    )).toBeFalse();
  });

  test("aliases shared icon entry points and installs the module guard", () => {
    const fixture: HraWebpackConfig = {
      plugins: [],
      resolve: { alias: {} },
    };
    const configured = withHraProductionIconBoundary(fixture);

    expect(configured.resolve.alias?.["@hugeicons/core-free-icons"])
      .toEndWith("/apps/web/app/hra-icon-data.ts");
    expect(configured.resolve.alias?.["@hugeicons/react"])
      .toEndWith("/apps/web/app/hra-icon-runtime.tsx");
    expect(configured.plugins?.some(
      (plugin) => typeof plugin === "object"
        && plugin !== null
        && plugin instanceof HraProductionIconModuleBoundaryPlugin,
    )).toBeTrue();
  });

  test("fails closed when the production output is absent", async () => {
    await withProduct({}, async (directory) => {
      await expect(checkHraProductionIconBoundary(directory)).rejects.toThrow(
        "did not scan any emitted Next.js assets",
      );
    });
  });
});
