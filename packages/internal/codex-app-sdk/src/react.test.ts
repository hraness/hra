import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  createExternalStoreSelectorReader,
  useExternalStoreSelector,
} from "./react";
import { createReducerStore } from "./store";

describe("external store selector", () => {
  test("retains equal selected identities across root revisions", () => {
    let root = { revision: 1, state: "ready" };
    let calls = 0;
    const read = createExternalStoreSelectorReader(
      () => root,
      (snapshot) => {
        calls += 1;
        return { state: snapshot.state };
      },
      (left, right) => left.state === right.state,
    );

    const first = read();
    expect(read()).toBe(first);
    expect(calls).toBe(1);
    root = { revision: 2, state: "ready" };
    expect(read()).toBe(first);
    expect(calls).toBe(2);
    root = { revision: 3, state: "recovering" };
    expect(read()).toEqual({ state: "recovering" });
  });

  test("uses the explicit server snapshot during server rendering", () => {
    const store = createReducerStore<
      Readonly<{ generation: number }>,
      number
    >(
      Object.freeze({ generation: 1 }),
      (_snapshot, generation: number) => Object.freeze({ generation }),
    );
    const getServerSnapshot = (): Readonly<{ generation: number }> =>
      Object.freeze({ generation: 9 });

    function Probe(): ReturnType<typeof createElement> {
      const generation = useExternalStoreSelector(
        store,
        (snapshot) => snapshot.generation,
        { getServerSnapshot },
      );
      return createElement("span", null, String(generation));
    }

    expect(renderToString(createElement(Probe))).toBe("<span>9</span>");
  });
});
