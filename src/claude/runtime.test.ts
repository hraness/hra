import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeError } from "./errors";
import {
  CLAUDE_NATIVE_FALLBACK_UNAVAILABLE_REASON,
  CLAUDE_PIN,
  CLAUDE_PIN_EFFORT,
  CLAUDE_PIN_FALLBACK_MODEL,
  CLAUDE_PIN_MODEL,
  CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  type ClaudeNativeFallbackCapability,
} from "./pin";
import { presetRequirements } from "../domain/presets";
import {
  buildPinnedClaudeRuntimeArgv,
  locateClaudeExecutable,
  resolvePinnedClaudeRuntime,
} from "./runtime";

const roots: string[] = [];

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hra-claude-"));
  roots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

const fakeExecutable = async (): Promise<Readonly<{ configDir: string; path: string }>> => {
  const root = await scratch();
  const path = join(root, "claude");
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { configDir: join(root, "config"), path };
};

describe("pinned Claude runtime", () => {
  test("admits the pinned version and builds the exact stream-json argv", async () => {
    const { configDir, path } = await fakeExecutable();
    const runtime = await resolvePinnedClaudeRuntime({
      configDir,
      executablePath: path,
      probeVersion: async () => `${CLAUDE_PIN} (Claude Code)`,
    });
    expect(runtime.version).toBe(CLAUDE_PIN);
    expect(runtime.model).toBe(CLAUDE_PIN_MODEL);
    expect(runtime.effort).toBe(CLAUDE_PIN_EFFORT);
    expect(runtime.nativeFallback).toEqual({
      model: CLAUDE_PIN_FALLBACK_MODEL,
      reason: CLAUDE_NATIVE_FALLBACK_UNAVAILABLE_REASON,
      status: "unavailable",
    });
    expect([...runtime.argv].slice(1)).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "default",
      "--model",
      CLAUDE_PIN_MODEL,
      "--effort",
      CLAUDE_PIN_EFFORT,
    ]);
    // "max without ultracode".
    expect(runtime.argv).not.toContain("ultracode");
    expect(runtime.argv).not.toContain("--dangerously-skip-permissions");
  });

  test("builds exact disabled and admitted native-fallback argv without starting Claude", () => {
    const executablePath = "/opt/hra/bin/claude";
    expect(buildPinnedClaudeRuntimeArgv({
      executablePath,
      nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
    })).toEqual([
      executablePath,
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "default",
      "--model",
      CLAUDE_PIN_MODEL,
      "--effort",
      CLAUDE_PIN_EFFORT,
    ]);

    expect(buildPinnedClaudeRuntimeArgv({
      executablePath,
      nativeFallback: {
        evidenceDigest: "a".repeat(64),
        model: CLAUDE_PIN_FALLBACK_MODEL,
        status: "armed",
      },
    })).toEqual([
      executablePath,
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "default",
      "--model",
      CLAUDE_PIN_MODEL,
      "--fallback-model",
      CLAUDE_PIN_FALLBACK_MODEL,
      "--effort",
      CLAUDE_PIN_EFFORT,
    ]);
  });

  test("refuses to arm native fallback without a sanitized evidence digest", () => {
    expect(() => buildPinnedClaudeRuntimeArgv({
      executablePath: "/opt/hra/bin/claude",
      nativeFallback: {
        evidenceDigest: "not-a-digest",
        model: CLAUDE_PIN_FALLBACK_MODEL,
        status: "armed",
      },
    })).toThrow("sanitized acceptance evidence digest");
  });

  test("refuses any fallback model or unavailable reason outside the reviewed pin", () => {
    expect(() => buildPinnedClaudeRuntimeArgv({
      executablePath: "/opt/hra/bin/claude",
      nativeFallback: {
        evidenceDigest: "a".repeat(64),
        model: "claude-sonnet-5",
        status: "armed",
      } as unknown as ClaudeNativeFallbackCapability,
    })).toThrow("exact pinned fallback model");
    expect(() => buildPinnedClaudeRuntimeArgv({
      executablePath: "/opt/hra/bin/claude",
      nativeFallback: {
        extra: true,
        model: CLAUDE_PIN_FALLBACK_MODEL,
        reason: CLAUDE_NATIVE_FALLBACK_UNAVAILABLE_REASON,
        status: "unavailable",
      } as unknown as ClaudeNativeFallbackCapability,
    })).toThrow("reviewed reason");
    expect(() => buildPinnedClaudeRuntimeArgv({
      executablePath: "/opt/hra/bin/claude",
      nativeFallback: {
        model: CLAUDE_PIN_FALLBACK_MODEL,
        reason: "operator_override",
        status: "unavailable",
      } as unknown as ClaudeNativeFallbackCapability,
    })).toThrow("reviewed reason");
  });

  test("refuses an unpinned build instead of parsing it hopefully", async () => {
    const { configDir, path } = await fakeExecutable();
    await expect(resolvePinnedClaudeRuntime({
      configDir,
      executablePath: path,
      probeVersion: async () => "2.1.259",
    })).rejects.toThrow(`HRA requires Claude Code ${CLAUDE_PIN}`);
    await expect(resolvePinnedClaudeRuntime({
      configDir,
      executablePath: path,
      probeVersion: async () => "unknown build",
    })).rejects.toThrow(ClaudeError);
  });

  test("requires an absolute config directory and an absolute executable", async () => {
    const { configDir, path } = await fakeExecutable();
    await expect(resolvePinnedClaudeRuntime({
      configDir: "relative",
      executablePath: path,
      probeVersion: async () => CLAUDE_PIN,
    })).rejects.toThrow("CLAUDE_CONFIG_DIR must be an absolute path");
    await expect(resolvePinnedClaudeRuntime({
      configDir,
      executablePath: "claude",
      probeVersion: async () => CLAUDE_PIN,
    })).rejects.toThrow("must be absolute");
  });

  test("refuses a missing executable", async () => {
    const root = await scratch();
    await expect(resolvePinnedClaudeRuntime({
      configDir: join(root, "config"),
      executablePath: join(root, "absent"),
      probeVersion: async () => CLAUDE_PIN,
    })).rejects.toThrow(ClaudeError);
  });

  test("locates the executable only on an absolute allowlisted PATH entry", async () => {
    const { path } = await fakeExecutable();
    const directory = path.slice(0, path.lastIndexOf("/"));
    await expect(locateClaudeExecutable({ PATH: directory })).resolves.toBe(path);
    await expect(locateClaudeExecutable({ PATH: "relative/bin" })).rejects.toThrow(ClaudeError);
    await expect(locateClaudeExecutable({})).rejects.toThrow(ClaudeError);
  });

  test("keeps the pinned model id equal to the fable-max preset requirement", () => {
    // `src/domain` is the leaf layer and cannot import `src/claude`, so this
    // is where the two spellings are proved identical.
    expect(presetRequirements["fable-max"]).toEqual({
      effort: CLAUDE_PIN_EFFORT,
      model: CLAUDE_PIN_MODEL,
    });
  });
});
