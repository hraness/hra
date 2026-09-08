import { expect, test } from "bun:test";
import * as fc from "fast-check";
import {
  assertBrowserDispatchAllowed, assertPreparationOutcome, browserDriverReceiptIfDispatched, browserRunnerDeadline,
  browserRunnerFailureDetails, browserTerminalState, collectBrowserPreparation, parsePreparationCollectionDiagnostic,
  parsePreparationIdentity, preparationNativeFailure, PreparationCollectionError, PreparationCollectionTrace,
  signalBrowserPreparation, waitForBrowserPreparationAbsence,
} from "./app-browser-runner.ts";

test("preparation process identity binds parent, detached group and start time", () => {
  expect(parsePreparationIdentity(" 42 7 42 Tue Sep 8 01:02:03 2026\n", 42, 7)).toEqual({ pid: 42, parent: 7, group: 42, started: "Tue Sep 8 01:02:03 2026" });
  for (const text of ["42 8 42 Tue Sep 8 01:02:03 2026", "42 7 99 Tue Sep 8 01:02:03 2026", "99 7 99 Tue Sep 8 01:02:03 2026", "42 7 42 truncated"]) {
    expect(() => parsePreparationIdentity(text, 42, 7)).toThrow();
  }
});

test("driver admission refuses prior cancellation and uncollected preparation", () => {
  const cancellation = new AbortController();
  expect(() => assertBrowserDispatchAllowed(cancellation.signal, true)).not.toThrow();
  expect(() => assertBrowserDispatchAllowed(cancellation.signal, false)).toThrow();
  cancellation.abort();
  expect(() => assertBrowserDispatchAllowed(cancellation.signal, true)).toThrow();
});

test("cancellation during final asynchronous cleanup remains fatal at terminal receipt commit", async () => {
  const cancellation = new AbortController();
  expect(browserTerminalState(cancellation.signal, true, undefined)).toBe("passed");
  await Promise.resolve(); cancellation.abort();
  expect(browserTerminalState(cancellation.signal, true, undefined)).toBe("failed");
  expect(browserTerminalState(new AbortController().signal, false, undefined)).toBe("failed");
  expect(browserTerminalState(new AbortController().signal, true, new Error("cleanup failed"))).toBe("failed");
});

test("cancellation wins a pending preparation wait without abandoning its settlement", async () => {
  const cancellation = new AbortController(); let finish: () => void = () => { throw new Error("Missing resolver"); };
  const pending = new Promise<void>((done) => { finish = done; });
  const result = browserRunnerDeadline(pending, 1000, "fixture preparation", cancellation.signal);
  cancellation.abort();
  await expect(result).rejects.toThrow("cancelled");
  finish(); await pending;
});

test("ordered preparation collection requires group absence and stream closure", async () => {
  const events: string[] = []; let present = true;
  await collectBrowserPreparation({
    present: () => present, leaderRunning: () => true,
    signal: async (signal) => { events.push(signal); },
    waitAbsent: async (milliseconds) => { events.push(`wait:${milliseconds}`); if (milliseconds === 5000) present = false; },
    closed: async () => { events.push("closed"); return { code: null, signal: "SIGKILL" }; },
  });
  expect(events).toEqual(["SIGTERM", "wait:2000", "SIGKILL", "wait:5000", "closed"]);
});

test("unknown probe, changed identity, leaderless group and failed stream closure cannot report collection", async () => {
  const controls = {
    present: () => true, leaderRunning: () => true, signal: () => Promise.resolve(),
    waitAbsent: () => Promise.resolve(), closed: async () => ({ code: 0, signal: null }),
  };
  await expect(collectBrowserPreparation({ ...controls, present: () => { throw new Error("probe unavailable"); } })).rejects.toThrow("initial-probe");
  await expect(collectBrowserPreparation({ ...controls, signal: async () => { throw new Error("identity changed"); } })).rejects.toThrow("term-leader-check");
  let signalled = false;
  await expect(collectBrowserPreparation({ ...controls, leaderRunning: () => false, signal: async () => { signalled = true; } })).rejects.toThrow("kill-leader-check");
  expect(signalled).toBe(false);
  await expect(collectBrowserPreparation({ ...controls, present: () => false, closed: async () => { throw new Error("streams remained"); } })).rejects.toThrow("stream-join");
});

const owned = { pid: 42, parent: 7, group: 42, started: "Tue Sep 8 01:02:03 2026" };
function traceFixture() {
  let elapsed = 0;
  const child = { identity: owned, childExitCode: null as number | null, childSignal: null as string | null, closeSeen: false };
  const trace = new PreparationCollectionTrace(() => child, () => elapsed);
  return { trace, child, elapsed: (value: number) => { elapsed = value; } };
}

test("collection diagnostics retain bounded exact ownership and direct-child snapshots", () => {
  const fixture = traceFixture();
  fixture.trace.mark("post-term-probe", 4);
  fixture.trace.termAttempted = true; fixture.trace.termSent = true;
  fixture.child.childSignal = "SIGTERM"; fixture.child.closeSeen = true;
  fixture.elapsed(23);
  const cause = Object.assign(new Error("private fixture payload"), { code: "EPERM", syscall: "kill", errno: -1 });
  const snapshot = fixture.trace.snapshot(cause);
  expect(snapshot).toEqual({ stage: "post-term-probe", attempt: 4, attemptCapped: false, elapsedMs: 23, elapsedCapped: false,
    pid: 42, group: 42, termAttempted: true, termSent: true, killAttempted: false, killSent: false,
    childExitCode: null, childSignal: "SIGTERM", closeSeen: true, code: "EPERM", syscall: "kill", errno: -1 });
  expect(Object.isFrozen(snapshot)).toBe(true);
  fixture.trace.mark("final-probe", 1_000_000); fixture.elapsed(1_000_000);
  expect(fixture.trace.snapshot()).toMatchObject({ attempt: 10_000, attemptCapped: true, elapsedMs: 30_000, elapsedCapped: true });
  expect(snapshot.stage).toBe("post-term-probe"); expect(snapshot.elapsedMs).toBe(23);
});

test("collection diagnostic parsing rejects foreign stages, fields, PID mismatches and impossible signal success", () => {
  const valid = traceFixture().trace.snapshot();
  for (const value of [null, [], { ...valid, stage: "unreviewed-operation" }, { ...valid, secret: "extra" },
    { ...valid, pid: 1 }, { ...valid, group: 43 }, { ...valid, attempt: 10_001 }, { ...valid, elapsedMs: Number.NaN },
    { ...valid, elapsedMs: 30_001 }, { ...valid, errno: 65536 }, { ...valid, code: "private-code" },
    { ...valid, syscall: "kill /private/fixture" }, { ...valid, childSignal: "private-signal" },
    { ...valid, termSent: true }, { ...valid, killSent: true }, { ...valid, closeSeen: "true" }]) {
    expect(() => parsePreparationCollectionDiagnostic(value)).toThrow();
  }
  fc.assert(fc.property(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 30_000 }), (attempt, elapsedMs) => {
    const sample = { ...valid, attempt, elapsedMs };
    const roundtrip: unknown = JSON.parse(JSON.stringify(parsePreparationCollectionDiagnostic(sample)));
    expect(parsePreparationCollectionDiagnostic(roundtrip)).toEqual(sample);
  }), { numRuns: 60 });
});

test("native diagnostic extraction admits only finite fields without invoking foreign getters or leaking arguments", () => {
  const cause = Object.assign(new Error("private fixture path"), { code: "EPERM", syscall: "kill", errno: -1 });
  expect(preparationNativeFailure(new Error("identity unavailable", { cause }))).toEqual({ code: "EPERM", syscall: "kill", errno: -1 });
  expect(preparationNativeFailure({ code: "ENOENT", syscall: "spawn /bin/ps", errno: -2 })).toEqual({ code: "ENOENT", syscall: "spawn-ps", errno: -2 });
  expect(preparationNativeFailure({ code: "TOKEN_VALUE", syscall: "spawn /private/fixture", errno: "private" }))
    .toEqual({ code: "unknown", syscall: "unknown", errno: null });
  const foreign = Object.defineProperty({}, "code", { get: () => { throw new Error("Getter must not execute"); } });
  expect(preparationNativeFailure(foreign)).toEqual({ code: "none", syscall: "none", errno: null });
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  expect(preparationNativeFailure(cycle)).toEqual({ code: "none", syscall: "none", errno: null });
});

test("TERM and KILL identity-read, identity-validation and syscall failures retain their precise stage", async () => {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const boundary of ["identity-read", "identity-validate", "syscall"] as const) {
      const fixture = traceFixture(); let sends = 0;
      const original = Object.assign(new Error("private native payload"), { code: "EPERM", syscall: "kill", errno: -1 });
      let caught: unknown;
      try {
        await signalBrowserPreparation(signal, owned, {
          identity: () => boundary === "identity-read" ? Promise.reject(original) : Promise.resolve(boundary === "identity-validate" ? { ...owned, started: "changed start identity" } : owned),
          send: () => { sends += 1; throw original; },
        }, fixture.trace);
      } catch (error) { caught = error; }
      const snapshot = fixture.trace.snapshot(caught);
      expect(snapshot.stage).toBe(`${signal === "SIGTERM" ? "term" : "kill"}-${boundary}`);
      expect(sends).toBe(boundary === "syscall" ? 1 : 0);
      expect(signal === "SIGTERM" ? snapshot.termAttempted : snapshot.killAttempted).toBe(boundary === "syscall");
      expect(snapshot.termSent).toBe(false); expect(snapshot.killSent).toBe(false);
      if (boundary !== "identity-validate") expect(caught).toBe(original);
    }
  }
});

test("post-TERM EPERM stays fatal after successful TERM and never falls through to KILL or stream success", async () => {
  const fixture = traceFixture(); const sent: string[] = [];
  const original = Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill", errno: -1 });
  let streamJoined = false, caught: unknown;
  try {
    await collectBrowserPreparation({
      present: () => true, leaderRunning: () => true,
      signal: (signal) => signalBrowserPreparation(signal, owned, { identity: () => Promise.resolve(owned), send: () => { sent.push(signal); } }, fixture.trace),
      waitAbsent: (milliseconds, phase) => waitForBrowserPreparationAbsence(milliseconds, phase, {
        present: () => { throw original; }, now: () => 0, wait: () => Promise.resolve(),
      }, fixture.trace),
      closed: () => { streamJoined = true; return Promise.resolve({ code: 0, signal: null }); },
    }, fixture.trace);
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(PreparationCollectionError);
  if (!(caught instanceof PreparationCollectionError)) throw new Error("Missing typed collection failure");
  expect(caught.cause).toBe(original);
  expect(caught.collection).toMatchObject({ stage: "post-term-probe", code: "EPERM", syscall: "kill", errno: -1, termAttempted: true, termSent: true, killAttempted: false, killSent: false });
  expect(sent).toEqual(["SIGTERM"]); expect(streamJoined).toBe(false);
});

test("absence waits retain probe/wait attempt identity without changing the existing ordered bounds", async () => {
  for (const phase of ["term", "kill"] as const) {
    const fixture = traceFixture(); let now = 0, waits = 0;
    await waitForBrowserPreparationAbsence(50, phase, {
      present: () => true, now: () => now,
      wait: () => { waits += 1; now += 25; return Promise.resolve(); },
    }, fixture.trace);
    expect(waits).toBe(2); expect(fixture.trace.snapshot()).toMatchObject({ stage: `post-${phase}-probe`, attempt: 2 });
    const original = new Error("wait failed");
    await expect(waitForBrowserPreparationAbsence(50, phase, {
      present: () => true, now: () => 0, wait: () => Promise.reject(original),
    }, fixture.trace)).rejects.toBe(original);
    expect(fixture.trace.snapshot().stage).toBe(`post-${phase}-wait`);
  }
});

test("typed collection errors preserve native cause but serialize only the closed diagnostic", () => {
  const fixture = traceFixture(); fixture.trace.mark("initial-probe");
  const original = Object.assign(new Error("private fixture payload"), { code: "EPERM", syscall: "kill", errno: -1, stack: "private stack", args: ["private arguments"] });
  const collection = new PreparationCollectionError(fixture.trace.snapshot(original), original);
  expect(collection.cause).toBe(original);
  collection.message = "private mutated message"; collection.name = "private mutated name";
  const aggregate = new AggregateError([new Error("Browser preparation cancelled"), collection], "Preparation and collection failed");
  const serialized = JSON.stringify(browserRunnerFailureDetails(aggregate));
  expect(serialized).toContain('"stage":"initial-probe"'); expect(serialized).toContain('"code":"EPERM"');
  expect(serialized).toContain("Browser preparation cancelled");
  expect(serialized).not.toContain("private"); expect(serialized).not.toContain('"stack"'); expect(serialized).not.toContain('"args"');
});

test("preparation aggregates take precedence over the later cancellation assertion", () => {
  const cancellation = new AbortController(); cancellation.abort();
  const aggregate = new AggregateError([new Error("Browser preparation cancelled"), new Error("collection failed")], "Preparation and collection failed");
  let caught: unknown;
  try { assertPreparationOutcome(cancellation.signal, aggregate); } catch (error) { caught = error; }
  expect(caught).toBe(aggregate);
  expect(() => assertPreparationOutcome(cancellation.signal, undefined)).toThrow("cancelled");
  expect(() => assertPreparationOutcome(new AbortController().signal, undefined)).not.toThrow();
});

test("never-dispatched drivers require absence while dispatched missing receipts remain fatal", async () => {
  const events: string[] = [];
  const missing = Object.assign(new Error("required receipt absent"), { code: "ENOENT" });
  expect(await browserDriverReceiptIfDispatched(false, {
    read: () => { events.push("read"); return Promise.reject(missing); },
    assertAbsent: () => { events.push("absent"); return Promise.resolve(); },
  })).toBeUndefined();
  expect(events).toEqual(["absent"]);
  await expect(browserDriverReceiptIfDispatched(true, {
    read: () => Promise.reject(missing), assertAbsent: () => Promise.resolve(),
  })).rejects.toBe(missing);
  const unexpected = new Error("unexpected pre-dispatch receipt");
  await expect(browserDriverReceiptIfDispatched(false, {
    read: () => Promise.resolve({ state: "passed" }), assertAbsent: () => Promise.reject(unexpected),
  })).rejects.toBe(unexpected);
});
