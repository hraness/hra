import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  HRA_RELEASE_OH_VERSION,
  assertReleasePackageReady,
  inspectReleasePackage,
  releaseArchiveName,
} from "./release-package-policy";

const readyManifest = {
  bin: { hra: "./src/cli.ts" },
  dependencies: { "@hraness/oh": "0.2.7", zod: "4.4.3" },
  license: "MIT",
  name: "@hraness/hra",
  publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
  version: "1.2.3",
};

describe("HRA public release package policy", () => {
  test("accepts one public MIT scoped package with the exact public Oh release", () => {
    expect(HRA_RELEASE_OH_VERSION).toBe("0.2.7");
    expect(assertReleasePackageReady(readyManifest)).toEqual({
      blockers: [],
      name: "@hraness/hra",
      version: "1.2.3",
    });
    expect(releaseArchiveName("1.2.3")).toBe("hraness-hra-1.2.3.tgz");
  });

  test("fails closed on GitHub, URL, workspace, range, moving, and wrong exact Oh dependencies", () => {
    for (const version of [
      "github:hraness/oh#v0.2.0",
      "https://example.com/oh.tgz",
      "workspace:*",
      "^0.2.7",
      "latest",
      "0.2.6",
      "0.2.8",
    ]) {
      const manifest = structuredClone(readyManifest);
      manifest.dependencies["@hraness/oh"] = version;
      expect(() => assertReleasePackageReady(manifest)).toThrow("runtime dependency policy");
    }
  });

  test("requires the Oh dependency to be present", () => {
    const manifest = structuredClone(readyManifest) as {
      dependencies: Record<string, string>;
    };
    delete manifest.dependencies["@hraness/oh"];
    expect(inspectReleasePackage(manifest).blockers).toEqual(["@hraness/oh=<missing>"]);
  });

  test("records the current public Oh dependency as release-ready", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8"),
    ) as unknown;
    expect(inspectReleasePackage(manifest)).toEqual({
      blockers: [],
      name: "@hraness/hra",
      version: "0.2.1",
    });
    expect(assertReleasePackageReady(manifest).blockers).toEqual([]);
  });
});
