import {
  type PortableInvalidation,
  type WorkspaceSummary,
} from "@hraness/agent-tasks-protocol";

import type { CloudWorkspaceClient } from "./http-client";

export interface CloudWorkspaceSummaryScope {
  readonly credentialGeneration: number;
  readonly organizationId: string | null;
  readonly userId: string;
}

export interface CloudWorkspaceSummaryReplacement {
  readonly scopeEpoch: number;
  readonly ordinal: number;
}

type CloudWorkspaceListClient = Pick<CloudWorkspaceClient, "listWorkspaces">;

function scopeKey(scope: CloudWorkspaceSummaryScope): string {
  return JSON.stringify([
    scope.credentialGeneration,
    scope.userId,
    scope.organizationId,
  ]);
}

function sameWorkspace(
  left: WorkspaceSummary,
  right: WorkspaceSummary,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function removedWorkspaceInvalidation(
  workspace: WorkspaceSummary,
): PortableInvalidation {
  return {
    workspaceId: workspace.id,
    projectionRevision: workspace.revision === Number.MAX_SAFE_INTEGER
      ? workspace.revision
      : workspace.revision + 1,
    scope: "workspace",
  };
}

function replacementInvalidation(
  previous: ReadonlyMap<string, WorkspaceSummary>,
  next: ReadonlyMap<string, WorkspaceSummary>,
): PortableInvalidation | null {
  for (const workspace of next.values()) {
    const prior = previous.get(workspace.id);
    if (prior === undefined || !sameWorkspace(prior, workspace)) {
      return {
        workspaceId: workspace.id,
        projectionRevision: workspace.revision,
        scope: "workspace",
      };
    }
  }
  for (const workspace of previous.values()) {
    if (!next.has(workspace.id)) {
      return removedWorkspaceInvalidation(workspace);
    }
  }
  return null;
}

/**
 * An in-memory, account-fenced first-page cache. The cache is never authority
 * on its own: every read and write supplies the current user, organization,
 * and credential generation. A slow completion from a replaced scope is
 * discarded, while a refresh for the new scope may begin immediately.
 */
export class CloudWorkspaceSummaryCache {
  readonly #onInvalidated: (invalidation: PortableInvalidation) => void;
  readonly #activeRefreshes = new Set<Promise<void>>();
  readonly #inFlightByScope = new Map<string, Promise<void>>();
  #admissionClosed = false;
  #scope: CloudWorkspaceSummaryScope | null = null;
  #summaries = new Map<string, WorkspaceSummary>();
  #scopeEpoch = 0;
  #nextReplacementOrdinal = 0;
  #committedReplacementOrdinal = 0;

  constructor(options: {
    readonly onInvalidated: (invalidation: PortableInvalidation) => void;
  }) {
    this.#onInvalidated = options.onInvalidated;
  }

  closeAdmission(): void {
    this.#admissionClosed = true;
  }

  async settled(): Promise<void> {
    for (;;) {
      const tasks = [...this.#activeRefreshes];
      if (tasks.length === 0) return;
      await Promise.allSettled(tasks);
      // Registered finalizers clear task identities in a following microtask.
      await Promise.resolve();
    }
  }

  replaceScope(
    scope: CloudWorkspaceSummaryScope | null,
    options: Readonly<{ invalidatePrevious?: boolean }> = {},
  ): boolean {
    const currentKey = this.#scope === null ? null : scopeKey(this.#scope);
    const nextKey = scope === null ? null : scopeKey(scope);
    if (currentKey === nextKey) return false;
    const removed = this.#summaries.values().next().value;
    this.#scope = scope === null ? null : { ...scope };
    this.#summaries.clear();
    this.#scopeEpoch += 1;
    this.#committedReplacementOrdinal = ++this.#nextReplacementOrdinal;
    if (
      removed !== undefined &&
      options.invalidatePrevious !== false
    ) {
      this.#onInvalidated(removedWorkspaceInvalidation(removed));
    }
    return true;
  }

  isCurrent(scope: CloudWorkspaceSummaryScope): boolean {
    return this.#scope !== null &&
      scopeKey(this.#scope) === scopeKey(scope);
  }

  summaries(
    scope: CloudWorkspaceSummaryScope,
  ): readonly WorkspaceSummary[] {
    if (!this.isCurrent(scope)) return [];
    return [...this.#summaries.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }

  has(scope: CloudWorkspaceSummaryScope, workspaceId: string): boolean {
    return this.isCurrent(scope) && this.#summaries.has(workspaceId);
  }

  remember(
    scope: CloudWorkspaceSummaryScope,
    workspace: WorkspaceSummary,
  ): boolean {
    if (!this.isCurrent(scope)) return false;
    const current = this.#summaries.get(workspace.id);
    if (current !== undefined && current.revision > workspace.revision) {
      return false;
    }
    this.#summaries.set(workspace.id, workspace);
    // Fence any first-page read that began before this more targeted update.
    this.#committedReplacementOrdinal = ++this.#nextReplacementOrdinal;
    return true;
  }

  beginFirstPageReplacement(
    scope: CloudWorkspaceSummaryScope,
  ): CloudWorkspaceSummaryReplacement | null {
    if (this.#admissionClosed || !this.isCurrent(scope)) return null;
    return Object.freeze({
      scopeEpoch: this.#scopeEpoch,
      ordinal: ++this.#nextReplacementOrdinal,
    });
  }

  replaceFirstPage(
    replacement: CloudWorkspaceSummaryReplacement,
    workspaces: readonly WorkspaceSummary[],
  ): boolean {
    if (
      this.#scope === null ||
      replacement.scopeEpoch !== this.#scopeEpoch ||
      replacement.ordinal <= this.#committedReplacementOrdinal
    ) return false;
    const next = new Map<string, WorkspaceSummary>();
    for (const workspace of workspaces) {
      if (next.has(workspace.id)) return false;
      const current = this.#summaries.get(workspace.id);
      if (current !== undefined && current.revision > workspace.revision) {
        return false;
      }
      next.set(workspace.id, workspace);
    }
    const invalidation = replacementInvalidation(this.#summaries, next);
    this.#summaries = next;
    this.#committedReplacementOrdinal = replacement.ordinal;
    if (invalidation !== null) this.#onInvalidated(invalidation);
    return true;
  }

  listAndRefresh(input: {
    readonly client: CloudWorkspaceListClient | null;
    readonly local: readonly WorkspaceSummary[];
    readonly scope: CloudWorkspaceSummaryScope | null;
  }): WorkspaceSummary[] {
    if (input.client !== null && input.scope !== null) {
      void this.refresh(input.scope, input.client).catch(() => undefined);
    }
    const merged = new Map<string, WorkspaceSummary>();
    for (const workspace of input.local) merged.set(workspace.id, workspace);
    const cached = input.scope === null ? [] : this.summaries(input.scope);
    for (const workspace of cached) {
      const existing = merged.get(workspace.id);
      if (
        (
          existing === undefined ||
          existing.authority.kind === "cloud"
        ) &&
        (existing !== undefined || merged.size < 64)
      ) {
        merged.set(workspace.id, workspace);
      }
    }
    return [...merged.values()].slice(0, 64);
  }

  refresh(
    scope: CloudWorkspaceSummaryScope,
    client: CloudWorkspaceListClient,
  ): Promise<void> {
    if (this.#admissionClosed || !this.isCurrent(scope)) {
      return Promise.resolve();
    }
    const requestedScopeKey = scopeKey(scope);
    const existing = this.#inFlightByScope.get(requestedScopeKey);
    if (existing !== undefined) return existing;
    const task = this.#refresh(scope, client);
    this.#inFlightByScope.set(requestedScopeKey, task);
    this.#activeRefreshes.add(task);
    void task.finally(() => {
      if (this.#inFlightByScope.get(requestedScopeKey) === task) {
        this.#inFlightByScope.delete(requestedScopeKey);
      }
      this.#activeRefreshes.delete(task);
    }).catch(() => undefined);
    return task;
  }

  async #refresh(
    scope: CloudWorkspaceSummaryScope,
    client: CloudWorkspaceListClient,
  ): Promise<void> {
    const replacement = this.beginFirstPageReplacement(scope);
    if (replacement === null) return;
    let result: Awaited<ReturnType<CloudWorkspaceListClient["listWorkspaces"]>>;
    try {
      result = await client.listWorkspaces({ limit: 64 });
    } catch {
      return;
    }
    if (!result.ok || !this.isCurrent(scope)) return;
    this.replaceFirstPage(replacement, result.data.workspaces);
  }
}
