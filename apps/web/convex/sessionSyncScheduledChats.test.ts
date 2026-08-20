import { describe, expect, test } from "bun:test";

import {
  nextScheduledChatSweepArgs,
  scheduledChatWakeTupleMatches,
} from "./sessionSyncScheduledChats";

const valid = {
  scheduledScheduleId: "schedule_a",
  scheduledWakeId: "wake_a",
  scheduledGeneration: "7",
  scheduledOccurrenceSequence: "11",
  scheduledExpectedRunAt: 42_000,
  schedule: {
    _id: "schedule_a",
    vaultId: "vault_a",
    sessionEntryId: "session_a",
    originDeviceId: "device_a",
    generation: "7",
    occurrenceSequence: "11",
    nextRunAt: 42_000,
  },
  wake: {
    _id: "wake_a",
    scheduleId: "schedule_a",
    vaultId: "vault_a",
    sessionEntryId: "session_a",
    originDeviceId: "device_a",
    generation: "7",
    occurrenceSequence: "11",
    expectedRunAt: 42_000,
  },
} as unknown as Parameters<typeof scheduledChatWakeTupleMatches>[0];

describe("scheduled chat wake ownership", () => {
  test("requires the complete immutable occurrence tuple", () => {
    expect(scheduledChatWakeTupleMatches(valid)).toBeTrue();
    type WakeTuple = Parameters<typeof scheduledChatWakeTupleMatches>[0];
    const mismatches: readonly ((input: WakeTuple) => WakeTuple)[] = [
      (input) => ({ ...input, scheduledScheduleId: "schedule_b" }),
      (input) => ({ ...input, scheduledWakeId: "wake_b" }),
      (input) => ({ ...input, scheduledGeneration: "8" }),
      (input) => ({ ...input, scheduledOccurrenceSequence: "12" }),
      (input) => ({ ...input, scheduledExpectedRunAt: 42_001 }),
      (input) => ({
        ...input,
        schedule: {
          ...input.schedule,
          originDeviceId: "device_b" as typeof input.schedule.originDeviceId,
        },
      }),
      (input) => ({
        ...input,
        wake: { ...input.wake, vaultId: "vault_b" as typeof input.wake.vaultId },
      }),
      (input) => ({
        ...input,
        wake: {
          ...input.wake,
          sessionEntryId: "session_b" as typeof input.wake.sessionEntryId,
        },
      }),
      (input) => ({
        ...input,
        wake: { ...input.wake, scheduleId: "schedule_b" as typeof input.wake.scheduleId },
      }),
    ];
    for (const mismatch of mismatches) {
      expect(scheduledChatWakeTupleMatches(mismatch(valid))).toBeFalse();
    }
  });

  test("restarts nonterminal sweeps at the due-index head", () => {
    expect(nextScheduledChatSweepArgs(true)).toBeNull();
    expect(nextScheduledChatSweepArgs(false)).toEqual({});
  });
});
