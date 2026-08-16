import { describe, expect, test } from "bun:test";

import {
  createPublicTreeManifest,
  parsePublicTreeManifest,
  publicTreeManifestErrors,
} from "./check-public-tree";

describe("public tree manifest", () => {
  test("canonicalizes paths and reports additions and stale entries", () => {
    const expected = createPublicTreeManifest([
      "scripts/public-tree.manifest.json",
      "README.md",
      "README.md",
    ]);
    expect(expected.paths).toEqual([
      "README.md",
      "scripts/public-tree.manifest.json",
    ]);
    expect(publicTreeManifestErrors([
      "LICENSE",
      "scripts/public-tree.manifest.json",
    ], expected)).toEqual([
      "LICENSE: path is not in the public tree manifest",
      "scripts/public-tree.manifest.json: stale path README.md",
    ]);
  });

  test("parses only normalized unique byte-order-sorted paths", () => {
    expect(parsePublicTreeManifest({
      paths: ["README.md", "scripts/public-tree.manifest.json"],
      version: 1,
    })).toEqual({
      paths: ["README.md", "scripts/public-tree.manifest.json"],
      version: 1,
    });
    expect(() => parsePublicTreeManifest({
      paths: ["scripts/z.ts", "README.md"],
      version: 1,
    })).toThrow("byte-order sorted");
    expect(() => parsePublicTreeManifest({
      paths: ["../private"],
      version: 1,
    })).toThrow("normalized repository-relative");
  });
});
