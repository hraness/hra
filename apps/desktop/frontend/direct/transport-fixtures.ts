import { FIXTURE_QUERY_KEY } from "@hraness/direct";
import { LOGICAL_RUNTIME_SCHEMA } from "@hraness/direct/core";
import type { DirectSessionActivation } from "@hraness/direct/testing";
import {
  RUNNER_PRESENCE_LEASE_MS,
  taskWorkspaceViewValues,
  type PortableRunProjection,
  type PortableTaskCommand,
  type TaskDetailProjection,
} from "@hraness/agent-tasks-protocol";

import { runtimeProtocolVersion } from "../../contracts/runtime";
import { hraDirectDefinition } from "./scenarios";
import {
  createHRADirectWorld,
  emptySnapshot,
  fixtureLocalWorkspace,
  fixtureTaskDetail,
  fixtureTaskPage,
  fixtureTaskView,
  HRA_DIRECT_ACTIVE_DEADLINE,
  HRA_DIRECT_ACTIVE_REQUEST_TIME,
  HRA_DIRECT_TIME,
  hraDirectTaskIds,
  hraDirectTaskStateIds,
  type HRADirectWorld,
  type HRADirectWorldInput,
} from "./world";

const logicalRuntime = {
  schema: LOGICAL_RUNTIME_SCHEMA,
  nowMs: HRA_DIRECT_TIME,
  nextOperation: 1,
  acceleration: 100,
} as const;

const localTaskWorkspace = fixtureLocalWorkspace(7);
const localTask = fixtureTaskView({
  id: "tsk_00000000000000000000000000",
  key: "KIT-0000000",
  revision: 7,
  status: "open",
  title: "Wire local task surface",
});

function directRun(
  id: string,
  taskKey: string,
  phase: PortableRunProjection["phase"],
  options: {
    readonly desiredState?: "run" | "stop";
    readonly interactions?: PortableRunProjection["interactions"];
    readonly updatedAt?: number;
  } = {},
): PortableRunProjection {
  const updatedAt = options.updatedAt ?? HRA_DIRECT_TIME;
  return {
    id,
    taskKey,
    phase,
    repositoryId: hraDirectTaskIds.repository,
    desiredState: options.desiredState ?? "run",
    updatedAt,
    events: [{
      id: `event_${id.slice(4)}`,
      sequence: 1,
      kind: phase === "failed"
        ? "run.failed"
        : phase === "cancelled"
          ? "run.cancelled"
          : phase === "queued"
            ? "run.queued"
            : phase === "submitted"
              ? "run.submitted"
              : "codex.running",
      observedAt: updatedAt,
    }],
    interactions: options.interactions ?? [],
  };
}

function taskState(
  id: string,
  revision: number,
  details: readonly TaskDetailProjection[],
) {
  const tasks = details.map(({ task }) => task);
  const runsByTaskKey = Object.fromEntries(details.flatMap(({ runs }) => {
    const latest = [...runs].sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return latest === undefined
      ? []
      : [[latest.taskKey, {
          phase: latest.phase,
          updatedAt: latest.updatedAt,
        }] as const];
  }));
  const humanInputsByTaskKey = Object.fromEntries(details.flatMap(({ runs }) =>
    runs.flatMap((run) => {
      const pending = run.interactions
        .filter(({ state }) => state === "pending")
        .toSorted((left, right) =>
          left.request.createdAt - right.request.createdAt ||
          left.request.id.localeCompare(right.request.id)
        );
      const first = pending[0]?.request;
      if (first === undefined) return [];
      return [[run.taskKey, {
        expiresAt: Math.min(...pending.map(({ request }) => request.expiresAt)),
        kind: first.kind === "file_change_approval"
          ? "approval" as const
          : "user_input" as const,
        oldestRequestedAt: first.createdAt,
        pendingCount: pending.length,
        preview: first.kind === "file_change_approval"
          ? "File change approval requested."
          : first.questions[0]?.prompt ?? "User input requested.",
      }] as const];
    })
  ));
  const tasksForView = (
    view: (typeof taskWorkspaceViewValues)[number],
  ): typeof tasks => {
    switch (view) {
      case "all":
        return tasks;
      case "ready":
        return tasks.filter(({ isReady }) => isReady);
      case "blocked":
        return tasks.filter(({ unresolvedBlockerCount }) =>
          unresolvedBlockerCount > 0
        );
      case "deferred":
        return tasks.filter(({ availableAt }) => availableAt > HRA_DIRECT_TIME);
      case "attention":
        return tasks.filter(({ key }) => humanInputsByTaskKey[key] !== undefined);
      case "assigned":
        return tasks.filter((task) =>
          task.status === "in_progress" &&
          task.currentClaim.agentId === "agent_local"
        );
      case "review":
        return tasks.filter(({ status }) => status === "in_review");
    }
  };
  const workspace = {
    ...fixtureLocalWorkspace(revision),
    counts: Object.fromEntries(taskWorkspaceViewValues.map((view) => [
      view,
      { capped: false, value: tasksForView(view).length },
    ])),
  };
  return {
    id,
    projectionJson: JSON.stringify({
      workspaces: [workspace],
      contexts: [{
        workspaceId: hraDirectTaskIds.workspace,
        projectionRevision: revision,
        viewer: { kind: "local_owner", id: "install_local0001", name: "You" },
        agents: [{ id: "agent_local", name: "Local agent", status: "active" }],
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
        runner: {
          state: "ready",
          serverTime: HRA_DIRECT_TIME,
          leaseUntil: HRA_DIRECT_TIME + RUNNER_PRESENCE_LEASE_MS,
          availableCapacity: 1,
        },
      }],
      repositories: [{
        workspaceId: hraDirectTaskIds.workspace,
        projectionRevision: revision,
        repositories: [{
          id: hraDirectTaskIds.repository,
          name: "Local hra",
          ready: true,
        }],
      }],
      pages: taskWorkspaceViewValues.map((view) => ({
        requestCursor: null,
        page: fixtureTaskPage({
          humanInputsByTaskKey,
          tasks: tasksForView(view),
          projectionRevision: revision,
          runsByTaskKey,
          view,
        }),
      })),
      details,
    }),
  };
}

const localTaskState = taskState("ready", 7, [
  fixtureTaskDetail({ task: localTask, projectionRevision: 7 }),
]);

function runReceipt(
  commandKind: "dispatch.stop" | "dispatch.retry" | "dispatch.resolve_ambiguity",
  workspaceRevision: number,
  runId: string,
  phase: "cancel_requested" | "cancelled" | "failed" | "queued",
) {
  return JSON.stringify({
    receiptId: "receipt_00000000000000000000000000",
    operationId: "op_00000000000000000000000000",
    workspaceId: hraDirectTaskIds.workspace,
    commandKind,
    commandDigest: `sha256_${"a".repeat(64)}`,
    recordedAt: HRA_DIRECT_TIME,
    outcome: "committed" as const,
    workspaceRevision,
    eventSequence: 1,
    eventIds: ["wevt_00000000000000000000000000"],
    eventKinds: ["run.changed" as const],
    result: { kind: "run_updated" as const, runId, phase },
  });
}

function reviewReceipt(
  commandKind: "review.accept" | "review.reject",
  workspaceRevision: number,
  taskId: string,
  submissionId: string,
) {
  return JSON.stringify({
    receiptId: "receipt_00000000000000000000000000",
    operationId: "op_00000000000000000000000000",
    workspaceId: hraDirectTaskIds.workspace,
    commandKind,
    commandDigest: `sha256_${"b".repeat(64)}`,
    recordedAt: HRA_DIRECT_TIME,
    outcome: "committed" as const,
    workspaceRevision,
    eventSequence: 1,
    eventIds: ["wevt_00000000000000000000000000"],
    eventKinds: ["task.changed" as const],
    result: {
      kind: "submission_updated" as const,
      taskId,
      submissionId,
      taskRevision: workspaceRevision,
    },
  });
}

function interactionReceipt(
  workspaceRevision: number,
  runId: string,
  interactionId: string,
) {
  return JSON.stringify({
    receiptId: "receipt_00000000000000000000000000",
    operationId: "op_00000000000000000000000000",
    workspaceId: hraDirectTaskIds.workspace,
    commandKind: "interaction.respond" as const,
    commandDigest: `sha256_${"c".repeat(64)}`,
    recordedAt: HRA_DIRECT_TIME,
    outcome: "committed" as const,
    workspaceRevision,
    eventSequence: 1,
    eventIds: ["wevt_00000000000000000000000000"],
    eventKinds: ["interaction.changed" as const],
    result: {
      kind: "interaction_updated" as const,
      runId,
      interactionId,
      state: "answered" as const,
    },
  });
}

const expectedOperationId = "op_00000000000000000000000000";
const localTaskAuthority = {
  kind: "local_owner" as const,
  installationId: "install_local0001",
  workspaceId: hraDirectTaskIds.workspace,
};

function expectedTaskCommand(command: PortableTaskCommand): string {
  return JSON.stringify(command);
}

function taskFixtureWorld(
  initialStateId: string,
  states: HRADirectWorldInput["task"]["states"],
  mutationTransitions: HRADirectWorldInput["task"]["mutationTransitions"] = [],
) {
  return createHRADirectWorld({
    task: {
      initialStateId,
      states,
      mutationTransitions,
      projectAdd: { version: runtimeProtocolVersion, status: "cancelled" },
    },
  });
}

const runningTaskA = fixtureTaskView({
  id: hraDirectTaskIds.currentTask,
  key: "KIT-0000001",
  revision: 11,
  status: "in_progress",
  title: "Run the first lane",
});
const runningTaskB = fixtureTaskView({
  id: "tsk_00000000000000000000000002",
  key: "KIT-0000002",
  revision: 11,
  status: "in_progress",
  title: "Run the second lane",
});
const twoRunningState = taskState("two-running", 11, [
  fixtureTaskDetail({
    task: runningTaskA,
    projectionRevision: 11,
    runs: [directRun(hraDirectTaskIds.currentRun, runningTaskA.key, "running")],
  }),
  fixtureTaskDetail({
    task: runningTaskB,
    projectionRevision: 11,
    runs: [directRun("run_lane_two", runningTaskB.key, "running")],
  }),
]);
const twoRunningDisplayState = taskState(
  hraDirectTaskStateIds.currentRunDisplayRevision12,
  12,
  [
    fixtureTaskDetail({
      task: runningTaskA,
      projectionRevision: 12,
      runs: [directRun(
        hraDirectTaskIds.currentRun,
        runningTaskA.key,
        "running",
        { updatedAt: HRA_DIRECT_TIME + 1 },
      )],
    }),
    fixtureTaskDetail({
      task: runningTaskB,
      projectionRevision: 12,
      runs: [directRun("run_lane_two", runningTaskB.key, "running")],
    }),
  ],
);

const hitlTask = fixtureTaskView({
  id: "tsk_00000000000000000000000003",
  key: "KIT-0000003",
  revision: 12,
  status: "in_progress",
  title: "Approve a local change",
});
const hitlRunId = "run_hitl_pending";
const hitlInteractionId = "interaction_hitl_pending";
const pendingHitlState = taskState("hitl-pending", 12, [
  fixtureTaskDetail({
    task: hitlTask,
    projectionRevision: 12,
    runs: [directRun(hitlRunId, hitlTask.key, "waiting", {
      interactions: [{
        runId: hitlRunId,
        request: {
          id: hitlInteractionId,
          createdAt: HRA_DIRECT_ACTIVE_REQUEST_TIME,
          expiresAt: HRA_DIRECT_ACTIVE_DEADLINE,
          kind: "file_change_approval",
          scope: "once",
        },
        state: "pending",
      }],
    })],
  }),
]);
const answeredHitlState = taskState("hitl-answered", 13, [
  fixtureTaskDetail({
    task: hitlTask,
    projectionRevision: 13,
    runs: [directRun(hitlRunId, hitlTask.key, "waiting", {
      interactions: [{
        runId: hitlRunId,
        request: {
          id: hitlInteractionId,
          createdAt: HRA_DIRECT_ACTIVE_REQUEST_TIME,
          expiresAt: HRA_DIRECT_ACTIVE_DEADLINE,
          kind: "file_change_approval",
          scope: "once",
        },
        state: "answered",
        responseRevision: 1,
        respondedAt: HRA_DIRECT_ACTIVE_REQUEST_TIME + 1,
      }],
    })],
  }),
]);

const reviewTask = fixtureTaskView({
  id: "tsk_00000000000000000000000004",
  key: "KIT-0000004",
  revision: 14,
  reviewRevision: 14,
  status: "in_review",
  title: "Review submitted work",
});
const reviewSubmissionId = "sub_00000000000000000000000000";
const pendingSubmission = {
  id: reviewSubmissionId,
  evidence: [],
  reviewRevision: 14,
  status: "pending" as const,
  submittedAt: HRA_DIRECT_TIME,
  submittedBy: {
    kind: "local_owner" as const,
    id: "install_local0001",
    name: "You",
  },
  summary: "Ready for review.",
  taskKey: reviewTask.key,
};
const reviewPendingState = taskState("review-pending", 14, [
  fixtureTaskDetail({
    task: reviewTask,
    projectionRevision: 14,
    submission: pendingSubmission,
  }),
]);
const reviewAcceptedState = taskState("review-accepted", 15, [
  fixtureTaskDetail({
    task: fixtureTaskView({
      ...reviewTask,
      revision: 15,
      reviewRevision: 15,
      status: "done",
    }),
    projectionRevision: 15,
    submission: {
      ...pendingSubmission,
      reviewRevision: 15,
      status: "accepted",
      reviewedAt: HRA_DIRECT_TIME + 1,
    },
  }),
]);
const reviewRejectedState = taskState("review-rejected", 15, [
  fixtureTaskDetail({
    task: fixtureTaskView({
      ...reviewTask,
      revision: 15,
      reviewRevision: 15,
      status: "open",
    }),
    projectionRevision: 15,
    submission: {
      ...pendingSubmission,
      reviewRevision: 15,
      status: "rejected",
      reviewReason: "Needs a deterministic replay check.",
      reviewedAt: HRA_DIRECT_TIME + 1,
    },
  }),
]);

const stopTask = fixtureTaskView({
  id: "tsk_00000000000000000000000005",
  key: "KIT-0000005",
  revision: 16,
  status: "in_progress",
  title: "Stop a running dispatch",
});
const stopRunId = "run_stop_current";
const runningStopState = taskState("stop-running", 16, [
  fixtureTaskDetail({
    task: stopTask,
    projectionRevision: 16,
    runs: [directRun(stopRunId, stopTask.key, "running")],
  }),
]);
const stopRequestedState = taskState("stop-requested", 17, [
  fixtureTaskDetail({
    task: stopTask,
    projectionRevision: 17,
    runs: [directRun(
      stopRunId,
      stopTask.key,
      "cancel_requested",
      { desiredState: "stop" },
    )],
  }),
]);

const retryTask = fixtureTaskView({
  id: "tsk_00000000000000000000000006",
  key: "KIT-0000006",
  revision: 18,
  status: "open",
  title: "Retry a failed dispatch",
});
const failedRunId = "run_failed_source";
const failedState = taskState("failed", 18, [
  fixtureTaskDetail({
    task: retryTask,
    projectionRevision: 18,
    runs: [directRun(failedRunId, retryTask.key, "failed")],
  }),
]);
const retryQueuedState = taskState("retry-queued", 19, [
  fixtureTaskDetail({
    task: retryTask,
    projectionRevision: 19,
    runs: [
      directRun("run_retry_queued", retryTask.key, "queued", {
        updatedAt: HRA_DIRECT_TIME + 1,
      }),
      directRun(failedRunId, retryTask.key, "failed"),
    ],
  }),
]);

const ambiguousTask = fixtureTaskView({
  id: "tsk_00000000000000000000000007",
  key: "KIT-0000007",
  revision: 20,
  status: "in_progress",
  title: "Resolve ambiguous dispatch",
});
const ambiguousRunId = "run_ambiguous_source";
const ambiguousState = taskState("ambiguous", 20, [
  fixtureTaskDetail({
    task: ambiguousTask,
    projectionRevision: 20,
    runs: [directRun(ambiguousRunId, ambiguousTask.key, "ambiguous")],
  }),
]);
const ambiguityResolvedState = taskState("ambiguity-resolved", 21, [
  fixtureTaskDetail({
    task: fixtureTaskView({ ...ambiguousTask, revision: 21, status: "open" }),
    projectionRevision: 21,
    runs: [directRun(
      ambiguousRunId,
      ambiguousTask.key,
      "cancelled",
      { desiredState: "stop" },
    )],
  }),
]);

const localReadyWorld = createHRADirectWorld({
  task: {
    initialStateId: localTaskState.id,
    states: [localTaskState],
    mutationTransitions: [],
    projectAdd: {
      version: runtimeProtocolVersion,
      status: "created",
      repository: {
        id: hraDirectTaskIds.repository,
        name: "Local hra",
        createdAt: HRA_DIRECT_TIME,
      },
      workspace: localTaskWorkspace,
    },
  },
});

const hitlPendingWorld = taskFixtureWorld(
  pendingHitlState.id,
  [pendingHitlState, answeredHitlState],
  [{
    id: "hitl-answer",
    commandKind: "interaction.respond",
    expectedCommandJson: expectedTaskCommand({
      authority: localTaskAuthority,
      expectedWorkspaceRevision: 12,
      interactionId: hitlInteractionId,
      kind: "interaction.respond",
      operationId: expectedOperationId,
      request: {
        id: hitlInteractionId,
        createdAt: HRA_DIRECT_ACTIVE_REQUEST_TIME,
        expiresAt: HRA_DIRECT_ACTIVE_DEADLINE,
        kind: "file_change_approval",
        scope: "once",
      },
      response: {
        decision: "approve_once",
        kind: "file_change_approval",
      },
      runId: hitlRunId,
    }),
    receiptJson: interactionReceipt(13, hitlRunId, hitlInteractionId),
    toStateId: answeredHitlState.id,
    invalidation: {
      workspaceId: hraDirectTaskIds.workspace,
      projectionRevision: 13,
      scope: "task_detail",
      taskId: hitlTask.id,
    },
  }],
);

const reviewAcceptWorld = taskFixtureWorld(
  reviewPendingState.id,
  [reviewPendingState, reviewAcceptedState],
  [{
    id: "review-accept",
    commandKind: "review.accept",
    expectedCommandJson: expectedTaskCommand({
      authority: localTaskAuthority,
      expectedReviewRevision: 14,
      expectedWorkspaceRevision: 14,
      kind: "review.accept",
      operationId: expectedOperationId,
      submissionId: reviewSubmissionId,
      taskId: reviewTask.id,
    }),
    receiptJson: reviewReceipt(
      "review.accept",
      15,
      reviewTask.id,
      reviewSubmissionId,
    ),
    toStateId: reviewAcceptedState.id,
    invalidation: {
      workspaceId: hraDirectTaskIds.workspace,
      projectionRevision: 15,
      scope: "task_detail",
      taskId: reviewTask.id,
    },
  }],
);

const reviewRejectWorld = taskFixtureWorld(
  reviewPendingState.id,
  [reviewPendingState, reviewRejectedState],
  [{
    id: "review-reject",
    commandKind: "review.reject",
    expectedCommandJson: expectedTaskCommand({
      authority: localTaskAuthority,
      expectedReviewRevision: 14,
      expectedWorkspaceRevision: 14,
      kind: "review.reject",
      operationId: expectedOperationId,
      reason: "Needs a deterministic replay check.",
      submissionId: reviewSubmissionId,
      taskId: reviewTask.id,
    }),
    receiptJson: reviewReceipt(
      "review.reject",
      15,
      reviewTask.id,
      reviewSubmissionId,
    ),
    toStateId: reviewRejectedState.id,
    invalidation: {
      workspaceId: hraDirectTaskIds.workspace,
      projectionRevision: 15,
      scope: "task_detail",
      taskId: reviewTask.id,
    },
  }],
);

const stopRequestedWorld = taskFixtureWorld(
  runningStopState.id,
  [runningStopState, stopRequestedState],
  [{
    id: "stop-requested",
    commandKind: "dispatch.stop",
    expectedCommandJson: expectedTaskCommand({
      authority: localTaskAuthority,
      expectedWorkspaceRevision: 16,
      kind: "dispatch.stop",
      operationId: expectedOperationId,
      runId: stopRunId,
    }),
    receiptJson: runReceipt(
      "dispatch.stop",
      17,
      stopRunId,
      "cancel_requested",
    ),
    toStateId: stopRequestedState.id,
    invalidation: {
      workspaceId: hraDirectTaskIds.workspace,
      projectionRevision: 17,
      scope: "task_detail",
      taskId: stopTask.id,
    },
  }],
);

const retryFailedWorld = taskFixtureWorld(
  failedState.id,
  [failedState, retryQueuedState],
  [{
    id: "retry-failed",
    commandKind: "dispatch.retry",
    expectedCommandJson: expectedTaskCommand({
      authority: localTaskAuthority,
      expectedTaskRevision: 18,
      expectedWorkspaceRevision: 18,
      kind: "dispatch.retry",
      operationId: expectedOperationId,
      sourceRunId: failedRunId,
      taskId: retryTask.id,
    }),
    receiptJson: runReceipt(
      "dispatch.retry",
      19,
      "run_retry_queued",
      "queued",
    ),
    toStateId: retryQueuedState.id,
    invalidation: {
      workspaceId: hraDirectTaskIds.workspace,
      projectionRevision: 19,
      scope: "task_detail",
      taskId: retryTask.id,
    },
  }],
);

const ambiguityResolvedWorld = taskFixtureWorld(
  ambiguousState.id,
  [ambiguousState, ambiguityResolvedState],
  [{
    id: "ambiguity-cancelled",
    commandKind: "dispatch.resolve_ambiguity",
    expectedCommandJson: expectedTaskCommand({
      authority: localTaskAuthority,
      expectedTaskRevision: 20,
      expectedWorkspaceRevision: 20,
      kind: "dispatch.resolve_ambiguity",
      operationId: expectedOperationId,
      reason: "confirmed_cancelled",
      sourceRunId: ambiguousRunId,
      taskId: ambiguousTask.id,
    }),
    receiptJson: runReceipt(
      "dispatch.resolve_ambiguity",
      21,
      ambiguousRunId,
      "cancelled",
    ),
    toStateId: ambiguityResolvedState.id,
    invalidation: {
      workspaceId: hraDirectTaskIds.workspace,
      projectionRevision: 21,
      scope: "task_detail",
      taskId: ambiguousTask.id,
    },
  }],
);

const restartResnapshotWorld = createHRADirectWorld({
  gateway: {
    snapshots: [emptySnapshot(), emptySnapshot(undefined, 2)],
    encoding: { kind: "chunked", chunkBytes: 257 },
    events: [{
      delayMs: 25,
      event: {
        version: runtimeProtocolVersion,
        sequence: 2,
        event: {
          type: "task.invalidated",
          invalidation: {
            workspaceId: hraDirectTaskIds.workspace,
            projectionRevision: 11,
            scope: "workspace",
          },
        },
      },
    }],
  },
  task: {
    initialStateId: twoRunningState.id,
    states: [twoRunningState],
    mutationTransitions: [],
    projectAdd: { version: runtimeProtocolVersion, status: "cancelled" },
  },
});

const taskTransportFixtureWorlds = {
  "ambiguity-resolved": ambiguityResolvedWorld,
  "hitl-pending": hitlPendingWorld,
  "local-ready": localReadyWorld,
  "restart-resnapshot": restartResnapshotWorld,
  "retry-failed": retryFailedWorld,
  "review-accept": reviewAcceptWorld,
  "review-reject": reviewRejectWorld,
  "stop-requested": stopRequestedWorld,
  "two-running": taskFixtureWorld(twoRunningState.id, [
    twoRunningState,
    twoRunningDisplayState,
  ]),
} as const satisfies Readonly<Record<string, HRADirectWorld>>;

export type HRATaskTransportFixtureId = keyof typeof taskTransportFixtureWorlds;

export function getHRATaskTransportFixture(id: HRATaskTransportFixtureId) {
  return {
    runtime: logicalRuntime,
    world: taskTransportFixtureWorlds[id],
  } as const;
}

export function createHRATaskTransportFixtureActivation(
  id: HRATaskTransportFixtureId,
): DirectSessionActivation {
  const fixture = getHRATaskTransportFixture(id);
  const serialized = hraDirectDefinition.serializeFixture({
    scenario: "chat-draft",
    world: fixture.world,
    runtime: fixture.runtime,
  });
  if (!serialized.ok) throw new Error(serialized.error.message);
  return {
    kind: "query",
    source: `?${FIXTURE_QUERY_KEY}=${encodeURIComponent(serialized.value)}`,
  };
}
