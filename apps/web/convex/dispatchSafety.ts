import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { FAIL_CLOSED_TASK_DISPATCH_PHASES } from "./dispatchLaws";

export type TaskDispatchGuard =
  | { readonly kind: "clear" }
  | { readonly kind: "blocked" }
  | { readonly kind: "projection_mismatch" };

/**
 * A projection loaded after protected state has changed cannot be reported as
 * an ordinary domain failure: Convex would commit the already-written prefix.
 * Throwing makes the whole mutation retryable and, critically, transactional.
 */
export function requireProjectionAfterProtectedWrite<Value>(
  value: Value | null | undefined,
  boundary: string,
): Value {
  if (value === null || value === undefined) {
    throw new Error(`${boundary} projection is invalid after a protected write.`);
  }
  return value;
}

interface TaskDispatchGuardTask {
  readonly taskId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
}

interface TaskDispatchGuardRow extends TaskDispatchGuardTask {
  readonly phase: Doc<"taskDispatches">["phase"];
}

export function taskDispatchGuardFromRows(
  task: TaskDispatchGuardTask,
  rows: readonly TaskDispatchGuardRow[],
): TaskDispatchGuard {
  if (rows.length === 0) return { kind: "clear" };
  return rows.every(
    (row) =>
      row.organizationId === task.organizationId &&
      row.workspaceId === task.workspaceId &&
      row.taskId === task.taskId &&
      FAIL_CLOSED_TASK_DISPATCH_PHASES.some((phase) => phase === row.phase),
  )
    ? { kind: "blocked" }
    : { kind: "projection_mismatch" };
}

/**
 * Looks only through the bounded set of phases that may still own local
 * effects. Any matching dispatch holds task mutation and claim release closed;
 * a corrupt tenant tuple fails closed as a projection mismatch.
 */
export async function loadTaskDispatchGuard(
  ctx: Pick<MutationCtx, "db">,
  task: Pick<Doc<"tasks">, "_id" | "organizationId" | "workspaceId">,
): Promise<TaskDispatchGuard> {
  const rows = await Promise.all(
    FAIL_CLOSED_TASK_DISPATCH_PHASES.map(
      async (phase) =>
        await ctx.db
          .query("taskDispatches")
          .withIndex("by_workspace_task_phase", (query) =>
            query.eq("workspaceId", task.workspaceId).eq("taskId", task._id).eq("phase", phase),
          )
          .first(),
    ),
  );
  return taskDispatchGuardFromRows(
    {
      taskId: task._id,
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
    },
    rows
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map((row) => ({
        taskId: row.taskId,
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
        phase: row.phase,
      })),
  );
}
