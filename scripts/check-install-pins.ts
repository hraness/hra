// The transactional installer pins three digests: the packaged CLI entry
// point, the normalizer module, and (for the public one-line command) the
// tagged preflight runtime. Between releases the working tree may change the
// first two, so this script keeps them consistent and, at release time,
// proves that the public command names the runtime bytes being tagged.
//
//   bun ./scripts/check-install-pins.ts             working-tree check
//   bun ./scripts/check-install-pins.ts --update    re-pin CLI and normalizer digests
//   bun ./scripts/check-install-pins.ts --release-tag v0.2.1
//                                                    working-tree check plus the public-command proof

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { HRA_INSTALL_ARCHIVE_URL, HRA_INSTALL_PREFLIGHT_SOURCE_SHA256, HRA_INSTALL_PREFLIGHT_SOURCE_URL } from "../src/install-preflight";
import { HRA_INSTALL_CLI_SHA256 } from "../src/install-normalizer";
import { HRA_INSTALL_NORMALIZER_SHA256 } from "../src/install-preflight-runtime";

const cliPath = "src/cli.ts";
const normalizerPath = "src/install-normalizer.ts";
const runtimePath = "src/install-preflight-runtime.ts";
const maximumSourceBytes = 8 * 1024 * 1024;
const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

async function sha256File(repositoryRoot: string, path: string): Promise<string> {
  const bytes = await readFile(join(repositoryRoot, path));
  if (bytes.byteLength > maximumSourceBytes) throw new Error(`Refusing to hash oversized source: ${path}`);
  return createHash("sha256").update(bytes).digest("hex");
}

export type InstallPinReport = Readonly<{
  cli: { expected: string; actual: string };
  normalizer: { expected: string; actual: string };
  runtime: { publicCommand: string; actual: string };
}>;

export async function readInstallPins(repositoryRoot: string): Promise<InstallPinReport> {
  return {
    cli: { expected: HRA_INSTALL_CLI_SHA256, actual: await sha256File(repositoryRoot, cliPath) },
    normalizer: { expected: HRA_INSTALL_NORMALIZER_SHA256, actual: await sha256File(repositoryRoot, normalizerPath) },
    runtime: { publicCommand: HRA_INSTALL_PREFLIGHT_SOURCE_SHA256, actual: await sha256File(repositoryRoot, runtimePath) },
  };
}

// Working-tree drift: the CLI and normalizer digests embedded in the installer
// must describe the bytes in this tree, or a locally packed archive would be
// refused by the local preflight.
export function workingTreePinDrift(report: InstallPinReport): string[] {
  const drift: string[] = [];
  if (report.cli.expected !== report.cli.actual) drift.push(`${cliPath} digest ${report.cli.actual} is not the pinned ${report.cli.expected}`);
  if (report.normalizer.expected !== report.normalizer.actual) drift.push(`${normalizerPath} digest ${report.normalizer.actual} is not the pinned ${report.normalizer.expected}`);
  return drift;
}

// Release proof: the public one-line command downloads the runtime at the
// tag being released and checks it against the pinned digest, so at the tag
// the working tree's runtime bytes must be exactly those bytes and every URL
// must name that tag.
export function releasePinDrift(report: InstallPinReport, releaseTag: string, packageVersion: string): string[] {
  const drift = workingTreePinDrift(report);
  const tag = z.string().regex(tagPattern).parse(releaseTag);
  if (tag !== `v${packageVersion}`) drift.push(`release tag ${tag} does not match package.json version ${packageVersion}`);
  if (!digestPattern.test(report.runtime.publicCommand)) drift.push("public command digest is not a SHA-256 hex digest");
  if (report.runtime.publicCommand !== report.runtime.actual) {
    drift.push(`${runtimePath} digest ${report.runtime.actual} is not the public command digest ${report.runtime.publicCommand}`);
  }
  const expectedRuntimeUrl = `https://raw.githubusercontent.com/hraness/hra/${tag}/src/install-preflight-runtime.ts`;
  if (HRA_INSTALL_PREFLIGHT_SOURCE_URL !== expectedRuntimeUrl) drift.push(`public command runtime URL is not ${expectedRuntimeUrl}`);
  const expectedArchiveUrl = `https://github.com/hraness/hra/releases/download/${tag}/hraness-hra-${packageVersion}.tgz`;
  if (HRA_INSTALL_ARCHIVE_URL !== expectedArchiveUrl) drift.push(`public command archive URL is not ${expectedArchiveUrl}`);
  return drift;
}

export async function assertInstallPinsForRelease(repositoryRoot: string, releaseTag: string): Promise<void> {
  const manifest = z.object({ version: z.string().min(1).max(64) }).passthrough().parse(JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown);
  const drift = releasePinDrift(await readInstallPins(repositoryRoot), releaseTag, manifest.version);
  if (drift.length > 0) throw new Error(`Installer pins are not release-consistent: ${drift.join("; ")}`);
}

async function replaceDigest(repositoryRoot: string, path: string, previous: string, next: string): Promise<number> {
  const text = await readFile(join(repositoryRoot, path), "utf8");
  const count = text.split(previous).length - 1;
  if (count > 0) await writeFile(join(repositoryRoot, path), text.split(previous).join(next));
  return count;
}

// Re-pin order matters: the normalizer embeds the CLI digest, so its own digest
// changes after the CLI digest is rewritten; the runtime embeds both.
export async function updateInstallPins(repositoryRoot: string): Promise<string[]> {
  const notes: string[] = [];
  const before = await readInstallPins(repositoryRoot);
  if (before.cli.expected !== before.cli.actual) {
    for (const path of [normalizerPath, runtimePath]) {
      const count = await replaceDigest(repositoryRoot, path, before.cli.expected, before.cli.actual);
      notes.push(`${path}: replaced ${String(count)} CLI digest site(s)`);
    }
  }
  const normalizerActual = await sha256File(repositoryRoot, normalizerPath);
  if (before.normalizer.expected !== normalizerActual) {
    const count = await replaceDigest(repositoryRoot, runtimePath, before.normalizer.expected, normalizerActual);
    notes.push(`${runtimePath}: replaced ${String(count)} normalizer digest site(s)`);
  }
  if (notes.length === 0) notes.push("installer pins already match the working tree");
  return notes;
}

if (import.meta.main) {
  const repositoryRoot = process.cwd();
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--update")) {
    for (const note of await updateInstallPins(repositoryRoot)) process.stdout.write(`${note}\n`);
    process.stdout.write("Re-run without --update after the module cache refreshes, and commit the pinned files together.\n");
  } else {
    const tagIndex = arguments_.indexOf("--release-tag");
    const report = await readInstallPins(repositoryRoot);
    const drift = tagIndex === -1
      ? workingTreePinDrift(report)
      : releasePinDrift(report, arguments_[tagIndex + 1] ?? "", z.object({ version: z.string() }).passthrough().parse(JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown).version);
    if (drift.length > 0) {
      process.stderr.write("Installer pins drifted. Run `bun run install-pins:update` for working-tree drift; release drift needs the release-preparation change.\n");
      for (const line of drift) process.stderr.write(`  ${line}\n`);
      process.exit(1);
    }
    process.stdout.write(tagIndex === -1 ? "Installer pins match the working tree.\n" : "Installer pins are release-consistent.\n");
  }
}
