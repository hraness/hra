import { taskWorkspaceLinkSchema } from "@hraness/agent-tasks-domain";
import {
  submissionEvidenceInputSchema,
  portableRunInteractionRequestSchema,
  repositoryIdSchema,
  runInteractionResponseSchema,
  runnerPresenceViewSchema,
  taskEventTypeSchema,
  taskPrioritySchema,
  taskReferenceViewSchema,
  taskTypeSchema,
  taskRunViewSchema,
  taskViewSchema,
  validateRunInteractionResponse,
} from "@hraness/agent-tasks-protocol";
import { taskWorkspaceViews } from "@hraness/agent-tasks-ui";
import { taskWorkspaceFixtureNow } from "@hraness/agent-tasks-ui/fixtures";
import { z } from "@hra-internal/schema";
import type { Jsonify } from "@hraness/types";

import { toPortableRunInteractionRequest } from "../app/task-run-boundary";

export const AGENT_TASKS_DIRECT_WORLD_VERSION = 1 as const;
export const AGENT_TASKS_DIRECT_SCHEMA = "hra.agent-tasks.direct/v1" as const;
export const AGENT_TASKS_DIRECT_TIME = taskWorkspaceFixtureNow;

const boundedText = z.string().min(1).max(2_000);
const optionalBoundedText = z.string().max(2_000);
const identifier = z.string().min(1).max(160);
const epoch = z.number().safe().int().min(0);
const boundedCount = z.number().safe().int().min(0).max(1_000_000);
const cursor = z.string().min(1).max(512);

const humanActorSchema = z.strictObject({
  id: identifier,
  kind: z.literal("human"),
  name: boundedText,
});
const agentActorSchema = z.strictObject({
  id: identifier,
  kind: z.literal("agent"),
  name: boundedText,
  status: z.enum(["active", "disabled"]),
});
const systemActorSchema = z.strictObject({
  id: identifier,
  jobKind: z.enum(["claim_expiry", "defer_wake", "repair", "reconciliation"]),
  kind: z.literal("system"),
});
const actorSchema = z.discriminatedUnion("kind", [
  humanActorSchema,
  agentActorSchema,
  systemActorSchema,
]);

const graphEdgeSchema = z.strictObject({
  createdAt: epoch,
  task: taskWorkspaceLinkSchema,
});
const commentSchema = z.strictObject({
  actor: actorSchema,
  body: optionalBoundedText,
  createdAt: epoch,
  id: identifier,
});
const eventSchema = z.strictObject({
  actor: actorSchema,
  createdAt: epoch,
  id: identifier,
  summary: boundedText,
  taskRevision: z.number().safe().int().positive(),
  type: taskEventTypeSchema,
});
const submissionSchema = z.strictObject({
  evidence: z.array(submissionEvidenceInputSchema).min(1).max(32),
  id: identifier,
  reviewReason: boundedText.optional(),
  reviewRevision: z.number().safe().int().positive(),
  reviewedAt: epoch.optional(),
  status: z.enum(["pending", "accepted", "rejected", "cancelled"]),
  submittedAt: epoch,
  submittedBy: actorSchema,
  summary: boundedText,
  taskKey: identifier,
});
export const agentTasksDetailSchema = z.strictObject({
  blockers: z.array(graphEdgeSchema).max(100),
  children: z.array(taskWorkspaceLinkSchema).max(100),
  comments: z.array(commentSchema).max(100),
  dependents: z.array(graphEdgeSchema).max(100),
  description: optionalBoundedText,
  events: z.array(eventSchema).max(100),
  labels: z.array(z.string().min(1).max(80)).max(64),
  parent: taskWorkspaceLinkSchema.nullable(),
  recoveries: z.array(z.strictObject({
    kind: z.enum([
      "access_revoked",
      "task_cancelled",
      "submission_rejected",
      "claim_expired",
      "cancelled_blocker",
    ]),
  })).max(5),
  references: z.array(taskReferenceViewSchema).max(100),
  runs: z.array(taskRunViewSchema).max(20).optional(),
  submission: submissionSchema.nullable(),
  task: taskViewSchema,
  truncatedCollections: z.array(z.enum([
    "blockers",
    "children",
    "comments",
    "dependents",
    "events",
    "references",
    "runs",
  ])).max(7),
});

const viewStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("loading") }),
  z.strictObject({ error: z.strictObject({ code: identifier, reference: identifier.optional() }), kind: z.literal("error") }),
  z.strictObject({ cursor: cursor.nullable(), kind: z.literal("ready"), tasks: z.array(taskViewSchema).max(100) }),
]);
const viewsSchema = z.strictObject({
  all: viewStateSchema,
  ready: viewStateSchema,
  blocked: viewStateSchema,
  deferred: viewStateSchema,
  attention: viewStateSchema,
  assigned: viewStateSchema,
  review: viewStateSchema,
});
const countSchema = z.strictObject({ capped: z.boolean(), value: boundedCount });
const countsSchema = z.strictObject({
  all: countSchema,
  ready: countSchema,
  blocked: countSchema,
  deferred: countSchema,
  attention: countSchema,
  assigned: countSchema,
  review: countSchema,
});
const capabilitiesSchema = z.strictObject({
  canAssign: z.boolean(),
  canCancel: z.boolean(),
  canComment: z.boolean(),
  canCreate: z.boolean(),
  canEdit: z.boolean(),
  canManageGraph: z.boolean(),
  canManageLabels: z.boolean(),
  canManageReferences: z.boolean(),
  canReopen: z.boolean(),
  canReview: z.boolean(),
});

export const agentTasksCommandRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    availableAt: epoch.optional(),
    description: optionalBoundedText,
    kind: z.literal("createTask"),
    labels: z.array(z.string().min(1).max(80)).max(64),
    parentKey: identifier.optional(),
    priority: taskPrioritySchema,
    repositoryId: repositoryIdSchema.optional(),
    title: boundedText,
    type: taskTypeSchema,
  }),
  z.strictObject({
    kind: z.literal("acceptSubmission"),
    reviewRevision: z.number().safe().int().positive(),
    submissionId: identifier,
    taskKey: identifier,
  }),
  z.strictObject({
    kind: z.literal("rejectSubmission"),
    reason: boundedText,
    reviewRevision: z.number().safe().int().positive(),
    submissionId: identifier,
    taskKey: identifier,
  }),
  z.strictObject({
    kind: z.literal("cancelTask"),
    reason: boundedText,
    revision: z.number().safe().int().positive(),
    taskKey: identifier,
  }),
  z.strictObject({
    kind: z.literal("requestRunStop"),
    runId: identifier,
  }),
  z.strictObject({
    kind: z.literal("retryRun"),
    runId: identifier,
    taskRevision: z.number().safe().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("abandonAmbiguousRun"),
    reason: z.enum(["confirmed_cancelled", "declared_failed"]),
    runId: identifier,
    taskRevision: z.number().safe().int().positive(),
  }),
]);
export const agentTasksCommandResponseSchema = z.discriminatedUnion("transition", [
  z.strictObject({
    detail: agentTasksDetailSchema,
    requestId: identifier,
    task: taskViewSchema,
    transition: z.literal("created"),
  }),
  z.strictObject({ requestId: identifier, transition: z.literal("accepted") }),
  z.strictObject({ requestId: identifier, transition: z.literal("rejected") }),
  z.strictObject({ requestId: identifier, transition: z.literal("cancelled") }),
  z.strictObject({
    requestId: identifier,
    run: taskRunViewSchema,
    transition: z.literal("stop_recorded"),
  }),
  z.strictObject({
    requestId: identifier,
    run: taskRunViewSchema,
    transition: z.literal("retried"),
  }),
  z.strictObject({
    requestId: identifier,
    run: taskRunViewSchema,
    transition: z.literal("ambiguity_resolved"),
  }),
]);
export const agentTasksCommandFailureSchema = z.strictObject({
  code: identifier,
  reference: identifier.optional(),
});
const commandStepSchema = z.strictObject({
  delayMs: z.number().safe().int().min(0).max(60_000).optional(),
  request: agentTasksCommandRequestSchema,
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("response"), value: agentTasksCommandResponseSchema }),
    z.strictObject({ error: agentTasksCommandFailureSchema, kind: z.literal("failure") }),
  ]),
});
const pageStepSchema = z.strictObject({
  cursor,
  nextCursor: cursor.nullable(),
  tasks: z.array(taskViewSchema).max(100),
  view: z.enum(taskWorkspaceViews),
});
const interactionResponseStepSchema = z.strictObject({
  request: z.strictObject({
    interactionId: identifier,
    request: portableRunInteractionRequestSchema,
    response: runInteractionResponseSchema,
    runId: identifier,
  }),
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("response"), requestId: identifier }),
    z.strictObject({ error: agentTasksCommandFailureSchema, kind: z.literal("failure") }),
  ]),
});

export const agentTasksDirectWorldSchema = z.strictObject({
  schema: z.literal(AGENT_TASKS_DIRECT_SCHEMA),
  version: z.literal(AGENT_TASKS_DIRECT_WORLD_VERSION),
  now: epoch,
  workspace: z.strictObject({
    id: identifier,
    keyPrefix: z.string().min(1).max(12),
    name: boundedText,
    slug: z.string().min(1).max(80),
  }),
  viewer: humanActorSchema,
  agents: z.array(z.strictObject({
    id: identifier,
    name: boundedText,
    status: z.enum(["active", "disabled"]),
  })).max(64),
  capabilities: capabilitiesSchema,
  counts: countsSchema,
  activeView: z.enum(taskWorkspaceViews),
  views: viewsSchema,
  selectedTaskKey: identifier.nullable(),
  details: z.array(agentTasksDetailSchema).max(100),
  runner: z.strictObject({
    presence: runnerPresenceViewSchema,
    repositories: z.array(z.strictObject({
      id: repositoryIdSchema,
      name: boundedText,
      ready: z.boolean(),
    })).max(128),
  }).optional(),
  scripts: z.strictObject({
    commands: z.array(commandStepSchema).max(32),
    interactions: z.array(interactionResponseStepSchema).max(32),
    pages: z.array(pageStepSchema).max(32),
  }),
  diagnostics: z.strictObject({
    requests: z.array(boundedText).max(256),
    violations: z.array(boundedText).max(256),
  }),
});

type ParsedAgentTasksDirectWorld = z.infer<typeof agentTasksDirectWorldSchema>;
export type AgentTasksDirectWorld = Jsonify<ParsedAgentTasksDirectWorld>;
export type AgentTasksCommandRequest = Jsonify<z.infer<typeof agentTasksCommandRequestSchema>>;
export type AgentTasksCommandResponse = Jsonify<z.infer<typeof agentTasksCommandResponseSchema>>;
export type AgentTasksCommandFailure = Jsonify<z.infer<typeof agentTasksCommandFailureSchema>>;

function jsonClone<Value>(value: Value): Jsonify<Value> {
  // Zod has already validated the owned shape; this clone removes absent
  // optional properties so the public type precisely satisfies JsonValue.
  return JSON.parse(JSON.stringify(value)) as Jsonify<Value>;
}

export function parseAgentTasksCommandRequest(input: unknown): AgentTasksCommandRequest {
  return jsonClone(agentTasksCommandRequestSchema.parse(input));
}

export function parseAgentTasksCommandResponse(input: unknown): AgentTasksCommandResponse {
  return jsonClone(agentTasksCommandResponseSchema.parse(input));
}

export function parseAgentTasksCommandFailure(input: unknown): AgentTasksCommandFailure {
  return jsonClone(agentTasksCommandFailureSchema.parse(input));
}

export function parseAgentTasksTaskView(
  input: unknown,
): AgentTasksDirectWorld["details"][number]["task"] {
  return jsonClone(taskViewSchema.parse(input));
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

const prototypePollutionKeys = new Set(["__proto__", "constructor", "prototype"]);

function rejectPrototypePollutionKeys(input: unknown): void {
  const pending = [input];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate !== "object" || candidate === null || visited.has(candidate)) continue;
    visited.add(candidate);
    for (const [key, value] of Object.entries(candidate)) {
      if (prototypePollutionKeys.has(key)) {
        throw new Error(`Agent Tasks Direct worlds cannot contain the ${key} key.`);
      }
      pending.push(value);
    }
  }
}

export function parseAgentTasksDirectWorld(input: unknown): AgentTasksDirectWorld {
  rejectPrototypePollutionKeys(input);
  const world = agentTasksDirectWorldSchema.parse(input);
  unique(world.agents.map(({ id }) => id), "Agent IDs");
  unique(world.details.map(({ task }) => task.key), "Detail task keys");
  for (const detail of world.details) {
    unique(detail.labels, `Labels for ${detail.task.key}`);
    unique(detail.comments.map(({ id }) => id), `Comment IDs for ${detail.task.key}`);
    unique(detail.events.map(({ id }) => id), `Event IDs for ${detail.task.key}`);
    unique(detail.references.map(({ id }) => id), `Reference IDs for ${detail.task.key}`);
    if (detail.submission !== null && detail.submission.taskKey !== detail.task.key) {
      throw new Error(`Submission ${detail.submission.id} must belong to ${detail.task.key}.`);
    }
    const runs = detail.runs ?? [];
    unique(runs.map(({ id }) => id), `Run IDs for ${detail.task.key}`);
    for (const run of runs) {
      if (run.taskKey !== detail.task.key) {
        throw new Error(`Run ${run.id} must belong to ${detail.task.key}.`);
      }
      unique(run.events.map(({ id }) => id), `Event IDs for run ${run.id}`);
      for (let index = 1; index < run.events.length; index += 1) {
        const previous = run.events[index - 1];
        const current = run.events[index];
        if (previous === undefined || current === undefined || current.sequence <= previous.sequence) {
          throw new Error(`Event sequences for run ${run.id} must be strictly increasing.`);
        }
      }
    }
  }
  for (const view of taskWorkspaceViews) {
    const state = world.views[view];
    if (state.kind === "ready") unique(state.tasks.map(({ key }) => key), `${view} view task keys`);
  }
  if (world.selectedTaskKey !== null) {
    const state = world.views[world.activeView];
    if (state.kind !== "ready" || !state.tasks.some(({ key }) => key === world.selectedTaskKey)) {
      throw new Error("The selected task must exist in the active ready view.");
    }
    if (!world.details.some(({ task }) => task.key === world.selectedTaskKey)) {
      throw new Error("The selected task must have a detail fixture.");
    }
  }
  for (const step of world.scripts.commands) {
    if (step.outcome.kind !== "response") continue;
    const expected = step.request.kind === "createTask"
      ? "created"
      : step.request.kind === "acceptSubmission"
        ? "accepted"
        : step.request.kind === "rejectSubmission"
          ? "rejected"
          : step.request.kind === "cancelTask"
            ? "cancelled"
            : step.request.kind === "requestRunStop"
              ? "stop_recorded"
              : step.request.kind === "retryRun"
                ? "retried"
                : "ambiguity_resolved";
    if (step.outcome.value.transition !== expected) {
      throw new Error(`Command ${step.request.kind} cannot produce ${step.outcome.value.transition}.`);
    }
    if (
      step.request.kind === "requestRunStop"
      && step.outcome.value.transition === "stop_recorded"
      && step.outcome.value.run.id !== step.request.runId
    ) {
      throw new Error("A stop response must identify the requested run.");
    }
    if (
      step.request.kind === "retryRun"
      && step.outcome.value.transition === "retried"
      && (
        step.outcome.value.run.id === step.request.runId
        || step.outcome.value.run.phase !== "queued"
        || step.outcome.value.run.desiredState !== "run"
      )
    ) {
      throw new Error("A retry response must create a distinct runnable queued attempt.");
    }
    if (
      step.request.kind === "abandonAmbiguousRun"
      && step.outcome.value.transition === "ambiguity_resolved"
      && (
        step.outcome.value.run.id !== step.request.runId
        || (step.request.reason === "confirmed_cancelled" && step.outcome.value.run.phase !== "cancelled")
        || (step.request.reason === "declared_failed" && step.outcome.value.run.phase !== "failed")
      )
    ) {
      throw new Error("An ambiguity response must match the requested run and terminal outcome.");
    }
    if (
      step.outcome.value.transition === "created"
      && (step.outcome.value.task.key !== step.outcome.value.detail.task.key
        || step.outcome.value.task.id !== step.outcome.value.detail.task.id)
    ) {
      throw new Error("A created response must pair one task with its matching detail.");
    }
  }
  for (const step of world.scripts.interactions) {
    if (step.request.interactionId !== step.request.request.id) {
      throw new Error("An interaction response must identify its request exactly.");
    }
    const detail = world.details.find(({ runs }) => runs?.some(({ id }) => id === step.request.runId));
    const run = detail?.runs?.find(({ id }) => id === step.request.runId);
    const interaction = run?.interactions.find(
      ({ request }) => request.id === step.request.interactionId,
    );
    if (interaction === undefined || interaction.runId !== step.request.runId) {
      throw new Error(`Interaction ${step.request.interactionId} must belong to ${step.request.runId}.`);
    }
    if (
      JSON.stringify(toPortableRunInteractionRequest(interaction.request)) !==
        JSON.stringify(step.request.request)
    ) {
      throw new Error(`Interaction ${step.request.interactionId} must script the exact visible request.`);
    }
    if (!validateRunInteractionResponse(step.request.request, step.request.response).success) {
      throw new Error(`Interaction ${step.request.interactionId} has an invalid scripted response.`);
    }
  }
  return jsonClone(world);
}

const fixtureHuman = {
  id: "user_fixturehuman",
  kind: "human" as const,
  name: "Mara Chen",
};
const fixtureWorker = {
  id: "agt_worker",
  kind: "agent" as const,
  name: "Build Scout",
  status: "active" as const,
};
const fixtureDisabledAgent = {
  id: "agt_disabled",
  kind: "agent" as const,
  name: "Retired Reviewer",
  status: "disabled" as const,
};
const fixtureRepositoryId = "repo_0123456789ABCDEFGHJKMNPQRS";

export const agentTasksReviewTask = jsonClone(taskViewSchema.parse({
  availableAt: AGENT_TASKS_DIRECT_TIME - 3_600_000,
  cancelledBlockerCount: 1,
  createdAt: AGENT_TASKS_DIRECT_TIME - 86_400_000,
  id: "tsk_00000000000000000000000011",
  isReady: false,
  key: "AT-12AB3CD",
  priority: 1,
  reviewRevision: 4,
  revision: 9,
  status: "in_review",
  title: "Fence credential revocation across active sessions",
  type: "feature",
  unresolvedBlockerCount: 1,
  updatedAt: AGENT_TASKS_DIRECT_TIME - 600_000,
  assigneeAgentId: fixtureWorker.id,
}));

export const agentTasksExpiredClaimTask = jsonClone(taskViewSchema.parse({
  availableAt: AGENT_TASKS_DIRECT_TIME - 7_200_000,
  cancelledBlockerCount: 0,
  createdAt: AGENT_TASKS_DIRECT_TIME - 172_800_000,
  currentClaim: {
    agentId: fixtureDisabledAgent.id,
    fence: 7,
    id: "clm_fixture",
    leaseGeneration: 3,
    leaseUntil: AGENT_TASKS_DIRECT_TIME - 60_000,
  },
  id: "tsk_00000000000000000000000012",
  isReady: false,
  key: "AT-45EF6GH",
  priority: 0,
  reviewRevision: 1,
  revision: 7,
  status: "in_progress",
  title: "Repair the stale claim projection",
  type: "bug",
  unresolvedBlockerCount: 0,
  updatedAt: AGENT_TASKS_DIRECT_TIME - 120_000,
  assigneeAgentId: fixtureDisabledAgent.id,
}));

export const agentTasksDeferredTask = jsonClone(taskViewSchema.parse({
  availableAt: AGENT_TASKS_DIRECT_TIME + 86_400_000,
  cancelledBlockerCount: 0,
  createdAt: AGENT_TASKS_DIRECT_TIME - 40_000,
  id: "tsk_00000000000000000000000013",
  isReady: false,
  key: "AT-78JK9MN",
  priority: 3,
  reviewRevision: 1,
  revision: 1,
  status: "open",
  title: "Run the provider reconciliation load test",
  type: "chore",
  unresolvedBlockerCount: 0,
  updatedAt: AGENT_TASKS_DIRECT_TIME - 40_000,
}));

export const agentTasksReviewDetail = jsonClone(agentTasksDetailSchema.parse({
  blockers: [{
    createdAt: AGENT_TASKS_DIRECT_TIME - 70_000_000,
    task: {
      id: "tsk_00000000000000000000000014",
      key: "AT-22PQ3RS",
      priority: 2,
      revision: 5,
      status: "cancelled",
      title: "Retired provider adapter spike",
    },
  }],
  children: [{
    id: "tsk_00000000000000000000000015",
    key: "AT-33ST4VW",
    priority: 2,
    revision: 2,
    status: "open",
    title: "Document operator recovery",
  }],
  comments: [
    {
      actor: fixtureHuman,
      body: "Keep the credential kill switch isolated from persistent agent identity.",
      createdAt: AGENT_TASKS_DIRECT_TIME - 3_600_000,
      id: "cmt_human_fixture",
    },
    {
      actor: fixtureWorker,
      body: "The revocation proof keeps a sibling credential authorized.",
      createdAt: AGENT_TASKS_DIRECT_TIME - 1_800_000,
      id: "cmt_agent_fixture",
    },
    {
      actor: {
        id: "system_claim_expiry",
        jobKind: "claim_expiry",
        kind: "system",
      },
      body: "A previous claim expired and its fence was retired.",
      createdAt: AGENT_TASKS_DIRECT_TIME - 1_200_000,
      id: "cmt_system_fixture",
    },
  ],
  dependents: [{
    createdAt: AGENT_TASKS_DIRECT_TIME - 60_000_000,
    task: {
      id: "tsk_00000000000000000000000016",
      key: "AT-44WX5YZ",
      priority: 1,
      revision: 3,
      status: "open",
      title: "Ship the operator surface",
    },
  }],
  description: "Prove that revoking one credential stops its process sessions immediately while a sibling credential for the same persistent agent remains authorized.",
  events: [
    {
      actor: fixtureHuman,
      createdAt: AGENT_TASKS_DIRECT_TIME - 86_400_000,
      id: "evt_created_fixture",
      summary: "Created the task and assigned the security label.",
      taskRevision: 1,
      type: "task.created",
    },
    {
      actor: fixtureWorker,
      createdAt: AGENT_TASKS_DIRECT_TIME - 900_000,
      id: "evt_submitted_fixture",
      summary: "Submitted immutable evidence for human review.",
      taskRevision: 9,
      type: "task.submitted",
    },
  ],
  labels: ["auth", "security", "control-plane"],
  parent: {
    id: "tsk_00000000000000000000000017",
    key: "AT-11BC2DE",
    priority: 1,
    revision: 12,
    status: "in_progress",
    title: "Cloud-friendly agent identity",
  },
  recoveries: [{ kind: "access_revoked" }],
  references: [
    {
      createdAt: AGENT_TASKS_DIRECT_TIME - 2_000_000,
      id: "ref_01J3ABCDEFGHJKMNPQRSTVWXYZ",
      kind: "pull_request",
      url: "https://github.com/example/agent-tasks/pull/42",
    },
    {
      createdAt: AGENT_TASKS_DIRECT_TIME - 1_900_000,
      id: "ref_01J4ABCDEFGHJKMNPQRSTVWXYZ",
      kind: "commit",
      sha: "abc123def456",
      url: "https://github.com/example/agent-tasks/commit/abc123def456",
    },
  ],
  runs: [{
    desiredState: "run",
    events: [
      {
        id: "event_0123456789abcdefghjkmnpqrs",
        kind: "worktree.ready",
        observedAt: AGENT_TASKS_DIRECT_TIME - 1_500_000,
        sequence: 1,
      },
      {
        id: "event_0123456789abcdefghjkmnpqrt",
        kind: "codex.testing",
        observedAt: AGENT_TASKS_DIRECT_TIME - 1_000_000,
        sequence: 2,
      },
      {
        id: "event_0123456789abcdefghjkmnpqrv",
        kind: "run.submitted",
        observedAt: AGENT_TASKS_DIRECT_TIME - 900_000,
        sequence: 3,
      },
    ],
    id: "run_0123456789abcdefghjkmnpqrs",
    interactions: [],
    phase: "submitted",
    repositoryId: fixtureRepositoryId,
    taskKey: agentTasksReviewTask.key,
    updatedAt: AGENT_TASKS_DIRECT_TIME - 900_000,
  }],
  submission: {
    evidence: [
      { kind: "pull_request", url: "https://github.com/example/agent-tasks/pull/42" },
      { kind: "test", command: "bun run test:local:human" },
      { kind: "note", text: "Sibling credential remained authorized after revocation." },
    ],
    id: "sub_01J3ABCDEFGHJKMNPQRSTVWXYZ",
    reviewRevision: 4,
    status: "pending",
    submittedAt: AGENT_TASKS_DIRECT_TIME - 900_000,
    submittedBy: fixtureWorker,
    summary: "Added credential-scoped revocation and black-box coverage for active process sessions.",
    taskKey: agentTasksReviewTask.key,
  },
  task: agentTasksReviewTask,
  truncatedCollections: [],
}));

export const agentTasksExpiredClaimDetail = jsonClone(agentTasksDetailSchema.parse({
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
  runs: [{
    desiredState: "run",
    events: [{
      id: "event_1123456789abcdefghjkmnpqrs",
      kind: "run.lease_lost",
      observedAt: AGENT_TASKS_DIRECT_TIME - 60_000,
      sequence: 1,
    }],
    id: "run_1123456789abcdefghjkmnpqrs",
    interactions: [],
    phase: "ambiguous",
    repositoryId: fixtureRepositoryId,
    taskKey: agentTasksExpiredClaimTask.key,
    updatedAt: AGENT_TASKS_DIRECT_TIME - 60_000,
  }],
  submission: null,
  task: agentTasksExpiredClaimTask,
  truncatedCollections: [],
}));

const allCapabilities = {
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
};
const counts = {
  all: { capped: true, value: 10_000 },
  assigned: { capped: false, value: 2 },
  attention: { capped: false, value: 2 },
  blocked: { capped: false, value: 1 },
  deferred: { capped: false, value: 1 },
  ready: { capped: false, value: 0 },
  review: { capped: false, value: 1 },
};

const baseWorld = parseAgentTasksDirectWorld({
  schema: AGENT_TASKS_DIRECT_SCHEMA,
  version: AGENT_TASKS_DIRECT_WORLD_VERSION,
  now: AGENT_TASKS_DIRECT_TIME,
  workspace: { id: "wsp_fixture", keyPrefix: "AT", name: "HRA", slug: "hra" },
  viewer: fixtureHuman,
  agents: [
    { id: "agt_worker", name: "Build Scout", status: "active" },
    { id: "agt_disabled", name: "Retired Reviewer", status: "disabled" },
  ],
  capabilities: allCapabilities,
  counts,
  activeView: "all",
  views: {
    all: { cursor: "cursor_fixture", kind: "ready", tasks: [agentTasksReviewTask, agentTasksExpiredClaimTask, agentTasksDeferredTask] },
    ready: { cursor: null, kind: "ready", tasks: [] },
    blocked: { cursor: null, kind: "ready", tasks: [agentTasksReviewTask] },
    deferred: { cursor: null, kind: "ready", tasks: [agentTasksDeferredTask] },
    attention: { cursor: null, kind: "ready", tasks: [agentTasksReviewTask, agentTasksExpiredClaimTask] },
    assigned: { cursor: null, kind: "ready", tasks: [agentTasksReviewTask, agentTasksExpiredClaimTask] },
    review: { cursor: null, kind: "ready", tasks: [agentTasksReviewTask] },
  },
  selectedTaskKey: agentTasksReviewTask.key,
  details: [agentTasksReviewDetail, agentTasksExpiredClaimDetail],
  runner: {
    presence: {
      availableCapacity: 1,
      leaseUntil: AGENT_TASKS_DIRECT_TIME + 45_000,
      serverTime: AGENT_TASKS_DIRECT_TIME,
      state: "ready",
    },
    repositories: [{ id: fixtureRepositoryId, name: "hra", ready: true }],
  },
  scripts: { commands: [], interactions: [], pages: [] },
  diagnostics: { requests: [], violations: [] },
});

export function createAgentTasksDirectWorld(
  mutate?: (world: AgentTasksDirectWorld) => void,
): AgentTasksDirectWorld {
  const world = structuredClone(baseWorld);
  mutate?.(world);
  return parseAgentTasksDirectWorld(world);
}
