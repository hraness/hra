import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import type { AccountSummary, RuntimeSnapshot } from "../../contracts/runtime";
import { RuntimeProjection, runtimeEventByteCeiling } from "../src/projection";
import { replayRuntimeEvents } from "../src/projection/reducer";

function emptySnapshot(): RuntimeSnapshot {
  return {
    revision: 1,
    lastSequence: 0,
    runtime: { state: "ready", generation: 1 },
    runner: { state: "connecting" },
    accounts: [],
    retainedAccountLocalData: [],
    humanAccount: { state: "signedOut", revision: 0 },
    chat: { revision: 1, panes: [] },
    sessionSync: {
      status: {
        state: "unavailable",
        reason: "cloudConfigurationMissing",
        retryable: false,
      },
      localGridSlots: [],
      remoteSessions: [],
    },
    harness: null,
  };
}

function account(index: number, selected: boolean): AccountSummary {
  return {
    id: `acct_property${String(index).padStart(8, "0")}`,
    revision: 1,
    label: `Account ${index}`,
    selected,
    identityLabel: null,
    planLabel: null,
    usageRemainingPercent: null,
    authState: "signedOut",
    login: { state: "idle" },
    runtime: { state: "stopped", generation: 0 },
  };
}

test("every public projection stream replays to its authoritative snapshot", () => {
  assertProperty(fc.property(
    fc.array(fc.boolean(), { maxLength: 64 }),
    (selectedValues) => {
      const projection = new RuntimeProjection(emptySnapshot(), { maxQueuedEvents: 128 });
      selectedValues.forEach((selected, index) => {
        projection.publish({ type: "account.upserted", account: account(index, selected) });
      });
      const queuedBytes = projection.queuedByteCount;
      const partial = projection.drainEvents(Math.floor(selectedValues.length / 2));
      const remainingBytes = projection.queuedByteCount;
      const remaining = projection.drainEvents();
      const events = [...partial, ...remaining];
      expect(queuedBytes).toBe(events.reduce(
        (total, event) => total + encodedBytes(event),
        0,
      ));
      expect(remainingBytes).toBe(remaining.reduce(
        (total, event) => total + encodedBytes(event),
        0,
      ));
      expect(projection.queuedByteCount).toBe(0);
      const replayed = replayRuntimeEvents(emptySnapshot(), events);
      const capture = projection.beginSnapshot();
      expect(replayed).toEqual(capture.response.snapshot);
      expect(events.every((event) => (
        new TextEncoder().encode(JSON.stringify(event)).byteLength <= runtimeEventByteCeiling
      ))).toBeTrue();
      capture.release();
    },
  ));
});

test("snapshot barriers preserve every transient-exact event with exact bytes", () => {
  assertProperty(fc.property(
    fc.array(fc.boolean(), { maxLength: 64 }),
    (protectedEvents) => {
      const projection = new RuntimeProjection(emptySnapshot(), { maxQueuedEvents: 128 });
      protectedEvents.forEach((isProtected, index) => {
        projection.publish(isProtected
          ? {
              type: "operation.completed",
              operationId: `op_property${String(index).padStart(8, "0")}`,
              outcome: { ok: true },
            }
          : { type: "runner.changed", runner: { state: "connected" } });
      });
      const expectedProtectedCount = protectedEvents.filter(Boolean).length;
      const capture = projection.beginSnapshot();
      expect(capture.response.snapshot.lastSequence).toBe(protectedEvents.length);
      expect(projection.queuedEventCount).toBe(expectedProtectedCount);
      const queuedBytes = projection.queuedByteCount;
      expect(projection.drainEvents()).toEqual([]);
      expect(projection.queuedByteCount).toBe(queuedBytes);
      capture.release();
      const resequenced = projection.drainEvents();
      expect(resequenced).toHaveLength(expectedProtectedCount);
      expect(resequenced.map(({ sequence }) => sequence)).toEqual(
        Array.from(
          { length: expectedProtectedCount },
          (_, index) => protectedEvents.length + index + 1,
        ),
      );
      expect(resequenced.every(({ event }) => event.type === "operation.completed")).toBeTrue();
      expect(queuedBytes).toBe(resequenced.reduce(
        (total, event) => total + encodedBytes(event),
        0,
      ));
      expect(projection.queuedByteCount).toBe(0);
    },
  ));
});

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
