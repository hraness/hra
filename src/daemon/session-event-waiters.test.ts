import { describe, expect, spyOn, test } from "bun:test";

import { createSessionId } from "../domain/values";
import { SessionEventWaiterLimitError, SessionEventWaiters } from "./session-event-waiters";

describe("SessionEventWaiters", () => {
  test("rechecks after registration so an append at the sleep boundary is not lost", async () => {
    const waiters = new SessionEventWaiters();
    const sessionId = createSessionId();
    let observed = 4;
    const result = await waiters.wait({
      sessionId,
      expectedObservedThrough: 3,
      waitMs: 1_000,
      signal: new AbortController().signal,
      readObservedThrough: () => observed,
    });
    expect(result).toBe("changed");
    expect(waiters.size).toBe(0);
    observed = 5;
  });

  test("wakes only observers of the appended session", async () => {
    const waiters = new SessionEventWaiters();
    const first = createSessionId();
    const second = createSessionId();
    const controller = new AbortController();
    const firstWait = waiters.wait({ sessionId: first, expectedObservedThrough: 0, waitMs: 1_000, signal: controller.signal, readObservedThrough: () => 0 });
    const secondWait = waiters.wait({ sessionId: second, expectedObservedThrough: 0, waitMs: 5, signal: controller.signal, readObservedThrough: () => 0 });
    await Bun.sleep(0);
    waiters.notify(first);
    expect(await firstWait).toBe("changed");
    expect(await secondWait).toBe("timeout");
  });

  test("reserves half of the local transport capacity for ordinary commands", async () => {
    const waiters = new SessionEventWaiters(1);
    const sessionId = createSessionId();
    const controller = new AbortController();
    const first = waiters.wait({ sessionId, expectedObservedThrough: 0, waitMs: 1_000, signal: controller.signal, readObservedThrough: () => 0 });
    await Bun.sleep(0);
    await expect(waiters.wait({ sessionId, expectedObservedThrough: 0, waitMs: 1_000, signal: controller.signal, readObservedThrough: () => 0 })).rejects.toBeInstanceOf(SessionEventWaiterLimitError);
    controller.abort(new Error("done"));
    await expect(first).rejects.toThrow("done");
  });

  test("removes its abort listener and timer when the wait times out", async () => {
    const waiters = new SessionEventWaiters();
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    try {
      const result = await waiters.wait({
        sessionId: createSessionId(),
        expectedObservedThrough: 0,
        waitMs: 1,
        signal: controller.signal,
        readObservedThrough: () => 0,
      });
      expect(result).toBe("timeout");
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
      expect(waiters.size).toBe(0);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  test("removes its abort listener and timer when the wait is aborted", async () => {
    const waiters = new SessionEventWaiters();
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    try {
      const wait = waiters.wait({
        sessionId: createSessionId(),
        expectedObservedThrough: 0,
        waitMs: 1_000,
        signal: controller.signal,
        readObservedThrough: () => 0,
      });
      await Bun.sleep(0);
      controller.abort(new Error("aborted"));
      await expect(wait).rejects.toThrow("aborted");
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
      expect(waiters.size).toBe(0);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  test("removes its abort listener when the session changes before the timeout", async () => {
    const waiters = new SessionEventWaiters();
    const sessionId = createSessionId();
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    try {
      const wait = waiters.wait({
        sessionId,
        expectedObservedThrough: 0,
        waitMs: 1_000,
        signal: controller.signal,
        readObservedThrough: () => 0,
      });
      await Bun.sleep(0);
      waiters.notify(sessionId);
      expect(await wait).toBe("changed");
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
