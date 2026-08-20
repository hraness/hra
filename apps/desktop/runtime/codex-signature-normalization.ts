import { constants } from "node:fs";
import { copyFile, lstat, open, readFile, rm } from "node:fs/promises";

import type { CodexNativeLicenseInventory } from "./codex-native-licenses";

const deltaMagic = Buffer.from("HRACSD01", "ascii");
const deltaHeaderBytes = 28;
const deltaSegmentHeaderBytes = 16;
const maximumSourceBytes = 350_000_000;
const maximumDeltaBytes = 50_000_000;
const maximumDeltaSegments = 100_000;
const maximumMachOLoadCommandBytes = 16 * 1_024 * 1_024;

export type CodeSignatureMetadata = Readonly<{
  cdHash: string | null;
  identifier: string | null;
  teamIdentifier: string | null;
}>;

export const CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE = 16_384 as const;
export const CODEX_SIGNATURE_NORMALIZATION_RUNTIME_VERSION = "15.5.0" as const;
export const CODEX_SIGNATURE_NORMALIZATION_ENTITLEMENTS_FILE =
  "codex-signature-normalization.entitlements.plist" as const;

export const codexSignatureNormalizationEntitlements = Object.freeze({
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
});

export const codexSignatureNormalizationSigning = Object.freeze({
  digestAlgorithm: "sha256" as const,
  entitlementsFile: CODEX_SIGNATURE_NORMALIZATION_ENTITLEMENTS_FILE,
  entitlementsSha256:
    "a2f94dda68da5a6d994132cfc3ee49f07b83bccc5c1b9d5653e2e5fdb228ff41",
  generateEntitlementDer: true as const,
  pageSize: CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE,
  runtimeVersion: CODEX_SIGNATURE_NORMALIZATION_RUNTIME_VERSION,
  timestamp: "none" as const,
});

export type CodexSignatureNormalizationEntry = Readonly<{
  appRelativePath: string;
  packaged: Readonly<{
    cdHash: string;
    identifier: string;
    pageSize: typeof CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE;
    runtimeVersion: typeof CODEX_SIGNATURE_NORMALIZATION_RUNTIME_VERSION;
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

export type CodexSignatureNormalizationManifestEntry = Readonly<{
  normalization: "adhoc-runtime-v1";
  packaged: CodexSignatureNormalizationEntry["packaged"];
  path: string;
  signing: typeof codexSignatureNormalizationSigning;
  source: CodexSignatureNormalizationEntry["source"];
  sourceDelta: CodexSignatureNormalizationEntry["sourceDelta"];
}>;

const entries = Object.freeze([
  Object.freeze({
    appRelativePath: "Contents/Resources/runtime/codex/bin/codex",
    packaged: Object.freeze({
      cdHash: "d5a8decaaecc44cd318c818f9ad794083570a812",
      identifier: "codex",
      pageSize: CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE,
      runtimeVersion: CODEX_SIGNATURE_NORMALIZATION_RUNTIME_VERSION,
      sha256: "055f18d2a33a719a2fab08e0a8326d950fa733340c596bb3df0d8dc94f85a96e",
      size: 258_960_048,
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
      sha256: "b0b05a7e03adf00fc1293b3e2679464cd8ec63024ca0ab5448915b5c33a1dadd",
      size: 2_046_810,
    }),
  }),
  Object.freeze({
    appRelativePath: "Contents/Resources/runtime/codex/bin/codex-code-mode-host",
    packaged: Object.freeze({
      cdHash: "62c42f5ea878b3d0cf931a993216a4034cd8e91f",
      identifier: "codex-code-mode-host",
      pageSize: CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE,
      runtimeVersion: CODEX_SIGNATURE_NORMALIZATION_RUNTIME_VERSION,
      sha256: "7f622f21007acac2780b0e9e39822ba493425366fc1cf996c24adafc9c0a6e08",
      size: 46_107_184,
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
      sha256: "5952f9bc32083e1f62e1cc13c55b5b50145f8f7e4df56dd89c2d8d5267d9c2c2",
      size: 363_584,
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

export function codexSignatureNormalizationCodesignArguments(
  entry: CodexSignatureNormalizationEntry,
  entitlementsPath: string,
  path: string,
): readonly string[] {
  if (entitlementsPath.length === 0 || path.length === 0) {
    throw new Error("Codex signature normalization paths must not be empty.");
  }
  return Object.freeze([
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
    CODEX_SIGNATURE_NORMALIZATION_RUNTIME_VERSION,
    "--pagesize",
    String(CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE),
    "--identifier",
    entry.source.identifier,
    path,
  ]);
}

export function parseCodexSignatureNormalizationEntitlements(
  codesignOutput: string,
): Readonly<Record<string, boolean>> {
  const dictionary = /<dict>([\s\S]*?)<\/dict>/u.exec(codesignOutput)?.[1];
  if (dictionary === undefined) {
    throw new Error("Normalized Codex entitlements are absent.");
  }
  const compact = dictionary.replace(/\s+/gu, "");
  const entries: Record<string, boolean> = {};
  const entryPattern = /<key>([^<]+)<\/key><(true|false)\/>/gyu;
  let cursor = 0;
  while (cursor < compact.length) {
    entryPattern.lastIndex = cursor;
    const match = entryPattern.exec(compact);
    if (match === null || match.index !== cursor) {
      throw new Error("Normalized Codex entitlements are malformed.");
    }
    const [, key, boolean] = match;
    if (key === undefined || boolean === undefined || key in entries) {
      throw new Error("Normalized Codex entitlements are malformed.");
    }
    entries[key] = boolean === "true";
    cursor = entryPattern.lastIndex;
  }
  return Object.freeze(entries);
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
      entitlements: Readonly<Record<string, unknown>>;
      flags: readonly string[];
      hashChoices: readonly string[];
      hashType: string | null;
      infoPlistBound: boolean | null;
      internalRequirementsCount: number | null;
      pageSize: number | null;
      runtimeVersion: string | null;
      sealedResources: string | null;
      signatureKind: string | null;
      timestamp: string | null;
    }>;
    size: number;
  }>,
): void {
  const flags = [...actual.signature.flags];
  const entitlementKeys = Object.keys(actual.signature.entitlements).sort();
  const expectedEntitlementKeys = Object.keys(
    codexSignatureNormalizationEntitlements,
  ).sort();
  if (
    actual.sha256 !== entry.packaged.sha256
    || actual.size !== entry.packaged.size
    || !signatureEquals(actual.signature, entry.packaged)
    || actual.signature.pageSize !== entry.packaged.pageSize
    || actual.signature.runtimeVersion !== entry.packaged.runtimeVersion
    || actual.signature.signatureKind !== "adhoc"
    || actual.signature.hashType !== codexSignatureNormalizationSigning.digestAlgorithm
    || actual.signature.hashChoices.length !== 1
    || actual.signature.hashChoices[0]
      !== codexSignatureNormalizationSigning.digestAlgorithm
    || actual.signature.infoPlistBound !== false
    || actual.signature.internalRequirementsCount !== 0
    || actual.signature.sealedResources !== "none"
    || actual.signature.timestamp !== null
    || entitlementKeys.length !== expectedEntitlementKeys.length
    || entitlementKeys.some((key, index) => key !== expectedEntitlementKeys[index])
    || expectedEntitlementKeys.some(
      (key) => actual.signature.entitlements[key] !== true,
    )
    || flags.length !== 2
    || new Set(flags).size !== 2
    || !flags.includes("adhoc")
    || !flags.includes("runtime")
  ) {
    throw new Error(
      `Normalized Codex package identity differs: ${entry.payloadPath}`,
    );
  }
}

export function codexSignatureNormalizationManifestEntries(): readonly CodexSignatureNormalizationManifestEntry[] {
  return codexSignatureNormalizationPolicy.entries.map((entry) => Object.freeze({
    normalization: "adhoc-runtime-v1" as const,
    packaged: entry.packaged,
    path: entry.appRelativePath,
    signing: codexSignatureNormalizationSigning,
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

type MachOSignatureEnvelope = Readonly<{
  codeSignatureCommandOffset: number;
  codeSignatureDataOffset: number;
  headerAndCommands: Buffer;
  linkeditCommandOffset: number;
  linkeditFileOffset: number;
}>;

async function readMachOSignatureEnvelope(
  path: string,
): Promise<MachOSignatureEnvelope> {
  const status = await lstat(path);
  if (
    !status.isFile()
    || status.isSymbolicLink()
    || status.nlink !== 1
    || status.size <= 0
    || status.size > maximumSourceBytes
  ) {
    throw new Error(
      "Codex normalization content must be a bounded regular single-link file.",
    );
  }
  const handle = await open(path, "r");
  try {
    const header = await readExactChunk(handle, 32, 0);
    const commandCount = header.readUInt32LE(16);
    const commandBytes = header.readUInt32LE(20);
    if (
      header.readUInt32LE(0) !== 0xfeedfacf
      || commandCount === 0
      || commandCount > 4_096
      || commandBytes === 0
      || commandBytes > maximumMachOLoadCommandBytes
      || 32 + commandBytes > status.size
    ) {
      throw new Error("Codex normalization content has an invalid Mach-O header.");
    }
    const headerAndCommands = await readExactChunk(handle, 32 + commandBytes, 0);
    let cursor = 32;
    let codeSignature: Readonly<{
      commandOffset: number;
      dataOffset: number;
      dataSize: number;
    }> | undefined;
    let linkedit: Readonly<{
      commandOffset: number;
      fileOffset: number;
      fileSize: number;
      vmSize: number;
    }> | undefined;
    for (let index = 0; index < commandCount; index += 1) {
      if (cursor + 8 > headerAndCommands.byteLength) {
        throw new Error("Codex normalization content has truncated Mach-O commands.");
      }
      const command = headerAndCommands.readUInt32LE(cursor);
      const commandSize = headerAndCommands.readUInt32LE(cursor + 4);
      if (
        commandSize < 8
        || commandSize % 4 !== 0
        || cursor + commandSize > headerAndCommands.byteLength
      ) {
        throw new Error("Codex normalization content has an invalid Mach-O command.");
      }
      if (command === 0x19 && commandSize >= 72) {
        const segmentName = headerAndCommands
          .subarray(cursor + 8, cursor + 24)
          .toString("utf8")
          .replace(/\0+$/u, "");
        if (segmentName === "__LINKEDIT") {
          if (linkedit !== undefined) {
            throw new Error(
              "Codex normalization content has duplicate __LINKEDIT segments.",
            );
          }
          linkedit = {
            commandOffset: cursor,
            fileOffset: safeBigUInt(
              headerAndCommands.readBigUInt64LE(cursor + 40),
              "Mach-O __LINKEDIT file offset",
            ),
            fileSize: safeBigUInt(
              headerAndCommands.readBigUInt64LE(cursor + 48),
              "Mach-O __LINKEDIT file size",
            ),
            vmSize: safeBigUInt(
              headerAndCommands.readBigUInt64LE(cursor + 32),
              "Mach-O __LINKEDIT VM size",
            ),
          };
        }
      } else if (command === 0x1d && commandSize === 16) {
        if (codeSignature !== undefined) {
          throw new Error("Codex normalization content has duplicate code signatures.");
        }
        codeSignature = {
          commandOffset: cursor,
          dataOffset: headerAndCommands.readUInt32LE(cursor + 8),
          dataSize: headerAndCommands.readUInt32LE(cursor + 12),
        };
      }
      cursor += commandSize;
    }
    if (
      cursor !== headerAndCommands.byteLength
      || codeSignature === undefined
      || linkedit === undefined
      || codeSignature.dataOffset < headerAndCommands.byteLength
      || codeSignature.dataSize <= 0
      || codeSignature.dataOffset + codeSignature.dataSize !== status.size
      || linkedit.fileOffset > codeSignature.dataOffset
      || linkedit.fileSize <= 0
      || linkedit.fileOffset + linkedit.fileSize !== status.size
      || linkedit.vmSize < linkedit.fileSize
      || linkedit.vmSize - linkedit.fileSize >= CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE
      || linkedit.vmSize % CODEX_SIGNATURE_NORMALIZATION_PAGE_SIZE !== 0
    ) {
      throw new Error("Codex normalization content has an invalid signature envelope.");
    }
    return {
      codeSignatureCommandOffset: codeSignature.commandOffset,
      codeSignatureDataOffset: codeSignature.dataOffset,
      headerAndCommands,
      linkeditCommandOffset: linkedit.commandOffset,
      linkeditFileOffset: linkedit.fileOffset,
    };
  } finally {
    await handle.close();
  }
}

function sameMachOHeaderOutsideSignatureEnvelope(
  source: MachOSignatureEnvelope,
  packaged: MachOSignatureEnvelope,
): boolean {
  if (source.headerAndCommands.byteLength !== packaged.headerAndCommands.byteLength) {
    return false;
  }
  const mutableRanges = [
    [source.linkeditCommandOffset + 32, source.linkeditCommandOffset + 40],
    [source.linkeditCommandOffset + 48, source.linkeditCommandOffset + 56],
    [source.codeSignatureCommandOffset + 12, source.codeSignatureCommandOffset + 16],
  ] as const;
  for (let index = 0; index < source.headerAndCommands.byteLength; index += 1) {
    if (mutableRanges.some(([start, end]) => index >= start && index < end)) continue;
    if (source.headerAndCommands[index] !== packaged.headerAndCommands[index]) return false;
  }
  return true;
}

export async function verifyCodexSignatureNormalizationContent(
  sourcePath: string,
  packagedPath: string,
): Promise<void> {
  const [source, packaged] = await Promise.all([
    readMachOSignatureEnvelope(sourcePath),
    readMachOSignatureEnvelope(packagedPath),
  ]);
  if (
    source.codeSignatureCommandOffset !== packaged.codeSignatureCommandOffset
    || source.codeSignatureDataOffset !== packaged.codeSignatureDataOffset
    || source.linkeditCommandOffset !== packaged.linkeditCommandOffset
    || source.linkeditFileOffset !== packaged.linkeditFileOffset
    || !sameMachOHeaderOutsideSignatureEnvelope(source, packaged)
  ) {
    throw new Error(
      "Normalized Codex content changed outside its code-signature envelope.",
    );
  }
  const sourceHandle = await open(sourcePath, "r");
  const packagedHandle = await open(packagedPath, "r");
  try {
    const chunkBytes = 1024 * 1024;
    for (
      let position = source.headerAndCommands.byteLength;
      position < source.codeSignatureDataOffset;
      position += chunkBytes
    ) {
      const length = Math.min(chunkBytes, source.codeSignatureDataOffset - position);
      const [sourceChunk, packagedChunk] = await Promise.all([
        readExactChunk(sourceHandle, length, position),
        readExactChunk(packagedHandle, length, position),
      ]);
      if (!sourceChunk.equals(packagedChunk)) {
        throw new Error(
          "Normalized Codex content changed outside its code-signature envelope.",
        );
      }
    }
  } finally {
    await Promise.all([sourceHandle.close(), packagedHandle.close()]);
  }
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
