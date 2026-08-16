import { describe, expect, test } from "bun:test";

import {
  decideVercelDeployment,
  hasBoundedWorkspaceLockExplanation,
  type WorkspaceDeploymentNode,
} from "./vercel-deploy-gate";

const workspaces: readonly WorkspaceDeploymentNode[] = [
  {
    dependencies: ["@hra-internal/design-kit"],
    name: "@hraness/hra-web",
    rootDirectory: "apps/web",
  },
  {
    dependencies: [],
    name: "@hra-internal/design-kit",
    rootDirectory: "packages/internal/design-kit",
  },
  {
    dependencies: [],
    name: "@hraness/hra",
    rootDirectory: "apps/desktop",
  },
];

describe("standalone Vercel deploy gate", () => {
  test("builds for the web workspace, transitive packages, and gate policy", () => {
    for (const path of [
      "apps/web/app/page.tsx",
      "packages/internal/design-kit/src/index.ts",
      "scripts/vercel-deploy-gate.ts",
    ]) {
      expect(decideVercelDeployment("@hraness/hra-web", [path], workspaces).action)
        .toBe("build");
    }
  });

  test("skips an unrelated desktop-only change", () => {
    expect(
      decideVercelDeployment(
        "@hraness/hra-web",
        ["apps/desktop/runtime/main.ts"],
        workspaces,
      ),
    ).toEqual({
      action: "skip",
      matchedPaths: [],
      reason: "only unrelated workspace or repository files changed",
    });
  });

  test("accepts only standalone workspace manifests as bounded lock explanations", () => {
    expect(hasBoundedWorkspaceLockExplanation([
      "bun.lock",
      "packages/internal/design-kit/package.json",
    ])).toBeTrue();
    expect(hasBoundedWorkspaceLockExplanation([
      "bun.lock",
      "docs/migration-inventory.md",
    ])).toBeFalse();
  });
});
