/**
 * Effect cancellation.
 *
 * An async effect that resolves after its component has unmounted, or after its
 * inputs changed, must not write state. A cleanup flag read through a function
 * says so without the surrounding code having to reason about when the closure
 * variable changed.
 */
export type Cancellation = Readonly<{
  cancel: () => void;
  live: () => boolean;
}>;

export function createCancellation(): Cancellation {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    live() {
      return !cancelled;
    },
  };
}
