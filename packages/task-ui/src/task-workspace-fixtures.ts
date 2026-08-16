import type { TaskView } from "@hraness/agent-tasks-protocol";

/** Deterministic examples for tests, Direct, and non-authoritative previews. */

import type {
  TaskWorkspaceActionResult,
  TaskWorkspaceActions,
  TaskWorkspaceDetail,
  TaskWorkspaceListItem,
  TaskWorkspaceProps,
} from "./task-workspace-state";

export const taskWorkspaceFixtureNow = Date.UTC(2026, 6, 19, 16, 0, 0);

const human = {
  id: "user_fixturehuman",
  kind: "human",
  name: "Mara Chen",
} as const;

const workerAgent = {
  id: "agt_worker",
  kind: "agent",
  name: "Build Scout",
  status: "active",
} as const;

const disabledAgent = {
  id: "agt_disabled",
  kind: "agent",
  name: "Retired Reviewer",
  status: "disabled",
} as const;

const system = {
  id: "system_claim_expiry",
  jobKind: "claim_expiry",
  kind: "system",
} as const;

export const reviewTaskFixture: TaskView = {
  availableAt: taskWorkspaceFixtureNow - 3_600_000,
  cancelledBlockerCount: 1,
  createdAt: taskWorkspaceFixtureNow - 86_400_000,
  id: "tsk_00000000000000000000000001",
  isReady: false,
  key: "AT-12AB3CD",
  priority: 1,
  reviewRevision: 4,
  revision: 9,
  status: "in_review",
  title: "Fence credential revocation across active sessions",
  type: "feature",
  unresolvedBlockerCount: 1,
  updatedAt: taskWorkspaceFixtureNow - 600_000,
  assigneeAgentId: workerAgent.id,
};

export const expiredClaimTaskFixture: TaskView = {
  availableAt: taskWorkspaceFixtureNow - 7_200_000,
  cancelledBlockerCount: 0,
  createdAt: taskWorkspaceFixtureNow - 172_800_000,
  currentClaim: {
    agentId: disabledAgent.id,
    fence: 7,
    id: "clm_fixture",
    leaseGeneration: 3,
    leaseUntil: taskWorkspaceFixtureNow - 60_000,
  },
  id: "tsk_00000000000000000000000002",
  isReady: false,
  key: "AT-45EF6GH",
  priority: 0,
  reviewRevision: 1,
  revision: 7,
  status: "in_progress",
  title: "Repair the stale claim projection",
  type: "bug",
  unresolvedBlockerCount: 0,
  updatedAt: taskWorkspaceFixtureNow - 120_000,
  assigneeAgentId: disabledAgent.id,
};

export const deferredTaskFixture: TaskView = {
  availableAt: taskWorkspaceFixtureNow + 86_400_000,
  cancelledBlockerCount: 0,
  createdAt: taskWorkspaceFixtureNow - 40_000,
  id: "tsk_00000000000000000000000003",
  isReady: false,
  key: "AT-78JK9MN",
  priority: 3,
  reviewRevision: 1,
  revision: 1,
  status: "open",
  title: "Run the provider reconciliation load test",
  type: "chore",
  unresolvedBlockerCount: 0,
  updatedAt: taskWorkspaceFixtureNow - 40_000,
};

export function taskListItemFixture(
  task: TaskView,
  overrides: Partial<Pick<TaskWorkspaceListItem, "humanInput" | "run">> = {},
): TaskWorkspaceListItem {
  return {
    humanInput: null,
    run: null,
    task,
    ...overrides,
  };
}

const cancelledBlocker = {
  id: "tsk_00000000000000000000000004",
  key: "AT-22PQ3RS",
  priority: 2,
  revision: 5,
  status: "cancelled",
  title: "Retired provider adapter spike",
} as const;

export const reviewTaskDetailFixture: TaskWorkspaceDetail = {
  blockers: [{ createdAt: taskWorkspaceFixtureNow - 70_000_000, task: cancelledBlocker }],
  children: [
    {
      id: "tsk_00000000000000000000000005",
      key: "AT-33ST4VW",
      priority: 2,
      revision: 2,
      status: "open",
      title: "Document operator recovery",
    },
  ],
  comments: [
    {
      actor: human,
      body: "Keep the credential kill switch isolated from the persistent agent identity.",
      createdAt: taskWorkspaceFixtureNow - 3_600_000,
      id: "cmt_01J3ABCDEFGHJKMNPQRSTVWXYZ",
    },
    {
      actor: workerAgent,
      body: "The black-box revocation case now proves the sibling credential remains usable.",
      createdAt: taskWorkspaceFixtureNow - 1_800_000,
      id: "cmt_01J4ABCDEFGHJKMNPQRSTVWXYZ",
    },
    {
      actor: system,
      body: "A previous claim expired and its fence was retired.",
      createdAt: taskWorkspaceFixtureNow - 1_200_000,
      id: "cmt_01J5ABCDEFGHJKMNPQRSTVWXYZ",
    },
  ],
  dependents: [
    {
      createdAt: taskWorkspaceFixtureNow - 60_000_000,
      task: {
        id: "tsk_00000000000000000000000006",
        key: "AT-44WX5YZ",
        priority: 1,
        revision: 3,
        status: "open",
        title: "Ship the private-alpha operator surface",
      },
    },
  ],
  description:
    "Prove that revoking one credential stops its process sessions immediately while a sibling credential for the same persistent agent remains authorized.",
  events: [
    {
      actor: human,
      createdAt: taskWorkspaceFixtureNow - 86_400_000,
      id: "evt_created",
      summary: "Created the task and assigned the security label.",
      taskRevision: 1,
      type: "task.created",
    },
    {
      actor: workerAgent,
      createdAt: taskWorkspaceFixtureNow - 900_000,
      id: "evt_submitted",
      summary: "Submitted immutable evidence for human review.",
      taskRevision: 9,
      type: "task.submitted",
    },
    {
      actor: system,
      createdAt: taskWorkspaceFixtureNow - 750_000,
      id: "evt_repair",
      summary: "Verified the readiness projection after submission.",
      taskRevision: 9,
      type: "task.updated",
    },
  ],
  labels: ["auth", "security", "private-alpha"],
  parent: {
    id: "tsk_00000000000000000000000007",
    key: "AT-11BC2DE",
    priority: 1,
    revision: 12,
    status: "in_progress",
    title: "Cloud-friendly agent identity",
  },
  recoveries: [{ kind: "access_revoked" }],
  references: [
    {
      createdAt: taskWorkspaceFixtureNow - 2_000_000,
      id: "ref_01J3ABCDEFGHJKMNPQRSTVWXYZ",
      kind: "pull_request",
      url: "https://github.com/example/agent-tasks/pull/42",
    },
    {
      createdAt: taskWorkspaceFixtureNow - 1_900_000,
      id: "ref_01J4ABCDEFGHJKMNPQRSTVWXYZ",
      kind: "commit",
      sha: "abc123def456",
      url: "https://github.com/example/agent-tasks/commit/abc123def456",
    },
  ],
  runs: [
    {
      desiredState: "run",
      events: [
        {
          id: "event_0123456789abcdefghjkmnpqrs",
          kind: "worktree.ready",
          observedAt: taskWorkspaceFixtureNow - 1_500_000,
          sequence: 1,
        },
        {
          id: "event_0123456789abcdefghjkmnpqrt",
          kind: "codex.testing",
          observedAt: taskWorkspaceFixtureNow - 1_000_000,
          sequence: 2,
        },
        {
          id: "event_0123456789abcdefghjkmnpqrv",
          kind: "run.submitted",
          observedAt: taskWorkspaceFixtureNow - 900_000,
          sequence: 3,
        },
      ],
      id: "run_0123456789abcdefghjkmnpqrs",
      interactions: [],
      phase: "submitted",
      repositoryId: "repo_0123456789ABCDEFGHJKMNPQRS",
      taskKey: reviewTaskFixture.key,
      updatedAt: taskWorkspaceFixtureNow - 900_000,
    },
  ],
  submission: {
    evidence: [
      { kind: "pull_request", url: "https://github.com/example/agent-tasks/pull/42" },
      { kind: "test", command: "bun run test:local:human" },
      { kind: "note", text: "Sibling credential remained authorized after revocation." },
    ],
    id: "sub_01J3ABCDEFGHJKMNPQRSTVWXYZ",
    reviewRevision: 4,
    status: "pending",
    submittedAt: taskWorkspaceFixtureNow - 900_000,
    submittedBy: workerAgent,
    summary: "Added credential-scoped revocation and black-box coverage for active process sessions.",
    taskKey: reviewTaskFixture.key,
  },
  task: reviewTaskFixture,
  truncatedCollections: [],
};

export const expiredClaimTaskDetailFixture: TaskWorkspaceDetail = {
  blockers: [],
  children: [],
  comments: [],
  dependents: [],
  description: "Repair counters after an agent disappeared beyond its lease deadline.",
  events: [],
  labels: ["repair"],
  parent: null,
  recoveries: [{ kind: "access_revoked" }],
  references: [],
  runs: [
    {
      desiredState: "run",
      events: [{
        id: "event_1123456789abcdefghjkmnpqrs",
        kind: "run.lease_lost",
        observedAt: taskWorkspaceFixtureNow - 60_000,
        sequence: 1,
      }],
      id: "run_1123456789abcdefghjkmnpqrs",
      interactions: [],
      phase: "ambiguous",
      repositoryId: "repo_0123456789ABCDEFGHJKMNPQRS",
      taskKey: expiredClaimTaskFixture.key,
      updatedAt: taskWorkspaceFixtureNow - 60_000,
    },
  ],
  submission: null,
  task: expiredClaimTaskFixture,
  truncatedCollections: [],
};

const successfulAction = (): Promise<TaskWorkspaceActionResult> =>
  Promise.resolve({ ok: true, requestId: "req_01J3ABCDEFGHJKMNPQRSTVWXYZ" });

export const taskWorkspaceFixtureActions: TaskWorkspaceActions = {
  acceptSubmission: successfulAction,
  abandonAmbiguousRun: successfulAction,
  addBlocker: successfulAction,
  addComment: successfulAction,
  addLabel: successfulAction,
  addReference: successfulAction,
  cancelTask: successfulAction,
  clearParent: successfulAction,
  createTask: successfulAction,
  deferTask: successfulAction,
  loadMore: () => undefined,
  rejectSubmission: successfulAction,
  removeBlocker: successfulAction,
  removeLabel: successfulAction,
  removeReference: successfulAction,
  reopenTask: successfulAction,
  respondToRunInteraction: successfulAction,
  requestRunStop: successfulAction,
  retryRun: successfulAction,
  selectTask: () => undefined,
  setAssignee: successfulAction,
  setParent: successfulAction,
  updateTask: successfulAction,
  viewChanged: () => undefined,
};

const commonProps = {
  actions: taskWorkspaceFixtureActions,
  agents: [
    { id: workerAgent.id, name: workerAgent.name, status: workerAgent.status },
    { id: disabledAgent.id, name: disabledAgent.name, status: disabledAgent.status },
  ],
  capabilities: {
    canAssign: true,
    canCancel: true,
    canComment: true,
    canCreate: true,
    canEdit: true,
    canManageGraph: true,
    canManageLabels: true,
    canManageReferences: true,
    canReopen: true,
    canReview: true,
  },
  counts: {
    all: { capped: false, value: 3 },
    assigned: { capped: false, value: 2 },
    attention: { capped: false, value: 2 },
    blocked: { capped: false, value: 1 },
    deferred: { capped: false, value: 1 },
    ready: { capped: false, value: 0 },
    review: { capped: false, value: 1 },
  },
  now: taskWorkspaceFixtureNow,
  runner: {
    presence: {
      availableCapacity: 1,
      leaseUntil: taskWorkspaceFixtureNow + 45_000,
      serverTime: taskWorkspaceFixtureNow,
      state: "ready",
    },
    repositories: [{
      id: "repo_0123456789ABCDEFGHJKMNPQRS",
      name: "example",
      ready: true,
    }],
  },
  viewer: human,
  workspace: {
    id: "wsp_fixture",
    keyPrefix: "AT",
    name: "HRA",
    slug: "hra",
  },
} as const;

export const taskWorkspaceLoadingFixture: TaskWorkspaceProps = {
  ...commonProps,
  read: { kind: "loading", view: "all" },
};

export const taskWorkspaceErrorFixture: TaskWorkspaceProps = {
  ...commonProps,
  read: {
    error: { code: "SERVICE_UNAVAILABLE", reference: "req_fixture" },
    kind: "error",
    view: "attention",
  },
};

export const taskWorkspaceEmptyFixture: TaskWorkspaceProps = {
  ...commonProps,
  read: {
    cursor: null,
    kind: "ready",
    selection: { kind: "none" },
    tasks: [],
    view: "ready",
  },
};

export const taskWorkspaceReadyFixture: TaskWorkspaceProps = {
  ...commonProps,
  read: {
    cursor: "cursor_fixture",
    kind: "ready",
    selection: { detail: reviewTaskDetailFixture, kind: "ready" },
    tasks: [
      taskListItemFixture(reviewTaskFixture),
      taskListItemFixture(expiredClaimTaskFixture),
      taskListItemFixture(deferredTaskFixture),
    ],
    view: "all",
  },
};

export const taskWorkspaceExpiredClaimFixture: TaskWorkspaceProps = {
  ...commonProps,
  read: {
    cursor: null,
    kind: "ready",
    selection: { detail: expiredClaimTaskDetailFixture, kind: "ready" },
    tasks: [taskListItemFixture(expiredClaimTaskFixture)],
    view: "attention",
  },
};
