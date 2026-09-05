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
  spawnClaudeAuthStatusProbe,
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

const scriptedExecutable = async (
  script: string,
): Promise<Readonly<{ configDir: string; path: string }>> => {
  const root = await scratch();
  const path = join(root, "claude");
  await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
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

  test("keeps every exit-zero authenticated shape unverified", async () => {
    const { configDir, path } = await scriptedExecutable(`
if [ "$1:$2:$3" != "auth:status:--json" ] || [ -z "$CLAUDE_CONFIG_DIR" ] || [ -n "$ANTHROPIC_API_KEY" ]; then
  exit 9
fi
printf '%s' '{"analyticsDisabled":false,"apiProvider":"firstParty","authMethod":"claude.ai","loggedIn":true,"projectsDirectory":"/isolated/projects","email":"must-not-escape@example.com","orgId":null,"orgName":null,"subscriptionType":null}'
`);
    await expect(spawnClaudeAuthStatusProbe({
      configDir,
      environment: { ...process.env, ANTHROPIC_API_KEY: "must-not-reach-child" },
      executablePath: path,
    })).resolves.toBe("unverified");
  });

  test("admits only the exact pinned exit-one signed-out matrix", async () => {
    const { configDir, path } = await scriptedExecutable(`
printf '%s' '{"projectsDirectory":"/isolated/projects","loggedIn":false,"authMethod":"none","analyticsDisabled":false,"apiProvider":"firstParty"}'
exit 1
`);
    await expect(spawnClaudeAuthStatusProbe({ configDir, executablePath: path }))
      .resolves.toBe("signed_out");
  });

  test("maps shape drift, other exits, oversized, and timed-out auth output to unverified", async () => {
    const malformed = await scriptedExecutable("printf '%s' '{\"loggedIn\":false}'; exit 1");
    const nonzero = await scriptedExecutable("printf '%s' '{\"loggedIn\":true}'; exit 7");
    const extra = await scriptedExecutable("printf '%s' '{\"analyticsDisabled\":false,\"apiProvider\":\"firstParty\",\"authMethod\":\"none\",\"loggedIn\":false,\"projectsDirectory\":\"/isolated/projects\",\"email\":null}'; exit 1");
    const exitZero = await scriptedExecutable("printf '%s' '{\"analyticsDisabled\":false,\"apiProvider\":\"firstParty\",\"authMethod\":\"none\",\"loggedIn\":false,\"projectsDirectory\":\"/isolated/projects\"}'");
    const oversized = await scriptedExecutable(`
printf '%s' '{"loggedIn":true,"padding":"'
i=0
while [ "$i" -lt 256 ]; do printf x; i=$((i + 1)); done
printf '%s' '"}'
`);
    const timedOut = await scriptedExecutable("while :; do :; done");
    await expect(spawnClaudeAuthStatusProbe({
      configDir: malformed.configDir,
      executablePath: malformed.path,
    })).resolves.toBe("unverified");
    await expect(spawnClaudeAuthStatusProbe({
      configDir: nonzero.configDir,
      executablePath: nonzero.path,
    })).resolves.toBe("unverified");
    await expect(spawnClaudeAuthStatusProbe({
      configDir: extra.configDir,
      executablePath: extra.path,
    })).resolves.toBe("unverified");
    await expect(spawnClaudeAuthStatusProbe({
      configDir: exitZero.configDir,
      executablePath: exitZero.path,
    })).resolves.toBe("unverified");
    await expect(spawnClaudeAuthStatusProbe({
      configDir: oversized.configDir,
      executablePath: oversized.path,
      maxOutputBytes: 64,
    })).resolves.toBe("unverified");
    await expect(spawnClaudeAuthStatusProbe({
      configDir: timedOut.configDir,
      executablePath: timedOut.path,
      timeoutMs: 20,
    })).resolves.toBe("unverified");
  });

  test("bounds version output and preserves caller cancellation", async () => {
    const oversized = await scriptedExecutable(`
i=0
while [ "$i" -lt 300 ]; do printf x; i=$((i + 1)); done
`);
    await expect(spawnClaudeVersionProbe({
      configDir: oversized.configDir,
      environment: process.env,
      executablePath: oversized.path,
    })).rejects.toThrow("did not report a version");

    const controller = new AbortController();
    controller.abort(new Error("caller stopped auth refresh"));
    await expect(spawnClaudeAuthStatusProbe({
      configDir: oversized.configDir,
      executablePath: oversized.path,
      signal: controller.signal,
    })).rejects.toThrow("caller stopped auth refresh");
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
