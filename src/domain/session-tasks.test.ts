import { describe, expect, test } from "bun:test";

import {
  SESSION_TASK_LIMIT,
  SESSION_TASK_MAX_INTERVAL_MINUTES,
  SESSION_TASK_MIN_INTERVAL_MINUTES,
  sessionTaskDeleteResultSchema,
  sessionTaskIntervalMinutesSchema,
  sessionTaskListSchema,
  sessionTaskPatchSchema,
  sessionTaskRecordSchema,
  sessionTaskSummarySchema,
  summarizeSessionTask,
} from "./session-tasks";

const sessionId = `sess_${"a".repeat(32)}`;
const taskId = `stask_${"b".repeat(32)}`;

const record = {
  scope: "conversation" as const,
  id: taskId,
  sessionId,
  name: "Review the conversation",
  prompt: "Inspect new messages and summarize material changes.",
  status: "active" as const,
  schedule: { kind: "interval_minutes" as const, minutes: 15 },
  revision: 1,
  nextDueAt: 901_000,
  createdAt: 1_000,
  updatedAt: 1_000,
};

describe("conversation-bound scheduled-task domain", () => {
  test("accepts only the closed whole-minute interval range", () => {
    expect(sessionTaskIntervalMinutesSchema.parse(SESSION_TASK_MIN_INTERVAL_MINUTES)).toBe(15);
    expect(sessionTaskIntervalMinutesSchema.parse(SESSION_TASK_MAX_INTERVAL_MINUTES)).toBe(10_080);
    for (const invalid of [14, 10_081, 15.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sessionTaskIntervalMinutesSchema.parse(invalid)).toThrow();
    }
  });

  test("keeps active and paused due-time states exact", () => {
    expect(sessionTaskRecordSchema.parse(record)).toEqual(record);
    expect(sessionTaskRecordSchema.parse({
      ...record,
      status: "paused",
      nextDueAt: null,
    })).toMatchObject({ status: "paused", nextDueAt: null });
    expect(() => sessionTaskRecordSchema.parse({ ...record, nextDueAt: null })).toThrow();
    expect(() => sessionTaskSummarySchema.parse({
      ...summarizeSessionTask(record),
      status: "paused",
    })).toThrow();
  });

  test("list summaries omit prompts and remain conversation scoped", () => {
    const summary = summarizeSessionTask(sessionTaskRecordSchema.parse(record));
    expect(summary).not.toHaveProperty("prompt");
    expect(sessionTaskListSchema.parse({
      scope: "conversation",
      sessionId,
      tasks: [summary],
    })).toEqual({ scope: "conversation", sessionId, tasks: [summary] });
    expect(() => sessionTaskListSchema.parse({
      scope: "conversation",
      sessionId,
      tasks: Array.from({ length: SESSION_TASK_LIMIT + 1 }, () => summary),
    })).toThrow();
  });

  test("rejects empty edits, extra fields, and standalone-field smuggling", () => {
    expect(() => sessionTaskPatchSchema.parse({})).toThrow();
    expect(() => sessionTaskPatchSchema.parse({ prompt: "replacement" })).not.toThrow();
    expect(() => sessionTaskPatchSchema.parse({
      status: "active",
      destination: "local",
    })).toThrow();
    expect(() => sessionTaskRecordSchema.parse({
      ...record,
      kind: "cron",
    })).toThrow();
  });

  test("validates bounded delete receipts without provider authority", () => {
    expect(sessionTaskDeleteResultSchema.parse({
      scope: "conversation",
      sessionId,
      taskId,
      deleted: true,
      revision: 2,
      deletedAt: 2_000,
    })).toEqual({
      scope: "conversation",
      sessionId,
      taskId,
      deleted: true,
      revision: 2,
      deletedAt: 2_000,
    });
    expect(() => sessionTaskDeleteResultSchema.parse({
      scope: "conversation",
      sessionId,
      taskId,
      deleted: true,
      revision: 2,
      deletedAt: 2_000,
      providerThreadId: "private",
    })).toThrow();
  });
});
