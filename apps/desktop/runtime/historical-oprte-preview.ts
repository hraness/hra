import { createHash, X509Certificate } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const strictBundleSignaturePolicy = "strict" as const;
export const historicalOprtePreviewSignaturePolicy =
  "historical_oprte_preview_v0_1_4_build_5" as const;

export type BundleSignaturePolicy =
  | typeof strictBundleSignaturePolicy
  | typeof historicalOprtePreviewSignaturePolicy;

export interface StrictBundleSignatureEvidence {
  readonly policy: typeof strictBundleSignaturePolicy;
}

export interface HistoricalOprtePreviewSignatureEvidence {
  readonly policy: typeof historicalOprtePreviewSignaturePolicy;
  readonly cmsByteLength: 1_863;
  readonly cmsSigningTimeMs: 1_786_392_778_000;
  readonly codeDirectoryByteLength: 23_440;
  readonly codeDirectoryCdHash: string;
  readonly codeDirectorySha256: string;
  readonly codeResourcesSha256: string;
  readonly designatedRequirement: string;
  readonly executableSha256: string;
  readonly infoPlistSha256: string;
  readonly leafCertificateSha1: string;
  readonly leafCertificateSha256: string;
  readonly leafNotAfterMs: 2_101_693_045_000;
  readonly leafNotBeforeMs: 1_786_333_045_000;
  readonly rootCertificateSha1: string;
  readonly rootCertificateSha256: string;
  readonly rootGroup: 20;
  readonly rootMode: 448;
  readonly rootNotAfterMs: 2_417_053_045_000;
  readonly rootNotBeforeMs: 1_786_333_045_000;
  readonly rootOwner: "effective_user";
  readonly xattrCount: 695;
  readonly xattrInventorySha256: string;
  readonly xattrName: "com.apple.provenance";
  readonly xattrValueHex: string;
}

export type BundleSignatureEvidence =
  | StrictBundleSignatureEvidence
  | HistoricalOprtePreviewSignatureEvidence;

export interface HistoricalOprtePreviewIdentity {
  readonly build: string;
  readonly bundleIdentifier: string;
  readonly executable: string;
  readonly version: string;
}

export interface HistoricalOprtePreviewTreeEvidence {
  readonly bytes: number;
  readonly directories: number;
  readonly digest: string;
  readonly entries: number;
  readonly files: number;
  readonly symlinks: number;
}

export const expectedHistoricalOprtePreviewIdentity = Object.freeze({
  build: "5",
  bundleIdentifier: "kitchen.hraness",
  executable: "oprte",
  version: "0.1.4",
});

export const expectedHistoricalOprtePreviewTree = Object.freeze({
  bytes: 578_073_214,
  directories: 93,
  digest: "c19f18c03602932be10b3ffe592dcd1d3fd11d2251ee3dc8630f48fbf5cdb64d",
  entries: 694,
  files: 448,
  symlinks: 153,
});

export const expectedHistoricalOprtePreviewSignature = Object.freeze({
  policy: historicalOprtePreviewSignaturePolicy,
  cmsByteLength: 1_863,
  cmsSigningTimeMs: 1_786_392_778_000,
  codeDirectoryByteLength: 23_440,
  codeDirectoryCdHash: "e9884a0b55a13c0801e2908176b8383e52851ae0",
  codeDirectorySha256:
    "e9884a0b55a13c0801e2908176b8383e52851ae04cb94404ab8921a32e24872d",
  codeResourcesSha256:
    "01ce6ee50ec5b5096c13c4ba796c97d46c63e40f2cada678239cfc471fc46dbb",
  designatedRequirement:
    'identifier "kitchen.hraness" and certificate root = H"3b08b5c6d4209824787da73fd5108d66954a16e9" and certificate leaf = H"8e70be5be2b1804a473f4ef1d337930bdbd17dc0"',
  executableSha256:
    "89491cd9b249fa2b3392c26cb916bc349f38f6d47f2e973c9e412dc2c4422315",
  infoPlistSha256:
    "9418a71674cbf18ae02253f6ad3bd7db82fe2ca132582f3e64bd655bbca863cd",
  leafCertificateSha1: "8e70be5be2b1804a473f4ef1d337930bdbd17dc0",
  leafCertificateSha256:
    "6ec2c63a7d3bf28e54c9c38486dc37b8f7c94abfc6fbc07ed51746792a5ae793",
  leafNotAfterMs: 2_101_693_045_000,
  leafNotBeforeMs: 1_786_333_045_000,
  rootCertificateSha1: "3b08b5c6d4209824787da73fd5108d66954a16e9",
  rootCertificateSha256:
    "fa593d3d8c2243412f8964ed7a24f455e3ab87b7c506862ce81a59c19cb5ecb9",
  rootGroup: 20,
  rootMode: 0o700,
  rootNotAfterMs: 2_417_053_045_000,
  rootNotBeforeMs: 1_786_333_045_000,
  rootOwner: "effective_user",
  xattrCount: 695,
  xattrInventorySha256:
    "f6c5d9584d938cfa9d6c108a51879fdfd2aaa26b612664c41429944abc1b0eea",
  xattrName: "com.apple.provenance",
  xattrValueHex: "010200d21f6a44e8c32756",
}) satisfies HistoricalOprtePreviewSignatureEvidence;

const expectedHistoricalOprteCertificateEvidence = Object.freeze({
  leafCertificateSha1:
    expectedHistoricalOprtePreviewSignature.leafCertificateSha1,
  leafCertificateSha256:
    expectedHistoricalOprtePreviewSignature.leafCertificateSha256,
  leafNotAfterMs: expectedHistoricalOprtePreviewSignature.leafNotAfterMs,
  leafNotBeforeMs: expectedHistoricalOprtePreviewSignature.leafNotBeforeMs,
  rootCertificateSha1:
    expectedHistoricalOprtePreviewSignature.rootCertificateSha1,
  rootCertificateSha256:
    expectedHistoricalOprtePreviewSignature.rootCertificateSha256,
  rootNotAfterMs: expectedHistoricalOprtePreviewSignature.rootNotAfterMs,
  rootNotBeforeMs: expectedHistoricalOprtePreviewSignature.rootNotBeforeMs,
});

const expectedHistoricalOprteCryptographicEvidence = Object.freeze({
  ...expectedHistoricalOprteCertificateEvidence,
  cmsSigningTimeMs: expectedHistoricalOprtePreviewSignature.cmsSigningTimeMs,
});

export type HistoricalStrictVerification =
  | "strict"
  | "exact_historical_trust_failure";

export interface HistoricalOprtePreviewInspection {
  readonly identity: HistoricalOprtePreviewIdentity;
  readonly signature: HistoricalOprtePreviewSignatureEvidence;
  readonly strictVerification: HistoricalStrictVerification;
  readonly tree: HistoricalOprtePreviewTreeEvidence;
}

export interface HistoricalOprteCapturedCommand {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type HistoricalOprteCommandCapture = (
  command: readonly string[],
) => Promise<HistoricalOprteCapturedCommand>;

export interface ParsedHistoricalOprteMachOSignature {
  readonly cms: Buffer;
  readonly codeDirectory: Buffer;
}

export interface HistoricalOprteSidebandExpectation {
  readonly xattrCount: number;
  readonly xattrInventorySha256: string;
  readonly xattrName: string;
  readonly xattrValueHex: string;
}

export interface HistoricalOprteSidebandOutputs {
  readonly acls: HistoricalOprteCapturedCommand;
  readonly flags: HistoricalOprteCapturedCommand;
  readonly names: HistoricalOprteCapturedCommand;
  readonly values: HistoricalOprteCapturedCommand;
}

export interface HistoricalOprteBoundaryObservation {
  readonly rootGroup: number;
  readonly rootMode: number;
  readonly rootOwner: "effective_user" | "foreign";
  readonly xattrCount: number;
  readonly xattrInventorySha256: string;
  readonly xattrName: string;
  readonly xattrValueHex: string;
}

export interface HistoricalOprteCertificateEvidence {
  readonly leafCertificateSha1: string;
  readonly leafCertificateSha256: string;
  readonly leafNotAfterMs: number;
  readonly leafNotBeforeMs: number;
  readonly rootCertificateSha1: string;
  readonly rootCertificateSha256: string;
  readonly rootNotAfterMs: number;
  readonly rootNotBeforeMs: number;
}

export interface HistoricalOprteCryptographicEvidence
  extends HistoricalOprteCertificateEvidence {
  readonly cmsSigningTimeMs: number;
}

const sha1Pattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const maximumLoadCommands = 4_096;
const maximumSignatureSlots = 64;

export function classifyHistoricalOprteStrictVerification(
  path: string,
  result: Readonly<HistoricalOprteCapturedCommand>,
): HistoricalStrictVerification {
  if (
    result.exitCode === 0
    && result.stdout.length === 0
    && result.stderr.length === 0
  ) return "strict";

  const expectedFailure =
    `${path}: CSSMERR_TP_NOT_TRUSTED\nIn architecture: arm64\n`;
  if (
    result.exitCode === 1
    && result.stdout.length === 0
    && result.stderr === expectedFailure
  ) return "exact_historical_trust_failure";

  throw new Error(
    "Historical OPRTE strict verification had an unrecognized result.",
  );
}

export function assertHistoricalOprtePreviewInspection(
  value: HistoricalOprtePreviewInspection,
): HistoricalOprtePreviewSignatureEvidence {
  assertExactRecord(
    value.identity,
    expectedHistoricalOprtePreviewIdentity,
    "identity",
  );
  assertExactRecord(
    value.tree,
    expectedHistoricalOprtePreviewTree,
    "tree",
  );
  if (
    value.strictVerification !== "strict"
    && value.strictVerification !== "exact_historical_trust_failure"
  ) {
    throw new Error("Historical OPRTE strict-verification evidence is invalid.");
  }
  assertExactRecord(
    value.signature,
    expectedHistoricalOprtePreviewSignature,
    "signature",
  );
  if (value.signature.xattrCount !== value.tree.entries + 1) {
    throw new Error("Historical OPRTE sideband coverage is incomplete.");
  }
  return expectedHistoricalOprtePreviewSignature;
}

export async function inspectHistoricalOprtePreview(
  path: string,
  identity: HistoricalOprtePreviewIdentity,
  tree: HistoricalOprtePreviewTreeEvidence,
): Promise<HistoricalOprtePreviewSignatureEvidence> {
  if (!isAbsolute(path)) {
    throw new Error("Historical OPRTE inspection requires an absolute path.");
  }
  assertExactRecord(
    identity,
    expectedHistoricalOprtePreviewIdentity,
    "identity",
  );
  assertExactRecord(tree, expectedHistoricalOprtePreviewTree, "tree");

  const strictResult = await capture([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    path,
  ]);
  const strictVerification = classifyHistoricalOprteStrictVerification(
    path,
    strictResult,
  );

  const details = await capture([
    "/usr/bin/codesign",
    "-d",
    "-r-",
    "--verbose=4",
    path,
  ]);
  if (details.exitCode !== 0) {
    throw new Error("Historical OPRTE signature metadata is unavailable.");
  }
  assertCodesignDetails(path, `${details.stdout}\n${details.stderr}`);

  const executablePath = join(path, "Contents", "MacOS", "oprte");
  const infoPlistPath = join(path, "Contents", "Info.plist");
  const codeResourcesPath = join(
    path,
    "Contents",
    "_CodeSignature",
    "CodeResources",
  );
  const [executable, infoPlist, codeResources] = await Promise.all([
    readFile(executablePath),
    readFile(infoPlistPath),
    readFile(codeResourcesPath),
  ]);
  const parsed = parseHistoricalOprteMachOSignature(executable);
  const cryptographic = await verifyHistoricalOprteCmsAndCertificates(parsed);
  // This compatibility proof is for one frozen artifact. Bind the signed CMS
  // time and exact encoded validity intervals instead of consulting ambient
  // wall-clock time, which would make a valid receipt stop authorizing rollback.
  // The executable digest also freezes every byte of the CMS produced without
  // a secure timestamp.
  assertExactRecord(
    cryptographic,
    expectedHistoricalOprteCryptographicEvidence,
    "cryptographic",
  );
  if (
    parsed.cms.byteLength !== expectedHistoricalOprtePreviewSignature.cmsByteLength
    || parsed.codeDirectory.byteLength
      !== expectedHistoricalOprtePreviewSignature.codeDirectoryByteLength
  ) throw new Error("Historical OPRTE signing blob length differs.");
  const codeDirectorySha256 = sha256(parsed.codeDirectory);
  const signature: HistoricalOprtePreviewSignatureEvidence = {
    policy: historicalOprtePreviewSignaturePolicy,
    cmsByteLength: expectedHistoricalOprtePreviewSignature.cmsByteLength,
    cmsSigningTimeMs:
      expectedHistoricalOprtePreviewSignature.cmsSigningTimeMs,
    codeDirectoryByteLength:
      expectedHistoricalOprtePreviewSignature.codeDirectoryByteLength,
    codeDirectoryCdHash: codeDirectorySha256.slice(0, 40),
    codeDirectorySha256,
    codeResourcesSha256: sha256(codeResources),
    designatedRequirement: expectedHistoricalOprtePreviewSignature
      .designatedRequirement,
    executableSha256: sha256(executable),
    infoPlistSha256: sha256(infoPlist),
    ...expectedHistoricalOprteCertificateEvidence,
    rootGroup: expectedHistoricalOprtePreviewSignature.rootGroup,
    rootMode: expectedHistoricalOprtePreviewSignature.rootMode,
    rootOwner: expectedHistoricalOprtePreviewSignature.rootOwner,
    xattrCount: expectedHistoricalOprtePreviewSignature.xattrCount,
    xattrInventorySha256:
      expectedHistoricalOprtePreviewSignature.xattrInventorySha256,
    xattrName: expectedHistoricalOprtePreviewSignature.xattrName,
    xattrValueHex: expectedHistoricalOprtePreviewSignature.xattrValueHex,
  };
  return assertHistoricalOprtePreviewInspection({
    identity,
    signature,
    strictVerification,
    tree,
  });
}

export async function inspectHistoricalOprteBoundary(
  path: string,
): Promise<HistoricalOprteBoundaryObservation> {
  const [root, sideband] = await Promise.all([
    lstat(path),
    inspectHistoricalOprteSideband(path),
  ]);
  const effectiveUser = process.geteuid?.();
  return {
    rootGroup: root.gid,
    rootMode: root.mode & 0o7777,
    rootOwner: effectiveUser !== undefined && root.uid === effectiveUser
      ? "effective_user"
      : "foreign",
    ...sideband,
  };
}

export function assertHistoricalOprteBoundarySamples(
  before: HistoricalOprteBoundaryObservation,
  after: HistoricalOprteBoundaryObservation,
): void {
  const expected = {
    rootGroup: expectedHistoricalOprtePreviewSignature.rootGroup,
    rootMode: expectedHistoricalOprtePreviewSignature.rootMode,
    rootOwner: expectedHistoricalOprtePreviewSignature.rootOwner,
    xattrCount: expectedHistoricalOprtePreviewSignature.xattrCount,
    xattrInventorySha256:
      expectedHistoricalOprtePreviewSignature.xattrInventorySha256,
    xattrName: expectedHistoricalOprtePreviewSignature.xattrName,
    xattrValueHex: expectedHistoricalOprtePreviewSignature.xattrValueHex,
  };
  assertExactRecord(before, expected, "boundary before");
  assertExactRecord(after, expected, "boundary after");
  assertExactRecord(after, before, "boundary reinspection");
}

export async function withHistoricalOprteBoundaryProof<Result>(
  path: string,
  inspectProof: () => Promise<Result>,
  inspectBoundary: (
    path: string,
  ) => Promise<HistoricalOprteBoundaryObservation> = inspectHistoricalOprteBoundary,
): Promise<Result> {
  const before = await inspectBoundary(path);
  assertHistoricalOprteBoundarySamples(before, before);
  const result = await inspectProof();
  const after = await inspectBoundary(path);
  assertHistoricalOprteBoundarySamples(before, after);
  return result;
}

function assertCodesignDetails(path: string, output: string): void {
  const expected = expectedHistoricalOprtePreviewSignature;
  for (const [prefix, value] of [
    ["Executable=", join(path, "Contents", "MacOS", "oprte")],
    ["Identifier=", "kitchen.hraness"],
    ["Format=", "app bundle with Mach-O thin (arm64)"],
    ["CandidateCDHash sha256=", expected.codeDirectoryCdHash],
    ["CandidateCDHashFull sha256=", expected.codeDirectorySha256],
    ["Hash choices=", "sha256"],
    ["CMSDigest=", expected.codeDirectorySha256],
    ["CMSDigestType=", "2"],
    ["Page size=", "4096"],
    ["CDHash=", expected.codeDirectoryCdHash],
    ["Signature size=", String(expected.cmsByteLength)],
    ["TeamIdentifier=", "not set"],
    ["designated => ", expected.designatedRequirement],
  ] as const) {
    if (singleLineValue(output, prefix) !== value) {
      throw new Error(`Historical OPRTE codesign ${prefix} evidence differs.`);
    }
  }
}

function singleLineValue(output: string, prefix: string): string | null {
  const values = output.split("\n")
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length));
  return values.length === 1 ? values[0] ?? null : null;
}

export function parseHistoricalOprteMachOSignature(
  executable: Buffer,
): ParsedHistoricalOprteMachOSignature {
  if (
    readUint32LittleEndian(executable, 0) !== 0xfeedfacf
    || readUint32LittleEndian(executable, 4) !== 0x0100000c
    || readUint32LittleEndian(executable, 12) !== 2
  ) throw new Error("Historical OPRTE executable is not one thin arm64 Mach-O.");

  const commandCount = readUint32LittleEndian(executable, 16);
  const commandBytes = readUint32LittleEndian(executable, 20);
  if (commandCount > maximumLoadCommands || 32 + commandBytes > executable.byteLength) {
    throw new Error("Historical OPRTE Mach-O load commands are invalid.");
  }

  let cursor = 32;
  let signatureRange: Readonly<{ offset: number; length: number }> | null = null;
  for (let index = 0; index < commandCount; index += 1) {
    const command = readUint32LittleEndian(executable, cursor);
    const commandSize = readUint32LittleEndian(executable, cursor + 4);
    if (
      commandSize < 8
      || commandSize % 4 !== 0
      || cursor + commandSize > 32 + commandBytes
    ) throw new Error("Historical OPRTE Mach-O load command is malformed.");
    if (command === 0x1d) {
      if (commandSize !== 16 || signatureRange !== null) {
        throw new Error("Historical OPRTE must have one code-signature command.");
      }
      signatureRange = {
        offset: readUint32LittleEndian(executable, cursor + 8),
        length: readUint32LittleEndian(executable, cursor + 12),
      };
    }
    cursor += commandSize;
  }
  if (cursor !== 32 + commandBytes || signatureRange === null) {
    throw new Error("Historical OPRTE code-signature range is missing.");
  }
  if (
    signatureRange.offset < cursor
    || signatureRange.length < 12
    || signatureRange.offset + signatureRange.length !== executable.byteLength
  ) throw new Error("Historical OPRTE code-signature range is invalid.");

  const signatureRangeBytes = executable.subarray(
    signatureRange.offset,
    signatureRange.offset + signatureRange.length,
  );
  if (readUint32BigEndian(signatureRangeBytes, 0) !== 0xfade0cc0) {
    throw new Error("Historical OPRTE signature SuperBlob is invalid.");
  }
  const superBlobLength = readUint32BigEndian(signatureRangeBytes, 4);
  const slotCount = readUint32BigEndian(signatureRangeBytes, 8);
  if (
    superBlobLength > signatureRangeBytes.byteLength
    || slotCount > maximumSignatureSlots
    || 12 + slotCount * 8 > superBlobLength
  ) throw new Error("Historical OPRTE signature index is invalid.");
  const signature = signatureRangeBytes.subarray(0, superBlobLength);
  if (signatureRangeBytes.subarray(superBlobLength).some(byte => byte !== 0)) {
    throw new Error("Historical OPRTE signature padding is invalid.");
  }

  const slots = new Map<number, Buffer>();
  const ranges: Array<Readonly<{ end: number; start: number }>> = [];
  for (let index = 0; index < slotCount; index += 1) {
    const type = readUint32BigEndian(signature, 12 + index * 8);
    const offset = readUint32BigEndian(signature, 16 + index * 8);
    if (slots.has(type) || offset < 12 + slotCount * 8 || offset + 8 > signature.length) {
      throw new Error("Historical OPRTE signature slot is invalid.");
    }
    const length = readUint32BigEndian(signature, offset + 4);
    if (length < 8 || offset + length > signature.length) {
      throw new Error("Historical OPRTE signature blob is invalid.");
    }
    ranges.push({ start: offset, end: offset + length });
    slots.set(type, signature.subarray(offset, offset + length));
  }
  ranges.sort((left, right) => left.start - right.start);
  if (ranges.some((range, index) =>
    index > 0 && (ranges[index - 1]?.end ?? 0) > range.start
  )) throw new Error("Historical OPRTE signature blobs overlap.");
  const codeDirectory = slots.get(0);
  const cmsWrapper = slots.get(0x10000);
  if (
    codeDirectory === undefined
    || readUint32BigEndian(codeDirectory, 0) !== 0xfade0c02
    || cmsWrapper === undefined
    || readUint32BigEndian(cmsWrapper, 0) !== 0xfade0b01
  ) throw new Error("Historical OPRTE signing blobs are incomplete.");
  return { codeDirectory, cms: cmsWrapper.subarray(8) };
}

export async function verifyHistoricalOprteCmsAndCertificates(
  parsed: ParsedHistoricalOprteMachOSignature,
  captureCommand: HistoricalOprteCommandCapture = capture,
): Promise<HistoricalOprteCryptographicEvidence> {
  const directory = await mkdtemp(join(tmpdir(), "hra-oprte-signature-"));
  const cmsPath = join(directory, "signature.cms");
  const codeDirectoryPath = join(directory, "CodeDirectory");
  const certificatesPath = join(directory, "certificates.pem");
  try {
    await Promise.all([
      writeFile(cmsPath, parsed.cms, { flag: "wx", mode: 0o600 }),
      writeFile(codeDirectoryPath, parsed.codeDirectory, {
        flag: "wx",
        mode: 0o600,
      }),
    ]);
    const verified = await captureCommand([
      "/usr/bin/openssl",
      "cms",
      "-verify",
      "-binary",
      "-inform",
      "DER",
      "-in",
      cmsPath,
      "-content",
      codeDirectoryPath,
      "-noverify",
      "-out",
      "/dev/null",
    ]);
    if (verified.exitCode !== 0) {
      throw new Error("Historical OPRTE CMS signature is invalid.");
    }
    const described = await captureCommand([
      "/usr/bin/openssl",
      "cms",
      "-cmsout",
      "-print",
      "-inform",
      "DER",
      "-in",
      cmsPath,
    ]);
    if (described.exitCode !== 0 || described.stderr.length !== 0) {
      throw new Error("Historical OPRTE CMS attributes are unavailable.");
    }
    const cmsSigningTimeMs = parseHistoricalOprteCmsSigningTime(
      described.stdout,
    );
    const extracted = await captureCommand([
      "/usr/bin/openssl",
      "pkcs7",
      "-inform",
      "DER",
      "-in",
      cmsPath,
      "-print_certs",
      "-out",
      certificatesPath,
    ]);
    if (extracted.exitCode !== 0) {
      throw new Error("Historical OPRTE CMS certificates are unavailable.");
    }
    const certificates = parseHistoricalOprteCertificateChain(
      await readFile(certificatesPath, "utf8"),
    );
    assertHistoricalOprteCmsSigningTimeWithinLeaf(
      cmsSigningTimeMs,
      certificates,
    );
    return { ...certificates, cmsSigningTimeMs };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function parseHistoricalOprteCmsSigningTime(output: string): number {
  const marker = "object: signingTime (1.2.840.113549.1.9.5)";
  const lines = output.replaceAll("\r\n", "\n").split("\n");
  const indexes = lines.flatMap((line, index) =>
    line.trim() === marker ? [index] : []
  );
  const valueSet = indexes.length === 1
    ? lines[(indexes[0] ?? -1) + 1]?.trim()
    : undefined;
  const encoded = indexes.length === 1
    ? lines[(indexes[0] ?? -1) + 2]?.trim()
    : undefined;
  if (
    valueSet !== "value.set:"
    || encoded === undefined
    || !/^UTCTIME:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(?:[1-9]|[12][0-9]|3[01]) [0-2][0-9]:[0-5][0-9]:[0-5][0-9] [0-9]{4} GMT$/u
      .test(encoded)
  ) throw new Error("Historical OPRTE CMS signing time is invalid.");
  const signingTimeMs = Date.parse(encoded.slice("UTCTIME:".length));
  if (!Number.isSafeInteger(signingTimeMs)) {
    throw new Error("Historical OPRTE CMS signing time is invalid.");
  }
  return signingTimeMs;
}

export function assertHistoricalOprteCmsSigningTimeWithinLeaf(
  cmsSigningTimeMs: number,
  certificate: HistoricalOprteCertificateEvidence,
): void {
  if (
    !Number.isSafeInteger(cmsSigningTimeMs)
    || cmsSigningTimeMs < certificate.leafNotBeforeMs
    || cmsSigningTimeMs > certificate.leafNotAfterMs
  ) throw new Error(
    "Historical OPRTE CMS signing time is outside leaf certificate validity.",
  );
}

export function parseHistoricalOprteCertificateChain(
  pem: string,
): HistoricalOprteCertificateEvidence {
  const encodedCertificates = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu,
  ) ?? [];
  if (encodedCertificates.length !== 2) {
    throw new Error("Historical OPRTE CMS must embed exactly two certificates.");
  }
  const certificates = encodedCertificates.map(value => new X509Certificate(value));
  const expected = expectedHistoricalOprtePreviewSignature;
  const root = certificates.find(certificate =>
    sha256(certificate.raw) === expected.rootCertificateSha256
  );
  const leaf = certificates.find(certificate =>
    sha256(certificate.raw) === expected.leafCertificateSha256
  );
  if (
    root === undefined
    || leaf === undefined
    || root === leaf
    || !root.ca
    || leaf.ca
    || root.subject !== root.issuer
    || leaf.issuer !== root.subject
    || !root.verify(root.publicKey)
    || !leaf.verify(root.publicKey)
  ) throw new Error("Historical OPRTE certificate chain is invalid.");
  const evidence: HistoricalOprteCertificateEvidence = {
    leafCertificateSha1: sha1(leaf.raw),
    leafCertificateSha256: sha256(leaf.raw),
    leafNotAfterMs: Date.parse(leaf.validTo),
    leafNotBeforeMs: Date.parse(leaf.validFrom),
    rootCertificateSha1: sha1(root.raw),
    rootCertificateSha256: sha256(root.raw),
    rootNotAfterMs: Date.parse(root.validTo),
    rootNotBeforeMs: Date.parse(root.validFrom),
  };
  for (const [key, value] of Object.entries(evidence)) {
    if (key.endsWith("Ms")) {
      if (!Number.isSafeInteger(value)) {
        throw new Error("Historical OPRTE certificate validity is invalid.");
      }
      continue;
    }
    const pattern = key.endsWith("Sha1") ? sha1Pattern : sha256Pattern;
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new Error("Historical OPRTE certificate digest is invalid.");
    }
  }
  return evidence;
}

export async function inspectHistoricalOprteSideband(
  path: string,
  captureCommand: HistoricalOprteCommandCapture = capture,
  expected: HistoricalOprteSidebandExpectation =
    expectedHistoricalOprtePreviewSignature,
): Promise<HistoricalOprteSidebandExpectation> {
  const names = await captureCommand(["/usr/bin/xattr", "-r", "-s", path]);
  const values = await captureCommand([
    "/usr/bin/xattr",
    "-p",
    "-r",
    "-s",
    "-x",
    expected.xattrName,
    path,
  ]);
  const flags = await captureCommand([
    "/usr/bin/find",
    path,
    "-exec",
    "/usr/bin/stat",
    "-f",
    "%Sf",
    "{}",
    "+",
  ]);
  const acls = await captureCommand([
    "/usr/bin/find",
    path,
    "-exec",
    "/bin/ls",
    "-lde",
    "{}",
    "+",
  ]);
  return parseHistoricalOprteSidebandOutputs(
    path,
    { acls, flags, names, values },
    expected,
  );
}

export function parseHistoricalOprteSidebandOutputs(
  path: string,
  outputs: HistoricalOprteSidebandOutputs,
  expected: HistoricalOprteSidebandExpectation,
): HistoricalOprteSidebandExpectation {
  const { acls, flags, names, values } = outputs;
  if (names.exitCode !== 0 || names.stderr.length !== 0) {
    throw new Error("Historical OPRTE extended attributes are unavailable.");
  }
  const inventory = nonEmptyLines(names.stdout).map(line => {
    if (!line.startsWith(path)) {
      throw new Error("Historical OPRTE xattr path escaped its bundle.");
    }
    return line.slice(path.length);
  });
  if (
    inventory.length !== expected.xattrCount
    || inventory.some(line =>
      line !== `: ${expected.xattrName}`
      && !(line.startsWith("/") && line.endsWith(`: ${expected.xattrName}`))
    )
  ) throw new Error("Historical OPRTE xattr inventory differs.");
  inventory.sort(compareUtf8);
  const inventorySha256 = sha256(Buffer.from(`${inventory.join("\n")}\n`, "utf8"));

  if (values.exitCode !== 0 || values.stderr.length !== 0) {
    throw new Error("Historical OPRTE provenance values are unavailable.");
  }
  const valueLines = nonEmptyLines(values.stdout);
  if (valueLines.length !== expected.xattrCount * 2) {
    throw new Error("Historical OPRTE provenance coverage differs.");
  }
  const valuePaths: string[] = [];
  for (let index = 0; index < valueLines.length; index += 2) {
    const header = valueLines[index] ?? "";
    const encoded = valueLines[index + 1] ?? "";
    if (!header.startsWith(path) || !header.endsWith(": ")) {
      throw new Error("Historical OPRTE provenance path is invalid.");
    }
    valuePaths.push(header.slice(path.length, -2));
    if (encoded.replaceAll(" ", "").toLowerCase() !== expected.xattrValueHex) {
      throw new Error("Historical OPRTE provenance value differs.");
    }
  }
  valuePaths.sort(compareUtf8);
  const inventoryPaths = inventory.map(line =>
    line.slice(0, -`: ${expected.xattrName}`.length)
  ).sort(compareUtf8);
  if (JSON.stringify(valuePaths) !== JSON.stringify(inventoryPaths)) {
    throw new Error("Historical OPRTE provenance paths differ.");
  }

  const flagLines = nonEmptyLines(flags.stdout);
  if (
    flags.exitCode !== 0
    || flags.stderr.length !== 0
    || flagLines.length !== expected.xattrCount
    || flagLines.some(value => value !== "-")
  ) throw new Error("Historical OPRTE file flags differ.");

  if (
    acls.exitCode !== 0
    || acls.stderr.length !== 0
    || /^[\t ]+\d+:/mu.test(acls.stdout)
  ) throw new Error("Historical OPRTE ACL evidence differs.");

  return {
    xattrCount: expected.xattrCount,
    xattrInventorySha256: inventorySha256,
    xattrName: expected.xattrName,
    xattrValueHex: expected.xattrValueHex,
  };
}

function nonEmptyLines(value: string): string[] {
  return value.split("\n").filter(line => line.length > 0);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertExactRecord(
  actual: object,
  expected: object,
  label: string,
): void {
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (
    actualEntries.length !== expectedEntries.length
    || actualEntries.some(([key, value], index) => {
      const expectedEntry = expectedEntries[index];
      return expectedEntry === undefined
        || expectedEntry[0] !== key
        || !Object.is(expectedEntry[1], value);
    })
  ) {
    throw new Error(`Historical OPRTE ${label} evidence differs.`);
  }
}

function readUint32LittleEndian(bytes: Buffer, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > bytes.byteLength) {
    throw new Error("Historical OPRTE Mach-O integer is out of bounds.");
  }
  return bytes.readUInt32LE(offset);
}

function readUint32BigEndian(bytes: Buffer, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > bytes.byteLength) {
    throw new Error("Historical OPRTE signature integer is out of bounds.");
  }
  return bytes.readUInt32BE(offset);
}

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function capture(
  command: readonly string[],
): Promise<HistoricalOprteCapturedCommand> {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}
