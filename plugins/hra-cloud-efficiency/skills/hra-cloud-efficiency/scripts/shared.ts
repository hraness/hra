import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export type CommandRunner = (
  arguments_: readonly string[],
  cwd?: string,
) => CommandResult;

export function command(arguments_: readonly string[], cwd = process.cwd()): CommandResult {
  const result = Bun.spawnSync({
    cmd: [...arguments_],
    cwd,
    env: { ...process.env },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString().trim(),
    stdout: result.stdout.toString().trimEnd(),
  };
}

export function requireCommand(
  arguments_: readonly string[],
  cwd = process.cwd(),
  runner: CommandRunner = command,
  failure = "required command failed",
): string {
  const result = runner(arguments_, cwd);
  if (result.exitCode !== 0) throw new Error(failure);
  return result.stdout;
}

export function resolvedCodexHome(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.CODEX_HOME;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("CODEX_HOME must be absolute");
    return resolve(configured);
  }
  return join(userHome, ".codex");
}

export function resolvedBunBin(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.BUN_INSTALL;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("BUN_INSTALL must be absolute");
    return join(configured, "bin");
  }
  return join(userHome, ".bun", "bin");
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return null;
    throw error;
  }
}

export function normalizeTrailingNewline(value: string): string {
  return `${value.replace(/\n*$/u, "")}\n`;
}

export function replaceManagedBlock(
  current: string | null,
  block: string,
  startMarker: string,
  endMarker: string,
): string {
  const normalizedBlock = normalizeTrailingNewline(block);
  const existing = current ?? "";
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  if ((start < 0) !== (end < 0)) throw new Error(`managed block is incomplete: ${startMarker}`);
  if (start >= 0 && end < start) throw new Error(`managed block markers are reversed: ${startMarker}`);
  if (
    start >= 0
    && (
      existing.indexOf(startMarker, start + startMarker.length) >= 0
      || existing.indexOf(endMarker, end + endMarker.length) >= 0
    )
  ) throw new Error(`managed block markers are duplicated: ${startMarker}`);
  if (start >= 0) {
    const after = end + endMarker.length;
    const suffix = existing.slice(after);
    const replacement = suffix.startsWith("\n") || suffix.startsWith("\r\n")
      ? normalizedBlock.slice(0, -1)
      : normalizedBlock;
    return `${existing.slice(0, start)}${replacement}${suffix}`;
  }
  const separator = existing === "" || existing.endsWith("\n\n")
    ? ""
    : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${normalizedBlock}`;
}

export function writeAtomic(path: string, value: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error: unknown) {
    try {
      unlinkSync(temporary);
    } catch { /* Preserve the primary failure. */ }
    throw error;
  }
}

export function regularFileMode(path: string, description: string, fallback = 0o644): number {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`refusing to replace non-regular ${description}: ${path}`);
    }
    return metadata.mode & 0o777;
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return fallback;
    throw error;
  }
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

function pluginIdentityMatches(pluginRoot: string, skillRoot: string, pluginName: string): boolean {
  const manifestText = verifiedRegularText(join(pluginRoot, ".codex-plugin", "plugin.json"), 16 * 1024);
  const skillText = verifiedRegularText(join(skillRoot, "SKILL.md"), 64 * 1024);
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
  return end >= 2
    && lines.slice(1, end).filter((line) => line.startsWith("name:")).length === 1
    && lines.slice(1, end).includes(`name: ${pluginName}`);
}

function reservedDanglingCacheTarget(
  existingTarget: string,
  codexHome: string,
  pluginName: string,
  expectedScript: string,
): boolean {
  if (!isAbsolute(existingTarget)) return false;
  const relativeTarget = relative(resolve(codexHome, "plugins", "cache"), resolve(existingTarget));
  if (
    relativeTarget === ""
    || isAbsolute(relativeTarget)
    || relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
  ) return false;
  const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
  const segments = relativeTarget.split(sep);
  return segments.length === 7
    && safeSegment.test(segments[0] ?? "")
    && segments[1] === pluginName
    && safeSegment.test(segments[2] ?? "")
    && segments[3] === "skills"
    && segments[4] === pluginName
    && segments[5] === "scripts"
    && segments[6] === expectedScript;
}

function managedPriorTarget(
  existingTarget: string,
  target: string,
  pluginName: string,
  codexHome: string,
): boolean {
  const expectedScript = basename(target);
  if (!isAbsolute(existingTarget) || basename(existingTarget) !== expectedScript) return false;
  try {
    const metadata = lstatSync(existingTarget);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) return false;
    const canonical = realpathSync(existingTarget);
    if (basename(dirname(canonical)) !== "scripts") return false;
    const skillRoot = dirname(dirname(canonical));
    if (basename(skillRoot) !== pluginName || basename(dirname(skillRoot)) !== "skills") return false;
    const pluginRoot = dirname(dirname(skillRoot));
    if (!pluginIdentityMatches(pluginRoot, skillRoot, pluginName)) return false;
    if (basename(pluginRoot) === pluginName && basename(dirname(pluginRoot)) === "plugins") return true;
    const cacheRoot = realpathSync(resolve(codexHome, "plugins", "cache"));
    const relativePlugin = relative(cacheRoot, pluginRoot);
    const segments = relativePlugin.split(sep);
    return relativePlugin !== ""
      && !isAbsolute(relativePlugin)
      && relativePlugin !== ".."
      && !relativePlugin.startsWith(`..${sep}`)
      && segments.length === 3
      && segments[0] !== ""
      && segments[1] === pluginName
      && segments[2] !== "";
  } catch (error: unknown) {
    return missingPath(error)
      && reservedDanglingCacheTarget(existingTarget, codexHome, pluginName, expectedScript);
  }
}

export function ensureManagedSymlink(
  link: string,
  target: string,
  pluginName: string,
  codexHome: string,
): "created" | "current" | "updated" {
  if (!isAbsolute(link) || !isAbsolute(target)) throw new Error("managed symlink paths must be absolute");
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  try {
    const metadata = lstatSync(link);
    if (!metadata.isSymbolicLink()) throw new Error(`refusing to replace unmanaged command: ${link}`);
    const existingTarget = resolve(dirname(link), readlinkSync(link));
    if (existingTarget === resolve(target)) return "current";
    if (!managedPriorTarget(existingTarget, target, pluginName, codexHome)) {
      throw new Error(`refusing to replace unrelated command link: ${link}`);
    }
    unlinkSync(link);
    symlinkSync(resolve(target), link);
    return "updated";
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      symlinkSync(resolve(target), link);
      return "created";
    }
    throw error;
  }
}

export function symlinkMatches(link: string, target: string): boolean {
  try {
    const linkMetadata = lstatSync(link);
    const targetMetadata = lstatSync(target);
    return linkMetadata.isSymbolicLink()
      && resolve(dirname(link), readlinkSync(link)) === resolve(target)
      && targetMetadata.isFile()
      && !targetMetadata.isSymbolicLink()
      && targetMetadata.nlink === 1
      && (targetMetadata.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function canonicalIfPresent(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function requireSafeIdentifier(value: string, option: string, maximum = 128): string {
  if (
    value.length < 1
    || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) throw new Error(`${option} must be a bounded ASCII identifier`);
  return value;
}

export function requireGitHubSlug(value: string, option: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error(`${option} must be one GitHub owner/repository slug`);
  }
  return value;
}
