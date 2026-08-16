import { expect, test } from "bun:test";

import { abortableSleep } from "../src/cloud/abortable-sleep";

class ObservedAbortSignal extends EventTarget {
  aborted = false;
  additions = 0;
  removals = 0;

  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
    this.additions += 1;
    super.addEventListener(...args);
  }

  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new Event("abort"));
  }

  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
    this.removals += 1;
    super.removeEventListener(...args);
  }
}

test("completed abortable sleeps remove their long-lived signal listener", async () => {
  const signal = new ObservedAbortSignal();
  for (let index = 0; index < 25; index += 1) {
    await abortableSleep(0, signal as unknown as AbortSignal);
  }

  expect(signal.additions).toBe(25);
  expect(signal.removals).toBe(25);
});

test("abortable sleep resolves promptly and removes its listener on abort", async () => {
  const signal = new ObservedAbortSignal();
  const sleeping = abortableSleep(60_000, signal as unknown as AbortSignal);
  signal.abort();
  await sleeping;

  expect(signal.additions).toBe(1);
  expect(signal.removals).toBe(1);
});

test("an already-aborted sleep installs no timer listener", async () => {
  const signal = new ObservedAbortSignal();
  signal.abort();
  await abortableSleep(60_000, signal as unknown as AbortSignal);

  expect(signal.additions).toBe(0);
  expect(signal.removals).toBe(0);
});
