import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { correspondingSourceSpecs } from "./corresponding-sources";
import runtimeVersions from "./runtime-versions.json";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const maximumInventoryBytes = 8_000_000;

type JsonRecord = Record<string, unknown>;

export type BunNativeLicenseDocument = Readonly<{
  name: string;
  sha256: string;
  sources: readonly string[];
  text: string;
}>;

export type BunNativeLicenseComponent = Readonly<{
  documentSha256s: readonly string[];
  identity: string;
  source: string;
}>;

export type BunCargoLicensePackage = Readonly<{
  checksumSha256: string;
  documentSha256s: readonly string[];
  identity: string;
}>;

export type BunNativeLicenseInventory = Readonly<{
  bun: Readonly<{
    completeSourceArchive: string;
    completeSourceArchiveSha256: string;
    sourceCommit: string;
    version: string;
    webkitSourceCommit: string;
  }>;
  cargoPackageCount: number;
  cargoPackages: readonly BunCargoLicensePackage[];
  componentCount: number;
  components: readonly BunNativeLicenseComponent[];
  documents: readonly BunNativeLicenseDocument[];
  schemaVersion: 1;
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

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function expectedComponentIdentities(): readonly string[] {
  const bun = correspondingSourceSpecs.find((spec) => spec.project === "Bun");
  if (bun === undefined) throw new Error("Bun corresponding-source pin is missing.");
  return [
    `Bun@${bun.commit}`,
    ...bun.externalSources.map((source) =>
      source.kind === "archive"
        ? `${source.project}@sha256:${source.sha256}`
        : `${source.project}@${source.commit}`),
  ].sort(compareText);
}

function parseInventory(value: unknown): BunNativeLicenseInventory {
  const root = record(value, "Bun native license inventory");
  if (root["schemaVersion"] !== 1) {
    throw new Error("Bun native license inventory schema is unsupported.");
  }
  const bun = record(root["bun"], "Bun native license metadata");
  const rawComponents = root["components"];
  const rawCargoPackages = root["cargoPackages"];
  const rawDocuments = root["documents"];
  if (
    !Array.isArray(rawComponents)
    || !Array.isArray(rawCargoPackages)
    || !Array.isArray(rawDocuments)
  ) {
    throw new Error("Bun native license inventory arrays are missing.");
  }
  return {
    bun: {
      completeSourceArchive: string(
        bun["completeSourceArchive"],
        "Bun complete source archive",
      ),
      completeSourceArchiveSha256: string(
        bun["completeSourceArchiveSha256"],
        "Bun complete source archive hash",
      ),
      sourceCommit: string(bun["sourceCommit"], "Bun source commit"),
      version: string(bun["version"], "Bun version"),
      webkitSourceCommit: string(bun["webkitSourceCommit"], "Bun WebKit source commit"),
    },
    cargoPackageCount: Number(root["cargoPackageCount"]),
    cargoPackages: rawCargoPackages.map((rawPackage, index) => {
      const packageEntry = record(rawPackage, `Bun Cargo package ${index}`);
      return {
        checksumSha256: string(
          packageEntry["checksumSha256"],
          `Bun Cargo package ${index} checksum`,
        ),
        documentSha256s: strings(
          packageEntry["documentSha256s"],
          `Bun Cargo package ${index} documents`,
        ),
        identity: string(packageEntry["identity"], `Bun Cargo package ${index} identity`),
      };
    }),
    componentCount: Number(root["componentCount"]),
    components: rawComponents.map((rawComponent, index) => {
      const component = record(rawComponent, `Bun native component ${index}`);
      return {
        documentSha256s: strings(
          component["documentSha256s"],
          `Bun native component ${index} documents`,
        ),
        identity: string(component["identity"], `Bun native component ${index} identity`),
        source: string(component["source"], `Bun native component ${index} source`),
      };
    }),
    documents: rawDocuments.map((rawDocument, index) => {
      const document = record(rawDocument, `Bun native document ${index}`);
      return {
        name: string(document["name"], `Bun native document ${index} name`),
        sha256: string(document["sha256"], `Bun native document ${index} hash`),
        sources: strings(document["sources"], `Bun native document ${index} sources`),
        text: string(document["text"], `Bun native document ${index} text`),
      };
    }),
    schemaVersion: 1,
  };
}

export function verifyBunNativeLicenseInventory(
  value: unknown,
): BunNativeLicenseInventory {
  const inventory = parseInventory(value);
  const bunSource = correspondingSourceSpecs.find((spec) => spec.project === "Bun");
  const webkitSource = correspondingSourceSpecs.find((spec) => spec.project === "Bun WebKit");
  if (bunSource === undefined || webkitSource === undefined) {
    throw new Error("Bun corresponding-source pins are incomplete.");
  }
  if (
    inventory.bun.version !== runtimeVersions.bun.version
    || inventory.bun.sourceCommit !== bunSource.commit
    || inventory.bun.webkitSourceCommit !== webkitSource.commit
    || inventory.bun.completeSourceArchive !== bunSource.archiveName
    || inventory.bun.completeSourceArchiveSha256
      !== runtimeVersions.bun.completeSourceArchiveSha256
    || inventory.componentCount !== inventory.components.length
    || inventory.componentCount !== 22
    || inventory.cargoPackageCount !== inventory.cargoPackages.length
    || inventory.cargoPackageCount !== 43
  ) {
    throw new Error("Bun native license inventory metadata differs from its pins.");
  }

  const documents = new Map<string, BunNativeLicenseDocument>();
  const sortedDocuments = [...inventory.documents].sort((left, right) =>
    compareText(left.sha256, right.sha256));
  if (JSON.stringify(inventory.documents) !== JSON.stringify(sortedDocuments)) {
    throw new Error("Bun native license documents are not canonical.");
  }
  for (const document of inventory.documents) {
    if (!sha256Pattern.test(document.sha256) || sha256(document.text) !== document.sha256) {
      throw new Error(`Bun native license document hash differs: ${document.name}`);
    }
    if (document.text.charCodeAt(0) === 0xfeff) {
      throw new Error(`Bun native license document has a UTF-8 BOM: ${document.name}`);
    }
    if (
      document.sources.length === 0
      || new Set(document.sources).size !== document.sources.length
      || JSON.stringify(document.sources) !== JSON.stringify([...document.sources].sort(compareText))
      || documents.has(document.sha256)
    ) {
      throw new Error(`Bun native license document provenance is not canonical: ${document.name}`);
    }
    documents.set(document.sha256, document);
  }

  const expectedComponents = expectedComponentIdentities();
  if (
    JSON.stringify(inventory.components.map((entry) => entry.identity))
      !== JSON.stringify(expectedComponents)
  ) {
    throw new Error("Bun native component set or order differs from its pins.");
  }
  for (const component of inventory.components) {
    if (
      component.documentSha256s.length === 0
      || JSON.stringify(component.documentSha256s)
        !== JSON.stringify([...new Set(component.documentSha256s)].sort(compareText))
      || component.documentSha256s.some((digest) => !documents.has(digest))
    ) {
      throw new Error(`Bun native component license set differs: ${component.identity}`);
    }
  }

  const sortedCargoPackages = [...inventory.cargoPackages].sort((left, right) =>
    compareText(left.identity, right.identity));
  if (JSON.stringify(inventory.cargoPackages) !== JSON.stringify(sortedCargoPackages)) {
    throw new Error("Bun Cargo package license inventory is not canonical.");
  }
  for (const packageEntry of inventory.cargoPackages) {
    if (
      !sha256Pattern.test(packageEntry.checksumSha256)
      || packageEntry.documentSha256s.length === 0
      || JSON.stringify(packageEntry.documentSha256s)
        !== JSON.stringify([...new Set(packageEntry.documentSha256s)].sort(compareText))
      || packageEntry.documentSha256s.some((digest) => !documents.has(digest))
    ) {
      throw new Error(`Bun Cargo package license set differs: ${packageEntry.identity}`);
    }
  }

  const referenced = new Set([
    ...inventory.components.flatMap((entry) => entry.documentSha256s),
    ...inventory.cargoPackages.flatMap((entry) => entry.documentSha256s),
  ]);
  if (referenced.size !== documents.size || [...documents].some(([digest]) => !referenced.has(digest))) {
    throw new Error("Bun native inventory contains an unreferenced license document.");
  }
  return inventory;
}

export function serializeBunNativeLicenseInventory(
  inventory: BunNativeLicenseInventory,
): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export function renderBunNativeLicenseNotices(
  inventory: BunNativeLicenseInventory,
): string {
  const lines = [
    "BUN NATIVE DEPENDENCY LICENSES",
    "",
    `Bun ${inventory.bun.version}`,
    `Source commit: ${inventory.bun.sourceCommit}`,
    `WebKit source commit: ${inventory.bun.webkitSourceCommit}`,
    `Complete source archive: ${inventory.bun.completeSourceArchive}`,
    `Complete source SHA-256: ${inventory.bun.completeSourceArchiveSha256}`,
    `Native source components: ${inventory.componentCount}`,
    `lol-html Cargo packages: ${inventory.cargoPackageCount}`,
    "",
    "COMPONENTS",
    "",
  ];
  for (const component of inventory.components) {
    lines.push(component.identity);
    lines.push(`Source: ${component.source}`);
    lines.push(`License documents: ${component.documentSha256s.join(", ")}`, "");
  }
  lines.push("LOL-HTML CARGO PACKAGES", "");
  for (const packageEntry of inventory.cargoPackages) {
    lines.push(packageEntry.identity);
    lines.push(`Cargo checksum: ${packageEntry.checksumSha256}`);
    lines.push(`License documents: ${packageEntry.documentSha256s.join(", ")}`, "");
  }
  lines.push("LICENSE DOCUMENTS", "");
  for (const document of inventory.documents) {
    lines.push(`${document.name} (${document.sha256})`);
    for (const source of document.sources) lines.push(`Source: ${source}`);
    lines.push("", document.text.trimEnd(), "", "=".repeat(78), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function readRegularText(path: string, maximumBytes: number): Promise<string> {
  const status = await lstat(path);
  if (
    !status.isFile()
    || status.isSymbolicLink()
    || status.nlink !== 1
    || status.size <= 0
    || status.size > maximumBytes
  ) {
    throw new Error(`Bun native license evidence is not a bounded regular file: ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== status.size) {
    throw new Error(`Bun native license evidence changed while it was read: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function loadBunNativeLicenseInventory(options: Readonly<{
  inventoryPath?: string;
  noticesPath?: string;
}> = {}): Promise<BunNativeLicenseInventory> {
  const inventoryPath = options.inventoryPath
    ?? join(import.meta.dir, "BUN-DEPENDENCY-LICENSES.json");
  const noticesPath = options.noticesPath
    ?? join(import.meta.dir, "BUN-DEPENDENCY-LICENSES.txt");
  const inventoryText = await readRegularText(inventoryPath, maximumInventoryBytes);
  if (inventoryText.charCodeAt(0) === 0xfeff) {
    throw new Error("Bun native license inventory has a UTF-8 BOM.");
  }
  const inventory = verifyBunNativeLicenseInventory(JSON.parse(inventoryText) as unknown);
  if (inventoryText !== serializeBunNativeLicenseInventory(inventory)) {
    throw new Error("Bun native license inventory is not canonical.");
  }
  const noticesText = await readRegularText(noticesPath, maximumInventoryBytes);
  if (noticesText !== renderBunNativeLicenseNotices(inventory)) {
    throw new Error("Bun native license notices differ from their inventory.");
  }
  return inventory;
}
