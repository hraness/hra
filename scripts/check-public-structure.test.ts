import { describe, expect, test } from "bun:test";

import {
  publicStructureErrors,
  type WorkspaceManifest,
} from "./check-public-structure";

const repositoryUrl = "git+https://github.com/hraness/hra.git";
const homepage = "https://hra.sh";
const bugs = { url: "https://github.com/hraness/hra/issues" } as const;

const names = new Map([
  ["apps/cli", "@hraness/hra-cli"],
  ["apps/desktop", "@hraness/hra"],
  ["apps/web", "@hraness/hra-web"],
  ["packages/human-client", "@hraness/hra-human-client"],
  ["packages/internal/brand-ui", "@hra-internal/brand-ui"],
  ["packages/internal/browser-storage", "@hra-internal/browser-storage"],
  ["packages/internal/convex", "@hra-internal/convex"],
  ["packages/internal/codex-app-sdk", "@hra-internal/codex-app-sdk"],
  ["packages/internal/design-kit", "@hra-internal/design-kit"],
  ["packages/internal/eslint-config", "@hra-internal/eslint-config"],
  ["packages/internal/schema", "@hra-internal/schema"],
  ["packages/internal/test", "@hra-internal/test"],
  ["packages/internal/typescript-config", "@hra-internal/typescript-config"],
  ["packages/task-domain", "@hraness/agent-tasks-domain"],
  ["packages/task-protocol", "@hraness/agent-tasks-protocol"],
  ["packages/task-ui", "@hraness/agent-tasks-ui"],
]);

function metadata(directory?: string): Record<string, unknown> {
  return {
    bugs,
    homepage,
    license: directory === "packages/internal/codex-app-sdk" ? "MIT" : "Apache-2.0",
    private: true,
    repository: {
      type: "git",
      url: repositoryUrl,
      ...(directory === undefined ? {} : { directory }),
    },
  };
}

function completeFixture(): Readonly<{
  manifests: readonly WorkspaceManifest[];
  presentPaths: ReadonlySet<string>;
}> {
  const manifests: WorkspaceManifest[] = [{
    path: "package.json",
    value: {
      ...metadata(),
      name: "hra",
      packageManager: "bun@1.3.14",
      devDependencies: { "agent-browser": "catalog:" },
      scripts: {
        build: "bun run scripts/check-resource-scheduler.ts --mode=exclusive --label=HRA-production-build -- bun run build:uncoordinated",
        check: "bun run scripts/check-resource-scheduler.ts --mode=heavy --label=HRA-source-check -- bun run check:uncoordinated",
        "check:complete": "bun run scripts/check-resource-scheduler.ts --mode=exclusive --label=HRA-complete-check -- bun run check:complete:uncoordinated",
        "check:public-boundary": "bun run scripts/check-public-boundary.ts",
        "check:public-tree": "bun run scripts/check-public-tree.ts",
        "check:structure": "bun run scripts/check-public-structure.ts",
        hra: "bun run dev:desktop",
        "lint:workspaces": "bun run --sequential --filter '@hraness/*' --filter '@hra-internal/*' lint",
        test: "bun run --sequential --filter '@hraness/*' --filter '@hra-internal/*' test",
        "typecheck:workspaces": "bun run --sequential --filter '@hraness/*' --filter '@hra-internal/*' typecheck",
      },
      workspaces: {
        catalog: {
          "@hraness/direct": "github:hraness/direct#v0.7.0",
          "@hraness/vercel-delivery": "github:hraness/vercel-delivery#v0.1.2",
          "@hraness/web-discovery": "github:hraness/web-discovery#v0.1.0",
          "agent-browser": "0.32.3",
          "react-aria-components": "1.19.0",
        },
        packages: ["apps/*", "packages/*", "packages/internal/*"],
      },
    },
  }];
  for (const [directory, name] of names) {
    manifests.push({
      path: `${directory}/package.json`,
      value: {
        ...metadata(directory),
        name,
        ...(directory === "apps/desktop"
          ? {
              scripts: {
                test: "bun test ./frontend/src ./frontend/dev ./frontend/direct ./contracts ./runtime/test --path-ignore-patterns='**/gateway.integration.test.ts' --path-ignore-patterns='**/application-support-migration.test.ts' --path-ignore-patterns='**/feasibility.test.ts' --path-ignore-patterns='**/provider-thread-archive-startup-v57.test.ts' --path-ignore-patterns='**/*.macos.test.ts' && bun run test:application-support-migration && bun run test:feasibility && bun run test:provider-thread-archive-startup-v57 && bun run test:gateway",
                "test:application-support-migration": "bun test ./runtime/test/application-support-migration.test.ts",
                "test:feasibility": "bun test ./runtime/test/feasibility.test.ts",
                "test:provider-thread-archive-startup-v57": "bun test ./runtime/test/provider-thread-archive-startup-v57.test.ts",
              },
            }
          : {}),
        ...(directory === "apps/desktop"
          || directory === "apps/web"
          || directory === "packages/task-ui"
          ? { dependencies: { "@hra-internal/codex-app-sdk": "workspace:*" } }
          : {}),
        ...(directory === "apps/web"
          ? {
              dependencies: {
                "@hra-internal/codex-app-sdk": "workspace:*",
                "@hraness/vercel-delivery": "catalog:",
                "@hraness/web-discovery": "catalog:",
              },
            }
          : {}),
      },
    });
  }
  const presentPaths = new Set([
    ".bun-version",
    ".github/workflows/ci.yml",
    ".gitignore",
    ".node-version",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "SECURITY_ARCHITECTURE.md",
    "THIRD_PARTY_NOTICES.md",
    "TRADEMARKS.md",
    "apps/web/next-env.d.ts",
    "bun.lock",
    "bunfig.toml",
    "hra-legacy-identifiers.manifest.json",
    "package.json",
    "packages/internal/codex-app-sdk/LICENSE",
    "packages/internal/codex-app-sdk/PROVENANCE.md",
    "scripts/check-public-boundary.ts",
    "scripts/check-public-structure.ts",
    "scripts/check-public-tree.ts",
    "scripts/check-resource-scheduler.ts",
    "scripts/check-standalone.ts",
    "scripts/direct/agent-browser.verify.json",
    "scripts/public-tree.manifest.json",
    "scripts/vercel-deploy-gate.ts",
    ...[...names.keys()].map((directory) => `${directory}/AGENTS.md`),
  ]);
  return { manifests, presentPaths };
}

describe("public repository structure", () => {
  test("accepts the exact public workspace and file set", () => {
    expect(publicStructureErrors(completeFixture())).toEqual([]);
  });

  test("rejects excluded paths and workspace metadata drift", () => {
    const fixture = completeFixture();
    const manifests = fixture.manifests.map((manifest) =>
      manifest.path === "packages/human-client/package.json"
        ? {
            ...manifest,
            value: {
              ...(manifest.value as Record<string, unknown>),
              license: "UNLICENSED",
            },
          }
        : manifest);
    const presentPaths = new Set(fixture.presentPaths);
    const privateWorkspace = ["packages/internal/", "identity"].join("");
    presentPaths.add(privateWorkspace);
    const errors = publicStructureErrors({ manifests, presentPaths });
    expect(errors).toContain(
      "packages/human-client/package.json: license must be Apache-2.0",
    );
    expect(errors).toContain(`${privateWorkspace}: excluded private path is present`);
  });

  test("rejects an external SDK pin and a non-workspace internal SDK edge", () => {
    const fixture = completeFixture();
    const manifests = fixture.manifests.map((manifest) => {
      if (manifest.path === "package.json") {
        const value = manifest.value as Record<string, unknown>;
        const workspaces = value["workspaces"] as Record<string, unknown>;
        return {
          ...manifest,
          value: {
            ...value,
            workspaces: {
              ...workspaces,
              catalog: {
                "@hraness/codex-app-sdk":
                  "github:hraness/codex-app-sdk#e7d5167ca5389ac834714a8a0a2c1602071963e2",
              },
            },
          },
        };
      }
      if (manifest.path === "packages/task-ui/package.json") {
        return {
          ...manifest,
          value: {
            ...(manifest.value as Record<string, unknown>),
            dependencies: { "@hra-internal/codex-app-sdk": "catalog:" },
          },
        };
      }
      return manifest;
    });
    const errors = publicStructureErrors({
      manifests,
      presentPaths: fixture.presentPaths,
    });
    expect(errors).toContain(
      "package.json: external Codex App SDK catalog pin must be absent",
    );
    expect(errors).toContain(
      "packages/task-ui/package.json: Codex App SDK must use the internal workspace",
    );
  });

  test("rejects mutable shared-package pins and the retired discovery workspace edge", () => {
    const fixture = completeFixture();
    const manifests = fixture.manifests.map((manifest) => {
      if (manifest.path === "package.json") {
        const value = manifest.value as Record<string, unknown>;
        const workspaces = value["workspaces"] as Record<string, unknown>;
        const catalog = workspaces["catalog"] as Record<string, unknown>;
        return {
          ...manifest,
          value: {
            ...value,
            workspaces: {
              ...workspaces,
              catalog: { ...catalog, "@hraness/direct": "github:hraness/direct#main" },
            },
          },
        };
      }
      if (manifest.path === "apps/web/package.json") {
        const value = manifest.value as Record<string, unknown>;
        return {
          ...manifest,
          value: {
            ...value,
            dependencies: {
              ...(value["dependencies"] as Record<string, unknown>),
              "@hra-internal/web-discovery": "workspace:*",
            },
          },
        };
      }
      return manifest;
    });
    const errors = publicStructureErrors({
      manifests,
      presentPaths: fixture.presentPaths,
    });
    expect(errors).toContain(
      "package.json: @hraness/direct must use immutable release github:hraness/direct#v0.7.0",
    );
    expect(errors).toContain(
      "apps/web/package.json: shared delivery and discovery packages must use the catalog",
    );
  });
});
