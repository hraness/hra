import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import runtimeVersions from "../runtime-versions.json";
import { resolvePortableRuntimeAssets } from "./runtime-paths";

const packageSmokeEnvironment = "HRA_PACKAGE_SMOKE_ROOT";
const packageSmokePrefix = "hra-package-smoke-";
const packageSmokeDurationMilliseconds = 30_000;

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    !fromRoot.startsWith(`..${sep}`)
    && fromRoot !== ".."
    && !fromRoot.startsWith(sep)
  );
}

export function packageSmokeRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const rawRoot = environment[packageSmokeEnvironment];
  if (rawRoot === undefined) return null;
  if (
    !isAbsolute(rawRoot)
    || basename(rawRoot).length <= packageSmokePrefix.length
    || !basename(rawRoot).startsWith(packageSmokePrefix)
  ) {
    throw new Error("Package smoke root is invalid.");
  }
  const expected = resolve(rawRoot);
  const canonical = realpathSync(rawRoot);
  const metadata = lstatSync(rawRoot);
  const expectedUser = typeof process.getuid === "function"
    ? process.getuid()
    : undefined;
  if (
    canonical !== expected
    || metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (expectedUser !== undefined && metadata.uid !== expectedUser)
    || (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Package smoke root is not an owned private directory.");
  }
  return canonical;
}

function commandVersion(argv: readonly string[]): string {
  const result = Bun.spawnSync([...argv], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Package smoke command failed: ${argv[0]}`);
  }
  return result.stdout.toString().trim();
}

export async function runPackageSmoke(root: string): Promise<void> {
  const assets = resolvePortableRuntimeAssets();
  const gateway = realpathSync(process.execPath);
  const configuredGateway = process.env.HRA_GATEWAY_PATH;
  if (
    configuredGateway === undefined
    || realpathSync(configuredGateway) !== gateway
  ) {
    throw new Error("Package smoke gateway identity differs from the host pin.");
  }
  const runtimeRoot = dirname(dirname(gateway));
  if (
    !inside(runtimeRoot, assets.bunBinary)
    || !inside(runtimeRoot, assets.codexBinary)
    || !inside(runtimeRoot, assets.gitBinary)
    || !inside(runtimeRoot, assets.gitRoot)
  ) {
    throw new Error("Package smoke toolchain escaped the bundled runtime.");
  }
  const codexVersion = commandVersion([assets.codexBinary, "--version"]);
  const bunVersion = commandVersion([assets.bunBinary, "--version"]);
  const gitVersion = commandVersion([assets.gitBinary, "--version"]);
  if (
    Bun.version !== "1.3.14"
    || bunVersion !== runtimeVersions.bun.version
    || codexVersion !== `codex-cli ${runtimeVersions.codex.version}`
    || gitVersion !== `git version ${runtimeVersions.git.version}`
  ) {
    throw new Error("Package smoke runtime versions differ from their pins.");
  }

  const marker = resolve(root, "gateway-ready.json");
  if (!inside(root, marker)) {
    throw new Error("Package smoke marker escaped its root.");
  }
  const descriptor = openSync(
    marker,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify({
      bunVersion: Bun.version,
      setupBunVersion: bunVersion,
      codexVersion,
      gitVersion,
      schemaVersion: 1,
    })}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  await Bun.sleep(packageSmokeDurationMilliseconds);
}
