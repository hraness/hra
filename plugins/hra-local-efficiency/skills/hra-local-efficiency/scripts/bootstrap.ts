#!/usr/bin/env bun

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ensureExactSymlink,
  normalizeTrailingNewline,
  readText,
  replaceManagedBlock,
  resolvedBunBin,
  resolvedCodexHome,
  sha256,
  symlinkMatches,
  writeAtomic,
} from "./shared";
import { resolveAtetHostResourceModule, resolveAtetRuntimeRoot } from "./host-run";

type Mode = "apply" | "check";

export type BootstrapOptions = {
  readonly bunBin: string;
  readonly codexHome: string;
  readonly installDependency: boolean;
  readonly mode: Mode;
  readonly runtimeRoot: string;
};

const startMarker = "<!-- hra-local-efficiency:start -->";
const endMarker = "<!-- hra-local-efficiency:end -->";
const atetRelease = "Atet v2.0.0 host-resource runtime";
const atetCommit = "58132fa6e8ac09a87d1fdffc17be40c8b1fd9d6d";
const pluginName = "hra-local-efficiency";
const commandScripts = Object.freeze([
  "host-run.ts",
  "validation-run.ts",
  "workspace-audit.ts",
  "session-audit.ts",
  "repo-adoption.ts",
  "doctor.ts",
]);
const atetArtifacts = Object.freeze([
  Object.freeze({
    bytes: 978,
    name: "host-resources.js",
    sha256: "c86948a8530410bb24e341ce047879196bd423ce8762ad9522a23f29ab517912",
    source: "dist/host-resources.js",
  }),
  Object.freeze({
    bytes: 46_672,
    name: "index-64bhbap5.js",
    sha256: "df629241e110836ed5c0ce9e0489e2c678237ba142ebed35a6a1a030c478245d",
    source: "dist/index-64bhbap5.js",
  }),
  Object.freeze({
    bytes: 68,
    name: "index-z1w83f81.js",
    sha256: "ff933e06cdca2b4821af7b65fc871a38add69a6360000717a76c35736169fd4a",
    source: "dist/index-z1w83f81.js",
  }),
  Object.freeze({
    bytes: 1_077,
    name: "LICENSE",
    sha256: "fa7d249dcd800e7faa648a60289865073d8819d477ab3f5edcd626345160d452",
    source: "LICENSE",
  }),
]);

function regularFileModeOrDefault(path: string): number {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) {
      throw new Error(`refusing to replace non-regular global guidance: ${path}`);
    }
    return metadata.mode & 0o777;
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return 0o644;
    throw error;
  }
}

export function parseBootstrapArguments(arguments_: readonly string[]): BootstrapOptions {
  let bunBin = resolvedBunBin();
  let codexHome = resolvedCodexHome();
  let installDependency = true;
  let mode: Mode | undefined;
  const runtimeRoot = resolveAtetRuntimeRoot();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply" || argument === "--check") {
      if (mode !== undefined) throw new Error("choose exactly one of --apply or --check");
      mode = argument.slice(2) as Mode;
      continue;
    }
    if (argument === "--skip-dependency-install") {
      installDependency = false;
      continue;
    }
    if (argument === "--codex-home" || argument === "--bun-bin") {
      const value = arguments_[index + 1];
      if (value === undefined || !value.startsWith("/")) {
        throw new Error(`${argument} requires an absolute path`);
      }
      if (argument === "--codex-home") codexHome = resolve(value);
      else bunBin = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown bootstrap argument: ${argument}`);
  }
  if (mode === undefined) throw new Error("choose --apply or --check");
  return { bunBin, codexHome, installDependency, mode, runtimeRoot };
}

function skillRoot(): string {
  return resolve(import.meta.dir, "..");
}

function asset(name: string): string {
  return readFileSync(join(skillRoot(), "assets", name), "utf8");
}

export function commandTargets(bunBin: string): readonly [string, string][] {
  return [
    ["hra-host-run", "host-run.ts"],
    ["hra-validate", "validation-run.ts"],
    ["hra-workspace-audit", "workspace-audit.ts"],
    ["hra-session-audit", "session-audit.ts"],
    ["hra-repo-adoption", "repo-adoption.ts"],
    ["hra-local-efficiency", "doctor.ts"],
  ].map(([name, script]) => [
    join(bunBin, name as string),
    join(skillRoot(), "scripts", script as string),
  ] as const);
}

function missingPath(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function verifiedRegularText(path: string, maximumBytes: number): string | null {
  try {
    const before = lstatSync(path);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || before.size < 1
      || before.size > maximumBytes
    ) return null;
    const value = readFileSync(path, "utf8");
    const after = lstatSync(path);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || after.nlink !== 1
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || Buffer.byteLength(value) !== after.size
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function pluginIdentityMatches(pluginRoot: string, skillRoot_: string): boolean {
  const manifestText = verifiedRegularText(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    16 * 1024,
  );
  const skillText = verifiedRegularText(join(skillRoot_, "SKILL.md"), 64 * 1024);
  if (manifestText === null || skillText === null) return false;
  try {
    const manifest: unknown = JSON.parse(manifestText);
    if (
      typeof manifest !== "object"
      || manifest === null
      || !("name" in manifest)
      || manifest.name !== pluginName
      || !("skills" in manifest)
      || manifest.skills !== "./skills/"
    ) return false;
  } catch {
    return false;
  }
  const lines = skillText.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return false;
  const end = lines.indexOf("---", 1);
  if (end < 2) return false;
  return lines.slice(1, end).filter((line) => line.startsWith("name:")).length === 1
    && lines.slice(1, end).includes(`name: ${pluginName}`);
}

function isReservedDanglingCacheTarget(
  existingTarget: string,
  codexHome: string,
  expectedScript: string,
): boolean {
  if (!isAbsolute(existingTarget) || !commandScripts.includes(expectedScript)) return false;
  const cacheRoot = resolve(codexHome, "plugins", "cache");
  const relativeTarget = relative(cacheRoot, resolve(existingTarget));
  if (
    relativeTarget === ""
    || isAbsolute(relativeTarget)
    || relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
  ) return false;
  const safeMarketplace = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const safeVersion = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
  const segments = relativeTarget.split(sep);
  return segments.length === 7
    && safeMarketplace.test(segments[0] ?? "")
    && segments[1] === pluginName
    && safeVersion.test(segments[2] ?? "")
    && segments[3] === "skills"
    && segments[4] === pluginName
    && segments[5] === "scripts"
    && segments[6] === expectedScript;
}

export function isManagedPriorCommandTarget(
  existingTarget: string,
  codexHome: string,
  expectedScript: string,
): boolean {
  if (!commandScripts.includes(expectedScript)) return false;
  try {
    const metadata = lstatSync(existingTarget);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) return false;
    const target = realpathSync(existingTarget);
    if (basename(target) !== expectedScript || basename(dirname(target)) !== "scripts") return false;
    const skillRoot_ = dirname(dirname(target));
    if (basename(skillRoot_) !== pluginName || basename(dirname(skillRoot_)) !== "skills") return false;
    const pluginRoot = dirname(dirname(skillRoot_));
    if (!pluginIdentityMatches(pluginRoot, skillRoot_)) return false;

    const sourceCheckout = basename(pluginRoot) === pluginName
      && basename(dirname(pluginRoot)) === "plugins";
    let pluginCache = false;
    try {
      const cacheRoot = realpathSync(resolve(codexHome, "plugins", "cache"));
      const relativePlugin = relative(cacheRoot, pluginRoot);
      const segments = relativePlugin.split(sep);
      pluginCache = relativePlugin !== ""
        && !isAbsolute(relativePlugin)
        && relativePlugin !== ".."
        && !relativePlugin.startsWith(`..${sep}`)
        && segments.length === 3
        && segments[0] !== ""
        && segments[1] === pluginName
        && segments[2] !== "";
    } catch { /* A source checkout need not have a plugin cache. */ }
    return sourceCheckout || pluginCache;
  } catch (error: unknown) {
    return missingPath(error)
      && isReservedDanglingCacheTarget(existingTarget, codexHome, expectedScript);
  }
}

export function ensureManagedCommandSymlink(
  target: string,
  link: string,
  codexHome: string,
): "created" | "current" | "updated" {
  try {
    const metadata = lstatSync(link);
    if (!metadata.isSymbolicLink()) {
      throw new Error(`refusing to replace unmanaged non-symlink: ${link}`);
    }
    const existingTarget = resolve(dirname(link), readlinkSync(link));
    if (
      existingTarget !== resolve(target)
      && !isManagedPriorCommandTarget(existingTarget, codexHome, basename(target))
    ) {
      throw new Error(`refusing to replace unmanaged command symlink: ${link}`);
    }
  } catch (error: unknown) {
    if (!missingPath(error)) throw error;
  }
  return ensureExactSymlink(target, link);
}

function dependencyAvailable(
  runtimeRoot: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  try {
    const configured = environment.HRA_ATET_HOST_RESOURCES_MODULE;
    const modulePath = configured === undefined || configured === ""
      ? join(runtimeRoot, "host-resources.js")
      : resolveAtetHostResourceModule(environment);
    if (configured === undefined || configured === "") {
      for (const artifact of atetArtifacts) {
        const path = join(runtimeRoot, artifact.name);
        const metadata = lstatSync(path);
        if (
          !metadata.isFile()
          || metadata.isSymbolicLink()
          || metadata.nlink !== 1
          || metadata.size !== artifact.bytes
          || sha256(readFileSync(path)) !== artifact.sha256
        ) return false;
      }
    }
    const moduleUrl = pathToFileURL(modulePath).href;
    const probe = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const value = await import(${JSON.stringify(moduleUrl)}); if (typeof value.createHostResourceCoordinator !== "function") process.exit(1);`,
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

async function downloadAtetArtifact(
  artifact: (typeof atetArtifacts)[number],
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const url = `https://raw.githubusercontent.com/hraness/atet/${atetCommit}/${artifact.source}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetcher(url, { redirect: "error", signal: controller.signal });
    if (!response.ok || response.url !== url || response.body === null) {
      throw new Error(`failed to download pinned ${artifact.name}`);
    }
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let total = 0;
    let next = await reader.read();
    while (!next.done) {
      total += next.value.byteLength;
      if (total > artifact.bytes) {
        await reader.cancel();
        throw new Error(`pinned ${artifact.name} exceeded its exact byte bound`);
      }
      chunks.push(next.value);
      next = await reader.read();
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`pinned ${artifact.name} failed byte verification`);
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

export async function installAtetRuntime(
  runtimeRoot: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const downloaded = await Promise.all(
    atetArtifacts.map(async (artifact) => [artifact, await downloadAtetArtifact(artifact, fetcher)] as const),
  );
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const rootMetadata = lstatSync(runtimeRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("refusing a non-directory private runtime root");
  }
  for (const [artifact, bytes] of downloaded) {
    writeAtomic(join(runtimeRoot, artifact.name), Buffer.from(bytes).toString("utf8"), 0o600);
  }
}

function expectedGlobalAgents(codexHome: string): string {
  return replaceManagedBlock(
    readText(join(codexHome, "AGENTS.md")),
    asset("global-agents-block.md"),
    startMarker,
    endMarker,
  );
}

export function checkInstallation(
  options: BootstrapOptions,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string[] {
  const failures: string[] = [];
  const agentsPath = join(options.codexHome, "AGENTS.md");
  try {
    regularFileModeOrDefault(agentsPath);
  } catch (error: unknown) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (readText(agentsPath) !== expectedGlobalAgents(options.codexHome)) {
    failures.push(`global guidance differs: ${agentsPath}`);
  }
  for (const profile of ["hra-worker.config.toml", "hra-routine.config.toml"]) {
    const path = join(options.codexHome, profile);
    if (readText(path) !== normalizeTrailingNewline(asset(profile))) {
      failures.push(`profile differs: ${path}`);
    }
  }
  for (const [link, target] of commandTargets(options.bunBin)) {
    if (!symlinkMatches(target, link)) failures.push(`command link differs: ${link}`);
  }
  if (!dependencyAvailable(options.runtimeRoot, environment)) {
    failures.push(`missing private dependency: ${atetRelease}`);
  }
  return failures;
}

async function applyInstallation(options: BootstrapOptions): Promise<void> {
  mkdirSync(options.codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(options.bunBin, { recursive: true, mode: 0o700 });
  const agentsPath = join(options.codexHome, "AGENTS.md");
  const agentsMode = regularFileModeOrDefault(agentsPath);
  writeAtomic(agentsPath, expectedGlobalAgents(options.codexHome), agentsMode);
  for (const profile of ["hra-worker.config.toml", "hra-routine.config.toml"]) {
    const path = join(options.codexHome, profile);
    const expected = normalizeTrailingNewline(asset(profile));
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      if (readText(path) !== expected) {
        throw new Error(`refusing to replace differing profile symlink: ${path}`);
      }
    } else {
      const mode = regularFileModeOrDefault(path);
      writeAtomic(path, expected, mode);
    }
  }
  for (const [link, target] of commandTargets(options.bunBin)) {
    if (!existsSync(target)) throw new Error(`plugin script is missing: ${target}`);
    chmodSync(target, 0o755);
    const result = ensureManagedCommandSymlink(target, link, options.codexHome);
    console.log(`${result.toUpperCase()}\t${link}\t${target}`);
  }
  if (!dependencyAvailable(options.runtimeRoot)) {
    if (!options.installDependency) {
      throw new Error(`missing ${atetRelease}; dependency installation was disabled`);
    }
    await installAtetRuntime(options.runtimeRoot);
  }
  const failures = checkInstallation(options);
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

if (import.meta.main) {
  try {
    const options = parseBootstrapArguments(process.argv.slice(2));
    if (options.mode === "apply") await applyInstallation(options);
    const failures = checkInstallation(options);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL\t${failure}`);
      process.exitCode = 1;
    } else {
      const agents = join(options.codexHome, "AGENTS.md");
      const metadata = lstatSync(agents);
      console.log(`PASS\tHRA local efficiency baseline\t${agents}\tmode=${metadata.mode & 0o777}`);
    }
  } catch (error) {
    console.error(`[hra-local-efficiency] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
