import { describe, expect, test } from "bun:test";

import { parseTaskData } from "./domain";

const validTask = {
  id: "tsk_0123456789ABCDEFGHJKMNPQRS",
  key: "OPS-ABC1234",
  title: "Receipt parser regression",
  type: "task" as const,
  priority: 1,
  status: "open" as const,
  availableAt: 1,
  isReady: true,
  unresolvedBlockerCount: 0,
  cancelledBlockerCount: 0,
  revision: 1,
  reviewRevision: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe("task command receipt parsing", () => {
  test("accepts only an exact protocol task payload", () => {
    expect(parseTaskData({ task: validTask })).toEqual({ task: validTask });
    expect(parseTaskData({ task: validTask, legacy: true })).toBeNull();
  });

  test("rejects malformed legacy claim receipts instead of asserting them", () => {
    expect(parseTaskData({ task: { ...validTask, status: "in_progress" } })).toBeNull();
    expect(
      parseTaskData({
        task: {
          ...validTask,
          status: "in_progress",
          currentClaim: {
            id: "clm_0123456789ABCDEFGHJKMNPQRS",
            agentId: "agt_0123456789ABCDEFGHJKMNPQRS",
            fence: 1,
            leaseUntil: 2,
          },
        },
      }),
    ).toBeNull();
  });
});
