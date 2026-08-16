import { afterEach, expect, test } from "bun:test";
import {
  RELEASE_CHECKSUM_FILE,
  RELEASE_INSTALLER_FILE,
  RELEASE_MANIFEST_FILE,
  artifactFilename,
  releaseTargetForRuntime,
  releaseTargets,
  sha256,
  type ReleaseManifest,
} from "./release-contract";
import { generateInstaller } from "./installer-template";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(selectedArtifactMarker = ""): Promise<{
  readonly release: string;
  readonly destination: string;
  readonly artifact: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "taskctl-installer-test-")));
  roots.push(root);
  const release = join(root, "release");
  const destinationParent = join(root, "destination");
  await Promise.all([mkdir(release), mkdir(destinationParent)]);
  const target = releaseTargetForRuntime(
    process.platform,
    process.arch,
    process.platform === "linux" ? "glibc" : null,
  );
  if (target === null) throw new Error("test host is outside the supported target matrix");
  const artifact = artifactFilename("0.1.0", target);
  const artifacts: ReleaseManifest["artifacts"] = [];
  for (const releaseTarget of releaseTargets) {
    const file = artifactFilename("0.1.0", releaseTarget);
    const bytes = new TextEncoder().encode(
      releaseTarget.bunTarget === target.bunTarget
        ? `#!/bin/sh\n${selectedArtifactMarker}` +
          "[ \"$" +
          "{1:-}\" = '--help' ] && { printf '%s\\n' 'usage: taskctl'; exit 0; }\nexit 1\n"
        : `binary:${releaseTarget.bunTarget}\n`,
    );
    await writeFile(join(release, file), bytes, { mode: 0o755 });
    artifacts.push({
      platform: releaseTarget.platform,
      arch: releaseTarget.arch,
      libc: releaseTarget.libc,
      bunTarget: releaseTarget.bunTarget,
      file,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  const manifest = {
    schemaVersion: 1,
    product: "taskctl",
    version: "0.1.0",
    bunVersion: "1.3.14",
    artifacts,
    installer: { file: RELEASE_INSTALLER_FILE },
    checksum: { algorithm: "sha256", file: RELEASE_CHECKSUM_FILE },
  } satisfies ReleaseManifest;
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(release, RELEASE_MANIFEST_FILE), manifestBytes);
  const installerBytes = new TextEncoder().encode(
    generateInstaller({
      version: "0.1.0",
      artifacts,
      manifest: {
        file: RELEASE_MANIFEST_FILE,
        bytes: manifestBytes.byteLength,
        sha256: sha256(manifestBytes),
      },
    }),
  );
  await writeFile(join(release, RELEASE_INSTALLER_FILE), installerBytes, { mode: 0o755 });
  const checksumFiles = [
    ...artifacts.map((candidate) => candidate.file),
    RELEASE_INSTALLER_FILE,
    RELEASE_MANIFEST_FILE,
  ].sort();
  const checksumLines: string[] = [];
  for (const file of checksumFiles) {
    checksumLines.push(`${sha256(new Uint8Array(await readFile(join(release, file))))}  ${file}`);
  }
  await writeFile(join(release, RELEASE_CHECKSUM_FILE), `${checksumLines.join("\n")}\n`);
  return { release, destination: join(destinationParent, "taskctl"), artifact };
}

async function runInstaller(
  release: string,
  destination: string,
  extra: readonly string[] = [],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const processHandle = Bun.spawn(
    [
      "/bin/sh",
      join(release, RELEASE_INSTALLER_FILE),
      "--source-dir",
      release,
      "--destination",
      destination,
      ...extra,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("generated installer verifies and atomically installs the current local artifact", async () => {
  const value = await fixture();
  const result = await runInstaller(value.release, value.destination);
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  expect(result.stdout).toContain(value.destination);
  expect((await readFile(value.destination, "utf8"))).toContain("usage: taskctl");
  const help = Bun.spawn([value.destination, "--help"], { stdout: "pipe", stderr: "pipe" });
  expect(await help.exited).toBe(0);
  expect(await new Response(help.stdout).text()).toContain("usage: taskctl");
});

test("generated installer rejects checksum tampering before destination creation", async () => {
  const value = await fixture();
  const artifactPath = join(value.release, value.artifact);
  const tampered = new Uint8Array(await readFile(artifactPath));
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  await writeFile(artifactPath, tampered, { mode: 0o755 });
  const result = await runInstaller(value.release, value.destination);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("SHA-256 verification failed");
  expect(readFile(value.destination)).rejects.toThrow();
});

test("generated installer requires explicit replacement and rejects non-normalized destinations", async () => {
  const value = await fixture();
  await writeFile(value.destination, "existing");
  const noReplace = await runInstaller(value.release, value.destination);
  expect(noReplace.exitCode).not.toBe(0);
  expect(noReplace.stderr).toContain("--replace");
  const replace = await runInstaller(value.release, value.destination, ["--replace"]);
  expect(replace.exitCode).toBe(0);

  const unsafe = await runInstaller(value.release, `${value.destination}/../taskctl`);
  expect(unsafe.exitCode).not.toBe(0);
  expect(unsafe.stderr).toContain("normalized");
});

test("generated installer binds the exact manifest and checksum set", async () => {
  const tamperedManifest = await fixture();
  const manifestPath = join(tamperedManifest.release, RELEASE_MANIFEST_FILE);
  const manifestSource = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    manifestSource.replace('"product": "taskctl"', '"product": "taskctm"'),
  );
  const manifestResult = await runInstaller(
    tamperedManifest.release,
    tamperedManifest.destination,
  );
  expect(manifestResult.exitCode).not.toBe(0);
  expect(manifestResult.stderr).toContain("manifest does not match this installer build");

  const omittedChecksum = await fixture();
  const omittedPath = join(omittedChecksum.release, RELEASE_CHECKSUM_FILE);
  const checksumLines = (await readFile(omittedPath, "utf8")).trimEnd().split("\n");
  await writeFile(omittedPath, `${checksumLines.slice(1).join("\n")}\n`);
  const omittedResult = await runInstaller(omittedChecksum.release, omittedChecksum.destination);
  expect(omittedResult.exitCode).not.toBe(0);
  expect(omittedResult.stderr).toContain("exact six release entries");

  const extraChecksum = await fixture();
  const extraPath = join(extraChecksum.release, RELEASE_CHECKSUM_FILE);
  await writeFile(
    extraPath,
    `${await readFile(extraPath, "utf8")}${"0".repeat(64)}  stale-extra\n`,
  );
  const extraResult = await runInstaller(extraChecksum.release, extraChecksum.destination);
  expect(extraResult.exitCode).not.toBe(0);
  expect(extraResult.stderr).toContain("exact six release entries");

  const unterminatedExtra = await fixture();
  const unterminatedPath = join(unterminatedExtra.release, RELEASE_CHECKSUM_FILE);
  await writeFile(
    unterminatedPath,
    `${await readFile(unterminatedPath, "utf8")}${"0".repeat(64)}  unterminated-extra`,
  );
  const unterminatedResult = await runInstaller(
    unterminatedExtra.release,
    unterminatedExtra.destination,
  );
  expect(unterminatedResult.exitCode).not.toBe(0);
  expect(unterminatedResult.stderr).toContain("exact six release entries");

  const staleChecksum = await fixture();
  const stalePath = join(staleChecksum.release, RELEASE_CHECKSUM_FILE);
  const staleSource = await readFile(stalePath, "utf8");
  await writeFile(stalePath, staleSource.replace(/^[0-9a-f]{64}/u, "0".repeat(64)));
  const staleResult = await runInstaller(staleChecksum.release, staleChecksum.destination);
  expect(staleResult.exitCode).not.toBe(0);
  expect(staleResult.stderr).toContain("stale, mixed, incomplete, or duplicated");

  const trustedInstaller = await fixture("# release alpha\n");
  const otherRelease = await fixture("# release bravo\n");
  await writeFile(
    join(otherRelease.release, RELEASE_INSTALLER_FILE),
    await readFile(join(trustedInstaller.release, RELEASE_INSTALLER_FILE)),
    { mode: 0o755 },
  );
  const mixedResult = await runInstaller(otherRelease.release, otherRelease.destination);
  expect(mixedResult.exitCode).not.toBe(0);
  expect(mixedResult.stderr).toContain("stale, mixed, incomplete, or duplicated");
}, 20_000);

test("generated installer rejects symlinked and oversized release metadata", async () => {
  const linkedManifest = await fixture();
  const manifestPath = join(linkedManifest.release, RELEASE_MANIFEST_FILE);
  await rename(manifestPath, `${manifestPath}.real`);
  await symlink(`${RELEASE_MANIFEST_FILE}.real`, manifestPath);
  const linkedResult = await runInstaller(linkedManifest.release, linkedManifest.destination);
  expect(linkedResult.exitCode).not.toBe(0);
  expect(linkedResult.stderr).toContain("symbolic link");

  const oversizedChecksums = await fixture();
  await writeFile(
    join(oversizedChecksums.release, RELEASE_CHECKSUM_FILE),
    "x".repeat(64 * 1_024 + 1),
  );
  const oversizedResult = await runInstaller(
    oversizedChecksums.release,
    oversizedChecksums.destination,
  );
  expect(oversizedResult.exitCode).not.toBe(0);
  expect(oversizedResult.stderr).toContain("checksum file is too large");

  const oversizedManifest = await fixture();
  await writeFile(
    join(oversizedManifest.release, RELEASE_MANIFEST_FILE),
    "x".repeat(64 * 1_024 + 1),
  );
  const oversizedManifestResult = await runInstaller(
    oversizedManifest.release,
    oversizedManifest.destination,
  );
  expect(oversizedManifestResult.exitCode).not.toBe(0);
  expect(oversizedManifestResult.stderr).toContain("manifest is too large");
});
