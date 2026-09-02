import { describe, expect, test } from "bun:test";

import { readInstallPins, releasePinDrift, workingTreePinDrift } from "./check-install-pins";

const repositoryRoot = new URL("..", import.meta.url).pathname;

describe("installer pins", () => {
  test("the working tree's CLI and normalizer digests match the embedded pins", async () => {
    expect(workingTreePinDrift(await readInstallPins(repositoryRoot))).toEqual([]);
  });

  test("release consistency requires the tagged runtime bytes and matching URLs", async () => {
    const report = await readInstallPins(repositoryRoot);
    const consistent = { ...report, runtime: { publicCommand: report.runtime.actual, actual: report.runtime.actual } };
    const drift = releasePinDrift(consistent, "v0.1.6", "0.1.6");
    expect(drift).toEqual([]);
    expect(releasePinDrift(report, "v0.1.6", "0.1.6").some((line) => line.includes("public command digest") || line.includes("is not the public command digest") || line.length === 0)).toBe(report.runtime.publicCommand !== report.runtime.actual);
    expect(releasePinDrift(consistent, "v0.1.7", "0.1.6")).toContain("release tag v0.1.7 does not match package.json version 0.1.6");
    expect(() => releasePinDrift(consistent, "0.1.6", "0.1.6")).toThrow();
  });

  test("working-tree drift names the file and both digests", () => {
    const report = {
      cli: { expected: "a".repeat(64), actual: "b".repeat(64) },
      normalizer: { expected: "c".repeat(64), actual: "c".repeat(64) },
      runtime: { publicCommand: "d".repeat(64), actual: "e".repeat(64) },
    };
    expect(workingTreePinDrift(report)).toEqual([`src/cli.ts digest ${"b".repeat(64)} is not the pinned ${"a".repeat(64)}`]);
  });
});
