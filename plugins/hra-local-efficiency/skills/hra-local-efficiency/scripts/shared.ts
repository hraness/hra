import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export function command(
  arguments_: readonly string[],
  cwd = process.cwd(),
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): CommandResult {
  const result = Bun.spawnSync({
    cmd: [...arguments_],
    cwd,
    env: { ...environment },
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
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const result = command(arguments_, cwd, environment);
  if (result.exitCode !== 0) {
    throw new Error(
      `${arguments_.join(" ")} failed${result.stderr === "" ? "" : `:\n${result.stderr}`}`,
    );
  }
  return result.stdout;
}

export function gitIndexVisibility(cwd: string): {
  readonly readable: boolean;
  readonly reason: "hidden-index-flags" | "populated-gitlink" | "read-error" | "visible";
  readonly transparent: boolean;
} {
  const visibility = command(["git", "ls-files", "-v", "-z"], cwd);
  if (visibility.exitCode !== 0) {
    return { readable: false, reason: "read-error", transparent: false };
  }
  const hidden = visibility.stdout.split("\0").filter(Boolean).some((entry) => {
    const tag = entry[0] ?? "";
    return tag === "S" || /^[a-z]$/u.test(tag);
  });
  if (hidden) {
    return { readable: true, reason: "hidden-index-flags", transparent: false };
  }

  const staged = command(["git", "ls-files", "--stage", "-z"], cwd);
  if (staged.exitCode !== 0) {
    return { readable: false, reason: "read-error", transparent: false };
  }
  const root = resolve(cwd);
  for (const entry of staged.stdout.split("\0").filter(Boolean)) {
    if (!entry.startsWith("160000 ")) continue;
    const separator = entry.indexOf("\t");
    if (separator < 0) {
      return { readable: false, reason: "read-error", transparent: false };
    }
    const path = entry.slice(separator + 1);
    const candidate = resolve(root, path);
    const withinRoot = relative(root, candidate);
    if (withinRoot === ".." || withinRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      return { readable: false, reason: "read-error", transparent: false };
    }
    try {
      const metadata = lstatSync(candidate);
      if (!metadata.isDirectory() || readdirSync(candidate).length > 0) {
        return { readable: true, reason: "populated-gitlink", transparent: false };
      }
    } catch (error: unknown) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT"
      ) continue;
      return { readable: false, reason: "read-error", transparent: false };
    }
  }
  return { readable: true, reason: "visible", transparent: true };
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
  const installRoot = environment.BUN_INSTALL;
  if (installRoot !== undefined && installRoot !== "") {
    if (!isAbsolute(installRoot)) throw new Error("BUN_INSTALL must be absolute");
    return join(installRoot, "bin");
  }
  return join(userHome, ".bun", "bin");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

const operationLabel = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

export function requireOperationLabel(value: string, option = "--label"): string {
  if (!operationLabel.test(value)) {
    throw new Error(`${option} must be 1 through 64 ASCII identifier characters`);
  }
  return value;
}

export function commandProgramLabel(program: string): string {
  const leaf = basename(program);
  return operationLabel.test(leaf) ? leaf : `command-${sha256(program).slice(0, 12)}`;
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
  if ((start < 0) !== (end < 0)) {
    throw new Error(`managed block is incomplete: ${startMarker}`);
  }
  if (start >= 0 && end < start) {
    throw new Error(`managed block markers are reversed: ${startMarker}`);
  }
  if (
    start >= 0
    && (
      existing.indexOf(startMarker, start + startMarker.length) >= 0
      || existing.indexOf(endMarker, end + endMarker.length) >= 0
    )
  ) {
    throw new Error(`managed block markers are duplicated: ${startMarker}`);
  }
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
  const temporary = join(
    dirname(path),
    `.${path.split("/").at(-1) ?? "file"}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error: unknown) {
    try {
      unlinkSync(temporary);
    } catch { /* Preserve the primary write failure. */ }
    throw error;
  }
}

function pathMetadata(path: string): Stats | null {
  try {
    return lstatSync(path);
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

export function ensureExactSymlink(target: string, link: string): "created" | "current" | "updated" {
  if (!isAbsolute(target) || !isAbsolute(link)) {
    throw new Error("symlink targets and paths must be absolute");
  }
  const normalizedTarget = resolve(target);
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  const metadata = pathMetadata(link);
  if (metadata !== null) {
    if (!metadata.isSymbolicLink()) {
      throw new Error(`refusing to replace unmanaged non-symlink: ${link}`);
    }
    const existingTarget = resolve(dirname(link), readlinkSync(link));
    if (existingTarget === normalizedTarget) return "current";
    const temporary = join(dirname(link), `.${link.split("/").at(-1) ?? "link"}.${randomUUID()}.tmp`);
    try {
      symlinkSync(normalizedTarget, temporary);
      renameSync(temporary, link);
    } catch (error: unknown) {
      try {
        unlinkSync(temporary);
      } catch { /* Preserve the primary link failure. */ }
      throw error;
    }
    return "updated";
  }
  symlinkSync(normalizedTarget, link);
  return "created";
}

export function symlinkMatches(target: string, link: string): boolean {
  try {
    const metadata = lstatSync(link);
    return metadata.isSymbolicLink()
      && resolve(dirname(link), readlinkSync(link)) === resolve(target);
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

export function relativeDisplay(root: string, path: string): string {
  const value = relative(root, path);
  return value === "" ? "." : value;
}
