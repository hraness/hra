import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CodexAppServerClient, type CodexAppServerClientOptions } from "./client.ts";
import { CodexError } from "./errors.ts";
import { record, string } from "./parse.ts";
import { spawnBunCodexProcess, type CodexProcess } from "./process.ts";
import { PINNED_CODEX_VERSION, type CodexAuthority } from "./protocol.ts";

export interface PinnedCodexRuntime {
  readonly packageRoot: string;
  readonly packageJsonPath: string;
  readonly packageVersion: typeof PINNED_CODEX_VERSION;
  readonly launcherArgv: readonly [string, string, "app-server", "--listen", "stdio://"];
}

export interface ResolvePinnedCodexRuntimeOptions {
  readonly packageJsonPath?: string;
  readonly resolveFrom?: string;
  readonly bunExecutable?: string;
}

export async function resolvePinnedCodexRuntime(
  options: ResolvePinnedCodexRuntimeOptions = {},
): Promise<PinnedCodexRuntime> {
  const packageJsonPath = await locatePackageJson(options);
  const canonicalPackageJson = await realpath(packageJsonPath).catch((error: unknown) => {
    throw new CodexError("RUNTIME_MISMATCH", "the pinned Codex package is unavailable", {
      cause: error,
    });
  });
  const packageRoot = dirname(canonicalPackageJson);
  const text = await Bun.file(canonicalPackageJson).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CodexError("RUNTIME_MISMATCH", "the Codex package manifest is invalid", {
      cause: error,
    });
  }
  const manifest = record(parsed, "Codex package manifest");
  const name = string(manifest.name, "Codex package name", { min: 1, max: 256 });
  const version = string(manifest.version, "Codex package version", { min: 1, max: 128 });
  if (name !== "@openai/codex" || version !== PINNED_CODEX_VERSION) {
    throw new CodexError(
      "RUNTIME_MISMATCH",
      `HRA requires @openai/codex ${PINNED_CODEX_VERSION}`,
    );
  }

  const binValue = manifest.bin;
  let relativeBin: string;
  if (typeof binValue === "string") {
    relativeBin = binValue;
  } else {
    relativeBin = string(record(binValue, "Codex package bin").codex, "Codex bin path", {
      min: 1,
      max: 2_048,
    });
  }
  const binPath = resolve(packageRoot, relativeBin);
  const canonicalBin = await realpath(binPath).catch((error: unknown) => {
    throw new CodexError("RUNTIME_MISMATCH", "the pinned Codex launcher is unavailable", {
      cause: error,
    });
  });
  const contained = relative(packageRoot, canonicalBin);
  if (contained.startsWith("..") || isAbsolute(contained)) {
    throw new CodexError("RUNTIME_MISMATCH", "the Codex launcher escapes its package root");
  }
  const stat = await lstat(canonicalBin);
  if (!stat.isFile()) {
    throw new CodexError("RUNTIME_MISMATCH", "the Codex launcher is not a regular file");
  }

  const bunExecutable = options.bunExecutable ?? process.execPath;
  if (!isAbsolute(bunExecutable)) {
    throw new CodexError("RUNTIME_MISMATCH", "the Bun executable path must be absolute");
  }
  return {
    packageRoot,
    packageJsonPath: canonicalPackageJson,
    packageVersion: PINNED_CODEX_VERSION,
    launcherArgv: [bunExecutable, canonicalBin, "app-server", "--listen", "stdio://"],
  };
}

export interface LaunchPinnedCodexOptions
  extends Omit<CodexAppServerClientOptions, "process">,
    ResolvePinnedCodexRuntimeOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly processFactory?: (input: {
    readonly runtime: PinnedCodexRuntime;
    readonly codexHome: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  }) => CodexProcess;
}

export async function launchPinnedCodexAppServer(
  options: LaunchPinnedCodexOptions,
): Promise<CodexAppServerClient> {
  const runtime = await resolvePinnedCodexRuntime(options);
  const processFactory =
    options.processFactory ??
    ((input: {
      readonly runtime: PinnedCodexRuntime;
      readonly codexHome: string;
      readonly environment?: Readonly<Record<string, string | undefined>>;
    }) =>
      spawnBunCodexProcess({
        argv: input.runtime.launcherArgv,
        codexHome: input.codexHome,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      }));
  const process = processFactory({
    runtime,
    codexHome: options.expectedCodexHome,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  const client = new CodexAppServerClient({
    process,
    authority: options.authority,
    expectedCodexHome: options.expectedCodexHome,
    isAuthorityCurrent: options.isAuthorityCurrent,
    ...(options.credentialStorePreflight === undefined
      ? {}
      : { credentialStorePreflight: options.credentialStorePreflight }),
    ...(options.experimentalApi === undefined
      ? {}
      : { experimentalApi: options.experimentalApi }),
    ...(options.onFact === undefined ? {} : { onFact: options.onFact }),
    ...(options.onSafeDiagnostic === undefined
      ? {}
      : { onSafeDiagnostic: options.onSafeDiagnostic }),
    ...(options.maxJsonLineBytes === undefined
      ? {}
      : { maxJsonLineBytes: options.maxJsonLineBytes }),
    ...(options.shutdownTermGraceMs === undefined
      ? {}
      : { shutdownTermGraceMs: options.shutdownTermGraceMs }),
    ...(options.shutdownSettlementMs === undefined
      ? {}
      : { shutdownSettlementMs: options.shutdownSettlementMs }),
  });
  await client.initialize();
  return client;
}

async function locatePackageJson(options: ResolvePinnedCodexRuntimeOptions): Promise<string> {
  if (options.packageJsonPath !== undefined) {
    if (!isAbsolute(options.packageJsonPath)) {
      throw new CodexError("RUNTIME_MISMATCH", "Codex package manifest path must be absolute");
    }
    return options.packageJsonPath;
  }
  const resolveFrom = options.resolveFrom ?? import.meta.dir;
  try {
    return Bun.resolveSync("@openai/codex/package.json", resolveFrom);
  } catch {
    let entry: string;
    try {
      entry = Bun.resolveSync("@openai/codex", resolveFrom);
    } catch (error) {
      throw new CodexError("RUNTIME_MISMATCH", "the pinned Codex package is not installed", {
        cause: error,
      });
    }
    let cursor = dirname(entry);
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = join(cursor, "package.json");
      if (await Bun.file(candidate).exists()) return candidate;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    throw new CodexError("RUNTIME_MISMATCH", "could not locate the Codex package manifest");
  }
}

export function codexAuthority(profileId: string, processGeneration: number): CodexAuthority {
  return { profileId, processGeneration };
}
