import { describe, expect, test } from "bun:test";

import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
  type BoundedProcessRequest,
} from "./bounded-process";
import type { CommandRequest } from "./configure-hosted-sync";
import {
  createLiveAcceptanceAuthorityCommandRunner,
  runLiveAcceptanceAuthorityCommand,
} from "./live-acceptance-authority-process";

const request = {
  arguments: ["--version"],
  containment: "authority",
  cwd: "/tmp",
  environment: { LANG: "C" },
  executable: "/bin/echo",
  outputMaximumBytes: 128,
  phase: "live-authority-test",
  stdin: "",
  timeoutMs: 5_000,
} satisfies CommandRequest;

describe("live acceptance authority command custody", () => {
  test.skipIf(process.platform === "linux")("the real default refuses unsupported authority custody before target execution", async () => {
    await expect(runLiveAcceptanceAuthorityCommand(request))
      .rejects.toBeInstanceOf(BoundedProcessContainmentUnavailableError);
  });

  test("requires descendant custody and exact bounded arguments before decoding and clearing output", async () => {
    const calls: BoundedProcessRequest[] = [];
    const stdout = Buffer.from("version\n");
    const stderr = Buffer.from("diagnostic\n");
    const run = createLiveAcceptanceAuthorityCommandRunner(async (input) => {
      calls.push(input);
      return { cleanup: "proven", exitCode: 0, stdout, stderr };
    });
    expect(await run(request)).toEqual({ exitCode: 0, stdout: "version\n", stderr: "diagnostic\n" });
    expect(calls).toEqual([{
      ...request,
      killSettlementMs: 1_000,
      terminationGraceMs: 250,
    }]);
    expect(calls[0]?.arguments).not.toBe(request.arguments);
    expect(calls[0]?.environment).not.toBe(request.environment);
    expect(stdout.every((byte) => byte === 0)).toBe(true);
    expect(stderr.every((byte) => byte === 0)).toBe(true);
  });

  test("never falls back after unsupported authority containment", async () => {
    let calls = 0;
    const unavailable = new BoundedProcessContainmentUnavailableError("authority_unsupported_platform");
    const run = createLiveAcceptanceAuthorityCommandRunner(async () => {
      calls += 1;
      throw unavailable;
    });
    await expect(run(request)).rejects.toBe(unavailable);
    expect(calls).toBe(1);
  });

  test("preserves unproven cleanup identity instead of returning a successful exit", async () => {
    const stdout = Buffer.from("untrusted");
    const stderr = Buffer.from("untrusted");
    const run = createLiveAcceptanceAuthorityCommandRunner(async () => ({
      cleanup: "unproven",
      phase: request.phase,
      processGroupId: 51_515,
      recoveryIdentity: { containment: "local", processGroupId: 51_515 },
      recoveryPath: "/tmp/acceptance-recovery.json",
      stdout,
      stderr,
    }));
    let caught: unknown;
    try { await run(request); } catch (error: unknown) { caught = error; }
    expect(caught).toBeInstanceOf(BoundedProcessCleanupUnprovenError);
    expect((caught as BoundedProcessCleanupUnprovenError).recoveryPaths)
      .toEqual(["/tmp/acceptance-recovery.json"]);
    expect(stdout.every((byte) => byte === 0)).toBe(true);
    expect(stderr.every((byte) => byte === 0)).toBe(true);
  });

  test("refuses non-authority and unbounded requests before any process", async () => {
    let calls = 0;
    const run = createLiveAcceptanceAuthorityCommandRunner(async () => {
      calls += 1;
      return { cleanup: "proven", exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    for (const patch of [
      { containment: "local" as const },
      { outputMaximumBytes: 0 },
      { outputMaximumBytes: 1_048_577 },
      { outputMaximumBytes: Number.NaN },
      { timeoutMs: 0 },
      { timeoutMs: 120_001 },
      { timeoutMs: 0.5 },
    ]) await expect(run({ ...request, ...patch })).rejects.toThrow("live_acceptance_authority_command_invalid");
    expect(calls).toBe(0);
  });

  test("refuses invalid UTF-8 and oversized outputs and clears both buffers", async () => {
    for (const invalid of [Buffer.from([0xff]), Buffer.alloc(129, 0x61)]) {
      const stderr = Buffer.from("retained only until validation");
      const run = createLiveAcceptanceAuthorityCommandRunner(async () => ({
        cleanup: "proven", exitCode: 0, stdout: invalid, stderr,
      }));
      await expect(run(request)).rejects.toThrow();
      expect(invalid.every((byte) => byte === 0)).toBe(true);
      expect(stderr.every((byte) => byte === 0)).toBe(true);
    }
  });
});
