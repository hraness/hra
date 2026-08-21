import { taskWorkspaceClientMutationIntentKindValues } from "@hraness/agent-tasks-domain";

const receiptOperationsByAttemptOperation = Object.freeze({
  "task.create": ["tasks.create", "tasks.create_and_dispatch"],
  "task.update": ["tasks.update"],
  "task.cancel": ["tasks.cancel"],
  "task.reopen": ["tasks.reopen"],
  "task.assign": ["tasks.assign"],
  "task.defer": ["tasks.defer"],
  "task.parent_set": ["tasks.parent.set"],
  "task.parent_clear": ["tasks.parent.clear"],
  "task.label_add": ["tasks.labels.add"],
  "task.label_remove": ["tasks.labels.remove"],
  "task.comment_add": ["tasks.comments.add"],
  "task.reference_add": ["tasks.references.add"],
  "task.reference_remove": ["tasks.references.remove"],
  "dependency.add": ["tasks.dependencies.add"],
  "dependency.remove": ["tasks.dependencies.remove"],
  "review.accept": ["tasks.accept"],
  "review.reject": ["tasks.reject"],
  "dispatch.stop": ["runs.stop"],
  "dispatch.retry": ["runs.retry"],
  "dispatch.resolve_ambiguity": ["runs.abandon_ambiguous"],
  "interaction.respond": ["dispatch.interaction.respond"],
} as const satisfies Readonly<
  Record<
    (typeof taskWorkspaceClientMutationIntentKindValues)[number],
    readonly string[]
  >
>);

export type ReceiptOperation =
  (typeof receiptOperationsByAttemptOperation)[
    keyof typeof receiptOperationsByAttemptOperation
  ][number];

export function receiptOperationsForAttempt(operation: string): readonly string[] {
  return taskWorkspaceClientMutationIntentKindValues.some((value) => value === operation)
    ? receiptOperationsByAttemptOperation[
        operation as keyof typeof receiptOperationsByAttemptOperation
      ]
    : [];
}

export type ReceiptAttemptOperation =
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "resolved"; operation: string }>;

export function attemptOperationForReceiptOperation(
  receiptOperation: string,
): ReceiptAttemptOperation {
  let resolved: string | null = null;
  for (
    const [attemptOperation, receiptOperations] of
      Object.entries(receiptOperationsByAttemptOperation)
  ) {
    if (!receiptOperations.some((operation) => operation === receiptOperation)) continue;
    if (resolved !== null && resolved !== attemptOperation) return { kind: "ambiguous" };
    resolved = attemptOperation;
  }
  return resolved === null
    ? { kind: "none" }
    : { kind: "resolved", operation: resolved };
}
