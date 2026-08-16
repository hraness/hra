import { describe, expect, test } from "bun:test";
import {
  createBearerSecret,
  createLocator,
  formatCredentialToken,
} from "@hraness/agent-tasks-protocol";

import { writeData, writeFailure, writeUsage, type CliIo } from "./output";

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      readStdin: () => Promise.resolve(""),
      stdinIsTTY: false,
    },
  };
}

function credential(): string {
  return formatCredentialToken(
    createLocator(Uint8Array.from({ length: 26 }, (_, index) => index)),
    createBearerSecret(Uint8Array.from({ length: 32 }, (_, index) => index)),
  );
}

describe("output boundaries", () => {
  test("writes selected data only to stdout", () => {
    const captured = captureIo();
    writeData(captured.io, { tasks: [], cursor: null }, true);
    expect(captured.stdout).toEqual(['{"tasks":[],"cursor":null}\n']);
    expect(captured.stderr).toEqual([]);
  });

  test("writes diagnostics only to stderr and maps protocol exit classes", () => {
    const captured = captureIo();
    const exitCode = writeFailure(
      captured.io,
      {
        code: "TASK_ALREADY_CLAIMED",
        message: "task is already claimed",
        requestId: "req_00000000000000000000000000",
        details: { taskKey: "OPS-7K2M4Q9", fence: 3 },
      },
      true,
    );
    expect(exitCode).toBe(4);
    expect(captured.stdout).toEqual([]);
    expect(JSON.parse(captured.stderr.join(""))).toEqual({
      error: {
        code: "TASK_ALREADY_CLAIMED",
        message: "task is already claimed",
        requestId: "req_00000000000000000000000000",
        details: { taskKey: "OPS-7K2M4Q9", fence: 3 },
      },
    });
  });

  test("redacts credentials from both data and diagnostics", () => {
    const token = credential();
    const captured = captureIo();
    writeData(captured.io, { accidental: token }, true);
    writeFailure(
      captured.io,
      {
        code: "SERVICE_UNAVAILABLE",
        message: `failed while using ${token}`,
        requestId: "req_00000000000000000000000000",
      },
      false,
    );
    const combined = [...captured.stdout, ...captured.stderr].join("");
    expect(combined).not.toContain(token);
    expect(combined).not.toContain(token.slice(-43));
    expect(combined).toContain("[REDACTED]");
  });

  test("renders usage as data in JSON mode", () => {
    const captured = captureIo();
    writeUsage(captured.io, "usage: taskctl", true);
    expect(JSON.parse(captured.stdout.join(""))).toEqual({ usage: "usage: taskctl" });
    expect(captured.stderr).toEqual([]);
  });
});
