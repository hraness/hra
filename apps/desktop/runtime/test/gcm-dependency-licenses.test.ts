import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  collectGcmDependencyEvidence,
  gcmDependencyLicensePins,
  loadGcmDependencyLicenseInventory,
  renderGcmDependencyLicenseNotices,
  serializeGcmDependencyLicenseInventory,
  verifyGcmDependencyLicenseInventory,
} from "../gcm-dependency-licenses";

const gcmRoot = join(
  import.meta.dir,
  "../../node_modules/dugite/git/libexec/git-core",
);

describe("Git Credential Manager dependency licenses", () => {
  test("binds every external runtime contributor and its exact license text", async () => {
    const inventory = await loadGcmDependencyLicenseInventory({ gcmRoot });
    expect(inventory.packageCount).toBe(22);
    expect(inventory.gcm.externalPackageCount).toBe(22);
    expect(inventory.packages).toHaveLength(22);
    expect(inventory.documents).toHaveLength(13);
    expect(inventory.packages.reduce(
      (total, entry) => total + entry.runtimeAssets.length,
      0,
    )).toBe(214);
    expect(inventory.packages.map((entry) => entry.identity)).toContain(
      "runtimepack.Microsoft.NETCore.App.Runtime.osx-arm64/8.0.24",
    );
    expect(inventory.packages.every((entry) => entry.documentSha256s.length > 0)).toBe(true);
    expect(inventory.packages.every((entry) => entry.runtimeAssets.length > 0)).toBe(true);
  });

  test("keeps the checked JSON and notice rendering canonical", async () => {
    const inventory = await loadGcmDependencyLicenseInventory({ gcmRoot });
    const [json, notices] = await Promise.all([
      readFile(join(import.meta.dir, "../GCM-DEPENDENCY-LICENSES.json"), "utf8"),
      readFile(join(import.meta.dir, "../GCM-DEPENDENCY-LICENSES.txt"), "utf8"),
    ]);
    expect(json).toBe(serializeGcmDependencyLicenseInventory(inventory));
    expect(notices).toBe(renderGcmDependencyLicenseNotices(inventory));
    expect(createHash("sha256").update(json).digest("hex")).toBe(
      "68eb5f5e555987b2a8637055a364743989c8da7cd188432c0f1f605ca72acec1",
    );
    expect(createHash("sha256").update(notices).digest("hex")).toBe(
      "58b92f2d423e170e0d49950855cd8c5145bf11ede028a0be849d48374a846c50",
    );
  });

  test("rejects document tampering and distinguishes raw BOM source bytes", async () => {
    const evidence = await collectGcmDependencyEvidence(gcmRoot);
    const value = JSON.parse(
      await readFile(join(import.meta.dir, "../GCM-DEPENDENCY-LICENSES.json"), "utf8"),
    ) as {
      documents: Array<{ text: string }>;
    };
    value.documents[0]!.text += "tampered";
    expect(() => verifyGcmDependencyLicenseInventory(value, evidence)).toThrow(
      "document hash differs",
    );

    const bomPins = gcmDependencyLicensePins.packages.flatMap((entry) =>
      entry.documents.filter((document) => document.sourceSha256 !== undefined));
    expect(bomPins).toHaveLength(2);
    expect(bomPins.every((document) => document.sourceSha256 !== document.sha256)).toBe(true);
  });
});
