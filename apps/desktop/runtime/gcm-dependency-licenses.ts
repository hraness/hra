import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import rawPins from "./gcm-dependency-license-pins.json";

const maximumEvidenceBytes = 2_000_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;

type PinDocument = Readonly<{
  entry?: string;
  name: string;
  sha256: string;
  sourceSha256?: string;
  url?: string;
}>;

export type GcmDependencyPackagePin = Readonly<{
  archiveSha256: string;
  depsSha512: string;
  documents: readonly PinDocument[];
  identity: string;
  nugetUrl: string;
  nuspecEntry: string;
  nuspecSha256: string;
  provenanceNote?: string;
}>;

type GcmDependencyPins = Readonly<{
  dotnetRuntime: Readonly<{
    documents: readonly Readonly<{
      name: string;
      sha256: string;
      url: string;
    }>[];
    identity: string;
    repository: string;
    sourceCommit: string;
  }>;
  gcm: Readonly<{
    depsJsonSha256: string;
    ownedContributors: readonly string[];
    runtimeConfigSha256: string;
    runtimeTarget: string;
    sourceCommit: string;
    version: string;
  }>;
  packages: readonly GcmDependencyPackagePin[];
  schemaVersion: 1;
}>;

export type GcmRuntimeAsset = Readonly<{
  installedPath: string;
  kind: "native" | "runtime";
  packagePath: string;
  sha256: string;
}>;

export type GcmDependencyLicenseDocument = Readonly<{
  name: string;
  sha256: string;
  sources: readonly string[];
  text: string;
}>;

export type GcmDependencyLicensePackage = Readonly<{
  archiveSha256?: string;
  depsSha512?: string;
  documentSha256s: readonly string[];
  identity: string;
  license: string;
  nugetUrl?: string;
  nuspecSha256?: string;
  provenanceNote?: string;
  repository?: string;
  runtimeAssets: readonly GcmRuntimeAsset[];
  sourceCommit?: string;
}>;

export type GcmDependencyLicenseInventory = Readonly<{
  documents: readonly GcmDependencyLicenseDocument[];
  gcm: Readonly<{
    depsJsonSha256: string;
    externalPackageCount: number;
    runtimeConfigSha256: string;
    runtimeTarget: string;
    sourceCommit: string;
    version: string;
  }>;
  packageCount: number;
  packages: readonly GcmDependencyLicensePackage[];
  schemaVersion: 1;
}>;

type GcmDependencyEvidence = Readonly<{
  assets: ReadonlyMap<string, readonly GcmRuntimeAsset[]>;
  depsJsonSha256: string;
  runtimeConfigSha256: string;
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularFile(path: string, maximumBytes = maximumEvidenceBytes): Promise<Uint8Array> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`GCM evidence must be a regular single-link file: ${path}`);
  }
  if (status.size <= 0 || status.size > maximumBytes) {
    throw new Error(`GCM evidence file has an invalid size: ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== status.size) {
    throw new Error(`GCM evidence changed while it was read: ${path}`);
  }
  return bytes;
}

function parsePins(value: unknown): GcmDependencyPins {
  const root = record(value, "GCM dependency pins");
  if (root["schemaVersion"] !== 1) throw new Error("GCM dependency pin schema is unsupported.");
  const gcm = record(root["gcm"], "GCM dependency pins gcm");
  const dotnet = record(root["dotnetRuntime"], "GCM dependency pins dotnetRuntime");
  const packages = root["packages"];
  if (!Array.isArray(packages) || packages.length !== 21) {
    throw new Error("GCM dependency pins must contain the exact 21 external NuGet packages.");
  }
  const parsedPackages = packages.map((rawPackage, index) => {
    const packagePin = record(rawPackage, `GCM package pin ${index}`);
    const documents = packagePin["documents"];
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new Error(`GCM package pin ${index} has no license document.`);
    }
    return {
      archiveSha256: string(packagePin["archiveSha256"], `GCM package ${index} archiveSha256`),
      depsSha512: string(packagePin["depsSha512"], `GCM package ${index} depsSha512`),
      documents: documents.map((rawDocument, documentIndex) => {
        const document = record(rawDocument, `GCM package ${index} document ${documentIndex}`);
        const entry = document["entry"];
        const url = document["url"];
        if ((typeof entry === "string") === (typeof url === "string")) {
          throw new Error(`GCM package ${index} document ${documentIndex} needs exactly one source.`);
        }
        return {
          ...(typeof entry === "string" ? { entry } : {}),
          name: string(document["name"], `GCM package ${index} document ${documentIndex} name`),
          sha256: string(document["sha256"], `GCM package ${index} document ${documentIndex} sha256`),
          ...(typeof document["sourceSha256"] === "string"
            ? { sourceSha256: document["sourceSha256"] }
            : {}),
          ...(typeof url === "string" ? { url } : {}),
        };
      }),
      identity: string(packagePin["identity"], `GCM package ${index} identity`),
      nugetUrl: string(packagePin["nugetUrl"], `GCM package ${index} nugetUrl`),
      nuspecEntry: string(packagePin["nuspecEntry"], `GCM package ${index} nuspecEntry`),
      nuspecSha256: string(packagePin["nuspecSha256"], `GCM package ${index} nuspecSha256`),
      ...(typeof packagePin["provenanceNote"] === "string"
        ? { provenanceNote: packagePin["provenanceNote"] }
        : {}),
    } satisfies GcmDependencyPackagePin;
  }).sort((left, right) => compareText(left.identity, right.identity));
  if (new Set(parsedPackages.map((entry) => entry.identity)).size !== parsedPackages.length) {
    throw new Error("GCM dependency package pins contain a duplicate identity.");
  }
  for (const packagePin of parsedPackages) {
    if (!sha256Pattern.test(packagePin.archiveSha256) || !sha256Pattern.test(packagePin.nuspecSha256)) {
      throw new Error(`GCM dependency package pin has an invalid digest: ${packagePin.identity}`);
    }
    if (!packagePin.depsSha512.startsWith("sha512-")) {
      throw new Error(`GCM dependency package pin has an invalid deps hash: ${packagePin.identity}`);
    }
  }
  const rawDotnetDocuments = dotnet["documents"];
  if (!Array.isArray(rawDotnetDocuments) || rawDotnetDocuments.length !== 2) {
    throw new Error(".NET runtime pins must contain LICENSE and THIRD-PARTY-NOTICES.");
  }
  return {
    dotnetRuntime: {
      documents: rawDotnetDocuments.map((rawDocument, index) => {
        const document = record(rawDocument, `.NET runtime document ${index}`);
        return {
          name: string(document["name"], `.NET runtime document ${index} name`),
          sha256: string(document["sha256"], `.NET runtime document ${index} sha256`),
          url: string(document["url"], `.NET runtime document ${index} URL`),
        };
      }),
      identity: string(dotnet["identity"], ".NET runtime identity"),
      repository: string(dotnet["repository"], ".NET runtime repository"),
      sourceCommit: string(dotnet["sourceCommit"], ".NET runtime source commit"),
    },
    gcm: {
      depsJsonSha256: string(gcm["depsJsonSha256"], "GCM deps JSON digest"),
      ownedContributors: [...strings(gcm["ownedContributors"], "GCM owned contributors")].sort(compareText),
      runtimeConfigSha256: string(gcm["runtimeConfigSha256"], "GCM runtime config digest"),
      runtimeTarget: string(gcm["runtimeTarget"], "GCM runtime target"),
      sourceCommit: string(gcm["sourceCommit"], "GCM source commit"),
      version: string(gcm["version"], "GCM version"),
    },
    packages: parsedPackages,
    schemaVersion: 1,
  };
}

export const gcmDependencyLicensePins = Object.freeze(parsePins(rawPins));

function assetEntries(rawPackage: JsonRecord): readonly Readonly<{
  kind: "native" | "runtime";
  packagePath: string;
}>[] {
  const entries: Array<Readonly<{ kind: "native" | "runtime"; packagePath: string }>> = [];
  for (const kind of ["native", "runtime"] as const) {
    const rawAssets = rawPackage[kind];
    if (rawAssets === undefined) continue;
    for (const packagePath of Object.keys(record(rawAssets, `GCM ${kind} assets`)).sort(compareText)) {
      entries.push({ kind, packagePath });
    }
  }
  return entries.sort((left, right) =>
    compareText(`${left.kind}:${left.packagePath}`, `${right.kind}:${right.packagePath}`));
}

export async function collectGcmDependencyEvidence(gcmRoot: string): Promise<GcmDependencyEvidence> {
  const depsPath = join(gcmRoot, "git-credential-manager.deps.json");
  const runtimeConfigPath = join(gcmRoot, "git-credential-manager.runtimeconfig.json");
  const [depsBytes, runtimeConfigBytes] = await Promise.all([
    readRegularFile(depsPath),
    readRegularFile(runtimeConfigPath),
  ]);
  const depsJsonSha256 = sha256(depsBytes);
  const runtimeConfigSha256 = sha256(runtimeConfigBytes);
  if (depsJsonSha256 !== gcmDependencyLicensePins.gcm.depsJsonSha256) {
    throw new Error(`GCM deps JSON hash differs: ${depsJsonSha256}`);
  }
  if (runtimeConfigSha256 !== gcmDependencyLicensePins.gcm.runtimeConfigSha256) {
    throw new Error(`GCM runtime config hash differs: ${runtimeConfigSha256}`);
  }
  const deps = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(depsBytes)), "GCM deps JSON");
  const runtimeTarget = string(record(deps["runtimeTarget"], "GCM runtime target")["name"], "GCM runtime target name");
  if (runtimeTarget !== gcmDependencyLicensePins.gcm.runtimeTarget) {
    throw new Error(`GCM runtime target differs: ${runtimeTarget}`);
  }
  const target = record(record(deps["targets"], "GCM targets")[runtimeTarget], "GCM target closure");
  const libraries = record(deps["libraries"], "GCM libraries");
  const contributing = Object.entries(target)
    .flatMap(([identity, rawPackage]) => {
      const assets = assetEntries(record(rawPackage, `GCM target package ${identity}`));
      return assets.length === 0 ? [] : [{ assets, identity }];
    })
    .sort((left, right) => compareText(left.identity, right.identity));
  const expected = [
    ...gcmDependencyLicensePins.gcm.ownedContributors,
    gcmDependencyLicensePins.dotnetRuntime.identity,
    ...gcmDependencyLicensePins.packages.map((entry) => entry.identity),
  ].sort(compareText);
  if (JSON.stringify(contributing.map((entry) => entry.identity)) !== JSON.stringify(expected)) {
    throw new Error("GCM contributing runtime package set differs from its exact 29-package pin.");
  }
  const assets = new Map<string, readonly GcmRuntimeAsset[]>();
  for (const contributor of contributing) {
    const resolvedAssets: GcmRuntimeAsset[] = [];
    for (const asset of contributor.assets) {
      const installedPath = basename(asset.packagePath);
      const bytes = await readRegularFile(join(gcmRoot, installedPath), 200_000_000);
      resolvedAssets.push({
        installedPath,
        kind: asset.kind,
        packagePath: asset.packagePath,
        sha256: sha256(bytes),
      });
    }
    assets.set(contributor.identity, resolvedAssets);
  }
  for (const packagePin of gcmDependencyLicensePins.packages) {
    const library = record(libraries[packagePin.identity], `GCM library ${packagePin.identity}`);
    if (library["type"] !== "package" || library["sha512"] !== packagePin.depsSha512) {
      throw new Error(`GCM deps package provenance differs: ${packagePin.identity}`);
    }
  }
  const dotnetLibrary = record(
    libraries[gcmDependencyLicensePins.dotnetRuntime.identity],
    "GCM .NET runtime library",
  );
  if (dotnetLibrary["type"] !== "runtimepack" || dotnetLibrary["sha512"] !== "") {
    throw new Error("GCM .NET runtime-pack metadata differs from its pin.");
  }
  return { assets, depsJsonSha256, runtimeConfigSha256 };
}

function parseInventory(value: unknown): GcmDependencyLicenseInventory {
  const root = record(value, "GCM dependency license inventory");
  if (root["schemaVersion"] !== 1) throw new Error("GCM dependency license inventory schema is unsupported.");
  const rawDocuments = root["documents"];
  const rawPackages = root["packages"];
  if (!Array.isArray(rawDocuments) || !Array.isArray(rawPackages)) {
    throw new Error("GCM dependency license inventory arrays are missing.");
  }
  const gcm = record(root["gcm"], "GCM dependency inventory metadata");
  const documents = rawDocuments.map((rawDocument, index) => {
    const document = record(rawDocument, `GCM dependency document ${index}`);
    return {
      name: string(document["name"], `GCM dependency document ${index} name`),
      sha256: string(document["sha256"], `GCM dependency document ${index} hash`),
      sources: strings(document["sources"], `GCM dependency document ${index} sources`),
      text: string(document["text"], `GCM dependency document ${index} text`),
    };
  });
  const packages = rawPackages.map((rawPackage, index) => {
    const packageEntry = record(rawPackage, `GCM dependency package ${index}`);
    const rawAssets = packageEntry["runtimeAssets"];
    if (!Array.isArray(rawAssets)) throw new Error(`GCM dependency package ${index} assets are missing.`);
    return {
      ...(typeof packageEntry["archiveSha256"] === "string" ? { archiveSha256: packageEntry["archiveSha256"] } : {}),
      ...(typeof packageEntry["depsSha512"] === "string" ? { depsSha512: packageEntry["depsSha512"] } : {}),
      documentSha256s: strings(packageEntry["documentSha256s"], `GCM dependency package ${index} document hashes`),
      identity: string(packageEntry["identity"], `GCM dependency package ${index} identity`),
      license: string(packageEntry["license"], `GCM dependency package ${index} license`),
      ...(typeof packageEntry["nugetUrl"] === "string" ? { nugetUrl: packageEntry["nugetUrl"] } : {}),
      ...(typeof packageEntry["nuspecSha256"] === "string" ? { nuspecSha256: packageEntry["nuspecSha256"] } : {}),
      ...(typeof packageEntry["provenanceNote"] === "string" ? { provenanceNote: packageEntry["provenanceNote"] } : {}),
      ...(typeof packageEntry["repository"] === "string" ? { repository: packageEntry["repository"] } : {}),
      runtimeAssets: rawAssets.map((rawAsset, assetIndex) => {
        const asset = record(rawAsset, `GCM dependency package ${index} asset ${assetIndex}`);
        const kind = asset["kind"];
        if (kind !== "native" && kind !== "runtime") {
          throw new Error(`GCM dependency package ${index} asset ${assetIndex} kind is invalid.`);
        }
        return {
          installedPath: string(asset["installedPath"], `GCM asset ${index}:${assetIndex} installed path`),
          kind,
          packagePath: string(asset["packagePath"], `GCM asset ${index}:${assetIndex} package path`),
          sha256: string(asset["sha256"], `GCM asset ${index}:${assetIndex} hash`),
        };
      }),
      ...(typeof packageEntry["sourceCommit"] === "string" ? { sourceCommit: packageEntry["sourceCommit"] } : {}),
    } satisfies GcmDependencyLicensePackage;
  });
  return {
    documents,
    gcm: {
      depsJsonSha256: string(gcm["depsJsonSha256"], "GCM inventory deps hash"),
      externalPackageCount: Number(gcm["externalPackageCount"]),
      runtimeConfigSha256: string(gcm["runtimeConfigSha256"], "GCM inventory runtime config hash"),
      runtimeTarget: string(gcm["runtimeTarget"], "GCM inventory runtime target"),
      sourceCommit: string(gcm["sourceCommit"], "GCM inventory source commit"),
      version: string(gcm["version"], "GCM inventory version"),
    },
    packageCount: Number(root["packageCount"]),
    packages,
    schemaVersion: 1,
  };
}

function expectedDocumentSource(packagePin: GcmDependencyPackagePin, document: PinDocument): string {
  return document.url ?? `nuget:${packagePin.nugetUrl}#${document.entry!}`;
}

export function verifyGcmDependencyLicenseInventory(
  value: unknown,
  evidence: GcmDependencyEvidence,
): GcmDependencyLicenseInventory {
  const inventory = parseInventory(value);
  if (
    inventory.gcm.version !== gcmDependencyLicensePins.gcm.version
    || inventory.gcm.sourceCommit !== gcmDependencyLicensePins.gcm.sourceCommit
    || inventory.gcm.runtimeTarget !== gcmDependencyLicensePins.gcm.runtimeTarget
    || inventory.gcm.depsJsonSha256 !== evidence.depsJsonSha256
    || inventory.gcm.runtimeConfigSha256 !== evidence.runtimeConfigSha256
    || inventory.gcm.externalPackageCount !== 22
    || inventory.packageCount !== 22
  ) {
    throw new Error("GCM dependency license inventory metadata differs from its pins.");
  }
  const sortedDocuments = [...inventory.documents].sort((left, right) => compareText(left.sha256, right.sha256));
  if (JSON.stringify(inventory.documents) !== JSON.stringify(sortedDocuments)) {
    throw new Error("GCM dependency license documents are not canonical.");
  }
  const documents = new Map<string, GcmDependencyLicenseDocument>();
  for (const document of inventory.documents) {
    if (!sha256Pattern.test(document.sha256) || sha256(document.text) !== document.sha256) {
      throw new Error(`GCM dependency license document hash differs: ${document.name}`);
    }
    if (document.text.charCodeAt(0) === 0xfeff) {
      throw new Error(`GCM dependency license document has a UTF-8 BOM: ${document.name}`);
    }
    if (
      document.sources.length === 0
      || new Set(document.sources).size !== document.sources.length
      || JSON.stringify(document.sources) !== JSON.stringify([...document.sources].sort(compareText))
    ) {
      throw new Error(`GCM dependency license document sources are not canonical: ${document.name}`);
    }
    if (documents.has(document.sha256)) {
      throw new Error(`GCM dependency license document hash is duplicated: ${document.sha256}`);
    }
    documents.set(document.sha256, document);
  }
  const expectedPackageIdentities = [
    gcmDependencyLicensePins.dotnetRuntime.identity,
    ...gcmDependencyLicensePins.packages.map((entry) => entry.identity),
  ].sort(compareText);
  if (JSON.stringify(inventory.packages.map((entry) => entry.identity)) !== JSON.stringify(expectedPackageIdentities)) {
    throw new Error("GCM dependency license package set or order differs from its pins.");
  }
  const pins = new Map(gcmDependencyLicensePins.packages.map((entry) => [entry.identity, entry]));
  for (const packageEntry of inventory.packages) {
    const expectedAssets = evidence.assets.get(packageEntry.identity);
    if (expectedAssets === undefined || JSON.stringify(packageEntry.runtimeAssets) !== JSON.stringify(expectedAssets)) {
      throw new Error(`GCM dependency runtime assets differ: ${packageEntry.identity}`);
    }
    if (packageEntry.license !== "MIT") {
      throw new Error(`GCM dependency has an unexpected license expression: ${packageEntry.identity}`);
    }
    const packagePin = pins.get(packageEntry.identity);
    if (packagePin === undefined) {
      const dotnet = gcmDependencyLicensePins.dotnetRuntime;
      if (
        packageEntry.repository !== dotnet.repository
        || packageEntry.sourceCommit !== dotnet.sourceCommit
        || packageEntry.archiveSha256 !== undefined
        || packageEntry.depsSha512 !== undefined
        || packageEntry.nugetUrl !== undefined
        || packageEntry.nuspecSha256 !== undefined
      ) {
        throw new Error(".NET runtime license provenance differs from its pins.");
      }
      const expectedHashes = dotnet.documents.map((entry) => entry.sha256).sort(compareText);
      if (JSON.stringify(packageEntry.documentSha256s) !== JSON.stringify(expectedHashes)) {
        throw new Error(".NET runtime license document set differs from its pins.");
      }
      for (const documentPin of dotnet.documents) {
        const document = documents.get(documentPin.sha256);
        if (document?.name !== documentPin.name || !document.sources.includes(documentPin.url)) {
          throw new Error(`.NET runtime license document provenance differs: ${documentPin.name}`);
        }
      }
      continue;
    }
    if (
      packageEntry.archiveSha256 !== packagePin.archiveSha256
      || packageEntry.depsSha512 !== packagePin.depsSha512
      || packageEntry.nugetUrl !== packagePin.nugetUrl
      || packageEntry.nuspecSha256 !== packagePin.nuspecSha256
      || packageEntry.provenanceNote !== packagePin.provenanceNote
      || packageEntry.repository !== undefined
      || packageEntry.sourceCommit !== undefined
    ) {
      throw new Error(`GCM NuGet package provenance differs: ${packageEntry.identity}`);
    }
    const expectedHashes = [...new Set(packagePin.documents.map((entry) => entry.sha256))].sort(compareText);
    if (JSON.stringify(packageEntry.documentSha256s) !== JSON.stringify(expectedHashes)) {
      throw new Error(`GCM dependency license document set differs: ${packageEntry.identity}`);
    }
    for (const documentPin of packagePin.documents) {
      const document = documents.get(documentPin.sha256);
      if (
        document?.name !== documentPin.name
        || !document.sources.includes(expectedDocumentSource(packagePin, documentPin))
      ) {
        throw new Error(`GCM dependency license provenance differs: ${packageEntry.identity}`);
      }
    }
  }
  const referenced = new Set(inventory.packages.flatMap((entry) => entry.documentSha256s));
  if (referenced.size !== documents.size || [...documents].some(([digest]) => !referenced.has(digest))) {
    throw new Error("GCM dependency inventory contains an unreferenced license document.");
  }
  return inventory;
}

export function serializeGcmDependencyLicenseInventory(
  inventory: GcmDependencyLicenseInventory,
): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export function renderGcmDependencyLicenseNotices(
  inventory: GcmDependencyLicenseInventory,
): string {
  const lines = [
    "GCM BUNDLED DEPENDENCY LICENSES",
    "",
    `Git Credential Manager ${inventory.gcm.version}`,
    `Source commit: ${inventory.gcm.sourceCommit}`,
    `Runtime target: ${inventory.gcm.runtimeTarget}`,
    `External runtime packages: ${inventory.packageCount}`,
    "",
    "PACKAGES",
    "",
  ];
  for (const packageEntry of inventory.packages) {
    lines.push(packageEntry.identity);
    lines.push(`License: ${packageEntry.license}`);
    if (packageEntry.nugetUrl !== undefined) lines.push(`NuGet: ${packageEntry.nugetUrl}`);
    if (packageEntry.repository !== undefined) lines.push(`Repository: ${packageEntry.repository}`);
    if (packageEntry.sourceCommit !== undefined) lines.push(`Source commit: ${packageEntry.sourceCommit}`);
    if (packageEntry.provenanceNote !== undefined) lines.push(`Provenance note: ${packageEntry.provenanceNote}`);
    lines.push(`Installed runtime assets: ${packageEntry.runtimeAssets.length}`);
    lines.push(`License documents: ${packageEntry.documentSha256s.join(", ")}`);
    lines.push("");
  }
  lines.push("LICENSE DOCUMENTS", "");
  for (const document of inventory.documents) {
    lines.push(`${document.name} (${document.sha256})`);
    for (const source of document.sources) lines.push(`Source: ${source}`);
    lines.push("");
    lines.push(document.text.trimEnd());
    lines.push("", "=".repeat(78), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function loadGcmDependencyLicenseInventory(options: Readonly<{
  gcmRoot: string;
  inventoryPath?: string;
  noticesPath?: string;
}>): Promise<GcmDependencyLicenseInventory> {
  const inventoryPath = options.inventoryPath ?? join(import.meta.dir, "GCM-DEPENDENCY-LICENSES.json");
  const noticesPath = options.noticesPath ?? join(import.meta.dir, "GCM-DEPENDENCY-LICENSES.txt");
  const evidence = await collectGcmDependencyEvidence(options.gcmRoot);
  const inventoryText = new TextDecoder("utf-8", { fatal: true }).decode(
    await readRegularFile(inventoryPath, 4_000_000),
  );
  if (inventoryText.charCodeAt(0) === 0xfeff) {
    throw new Error("GCM dependency license inventory has a UTF-8 BOM.");
  }
  const inventory = verifyGcmDependencyLicenseInventory(JSON.parse(inventoryText) as unknown, evidence);
  if (serializeGcmDependencyLicenseInventory(inventory) !== inventoryText) {
    throw new Error("GCM dependency license inventory is not canonical.");
  }
  const notices = new TextDecoder("utf-8", { fatal: true }).decode(
    await readRegularFile(noticesPath, 4_000_000),
  );
  if (notices !== renderGcmDependencyLicenseNotices(inventory)) {
    throw new Error("GCM dependency license notices differ from their inventory.");
  }
  return inventory;
}
