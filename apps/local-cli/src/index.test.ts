import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { runLocalCli } from "./index";
import {
  createFakeHome,
  startFakeLocalRuntime,
  type FakeLocalRuntime,
} from "./test-support";

const runtimes: FakeLocalRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.close()));
});

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (value: string) => { stdout += value; } },
      stderr: { write: (value: string) => { stderr += value; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("local hra CLI composition", () => {
  test("writes one stable projection JSON value and no diagnostics", async () => {
    const home = createFakeHome();
    runtimes.push(await startFakeLocalRuntime({
      home,
      profile: "development",
      response: () => ({
        version: 1,
        ok: true,
        result: {
          type: "panes",
          projection: { version: 1, panes: [], truncated: false },
        },
      }),
    }));
    const capture = captureIo();
    expect(await runLocalCli(["pane", "list", "--json"], {
      io: capture.io,
      homeDirectory: home,
    })).toBe(0);
    expect(capture.stdout()).toBe('{"version":1,"panes":[],"truncated":false}\n');
    expect(capture.stderr()).toBe("");
  });

  test("keeps errors on stderr and redacts discovery material", async () => {
    const home = createFakeHome();
    const capture = captureIo();
    expect(await runLocalCli(["attention", "list", "--json"], {
      io: capture.io,
      homeDirectory: home,
    })).toBe(1);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toBe('{"error":{"code":"runtime_unavailable"}}\n');
    expect(capture.stderr()).not.toContain(home);
    expect(capture.stderr()).not.toContain("capability");
    rmHome(home);
  });

  test("prints strict usage only to stderr", async () => {
    const capture = captureIo();
    expect(await runLocalCli(["pane", "list"], { io: capture.io })).toBe(2);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("hra pane list --json");
  });
});

function rmHome(home: string): void {
  // No endpoint was started, so the ordinary fake-runtime cleanup hook does
  // not own this isolated directory.
  rmSync(home, { recursive: true, force: true });
}
