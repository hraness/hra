import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CODEX_PIN, PINNED_CODEX_MATRIX_DIGESTS, PINNED_CODEX_SCHEMA_DIGESTS } from "../src/codex/pin";
import {
  CODEX_BUMP_EXIT,
  CODEX_PIN_RELATIVE_PATH,
  CodexBumpRefusedError,
  TRACKED_CODEX_SCHEMA_FILES,
  generateCodexSchemas,
  matrixDrift,
  methodsInGeneratedUnion,
  parseCodexBumpArguments,
  parseCodexManifest,
  parseRepositoryCodexDependency,
  renderCodexPinSource,
  runCodexBump,
} from "./codex-bump";
import { BoundedProcessCleanupUnprovenError, runBoundedProcess } from "./bounded-process";

const repoRoot = resolve(import.meta.dir, "..");

const expectAbsentPath = async (path: string): Promise<void> => {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
};

const waitForMarker = async (path: string): Promise<void> => {
  const deadline = performance.now() + 3_000;
  while (!await Bun.file(path).exists()) {
    if (performance.now() >= deadline) throw new Error("Schema fixture did not start");
    await Bun.sleep(10);
  }
};

describe("codex-bump process custody", () => {
  test("the output absence assertion refuses an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-codex-absence-test-"));
    try {
      await expect(expectAbsentPath(root)).rejects.toThrow();
      await expectAbsentPath(join(root, "absent"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pre-cancelled generation never dispatches its launcher", async () => {
    const cancellation = new AbortController(); cancellation.abort();
    let dispatched = false;
    await expect(generateCodexSchemas({
      bunExecutable: process.execPath, launcher: "/unused/codex.js", signal: cancellation.signal,
    }, async () => {
      dispatched = true;
      throw new Error("Unexpected dispatch");
    })).rejects.toThrow("cancelled");
    expect(dispatched).toBe(false);
  });

  test.each(["timeout", "overflow", "cancel"] as const)("collects a %s schema process before removing its output", async (scenario) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-codex-custody-test-")));
    const launcher = join(root, "codex.js"), marker = join(root, "ready.json");
    const cancellation = new AbortController();
    let outputDirectory: string | undefined;
    let collected = false;
    let pending: Promise<unknown> | undefined;
    const childProgram = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, parent: process.ppid }));`,
      scenario === "overflow" ? "process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1024, 120));" : "",
      "setInterval(() => undefined, 1000);",
    ].join("\n");
    await writeFile(launcher, [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
      "child.unref();",
    ].join("\n"));
    try {
      pending = generateCodexSchemas({ bunExecutable: process.execPath, launcher, signal: cancellation.signal }, async (request, dependencies) => {
        expect(request.arguments.slice(0, -1)).toEqual([launcher, "app-server", "generate-ts", "--experimental", "--out"]);
        expect(request.executable).toBe(process.execPath);
        expect(request).toMatchObject({ containment: "local", timeoutMs: 90_000, terminationGraceMs: 2_000,
          killSettlementMs: 5_000, outputMaximumBytes: 4 * 1024 * 1024 });
        outputDirectory = request.arguments.at(-1);
        expect(dependencies?.recoveryDirectory).toBe(join(outputDirectory ?? "", "process-recovery"));
        const result = await runBoundedProcess({ ...request, timeoutMs: scenario === "timeout" ? 500 : 3_000,
          terminationGraceMs: 25, killSettlementMs: 1_000 }, dependencies);
        collected = result.cleanup === "proven";
        expect(result.cleanup).toBe("proven");
        expect(result.cleanup === "proven" ? result.exitCode : undefined).toBe(scenario === "timeout" ? 124 : scenario === "cancel" ? 130 : 1);
        expect(result.stdout.byteLength + result.stderr.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
        return result;
      }).then(() => undefined, (error: unknown) => error);
      if (scenario === "cancel") { await waitForMarker(marker); cancellation.abort(); }
      const failure = await pending;
      expect(failure).toBeInstanceOf(CodexBumpRefusedError);
      expect(collected).toBe(true);
      const identity = JSON.parse(await readFile(marker, "utf8")) as { pid: number; parent: number };
      expect(() => process.kill(identity.pid, 0)).toThrow();
      expect(outputDirectory).toBeDefined();
      await expectAbsentPath(outputDirectory ?? "");
    } finally {
      cancellation.abort();
      await pending;
      // Uncertain writers retain their fixture source and marker as well as
      // the separate generated-output directory and recovery journal.
      if (collected) await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("an unproven result retains both generated evidence and its journal", async () => {
    let outputDirectory = "", journal = "";
    try {
      const failure = await generateCodexSchemas({ bunExecutable: process.execPath, launcher: "/fixture/codex.js" }, async (request, dependencies) => {
        outputDirectory = request.arguments.at(-1) ?? "";
        const recoveryDirectory = dependencies?.recoveryDirectory;
        if (recoveryDirectory === undefined) throw new Error("Missing run-owned recovery directory");
        await mkdir(recoveryDirectory, { mode: 0o700 });
        journal = join(recoveryDirectory, "fixture-journal.json");
        await writeFile(journal, "retained journal");
        await writeFile(join(outputDirectory, "partial-schema.ts"), "retained partial schema");
        return { cleanup: "unproven", phase: request.phase, processGroupId: 42_424,
          recoveryIdentity: { containment: "local", processGroupId: 42_424 }, recoveryPath: journal,
          stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(BoundedProcessCleanupUnprovenError);
      if (!(failure instanceof BoundedProcessCleanupUnprovenError)) throw failure;
      expect(failure.recoveryPaths).toContain(outputDirectory);
      expect(failure.recoveryPaths).toContain(journal);
      expect(await readFile(journal, "utf8")).toBe("retained journal");
      expect(await readFile(join(outputDirectory, "partial-schema.ts"), "utf8")).toBe("retained partial schema");
    } finally {
      // This injected result never created a process. It is safe to remove
      // exactly this synthetic evidence after proving production retained it.
      if (outputDirectory !== "") await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});

describe("codex-bump arguments", () => {
  test("accepts one exact release and an optional --check", () => {
    expect(parseCodexBumpArguments(["1.2.3"])).toEqual({ version: "1.2.3", mode: "write" });
    expect(parseCodexBumpArguments(["--check", "0.149.0"])).toEqual({ version: "0.149.0", mode: "check" });
  });

  test("rejects ranges, prereleases, unknown flags, and extra values", () => {
    for (const argv of [[], ["^1.2.3"], ["1.2.3-beta.1"], ["1.2"], ["v1.2.3"], ["1.2.3", "--force"], ["1.2.3", "4.5.6"], ["--check", "--check", "1.2.3"], ["01.2.3"]]) {
      expect(() => parseCodexBumpArguments(argv)).toThrow(CodexBumpRefusedError);
    }
  });
});

describe("codex-bump manifests", () => {
  test("parses the installed manifest from unknown and contains the launcher", () => {
    const manifest = parseCodexManifest(
      { name: "@openai/codex", version: "0.149.0", bin: { codex: "bin/codex.js" } },
      "/repo/node_modules/@openai/codex/package.json",
    );
    expect(manifest).toEqual({ version: "0.149.0", launcher: "/repo/node_modules/@openai/codex/bin/codex.js" });
    expect(parseCodexManifest(
      { name: "@openai/codex", version: "0.149.0", bin: "codex.js" },
      "/repo/node_modules/@openai/codex/package.json",
    ).launcher).toBe("/repo/node_modules/@openai/codex/codex.js");
    for (const malformed of [
      null,
      {},
      { name: "@openai/other", version: "0.149.0", bin: "codex.js" },
      { name: "@openai/codex", version: "0.149.0-rc.1", bin: "codex.js" },
      { name: "@openai/codex", version: "0.149.0", bin: "../escape.js" },
      { name: "@openai/codex", version: "0.149.0" },
    ]) {
      expect(() => parseCodexManifest(malformed, "/repo/node_modules/@openai/codex/package.json"))
        .toThrow(CodexBumpRefusedError);
    }
  });

  test("reads the exact repository dependency", () => {
    expect(parseRepositoryCodexDependency({ dependencies: { "@openai/codex": "0.149.0" } })).toBe("0.149.0");
    expect(() => parseRepositoryCodexDependency({ dependencies: {} })).toThrow(CodexBumpRefusedError);
    expect(() => parseRepositoryCodexDependency(null)).toThrow(CodexBumpRefusedError);
  });
});

describe("codex-bump rendering", () => {
  test("renders the checked-in pin.ts byte for byte from its own constants", async () => {
    const rendered = renderCodexPinSource({
      version: CODEX_PIN,
      schemaDigests: PINNED_CODEX_SCHEMA_DIGESTS,
      matrixDigests: PINNED_CODEX_MATRIX_DIGESTS,
    });
    expect(rendered).toBe(await readFile(join(repoRoot, CODEX_PIN_RELATIVE_PATH), "utf8"));
    expect(Object.keys(PINNED_CODEX_SCHEMA_DIGESTS)).toEqual([...TRACKED_CODEX_SCHEMA_FILES]);
  });

  test("refuses to render a malformed digest", () => {
    expect(() => renderCodexPinSource({
      version: CODEX_PIN,
      schemaDigests: { ...PINNED_CODEX_SCHEMA_DIGESTS, "ServerRequest.ts": "nope" },
      matrixDigests: PINNED_CODEX_MATRIX_DIGESTS,
    })).toThrow(CodexBumpRefusedError);
  });

  test("computes matrix drift in generated order", () => {
    expect(matrixDrift(["a", "b", "d"], ["a", "c", "b"])).toEqual({ added: ["d"], removed: ["c"] });
    expect(matrixDrift(["a"], ["a"])).toEqual({ added: [], removed: [] });
    expect(methodsInGeneratedUnion('| { "method": "x/y", params: A }\n| { "method": "z", params: B }')).toEqual(["x/y", "z"]);
  });
});

describe("codex-bump end to end", () => {
  test("refuses a version that differs from the installed package without touching pin.ts", async () => {
    const lines: string[] = [];
    const before = await readFile(join(repoRoot, CODEX_PIN_RELATIVE_PATH), "utf8");
    const exitCode = await runCodexBump(
      { version: "999.0.0", mode: "write" },
      { repoRoot, bunExecutable: process.execPath, stdout: (line) => lines.push(line) },
    );
    expect(exitCode).toBe(CODEX_BUMP_EXIT.refused);
    expect(lines.join("\n")).toContain("refused");
    expect(await readFile(join(repoRoot, CODEX_PIN_RELATIVE_PATH), "utf8")).toBe(before);
  });

  test("refuses a repository without an exact dependency", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-codex-bump-repo-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
      const lines: string[] = [];
      const exitCode = await runCodexBump(
        { version: CODEX_PIN, mode: "check" },
        { repoRoot: root, bunExecutable: process.execPath, stdout: (line) => lines.push(line) },
      );
      expect(exitCode).toBe(CODEX_BUMP_EXIT.refused);
      expect(lines.join("\n")).toContain("package.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--check against the current pin regenerates every digest and reports the file current", async () => {
    const lines: string[] = [];
    const exitCode = await runCodexBump(
      { version: CODEX_PIN, mode: "check" },
      { repoRoot, bunExecutable: process.execPath, stdout: (line) => lines.push(line) },
    );
    const output = lines.join("\n");
    expect({ exitCode, output }).toEqual({ exitCode: CODEX_BUMP_EXIT.ok, output });
    expect(output).toContain("schema digests: 0 of 15 changed");
    expect(output).toContain("matrix digests: 0 of 2 changed");
    expect(output).toContain("ServerNotification methods: unchanged");
    expect(output).toContain("ServerRequest methods: unchanged");
    expect(output).toContain(`${CODEX_PIN_RELATIVE_PATH}: current`);
  }, 120_000);
});
