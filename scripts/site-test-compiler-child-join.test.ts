import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fc from "fast-check";

import { createSiteTestCompilerChildJoin } from "./site-test-compiler-child-join";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  references = 0;
  refCalls = 0;
  onRef?: () => void;

  asChild(): ChildProcess { return this as unknown as ChildProcess; }

  ref(): void {
    this.refCalls++;
    this.references++;
    this.onRef?.();
  }

  unref(): void { this.references = 0; }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const task = new Promise<void>((resolveTask, rejectTask) => { resolve = resolveTask; reject = rejectTask; });
  return { task, resolve, reject };
}

function fixture(overrides: Partial<Parameters<typeof createSiteTestCompilerChildJoin>[0]> = {}) {
  const notifications: unknown[] = [];
  const calls: string[] = [];
  let leaseLive = false;
  const owner = createSiteTestCompilerChildJoin({
    stop: () => { calls.push("stop"); return Promise.resolve(); },
    keepAlive: () => {
      calls.push("lease"); leaseLive = true;
      return () => { calls.push("release"); leaseLive = false; };
    },
    onFailure: (error) => { notifications.push(error); },
    ...overrides,
  });
  return { owner, notifications, calls, get leaseLive() { return leaseLive; } };
}

async function failureOf(task: Promise<void>): Promise<AggregateError> {
  const error: unknown = await task.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error("Expected the retained join failure");
  return error;
}

function throwUnknown(cause: unknown): never { throw cause; }

function expectCause(failure: unknown, cause: unknown): void {
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Expected a tagged failure");
  expect(failure.cause).toBe(cause);
}

test("zero-child close calls stop once and shares its exact promise through completion", async () => {
  const { owner, calls } = fixture();
  const first = owner.close();
  expect(owner.close()).toBe(first);
  expect(() => owner.assertOpen()).toThrow("SITE_COMPILER_CHILD_JOIN_NOT_OPEN");
  await first;
  expect(owner.close()).toBe(first);
  expect(calls).toEqual(["lease", "stop", "release"]);
});

test("close retains a dedicated lease until both stop and every child close settle", async () => {
  const stop = deferred();
  const owned = fixture({ stop: () => stop.task });
  const first = new FakeChild(), second = new FakeChild();
  owned.owner.own(first.asChild()); owned.owner.own(second.asChild());
  const closing = owned.owner.close();
  let settled = false;
  void closing.then(() => { settled = true; });
  await Promise.resolve();
  expect(first.refCalls).toBe(1); expect(second.refCalls).toBe(1);
  first.unref(); second.unref();
  expect(first.references).toBe(0); expect(second.references).toBe(0);
  expect(owned.leaseLive).toBeTrue();
  first.emit("exit", 0, null);
  first.emit("close", 0, null);
  second.emit("exit", null, "SIGTERM");
  stop.resolve();
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBeFalse(); expect(owned.leaseLive).toBeTrue();
  second.emit("close", null, "SIGTERM");
  await closing;
  expect(owned.leaseLive).toBeFalse();
  expect(owned.calls).toEqual(["lease", "release"]);
});

test("an acquisition-time close before shutdown is retained without ref or exit-code requirements", async () => {
  const { owner, notifications } = fixture();
  const child = new FakeChild();
  owner.own(child.asChild());
  child.emit("close", 7, null);
  await owner.close();
  expect(child.refCalls).toBe(0);
  expect(notifications).toEqual([]);
});

test("spawn error without exit still requires close and preserves the exact raw error", async () => {
  const owned = fixture();
  const child = new FakeChild(), nativeError = new Error("synthetic spawn failure");
  owned.owner.own(child.asChild());
  child.emit("error", nativeError);
  const closing = owned.owner.close();
  let settled = false;
  void closing.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBeFalse(); expect(owned.leaseLive).toBeTrue();
  child.emit("close", -2, null);
  const failure = await failureOf(closing);
  expect(failure.errors).toEqual(owned.notifications);
  expect(failure.errors[0]).toMatchObject({ message: "SITE_COMPILER_CHILD_ERROR", cause: nativeError });
  expectCause(failure.errors[0], nativeError);
  expect(owned.leaseLive).toBeFalse();
});

test("closing refuses acquisitions synchronously and preserves its pending child", async () => {
  const owned = fixture();
  const child = new FakeChild(); owned.owner.own(child.asChild());
  const closing = owned.owner.close();
  expect(() => owned.owner.assertOpen()).toThrow("SITE_COMPILER_CHILD_JOIN_NOT_OPEN");
  expect(() => owned.owner.own(new FakeChild().asChild())).toThrow("SITE_COMPILER_CHILD_JOIN_NOT_OPEN");
  child.emit("close", null, "SIGTERM");
  await closing;
  expect(() => owned.owner.own(new FakeChild().asChild())).toThrow("SITE_COMPILER_CHILD_JOIN_NOT_OPEN");
});

test("the sixteen-acquisition limit remains fixed after earlier children close", async () => {
  const { owner } = fixture();
  const children = Array.from({ length: 16 }, () => new FakeChild());
  for (const child of children) { owner.assertOpen(); owner.own(child.asChild()); child.emit("close", 0, null); }
  expect(() => owner.assertOpen()).toThrow("SITE_COMPILER_CHILD_ACQUISITION_LIMIT");
  expect(() => owner.own(new FakeChild().asChild())).toThrow("SITE_COMPILER_CHILD_ACQUISITION_LIMIT");
  await owner.close();
  expect(children.every((child) => child.refCalls === 0)).toBeTrue();
});

test("duplicate ownership refuses without adding a second close obligation", async () => {
  const { owner } = fixture(); const child = new FakeChild();
  owner.own(child.asChild());
  expect(() => owner.own(child.asChild())).toThrow("SITE_COMPILER_CHILD_ALREADY_OWNED");
  child.emit("close", 0, null);
  await owner.close();
});

test.each(["throw", "reject"] as const)("stop %s of undefined still joins the child and aggregates its error", async (mode) => {
  const owned = fixture({ stop: mode === "throw" ? () => throwUnknown(undefined) : () => Promise.reject(undefined) });
  const child = new FakeChild(), nativeError = new Error("synthetic child error");
  owned.owner.own(child.asChild());
  const closing = owned.owner.close();
  await Promise.resolve(); await Promise.resolve();
  expect(owned.leaseLive).toBeTrue();
  child.emit("error", nativeError);
  child.emit("close", null, "SIGKILL");
  const failure = await failureOf(closing);
  expect(failure.errors).toEqual([
    expect.objectContaining({ message: "SITE_COMPILER_CHILD_STOP_FAILED", cause: undefined }),
    expect.objectContaining({ message: "SITE_COMPILER_CHILD_ERROR", cause: nativeError }),
  ]);
  expectCause(failure.errors[0], undefined);
  expectCause(failure.errors[1], nativeError);
  expect(owned.leaseLive).toBeFalse();
});

test("late error after child close but before stop settlement remains part of the join", async () => {
  const stop = deferred(); const owned = fixture({ stop: () => stop.task });
  const child = new FakeChild(); owned.owner.own(child.asChild());
  const closing = owned.owner.close();
  child.emit("close", 0, null);
  const nativeError = { private: "late child error" };
  child.emit("error", nativeError);
  stop.resolve();
  const failure = await failureOf(closing);
  expect(failure.errors[0]).toMatchObject({ message: "SITE_COMPILER_CHILD_ERROR", cause: nativeError });
  expectCause(failure.errors[0], nativeError);
  expect(owned.notifications).toEqual(failure.errors);
});

test.each(["child", "stdin", "stdout"] as const)("first %s error after a completed barrier still notifies the failure-only driver hook", async (source) => {
  const owned = fixture(); const child = new FakeChild(); owned.owner.own(child.asChild());
  child.emit("close", 0, null);
  const closing = owned.owner.close(); await closing;
  const nativeError = new Error("late error after close");
  const target: EventEmitter = source === "child" ? child : child[source];
  expect(() => target.emit("error", nativeError)).not.toThrow();
  expect(owned.notifications).toHaveLength(1);
  expectCause(owned.notifications[0], nativeError);
  expect(owned.owner.close()).toBe(closing);
});

test.each(["child", "stdin", "stdout"] as const)("%s error bursts retain only the first exact cause", async (source) => {
  const owned = fixture(); const child = new FakeChild(); owned.owner.own(child.asChild());
  const target: EventEmitter = source === "child" ? child : child[source];
  const firstError = { private: "first failure" };
  target.emit("error", firstError);
  for (let index = 0; index < 32; index++) target.emit("error", new Error("subsequent failure"));
  child.emit("close", 0, null);
  const failure = await failureOf(owned.owner.close());
  expect(owned.notifications).toHaveLength(1);
  expect(failure.errors).toHaveLength(1);
  expectCause(failure.errors[0], firstError);
});

test("creation snapshots dependency functions instead of retaining a mutable options alias", async () => {
  const calls: string[] = [];
  const dependencies = {
    stop: () => { calls.push("stop"); return Promise.resolve(); },
    keepAlive: () => { calls.push("lease"); return () => { calls.push("release"); }; },
    onFailure: () => { calls.push("failure"); },
  };
  const owner = createSiteTestCompilerChildJoin(dependencies);
  dependencies.stop = () => { throw new Error("mutated stop"); };
  dependencies.keepAlive = () => { throw new Error("mutated lease"); };
  dependencies.onFailure = () => { throw new Error("mutated reporter"); };
  const child = new FakeChild(); owner.own(child.asChild());
  const nativeError = new Error("original child failure");
  child.emit("error", nativeError); child.emit("close", 0, null);
  const failure = await failureOf(owner.close());
  expect(failure.errors).toHaveLength(1);
  expectCause(failure.errors[0], nativeError);
  expect(calls).toEqual(["failure", "lease", "stop", "release"]);
});

test.each(["ref", "lease", "release"] as const)("%s failure is retained without skipping stop or child close", async (stage) => {
  const nativeError = new Error("synthetic lease or ref failure");
  let stopCalls = 0, releaseCalls = 0;
  const owned = fixture({
    stop: () => { stopCalls++; return Promise.resolve(); },
    keepAlive: () => {
      if (stage === "lease") throw nativeError;
      return () => { releaseCalls++; if (stage === "release") throw nativeError; };
    },
  });
  const child = new FakeChild();
  if (stage === "ref") child.onRef = () => { throw nativeError; };
  owned.owner.own(child.asChild());
  const closing = owned.owner.close();
  await Promise.resolve();
  expect(stopCalls).toBe(1); expect(releaseCalls).toBe(0);
  child.emit("close", null, "SIGTERM");
  const failure = await failureOf(closing);
  expect(failure.errors[0]).toMatchObject({ cause: nativeError });
  expectCause(failure.errors[0], nativeError);
  expect(releaseCalls).toBe(stage === "lease" ? 0 : 1);
  expect(owned.owner.close()).toBe(closing);
});

test("reentrant close dependencies see the reserved task and reporter failure cannot bypass joining", async () => {
  const reportError = new Error("synthetic reporter failure");
  let duringStop: Promise<void> | undefined;
  const owned = fixture({
    stop: () => { duringStop = owned.owner.close(); return Promise.resolve(); },
    onFailure: () => { throw reportError; },
  });
  const child = new FakeChild(); owned.owner.own(child.asChild());
  const closing = owned.owner.close();
  child.emit("error", undefined); child.emit("close", 0, null);
  const failure = await failureOf(closing);
  expect(duringStop === closing).toBeTrue();
  expect(failure.errors).toEqual([
    expect.objectContaining({ message: "SITE_COMPILER_CHILD_ERROR", cause: undefined }),
    expect.objectContaining({ message: "SITE_COMPILER_CHILD_FAILURE_REPORT_FAILED", cause: reportError }),
  ]);
  expectCause(failure.errors[0], undefined);
  expectCause(failure.errors[1], reportError);
});

test("seeded close orders preserve the stop-and-close barrier and shared task", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ early: fc.boolean(), order: fc.integer({ min: 0, max: 8 }) }), { maxLength: 8 }),
    fc.integer({ min: 0, max: 8 }),
    async (schedule, stopPosition) => {
      const stop = deferred();
      const owned = fixture({ stop: () => stop.task });
      const children = schedule.map(() => new FakeChild());
      for (const child of children) owned.owner.own(child.asChild());
      for (let index = 0; index < children.length; index++) {
        if (schedule[index]?.early) children[index]?.emit("close", 0, null);
      }
      const remaining = schedule.map((entry, index) => ({ ...entry, index }))
        .filter((entry) => !entry.early).sort((left, right) => left.order - right.order || left.index - right.index);
      const stopAt = stopPosition % (remaining.length + 1);
      const closing = owned.owner.close();
      let settled = false;
      void closing.then(() => { settled = true; }, () => { settled = true; });
      try {
        expect(owned.owner.close()).toBe(closing);
        expect(() => owned.owner.assertOpen()).toThrow("SITE_COMPILER_CHILD_JOIN_NOT_OPEN");
        await Promise.resolve();
        for (let step = 0; step <= remaining.length; step++) {
          if (step === stopAt) stop.resolve();
          await Promise.resolve(); await Promise.resolve();
          if (step < stopAt || step < remaining.length) {
            expect(settled).toBeFalse();
            expect(owned.leaseLive).toBeTrue();
          }
          const entry = remaining[step];
          if (entry !== undefined) children[entry.index]?.emit("close", null, "SIGTERM");
        }
        await closing;
        expect(owned.leaseLive).toBeFalse();
        expect(owned.calls).toEqual(["lease", "release"]);
        expect(owned.owner.close()).toBe(closing);
        for (let index = 0; index < children.length; index++) {
          expect(children[index]?.refCalls).toBe(schedule[index]?.early ? 0 : 1);
        }
      } finally {
        stop.resolve();
        for (const child of children) child.emit("close", 0, null);
        await closing;
      }
    },
  ), { seed: 20260909, numRuns: 32 });
});
