import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCodexNativeLicenseInventory } from "../codex-native-licenses";
import {
  CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE,
  CODEX_SIGNATURE_NORMALIZATION_RUNTIME_VERSION,
  codexSignatureNormalizationEntry,
  codexSignatureNormalizationCodesignArguments,
  codexSignatureNormalizationEntitlements,
  codexSignatureNormalizationManifestEntries,
  codexSignatureNormalizationPolicy,
  codexSignatureNormalizationSigning,
  createCodexSignatureSourceDelta,
  parseCodexSignatureNormalizationEntitlements,
  reconstructCodexSignatureSource,
  verifyCodexSignatureNormalizationContent,
  verifyCodexSignatureNormalizationInventory,
  verifyCodexSignatureNormalizationPackaged,
  verifyCodexSignatureNormalizationSource,
} from "../codex-signature-normalization";

const temporaryRoots: string[] = [];

function machOSignatureFixture(signatureBytes: number): Buffer {
  const signatureOffset = 256;
  const linkeditOffset = 192;
  const bytes = Buffer.alloc(signatureOffset + signatureBytes);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 16);
  bytes.writeUInt32LE(88, 20);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(72, 36);
  bytes.write("__LINKEDIT", 40, "ascii");
  bytes.writeBigUInt64LE(BigInt(CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE), 64);
  bytes.writeBigUInt64LE(BigInt(linkeditOffset), 72);
  bytes.writeBigUInt64LE(BigInt(bytes.byteLength - linkeditOffset), 80);
  bytes.writeUInt32LE(0x1d, 104);
  bytes.writeUInt32LE(16, 108);
  bytes.writeUInt32LE(signatureOffset, 112);
  bytes.writeUInt32LE(signatureBytes, 116);
  for (let index = 120; index < signatureOffset; index += 1) {
    bytes[index] = (index * 13 + 17) % 251;
  }
  bytes.fill(signatureBytes % 251, signatureOffset);
  return bytes;
}

function packagedSignature(
  entry: ReturnType<typeof codexSignatureNormalizationEntry>,
) {
  return {
    ...entry.packaged,
    entitlements: codexSignatureNormalizationEntitlements,
    flags: ["runtime", "adhoc"],
    hashChoices: ["sha256"],
    hashType: "sha256",
    infoPlistBound: false,
    internalRequirementsCount: 0,
    sealedResources: "none",
    signatureKind: "adhoc",
    timestamp: null,
  } as const;
}

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
        "055f18d2a33a719a2fab08e0a8326d950fa733340c596bb3df0d8dc94f85a96e",
        "7f622f21007acac2780b0e9e39822ba493425366fc1cf996c24adafc9c0a6e08",
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
        signing: codexSignatureNormalizationSigning,
        source: entry.source,
        sourceDelta: entry.sourceDelta,
      })),
    );
    expect(codexSignatureNormalizationPolicy.entries.map((entry) => [
      entry.sourceDelta.sha256,
      entry.sourceDelta.size,
    ])).toEqual([
      ["b0b05a7e03adf00fc1293b3e2679464cd8ec63024ca0ab5448915b5c33a1dadd", 2_046_810],
      ["5952f9bc32083e1f62e1cc13c55b5b50145f8f7e4df56dd89c2d8d5267d9c2c2", 363_584],
    ]);
  });

  test("pins every cross-host codesign input in the signing command", async () => {
    const entry = codexSignatureNormalizationEntry("bin/codex");
    const entitlementsPath = join(
      import.meta.dir,
      "../codex-signature-normalization.entitlements.plist",
    );
    expect(CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE).toBe(16_384);
    expect(CODEX_SIGNATURE_NORMALIZATION_RUNTIME_VERSION).toBe("15.5.0");
    expect(entry.packaged.pageSize).toBe(CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE);
    expect(createHash("sha256").update(await readFile(entitlementsPath)).digest("hex"))
      .toBe(codexSignatureNormalizationSigning.entitlementsSha256);
    expect(codexSignatureNormalizationCodesignArguments(
      entry,
      entitlementsPath,
      "/tmp/codex",
    )).toEqual([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      entitlementsPath,
      "--generate-entitlement-der",
      "--timestamp=none",
      "--digest-algorithm=sha256",
      "--runtime-version",
      "15.5.0",
      "--pagesize",
      "16384",
      "--identifier",
      "codex",
      "/tmp/codex",
    ]);
  });

  test("parses only the two canonical true JIT entitlements", () => {
    const xml = `<?xml version="1.0"?><plist><dict>
      <key>com.apple.security.cs.allow-jit</key><true/>
      <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
    </dict></plist>`;
    expect(parseCodexSignatureNormalizationEntitlements(xml)).toEqual(
      codexSignatureNormalizationEntitlements,
    );
    expect(() => parseCodexSignatureNormalizationEntitlements(
      xml.replace("</dict>", "<key>unexpected</key><true/></dict>"),
    )).not.toThrow();
    expect(() => verifyCodexSignatureNormalizationPackaged(
      codexSignatureNormalizationEntry("bin/codex"),
      {
        sha256: codexSignatureNormalizationEntry("bin/codex").packaged.sha256,
        signature: {
          ...packagedSignature(codexSignatureNormalizationEntry("bin/codex")),
          entitlements: parseCodexSignatureNormalizationEntitlements(
            xml.replace("</dict>", "<key>unexpected</key><true/></dict>"),
          ),
        },
        size: codexSignatureNormalizationEntry("bin/codex").packaged.size,
      },
    )).toThrow("package identity differs");
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
      signature: packagedSignature(entry),
      size: entry.packaged.size,
    })).not.toThrow();
    expect(() => verifyCodexSignatureNormalizationPackaged(entry, {
      sha256: "0".repeat(64),
      signature: packagedSignature(entry),
      size: entry.packaged.size,
    })).toThrow("package identity differs");
    const signatureContract = packagedSignature(entry);
    for (const signature of [
      { ...signatureContract, cdHash: "0".repeat(40) },
      { ...signatureContract, identifier: "unreviewed" },
      { ...signatureContract, teamIdentifier: "2DC432GLL2" },
      { ...signatureContract, flags: ["adhoc"] },
      { ...signatureContract, hashChoices: ["sha1", "sha256"] },
      { ...signatureContract, hashType: "sha1" },
      { ...signatureContract, infoPlistBound: true },
      { ...signatureContract, internalRequirementsCount: 1 },
      { ...signatureContract, pageSize: 4_096 },
      { ...signatureContract, runtimeVersion: "26.0.0" },
      { ...signatureContract, sealedResources: "yes" },
      { ...signatureContract, signatureKind: null },
      { ...signatureContract, timestamp: "Aug 20, 2026" },
      {
        ...signatureContract,
        entitlements: { "com.apple.security.cs.allow-jit": true },
      },
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

  test("allows changes only inside the Mach-O signature envelope", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "source-macho");
    const packagedPath = join(root, "packaged-macho");
    const source = machOSignatureFixture(64);
    const packaged = machOSignatureFixture(32);
    await Promise.all([
      writeFile(sourcePath, source, { mode: 0o755 }),
      writeFile(packagedPath, packaged, { mode: 0o755 }),
    ]);
    expect(await verifyCodexSignatureNormalizationContent(sourcePath, packagedPath))
      .toBeUndefined();
    packaged[200] = packaged[200]! ^ 0xff;
    await writeFile(packagedPath, packaged, { mode: 0o755 });
    await expectFailure(
      () => verifyCodexSignatureNormalizationContent(sourcePath, packagedPath),
      "changed outside its code-signature envelope",
    );
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
