import { lstat, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { validateFrontendBuild } from "./frontend-package-integrity";

// The bridge package is versioned with its exact legacy outer bundle name.
const LEGACY_OPRTE_PACKAGE_APP_NAME =
  /^OPRTE-[A-Za-z0-9][A-Za-z0-9._+-]*-macos-(?:Debug|ReleaseFast|ReleaseSafe|ReleaseSmall)\.app$/u;
const DEFAULT_PROJECT_DIRECTORY = resolve(import.meta.dir, "..");

export class PackageOutputPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageOutputPreparationError";
  }
}

export async function preparePackageOutput(options: {
  readonly appBundlePath: string;
  readonly projectDirectory?: string;
  readonly sourceDirectory: string;
}): Promise<void> {
  const projectDirectory = resolve(
    options.projectDirectory ?? DEFAULT_PROJECT_DIRECTORY,
  );
  const sourceDirectory = resolve(options.sourceDirectory);
  const expectedSourceDirectory = resolve(projectDirectory, "frontend/dist");
  if (sourceDirectory !== expectedSourceDirectory) {
    throw new PackageOutputPreparationError(
      `Frontend source must be the owned Vite output ${expectedSourceDirectory}.`,
    );
  }

  const packageRoot = resolve(projectDirectory, "zig-out/package");
  const appBundlePath = resolve(options.appBundlePath);
  if (
    dirname(appBundlePath) !== packageRoot ||
    !LEGACY_OPRTE_PACKAGE_APP_NAME.test(basename(appBundlePath))
  ) {
    throw new PackageOutputPreparationError(
      `Refusing to remove a target outside the exact legacy OPRTE bridge package pattern: ${appBundlePath}.`,
    );
  }

  const initialTargetStat = await existingBundleDirectoryStat(appBundlePath);
  await validateFrontendBuild({ sourceDirectory });
  await rejectSymlinkedExistingAncestor(projectDirectory, packageRoot);
  await removeEphemeralViteProof(sourceDirectory);
  if (initialTargetStat === null) return;
  const finalTargetStat = await existingBundleDirectoryStat(appBundlePath);
  if (
    finalTargetStat === null ||
    finalTargetStat.dev !== initialTargetStat.dev ||
    finalTargetStat.ino !== initialTargetStat.ino
  ) {
    throw new PackageOutputPreparationError(
      `Package target changed during preparation: ${appBundlePath}.`,
    );
  }
  await rm(appBundlePath, { recursive: true });
}

async function existingBundleDirectoryStat(
  appBundlePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    const stat = await lstat(appBundlePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PackageOutputPreparationError(
        `Refusing to remove package target that is not a real directory: ${appBundlePath}.`,
      );
    }
    return stat;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function removeEphemeralViteProof(sourceDirectory: string): Promise<void> {
  const proofDirectory = resolve(sourceDirectory, ".vite");
  const stat = await lstat(proofDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PackageOutputPreparationError(
      `Ephemeral Vite proof must be a real directory: ${proofDirectory}.`,
    );
  }
  await rm(proofDirectory, { recursive: true });
}

async function rejectSymlinkedExistingAncestor(
  projectDirectory: string,
  packageRoot: string,
): Promise<void> {
  for (const path of [
    projectDirectory,
    resolve(projectDirectory, "zig-out"),
    packageRoot,
  ]) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new PackageOutputPreparationError(
          `Package output ancestor must be a real directory: ${path}.`,
        );
      }
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseCliArguments(argv: readonly string[]): {
  readonly appBundlePath: string;
  readonly sourceDirectory: string;
} {
  if (argv.length !== 4) {
    throw new Error(
      "Usage: prepare-package-output.ts --source <dir> --app-bundle <path>",
    );
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !["--source", "--app-bundle"].includes(key) ||
      values.has(key)
    ) {
      throw new Error(
        "Usage: prepare-package-output.ts --source <dir> --app-bundle <path>",
      );
    }
    values.set(key, value);
  }
  const sourceDirectory = values.get("--source");
  const appBundlePath = values.get("--app-bundle");
  if (sourceDirectory === undefined || appBundlePath === undefined) {
    throw new Error("--source and --app-bundle are required.");
  }
  return { appBundlePath, sourceDirectory };
}

if (import.meta.main) {
  await preparePackageOutput(parseCliArguments(process.argv.slice(2)));
}
