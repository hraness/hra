import { expect, test } from "bun:test";
import { createPreviewLoading, type PreviewLoadingState } from "./preview-loading.ts";

function fixture() {
  const published: PreviewLoadingState[] = [];
  const callbacks: (() => void)[] = [];
  const cancelled: number[] = [];
  const load = createPreviewLoading({ publish: (state) => { published.push(state); }, schedule: (callback) => { callbacks.push(callback); return callbacks.length - 1; }, cancel: (timer: number) => { cancelled.push(timer); } });
  return { load, published, callbacks, cancelled };
}

test("an early ready message cannot be reset by a later viewport observation", () => {
  const f = fixture();
  f.load.complete(true);
  f.load.begin();
  expect(f.load.state()).toBe("ready");
  expect(f.published).toEqual(["ready"]);
  expect(f.callbacks).toHaveLength(0);
});

test("a new selection resets loading and rejects a stale timer callback", () => {
  const f = fixture();
  f.load.begin();
  f.load.begin();
  expect(f.callbacks).toHaveLength(1);
  f.load.reset();
  f.load.begin();
  f.callbacks[0]!();
  expect(f.load.state()).toBe("loading");
  expect(f.cancelled).toEqual([0]);
  f.load.complete(true);
  f.callbacks[1]!();
  expect(f.load.state()).toBe("ready");
  expect(f.cancelled).toEqual([0, 1]);
});

test("a timed-out or failed preview stays settled until a new selection", () => {
  const f = fixture();
  f.load.begin();
  f.callbacks[0]!();
  expect(f.load.state()).toBe("failed");
  f.load.begin();
  expect(f.callbacks).toHaveLength(1);
  f.load.complete(false);
  f.load.reset();
  f.load.begin();
  expect(f.load.state()).toBe("loading");
  expect(f.callbacks).toHaveLength(2);
});

test("a second frame has its own deadline and closing it invalidates pending work", () => {
  const embedded = fixture(), enlarged = fixture();
  embedded.load.complete(true);
  enlarged.load.begin();
  expect(enlarged.load.state()).toBe("loading");
  enlarged.callbacks[0]!();
  expect(enlarged.load.state()).toBe("failed");
  expect(embedded.load.state()).toBe("ready");
  enlarged.load.reset();
  enlarged.load.begin();
  enlarged.load.reset();
  enlarged.callbacks[1]!();
  expect(enlarged.load.state()).toBe("idle");
  expect(enlarged.cancelled).toEqual([1]);
});
