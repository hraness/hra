import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertReleasePackageReady,
  inspectReleasePackage,
  releaseArchiveName,
} from "./release-package-policy";

const readyManifest = {
  bin: { hra: "./src/cli.ts" },
  dependencies: { "@hraness/oh": "0.2.3", zod: "4.4.3" },
  license: "MIT",
  name: "@hraness/hra",
  publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
  version: "1.2.3",
};

describe("HRA public release package policy", () => {
  test("accepts one public MIT scoped package with registry-only runtime dependencies", () => {
    expect(assertReleasePackageReady(readyManifest)).toEqual({
      blockers: [],
      name: "@hraness/hra",
      version: "1.2.3",
    });
    expect(releaseArchiveName("1.2.3")).toBe("hraness-hra-1.2.3.tgz");
  });

  test("fails closed on GitHub, URL, workspace, range, and moving runtime dependencies", () => {
    for (const version of [
      "github:hraness/oh#v0.2.0",
      "https://example.com/oh.tgz",
      "workspace:*",
      "^0.2.3",
      "latest",
    ]) {
      const manifest = structuredClone(readyManifest);
      manifest.dependencies["@hraness/oh"] = version;
      expect(() => assertReleasePackageReady(manifest)).toThrow("non-registry runtime dependencies");
    }
  });

  test("records the current unpublished Oh dependency as the only release blocker", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8"),
    ) as unknown;
    expect(inspectReleasePackage(manifest)).toEqual({
      blockers: ["@hraness/oh=github:hraness/oh#v0.2.0"],
      name: "@hraness/hra",
      version: "0.1.0",
    });
    expect(() => assertReleasePackageReady(manifest)).toThrow("@hraness/oh=github:hraness/oh#v0.2.0");
  });
});
