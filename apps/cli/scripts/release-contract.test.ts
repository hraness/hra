import { afterEach, expect, test } from "bun:test";
import {
  RELEASE_CHECKSUM_FILE,
  RELEASE_INSTALLER_FILE,
  RELEASE_MANIFEST_FILE,
  artifactFilename,
  releaseTargetForRuntime,
  releaseTargets,
  sha256,
  validateInstallDestination,
  verifyReleaseDirectory,
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

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "taskctl-release-test-")));
  roots.push(root);
  return root;
}

async function createReleaseFixture(): Promise<string> {
  const root = await temporaryRoot();
  const version = "0.1.0";
  const artifacts: ReleaseManifest["artifacts"] = [];
  for (const target of releaseTargets) {
    const file = artifactFilename(version, target);
    const bytes = new TextEncoder().encode(`binary:${target.bunTarget}\n`);
    await writeFile(join(root, file), bytes, { mode: 0o755 });
    artifacts.push({
      platform: target.platform,
      arch: target.arch,
      libc: target.libc,
      bunTarget: target.bunTarget,
      file,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  const manifest = {
    schemaVersion: 1,
    product: "taskctl",
    version,
    bunVersion: "1.3.14",
    artifacts,
    installer: { file: RELEASE_INSTALLER_FILE },
    checksum: { algorithm: "sha256", file: RELEASE_CHECKSUM_FILE },
  } satisfies ReleaseManifest;
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, RELEASE_MANIFEST_FILE), manifestBytes);
  const installer = new TextEncoder().encode(
    generateInstaller({
      version,
      artifacts,
      manifest: {
        file: RELEASE_MANIFEST_FILE,
        bytes: manifestBytes.byteLength,
        sha256: sha256(manifestBytes),
      },
    }),
  );
  await writeFile(join(root, RELEASE_INSTALLER_FILE), installer, { mode: 0o755 });
  const checksumFiles = [
    ...artifacts.map((artifact) => artifact.file),
    RELEASE_INSTALLER_FILE,
    RELEASE_MANIFEST_FILE,
  ].sort();
  const lines = [];
  for (const file of checksumFiles) {
    const bytes = new Uint8Array(await readFile(join(root, file)));
    lines.push(`${sha256(bytes)}  ${file}`);
  }
  await writeFile(join(root, RELEASE_CHECKSUM_FILE), `${lines.join("\n")}\n`);
  return root;
}

test("maps only the four pinned runtime combinations", () => {
  expect(releaseTargetForRuntime("darwin", "arm64", null)?.bunTarget).toBe("bun-darwin-arm64");
  expect(releaseTargetForRuntime("darwin", "x64", null)?.bunTarget).toBe("bun-darwin-x64");
  expect(releaseTargetForRuntime("linux", "arm64", "glibc")?.bunTarget).toBe("bun-linux-arm64");
  expect(releaseTargetForRuntime("linux", "x64", "glibc")?.bunTarget).toBe(
    "bun-linux-x64-baseline",
  );
  expect(releaseTargetForRuntime("linux", "x64", "musl")).toBeNull();
  expect(releaseTargetForRuntime("win32", "x64", null)).toBeNull();
  expect(releaseTargetForRuntime("darwin", "riscv64", null)).toBeNull();
});

test("verifies an exact release and fails closed on artifact or manifest tampering", async () => {
  const artifactTamper = await createReleaseFixture();
  expect((await verifyReleaseDirectory(artifactTamper)).artifacts).toHaveLength(4);
  await writeFile(
    join(artifactTamper, artifactFilename("0.1.0", releaseTargets[0])),
    "tampered",
  );
  expect(verifyReleaseDirectory(artifactTamper)).rejects.toThrow("checksum mismatch");

  const manifestTamper = await createReleaseFixture();
  const manifestSource = await readFile(join(manifestTamper, RELEASE_MANIFEST_FILE), "utf8");
  await writeFile(
    join(manifestTamper, RELEASE_MANIFEST_FILE),
    manifestSource.replace('"product": "taskctl"', '"product": "tampered"'),
  );
  expect(verifyReleaseDirectory(manifestTamper)).rejects.toThrow();
});

test("rejects stale, incomplete, or extended checksum sets", async () => {
  const omitted = await createReleaseFixture();
  const omittedPath = join(omitted, RELEASE_CHECKSUM_FILE);
  const omittedLines = (await readFile(omittedPath, "utf8")).trimEnd().split("\n");
  await writeFile(omittedPath, `${omittedLines.slice(1).join("\n")}\n`);
  expect(verifyReleaseDirectory(omitted)).rejects.toThrow("exact release file set");

  const extra = await createReleaseFixture();
  const extraPath = join(extra, RELEASE_CHECKSUM_FILE);
  await writeFile(
    extraPath,
    `${await readFile(extraPath, "utf8")}${"0".repeat(64)}  unexpected-file\n`,
  );
  expect(verifyReleaseDirectory(extra)).rejects.toThrow("exact release file set");

  const stale = await createReleaseFixture();
  const stalePath = join(stale, RELEASE_CHECKSUM_FILE);
  const staleSource = await readFile(stalePath, "utf8");
  await writeFile(stalePath, staleSource.replace(/^[0-9a-f]{64}/u, "0".repeat(64)));
  expect(verifyReleaseDirectory(stale)).rejects.toThrow("checksum mismatch");
});

test("rejects manifest and checksum symlinks before reading them", async () => {
  const linkedManifest = await createReleaseFixture();
  const manifestPath = join(linkedManifest, RELEASE_MANIFEST_FILE);
  await rename(manifestPath, join(linkedManifest, "manifest-backup"));
  await symlink("manifest-backup", manifestPath);
  expect(verifyReleaseDirectory(linkedManifest)).rejects.toThrow("invalid size or type");

  const linkedChecksums = await createReleaseFixture();
  const checksumPath = join(linkedChecksums, RELEASE_CHECKSUM_FILE);
  await rename(checksumPath, join(linkedChecksums, "checksums-backup"));
  await symlink("checksums-backup", checksumPath);
  expect(verifyReleaseDirectory(linkedChecksums)).rejects.toThrow("invalid size or type");
});

test("rejects a symlinked release directory", async () => {
  const release = await createReleaseFixture();
  const linkParent = await temporaryRoot();
  const linkedRelease = join(linkParent, "linked-release");
  await symlink(release, linkedRelease);
  expect(verifyReleaseDirectory(linkedRelease)).rejects.toThrow("real directory");
});

test("rejects oversized manifest and checksum files before parsing", async () => {
  const oversizedManifest = await createReleaseFixture();
  await writeFile(join(oversizedManifest, RELEASE_MANIFEST_FILE), "x".repeat(64 * 1_024 + 1));
  expect(verifyReleaseDirectory(oversizedManifest)).rejects.toThrow("invalid size or type");

  const oversizedChecksums = await createReleaseFixture();
  await writeFile(join(oversizedChecksums, RELEASE_CHECKSUM_FILE), "x".repeat(64 * 1_024 + 1));
  expect(verifyReleaseDirectory(oversizedChecksums)).rejects.toThrow("invalid size or type");
});

test("install destinations are explicit, physical, and replacement-safe", async () => {
  const root = await temporaryRoot();
  const destination = join(root, "taskctl");
  expect(await validateInstallDestination(destination, false)).toMatchObject({ destination });
  expect(validateInstallDestination("relative/taskctl", false)).rejects.toThrow(
    "normalized absolute path",
  );
  expect(validateInstallDestination(`${root}/nested/../taskctl`, false)).rejects.toThrow(
    "normalized absolute path",
  );
  await writeFile(destination, "old");
  expect(validateInstallDestination(destination, false)).rejects.toThrow("--replace");
  expect((await validateInstallDestination(destination, true)).replace).toBeTrue();

  const realParent = join(root, "real-parent");
  await mkdir(realParent);
  const linkedParent = join(root, "linked-parent");
  await symlink(realParent, linkedParent);
  expect(validateInstallDestination(join(linkedParent, "taskctl"), false)).rejects.toThrow();
});

test("generated installer disables curl config and clears named token variables", async () => {
  const fixture = await createReleaseFixture();
  const installer = await readFile(join(fixture, RELEASE_INSTALLER_FILE), "utf8");
  const curlInvocations = installer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("curl "));
  expect(curlInvocations.length).toBeGreaterThan(0);
  for (const invocation of curlInvocations) expect(invocation).toMatch(/^curl -q(?: |$)/u);
  expect(installer.indexOf('unset "$TOKEN_ENV"')).toBeGreaterThan(
    installer.indexOf('TOKEN=$(printenv "$TOKEN_ENV"'),
  );
  expect(installer.indexOf('unset "$TOKEN_ENV"')).toBeLessThan(
    installer.indexOf(`download_remote '${RELEASE_CHECKSUM_FILE}'`),
  );
});

test("generated installer applies metadata-specific transfer and pre-copy size bounds", async () => {
  const fixture = await createReleaseFixture();
  const installer = await readFile(join(fixture, RELEASE_INSTALLER_FILE), "utf8");
  expect(installer).toContain('--max-filesize "$MAX_BYTES"');
  expect(installer).toContain(
    `copy_local '${RELEASE_CHECKSUM_FILE}' '65536' '0' 'checksum file'`,
  );
  expect(installer).toMatch(
    new RegExp(`copy_local '${RELEASE_MANIFEST_FILE}' '65536' '[1-9][0-9]*' 'manifest'`, "u"),
  );
  expect(installer).toContain(
    `download_remote '${RELEASE_CHECKSUM_FILE}' '65536' '0' 'checksum file'`,
  );
  const copyFunction = installer.slice(
    installer.indexOf("copy_local()"),
    installer.indexOf("curl_once()"),
  );
  expect(copyFunction.indexOf("check_source_size")).toBeLessThan(copyFunction.indexOf("cp \"$SOURCE_DIR"));
});

test("generated installer contains no archive extraction or privilege escalation", async () => {
  const fixture = await createReleaseFixture();
  const installer = await readFile(join(fixture, RELEASE_INSTALLER_FILE), "utf8");
  expect(installer).not.toContain("bun-linux-x64-baseline");
  expect(installer).toContain("linux-x64-glibc-baseline");
  expect(installer).toContain("Authorization: Bearer %s");
  expect(installer).toContain("--config \"$CONFIG_FILE\"");
  expect(installer).not.toContain("sudo");
  expect(installer).not.toMatch(/\btar\b|\bunzip\b/u);
});
