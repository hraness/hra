import { expect, test } from "bun:test";
import { ChildProcess, type spawn } from "node:child_process";
import { installSiteTestCompilerSpawnScope } from "./site-test-compiler-spawn-scope";

test("forwards the actual receiver and arguments once and owns the same native handle", async () => {
  const child = new ChildProcess();
  const events: string[] = [];
  const argv = ["--service=0.27.0", "--ping"];
  const options = { stdio: "pipe" as const };
  let received: unknown[] = [];
  const original = function (this: unknown, ...args: unknown[]) {
    events.push("spawn"); expect(this).toBe(owner); received = args; return child;
  } as typeof spawn;
  const owner = { spawn: original };
  const scope = installSiteTestCompilerSpawnScope(owner, {
    assertOpen: () => { events.push("admit-state"); },
    own: (value) => { expect(value).toBe(child); events.push("own"); },
    close: async () => { events.push("close"); },
  }, () => { events.push("admit-command"); }, () => { throw new Error("Unexpected failure"); });
  expect(owner.spawn("compiler", argv, options) === child).toBe(true);
  expect(received).toEqual(["compiler", argv, options]);
  expect(received[1]).toBe(argv); expect(received[2]).toBe(options);
  expect(events).toEqual(["admit-state", "admit-command", "spawn", "own"]);
  const first = scope.close();
  expect(scope.close()).toBe(first);
  await first;
  expect(owner.spawn).toBe(original);
  expect(events.at(-1)).toBe("close");
});

test.each(["admission", "state", "spawn"])("reports %s refusal without acquiring a child", async (stage) => {
  const error = new Error("synthetic refusal");
  let spawned = 0;
  const failures: unknown[] = [];
  const original = (() => { spawned += 1; throw error; }) as typeof spawn;
  const owner = { spawn: original };
  const scope = installSiteTestCompilerSpawnScope(owner, {
    assertOpen: () => { if (stage === "state") throw error; },
    own: () => { throw new Error("Unexpected acquisition"); }, close: async () => {},
  }, () => { if (stage === "admission") throw error; }, (value) => { failures.push(value); });
  expect(() => owner.spawn("compiler")).toThrow(error);
  expect(spawned).toBe(stage === "spawn" ? 1 : 0);
  expect(failures).toEqual([error]);
  await scope.close();
  expect(owner.spawn).toBe(original);
});

test("refuses a reentrant spawn before a second native acquisition", async () => {
  const child = new ChildProcess();
  let spawned = 0;
  const failures: unknown[] = [];
  const owner = { spawn: (() => {
    spawned += 1;
    expect(() => owner.spawn("nested")).toThrow("SITE_COMPILER_SPAWN_REENTRANT");
    return child;
  }) as typeof spawn };
  const scope = installSiteTestCompilerSpawnScope(owner, {
    assertOpen: () => {}, own: () => {}, close: async () => {},
  }, () => {}, (error) => { failures.push(error); });
  expect(owner.spawn("compiler") === child).toBe(true);
  expect(spawned).toBe(1);
  expect(failures).toHaveLength(1);
  await scope.close();
});

test("does not restore a replaced export or erase a shutdown failure", async () => {
  const original = (() => new ChildProcess()) as typeof spawn;
  const replacement = (() => new ChildProcess()) as typeof spawn;
  const owner = { spawn: original };
  const closed = Promise.withResolvers<undefined>();
  const failure = new Error("synthetic close failure");
  const scope = installSiteTestCompilerSpawnScope(owner, {
    assertOpen: () => {}, own: () => {}, close: () => closed.promise,
  }, () => {}, () => {});
  const result = scope.close().catch((error: unknown) => error);
  owner.spawn = replacement;
  closed.reject(failure);
  const error = await result;
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error("Missing aggregate");
  expect(error.errors[0]).toBe(failure);
  expect(error.errors[1]).toHaveProperty("message", "SITE_COMPILER_SPAWN_SCOPE_REPLACED");
  expect(owner.spawn).toBe(replacement);
});
