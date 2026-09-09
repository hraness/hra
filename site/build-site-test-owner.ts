import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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
        arguments: ["--preload", join(sourceRoot, "scripts/register-site-stylex-test-transform.ts"), join(sourceRoot, "site/build-site-test-driver.ts")],
        containment: "local", cwd: sourceRoot,
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
      const processFailure = (error?: unknown): Error => new Error("SITE_COMPILER_PROCESS_FAILED", { cause: {
        exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"), error,
      } });
      if (result.stdout.byteLength + result.stderr.byteLength >= request.outputMaximumBytes) {
        throw processFailure();
      }
      // A valid real builder failure wins over cancellation. Transport/cleanup
      // errors never masquerade as the expected malformed-input oracle.
      if ((result.exitCode === 124 || result.exitCode === 130) && controller.signal.aborted
        && result.stdout.length === 0) controller.signal.throwIfAborted();
      let terminal;
      try { terminal = readSiteTestBuildTerminal(result.stdout); }
      catch (error: unknown) {
        if (controller.signal.aborted && (result.exitCode === 124 || result.exitCode === 130)) controller.signal.throwIfAborted();
        throw processFailure(error);
      }
      if (terminal.status === "failure" && result.exitCode === 1) {
        const error = new Error(terminal.message);
        error.name = terminal.name;
        if (terminal.stack !== undefined) error.stack = terminal.stack;
        throw error;
      }
      if (terminal.status !== "success" || result.exitCode !== 0) throw processFailure();
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
