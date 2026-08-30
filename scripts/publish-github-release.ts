import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  assertReleaseAssetBytes,
  parseGitHubRelease,
  publicRepository,
} from "./release-distribution-policy";
import { assertReleasePackageReady, releaseArchiveName } from "./release-package-policy";

const [tag, archiveArgument, checksumArgument] = process.argv.slice(2);
if (tag === undefined || archiveArgument === undefined || checksumArgument === undefined) {
  throw new Error("Usage: publish-github-release.ts TAG ARTIFACT.tgz SHA256SUMS");
}
if (process.env.GITHUB_REPOSITORY !== publicRepository) {
  throw new Error(`GitHub Release publication must run in ${publicRepository}.`);
}
const verifiedSha = process.env.VERIFIED_SHA;
if (verifiedSha === undefined || !/^[0-9a-f]{40}$/u.test(verifiedSha)) {
  throw new Error("GitHub Release publication requires one verified commit.");
}
const manifest = JSON.parse(await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8")) as unknown;
const inspection = assertReleasePackageReady(manifest);
const archive = resolve(archiveArgument);
const checksum = resolve(checksumArgument);
if (
  tag !== `v${inspection.version}`
  || basename(archive) !== releaseArchiveName(inspection.version)
  || basename(checksum) !== "SHA256SUMS"
) throw new Error("GitHub Release coordinates do not match the public package.");
const archiveBytes = await readFile(archive);
const checksumBytes = await readFile(checksum);

function command(arguments_: string[]): string {
  const result = Bun.spawnSync({ cmd: arguments_, stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${arguments_.join(" ")}\n${result.stderr.toString("utf8")}`);
  }
  return result.stdout.toString("utf8");
}

function release(): unknown {
  return JSON.parse(command(["gh", "api", `/repos/${publicRepository}/releases/tags/${tag}`])) as unknown;
}

const existing = Bun.spawnSync({
  cmd: ["gh", "api", `/repos/${publicRepository}/releases/tags/${tag}`],
  stderr: "pipe",
  stdout: "pipe",
});
if (existing.exitCode !== 0) {
  const failure = `${existing.stdout.toString("utf8")}\n${existing.stderr.toString("utf8")}`;
  if (!/HTTP 404|Not Found|release not found/iu.test(failure)) {
    throw new Error(`GitHub Release existence is indeterminate.\n${failure}`);
  }
  command([
    "gh", "release", "create", tag, archive, checksum,
    "--repo", publicRepository,
    "--generate-notes",
    "--latest",
    "--verify-tag",
    "--title", `HRA ${tag}`,
  ]);
}
const coordinate = parseGitHubRelease(release(), inspection.version);
assertReleaseAssetBytes(
  coordinate,
  archiveBytes,
  checksumBytes,
  (bytes) => createHash("sha256").update(bytes).digest("hex"),
);
const directory = await mkdtemp(join(tmpdir(), "hra-release-readback-"));
try {
  command([
    "gh", "release", "download", tag,
    "--repo", publicRepository,
    "--dir", directory,
    "--pattern", basename(archive),
    "--pattern", "SHA256SUMS",
  ]);
  for (const source of [archive, checksum]) {
    if (!(await readFile(source)).equals(await readFile(join(directory, basename(source))))) {
      throw new Error(`GitHub Release contains different bytes for ${basename(source)}.`);
    }
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}
console.log(`GitHub Release ${tag} contains the exact immutable HRA artifacts.`);
