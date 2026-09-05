import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeError } from "./errors";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL } from "./pin";
import { presetRequirements } from "../domain/presets";
import {
  claudeSessionArgv,
  locateClaudeExecutable,
  resolvePinnedClaudeRuntime,
  spawnClaudeVersionProbe,
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

  test("binds creation and resume to one canonical durable session id", async () => {
    const { configDir, path } = await fakeExecutable();
    const runtime = await resolvePinnedClaudeRuntime({
      configDir,
      executablePath: path,
      probeVersion: async () => CLAUDE_PIN,
    });
    const providerThreadId = "726b1b3d-ed97-4b55-9904-e58fa7d7eb45";
    expect(claudeSessionArgv(runtime, { kind: "create", providerThreadId }).slice(-2))
      .toEqual(["--session-id", providerThreadId]);
    expect(claudeSessionArgv(runtime, { kind: "resume", providerThreadId }).slice(-2))
      .toEqual(["--resume", providerThreadId]);
    expect(() => claudeSessionArgv(runtime, {
      kind: "resume",
      providerThreadId: "not-a-session",
    })).toThrow("canonical lowercase UUID");
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

  test("bounds and reaps a version probe whose stdout exceeds the protocol limit", async () => {
    let forceTerminations = 0;
    let settleExit!: (code: number) => void;
    let closeStdout!: () => void;
    const exited = new Promise<number>((resolve) => { settleExit = resolve; });
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStdout = () => controller.close();
        controller.enqueue(new Uint8Array(4 * 1_024 + 1));
      },
    });

    await expect(spawnClaudeVersionProbe({
      configDir: "/tmp/personal-claude",
      configHome: "personal",
      environment: {},
      executablePath: "/tmp/claude",
      signal: new AbortController().signal,
      spawn: () => ({
        exited,
        forceTerminate: () => {
          forceTerminations += 1;
          closeStdout();
          settleExit(137);
        },
        stdout,
      }),
    })).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(forceTerminations).toBe(1);
  });

  test("aborts and reaps a hanging version probe", async () => {
    let forceTerminations = 0;
    let settleExit!: (code: number) => void;
    let closeStdout!: () => void;
    const exited = new Promise<number>((resolve) => { settleExit = resolve; });
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { closeStdout = () => controller.close(); },
    });
    const controller = new AbortController();
    const reason = new Error("version probe canceled");
    const probe = spawnClaudeVersionProbe({
      configDir: "/tmp/personal-claude",
      configHome: "personal",
      environment: {},
      executablePath: "/tmp/claude",
      signal: controller.signal,
      timeoutMs: 1_000,
      spawn: () => ({
        exited,
        forceTerminate: () => {
          forceTerminations += 1;
          closeStdout();
          settleExit(137);
        },
        stdout,
      }),
    });

    controller.abort(reason);
    await expect(probe).rejects.toBe(reason);
    expect(forceTerminations).toBe(1);
  });

  test("times out and reaps a hanging version probe", async () => {
    let forceTerminations = 0;
    let settleExit!: (code: number) => void;
    let closeStdout!: () => void;
    const exited = new Promise<number>((resolve) => { settleExit = resolve; });
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { closeStdout = () => controller.close(); },
    });

    await expect(spawnClaudeVersionProbe({
      configDir: "/tmp/personal-claude",
      configHome: "personal",
      environment: {},
      executablePath: "/tmp/claude",
      signal: new AbortController().signal,
      timeoutMs: 5,
      spawn: () => ({
        exited,
        forceTerminate: () => {
          forceTerminations += 1;
          closeStdout();
          settleExit(137);
        },
        stdout,
      }),
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(forceTerminations).toBe(1);
  });

  test("validates version-probe admission before spawning a process", async () => {
    let spawns = 0;
    const invalid = spawnClaudeVersionProbe({
      configDir: "/tmp/personal-claude",
      configHome: "personal",
      environment: {},
      executablePath: "/tmp/claude",
      signal: new AbortController().signal,
      timeoutMs: 0,
      spawn: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
    });
    await expect(invalid).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(spawns).toBe(0);

    const controller = new AbortController();
    const reason = new Error("already canceled");
    controller.abort(reason);
    await expect(spawnClaudeVersionProbe({
      configDir: "/tmp/personal-claude",
      configHome: "personal",
      environment: {},
      executablePath: "/tmp/claude",
      signal: controller.signal,
      spawn: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
    })).rejects.toBe(reason);
    expect(spawns).toBe(0);
  });
});
