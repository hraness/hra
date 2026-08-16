import type { RuntimeEvent, RuntimeSnapshot } from "../../../contracts/runtime";
import {
  advanceRuntimeProjection,
  nextRuntimeProjectionSequence,
  reduceRuntimeProjectionEvent,
  type RuntimeProjectionEvent,
} from "../../../contracts/runtime-projection";

export type ProjectionEvent = RuntimeProjectionEvent;

export { reduceRuntimeProjectionEvent as reduceProjectionEvent };

export class ProjectionSequenceGapError extends Error {
  readonly expected: number;
  readonly received: number;

  constructor(expected: number, received: number) {
    super(`Runtime projection expected sequence ${expected} but received ${received}`);
    this.name = "ProjectionSequenceGapError";
    this.expected = expected;
    this.received = received;
  }
}

export function replayRuntimeEvent(
  snapshot: RuntimeSnapshot,
  envelope: RuntimeEvent,
): RuntimeSnapshot {
  if (envelope.sequence <= snapshot.lastSequence) return snapshot;
  const expected = nextRuntimeProjectionSequence(snapshot);
  if (envelope.sequence !== expected) {
    throw new ProjectionSequenceGapError(expected, envelope.sequence);
  }
  return advanceRuntimeProjection(snapshot, envelope);
}

export function replayRuntimeEvents(
  snapshot: RuntimeSnapshot,
  events: readonly RuntimeEvent[],
): RuntimeSnapshot {
  return events.reduce(replayRuntimeEvent, snapshot);
}
