import { constants } from "node:fs";
import { copyFile, lstat, open, readFile, rm } from "node:fs/promises";

import type { CodexNativeLicenseInventory } from "./codex-native-licenses";

const deltaMagic = Buffer.from("HRACSD01", "ascii");
const deltaHeaderBytes = 28;
const deltaSegmentHeaderBytes = 16;
const maximumSourceBytes = 350_000_000;
const maximumDeltaBytes = 50_000_000;
const maximumDeltaSegments = 100_000;

export type CodeSignatureMetadata = Readonly<{
  cdHash: string | null;
  identifier: string | null;
  teamIdentifier: string | null;
}>;

export type CodexSignatureNormalizationEntry = Readonly<{
  appRelativePath: string;
  packaged: Readonly<{
    cdHash: string;
    identifier: string;
    sha256: string;
    size: number;
    teamIdentifier: null;
  }>;
  payloadPath: string;
  source: Readonly<{
    cdHash: string;
    identifier: string;
    sha256: string;
    size: number;
    teamIdentifier: string;
  }>;
  sourceDelta: Readonly<{
    format: "hra-source-delta-v1";
    path: string;
    sha256: string;
    size: number;
  }>;
}>;

const entries = Object.freeze([
  Object.freeze({
    appRelativePath: "Contents/Resources/runtime/codex/bin/codex",
    packaged: Object.freeze({
      cdHash: "5ae280ff1821f445b9a57fd1cae94a5638b64412",
      identifier: "codex",
      sha256: "587cdb466744d6ed95cd189185b21764edc240c858c6d1de9c3d9f640072ec5b",
      size: 258_959_424,
      teamIdentifier: null,
    }),
    payloadPath: "bin/codex",
    source: Object.freeze({
      cdHash: "14fe9fce7d47a8c12e42094e5cc90ff97b2cf627",
      identifier: "codex",
      sha256: "80a3933d11a9d13ef806aa24f7bb8afc9169cfe4e9b09d6da6a92922cbde9cff",
      size: 260_472_144,
      teamIdentifier: "2DC432GLL2",
    }),
    sourceDelta: Object.freeze({
      format: "hra-source-delta-v1",
      path: "Contents/Resources/runtime/provenance/codex-signatures/codex.source-delta",
      sha256: "31e85f5acf1ac89da21e8299c1a4da473e64da45c9a80dd9aa56363ce34754d3",
      size: 2_047_901,
    }),
  }),
  Object.freeze({
    appRelativePath: "Contents/Resources/runtime/codex/bin/codex-code-mode-host",
    packaged: Object.freeze({
      cdHash: "c6baa6a305971da8115c47e52005e922ea767540",
      identifier: "codex-code-mode-host",
      sha256: "b0d18d2e3c9c2040e4f05ea08cbc6df35bb0c991f097200489d936759d453f69",
      size: 46_106_576,
      teamIdentifier: null,
    }),
    payloadPath: "bin/codex-code-mode-host",
    source: Object.freeze({
      cdHash: "d4a7d8e1af4b06413ef43fa933d983c3db019e8f",
      identifier: "codex-code-mode-host",
      sha256: "de329ec247b5ebbdf796b5888a7c2a9d731e221321584c5abdcc686c70b2db81",
      size: 46_374_288,
      teamIdentifier: "2DC432GLL2",
    }),
    sourceDelta: Object.freeze({
      format: "hra-source-delta-v1",
      path:
        "Contents/Resources/runtime/provenance/codex-signatures/codex-code-mode-host.source-delta",
      sha256: "5db3af7a60caedfac88b65ed96054e5faea1759d1d90072621c3fe2a7c6686e9",
      size: 363_523,
    }),
  }),
] satisfies readonly CodexSignatureNormalizationEntry[]);

export const codexSignatureNormalizationPolicy = Object.freeze({
  entries,
  packageIntegrity:
    "sha512-6zgvh70MzBNSeT17HEhSOrmmGGZGAKzSC7x6JAq+edkJkdPYA9P0I1tG7aJ49GlBkBxuC+MKBH1qm6+2Cghcww==",
  packageManifestSha256:
    "051cbc20f48e7bd20b89e301ffc8f60af890a1da3815e5e700f11ada41c3b445",
  packageName: "@openai/codex",
  packageTarget: "aarch64-apple-darwin",
  packageVersion: "0.144.6-darwin-arm64",
} as const);

export function codexSignatureNormalizationEntry(
  payloadPath: string,
): CodexSignatureNormalizationEntry {
  const entry = codexSignatureNormalizationPolicy.entries.find(
    (candidate) => candidate.payloadPath === payloadPath,
  );
  if (entry === undefined) {
    throw new Error(`Codex signature normalization policy is absent: ${payloadPath}`);
  }
  return entry;
}

function signatureEquals(
  actual: CodeSignatureMetadata,
  expected: CodeSignatureMetadata,
): boolean {
  return actual.cdHash === expected.cdHash
    && actual.identifier === expected.identifier
    && actual.teamIdentifier === expected.teamIdentifier;
}

export function verifyCodexSignatureNormalizationInventory(
  inventory: CodexNativeLicenseInventory,
): void {
  const policy = codexSignatureNormalizationPolicy;
  if (
    inventory.platformPackage.integrity !== policy.packageIntegrity
    || inventory.platformPackage.manifestSha256 !== policy.packageManifestSha256
    || inventory.platformPackage.name !== policy.packageName
    || inventory.platformPackage.target !== policy.packageTarget
    || inventory.platformPackage.version !== policy.packageVersion
  ) {
    throw new Error("Codex signature normalization package provenance differs.");
  }
  const payloads = new Map(
    inventory.platformPackage.payloads.map((payload) => [payload.path, payload]),
  );
  for (const entry of policy.entries) {
    const payload = payloads.get(entry.payloadPath);
    if (
      payload === undefined
      || payload.sha256 !== entry.source.sha256
      || payload.size !== entry.source.size
    ) {
      throw new Error(
        `Codex signature normalization source payload differs: ${entry.payloadPath}`,
      );
    }
  }
}

export function verifyCodexSignatureNormalizationSource(
  entry: CodexSignatureNormalizationEntry,
  actual: Readonly<{
    sha256: string;
    signature: CodeSignatureMetadata;
    size: number;
  }>,
): void {
  if (
    actual.sha256 !== entry.source.sha256
    || actual.size !== entry.source.size
    || !signatureEquals(actual.signature, entry.source)
  ) {
    throw new Error(
      `Codex normalization source identity differs: ${entry.payloadPath}`,
    );
  }
}

export function verifyCodexSignatureNormalizationPackaged(
  entry: CodexSignatureNormalizationEntry,
  actual: Readonly<{
    sha256: string;
    signature: CodeSignatureMetadata & Readonly<{
      flags: readonly string[];
      signatureKind: string | null;
    }>;
    size: number;
  }>,
): void {
  if (
    actual.sha256 !== entry.packaged.sha256
    || actual.size !== entry.packaged.size
    || !signatureEquals(actual.signature, entry.packaged)
    || actual.signature.signatureKind !== "adhoc"
    || JSON.stringify(actual.signature.flags) !== JSON.stringify(["adhoc", "runtime"])
  ) {
    throw new Error(
      `Normalized Codex package identity differs: ${entry.payloadPath}`,
    );
  }
}

export function codexSignatureNormalizationManifestEntries(): readonly Readonly<{
  normalization: "adhoc-runtime-v1";
  packaged: CodexSignatureNormalizationEntry["packaged"];
  path: string;
  source: CodexSignatureNormalizationEntry["source"];
  sourceDelta: CodexSignatureNormalizationEntry["sourceDelta"];
}>[] {
  return codexSignatureNormalizationPolicy.entries.map((entry) => Object.freeze({
    normalization: "adhoc-runtime-v1" as const,
    packaged: entry.packaged,
    path: entry.appRelativePath,
    source: entry.source,
    sourceDelta: entry.sourceDelta,
  }));
}

async function readExactChunk(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      throw new Error("Codex signature delta source changed while read.");
    }
    offset += result.bytesRead;
  }
  return bytes;
}

export async function createCodexSignatureSourceDelta(
  sourcePath: string,
  packagedPath: string,
): Promise<Buffer> {
  const [sourceStatus, packagedStatus] = await Promise.all([
    lstat(sourcePath),
    lstat(packagedPath),
  ]);
  for (const [label, status] of [["source", sourceStatus], ["packaged", packagedStatus]] as const) {
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new Error(`Codex signature delta ${label} must be a regular single-link file.`);
    }
  }
  if (
    sourceStatus.size <= 0
    || sourceStatus.size > maximumSourceBytes
    || packagedStatus.size <= 0
    || packagedStatus.size > maximumSourceBytes
  ) {
    throw new Error("Codex signature delta input size is invalid.");
  }

  const source = await open(sourcePath, "r");
  const packaged = await open(packagedPath, "r");
  const segments: Array<Readonly<{ bytes: Buffer; offset: number }>> = [];
  try {
    const chunkBytes = 1024 * 1024;
    for (let position = 0; position < sourceStatus.size; position += chunkBytes) {
      const sourceLength = Math.min(chunkBytes, sourceStatus.size - position);
      const packagedLength = Math.max(
        0,
        Math.min(sourceLength, packagedStatus.size - position),
      );
      const sourceChunk = await readExactChunk(source, sourceLength, position);
      const packagedChunk = packagedLength === 0
        ? Buffer.alloc(0)
        : await readExactChunk(packaged, packagedLength, position);
      if (sourceLength === packagedLength && sourceChunk.equals(packagedChunk)) continue;

      let cursor = 0;
      while (cursor < sourceLength) {
        while (
          cursor < sourceLength
          && cursor < packagedLength
          && sourceChunk[cursor] === packagedChunk[cursor]
        ) cursor += 1;
        if (cursor === sourceLength) break;
        const start = cursor;
        while (
          cursor < sourceLength
          && (
            cursor >= packagedLength
            || sourceChunk[cursor] !== packagedChunk[cursor]
          )
        ) cursor += 1;
        segments.push({
          bytes: Buffer.from(sourceChunk.subarray(start, cursor)),
          offset: position + start,
        });
        if (segments.length > maximumDeltaSegments) {
          throw new Error("Codex signature delta has too many changed segments.");
        }
      }
    }
  } finally {
    await Promise.all([source.close(), packaged.close()]);
  }

  const header = Buffer.alloc(deltaHeaderBytes);
  deltaMagic.copy(header, 0);
  header.writeBigUInt64BE(BigInt(sourceStatus.size), 8);
  header.writeBigUInt64BE(BigInt(packagedStatus.size), 16);
  header.writeUInt32BE(segments.length, 24);
  const parts: Buffer[] = [header];
  for (const segment of segments) {
    const segmentHeader = Buffer.alloc(deltaSegmentHeaderBytes);
    segmentHeader.writeBigUInt64BE(BigInt(segment.offset), 0);
    segmentHeader.writeBigUInt64BE(BigInt(segment.bytes.byteLength), 8);
    parts.push(segmentHeader, segment.bytes);
  }
  const delta = Buffer.concat(parts);
  if (delta.byteLength > maximumDeltaBytes) {
    throw new Error("Codex signature delta is unexpectedly large.");
  }
  return delta;
}

function safeBigUInt(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Codex signature delta ${label} is invalid.`);
  }
  return number;
}

export async function reconstructCodexSignatureSource(
  packagedPath: string,
  deltaPath: string,
  destinationPath: string,
): Promise<void> {
  const [packagedStatus, deltaStatus] = await Promise.all([
    lstat(packagedPath),
    lstat(deltaPath),
  ]);
  if (
    !packagedStatus.isFile()
    || packagedStatus.isSymbolicLink()
    || packagedStatus.nlink !== 1
    || !deltaStatus.isFile()
    || deltaStatus.isSymbolicLink()
    || deltaStatus.nlink !== 1
    || deltaStatus.size < deltaHeaderBytes
    || deltaStatus.size > maximumDeltaBytes
  ) {
    throw new Error("Codex signature source reconstruction input is invalid.");
  }
  const delta = await readFile(deltaPath);
  if (!delta.subarray(0, deltaMagic.byteLength).equals(deltaMagic)) {
    throw new Error("Codex signature delta magic differs.");
  }
  const sourceSize = safeBigUInt(delta.readBigUInt64BE(8), "source size");
  const packagedSize = safeBigUInt(delta.readBigUInt64BE(16), "packaged size");
  const segmentCount = delta.readUInt32BE(24);
  if (
    sourceSize <= 0
    || sourceSize > maximumSourceBytes
    || packagedSize !== packagedStatus.size
    || segmentCount > maximumDeltaSegments
  ) {
    throw new Error("Codex signature delta identity differs.");
  }

  let cursor = deltaHeaderBytes;
  let priorEnd = 0;
  const segments: Array<Readonly<{ bytes: Buffer; offset: number }>> = [];
  for (let index = 0; index < segmentCount; index += 1) {
    if (cursor + deltaSegmentHeaderBytes > delta.byteLength) {
      throw new Error("Codex signature delta segment header is truncated.");
    }
    const offset = safeBigUInt(delta.readBigUInt64BE(cursor), "segment offset");
    const length = safeBigUInt(
      delta.readBigUInt64BE(cursor + 8),
      "segment length",
    );
    cursor += deltaSegmentHeaderBytes;
    if (
      length <= 0
      || offset < priorEnd
      || offset + length > sourceSize
      || cursor + length > delta.byteLength
    ) {
      throw new Error("Codex signature delta segment is invalid.");
    }
    segments.push({
      bytes: delta.subarray(cursor, cursor + length),
      offset,
    });
    cursor += length;
    priorEnd = offset + length;
  }
  if (cursor !== delta.byteLength) {
    throw new Error("Codex signature delta has trailing bytes.");
  }

  await copyFile(packagedPath, destinationPath, constants.COPYFILE_EXCL);
  const destination = await open(destinationPath, "r+");
  try {
    await destination.truncate(sourceSize);
    for (const segment of segments) {
      let written = 0;
      while (written < segment.bytes.byteLength) {
        const result = await destination.write(
          segment.bytes,
          written,
          segment.bytes.byteLength - written,
          segment.offset + written,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Codex signature source reconstruction stopped early.");
        }
        written += result.bytesWritten;
      }
    }
  } catch (error) {
    await destination.close();
    await rm(destinationPath, { force: true });
    throw error;
  }
  await destination.close();
}
