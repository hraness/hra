import { describe, expect, test } from "bun:test";

import type { CodexFact } from "../src/codex";
import { SessionStore } from "../src/sessions/store";

function fact(
  streamPosition: number,
  availability: "signed_in" | "signed_out" =
    streamPosition === 1 ? "signed_in" : "signed_out",
): CodexFact {
  return {
    accountProfileId: "account_1",
    encodedBytes: 16,
    factIndex: 0,
    generation: 1,
    origin: "live",
    streamPosition,
    type: "account.changed",
    availability,
  };
}

describe("SessionStore", () => {
  test("keeps a stable snapshot and publishes exactly once per changed batch", () => {
    const store = new SessionStore();
    const initial = store.getSnapshot();
    let publications = 0;
    const unsubscribe = store.subscribe(() => {
      publications += 1;
    });

    const changed = store.dispatchBatch([fact(1), fact(2)]);
    expect(changed).toBe(store.getSnapshot());
    expect(changed).not.toBe(initial);
    expect(changed.revision).toBe(1);
    expect(publications).toBe(1);

    expect(store.dispatch(fact(1))).toBe(changed);
    expect(publications).toBe(1);
    unsubscribe();
    store.dispatch(fact(3, "signed_in"));
    expect(publications).toBe(1);
  });

  test("isolates a throwing listener and still publishes to later subscribers", () => {
    const store = new SessionStore();
    const unsubscribe = store.subscribe(() => {
      throw new Error("listener failed");
    });
    let publications = 0;
    store.subscribe(() => {
      publications += 1;
    });
    expect(() => store.dispatch(fact(1))).not.toThrow();
    expect(publications).toBe(1);
    unsubscribe();
    expect(() => store.dispatch(fact(2))).not.toThrow();
    expect(publications).toBe(2);
  });

  test("returns only newly accepted facts for exactly-once effect adapters", () => {
    const store = new SessionStore();
    const first = fact(1);
    expect(store.dispatchAcceptedBatch([first, first, fact(2)]).accepted)
      .toEqual([first, fact(2)]);
    expect(store.dispatchAcceptedBatch([first]).accepted).toEqual([]);
  });
});
