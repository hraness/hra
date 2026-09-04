import { describe, expect, test } from "bun:test";

import { idleLockMs } from "../env";
import { createIdleTimer, idleActivityEvents, isLockShortcut } from "./idle";

function shortcut(overrides: Partial<Parameters<typeof isLockShortcut>[0]> = {}) {
  return {
    altKey: false,
    ctrlKey: true,
    key: "l",
    metaKey: false,
    ...overrides,
  };
}

describe("createIdleTimer", () => {
  test("locks after the idle interval with no activity", () => {
    let locks = 0;
    const timer = createIdleTimer({ idleMs: idleLockMs, now: 0, onIdle: () => { locks += 1; } });
    expect(timer.tick(idleLockMs - 1)).toBe(false);
    expect(locks).toBe(0);
    expect(timer.tick(idleLockMs)).toBe(true);
    expect(locks).toBe(1);
  });

  test("activity pushes the deadline out", () => {
    let locks = 0;
    const timer = createIdleTimer({ idleMs: idleLockMs, now: 0, onIdle: () => { locks += 1; } });
    timer.activity(idleLockMs - 1);
    expect(timer.idleAt()).toBe(idleLockMs - 1 + idleLockMs);
    expect(timer.tick(idleLockMs)).toBe(false);
    expect(locks).toBe(0);
    expect(timer.tick(idleLockMs * 2)).toBe(true);
    expect(locks).toBe(1);
  });

  test("locks exactly once and ignores activity afterwards", () => {
    let locks = 0;
    const timer = createIdleTimer({ idleMs: idleLockMs, now: 0, onIdle: () => { locks += 1; } });
    timer.tick(idleLockMs);
    timer.activity(idleLockMs + 1);
    timer.tick(idleLockMs * 10);
    expect(locks).toBe(1);
  });

  test("a clock that goes backwards never extends the deadline", () => {
    const timer = createIdleTimer({ idleMs: idleLockMs, now: 1_000, onIdle: () => undefined });
    timer.activity(0);
    expect(timer.idleAt()).toBe(1_000 + idleLockMs);
  });

  test("refuses an implausibly short interval", () => {
    expect(() => createIdleTimer({ idleMs: 10, now: 0, onIdle: () => undefined })).toThrow();
  });

  test("the configured idle lock is fifteen minutes", () => {
    expect(idleLockMs).toBe(15 * 60 * 1_000);
  });
});

describe("isLockShortcut", () => {
  test("Ctrl+L locks, in either case", () => {
    expect(isLockShortcut(shortcut())).toBe(true);
    expect(isLockShortcut(shortcut({ key: "L" }))).toBe(true);
  });

  test("other chords do not lock", () => {
    expect(isLockShortcut(shortcut({ ctrlKey: false }))).toBe(false);
    expect(isLockShortcut(shortcut({ metaKey: true }))).toBe(false);
    expect(isLockShortcut(shortcut({ altKey: true }))).toBe(false);
    expect(isLockShortcut(shortcut({ key: "k" }))).toBe(false);
  });
});

describe("idleActivityEvents", () => {
  test("covers pointer and keyboard input", () => {
    expect(idleActivityEvents).toContain("keydown");
    expect(idleActivityEvents).toContain("pointerdown");
    expect(idleActivityEvents).toContain("touchstart");
  });
});
