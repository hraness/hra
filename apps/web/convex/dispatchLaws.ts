import {
  type RunPhase,
  type RunnerHeartbeatRequest,
  type RunnerPresenceView,
} from "@hraness/agent-tasks-protocol";

export {
  AMBIGUOUS_DISPATCH_RESOLUTION_REASONS,
  FAIL_CLOSED_TASK_DISPATCH_PHASES,
  contiguousEventBatch,
  dispatchRetryAllowed,
  dispatchSubmissionInputRevisionMatches,
  isTerminalRunPhase,
  nextRunPhase,
  resolvedAmbiguousDispatchPhase,
  runDisplayBudgetAfterBatch,
  runEventSequenceAllowed,
  storedRunEventPayloadMatches,
  taskDispatchBlocksTaskRelease,
} from "@hraness/agent-tasks-domain";

export function rejectedSubmissionMatchesDispatch(input: Readonly<{
  sourceDispatchPublicId: string;
  submissionDispatchPublicId?: string;
  submissionStatus?: "accepted" | "cancelled" | "pending" | "rejected";
}>): boolean {
  return input.submissionStatus === "rejected" &&
    input.submissionDispatchPublicId === input.sourceDispatchPublicId;
}
export type {
  AmbiguousDispatchResolutionReason,
  DispatchHumanResolutionInput,
  RunDisplayBudget,
  RunDisplayBudgetCheck,
} from "@hraness/agent-tasks-domain";

import {
  CLAIM_RENEWAL_THRESHOLD_MS,
  DEFAULT_CLAIM_LEASE_MS,
  DISPATCH_LEASE_MS,
  RUNNER_PRESENCE_LEASE_MS,
} from "./model";

export type HeartbeatDisposition =
  | { readonly kind: "create" }
  | { readonly kind: "advance" }
  | { readonly kind: "restart" }
  | { readonly kind: "replay" }
  | { readonly kind: "stale" }
  | { readonly kind: "gap" }
  | { readonly kind: "conflict" };

/** Exact request replays are observational and never advance queue rotation. */
export function heartbeatMayRotateCandidates(disposition: HeartbeatDisposition): boolean {
  return disposition.kind === "create" ||
    disposition.kind === "advance" ||
    disposition.kind === "restart";
}

export interface DispatchCandidateRow {
  readonly publicId: string;
  readonly queuedAt: number;
  readonly repositoryId: string;
}

export interface EvaluatedDispatchCandidateRow extends DispatchCandidateRow {
  readonly candidateOrderAt?: number;
  readonly candidateRotationAt?: number;
  readonly eligible: boolean;
}

export const CANDIDATE_ROTATION_COOLDOWN_MS = 60_000;
export const MAX_CANDIDATE_EVALUATIONS_PER_HEARTBEAT = 512;

function compareDispatchCandidateRows(
  left: DispatchCandidateRow,
  right: DispatchCandidateRow,
): number {
  return left.queuedAt - right.queuedAt || left.publicId.localeCompare(right.publicId);
}

/**
 * Keeps one oldest queued row per capable repository before filling spare
 * capacity with the globally oldest extras from those offered repositories.
 * This prevents an unsupported or very busy repository from starving every
 * other capable queue without reaching behind an unoffered repository head.
 */
export function selectFairDispatchCandidateRows<Row extends DispatchCandidateRow>(input: Readonly<{
  expandedRows: readonly Row[];
  headRows: readonly Row[];
  limit: number;
  repositoryCursor?: string;
}>): readonly Row[] | null {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) return null;
  const headRepositoryIds = new Set<string>();
  const headByPublicId = new Map<string, Row>();
  const publicIds = new Set<string>();
  for (const row of input.headRows) {
    if (
      !Number.isSafeInteger(row.queuedAt) ||
      row.queuedAt < 0 ||
      headRepositoryIds.has(row.repositoryId) ||
      publicIds.has(row.publicId)
    ) return null;
    headRepositoryIds.add(row.repositoryId);
    headByPublicId.set(row.publicId, row);
    publicIds.add(row.publicId);
  }
  const repositoryOrderedHeads = [...input.headRows]
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  const repositoryCursor = input.repositoryCursor;
  const cyclicHeads = repositoryCursor === undefined
    ? repositoryOrderedHeads
    : (() => {
        const start = repositoryOrderedHeads.findIndex(
          ({ repositoryId }) => repositoryId > repositoryCursor,
        );
        // Finish the repository-head cycle without wrapping. Spare response
        // capacity may later use extras only from these tail repositories; the
        // next heartbeat starts a fresh head cycle after the cursor reaches end.
        return start < 0 ? repositoryOrderedHeads : repositoryOrderedHeads.slice(start);
      })();
  const heads = cyclicHeads.slice(0, input.limit);
  if (heads.length === input.limit) return heads;
  const offeredRepositoryIds = new Set(heads.map(({ repositoryId }) => repositoryId));

  const extras: Row[] = [];
  for (const row of input.expandedRows) {
    if (
      !Number.isSafeInteger(row.queuedAt) ||
      row.queuedAt < 0 ||
      !headRepositoryIds.has(row.repositoryId)
    ) return null;
    if (publicIds.has(row.publicId)) {
      const head = headByPublicId.get(row.publicId);
      if (
        head !== undefined &&
        head.repositoryId === row.repositoryId &&
        head.queuedAt === row.queuedAt
      ) continue;
      return null;
    }
    publicIds.add(row.publicId);
    if (offeredRepositoryIds.has(row.repositoryId)) extras.push(row);
  }
  return [
    ...heads,
    ...extras.sort(compareDispatchCandidateRows).slice(0, input.limit - heads.length),
  ];
}

/** Candidate discovery follows the persisted wake barrier as well as live readiness. */
export function dispatchCandidateIsEligible(input: Readonly<{
  currentClaimFence: number;
  currentTaskRevision: number;
  persistedReady: boolean;
  queuedClaimFence: number;
  queuedTaskRevision: number;
  readyNow: boolean;
}>): boolean {
  return input.persistedReady &&
    input.readyNow &&
    input.queuedTaskRevision === input.currentTaskRevision &&
    input.queuedClaimFence === input.currentClaimFence;
}

/**
 * Selects the oldest currently eligible row in every scanned repository before
 * filling spare capacity. Ineligible scanned rows are returned for rotation so
 * an arbitrary blocked prefix cannot permanently hide later ready work.
 */
export function planFairEligibleDispatchCandidates<Row extends EvaluatedDispatchCandidateRow>(
  input: Readonly<{
    limit: number;
    repositoryCursor?: Row["repositoryId"];
    rows: readonly Row[];
  }>,
): Readonly<{
  deferredPublicIds: readonly string[];
  nextRepositoryCursor?: Row["repositoryId"];
  selected: readonly Row[];
}> | null {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) return null;
  const publicIds = new Set<string>();
  const eligibleByRepository = new Map<string, Row[]>();
  const deferred: Row[] = [];
  for (const row of input.rows) {
    if (
      publicIds.has(row.publicId) ||
      !Number.isSafeInteger(row.queuedAt) ||
      row.queuedAt < 0 ||
      (row.candidateOrderAt !== undefined && (
        !Number.isSafeInteger(row.candidateOrderAt) || row.candidateOrderAt < 0
      )) ||
      (row.candidateRotationAt !== undefined && (
        !Number.isSafeInteger(row.candidateRotationAt) || row.candidateRotationAt < 0
      ))
    ) return null;
    publicIds.add(row.publicId);
    if (!row.eligible) {
      deferred.push(row);
      continue;
    }
    const repositoryRows = eligibleByRepository.get(row.repositoryId) ?? [];
    repositoryRows.push(row);
    eligibleByRepository.set(row.repositoryId, repositoryRows);
  }
  const headRows: Row[] = [];
  const expandedRows: Row[] = [];
  for (const rows of eligibleByRepository.values()) {
    rows.sort(compareDispatchCandidateRows);
    const head = rows[0];
    if (head === undefined) continue;
    headRows.push(head);
    expandedRows.push(...rows);
  }
  const selected = selectFairDispatchCandidateRows({
    expandedRows,
    headRows,
    limit: input.limit,
    ...(input.repositoryCursor === undefined
      ? {}
      : { repositoryCursor: input.repositoryCursor }),
  });
  if (selected === null) return null;
  const headPublicIds = new Set(headRows.map(({ publicId }) => publicId));
  const nextRepositoryCursor = selected
    .filter(({ publicId }) => headPublicIds.has(publicId))
    .at(-1)?.repositoryId;
  return {
    deferredPublicIds: deferred.sort(compareDispatchCandidateRows).map(({ publicId }) => publicId),
    ...(nextRepositoryCursor === undefined ? {} : { nextRepositoryCursor }),
    selected,
  };
}

/**
 * Rotates only validated ineligible rows from a truncated repository page.
 * Untruncated queues never churn, and the cooldown rate-bounds a long queue's
 * repeated discovery cycles.
 */
export function candidateRowsToRotate<Row extends EvaluatedDispatchCandidateRow>(input: Readonly<{
  cooldownMs: number;
  deferredPublicIds: readonly string[];
  maximumRows: number;
  now: number;
  rows: readonly Row[];
  truncatedRepositoryIds: readonly string[];
}>): readonly Row[] | null {
  if (
    !Number.isSafeInteger(input.maximumRows) ||
    input.maximumRows < 0 ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    !Number.isSafeInteger(input.cooldownMs) ||
    input.cooldownMs < 1 ||
    input.rows.length > input.maximumRows
  ) return null;
  const rowPublicIds = new Set(input.rows.map(({ publicId }) => publicId));
  const deferredPublicIds = new Set(input.deferredPublicIds);
  const truncatedRepositoryIds = new Set(input.truncatedRepositoryIds);
  if (
    rowPublicIds.size !== input.rows.length ||
    deferredPublicIds.size !== input.deferredPublicIds.length ||
    truncatedRepositoryIds.size !== input.truncatedRepositoryIds.length ||
    input.deferredPublicIds.some((publicId) => !rowPublicIds.has(publicId))
  ) return null;
  const rotationCutoff = input.now - input.cooldownMs;
  return input.rows.filter((row) =>
    deferredPublicIds.has(row.publicId) &&
    truncatedRepositoryIds.has(row.repositoryId) &&
    (row.candidateRotationAt === undefined || row.candidateRotationAt <= rotationCutoff));
}

/** Includes the already-loaded repository head in each expansion query. */
export function dispatchCandidateExpansionTake(
  nonemptyRepositoryCount: number,
  limit: number,
): number {
  if (
    !Number.isSafeInteger(nonemptyRepositoryCount) ||
    nonemptyRepositoryCount < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    nonemptyRepositoryCount === 0 ||
    nonemptyRepositoryCount >= limit
  ) return 0;
  return limit - nonemptyRepositoryCount + 1;
}

/**
 * Scans at least two rows from every nonempty queue. The expansion term keeps
 * a sparse set of repositories capable of filling the response in one pass.
 */
export function dispatchCandidateScanTake(
  nonemptyRepositoryCount: number,
  limit: number,
): number {
  if (
    !Number.isSafeInteger(nonemptyRepositoryCount) ||
    nonemptyRepositoryCount < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) return 0;
  return Math.max(
    2,
    dispatchCandidateExpansionTake(nonemptyRepositoryCount, limit),
    Math.floor(MAX_CANDIDATE_EVALUATIONS_PER_HEARTBEAT / nonemptyRepositoryCount),
  );
}

export interface PersistedHeartbeatClock {
  readonly bootId: string;
  readonly bootGeneration: number;
  readonly heartbeatSequence: number;
  readonly heartbeatFingerprint: string;
  readonly leaseUntil: number;
}

const terminalRunPhases = new Set(["submitted", "failed", "cancelled"]);

/** Returns terminal proofs only for the exact bounded reservations retained locally. */
export function retainedTerminalRunIds(
  retainedRunIds: readonly string[],
  rows: readonly Readonly<{ publicId: string; phase: string }>[],
): readonly string[] {
  const rowById = new Map(rows.map((row) => [row.publicId, row] as const));
  return [...new Set(retainedRunIds)].filter((runId) => {
    const row = rowById.get(runId);
    return row !== undefined && terminalRunPhases.has(row.phase);
  });
}

export interface PersistedRunnerAuthority {
  readonly runnerPublicId: string;
  readonly installationId: string;
  readonly generation: number;
  readonly leaseUntil: number;
}

export type RunnerAuthorityDisposition =
  | { readonly kind: "acquire"; readonly generation: 1 }
  | { readonly kind: "renew"; readonly generation: number }
  | { readonly kind: "takeover"; readonly generation: number }
  | { readonly kind: "conflict"; readonly retryAfterMs: number }
  | { readonly kind: "corrupt" };

/**
 * Elects one runner installation per workspace. A live owner is never
 * superseded by heartbeat order; a different installation may take authority
 * only at the exact server-time lease boundary or later.
 */
export function runnerAuthorityDisposition(
  current: PersistedRunnerAuthority | null,
  incoming: Pick<PersistedRunnerAuthority, "runnerPublicId" | "installationId">,
  now: number,
): RunnerAuthorityDisposition {
  if (!Number.isSafeInteger(now) || now < 0) return { kind: "corrupt" };
  if (current === null) return { kind: "acquire", generation: 1 };
  if (
    !Number.isSafeInteger(current.generation) ||
    current.generation < 1 ||
    !Number.isSafeInteger(current.leaseUntil) ||
    current.leaseUntil < 0
  ) {
    return { kind: "corrupt" };
  }
  if (
    current.runnerPublicId === incoming.runnerPublicId &&
    current.installationId === incoming.installationId
  ) {
    return { kind: "renew", generation: current.generation };
  }
  if (current.leaseUntil > now) {
    return { kind: "conflict", retryAfterMs: current.leaseUntil - now };
  }
  if (current.generation >= Number.MAX_SAFE_INTEGER) return { kind: "corrupt" };
  return { kind: "takeover", generation: current.generation + 1 };
}

export function runnerAuthorityClockMatches(input: Readonly<{
  authorityGeneration: number;
  authorityLeaseUntil: number;
  runnerLeaseUntil: number;
}>): boolean {
  return Number.isSafeInteger(input.authorityGeneration) &&
    input.authorityGeneration > 0 &&
    Number.isSafeInteger(input.authorityLeaseUntil) &&
    input.authorityLeaseUntil >= 0 &&
    Number.isSafeInteger(input.runnerLeaseUntil) &&
    input.runnerLeaseUntil === input.authorityLeaseUntil;
}

export function runnerAuthorityTupleMatches(input: {
  readonly authorityOrganizationId: string;
  readonly authorityWorkspaceId: string;
  readonly authorityRunnerId: string;
  readonly authorityRunnerPublicId: string;
  readonly authorityInstallationId: string;
  readonly runnerOrganizationId: string;
  readonly runnerWorkspaceId: string;
  readonly runnerId: string;
  readonly runnerPublicId: string;
  readonly runnerInstallationId: string;
}): boolean {
  return (
    input.authorityOrganizationId === input.runnerOrganizationId &&
    input.authorityWorkspaceId === input.runnerWorkspaceId &&
    input.authorityRunnerId === input.runnerId &&
    input.authorityRunnerPublicId === input.runnerPublicId &&
    input.authorityInstallationId === input.runnerInstallationId
  );
}

export interface DispatchSubmissionAuthorityInput {
  readonly now: number;
  readonly authorization: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly agentId: string;
  };
  readonly request: {
    readonly runId: string;
    readonly runnerId: string;
    readonly bootId: string;
    readonly claimId: string;
    readonly claimFence: number;
  };
  readonly task: {
    readonly id: string;
    readonly organizationId: string;
    readonly workspaceId: string;
  };
  readonly claim: {
    readonly id: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly taskId: string;
    readonly agentId: string;
    readonly publicId: string;
    readonly fence: number;
    readonly state: string;
    readonly leaseUntil: number;
  };
  readonly dispatch: {
    readonly publicId: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly taskId: string;
    readonly runnerId: string;
    readonly runnerPublicId: string;
    readonly bootId: string;
    readonly bootGeneration: number;
    readonly taskClaimId: string;
    readonly taskClaimPublicId: string;
    readonly claimFence: number;
    readonly leaseUntil: number;
    readonly phase: RunPhase;
  };
  readonly runner: {
    readonly id: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly agentId: string;
    readonly publicId: string;
    readonly installationId: string;
    readonly bootId: string;
    readonly bootGeneration: number;
    readonly leaseUntil: number;
  };
  readonly authority: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly runnerId: string;
    readonly runnerPublicId: string;
    readonly installationId: string;
    readonly generation: number;
    readonly leaseUntil: number;
  };
}

/**
 * Fences a task submission to the exact live dispatch and workspace runner
 * authority that produced it. This is intentionally one total predicate so a
 * Convex mutation can validate the complete tuple and perform the task write
 * in the same serializable transaction.
 */
export function dispatchSubmissionAuthorityMatches(
  input: DispatchSubmissionAuthorityInput,
): boolean {
  const { authorization, authority, claim, dispatch, now, request, runner, task } = input;
  return (
    Number.isSafeInteger(authority.generation) &&
    authority.generation > 0 &&
    authority.leaseUntil > now &&
    runner.leaseUntil === authority.leaseUntil &&
    claim.leaseUntil > now &&
    dispatch.leaseUntil > now &&
    (dispatch.phase === "running" || dispatch.phase === "waiting") &&
    authorization.organizationId === task.organizationId &&
    authorization.workspaceId === task.workspaceId &&
    authority.organizationId === authorization.organizationId &&
    authority.workspaceId === authorization.workspaceId &&
    runner.organizationId === authorization.organizationId &&
    runner.workspaceId === authorization.workspaceId &&
    authorization.agentId === claim.agentId &&
    authorization.agentId === runner.agentId &&
    claim.organizationId === task.organizationId &&
    claim.workspaceId === task.workspaceId &&
    claim.taskId === task.id &&
    claim.state === "active" &&
    dispatch.organizationId === task.organizationId &&
    dispatch.workspaceId === task.workspaceId &&
    dispatch.taskId === task.id &&
    dispatch.publicId === request.runId &&
    dispatch.runnerPublicId === request.runnerId &&
    dispatch.bootId === request.bootId &&
    dispatch.taskClaimPublicId === request.claimId &&
    dispatch.claimFence === request.claimFence &&
    claim.publicId === request.claimId &&
    claim.fence === request.claimFence &&
    dispatch.taskClaimId === claim.id &&
    dispatch.runnerId === runner.id &&
    dispatch.runnerPublicId === runner.publicId &&
    dispatch.bootId === runner.bootId &&
    dispatch.bootGeneration === runner.bootGeneration &&
    runnerAuthorityTupleMatches({
      authorityOrganizationId: authority.organizationId,
      authorityWorkspaceId: authority.workspaceId,
      authorityRunnerId: authority.runnerId,
      authorityRunnerPublicId: authority.runnerPublicId,
      authorityInstallationId: authority.installationId,
      runnerOrganizationId: runner.organizationId,
      runnerWorkspaceId: runner.workspaceId,
      runnerId: runner.id,
      runnerPublicId: runner.publicId,
      runnerInstallationId: runner.installationId,
    })
  );
}

/**
 * Applies the runner's persisted boot-generation/sequence clock. A restart is
 * a one-step generation change whose first heartbeat is sequence one. Equal
 * sequence is replay-only and never extends the lease.
 */
export function heartbeatDisposition(
  current: PersistedHeartbeatClock | null,
  incoming: Pick<RunnerHeartbeatRequest, "bootId" | "bootGeneration" | "sequence"> & {
    readonly fingerprint: string;
  },
): HeartbeatDisposition {
  if (incoming.bootGeneration < 1 || incoming.sequence < 1) return { kind: "conflict" };
  if (current === null) {
    return incoming.bootGeneration === 1 && incoming.sequence === 1
      ? { kind: "create" }
      : { kind: "gap" };
  }
  if (incoming.bootGeneration < current.bootGeneration) return { kind: "stale" };
  if (incoming.bootGeneration === current.bootGeneration) {
    if (incoming.bootId !== current.bootId) return { kind: "conflict" };
    if (incoming.sequence < current.heartbeatSequence) return { kind: "stale" };
    if (incoming.sequence === current.heartbeatSequence) {
      return incoming.fingerprint === current.heartbeatFingerprint
        ? { kind: "replay" }
        : { kind: "conflict" };
    }
    return incoming.sequence === current.heartbeatSequence + 1
      ? { kind: "advance" }
      : { kind: "gap" };
  }
  if (incoming.bootGeneration !== current.bootGeneration + 1) return { kind: "gap" };
  if (incoming.sequence !== 1 || incoming.bootId === current.bootId) {
    return { kind: "conflict" };
  }
  return { kind: "restart" };
}

/** Stable semantic heartbeat identity; repository capabilities are a set. */
export function heartbeatFingerprint(
  heartbeat: Omit<RunnerHeartbeatRequest, "repositoryIds"> & {
    readonly repositoryIds: readonly string[];
  },
): string {
  return JSON.stringify({
    runnerId: heartbeat.runnerId,
    installationId: heartbeat.installationId,
    bootId: heartbeat.bootId,
    bootGeneration: heartbeat.bootGeneration,
    sequence: heartbeat.sequence,
    protocolVersion: heartbeat.protocolVersion,
    clientVersion: heartbeat.clientVersion,
    reportedState: heartbeat.reportedState,
    blockReason: heartbeat.blockReason ?? null,
    capacity: heartbeat.capacity,
    activeRuns: heartbeat.activeRuns,
    currentRunIds: [...heartbeat.currentRunIds].sort(),
    retainedRunIds: [...heartbeat.retainedRunIds].sort(),
    repositoryIds: [...heartbeat.repositoryIds].sort(),
  });
}

export type RunnerPresenceInput = Readonly<{
  blockReason?: "no_account" | "no_repository" | "capacity_full" | "upgrade_required" | "credential_invalid";
  capacity: number;
  cloudActiveRuns: number;
  desiredState: "active" | "draining";
  leaseUntil: number;
  reportedActiveRuns: number;
  reportedState: "starting" | "ready" | "busy" | "degraded";
  repositoryCount: number;
}>;

/** Derives browser-visible presence from a live lease, never from agentSessions. */
export function deriveRunnerPresence(
  input: RunnerPresenceInput,
  now: number,
): RunnerPresenceView {
  if (input.leaseUntil <= now) return { state: "offline", serverTime: now };
  if (input.desiredState === "draining") {
    return { state: "draining", serverTime: now, leaseUntil: input.leaseUntil };
  }
  if (input.reportedState === "degraded") {
    return {
      state: "blocked",
      serverTime: now,
      leaseUntil: input.leaseUntil,
      reason: input.blockReason ?? "credential_invalid",
    };
  }
  if (input.repositoryCount === 0) {
    return {
      state: "blocked",
      serverTime: now,
      leaseUntil: input.leaseUntil,
      reason: "no_repository",
    };
  }
  const occupied = Math.max(input.reportedActiveRuns, input.cloudActiveRuns);
  const availableCapacity = Math.max(0, input.capacity - occupied);
  if (input.capacity === 0 || availableCapacity === 0) {
    return {
      state: "blocked",
      serverTime: now,
      leaseUntil: input.leaseUntil,
      reason: "capacity_full",
    };
  }
  if (input.reportedState !== "ready") {
    return { state: "busy", serverTime: now, leaseUntil: input.leaseUntil };
  }
  return {
    state: "ready",
    serverTime: now,
    leaseUntil: input.leaseUntil,
    availableCapacity,
  };
}

export function heartbeatLeaseUntil(now: number): number {
  return now + RUNNER_PRESENCE_LEASE_MS;
}

export function dispatchTenantTupleMatches(input: {
  readonly authorizedOrganizationId: string;
  readonly authorizedWorkspaceId: string;
  readonly runnerOrganizationId: string;
  readonly runnerWorkspaceId: string;
  readonly taskOrganizationId: string;
  readonly taskWorkspaceId: string;
  readonly repositoryOrganizationId: string;
  readonly repositoryWorkspaceId: string;
  readonly dispatchOrganizationId?: string;
  readonly dispatchWorkspaceId?: string;
}): boolean {
  const organizationIds = [
    input.runnerOrganizationId,
    input.taskOrganizationId,
    input.repositoryOrganizationId,
    ...(input.dispatchOrganizationId === undefined ? [] : [input.dispatchOrganizationId]),
  ];
  const workspaceIds = [
    input.runnerWorkspaceId,
    input.taskWorkspaceId,
    input.repositoryWorkspaceId,
    ...(input.dispatchWorkspaceId === undefined ? [] : [input.dispatchWorkspaceId]),
  ];
  return (
    organizationIds.every((id) => id === input.authorizedOrganizationId) &&
    workspaceIds.every((id) => id === input.authorizedWorkspaceId)
  );
}

export function dispatchBindingTupleMatches(input: {
  readonly dispatchRunnerId: string;
  readonly runnerId: string;
  readonly dispatchBootId: string;
  readonly bootId: string;
  readonly dispatchBootGeneration: number;
  readonly bootGeneration: number;
  readonly dispatchClaimPublicId: string;
  readonly claimPublicId: string;
  readonly dispatchClaimFence: number;
  readonly claimFence: number;
}): boolean {
  return (
    input.dispatchRunnerId === input.runnerId &&
    input.dispatchBootId === input.bootId &&
    input.dispatchBootGeneration === input.bootGeneration &&
    input.dispatchClaimPublicId === input.claimPublicId &&
    input.dispatchClaimFence === input.claimFence
  );
}

const EXPIRABLE_DISPATCH_PHASES = new Set<RunPhase>([
  "leased",
  "provisioning",
  "starting",
  "running",
  "waiting",
  "cancel_requested",
]);

export interface PersistedDispatchLease {
  readonly dispatchId: string;
  readonly runnerId: string;
  readonly bootId: string;
  readonly bootGeneration: number;
  readonly taskClaimId: string;
  readonly claimFence: number;
  readonly leaseGeneration: number;
  readonly leaseUntil: number;
  readonly phase: RunPhase;
}

export interface ScheduledDispatchLease {
  readonly dispatchId: string;
  readonly runnerId: string;
  readonly bootId: string;
  readonly bootGeneration: number;
  readonly taskClaimId: string;
  readonly claimFence: number;
  readonly leaseGeneration: number;
  readonly expectedDeadline: number;
}

export type ScheduledDispatchExpiryDisposition = "ambiguous" | "requeue" | "reschedule" | "stale";

/**
 * Applies a dispatch-expiry job only to the exact runner boot, task claim,
 * fence, lease generation, and deadline that scheduled it. A due active lease
 * becomes ambiguous instead of being automatically retried.
 */
export function scheduledDispatchExpiryDisposition(
  current: PersistedDispatchLease | null,
  scheduled: ScheduledDispatchLease,
  now: number,
): ScheduledDispatchExpiryDisposition {
  if (
    current === null ||
    current.dispatchId !== scheduled.dispatchId ||
    current.runnerId !== scheduled.runnerId ||
    current.bootId !== scheduled.bootId ||
    current.bootGeneration !== scheduled.bootGeneration ||
    current.taskClaimId !== scheduled.taskClaimId ||
    current.claimFence !== scheduled.claimFence ||
    current.leaseGeneration !== scheduled.leaseGeneration ||
    current.leaseUntil !== scheduled.expectedDeadline ||
    !EXPIRABLE_DISPATCH_PHASES.has(current.phase)
  ) {
    return "stale";
  }
  if (now < scheduled.expectedDeadline) return "reschedule";
  return current.phase === "leased" ? "requeue" : "ambiguous";
}

export type ClaimEligibility = Readonly<{
  dispatchPhase: RunPhase;
  repositoryCapability: boolean;
  runnerBootMatches: boolean;
  runnerDesiredState: "active" | "draining";
  runnerLeaseUntil: number;
  runnerReady: boolean;
  availableCapacity: number;
  taskReady: boolean;
}>;

export function dispatchClaimAllowed(input: ClaimEligibility, now: number): boolean {
  return (
    input.dispatchPhase === "queued" &&
    input.repositoryCapability &&
    input.runnerBootMatches &&
    input.runnerDesiredState === "active" &&
    input.runnerLeaseUntil > now &&
    input.runnerReady &&
    input.availableCapacity > 0 &&
    input.taskReady
  );
}

export type DispatchClaimLeaseDisposition =
  | Readonly<{
      kind: "retain";
      claimLeaseGeneration: number;
      claimLeaseUntil: number;
      dispatchLeaseUntil: number;
    }>
  | Readonly<{
      kind: "renew";
      claimLeaseGeneration: number;
      claimLeaseUntil: number;
      dispatchLeaseUntil: number;
    }>;

/** Keeps the short dispatch lease inside its paired task-claim authority. */
export function dispatchClaimLeaseDisposition(
  input: Readonly<{
    claimLeaseGeneration: number;
    claimLeaseUntil: number;
  }>,
  now: number,
): DispatchClaimLeaseDisposition | null {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(input.claimLeaseGeneration) ||
    input.claimLeaseGeneration < 1 ||
    !Number.isSafeInteger(input.claimLeaseUntil) ||
    input.claimLeaseUntil <= now
  ) {
    return null;
  }
  if (input.claimLeaseUntil - now > CLAIM_RENEWAL_THRESHOLD_MS) {
    return {
      kind: "retain",
      claimLeaseGeneration: input.claimLeaseGeneration,
      claimLeaseUntil: input.claimLeaseUntil,
      dispatchLeaseUntil: Math.min(input.claimLeaseUntil, now + DISPATCH_LEASE_MS),
    };
  }
  if (input.claimLeaseGeneration === Number.MAX_SAFE_INTEGER) return null;
  const claimLeaseUntil = now + DEFAULT_CLAIM_LEASE_MS;
  return {
    kind: "renew",
    claimLeaseGeneration: input.claimLeaseGeneration + 1,
    claimLeaseUntil,
    dispatchLeaseUntil: Math.min(claimLeaseUntil, now + DISPATCH_LEASE_MS),
  };
}
