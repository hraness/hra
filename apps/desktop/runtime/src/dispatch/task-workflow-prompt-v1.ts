export interface TaskWorkflowPromptV1Input {
  readonly taskKey: string;
  readonly title: string;
  readonly description: string;
}

const noDescription = "No additional description was provided.";

const workingInstructions = [
  "Make repository changes only in the current managed worktree.",
  "Use other explicitly admitted workspace roots only when the task requires them.",
  "Implement the task, run relevant checks, and leave the managed worktree ready for human review.",
].join(" ");

/** Render the common initial user message for local and cloud task dispatch. */
export function renderTaskWorkflowPromptV1(
  input: TaskWorkflowPromptV1Input,
): string {
  const description = input.description.trim();
  return [
    `Task key: ${input.taskKey}\nTask title: ${input.title}`,
    `Task description:\n${description.length === 0 ? noDescription : description}`,
    `Working instructions:\n${workingInstructions}`,
  ].join("\n\n");
}
