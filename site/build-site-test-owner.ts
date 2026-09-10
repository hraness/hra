import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  requireBoundedProcessCleanup, runBoundedProcess,
  type BoundedProcessRequest, type BoundedProcessResult,
} from "../scripts/bounded-process";
import { readSiteTestBuildTerminal, siteTestBuildOptions, type SiteTestBuildOptions } from "./build-site-test-protocol";

export const siteCompilerWorkMs = 60_000;
export const siteCompilerTerminationMs = 1_000;
export const siteCompilerCollectionMs = 5_000;
export const siteCompilerProofDrainMs = 5_000;
export const siteCompilerCloseMs = siteCompilerTerminationMs + siteCompilerCollectionMs + siteCompilerProofDrainMs;
export const siteCompilerOuterMs = siteCompilerWorkMs + siteCompilerCloseMs + 5_000;
export const siteCompilerHookMs = siteCompilerCloseMs + 5_000;

type Outcome = { status: "fulfilled" } | { status: "rejected"; reason: unknown };
type Schedule = (callback: () => void, milliseconds: number) => () => void;
const scheduleTimer: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => { clearTimeout(timer); };
};

const localExitDiagnostics = z.object({
  version: z.literal(1),
  rawCloseCode: z.union([z.number().int().min(0).max(255), z.null(), z.literal("unobserved"), z.literal("invalid")]),
  rawCloseSignal: z.enum(["none", "SIGTERM", "SIGKILL", "other", "unobserved"]),
  firstTerminationReason: z.enum(["none", "residual_group_non_absent", "output_limit", "abort", "timeout", "journal", "child_error"]),
  forcedExitCode: z.union([z.literal(1), z.literal(124), z.literal(130), z.null()]),
  closeGroup: z.enum(["unobserved", "absent", "non_absent"]),
  termSignalFailed: z.boolean(),
  killSignalFailed: z.boolean(),
}).strict();

function renderLocalExitDiagnostics(value: unknown): string {
  if (value === undefined) return "local_diagnostics=absent";
  const parsed = localExitDiagnostics.safeParse(value);
  if (!parsed.success) return "local_diagnostics=invalid";
  const diagnostic = parsed.data;
  return `local_diagnostics=v1 raw_close_code=${String(diagnostic.rawCloseCode)} raw_close_signal=${diagnostic.rawCloseSignal} termination=${diagnostic.firstTerminationReason} forced_exit_code=${String(diagnostic.forcedExitCode)} close_group=${diagnostic.closeGroup} term_signal_failed=${String(diagnostic.termSignalFailed)} kill_signal_failed=${String(diagnostic.killSignalFailed)}`;
}

/** One test-local owner; no production builder or process authority changes. */
export function createSiteCompilerCase(sourceRoot: string, dependencies: Readonly<{
  workMs?: number;
  now?: () => number;
  schedule?: Schedule;
  runProcess?: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
  removeRoot?: (root: string) => Promise<void>;
}> = {}) {
  const now = dependencies.now ?? (() => performance.now());
  const schedule = dependencies.schedule ?? scheduleTimer;
  const runProcess = dependencies.runProcess ?? runBoundedProcess;
  const removeRoot = dependencies.removeRoot ?? (async (root: string) => { await rm(root, { recursive: true, force: true }); });
  const workMs = dependencies.workMs ?? siteCompilerWorkMs;
  if (!Number.isSafeInteger(workMs) || workMs < 1 || workMs > siteCompilerWorkMs) throw new Error("SITE_COMPILER_BUDGET_INVALID");
  const controller = new AbortController();
  const deadlineError = new Error("SITE_COMPILER_CASE_DEADLINE");
  const closingError = new Error("SITE_COMPILER_CASE_CLOSING");
  const roots = new Set<string>();
  const processes: Promise<Outcome>[] = [];
  const requests: Promise<Outcome>[] = [];
  const lateFailures: unknown[] = [];
  let cleanupUnproven = false;
  let proof: Promise<Outcome> | undefined;
  let deadline = 0;
  let cancelDeadline: (() => void) | undefined;
  let closing: Promise<void> | undefined;

  const checkpoint = (): void => {
    if (deadline !== 0 && now() >= deadline && !controller.signal.aborted) controller.abort(deadlineError);
    controller.signal.throwIfAborted();
  };
  const observe = (task: Promise<unknown>): Promise<Outcome> => task.then(
    () => ({ status: "fulfilled" }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );

  const buildSite = (input: SiteTestBuildOptions): Promise<readonly string[]> => {
    // Observe before executing even the synchronous pre-dispatch checks.
    const task = Promise.resolve().then(async () => {
      checkpoint();
      if (proof === undefined || closing !== undefined) throw new Error("SITE_COMPILER_CASE_NOT_RUNNING");
      const options = siteTestBuildOptions.parse(input);
      const request: BoundedProcessRequest = {
        executable: process.execPath,
        arguments: ["--preload", join(sourceRoot, "scripts/site-test-compiler-preload.ts"), "--preload", join(sourceRoot, "scripts/register-site-stylex-test-transform.ts"), join(sourceRoot, "site/build-site-test-driver.ts")],
        containment: "local", captureLocalDiagnostics: true, cwd: sourceRoot,
        environment: { PATH: process.env.PATH ?? dirname(process.execPath), NO_COLOR: "1" },
        stdin: JSON.stringify(options), signal: controller.signal,
        phase: "site-test-compiler", timeoutMs: Math.max(1, Math.ceil(deadline - now())),
        terminationGraceMs: siteCompilerTerminationMs, killSettlementMs: siteCompilerCollectionMs,
        outputMaximumBytes: 1024 * 1024,
      };
      const raw = Promise.resolve().then(async () => {
        checkpoint();
        try { return await runProcess(request); }
        catch (error: unknown) { cleanupUnproven = true; lateFailures.push(error); throw error; }
      });
      processes.push(observe(raw));
      const collected = await raw;
      let result;
      try { result = requireBoundedProcessCleanup(collected); }
      catch (error: unknown) { cleanupUnproven = true; lateFailures.push(error); throw error; }
      const processFailure = (
        stage: "output_bound" | "terminal_invalid" | "terminal_exit_mismatch",
        terminalStatus?: "success" | "failure",
        error?: unknown,
      ): Error => {
        const exitCode = Number.isSafeInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255
          ? String(result.exitCode) : "invalid";
        return new Error(`SITE_COMPILER_PROCESS_FAILED stage=${stage} exit_code=${exitCode} terminal=${terminalStatus ?? "unparsed"} stdout_bytes=${String(result.stdout.byteLength)} stderr_bytes=${String(result.stderr.byteLength)} mode=${options.check ? "check" : "build"} ${renderLocalExitDiagnostics(result.localDiagnostics)}`, { cause: {
          exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"), error,
        } });
      };
      if (result.stdout.byteLength + result.stderr.byteLength >= request.outputMaximumBytes) {
        throw processFailure("output_bound");
      }
      // A valid real builder failure wins over cancellation. Transport/cleanup
      // errors never masquerade as the expected malformed-input oracle.
      if ((result.exitCode === 124 || result.exitCode === 130) && controller.signal.aborted
        && result.stdout.length === 0) controller.signal.throwIfAborted();
      let terminal;
      try { terminal = readSiteTestBuildTerminal(result.stdout); }
      catch (error: unknown) {
        if (controller.signal.aborted && (result.exitCode === 124 || result.exitCode === 130)) controller.signal.throwIfAborted();
        throw processFailure("terminal_invalid", undefined, error);
      }
      if (terminal.status === "failure" && result.exitCode === 1) {
        const error = new Error(terminal.message);
        error.name = terminal.name;
        if (terminal.stack !== undefined) error.stack = terminal.stack;
        throw error;
      }
      if (terminal.status !== "success" || result.exitCode !== 0) throw processFailure("terminal_exit_mismatch", terminal.status);
      checkpoint();
      return terminal.mismatches;
    });
    requests.push(task.then(
      () => ({ status: "fulfilled" }),
      (reason: unknown) => {
        if (controller.signal.aborted && reason !== closingError && reason !== deadlineError) lateFailures.push(reason);
        return { status: "rejected", reason };
      },
    ));
    return task;
  };

  return {
    buildSite,
    registerRoot: (root: string): void => { roots.add(root); },
    checkpoint,
    run(operation: () => Promise<void>): Promise<void> {
      if (proof !== undefined || closing !== undefined) throw new Error("SITE_COMPILER_CASE_ALREADY_STARTED");
      deadline = now() + workMs;
      cancelDeadline = schedule(() => { controller.abort(deadlineError); }, workMs);
      const raw = Promise.resolve().then(async () => {
        checkpoint();
        await operation();
        checkpoint();
      });
      proof = observe(raw);
      return raw;
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      if (!controller.signal.aborted) controller.abort(closingError);
      cancelDeadline?.();
      closing = (async () => {
        let cancelDrain: (() => void) | undefined;
        try {
          const drained = await Promise.race([
            (async () => { const outcome = await proof; await Promise.all(requests); await Promise.all(processes); return outcome; })(),
            new Promise<never>((_resolve, reject) => {
              cancelDrain = schedule(() => { reject(new Error("SITE_COMPILER_PROOF_DRAIN_UNPROVEN")); }, siteCompilerCloseMs);
            }),
          ]);
          const failures = [...lateFailures];
          if (drained?.status === "rejected" && drained.reason !== closingError && drained.reason !== deadlineError) failures.push(drained.reason);
          if (cleanupUnproven) throw new AggregateError(failures, "SITE_COMPILER_CLEANUP_UNPROVEN; fixture roots retained");
          for (const root of roots) await removeRoot(root);
          roots.clear();
          if (failures.length > 0) throw new AggregateError([...new Set(failures)], "SITE_COMPILER_PROOF_FAILED");
        } finally { cancelDrain?.(); }
      })();
      void observe(closing);
      return closing;
    },
  };
}
