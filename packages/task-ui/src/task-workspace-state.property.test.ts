import { expect, test } from "bun:test";
import type { TaskRunView } from "@hraness/agent-tasks-protocol";
import { assertProperty, fc } from "@hra-internal/test";

import {
  elapsedTaskTime,
  prioritizeTasksNeedingInput,
  setRunInteractionOption,
  setRunInteractionOtherText,
  type RunInteractionQuestionDraft,
  type TaskWorkspaceListItem,
  taskTranscriptMessages,
} from "./task-workspace-state";
import { reviewTaskFixture } from "./task-workspace-fixtures";

const optionId = fc.string({ minLength: 1, maxLength: 40 });

test("property: shared interaction option updates preserve set semantics under batched input", () => {
  assertProperty(fc.property(
    fc.array(fc.tuple(optionId, fc.boolean()), { maxLength: 80 }),
    (updates) => {
      let draft: RunInteractionQuestionDraft = { otherText: "kept", selectedOptionIds: [] };
      const expected = new Set<string>();
      for (const [id, checked] of updates) {
        draft = setRunInteractionOption(draft, id, checked);
        if (checked) expected.add(id);
        else expected.delete(id);
      }
      expect(draft.otherText).toBe("kept");
      expect(new Set(draft.selectedOptionIds)).toEqual(expected);
      expect(draft.selectedOptionIds).toHaveLength(expected.size);
    },
  ));
});

test("property: free-form interaction input never erases selected options", () => {
  assertProperty(fc.property(
    fc.uniqueArray(optionId, { maxLength: 8 }),
    fc.string({ maxLength: 2_000 }),
    (selectedOptionIds, otherText) => {
      const draft = setRunInteractionOtherText({ otherText: "", selectedOptionIds }, otherText);
      expect(draft).toEqual({ otherText, selectedOptionIds });
    },
  ));
});

test("property: pending human decisions are stably partitioned above autonomous work", () => {
  assertProperty(fc.property(
    fc.array(fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }), {
      minLength: 1,
      maxLength: 80,
    }),
    (requestedAtValues) => {
      const tasks: TaskWorkspaceListItem[] = requestedAtValues.map((requestedAt, index) => ({
        humanInput: requestedAt === null
          ? null
          : {
              expiresAt: 3_000_000,
              kind: index % 2 === 0 ? "approval" : "user_input",
              oldestRequestedAt: requestedAt,
              pendingCount: 1,
              preview: `Question ${index}`,
            },
        run: null,
        task: {
          ...reviewTaskFixture,
          id: `task-${index}`,
          key: `AT-${String(index).padStart(7, "0")}`,
        },
      }));
      const prioritized = prioritizeTasksNeedingInput(tasks, 2_000_000);
      const summaries = prioritized.map(({ humanInput }) => humanInput);
      const firstAutonomous = summaries.findIndex((summary) => summary === null);
      expect(summaries.every((summary, index) =>
        firstAutonomous === -1 || index < firstAutonomous ? summary !== null : summary === null,
      )).toBeTrue();

      const expectedPendingKeys = tasks
        .filter(({ humanInput }) => humanInput !== null)
        .map(({ task }) => task.key);
      const actualPendingKeys = prioritized
        .filter(({ humanInput }) => humanInput !== null)
        .map(({ task }) => task.key);
      expect(actualPendingKeys).toEqual(expectedPendingKeys);

      const expectedAutonomousKeys = tasks
        .filter(({ humanInput }) => humanInput === null)
        .map(({ task }) => task.key);
      const actualAutonomousKeys = prioritized
        .filter(({ humanInput }) => humanInput === null)
        .map(({ task }) => task.key);
      expect(actualAutonomousKeys).toEqual(expectedAutonomousKeys);
    },
  ));
});

test("property: expired human-input previews fail closed before prioritization", () => {
  const now = 2_000_000;
  assertProperty(fc.property(
    fc.array(fc.integer({ min: -10_000, max: 10_000 }), { minLength: 1, maxLength: 80 }),
    (expiryOffsets) => {
      const tasks: TaskWorkspaceListItem[] = expiryOffsets.map((offset, index) => ({
        humanInput: {
          expiresAt: now + offset,
          kind: index % 2 === 0 ? "approval" : "user_input",
          oldestRequestedAt: now - 20_000,
          pendingCount: 1,
          preview: `Question ${index}`,
        },
        run: null,
        task: {
          ...reviewTaskFixture,
          id: `expiring-task-${index}`,
          key: `AT-${String(index).padStart(7, "0")}`,
        },
      }));
      const prioritized = prioritizeTasksNeedingInput(tasks, now);
      const expectedActive = tasks
        .filter(({ humanInput }) => humanInput !== null && humanInput.expiresAt > now)
        .map(({ task }) => task.key);
      const expectedExpired = tasks
        .filter(({ humanInput }) => humanInput !== null && humanInput.expiresAt <= now)
        .map(({ task }) => task.key);

      expect(prioritized.filter(({ humanInput }) => humanInput !== null).map(({ task }) => task.key))
        .toEqual(expectedActive);
      expect(prioritized.filter(({ humanInput }) => humanInput === null).map(({ task }) => task.key))
        .toEqual(expectedExpired);
    },
  ));
});

test("property: elapsed task time is stable within each elapsed second", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0, max: 86_400_000 }),
    fc.integer({ min: 0, max: 999 }),
    (elapsed, subsecond) => {
      const startedAt = 1_000_000;
      expect(elapsedTaskTime(startedAt + elapsed + subsecond, startedAt)).toBe(
        elapsedTaskTime(startedAt + Math.floor((elapsed + subsecond) / 1_000) * 1_000, startedAt),
      );
      expect(elapsedTaskTime(startedAt - elapsed, startedAt)).toBe("0s");
    },
  ));
});

test("coalesces adjacent stream deltas but respects tool and status boundaries", () => {
  const events: TaskRunView["events"] = [
    { displayText: "Checking ", id: "event_0123456789abcdefghjkmnpqrs", kind: "codex.reasoning_summary.delta", observedAt: 1, sequence: 1 },
    { displayText: "the lease.", id: "event_0123456789abcdefghjkmnpqrt", kind: "codex.reasoning_summary.delta", observedAt: 2, sequence: 2 },
    { id: "event_0123456789abcdefghjkmnpqrv", kind: "codex.tool_activity.started", observedAt: 3, sequence: 3 },
    { displayText: "Lease is sound.", id: "event_0123456789abcdefghjkmnpqrw", kind: "codex.reasoning_summary.delta", observedAt: 4, sequence: 4 },
    { displayText: "Done.", id: "event_0123456789abcdefghjkmnpqrx", kind: "codex.assistant_message.delta", observedAt: 5, sequence: 5 },
  ];
  expect(taskTranscriptMessages(events)).toEqual([
    { id: "event_0123456789abcdefghjkmnpqrs", kind: "thinking", text: "Checking the lease." },
    { id: "event_0123456789abcdefghjkmnpqrw", kind: "thinking", text: "Lease is sound." },
    { id: "event_0123456789abcdefghjkmnpqrx", kind: "response", text: "Done." },
  ]);
});

test("property: transcript coalescing preserves every bounded public text delta exactly once", () => {
  const token = fc.record({
    kind: fc.constantFrom("thinking" as const, "response" as const, "boundary" as const),
    text: fc.string({ minLength: 1, maxLength: 80 }),
  });
  assertProperty(fc.property(fc.array(token, { maxLength: 120 }), (tokens) => {
    const events: TaskRunView["events"] = tokens.map((value, index) => {
      const identity = {
        id: `event_${String(index).padStart(26, "0")}`,
        observedAt: index,
        sequence: index + 1,
      };
      if (value.kind === "boundary") return { ...identity, kind: "codex.tool_activity.started" };
      return {
        ...identity,
        displayText: value.text,
        kind: value.kind === "thinking"
          ? "codex.reasoning_summary.delta" as const
          : "codex.assistant_message.delta" as const,
      };
    });
    const messages = taskTranscriptMessages(events);
    expect(messages.map(({ text }) => text).join("")).toBe(
      tokens.filter(({ kind }) => kind !== "boundary").map(({ text }) => text).join(""),
    );
    expect(messages.length).toBeLessThanOrEqual(
      tokens.filter(({ kind }) => kind !== "boundary").length,
    );
  }));
});
