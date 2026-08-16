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

type CloudWorkspaceListClient = Pick<CloudWorkspaceClient, "listWorkspaces">;

interface InFlightRefresh {
  readonly scopeKey: string;
  readonly task: Promise<void>;
}

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
  #inFlight: InFlightRefresh | null = null;
  #scope: CloudWorkspaceSummaryScope | null = null;
  #summaries = new Map<string, WorkspaceSummary>();

  constructor(options: {
    readonly onInvalidated: (invalidation: PortableInvalidation) => void;
  }) {
    this.#onInvalidated = options.onInvalidated;
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
    this.#summaries.set(workspace.id, workspace);
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
    if (!this.isCurrent(scope)) return Promise.resolve();
    const requestedScopeKey = scopeKey(scope);
    if (this.#inFlight?.scopeKey === requestedScopeKey) {
      return this.#inFlight.task;
    }
    const task = this.#refresh(scope, client);
    this.#inFlight = { scopeKey: requestedScopeKey, task };
    void task.finally(() => {
      if (this.#inFlight?.task === task) this.#inFlight = null;
    }).catch(() => undefined);
    return task;
  }

  async #refresh(
    scope: CloudWorkspaceSummaryScope,
    client: CloudWorkspaceListClient,
  ): Promise<void> {
    let result: Awaited<ReturnType<CloudWorkspaceListClient["listWorkspaces"]>>;
    try {
      result = await client.listWorkspaces({ limit: 64 });
    } catch {
      return;
    }
    if (!result.ok || !this.isCurrent(scope)) return;
    const next = new Map<string, WorkspaceSummary>();
    for (const workspace of result.data.workspaces) {
      if (next.has(workspace.id)) return;
      next.set(workspace.id, workspace);
    }
    const invalidation = replacementInvalidation(this.#summaries, next);
    this.#summaries = next;
    if (invalidation !== null) this.#onInvalidated(invalidation);
  }
}
