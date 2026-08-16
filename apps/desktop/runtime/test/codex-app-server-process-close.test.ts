import { describe, expect, test } from "bun:test";

import { finalizeCodexAppServerProcess } from "../src/app-server-process";

describe("Codex app-server generation finalization", () => {
  test("does not let protocol, writer, or stdin failures skip kill and exit proof", async () => {
    const events: string[] = [];
    let childGone = false;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });

    const result = finalizeCodexAppServerProcess({
      expireProtocol() {
        events.push("protocol");
        throw new Error("private protocol detail");
      },
      closeWriter() {
        events.push("writer");
        throw new Error("private writer detail");
      },
      endStdin() {
        events.push("stdin");
        throw new Error("private stdin detail");
      },
      exited,
      kill(signal) {
        events.push(signal);
        if (signal === "SIGKILL") {
          childGone = true;
          resolveExit();
        }
      },
    }, {
      stepTimeoutMs: 1,
      gracefulExitTimeoutMs: 1,
      terminateExitTimeoutMs: 1,
    });

    let rejected = false;
    try {
      await result;
    } catch (error: unknown) {
      rejected = true;
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("Codex app-server shutdown completed");
    }
    expect(rejected).toBeTrue();
    expect(childGone).toBeTrue();
    expect(events).toEqual(["protocol", "writer", "stdin", "SIGTERM", "SIGKILL"]);
  });

  test("resolves only after a graceful child exit and sends no signal", async () => {
    const events: string[] = [];
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });

    await finalizeCodexAppServerProcess({
      expireProtocol() { events.push("protocol"); },
      closeWriter() { events.push("writer"); },
      endStdin() {
        events.push("stdin");
        resolveExit();
      },
      exited,
      kill(signal) { events.push(signal); },
    }, {
      stepTimeoutMs: 10,
      gracefulExitTimeoutMs: 10,
      terminateExitTimeoutMs: 10,
    });

    expect(events).toEqual(["protocol", "writer", "stdin"]);
  });

  test("bounds a hung cleanup step without weakening the child-exit fence", async () => {
    const events: string[] = [];
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const never = new Promise<void>(() => undefined);

    let rejected = false;
    try {
      await finalizeCodexAppServerProcess({
        expireProtocol() {
          events.push("protocol");
          return never;
        },
        closeWriter() { events.push("writer"); },
        endStdin() { events.push("stdin"); },
        exited,
        kill(signal) {
          events.push(signal);
          if (signal === "SIGTERM") resolveExit();
        },
      }, {
        stepTimeoutMs: 1,
        gracefulExitTimeoutMs: 1,
        terminateExitTimeoutMs: 10,
      });
    } catch (error: unknown) {
      rejected = true;
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("protocol_timeout");
    }
    expect(rejected).toBeTrue();
    expect(events).toEqual(["protocol", "writer", "stdin", "SIGTERM"]);
  });
});
