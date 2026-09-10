import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  browserExecutable, browserFile, browserInventory, browserSources, parseBrowserRequest,
  publishBrowserJson, readBrowserFile, verifyBrowserRequest,
} from "./app-browser-handoff.ts";
import { browserRunnerDeadline, parsePreparationIdentity } from "./app-browser-runner.ts";
import { assertConnectedCancellationProof, assertPreparationCancellationProof } from "./app-browser-custody-contract.ts";

// Native proof is an explicit exclusive gate, not an implicit browser launch
// from the ordinary scripts test sweep. A skipped invocation proves nothing.
const native = test.skipIf(process.env.OOMPA_BROWSER_CUSTODY_NATIVE !== "1");
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function json(path: string): Promise<Record<string, unknown>> {
  return record(JSON.parse((await readBrowserFile(path, 16 * 1024 * 1024)).toString("utf8")) as unknown);
}
function positivePid(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 1);
  return value;
}
function requireAbsent(target: number): void {
  assert.ok(Number.isSafeInteger(target) && Math.abs(target) > 1);
  try { process.kill(target, 0); }
  catch (error) {
    assert.ok(error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH", "Native absence requires exact ESRCH");
    return;
  }
  assert.fail("Native custody process or group remains; evidence retained");
}
async function requireListenerAbsent(value: unknown): Promise<void> {
  assert.ok(typeof value === "string");
  const url = new URL(value);
  assert.equal(url.origin, value); assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
  assert.ok(/^\d+$/u.test(url.port) && Number(url.port) > 0 && Number(url.port) <= 65535);
  await new Promise<void>((done, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Native listener postflight deadline")); }, 2000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error("Native custody listener remains; evidence retained")); });
    socket.once("error", (error) => {
      clearTimeout(timer); socket.destroy();
      if ("code" in error && error.code === "ECONNREFUSED") done(); else reject(error);
    });
  });
}

for (const scenario of ["preparation-cancellation", "connected-cancellation", "partial-setup-failure"] as const) {
  native(`genuine Node browser custody: ${scenario}`, async () => {
    assert.equal(Bun.version, "1.3.14");
    assert.equal(await realpath(root), root);
    const selectedNode = process.env.NODE_EXECUTABLE_PATH ?? Bun.which("node");
    const selectedChrome = process.env.CHROMIUM_EXECUTABLE_PATH;
    assert.ok(typeof selectedNode === "string" && selectedChrome !== undefined, "Set genuine Node and Chromium executables for the native custody gate");
    const node = await browserExecutable(await realpath(selectedNode));
    const bun = await browserExecutable(process.execPath);
    const chromium = await browserExecutable(await realpath(selectedChrome));
    const sources = await browserSources(root);
    const app = await browserInventory(join(root, "app/dist"));
    const site = await browserInventory(join(root, "dist/site"));
    const fixtureSource = await browserFile(root, "scripts/app-browser-custody-fixture.ts");
    await mkdir(join(root, "tmp"), { recursive: true });
    const evidence = await mkdtemp(join(root, "tmp/browser-custody-"));
    assert.equal(await realpath(evidence), evidence);
    await publishBrowserJson(join(evidence, "intent.json"), { scenario, node, bun, chromium, fixtureSource, sources, app, site });
    const child = spawn(node.path, [join(root, fixtureSource.path)], {
      cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${dirname(node.path)}:${dirname(bun.path)}:/usr/bin:/bin`, NODE_ENV: "production", TZ: "UTC",
        BUN_EXECUTABLE_PATH: bun.path, CHROMIUM_EXECUTABLE_PATH: chromium.path,
        OOMPA_BROWSER_CUSTODY_CASE: scenario, OOMPA_BROWSER_CUSTODY_EVIDENCE: evidence,
      },
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.once("close", (code, signal) => done({ code, signal }));
    });
    let stdout = "", stderr = "", outputBytes = 0;
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (stream === "stdout") stdout = (stdout + chunk.toString("utf8")).slice(-65536);
      else stderr = (stderr + chunk.toString("utf8")).slice(-65536);
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    let outcome: Awaited<typeof closed> | undefined;
    let identity: ReturnType<typeof parsePreparationIdentity> | undefined;
    let failure: unknown;
    let proved = false;
    const joinDeadline = performance.now() + 360_000;
    // Every artifact is retained, including uncertain owners. The fixture asks
    // its real bootstrap for cancellation at 240 s; the parent never signals a
    // browser, guesses a PGID, or exits the helper to manufacture collection.
    try {
      await browserRunnerDeadline(new Promise<void>((done, reject) => {
        child.once("spawn", done); child.once("error", reject);
      }), 5000, "Custody fixture spawn");
      const pid = positivePid(child.pid);
      const text = await new Promise<string>((done, reject) => {
        execFile("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
          (error, value) => { if (error === null) done(value); else reject(error); });
      });
      identity = parsePreparationIdentity(text, pid, process.pid);
      await publishBrowserJson(join(evidence, "owner.json"), identity);
      outcome = await browserRunnerDeadline(closed, Math.max(1, joinDeadline - performance.now()), "Native custody fixture closure");
      expect(outcome).toEqual({ code: 1, signal: null });
      expect(outputBytes).toBeLessThanOrEqual(1024 * 1024);
      requireAbsent(pid); requireAbsent(-identity.group);
      const terminal = await json(join(evidence, "fixture-terminal.json"));
      expect(terminal.schemaVersion).toBe(1); expect(terminal.kind).toBe("oompa-browser-custody-fixture");
      expect(terminal.scenario).toBe(scenario); expect(terminal.pid).toBe(pid); expect(terminal.node).toEqual(node);
      expect(terminal.triggered).toBe(true); expect(terminal.expired).toBe(false); expect(terminal.rejected).toBe(true);
      expect(terminal.expiryFailure).toBe(false);
      assert.ok(typeof terminal.run === "string");
      const run = terminal.run;
      const request = parseBrowserRequest(await json(join(run, "request.json")));
      expect(request.root).toBe(root); expect(request.run).toBe(run);
      expect(request.node).toEqual(node); expect(request.bun).toEqual(bun); expect(request.chromium).toEqual(chromium);
      expect(request.sources).toEqual(sources); expect(request.app).toEqual(app); expect(request.site).toEqual(site);
      await verifyBrowserRequest(request);
      expect(await browserFile(root, fixtureSource.path)).toEqual(fixtureSource);
      const trigger = await json(join(evidence, "trigger.json"));
      expect(trigger.pid).toBe(pid); expect(trigger.scenario).toBe(scenario);
      expect(trigger.action).toBe(scenario === "partial-setup-failure" ? "throw" : "self-SIGTERM");
      const preparation = await json(join(run, "preparation-result.json"));
      expect(preparation.collected).toBe(true);
      const preparationIdentity = record(preparation.identity);
      const preparationPid = positivePid(preparationIdentity.pid);
      expect(preparationIdentity.parent).toBe(pid); expect(preparationIdentity.group).toBe(preparationPid);
      requireAbsent(preparationPid); requireAbsent(-preparationPid);
      const receipt = await json(join(run, "receipt.json"));
      expect(receipt.state).toBe("failed"); expect(receipt.schemaVersion).toBe(2);
      const runner = record(receipt.runner);
      expect(runner.inputsUnchanged).toBe(true);
      expect(runner.cancelled).toBe(scenario !== "partial-setup-failure");
      if (scenario === "preparation-cancellation") {
        expect(trigger.kind).toBe("preparation-owned");
        expect(terminal.observations).toEqual(["preparation-owned"]);
        expect(existsSync(join(run, "driver-receipt.json"))).toBe(false);
        // Failed admission and positive native collection are distinct facts;
        // require the exact cancellation cause rather than any failed build.
        assertPreparationCancellationProof(preparation, runner);
      } else {
        expect(runner.preparationCollected).toBe(true); expect(preparation.state).toBe("passed");
        const driver = await json(join(run, "driver-receipt.json"));
        expect(driver.state).toBe("failed");
        expect(record(driver.driverRuntime).name).toBe("node"); expect(record(driver.driverRuntime).version).toBe("24.18.1");
        expect(record(driver.buildRuntime).name).toBe("bun"); expect(record(driver.buildRuntime).version).toBe("1.3.14");
        const serverObservation = await json(join(evidence, scenario === "connected-cancellation" ? "observation-3.json" : "observation-2.json"));
        assert.ok(Array.isArray(serverObservation.origins));
        expect(serverObservation.origins).toHaveLength(scenario === "connected-cancellation" ? 3 : 2);
        for (const origin of serverObservation.origins) await requireListenerAbsent(origin);
        if (scenario === "partial-setup-failure") {
          expect(trigger.kind).toBe("partial-servers-owned");
          expect(terminal.observations).toEqual(["preparation-owned", "partial-servers-owned"]);
          expect(driver.profileDiagnostics).toEqual([]);
          expect(driver.evidence).toEqual([]);
          // Any server-close error aggregates with the sentinel and fails this
          // exact check; process exit alone cannot stand in for server.stop().
          expect(driver.failure).toEqual({ name: "BrowserCustodySetupFixtureError", message: "Native browser custody setup fixture" });
        } else {
          assertConnectedCancellationProof(driver);
          expect(trigger.kind).toBe("browser-census-owned");
          expect(terminal.observations).toEqual(["preparation-owned", "partial-servers-owned", "browser-census-owned"]);
          assert.ok(Array.isArray(serverObservation.pids) && serverObservation.pids.length > 0);
          assert.ok(Array.isArray(driver.profileDiagnostics) && driver.profileDiagnostics.length === 1);
          const profile = record(driver.profileDiagnostics[0]);
          assert.ok(Array.isArray(profile.ownedPids) && profile.ownedPids.length > 0);
          for (const browserPid of profile.ownedPids) requireAbsent(positivePid(browserPid));
          for (const browserPid of serverObservation.pids) expect(profile.ownedPids).toContain(positivePid(browserPid));
          assert.ok(Array.isArray(driver.evidence));
          const cleanup = driver.evidence.map((entry: unknown) => record(entry)).filter((entry) => entry.name === "desktop:browser-cleanup");
          expect(cleanup).toHaveLength(1);
          const values = record(cleanup[0]?.values);
          expect(values.survivors).toBe(0); expect(values.pages).toBe(0); expect(values.ownedProcesses).toBe(profile.ownedPids.length);
        }
      }
      proved = true;
    } catch (error) { failure = error; }
    finally {
      // Even an identity/publication/assertion failure joins the same direct
      // child and streams within the original outer bound. Unknown collection
      // is recorded, never converted into a hard exit or a second signal path.
      try {
        outcome ??= await browserRunnerDeadline(closed, Math.max(1, joinDeadline - performance.now()), "Native custody fixture failure closure");
        if (child.pid !== undefined) requireAbsent(positivePid(child.pid));
        if (identity !== undefined) requireAbsent(-identity.group);
      } catch (error) {
        proved = false;
        failure = failure === undefined ? error : new AggregateError([failure, error], "Native custody proof and helper closure failed; evidence retained");
      }
      try {
        await publishBrowserJson(join(evidence, "supervisor-result.json"), {
          scenario, proved, identity: identity ?? null, acquisitionPid: child.pid ?? null,
          outcome: outcome ?? null, stdout, stderr, outputBytes, failed: failure !== undefined,
        });
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], "Native custody failure and receipt publication failed");
      }
    }
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error("Native browser custody proof failed", { cause: failure });
    expect(proved).toBe(true);
  }, 390_000);
}
