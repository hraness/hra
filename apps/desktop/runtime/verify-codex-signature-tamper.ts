import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  codexSignatureNormalizationEntry,
  codexSignatureNormalizationPolicy,
} from "./codex-signature-normalization";
import { macosPackage } from "./macos-package-config";
import { sha256File, verifyMacOSApp } from "./verify-macos-package";

async function privateTemporaryRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hra-codex-signature-tamper-")),
  );
  const status = await lstat(root);
  if (
    !status.isDirectory()
    || status.isSymbolicLink()
    || status.uid !== process.getuid?.()
    || (status.mode & 0o777) !== 0o700
  ) {
    await rm(root, { force: true, recursive: true });
    throw new Error("Codex signature tamper root is not an owner-private directory.");
  }
  return root;
}

async function expectAppRejection(
  appPath: string,
  label: string,
  expectedMessage: string,
): Promise<void> {
  try {
    await verifyMacOSApp(appPath);
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      process.stdout.write(`Codex signature tamper rejected: ${label}.\n`);
      return;
    }
    throw error;
  }
  throw new Error(`Codex signature tamper was accepted: ${label}.`);
}

async function mutateLastByte(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size < 1) {
    throw new Error(`Tamper target must be a nonempty regular single-link file: ${path}`);
  }
  const handle = await open(path, "r+");
  try {
    const byte = Buffer.alloc(1);
    const read = await handle.read(byte, 0, 1, status.size - 1);
    if (read.bytesRead !== 1) throw new Error(`Could not read tamper target: ${path}`);
    byte[0] = byte[0]! ^ 0xff;
    const written = await handle.write(byte, 0, 1, status.size - 1);
    if (written.bytesWritten !== 1) throw new Error(`Could not write tamper target: ${path}`);
  } finally {
    await handle.close();
  }
}

async function runCodesign(argv: readonly string[]): Promise<void> {
  const child = Bun.spawn([...argv], {
    cwd: macosPackage.desktopRoot,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
}

async function withRestoredFile(
  temporaryRoot: string,
  target: string,
  backupName: string,
  action: () => Promise<void>,
): Promise<void> {
  const backup = join(temporaryRoot, backupName);
  await copyFile(target, backup, constants.COPYFILE_EXCL);
  const expectedSha256 = await sha256File(backup);
  try {
    await action();
  } finally {
    await copyFile(backup, target);
  }
  if (await sha256File(target) !== expectedSha256) {
    throw new Error(`Tamper regression did not restore its target: ${target}`);
  }
}

function runtimeManifest(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Runtime manifest tamper fixture must be an object.");
  }
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Codex signature tamper regression requires Apple Silicon macOS.");
  }
  const appPath = await realpath(macosPackage.appBundlePath);
  if (appPath !== macosPackage.appBundlePath || !appPath.endsWith(".app")) {
    throw new Error("Codex signature tamper regression requires the exact package app.");
  }
  await verifyMacOSApp(appPath);
  const temporaryRoot = await privateTemporaryRoot();
  try {
    for (const [index, entry] of codexSignatureNormalizationPolicy.entries.entries()) {
      const packagedPath = resolve(appPath, entry.appRelativePath);
      await withRestoredFile(
        temporaryRoot,
        packagedPath,
        `packaged-${index}`,
        async () => {
          await mutateLastByte(packagedPath);
          await expectAppRejection(
            appPath,
            `${entry.payloadPath} packaged bytes`,
            entry.payloadPath === "bin/codex"
              ? "Runtime hash differs: codex/bin/codex"
              : "Normalized Codex package identity differs",
          );
        },
      );

      const deltaPath = resolve(appPath, entry.sourceDelta.path);
      await withRestoredFile(
        temporaryRoot,
        deltaPath,
        `delta-${index}`,
        async () => {
          await mutateLastByte(deltaPath);
          await expectAppRejection(
            appPath,
            `${entry.payloadPath} source delta`,
            "Normalized Codex evidence differs",
          );
        },
      );
    }

    const manifestPath = join(appPath, "Contents/Resources/runtime/manifest.json");
    await withRestoredFile(temporaryRoot, manifestPath, "manifest", async () => {
      const manifest = runtimeManifest(JSON.parse(await readFile(manifestPath, "utf8")));
      const runtime = runtimeManifest(manifest["runtime"]);
      const normalized = runtime["normalizedSignatures"];
      if (!Array.isArray(normalized) || normalized.length === 0) {
        throw new Error("Runtime manifest has no normalized signature tamper target.");
      }
      const first = runtimeManifest(normalized[0]);
      first["path"] = "Contents/Resources/runtime/codex/bin/unreviewed";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await expectAppRejection(
        appPath,
        "normalized manifest path",
        "normalized Codex signatures differ from policy",
      );
    });

    const codex = codexSignatureNormalizationEntry("bin/codex");
    const codexPath = resolve(appPath, codex.appRelativePath);
    await withRestoredFile(temporaryRoot, codexPath, "codex-flags", async () => {
      await runCodesign([
        "/usr/bin/codesign",
        "--force",
        "--sign",
        "-",
        "--identifier",
        codex.packaged.identifier,
        codexPath,
      ]);
      await expectAppRejection(
        appPath,
        "normalized signature without hardened-runtime flags",
        "Runtime hash differs: codex/bin/codex",
      );
    });

    await verifyMacOSApp(appPath);
    await runCodesign([
      "/usr/bin/codesign",
      "--verify",
      "--deep",
      "--strict",
      "--verbose=4",
      appPath,
    ]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
  process.stdout.write("Codex signature tamper regressions passed.\n");
}

if (import.meta.main) await main();
