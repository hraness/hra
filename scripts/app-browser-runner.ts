import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertBrowserNode, browserDigest, browserExecutable, browserInventory, browserSources,
  parseBrowserRequest, publishBrowserJson, publishBrowserTerminalJson, readBrowserFile,
  readBrowserPrepared, verifyBrowserRequest, type BrowserRequest,
} from "./app-browser-handoff.ts";

type ChildIdentity = Readonly<{ pid: number; parent: number; group: number; started: string }>;
type ChildExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
type OwnedPreparation = { child: ChildProcess; closed: Promise<ChildExit>; identity: ChildIdentity | undefined };
const delay = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));

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
  waitAbsent: (milliseconds: number) => Promise<void>; closed: () => Promise<ChildExit>;
}>): Promise<void> {
  if (operations.present()) {
    if (operations.leaderRunning()) await operations.signal("SIGTERM");
    await operations.waitAbsent(2000);
  }
  if (operations.present()) {
    assert.ok(operations.leaderRunning(), "Preparation leader exited with an uncollected group");
    await operations.signal("SIGKILL"); await operations.waitAbsent(5000);
  }
  assert.equal(operations.present(), false, "Preparation process group remains; evidence retained");
  await operations.closed();
}
async function collectPreparation(owner: OwnedPreparation): Promise<void> {
  const identity = owner.identity;
  assert.ok(identity !== undefined, "Preparation ownership unproved; evidence retained");
  await collectBrowserPreparation({
    present: () => groupPresent(identity.group),
    leaderRunning: () => owner.child.exitCode === null && owner.child.signalCode === null,
    signal: async (signal) => {
      assert.deepEqual(await preparationIdentity(identity.pid), identity, "Preparation identity changed; refusing signal");
      process.kill(-identity.group, signal);
    },
    waitAbsent: async (milliseconds) => {
      const deadline = performance.now() + milliseconds;
      while (groupPresent(identity.group) && performance.now() < deadline) await delay(25);
    },
    closed: () => browserRunnerDeadline(owner.closed, 5000, "Preparation stream closure"),
  });
}
function failureDetails(value: unknown, depth = 0): unknown {
  if (!(value instanceof Error)) return { name: "UnknownFailure", message: typeof value };
  return { name: value.name.slice(0, 80), message: value.message.slice(0, 1000),
    ...(depth < 3 && value.cause !== undefined ? { cause: failureDetails(value.cause, depth + 1) } : {}),
    ...(depth < 3 && value instanceof AggregateError ? { errors: value.errors.slice(0, 8).map((error: unknown) => failureDetails(error, depth + 1)) } : {}),
  };
}

async function runPreparation(request: BrowserRequest, signal: AbortSignal): Promise<void> {
  assert.ok(!signal.aborted, "Browser preparation cancelled before dispatch");
  const args = [join(request.root, "scripts/prepare-app-browser.ts"), request.run];
  await publishBrowserJson(join(request.run, "preparation-intent.json"), { executable: request.bun, args, parent: process.pid, detached: true });
  assert.ok(!signal.aborted, "Browser preparation cancelled before dispatch");
  const child = spawn(request.bun.path, args, {
    cwd: request.root, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${dirname(request.bun.path)}:${dirname(request.node.path)}:/usr/bin:/bin`, NODE_ENV: "production", TZ: "UTC" },
  });
  // Sticky immediately after acquisition, before identity/journal operations.
  const owner: OwnedPreparation = { child, identity: undefined,
    closed: new Promise((done) => child.once("close", (code, signal) => done({ code, signal }))),
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
    const outcome = await browserRunnerDeadline(owner.closed, 180_000, "Browser preparation", AbortSignal.any([signal, outputFailure.signal]));
    assert.equal(outcome.signal, null); assert.equal(outcome.code, 0, "Bun browser preparation failed");
    assert.equal(exceeded, false, "Preparation output exceeded its bound");
  } catch (error) { failure = error; }
  finally {
    try {
      if (acquisition.spawned) await collectPreparation(owner);
      else {
        assert.equal(child.pid, undefined, "A possibly acquired preparation child lacks ownership proof");
        await browserRunnerDeadline(owner.closed, 5000, "Failed preparation stream closure");
      }
      collected = true;
    } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Preparation and collection failed"); }
    await publishBrowserJson(join(request.run, "preparation-result.json"), {
      state: browserTerminalState(signal, collected, failure), collected, identity: owner.identity ?? null,
      acquisition: { pid: child.pid ?? null, spawned: acquisition.spawned },
      stdout, stderr, outputBytes, exceeded, ...(failure === undefined ? {} : { failure: failureDetails(failure) }),
    });
  }
  assert.ok(!signal.aborted, "Browser preparation cancelled");
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error("Preparation failed", { cause: failure });
}

export function assertBrowserDispatchAllowed(signal: AbortSignal, prepared: boolean): void {
  assert.ok(!signal.aborted, "Browser acceptance cancelled before driver admission");
  assert.equal(prepared, true, "Browser preparation has not been collected");
}

export function browserTerminalState(signal: AbortSignal, collected: boolean, failure: unknown): "passed" | "failed" {
  return failure !== undefined || signal.aborted || !collected ? "failed" : "passed";
}

export async function runBrowserBootstrap(): Promise<void> {
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
  let request: BrowserRequest | undefined, inputsUnchanged = false;
  try {
    request = parseBrowserRequest({ schemaVersion: 1, kind: "hra-browser-preparation-request", root, run, node, bun, chromium,
      sources: await browserSources(root), app: await browserInventory(join(root, "app/dist")), site: await browserInventory(join(root, "dist/site")),
    });
    await publishBrowserJson(join(run, "request.json"), request);
    requestSha256 = browserDigest(await readBrowserFile(join(run, "request.json"), 16 * 1024 * 1024));
    await runPreparation(request, cancellation.signal); preparationCollected = true;
    const handoff = await readBrowserPrepared(root, run);
    assertBrowserDispatchAllowed(cancellation.signal, preparationCollected);
    const driver: unknown = await import(pathToFileURL(join(run, "driver.mjs")).href);
    assertBrowserDispatchAllowed(cancellation.signal, preparationCollected);
    assert.ok(typeof driver === "object" && driver !== null && "runAppBrowser" in driver && typeof driver.runAppBrowser === "function");
    await (driver.runAppBrowser as (root: string, run: string, signal: AbortSignal) => Promise<void>)(root, run, cancellation.signal);
    await verifyBrowserRequest(request);
    assert.deepEqual(await readBrowserPrepared(root, run), handoff);
  } catch (error) { failure = error; }
  finally {
    try {
      assert.ok(request !== undefined, "Browser request was not established");
      await verifyBrowserRequest(request); inputsUnchanged = true;
    } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Browser run and input postflight failed"); }
    try {
      const value: unknown = JSON.parse((await readBrowserFile(join(run, "driver-receipt.json"), 16 * 1024 * 1024)).toString("utf8"));
      assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
      driverReceipt = value as Record<string, unknown>;
      assert.equal(driverReceipt.kind, "hra-app-browser-acceptance"); assert.equal(driverReceipt.schemaVersion, 2);
      assert.ok(typeof driverReceipt.driverRuntime === "object" && driverReceipt.driverRuntime !== null);
      const identity = driverReceipt.driverRuntime as Record<string, unknown>;
      assert.equal(identity.name, "node"); assert.equal(identity.version, "24.18.1"); assert.deepEqual(identity.executable, node);
      if (failure === undefined) assert.equal(driverReceipt.state, "passed", "Browser driver did not pass");
    } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Browser run and receipt verification failed"); }
    // No awaits after this terminal decision. An interrupt during any earlier
    // cleanup remains fatal and cannot produce a passed final receipt.
    const state = browserTerminalState(cancellation.signal, preparationCollected && inputsUnchanged, failure);
    try {
      publishBrowserTerminalJson(join(run, "receipt.json"), {
        ...(driverReceipt ?? {}), schemaVersion: 2, kind: "hra-app-browser-acceptance", state,
        buildRuntime: driverReceipt?.buildRuntime ?? { name: "bun", version: "1.3.14", executable: bun },
        driverRuntime: driverReceipt?.driverRuntime ?? { name: "node", version: process.versions.node, executable: node },
        runner: { preparationCollected, inputsUnchanged, cancelled: cancellation.signal.aborted, requestSha256: requestSha256 ?? null },
        ...(failure === undefined ? {} : { runnerFailure: failureDetails(failure) }),
      });
      console.log(`Browser acceptance ${state}; receipt retained`);
    } finally { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
    if (state === "failed" && failure === undefined) failure = new Error("Browser acceptance cancelled or uncollected");
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error("Browser acceptance failed", { cause: failure });
}
