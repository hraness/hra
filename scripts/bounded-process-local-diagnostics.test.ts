import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireBoundedProcessCleanup, runBoundedProcess, type BoundedProcessRequest, type BoundedProcessResult } from "./bounded-process";

type OwnedFixture = { cleanupAllowed: boolean; tasks: Promise<BoundedProcessResult>[] };
const fixtures = new Map<string, OwnedFixture>();

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-local-diagnostics-")));
  fixtures.set(root, { cleanupAllowed: true, tasks: [] });
  return { root, recoveryDirectory: join(root, "recovery") };
}

function run(
  root: string,
  recoveryDirectory: string,
  overrides: Partial<BoundedProcessRequest> = {},
  captureLocalDiagnostics = true,
) {
  const owned = fixtures.get(root);
  if (owned === undefined) throw new Error("LOCAL_DIAGNOSTICS_FIXTURE_CLOSING");
  const raw = runBoundedProcess({
    arguments: [], ...(captureLocalDiagnostics ? { captureLocalDiagnostics: true as const } : {}),
    containment: "local", cwd: root,
    environment: { PATH: process.env.PATH }, executable: "/usr/bin/true",
    outputMaximumBytes: 64, phase: "local-diagnostics-proof", terminationGraceMs: 25,
    killSettlementMs: 1_000, timeoutMs: 3_000, ...overrides,
  }, { recoveryDirectory });
  owned.tasks.push(raw);
  return raw.then((result) => {
    if (result.cleanup !== "proven") owned.cleanupAllowed = false;
    return requireBoundedProcessCleanup(result);
  }, (error: unknown) => {
    owned.cleanupAllowed = false;
    throw error;
  });
}

afterEach(async () => {
  const closing = [...fixtures];
  fixtures.clear();
  for (const [root, owned] of closing) {
    await Promise.allSettled(owned.tasks);
    if (owned.cleanupAllowed) await rm(root, { recursive: true, force: true });
  }
}, 10_000);

describe("local process diagnostic evidence", () => {
  test.each([0, 7])("retains the actual leader close code %s without forcing a result", async (exitCode) => {
    const { root, recoveryDirectory } = await fixture();
    const result = await run(root, recoveryDirectory, {
      executable: process.execPath, arguments: ["-e", "process.exitCode = Number(process.argv[1]);", String(exitCode)],
    });
    expect(result.exitCode).toBe(exitCode);
    expect(result.localDiagnostics).toEqual({
      version: 1, rawCloseCode: exitCode, rawCloseSignal: "none", firstTerminationReason: "none",
      forcedExitCode: null, closeGroup: "absent", termSignalFailed: false, killSignalFailed: false,
    });
  });

  test("leaves the exact completed result shape unchanged without opt-in", async () => {
    const { root, recoveryDirectory } = await fixture();
    const result = await run(root, recoveryDirectory, {}, false);
    expect(result).toEqual({ cleanup: "proven", exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    expect(Object.keys(result).sort()).toEqual(["cleanup", "exitCode", "stderr", "stdout"]);
  });

  test("refuses authority diagnostic opt-in before creating custody", async () => {
    const { root, recoveryDirectory } = await fixture();
    const result = await run(root, recoveryDirectory, { containment: "authority" });
    expect(result).toEqual({ cleanup: "proven", exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    await expect(lstat(recoveryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([false, null, 1, "true"])("refuses a foreign diagnostic option %j before creating custody", async (value) => {
    const { root, recoveryDirectory } = await fixture();
    const overrides: Partial<BoundedProcessRequest> = {};
    Object.defineProperty(overrides, "captureLocalDiagnostics", { enumerable: true, value });
    expect(await run(root, recoveryDirectory, overrides)).toEqual({
      cleanup: "proven", exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    });
    await expect(lstat(recoveryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps pre-dispatch cancellation unobserved and free of custody", async () => {
    const { root, recoveryDirectory } = await fixture();
    const cancellation = new AbortController();
    cancellation.abort();
    expect(await run(root, recoveryDirectory, { signal: cancellation.signal })).toEqual({
      cleanup: "proven", exitCode: 130, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    });
    await expect(lstat(recoveryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("distinguishes a zero-exit leader from its forced residual-group failure", async () => {
    const { root, recoveryDirectory } = await fixture();
    const result = await run(root, recoveryDirectory, {
      executable: process.execPath,
      arguments: ["-e", [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', process.argv[1]], { stdio: ['ignore', 'pipe', 'ignore'] });",
        "const deadline = setTimeout(() => process.exit(2), 1500);",
        "child.stdout.once('data', () => { clearTimeout(deadline); child.stdout.destroy(); child.unref(); });",
      ].join("\n"), [
        "process.on('SIGTERM', () => {});",
        "setTimeout(() => process.exit(3), 2500);",
        "process.stdout.write('READY');",
      ].join("\n")],
    });
    expect(result.cleanup).toBe("proven");
    expect(result.exitCode).toBe(1);
    expect(result.localDiagnostics).toEqual({
      version: 1, rawCloseCode: 0, rawCloseSignal: "none", firstTerminationReason: "residual_group_non_absent",
      forcedExitCode: 1, closeGroup: "non_absent", termSignalFailed: false, killSignalFailed: false,
    });
  });

  test("retains the timeout cause and failed result after native collection", async () => {
    const { root, recoveryDirectory } = await fixture();
    const result = await run(root, recoveryDirectory, {
      executable: process.execPath, arguments: ["-e", "setInterval(() => undefined, 1000);"], timeoutMs: 250,
    });
    expect(result.exitCode).toBe(124);
    expect(result.localDiagnostics).toMatchObject({
      firstTerminationReason: "timeout", forcedExitCode: 124, termSignalFailed: false, killSignalFailed: false,
    });
  });

  test("retains output-limit failure without exposing output in diagnostics", async () => {
    const { root, recoveryDirectory } = await fixture();
    const result = await run(root, recoveryDirectory, {
      executable: process.execPath, arguments: ["-e", "process.stdout.write('private-data'.repeat(100)); setInterval(() => undefined, 1000);"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.byteLength + result.stderr.byteLength).toBe(64);
    expect(result.localDiagnostics).toMatchObject({ firstTerminationReason: "output_limit", forcedExitCode: 1 });
    expect(JSON.stringify(result.localDiagnostics)).not.toContain("private-data");
  });

  test.each(["SIGTERM", "SIGKILL"] as const)("records a %s reporting failure without changing collection or first cause", async (failedSignal) => {
    const { root, recoveryDirectory } = await fixture();
    const readyPath = join(root, "ready");
    const cancellation = new AbortController();
    const pending = run(root, recoveryDirectory, {
      executable: process.execPath, arguments: ["-e", [
        "process.on('SIGTERM', () => {});",
        "const { writeFileSync, linkSync, unlinkSync } = require('node:fs');",
        "const pending = process.argv[1] + '.pending';",
        "writeFileSync(pending, String(process.pid), { flag: 'wx' });",
        "linkSync(pending, process.argv[1]); unlinkSync(pending);",
        "setInterval(() => undefined, 1000);",
      ].join("\n"), readyPath], signal: cancellation.signal,
    });
    let restore: (() => void) | undefined;
    try {
      const readyDeadline = performance.now() + 1_000;
      while (!await Bun.file(readyPath).exists()) {
        if (performance.now() >= readyDeadline) throw new Error("LOCAL_DIAGNOSTICS_READY_DEADLINE");
        await Bun.sleep(10);
      }
      const pidText = await readFile(readyPath, "utf8");
      if (!/^[1-9][0-9]{0,9}$/u.test(pidText) || Number(pidText) <= 1) throw new Error("LOCAL_DIAGNOSTICS_PID_INVALID");
      const processGroupId = -Number(pidText);
      const originalKill = process.kill.bind(process);
      const processKill = spyOn(process, "kill").mockImplementation((pid, signal) => {
        const result = originalKill(pid, signal);
        if (pid === processGroupId && signal === failedSignal) {
          throw Object.assign(new Error("synthetic private signal error"), { code: "EPERM" });
        }
        return result;
      });
      restore = () => { processKill.mockRestore(); };
      cancellation.abort();
      const result = await pending;
      expect(result.exitCode).toBe(1);
      expect(result.localDiagnostics).toMatchObject({
        firstTerminationReason: "abort", forcedExitCode: 1,
        termSignalFailed: failedSignal === "SIGTERM", killSignalFailed: failedSignal === "SIGKILL",
      });
      let absence: unknown;
      try { originalKill(processGroupId, 0); } catch (error: unknown) { absence = error; }
      expect(absence).toMatchObject({ code: "ESRCH" });
      expect(JSON.stringify(result.localDiagnostics)).not.toContain("synthetic private signal error");
    } finally {
      cancellation.abort();
      try { await pending; } finally { restore?.(); }
    }
  });
});
