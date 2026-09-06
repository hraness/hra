import { expect, test } from "bun:test";
import fc from "fast-check";

import { CodexError } from "./errors.ts";
import { CodexConnectionEffects } from "./session-effects.ts";

function latch<A>(): { promise: Promise<A>; resolve: (value: A) => void } {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>(done => { resolve = done; });
  return { promise, resolve };
}

test("completion reserves synchronously and preserves native failure identity", async () => {
  const runtime = new CodexConnectionEffects();
  try {
    const success = runtime.completion<number>("requests");
    success.succeed(42);
    success.reject(new Error("late rejection must lose"));
    expect(await success.start()).toBe(42);

    const expected = new CodexError("AUTHORITY_STALE", "authority changed");
    const failed = runtime.completion<number>("requests");
    failed.reject(expected);
    await expect(failed.start()).rejects.toBe(expected);

    const defect = new TypeError("foreign parser defect");
    const broken = runtime.completion<number>("requests");
    broken.reject(defect);
    await expect(broken.start()).rejects.toBe(defect);
  } finally {
    await runtime.close();
  }
});

test("a failed fact is observed once and does not poison subsequent ordered work", async () => {
  const runtime = new CodexConnectionEffects();
  const firstEntered = latch<undefined>();
  const release = latch<undefined>();
  const order: string[] = [];
  const errors: unknown[] = [];
  const failure = new CodexError("AUTHORITY_STALE", "old authority");
  try {
    const first = runtime.fact(async () => {
      order.push("first");
      firstEntered.resolve(undefined);
      await release.promise;
      throw failure;
    }, error => { errors.push(error); });
    const observed = first.catch((error: unknown) => error);
    const second = runtime.fact(() => { order.push("second"); }, error => { errors.push(error); });
    await firstEntered.promise;
    expect(order).toEqual(["first"]);
    release.resolve(undefined);
    expect(await observed).toBe(failure);
    await second;
    expect(order).toEqual(["first", "second"]);
    expect(errors).toEqual([failure]);
    await runtime.drain("facts");
  } finally {
    release.resolve(undefined);
    await runtime.close();
  }
});

test("background work is counted before admission can accept another request", async () => {
  const runtime = new CodexConnectionEffects();
  const release = latch<undefined>();
  const failures: unknown[] = [];
  try {
    runtime.track("dynamic", () => release.promise, error => { failures.push(error); });
    expect(runtime.count("dynamic")).toBe(1);
    release.resolve(undefined);
    await runtime.drain("dynamic");
    expect(runtime.count("dynamic")).toBe(0);
    expect(failures).toEqual([]);
  } finally {
    release.resolve(undefined);
    await runtime.close();
  }
});

test("scope disposal attempts iterator release without awaiting an uncancelable foreign read", async () => {
  const runtime = new CodexConnectionEffects();
  const entered = latch<undefined>();
  const pending = latch<IteratorResult<number>>();
  const values: number[] = [];
  let returned = false;
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => { entered.resolve(undefined); return pending.promise; },
        return: () => { returned = true; return new Promise<IteratorResult<number>>(() => undefined); },
      };
    },
  };
  const reading = runtime.read(source, async value => { values.push(value); }, () => { throw new Error("unexpected cleanup failure"); });
  const observed = reading.catch((error: unknown) => error);
  await entered.promise;
  await runtime.close();
  await observed;
  expect(returned).toBe(true);
  pending.resolve({ done: false, value: 1 });
  await Promise.resolve(undefined);
  expect(values).toEqual([]);
});

test("fact arrival order survives arbitrary successful and failed deliveries", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 32 }), async failures => {
    const runtime = new CodexConnectionEffects();
    const delivered: number[] = [];
    const diagnosed: unknown[] = [];
    try {
      const tasks = failures.map((fail, index) => runtime.fact(async () => {
        delivered.push(index);
        await Promise.resolve();
        if (fail) throw new CodexError("AUTHORITY_STALE", "test generation retired");
      }, error => { diagnosed.push(error); }));
      const outcomes = await Promise.allSettled(tasks);
      expect(delivered).toEqual(failures.map((_fail, index) => index));
      expect(outcomes.map(outcome => outcome.status === "rejected")).toEqual(failures);
      expect(diagnosed).toHaveLength(failures.filter(Boolean).length);
      await runtime.drain("facts");
    } finally {
      await runtime.close();
    }
  }), { numRuns: 50 });
});

test("deadline activation follows the domain reservation even after expiration", async () => {
  const runtime = new CodexConnectionEffects();
  let reserved = false;
  let expired = 0;
  const failure = new CodexError("TIMEOUT", "already expired");
  try {
    const completion = runtime.completion<undefined>("requests", {
      deadlineMs: 0,
      onDeadline: () => {
        expect(reserved).toBe(true);
        expired += 1;
        completion.reject(failure);
      },
      onAbort: () => { throw new Error("no abort signal"); },
    });
    await Bun.sleep(1);
    expect(expired).toBe(0);
    reserved = true;
    const result = completion.start();
    expect(completion.start()).toBe(result);
    await expect(result).rejects.toBe(failure);
    expect(expired).toBe(1);
  } finally {
    await runtime.close();
  }
});
