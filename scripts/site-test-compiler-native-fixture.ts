import childProcess, { type ChildProcess, type spawn } from "node:child_process";
import { link, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { createSiteTestCompilerChildJoin } from "./site-test-compiler-child-join";
import { holdSiteTestCompilerEventLoop } from "./site-test-compiler-event-loop";

const [mode, root] = z.tuple([
  z.enum(["transform", "late-unref", "no-child", "unknown-spawn", "cancel-join", "failed-spawn", "already-closed"]), z.string(),
]).parse(Bun.argv.slice(2));
if (!isAbsolute(root)) throw new Error("SITE_COMPILER_NATIVE_ROOT_INVALID");

if (mode === "failed-spawn" || mode === "already-closed") {
  const failureObservation: { observed: boolean; cause?: unknown } = { observed: false };
  let exitObserved = false;
  let closeObserved = false;
  let closedBeforeStop = false;
  let joinRejected = false;
  const childJoin = createSiteTestCompilerChildJoin({
    stop: () => { closedBeforeStop = closeObserved; return Promise.resolve(); },
    keepAlive: holdSiteTestCompilerEventLoop,
    onFailure: () => { process.exitCode = 1; },
  });
  const child = childProcess.spawn(mode === "failed-spawn" ? join(root, "deliberately-absent-executable") : "/usr/bin/true", [], { stdio: "ignore" });
  child.once("error", (error: unknown) => { failureObservation.observed = true; failureObservation.cause = error; });
  child.once("exit", () => { exitObserved = true; });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => { closeObserved = true; resolve(); });
  });
  childJoin.own(child);
  if (mode === "already-closed") await closed;
  try { await childJoin.close(); }
  catch (error: unknown) {
    joinRejected = true;
    // Keep the actual native error in memory and prove the owner retained its
    // identity. Never serialize its executable path or arbitrary error text.
    if (!failureObservation.observed || !(error instanceof AggregateError)
      || !error.errors.some((failure: unknown) => failure instanceof Error && failure.cause === failureObservation.cause)) {
      throw new Error("SITE_COMPILER_NATIVE_CHILD_ERROR_NOT_RETAINED");
    }
  }
  process.stdout.write(`${JSON.stringify({ errorObserved: failureObservation.observed, exitObserved, closeObserved, joinRejected,
    ...(mode === "already-closed" ? { closedBeforeStop } : {}),
  })}\n`);
} else if (mode === "cancel-join") {
  // This deliberately pending child is owned only by the parent's existing
  // process group. The join requests no signals or independent cleanup.
  const child = childProcess.spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000);"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { PATH: process.env.PATH, NO_COLOR: "1" },
  });
  const pending = createSiteTestCompilerChildJoin({
    stop: async () => {
      const readyPath = join(root, "ready.json");
      const childPid = z.number().int().min(2).parse(child.pid);
      await writeFile(`${readyPath}.pending`, JSON.stringify({ pid: process.pid, childPid }), { flag: "wx", mode: 0o600 });
      await link(`${readyPath}.pending`, readyPath);
      await unlink(`${readyPath}.pending`);
    },
    keepAlive: holdSiteTestCompilerEventLoop,
    onFailure: () => { process.exitCode = 1; },
  });
  pending.own(child);
  await new Promise<void>((resolve, reject) => {
    let text = "";
    child.once("error", reject);
    child.once("close", () => { reject(new Error("SITE_COMPILER_NATIVE_CHILD_CLOSED_EARLY")); });
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text === "ready") resolve();
      else if (text.length >= 5) reject(new Error("SITE_COMPILER_NATIVE_CHILD_READY_INVALID"));
    });
  });
  await pending.close();
  throw new Error("SITE_COMPILER_NATIVE_PENDING_JOIN_RETURNED");
} else {
  const events: string[] = [];
  const children: ChildProcess[] = [];
  let closed = 0;
  const original = childProcess.spawn;
  // Observe acquisition before the real scope imports esbuild. The scope unit
  // test separately proves strict identity between own() and the returned child.
  childProcess.spawn = function (this: unknown, ...arguments_: Parameters<typeof spawn>): ChildProcess {
    if (children.length >= 1) throw new Error("SITE_COMPILER_NATIVE_EXTRA_CHILD");
    const child = Reflect.apply(original, this, arguments_);
    children.push(child);
    events.push("acquired");
    child.once("close", () => { closed += 1; events.push("child_closed"); });
    return child;
  } as typeof spawn;
  const { stopSiteTestCompiler } = await import("./site-test-compiler-preload");
  let refused = false;
  if (mode === "unknown-spawn") {
    try { childProcess.spawn("/usr/bin/true", [], { stdio: "ignore" }); }
    catch { refused = true; }
  } else if (mode !== "no-child") {
    const { transform } = await import("esbuild");
    const transformed = await transform("export const answer: number = 42;", { loader: "ts" });
    if (!transformed.code.includes("const answer = 42")) throw new Error("SITE_COMPILER_NATIVE_TRANSFORM_INVALID");
    events.push("transformed");
  }
  events.push("stop_started");
  const stopped = stopSiteTestCompiler();
  const sharedStop = stopped === stopSiteTestCompiler();
  if (mode === "late-unref") {
    queueMicrotask(() => {
      const child = children[0];
      if (child === undefined) throw new Error("SITE_COMPILER_NATIVE_CHILD_MISSING");
      child.unref();
      events.push("late_unref");
    });
  }
  await stopped;
  events.push("stop_returned");
  process.stdout.write(`${JSON.stringify({ mode, acquired: children.length, closed, sharedStop, refused, events })}\n`);
}
