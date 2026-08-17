import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildLegacyManifest,
  collectPublicBoundaryEntries,
  parseLegacyManifest,
  publicBoundaryErrors,
  validateLegacyManifest,
} from "./check-public-boundary";

describe("public repository boundary", () => {
  test("collects source without local compiler cache debris", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-public-collector-"));
    try {
      await mkdir(join(root, "apps/desktop/.zig-cache"), { recursive: true });
      await mkdir(join(root, "apps/web"), { recursive: true });
      await writeFile(join(root, "apps/desktop/.zig-cache/object.o"), "cache");
      await writeFile(join(root, "apps/web/tsconfig.tsbuildinfo"), "cache");
      await writeFile(join(root, "apps/web/source.ts"), "export {};\n");
      const paths = (await collectPublicBoundaryEntries(root))
        .map(({ path }) => path);
      expect(paths).toContain("apps/web/source.ts");
      expect(paths.some(path => path.includes(".zig-cache"))).toBeFalse();
      expect(paths.some(path => path.endsWith(".tsbuildinfo"))).toBeFalse();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects excluded authority, generated output, and unsafe file kinds", () => {
    const authorityPath = ["release", "authority.json"].join("-");
    const excludedPackage = ["packages/codex-", "app-sdk"].join("");
    expect(publicBoundaryErrors([
      { kind: "file", path: authorityPath, source: "{}" },
      { kind: "directory", path: "apps/web/.next" },
      { kind: "directory", path: "apps/desktop/.zig-cache" },
      { kind: "file", path: "apps/web/tsconfig.tsbuildinfo" },
      { kind: "symlink", path: "packages/link", source: "../outside" },
      { kind: "directory", path: excludedPackage },
      { kind: "special", path: "scripts/control.pipe" },
      { kind: "file", path: "apps/web/.env.production", source: "" },
    ])).toEqual([
      "apps/desktop/.zig-cache: generated build output is present",
      "apps/web/.env.production: private environment file is present",
      "apps/web/.next: generated build output is present",
      "apps/web/tsconfig.tsbuildinfo: generated build output is present",
      `${excludedPackage}: excluded private path is present`,
      "packages/link: symbolic links are forbidden",
      `${authorityPath}: excluded private path is present`,
      "scripts/control.pipe: special files are forbidden",
    ]);
  });

  test("rejects private coordinates, credentials, checkout paths, and labels", () => {
    const formerLabel = ["Jun", "gle fixture"].join("");
    const credential = ["CONVEX", "DEPLOY", "KEY"].join("_");
    const privatePath = ["/Users/", "maintainer", "/Documents/source"].join("");
    const privateRepository = ["hraness/hra", "-ops"].join("");
    const providerIdentifier = ["prj", "_1234567890"].join("");
    const repositoryIdentifier = ["repository", "Id: ", "12345", "67890"].join("");
    expect(publicBoundaryErrors([
      {
        kind: "file",
        path: "src/private.ts",
        source: [
          formerLabel,
          credential,
          privatePath,
          privateRepository,
          providerIdentifier,
          repositoryIdentifier,
        ].join("\n"),
      },
    ])).toEqual([
      "src/private.ts: contains an unaudited former-workspace label",
      "src/private.ts: contains a provider deployment identifier",
      "src/private.ts: contains a numeric repository identifier",
      "src/private.ts: contains a private provider credential name",
      "src/private.ts: contains a developer-specific absolute path",
      "src/private.ts: contains private operations repository",
    ]);
  });

  test("allows reviewed UI tokens, public client origins, and runtime compatibility bytes", () => {
    expect(publicBoundaryErrors([
      {
        kind: "file",
        path: "packages/ui/styles.css",
        source: ".jungle-visually-hidden { color: var(--jungle-foreground); }",
      },
      {
        kind: "file",
        path: "apps/desktop/runtime/src/compatibility.ts",
        source: [
          "const oldService = 'OPRTE';",
          "const oldAccount = 'Kitchen';",
          "const cloud = 'https://example.convex.cloud';",
          "const blob = 'https://example.public.blob.vercel-storage.com';",
          "const fixture = '/Users/example/project';",
        ].join("\n"),
      },
    ])).toEqual([]);
  });
});

describe("reviewed runtime compatibility bytes", () => {
  test("pins exact matching lines and rejects drift or stale entries", () => {
    const expected = buildLegacyManifest([
      { path: "src/old.ts", source: "OPRTE" },
      { path: "src/stale.ts", source: "Kitchen" },
    ]);
    const actual = buildLegacyManifest([
      { path: "src/new.ts", source: "OPRTE" },
      { path: "src/old.ts", source: "OPRTE Kitchen" },
    ]);
    expect(validateLegacyManifest(actual, expected)).toEqual([
      "src/new.ts: legacy identifiers are not audited",
      "src/old.ts: legacy identifier evidence drifted",
      "hra-legacy-identifiers.manifest.json: stale entry for src/stale.ts",
    ]);
  });

  test("accepts only the public compatibility category", () => {
    expect(parseLegacyManifest({ version: 1, entries: [] })).toEqual({
      entries: [],
      version: 1,
    });
    expect(() => parseLegacyManifest({
      version: 1,
      entries: [{
        category: "historical",
        matchingLinesSha256: "a".repeat(64),
        occurrences: { kitchen: 0, operateStylized: 0, oprte: 1 },
        path: "docs/history.md",
      }],
    })).toThrow("compatibility path");
  });
});
