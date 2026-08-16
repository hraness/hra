import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  type CodexNativeLicenseInventory,
  renderCodexNativeLicenseNotices,
  serializeCodexNativeLicenseInventory,
  verifyCodexNativeLicenseInventory,
} from "./codex-native-licenses";

const execFile = promisify(execFileCallback);
const sourceCommit = "5d1fbf26c43abc65a203928b2e31561cb039e06d";
const sourceTag = "rust-v0.144.6";
const target = "aarch64-apple-darwin";
const version = "0.144.6";
const cargoLockSha256 = "175793a40a3147db1fee08fd9db0acc59312c344b3513dd7ee316f5446d8119e";
const platformIntegrity = "sha512-6zgvh70MzBNSeT17HEhSOrmmGGZGAKzSC7x6JAq+edkJkdPYA9P0I1tG7aJ49GlBkBxuC+MKBH1qm6+2Cghcww==";
const expectedMissingFileOverrides = 77;
const maximumLicenseBytes = 2_000_000;
const excludedLicenseExtensions = /\.(?:bazel|c|cc|cpp|h|hpp|js|json|py|rs|sh|star|toml|ts)$/iu;
const licenseNamePattern = /^(?:licen[cs]e|copying|copyright|notice)(?:$|[-_.])/iu;

type MetadataPackage = Readonly<{
  authors: readonly string[];
  id: string;
  license: string | null;
  license_file: string | null;
  manifest_path: string;
  name: string;
  source: string | null;
  version: string;
}>;

type CargoMetadata = Readonly<{
  packages: readonly MetadataPackage[];
  workspace_root: string;
}>;

type LockPackage = Readonly<{
  checksum?: string;
  name: string;
  source?: string;
  version: string;
}>;

type ReviewedDocument = Readonly<{
  path: string;
  sha256: string;
  text: string;
  url?: string;
  source?: string;
}>;

type ReviewedOverride = Readonly<{
  declaredLicense: string;
  documents: readonly ReviewedDocument[];
  evidenceKind: string;
  identity: string;
  normalizedLicenseExpression: string;
  upstreamDocumentMissing: boolean;
}>;

type ReviewedComponent = Readonly<{
  documents: readonly ReviewedDocument[];
  evidence: readonly Readonly<{ name: string; sha256: string; source: string }>[];
  identity: string;
  license: string;
  sourceCommit: string;
  sourceUrl: string;
}>;

type ReviewedPins = Readonly<{
  missingFileOverrides: readonly ReviewedOverride[];
  nativeComponents: readonly ReviewedComponent[];
  schemaVersion: 1;
}>;

type UpdateOptions = Readonly<{
  cargoBinary?: string;
  cargoHome?: string;
  cargoMetadataPath?: string;
  cargoTreePath?: string;
  platformPackageRoot?: string;
  sourceRoot: string;
}>;

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCargoLock(text: string): string {
  const matches = text.match(/^version = "0\.0\.0"$/gmu) ?? [];
  if (matches.length !== 132) {
    throw new Error(`Expected exactly 132 first-party 0.0.0 Cargo.lock versions, found ${matches.length}.`);
  }
  return text.replace(/^version = "0\.0\.0"$/gmu, `version = "${version}"`);
}

function parseCargoTree(text: string): readonly string[] {
  const identities = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^([^ ]+) v([^ ]+)/u.exec(line);
    if (match) identities.add(`${match[1]}@${match[2]}`);
  }
  const result = [...identities].sort(compareText);
  if (result.length !== 969) throw new Error(`Expected exact 969-package Cargo tree, found ${result.length}.`);
  return result;
}

function parseCargoLock(text: string): readonly LockPackage[] {
  const parsed = Bun.TOML.parse(text) as { package?: unknown };
  if (!Array.isArray(parsed.package)) throw new Error("Cargo.lock has no package array.");
  return parsed.package.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Cargo.lock package ${index} is invalid.`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry["name"] !== "string" || typeof entry["version"] !== "string") {
      throw new Error(`Cargo.lock package ${index} has no identity.`);
    }
    return {
      ...(typeof entry["checksum"] === "string" ? { checksum: entry["checksum"] } : {}),
      name: entry["name"],
      ...(typeof entry["source"] === "string" ? { source: entry["source"] } : {}),
      version: entry["version"],
    };
  });
}

function parseCargoMetadata(text: string): CargoMetadata {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Cargo metadata must be an object.");
  }
  const root = parsed as Record<string, unknown>;
  const rawPackages = root["packages"];
  const workspaceRoot = root["workspace_root"];
  if (!Array.isArray(rawPackages) || typeof workspaceRoot !== "string") {
    throw new Error("Cargo metadata shape is invalid.");
  }
  const packages = rawPackages.map((rawPackage, index): MetadataPackage => {
    if (typeof rawPackage !== "object" || rawPackage === null || Array.isArray(rawPackage)) {
      throw new Error(`Cargo metadata package ${index} must be an object.`);
    }
    const entry = rawPackage as Record<string, unknown>;
    const authors = entry["authors"];
    const license = entry["license"];
    const licenseFile = entry["license_file"];
    const source = entry["source"];
    if (
      !Array.isArray(authors) ||
      authors.some((author) => typeof author !== "string") ||
      typeof entry["id"] !== "string" ||
      (license !== null && typeof license !== "string") ||
      (licenseFile !== null && typeof licenseFile !== "string") ||
      typeof entry["manifest_path"] !== "string" ||
      typeof entry["name"] !== "string" ||
      (source !== null && typeof source !== "string") ||
      typeof entry["version"] !== "string"
    ) {
      throw new Error(`Cargo metadata package ${index} shape is invalid.`);
    }
    return {
      authors: authors as string[],
      id: entry["id"],
      license,
      license_file: licenseFile,
      manifest_path: entry["manifest_path"],
      name: entry["name"],
      source,
      version: entry["version"],
    };
  });
  return { packages, workspace_root: workspaceRoot };
}

async function readRegularBytes(path: string, maximumBytes: number): Promise<Uint8Array> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`License evidence must be a regular single-link file: ${path}`);
  }
  if (status.size <= 0 || status.size > maximumBytes) {
    throw new Error(`License evidence has invalid size: ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== status.size) throw new Error(`License evidence changed while read: ${path}`);
  return bytes;
}

async function readRegularText(path: string): Promise<{ digest: string; text: string }> {
  const bytes = await readRegularBytes(path, maximumLicenseBytes);
  return {
    digest: sha256(bytes),
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  };
}

function isLicenseName(name: string): boolean {
  return licenseNamePattern.test(name) && !excludedLicenseExtensions.test(name);
}

async function rootLicensePaths(root: string): Promise<readonly string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isLicenseName(entry.name))
    .map((entry) => join(root, entry.name))
    .sort(compareText);
}

async function recursiveLicensePaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      // Cargo Git checkouts may contain repository-relative license symlinks. Record
      // only license-named links here; readPackageLicense applies the source-kind and
      // canonical checkout-containment checks before accepting their targets.
      if (entry.isSymbolicLink()) {
        if (isLicenseName(entry.name)) paths.push(path);
        continue;
      }
      if (entry.isDirectory()) {
        if (/^(?:\.git|examples?|target|tests?)$/iu.test(entry.name)) continue;
        await visit(path);
      } else if (entry.isFile() && isLicenseName(entry.name)) {
        paths.push(path);
      } else if (!entry.isFile()) {
        throw new Error(`Special file in Cargo source evidence: ${path}`);
      }
    }
  }
  await visit(root);
  return paths;
}

async function gitCheckoutRoot(packageRoot: string): Promise<string | undefined> {
  let candidate = packageRoot;
  while (true) {
    try {
      const marker = await lstat(join(candidate, ".git"));
      if (marker.isDirectory() || marker.isFile()) return candidate;
    } catch (error) {
      const statusError = error as NodeJS.ErrnoException;
      if (statusError.code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

async function readPackageLicense(
  path: string,
  packageRoot: string,
  packageSource: string,
): Promise<{ digest: string; text: string }> {
  const status = await lstat(path);
  if (!status.isSymbolicLink()) return readRegularText(path);
  if (!packageSource.startsWith("git+")) {
    throw new Error(`Registry/path Cargo package cannot use a license symlink: ${path}`);
  }
  const checkoutRoot = await gitCheckoutRoot(packageRoot);
  if (!checkoutRoot) throw new Error(`License symlink is not inside a Cargo Git checkout: ${path}`);
  const targetPath = await realpath(path);
  assertContained(checkoutRoot, targetPath);
  return readRegularText(targetPath);
}

async function command(binary: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = await execFile(binary, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

async function sourceIdentity(sourceRoot: string): Promise<void> {
  const [commit, tags, status] = await Promise.all([
    command("git", ["rev-parse", "HEAD"], sourceRoot),
    command("git", ["tag", "--points-at", "HEAD"], sourceRoot),
    command("git", ["status", "--porcelain"], sourceRoot),
  ]);
  if (commit.trim() !== sourceCommit || !tags.split("\n").includes(sourceTag) || status.trim() !== "") {
    throw new Error("Codex source root must be the clean exact rust-v0.144.6 commit.");
  }
}

async function createCargoEvidence(options: UpdateOptions, normalizedLock: string) {
  if ((options.cargoMetadataPath === undefined) !== (options.cargoTreePath === undefined)) {
    throw new Error("--metadata and --tree must be supplied together.");
  }
  if (options.cargoMetadataPath && options.cargoTreePath) {
    const [metadata, tree] = await Promise.all([
      readFile(options.cargoMetadataPath, "utf8"),
      readFile(options.cargoTreePath, "utf8"),
    ]);
    return { metadata, tree };
  }
  if (!options.cargoBinary || !options.cargoHome) {
    throw new Error("Cargo 1.95 binary/home are required when prepared metadata/tree are absent.");
  }
  const cargoVersion = await command(options.cargoBinary, ["--version"], options.sourceRoot, {
    CARGO_HOME: options.cargoHome,
  });
  if (!cargoVersion.startsWith("cargo 1.95.0 ")) throw new Error(`Expected Cargo 1.95.0, got ${cargoVersion.trim()}.`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hra-codex-native-licenses."));
  const workspace = join(temporaryRoot, "codex-rs");
  await cp(join(options.sourceRoot, "codex-rs"), workspace, {
    filter: (path) => basename(path) !== "target",
    recursive: true,
  });
  await writeFile(join(workspace, "Cargo.lock"), normalizedLock);
  const env = { CARGO_HOME: options.cargoHome };
  const metadata = await command(
    options.cargoBinary,
    ["metadata", "--locked", "--offline", "--filter-platform", target, "--format-version", "1"],
    workspace,
    env,
  );
  const tree = await command(
    options.cargoBinary,
    [
      "tree", "--locked", "--offline", "--target", target, "--edges", "normal,build",
      "--prefix", "none", "--format", "{p}", "-p", "codex-cli", "-p", "codex-code-mode-host",
    ],
    workspace,
    env,
  );
  return { metadata, tree };
}

function assertContained(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child === ".." || child.startsWith(`..${sep}`) || resolve(root, child) !== candidate) {
    throw new Error(`Path escapes its evidence root: ${candidate}`);
  }
}

export async function generateCodexNativeLicenseInventory(
  options: UpdateOptions,
): Promise<CodexNativeLicenseInventory> {
  const sourceRoot = await realpath(options.sourceRoot);
  await sourceIdentity(sourceRoot);
  const originalLockText = await readFile(join(sourceRoot, "codex-rs/Cargo.lock"), "utf8");
  if (sha256(originalLockText) !== cargoLockSha256) throw new Error("Upstream Codex Cargo.lock digest differs.");
  const normalizedLock = normalizeCargoLock(originalLockText);
  const normalizedCargoLockSha256 = sha256(normalizedLock);
  const cargoEvidence = await createCargoEvidence(options, normalizedLock);
  const metadata = parseCargoMetadata(cargoEvidence.metadata);
  const closureIdentities = parseCargoTree(cargoEvidence.tree);
  const packagesByIdentity = new Map<string, MetadataPackage>(
    metadata.packages.map((entry) => [`${entry.name}@${entry.version}`, entry] as const),
  );
  if (packagesByIdentity.size !== metadata.packages.length) {
    throw new Error("Cargo metadata contains a duplicate name/version identity.");
  }
  const lockPackages = parseCargoLock(originalLockText);
  const reviewed = JSON.parse(
    await readFile(join(import.meta.dir, "codex-native-licenses-reviewed.json"), "utf8"),
  ) as ReviewedPins;
  if (
    reviewed.schemaVersion !== 1 ||
    reviewed.missingFileOverrides.length !== expectedMissingFileOverrides ||
    reviewed.nativeComponents.length !== 16
  ) {
    throw new Error("Reviewed Codex native license pins have an unexpected closure.");
  }
  const overrides = new Map(reviewed.missingFileOverrides.map((entry) => [entry.identity, entry]));
  if (overrides.size !== expectedMissingFileOverrides) throw new Error("Reviewed overrides contain duplicates.");

  const documentMap = new Map<string, { sha256: string; sources: Set<string>; text: string }>();
  const addDocument = (text: string, digest: string, source: string) => {
    if (sha256(text) !== digest) throw new Error(`Reviewed license text hash differs: ${source}`);
    const existing = documentMap.get(digest);
    if (existing && existing.text !== text) throw new Error(`License SHA-256 collision: ${digest}`);
    if (existing) existing.sources.add(source);
    else documentMap.set(digest, { sha256: digest, sources: new Set([source]), text });
    return digest;
  };
  const codexLicense = await readRegularText(join(sourceRoot, "LICENSE"));
  const codexNotice = await readRegularText(join(sourceRoot, "NOTICE"));
  const workspaceDocuments = [
    addDocument(
      codexLicense.text,
      codexLicense.digest,
      `https://raw.githubusercontent.com/openai/codex/${sourceCommit}/LICENSE`,
    ),
    addDocument(
      codexNotice.text,
      codexNotice.digest,
      `https://raw.githubusercontent.com/openai/codex/${sourceCommit}/NOTICE`,
    ),
  ].sort(compareText);

  const consumedOverrides = new Set<string>();
  const cargoPackages = [];
  for (const identity of closureIdentities) {
    const packageValue = packagesByIdentity.get(identity);
    if (!packageValue) throw new Error(`Cargo tree identity absent from metadata: ${identity}`);
    const isWorkspace = packageValue.source === null;
    const metadataWorkspace = resolve(metadata.workspace_root);
    let manifestPath: string;
    let source: string;
    let checksum: string | undefined;
    if (isWorkspace) {
      const metadataManifest = resolve(packageValue.manifest_path);
      assertContained(metadataWorkspace, metadataManifest);
      const manifestRelative = relative(metadataWorkspace, metadataManifest);
      manifestPath = join(sourceRoot, "codex-rs", manifestRelative);
      source = `workspace:${relative(join(sourceRoot, "codex-rs"), dirname(manifestPath)) || "."}`;
      const lockMatches = lockPackages.filter(
        (entry) => entry.name === packageValue.name && entry.version === "0.0.0" && entry.source === undefined,
      );
      if (lockMatches.length !== 1) throw new Error(`Workspace lock identity differs: ${identity}`);
    } else {
      manifestPath = resolve(packageValue.manifest_path);
      source = packageValue.source!;
      const lockMatches = lockPackages.filter(
        (entry) =>
          entry.name === packageValue.name &&
          entry.version === packageValue.version &&
          entry.source === packageValue.source,
      );
      if (lockMatches.length !== 1) throw new Error(`External lock identity differs: ${identity}`);
      checksum = lockMatches[0]!.checksum;
      if (source.startsWith("registry+") && checksum === undefined) {
        throw new Error(`Registry package has no Cargo.lock checksum: ${identity}`);
      }
    }
    const manifest = await readRegularBytes(manifestPath, 1_000_000);
    const originalManifestPath = join(dirname(manifestPath), "Cargo.toml.orig");
    let originalManifestSha256: string | undefined;
    try {
      originalManifestSha256 = sha256(await readRegularBytes(originalManifestPath, 1_000_000));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
        const statusError = error as NodeJS.ErrnoException;
        if (statusError.code !== "ENOENT") throw error;
      }
    }
    let documentSha256s: readonly string[];
    let licenseEvidence: string;
    let reviewedLicenseExpression: string | undefined;
    let upstreamLicenseDocumentMissing = false;
    if (isWorkspace) {
      documentSha256s = workspaceDocuments;
      licenseEvidence = "openai/codex source LICENSE and NOTICE";
    } else {
      const packageRoot = dirname(manifestPath);
      const directDocuments = await rootLicensePaths(packageRoot);
      const override = overrides.get(identity);
      if (directDocuments.length === 0) {
        if (!override || override.declaredLicense !== packageValue.license) {
          throw new Error(`Missing exact reviewed license-file override: ${identity}`);
        }
        consumedOverrides.add(identity);
        licenseEvidence = override.evidenceKind;
        reviewedLicenseExpression = override.normalizedLicenseExpression;
        upstreamLicenseDocumentMissing = override.upstreamDocumentMissing;
        documentSha256s = override.documents.map((document) =>
          addDocument(document.text, document.sha256, document.url ?? document.source ?? `${identity}/${document.path}`)
        ).sort(compareText);
      } else {
        if (override) throw new Error(`Unused reviewed license-file override: ${identity}`);
        licenseEvidence = "Cargo package license files";
        const sourceDocuments = await recursiveLicensePaths(packageRoot);
        documentSha256s = (await Promise.all(sourceDocuments.map(async (path) => {
          const document = await readPackageLicense(path, packageRoot, source);
          return addDocument(document.text, document.digest, `cargo:${identity}/${relative(packageRoot, path)}`);
        }))).sort(compareText);
      }
    }
    cargoPackages.push({
      authors: [...packageValue.authors],
      ...(checksum ? { checksum } : {}),
      declaredLicense: packageValue.license ?? "Apache-2.0",
      documentSha256s: [...new Set(documentSha256s)].sort(compareText),
      identity,
      licenseEvidence,
      manifestSha256: sha256(manifest),
      ...(originalManifestSha256 ? { originalManifestSha256 } : {}),
      ...(reviewedLicenseExpression ? { reviewedLicenseExpression } : {}),
      source,
      upstreamLicenseDocumentMissing,
    });
  }
  if (consumedOverrides.size !== expectedMissingFileOverrides) {
    const unused = [...overrides.keys()].filter((identity) => !consumedOverrides.has(identity));
    throw new Error(`Reviewed missing-file overrides differ from the Cargo closure: ${unused.join(", ")}`);
  }
  cargoPackages.sort((left, right) => compareText(left.identity, right.identity));

  const nativeComponents = reviewed.nativeComponents.map((component) => ({
    documentSha256s: [...new Set(component.documents.map((document) =>
      addDocument(document.text, document.sha256, document.url ?? document.source ?? `${component.identity}/${document.path}`)
    ))].sort(compareText),
    evidence: [...component.evidence].sort((left, right) => compareText(left.name, right.name)),
    identity: component.identity,
    license: component.license,
    sourceCommit: component.sourceCommit,
    sourceUrl: component.sourceUrl,
  })).sort((left, right) => compareText(left.identity, right.identity));

  const repositoryRoot = resolve(import.meta.dir, "../../..");
  const platformRoot = await realpath(
    options.platformPackageRoot ??
      join(
        repositoryRoot,
        "node_modules/.bun/@openai+codex@0.144.6-darwin-arm64/node_modules/@openai/codex",
      ),
  );
  const platformManifest = await readRegularBytes(join(platformRoot, "package.json"), 100_000);
  const vendorRoot = join(platformRoot, "vendor", target);
  const coverage = new Map<string, readonly string[]>([
    ["bin/codex", nativeComponents.map((entry) => entry.identity).filter((identity) => !identity.startsWith("pcre2@") && !identity.startsWith("ripgrep@") && !identity.startsWith("zsh@"))],
    ["bin/codex-code-mode-host", nativeComponents.map((entry) => entry.identity).filter((identity) => !identity.startsWith("pcre2@") && !identity.startsWith("ripgrep@") && !identity.startsWith("zsh@"))],
    ["codex-package.json", ["codex-project@0.144.6"]],
    ["codex-path/rg", ["pcre2@10.45", "ripgrep@15.1.0"]],
    ["codex-resources/zsh/bin/zsh", ["zsh@77045ef899e53b9598bebc5a41db93a548a40ca6"]],
  ]);
  const payloads = [];
  for (const [path, payloadCoverage] of [...coverage].sort(([left], [right]) => compareText(left, right))) {
    const payloadPath = join(vendorRoot, path);
    assertContained(platformRoot, payloadPath);
    const bytes = await readRegularBytes(payloadPath, 350_000_000);
    const payloadStat = await stat(payloadPath);
    payloads.push({
      coverage: path.startsWith("bin/") ? ["cargo-closure", ...payloadCoverage].sort(compareText) : [...payloadCoverage].sort(compareText),
      path,
      sha256: sha256(bytes),
      size: payloadStat.size,
    });
  }

  const documents = [...documentMap.values()]
    .map((document) => ({
      sha256: document.sha256,
      sources: [...document.sources].sort(compareText),
      text: document.text,
    }))
    .sort((left, right) => compareText(left.sha256, right.sha256));
  const externalPackages = cargoPackages.filter((entry) => !entry.source.startsWith("workspace:"));
  const workspacePackages = cargoPackages.filter((entry) => entry.source.startsWith("workspace:"));
  const externalIdentities = externalPackages.map((entry) =>
    `${entry.identity}|${entry.source}|${entry.checksum ?? "-"}`
  );
  const candidate = {
    counts: {
      documents: documents.length,
      externalPackages: externalPackages.length,
      nativeComponents: nativeComponents.length,
      packages: cargoPackages.length,
      payloads: payloads.length,
      workspacePackages: workspacePackages.length,
    },
    documents,
    nativeComponents,
    packages: cargoPackages,
    platformPackage: {
      integrity: platformIntegrity,
      manifestSha256: sha256(platformManifest),
      name: "@openai/codex",
      payloads,
      target,
      version: "0.144.6-darwin-arm64",
    },
    schemaVersion: 1,
    source: {
      cargoLockExternalIdentities: externalIdentities,
      cargoLockExternalIdentitiesSha256: sha256(`${externalIdentities.join("\n")}\n`),
      cargoLockSha256,
      cargoMetadataSha256: sha256(cargoEvidence.metadata),
      cargoTreeSha256: sha256(cargoEvidence.tree),
      commit: sourceCommit,
      normalizedCargoLockSha256,
      repository: "https://github.com/openai/codex",
      rootPackages: ["codex-cli", "codex-code-mode-host"],
      rustToolchain: "1.95.0",
      tag: sourceTag,
      target,
    },
  };
  return verifyCodexNativeLicenseInventory(candidate);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const sourceRoot = argument("--source-root");
  if (!sourceRoot) throw new Error("usage: bun codex-native-licenses-update.ts --source-root <openai/codex> [--metadata <json> --tree <text> | --cargo <1.95 binary> --cargo-home <dir>]");
  const cargoBinary = argument("--cargo");
  const cargoHome = argument("--cargo-home");
  const cargoMetadataPath = argument("--metadata");
  const cargoTreePath = argument("--tree");
  const platformPackageRoot = argument("--platform-root");
  const inventory = await generateCodexNativeLicenseInventory({
    ...(cargoBinary ? { cargoBinary } : {}),
    ...(cargoHome ? { cargoHome } : {}),
    ...(cargoMetadataPath ? { cargoMetadataPath } : {}),
    ...(cargoTreePath ? { cargoTreePath } : {}),
    ...(platformPackageRoot ? { platformPackageRoot } : {}),
    sourceRoot,
  });
  const jsonPath = join(import.meta.dir, "CODEX-NATIVE-LICENSES.json");
  const textPath = join(import.meta.dir, "CODEX-NATIVE-LICENSES.txt");
  await Promise.all([
    writeFile(jsonPath, serializeCodexNativeLicenseInventory(inventory)),
    writeFile(textPath, renderCodexNativeLicenseNotices(inventory)),
  ]);
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${textPath}`);
}
