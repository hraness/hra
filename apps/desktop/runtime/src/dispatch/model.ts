import { z } from "@hra-internal/schema";

export const dispatchStageSchema = z.enum([
  "reserved",
  "worktree_ready",
  "thread_starting",
  "thread_ready",
  "turn_starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "lease_lost",
  "ambiguous",
]);

export type DispatchStage = z.infer<typeof dispatchStageSchema>;

export const publicRunStatusEventKindSchema = z.enum([
  "run.queued",
  "worktree.preparing",
  "worktree.ready",
  "codex.starting",
  "codex.running",
  "codex.planning",
  "codex.editing",
  "codex.testing",
  "codex.waiting_for_approval",
  "codex.waiting_for_input",
  "run.submitted",
  "run.failed",
  "run.cancelled",
  "run.lease_lost",
  "codex.tool_activity.started",
  "codex.tool_activity.completed",
]);
export const publicRunTextEventKindSchema = z.enum([
  "codex.reasoning_summary.delta",
  "codex.assistant_message.delta",
]);
export const publicRunEventKindSchema = z.enum([
  ...publicRunStatusEventKindSchema.options,
  ...publicRunTextEventKindSchema.options,
]);

export type PublicRunEventKind = z.infer<typeof publicRunEventKindSchema>;
export type PublicRunStatusEventKind = z.infer<typeof publicRunStatusEventKindSchema>;
export type PublicRunTextEventKind = z.infer<typeof publicRunTextEventKindSchema>;

const publicSummaryByKind = {
  "run.queued": "Queued in HRA",
  "worktree.preparing": "Preparing execution workspace",
  "worktree.ready": "Execution workspace ready",
  "codex.starting": "Starting Codex",
  "codex.running": "Codex is working",
  "codex.planning": "Planning the change",
  "codex.editing": "Editing the workspace",
  "codex.testing": "Running checks",
  "codex.waiting_for_approval": "Waiting for approval in HRA",
  "codex.waiting_for_input": "Waiting for input in HRA",
  "run.submitted": "Submitted for review",
  "run.failed": "Run needs attention",
  "run.cancelled": "Run cancelled",
  "run.lease_lost": "Runner connection was lost",
  "codex.tool_activity.started": "Calling tools",
  "codex.tool_activity.completed": "Finished calling tools",
  "codex.reasoning_summary.delta": "Thinking",
  "codex.assistant_message.delta": "Responding",
} as const satisfies Record<PublicRunEventKind, string>;

export const terminalDispatchStages: ReadonlySet<DispatchStage> = new Set([
  "completed",
  "failed",
  "cancelled",
  "lease_lost",
]);

const allowedSuccessors = {
  reserved: ["worktree_ready", "failed", "cancelled", "lease_lost", "ambiguous"],
  worktree_ready: ["thread_starting", "failed", "cancelled", "lease_lost", "ambiguous"],
  thread_starting: ["thread_ready", "ambiguous", "failed", "cancelled", "lease_lost"],
  thread_ready: ["turn_starting", "failed", "cancelled", "lease_lost", "ambiguous"],
  turn_starting: ["running", "ambiguous", "failed", "cancelled", "lease_lost"],
  running: ["waiting", "completed", "failed", "cancelled", "lease_lost", "ambiguous"],
  waiting: ["running", "completed", "failed", "cancelled", "lease_lost", "ambiguous"],
  ambiguous: ["worktree_ready", "thread_ready", "running", "failed", "cancelled", "lease_lost"],
  completed: [],
  failed: [],
  cancelled: [],
  lease_lost: [],
} as const satisfies Record<DispatchStage, readonly DispatchStage[]>;

export function canTransitionDispatch(from: DispatchStage, to: DispatchStage): boolean {
  return (allowedSuccessors[from] as readonly DispatchStage[]).includes(to);
}

export function publicRunEvent(kind: PublicRunEventKind): Readonly<{
  kind: PublicRunEventKind;
  summary: string;
}> {
  return { kind, summary: publicSummaryByKind[kind] };
}

export function stageForPublicEvent(kind: PublicRunEventKind): DispatchStage | null {
  switch (kind) {
    case "run.queued":
    case "worktree.preparing":
      return "reserved";
    case "worktree.ready":
      return "worktree_ready";
    case "codex.starting":
      return "thread_starting";
    case "codex.running":
    case "codex.planning":
    case "codex.editing":
    case "codex.testing":
    case "codex.tool_activity.started":
    case "codex.tool_activity.completed":
    case "codex.reasoning_summary.delta":
    case "codex.assistant_message.delta":
      return "running";
    case "codex.waiting_for_approval":
    case "codex.waiting_for_input":
      return "waiting";
    case "run.submitted":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    case "run.lease_lost":
      return "lease_lost";
  }
}
