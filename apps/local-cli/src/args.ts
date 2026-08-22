export const localCliUsage = `usage:
  hra attention list --json
  hra pane list --json`;

export type LocalCliCommand = Readonly<{
  operation: "attention.list" | "panes.list";
}>;

export class LocalCliUsageError extends Error {
  constructor() {
    super("invalid local HRA command");
    this.name = "LocalCliUsageError";
  }
}

export function parseLocalCliArgs(value: readonly string[]): LocalCliCommand {
  if (
    value.length === 3 && value[0] === "attention" && value[1] === "list" &&
    value[2] === "--json"
  ) {
    return Object.freeze({ operation: "attention.list" });
  }
  if (
    value.length === 3 && value[0] === "pane" && value[1] === "list" &&
    value[2] === "--json"
  ) {
    return Object.freeze({ operation: "panes.list" });
  }
  throw new LocalCliUsageError();
}
