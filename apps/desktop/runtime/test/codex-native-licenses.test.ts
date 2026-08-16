import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  loadCodexNativeLicenseInventory,
  renderCodexNativeLicenseNotices,
  serializeCodexNativeLicenseInventory,
  verifyCodexNativePayloadsAtPaths,
  verifyCodexNativeLicenseInventory,
  verifyInstalledCodexNativePayloads,
} from "../codex-native-licenses";

const platformPackageRoot = resolve(
  import.meta.dir,
  "../../../../node_modules/.bun/@openai+codex@0.144.6-darwin-arm64/node_modules/@openai/codex",
);

async function expectFailure(action: () => Promise<void>, message: string): Promise<void> {
  try {
    await action();
    throw new Error(`Expected failure containing: ${message}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  }
}

describe("Codex 0.144.6 native dependency licenses", () => {
  test("binds the exact target Cargo closure and every license document", async () => {
    const inventory = await loadCodexNativeLicenseInventory();
    expect(inventory.counts).toEqual({
      documents: inventory.documents.length,
      externalPackages: 849,
      nativeComponents: inventory.nativeComponents.length,
      packages: 969,
      payloads: 5,
      workspacePackages: 120,
    });
    expect(inventory.nativeComponents).toHaveLength(16);
    expect(inventory.packages.every((entry) => entry.documentSha256s.length > 0)).toBe(true);
    expect(inventory.packages.every((entry) => entry.declaredLicense.length > 0)).toBe(true);
    expect(inventory.source.cargoLockExternalIdentities).toEqual(
      inventory.packages
        .filter((entry) => !entry.source.startsWith("workspace:"))
        .map((entry) => `${entry.identity}|${entry.source}|${entry.checksum ?? "-"}`),
    );
    expect(inventory.source.cargoLockSha256).toBe(
      "175793a40a3147db1fee08fd9db0acc59312c344b3513dd7ee316f5446d8119e",
    );
    expect(inventory.source.normalizedCargoLockSha256).toBe(
      "5cc77d7dfcc2828d3d389daf5824998c445c01e1d30367b04885813242d53f11",
    );
  });

  test("hash-checks every file in the actual shipped npm platform payload", async () => {
    const inventory = await loadCodexNativeLicenseInventory();
    const packageRoot = await realpath(platformPackageRoot);
    await verifyInstalledCodexNativePayloads(inventory, packageRoot);
    await verifyCodexNativePayloadsAtPaths(inventory, {
      manifestPath: join(packageRoot, "package.json"),
      vendorRoot: join(packageRoot, "vendor", inventory.platformPackage.target),
    });
    expect(inventory.platformPackage.payloads.map((entry) => [entry.path, entry.sha256])).toEqual([
      ["bin/codex", "80a3933d11a9d13ef806aa24f7bb8afc9169cfe4e9b09d6da6a92922cbde9cff"],
      ["bin/codex-code-mode-host", "de329ec247b5ebbdf796b5888a7c2a9d731e221321584c5abdcc686c70b2db81"],
      ["codex-package.json", "18398df8f34b1dbb0997d223a1044b9f5b20d78cc3d527485f30dcc9c8dcfee4"],
      ["codex-path/rg", "4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94"],
      ["codex-resources/zsh/bin/zsh", "b69893d9da08786211bac0862212e26a8a31af24eb77da21692671c58d388b8d"],
    ]);
  });

  test("rejects symlinked mounted-package evidence roots", async () => {
    const inventory = await loadCodexNativeLicenseInventory();
    const packageRoot = await realpath(platformPackageRoot);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "hra-codex-native-licenses-"));
    try {
      const vendorLink = join(temporaryRoot, "vendor-link");
      const manifestLink = join(temporaryRoot, "manifest-link.json");
      await Promise.all([
        symlink(join(packageRoot, "vendor", inventory.platformPackage.target), vendorLink),
        symlink(join(packageRoot, "package.json"), manifestLink),
      ]);
      await expectFailure(
        () => verifyCodexNativePayloadsAtPaths(inventory, {
          manifestPath: join(packageRoot, "package.json"),
          vendorRoot: vendorLink,
        }),
        "vendor root must be a real directory",
      );
      await expectFailure(
        () => verifyCodexNativePayloadsAtPaths(inventory, {
          manifestPath: manifestLink,
          vendorRoot: join(packageRoot, "vendor", inventory.platformPackage.target),
        }),
        "manifest path contains a symlink",
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("keeps checked JSON and human-readable notices canonical", async () => {
    const inventory = await loadCodexNativeLicenseInventory();
    const [json, notices] = await Promise.all([
      readFile(join(import.meta.dir, "../CODEX-NATIVE-LICENSES.json"), "utf8"),
      readFile(join(import.meta.dir, "../CODEX-NATIVE-LICENSES.txt"), "utf8"),
    ]);
    expect(json).toBe(serializeCodexNativeLicenseInventory(inventory));
    expect(notices).toBe(renderCodexNativeLicenseNotices(inventory));
    expect(createHash("sha256").update(json).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
    expect(createHash("sha256").update(notices).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("makes every missing-file fallback explicit and attributable", async () => {
    const reviewed = JSON.parse(
      await readFile(join(import.meta.dir, "../codex-native-licenses-reviewed.json"), "utf8"),
    ) as {
      missingFileOverrides: Array<{
        evidenceKind: string;
        identity: string;
        normalizedLicenseExpression: string;
        upstreamDocumentMissing: boolean;
      }>;
    };
    expect(reviewed.missingFileOverrides).toHaveLength(77);
    const inventory = await loadCodexNativeLicenseInventory();
    const packageMap = new Map(inventory.packages.map((entry) => [entry.identity, entry]));
    for (const override of reviewed.missingFileOverrides) {
      const packageValue = packageMap.get(override.identity);
      expect(packageValue).toBeDefined();
      if (override.upstreamDocumentMissing && override.identity === "io_tee@0.1.1") {
        // The exact published manifest has no authors field; preserve that fact instead of inventing one.
        expect(packageValue!.authors).toEqual([]);
      } else if (override.upstreamDocumentMissing) {
        expect(packageValue!.authors.length).toBeGreaterThan(0);
      }
      expect(packageValue!.documentSha256s.length).toBeGreaterThan(0);
      expect(packageValue!.licenseEvidence.length).toBeGreaterThan(0);
      expect(packageValue!.reviewedLicenseExpression).toBe(
        override.normalizedLicenseExpression,
      );
      expect(packageValue!.upstreamLicenseDocumentMissing).toBe(
        override.upstreamDocumentMissing,
      );
      expect(override.evidenceKind.length).toBeGreaterThan(0);
      expect(override.normalizedLicenseExpression.length).toBeGreaterThan(0);
    }
    expect(
      inventory.packages
        .filter((entry) => entry.upstreamLicenseDocumentMissing)
        .map((entry) => entry.identity),
    ).toEqual([
      "debugserver-types@0.5.0",
      "deno_core_icudata@0.77.0",
      "eventsource-stream@0.2.3",
      "fax@0.2.6",
      "fax_derive@0.2.0",
      "fxhash@0.2.1",
      "io_tee@0.1.1",
      "sse-stream@0.2.1",
    ]);
  });

  test("rejects document, lock identity, and payload tampering", async () => {
    const original = JSON.parse(
      await readFile(join(import.meta.dir, "../CODEX-NATIVE-LICENSES.json"), "utf8"),
    ) as {
      documents: Array<{ text: string }>;
      platformPackage: { payloads: Array<{ sha256: string }> };
      source: { cargoLockExternalIdentities: string[] };
    };
    original.documents[0]!.text += "tampered";
    expect(() => verifyCodexNativeLicenseInventory(original)).toThrow("document 0 hash differs");

    const lockTamper = JSON.parse(
      await readFile(join(import.meta.dir, "../CODEX-NATIVE-LICENSES.json"), "utf8"),
    ) as { source: { cargoLockExternalIdentities: string[] } };
    lockTamper.source.cargoLockExternalIdentities[0] += "tampered";
    expect(() => verifyCodexNativeLicenseInventory(lockTamper)).toThrow(
      "Cargo.lock identity digest differs",
    );

    const payloadTamper = JSON.parse(
      await readFile(join(import.meta.dir, "../CODEX-NATIVE-LICENSES.json"), "utf8"),
    ) as { platformPackage: { payloads: Array<{ sha256: string }> } };
    payloadTamper.platformPackage.payloads[0]!.sha256 = "0".repeat(64);
    const parsed = verifyCodexNativeLicenseInventory(payloadTamper);
    try {
      await verifyInstalledCodexNativePayloads(parsed, platformPackageRoot);
      throw new Error("Expected payload verification to reject a tampered hash.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("payload hash/size differs");
    }
  });
});
