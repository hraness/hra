import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCodexNativeLicenseInventory } from "../codex-native-licenses";
import {
  codexSignatureNormalizationEntry,
  codexSignatureNormalizationManifestEntries,
  codexSignatureNormalizationPolicy,
  createCodexSignatureSourceDelta,
  reconstructCodexSignatureSource,
  verifyCodexSignatureNormalizationInventory,
  verifyCodexSignatureNormalizationPackaged,
  verifyCodexSignatureNormalizationSource,
} from "../codex-signature-normalization";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hra-codex-signature-normalization-"));
  temporaryRoots.push(root);
  return root;
}

async function expectFailure(
  action: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
    throw new Error(`Expected failure containing: ${message}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Codex signature normalization", () => {
  test("binds the exception to the exact official package and source payloads", async () => {
    const inventory = await loadCodexNativeLicenseInventory();
    expect(() => verifyCodexSignatureNormalizationInventory(inventory)).not.toThrow();
    expect(codexSignatureNormalizationPolicy.entries.map((entry) => entry.payloadPath)).toEqual([
      "bin/codex",
      "bin/codex-code-mode-host",
    ]);
    expect(codexSignatureNormalizationPolicy.entries.map((entry) => entry.source.sha256))
      .toEqual([
        "80a3933d11a9d13ef806aa24f7bb8afc9169cfe4e9b09d6da6a92922cbde9cff",
        "de329ec247b5ebbdf796b5888a7c2a9d731e221321584c5abdcc686c70b2db81",
      ]);
    expect(codexSignatureNormalizationPolicy.entries.map((entry) => entry.packaged.sha256))
      .toEqual([
        "587cdb466744d6ed95cd189185b21764edc240c858c6d1de9c3d9f640072ec5b",
        "b0d18d2e3c9c2040e4f05ea08cbc6df35bb0c991f097200489d936759d453f69",
      ]);
    expect(codexSignatureNormalizationPolicy.entries.every(
      (entry) => entry.source.teamIdentifier === "2DC432GLL2",
    )).toBe(true);
    expect(codexSignatureNormalizationPolicy.entries.every(
      (entry) => entry.packaged.teamIdentifier === null,
    )).toBe(true);
  });

  test("records exact source, packaged, and reversible-delta evidence", () => {
    expect(codexSignatureNormalizationManifestEntries()).toEqual(
      codexSignatureNormalizationPolicy.entries.map((entry) => ({
        normalization: "adhoc-runtime-v1",
        packaged: entry.packaged,
        path: entry.appRelativePath,
        source: entry.source,
        sourceDelta: entry.sourceDelta,
      })),
    );
    expect(codexSignatureNormalizationPolicy.entries.map((entry) => [
      entry.sourceDelta.sha256,
      entry.sourceDelta.size,
    ])).toEqual([
      ["31e85f5acf1ac89da21e8299c1a4da473e64da45c9a80dd9aa56363ce34754d3", 2_047_901],
      ["5db3af7a60caedfac88b65ed96054e5faea1759d1d90072621c3fe2a7c6686e9", 363_523],
    ]);
  });

  test("rejects source and packaged signature identity drift", () => {
    const entry = codexSignatureNormalizationEntry("bin/codex");
    expect(() => verifyCodexSignatureNormalizationSource(entry, {
      sha256: entry.source.sha256,
      signature: entry.source,
      size: entry.source.size,
    })).not.toThrow();
    expect(() => verifyCodexSignatureNormalizationSource(entry, {
      sha256: entry.source.sha256,
      signature: { ...entry.source, teamIdentifier: "unexpected" },
      size: entry.source.size,
    })).toThrow("source identity differs");

    expect(() => verifyCodexSignatureNormalizationPackaged(entry, {
      sha256: entry.packaged.sha256,
      signature: {
        ...entry.packaged,
        flags: ["adhoc", "runtime"],
        signatureKind: "adhoc",
      },
      size: entry.packaged.size,
    })).not.toThrow();
    expect(() => verifyCodexSignatureNormalizationPackaged(entry, {
      sha256: "0".repeat(64),
      signature: {
        ...entry.packaged,
        flags: ["adhoc", "runtime"],
        signatureKind: "adhoc",
      },
      size: entry.packaged.size,
    })).toThrow("package identity differs");
    const packagedSignature = {
      ...entry.packaged,
      flags: ["adhoc", "runtime"],
      signatureKind: "adhoc",
    } as const;
    for (const signature of [
      { ...packagedSignature, cdHash: "0".repeat(40) },
      { ...packagedSignature, identifier: "unreviewed" },
      { ...packagedSignature, teamIdentifier: "2DC432GLL2" },
      { ...packagedSignature, flags: ["adhoc"] },
      { ...packagedSignature, signatureKind: null },
    ]) {
      expect(() => verifyCodexSignatureNormalizationPackaged(entry, {
        sha256: entry.packaged.sha256,
        signature,
        size: entry.packaged.size,
      })).toThrow("package identity differs");
    }
    expect(() => codexSignatureNormalizationEntry("../bin/codex"))
      .toThrow("policy is absent");
  });

  test("creates a deterministic bounded delta that restores exact source bytes", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "source");
    const packagedPath = join(root, "packaged");
    const deltaPath = join(root, "source.delta");
    const reconstructedPath = join(root, "reconstructed");
    const source = Buffer.alloc(32_000);
    for (let index = 0; index < source.byteLength; index += 1) {
      source[index] = (index * 17 + 29) % 251;
    }
    const packaged = Buffer.from(source.subarray(0, 30_000));
    packaged[17] = packaged[17]! ^ 0xff;
    packaged[2_049] = packaged[2_049]! ^ 0xff;
    packaged.fill(7, 27_000, 27_100);
    await Promise.all([
      writeFile(sourcePath, source, { mode: 0o755 }),
      writeFile(packagedPath, packaged, { mode: 0o755 }),
    ]);

    const first = await createCodexSignatureSourceDelta(sourcePath, packagedPath);
    const second = await createCodexSignatureSourceDelta(sourcePath, packagedPath);
    expect(first).toEqual(second);
    await writeFile(deltaPath, first, { flag: "wx", mode: 0o600 });
    await reconstructCodexSignatureSource(
      packagedPath,
      deltaPath,
      reconstructedPath,
    );
    expect(await readFile(reconstructedPath)).toEqual(source);
  });

  test("rejects malformed source deltas before reconstruction", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "source");
    const packagedPath = join(root, "packaged");
    const deltaPath = join(root, "source.delta");
    const destinationPath = join(root, "reconstructed");
    await Promise.all([
      writeFile(sourcePath, "source bytes", { mode: 0o755 }),
      writeFile(packagedPath, "packaged", { mode: 0o755 }),
    ]);
    const delta = await createCodexSignatureSourceDelta(sourcePath, packagedPath);
    delta[0] = delta[0]! ^ 0xff;
    await writeFile(deltaPath, delta, { mode: 0o600 });
    await expectFailure(
      () => reconstructCodexSignatureSource(packagedPath, deltaPath, destinationPath),
      "delta magic differs",
    );
  });

  test("rejects truncated, symlinked, and hard-linked delta custody", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "source");
    const packagedPath = join(root, "packaged");
    const deltaPath = join(root, "source.delta");
    const truncatedPath = join(root, "truncated.delta");
    const deltaLinkPath = join(root, "delta-link");
    const packagedLinkPath = join(root, "packaged-hard-link");
    await Promise.all([
      writeFile(sourcePath, "source bytes extended", { mode: 0o755 }),
      writeFile(packagedPath, "packaged", { mode: 0o755 }),
    ]);
    const delta = await createCodexSignatureSourceDelta(sourcePath, packagedPath);
    await Promise.all([
      writeFile(deltaPath, delta, { mode: 0o600 }),
      writeFile(truncatedPath, delta.subarray(0, delta.byteLength - 1), { mode: 0o600 }),
    ]);
    await expectFailure(
      () => reconstructCodexSignatureSource(
        packagedPath,
        truncatedPath,
        join(root, "truncated-output"),
      ),
      "delta segment is invalid",
    );

    await symlink(deltaPath, deltaLinkPath);
    await expectFailure(
      () => reconstructCodexSignatureSource(
        packagedPath,
        deltaLinkPath,
        join(root, "symlink-output"),
      ),
      "reconstruction input is invalid",
    );

    await link(packagedPath, packagedLinkPath);
    await expectFailure(
      () => createCodexSignatureSourceDelta(sourcePath, packagedPath),
      "packaged must be a regular single-link file",
    );
  });
});
