import { describe, expect, test } from "bun:test";

import { WorkEventWaiterLimitError, WorkEventWaiters } from "./work-event-waiters";

describe("work event waiters", () => {
  test("registers before rechecking the durable sequence", async () => {
    const waiters = new WorkEventWaiters();
    let sequence = 1;
    const outcome = waiters.wait({
      workId: "work_00000000000000000000000000000000",
      expectedSequence: 1,
      waitMs: 1_000,
      signal: new AbortController().signal,
      readSequence: () => {
        sequence = 2;
        return sequence;
      },
    });
    await expect(outcome).resolves.toBe("changed");
    expect(waiters.size).toBe(0);
  });

  test("notifies only waiters for the changed work plan", async () => {
    const waiters = new WorkEventWaiters(2);
    const controller = new AbortController();
    const first = waiters.wait({
      workId: "work_00000000000000000000000000000000",
      expectedSequence: 1,
      waitMs: 1_000,
      signal: controller.signal,
      readSequence: () => 1,
    });
    const second = waiters.wait({
      workId: "work_11111111111111111111111111111111",
      expectedSequence: 1,
      waitMs: 1_000,
      signal: controller.signal,
      readSequence: () => 1,
    });
    await Promise.resolve();
    waiters.notify("work_00000000000000000000000000000000");
    await expect(first).resolves.toBe("changed");
    expect(waiters.size).toBe(1);
    controller.abort(new Error("done"));
    await expect(second).rejects.toThrow("done");
  });

  test("bounds concurrent waiters", async () => {
    const waiters = new WorkEventWaiters(1);
    const controller = new AbortController();
    const first = waiters.wait({
      workId: "work_00000000000000000000000000000000",
      expectedSequence: 1,
      waitMs: 1_000,
      signal: controller.signal,
      readSequence: () => 1,
    });
    await Promise.resolve();
    await expect(waiters.wait({
      workId: "work_11111111111111111111111111111111",
      expectedSequence: 1,
      waitMs: 1_000,
      signal: controller.signal,
      readSequence: () => 1,
    })).rejects.toBeInstanceOf(WorkEventWaiterLimitError);
    controller.abort(new Error("done"));
    await expect(first).rejects.toThrow("done");
  });
});
