import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { expireOpenInteractions } from "./dispatchInteractions";
import { appendTaskEvent } from "./events";
import { advanceWorkspaceProjectionById } from "./hraProjection";
import {
  activeClaimMatchesTask,
  ensureCounterProjection,
  queueTaskClaimRepair,
} from "./workGraph";

const RECONCILIATION_REQUEST_ID = "req_00000000000000000000000000";

export type BoundTaskDispatch = Extract<Doc<"taskDispatches">, { runnerId: unknown }>;

/**
 * Recognizes the intentional gap between the authoritative task submission
 * transaction and the runner's subsequent terminal lifecycle event. This is
 * not a generic terminal check: every durable task/claim coordinate still has
 * to match the exact dispatch attempt.
 */
export function submittedTaskClaimMatchesDispatch(
  dispatch: Readonly<{
    organizationId: unknown;
    workspaceId: unknown;
    taskId: unknown;
    taskClaimPublicId: unknown;
    claimFence: unknown;
    leaseGeneration: unknown;
  }>,
  task: Readonly<{
    _id: unknown;
    organizationId: unknown;
    workspaceId: unknown;
    status: string;
    currentClaim?: unknown;
  }> | null,
  claim: Readonly<{
    organizationId: unknown;
    workspaceId: unknown;
    taskId: unknown;
    publicId: unknown;
    fence: unknown;
    leaseGeneration: unknown;
    state: string;
  }> | null,
): boolean {
  return task !== null && claim !== null && (
    task.organizationId === dispatch.organizationId &&
    task.workspaceId === dispatch.workspaceId &&
    task._id === dispatch.taskId &&
    task.status === "in_review" &&
    task.currentClaim === undefined &&
    claim.organizationId === dispatch.organizationId &&
    claim.workspaceId === dispatch.workspaceId &&
    claim.taskId === task._id &&
    claim.publicId === dispatch.taskClaimPublicId &&
    claim.fence === dispatch.claimFence &&
    claim.leaseGeneration === dispatch.leaseGeneration &&
    claim.state === "submitted"
  );
}

/**
 * Returns a pre-side-effect lease to the queue while atomically releasing its
 * task claim. Any uncertainty fails closed so the caller can quarantine it.
 */
export async function requeueLeasedDispatch(
  ctx: MutationCtx,
  dispatch: BoundTaskDispatch,
  now: number,
): Promise<boolean> {
  const [task, claim] = await Promise.all([
    ctx.db.get(dispatch.taskId),
    ctx.db.get(dispatch.taskClaimId),
  ]);
  if (
    task === null ||
    claim === null ||
    dispatch.phase !== "leased" ||
    task.organizationId !== dispatch.organizationId ||
    task.workspaceId !== dispatch.workspaceId ||
    claim.organizationId !== dispatch.organizationId ||
    claim.workspaceId !== dispatch.workspaceId ||
    claim.taskId !== task._id ||
    claim.publicId !== dispatch.taskClaimPublicId ||
    claim.fence !== dispatch.claimFence ||
    claim.leaseGeneration !== dispatch.leaseGeneration ||
    !activeClaimMatchesTask(task, claim)
  ) {
    if (task !== null) await queueTaskClaimRepair(ctx, task, now);
    return false;
  }
  const projection = await ensureCounterProjection(
    ctx,
    task,
    now,
    RECONCILIATION_REQUEST_ID,
  );
  if (!projection.ok) return false;
  const ready = task.availableAt <= now &&
    projection.actual.unresolved === 0 &&
    projection.actual.cancelled === 0;
  const nextRevision = task.revision + 1;
  await ctx.db.patch(claim._id, {
    state: "released",
    endedAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(task._id, {
    status: "open",
    currentClaim: undefined,
    isReady: ready,
    ...(ready ? { readySince: now } : { readySince: undefined }),
    revision: nextRevision,
    updatedAt: now,
  });
  await ctx.db.replace(dispatch._id, {
    organizationId: dispatch.organizationId,
    workspaceId: dispatch.workspaceId,
    taskId: dispatch.taskId,
    repositoryId: dispatch.repositoryId,
    publicId: dispatch.publicId,
    taskKey: dispatch.taskKey,
    repositoryPublicId: dispatch.repositoryPublicId,
    acceptedThroughSequence: dispatch.acceptedThroughSequence,
    queuedByUserId: dispatch.queuedByUserId,
    phase: "queued",
    desiredState: "run",
    queuedTaskRevision: nextRevision,
    queuedClaimFence: task.claimFence,
    ...(dispatch.retryOfDispatchId === undefined
      ? {}
      : { retryOfDispatchId: dispatch.retryOfDispatchId }),
    queuedAt: now,
    candidateOrderAt: now,
    createdAt: dispatch.createdAt,
    updatedAt: now,
  });
  await appendTaskEvent(ctx, {
    organizationId: task.organizationId,
    workspaceId: task.workspaceId,
    taskId: task._id,
    taskPublicId: task.publicId,
    taskRevision: nextRevision,
    type: "task.claim_released",
    actor: { kind: "system", jobKind: "reconciliation", sourceId: dispatch.publicId },
    command: { kind: "system", jobKind: "reconciliation" },
    payload: { fence: claim.fence },
    now,
  });
  return true;
}

/**
 * The task submission transaction is authoritative proof that this exact run
 * finished. This closes the crash window between task submission and the
 * runner's terminal lifecycle event without asking a human to guess.
 */
export async function reconcileSubmittedDispatch(
  ctx: MutationCtx,
  dispatch: BoundTaskDispatch,
  now: number,
): Promise<boolean> {
  const [task, claim] = await Promise.all([
    ctx.db.get(dispatch.taskId),
    ctx.db.get(dispatch.taskClaimId),
  ]);
  if (!submittedTaskClaimMatchesDispatch(dispatch, task, claim)) {
    return false;
  }
  const sequence = dispatch.acceptedThroughSequence + 1;
  await ctx.db.insert("taskRunEvents", {
    organizationId: dispatch.organizationId,
    workspaceId: dispatch.workspaceId,
    dispatchId: dispatch._id,
    publicId: randomRunEventId(),
    sequence,
    kind: "run.submitted",
    observedAt: now,
  });
  await ctx.db.patch(dispatch._id, {
    acceptedThroughSequence: sequence,
    phase: "submitted",
    terminalAt: now,
    updatedAt: now,
  });
  await expireOpenInteractions(ctx, dispatch._id, now);
  await advanceWorkspaceProjectionById(ctx, dispatch.workspaceId, now);
  return true;
}

function randomRunEventId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const body = [...bytes].map((byte) => byte.toString(36).padStart(2, "0")).join("");
  return `event_${body}`;
}
