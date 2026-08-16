import { describe, expect, test } from "bun:test";

import {
  assertHraProductionModuleIds,
  hraProductionModuleBoundaryPlugin,
  productionModuleBoundaryViolations,
} from "../vite.config";

describe("HRA production module boundary", () => {
  test("admits the local adapter and shared build-time styles", () => {
    const moduleIds = [
      "/repo/apps/desktop/frontend/src/ui.tsx",
      "/repo/node_modules/@hraness/ui/src/components.css",
      "/repo/packages/internal/design-kit/src/tokens.css",
      "/repo/packages/internal/design-kit/src/reset.css",
      "/repo/node_modules/react-aria-components/dist/import.mjs",
    ];

    expect(productionModuleBoundaryViolations(moduleIds)).toEqual([]);
    expect(() => assertHraProductionModuleIds(moduleIds)).not.toThrow();
  });

  test("rejects Hugeicons and design-kit React modules by resolved ID", () => {
    const moduleIds = [
      "/repo/node_modules/.bun/@hugeicons+react@1.1.9/node_modules/@hugeicons/react/dist/index.js",
      "/repo/packages/internal/design-kit/src/react/gallery.tsx",
      "@hra-internal/design-kit/react",
    ];

    expect(productionModuleBoundaryViolations(moduleIds).map(({ rule }) => rule).sort())
      .toEqual([
        "Hugeicons JavaScript",
        "design-kit React JavaScript",
        "design-kit React JavaScript",
      ].sort());
    expect(() => assertHraProductionModuleIds(moduleIds)).toThrow(
      "production renderer contains forbidden module IDs",
    );
  });

  test("fails closed when Rollup reports no compiled module IDs", () => {
    expect(() => assertHraProductionModuleIds([])).toThrow(
      "did not inspect a compiled chunk",
    );
    const plugin = hraProductionModuleBoundaryPlugin();
    expect(plugin.apply).toBe("build");
    expect(plugin.name).toBe("hra-production-module-boundary");
    expect(typeof plugin.generateBundle).toBe("function");
  });
});
