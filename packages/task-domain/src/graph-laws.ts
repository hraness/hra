import type { TaskStatus } from "./task";

export const MAX_DIRECT_BLOCKERS = 100;
export const MAX_BLOCKING_DEPENDENTS = 500;
export const BLOCKER_PROPAGATION_READ_HEADROOM = 16;
export const MAX_BLOCKER_PROPAGATION_READS =
  2 * MAX_DIRECT_BLOCKERS + 2 * MAX_BLOCKING_DEPENDENTS + BLOCKER_PROPAGATION_READ_HEADROOM;
export const MAX_GRAPH_VISITED_TASKS = 500;
export const MAX_GRAPH_EXAMINED_EDGES = 10_000;
export const MAX_PARENT_DEPTH = 100;
export const WORKSPACE_ACTIVE_TASK_LIMIT = 10_000;
export const WORKSPACE_TOTAL_TASK_LIMIT = 100_000;

export function blockerPropagationReadBound(
  directBlockers: number,
  blockingDependents: number,
): number | null {
  if (
    !Number.isSafeInteger(directBlockers) ||
    directBlockers < 0 ||
    directBlockers > MAX_DIRECT_BLOCKERS ||
    !Number.isSafeInteger(blockingDependents) ||
    blockingDependents < 0 ||
    blockingDependents > MAX_BLOCKING_DEPENDENTS
  ) return null;
  return 2 * directBlockers + 2 * blockingDependents + BLOCKER_PROPAGATION_READ_HEADROOM;
}

export type TaskCancellationDisposition = "allowed" | "revision_conflict" | "terminal";

export function taskCancellationDisposition(input: {
  readonly currentRevision: number;
  readonly expectedRevision: number;
  readonly status: TaskStatus;
}): TaskCancellationDisposition {
  if (input.currentRevision !== input.expectedRevision) return "revision_conflict";
  return input.status === "done" || input.status === "cancelled" ? "terminal" : "allowed";
}

export function reviewAcceptanceAllowed(input: {
  readonly action: "accept" | "reject";
  readonly blockingCount: number;
}): boolean {
  return input.action !== "accept" || input.blockingCount === 0;
}

export function isCredentialFreeHttpsUrl(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export type GraphValidationResult =
  | { readonly kind: "valid"; readonly visitedTasks: number; readonly examinedEdges: number }
  | { readonly kind: "cycle"; readonly visitedTasks: number; readonly examinedEdges: number }
  | {
      readonly kind: "limit";
      readonly exhausted: "visited_tasks" | "examined_edges";
      readonly visitedTasks: number;
      readonly examinedEdges: number;
    };

/** An edge is prerequisite -> dependent. */
export function validateDependencyInsertion(
  dependentsByBlocker: ReadonlyMap<string, readonly string[]>,
  blocker: string,
  blocked: string,
  limits: { readonly visitedTasks: number; readonly examinedEdges: number } = {
    visitedTasks: MAX_GRAPH_VISITED_TASKS,
    examinedEdges: MAX_GRAPH_EXAMINED_EDGES,
  },
): GraphValidationResult {
  if (blocker === blocked) return { kind: "cycle", visitedTasks: 1, examinedEdges: 0 };
  const visited = new Set<string>([blocked]);
  const queue = [blocked];
  let examinedEdges = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const dependents = dependentsByBlocker.get(current) ?? [];
    for (const dependent of dependents) {
      examinedEdges += 1;
      if (examinedEdges > limits.examinedEdges) {
        return {
          kind: "limit",
          exhausted: "examined_edges",
          visitedTasks: visited.size,
          examinedEdges,
        };
      }
      if (dependent === blocker && !visited.has(dependent) && visited.size >= limits.visitedTasks) {
        return {
          kind: "limit",
          exhausted: "visited_tasks",
          visitedTasks: visited.size,
          examinedEdges,
        };
      }
      if (dependent === blocker) {
        return { kind: "cycle", visitedTasks: visited.size, examinedEdges };
      }
      if (visited.has(dependent)) continue;
      if (visited.size >= limits.visitedTasks) {
        return {
          kind: "limit",
          exhausted: "visited_tasks",
          visitedTasks: visited.size,
          examinedEdges,
        };
      }
      visited.add(dependent);
      queue.push(dependent);
    }
  }
  return { kind: "valid", visitedTasks: visited.size, examinedEdges };
}

export type ParentValidationResult =
  | { readonly kind: "valid"; readonly depth: number }
  | { readonly kind: "cycle"; readonly depth: number }
  | { readonly kind: "limit"; readonly depth: number };

export function validateParentInsertion(
  parentByTask: ReadonlyMap<string, string | undefined>,
  task: string,
  proposedParent: string,
  maximumDepth = MAX_PARENT_DEPTH,
): ParentValidationResult {
  if (task === proposedParent) return { kind: "cycle", depth: 1 };
  let current: string | undefined = proposedParent;
  let depth = 0;
  const visited = new Set<string>();
  while (current !== undefined) {
    depth += 1;
    if (current === task || visited.has(current)) return { kind: "cycle", depth };
    if (depth > maximumDepth) return { kind: "limit", depth };
    visited.add(current);
    current = parentByTask.get(current);
  }
  return { kind: "valid", depth };
}

export type BlockerLifecycle = "open" | "in_progress" | "in_review" | "done" | "cancelled";

export function blockerContribution(status: BlockerLifecycle): {
  readonly unresolved: number;
  readonly cancelled: number;
} {
  if (status === "done") return { unresolved: 0, cancelled: 0 };
  if (status === "cancelled") return { unresolved: 0, cancelled: 1 };
  return { unresolved: 1, cancelled: 0 };
}

export function transitionBlockerCounters(
  counters: { readonly unresolved: number; readonly cancelled: number },
  previous: BlockerLifecycle,
  next: BlockerLifecycle,
): { readonly unresolved: number; readonly cancelled: number } {
  const before = blockerContribution(previous);
  const after = blockerContribution(next);
  return {
    unresolved: counters.unresolved - before.unresolved + after.unresolved,
    cancelled: counters.cancelled - before.cancelled + after.cancelled,
  };
}

export function derivedReady(input: {
  readonly status: BlockerLifecycle;
  readonly availableAt: number;
  readonly now: number;
  readonly unresolved: number;
  readonly cancelled: number;
}): boolean {
  return input.status === "open" &&
    input.availableAt <= input.now &&
    input.unresolved === 0 &&
    input.cancelled === 0;
}

export function derivedNeedsAttention(input: {
  readonly status: BlockerLifecycle;
  readonly unresolved: number;
  readonly cancelled: number;
}): boolean {
  return input.cancelled > 0 || (input.status === "done" && input.unresolved > 0);
}

export type SubmissionLifecycle = "pending" | "accepted" | "rejected" | "cancelled";
export type SubmissionTerminalCommand = "accept" | "reject" | "cancel";

export function transitionSubmissionLifecycle(
  state: SubmissionLifecycle,
  command: SubmissionTerminalCommand,
): SubmissionLifecycle | null {
  if (state !== "pending") return null;
  if (command === "accept") return "accepted";
  if (command === "reject") return "rejected";
  return "cancelled";
}

export function reviewActorAllowed(input: {
  readonly submittedByAgentId: string;
  readonly reviewerAgentId?: string;
}): boolean {
  return input.reviewerAgentId === undefined ||
    input.reviewerAgentId !== input.submittedByAgentId;
}
