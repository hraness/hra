import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { loadBunNativeLicenseInventory } from "./bun-native-licenses";
import {
  renderCodexNativeLicenseNotices,
  serializeCodexNativeLicenseInventory,
  verifyCodexNativeLicenseInventory,
  verifyCodexNativePayloadsAtPaths,
} from "./codex-native-licenses";
import {
  correspondingSourceSpecs,
  verifyCorrespondingSourceArchive,
} from "./corresponding-sources";
import {
  hranessUiStylesheetInput,
  imageNormalizerPackageContract,
  macosPackage,
  requiredLicenseFileNames,
  requiredRuntimeBinFileNames,
  trustedThirdPartyTeams,
} from "./macos-package-config";
import { loadGcmDependencyLicenseInventory } from "./gcm-dependency-licenses";
import runtimeVersions from "./runtime-versions.json";
import {
  createShippedJavaScriptLicenseInventory,
  renderShippedJavaScriptLicenseNotices,
  serializeShippedJavaScriptLicenseInventory,
  verifyShippedJavaScriptLicenseInventory,
} from "./shipped-javascript-licenses";

type CommandResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type RuntimeTreeEntry = Readonly<{
  path: string;
  sha256?: string;
  target?: string;
  type: "file" | "symlink";
}>;

type MacOSAppEvidence = Readonly<{
  commit: string;
  runtimeManifest: unknown;
  treeSha256: string;
}>;

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    !fromRoot.startsWith(`..${sep}`)
    && fromRoot !== ".."
    && !fromRoot.startsWith(sep)
  );
}

async function run(
  argv: readonly string[],
  options: Readonly<{
    allowFailure?: boolean;
    cwd?: string;
  }> = {},
): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd ?? macosPackage.desktopRoot,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && options.allowFailure !== true) {
    throw new Error(
      `${argv.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`,
    );
  }
  return { exitCode, stderr, stdout };
}

export async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hasher = createHash("sha256");
  try {
    for await (const chunk of handle.readableWebStream()) {
      hasher.update(chunk as Uint8Array);
    }
  } finally {
    await handle.close();
  }
  return hasher.digest("hex");
}

export async function verifyRegularReleaseEntries(
  releaseDirectory: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    const status = await lstat(join(releaseDirectory, name));
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Release entry must be a regular file: ${name}`);
    }
  }
}

async function walkTree(root: string): Promise<RuntimeTreeEntry[]> {
  const entries: RuntimeTreeEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (child.isSymbolicLink()) {
        const target = await readlink(path);
        if (target.startsWith("/") || !inside(root, resolve(dirname(path), target))) {
          throw new Error(`Runtime symlink escapes its root: ${relativePath}`);
        }
        entries.push({ path: relativePath, target, type: "symlink" });
      } else if (child.isDirectory()) {
        await visit(path);
      } else if (child.isFile()) {
        entries.push({ path: relativePath, sha256: await sha256File(path), type: "file" });
      } else {
        throw new Error(`Special runtime file is forbidden: ${relativePath}`);
      }
    }
  }
  await visit(root);
  return entries;
}

async function plistValue(path: string, key: string): Promise<string> {
  const result = await run([
    "/usr/bin/plutil",
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path,
  ]);
  return result.stdout.trim();
}

async function plistHasKey(path: string, key: string): Promise<boolean> {
  return (await run([
    "/usr/bin/plutil",
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path,
  ], { allowFailure: true })).exitCode === 0;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

async function codeSignature(path: string): Promise<Readonly<{
  cdHash: string;
  identifier: string;
  teamIdentifier: string | null;
}>> {
  const result = await run([
    "/usr/bin/codesign",
    "--display",
    "--verbose=4",
    path,
  ]);
  const details = `${result.stdout}\n${result.stderr}`;
  const value = (pattern: RegExp): string | null =>
    pattern.exec(details)?.[1]?.trim() ?? null;
  const cdHash = value(/^CDHash=([0-9a-fA-F]+)$/mu)?.toLowerCase() ?? null;
  const identifier = value(/^Identifier=(.+)$/mu);
  const rawTeam = value(/^TeamIdentifier=(.+)$/mu);
  if (cdHash === null || identifier === null) {
    throw new Error(`Missing code signature metadata: ${path}`);
  }
  return {
    cdHash,
    identifier,
    teamIdentifier: rawTeam === "not set" ? null : rawTeam,
  };
}

async function verifyRuntimeManifest(
  appPath: string,
): Promise<MacOSAppEvidence> {
  const runtimeRoot = join(appPath, "Contents/Resources/runtime");
  const manifestPath = join(runtimeRoot, "manifest.json");
  const manifest = record(
    JSON.parse(await readFile(manifestPath, "utf8")),
    "runtime manifest",
  );
  if (manifest["schemaVersion"] !== 1) {
    throw new Error("Runtime manifest schema is unsupported.");
  }
  const release = record(manifest["release"], "runtime manifest release");
  const runtime = record(manifest["runtime"], "runtime manifest runtime");
  if (
    release["version"] !== macosPackage.version
    || number(release["build"], "release build") !== macosPackage.build
    || release["architecture"] !== macosPackage.architecture
    || release["minimumMacOS"] !== macosPackage.minimumMacOS
    || release["signing"] !== "adhoc"
  ) {
    throw new Error("Runtime manifest release identity differs from the package.");
  }
  const commit = string(release["commit"], "release commit");
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Runtime manifest source commit is invalid.");
  }

  const gateway = record(runtime["gateway"], "runtime gateway");
  const dataRemover = record(runtime["dataRemover"], "runtime data remover");
  const gitExecutor = record(runtime["gitExecutor"], "runtime Git executor");
  const imageNormalizer = record(runtime["imageNormalizer"], "runtime image normalizer");
  const keychainCustodian = record(runtime["keychainCustodian"], "runtime Keychain custodian");
  const codex = record(runtime["codex"], "runtime Codex");
  const git = record(runtime["git"], "runtime Git");
  const gitCredentialManager = record(
    runtime["gitCredentialManager"],
    "runtime Git Credential Manager",
  );
  const gitLfs = record(runtime["gitLfs"], "runtime Git LFS");
  const ripgrep = record(runtime["ripgrep"], "runtime ripgrep");
  const expectedHashes = new Map([
    [
      imageNormalizerPackageContract.runtimeRelativePath,
      string(imageNormalizer["sha256"], "image normalizer SHA-256"),
    ],
    ["bin/oprte-gateway", string(gateway["sha256"], "gateway SHA-256")],
    ["bin/oprte-data-remover", string(dataRemover["sha256"], "data remover SHA-256")],
    ["bin/oprte-git-executor", string(gitExecutor["sha256"], "Git executor SHA-256")],
    ["bin/oprte-keychain-custodian", string(keychainCustodian["sha256"], "Keychain custodian SHA-256")],
    ["codex/bin/codex", string(codex["binarySha256"], "Codex SHA-256")],
    ["git/bin/git", string(git["binarySha256"], "Git SHA-256")],
    [
      "git/libexec/git-core/git-credential-manager",
      string(gitCredentialManager["binarySha256"], "Git Credential Manager SHA-256"),
    ],
    ["git/libexec/git-core/git-lfs", string(gitLfs["binarySha256"], "Git LFS SHA-256")],
    ["codex/codex-path/rg", string(ripgrep["binarySha256"], "ripgrep SHA-256")],
  ]);
  for (const [path, expected] of expectedHashes) {
    if (!/^[0-9a-f]{64}$/u.test(expected) || await sha256File(join(runtimeRoot, path)) !== expected) {
      throw new Error(`Runtime hash differs: ${path}`);
    }
  }
  if (
    gateway["bunVersion"] !== runtimeVersions.bun.version
    || gateway["compilerBinarySha256"] !== runtimeVersions.bun.binarySha256
    || gateway["compilerReleaseAssetSha256"] !== runtimeVersions.bun.releaseAssetSha256
    || gateway["compilerSourceCommit"] !== runtimeVersions.bun.sourceCommit
    || gateway["completeSourceArchiveSha256"]
      !== runtimeVersions.bun.completeSourceArchiveSha256
    || gateway["dependencyLicenseInventorySha256"]
      !== runtimeVersions.bun.dependencyLicenseInventorySha256
    || gateway["dependencyLicenseNoticesSha256"]
      !== runtimeVersions.bun.dependencyLicenseNoticesSha256
    || codex["version"] !== runtimeVersions.codex.version
    || codex["sourceCommit"] !== runtimeVersions.codex.sourceCommit
    || codex["dependencyLicenseInventorySha256"]
      !== runtimeVersions.codex.dependencyLicenseInventorySha256
    || codex["dependencyLicenseNoticesSha256"]
      !== runtimeVersions.codex.dependencyLicenseNoticesSha256
    || git["version"] !== runtimeVersions.git.version
    || git["assetSha256"] !== runtimeVersions.git.assetSha256
    || gitCredentialManager["version"] !== runtimeVersions.gitCredentialManager.version
    || gitCredentialManager["sourceCommit"] !== runtimeVersions.gitCredentialManager.sourceCommit
    || gitCredentialManager["licenseSha256"] !== runtimeVersions.gitCredentialManager.licenseSha256
    || gitCredentialManager["noticeSha256"] !== runtimeVersions.gitCredentialManager.noticeSha256
    || gitCredentialManager["depsJsonSha256"] !== runtimeVersions.gitCredentialManager.depsJsonSha256
    || gitCredentialManager["runtimeConfigSha256"] !== runtimeVersions.gitCredentialManager.runtimeConfigSha256
    || gitCredentialManager["dependencyLicenseInventorySha256"]
      !== runtimeVersions.gitCredentialManager.dependencyLicenseInventorySha256
    || gitCredentialManager["dependencyLicenseNoticesSha256"]
      !== runtimeVersions.gitCredentialManager.dependencyLicenseNoticesSha256
    || gitCredentialManager["dotnetRuntimeVersion"]
      !== runtimeVersions.gitCredentialManager.dotnetRuntimeVersion
    || gitCredentialManager["dotnetRuntimeSourceCommit"]
      !== runtimeVersions.gitCredentialManager.dotnetRuntimeSourceCommit
    || gitLfs["version"] !== runtimeVersions.gitLfs.version
    || gitLfs["sourceCommit"] !== runtimeVersions.gitLfs.sourceCommit
    || gitLfs["licenseSha256"] !== runtimeVersions.gitLfs.licenseSha256
    || ripgrep["version"] !== runtimeVersions.ripgrep.version
    || ripgrep["sourceCommit"] !== runtimeVersions.ripgrep.sourceCommit
    || ripgrep["pcre2LicenseSha256"] !== runtimeVersions.ripgrep.pcre2.licenseSha256
  ) {
    throw new Error("Runtime version pins differ from the manifest.");
  }

  const dataRemoverSignature = await codeSignature(join(runtimeRoot, "bin/oprte-data-remover"));
  if (dataRemover["cdHash"] !== dataRemoverSignature.cdHash) {
    throw new Error("Data remover CodeDirectory hash differs from the manifest.");
  }
  const imageNormalizerSignature = await codeSignature(
    join(runtimeRoot, imageNormalizerPackageContract.runtimeRelativePath),
  );
  if (imageNormalizer["cdHash"] !== imageNormalizerSignature.cdHash) {
    throw new Error("Image normalizer CodeDirectory hash differs from the manifest.");
  }
  const preserved = runtime["preservedSignatures"];
  if (!Array.isArray(preserved) || preserved.length === 0) {
    throw new Error("Runtime manifest has no preserved third-party signatures.");
  }
  for (const [index, rawEntry] of preserved.entries()) {
    const entry = record(rawEntry, `preserved signature ${index}`);
    const path = string(entry["path"], `preserved signature ${index} path`);
    const team = string(entry["teamIdentifier"], `preserved signature ${index} team`);
    if (!trustedThirdPartyTeams.has(team)) {
      throw new Error(`Untrusted preserved signature team: ${team}`);
    }
    const absolute = resolve(appPath, path);
    if (!inside(appPath, absolute)) {
      throw new Error(`Preserved signature escaped the app: ${path}`);
    }
    const signature = await codeSignature(absolute);
    if (signature.teamIdentifier !== team) {
      throw new Error(`Preserved signature changed: ${path}`);
    }
    await run(["/usr/bin/codesign", "--verify", "--strict", absolute]);
  }

  const tree = (await walkTree(runtimeRoot))
    .filter((entry) => entry.path !== "manifest.json");
  const actualTreeSha256 = createHash("sha256")
    .update(`${JSON.stringify(tree)}\n`, "utf8")
    .digest("hex");
  const treeSha256 = string(runtime["treeSha256"], "runtime tree SHA-256");
  if (actualTreeSha256 !== treeSha256) {
    throw new Error("Runtime tree hash differs from the manifest.");
  }
  return { commit, runtimeManifest: manifest, treeSha256 };
}

export async function verifyMacOSApp(
  appPath = macosPackage.appBundlePath,
): Promise<MacOSAppEvidence> {
  const stat = await lstat(appPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Packaged app must be a real directory: ${appPath}`);
  }
  const canonical = await realpath(appPath);
  if (!canonical.endsWith(".app")) {
    throw new Error("Packaged app path must end in .app.");
  }
  const contentsRoot = join(canonical, "Contents");
  const runtimeRoot = join(contentsRoot, "Resources/runtime");
  const plist = join(contentsRoot, "Info.plist");
  const expectedPlist = new Map([
    ["CFBundleDisplayName", macosPackage.displayName],
    ["CFBundleExecutable", macosPackage.executableName],
    ["CFBundleIdentifier", macosPackage.bundleIdentifier],
    ["CFBundleName", macosPackage.productName],
    ["CFBundleShortVersionString", macosPackage.version],
    ["CFBundleVersion", String(macosPackage.build)],
    ["LSMinimumSystemVersion", macosPackage.minimumMacOS],
  ]);
  for (const [key, expected] of expectedPlist) {
    if (await plistValue(plist, key) !== expected) {
      throw new Error(`Info.plist ${key} differs from ${expected}.`);
    }
  }
  for (const key of ["SUFeedURL", "SUPublicEDKey", "SUEnableAutomaticChecks"]) {
    if (await plistHasKey(plist, key)) {
      throw new Error(`Ad-hoc package must not contain ${key}.`);
    }
  }
  try {
    await lstat(join(contentsRoot, "Frameworks/Sparkle.framework"));
    throw new Error("Ad-hoc package must not bundle Sparkle.framework.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const bins = (await readdir(join(runtimeRoot, "bin"))).sort();
  if (JSON.stringify(bins) !== JSON.stringify([...requiredRuntimeBinFileNames])) {
    throw new Error(`Runtime bin set differs: ${bins.join(", ")}`);
  }
  const licenses = (await readdir(join(runtimeRoot, "licenses"))).sort();
  if (JSON.stringify(licenses) !== JSON.stringify([...requiredLicenseFileNames])) {
    throw new Error(`Runtime license set differs: ${licenses.join(", ")}`);
  }
  const licenseRoot = join(runtimeRoot, "licenses");
  const stagedHranessUiLicenseSha256 = await sha256File(
    join(licenseRoot, "HRANESS-UI-LICENSE.txt"),
  );
  if (stagedHranessUiLicenseSha256 !== hranessUiStylesheetInput.licenseSha256) {
    throw new Error("Staged hraness/ui license hash differs.");
  }
  const stagedInventoryText = await readFile(
    join(licenseRoot, "SHIPPED-JAVASCRIPT-LICENSES.json"),
    "utf8",
  );
  const stagedInventory = verifyShippedJavaScriptLicenseInventory(
    JSON.parse(stagedInventoryText) as unknown,
  );
  if (serializeShippedJavaScriptLicenseInventory(stagedInventory) !== stagedInventoryText) {
    throw new Error("Staged JavaScript license inventory is not canonical.");
  }
  const expectedInventory = await createShippedJavaScriptLicenseInventory();
  if (
    serializeShippedJavaScriptLicenseInventory(expectedInventory)
    !== stagedInventoryText
  ) {
    throw new Error("Staged JavaScript license inventory differs from installed production dependencies.");
  }
  const stagedNotices = await readFile(
    join(licenseRoot, "SHIPPED-JAVASCRIPT-LICENSES.txt"),
    "utf8",
  );
  if (stagedNotices !== renderShippedJavaScriptLicenseNotices(stagedInventory)) {
    throw new Error("Staged JavaScript license notices differ from their inventory.");
  }
  await loadGcmDependencyLicenseInventory({
    gcmRoot: join(runtimeRoot, "git/libexec/git-core"),
    inventoryPath: join(licenseRoot, "GCM-DEPENDENCY-LICENSES.json"),
    noticesPath: join(licenseRoot, "GCM-DEPENDENCY-LICENSES.txt"),
  });
  await loadBunNativeLicenseInventory({
    inventoryPath: join(licenseRoot, "BUN-DEPENDENCY-LICENSES.json"),
    noticesPath: join(licenseRoot, "BUN-DEPENDENCY-LICENSES.txt"),
  });
  const stagedCodexInventoryText = await readFile(
    join(licenseRoot, "CODEX-NATIVE-LICENSES.json"),
    "utf8",
  );
  const stagedCodexInventory = verifyCodexNativeLicenseInventory(
    JSON.parse(stagedCodexInventoryText) as unknown,
  );
  if (
    serializeCodexNativeLicenseInventory(stagedCodexInventory)
    !== stagedCodexInventoryText
  ) {
    throw new Error("Staged Codex native license inventory is not canonical.");
  }
  const stagedCodexNotices = await readFile(
    join(licenseRoot, "CODEX-NATIVE-LICENSES.txt"),
    "utf8",
  );
  if (stagedCodexNotices !== renderCodexNativeLicenseNotices(stagedCodexInventory)) {
    throw new Error("Staged Codex native license notices differ from their inventory.");
  }
  await verifyCodexNativePayloadsAtPaths(stagedCodexInventory, {
    manifestPath: join(licenseRoot, "CODEX-platform-package.json"),
    vendorRoot: join(runtimeRoot, "codex"),
  });
  const [stagedRuntimeVersions, sourceRuntimeVersions] = await Promise.all([
    readFile(join(licenseRoot, "RUNTIME-VERSIONS.json"), "utf8"),
    readFile(join(import.meta.dir, "runtime-versions.json"), "utf8"),
  ]);
  if (stagedRuntimeVersions !== sourceRuntimeVersions) {
    throw new Error("Staged runtime version pins differ from source.");
  }

  const release = await verifyRuntimeManifest(canonical);
  const dataRemover = await codeSignature(join(runtimeRoot, "bin/oprte-data-remover"));
  if (dataRemover.identifier !== "oprte-data-remover") {
    throw new Error("Data remover code identifier differs.");
  }
  if (await plistValue(plist, "KitchenExpectedDataRemoverCDHashV1") !== dataRemover.cdHash) {
    throw new Error("Info.plist does not seal the data remover CodeDirectory hash.");
  }
  const custodian = await codeSignature(join(runtimeRoot, "bin/oprte-keychain-custodian"));
  if (custodian.identifier !== "oprte-keychain-custodian") {
    throw new Error("Keychain custodian code identifier differs.");
  }
  const imageNormalizerPath = join(
    runtimeRoot,
    imageNormalizerPackageContract.runtimeRelativePath,
  );
  const imageNormalizer = await codeSignature(imageNormalizerPath);
  if (
    imageNormalizer.identifier !== imageNormalizerPackageContract.identifier
    || imageNormalizer.teamIdentifier !== null
  ) {
    throw new Error("Image normalizer code identity differs.");
  }
  await run(["/usr/bin/codesign", "--verify", "--strict", imageNormalizerPath]);
  const imageNormalizerEntitlements = await run([
    "/usr/bin/codesign",
    "--display",
    "--entitlements",
    ":-",
    imageNormalizerPath,
  ], { allowFailure: true });
  if (/<key>/u.test(
    `${imageNormalizerEntitlements.stdout}\n${imageNormalizerEntitlements.stderr}`,
  )) {
    throw new Error("Image normalizer must not carry entitlements.");
  }
  const imageNormalizerImports = await run([
    "/usr/bin/nm",
    "-u",
    imageNormalizerPath,
  ]);
  if (/^_(?:accept|bind|connect|getaddrinfo|listen|recv(?:from|msg)?|send(?:file|msg|to)?|socket|socketpair)$/mu
    .test(imageNormalizerImports.stdout)) {
    throw new Error("Image normalizer must not import network operations.");
  }
  const gateway = await codeSignature(join(runtimeRoot, "bin/oprte-gateway"));
  if (gateway.identifier !== "oprte-gateway") {
    throw new Error("Gateway code identifier differs.");
  }
  const entitlements = await run([
    "/usr/bin/codesign",
    "--display",
    "--entitlements",
    ":-",
    join(runtimeRoot, "bin/oprte-gateway"),
  ]);
  const entitlementText = `${entitlements.stdout}\n${entitlements.stderr}`;
  if (
    !entitlementText.includes("com.apple.security.cs.allow-unsigned-executable-memory")
    || !entitlementText.includes("<true/>")
  ) {
    throw new Error("Gateway JIT entitlement is missing.");
  }
  const host = await codeSignature(join(contentsRoot, `MacOS/${macosPackage.executableName}`));
  if (host.identifier !== macosPackage.bundleIdentifier || host.teamIdentifier !== null) {
    throw new Error("Ad-hoc host code identity differs.");
  }
  await run([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    canonical,
  ]);
  const archs = (await run([
    "/usr/bin/lipo",
    "-archs",
    join(contentsRoot, `MacOS/${macosPackage.executableName}`),
  ])).stdout.trim();
  if (archs !== macosPackage.architecture) {
    throw new Error(`Host architecture differs: ${archs}`);
  }
  const codexVersion = (await run([join(runtimeRoot, "codex/bin/codex"), "--version"])).stdout.trim();
  if (codexVersion !== `codex-cli ${runtimeVersions.codex.version}`) {
    throw new Error(`Bundled Codex version differs: ${codexVersion}`);
  }
  const gitVersion = (await run([join(runtimeRoot, "git/bin/git"), "--version"])).stdout.trim();
  if (gitVersion !== `git version ${runtimeVersions.git.version}`) {
    throw new Error(`Bundled Git version differs: ${gitVersion}`);
  }
  const gitLfsVersion = (await run([
    join(runtimeRoot, "git/libexec/git-core/git-lfs"),
    "version",
  ])).stdout.trim();
  if (gitLfsVersion !== runtimeVersions.gitLfs.versionOutput) {
    throw new Error(`Bundled Git LFS version differs: ${gitLfsVersion}`);
  }
  const gitCredentialManagerVersion = (await run([
    join(runtimeRoot, "git/libexec/git-core/git-credential-manager"),
    "--version",
  ])).stdout.trim();
  if (gitCredentialManagerVersion !== runtimeVersions.gitCredentialManager.versionOutput) {
    throw new Error(
      `Bundled Git Credential Manager version differs: ${gitCredentialManagerVersion}`,
    );
  }
  const ripgrepVersion = (await run([
    join(runtimeRoot, "codex/codex-path/rg"),
    "--version",
  ])).stdout.trim();
  if (ripgrepVersion !== runtimeVersions.ripgrep.versionOutput) {
    throw new Error(`Bundled ripgrep version differs: ${ripgrepVersion}`);
  }
  return release;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

type ObservedProcess = Readonly<{
  command: string;
  pgid: number;
  pid: number;
}>;

async function processTable(): Promise<readonly ObservedProcess[]> {
  const result = await run([
    "/bin/ps",
    "-axo",
    "pid=,ppid=,pgid=,command=",
  ]);
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*([1-9][0-9]*)\s+[1-9][0-9]*\s+([1-9][0-9]*)\s+(.+)$/u.exec(line);
    if (match === null) return [];
    return [{
      command: match[3]!,
      pgid: Number(match[2]),
      pid: Number(match[1]),
    }];
  });
}

async function signalExactGatewayGroups(
  observed: ReadonlyMap<number, ObservedProcess>,
  expectedGateway: string,
  signal: NodeJS.Signals,
): Promise<void> {
  const current = new Map((await processTable()).map((entry) => [entry.pid, entry]));
  for (const prior of observed.values()) {
    const live = current.get(prior.pid);
    if (
      live === undefined
      || live.pgid !== prior.pgid
      || !live.command.includes(expectedGateway)
    ) continue;
    try {
      process.kill(-live.pgid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
  }
}

export async function launchSmokeMacOSApp(
  appPath: string,
  dwellMilliseconds = 8_000,
): Promise<void> {
  const executable = join(appPath, `Contents/MacOS/${macosPackage.executableName}`);
  const smokeRoot = await realpath(
    await mkdtemp(join(tmpdir(), "hra-package-smoke-")),
  );
  const child = Bun.spawn([executable], {
    cwd: dirname(appPath),
    detached: true,
    env: {
      ...process.env,
      HRA_PACKAGE_SMOKE_ROOT: smokeRoot,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    child.kill("SIGKILL");
    await rm(smokeRoot, { force: true, recursive: true });
    throw new Error("Package launch smoke could not establish an owned process group.");
  }
  let exited = false;
  const exit = child.exited.then((code) => {
    exited = true;
    return code;
  });
  const expectedGateway = join(
    appPath,
    "Contents/Resources/runtime/bin/oprte-gateway",
  );
  const deadline = Date.now() + dwellMilliseconds;
  const observedGateways = new Map<number, ObservedProcess>();
  let cleanupError: unknown;
  try {
    while (!exited && Date.now() < deadline) {
      for (const entry of await processTable()) {
        if (entry.command.includes(expectedGateway)) {
          observedGateways.set(entry.pid, entry);
        }
      }
      await Bun.sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    if (exited || !processExists(child.pid)) {
      const [code, stdout, stderr] = await Promise.all([
        exit,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      throw new Error(
        `Packaged app exited during launch smoke (${code}): ${stdout}\n${stderr}`,
      );
    }
    if (observedGateways.size === 0) {
      throw new Error(
        "Packaged app did not launch its bundled gateway process during the smoke window.",
      );
    }
    const markerPath = join(smokeRoot, "gateway-ready.json");
    const markerStatus = await lstat(markerPath);
    const marker = record(
      JSON.parse(await readFile(markerPath, "utf8")),
      "package smoke marker",
    );
    if (
      !markerStatus.isFile()
      || markerStatus.isSymbolicLink()
      || markerStatus.mode & 0o077
      || marker["schemaVersion"] !== 1
      || marker["bunVersion"] !== "1.3.14"
      || marker["codexVersion"] !== `codex-cli ${runtimeVersions.codex.version}`
      || marker["gitVersion"] !== `git version ${runtimeVersions.git.version}`
    ) {
      throw new Error("Packaged gateway did not prove its isolated runtime identity.");
    }
  } finally {
    try {
      if (!exited) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            cleanupError = error;
          }
        }
      }
      await signalExactGatewayGroups(observedGateways, expectedGateway, "SIGTERM");
      const settled = await Promise.race([
        exit.then(() => true),
        Bun.sleep(3_000).then(() => false),
      ]);
      if (!settled) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            cleanupError = error;
          }
        }
        await signalExactGatewayGroups(observedGateways, expectedGateway, "SIGKILL");
        await exit;
      } else {
        await Bun.sleep(250);
        await signalExactGatewayGroups(observedGateways, expectedGateway, "SIGKILL");
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await rm(smokeRoot, { force: true, recursive: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) {
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error("Package launch smoke cleanup failed.");
  }
}

export async function verifyMacOSDmg(
  dmgPath: string,
  options: Readonly<{ launchSmoke?: boolean }> = {},
): Promise<MacOSAppEvidence> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hra-dmg-verify-"));
  const mountPoint = join(temporaryRoot, "mount");
  await Bun.write(join(temporaryRoot, ".keep"), "");
  await run(["/bin/mkdir", mountPoint]);
  let attached = false;
  let evidence: MacOSAppEvidence | undefined;
  try {
    await run([
      "/usr/bin/hdiutil",
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountPoint,
      dmgPath,
    ]);
    attached = true;
    const entries = (await readdir(mountPoint)).sort();
    if (JSON.stringify(entries) !== JSON.stringify(["Applications", "HRA.app"])) {
      throw new Error(`DMG root differs: ${entries.join(", ")}`);
    }
    const applications = await lstat(join(mountPoint, "Applications"));
    if (!applications.isSymbolicLink() || await readlink(join(mountPoint, "Applications")) !== "/Applications") {
      throw new Error("DMG Applications link differs.");
    }
    const mountedApp = join(mountPoint, "HRA.app");
    evidence = await verifyMacOSApp(mountedApp);
    if (options.launchSmoke === true) {
      await launchSmokeMacOSApp(mountedApp);
    }
  } finally {
    if (attached) {
      await run(["/usr/bin/hdiutil", "detach", mountPoint], { allowFailure: true });
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
  if (evidence === undefined) {
    throw new Error("DMG verification produced no application evidence.");
  }
  return evidence;
}

export async function verifyMacOSReleaseArtifacts(
  releaseDirectory = macosPackage.releaseDirectory,
): Promise<void> {
  const status = await lstat(releaseDirectory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Release path must be a real directory: ${releaseDirectory}`);
  }
  const dmgName = `${macosPackage.artifactBaseName}.dmg`;
  const checksumName = `${dmgName}.sha256`;
  const manifestName =
    `HRA-${macosPackage.version}-${macosPackage.build}-release-manifest.json`;
  const expectedEntries = [
    checksumName,
    dmgName,
    manifestName,
    ...correspondingSourceSpecs.map((spec) => spec.archiveName),
  ].sort();
  const entries = (await readdir(releaseDirectory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`Release artifact set differs: ${entries.join(", ")}`);
  }
  await verifyRegularReleaseEntries(releaseDirectory, expectedEntries);

  const { dmgEvidence, dmgSha256, dmgStatus } = await verifyDmgAndChecksum(
    releaseDirectory,
  );
  const rawManifest: unknown = JSON.parse(
    await readFile(join(releaseDirectory, manifestName), "utf8"),
  );
  const manifest = record(rawManifest, "release manifest");
  if (manifest["schemaVersion"] !== 1) {
    throw new Error("Release manifest schema is unsupported.");
  }
  const artifact = record(manifest["artifact"], "release artifact");
  if (
    artifact["name"] !== dmgName
    || artifact["sha256"] !== dmgSha256
    || number(artifact["bytes"], "release artifact bytes") !== dmgStatus.size
  ) {
    throw new Error("Release artifact evidence differs from the DMG.");
  }
  const release = record(manifest["release"], "release identity");
  if (
    release["architecture"] !== macosPackage.architecture
    || number(release["build"], "release build") !== macosPackage.build
    || release["commit"] !== dmgEvidence.commit
    || release["minimumMacOS"] !== macosPackage.minimumMacOS
    || release["notarized"] !== false
    || release["signing"] !== "adhoc"
    || release["version"] !== macosPackage.version
  ) {
    throw new Error("Release identity differs from the mounted app.");
  }
  const rawSources = manifest["correspondingSources"];
  if (!Array.isArray(rawSources) || rawSources.length !== correspondingSourceSpecs.length) {
    throw new Error("Release corresponding-source evidence differs.");
  }
  for (const [index, spec] of correspondingSourceSpecs.entries()) {
    const recorded = record(rawSources[index], `corresponding source ${index}`);
    const actual = await verifyCorrespondingSourceArchive(
      join(releaseDirectory, spec.archiveName),
      spec,
    );
    if (
      spec.project === "Bun"
      && actual.sha256 !== runtimeVersions.bun.completeSourceArchiveSha256
    ) {
      throw new Error("Bun complete corresponding-source hash differs from its runtime pin.");
    }
    if (
      recorded["archiveName"] !== actual.archiveName
      || number(recorded["bytes"], `corresponding source ${index} bytes`) !== actual.bytes
      || recorded["commit"] !== actual.commit
      || recorded["project"] !== actual.project
      || recorded["repository"] !== actual.repository
      || recorded["sha256"] !== actual.sha256
      || JSON.stringify(recorded["externalSources"])
        !== JSON.stringify(actual.externalSources)
      || JSON.stringify(recorded["submodules"]) !== JSON.stringify(actual.submodules)
    ) {
      throw new Error(`${spec.project} corresponding-source evidence differs.`);
    }
  }
  if (
    manifest["runtimeTreeSha256"] !== dmgEvidence.treeSha256
    || manifest["sourceTreeCleanAtPackaging"] !== true
    || JSON.stringify(manifest["runtimeManifest"])
      !== JSON.stringify(dmgEvidence.runtimeManifest)
  ) {
    throw new Error("Release provenance differs from the mounted app.");
  }
}

async function verifyDmgAndChecksum(
  releaseDirectory: string,
): Promise<Readonly<{
  dmgEvidence: MacOSAppEvidence;
  dmgSha256: string;
  dmgStatus: Awaited<ReturnType<typeof lstat>>;
}>> {
  const dmgName = `${macosPackage.artifactBaseName}.dmg`;
  const dmgPath = join(releaseDirectory, dmgName);
  const checksumName = `${dmgName}.sha256`;
  const dmgStatus = await lstat(dmgPath);
  if (!dmgStatus.isFile() || dmgStatus.isSymbolicLink()) {
    throw new Error("Release DMG must be a regular file.");
  }
  const dmgSha256 = await sha256File(dmgPath);
  const checksum = await readFile(join(releaseDirectory, checksumName), "utf8");
  if (checksum !== `${dmgSha256}  ${dmgName}\n`) {
    throw new Error("Release checksum file differs from the DMG.");
  }
  return {
    dmgEvidence: await verifyMacOSDmg(dmgPath),
    dmgSha256,
    dmgStatus,
  };
}

export async function verifyMacOSCoreArtifacts(
  releaseDirectory = macosPackage.releaseDirectory,
): Promise<void> {
  const status = await lstat(releaseDirectory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Release path must be a real directory: ${releaseDirectory}`);
  }
  const dmgName = `${macosPackage.artifactBaseName}.dmg`;
  const expectedEntries = [`${dmgName}.sha256`, dmgName].sort();
  const entries = (await readdir(releaseDirectory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`Core package artifact set differs: ${entries.join(", ")}`);
  }
  await verifyRegularReleaseEntries(releaseDirectory, expectedEntries);
  await verifyDmgAndChecksum(releaseDirectory);
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const appPath = resolve(argumentValue("--app") ?? macosPackage.appBundlePath);
  const coreReleaseDirectory = argumentValue("--core-release-directory");
  const dmg = argumentValue("--dmg");
  const releaseDirectory = argumentValue("--release-directory");
  const launchSmoke = process.argv.includes("--launch-smoke");
  if (coreReleaseDirectory !== undefined) {
    if (
      releaseDirectory !== undefined
      || dmg !== undefined
      || process.argv.includes("--app")
      || launchSmoke
    ) {
      throw new Error("Core release verification cannot be combined with app, DMG, release, or launch options.");
    }
    const resolvedCoreReleaseDirectory = resolve(coreReleaseDirectory);
    await verifyMacOSCoreArtifacts(resolvedCoreReleaseDirectory);
    process.stdout.write(`${resolvedCoreReleaseDirectory}\n`);
    return;
  }
  if (releaseDirectory !== undefined) {
    if (dmg !== undefined || process.argv.includes("--app") || launchSmoke) {
      throw new Error("Release-directory verification cannot be combined with app, DMG, or launch options.");
    }
    const resolvedReleaseDirectory = resolve(releaseDirectory);
    await verifyMacOSReleaseArtifacts(resolvedReleaseDirectory);
    process.stdout.write(`${resolvedReleaseDirectory}\n`);
    return;
  }
  if (dmg === undefined) {
    await verifyMacOSApp(appPath);
    if (launchSmoke) await launchSmokeMacOSApp(appPath);
    process.stdout.write(`${appPath}\n`);
    return;
  }
  const dmgPath = resolve(dmg);
  if (basename(dmgPath) !== `${macosPackage.artifactBaseName}.dmg`) {
    throw new Error(`Unexpected DMG name: ${basename(dmgPath)}`);
  }
  await verifyMacOSDmg(dmgPath, { launchSmoke });
  process.stdout.write(`${dmgPath}\n`);
}

if (import.meta.main) await main();
