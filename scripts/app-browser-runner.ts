import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserCustodyObserver } from "./app-browser.ts";
import {
  assertBrowserNode, browserDigest, browserExecutable, browserInventory, browserSources,
  parseBrowserRequest, publishBrowserJson, publishBrowserTerminalJson, readBrowserFile,
  readBrowserPrepared, verifyBrowserRequest, type BrowserRequest,
} from "./app-browser-handoff.ts";

type ChildIdentity = Readonly<{ pid: number; parent: number; group: number; started: string }>;
type ChildExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
type OwnedPreparation = { child: ChildProcess; closed: Promise<ChildExit>; identity: ChildIdentity | undefined };
const delay = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));

const preparationCollectionStages = [
  "ownership-proof", "initial-probe", "term-leader-check", "term-identity-read", "term-identity-validate", "term-syscall",
  "post-term-probe", "post-term-wait", "pre-kill-probe", "kill-leader-check", "kill-identity-read", "kill-identity-validate",
  "kill-syscall", "post-kill-probe", "post-kill-wait", "final-probe", "final-absence", "stream-join",
  "unspawned-ownership-proof", "unspawned-stream-join",
] as const;
type PreparationCollectionStage = typeof preparationCollectionStages[number];
const collectionCodes = ["none", "unknown", "EPERM", "EACCES", "ESRCH", "ENOENT", "EINVAL", "EIO", "EAGAIN", "ENOMEM",
  "ETIMEDOUT", "ECANCELED", "ABORT_ERR", "ERR_ASSERTION", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"] as const;
const collectionSyscalls = ["none", "unknown", "kill", "spawn-ps", "read", "write", "waitpid"] as const;
const childSignals = ["unknown", "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL",
  "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGSTOP", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN",
  "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGXCPU", "SIGXFSZ", "SIGWINCH", "SIGIO", "SIGSYS", "SIGINFO",
  "SIGEMT", "SIGVTALRM", "SIGPROF", "SIGPOLL", "SIGPWR", "SIGLOST", "SIGUNUSED", "SIGBREAK"] as const;
export type PreparationCollectionDiagnostic = Readonly<{
  stage: PreparationCollectionStage; attempt: number; attemptCapped: boolean; elapsedMs: number; elapsedCapped: boolean;
  pid: number | null; group: number | null; termAttempted: boolean; termSent: boolean; killAttempted: boolean; killSent: boolean;
  childExitCode: number | null; childSignal: typeof childSignals[number] | null; closeSeen: boolean;
  code: typeof collectionCodes[number]; syscall: typeof collectionSyscalls[number]; errno: number | null;
}>;
const diagnosticKeys = ["stage", "attempt", "attemptCapped", "elapsedMs", "elapsedCapped", "pid", "group", "termAttempted",
  "termSent", "killAttempted", "killSent", "childExitCode", "childSignal", "closeSeen", "code", "syscall", "errno"];
function ownField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value as unknown : undefined;
  } catch { return undefined; }
}
function finiteChoice<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.some((choice) => choice === value);
}
export function preparationNativeFailure(value: unknown): Pick<PreparationCollectionDiagnostic, "code" | "syscall" | "errno"> {
  let code: unknown, syscall: unknown, errno: unknown;
  let current = value;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    code ??= ownField(current, "code"); syscall ??= ownField(current, "syscall"); errno ??= ownField(current, "errno");
    current = ownField(current, "cause");
  }
  return {
    code: code === undefined ? "none" : finiteChoice(code, collectionCodes) ? code : "unknown",
    syscall: syscall === undefined ? "none" : syscall === "spawn /bin/ps" ? "spawn-ps"
      : finiteChoice(syscall, collectionSyscalls) ? syscall : "unknown",
    errno: typeof errno === "number" && Number.isInteger(errno) && Math.abs(errno) <= 65535 ? errno : null,
  };
}
export function parsePreparationCollectionDiagnostic(value: unknown): PreparationCollectionDiagnostic {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), "Invalid preparation collection diagnostic");
  assert.deepEqual(Object.keys(value).sort(), [...diagnosticKeys].sort(), "Unexpected preparation collection fields");
  const fields = Object.fromEntries(diagnosticKeys.map((key) => [key, ownField(value, key)]));
  assert.ok(finiteChoice(fields.stage, preparationCollectionStages));
  assert.ok(finiteChoice(fields.code, collectionCodes)); assert.ok(finiteChoice(fields.syscall, collectionSyscalls));
  assert.ok(fields.childSignal === null || finiteChoice(fields.childSignal, childSignals));
  const integer = (candidate: unknown, min: number, max: number): candidate is number =>
    typeof candidate === "number" && Number.isInteger(candidate) && candidate >= min && candidate <= max;
  assert.ok(integer(fields.attempt, 0, 10_000)); assert.ok(integer(fields.elapsedMs, 0, 30_000));
  assert.ok(fields.pid === null || integer(fields.pid, 2, 2 ** 31 - 1)); assert.equal(fields.group, fields.pid);
  assert.ok(fields.childExitCode === null || integer(fields.childExitCode, -(2 ** 31), 2 ** 31 - 1));
  assert.ok(fields.errno === null || integer(fields.errno, -65535, 65535));
  for (const key of ["attemptCapped", "elapsedCapped", "termAttempted", "termSent", "killAttempted", "killSent", "closeSeen"]) {
    assert.equal(typeof fields[key], "boolean");
  }
  assert.ok(fields.termSent !== true || fields.termAttempted === true); assert.ok(fields.killSent !== true || fields.killAttempted === true);
  return Object.freeze(fields) as PreparationCollectionDiagnostic;
}
export class PreparationCollectionError extends Error {
  readonly collection: PreparationCollectionDiagnostic;
  constructor(collection: PreparationCollectionDiagnostic, cause: unknown) {
    const parsed = parsePreparationCollectionDiagnostic(collection);
    super(`Browser preparation collection failed at ${parsed.stage}`, { cause });
    this.name = "PreparationCollectionError"; this.collection = parsed;
  }
}
export class PreparationCollectionTrace {
  stage: PreparationCollectionStage = "ownership-proof";
  attempt = 0;
  termAttempted = false; termSent = false; killAttempted = false; killSent = false;
  readonly #started: number;
  private readonly state: () => Readonly<{ identity?: ChildIdentity; childExitCode: number | null; childSignal: string | null; closeSeen: boolean }>;
  private readonly now: () => number;
  constructor(
    state: () => Readonly<{ identity?: ChildIdentity; childExitCode: number | null; childSignal: string | null; closeSeen: boolean }>
      = () => ({ childExitCode: null, childSignal: null, closeSeen: false }),
    now: () => number = () => performance.now(),
  ) { this.state = state; this.now = now; this.#started = now(); }
  mark(stage: PreparationCollectionStage, attempt = 0): void { this.stage = stage; this.attempt = attempt; }
  snapshot(cause?: unknown): PreparationCollectionDiagnostic {
    const current = this.state();
    const elapsed = Math.max(0, Math.floor(this.now() - this.#started));
    return parsePreparationCollectionDiagnostic({
      stage: this.stage, attempt: Math.min(10_000, this.attempt), attemptCapped: this.attempt > 10_000,
      elapsedMs: Math.min(30_000, elapsed), elapsedCapped: elapsed > 30_000,
      pid: current.identity?.pid ?? null, group: current.identity?.group ?? null,
      termAttempted: this.termAttempted, termSent: this.termSent, killAttempted: this.killAttempted, killSent: this.killSent,
      childExitCode: current.childExitCode, childSignal: current.childSignal === null ? null
        : finiteChoice(current.childSignal, childSignals) ? current.childSignal : "unknown", closeSeen: current.closeSeen,
      ...preparationNativeFailure(cause),
    });
  }
}

export function parsePreparationIdentity(text: string, expectedPid: number, parent: number): ChildIdentity {
  const parts = text.trim().split(/\s+/u);
  assert.equal(parts.length, 8, "Invalid preparation process identity");
  assert.equal(Number(parts[0]), expectedPid); assert.equal(Number(parts[1]), parent); assert.equal(Number(parts[2]), expectedPid);
  assert.ok(Number.isSafeInteger(expectedPid) && expectedPid > 1);
  const started = parts.slice(3).join(" "); assert.ok(started.length >= 20 && started.length <= 40);
  return { pid: expectedPid, parent, group: expectedPid, started };
}
async function preparationIdentity(pid: number): Promise<ChildIdentity> {
  const text = await new Promise<string>((done, reject) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
      (error, stdout) => { if (error !== null) reject(new Error("Preparation process identity unavailable", { cause: error })); else done(stdout); });
  });
  return parsePreparationIdentity(text, pid, process.pid);
}
function groupPresent(group: number): boolean {
  assert.ok(Number.isSafeInteger(group) && group > 1);
  try { process.kill(-group, 0); return true; }
  catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false; throw error; }
}
export async function browserRunnerDeadline<T>(work: Promise<T>, milliseconds: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline`)), milliseconds);
      abort = () => reject(new Error(`${label} cancelled`));
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); if (abort !== undefined) signal?.removeEventListener("abort", abort); }
}

/** Pure control seam tests the same ordered collection policy used natively.
 * Unknown identity/probe failures propagate; a reused/leaderless group is never
 * signalled merely because its remembered number is still present. */
export async function collectBrowserPreparation(operations: Readonly<{
  present: () => boolean; leaderRunning: () => boolean; signal: (signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  waitAbsent: (milliseconds: number, phase: "term" | "kill") => Promise<void>; closed: () => Promise<ChildExit>;
}>, trace = new PreparationCollectionTrace()): Promise<void> {
  try {
    trace.mark("initial-probe");
    if (operations.present()) {
      trace.mark("term-leader-check");
      if (operations.leaderRunning()) await operations.signal("SIGTERM");
      trace.mark("post-term-wait"); await operations.waitAbsent(2000, "term");
    }
    trace.mark("pre-kill-probe");
    if (operations.present()) {
      trace.mark("kill-leader-check");
      assert.ok(operations.leaderRunning(), "Preparation leader exited with an uncollected group");
      await operations.signal("SIGKILL");
      trace.mark("post-kill-wait"); await operations.waitAbsent(5000, "kill");
    }
    trace.mark("final-probe"); const present = operations.present();
    trace.mark("final-absence"); assert.equal(present, false, "Preparation process group remains; evidence retained");
    trace.mark("stream-join"); await operations.closed();
  } catch (cause) {
    throw cause instanceof PreparationCollectionError ? cause : new PreparationCollectionError(trace.snapshot(cause), cause);
  }
}
export async function signalBrowserPreparation(
  signal: "SIGTERM" | "SIGKILL", identity: ChildIdentity,
  operations: Readonly<{ identity: () => Promise<ChildIdentity>; send: () => void }>, trace: PreparationCollectionTrace,
): Promise<void> {
  trace.mark(signal === "SIGTERM" ? "term-identity-read" : "kill-identity-read");
  const current = await operations.identity();
  trace.mark(signal === "SIGTERM" ? "term-identity-validate" : "kill-identity-validate");
  assert.deepEqual(current, identity, "Preparation identity changed; refusing signal");
  trace.mark(signal === "SIGTERM" ? "term-syscall" : "kill-syscall");
  if (signal === "SIGTERM") trace.termAttempted = true; else trace.killAttempted = true;
  operations.send();
  if (signal === "SIGTERM") trace.termSent = true; else trace.killSent = true;
}
export async function waitForBrowserPreparationAbsence(
  milliseconds: number, phase: "term" | "kill",
  operations: Readonly<{ present: () => boolean; now: () => number; wait: () => Promise<void> }>, trace: PreparationCollectionTrace,
): Promise<void> {
  const deadline = operations.now() + milliseconds;
  let attempt = 0;
  let unresolvedPermission: { cause: unknown } | undefined;
  for (;;) {
    trace.mark(phase === "term" ? "post-term-probe" : "post-kill-probe", attempt);
    try {
      // The native probe returns false only for ESRCH. Neither an uncertain
      // probe nor direct-child exit proves that the owned group is absent.
      if (!operations.present()) return;
    } catch (error) {
      const signalSent = phase === "term" ? trace.termSent : trace.killSent;
      if (!signalSent || ownField(error, "code") !== "EPERM") throw error;
      // A successful owned signal may precede an indeterminate group probe.
      // Retain the first failure until actual absence, even if a later probe
      // reports presence, so uncertainty can never authorize another signal.
      unresolvedPermission ??= { cause: error };
    }
    if (operations.now() >= deadline) {
      if (unresolvedPermission !== undefined) {
        throw new PreparationCollectionError(trace.snapshot(unresolvedPermission.cause), unresolvedPermission.cause);
      }
      return;
    }
    trace.mark(phase === "term" ? "post-term-wait" : "post-kill-wait", attempt);
    await operations.wait(); attempt += 1;
  }
}
async function collectPreparation(owner: OwnedPreparation, trace: PreparationCollectionTrace): Promise<void> {
  const identity = owner.identity;
  trace.mark("ownership-proof");
  assert.ok(identity !== undefined, "Preparation ownership unproved; evidence retained");
  await collectBrowserPreparation({
    present: () => groupPresent(identity.group),
    leaderRunning: () => owner.child.exitCode === null && owner.child.signalCode === null,
    signal: (signal) => signalBrowserPreparation(signal, identity, {
      identity: () => preparationIdentity(identity.pid), send: () => { process.kill(-identity.group, signal); },
    }, trace),
    waitAbsent: (milliseconds, phase) => waitForBrowserPreparationAbsence(milliseconds, phase, {
      present: () => groupPresent(identity.group), now: () => performance.now(), wait: () => delay(25),
    }, trace),
    closed: () => browserRunnerDeadline(owner.closed, 5000, "Preparation stream closure"),
  }, trace);
}
export function browserRunnerFailureDetails(value: unknown, depth = 0): unknown {
  if (!(value instanceof Error)) return { name: "UnknownFailure", message: typeof value };
  // Keep the original cause in memory, but serialize only this validated
  // native-operation diagnostic. Never copy syscall messages, stacks or args.
  if (value instanceof PreparationCollectionError) {
    const collection = parsePreparationCollectionDiagnostic(value.collection);
    return { name: "PreparationCollectionError", message: `Browser preparation collection failed at ${collection.stage}`, collection };
  }
  return { name: value.name.slice(0, 80), message: value.message.slice(0, 1000),
    ...(depth < 3 && value.cause !== undefined ? { cause: browserRunnerFailureDetails(value.cause, depth + 1) } : {}),
    ...(depth < 3 && value instanceof AggregateError ? { errors: value.errors.slice(0, 8).map((error: unknown) => browserRunnerFailureDetails(error, depth + 1)) } : {}),
  };
}

async function runPreparation(request: BrowserRequest, signal: AbortSignal, observer?: BrowserCustodyObserver): Promise<void> {
  assert.ok(!signal.aborted, "Browser preparation cancelled before dispatch");
  const args = [join(request.root, "scripts/prepare-app-browser.ts"), request.run];
  await publishBrowserJson(join(request.run, "preparation-intent.json"), { executable: request.bun, args, parent: process.pid, detached: true });
  assert.ok(!signal.aborted, "Browser preparation cancelled before dispatch");
  const child = spawn(request.bun.path, args, {
    cwd: request.root, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${dirname(request.bun.path)}:${dirname(request.node.path)}:/usr/bin:/bin`, NODE_ENV: "production", TZ: "UTC" },
  });
  // Sticky immediately after acquisition, before identity/journal operations.
  const closeState = { seen: false };
  const owner: OwnedPreparation = { child, identity: undefined,
    closed: new Promise((done) => child.once("close", (code, signal) => { closeState.seen = true; done({ code, signal }); })),
  };
  let stdout = "", stderr = "", outputBytes = 0, exceeded = false;
  const outputFailure = new AbortController();
  const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
    outputBytes += chunk.length;
    if (stream === "stdout") stdout = (stdout + chunk.toString("utf8")).slice(-32768);
    else stderr = (stderr + chunk.toString("utf8")).slice(-32768);
    if (outputBytes > 1024 * 1024) { exceeded = true; outputFailure.abort(); }
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  let failure: unknown, collected = false;
  const acquisition = { spawned: false };
  try {
    await browserRunnerDeadline(new Promise<void>((done, reject) => {
      child.once("spawn", () => { acquisition.spawned = true; done(); }); child.once("error", reject);
    }), 5000, "Preparation spawn");
    assert.ok(child.pid !== undefined);
    owner.identity = await preparationIdentity(child.pid);
    await publishBrowserJson(join(request.run, "preparation-owner.json"), owner.identity);
    if (observer !== undefined) {
      assert.equal(observer(Object.freeze({ kind: "preparation-owned", run: request.run, identity: Object.freeze({ ...owner.identity }) })),
        undefined, "Browser custody observation must finish synchronously");
    }
    const outcome = await browserRunnerDeadline(owner.closed, 180_000, "Browser preparation", AbortSignal.any([signal, outputFailure.signal]));
    assert.equal(outcome.signal, null); assert.equal(outcome.code, 0, "Bun browser preparation failed");
    assert.equal(exceeded, false, "Preparation output exceeded its bound");
  } catch (error) { failure = error; }
  finally {
    const trace = new PreparationCollectionTrace(() => ({
      ...(owner.identity === undefined ? {} : { identity: owner.identity }),
      childExitCode: child.exitCode, childSignal: child.signalCode, closeSeen: closeState.seen,
    }));
    let collectionFailure: unknown;
    try {
      if (acquisition.spawned) await collectPreparation(owner, trace);
      else {
        trace.mark("unspawned-ownership-proof");
        assert.equal(child.pid, undefined, "A possibly acquired preparation child lacks ownership proof");
        trace.mark("unspawned-stream-join");
        await browserRunnerDeadline(owner.closed, 5000, "Failed preparation stream closure");
      }
      collected = true;
    } catch (cause) {
      collectionFailure = cause;
      const error = cause instanceof PreparationCollectionError ? cause : new PreparationCollectionError(trace.snapshot(cause), cause);
      failure = failure === undefined ? error : new AggregateError([failure, error], "Preparation and collection failed");
    }
    try {
      await publishBrowserJson(join(request.run, "preparation-result.json"), {
        state: browserTerminalState(signal, collected, failure), collected, identity: owner.identity ?? null,
        acquisition: { pid: child.pid ?? null, spawned: acquisition.spawned },
        collection: trace.snapshot(collectionFailure),
        stdout, stderr, outputBytes, exceeded, ...(failure === undefined ? {} : { failure: browserRunnerFailureDetails(failure) }),
      });
    } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Preparation and receipt publication failed"); }
  }
  assertPreparationOutcome(signal, failure);
}

export function assertPreparationOutcome(signal: AbortSignal, failure: unknown): void {
  // Preserve a primary/collection aggregate instead of replacing it with the
  // less informative fact that the caller also cancelled preparation.
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error("Preparation failed", { cause: failure });
  assert.ok(!signal.aborted, "Browser preparation cancelled");
}

export function assertBrowserDispatchAllowed(signal: AbortSignal, prepared: boolean): void {
  assert.ok(!signal.aborted, "Browser acceptance cancelled before driver admission");
  assert.equal(prepared, true, "Browser preparation has not been collected");
}

export function browserTerminalState(signal: AbortSignal, collected: boolean, failure: unknown): "passed" | "failed" {
  return failure !== undefined || signal.aborted || !collected ? "failed" : "passed";
}

export async function browserDriverReceiptIfDispatched<T>(dispatched: boolean, operations: Readonly<{
  read: () => Promise<T>; assertAbsent: () => Promise<void>;
}>): Promise<T | undefined> {
  if (dispatched) return await operations.read();
  await operations.assertAbsent();
  return undefined;
}

export async function runBrowserBootstrap(observer?: BrowserCustodyObserver): Promise<void> {
  assertBrowserNode(process.versions); assert.equal(process.argv.length, 2, "Browser runner takes no positional arguments");
  const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const bunPath = process.env.BUN_EXECUTABLE_PATH, chromePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  assert.ok(bunPath !== undefined && chromePath !== undefined, "Set explicit BUN_EXECUTABLE_PATH and CHROMIUM_EXECUTABLE_PATH");
  const node = await browserExecutable(process.execPath), bun = await browserExecutable(bunPath), chromium = await browserExecutable(chromePath);
  const temporaryRoot = join(root, "tmp"); await mkdir(temporaryRoot, { recursive: true }); assert.equal(await realpath(temporaryRoot), temporaryRoot);
  const run = await mkdtemp(join(temporaryRoot, "app-browser-"));
  const cancellation = new AbortController(); const onSignal = () => cancellation.abort();
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  let failure: unknown, driverReceipt: Record<string, unknown> | undefined, preparationCollected = false, requestSha256: string | undefined;
  let request: BrowserRequest | undefined, inputsUnchanged = false, driverDispatched = false;
  try {
    request = parseBrowserRequest({ schemaVersion: 1, kind: "hra-browser-preparation-request", root, run, node, bun, chromium,
      sources: await browserSources(root), app: await browserInventory(join(root, "app/dist")), site: await browserInventory(join(root, "dist/site")),
    });
    await publishBrowserJson(join(run, "request.json"), request);
    requestSha256 = browserDigest(await readBrowserFile(join(run, "request.json"), 16 * 1024 * 1024));
    await runPreparation(request, cancellation.signal, observer); preparationCollected = true;
    const handoff = await readBrowserPrepared(root, run);
    assertBrowserDispatchAllowed(cancellation.signal, preparationCollected);
    const driver: unknown = await import(pathToFileURL(join(run, "driver.mjs")).href);
    assertBrowserDispatchAllowed(cancellation.signal, preparationCollected);
    assert.ok(typeof driver === "object" && driver !== null && "runAppBrowser" in driver && typeof driver.runAppBrowser === "function");
    driverDispatched = true;
    await (driver.runAppBrowser as (root: string, run: string, signal: AbortSignal, observer?: BrowserCustodyObserver) => Promise<void>)(root, run, cancellation.signal, observer);
    await verifyBrowserRequest(request);
    assert.deepEqual(await readBrowserPrepared(root, run), handoff);
  } catch (error) { failure = error; }
  finally {
    try {
      assert.ok(request !== undefined, "Browser request was not established");
      await verifyBrowserRequest(request); inputsUnchanged = true;
    } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Browser run and input postflight failed"); }
    try {
      driverReceipt = await browserDriverReceiptIfDispatched(driverDispatched, {
        read: async () => {
          const value: unknown = JSON.parse((await readBrowserFile(join(run, "driver-receipt.json"), 16 * 1024 * 1024)).toString("utf8"));
          assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
          const receipt = value as Record<string, unknown>;
          assert.equal(receipt.kind, "hra-app-browser-acceptance"); assert.equal(receipt.schemaVersion, 2);
          assert.ok(typeof receipt.driverRuntime === "object" && receipt.driverRuntime !== null);
          const identity = receipt.driverRuntime as Record<string, unknown>;
          assert.equal(identity.name, "node"); assert.equal(identity.version, "24.18.1"); assert.deepEqual(identity.executable, node);
          if (failure === undefined) assert.equal(receipt.state, "passed", "Browser driver did not pass");
          return receipt;
        },
        assertAbsent: async () => {
          let present = true;
          try { await lstat(join(run, "driver-receipt.json")); }
          catch (error) { if (ownField(error, "code") !== "ENOENT") throw error; present = false; }
          assert.equal(present, false, "Unexpected receipt for an undispatched browser driver");
        },
      });
      assert.ok(driverDispatched || failure !== undefined, "Browser driver was never dispatched");
    } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Browser run and receipt verification failed"); }
    // No awaits after this terminal decision. An interrupt during any earlier
    // cleanup remains fatal and cannot produce a passed final receipt.
    const state = browserTerminalState(cancellation.signal, preparationCollected && inputsUnchanged, failure);
    try {
      publishBrowserTerminalJson(join(run, "receipt.json"), {
        ...(driverReceipt ?? {}), schemaVersion: 2, kind: "hra-app-browser-acceptance", state,
        buildRuntime: driverReceipt?.buildRuntime ?? { name: "bun", version: "1.3.14", executable: bun },
        driverRuntime: driverReceipt?.driverRuntime ?? { name: "node", version: process.versions.node, executable: node },
        runner: { preparationCollected, inputsUnchanged, driverDispatched, cancelled: cancellation.signal.aborted, requestSha256: requestSha256 ?? null },
        ...(failure === undefined ? {} : { runnerFailure: browserRunnerFailureDetails(failure) }),
      });
      console.log(`Browser acceptance ${state}; receipt retained`);
    } finally { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
    if (state === "failed" && failure === undefined) failure = new Error("Browser acceptance cancelled or uncollected");
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error("Browser acceptance failed", { cause: failure });
}
