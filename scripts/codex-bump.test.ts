import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CODEX_PIN, PINNED_CODEX_MATRIX_DIGESTS, PINNED_CODEX_SCHEMA_DIGESTS } from "../src/codex/pin";
import {
  CODEX_BUMP_EXIT,
  CODEX_PIN_RELATIVE_PATH,
  CodexBumpRefusedError,
  TRACKED_CODEX_SCHEMA_FILES,
  matrixDrift,
  methodsInGeneratedUnion,
  parseCodexBumpArguments,
  parseCodexManifest,
  parseRepositoryCodexDependency,
  renderCodexPinSource,
  runCodexBump,
} from "./codex-bump";

const repoRoot = resolve(import.meta.dir, "..");

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
