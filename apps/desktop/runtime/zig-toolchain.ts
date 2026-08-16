import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const nativeSdkZigVersion = "0.16.0";

type VersionProbe = (executable: string) => string | undefined;

export interface ZigResolutionOptions {
  readonly commonExecutables?: readonly string[];
  readonly versionProbe?: VersionProbe;
}

const defaultCommonExecutables = ["/opt/homebrew/bin/zig", "/usr/local/bin/zig"];

function executable(candidate: string): string | undefined {
  if (!isAbsolute(candidate)) {
    return undefined;
  }

  try {
    const canonical = realpathSync(candidate);
    if (!statSync(canonical).isFile()) {
      return undefined;
    }
    accessSync(canonical, constants.X_OK);
    return canonical;
  } catch {
    return undefined;
  }
}

function pathExecutables(environment: NodeJS.ProcessEnv): readonly string[] {
  return (environment.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)
    .map((directory) => join(directory, "zig"));
}

function managedExecutable(environment: NodeJS.ProcessEnv): string | undefined {
  const nativeSdkHome = environment.NATIVE_SDK_HOME?.trim();
  if (nativeSdkHome) {
    return join(
      nativeSdkHome,
      "toolchains",
      `zig-${nativeSdkZigVersion}`,
      "zig",
    );
  }

  const home = environment.HOME?.trim();
  return home
    ? join(home, ".native", "toolchains", `zig-${nativeSdkZigVersion}`, "zig")
    : undefined;
}

function probeVersion(zigExecutable: string): string | undefined {
  try {
    const result = Bun.spawnSync([zigExecutable, "version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) {
      return undefined;
    }

    const version = result.stdout.toString().trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function releaseVersion(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    return undefined;
  }

  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return [Number(major), Number(minor), Number(patch)];
}

export function isCompatibleZigVersion(
  actual: string,
  pinned = nativeSdkZigVersion,
): boolean {
  const actualVersion = releaseVersion(actual);
  const pinnedVersion = releaseVersion(pinned);
  return actualVersion !== undefined
    && pinnedVersion !== undefined
    && actualVersion[0] === pinnedVersion[0]
    && actualVersion[1] === pinnedVersion[1]
    && actualVersion[2] >= pinnedVersion[2];
}

export function resolveZigExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  options: ZigResolutionOptions = {},
): string {
  const override = environment.NATIVE_SDK_ZIG?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error("NATIVE_SDK_ZIG must be an absolute path");
    }

    const resolvedOverride = executable(override);
    if (!resolvedOverride) {
      throw new Error(`NATIVE_SDK_ZIG is not an executable file: ${override}`);
    }
    return resolvedOverride;
  }

  const versionProbe = options.versionProbe ?? probeVersion;
  const managed = managedExecutable(environment);
  const candidates = [
    ...pathExecutables(environment),
    ...(options.commonExecutables ?? defaultCommonExecutables),
    ...(managed ? [managed] : []),
  ];
  const visited = new Set<string>();
  for (const candidate of candidates) {
    const resolved = executable(candidate);
    if (!resolved || visited.has(resolved)) {
      continue;
    }
    visited.add(resolved);

    const version = versionProbe(resolved);
    if (version && isCompatibleZigVersion(version)) {
      return resolved;
    }
  }

  throw new Error(
    "Zig 0.16.0 is required for HRA macOS development. Install it with `brew install zig`, set NATIVE_SDK_ZIG to an absolute Zig executable, or run `bun run --cwd apps/desktop native build --yes` once to install Native SDK's managed toolchain.",
  );
}
