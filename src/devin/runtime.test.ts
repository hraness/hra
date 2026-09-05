import { describe, expect, test } from "bun:test";

import { DevinError } from "./errors";
import { DEVIN_MODEL, DEVIN_PIN } from "./pin";
import { isolatedDevinEnvironment, type DevinDirectories } from "./process";
import {
  parseDevinVersionOutput,
  resolvePinnedDevinRuntime,
  spawnDevinVersionProbe,
  type DevinVersionProbeProcess,
} from "./runtime";

const directories: DevinDirectories = {
  home: "/var/hra/devin/home",
  configHome: "/var/hra/devin/config",
  dataHome: "/var/hra/devin/data",
  cacheHome: "/var/hra/devin/cache",
  stateHome: "/var/hra/devin/state",
};
const encoder = new TextEncoder();
const chunks = (values: readonly Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() { for (const value of values) yield value; },
});

describe("pinned Devin runtime", () => {
  test("accepts only the pinned CLI's exact version shape", () => {
    expect(parseDevinVersionOutput(`devin ${DEVIN_PIN} (18033302)\n`)).toBe(DEVIN_PIN);
    for (const value of [
      DEVIN_PIN,
      `devin ${DEVIN_PIN}`,
      `wrapper devin ${DEVIN_PIN} (18033302)`,
      `devin ${DEVIN_PIN}-beta (18033302)`,
      `devin ${DEVIN_PIN} (build)` ,
    ]) {
      expect(() => parseDevinVersionOutput(value)).toThrow(DevinError);
    }
  });

  test("constructs exact Astra ACP argv after a pinned probe", async () => {
    const runtime = await resolvePinnedDevinRuntime({
      directories,
      executablePath: "/bin/echo",
      probeVersion: async () => `devin ${DEVIN_PIN} (18033302)\n`,
    });
    expect(runtime.version).toBe(DEVIN_PIN);
    expect(runtime.model).toBe(DEVIN_MODEL);
    expect(runtime.argv.slice(1)).toEqual(["acp", "--model", "gpt-6-astra"]);
  });

  test("overrides every HOME/XDG directory and drops ambient credentials", () => {
    expect(isolatedDevinEnvironment({
      HOME: "/Users/private",
      PATH: "/usr/bin:/bin",
      DEVIN_API_KEY: "must-not-cross",
      HTTPS_PROXY: "https://must-not-cross.invalid",
    }, directories)).toEqual({
      HOME: directories.home,
      PATH: "/usr/bin:/bin",
      XDG_CONFIG_HOME: directories.configHome,
      XDG_DATA_HOME: directories.dataHome,
      XDG_CACHE_HOME: directories.cacheHome,
      XDG_STATE_HOME: directories.stateHome,
      NO_COLOR: "1",
    });
  });

  test("runs a bounded, isolated direct version probe", async () => {
    let launch: unknown;
    const result = await spawnDevinVersionProbe({
      deadlineMs: 1_000,
      directories,
      environment: { PATH: "/usr/bin:/bin", DEVIN_API_KEY: "secret" },
      executablePath: "/opt/devin",
      processFactory: (input) => {
        launch = input;
        return {
          exited: Promise.resolve(0),
          forceTerminate: () => undefined,
          stderr: chunks([]),
          stdout: chunks([encoder.encode(`devin ${DEVIN_PIN} (18033302)\n`)]),
          terminate: () => undefined,
        };
      },
      signal: new AbortController().signal,
    });
    expect(result).toBe(`devin ${DEVIN_PIN} (18033302)\n`);
    expect(launch).toEqual({
      argv: ["/opt/devin", "--version"],
      environment: {
        HOME: directories.home,
        PATH: "/usr/bin:/bin",
        XDG_CONFIG_HOME: directories.configHome,
        XDG_DATA_HOME: directories.dataHome,
        XDG_CACHE_HOME: directories.cacheHome,
        XDG_STATE_HOME: directories.stateHome,
        NO_COLOR: "1",
      },
    });
  });

  test("terminates and joins an overproducing version probe", async () => {
    let resolveExit!: (code: number) => void;
    let terminated = false;
    const process: DevinVersionProbeProcess = {
      exited: new Promise((resolve) => { resolveExit = resolve; }),
      forceTerminate: () => undefined,
      stderr: chunks([]),
      stdout: chunks([new Uint8Array(513)]),
      terminate: () => { terminated = true; resolveExit(143); },
    };
    await expect(spawnDevinVersionProbe({
      deadlineMs: 1_000,
      directories,
      environment: {},
      executablePath: "/opt/devin",
      processFactory: () => process,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(terminated).toBe(true);
  });
});
