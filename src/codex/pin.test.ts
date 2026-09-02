import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { CODEX_PIN, PINNED_CODEX_MATRIX_DIGESTS, PINNED_CODEX_SCHEMA_DIGESTS } from "./pin.ts";
import { PINNED_CODEX_VERSION } from "./protocol.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const srcRoot = join(repoRoot, "src");

describe("CODEX_PIN", () => {
  test("is an exact release that equals the installed @openai/codex package", async () => {
    expect(CODEX_PIN).toMatch(/^\d+\.\d+\.\d+$/u);
    const manifestPath = Bun.resolveSync("@openai/codex/package.json", repoRoot);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    expect(manifest).toMatchObject({ name: "@openai/codex", version: CODEX_PIN });
    expect(PINNED_CODEX_VERSION).toBe(CODEX_PIN);
  });

  test("equals the exact @openai/codex dependency in package.json", async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as unknown;
    expect(manifest).toMatchObject({ dependencies: { "@openai/codex": CODEX_PIN } });
  });

  test("records six schema digests and two matrix digests", () => {
    const digests = [...Object.values(PINNED_CODEX_SCHEMA_DIGESTS), ...Object.values(PINNED_CODEX_MATRIX_DIGESTS)];
    expect(digests).toHaveLength(8);
    for (const digest of digests) expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(new Set(digests).size).toBe(8);
  });

  test("is the only non-test src file that spells the pinned version", async () => {
    const offenders: string[] = [];
    const escaped = CODEX_PIN.replaceAll(".", "\\.");
    const literal = new RegExp(`(?<![0-9.])${escaped}(?![0-9.])`, "u");
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: srcRoot, absolute: true })) {
      const relativePath = relative(srcRoot, path);
      if (relativePath.endsWith(".test.ts") || relativePath === "codex/pin.ts") continue;
      if (literal.test(await readFile(path, "utf8"))) offenders.push(relativePath);
    }
    expect(offenders.sort()).toEqual([]);
  });
});
