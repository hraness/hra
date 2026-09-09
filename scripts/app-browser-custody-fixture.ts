import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserCustodyObservation, BrowserCustodyObserver } from "./app-browser.ts";
import { assertBrowserNode, browserExecutable, publishBrowserTerminalJson } from "./app-browser-handoff.ts";
import { runBrowserBootstrap } from "./app-browser-runner.ts";

// A separate genuine Node process drives the unchanged bootstrap and browser
// program. These fixture-only variables are never read by production entries.
assertBrowserNode(process.versions);
assert.equal(process.argv.length, 2);
const scenario = process.env.HRA_BROWSER_CUSTODY_CASE;
assert.ok(scenario === "preparation-cancellation" || scenario === "connected-cancellation" || scenario === "partial-setup-failure");
const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const evidencePath = process.env.HRA_BROWSER_CUSTODY_EVIDENCE;
assert.ok(evidencePath !== undefined);
const evidence = await realpath(evidencePath);
assert.equal(evidence, evidencePath);
assert.equal(dirname(evidence), join(root, "tmp"));
assert.match(evidence.slice(dirname(evidence).length + 1), /^browser-custody-[A-Za-z0-9]+$/u);
const metadata = await lstat(evidence);
assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
assert.equal(metadata.mode & 0o077, 0);
const node = await browserExecutable(process.execPath);
const observations: BrowserCustodyObservation[] = [];
let run: string | undefined;
let triggered = false;
let expired = false;
let expiryFailure = false;
let rejected = false;
let failureName: string | undefined;

const selfSignal = (): void => {
  assert.ok(process.pid > 1 && process.listenerCount("SIGTERM") > 0, "Bootstrap cancellation listener is not installed");
  // This exact process signals itself. Neither the fixture nor the parent test
  // guesses browser PIDs, signals a remembered group, or owns a second closer.
  process.kill(process.pid, "SIGTERM");
};
const observe: BrowserCustodyObserver = (observation) => {
  assert.ok(observations.length < 3, "Unexpected extra native custody observation");
  if (run === undefined) run = observation.run;
  assert.equal(observation.run, run);
  assert.equal(dirname(run), join(root, "tmp"));
  assert.match(run.slice(dirname(run).length + 1), /^app-browser-[A-Za-z0-9]+$/u);
  if (observation.kind === "preparation-owned") {
    assert.equal(observation.identity.parent, process.pid);
    assert.equal(observation.identity.pid, observation.identity.group);
    assert.ok(Number.isSafeInteger(observation.identity.pid) && observation.identity.pid > 1);
    // Require actual live acquisition before classifying this as cancellation
    // of preparation. A child which already exited makes this arm fail.
    assert.equal(process.kill(-observation.identity.group, 0), true);
  }
  observations.push(observation);
  publishBrowserTerminalJson(join(evidence, `observation-${observations.length}.json`), observation);
  const target = scenario === "preparation-cancellation" ? "preparation-owned"
    : scenario === "connected-cancellation" ? "browser-census-owned" : "partial-servers-owned";
  if (observation.kind !== target) return undefined;
  assert.equal(triggered, false);
  if (observation.kind === "browser-census-owned") assert.ok(observation.pids.length > 0);
  if (observation.kind === "partial-servers-owned") assert.equal(observation.origins.length, 2);
  triggered = true;
  publishBrowserTerminalJson(join(evidence, "trigger.json"), {
    scenario, kind: target, pid: process.pid, action: scenario === "partial-setup-failure" ? "throw" : "self-SIGTERM",
  });
  if (scenario === "partial-setup-failure") {
    throw Object.assign(new Error("Native browser custody setup fixture"), { name: "BrowserCustodySetupFixtureError" });
  }
  selfSignal();
  return undefined;
};

// A missed phase gets one bounded cooperative expiry request. It is never a
// hard exit that would abandon acquired children; unknown cleanup is retained.
const expiry = setTimeout(() => {
  expired = true;
  // A diagnostic write failure in a timer must not become an uncaught hard
  // exit while the bootstrap still owns native resources.
  try { publishBrowserTerminalJson(join(evidence, "expiry.json"), { scenario, expired: true, pid: process.pid }); }
  catch { expiryFailure = true; }
  try { if (process.listenerCount("SIGTERM") > 0) selfSignal(); }
  catch { expiryFailure = true; }
}, 240_000);
try { await runBrowserBootstrap(observe); }
catch (error) {
  rejected = true;
  failureName = error instanceof Error ? error.name.slice(0, 80) : "UnknownFailure";
} finally {
  clearTimeout(expiry);
  publishBrowserTerminalJson(join(evidence, "fixture-terminal.json"), {
    schemaVersion: 1, kind: "hra-browser-custody-fixture", scenario, node, pid: process.pid,
    run: run ?? null, triggered, expired, expiryFailure, rejected, failureName: failureName ?? null,
    observations: observations.map(({ kind }) => kind),
  });
}
// All three arms intentionally fail acceptance. The parent separately proves
// the expected cause and real native collection; this never reports acceptance.
process.exitCode = 1;
