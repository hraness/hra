import type { RuntimeEvent, RuntimeSnapshot } from "../../../contracts/runtime";
import {
  advanceRuntimeProjection,
  nextRuntimeProjectionSequence,
} from "../../../contracts/runtime-projection";

export type RuntimeProjectionResult =
  | Readonly<{ readonly kind: "applied"; readonly snapshot: RuntimeSnapshot }>
  | Readonly<{
      readonly kind: "ignored";
      readonly snapshot: RuntimeSnapshot;
      readonly sequence: number;
    }>
  | Readonly<{
      readonly kind: "gap";
      readonly snapshot: RuntimeSnapshot;
      readonly expectedSequence: number;
      readonly receivedSequence: number;
    }>
  | Readonly<{
      readonly kind: "invalidated";
      readonly snapshot: RuntimeSnapshot;
      readonly sequence: number;
      readonly reason: Extract<
        RuntimeEvent["event"],
        { readonly type: "snapshot.invalidated" }
      >["reason"];
    }>;

export function applyRuntimeEvent(
  snapshot: RuntimeSnapshot,
  message: RuntimeEvent,
): RuntimeProjectionResult {
  if (message.sequence <= snapshot.lastSequence) {
    return { kind: "ignored", snapshot, sequence: message.sequence };
  }
  if (message.event.type === "snapshot.invalidated") {
    return {
      kind: "invalidated",
      snapshot,
      sequence: message.sequence,
      reason: message.event.reason,
    };
  }
  const expectedSequence = nextRuntimeProjectionSequence(snapshot);
  if (message.sequence !== expectedSequence) {
    return {
      kind: "gap",
      snapshot,
      expectedSequence,
      receivedSequence: message.sequence,
    };
  }
  return { kind: "applied", snapshot: advanceRuntimeProjection(snapshot, message) };
}
