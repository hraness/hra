#!/usr/bin/env bun

import {
  PINNED_BUN_VERSION,
  RELEASE_CHECKSUM_FILE,
  RELEASE_INSTALLER_FILE,
  RELEASE_MANIFEST_FILE,
  RELEASE_PRODUCT,
  RELEASE_SCHEMA_VERSION,
  artifactFilename,
  releaseTargetForRuntime,
  releaseTargets,
  sha256,
  validateInstallDestination,
  verifyReleaseDirectory,
  type ReleaseManifest,
  type ReleaseTarget,
} from "./release-contract";
import { generateInstaller } from "./installer-template";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(CLI_ROOT, "src/index.ts");

type ReleaseCommand =
  | { readonly kind: "build"; readonly directory: string }
  | { readonly kind: "verify" | "smoke"; readonly directory: string };

function usage(): never {
  throw new Error(
    "usage: release.ts build --out-dir PATH | verify --release-dir PATH | smoke --release-dir PATH",
  );
}

function parseCommand(argv: readonly string[]): ReleaseCommand {
  const [kind, option, directory, ...rest] = argv;
  if (rest.length !== 0 || directory === undefined) usage();
  if (kind === "build" && option === "--out-dir") {
    return { kind, directory: resolve(CLI_ROOT, directory) };
  }
  if ((kind === "verify" || kind === "smoke") && option === "--release-dir") {
    return { kind, directory: resolve(CLI_ROOT, directory) };
  }
  return usage();
}

function assertOwnedReleasePath(directory: string): void {
  const pathFromRoot = relative(CLI_ROOT, directory);
  if (
    directory === CLI_ROOT ||
    pathFromRoot.length === 0 ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith("../")
  ) {
    throw new Error("release directory must be inside the CLI workspace");
  }
}

async function packageVersion(): Promise<string> {
  const value: unknown = JSON.parse(await readFile(resolve(CLI_ROOT, "package.json"), "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    value.name !== "@hraness/hra-cli" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error("CLI package metadata is invalid");
  }
  return value.version;
}

async function fileMetadata(path: string): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error(`release output is not a nonempty regular file: ${path}`);
  }
  const bytes = new Uint8Array(await readFile(path));
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function compileTarget(
  target: ReleaseTarget,
  version: string,
  outputDirectory: string,
): Promise<void> {
  const output = resolve(outputDirectory, artifactFilename(version, target));
  const processHandle = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--minify",
      `--target=${target.bunTarget}`,
      ENTRYPOINT,
      "--outfile",
      output,
    ],
    { cwd: CLI_ROOT, stdout: "inherit", stderr: "inherit", env: process.env },
  );
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) throw new Error(`Bun cross-compile failed for ${target.bunTarget}`);
  await chmod(output, 0o755);
}

async function writeReleaseMetadata(
  directory: string,
  version: string,
): Promise<ReleaseManifest> {
  const artifacts: ReleaseManifest["artifacts"] = [];
  for (const target of releaseTargets) {
    const file = artifactFilename(version, target);
    const metadata = await fileMetadata(resolve(directory, file));
    artifacts.push({
      platform: target.platform,
      arch: target.arch,
      libc: target.libc,
      bunTarget: target.bunTarget,
      file,
      ...metadata,
    });
  }
  const manifest = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    product: RELEASE_PRODUCT,
    version,
    bunVersion: PINNED_BUN_VERSION,
    artifacts,
    installer: { file: RELEASE_INSTALLER_FILE },
    checksum: { algorithm: "sha256", file: RELEASE_CHECKSUM_FILE },
  } satisfies ReleaseManifest;
  await writeFile(
    resolve(directory, RELEASE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
  const manifestMetadata = await fileMetadata(resolve(directory, RELEASE_MANIFEST_FILE));
  await writeFile(
    resolve(directory, RELEASE_INSTALLER_FILE),
    generateInstaller({
      version,
      artifacts,
      manifest: { file: RELEASE_MANIFEST_FILE, ...manifestMetadata },
    }),
    { encoding: "utf8", flag: "wx", mode: 0o755 },
  );

  const checksumFiles = [
    ...artifacts.map((artifact) => artifact.file),
    RELEASE_INSTALLER_FILE,
    RELEASE_MANIFEST_FILE,
  ].sort();
  const checksumLines: string[] = [];
  for (const file of checksumFiles) {
    const metadata = await fileMetadata(resolve(directory, file));
    checksumLines.push(`${metadata.sha256}  ${file}`);
  }
  await writeFile(resolve(directory, RELEASE_CHECKSUM_FILE), `${checksumLines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  return await verifyReleaseDirectory(directory);
}

async function buildRelease(outputDirectory: string): Promise<ReleaseManifest> {
  assertOwnedReleasePath(outputDirectory);
  if (Bun.version !== PINNED_BUN_VERSION) {
    throw new Error(`release build requires Bun ${PINNED_BUN_VERSION}; found ${Bun.version}`);
  }
  try {
    await lstat(outputDirectory);
    throw new Error("release output already exists; choose a new directory or remove it explicitly");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const outputParent = dirname(outputDirectory);
  await mkdir(outputParent, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(outputParent, ".taskctl-release-"));
  try {
    const version = await packageVersion();
    for (const target of releaseTargets) {
      await compileTarget(target, version, temporaryDirectory);
    }
    const manifest = await writeReleaseMetadata(temporaryDirectory, version);
    await rename(temporaryDirectory, outputDirectory);
    return manifest;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function detectCurrentLibc(): Promise<"glibc" | "musl" | null> {
  if (process.platform !== "linux") return null;
  const processHandle = Bun.spawn(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) return "musl";
  return /GLIBC|GNU C Library|GNU libc/iu.test(`${stdout}\n${stderr}`) ? "glibc" : "musl";
}

async function smokeRelease(releaseDirectoryInput: string): Promise<void> {
  const releaseDirectory = await realpath(resolve(releaseDirectoryInput));
  const manifest = await verifyReleaseDirectory(releaseDirectory);
  const target = releaseTargetForRuntime(
    process.platform,
    process.arch,
    await detectCurrentLibc(),
  );
  if (target === null) throw new Error("current platform is unsupported by this taskctl release");
  const artifact = manifest.artifacts.find((candidate) => candidate.bunTarget === target.bunTarget);
  if (artifact === undefined) throw new Error("current-platform artifact is missing from the manifest");

  const smokeRoot = await mkdtemp(join(CLI_ROOT, ".taskctl-smoke-"));
  try {
    const physicalRoot = await realpath(smokeRoot);
    const destination = resolve(physicalRoot, "taskctl");
    await validateInstallDestination(destination, false);
    const installer = resolve(releaseDirectory, RELEASE_INSTALLER_FILE);
    const install = Bun.spawn(
      ["/bin/sh", installer, "--source-dir", releaseDirectory, "--destination", destination],
      { cwd: CLI_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [installExit, installStdout, installStderr] = await Promise.all([
      install.exited,
      new Response(install.stdout).text(),
      new Response(install.stderr).text(),
    ]);
    if (installExit !== 0) throw new Error(`installer smoke failed: ${installStderr.trim()}`);
    if (!installStdout.includes(destination)) throw new Error("installer did not report its destination");
    const smoke = Bun.spawn([destination, "--help"], { stdout: "pipe", stderr: "pipe" });
    const [smokeExit, smokeStdout, smokeStderr] = await Promise.all([
      smoke.exited,
      new Response(smoke.stdout).text(),
      new Response(smoke.stderr).text(),
    ]);
    if (smokeExit !== 0 || !smokeStdout.includes("usage: taskctl") || smokeStderr.length !== 0) {
      throw new Error("installed current-platform artifact did not pass --help smoke");
    }
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const command = parseCommand(argv);
  assertOwnedReleasePath(command.directory);
  if (command.kind === "build") {
    const manifest = await buildRelease(command.directory);
    process.stdout.write(`${JSON.stringify({ ok: true, action: "build", manifest })}\n`);
    return;
  }
  if (command.kind === "verify") {
    const manifest = await verifyReleaseDirectory(command.directory);
    process.stdout.write(`${JSON.stringify({ ok: true, action: "verify", manifest })}\n`);
    return;
  }
  await smokeRelease(command.directory);
  process.stdout.write(`${JSON.stringify({ ok: true, action: "smoke" })}\n`);
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown release failure";
    process.stderr.write(`taskctl release: ${message}\n`);
    process.exitCode = 1;
  }
}
