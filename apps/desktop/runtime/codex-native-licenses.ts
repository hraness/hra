import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const expectedPackageCount = 969;
const expectedExternalPackageCount = 849;
const expectedWorkspacePackageCount = 120;
const expectedPayloadPaths = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-package.json",
  "codex-path/rg",
  "codex-resources/zsh/bin/zsh",
] as const;
const expectedNativeComponents = [
  "abseil-cpp@20250814.1",
  "codex-project@0.144.6",
  "dragonbox@beeeef91cf6fef89a4d4ba5e95d47ca64ccb3a44",
  "fast_float@8.0.2",
  "fp16@3d2de1816307bac63c16a297e8c4dc501b4076df",
  "highway@1.2.0",
  "icu@a86a32e67b8d1384b33f8fa48c83a6079b86f8cd",
  "libc++@99457fa555797f8c5ac3c076ca288d8481d3b23a",
  "libc++abi@8f11bb1d4438d0239d0dfc1bd9456a9f31629dda",
  "llvm-libc@cb952785ccee13811f293f3c419958d1e3ddafbf",
  "pcre2@10.45",
  "ripgrep@15.1.0",
  "rusty_v8@149.2.0",
  "simdutf@7.7.0",
  "v8@14.9.207.2",
  "zsh@77045ef899e53b9598bebc5a41db93a548a40ca6",
] as const;

type JsonRecord = Record<string, unknown>;

export type CodexNativeLicenseDocument = Readonly<{
  sha256: string;
  sources: readonly string[];
  text: string;
}>;

export type CodexNativeCargoPackage = Readonly<{
  authors: readonly string[];
  checksum?: string;
  declaredLicense: string;
  documentSha256s: readonly string[];
  identity: string;
  licenseEvidence: string;
  manifestSha256: string;
  originalManifestSha256?: string;
  reviewedLicenseExpression?: string;
  source: string;
  upstreamLicenseDocumentMissing: boolean;
}>;

export type CodexNativeComponent = Readonly<{
  documentSha256s: readonly string[];
  evidence: readonly Readonly<{
    name: string;
    sha256: string;
    source: string;
  }>[];
  identity: string;
  license: string;
  sourceCommit: string;
  sourceUrl: string;
}>;

export type CodexNativePayload = Readonly<{
  coverage: readonly string[];
  path: string;
  sha256: string;
  size: number;
}>;

export type CodexNativeLicenseInventory = Readonly<{
  counts: Readonly<{
    documents: number;
    externalPackages: number;
    nativeComponents: number;
    packages: number;
    payloads: number;
    workspacePackages: number;
  }>;
  documents: readonly CodexNativeLicenseDocument[];
  nativeComponents: readonly CodexNativeComponent[];
  packages: readonly CodexNativeCargoPackage[];
  platformPackage: Readonly<{
    integrity: string;
    manifestSha256: string;
    name: "@openai/codex";
    payloads: readonly CodexNativePayload[];
    target: "aarch64-apple-darwin";
    version: "0.144.6-darwin-arm64";
  }>;
  schemaVersion: 1;
  source: Readonly<{
    cargoLockExternalIdentities: readonly string[];
    cargoLockExternalIdentitiesSha256: string;
    cargoLockSha256: string;
    cargoMetadataSha256: string;
    cargoTreeSha256: string;
    commit: "5d1fbf26c43abc65a203928b2e31561cb039e06d";
    normalizedCargoLockSha256: string;
    repository: "https://github.com/openai/codex";
    rootPackages: readonly ["codex-cli", "codex-code-mode-host"];
    rustToolchain: "1.95.0";
    tag: "rust-v0.144.6";
    target: "aarch64-apple-darwin";
  }>;
}>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  return value as string[];
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSha256(value: string, label: string): string {
  if (!sha256Pattern.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function assertSortedUnique(values: readonly string[], label: string): void {
  if (values.length !== new Set(values).size) throw new Error(`${label} contains a duplicate.`);
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
    throw new Error(`${label} must be strictly sorted.`);
  }
}

function parseInventory(value: unknown): CodexNativeLicenseInventory {
  const root = record(value, "Codex native license inventory");
  if (root["schemaVersion"] !== 1) throw new Error("Codex native license schema is unsupported.");

  const source = record(root["source"], "Codex native inventory source");
  const externalIdentities = strings(
    source["cargoLockExternalIdentities"],
    "Codex external Cargo.lock identities",
  );
  assertSortedUnique(externalIdentities, "Codex external Cargo.lock identities");
  if (externalIdentities.length !== expectedExternalPackageCount) {
    throw new Error(`Codex external Cargo.lock identity count must be ${expectedExternalPackageCount}.`);
  }
  const parsedSource = {
    cargoLockExternalIdentities: externalIdentities,
    cargoLockExternalIdentitiesSha256: assertSha256(
      string(source["cargoLockExternalIdentitiesSha256"], "Cargo.lock identity digest"),
      "Cargo.lock identity digest",
    ),
    cargoLockSha256: assertSha256(string(source["cargoLockSha256"], "Cargo.lock digest"), "Cargo.lock digest"),
    cargoMetadataSha256: assertSha256(
      string(source["cargoMetadataSha256"], "Cargo metadata digest"),
      "Cargo metadata digest",
    ),
    cargoTreeSha256: assertSha256(string(source["cargoTreeSha256"], "Cargo tree digest"), "Cargo tree digest"),
    commit: string(source["commit"], "Codex source commit"),
    normalizedCargoLockSha256: assertSha256(
      string(source["normalizedCargoLockSha256"], "normalized Cargo.lock digest"),
      "normalized Cargo.lock digest",
    ),
    repository: string(source["repository"], "Codex source repository"),
    rootPackages: strings(source["rootPackages"], "Codex root packages"),
    rustToolchain: string(source["rustToolchain"], "Codex Rust toolchain"),
    tag: string(source["tag"], "Codex source tag"),
    target: string(source["target"], "Codex target"),
  };
  if (
    parsedSource.repository !== "https://github.com/openai/codex" ||
    parsedSource.tag !== "rust-v0.144.6" ||
    parsedSource.commit !== "5d1fbf26c43abc65a203928b2e31561cb039e06d" ||
    parsedSource.rustToolchain !== "1.95.0" ||
    parsedSource.target !== "aarch64-apple-darwin" ||
    parsedSource.rootPackages.join("\n") !== "codex-cli\ncodex-code-mode-host"
  ) {
    throw new Error("Codex native inventory source pin differs from the reviewed 0.144.6 build graph.");
  }
  if (sha256(`${externalIdentities.join("\n")}\n`) !== parsedSource.cargoLockExternalIdentitiesSha256) {
    throw new Error("Codex external Cargo.lock identity digest differs.");
  }

  const rawDocuments = root["documents"];
  if (!Array.isArray(rawDocuments) || rawDocuments.length === 0) {
    throw new Error("Codex native inventory must contain license documents.");
  }
  const documents = rawDocuments.map((rawDocument, index) => {
    const document = record(rawDocument, `Codex license document ${index}`);
    const text = string(document["text"], `Codex license document ${index} text`);
    const sources = strings(document["sources"], `Codex license document ${index} sources`);
    assertSortedUnique(sources, `Codex license document ${index} sources`);
    if (sources.length === 0) throw new Error(`Codex license document ${index} has no provenance source.`);
    const digest = assertSha256(
      string(document["sha256"], `Codex license document ${index} digest`),
      `Codex license document ${index} digest`,
    );
    if (sha256(text) !== digest) throw new Error(`Codex license document ${index} hash differs.`);
    return { sha256: digest, sources, text } satisfies CodexNativeLicenseDocument;
  }).sort((left, right) => compareText(left.sha256, right.sha256));
  assertSortedUnique(documents.map((entry) => entry.sha256), "Codex license document digests");
  const documentDigests = new Set(documents.map((entry) => entry.sha256));

  const rawPackages = root["packages"];
  if (!Array.isArray(rawPackages) || rawPackages.length !== expectedPackageCount) {
    throw new Error(`Codex Cargo closure must contain exactly ${expectedPackageCount} packages.`);
  }
  const packages = rawPackages.map((rawPackage, index) => {
    const packageValue = record(rawPackage, `Codex Cargo package ${index}`);
    const identity = string(packageValue["identity"], `Codex Cargo package ${index} identity`);
    const packageDocuments = strings(
      packageValue["documentSha256s"],
      `Codex Cargo package ${identity} documents`,
    );
    assertSortedUnique(packageDocuments, `Codex Cargo package ${identity} documents`);
    if (packageDocuments.length === 0 || packageDocuments.some((digest) => !documentDigests.has(digest))) {
      throw new Error(`Codex Cargo package ${identity} has incomplete license document references.`);
    }
    const checksum = packageValue["checksum"];
    const originalManifest = packageValue["originalManifestSha256"];
    const reviewedLicenseExpression = packageValue["reviewedLicenseExpression"];
    return {
      authors: strings(packageValue["authors"], `Codex Cargo package ${identity} authors`),
      ...(typeof checksum === "string"
        ? { checksum: assertSha256(checksum, `Codex Cargo package ${identity} checksum`) }
        : {}),
      declaredLicense: string(
        packageValue["declaredLicense"],
        `Codex Cargo package ${identity} declared license`,
      ),
      documentSha256s: packageDocuments,
      identity,
      licenseEvidence: string(
        packageValue["licenseEvidence"],
        `Codex Cargo package ${identity} license evidence`,
      ),
      manifestSha256: assertSha256(
        string(packageValue["manifestSha256"], `Codex Cargo package ${identity} manifest digest`),
        `Codex Cargo package ${identity} manifest digest`,
      ),
      ...(typeof originalManifest === "string"
        ? {
            originalManifestSha256: assertSha256(
              originalManifest,
              `Codex Cargo package ${identity} original manifest digest`,
            ),
          }
        : {}),
      ...(typeof reviewedLicenseExpression === "string"
        ? {
            reviewedLicenseExpression: string(
              reviewedLicenseExpression,
              `Codex Cargo package ${identity} reviewed license expression`,
            ),
          }
        : {}),
      source: string(packageValue["source"], `Codex Cargo package ${identity} source`),
      upstreamLicenseDocumentMissing:
        packageValue["upstreamLicenseDocumentMissing"] === true,
    } satisfies CodexNativeCargoPackage;
  });
  assertSortedUnique(packages.map((entry) => entry.identity), "Codex Cargo package identities");
  const externalPackages = packages.filter((entry) => !entry.source.startsWith("workspace:"));
  const workspacePackages = packages.filter((entry) => entry.source.startsWith("workspace:"));
  if (
    externalPackages.length !== expectedExternalPackageCount ||
    workspacePackages.length !== expectedWorkspacePackageCount
  ) {
    throw new Error("Codex Cargo closure external/workspace package counts differ.");
  }
  const packageLockIdentities = externalPackages.map((entry) =>
    `${entry.identity}|${entry.source}|${entry.checksum ?? "-"}`
  );
  if (packageLockIdentities.join("\n") !== externalIdentities.join("\n")) {
    throw new Error("Codex Cargo closure does not equal the exact external Cargo.lock identities.");
  }
  const missingUpstreamDocuments = packages
    .filter((entry) => entry.upstreamLicenseDocumentMissing)
    .map((entry) => entry.identity);
  const expectedMissingUpstreamDocuments = [
    "debugserver-types@0.5.0",
    "deno_core_icudata@0.77.0",
    "eventsource-stream@0.2.3",
    "fax@0.2.6",
    "fax_derive@0.2.0",
    "fxhash@0.2.1",
    "io_tee@0.1.1",
    "sse-stream@0.2.1",
  ];
  if (missingUpstreamDocuments.join("\n") !== expectedMissingUpstreamDocuments.join("\n")) {
    throw new Error("Codex manifest-license fallback set differs from the exact eight reviewed crates.");
  }
  if (
    packages.some(
      (entry) => entry.upstreamLicenseDocumentMissing && entry.reviewedLicenseExpression === undefined,
    )
  ) {
    throw new Error("Codex manifest-license fallback lacks a reviewed license expression.");
  }

  const rawComponents = root["nativeComponents"];
  if (!Array.isArray(rawComponents)) throw new Error("Codex native components must be an array.");
  const nativeComponents = rawComponents.map((rawComponent, index) => {
    const component = record(rawComponent, `Codex native component ${index}`);
    const identity = string(component["identity"], `Codex native component ${index} identity`);
    const componentDocuments = strings(component["documentSha256s"], `${identity} documents`);
    assertSortedUnique(componentDocuments, `${identity} documents`);
    if (componentDocuments.length === 0 || componentDocuments.some((digest) => !documentDigests.has(digest))) {
      throw new Error(`Codex native component ${identity} has incomplete license documents.`);
    }
    const rawEvidence = component["evidence"];
    if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
      throw new Error(`Codex native component ${identity} has no pinned evidence.`);
    }
    const evidence = rawEvidence.map((rawEntry, evidenceIndex) => {
      const entry = record(rawEntry, `${identity} evidence ${evidenceIndex}`);
      return {
        name: string(entry["name"], `${identity} evidence ${evidenceIndex} name`),
        sha256: assertSha256(
          string(entry["sha256"], `${identity} evidence ${evidenceIndex} digest`),
          `${identity} evidence ${evidenceIndex} digest`,
        ),
        source: string(entry["source"], `${identity} evidence ${evidenceIndex} source`),
      };
    });
    assertSortedUnique(evidence.map((entry) => entry.name), `${identity} evidence names`);
    return {
      documentSha256s: componentDocuments,
      evidence,
      identity,
      license: string(component["license"], `${identity} license`),
      sourceCommit: string(component["sourceCommit"], `${identity} source commit`),
      sourceUrl: string(component["sourceUrl"], `${identity} source URL`),
    } satisfies CodexNativeComponent;
  });
  assertSortedUnique(nativeComponents.map((entry) => entry.identity), "Codex native component identities");
  if (nativeComponents.map((entry) => entry.identity).join("\n") !== expectedNativeComponents.join("\n")) {
    throw new Error("Codex native component set differs from the reviewed macOS build inputs.");
  }

  const platform = record(root["platformPackage"], "Codex platform package");
  const rawPayloads = platform["payloads"];
  if (!Array.isArray(rawPayloads)) throw new Error("Codex platform payloads must be an array.");
  const payloads = rawPayloads.map((rawPayload, index) => {
    const payload = record(rawPayload, `Codex platform payload ${index}`);
    const payloadPath = string(payload["path"], `Codex platform payload ${index} path`);
    const coverage = strings(payload["coverage"], `Codex platform payload ${payloadPath} coverage`);
    assertSortedUnique(coverage, `Codex platform payload ${payloadPath} coverage`);
    if (coverage.length === 0) throw new Error(`Codex platform payload ${payloadPath} has no coverage.`);
    return {
      coverage,
      path: payloadPath,
      sha256: assertSha256(
        string(payload["sha256"], `Codex platform payload ${payloadPath} digest`),
        `Codex platform payload ${payloadPath} digest`,
      ),
      size: integer(payload["size"], `Codex platform payload ${payloadPath} size`),
    } satisfies CodexNativePayload;
  });
  assertSortedUnique(payloads.map((entry) => entry.path), "Codex platform payload paths");
  if (payloads.map((entry) => entry.path).join("\n") !== expectedPayloadPaths.join("\n")) {
    throw new Error("Codex platform payload set differs from the exact shipped npm package.");
  }
  if (
    platform["name"] !== "@openai/codex" ||
    platform["version"] !== "0.144.6-darwin-arm64" ||
    platform["target"] !== "aarch64-apple-darwin"
  ) {
    throw new Error("Codex platform package identity differs from the reviewed native package.");
  }
  const platformPackage = {
    integrity: string(platform["integrity"], "Codex platform package integrity"),
    manifestSha256: assertSha256(
      string(platform["manifestSha256"], "Codex platform package manifest digest"),
      "Codex platform package manifest digest",
    ),
    name: "@openai/codex" as const,
    payloads,
    target: "aarch64-apple-darwin" as const,
    version: "0.144.6-darwin-arm64" as const,
  };
  if (!platformPackage.integrity.startsWith("sha512-")) {
    throw new Error("Codex platform package integrity must be a sha512 SRI value.");
  }

  const counts = record(root["counts"], "Codex native inventory counts");
  const parsedCounts = {
    documents: integer(counts["documents"], "Codex document count"),
    externalPackages: integer(counts["externalPackages"], "Codex external package count"),
    nativeComponents: integer(counts["nativeComponents"], "Codex native component count"),
    packages: integer(counts["packages"], "Codex package count"),
    payloads: integer(counts["payloads"], "Codex payload count"),
    workspacePackages: integer(counts["workspacePackages"], "Codex workspace package count"),
  };
  if (
    parsedCounts.documents !== documents.length ||
    parsedCounts.externalPackages !== externalPackages.length ||
    parsedCounts.nativeComponents !== nativeComponents.length ||
    parsedCounts.packages !== packages.length ||
    parsedCounts.payloads !== payloads.length ||
    parsedCounts.workspacePackages !== workspacePackages.length
  ) {
    throw new Error("Codex native inventory summary counts differ from their arrays.");
  }

  return {
    counts: parsedCounts,
    documents,
    nativeComponents,
    packages,
    platformPackage,
    schemaVersion: 1,
    source: parsedSource as CodexNativeLicenseInventory["source"],
  };
}

export function verifyCodexNativeLicenseInventory(value: unknown): CodexNativeLicenseInventory {
  return parseInventory(value);
}

export function serializeCodexNativeLicenseInventory(
  inventory: CodexNativeLicenseInventory,
): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export function renderCodexNativeLicenseNotices(inventory: CodexNativeLicenseInventory): string {
  const lines = [
    "CODEX 0.144.6 NATIVE DEPENDENCY LICENSE INVENTORY",
    "",
    `Source: ${inventory.source.repository} tag ${inventory.source.tag} (${inventory.source.commit})`,
    `Target: ${inventory.source.target}; Rust ${inventory.source.rustToolchain}`,
    `Cargo closure: ${inventory.counts.packages} packages (${inventory.counts.externalPackages} external, ${inventory.counts.workspacePackages} workspace)`,
    `Native components: ${inventory.counts.nativeComponents}; unique license documents: ${inventory.counts.documents}`,
    "",
    "UPSTREAM LICENSE DOCUMENT GAPS",
    "",
    "Eight exact published/source trees declare a license but contain no authored license document. Their entries preserve the exact identity, manifest hash, declared expression, manifest authors when declared, and a reviewed expression with pinned canonical terms. Canonical MIT terms retain the SPDX placeholder instead of inventing a year or copyright holder. io_tee@0.1.1 also declares no manifest authors, so no attribution is inferred.",
    "",
    "SHIPPED NPM PAYLOADS",
    "",
    ...inventory.platformPackage.payloads.map(
      (payload) => `${payload.path}\n  SHA-256: ${payload.sha256}\n  Coverage: ${payload.coverage.join(", ")}`,
    ),
    "",
    "CARGO PACKAGE TO LICENSE DOCUMENT MAP",
    "",
    ...inventory.packages.map(
      (entry) =>
        `${entry.identity} [${entry.declaredLicense}]\n  Authors: ${entry.authors.length > 0 ? entry.authors.join("; ") : "not declared"}\n  Evidence: ${entry.licenseEvidence}\n  Manifest SHA-256: ${entry.manifestSha256}\n  Reviewed license expression: ${entry.reviewedLicenseExpression ?? "not required; upstream document present"}\n  Upstream license document: ${entry.upstreamLicenseDocumentMissing ? "missing; exact manifest/declaration plus pinned canonical terms; canonical placeholders are not attribution" : "present and pinned"}\n  Source: ${entry.source}\n  Documents: ${entry.documentSha256s.join(", ")}`,
    ),
    "",
    "SOURCE-BUILT AND FETCHED NATIVE COMPONENTS",
    "",
    ...inventory.nativeComponents.map(
      (entry) =>
        `${entry.identity} [${entry.license}]\n  Source: ${entry.sourceUrl} @ ${entry.sourceCommit}\n  Documents: ${entry.documentSha256s.join(", ")}\n  Evidence: ${entry.evidence.map((item) => `${item.name}=${item.sha256}`).join(", ")}`,
    ),
    "",
    "LICENSE DOCUMENTS",
    "",
    ...inventory.documents.flatMap((document) => [
      `----- ${document.sha256} -----`,
      `Sources: ${document.sources.join(" | ")}`,
      "",
      document.text.replace(/\n$/u, ""),
      "",
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

export async function loadCodexNativeLicenseInventory(): Promise<CodexNativeLicenseInventory> {
  const value = JSON.parse(
    await readFile(join(import.meta.dir, "CODEX-NATIVE-LICENSES.json"), "utf8"),
  ) as unknown;
  return verifyCodexNativeLicenseInventory(value);
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`Codex native payload must be a regular single-link file: ${path}`);
  }
  if (status.size <= 0 || status.size > maximumBytes) {
    throw new Error(`Codex native payload has an invalid size: ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== status.size) throw new Error(`Codex native payload changed while read: ${path}`);
  return bytes;
}

function assertContained(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || resolve(root, child) !== candidate) {
    throw new Error(`Codex native payload escapes its package root: ${candidate}`);
  }
}

export async function verifyInstalledCodexNativePayloads(
  inventory: CodexNativeLicenseInventory,
  platformPackageRoot: string,
): Promise<void> {
  const root = await realpath(platformPackageRoot);
  await verifyCodexNativePayloadsAtPaths(inventory, {
    manifestPath: join(root, "package.json"),
    vendorRoot: join(root, "vendor", inventory.platformPackage.target),
  });
}

export async function verifyCodexNativePayloadsAtPaths(
  inventory: CodexNativeLicenseInventory,
  paths: Readonly<{ manifestPath: string; vendorRoot: string }>,
): Promise<void> {
  const vendorStatus = await lstat(paths.vendorRoot);
  if (!vendorStatus.isDirectory() || vendorStatus.isSymbolicLink() || vendorStatus.nlink < 1) {
    throw new Error(`Codex native vendor root must be a real directory: ${paths.vendorRoot}`);
  }
  const vendorRoot = await realpath(paths.vendorRoot);
  const manifestPath = resolve(paths.manifestPath);
  const canonicalManifestPath = await realpath(manifestPath);
  if (canonicalManifestPath !== manifestPath) {
    throw new Error(`Codex platform manifest path contains a symlink: ${manifestPath}`);
  }
  const manifest = await readRegularFile(manifestPath, 100_000);
  if (sha256(manifest) !== inventory.platformPackage.manifestSha256) {
    throw new Error("Installed Codex platform package manifest hash differs from the inventory.");
  }
  const parsedManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest)) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    parsedManifest.name !== inventory.platformPackage.name ||
    parsedManifest.version !== inventory.platformPackage.version
  ) {
    throw new Error("Installed Codex platform package identity differs from the inventory.");
  }
  for (const payload of inventory.platformPackage.payloads) {
    const payloadPath = join(vendorRoot, payload.path);
    assertContained(vendorRoot, payloadPath);
    const canonicalPayloadPath = await realpath(payloadPath);
    if (canonicalPayloadPath !== payloadPath) {
      throw new Error(`Codex native payload path contains a symlink: ${payloadPath}`);
    }
    const bytes = await readRegularFile(canonicalPayloadPath, 350_000_000);
    if (bytes.byteLength !== payload.size || sha256(bytes) !== payload.sha256) {
      throw new Error(`Installed Codex native payload hash/size differs: ${payload.path}`);
    }
  }
}
