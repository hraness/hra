import type {
  HRAProjectionCursor,
  WorkspaceSummary,
} from "@hraness/agent-tasks-protocol";

import type { TaskAttentionObservation } from "./attention-projector";

type TaskWorkspaceListResult =
  | Readonly<{ ok: false }>
  | Readonly<{
      ok: true;
      data: Readonly<{
        workspaces: readonly WorkspaceSummary[];
        cursor: HRAProjectionCursor | null;
      }>;
    }>;

interface TaskWorkspaceListClient {
  listWorkspaces(input: Readonly<{
    limit: number;
    signal: AbortSignal;
  }>): Promise<TaskWorkspaceListResult>;
}

export interface ScopedTaskAttentionFallbackOptions<Scope> {
  readonly readLocal: (() => readonly WorkspaceSummary[]) | null;
  readonly cloudConfigured: boolean;
  readonly scope: Scope | null;
  readonly isScopeCurrent: (scope: Scope) => boolean;
  readonly readCached: (scope: Scope) => readonly WorkspaceSummary[];
}

export interface ScopedTaskAttentionOptions<Scope, Replacement>
  extends Omit<ScopedTaskAttentionFallbackOptions<Scope>, "cloudConfigured"> {
  readonly signal: AbortSignal;
  readonly client: TaskWorkspaceListClient | null;
  readonly beginFirstPageReplacement: (scope: Scope) => Replacement | null;
  readonly replaceFirstPage: (
    replacement: Replacement,
    workspaces: readonly WorkspaceSummary[],
  ) => boolean;
}

function mergedAttentionWorkspaces(
  local: readonly WorkspaceSummary[],
  cloud: readonly WorkspaceSummary[],
): readonly WorkspaceSummary[] {
  const merged = new Map<string, WorkspaceSummary>();
  for (const workspace of [...local, ...cloud]) {
    const current = merged.get(workspace.id);
    if (current === undefined || workspace.revision > current.revision) {
      merged.set(workspace.id, workspace);
    }
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function readLocalTaskAttention(
  readLocal: (() => readonly WorkspaceSummary[]) | null,
): readonly WorkspaceSummary[] | null {
  if (readLocal === null) return null;
  try {
    return readLocal();
  } catch {
    return null;
  }
}

/** Synchronous, scope-fenced evidence used when a cloud refresh hits its deadline. */
export function readScopedTaskAttentionFallback<Scope>(
  options: ScopedTaskAttentionFallbackOptions<Scope>,
): TaskAttentionObservation {
  const local = readLocalTaskAttention(options.readLocal);
  if (local === null) {
    return { completeness: "task_authority_unavailable", workspaces: [] };
  }
  if (!options.cloudConfigured) {
    return { completeness: "complete", workspaces: local };
  }
  const scope = options.scope;
  if (scope === null || !options.isScopeCurrent(scope)) {
    return { completeness: "cloud_unavailable", workspaces: local };
  }
  return {
    completeness: "cloud_unavailable",
    workspaces: mergedAttentionWorkspaces(local, options.readCached(scope)),
  };
}

/**
 * Joins local task authority with one exact cloud identity scope. Successful
 * first pages replace the scoped cache atomically; an aborted, stale, or older
 * completion can neither render nor repopulate cloud rows.
 */
export async function readScopedTaskAttention<Scope, Replacement>(
  options: ScopedTaskAttentionOptions<Scope, Replacement>,
): Promise<TaskAttentionObservation> {
  options.signal.throwIfAborted();
  const local = readLocalTaskAttention(options.readLocal);
  if (local === null) {
    return { completeness: "task_authority_unavailable", workspaces: [] };
  }
  options.signal.throwIfAborted();

  if (options.client === null) {
    return { completeness: "complete", workspaces: local };
  }
  const scope = options.scope;
  if (scope === null) {
    return { completeness: "cloud_unavailable", workspaces: local };
  }
  const replacement = options.beginFirstPageReplacement(scope);
  if (replacement === null) {
    return { completeness: "cloud_unavailable", workspaces: local };
  }

  try {
    const result = await options.client.listWorkspaces({
      limit: 64,
      signal: options.signal,
    });
    if (!options.isScopeCurrent(scope)) {
      return { completeness: "cloud_unavailable", workspaces: local };
    }
    const cached = () => mergedAttentionWorkspaces(local, options.readCached(scope));
    if (options.signal.aborted) {
      return { completeness: "cloud_unavailable", workspaces: cached() };
    }
    if (!result.ok) return { completeness: "cloud_unavailable", workspaces: cached() };
    if (!options.replaceFirstPage(replacement, result.data.workspaces)) {
      return { completeness: "cloud_unavailable", workspaces: cached() };
    }
    if (!options.isScopeCurrent(scope)) {
      return { completeness: "cloud_unavailable", workspaces: local };
    }
    return {
      completeness: result.data.cursor === null
        ? "complete"
        : "workspace_limit_reached",
      workspaces: mergedAttentionWorkspaces(local, result.data.workspaces),
    };
  } catch {
    return options.isScopeCurrent(scope)
      ? {
          completeness: "cloud_unavailable",
          workspaces: mergedAttentionWorkspaces(local, options.readCached(scope)),
        }
      : { completeness: "cloud_unavailable", workspaces: local };
  }
}
