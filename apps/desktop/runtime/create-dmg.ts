import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import {
  correspondingSourceSpecs,
  createCorrespondingSourceArchives,
} from "./corresponding-sources";
import { macosPackage } from "./macos-package-config";
import {
  sha256File,
  verifyMacOSApp,
  verifyMacOSCoreArtifacts,
  verifyMacOSDmg,
  verifyMacOSReleaseArtifacts,
} from "./verify-macos-package";

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    !fromRoot.startsWith(`..${sep}`)
    && fromRoot !== ".."
    && !fromRoot.startsWith(sep)
  );
}

async function run(argv: readonly string[]): Promise<string> {
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
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return stdout;
}

async function gitStatusIsClean(): Promise<boolean> {
  return (await run(["/usr/bin/git", "status", "--porcelain=v1", "--untracked-files=all"])).trim() === "";
}

async function main(): Promise<void> {
  const coreOnly = process.argv.length === 3 && process.argv[2] === "--core-only";
  if (!coreOnly && process.argv.length !== 2) {
    throw new Error("Usage: bun run create-dmg.ts [--core-only]");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("HRA DMG creation requires Apple Silicon macOS.");
  }
  if (!coreOnly && !await gitStatusIsClean()) {
    throw new Error("Refusing to create release artifacts from a dirty source tree.");
  }
  const appEvidence = await verifyMacOSApp();
  const releaseRoot = macosPackage.releaseDirectory;
  const dmgPath = join(releaseRoot, `${macosPackage.artifactBaseName}.dmg`);
  const checksumPath = `${dmgPath}.sha256`;
  const manifestPath = join(
    releaseRoot,
    `HRA-${macosPackage.version}-${macosPackage.build}-release-manifest.json`,
  );
  const sourcePaths = correspondingSourceSpecs.map((spec) =>
    join(releaseRoot, spec.archiveName));
  const releasePaths = [dmgPath, checksumPath, manifestPath, ...sourcePaths];
  for (const path of releasePaths) {
    if (!inside(releaseRoot, path)) {
      throw new Error(`Refusing to replace release output outside ${releaseRoot}.`);
    }
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hra-dmg-create-"));
  const stagingRoot = join(temporaryRoot, "root");
  const outputRoot = join(temporaryRoot, "output");
  const temporaryDmg = join(outputRoot, `${macosPackage.artifactBaseName}.dmg`);
  const temporaryChecksum = `${temporaryDmg}.sha256`;
  const temporaryManifest = join(
    outputRoot,
    `HRA-${macosPackage.version}-${macosPackage.build}-release-manifest.json`,
  );
  let correspondingSources = [] as Awaited<ReturnType<typeof createCorrespondingSourceArchives>>;
  try {
    await mkdir(stagingRoot, { mode: 0o755 });
    await mkdir(outputRoot, { mode: 0o755 });
    await run([
      "/usr/bin/ditto",
      "--rsrc",
      "--extattr",
      macosPackage.appBundlePath,
      join(stagingRoot, "HRA.app"),
    ]);
    await symlink("/Applications", join(stagingRoot, "Applications"));
    const rootEntries = (await Array.fromAsync(new Bun.Glob("*").scan({
      absolute: false,
      cwd: stagingRoot,
      onlyFiles: false,
    }))).sort();
    if (JSON.stringify(rootEntries) !== JSON.stringify(["Applications", "HRA.app"])) {
      throw new Error(`DMG staging root differs: ${rootEntries.join(", ")}`);
    }
    await run([
      "/usr/bin/hdiutil",
      "create",
      "-format",
      "UDZO",
      "-imagekey",
      "zlib-level=9",
      "-ov",
      "-srcfolder",
      stagingRoot,
      "-volname",
      macosPackage.productName,
      temporaryDmg,
    ]);
    if (!coreOnly) {
      correspondingSources = await createCorrespondingSourceArchives(outputRoot);
    }
    await verifyMacOSDmg(temporaryDmg);
    const dmgSha256 = await sha256File(temporaryDmg);
    const dmgBytes = (await lstat(temporaryDmg)).size;
    await writeFile(
      temporaryChecksum,
      `${dmgSha256}  ${basename(temporaryDmg)}\n`,
      { flag: "wx" },
    );
    if (coreOnly) {
      await verifyMacOSCoreArtifacts(outputRoot);
    } else {
      const runtimeManifest = JSON.parse(await readFile(
        join(macosPackage.appBundlePath, "Contents/Resources/runtime/manifest.json"),
        "utf8",
      )) as unknown;
      const releaseManifest = {
        schemaVersion: 1,
        artifact: {
          bytes: dmgBytes,
          name: basename(temporaryDmg),
          sha256: dmgSha256,
        },
        correspondingSources,
        release: {
          architecture: macosPackage.architecture,
          build: macosPackage.build,
          commit: appEvidence.commit,
          minimumMacOS: macosPackage.minimumMacOS,
          notarized: false,
          signing: "adhoc",
          version: macosPackage.version,
        },
        runtimeTreeSha256: appEvidence.treeSha256,
        runtimeManifest,
        sourceTreeCleanAtPackaging: true,
      } as const;
      await writeFile(
        temporaryManifest,
        `${JSON.stringify(releaseManifest, null, 2)}\n`,
        { flag: "wx" },
      );
      await verifyMacOSReleaseArtifacts(outputRoot);
    }

    const allowedExistingNames = new Set(releasePaths.map((path) => basename(path)));
    const previousReleaseRoot = join(temporaryRoot, "previous-release");
    let previousReleaseMoved = false;
    let stagedReleaseInstalled = false;
    await mkdir(dirname(releaseRoot), { recursive: true, mode: 0o755 });
    try {
      const releaseStatus = await lstat(releaseRoot);
      if (!releaseStatus.isDirectory() || releaseStatus.isSymbolicLink()) {
        throw new Error(`Release path must be a real directory: ${releaseRoot}`);
      }
      for (const name of await readdir(releaseRoot)) {
        if (!allowedExistingNames.has(name)) {
          throw new Error(`Refusing to replace unknown release entry: ${name}`);
        }
        const entryStatus = await lstat(join(releaseRoot, name));
        if (!entryStatus.isFile() || entryStatus.isSymbolicLink()) {
          throw new Error(`Existing release entry is not a regular file: ${name}`);
        }
      }
      await rename(releaseRoot, previousReleaseRoot);
      previousReleaseMoved = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    try {
      await rename(outputRoot, releaseRoot);
      stagedReleaseInstalled = true;
      if (coreOnly) {
        await verifyMacOSCoreArtifacts(releaseRoot);
        process.stdout.write(`${dmgPath}\n${checksumPath}\n`);
      } else {
        await verifyMacOSReleaseArtifacts(releaseRoot);
        process.stdout.write(`${dmgPath}\n${checksumPath}\n${manifestPath}\n`);
      }
    } catch (error) {
      if (stagedReleaseInstalled) {
        await rename(releaseRoot, outputRoot);
        stagedReleaseInstalled = false;
      }
      if (previousReleaseMoved) {
        await rename(previousReleaseRoot, releaseRoot);
        previousReleaseMoved = false;
      }
      throw error;
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

if (import.meta.main) await main();
