/**
 * Idle lock, expressed without React or the document so it tests directly.
 *
 * The tab drops the account key after `idleMs` without pointer or keyboard
 * activity. `activity()` is called from the real listeners; `tick(now)` is
 * called by the interval. Nothing here reads a clock on its own, so a test
 * drives it with exact times.
 */
export type IdleTimer = Readonly<{
  activity: (now: number) => void;
  idleAt: () => number;
  tick: (now: number) => boolean;
}>;

export function createIdleTimer(input: Readonly<{
  idleMs: number;
  now: number;
  onIdle: () => void;
}>): IdleTimer {
  if (!Number.isSafeInteger(input.idleMs) || input.idleMs < 1_000) {
    throw new Error("Idle lock interval must be at least one second.");
  }
  let lastActivity = input.now;
  let fired = false;
  return {
    activity(now) {
      if (fired) return;
      if (now > lastActivity) lastActivity = now;
    },
    idleAt() {
      return lastActivity + input.idleMs;
    },
    tick(now) {
      if (fired || now < lastActivity + input.idleMs) return fired;
      fired = true;
      input.onIdle();
      return true;
    },
  };
}

/** The events that count as presence at the keyboard or the screen. */
export const idleActivityEvents = [
  "keydown",
  "pointerdown",
  "pointermove",
  "touchstart",
  "wheel",
] as const;

/** `Ctrl+L` locks immediately. */
export function isLockShortcut(event: Readonly<{
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
}>): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "l";
}
