import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { errorMessage, isJsonObject } from "./jsonl";

export interface ResolvedCodexCommand {
  readonly binaryPath: string;
  readonly commandPrefix: readonly [string, ...Array<string>];
  readonly source: "argument" | "environment" | "workspace" | "path";
}

export interface CodexVersionEvidence {
  readonly raw: string;
  readonly version: string;
}

export async function resolveCodexCommand(
  explicitPath?: string,
): Promise<ResolvedCodexCommand> {
  if (explicitPath !== undefined) {
    return resolveCandidate(explicitPath, "argument");
  }

  const environmentPath = process.env.HRA_CODEX_BIN;
  if (environmentPath !== undefined && environmentPath.trim().length > 0) {
    return resolveCandidate(environmentPath, "environment");
  }

  const workspaceCandidate = resolve(import.meta.dir, "../../../node_modules/.bin/codex");
  if (await canExecute(workspaceCandidate)) {
    return resolveCandidate(workspaceCandidate, "workspace");
  }

  const pathCandidate = Bun.which("codex");
  if (pathCandidate !== null) {
    return resolveCandidate(pathCandidate, "path");
  }

  throw new Error(
    "no Codex binary found; set HRA_CODEX_BIN to the exact pinned executable",
  );
}

export async function readCodexVersion(
  command: ResolvedCodexCommand,
  timeoutMs = 5_000,
): Promise<CodexVersionEvidence> {
  const child = Bun.spawn({
    cmd: [...command.commandPrefix, "--version"],
    cwd: dirname(command.binaryPath),
    env: buildProbeEnvironment(process.env.CODEX_HOME),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const completion = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs} ms reading Codex version`));
    }, timeoutMs);
  });
  const result = await Promise.race([completion, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
  const [exitCode, stdout, stderr] = result;
  if (exitCode !== 0) {
    throw new Error(`Codex --version exited ${exitCode}: ${stderr.trim()}`);
  }
  const raw = stdout.trim();
  const match = raw.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/u);
  if (match?.[1] === undefined) {
    throw new Error(`could not parse Codex version from ${JSON.stringify(raw)}`);
  }
  return { raw, version: match[1] };
}

export async function resolveExpectedCodexVersion(
  explicitVersion?: string,
): Promise<string | null> {
  const environmentVersion = process.env.HRA_CODEX_VERSION;
  const selected = explicitVersion ?? environmentVersion;
  if (selected !== undefined && selected.trim().length > 0) {
    return normalizeExactVersion(selected);
  }

  const rootPackagePath = resolve(import.meta.dir, "../../../../../package.json");
  try {
    const parsed = JSON.parse(await readFile(rootPackagePath, "utf8")) as unknown;
    if (!isJsonObject(parsed) || !isJsonObject(parsed.workspaces) || !isJsonObject(parsed.workspaces.catalog)) {
      return null;
    }
    const catalogVersion = parsed.workspaces.catalog["@openai/codex"];
    return typeof catalogVersion === "string" ? normalizeExactVersion(catalogVersion) : null;
  } catch (error: unknown) {
    if (errorMessage(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

export function buildProbeEnvironment(codexHome: string | undefined): Record<string, string> {
  const allowedNames = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ] as const;
  const environment: Record<string, string> = { NO_COLOR: "1", RUST_BACKTRACE: "0" };
  for (const name of allowedNames) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  if (codexHome !== undefined) {
    environment.CODEX_HOME = codexHome;
  }
  return environment;
}

async function resolveCandidate(
  candidate: string,
  source: ResolvedCodexCommand["source"],
): Promise<ResolvedCodexCommand> {
  if (!isAbsolute(candidate)) {
    throw new Error(`Codex binary path must be absolute: ${candidate}`);
  }
  await access(candidate, constants.X_OK);
  const binaryPath = await realpath(candidate);
  const commandPrefix = binaryPath.endsWith(".js")
    ? ([process.execPath, binaryPath] as const)
    : ([binaryPath] as const);
  return { binaryPath, commandPrefix, source };
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeExactVersion(value: string): string | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u);
  return match?.[1] ?? null;
}
