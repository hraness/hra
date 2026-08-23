import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CodexError } from "./errors.ts";
import type { CodexProcess } from "./process.ts";
import { launchPinnedCodexAppServer, resolvePinnedCodexRuntime } from "./runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fakePackage(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hra-control-plane-runtime-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "codex.js"), "export {};\n", { mode: 0o700 });
  const packageJsonPath = join(root, "package.json");
  await writeFile(
    packageJsonPath,
    JSON.stringify({ name: "@openai/codex", version, bin: { codex: "bin/codex.js" } }),
  );
  return packageJsonPath;
}

function inertProcess(): CodexProcess {
  const empty: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  };
  return {
    stdout: empty,
    stderr: empty,
    exited: new Promise(() => undefined),
    write: () => Promise.resolve(),
    terminate: () => undefined,
    forceTerminate: () => undefined,
  };
}

describe("pinned Codex runtime", () => {
  test("resolves only the exact package and contained launcher", async () => {
    const packageJsonPath = await fakePackage("0.149.0");
    const runtime = await resolvePinnedCodexRuntime({
      packageJsonPath,
      bunExecutable: process.execPath,
    });
    expect(runtime.packageVersion).toBe("0.149.0");
    expect(runtime.launcherArgv.slice(-3)).toEqual(["app-server", "--listen", "stdio://"]);
  });

  test("fails closed on a version drift", async () => {
    const packageJsonPath = await fakePackage("0.149.1");
    const error = await resolvePinnedCodexRuntime({
      packageJsonPath,
      bunExecutable: process.execPath,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexError);
  });

  test("forwards explicit shutdown bounds to the client", async () => {
    const packageJsonPath = await fakePackage("0.149.0");
    const error = await launchPinnedCodexAppServer({
      packageJsonPath,
      bunExecutable: process.execPath,
      processFactory: () => inertProcess(),
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      shutdownTermGraceMs: 0,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "INVALID_INPUT" });
  });
});
