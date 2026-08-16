import {
  taskDomain,
  type PortableInvalidation,
} from "@hraness/agent-tasks-protocol";

export const LOCAL_TASK_DISPLAY_CHANGE_WINDOW_MS = 16;
export const LOCAL_TASK_CHANGE_MAX_RETRY_DELAY_MS = 1_024;
export const MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES = 128;
export const MAX_TRACKED_LOCAL_TASK_CHANGE_HEADS = 4_096;
/** LocalTaskStore admits at most 64 live workspaces. */
export const MAX_PENDING_LOCAL_TASK_WORKSPACE_FALLBACKS = 64;
const MAX_LOCAL_TASK_CHANGE_RETRY_EXPONENT = 6;

export type PortableTaskChangeRecord = Extract<
  PortableInvalidation,
  { readonly scope: "task_change" }
>;

type ScheduledHandle = object | number;

export interface LocalTaskChangeCoordinatorOptions {
  readonly cancel?: (handle: ScheduledHandle) => void;
  readonly onChange: (change: PortableInvalidation) => void;
  readonly schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ScheduledHandle;
}

type PendingChange = Readonly<{
  change: PortableTaskChangeRecord;
  failedAttempts: number;
  immediate: boolean;
  ordinal: number;
}>;

type WorkspaceFallback = Readonly<{
  failedAttempts: number;
  invalidation: Extract<PortableInvalidation, { readonly scope: "workspace" }>;
  ordinal: number;
}>;

function changeKey(change: PortableTaskChangeRecord): string {
  return `${change.workspaceId}\0${change.taskId}\0${change.runId}`;
}

export function localTaskChangeDelivery(
  changeKind: PortableTaskChangeRecord["changeKind"],
): "coalesce_display" | "immediate" {
  switch (changeKind) {
    case "run.display_changed":
      return "coalesce_display";
    case "run.admitted":
    case "run.event_appended":
    case "run.interaction_changed":
    case "run.phase_changed":
    case "task.submitted":
      return "immediate";
  }
}

function hasWorkspaceSummary(change: PortableTaskChangeRecord): boolean {
  return change.affectedProjections.some(
    ({ projection }) => projection === "workspace_summary",
  );
}

function allowsWorkspaceSummary(
  changeKind: PortableTaskChangeRecord["changeKind"],
): boolean {
  switch (changeKind) {
    case "run.admitted":
    case "run.event_appended":
    case "task.submitted":
      return true;
    case "run.display_changed":
    case "run.interaction_changed":
    case "run.phase_changed":
      return false;
  }
}

function mergedAffectedProjections(
  first: PortableTaskChangeRecord,
  second: PortableTaskChangeRecord,
): PortableTaskChangeRecord["affectedProjections"] {
  const includeWorkspaceSummary = hasWorkspaceSummary(first) ||
    hasWorkspaceSummary(second);
  return [
    ...(includeWorkspaceSummary
      ? [{ projection: "workspace_summary" as const }]
      : []),
    {
      projection: "task_list" as const,
      views: [...taskDomain.taskWorkspaceViewValues],
    },
    { projection: "task_detail" as const },
  ] as PortableTaskChangeRecord["affectedProjections"];
}

export function mergePortableTaskChanges(
  first: PortableTaskChangeRecord,
  second: PortableTaskChangeRecord,
): PortableTaskChangeRecord {
  if (
    first.workspaceId !== second.workspaceId ||
    first.taskId !== second.taskId ||
    first.runId !== second.runId
  ) {
    throw new TypeError("Only one task/run identity can be coalesced");
  }
  const affectedProjections = mergedAffectedProjections(first, second);
  const includesWorkspaceSummary = affectedProjections[0]?.projection ===
    "workspace_summary";
  const kindSource = includesWorkspaceSummary &&
      !allowsWorkspaceSummary(second.changeKind)
    ? first
    : second;
  return taskDomain.portableTaskChangeRecordSchema.parse({
    workspaceId: kindSource.workspaceId,
    projectionRevision: Math.max(
      first.projectionRevision,
      second.projectionRevision,
    ),
    scope: "task_change",
    taskId: kindSource.taskId,
    runId: kindSource.runId,
    changeKind: kindSource.changeKind,
    affectedProjections,
  });
}

/**
 * Batches only display-only task changes for one bounded render interval.
 * Every semantic, terminal, error, admission, interaction, and submission
 * change bypasses the window and subsumes any older pending display hint for
 * the same task/run identity.
 */
export class LocalTaskChangeCoordinator {
  readonly #cancel: (handle: ScheduledHandle) => void;
  readonly #onChange: (change: PortableInvalidation) => void;
  readonly #deliveringKeys = new Set<string>();
  readonly #deliveringWorkspaceIds = new Set<string>();
  readonly #fallbacks = new Map<string, WorkspaceFallback>();
  readonly #inFlightHeads = new Map<string, number>();
  readonly #inFlightWorkspaceHeads = new Map<string, number>();
  readonly #pending = new Map<string, PendingChange>();
  readonly #publishedHeads = new Map<string, number>();
  readonly #publishedWorkspaceHeads = new Map<string, number>();
  readonly #schedule: (
    callback: () => void,
    delayMs: number,
  ) => ScheduledHandle;
  #closed = false;
  #nextOrdinal = 1;
  #scheduled: ScheduledHandle | null = null;

  constructor(options: LocalTaskChangeCoordinatorOptions) {
    this.#onChange = options.onChange;
    this.#schedule = options.schedule ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  accept(value: PortableTaskChangeRecord): void {
    if (this.#closed) {
      throw new Error("Local task change coordinator is closed");
    }
    const change = taskDomain.portableTaskChangeRecordSchema.parse(value);
    const key = changeKey(change);
    const deliveredWorkspaceHead = Math.max(
      this.#publishedWorkspaceHeads.get(change.workspaceId) ?? 0,
      this.#inFlightWorkspaceHeads.get(change.workspaceId) ?? 0,
    );
    if (change.projectionRevision <= deliveredWorkspaceHead) return;
    if (this.#fallbacks.has(change.workspaceId)) {
      this.#retainWorkspaceFallback(change);
      this.#ensureTimer();
      return;
    }
    const deliveredHead = Math.max(
      this.#publishedHeads.get(key) ?? 0,
      this.#inFlightHeads.get(key) ?? 0,
    );
    if (change.projectionRevision <= deliveredHead) return;

    const pending = this.#pending.get(key);
    const immediate = localTaskChangeDelivery(change.changeKind) ===
      "immediate";
    if (pending !== undefined) {
      if (change.projectionRevision < pending.change.projectionRevision) return;
      this.#pending.set(key, {
        change: mergePortableTaskChanges(pending.change, change),
        failedAttempts: pending.failedAttempts,
        immediate: pending.immediate || immediate,
        ordinal: pending.ordinal,
      });
    } else {
      if (
        this.#pending.size + this.#inFlightHeads.size >=
          MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES
      ) {
        try {
          this.#flushOldest();
        } catch {
          // The accepted hint remains pending. Capacity fallback below retains
          // this post-commit change without reporting the mutation as failed.
        }
      }
      if (
        this.#pending.size + this.#inFlightHeads.size >=
          MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES
      ) {
        this.#retainWorkspaceFallback(change);
        this.#ensureTimer();
        return;
      }
      this.#pending.set(key, {
        change,
        failedAttempts: 0,
        immediate,
        ordinal: this.#allocateOrdinal(),
      });
    }

    const accepted = this.#pending.get(key);
    if (accepted?.immediate === true) {
      try {
        this.#deliverKey(key);
      } catch {
        // Publication is a post-commit hint. Retain and retry it internally so
        // a durable mutation is never misreported to its caller as uncommitted.
      } finally {
        this.#settleTimer();
      }
      return;
    }
    this.#ensureTimer();
  }

  flush(): void {
    if (this.#scheduled !== null) {
      this.#cancel(this.#scheduled);
      this.#scheduled = null;
    }
    const pending = [
      ...[...this.#pending.entries()].map(([key, entry]) => ({
        key,
        kind: "task" as const,
        ordinal: entry.ordinal,
      })),
      ...[...this.#fallbacks.entries()].map(([workspaceId, entry]) => ({
        key: workspaceId,
        kind: "workspace" as const,
        ordinal: entry.ordinal,
      })),
    ].sort((left, right) => left.ordinal - right.ordinal);
    let failed = false;
    let firstError: unknown;
    for (const entry of pending) {
      try {
        if (entry.kind === "task") this.#deliverKey(entry.key);
        else this.#deliverWorkspace(entry.key);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    this.#settleTimer();
    if (failed) throw firstError;
  }

  close(): void {
    if (this.#closed) return;
    let failed = false;
    let firstError: unknown;
    try {
      this.flush();
      if (
        this.#pending.size !== 0 ||
        this.#fallbacks.size !== 0 ||
        this.#inFlightHeads.size !== 0 ||
        this.#inFlightWorkspaceHeads.size !== 0
      ) {
        failed = true;
        firstError = new Error(
          "Local task change coordinator received changes while closing",
        );
      }
    } catch (error) {
      failed = true;
      firstError = error;
    } finally {
      this.#closed = true;
      if (this.#scheduled !== null) {
        this.#cancel(this.#scheduled);
        this.#scheduled = null;
      }
    }
    if (failed) throw firstError;
  }

  #allocateOrdinal(): number {
    if (this.#nextOrdinal < Number.MAX_SAFE_INTEGER) {
      const ordinal = this.#nextOrdinal;
      this.#nextOrdinal += 1;
      return ordinal;
    }
    const ordered = [
      ...[...this.#pending.entries()].map(([key, entry]) => ({
        entry,
        key,
        kind: "task" as const,
      })),
      ...[...this.#fallbacks.entries()].map(([key, entry]) => ({
        entry,
        key,
        kind: "workspace" as const,
      })),
    ].sort((left, right) => left.entry.ordinal - right.entry.ordinal);
    let ordinal = 1;
    for (const item of ordered) {
      if (item.kind === "task") {
        this.#pending.set(item.key, { ...item.entry, ordinal });
      } else {
        this.#fallbacks.set(item.key, { ...item.entry, ordinal });
      }
      ordinal += 1;
    }
    this.#nextOrdinal = ordinal + 1;
    return ordinal;
  }

  #ensureTimer(): void {
    if (
      this.#closed ||
      (this.#pending.size === 0 && this.#fallbacks.size === 0) ||
      this.#scheduled !== null
    ) return;
    this.#scheduled = this.#schedule(() => {
      this.#scheduled = null;
      this.#drainScheduled();
      this.#ensureTimer();
    }, this.#nextDelayMs());
  }

  #flushOldest(): void {
    let oldestTask: readonly [string, PendingChange] | undefined;
    for (const entry of this.#pending.entries()) {
      if (this.#deliveringKeys.has(entry[0])) continue;
      if (
        oldestTask === undefined ||
        entry[1].ordinal < oldestTask[1].ordinal
      ) {
        oldestTask = entry;
      }
    }
    let oldestWorkspace: readonly [string, WorkspaceFallback] | undefined;
    for (const entry of this.#fallbacks.entries()) {
      if (this.#deliveringWorkspaceIds.has(entry[0])) continue;
      if (
        oldestWorkspace === undefined ||
        entry[1].ordinal < oldestWorkspace[1].ordinal
      ) {
        oldestWorkspace = entry;
      }
    }
    if (
      oldestWorkspace !== undefined &&
      (
        oldestTask === undefined ||
        oldestWorkspace[1].ordinal < oldestTask[1].ordinal
      )
    ) {
      this.#deliverWorkspace(oldestWorkspace[0]);
      return;
    }
    if (oldestTask !== undefined) this.#deliverKey(oldestTask[0]);
  }

  #deliverKey(key: string): void {
    if (this.#deliveringKeys.has(key)) return;
    if (
      this.#inFlightHeads.size >= MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES
    ) {
      this.#ensureTimer();
      throw new Error(
        "Local task change coordinator reentrant delivery limit was reached",
      );
    }
    this.#deliveringKeys.add(key);
    try {
      while (true) {
        const entry = this.#pending.get(key);
        if (entry === undefined) return;
        const publishedHead = this.#publishedHeads.get(key) ?? 0;
        if (entry.change.projectionRevision <= publishedHead) {
          this.#pending.delete(key);
          continue;
        }

        this.#pending.delete(key);
        this.#inFlightHeads.set(key, entry.change.projectionRevision);
        try {
          this.#onChange(entry.change);
        } catch (error) {
          this.#inFlightHeads.delete(key);
          this.#restoreFailedChange(key, entry);
          this.#rescheduleTimer();
          throw error;
        }
        this.#inFlightHeads.delete(key);
        this.#recordPublishedHead(key, entry.change.projectionRevision);

        const reentrant = this.#pending.get(key);
        if (reentrant === undefined || !reentrant.immediate) return;
      }
    } finally {
      this.#inFlightHeads.delete(key);
      this.#deliveringKeys.delete(key);
    }
  }

  #drainScheduled(): void {
    const pending = [
      ...[...this.#pending.entries()].map(([key, entry]) => ({
        key,
        kind: "task" as const,
        ordinal: entry.ordinal,
      })),
      ...[...this.#fallbacks.entries()].map(([workspaceId, entry]) => ({
        key: workspaceId,
        kind: "workspace" as const,
        ordinal: entry.ordinal,
      })),
    ].sort((left, right) => left.ordinal - right.ordinal);
    for (const entry of pending) {
      try {
        if (entry.kind === "task") this.#deliverKey(entry.key);
        else this.#deliverWorkspace(entry.key);
      } catch {
        // A failed callback remains pending and is retried in a later window.
      }
    }
  }

  #recordPublishedHead(key: string, projectionRevision: number): void {
    const publishedHead = this.#publishedHeads.get(key) ?? 0;
    if (projectionRevision <= publishedHead) return;
    this.#publishedHeads.delete(key);
    this.#publishedHeads.set(key, projectionRevision);
    while (
      this.#publishedHeads.size > MAX_TRACKED_LOCAL_TASK_CHANGE_HEADS
    ) {
      const oldest = this.#publishedHeads.keys().next().value;
      if (oldest === undefined) break;
      this.#publishedHeads.delete(oldest);
    }
  }

  #recordPublishedWorkspaceHead(
    workspaceId: string,
    projectionRevision: number,
  ): void {
    const publishedHead = this.#publishedWorkspaceHeads.get(workspaceId) ?? 0;
    if (projectionRevision <= publishedHead) return;
    this.#publishedWorkspaceHeads.delete(workspaceId);
    this.#publishedWorkspaceHeads.set(workspaceId, projectionRevision);
    while (
      this.#publishedWorkspaceHeads.size >
        MAX_PENDING_LOCAL_TASK_WORKSPACE_FALLBACKS
    ) {
      const oldest = this.#publishedWorkspaceHeads.keys().next().value;
      if (oldest === undefined) break;
      this.#publishedWorkspaceHeads.delete(oldest);
    }
  }

  #retainWorkspaceFallback(change: PortableTaskChangeRecord): void {
    const workspaceId = change.workspaceId;
    const existing = this.#fallbacks.get(workspaceId);
    let projectionRevision = Math.max(
      change.projectionRevision,
      existing?.invalidation.projectionRevision ?? 0,
    );
    let failedAttempts = existing?.failedAttempts ?? 0;
    let ordinal = existing?.ordinal ?? this.#allocateOrdinal();
    for (const [key, pending] of this.#pending.entries()) {
      if (pending.change.workspaceId !== workspaceId) continue;
      projectionRevision = Math.max(
        projectionRevision,
        pending.change.projectionRevision,
      );
      failedAttempts = Math.max(failedAttempts, pending.failedAttempts);
      ordinal = Math.min(ordinal, pending.ordinal);
      this.#pending.delete(key);
    }
    this.#fallbacks.set(workspaceId, {
      failedAttempts,
      invalidation: taskDomain.portableInvalidationSchema.parse({
        workspaceId,
        projectionRevision,
        scope: "workspace",
      }) as Extract<PortableInvalidation, { readonly scope: "workspace" }>,
      ordinal,
    });
  }

  #deliverWorkspace(workspaceId: string): void {
    if (this.#deliveringWorkspaceIds.has(workspaceId)) return;
    const entry = this.#fallbacks.get(workspaceId);
    if (entry === undefined) return;
    const publishedHead = this.#publishedWorkspaceHeads.get(workspaceId) ?? 0;
    if (entry.invalidation.projectionRevision <= publishedHead) {
      this.#fallbacks.delete(workspaceId);
      return;
    }

    this.#deliveringWorkspaceIds.add(workspaceId);
    this.#fallbacks.delete(workspaceId);
    this.#inFlightWorkspaceHeads.set(
      workspaceId,
      entry.invalidation.projectionRevision,
    );
    try {
      this.#onChange(entry.invalidation);
    } catch (error) {
      this.#inFlightWorkspaceHeads.delete(workspaceId);
      this.#restoreFailedWorkspaceFallback(workspaceId, entry);
      this.#rescheduleTimer();
      throw error;
    } finally {
      this.#inFlightWorkspaceHeads.delete(workspaceId);
      this.#deliveringWorkspaceIds.delete(workspaceId);
    }
    this.#recordPublishedWorkspaceHead(
      workspaceId,
      entry.invalidation.projectionRevision,
    );
    for (const [key, pending] of this.#pending.entries()) {
      if (
        pending.change.workspaceId === workspaceId &&
        pending.change.projectionRevision <= entry.invalidation.projectionRevision
      ) {
        this.#pending.delete(key);
      }
    }
  }

  #restoreFailedWorkspaceFallback(
    workspaceId: string,
    failed: WorkspaceFallback,
  ): void {
    const reentrant = this.#fallbacks.get(workspaceId);
    let projectionRevision = Math.max(
      failed.invalidation.projectionRevision,
      reentrant?.invalidation.projectionRevision ?? 0,
    );
    let failedAttempts = Math.min(
      Math.max(failed.failedAttempts, reentrant?.failedAttempts ?? 0) + 1,
      MAX_LOCAL_TASK_CHANGE_RETRY_EXPONENT,
    );
    let ordinal = Math.min(
      failed.ordinal,
      reentrant?.ordinal ?? failed.ordinal,
    );
    for (const [key, pending] of this.#pending.entries()) {
      if (pending.change.workspaceId !== workspaceId) continue;
      projectionRevision = Math.max(
        projectionRevision,
        pending.change.projectionRevision,
      );
      failedAttempts = Math.max(failedAttempts, pending.failedAttempts);
      ordinal = Math.min(ordinal, pending.ordinal);
      this.#pending.delete(key);
    }
    this.#fallbacks.set(workspaceId, {
      failedAttempts,
      invalidation: {
        workspaceId,
        projectionRevision,
        scope: "workspace",
      },
      ordinal,
    });
  }

  #restoreFailedChange(key: string, failed: PendingChange): void {
    const reentrant = this.#pending.get(key);
    const failedAttempts = Math.min(
      Math.max(failed.failedAttempts, reentrant?.failedAttempts ?? 0) + 1,
      MAX_LOCAL_TASK_CHANGE_RETRY_EXPONENT,
    );
    if (reentrant === undefined) {
      this.#pending.set(key, { ...failed, failedAttempts });
      return;
    }
    this.#pending.set(key, {
      change: mergePortableTaskChanges(failed.change, reentrant.change),
      failedAttempts,
      immediate: failed.immediate || reentrant.immediate,
      ordinal: Math.min(failed.ordinal, reentrant.ordinal),
    });
  }

  #nextDelayMs(): number {
    let retryExponent = 0;
    for (const { failedAttempts } of this.#pending.values()) {
      retryExponent = Math.max(retryExponent, failedAttempts);
    }
    for (const { failedAttempts } of this.#fallbacks.values()) {
      retryExponent = Math.max(retryExponent, failedAttempts);
    }
    return Math.min(
      LOCAL_TASK_DISPLAY_CHANGE_WINDOW_MS * (2 ** retryExponent),
      LOCAL_TASK_CHANGE_MAX_RETRY_DELAY_MS,
    );
  }

  #rescheduleTimer(): void {
    if (this.#scheduled !== null) {
      this.#cancel(this.#scheduled);
      this.#scheduled = null;
    }
    this.#ensureTimer();
  }

  #settleTimer(): void {
    if (this.#pending.size !== 0 || this.#fallbacks.size !== 0) {
      this.#ensureTimer();
      return;
    }
    if (this.#scheduled === null) return;
    this.#cancel(this.#scheduled);
    this.#scheduled = null;
  }
}
