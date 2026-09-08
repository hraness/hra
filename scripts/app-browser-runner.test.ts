import { expect, test } from "bun:test";
import { assertBrowserDispatchAllowed, browserRunnerDeadline, browserTerminalState, collectBrowserPreparation, parsePreparationIdentity } from "./app-browser-runner.ts";

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
  await expect(collectBrowserPreparation({ ...controls, present: () => { throw new Error("probe unavailable"); } })).rejects.toThrow("probe unavailable");
  await expect(collectBrowserPreparation({ ...controls, signal: async () => { throw new Error("identity changed"); } })).rejects.toThrow("identity changed");
  let signalled = false;
  await expect(collectBrowserPreparation({ ...controls, leaderRunning: () => false, signal: async () => { signalled = true; } })).rejects.toThrow("leader exited");
  expect(signalled).toBe(false);
  await expect(collectBrowserPreparation({ ...controls, present: () => false, closed: async () => { throw new Error("streams remained"); } })).rejects.toThrow("streams remained");
});
