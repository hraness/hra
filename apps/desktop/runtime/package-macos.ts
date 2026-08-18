import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { loadBunNativeLicenseInventory } from "./bun-native-licenses";
import {
  type CodexNativeLicenseInventory,
  loadCodexNativeLicenseInventory,
  verifyInstalledCodexNativePayloads,
} from "./codex-native-licenses";
import {
  codexSignatureNormalizationEntry,
  codexSignatureNormalizationManifestEntries,
  codexSignatureNormalizationPolicy,
  createCodexSignatureSourceDelta,
  verifyCodexSignatureNormalizationInventory,
  verifyCodexSignatureNormalizationPackaged,
  verifyCodexSignatureNormalizationSource,
} from "./codex-signature-normalization";
import { verifyPackagedFrontend } from "./frontend-package-integrity";
import { loadGcmDependencyLicenseInventory } from "./gcm-dependency-licenses";
import {
  hranessUiStylesheetInput,
  macosPackage,
  requiredLicenseFileNames,
  trustedThirdPartyTeams,
} from "./macos-package-config";
import { inspectReleaseSourceRepository } from "./release-provenance";
import runtimeVersions from "./runtime-versions.json";
import {
  createShippedJavaScriptLicenseInventory,
  renderShippedJavaScriptLicenseNotices,
  serializeShippedJavaScriptLicenseInventory,
  verifyShippedJavaScriptLicenseInventory,
} from "./shipped-javascript-licenses";
import { verifyRuntimePins } from "./verify-runtime-pins";

type CommandResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type CodeSignature = Readonly<{
  cdHash: string | null;
  flags: readonly string[];
  identifier: string | null;
  signatureKind: string | null;
  teamIdentifier: string | null;
}>;

type RuntimeTreeEntry = Readonly<{
  path: string;
  sha256?: string;
  target?: string;
  type: "file" | "symlink";
}>;

const appRoot = macosPackage.appBundlePath;
const contentsRoot = join(appRoot, "Contents");
const resourcesRoot = join(contentsRoot, "Resources");
const runtimeRoot = join(resourcesRoot, "runtime");
const binRoot = join(runtimeRoot, "bin");
const licensesRoot = join(runtimeRoot, "licenses");
const infoPlist = join(contentsRoot, "Info.plist");
const gatewayEntitlements = join(
  macosPackage.desktopRoot,
  "runtime/gateway.release.entitlements.plist",
);

const ownedCode = Object.freeze([
  {
    identifier: "oprte-data-remover",
    path: join(binRoot, "oprte-data-remover"),
  },
  {
    identifier: "oprte-git-executor",
    path: join(binRoot, "oprte-git-executor"),
  },
  {
    identifier: "oprte-keychain-custodian",
    path: join(binRoot, "oprte-keychain-custodian"),
  },
  {
    entitlements: gatewayEntitlements,
    identifier: "oprte-gateway",
    path: join(binRoot, "oprte-gateway"),
  },
  {
    identifier: macosPackage.bundleIdentifier,
    path: join(contentsRoot, `MacOS/${macosPackage.executableName}`),
  },
] as const);

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    !fromRoot.startsWith(`..${sep}`)
    && fromRoot !== ".."
    && !fromRoot.startsWith(sep)
  );
}

async function requireRealDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${path}`);
  }
}

async function run(
  argv: readonly string[],
  options: Readonly<{ allowFailure?: boolean }> = {},
): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    cwd: macosPackage.desktopRoot,
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

async function sha256(path: string): Promise<string> {
  const file = await open(path, "r");
  const hasher = createHash("sha256");
  try {
    for await (const chunk of file.readableWebStream()) {
      hasher.update(chunk as Uint8Array);
    }
  } finally {
    await file.close();
  }
  return hasher.digest("hex");
}

async function setPlist(
  key: string,
  type: "bool" | "string",
  value: string,
): Promise<void> {
  const replace = await run([
    "/usr/bin/plutil",
    "-replace",
    key,
    `-${type}`,
    value,
    infoPlist,
  ], { allowFailure: true });
  if (replace.exitCode === 0) return;
  await run([
    "/usr/bin/plutil",
    "-insert",
    key,
    `-${type}`,
    value,
    infoPlist,
  ]);
}

async function removePlistKey(key: string): Promise<void> {
  await run([
    "/usr/bin/plutil",
    "-remove",
    key,
    infoPlist,
  ], { allowFailure: true });
}

async function copyExclusive(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function stageLicenseFiles(options: Readonly<{
  codexPackageRoot: string;
  codexPlatformPackageJson: string;
  gitPackageRoot: string;
  gitRoot: string;
}>): Promise<CodexNativeLicenseInventory> {
  const repositoryRoot = resolve(macosPackage.desktopRoot, "../..");
  await loadGcmDependencyLicenseInventory({
    gcmRoot: join(options.gitRoot, "libexec/git-core"),
  });
  await loadBunNativeLicenseInventory();
  const codexNativeInventory = await loadCodexNativeLicenseInventory();
  await verifyInstalledCodexNativePayloads(
    codexNativeInventory,
    dirname(options.codexPlatformPackageJson),
  );
  const hranessUiRoot = join(macosPackage.desktopRoot, "node_modules/@hraness/ui");
  const hranessUiInputs = new Map<string, string>([
    ["checked license", join(macosPackage.desktopRoot, "runtime/HRANESS-UI-LICENSE.txt")],
    ["license", join(hranessUiRoot, "LICENSE")],
    ["manifest", join(hranessUiRoot, "package.json")],
    ["stylesheet", join(hranessUiRoot, "src/components.css")],
  ]);
  const hranessUiExpected = new Map<string, string>([
    ["checked license", hranessUiStylesheetInput.licenseSha256],
    ["license", hranessUiStylesheetInput.licenseSha256],
    ["manifest", hranessUiStylesheetInput.packageJsonSha256],
    ["stylesheet", hranessUiStylesheetInput.stylesheetSha256],
  ]);
  for (const [label, path] of hranessUiInputs) {
    const actual = await sha256(path);
    const expected = hranessUiExpected.get(label);
    if (actual !== expected) {
      throw new Error(`hraness/ui ${label} hash differs: ${actual}`);
    }
  }
  const sources = new Map<string, string>([
    ["BUN-DEPENDENCY-LICENSES.json", join(macosPackage.desktopRoot, "runtime/BUN-DEPENDENCY-LICENSES.json")],
    ["BUN-DEPENDENCY-LICENSES.txt", join(macosPackage.desktopRoot, "runtime/BUN-DEPENDENCY-LICENSES.txt")],
    ["BUN-LICENSE.md", join(macosPackage.desktopRoot, "runtime/BUN-LICENSE.md")],
    ["BUN-PROVENANCE.md", join(macosPackage.desktopRoot, "runtime/BUN-PROVENANCE.md")],
    ["CODEX-APP-SDK-LICENSE.txt", join(repositoryRoot, "packages/internal/codex-app-sdk/LICENSE")],
    ["CODEX-LICENSE.txt", join(macosPackage.desktopRoot, "runtime/CODEX-LICENSE.txt")],
    ["CODEX-NATIVE-LICENSES.json", join(macosPackage.desktopRoot, "runtime/CODEX-NATIVE-LICENSES.json")],
    ["CODEX-NATIVE-LICENSES.txt", join(macosPackage.desktopRoot, "runtime/CODEX-NATIVE-LICENSES.txt")],
    ["CODEX-NOTICE.txt", join(macosPackage.desktopRoot, "runtime/CODEX-NOTICE.txt")],
    ["CODEX-SIGNATURE-NORMALIZATION.md", join(macosPackage.desktopRoot, "runtime/CODEX-SIGNATURE-NORMALIZATION.md")],
    ["CODEX-package.json", join(options.codexPackageRoot, "package.json")],
    ["CODEX-platform-package.json", options.codexPlatformPackageJson],
    ["DESKTOP-THIRD-PARTY-NOTICES.md", join(macosPackage.desktopRoot, "runtime/THIRD_PARTY_NOTICES.md")],
    ["DUGITE-LICENSE.txt", join(options.gitPackageRoot, "LICENSE")],
    ["EVILCHARTS-LICENSE.txt", join(repositoryRoot, "packages/internal/design-kit/vendor/evilcharts/LICENSE")],
    ["EVILCHARTS-UPSTREAM.md", join(repositoryRoot, "packages/internal/design-kit/vendor/evilcharts/UPSTREAM.md")],
    ["GEIST-MONO-OFL.txt", join(repositoryRoot, "packages/internal/design-kit/src/fonts/geist-mono/OFL.txt")],
    ["GEIST-MONO-PROVENANCE.md", join(repositoryRoot, "packages/internal/design-kit/src/fonts/geist-mono/PROVENANCE.md")],
    ["GEIST-OFL.txt", join(repositoryRoot, "packages/internal/design-kit/src/fonts/geist/OFL.txt")],
    ["GEIST-PROVENANCE.md", join(repositoryRoot, "packages/internal/design-kit/src/fonts/geist/PROVENANCE.md")],
    ["GCM-DEPENDENCY-LICENSES.json", join(macosPackage.desktopRoot, "runtime/GCM-DEPENDENCY-LICENSES.json")],
    ["GCM-DEPENDENCY-LICENSES.txt", join(macosPackage.desktopRoot, "runtime/GCM-DEPENDENCY-LICENSES.txt")],
    ["GIT-COPYING.txt", join(macosPackage.desktopRoot, "runtime/GIT-COPYING.txt")],
    ["GIT-CORRESPONDING-SOURCE.txt", join(macosPackage.desktopRoot, "runtime/GIT-CORRESPONDING-SOURCE.txt")],
    ["GIT-CREDENTIAL-MANAGER-LICENSE.txt", join(macosPackage.desktopRoot, "runtime/GIT-CREDENTIAL-MANAGER-LICENSE.txt")],
    ["GIT-CREDENTIAL-MANAGER-NOTICE.txt", join(options.gitRoot, "libexec/git-core/NOTICE")],
    ["GIT-CREDENTIAL-MANAGER-PROVENANCE.md", join(macosPackage.desktopRoot, "runtime/GIT-CREDENTIAL-MANAGER-PROVENANCE.md")],
    ["GIT-LFS-LICENSE.md", join(macosPackage.desktopRoot, "runtime/GIT-LFS-LICENSE.md")],
    ["GIT-LFS-PROVENANCE.md", join(macosPackage.desktopRoot, "runtime/GIT-LFS-PROVENANCE.md")],
    ["HRANESS-UI-LICENSE.txt", join(macosPackage.desktopRoot, "runtime/HRANESS-UI-LICENSE.txt")],
    ["HRANESS-UI-PROVENANCE.md", join(macosPackage.desktopRoot, "runtime/HRANESS-UI-PROVENANCE.md")],
    ["HRA-LICENSE.txt", join(repositoryRoot, "LICENSE")],
    ["JAVASCRIPT-LICENSE-OVERRIDES.md", join(macosPackage.desktopRoot, "runtime/JAVASCRIPT-LICENSE-OVERRIDES.md")],
    ["JELLY-UI-LICENSE.txt", join(repositoryRoot, "packages/internal/design-kit/vendor/jelly-ui/LICENSE")],
    ["JELLY-UI-UPSTREAM.md", join(repositoryRoot, "packages/internal/design-kit/vendor/jelly-ui/UPSTREAM.md")],
    ["NATIVE-SDK-LICENSE.txt", join(macosPackage.desktopRoot, "node_modules/@native-sdk/cli/LICENSE")],
    ["NOTO-PHOENIX-LICENSE.txt", join(repositoryRoot, "assets/brand/phoenix/LICENSE")],
    ["NOTO-PHOENIX-PROVENANCE.md", join(repositoryRoot, "assets/brand/phoenix/PROVENANCE.md")],
    ["PCRE2-LICENCE.md", join(macosPackage.desktopRoot, "runtime/PCRE2-LICENCE.md")],
    ["RIPGREP-COPYING.txt", join(macosPackage.desktopRoot, "runtime/RIPGREP-COPYING.txt")],
    ["RIPGREP-LICENSE-MIT.txt", join(macosPackage.desktopRoot, "runtime/RIPGREP-LICENSE-MIT.txt")],
    ["RIPGREP-PROVENANCE.md", join(macosPackage.desktopRoot, "runtime/RIPGREP-PROVENANCE.md")],
    ["RIPGREP-UNLICENSE.txt", join(macosPackage.desktopRoot, "runtime/RIPGREP-UNLICENSE.txt")],
    ["ROOT-THIRD-PARTY-NOTICES.md", join(repositoryRoot, "THIRD_PARTY_NOTICES.md")],
    ["RUNTIME-VERSIONS.json", join(macosPackage.desktopRoot, "runtime/runtime-versions.json")],
    ["SPDX-MIT-LICENSE.txt", join(macosPackage.desktopRoot, "runtime/SPDX-MIT-LICENSE.txt")],
    ["embedded-git.json", join(options.gitPackageRoot, "script/embedded-git.json")],
  ]);
  for (const [name, source] of sources) {
    await copyExclusive(source, join(licensesRoot, name));
  }

  const shippedPackages = await createShippedJavaScriptLicenseInventory();
  verifyShippedJavaScriptLicenseInventory(shippedPackages);
  await writeFile(
    join(licensesRoot, "SHIPPED-JAVASCRIPT-LICENSES.json"),
    serializeShippedJavaScriptLicenseInventory(shippedPackages),
    { flag: "wx" },
  );
  await writeFile(
    join(licensesRoot, "SHIPPED-JAVASCRIPT-LICENSES.txt"),
    renderShippedJavaScriptLicenseNotices(shippedPackages),
    { flag: "wx" },
  );
  const actual = (await readdir(licensesRoot)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...requiredLicenseFileNames])) {
    throw new Error(`Packaged license set differs: ${actual.join(", ")}`);
  }
  return codexNativeInventory;
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
        if (target.startsWith("/")) {
          throw new Error(`Absolute runtime symlink is forbidden: ${relativePath}`);
        }
        const resolvedTarget = resolve(dirname(path), target);
        if (!inside(root, resolvedTarget)) {
          throw new Error(`Runtime symlink escapes its root: ${relativePath}`);
        }
        entries.push({ path: relativePath, target, type: "symlink" });
      } else if (child.isDirectory()) {
        await visit(path);
      } else if (child.isFile()) {
        entries.push({ path: relativePath, sha256: await sha256(path), type: "file" });
      } else {
        throw new Error(`Special runtime file is forbidden: ${relativePath}`);
      }
    }
  }
  await visit(root);
  return entries;
}

async function isMachO(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  const bytes = Buffer.alloc(4);
  try {
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) return false;
  } finally {
    await handle.close();
  }
  return new Set([
    "cafebabe",
    "cafebabf",
    "cefaedfe",
    "cffaedfe",
    "feedface",
    "feedfacf",
  ]).has(bytes.toString("hex"));
}

async function codeSignature(path: string): Promise<CodeSignature> {
  const result = await run([
    "/usr/bin/codesign",
    "--display",
    "--verbose=4",
    path,
  ], { allowFailure: true });
  const details = `${result.stdout}\n${result.stderr}`;
  const value = (pattern: RegExp): string | null =>
    pattern.exec(details)?.[1]?.trim() ?? null;
  const rawTeam = value(/^TeamIdentifier=(.+)$/mu);
  const rawFlags = value(/^CodeDirectory .* flags=0x[0-9a-fA-F]+\(([^)]*)\)/mu);
  return {
    cdHash: value(/^CDHash=([0-9a-fA-F]+)$/mu)?.toLowerCase() ?? null,
    flags: rawFlags === null || rawFlags.length === 0 ? [] : rawFlags.split(","),
    identifier: value(/^Identifier=(.+)$/mu),
    signatureKind: value(/^Signature=(.+)$/mu),
    teamIdentifier: rawTeam === "not set" ? null : rawTeam,
  };
}

async function signAdHoc(
  path: string,
  options: Readonly<{ entitlements?: string; identifier?: string }> = {},
): Promise<void> {
  await run([
    "/usr/bin/codesign",
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    ...(options.identifier === undefined
      ? []
      : ["--identifier", options.identifier]),
    ...(options.entitlements === undefined
      ? []
      : ["--entitlements", options.entitlements]),
    path,
  ]);
}

async function normalizeCodexSignatures(
  inventory: CodexNativeLicenseInventory,
  sourceVendorRoot: string,
): Promise<ReturnType<typeof codexSignatureNormalizationManifestEntries>> {
  verifyCodexSignatureNormalizationInventory(inventory);
  for (const entry of codexSignatureNormalizationPolicy.entries) {
    const path = join(runtimeRoot, "codex", entry.payloadPath);
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new Error(
        `Codex normalization source must be a regular single-link file: ${entry.payloadPath}`,
      );
    }
    verifyCodexSignatureNormalizationSource(entry, {
      sha256: await sha256(path),
      signature: await codeSignature(path),
      size: status.size,
    });
    const sourceStrict = await run([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "--verbose=6",
      path,
    ], { allowFailure: true });
    process.stdout.write(
      `Codex source signature ${entry.payloadPath}: strict ${sourceStrict.exitCode === 0 ? "accepted" : "rejected"}; applying reviewed deterministic normalization.\n`,
    );
    await signAdHoc(path, { identifier: entry.source.identifier });
    const packagedStatus = await lstat(path);
    verifyCodexSignatureNormalizationPackaged(entry, {
      sha256: await sha256(path),
      signature: await codeSignature(path),
      size: packagedStatus.size,
    });
    await run([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "--verbose=6",
      path,
    ]);
    const delta = await createCodexSignatureSourceDelta(
      join(sourceVendorRoot, entry.payloadPath),
      path,
    );
    const deltaSha256 = createHash("sha256").update(delta).digest("hex");
    if (
      delta.byteLength !== entry.sourceDelta.size
      || deltaSha256 !== entry.sourceDelta.sha256
    ) {
      throw new Error(
        `Codex signature source delta differs: ${entry.payloadPath}`,
      );
    }
    const deltaPath = resolve(appRoot, entry.sourceDelta.path);
    if (!inside(appRoot, deltaPath)) {
      throw new Error(`Codex signature source delta escaped the app: ${entry.payloadPath}`);
    }
    await mkdir(dirname(deltaPath), { recursive: true, mode: 0o755 });
    await writeFile(deltaPath, delta, { flag: "wx", mode: 0o644 });
  }
  return codexSignatureNormalizationManifestEntries();
}

async function signRuntimeTree(
  preserveExactSignedPaths: ReadonlySet<string>,
): Promise<ReadonlyArray<Readonly<{
  path: string;
  teamIdentifier: string;
}>>> {
  const preserved: Array<Readonly<{ path: string; teamIdentifier: string }>> = [];
  const ownedPaths = new Set(ownedCode.map((entry) => entry.path));
  const files = (await walkTree(runtimeRoot))
    .filter((entry) => entry.type === "file" && entry.path !== "manifest.json")
    .map((entry) => join(runtimeRoot, entry.path));
  const machOFiles: string[] = [];
  for (const path of files) {
    if (await isMachO(path)) machOFiles.push(path);
  }
  machOFiles.sort((left, right) => right.split(sep).length - left.split(sep).length || left.localeCompare(right));
  for (const path of machOFiles) {
    if (ownedPaths.has(path)) continue;
    const signature = await codeSignature(path);
    if (preserveExactSignedPaths.has(path)) {
      if (
        signature.identifier === null
        || !/^[0-9a-f]{40,64}$/u.test(signature.cdHash ?? "")
      ) {
        throw new Error(`Exact Codex payload lacks a valid signature: ${path}`);
      }
      await run(["/usr/bin/codesign", "--verify", "--strict", path]);
      if (signature.teamIdentifier !== null) {
        if (!trustedThirdPartyTeams.has(signature.teamIdentifier)) {
          throw new Error(
            `Unexpected third-party signing team ${signature.teamIdentifier}: ${path}`,
          );
        }
        preserved.push({
          path: relative(appRoot, path).split(sep).join("/"),
          teamIdentifier: signature.teamIdentifier,
        });
      }
      continue;
    }
    if (signature.teamIdentifier !== null) {
      if (!trustedThirdPartyTeams.has(signature.teamIdentifier)) {
        throw new Error(
          `Unexpected third-party signing team ${signature.teamIdentifier}: ${path}`,
        );
      }
      await run(["/usr/bin/codesign", "--verify", "--strict", path]);
      preserved.push({
        path: relative(appRoot, path).split(sep).join("/"),
        teamIdentifier: signature.teamIdentifier,
      });
      continue;
    }
    await signAdHoc(path);
  }
  for (const entry of ownedCode) {
    await signAdHoc(entry.path, entry);
  }
  return preserved.sort((left, right) => left.path.localeCompare(right.path));
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("HRA macOS packaging requires Apple Silicon macOS.");
  }
  const sourceRepository = await inspectReleaseSourceRepository();
  await requireRealDirectory(appRoot);
  const canonicalPackageRoot = await realpath(join(macosPackage.desktopRoot, "zig-out/package"));
  const canonicalAppRoot = await realpath(appRoot);
  if (!inside(canonicalPackageRoot, canonicalAppRoot) || !canonicalAppRoot.endsWith(".app")) {
    throw new Error("Refusing to mutate an app outside the exact package root.");
  }
  await verifyPackagedFrontend({
    packageDirectory: join(resourcesRoot, "frontend/dist"),
    sourceDirectory: join(macosPackage.desktopRoot, "frontend/dist"),
  });

  const pins = await verifyRuntimePins();
  await rm(runtimeRoot, { force: true, recursive: true });
  await mkdir(binRoot, { recursive: true, mode: 0o755 });
  await mkdir(licensesRoot, { recursive: true, mode: 0o755 });
  await Promise.all([
    copyExclusive(join(macosPackage.desktopRoot, "runtime/dist/oprte-gateway"), join(binRoot, "oprte-gateway")),
    copyExclusive(join(macosPackage.desktopRoot, "zig-out/bin/oprte-data-remover"), join(binRoot, "oprte-data-remover")),
    copyExclusive(join(macosPackage.desktopRoot, "zig-out/bin/oprte-git-executor"), join(binRoot, "oprte-git-executor")),
    copyExclusive(join(macosPackage.desktopRoot, "zig-out/bin/oprte-keychain-custodian"), join(binRoot, "oprte-keychain-custodian")),
    cp(pins.codexVendorRoot, join(runtimeRoot, "codex"), {
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    }),
    cp(pins.gitRoot, join(runtimeRoot, "git"), {
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    }),
  ]);
  await Promise.all(ownedCode.slice(0, 4).map((entry) => chmod(entry.path, 0o755)));
  const codexNativeInventory = await stageLicenseFiles({
    codexPackageRoot: pins.codexPackageRoot,
    codexPlatformPackageJson: pins.codexPlatformPackageJson,
    gitPackageRoot: pins.gitPackageRoot,
    gitRoot: pins.gitRoot,
  });

  await setPlist("CFBundleExecutable", "string", macosPackage.executableName);
  await setPlist("CFBundleIdentifier", "string", macosPackage.bundleIdentifier);
  await setPlist("CFBundleName", "string", macosPackage.productName);
  await setPlist("CFBundleDisplayName", "string", macosPackage.displayName);
  await setPlist("CFBundleShortVersionString", "string", macosPackage.version);
  await setPlist("CFBundleVersion", "string", String(macosPackage.build));
  await setPlist("LSMinimumSystemVersion", "string", macosPackage.minimumMacOS);
  for (const key of [
    "SUAllowsAutomaticUpdates",
    "SUAutomaticallyUpdate",
    "SUEnableAutomaticChecks",
    "SUFeedURL",
    "SUPublicEDKey",
    "SURequireSignedFeed",
    "SUSignedFeedFailureExpirationInterval",
    "SUVerifyUpdateBeforeExtraction",
  ]) {
    await removePlistKey(key);
  }

  const exactCodexPayloadPaths = new Set(
    codexNativeInventory.platformPackage.payloads.map((payload) =>
      join(runtimeRoot, "codex", payload.path)),
  );
  const normalizedSignatures = await normalizeCodexSignatures(
    codexNativeInventory,
    pins.codexVendorRoot,
  );
  const preservedSignatures = await signRuntimeTree(exactCodexPayloadPaths);
  const dataRemoverSignature = await codeSignature(join(binRoot, "oprte-data-remover"));
  if (!/^[0-9a-f]{40,64}$/u.test(dataRemoverSignature.cdHash ?? "")) {
    throw new Error("The data remover has no valid CodeDirectory hash.");
  }
  await setPlist(
    "KitchenExpectedDataRemoverCDHashV1",
    "string",
    dataRemoverSignature.cdHash!,
  );

  const runtimeTree = (await walkTree(runtimeRoot))
    .filter((entry) => entry.path !== "manifest.json");
  const runtimeTreeSha256 = createHash("sha256")
    .update(`${JSON.stringify(runtimeTree)}\n`, "utf8")
    .digest("hex");
  const manifest = {
    schemaVersion: 1,
    release: {
      architecture: macosPackage.architecture,
      build: macosPackage.build,
      commit: sourceRepository.commit,
      minimumMacOS: macosPackage.minimumMacOS,
      signing: "adhoc",
      version: macosPackage.version,
    },
    runtime: {
      codex: {
        binarySha256: await sha256(join(runtimeRoot, "codex/bin/codex")),
        dependencyLicenseInventorySha256:
          runtimeVersions.codex.dependencyLicenseInventorySha256,
        dependencyLicenseNoticesSha256:
          runtimeVersions.codex.dependencyLicenseNoticesSha256,
        sourceBinarySha256:
          codexSignatureNormalizationEntry("bin/codex").source.sha256,
        sourceCommit: runtimeVersions.codex.sourceCommit,
        version: runtimeVersions.codex.version,
      },
      dataRemover: {
        cdHash: dataRemoverSignature.cdHash,
        sha256: await sha256(join(binRoot, "oprte-data-remover")),
      },
      gateway: {
        bunVersion: pins.bunCompiler.version,
        compilerBinarySha256: pins.bunCompiler.binarySha256,
        compilerReleaseAssetSha256: runtimeVersions.bun.releaseAssetSha256,
        compilerSourceCommit: runtimeVersions.bun.sourceCommit,
        completeSourceArchiveSha256: runtimeVersions.bun.completeSourceArchiveSha256,
        dependencyLicenseInventorySha256:
          runtimeVersions.bun.dependencyLicenseInventorySha256,
        dependencyLicenseNoticesSha256:
          runtimeVersions.bun.dependencyLicenseNoticesSha256,
        sha256: await sha256(join(binRoot, "oprte-gateway")),
      },
      git: {
        assetSha256: runtimeVersions.git.assetSha256,
        binarySha256: await sha256(join(runtimeRoot, "git/bin/git")),
        version: runtimeVersions.git.version,
      },
      gitCredentialManager: {
        binarySha256: await sha256(
          join(runtimeRoot, "git/libexec/git-core/git-credential-manager"),
        ),
        licenseSha256: runtimeVersions.gitCredentialManager.licenseSha256,
        noticeSha256: runtimeVersions.gitCredentialManager.noticeSha256,
        depsJsonSha256: runtimeVersions.gitCredentialManager.depsJsonSha256,
        dependencyLicenseInventorySha256:
          runtimeVersions.gitCredentialManager.dependencyLicenseInventorySha256,
        dependencyLicenseNoticesSha256:
          runtimeVersions.gitCredentialManager.dependencyLicenseNoticesSha256,
        dotnetRuntimeSourceCommit:
          runtimeVersions.gitCredentialManager.dotnetRuntimeSourceCommit,
        dotnetRuntimeVersion: runtimeVersions.gitCredentialManager.dotnetRuntimeVersion,
        runtimeConfigSha256: runtimeVersions.gitCredentialManager.runtimeConfigSha256,
        sourceCommit: runtimeVersions.gitCredentialManager.sourceCommit,
        version: runtimeVersions.gitCredentialManager.version,
      },
      gitExecutor: {
        sha256: await sha256(join(binRoot, "oprte-git-executor")),
      },
      keychainCustodian: {
        sha256: await sha256(join(binRoot, "oprte-keychain-custodian")),
      },
      gitLfs: {
        binarySha256: await sha256(join(runtimeRoot, "git/libexec/git-core/git-lfs")),
        licenseSha256: runtimeVersions.gitLfs.licenseSha256,
        sourceCommit: runtimeVersions.gitLfs.sourceCommit,
        version: runtimeVersions.gitLfs.version,
      },
      normalizedSignatures,
      preservedSignatures,
      ripgrep: {
        binarySha256: await sha256(join(runtimeRoot, "codex/codex-path/rg")),
        pcre2LicenseSha256: runtimeVersions.ripgrep.pcre2.licenseSha256,
        sourceCommit: runtimeVersions.ripgrep.sourceCommit,
        version: runtimeVersions.ripgrep.version,
      },
      treeSha256: runtimeTreeSha256,
    },
  } as const;
  await writeFile(
    join(runtimeRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );

  await signAdHoc(appRoot);
  await run([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    appRoot,
  ]);
  process.stdout.write(`${appRoot}\n`);
}

if (import.meta.main) await main();
