import { describe, expect, test } from "bun:test";

import {
  standalonePackageErrors,
  standaloneSourceErrors,
} from "./check-standalone";

describe("standalone source policy", () => {
  test("rejects monorepo imports, paths, and depth assumptions", () => {
    expect(standaloneSourceErrors([
      { path: "src/import.ts", source: ['import "@jun', 'gle/schema";'].join("") },
      {
        path: "src/regex.ts",
        source: ["/@jun", "gle\\/schema/"].join(""),
      },
      { path: "src/path.ts", source: ["pro", "jects/op", "rte/apps/web"].join("") },
      { path: "src/env.ts", source: ["NEXT_PUBLIC_JUN", "GLE_API_URL"].join("") },
      {
        path: "src/checkout.ts",
        source: ["/Users/example/Documents/jun", "gle/apps"].join(""),
      },
      { path: "docs/guide.md", source: ["Jun", "gle workspace"].join("") },
      { path: "apps/web/package.json", source: ["../../", "../../scripts/check.ts"].join("") },
    ])).toEqual([
      "apps/web/package.json: contains former monorepo-depth relative path",
      "docs/guide.md: contains former repository identity assumption",
      "src/checkout.ts: contains developer-specific former checkout path",
      "src/env.ts: contains former monorepo environment authority",
      "src/import.ts: contains private monorepo package import",
      "src/path.ts: contains former monorepo product path",
      "src/regex.ts: contains private monorepo package import",
    ]);
  });

  test("permits the checked compatibility manifest", () => {
    expect(standaloneSourceErrors([
      {
        path: "hra-legacy-identifiers.manifest.json",
        source: ["Jun", "gle repository pro", "jects/op", "rte"].join(""),
      },
    ])).toEqual([]);
  });

  test("permits a deep import that resolves to a standalone root utility", () => {
    expect(standaloneSourceErrors([
      {
        path: "apps/desktop/frontend/direct/check.ts",
        source: ["../../", "../../scripts/direct/check"].join(""),
      },
    ])).toEqual([]);
  });
});

describe("standalone package graph", () => {
  test("rejects unresolved workspace and catalog protocols", () => {
    expect(standalonePackageErrors([
      {
        path: "package.json",
        value: { name: "hra", workspaces: { catalog: { zod: "1.0.0" } } },
      },
      {
        path: "apps/example/package.json",
        value: {
          name: "@hraness/example",
          dependencies: { "@hraness/missing": "workspace:*", react: "catalog:" },
        },
      },
    ])).toEqual([
      "apps/example/package.json: @hraness/missing uses workspace:* but is not a workspace",
      "apps/example/package.json: react uses catalog: but is absent from workspaces.catalog",
    ]);
  });

  test("permits the internal SDK and rejects workspaces owned by excluded repositories", () => {
    expect(standalonePackageErrors([
      {
        path: "package.json",
        value: {
          name: "hra",
          workspaces: { catalog: {} },
        },
      },
      {
        path: "packages/internal/codex-app-sdk/package.json",
        value: { name: "@hra-internal/codex-app-sdk" },
      },
      {
        path: "packages/task-ui/package.json",
        value: {
          name: "@hraness/agent-tasks-ui",
          dependencies: { "@hra-internal/codex-app-sdk": "workspace:*" },
        },
      },
      {
        path: "packages/internal/identity/package.json",
        value: { name: "@hra-internal/identity" },
      },
      {
        path: "apps/example/package.json",
        value: {
          name: "@hraness/example",
          dependencies: { "@hra-internal/identity": "workspace:*" },
        },
      },
    ])).toEqual([
      "packages/internal/identity/package.json: excluded workspace @hra-internal/identity is present",
      "apps/example/package.json: @hra-internal/identity must not use the workspace protocol",
    ]);
  });
});
