import {
  defineDirect,
  type ScenarioDefinitionInput,
} from "@hraness/direct";
import { LOGICAL_RUNTIME_SCHEMA } from "@hraness/direct/core";

import { toPortableRunInteractionRequest } from "../app/task-run-boundary";
import {
  AGENT_TASKS_DIRECT_TIME,
  agentTasksDeferredTask,
  agentTasksExpiredClaimDetail,
  agentTasksExpiredClaimTask,
  agentTasksReviewTask,
  createAgentTasksDirectWorld,
  parseAgentTasksDirectWorld,
  parseAgentTasksTaskView,
  type AgentTasksDirectWorld,
} from "./world";

export type AgentTasksDirectRoute = "/";
export type AgentTasksDirectViewport = "compact" | "stacked" | "wide";

export interface AgentTasksScenarioMetadata {
  readonly group: "Capabilities" | "Queues" | "Recovery" | "Review" | "Runner" | "Workflow";
  readonly viewport: AgentTasksDirectViewport;
}

const runtime = {
  schema: LOGICAL_RUNTIME_SCHEMA,
  nowMs: AGENT_TASKS_DIRECT_TIME,
  nextOperation: 1,
  acceleration: 100,
} as const;

const createRequest = {
  description: "Capture one deterministic control-plane regression.",
  kind: "createTask" as const,
  labels: ["reconciliation", "direct"],
  priority: 2 as const,
  repositoryId: "repo_0123456789ABCDEFGHJKMNPQRS",
  title: "Trace provider reconciliation drift",
  type: "task" as const,
};
const createdTask = {
  availableAt: AGENT_TASKS_DIRECT_TIME,
  cancelledBlockerCount: 0,
  createdAt: AGENT_TASKS_DIRECT_TIME,
  id: "tsk_00000000000000000000000014",
  isReady: true,
  key: "AT-9XZ2KMN",
  priority: 2 as const,
  reviewRevision: 1,
  revision: 1,
  status: "open" as const,
  title: createRequest.title,
  type: createRequest.type,
  unresolvedBlockerCount: 0,
  updatedAt: AGENT_TASKS_DIRECT_TIME,
};
const createdDetail = {
  blockers: [],
  children: [],
  comments: [],
  dependents: [],
  description: createRequest.description,
  events: [{
    actor: { id: "user_fixturehuman", kind: "human" as const, name: "Mara Chen" },
    createdAt: AGENT_TASKS_DIRECT_TIME,
    id: "evt_created_fixture",
    summary: "Created the task from the deterministic human control plane.",
    taskRevision: 1,
    type: "task.created" as const,
  }],
  labels: [...createRequest.labels],
  parent: null,
  recoveries: [],
  references: [],
  runs: [{
    desiredState: "run" as const,
    events: [{
      id: "event_createdqueue0000000000001",
      kind: "run.queued" as const,
      observedAt: AGENT_TASKS_DIRECT_TIME,
      sequence: 1,
    }],
    id: "run_createdfixture000000000001",
    interactions: [],
    phase: "queued" as const,
    repositoryId: createRequest.repositoryId,
    taskKey: createdTask.key,
    updatedAt: AGENT_TASKS_DIRECT_TIME,
  }],
  submission: null,
  task: createdTask,
  truncatedCollections: [],
};

type RunFixture = NonNullable<AgentTasksDirectWorld["details"][number]["runs"]>[number];
type RunEventKind = RunFixture["events"][number]["kind"];
type RunStatusEventKind = Exclude<
  RunEventKind,
  "codex.assistant_message.delta" | "codex.reasoning_summary.delta"
>;

const primaryRunId = "run_direct_primary0001";
const retryRunId = "run_direct_retry0000001";
const fixtureRepositoryId = createRequest.repositoryId;

function createRunFixture(options: Readonly<{
  desiredState?: RunFixture["desiredState"];
  eventKinds: readonly RunStatusEventKind[];
  eventToken: string;
  id?: string;
  phase: RunFixture["phase"];
}>): RunFixture {
  return {
    desiredState: options.desiredState ?? "run",
    events: options.eventKinds.map((kind, index) => ({
      id: `event_direct_${options.eventToken}_${String(index + 1)}`,
      kind,
      observedAt: AGENT_TASKS_DIRECT_TIME - (options.eventKinds.length - index) * 1_000,
      sequence: index + 1,
    })),
    id: options.id ?? primaryRunId,
    interactions: [],
    phase: options.phase,
    repositoryId: fixtureRepositoryId,
    taskKey: agentTasksReviewTask.key,
    updatedAt: AGENT_TASKS_DIRECT_TIME - 1_000,
  };
}

function configureDispatchRun(
  world: AgentTasksDirectWorld,
  run: RunFixture,
): AgentTasksDirectWorld["details"][number] {
  world.activeView = "all";
  world.selectedTaskKey = agentTasksReviewTask.key;
  const detail = world.details.find(({ task }) => task.key === agentTasksReviewTask.key);
  if (detail === undefined) throw new Error("Review detail is required.");
  const hasClaim = [
    "leased",
    "provisioning",
    "starting",
    "running",
    "waiting",
    "cancel_requested",
    "ambiguous",
  ].some((phase) => phase === run.phase);
  const status = run.phase === "submitted"
    ? "in_review"
    : hasClaim
      ? "in_progress"
      : "open";
  const isReady = run.phase === "failed" || run.phase === "cancelled";
  const nextTask: Record<string, unknown> = {
    ...detail.task,
    cancelledBlockerCount: 0,
    isReady,
    revision: 10,
    status,
    unresolvedBlockerCount: 0,
    updatedAt: world.now - 1_000,
  };
  if (hasClaim) {
    nextTask.currentClaim = {
      agentId: "agt_worker",
      fence: 11,
      id: "clm_dispatch_fixture",
      leaseGeneration: 2,
      leaseUntil: world.now + 90_000,
    };
  } else {
    delete nextTask.currentClaim;
  }
  detail.task = parseAgentTasksTaskView(nextTask);
  detail.blockers = [];
  detail.events = [];
  detail.recoveries = [];
  detail.runs = [run];
  if (run.phase !== "submitted") detail.submission = null;
  for (const state of Object.values(world.views)) {
    if (state.kind !== "ready") continue;
    state.tasks = state.tasks.map((task) => task.key === detail.task.key ? detail.task : task);
  }
  return detail;
}

const scenarioInputs = [
  {
    id: "tasks-empty-ready",
    title: "Ready queue is empty",
    description: "The real control plane explains that no task can be claimed without fabricating loading work.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      world.activeView = "ready";
      for (const view of Object.keys(world.views) as (keyof typeof world.views)[]) {
        world.views[view] = { cursor: null, kind: "ready", tasks: [] };
        world.counts[view] = { capped: false, value: 0 };
      }
      world.selectedTaskKey = null;
      world.details = [];
    }),
    runtime,
  },
  {
    id: "tasks-query-failed",
    title: "Attention query failed",
    description: "A bounded read error remains a human-readable control-plane state with a correlation reference.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      world.activeView = "attention";
      world.views.attention = {
        error: { code: "SERVICE_UNAVAILABLE", reference: "req_direct_query" },
        kind: "error",
      };
      world.selectedTaskKey = null;
    }),
    runtime,
  },
  {
    id: "tasks-rich-review",
    title: "Rich immutable review",
    description: "Graph edges, actors, evidence, references, comments, events, and recovery guidance render together.",
    route: "/",
    world: createAgentTasksDirectWorld(),
    runtime,
  },
  {
    id: "runner-offline",
    title: "Desktop runner offline",
    description: "The task control plane keeps durable work queueable while clearly reporting that HRA is offline.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      if (world.runner === undefined) throw new Error("Runner fixture is required.");
      world.runner.presence = { serverTime: world.now, state: "offline" };
      world.runner.repositories[0] = {
        ...world.runner.repositories[0]!,
        ready: false,
      };
    }),
    runtime,
  },
  {
    id: "runner-heartbeat-expired",
    title: "Runner heartbeat expires",
    description: "A formerly ready heartbeat becomes offline at its authoritative lease deadline instead of leaving a stale green state.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      if (world.runner === undefined) throw new Error("Runner fixture is required.");
      world.runner.presence = {
        availableCapacity: 1,
        leaseUntil: world.now,
        serverTime: world.now - 45_000,
        state: "ready",
      };
    }),
    runtime,
  },
  {
    id: "runner-run-streaming",
    title: "Codex run streams a minimal public display",
    description: "Consecutive bounded reasoning deltas coalesce, assistant text stays readable, and anonymous tool work becomes one elapsed indicator.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      if (world.runner === undefined) throw new Error("Runner fixture is required.");
      world.runner.presence = {
        leaseUntil: world.now + 45_000,
        serverTime: world.now,
        state: "busy",
      };
      const detail = world.details.find(({ task }) => task.key === agentTasksReviewTask.key);
      if (detail === undefined) throw new Error("Review detail is required.");
      detail.runs = [{
        desiredState: "run",
        events: [
          { id: "event_streamworktree00000000001", kind: "worktree.ready", observedAt: world.now - 30_000, sequence: 1 },
          { displayText: "Checking the dispatch ", id: "event_streamthinking0000000002", kind: "codex.reasoning_summary.delta", observedAt: world.now - 25_000, sequence: 2 },
          { displayText: "lease before editing.", id: "event_streamthinking0000000003", kind: "codex.reasoning_summary.delta", observedAt: world.now - 24_000, sequence: 3 },
          { displayText: "The lease is sound; I’m applying the change.", id: "event_streamresponse0000000004", kind: "codex.assistant_message.delta", observedAt: world.now - 20_000, sequence: 4 },
          { id: "event_streamtoolstart0000000005", kind: "codex.tool_activity.started", observedAt: world.now - 10_000, sequence: 5 },
        ],
        id: "run_streamingfixture0000000001",
        interactions: [],
        phase: "running",
        repositoryId: "repo_0123456789ABCDEFGHJKMNPQRS",
        taskKey: detail.task.key,
        updatedAt: world.now - 1_000,
      }];
    }),
    runtime,
  },
  {
    id: "runner-blocked-account",
    title: "Runner blocked without an account",
    description: "A live desktop lease remains visibly unavailable when no connected Codex account can accept work.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      if (world.runner === undefined) throw new Error("Runner fixture is required.");
      world.runner.presence = {
        leaseUntil: world.now + 45_000,
        reason: "no_account",
        serverTime: world.now,
        state: "blocked",
      };
      world.runner.repositories[0] = { ...world.runner.repositories[0]!, ready: false };
    }),
    runtime,
  },
  {
    id: "runner-blocked-credential",
    title: "Runner credential expired",
    description: "An invalid runner credential removes dispatch readiness without exposing credential material or provider identity.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      if (world.runner === undefined) throw new Error("Runner fixture is required.");
      world.runner.presence = {
        leaseUntil: world.now + 45_000,
        reason: "credential_invalid",
        serverTime: world.now,
        state: "blocked",
      };
      world.runner.repositories[0] = { ...world.runner.repositories[0]!, ready: false };
    }),
    runtime,
  },
  {
    id: "runner-ready",
    title: "Runner ready to dispatch",
    description: "A server-derived lease and mapped repository present one honest ready state before a human creates work.",
    route: "/",
    world: createAgentTasksDirectWorld(),
    runtime,
  },
  {
    id: "runner-draining",
    title: "Runner draining",
    description: "A draining desktop keeps active work observable while refusing new dispatch claims.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      if (world.runner === undefined) throw new Error("Runner fixture is required.");
      world.runner.presence = {
        leaseUntil: world.now + 45_000,
        serverTime: world.now,
        state: "draining",
      };
      world.runner.repositories[0] = { ...world.runner.repositories[0]!, ready: false };
    }),
    runtime,
  },
  {
    id: "tasks-readiness-race",
    title: "Ready display races with dispatch",
    description: "Even when HRA looked ready at submit time, the exact create result remains one durable queued task and run.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      world.activeView = "all";
      for (const view of Object.keys(world.views) as (keyof typeof world.views)[]) {
        world.views[view] = { cursor: null, kind: "ready", tasks: [] };
        world.counts[view] = { capped: false, value: 0 };
      }
      world.selectedTaskKey = null;
      world.details = [];
      world.scripts.commands = [{
        request: createRequest,
        outcome: {
          kind: "response",
          value: {
            detail: createdDetail,
            requestId: "req_readiness_race",
            task: createdTask,
            transition: "created",
          },
        },
      }];
    }),
    runtime,
  },
  {
    id: "runner-worktree-failed",
    title: "Worktree preparation failed",
    description: "A typed local preparation failure becomes an immutable failed attempt with no path, command, or raw error in browser state.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      configureDispatchRun(world, createRunFixture({
        eventKinds: ["worktree.preparing", "run.failed"],
        eventToken: "worktree_failed",
        phase: "failed",
      }));
    }),
    runtime,
  },
  {
    id: "runner-start-ambiguous",
    title: "Codex start outcome is ambiguous",
    description: "A lost response after Codex start quarantines the attempt and requires proof of stop before retry.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      configureDispatchRun(world, createRunFixture({
        eventKinds: ["worktree.preparing", "worktree.ready", "codex.starting", "run.lease_lost"],
        eventToken: "start_ambiguous",
        phase: "ambiguous",
      }));
    }),
    runtime,
  },
  {
    id: "runner-waiting-approval",
    title: "Codex waits for approval",
    description: "The web offers one bounded managed-worktree edit decision without rendering paths, commands, or a diff.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      const run = createRunFixture({
        eventKinds: ["worktree.ready", "codex.running", "codex.waiting_for_approval"],
        eventToken: "waiting_approval",
        phase: "waiting",
      });
      const request = {
        id: "interaction_directapproval01",
        kind: "file_change_approval" as const,
        scope: "once" as const,
        createdAt: world.now - 1_000,
        expiresAt: world.now + 60_000,
        reply: {
          version: 1 as const,
          algorithm: "P256-HKDF-SHA256-A256GCM" as const,
          keyId: `hitlkey_${"a".repeat(32)}`,
          publicKey: "B".repeat(87),
          runnerId: "runner_direct001",
          bootId: "boot_direct0001",
          bootGeneration: 1,
          claimId: "claim_direct001",
          claimFence: 1,
          requestDigest: `sha256_${"b".repeat(64)}`,
        },
      };
      run.interactions = [{
        runId: run.id,
        request,
        state: "pending",
      }];
      configureDispatchRun(world, run);
      world.scripts.interactions = [{
        request: {
          interactionId: request.id,
          request: toPortableRunInteractionRequest(request),
          response: { kind: "file_change_approval", decision: "approve_once" },
          runId: run.id,
        },
        outcome: { kind: "response", requestId: "req_direct_approval" },
      }];
    }),
    runtime,
  },
  {
    id: "runner-waiting-question",
    title: "Codex waits for human input",
    description: "The real question form sends one exact bounded answer while keeping provider and key material out of the page.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      const run = createRunFixture({
        eventKinds: ["worktree.ready", "codex.running", "codex.waiting_for_input"],
        eventToken: "waiting_question",
        phase: "waiting",
      });
      const request = {
        id: "interaction_directquestion01",
        kind: "user_input" as const,
        createdAt: world.now - 1_000,
        expiresAt: world.now + 60_000,
        questions: [{
          id: "question_directgate01",
          header: "Verification",
          prompt: "Which gate should run before merge?",
          allowOther: true,
          options: [
            {
              id: "option_directfullgate01",
              label: "Full repository gate",
              description: "Run the complete deterministic repository check.",
            },
            {
              id: "option_directnarrow01",
              label: "Narrow package gate",
              description: "Run only the affected package checks.",
            },
          ],
        }],
        reply: {
          version: 1 as const,
          algorithm: "P256-HKDF-SHA256-A256GCM" as const,
          keyId: `hitlkey_${"c".repeat(32)}`,
          publicKey: "D".repeat(87),
          runnerId: "runner_direct001",
          bootId: "boot_direct0001",
          bootGeneration: 1,
          claimId: "claim_direct001",
          claimFence: 1,
          requestDigest: `sha256_${"d".repeat(64)}`,
        },
      };
      const question = request.questions[0];
      const option = question?.options[0];
      if (question === undefined || option === undefined) {
        throw new Error("The deterministic question fixture must contain one selectable option.");
      }
      const response = {
        kind: "user_input" as const,
        answers: [{
          questionId: question.id,
          selectedOptionIds: [option.id],
        }],
      };
      run.interactions = [{ runId: run.id, request, state: "pending" }];
      const detail = configureDispatchRun(world, run);
      const all = world.views.all;
      if (all.kind !== "ready") throw new Error("The all view must be ready.");
      all.tasks = [...all.tasks.filter(({ key }) => key !== detail.task.key), detail.task];
      world.scripts.interactions = [{
        request: {
          interactionId: request.id,
          request: toPortableRunInteractionRequest(request),
          response,
          runId: run.id,
        },
        outcome: { kind: "response", requestId: "req_direct_question" },
      }];
    }),
    runtime,
  },
  {
    id: "runner-input-changed",
    title: "Task input changed during execution",
    description: "A stale attempt waits for attention instead of submitting against a changed task revision.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      const detail = configureDispatchRun(world, createRunFixture({
        eventKinds: ["worktree.ready", "codex.running", "codex.waiting_for_input"],
        eventToken: "input_changed",
        phase: "waiting",
      }));
      detail.description = "Task input changed after this attempt started. Stop it before retrying against the new revision.";
    }),
    runtime,
  },
  {
    id: "runner-run-submitted",
    title: "Codex result submitted for review",
    description: "A completed run creates a review submission and preserves ordered semantic lifecycle evidence.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      configureDispatchRun(world, createRunFixture({
        eventKinds: ["worktree.ready", "codex.running", "codex.testing", "run.submitted"],
        eventToken: "submitted",
        phase: "submitted",
      }));
    }),
    runtime,
  },
  {
    id: "runner-queued-cancel",
    title: "Queued run cancellation",
    description: "Cancel queued run consumes one exact command and records terminal cancellation before any local side effect.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      const queued = createRunFixture({
        eventKinds: ["run.queued"],
        eventToken: "queued_cancel",
        phase: "queued",
      });
      configureDispatchRun(world, queued);
      world.scripts.commands = [{
        request: { kind: "requestRunStop", runId: primaryRunId },
        outcome: {
          kind: "response",
          value: {
            requestId: "req_queued_cancelled",
            run: { ...queued, desiredState: "stop", phase: "cancelled", updatedAt: world.now },
            transition: "stop_recorded",
          },
        },
      }];
    }),
    runtime,
  },
  {
    id: "runner-failed-retry",
    title: "Failed run retry",
    description: "Retry preserves the failed attempt and creates one new queued attempt against the current task revision.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      const failed = createRunFixture({
        eventKinds: ["worktree.ready", "run.failed"],
        eventToken: "failed_retry",
        phase: "failed",
      });
      const detail = configureDispatchRun(world, failed);
      world.scripts.commands = [{
        request: { kind: "retryRun", runId: primaryRunId, taskRevision: detail.task.revision },
        outcome: {
          kind: "response",
          value: {
            requestId: "req_failed_retried",
            run: createRunFixture({
              eventKinds: ["run.queued"],
              eventToken: "failed_retry_new",
              id: retryRunId,
              phase: "queued",
            }),
            transition: "retried",
          },
        },
      }];
    }),
    runtime,
  },
  {
    id: "runner-cancelled-retry",
    title: "Cancelled run retry",
    description: "Retry never rewinds a cancelled attempt; it appends one separate queued run.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      const cancelled = createRunFixture({
        desiredState: "stop",
        eventKinds: ["run.queued", "run.cancelled"],
        eventToken: "cancelled_retry",
        phase: "cancelled",
      });
      const detail = configureDispatchRun(world, cancelled);
      world.scripts.commands = [{
        request: { kind: "retryRun", runId: primaryRunId, taskRevision: detail.task.revision },
        outcome: {
          kind: "response",
          value: {
            requestId: "req_cancelled_retried",
            run: createRunFixture({
              eventKinds: ["run.queued"],
              eventToken: "cancelled_retry_new",
              id: retryRunId,
              phase: "queued",
            }),
            transition: "retried",
          },
        },
      }];
    }),
    runtime,
  },
  {
    id: "runner-ambiguous-resolve",
    title: "Ambiguous run resolution",
    description: "A human confirmation records a cancelled outcome, releases the reservation, and only then exposes retry.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      const ambiguous = createRunFixture({
        eventKinds: ["worktree.ready", "codex.starting", "run.lease_lost"],
        eventToken: "ambiguous_resolve",
        phase: "ambiguous",
      });
      const detail = configureDispatchRun(world, ambiguous);
      world.scripts.commands = [{
        request: {
          kind: "abandonAmbiguousRun",
          reason: "confirmed_cancelled",
          runId: primaryRunId,
          taskRevision: detail.task.revision,
        },
        outcome: {
          kind: "response",
          value: {
            requestId: "req_ambiguity_resolved",
            run: { ...ambiguous, desiredState: "stop", phase: "cancelled", updatedAt: world.now },
            transition: "ambiguity_resolved",
          },
        },
      }];
    }),
    runtime,
  },
  {
    id: "tasks-review-rejected",
    title: "Review rejection recovery",
    description: "One exact human rejection preserves evidence, records the reason, and reopens work for a new claim.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      world.scripts.commands = [{
        request: {
          kind: "rejectSubmission",
          reason: "Evidence does not prove sibling credential isolation.",
          reviewRevision: 4,
          submissionId: "sub_01J3ABCDEFGHJKMNPQRSTVWXYZ",
          taskKey: agentTasksReviewTask.key,
        },
        outcome: {
          kind: "response",
          value: { requestId: "req_review_rejected", transition: "rejected" },
        },
      }];
    }),
    runtime,
  },
  {
    id: "tasks-review-conflict",
    title: "Stale review conflict",
    description: "An exact stale acceptance returns a state conflict and leaves the immutable submission unchanged.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      world.scripts.commands = [{
        request: {
          kind: "acceptSubmission",
          reviewRevision: 4,
          submissionId: "sub_01J3ABCDEFGHJKMNPQRSTVWXYZ",
          taskKey: agentTasksReviewTask.key,
        },
        outcome: {
          error: { code: "TASK_STATE_CONFLICT", reference: "req_stale_review" },
          kind: "failure",
        },
      }];
    }),
    runtime,
  },
  {
    id: "tasks-review-observer",
    title: "Review observer",
    description: "A human without reviewer capability can inspect immutable evidence without accept or reject controls.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      world.capabilities.canReview = false;
    }),
    runtime,
  },
  {
    id: "tasks-viewer-read-only",
    title: "Read-only operator",
    description: "A viewer without mutation capabilities can inspect the full task record without actionable controls.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      for (const capability of Object.keys(world.capabilities) as (keyof typeof world.capabilities)[]) {
        world.capabilities[capability] = false;
      }
    }),
    runtime,
  },
  {
    id: "tasks-expired-claim",
    title: "Expired claim recovery",
    description: "The old fence, disabled agent, and recovery guidance remain visible before any new work begins.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      world.activeView = "attention";
      world.views.attention = { cursor: null, kind: "ready", tasks: [agentTasksExpiredClaimTask] };
      world.selectedTaskKey = agentTasksExpiredClaimTask.key;
      world.details = [structuredClone(agentTasksExpiredClaimDetail)];
    }),
    runtime,
  },
  {
    id: "tasks-create-success",
    title: "Human task creation",
    description: "The real editor consumes one exact command and selects the newly created ready task.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      world.activeView = "all";
      for (const view of Object.keys(world.views) as (keyof typeof world.views)[]) {
        world.views[view] = { cursor: null, kind: "ready", tasks: [] };
        world.counts[view] = { capped: false, value: 0 };
      }
      world.selectedTaskKey = null;
      world.details = [];
      world.scripts.commands = [{
        request: createRequest,
        outcome: {
          kind: "response",
          value: {
            detail: createdDetail,
            requestId: "req_task_created",
            task: createdTask,
            transition: "created",
          },
        },
      }];
    }),
    runtime,
  },
  {
    id: "tasks-create-pending-isolation",
    title: "Operation-scoped pending feedback",
    description: "A deferred create command paints only its own submit control as pending while the competing run stop remains disabled and visually stable.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      configureDispatchRun(world, createRunFixture({
        eventKinds: ["worktree.ready", "codex.running"],
        eventToken: "create_pending_isolation",
        phase: "running",
      }));
      world.scripts.commands = [{
        delayMs: 30_000,
        request: createRequest,
        outcome: {
          kind: "response",
          value: {
            detail: createdDetail,
            requestId: "req_task_created_pending_isolation",
            task: createdTask,
            transition: "created",
          },
        },
      }];
    }),
    runtime: { ...runtime, acceleration: 10 },
  },
  {
    id: "tasks-pagination-scope",
    title: "Queue-scoped pagination",
    description: "One exact all-queue cursor appends its page without leaking into another task view.",
    route: "/",
    world: createAgentTasksDirectWorld((world) => {
      world.views.all = { cursor: "page:all:1", kind: "ready", tasks: [agentTasksReviewTask] };
      world.scripts.pages = [{
        cursor: "page:all:1",
        nextCursor: null,
        tasks: [agentTasksExpiredClaimTask, agentTasksDeferredTask],
        view: "all",
      }];
    }),
    runtime,
  },
] as const satisfies readonly ScenarioDefinitionInput<AgentTasksDirectWorld, AgentTasksDirectRoute>[];

export const agentTasksScenarioMetadata: Readonly<Record<string, AgentTasksScenarioMetadata>> = Object.freeze({
  "tasks-empty-ready": { group: "Queues", viewport: "wide" },
  "tasks-query-failed": { group: "Queues", viewport: "stacked" },
  "tasks-rich-review": { group: "Review", viewport: "wide" },
  "runner-offline": { group: "Runner", viewport: "stacked" },
  "runner-heartbeat-expired": { group: "Runner", viewport: "compact" },
  "runner-run-streaming": { group: "Runner", viewport: "wide" },
  "runner-blocked-account": { group: "Runner", viewport: "stacked" },
  "runner-blocked-credential": { group: "Recovery", viewport: "compact" },
  "runner-ready": { group: "Runner", viewport: "wide" },
  "runner-draining": { group: "Runner", viewport: "stacked" },
  "tasks-readiness-race": { group: "Workflow", viewport: "wide" },
  "runner-worktree-failed": { group: "Recovery", viewport: "wide" },
  "runner-start-ambiguous": { group: "Recovery", viewport: "wide" },
  "runner-waiting-approval": { group: "Runner", viewport: "stacked" },
  "runner-waiting-question": { group: "Runner", viewport: "stacked" },
  "runner-input-changed": { group: "Recovery", viewport: "wide" },
  "runner-run-submitted": { group: "Workflow", viewport: "wide" },
  "runner-queued-cancel": { group: "Workflow", viewport: "stacked" },
  "runner-failed-retry": { group: "Recovery", viewport: "wide" },
  "runner-cancelled-retry": { group: "Recovery", viewport: "wide" },
  "runner-ambiguous-resolve": { group: "Recovery", viewport: "wide" },
  "tasks-review-rejected": { group: "Review", viewport: "wide" },
  "tasks-review-conflict": { group: "Review", viewport: "wide" },
  "tasks-review-observer": { group: "Review", viewport: "stacked" },
  "tasks-viewer-read-only": { group: "Capabilities", viewport: "compact" },
  "tasks-expired-claim": { group: "Recovery", viewport: "stacked" },
  "tasks-create-success": { group: "Workflow", viewport: "wide" },
  "tasks-create-pending-isolation": { group: "Workflow", viewport: "wide" },
  "tasks-pagination-scope": { group: "Queues", viewport: "compact" },
} satisfies Readonly<Record<(typeof scenarioInputs)[number]["id"], AgentTasksScenarioMetadata>>);

export const agentTasksDirectDefinition = defineDirect({
  parseWorld: parseAgentTasksDirectWorld,
  defaultScenario: "tasks-rich-review",
  scenarios: scenarioInputs,
  coverage: [
    { key: "tasks.read.states", mode: "fixture", claim: "The real workspace renders ready, empty, and failed queue states.", scenarios: ["tasks-empty-ready", "tasks-query-failed", "tasks-rich-review"] },
    { key: "tasks.detail.auditability", mode: "fixture", claim: "Task details preserve graph, evidence, comments, references, and append-only events.", scenarios: ["tasks-rich-review"] },
    { key: "tasks.identity.presentation", mode: "fixture", claim: "Human, active-agent, disabled-agent, and system attribution remain distinct.", scenarios: ["tasks-rich-review", "tasks-expired-claim"] },
    { key: "tasks.recovery.presentation", mode: "fixture", claim: "Expired claims and rejected submissions present concrete recovery guidance.", scenarios: ["tasks-expired-claim", "tasks-review-rejected"] },
    { key: "tasks.responsive.accessibility", mode: "fixture", claim: "Wide, stacked, and compact frames retain named controls and bounded horizontal layout.", scenarios: ["tasks-rich-review", "tasks-review-observer", "tasks-viewer-read-only"] },
    { key: "tasks.network.containment", mode: "fixture", claim: "The browser lab blocks unmapped fetches and verifies same-origin GET-only asset traffic.", scenarios: ["tasks-rich-review"] },
    { key: "tasks.review.command", mode: "mixed", claim: "Exact accept/reject requests and deterministic success/conflict responses drive the real review UI; production authority remains direct evidence.", scenarios: ["tasks-review-rejected", "tasks-review-conflict"] },
    { key: "tasks.review.four-eyes", mode: "direct", claim: "Agent-submitter four-eyes enforcement requires direct backend law and mutation evidence.", scenarios: [] },
    { key: "tasks.capability.enforcement", mode: "mixed", claim: "Capabilities remove controls in the UI while production authorization remains direct evidence.", scenarios: ["tasks-review-observer", "tasks-viewer-read-only"] },
    { key: "tasks.create.command", mode: "mixed", claim: "Exact human create commands mutate the deterministic workspace with operation-scoped pending feedback; production persistence remains direct evidence.", scenarios: ["tasks-create-success", "tasks-create-pending-isolation"] },
    { key: "tasks.pagination.realtime", mode: "mixed", claim: "Queue-scoped pagination is deterministic here while Convex subscription updates remain direct evidence.", scenarios: ["tasks-pagination-scope"] },
    { key: "runner.presence.presentation", mode: "mixed", claim: "Ready, offline, blocked, busy, draining, credential-invalid, and heartbeat-expired runner leases remain honest in the real task surface; production lease authority remains direct evidence.", scenarios: ["runner-ready", "runner-offline", "runner-blocked-account", "runner-blocked-credential", "runner-heartbeat-expired", "runner-run-streaming", "runner-draining"] },
    { key: "runner.lifecycle.presentation", mode: "mixed", claim: "Structurally bounded public reasoning summaries and assistant deltas coalesce into a readable live display while content-free tool activity becomes one anonymous elapsed indicator; raw tool details, output, and local paths remain absent.", scenarios: ["runner-run-streaming", "runner-worktree-failed", "runner-start-ambiguous", "runner-waiting-approval", "runner-input-changed", "runner-run-submitted", "tasks-rich-review"] },
    { key: "runner.hitl.response", mode: "mixed", claim: "Pending human input is promoted above autonomous tasks and exact file-approval and user-input responses drive the real inline controls; production browser sealing, backend authority, and provider continuation remain direct evidence.", scenarios: ["runner-waiting-approval", "runner-waiting-question"] },
    { key: "runner.dispatch.readiness", mode: "mixed", claim: "A ready display can still converge to one durable queued task and run; production atomicity and runner selection remain direct evidence.", scenarios: ["tasks-readiness-race", "tasks-create-success"] },
    { key: "runner.recovery.commands", mode: "mixed", claim: "Exact Stop, Retry, and Resolve requests drive the real recovery controls while production idempotency, fences, and claim release remain direct evidence.", scenarios: ["runner-queued-cancel", "runner-failed-retry", "runner-cancelled-retry", "runner-ambiguous-resolve"] },
    { key: "auth.password-session", mode: "direct", claim: "Convex Auth password session establishment is excluded from credential-free fixture evidence.", scenarios: [] },
    { key: "auth.organization-switch", mode: "direct", claim: "Organization and workspace selection plus current membership require authenticated integration evidence.", scenarios: [] },
    { key: "convex.realtime-subscriptions", mode: "direct", claim: "Convex subscription ordering and reconnect behavior require live deployment evidence.", scenarios: [] },
    { key: "convex.command-semantics", mode: "direct", claim: "Production transactions, tenant guards, fences, and idempotency remain proven by direct backend suites.", scenarios: [] },
    { key: "configuration.next-runtime", mode: "direct", claim: "Next.js and Convex Auth runtime configuration is outside the isolated Vite graph.", scenarios: [] },
  ],
});

export { createRequest as agentTasksCreateRequest };
