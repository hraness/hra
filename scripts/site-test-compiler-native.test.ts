import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { requireBoundedProcessCleanup, runBoundedProcess, type CompletedBoundedProcessResult } from "./bounded-process";

const nativeWorkMs = 15_000;
const nativeCollectionMs = 1_000 + 5_000;
const nativeOuterMs = nativeWorkMs + nativeCollectionMs + 5_000;
type Mode = "transform" | "late-unref" | "no-child" | "unknown-spawn" | "cancel-join" | "failed-spawn" | "already-closed";

async function withNativeFixture(mode: Mode, proof: (input: Readonly<{
  root: string; controller: AbortController; result: Promise<CompletedBoundedProcessResult>;
}>) => Promise<void>): Promise<void> {
  const sourceRoot = await realpath(join(import.meta.dir, ".."));
  const root = await mkdtemp(join(tmpdir(), "hra-site-compiler-native-"));
  const controller = new AbortController();
  const raw = runBoundedProcess({
    executable: process.execPath, arguments: [join(sourceRoot, "scripts/site-test-compiler-native-fixture.ts"), mode, root],
    containment: "local", captureLocalDiagnostics: true, cwd: sourceRoot,
    environment: { PATH: process.env.PATH ?? dirname(process.execPath), NO_COLOR: "1" },
    signal: controller.signal, phase: "site-compiler-native-proof", timeoutMs: nativeWorkMs,
    terminationGraceMs: 1_000, killSettlementMs: 5_000, outputMaximumBytes: 16_384,
  });
  const result = raw.then(requireBoundedProcessCleanup);
  const observed = result.then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason: unknown) => ({ status: "rejected", reason }) as const,
  );
  const failures: unknown[] = [];
  try { await proof({ root, controller, result }); }
  catch (error: unknown) { failures.push(error); }
  controller.abort();
  const outcome = await observed;
  if (outcome.status === "rejected") failures.push(outcome.reason);
  // Keep private readiness and recovery evidence if process collection is not
  // proved. This helper never sends a second cleanup signal or removes state.
  else await rm(root, { recursive: true, force: true });
  if (failures.length > 0) throw new AggregateError(failures, "SITE_COMPILER_NATIVE_PROOF_FAILED");
}

const terminal = z.object({
  mode: z.enum(["transform", "late-unref", "no-child", "unknown-spawn"]),
  acquired: z.number().int().min(0).max(1), closed: z.number().int().min(0).max(1),
  sharedStop: z.boolean(), refused: z.boolean(),
  events: z.array(z.enum(["acquired", "transformed", "stop_started", "late_unref", "child_closed", "stop_returned"])).max(6),
}).strict();

test.each(["transform", "late-unref"] as const)("joins the genuine native compiler before shutdown returns: %s", async (mode) => {
  await withNativeFixture(mode, async ({ result }) => {
    const value = await result;
    expect(value.exitCode).toBe(0);
    expect(value.stderr.toString("utf8")).toBe("");
    expect(value.localDiagnostics).toMatchObject({ rawCloseCode: 0, firstTerminationReason: "none", closeGroup: "absent" });
    const parsed = terminal.parse(JSON.parse(value.stdout.toString("utf8")) as unknown);
    expect(parsed).toEqual({ mode, acquired: 1, closed: 1, sharedStop: true, refused: false,
      events: ["acquired", "transformed", "stop_started", ...(mode === "late-unref" ? ["late_unref"] as const : []), "child_closed", "stop_returned"],
    });
  });
}, nativeOuterMs);

test("closes a compiler scope without starting an unnecessary native child", async () => {
  await withNativeFixture("no-child", async ({ result }) => {
    const value = await result;
    expect(value.exitCode).toBe(0);
    expect(value.stderr.toString("utf8")).toBe("");
    expect(terminal.parse(JSON.parse(value.stdout.toString("utf8")) as unknown)).toEqual({
      mode: "no-child", acquired: 0, closed: 0, sharedStop: true, refused: false, events: ["stop_started", "stop_returned"],
    });
  });
}, nativeOuterMs);

test("refuses an unknown spawn before dispatch and keeps a swallowed refusal nonzero", async () => {
  await withNativeFixture("unknown-spawn", async ({ result }) => {
    const value = await result;
    expect(value.exitCode).toBe(1);
    expect(value.stderr.toString("utf8")).toBe("");
    expect(value.localDiagnostics).toMatchObject({ rawCloseCode: 1, firstTerminationReason: "none", closeGroup: "absent" });
    expect(terminal.parse(JSON.parse(value.stdout.toString("utf8")) as unknown)).toEqual({
      mode: "unknown-spawn", acquired: 0, closed: 0, sharedStop: true, refused: true, events: ["stop_started", "stop_returned"],
    });
  });
}, nativeOuterMs);

test("the parent collects the complete group while a real child-close join is pending", async () => {
  await withNativeFixture("cancel-join", async ({ root, controller, result }) => {
    const readyDeadline = performance.now() + 10_000;
    let ready: Readonly<{ pid: number; childPid: number }> | undefined;
    while (ready === undefined) {
      try {
        ready = z.object({ pid: z.number().int().min(2), childPid: z.number().int().min(2) }).strict()
          .parse(JSON.parse(await readFile(join(root, "ready.json"), "utf8")) as unknown);
      } catch (error: unknown) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        if (performance.now() >= readyDeadline) throw new Error("SITE_COMPILER_NATIVE_READY_DEADLINE");
        await Bun.sleep(20);
      }
    }
    controller.abort();
    const value = await result;
    expect(value.cleanup).toBe("proven");
    expect(value.exitCode).toBe(130);
    expect(value.stdout.length).toBe(0);
    expect(value.stderr.length).toBe(0);
    expect(value.localDiagnostics).toMatchObject({ firstTerminationReason: "abort", termSignalFailed: false, killSignalFailed: false });
    for (const pid of [ready.pid, ready.childPid]) {
      let absence: unknown;
      try { process.kill(pid, 0); } catch (error: unknown) { absence = error; }
      expect(absence).toMatchObject({ code: "ESRCH" });
    }
  });
}, nativeOuterMs);

test("joins a genuine failed spawn through close without waiting for an exit event", async () => {
  await withNativeFixture("failed-spawn", async ({ result }) => {
    const value = await result;
    expect(value.exitCode).toBe(1);
    expect(value.stderr.toString("utf8")).toBe("");
    expect(value.localDiagnostics).toMatchObject({ rawCloseCode: 1, firstTerminationReason: "none", closeGroup: "absent" });
    expect(z.object({ errorObserved: z.boolean(), exitObserved: z.boolean(), closeObserved: z.boolean(), joinRejected: z.boolean() }).strict()
      .parse(JSON.parse(value.stdout.toString("utf8")) as unknown)).toEqual({
      errorObserved: true, exitObserved: false, closeObserved: true, joinRejected: true,
    });
  });
}, nativeOuterMs);

test("joins a genuine child whose close event preceded the stop request", async () => {
  await withNativeFixture("already-closed", async ({ result }) => {
    const value = await result;
    expect(value.exitCode).toBe(0);
    expect(value.stderr.toString("utf8")).toBe("");
    expect(value.localDiagnostics).toMatchObject({ rawCloseCode: 0, firstTerminationReason: "none", closeGroup: "absent" });
    expect(z.object({ errorObserved: z.boolean(), exitObserved: z.boolean(), closeObserved: z.boolean(), joinRejected: z.boolean(),
      closedBeforeStop: z.boolean(),
    }).strict().parse(JSON.parse(value.stdout.toString("utf8")) as unknown)).toEqual({
      errorObserved: false, exitObserved: true, closeObserved: true, joinRejected: false, closedBeforeStop: true,
    });
  });
}, nativeOuterMs);
