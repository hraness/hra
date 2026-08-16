import { v } from "convex/values";

import {
  activeTaskClaimTupleMatches,
  blockerContribution,
  dependencyTupleMatches,
  derivedNeedsAttention,
  derivedReady,
  taskScopedRecordMatches,
  type BlockerLifecycle,
  type SubmissionLifecycle,
} from "./workGraphLaws";

export const WORKSPACE_INTEGRITY_LIMITS = {
  defaultTasks: 8,
  maximumTasks: 16,
  maximumScanPages: 64,
  activeClaims: 2,
  directBlockers: 100,
  pendingSubmissions: 1,
  activeGrants: 100,
  runnerAuthorities: 1,
  findings: 128,
} as const;

export const WORKSPACE_INTEGRITY_INVERSE_INDEXES = {
  activeClaims: "by_task_state",
  blockerEdges: "by_blocked_task_blocker",
  pendingSubmissions: "by_task_status_submitted",
  taskEvents: "by_task",
} as const;

export type WorkspaceIntegrityFindingKind =
  | "task_tenant_mismatch"
  | "task_claim_shape_mismatch"
  | "claim_fence_mismatch"
  | "active_claim_count_mismatch"
  | "active_claim_tuple_mismatch"
  | "blocker_relation_mismatch"
  | "unresolved_blocker_count_mismatch"
  | "cancelled_blocker_count_mismatch"
  | "blocked_projection_mismatch"
  | "ready_projection_mismatch"
  | "attention_projection_mismatch"
  | "pending_submission_count_mismatch"
  | "pending_submission_tuple_mismatch"
  | "submission_review_revision_mismatch"
  | "latest_event_missing"
  | "latest_event_tuple_mismatch"
  | "latest_event_revision_mismatch"
  | "workspace_usage_missing"
  | "workspace_usage_tenant_mismatch"
  | "active_task_usage_mismatch"
  | "total_task_usage_mismatch"
  | "active_agent_usage_mismatch"
  | "active_grant_tenant_mismatch"
  | "active_grant_agent_mismatch"
  | "runner_authority_count_mismatch"
  | "runner_authority_tenant_mismatch"
  | "runner_authority_tuple_mismatch"
  | "runner_authority_generation_invalid"
  | "task_scan_changed"
  | "task_scan_duplicate";

export interface WorkspaceIntegrityFinding {
  readonly kind: WorkspaceIntegrityFindingKind;
  readonly taskKey?: string;
  readonly expected?: number;
  readonly actual?: number;
}

interface BoundedRows<Row> {
  readonly rows: readonly Row[];
  readonly limit: number;
  readonly truncated: boolean;
}

interface CompactClaimInput {
  readonly claimId: string;
  readonly publicId: string;
  readonly agentId: string;
  readonly agentPublicId: string;
  readonly fence: number;
  readonly leaseGeneration: number;
  readonly leaseUntil: number;
}

interface DurableClaimInput {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly publicId: string;
  readonly agentId: string;
  readonly agentPublicId: string;
  readonly state: string;
  readonly fence: number;
  readonly leaseGeneration: number;
  readonly leaseUntil: number;
}

interface BlockerRelationInput {
  readonly edge: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly blockerTaskId: string;
    readonly blockedTaskId: string;
  };
  readonly blocker: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly id: string;
    readonly status: BlockerLifecycle;
  } | null;
}

interface PendingSubmissionInput {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly status: SubmissionLifecycle;
  readonly reviewRevision: number;
}

interface LatestEventInput {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly taskPublicId: string;
  readonly taskRevision: number;
}

export interface RunnerAuthorityIntegrityRow {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runnerId: string;
  readonly runnerPublicId: string;
  readonly installationId: string;
  readonly generation: number;
  readonly leaseUntil: number;
  readonly runner: {
    readonly id: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly publicId: string;
    readonly installationId: string;
    readonly leaseUntil: number;
  } | null;
}

export interface RunnerAuthorityIntegrityInput {
  readonly workspace: {
    readonly organizationId: string;
    readonly id: string;
  };
  readonly authorities: BoundedRows<RunnerAuthorityIntegrityRow>;
}

export interface TaskIntegrityInput {
  readonly workspace: {
    readonly organizationId: string;
    readonly id: string;
  };
  readonly now: number;
  readonly task: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly id: string;
    readonly publicId: string;
    readonly key: string;
    readonly status: BlockerLifecycle;
    readonly availableAt: number;
    readonly isReady: boolean;
    readonly isBlocked?: boolean;
    readonly needsAttention?: boolean;
    readonly unresolvedBlockerCount: number;
    readonly cancelledBlockerCount: number;
    readonly revision: number;
    readonly reviewRevision: number;
    readonly claimFence: number;
    readonly currentClaim?: CompactClaimInput;
  };
  readonly activeClaims: BoundedRows<DurableClaimInput>;
  readonly blockers: BoundedRows<BlockerRelationInput>;
  readonly pendingSubmissions: BoundedRows<PendingSubmissionInput>;
  readonly latestEvent: LatestEventInput | null;
}

export interface WorkspaceIntegrityPageInput {
  readonly workspace: {
    readonly organizationId: string;
    readonly id: string;
    readonly publicId: string;
  };
  readonly now: number;
  readonly startedAtBeginning: boolean;
  readonly nextCursor: string | null;
  readonly taskLimit: number;
  readonly tasks: readonly TaskIntegrityInput[];
  readonly usage: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly activeTasks: number;
    readonly totalTasks: number;
    readonly activeAgents: number;
    readonly updatedAt: number;
  } | null;
  readonly activeGrants: BoundedRows<{
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly agentId: string;
    readonly agent: {
      readonly id: string;
      readonly organizationId: string;
      readonly status: "active" | "disabled";
    } | null;
  }>;
  readonly runnerAuthorities: BoundedRows<RunnerAuthorityIntegrityRow>;
}

export interface TaskIntegrityAudit {
  readonly findings: readonly WorkspaceIntegrityFinding[];
  readonly complete: boolean;
  readonly coverage: {
    readonly blockersScanned: number;
    readonly blockerLimit: number;
    readonly blockersTruncated: boolean;
    readonly pendingSubmissionsScanned: number;
    readonly pendingSubmissionLimit: number;
    readonly pendingSubmissionsTruncated: boolean;
    readonly activeClaimsScanned: number;
    readonly activeClaimLimit: number;
    readonly activeClaimsTruncated: boolean;
  };
}

function finding(
  kind: WorkspaceIntegrityFindingKind,
  taskKey?: string,
  expected?: number,
  actual?: number,
): WorkspaceIntegrityFinding {
  return {
    kind,
    ...(taskKey === undefined ? {} : { taskKey }),
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

function asCount(value: boolean): number {
  return value ? 1 : 0;
}

function activeTask(status: BlockerLifecycle): boolean {
  return status !== "done" && status !== "cancelled";
}

export function auditRunnerAuthorityIntegrity(
  input: RunnerAuthorityIntegrityInput,
): readonly WorkspaceIntegrityFinding[] {
  const findings: WorkspaceIntegrityFinding[] = [];
  if (input.authorities.truncated || input.authorities.rows.length > 1) {
    findings.push(
      finding("runner_authority_count_mismatch", undefined, 1, input.authorities.rows.length),
    );
  }
  for (const authority of input.authorities.rows) {
    if (
      authority.organizationId !== input.workspace.organizationId ||
      authority.workspaceId !== input.workspace.id
    ) {
      findings.push(finding("runner_authority_tenant_mismatch"));
    }
    if (!Number.isSafeInteger(authority.generation) || authority.generation < 1) {
      findings.push(finding("runner_authority_generation_invalid"));
    }
    const runner = authority.runner;
    if (
      runner === null ||
      runner.id !== authority.runnerId ||
      runner.organizationId !== authority.organizationId ||
      runner.workspaceId !== authority.workspaceId ||
      runner.publicId !== authority.runnerPublicId ||
      runner.installationId !== authority.installationId ||
      runner.leaseUntil !== authority.leaseUntil
    ) {
      findings.push(finding("runner_authority_tuple_mismatch"));
    }
  }
  return findings;
}

export function auditTaskIntegrity(input: TaskIntegrityInput): TaskIntegrityAudit {
  const { task } = input;
  const findings: WorkspaceIntegrityFinding[] = [];
  const complete =
    !input.activeClaims.truncated &&
    !input.blockers.truncated &&
    !input.pendingSubmissions.truncated;

  if (
    task.organizationId !== input.workspace.organizationId ||
    task.workspaceId !== input.workspace.id
  ) {
    findings.push(finding("task_tenant_mismatch", task.key));
  }

  const shouldHaveClaim = task.status === "in_progress";
  if ((task.currentClaim !== undefined) !== shouldHaveClaim) {
    findings.push(
      finding(
        "task_claim_shape_mismatch",
        task.key,
        asCount(shouldHaveClaim),
        asCount(task.currentClaim !== undefined),
      ),
    );
  }
  const expectedActiveClaims = shouldHaveClaim ? 1 : 0;
  if (
    input.activeClaims.truncated ||
    input.activeClaims.rows.length !== expectedActiveClaims
  ) {
    findings.push(
      finding(
        "active_claim_count_mismatch",
        task.key,
        expectedActiveClaims,
        input.activeClaims.rows.length,
      ),
    );
  }
  if (task.currentClaim !== undefined) {
    if (task.currentClaim.fence !== task.claimFence) {
      findings.push(
        finding(
          "claim_fence_mismatch",
          task.key,
          task.claimFence,
          task.currentClaim.fence,
        ),
      );
    }
    const claim =
      input.activeClaims.rows.length === 1 ? input.activeClaims.rows[0] : undefined;
    if (
      claim === undefined ||
      !activeTaskClaimTupleMatches({
        taskStatus: task.status,
        taskOrganizationId: task.organizationId,
        taskWorkspaceId: task.workspaceId,
        taskId: task.id,
        compactClaimId: task.currentClaim.claimId,
        compactClaimPublicId: task.currentClaim.publicId,
        compactAgentId: task.currentClaim.agentId,
        compactAgentPublicId: task.currentClaim.agentPublicId,
        compactFence: task.currentClaim.fence,
        compactLeaseGeneration: task.currentClaim.leaseGeneration,
        compactLeaseUntil: task.currentClaim.leaseUntil,
        claimId: claim?.id ?? "",
        claimOrganizationId: claim?.organizationId ?? "",
        claimWorkspaceId: claim?.workspaceId ?? "",
        claimTaskId: claim?.taskId ?? "",
        claimPublicId: claim?.publicId ?? "",
        claimAgentId: claim?.agentId ?? "",
        claimAgentPublicId: claim?.agentPublicId ?? "",
        claimState: claim?.state ?? "missing",
        claimFence: claim?.fence ?? -1,
        claimLeaseGeneration: claim?.leaseGeneration ?? -1,
        claimLeaseUntil: claim?.leaseUntil ?? -1,
      })
    ) {
      findings.push(finding("active_claim_tuple_mismatch", task.key));
    }
  }

  let blockerRelationsValid = !input.blockers.truncated;
  let expectedUnresolved = 0;
  let expectedCancelled = 0;
  for (const relation of input.blockers.rows) {
    const blocker = relation.blocker;
    const matches =
      blocker !== null &&
      dependencyTupleMatches({
        dependencyOrganizationId: relation.edge.organizationId,
        dependencyWorkspaceId: relation.edge.workspaceId,
        dependencyBlockerTaskId: relation.edge.blockerTaskId,
        dependencyBlockedTaskId: relation.edge.blockedTaskId,
        blockerOrganizationId: blocker.organizationId,
        blockerWorkspaceId: blocker.workspaceId,
        blockerTaskId: blocker.id,
        blockedOrganizationId: task.organizationId,
        blockedWorkspaceId: task.workspaceId,
        blockedTaskId: task.id,
      });
    if (!matches) {
      blockerRelationsValid = false;
      continue;
    }
    const contribution = blockerContribution(blocker.status);
    expectedUnresolved += contribution.unresolved;
    expectedCancelled += contribution.cancelled;
  }
  if (!blockerRelationsValid && !input.blockers.truncated) {
    findings.push(finding("blocker_relation_mismatch", task.key));
  }
  if (blockerRelationsValid) {
    if (task.unresolvedBlockerCount !== expectedUnresolved) {
      findings.push(
        finding(
          "unresolved_blocker_count_mismatch",
          task.key,
          expectedUnresolved,
          task.unresolvedBlockerCount,
        ),
      );
    }
    if (task.cancelledBlockerCount !== expectedCancelled) {
      findings.push(
        finding(
          "cancelled_blocker_count_mismatch",
          task.key,
          expectedCancelled,
          task.cancelledBlockerCount,
        ),
      );
    }
    const expectedBlocked = expectedUnresolved + expectedCancelled > 0;
    if ((task.isBlocked === true) !== expectedBlocked) {
      findings.push(
        finding(
          "blocked_projection_mismatch",
          task.key,
          asCount(expectedBlocked),
          asCount(task.isBlocked === true),
        ),
      );
    }
    const expectedReady = derivedReady({
      status: task.status,
      availableAt: task.availableAt,
      now: input.now,
      unresolved: expectedUnresolved,
      cancelled: expectedCancelled,
    });
    if (task.isReady !== expectedReady) {
      findings.push(
        finding(
          "ready_projection_mismatch",
          task.key,
          asCount(expectedReady),
          asCount(task.isReady),
        ),
      );
    }
    const expectedAttention = derivedNeedsAttention({
      status: task.status,
      unresolved: expectedUnresolved,
      cancelled: expectedCancelled,
    });
    if ((task.needsAttention === true) !== expectedAttention) {
      findings.push(
        finding(
          "attention_projection_mismatch",
          task.key,
          asCount(expectedAttention),
          asCount(task.needsAttention === true),
        ),
      );
    }
  }

  const expectedPending = task.status === "in_review" ? 1 : 0;
  const actualPending = input.pendingSubmissions.rows.length;
  if (input.pendingSubmissions.truncated || actualPending !== expectedPending) {
    findings.push(
      finding(
        "pending_submission_count_mismatch",
        task.key,
        expectedPending,
        actualPending,
      ),
    );
  }
  const submission = actualPending === 1 ? input.pendingSubmissions.rows[0] : undefined;
  if (submission !== undefined) {
    if (
      !taskScopedRecordMatches({
        taskOrganizationId: task.organizationId,
        taskWorkspaceId: task.workspaceId,
        taskId: task.id,
        recordOrganizationId: submission.organizationId,
        recordWorkspaceId: submission.workspaceId,
        recordTaskId: submission.taskId,
      })
    ) {
      findings.push(finding("pending_submission_tuple_mismatch", task.key));
    }
    if (submission.reviewRevision !== task.reviewRevision) {
      findings.push(
        finding(
          "submission_review_revision_mismatch",
          task.key,
          task.reviewRevision,
          submission.reviewRevision,
        ),
      );
    }
  }

  if (input.latestEvent === null) {
    findings.push(finding("latest_event_missing", task.key, task.revision, -1));
  } else {
    const event = input.latestEvent;
    if (
      !taskScopedRecordMatches({
        taskOrganizationId: task.organizationId,
        taskWorkspaceId: task.workspaceId,
        taskId: task.id,
        recordOrganizationId: event.organizationId,
        recordWorkspaceId: event.workspaceId,
        recordTaskId: event.taskId,
      }) ||
      event.taskPublicId !== task.publicId
    ) {
      findings.push(finding("latest_event_tuple_mismatch", task.key));
    }
    if (event.taskRevision !== task.revision) {
      findings.push(
        finding(
          "latest_event_revision_mismatch",
          task.key,
          task.revision,
          event.taskRevision,
        ),
      );
    }
  }

  return {
    findings,
    complete,
    coverage: {
      blockersScanned: input.blockers.rows.length,
      blockerLimit: input.blockers.limit,
      blockersTruncated: input.blockers.truncated,
      pendingSubmissionsScanned: input.pendingSubmissions.rows.length,
      pendingSubmissionLimit: input.pendingSubmissions.limit,
      pendingSubmissionsTruncated: input.pendingSubmissions.truncated,
      activeClaimsScanned: input.activeClaims.rows.length,
      activeClaimLimit: input.activeClaims.limit,
      activeClaimsTruncated: input.activeClaims.truncated,
    },
  };
}

export function buildWorkspaceIntegrityPage(input: WorkspaceIntegrityPageInput) {
  const taskAudits = input.tasks.map(auditTaskIntegrity);
  const authorityFindings = auditRunnerAuthorityIntegrity({
    workspace: input.workspace,
    authorities: input.runnerAuthorities,
  });
  const findings = [
    ...taskAudits.flatMap((audit) => audit.findings),
    ...authorityFindings,
  ];
  const workspaceComplete = input.startedAtBeginning && input.nextCursor === null;
  const activeTaskCount = input.tasks.filter((row) => activeTask(row.task.status)).length;
  const totalTaskCount = input.tasks.length;
  let grantsComplete = !input.activeGrants.truncated;
  let activeAgentCount = 0;

  for (const grant of input.activeGrants.rows) {
    if (
      grant.organizationId !== input.workspace.organizationId ||
      grant.workspaceId !== input.workspace.id
    ) {
      grantsComplete = false;
      findings.push(finding("active_grant_tenant_mismatch"));
      continue;
    }
    if (
      grant.agent === null ||
      grant.agent.id !== grant.agentId ||
      grant.agent.organizationId !== input.workspace.organizationId
    ) {
      grantsComplete = false;
      findings.push(finding("active_grant_agent_mismatch"));
      continue;
    }
    if (grant.agent.status === "active") activeAgentCount += 1;
  }

  const usage = input.usage;
  if (usage === null) {
    findings.push(finding("workspace_usage_missing"));
  } else if (
    usage.organizationId !== input.workspace.organizationId ||
    usage.workspaceId !== input.workspace.id
  ) {
    findings.push(finding("workspace_usage_tenant_mismatch"));
  } else {
    if (workspaceComplete && usage.activeTasks !== activeTaskCount) {
      findings.push(
        finding(
          "active_task_usage_mismatch",
          undefined,
          activeTaskCount,
          usage.activeTasks,
        ),
      );
    }
    if (workspaceComplete && usage.totalTasks !== totalTaskCount) {
      findings.push(
        finding("total_task_usage_mismatch", undefined, totalTaskCount, usage.totalTasks),
      );
    }
    if (grantsComplete && usage.activeAgents !== activeAgentCount) {
      findings.push(
        finding(
          "active_agent_usage_mismatch",
          undefined,
          activeAgentCount,
          usage.activeAgents,
        ),
      );
    }
  }

  const findingLimit = WORKSPACE_INTEGRITY_LIMITS.findings;
  const findingsTruncated = findings.length > findingLimit;
  const taskRelationsComplete = taskAudits.every((audit) => audit.complete);
  const authoritiesComplete =
    !input.runnerAuthorities.truncated && input.runnerAuthorities.rows.length <= 1;
  const pageComplete =
    taskRelationsComplete && grantsComplete && authoritiesComplete && !findingsTruncated;
  const renderedFindings = findings.slice(0, findingLimit);
  const pageClean = pageComplete && renderedFindings.length === 0;

  return {
    generatedAt: input.now,
    workspacePublicId: input.workspace.publicId,
    nextCursor: input.nextCursor,
    workspaceComplete,
    workspaceClean: workspaceComplete && pageClean,
    pageComplete,
    pageClean,
    observed: {
      tasks: totalTaskCount,
      activeTasks: activeTaskCount,
      activeGrants: input.activeGrants.rows.length,
      activeAgents: activeAgentCount,
      runnerAuthorities: input.runnerAuthorities.rows.length,
    },
    usageSnapshot:
      usage === null
        ? null
        : {
            activeTasks: usage.activeTasks,
            totalTasks: usage.totalTasks,
            activeAgents: usage.activeAgents,
            updatedAt: usage.updatedAt,
          },
    taskFingerprints: input.tasks.map(({ task }) => ({
      taskKey: task.key,
      revision: task.revision,
    })),
    findings: renderedFindings,
    coverage: {
      tasks: {
        scanned: totalTaskCount,
        limit: input.taskLimit,
        complete: input.nextCursor === null,
      },
      blockerRelations: {
        scanned: taskAudits.reduce(
          (sum, audit) => sum + audit.coverage.blockersScanned,
          0,
        ),
        perTaskLimit: WORKSPACE_INTEGRITY_LIMITS.directBlockers,
        truncatedTasks: taskAudits.filter((audit) => audit.coverage.blockersTruncated)
          .length,
      },
      activeClaims: {
        scanned: taskAudits.reduce(
          (sum, audit) => sum + audit.coverage.activeClaimsScanned,
          0,
        ),
        perTaskLimit: WORKSPACE_INTEGRITY_LIMITS.activeClaims,
        truncatedTasks: taskAudits.filter(
          (audit) => audit.coverage.activeClaimsTruncated,
        ).length,
      },
      pendingSubmissions: {
        scanned: taskAudits.reduce(
          (sum, audit) => sum + audit.coverage.pendingSubmissionsScanned,
          0,
        ),
        perTaskLimit: WORKSPACE_INTEGRITY_LIMITS.pendingSubmissions,
        truncatedTasks: taskAudits.filter(
          (audit) => audit.coverage.pendingSubmissionsTruncated,
        ).length,
      },
      activeGrants: {
        scanned: input.activeGrants.rows.length,
        limit: input.activeGrants.limit,
        truncated: input.activeGrants.truncated,
      },
      runnerAuthorities: {
        scanned: input.runnerAuthorities.rows.length,
        limit: input.runnerAuthorities.limit,
        truncated: input.runnerAuthorities.truncated,
      },
      findings: {
        observed: findings.length,
        limit: findingLimit,
        truncated: findingsTruncated,
      },
    },
  };
}

export type WorkspaceIntegrityPage = ReturnType<typeof buildWorkspaceIntegrityPage>;

export interface WorkspaceIntegrityScanInput {
  readonly workspacePublicId: string;
  readonly generatedAt: number;
  readonly maxPages: number;
  readonly passes: readonly (readonly WorkspaceIntegrityPage[])[];
}

interface ScanPassSummary {
  readonly complete: boolean;
  readonly pages: number;
  readonly tasks: number;
  readonly activeTasks: number;
  readonly fingerprints: readonly { readonly taskKey: string; readonly revision: number }[];
  readonly usage: WorkspaceIntegrityPage["usageSnapshot"];
  readonly findings: readonly WorkspaceIntegrityFinding[];
}

function sameUsage(
  left: WorkspaceIntegrityPage["usageSnapshot"],
  right: WorkspaceIntegrityPage["usageSnapshot"],
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.activeTasks === right.activeTasks &&
    left.totalTasks === right.totalTasks &&
    left.activeAgents === right.activeAgents &&
    left.updatedAt === right.updatedAt
  );
}

function summarizeScanPass(
  workspacePublicId: string,
  maxPages: number,
  pages: readonly WorkspaceIntegrityPage[],
): ScanPassSummary {
  const fingerprints = pages.flatMap((page) => page.taskFingerprints);
  const uniqueTaskKeys = new Set(fingerprints.map(({ taskKey }) => taskKey));
  const findings = pages.flatMap((page) => page.findings);
  if (uniqueTaskKeys.size !== fingerprints.length) {
    findings.push(
      finding("task_scan_duplicate", undefined, uniqueTaskKeys.size, fingerprints.length),
    );
  }
  const usage = pages[0]?.usageSnapshot ?? null;
  const stableUsage =
    usage !== null && pages.every((page) => sameUsage(usage, page.usageSnapshot));
  const tasks = pages.reduce((sum, page) => sum + page.observed.tasks, 0);
  const activeTasks = pages.reduce((sum, page) => sum + page.observed.activeTasks, 0);
  const sequenceComplete =
    pages.length > 0 &&
    pages.length <= maxPages &&
    pages.at(-1)?.nextCursor === null;
  const complete =
    sequenceComplete &&
    stableUsage &&
    pages.every(
      (page) =>
        page.workspacePublicId === workspacePublicId && page.pageComplete,
    );

  if (sequenceComplete && usage !== null) {
    if (usage.activeTasks !== activeTasks) {
      findings.push(
        finding("active_task_usage_mismatch", undefined, activeTasks, usage.activeTasks),
      );
    }
    if (usage.totalTasks !== tasks) {
      findings.push(finding("total_task_usage_mismatch", undefined, tasks, usage.totalTasks));
    }
  }

  return {
    complete,
    pages: pages.length,
    tasks,
    activeTasks,
    fingerprints,
    usage,
    findings,
  };
}

function fingerprintKey(
  fingerprints: readonly { readonly taskKey: string; readonly revision: number }[],
): string {
  return JSON.stringify(
    [...fingerprints]
      .sort((left, right) => left.taskKey.localeCompare(right.taskKey))
      .map(({ taskKey, revision }) => [taskKey, revision]),
  );
}

function uniqueFindings(
  findings: readonly WorkspaceIntegrityFinding[],
): WorkspaceIntegrityFinding[] {
  const seen = new Set<string>();
  return findings.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildWorkspaceIntegrityScan(input: WorkspaceIntegrityScanInput) {
  const passSummaries = input.passes.map((pages) =>
    summarizeScanPass(input.workspacePublicId, input.maxPages, pages),
  );
  const first = passSummaries[0];
  const second = passSummaries[1];
  const stable =
    first !== undefined &&
    second !== undefined &&
    first.complete &&
    second.complete &&
    sameUsage(first.usage, second.usage) &&
    fingerprintKey(first.fingerprints) === fingerprintKey(second.fingerprints);
  const findings = uniqueFindings(passSummaries.flatMap((pass) => pass.findings));
  if (first !== undefined && second !== undefined && !stable) {
    findings.push(finding("task_scan_changed"));
  }
  const findingLimit = WORKSPACE_INTEGRITY_LIMITS.findings;
  const findingsTruncated = findings.length > findingLimit;
  const renderedFindings = findings.slice(0, findingLimit);
  const complete = stable && !findingsTruncated;

  return {
    generatedAt: input.generatedAt,
    workspacePublicId: input.workspacePublicId,
    scanComplete: complete,
    scanClean: complete && renderedFindings.length === 0,
    observed: {
      passes: passSummaries.length,
      pages: passSummaries.reduce((sum, pass) => sum + pass.pages, 0),
      tasks: second?.tasks ?? first?.tasks ?? 0,
      activeTasks: second?.activeTasks ?? first?.activeTasks ?? 0,
      activeAgents: second?.usage?.activeAgents ?? first?.usage?.activeAgents ?? 0,
    },
    findings: renderedFindings,
    coverage: {
      maximumPagesPerPass: input.maxPages,
      completedPasses: passSummaries.filter((pass) => pass.complete).length,
      findings: {
        observed: findings.length,
        limit: findingLimit,
        truncated: findingsTruncated,
      },
    },
  };
}

export const workspaceIntegrityFindingKindValidator = v.union(
  v.literal("task_tenant_mismatch"),
  v.literal("task_claim_shape_mismatch"),
  v.literal("claim_fence_mismatch"),
  v.literal("active_claim_count_mismatch"),
  v.literal("active_claim_tuple_mismatch"),
  v.literal("blocker_relation_mismatch"),
  v.literal("unresolved_blocker_count_mismatch"),
  v.literal("cancelled_blocker_count_mismatch"),
  v.literal("blocked_projection_mismatch"),
  v.literal("ready_projection_mismatch"),
  v.literal("attention_projection_mismatch"),
  v.literal("pending_submission_count_mismatch"),
  v.literal("pending_submission_tuple_mismatch"),
  v.literal("submission_review_revision_mismatch"),
  v.literal("latest_event_missing"),
  v.literal("latest_event_tuple_mismatch"),
  v.literal("latest_event_revision_mismatch"),
  v.literal("workspace_usage_missing"),
  v.literal("workspace_usage_tenant_mismatch"),
  v.literal("active_task_usage_mismatch"),
  v.literal("total_task_usage_mismatch"),
  v.literal("active_agent_usage_mismatch"),
  v.literal("active_grant_tenant_mismatch"),
  v.literal("active_grant_agent_mismatch"),
  v.literal("runner_authority_count_mismatch"),
  v.literal("runner_authority_tenant_mismatch"),
  v.literal("runner_authority_tuple_mismatch"),
  v.literal("runner_authority_generation_invalid"),
  v.literal("task_scan_changed"),
  v.literal("task_scan_duplicate"),
);

const coverageValidator = v.object({
  scanned: v.number(),
  limit: v.number(),
  truncated: v.boolean(),
});

export const workspaceIntegrityPageValidator = v.object({
  generatedAt: v.number(),
  workspacePublicId: v.string(),
  nextCursor: v.union(v.string(), v.null()),
  workspaceComplete: v.boolean(),
  workspaceClean: v.boolean(),
  pageComplete: v.boolean(),
  pageClean: v.boolean(),
  observed: v.object({
    tasks: v.number(),
    activeTasks: v.number(),
    activeGrants: v.number(),
    activeAgents: v.number(),
    runnerAuthorities: v.number(),
  }),
  usageSnapshot: v.union(
    v.object({
      activeTasks: v.number(),
      totalTasks: v.number(),
      activeAgents: v.number(),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  taskFingerprints: v.array(
    v.object({ taskKey: v.string(), revision: v.number() }),
  ),
  findings: v.array(
    v.object({
      kind: workspaceIntegrityFindingKindValidator,
      taskKey: v.optional(v.string()),
      expected: v.optional(v.number()),
      actual: v.optional(v.number()),
    }),
  ),
  coverage: v.object({
    tasks: v.object({ scanned: v.number(), limit: v.number(), complete: v.boolean() }),
    blockerRelations: v.object({
      scanned: v.number(),
      perTaskLimit: v.number(),
      truncatedTasks: v.number(),
    }),
    activeClaims: v.object({
      scanned: v.number(),
      perTaskLimit: v.number(),
      truncatedTasks: v.number(),
    }),
    pendingSubmissions: v.object({
      scanned: v.number(),
      perTaskLimit: v.number(),
      truncatedTasks: v.number(),
    }),
    activeGrants: coverageValidator,
    runnerAuthorities: coverageValidator,
    findings: v.object({ observed: v.number(), limit: v.number(), truncated: v.boolean() }),
  }),
});

export const workspaceIntegrityScanValidator = v.object({
  generatedAt: v.number(),
  workspacePublicId: v.string(),
  scanComplete: v.boolean(),
  scanClean: v.boolean(),
  observed: v.object({
    passes: v.number(),
    pages: v.number(),
    tasks: v.number(),
    activeTasks: v.number(),
    activeAgents: v.number(),
  }),
  findings: v.array(
    v.object({
      kind: workspaceIntegrityFindingKindValidator,
      taskKey: v.optional(v.string()),
      expected: v.optional(v.number()),
      actual: v.optional(v.number()),
    }),
  ),
  coverage: v.object({
    maximumPagesPerPass: v.number(),
    completedPasses: v.number(),
    findings: v.object({ observed: v.number(), limit: v.number(), truncated: v.boolean() }),
  }),
});
