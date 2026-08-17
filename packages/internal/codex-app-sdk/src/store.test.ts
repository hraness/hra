import { describe, expect, test } from "bun:test";

import { createReducerStore } from "./store";

type CounterAction =
  | Readonly<{ type: "add"; value: number }>
  | Readonly<{ type: "noop" }>
  | Readonly<{ type: "fail" }>;
type CounterSnapshot = Readonly<{ count: number }>;

describe("reducer store", () => {
  test("commits before notification and isolates listener failures", () => {
    const reported: unknown[] = [];
    const observed: number[] = [];
    const store = createReducerStore<CounterSnapshot, CounterAction>(
      Object.freeze({ count: 0 }),
      (snapshot, action: CounterAction) => {
        if (action.type === "noop") return snapshot;
        if (action.type === "fail") throw new Error("reducer failed");
        return Object.freeze({ count: snapshot.count + action.value });
      },
      {
        onListenerFailure: ({ error }) => {
          reported.push(error);
        },
      },
    );

    store.subscribe(() => {
      throw new Error("observer failed");
    });
    store.subscribe(() => {
      observed.push(store.getSnapshot().count);
    });

    const commit = store.dispatch({ type: "add", value: 2 });

    expect(commit).toEqual({
      changed: true,
      snapshot: { count: 2 },
      listenerFailureCount: 1,
    });
    expect(observed).toEqual([2]);
    expect(reported).toHaveLength(1);
  });

  test("suppresses identity no-ops and makes unsubscribe idempotent", () => {
    const store = createReducerStore<CounterSnapshot, CounterAction>(
      Object.freeze({ count: 0 }),
      (snapshot, action: CounterAction) =>
        action.type === "add"
          ? Object.freeze({ count: snapshot.count + action.value })
          : snapshot,
    );
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    expect(store.dispatch({ type: "noop" }).changed).toBe(false);
    unsubscribe();
    unsubscribe();
    store.dispatch({ type: "add", value: 1 });

    expect(notifications).toBe(0);
  });

  test("tracks duplicate listener subscriptions independently", () => {
    const store = createReducerStore(0, (value, delta: number) => value + delta);
    let notifications = 0;
    const listener = (): void => {
      notifications += 1;
    };
    const unsubscribeFirst = store.subscribe(listener);
    const unsubscribeSecond = store.subscribe(listener);

    unsubscribeFirst();
    store.dispatch(1);
    expect(notifications).toBe(1);
    unsubscribeSecond();
    store.dispatch(1);
    expect(notifications).toBe(1);
  });

  test("does not commit when the reducer throws", () => {
    const initial = Object.freeze({ count: 3 });
    const store = createReducerStore<CounterSnapshot, CounterAction>(
      initial,
      (snapshot, action: CounterAction) => {
        if (action.type === "fail") throw new Error("reducer failed");
        return snapshot;
      },
    );
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    expect(() => store.dispatch({ type: "fail" })).toThrow("reducer failed");
    expect(store.getSnapshot()).toBe(initial);
    expect(notifications).toBe(0);
  });
});
