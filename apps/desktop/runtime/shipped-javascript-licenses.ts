import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseConfigFileTextToJson } from "typescript";

const desktopRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopRoot, "../..");

const maximumDocumentBytes = 1_048_576;
const maximumPackageJsonBytes = 1_048_576;
const licenseFileName = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/iu;
const thirdPartyFileName = /^third[._-]?party[._-]?(?:licen[cs]es?|notices?)(?:$|[._-])/iu;
const maximumPackageTreeEntries = 100_000;
const maximumPackageTreeDepth = 32;

type LockPin = Readonly<{
  lockIntegrity: string;
  lockKey: string;
}>;

const licenseMetadataOverrides: ReadonlyMap<string, Readonly<{
  documentPath: string;
  documentSha256: string;
  license: string;
  packageJsonSha256: string;
} & LockPin>> = new Map([
  [
    "khroma@2.1.0",
    {
      documentPath: "license",
      documentSha256: "66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49",
      license: "MIT",
      lockIntegrity: "sha512-Ls993zuzfayK269Svk9hzpeGUKob/sIgZzyHYdjQoAdQetRKpOLj+k/QQQ/6Qi0Yz65mlROrfd+Ev+1+7dz9Kw==",
      lockKey: "khroma",
      packageJsonSha256: "0d2145738d3cab828da4c5724b45e0dd2577c0ce84503c956d76897e93fa7de2",
    },
  ],
]);

const reviewedLicenseDocumentOverrides: ReadonlyMap<string, Readonly<{
  documents: readonly (readonly [fileName: string, sha256: string])[];
  packageJsonSha256: string;
} & LockPin>> = new Map([
  [
    "@openai/codex@0.144.6",
    {
      documents: [
        ["CODEX-LICENSE.txt", "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc"],
        ["CODEX-NOTICE.txt", "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915"],
      ],
      lockIntegrity: "sha512-wk+2CWiBNXiJLBoN2D08N9RceWkSBnlgk5g2K1a4CXrP/C0gdlHyRUG7RFzm9y41DCK/7tvCct233JVxyFmznw==",
      lockKey: "@openai/codex",
      packageJsonSha256: "b701b7d7b7683263e5612e612c468c526d78c3deb1360741e976dc40e0456919",
    },
  ],
  [
    "@openai/codex@0.144.6-darwin-arm64",
    {
      documents: [
        ["CODEX-LICENSE.txt", "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc"],
        ["CODEX-NOTICE.txt", "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915"],
      ],
      lockIntegrity: "sha512-6zgvh70MzBNSeT17HEhSOrmmGGZGAKzSC7x6JAq+edkJkdPYA9P0I1tG7aJ49GlBkBxuC+MKBH1qm6+2Cghcww==",
      lockKey: "@openai/codex-darwin-arm64",
      packageJsonSha256: "051cbc20f48e7bd20b89e301ffc8f60af890a1da3815e5e700f11ada41c3b445",
    },
  ],
  [
    "client-only@0.0.1",
    {
      documents: [
        ["SPDX-MIT-LICENSE.txt", "b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5"],
      ],
      lockIntegrity: "sha512-IV3Ou0jSMzZrd3pZ48nLkT9DA7Ag1pnPzaiQhpW7c3RbcqqzvzzVu+L8gfqMp/8IM2MQtSiqaCxrrcfu8I8rMA==",
      lockKey: "client-only",
      packageJsonSha256: "4d6342705767832f299b9a59c28e4275bcf02db19472732f93f67d979441df8f",
    },
  ],
] as const);

export const shippedJavaScriptSentinels = Object.freeze([
  "marked",
  "react",
  "react-aria",
  "react-aria-components",
  "react-dom",
  "streamdown",
  "zod",
] as const);

export type ShippedJavaScriptLicenseDocument = Readonly<{
  path: string;
  sha256: string;
  text: string;
}>;

export type ShippedJavaScriptPackage = Readonly<{
  license: string;
  licenseDocuments: readonly ShippedJavaScriptLicenseDocument[];
  name: string;
  packageJsonSha256: string;
  version: string;
}>;

export type ShippedJavaScriptLicenseInventory = Readonly<{
  coverage: "installed-production-dependency-closure";
  dependencySections: readonly [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  entrypoints: readonly ["frontend/src/main.tsx", "runtime/src/main.ts"];
  packageCount: number;
  packages: readonly ShippedJavaScriptPackage[];
  rootDependencies: readonly string[];
  rootPackage: Readonly<{ name: string; version: string }>;
  schemaVersion: 1;
}>;

type JsonRecord = Record<string, unknown>;

type PackageMetadata = Readonly<{
  dependencies: ReadonlyMap<string, "optional" | "required">;
  license: string | null;
  name: string;
  packageJsonBytes: Uint8Array;
  packageJsonPath: string;
  packageRoot: string;
  version: string;
}>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    !fromRoot.startsWith(`..${sep}`)
    && fromRoot !== ".."
    && !fromRoot.startsWith(sep)
  );
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function nonblankString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonblank string.`);
  }
  return value;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let lockPackagesPromise: Promise<JsonRecord> | undefined;

async function lockPackages(): Promise<JsonRecord> {
  lockPackagesPromise ??= (async () => {
    const lockPath = join(repositoryRoot, "bun.lock");
    const parsed = parseConfigFileTextToJson(lockPath, await readFile(lockPath, "utf8"));
    if (parsed.error !== undefined) {
      throw new Error("Bun lockfile is not valid JSONC.");
    }
    return record(record(parsed.config, "Bun lockfile")["packages"], "Bun lockfile packages");
  })();
  return lockPackagesPromise;
}

async function verifyLockPin(identity: string, pin: LockPin): Promise<void> {
  const entry = (await lockPackages())[pin.lockKey];
  if (
    !Array.isArray(entry)
    || entry[0] !== identity
    || entry[3] !== pin.lockIntegrity
  ) {
    throw new Error(`Reviewed license override lock pin differs: ${identity}`);
  }
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`License inventory requires a real single-link file: ${path}`);
  }
  if (before.size > maximumBytes) {
    throw new Error(`License inventory file exceeds its byte limit: ${path}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || bytes.byteLength !== before.size
  ) {
    throw new Error(`License inventory file changed while it was read: ${path}`);
  }
  return bytes;
}

function parseDependencyMap(
  rawPackage: JsonRecord,
  packageJsonPath: string,
): ReadonlyMap<string, "optional" | "required"> {
  const dependencies = new Map<string, "optional" | "required">();
  const peerMetadata = rawPackage["peerDependenciesMeta"] === undefined
    ? {}
    : record(rawPackage["peerDependenciesMeta"], `${packageJsonPath} peerDependenciesMeta`);
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const rawSection = rawPackage[section];
    if (rawSection === undefined) continue;
    const sectionRecord = record(rawSection, `${packageJsonPath} ${section}`);
    for (const name of Object.keys(sectionRecord).sort(compareText)) {
      nonblankString(sectionRecord[name], `${packageJsonPath} ${section}.${name}`);
      const peerOptional = section === "peerDependencies"
        && peerMetadata[name] !== undefined
        && record(
          peerMetadata[name],
          `${packageJsonPath} peerDependenciesMeta.${name}`,
        )["optional"] === true;
      const kind = section === "optionalDependencies" || peerOptional
        ? "optional"
        : "required";
      if (kind === "required" || !dependencies.has(name)) {
        dependencies.set(name, kind);
      }
    }
  }
  return new Map([...dependencies].sort(([left], [right]) => compareText(left, right)));
}

async function readPackageMetadata(packageJsonPath: string): Promise<PackageMetadata> {
  const canonicalPath = await realpath(packageJsonPath);
  if (!inside(repositoryRoot, canonicalPath)) {
    throw new Error(`Dependency package escaped the repository: ${canonicalPath}`);
  }
  const packageJsonBytes = await readBoundedRegularFile(
    canonicalPath,
    maximumPackageJsonBytes,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageJsonBytes));
  } catch (error) {
    throw new Error(`Invalid dependency package metadata: ${canonicalPath}`, { cause: error });
  }
  const rawPackage = record(parsed, canonicalPath);
  const rawLicense = rawPackage["license"];
  const name = nonblankString(rawPackage["name"], `${canonicalPath} name`);
  const version = nonblankString(rawPackage["version"], `${canonicalPath} version`);
  const override = licenseMetadataOverrides.get(`${name}@${version}`);
  return {
    dependencies: parseDependencyMap(rawPackage, canonicalPath),
    license: rawLicense === undefined
      ? override?.license ?? null
      : nonblankString(rawLicense, `${canonicalPath} license`),
    name,
    packageJsonBytes,
    packageJsonPath: canonicalPath,
    packageRoot: dirname(canonicalPath),
    version,
  };
}

async function resolveDependencyPackageJson(
  fromPackageRoot: string,
  dependencyName: string,
): Promise<string | null> {
  const nameParts = dependencyName.split("/");
  if (
    nameParts.some((part) => part.length === 0 || part === "." || part === "..")
    || (dependencyName.startsWith("@") && nameParts.length !== 2)
    || (!dependencyName.startsWith("@") && nameParts.length !== 1)
  ) {
    throw new Error(`Invalid dependency package name: ${dependencyName}`);
  }
  let cursor = fromPackageRoot;
  while (inside(repositoryRoot, cursor)) {
    const candidate = join(cursor, "node_modules", ...nameParts, "package.json");
    try {
      const canonical = await realpath(candidate);
      if (!inside(repositoryRoot, canonical)) {
        throw new Error(`Dependency package escaped the repository: ${dependencyName}`);
      }
      return canonical;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (cursor === repositoryRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function isExternalPackage(packageJsonPath: string): boolean {
  return packageJsonPath.split(sep).includes("node_modules");
}

async function readLicenseDocument(
  packageRoot: string,
  path: string,
): Promise<ShippedJavaScriptLicenseDocument> {
  const bytes = await readBoundedRegularFile(path, maximumDocumentBytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM is forbidden in a license document: ${path}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`License document is not UTF-8: ${path}`, { cause: error });
  }
  return {
    path: relative(packageRoot, path).split(sep).join("/"),
    sha256: sha256(bytes),
    text,
  };
}

async function collectLicenseDocuments(
  packageRoot: string,
): Promise<readonly ShippedJavaScriptLicenseDocument[]> {
  const documents: ShippedJavaScriptLicenseDocument[] = [];
  let entryCount = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maximumPackageTreeDepth) {
      throw new Error(`Dependency package tree exceeds its depth limit: ${packageRoot}`);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > maximumPackageTreeEntries) {
        throw new Error(`Dependency package tree exceeds its entry limit: ${packageRoot}`);
      }
      const path = join(directory, entry.name);
      const isLicenseDocument = licenseFileName.test(entry.name)
        || thirdPartyFileName.test(entry.name);
      if (entry.isSymbolicLink()) {
        if (isLicenseDocument) {
          throw new Error(`Symlinked license inventory entry is forbidden: ${path}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await visit(path, depth + 1);
        continue;
      }
      if (!isLicenseDocument) continue;
      if (!entry.isFile()) {
        throw new Error(`Special license inventory entry is forbidden: ${path}`);
      }
      documents.push(await readLicenseDocument(packageRoot, path));
    }
  }
  await visit(packageRoot, 0);
  return documents.sort((left, right) => compareText(left.path, right.path));
}

function packageIdentity(value: Readonly<{ name: string; version: string }>): string {
  return `${value.name}@${value.version}`;
}

export function serializeShippedJavaScriptLicenseInventory(
  inventory: ShippedJavaScriptLicenseInventory,
): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export function renderShippedJavaScriptLicenseNotices(
  inventory: ShippedJavaScriptLicenseInventory,
): string {
  const lines = [
    "HRA shipped JavaScript licenses and notices",
    "===========================================",
    "",
    "This fail-closed inventory covers the complete installed production dependency",
    "closure used to compile the frontend and Bun gateway. Development-only packages",
    "are excluded. Each package.json and included license/notice document is SHA-256",
    "bound in the adjacent SHIPPED-JAVASCRIPT-LICENSES.json file.",
    "",
  ];
  for (const packageRecord of inventory.packages) {
    lines.push(
      `------------------------------------------------------------------------`,
      `${packageRecord.name} ${packageRecord.version}`,
      `Declared license: ${packageRecord.license}`,
      `package.json SHA-256: ${packageRecord.packageJsonSha256}`,
    );
    if (packageRecord.licenseDocuments.length === 0) {
      throw new Error(`Package has no reviewed license document: ${packageIdentity(packageRecord)}`);
    }
    lines.push("");
    for (const document of packageRecord.licenseDocuments) {
      lines.push(
        `--- ${document.path} (SHA-256 ${document.sha256}) ---`,
        document.text.endsWith("\n") ? document.text.slice(0, -1) : document.text,
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function createShippedJavaScriptLicenseInventory(
  options: Readonly<{
    packageJsonPath?: string;
    sentinels?: readonly string[];
  }> = {},
): Promise<ShippedJavaScriptLicenseInventory> {
  const packageJsonPath = options.packageJsonPath ?? join(desktopRoot, "package.json");
  const sentinels = options.sentinels ?? shippedJavaScriptSentinels;
  const root = await readPackageMetadata(packageJsonPath);
  const rootDependencies = [...root.dependencies.keys()].sort(compareText);
  const pending = [root.packageJsonPath];
  const visited = new Set<string>();
  const externalPackages = new Map<string, ShippedJavaScriptPackage>();

  while (pending.length > 0) {
    const currentPath = pending.shift();
    if (currentPath === undefined || visited.has(currentPath)) continue;
    visited.add(currentPath);
    const metadata = await readPackageMetadata(currentPath);
    if (isExternalPackage(metadata.packageJsonPath)) {
      if (metadata.license === null) {
        throw new Error(`External package has no declared license: ${packageIdentity(metadata)}`);
      }
      const packageJsonSha256 = sha256(metadata.packageJsonBytes);
      const identity = packageIdentity(metadata);
      let licenseDocuments = await collectLicenseDocuments(metadata.packageRoot);
      const reviewedOverride = reviewedLicenseDocumentOverrides.get(identity);
      if (reviewedOverride !== undefined) {
        if (packageJsonSha256 !== reviewedOverride.packageJsonSha256) {
          throw new Error(`Reviewed license override package metadata differs: ${identity}`);
        }
        await verifyLockPin(identity, reviewedOverride);
        const overrideDocuments: ShippedJavaScriptLicenseDocument[] = [];
        for (const [fileName, expectedSha256] of reviewedOverride.documents) {
          const document = await readLicenseDocument(import.meta.dir, join(import.meta.dir, fileName));
          if (document.sha256 !== expectedSha256) {
            throw new Error(`Reviewed license override document differs: ${identity} ${fileName}`);
          }
          overrideDocuments.push({
            ...document,
            path: `reviewed-override/${document.path}`,
          });
        }
        licenseDocuments = [...licenseDocuments, ...overrideDocuments]
          .sort((left, right) => compareText(left.path, right.path));
      }
      if (licenseDocuments.length === 0) {
        throw new Error(`External package has no reviewed license document: ${identity}`);
      }
      const packageRecord: ShippedJavaScriptPackage = {
        license: metadata.license,
        licenseDocuments,
        name: metadata.name,
        packageJsonSha256,
        version: metadata.version,
      };
      const licenseOverride = licenseMetadataOverrides.get(identity);
      if (licenseOverride !== undefined) {
        if (packageJsonSha256 !== licenseOverride.packageJsonSha256) {
          throw new Error(`Reviewed license metadata override package differs: ${identity}`);
        }
        await verifyLockPin(identity, licenseOverride);
        const evidence = packageRecord.licenseDocuments.find(
          (document) => document.path === licenseOverride.documentPath,
        );
        if (evidence?.sha256 !== licenseOverride.documentSha256) {
          throw new Error(`License metadata override evidence differs: ${identity}`);
        }
      }
      const existing = externalPackages.get(identity);
      if (
        existing !== undefined
        && serializePackageRecord(existing) !== serializePackageRecord(packageRecord)
      ) {
        throw new Error(`Conflicting installed package evidence: ${identity}`);
      }
      externalPackages.set(identity, packageRecord);
    }
    for (const [name, kind] of metadata.dependencies) {
      const resolved = await resolveDependencyPackageJson(metadata.packageRoot, name);
      if (resolved === null) {
        if (kind === "optional") continue;
        throw new Error(`${packageIdentity(metadata)} is missing required dependency ${name}`);
      }
      if (!visited.has(resolved)) pending.push(resolved);
    }
    pending.sort(compareText);
  }

  const packages = [...externalPackages.values()].sort((left, right) =>
    compareText(packageIdentity(left), packageIdentity(right))
  );
  const names = new Set(packages.map((packageRecord) => packageRecord.name));
  for (const sentinel of sentinels) {
    if (!names.has(sentinel)) {
      throw new Error(`Shipped JavaScript inventory is missing sentinel package ${sentinel}`);
    }
  }
  return {
    coverage: "installed-production-dependency-closure",
    dependencySections: ["dependencies", "optionalDependencies", "peerDependencies"],
    entrypoints: ["frontend/src/main.tsx", "runtime/src/main.ts"],
    packageCount: packages.length,
    packages,
    rootDependencies,
    rootPackage: { name: root.name, version: root.version },
    schemaVersion: 1,
  };
}

function serializePackageRecord(packageRecord: ShippedJavaScriptPackage): string {
  return JSON.stringify(packageRecord);
}

export function verifyShippedJavaScriptLicenseInventory(
  inventory: unknown,
): ShippedJavaScriptLicenseInventory {
  const raw = record(inventory, "shipped JavaScript license inventory");
  if (
    raw["schemaVersion"] !== 1
    || raw["coverage"] !== "installed-production-dependency-closure"
  ) {
    throw new Error("Shipped JavaScript license inventory header is invalid.");
  }
  const packages = raw["packages"];
  if (!Array.isArray(packages) || raw["packageCount"] !== packages.length) {
    throw new Error("Shipped JavaScript license package count is invalid.");
  }
  const identities: string[] = [];
  const names = new Set<string>();
  for (const [index, value] of packages.entries()) {
    const packageRecord = record(value, `shipped JavaScript package ${index}`);
    const name = nonblankString(packageRecord["name"], `package ${index} name`);
    const version = nonblankString(packageRecord["version"], `package ${index} version`);
    nonblankString(packageRecord["license"], `package ${index} license`);
    const packageJsonSha256 = nonblankString(
      packageRecord["packageJsonSha256"],
      `package ${index} package.json SHA-256`,
    );
    if (!/^[a-f0-9]{64}$/u.test(packageJsonSha256)) {
      throw new Error(`Package ${index} package.json SHA-256 is invalid.`);
    }
    const documents = packageRecord["licenseDocuments"];
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new Error(`Package ${index} licenseDocuments must be a nonempty array.`);
    }
    const documentPaths: string[] = [];
    for (const [documentIndex, documentValue] of documents.entries()) {
      const document = record(
        documentValue,
        `package ${index} license document ${documentIndex}`,
      );
      const path = nonblankString(
        document["path"],
        `package ${index} license document ${documentIndex} path`,
      );
      const text = nonblankString(
        document["text"],
        `package ${index} license document ${documentIndex} text`,
      );
      const digest = nonblankString(
        document["sha256"],
        `package ${index} license document ${documentIndex} SHA-256`,
      );
      if (digest !== sha256(text)) {
        throw new Error(`Package ${index} license document ${path} hash differs.`);
      }
      documentPaths.push(path);
    }
    if (JSON.stringify(documentPaths) !== JSON.stringify([...new Set(documentPaths)].sort(compareText))) {
      throw new Error(`Package ${index} license documents are not unique and sorted.`);
    }
    identities.push(`${name}@${version}`);
    names.add(name);
  }
  if (JSON.stringify(identities) !== JSON.stringify([...new Set(identities)].sort(compareText))) {
    throw new Error("Shipped JavaScript packages are not unique and sorted.");
  }
  for (const sentinel of shippedJavaScriptSentinels) {
    if (!names.has(sentinel)) {
      throw new Error(`Shipped JavaScript inventory is missing sentinel package ${sentinel}`);
    }
  }
  return inventory as ShippedJavaScriptLicenseInventory;
}

if (import.meta.main) {
  const inventory = await createShippedJavaScriptLicenseInventory();
  verifyShippedJavaScriptLicenseInventory(inventory);
  process.stdout.write(
    `Verified ${inventory.packageCount} shipped JavaScript package licenses.\n`,
  );
}
