import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_PIN,
  CLAUDE_PIN_EFFORT,
  CLAUDE_PIN_MODEL,
  createClaudeLoginSignalCustody,
  runClaudeForegroundLogin,
  type ClaudeLoginSignal,
} from "../src/claude/index";
import { createClaudeLiveAcceptanceSignalCustody } from "./claude-live-acceptance";

class FakeRunnerSignalSource {
  readonly listeners = new Map<ClaudeLoginSignal, Set<() => void>>();

  on(signal: ClaudeLoginSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: ClaudeLoginSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: ClaudeLoginSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  count(signal: ClaudeLoginSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

const runtime = {
  argv: [join(tmpdir(), "hra-claude-live-signal-runtime"), "--print"],
  effort: CLAUDE_PIN_EFFORT,
  executablePath: join(tmpdir(), "hra-claude-live-signal-runtime"),
  model: CLAUDE_PIN_MODEL,
  version: CLAUDE_PIN,
} as const;

describe("Claude live-acceptance signal custody", () => {
  test("replays an early terminal signal into native login custody before spawn", async () => {
    for (const interruptedBy of ["SIGINT", "SIGTERM"] as const) {
      const source = new FakeRunnerSignalSource();
      const runner = createClaudeLiveAcceptanceSignalCustody(source);
      source.emit(interruptedBy);
      const login = createClaudeLoginSignalCustody({
        signal: new AbortController().signal,
        signalSource: runner.loginSignalSource,
      });
      let spawnCalls = 0;
      try {
        await expect(runClaudeForegroundLogin({
          configDir: join(tmpdir(), "hra-claude-live-signal-config"),
          processFactory: () => {
            spawnCalls += 1;
            throw new Error("must not spawn after an early terminal signal");
          },
          runtime,
          signal: new AbortController().signal,
          signalCustody: login,
          stdio: { stdin: 0, stdout: 1, stderr: 2 },
        })).resolves.toEqual({
          interruptedBy,
          reason: "interrupted_before_spawn",
          state: "not_started",
        });
        expect(login.interruptedBy).toBe(interruptedBy);
        expect(spawnCalls).toBe(0);
      } finally {
        login.close();
        runner.close();
      }
      expect(source.count("SIGINT")).toBe(0);
      expect(source.count("SIGTERM")).toBe(0);
    }
  });

  test("separates login listeners, proof abort, cleanup abort, and close", () => {
    const source = new FakeRunnerSignalSource();
    const custody = createClaudeLiveAcceptanceSignalCustody(source);
    let loginInterrupts = 0;
    const loginListener = (): void => {
      loginInterrupts += 1;
    };
    custody.loginSignalSource.add("SIGINT", loginListener);
    source.emit("SIGINT");
    expect(loginInterrupts).toBe(1);
    expect(custody.interruptedDuringLogin()).toBeTrue();
    custody.loginSignalSource.remove("SIGINT", loginListener);
    source.emit("SIGINT");
    expect(loginInterrupts).toBe(1);

    const proof = custody.beginProof();
    expect(proof.aborted).toBeTrue();
    expect(proof.reason).toMatchObject({ code: "operator_interrupted" });
    expect(() => custody.loginSignalSource.add("SIGTERM", loginListener)).toThrow();

    const cleanup = custody.beginCleanup();
    expect(cleanup.aborted).toBeFalse();
    source.emit("SIGTERM");
    expect(cleanup.aborted).toBeTrue();
    expect(cleanup.reason).toMatchObject({ code: "operator_interrupted" });
    expect(proof.reason).not.toBe(cleanup.reason);

    custody.close();
    expect(source.count("SIGINT")).toBe(0);
    expect(source.count("SIGTERM")).toBe(0);
    source.emit("SIGINT");
    expect(loginInterrupts).toBe(1);
    custody.close();
  });
});
