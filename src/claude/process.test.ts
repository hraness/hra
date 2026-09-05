import { describe, expect, test } from "bun:test";

import {
  ClaudeLaunchIntentLivenessProbe,
  inspectSpawnedClaudeProcessIdentity,
  spawnBunClaudeProcess,
  type ClaudeProcessIdentityInspectionSpawner,
} from "./process";

const processOutput = (...chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk;
  },
});

const encodedProcessOutput = (value: string): AsyncIterable<Uint8Array> =>
  processOutput(new TextEncoder().encode(value));

describe("Claude child process identity", () => {
  test("reads a bounded process-start token through the fixed non-shell ps command", async () => {
    const calls: unknown[] = [];
    const identity = await inspectSpawnedClaudeProcessIdentity(8_123, {
      platform: "darwin",
      spawn: (input) => {
        calls.push(input);
        return {
          exited: Promise.resolve(0),
          forceTerminate: () => undefined,
          stdout: {
            async *[Symbol.asyncIterator]() {
              yield new TextEncoder().encode(" Fri Sep  4 12:00:00 2026 \n");
            },
          },
        };
      },
    });
    expect(identity).toEqual({
      pid: 8_123,
      pidDomain: "darwin",
      procStart: "Fri Sep  4 12:00:00 2026",
    });
    expect(calls).toEqual([{
      argv: ["/bin/ps", "-p", "8123", "-o", "lstart="],
      environment: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
        TZ: "UTC",
      },
    }]);
  });

  test("takes one fixed process snapshot and matches only direct launch-id argv pairs", async () => {
    const resumed = "11111111-1111-4111-8111-111111111111";
    const started = "22222222-2222-4222-8222-222222222222";
    const absent = "33333333-3333-4333-8333-333333333333";
    const calls: unknown[] = [];
    const probe = new ClaudeLaunchIntentLivenessProbe({
      platform: "darwin",
      now: () => 1_000,
      spawn: (input) => {
        calls.push(input);
        return {
          exited: Promise.resolve(0),
          forceTerminate: () => undefined,
          stdout: encodedProcessOutput([
            `/opt/claude --resume ${resumed} --verbose`,
            `/opt/claude --session-id ${started}`,
            `/opt/other --resume=${absent}`,
            `/opt/other prefix--resume ${absent}`,
            `/opt/other --resume ${absent}-suffix`,
          ].join("\n")),
        };
      },
    });
    const options = {
      deadlineAt: 2_000,
      signal: new AbortController().signal,
    };

    expect(await probe.probe(resumed, options)).toBe("live");
    expect(await probe.probe(started, options)).toBe("live");
    expect(await probe.probe(absent, options)).toBe("not_live");
    expect(calls).toEqual([{
      argv: ["/bin/ps", "-axww", "-o", "command="],
      environment: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
        TZ: "UTC",
      },
    }]);
  });

  test("returns unknown without inspection for invalid ids, deadlines, and platforms", async () => {
    let spawned = 0;
    const spawn = () => {
      spawned += 1;
      throw new Error("must not inspect");
    };
    const probe = new ClaudeLaunchIntentLivenessProbe({
      platform: "darwin",
      now: () => 1_000,
      spawn,
    });
    const liveOptions = {
      deadlineAt: 2_000,
      signal: new AbortController().signal,
    };
    expect(await probe.probe("contains whitespace", liveOptions)).toBe("unknown");
    expect(await probe.probe("x".repeat(201), liveOptions)).toBe("unknown");
    expect(await probe.probe("valid-id", {
      ...liveOptions,
      deadlineAt: 1_000,
    })).toBe("unknown");
    const aborted = new AbortController();
    aborted.abort();
    expect(await probe.probe("valid-id", {
      deadlineAt: 2_000,
      signal: aborted.signal,
    })).toBe("unknown");
    expect(await probe.probe("valid-id", undefined as never)).toBe("unknown");
    expect(await probe.probe("valid-id", {
      deadlineAt: 2_000,
      signal: {} as never,
    })).toBe("unknown");
    expect(spawned).toBe(0);

    const unsupported = new ClaudeLaunchIntentLivenessProbe({
      platform: "win32",
      now: () => 1_000,
      spawn,
    });
    expect(await unsupported.probe("valid-id", liveOptions)).toBe("unknown");
    expect(spawned).toBe(0);
  });

  test("maps spawn, exit, read, parse, and truncation ambiguity to unknown", async () => {
    const options = {
      deadlineAt: 2_000,
      signal: new AbortController().signal,
    };
    const resultFor = async (
      spawn: ClaudeProcessIdentityInspectionSpawner,
    ) => await new ClaudeLaunchIntentLivenessProbe({
      platform: "linux",
      now: () => 1_000,
      spawn,
    }).probe("44444444-4444-4444-8444-444444444444", options);

    expect(await resultFor(() => { throw new Error("private process table"); }))
      .toBe("unknown");
    expect(await resultFor(() => null as never)).toBe("unknown");
    expect(await resultFor(() => ({
      exited: Promise.resolve(1),
      forceTerminate: () => undefined,
      stdout: encodedProcessOutput("/opt/claude --resume 44444444-4444-4444-8444-444444444444"),
    }))).toBe("unknown");
    expect(await resultFor(() => ({
      exited: Promise.resolve(0),
      forceTerminate: () => undefined,
      stdout: {
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(new Error("PRIVATE_COMMAND_LINE")),
          };
        },
      },
    }))).toBe("unknown");
    expect(await resultFor(() => ({
      exited: Promise.resolve(0),
      forceTerminate: () => undefined,
      stdout: processOutput(new Uint8Array([0xff])),
    }))).toBe("unknown");
    expect(await resultFor(() => ({
      exited: Promise.resolve(0),
      forceTerminate: () => undefined,
      stdout: encodedProcessOutput("/opt/claude --resume"),
    }))).toBe("unknown");
    expect(await resultFor(() => ({
      exited: Promise.resolve(0),
      forceTerminate: () => undefined,
      stdout: processOutput(new Uint8Array(4 * 1_024 * 1_024 + 1)),
    }))).toBe("unknown");
  });

  test("returns unknown and terminates a process snapshot on deadline or abort", async () => {
    let forceTerminations = 0;
    const hangingInspection = () => ({
      exited: new Promise<number>(() => undefined),
      forceTerminate: () => { forceTerminations += 1; },
      stdout: {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          };
        },
      },
    });
    const deadlineProbe = new ClaudeLaunchIntentLivenessProbe({
      platform: "darwin",
      now: () => 0,
      spawn: hangingInspection,
    });

    expect(await deadlineProbe.probe("55555555-5555-4555-8555-555555555555", {
      deadlineAt: 1,
      signal: new AbortController().signal,
    })).toBe("unknown");
    expect(forceTerminations).toBe(1);

    const abort = new AbortController();
    const abortProbe = new ClaudeLaunchIntentLivenessProbe({
      platform: "linux",
      now: () => 0,
      spawn: hangingInspection,
    });
    const result = abortProbe.probe("66666666-6666-4666-8666-666666666666", {
      deadlineAt: 1_000,
      signal: abort.signal,
    });
    abort.abort();
    expect(await result).toBe("unknown");
    expect(forceTerminations).toBe(2);
  });

  test("exposes the spawned child identity and reaps an unprovable child", async () => {
    const child = spawnBunClaudeProcess({
      argv: [process.execPath, "-e", "setInterval(() => undefined, 1000)"],
      configDir: "/tmp/hra-claude-process-identity-test",
      inspectIdentity: async (pid) => Object.freeze({
        pid,
        pidDomain: "darwin",
        procStart: "Fri Sep  4 12:00:00 2026",
      }),
    });
    try {
      const identity = await child.identity;
      expect(identity.pid).not.toBe(process.pid);
      expect(identity.procStart).toMatch(/^[\x20-\x7e]{1,128}$/u);
    } finally {
      child.forceTerminate();
      await child.exited;
    }

    const unprovable = spawnBunClaudeProcess({
      argv: [process.execPath, "-e", "setInterval(() => undefined, 1000)"],
      configDir: "/tmp/hra-claude-process-identity-test",
      inspectIdentity: async () => { throw new Error("inspection unavailable"); },
    });
    await expect(unprovable.identity).rejects.toThrow("identity could not be proven");
    await expect(unprovable.exited).resolves.not.toBe(0);
  });
});
