import { expect, test } from "bun:test";

import { bindJellyPointerRelease, isJellySurfaceDisabled } from "./jelly-surface";

class ListenerTarget {
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
}

function pointerEvent(pointerId: number): Event {
  return Object.assign(new Event("pointerup"), { pointerId });
}

test("Jelly pointer release listeners clean up on completion, blur, and unmount", () => {
  const completedTarget = new ListenerTarget();
  let completedReleases = 0;
  const disposeCompleted = bindJellyPointerRelease(
    completedTarget,
    7,
    () => completedReleases += 1,
  );

  completedTarget.dispatch("pointerup", pointerEvent(8));
  expect(completedReleases).toBe(0);
  expect(completedTarget.listenerCount()).toBe(3);
  completedTarget.dispatch("pointercancel", pointerEvent(7));
  expect(completedReleases).toBe(1);
  expect(completedTarget.listenerCount()).toBe(0);
  disposeCompleted();

  const blurredTarget = new ListenerTarget();
  let blurredReleases = 0;
  bindJellyPointerRelease(blurredTarget, 4, () => blurredReleases += 1);
  blurredTarget.dispatch("blur");
  expect(blurredReleases).toBe(1);
  expect(blurredTarget.listenerCount()).toBe(0);

  const unmountedTarget = new ListenerTarget();
  let unmountedReleases = 0;
  const unmount = bindJellyPointerRelease(unmountedTarget, 2, () => unmountedReleases += 1);
  unmount();
  unmountedTarget.dispatch("pointerup", pointerEvent(2));
  expect(unmountedReleases).toBe(0);
  expect(unmountedTarget.listenerCount()).toBe(0);
});

test("only a surface's own disabled control suppresses Jelly interaction feedback", () => {
  const enabled = {
    matches: () => false,
  };
  const disabledHost = {
    matches: (selector: string) => selector.includes("[data-disabled]"),
  };
  const pendingHost = {
    matches: (selector: string) => selector.includes("[data-pending]"),
  };
  const compositeWithNestedDisabledAction = {
    matches: () => false,
  };

  expect(isJellySurfaceDisabled(enabled)).toBeFalse();
  expect(isJellySurfaceDisabled(disabledHost)).toBeTrue();
  expect(isJellySurfaceDisabled(pendingHost)).toBeTrue();
  expect(isJellySurfaceDisabled(compositeWithNestedDisabledAction)).toBeFalse();
});
