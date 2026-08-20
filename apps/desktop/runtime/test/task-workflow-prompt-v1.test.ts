import { describe, expect, test } from "bun:test";

import { renderTaskWorkflowPromptV1 } from "../src/dispatch/task-workflow-prompt-v1";

const workingInstructions = "Make repository changes only in the current managed worktree. Use other explicitly admitted workspace roots only when the task requires them. Implement the task, run relevant checks, and leave the managed worktree ready for human review.";

describe("task workflow prompt v1", () => {
  test("labels task fields and trims only the multiline description", () => {
    const input = {
      taskKey: "OPS-0000001",
      title: "  Preserve the validated title  ",
      description: "\n  First line.\n\nSecond line.  \n",
    };
    const expected = [
      "Task key: OPS-0000001\nTask title:   Preserve the validated title  ",
      "Task description:\nFirst line.\n\nSecond line.",
      `Working instructions:\n${workingInstructions}`,
    ].join("\n\n");

    expect(renderTaskWorkflowPromptV1(input)).toBe(expected);
    expect(renderTaskWorkflowPromptV1(input)).toBe(expected);
  });

  test("uses an explicit fallback for a whitespace-only description", () => {
    expect(renderTaskWorkflowPromptV1({
      taskKey: "OPS-0000002",
      title: "Describe the task",
      description: " \n\t ",
    })).toBe([
      "Task key: OPS-0000002\nTask title: Describe the task",
      "Task description:\nNo additional description was provided.",
      `Working instructions:\n${workingInstructions}`,
    ].join("\n\n"));
  });
});
