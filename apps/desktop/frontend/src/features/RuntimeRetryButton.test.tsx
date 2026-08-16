import { expect, test } from "bun:test";

import { createRuntimeRetryCoordinator } from "./RuntimeRetryButton";

function deferred(): Readonly<{
  promise: Promise<void>;
  reject: (reason: unknown) => void;
  resolve: () => void;
}> {
  let reject!: (reason: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("runtime retry coalesces rapid requests and contains the retained failure", async () => {
  const attempt = deferred();
  const pending: boolean[] = [];
  let calls = 0;
  const coordinator = createRuntimeRetryCoordinator(() => {
    calls += 1;
    return attempt.promise;
  }, (value) => pending.push(value));

  const first = coordinator.retry();
  const second = coordinator.retry();
  expect(second).toBe(first);
  expect(calls).toBe(1);
  expect(coordinator.isPending()).toBe(true);
  expect(pending).toEqual([true]);

  attempt.reject(new Error("still unavailable"));
  await first;
  expect(coordinator.isPending()).toBe(false);
  expect(pending).toEqual([true, false]);
});

test("runtime retry never publishes a completion update after unmount", async () => {
  const attempt = deferred();
  const pending: boolean[] = [];
  const coordinator = createRuntimeRetryCoordinator(
    () => attempt.promise,
    (value) => pending.push(value),
  );

  const retry = coordinator.retry();
  coordinator.setMounted(false);
  attempt.resolve();
  await retry;

  expect(coordinator.isPending()).toBe(false);
  expect(pending).toEqual([true]);
});
