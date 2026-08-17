import { describe, expect, test } from "bun:test";

import { createReducerStore } from "./store";
import { createDeterministicNumberSource } from "./testing/fixtures";

describe("reducer store properties", () => {
  test("notifications equal committed root changes for arbitrary actions", () => {
    const numbers = createDeterministicNumberSource(0x51a7e);
    const actions = Array.from(
      { length: 1_000 },
      () => numbers.nextInteger(-8, 8),
    );
    const store = createReducerStore<
      Readonly<{ total: number }>,
      number
    >(
      Object.freeze({ total: 0 }),
      (snapshot, delta: number) =>
        delta === 0
          ? snapshot
          : Object.freeze({ total: snapshot.total + delta }),
    );
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    let expectedTotal = 0;
    let expectedNotifications = 0;
    for (const delta of actions) {
      expectedTotal += delta;
      if (delta !== 0) expectedNotifications += 1;
      store.dispatch(delta);
    }

    expect(store.getSnapshot().total).toBe(expectedTotal);
    expect(notifications).toBe(expectedNotifications);
  });

  test("a failing observer never suppresses a healthy observer", () => {
    const store = createReducerStore(0, (value, delta: number) => value + delta);
    let healthyNotifications = 0;
    store.subscribe(() => {
      throw new Error("expected observer failure");
    });
    store.subscribe(() => {
      healthyNotifications += 1;
    });

    for (let index = 0; index < 500; index += 1) {
      const commit = store.dispatch(1);
      expect(commit.listenerFailureCount).toBe(1);
    }

    expect(healthyNotifications).toBe(500);
    expect(store.getSnapshot()).toBe(500);
  });
});
