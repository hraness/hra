import { describe, expect, test } from "bun:test";

import {
  createSelectorSnapshotReader,
  getRuntimeShellFallbackSnapshot,
} from "./use-runtime-shell-selector";

describe("runtime shell selector cache", () => {
  test("keeps fallback and equal selections referentially stable across root revisions", () => {
    expect(getRuntimeShellFallbackSnapshot()).toBe(getRuntimeShellFallbackSnapshot());

    let root = { label: "ready", revision: 1 };
    let selectorCalls = 0;
    const read = createSelectorSnapshotReader(
      () => root,
      (snapshot) => {
        selectorCalls += 1;
        return { label: snapshot.label };
      },
      (left, right) => left.label === right.label,
    );
    const first = read();
    expect(read()).toBe(first);
    expect(selectorCalls).toBe(1);

    root = { label: "ready", revision: 2 };
    expect(read()).toBe(first);
    expect(selectorCalls).toBe(2);

    root = { label: "failed", revision: 3 };
    const changed = read();
    expect(changed).not.toBe(first);
    expect(changed).toEqual({ label: "failed" });
  });

  test("reuses the committed identity when a selector function changes", () => {
    const root = { label: "ready", revision: 1 };
    const committed = { label: "ready" };
    const read = createSelectorSnapshotReader(
      () => root,
      (snapshot) => ({ label: snapshot.label }),
      (left, right) => left.label === right.label,
      () => ({ hasValue: true, value: committed }),
    );

    expect(read()).toBe(committed);
  });
});
