import {
  MAX_RUN_EVENTS,
  MAX_RUN_EVENT_BATCH,
  dispatchClaimIdSchema,
  dispatchIdSchema,
  publicRunEventSchema,
  runDisplayBudgetAfterBatch,
  runEventViewSchema,
  runnerBootIdSchema,
  runnerIdSchema,
  runPhaseSchema,
} from "@hraness/agent-tasks-domain";
import { z } from "@hra-internal/schema";

import { runnerInstallationIdSchema } from "./dispatch-identifiers";
import { successEnvelopeSchema } from "./errors";
import { MAX_RUN_INTERACTION_VIEWS, runInteractionViewSchema } from "./interactions";
import {
  epochMsSchema,
  positiveGenerationSchema,
  repositoryIdSchema,
  taskDescriptionSchema,
  taskKeySchema,
  taskTitleSchema,
} from "./model";

export {
  MAX_NONTERMINAL_RUN_EVENTS,
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
  MAX_RUN_EVENTS,
  MAX_RUN_EVENT_BATCH,
  MAX_RUN_REASONING_SUMMARY_EVENTS,
  MAX_RUN_TOOL_ACTIVITY_EVENTS,
  dispatchClaimIdSchema,
  dispatchIdSchema,
  publicRunEventKindSchema,
  publicRunEventSchema,
  publicRunStatusEventKindSchema,
  publicRunTextEventKindSchema,
  runDisplayTextSchema,
  runEventViewSchema,
  runnerBootIdSchema,
  runnerIdSchema,
  runPhaseSchema,
} from "@hraness/agent-tasks-domain";
export {
  dispatchEventIdSchema,
  runnerInstallationIdSchema,
} from "./dispatch-identifiers";
export type {
  PublicRunEvent,
  PublicRunEventKind,
  RunEventView,
  RunPhase,
} from "@hraness/agent-tasks-domain";

export const RUNNER_HEARTBEAT_INTERVAL_MS = 15_000;
export const RUNNER_PRESENCE_LEASE_MS = 45_000;
export const DISPATCH_LEASE_MS = 90_000;
export const MAX_DISPATCH_CLAIMS_PER_PULL = 4;
export const HRA_DISPATCH_PROTOCOL_VERSION = 1;

export const runnerDesiredStateSchema = z.enum(["active", "draining"]);
export const runnerReportedStateSchema = z.enum(["starting", "ready", "busy", "degraded"]);
export const runnerBlockReasonSchema = z.enum([
  "no_account",
  "no_repository",
  "capacity_full",
  "upgrade_required",
  "credential_invalid",
]);

export const runnerHeartbeatRequestSchema = z.object({
  runnerId: runnerIdSchema,
  installationId: runnerInstallationIdSchema,
  bootId: runnerBootIdSchema,
  bootGeneration: positiveGenerationSchema,
  sequence: positiveGenerationSchema,
  protocolVersion: z.literal(HRA_DISPATCH_PROTOCOL_VERSION),
  clientVersion: z.string().min(1).max(64),
  reportedState: runnerReportedStateSchema,
  blockReason: runnerBlockReasonSchema.optional(),
  capacity: z.number().int().min(0).max(32),
  activeRuns: z.number().int().min(0).max(32),
  currentRunIds: z.array(dispatchIdSchema).max(32),
  retainedRunIds: z.array(dispatchIdSchema).max(32),
  repositoryIds: z.array(repositoryIdSchema).max(128),
}).strict().superRefine((value, context) => {
  if (new Set(value.repositoryIds).size !== value.repositoryIds.length) {
    context.addIssue({ code: "custom", message: "repository IDs must be unique", path: ["repositoryIds"] });
  }
  if (value.activeRuns > value.capacity) {
    context.addIssue({ code: "custom", message: "active runs exceed capacity", path: ["activeRuns"] });
  }
  for (const field of ["currentRunIds", "retainedRunIds"] as const) {
    if (new Set(value[field]).size !== value[field].length) {
      context.addIssue({ code: "custom", message: `${field} must be unique`, path: [field] });
    }
  }
  const retained = new Set(value.retainedRunIds);
  if (value.currentRunIds.some((runId) => !retained.has(runId))) {
    context.addIssue({
      code: "custom",
      message: "current runs must also be retained",
      path: ["currentRunIds"],
    });
  }
  if (value.retainedRunIds.length > value.activeRuns) {
    context.addIssue({
      code: "custom",
      message: "retained runs exceed the reported active count",
      path: ["retainedRunIds"],
    });
  }
  if (value.reportedState === "degraded" && value.blockReason === undefined) {
    context.addIssue({
      code: "custom",
      message: "degraded runners require a block reason",
      path: ["blockReason"],
    });
  }
  if (value.reportedState !== "degraded" && value.blockReason !== undefined) {
    context.addIssue({
      code: "custom",
      message: "only degraded runners report a block reason",
      path: ["blockReason"],
    });
  }
});
export type RunnerHeartbeatRequest = z.infer<typeof runnerHeartbeatRequestSchema>;

export const dispatchCandidateSchema = z.object({
  taskKey: taskKeySchema,
  repositoryId: repositoryIdSchema,
  queuedAt: epochMsSchema,
}).strict();

export const runnerHeartbeatResponseSchema = z.object({
  serverTime: epochMsSchema,
  leaseUntil: epochMsSchema,
  desiredState: runnerDesiredStateSchema,
  candidates: z.array(dispatchCandidateSchema).max(32),
  runLeases: z.array(z.object({
    runId: dispatchIdSchema,
    leaseUntil: epochMsSchema,
  }).strict()).max(32),
  stopRunIds: z.array(dispatchIdSchema).max(32),
  releaseRunIds: z.array(dispatchIdSchema).max(32),
}).strict().superRefine((value, context) => {
  if (value.leaseUntil <= value.serverTime) {
    context.addIssue({
      code: "custom",
      message: "runner lease must end after server time",
      path: ["leaseUntil"],
    });
  }
  if (value.leaseUntil > value.serverTime + RUNNER_PRESENCE_LEASE_MS) {
    context.addIssue({
      code: "custom",
      message: "runner lease exceeds the presence bound",
      path: ["leaseUntil"],
    });
  }
  const runIds = value.runLeases.map(({ runId }) => runId);
  const activeRunIds = new Set(runIds);
  if (activeRunIds.size !== runIds.length) {
    context.addIssue({ code: "custom", message: "run leases must be unique", path: ["runLeases"] });
  }
  const candidateIds = value.candidates.map(({ repositoryId, taskKey }) =>
    `${taskKey}\u0000${repositoryId}`);
  if (new Set(candidateIds).size !== candidateIds.length) {
    context.addIssue({
      code: "custom",
      message: "dispatch candidates must be unique",
      path: ["candidates"],
    });
  }
  for (const [field, ids] of [
    ["stopRunIds", value.stopRunIds],
    ["releaseRunIds", value.releaseRunIds],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: `${field} must be unique`, path: [field] });
    }
  }
  if (value.stopRunIds.some((runId) => !activeRunIds.has(runId))) {
    context.addIssue({
      code: "custom",
      message: "stop runs must have a current lease",
      path: ["stopRunIds"],
    });
  }
  if (value.releaseRunIds.some((runId) => activeRunIds.has(runId))) {
    context.addIssue({
      code: "custom",
      message: "released runs cannot have a current lease",
      path: ["releaseRunIds"],
    });
  }
  value.runLeases.forEach((lease, index) => {
    if (
      lease.leaseUntil <= value.serverTime ||
      lease.leaseUntil > value.serverTime + DISPATCH_LEASE_MS
    ) {
      context.addIssue({
        code: "custom",
        message: "run lease is outside the dispatch bound",
        path: ["runLeases", index, "leaseUntil"],
      });
    }
  });
});
export const runnerHeartbeatEnvelopeSchema = successEnvelopeSchema(runnerHeartbeatResponseSchema);
export type RunnerHeartbeatResponse = z.infer<typeof runnerHeartbeatResponseSchema>;

export function runnerHeartbeatResponseMatchesRequest(
  request: RunnerHeartbeatRequest,
  response: RunnerHeartbeatResponse,
): boolean {
  const currentRunIds = new Set(request.currentRunIds);
  const retainedRunIds = new Set(request.retainedRunIds);
  const repositoryIds = new Set(request.repositoryIds);
  return response.runLeases.every(({ runId }) => currentRunIds.has(runId)) &&
    response.releaseRunIds.every((runId) => retainedRunIds.has(runId)) &&
    response.candidates.every(({ repositoryId }) => repositoryIds.has(repositoryId));
}

export const claimDispatchRequestSchema = z.object({
  runnerId: runnerIdSchema,
  bootId: runnerBootIdSchema,
  bootGeneration: positiveGenerationSchema,
  taskKey: taskKeySchema,
  repositoryId: repositoryIdSchema,
}).strict();

export const claimedDispatchSchema = z.object({
  runId: dispatchIdSchema,
  taskId: z.string().min(1).max(128),
  taskKey: taskKeySchema,
  taskTitle: taskTitleSchema,
  taskDescription: taskDescriptionSchema,
  repositoryId: repositoryIdSchema,
  baseRef: z.string().min(1).max(512),
  claimId: dispatchClaimIdSchema,
  claimFence: positiveGenerationSchema,
  inputReviewRevision: positiveGenerationSchema,
  leaseGeneration: positiveGenerationSchema,
  leaseUntil: epochMsSchema,
}).strict();
export const claimDispatchResponseSchema = z.object({ run: claimedDispatchSchema }).strict();
export const claimDispatchEnvelopeSchema = successEnvelopeSchema(claimDispatchResponseSchema);
export type ClaimedDispatch = z.infer<typeof claimedDispatchSchema>;

export const appendRunEventsRequestSchema = z.object({
  runnerId: runnerIdSchema,
  bootId: runnerBootIdSchema,
  claimId: dispatchClaimIdSchema,
  claimFence: positiveGenerationSchema,
  events: z.array(publicRunEventSchema).min(1).max(MAX_RUN_EVENT_BATCH),
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.events.length; index += 1) {
    const previous = value.events[index - 1];
    const current = value.events[index];
    if (
      previous === undefined ||
      current === undefined ||
      current.sequence !== previous.sequence + 1
    ) {
      context.addIssue({
        code: "custom",
        message: "run event sequences must be contiguous",
        path: ["events", index, "sequence"],
      });
    }
  }
  if (new Set(value.events.map(({ id }) => id)).size !== value.events.length) {
    context.addIssue({ code: "custom", message: "run event IDs must be unique", path: ["events"] });
  }
});

export const appendRunEventsResponseSchema = z.object({
  acceptedThroughSequence: positiveGenerationSchema,
  serverTime: epochMsSchema,
}).strict();
export const appendRunEventsEnvelopeSchema = successEnvelopeSchema(appendRunEventsResponseSchema);

export const runnerPresenceViewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("offline"), serverTime: epochMsSchema }).strict(),
  z.object({
    state: z.literal("blocked"),
    serverTime: epochMsSchema,
    leaseUntil: epochMsSchema,
    reason: runnerBlockReasonSchema,
  }).strict(),
  z.object({
    state: z.literal("ready"),
    serverTime: epochMsSchema,
    leaseUntil: epochMsSchema,
    availableCapacity: z.number().int().positive().max(32),
  }).strict(),
  z.object({
    state: z.literal("busy"),
    serverTime: epochMsSchema,
    leaseUntil: epochMsSchema,
  }).strict(),
  z.object({
    state: z.literal("draining"),
    serverTime: epochMsSchema,
    leaseUntil: epochMsSchema,
  }).strict(),
]).superRefine((presence, context) => {
  if (presence.state === "offline") return;
  if (presence.leaseUntil <= presence.serverTime) {
    context.addIssue({
      code: "custom",
      message: "online runner presence requires a live lease",
      path: ["leaseUntil"],
    });
  }
  if (presence.leaseUntil > presence.serverTime + RUNNER_PRESENCE_LEASE_MS) {
    context.addIssue({
      code: "custom",
      message: "runner presence lease exceeds the presence bound",
      path: ["leaseUntil"],
    });
  }
});
export type RunnerPresenceView = z.infer<typeof runnerPresenceViewSchema>;

export const taskRunViewSchema = z.object({
  id: dispatchIdSchema,
  taskKey: taskKeySchema,
  phase: runPhaseSchema,
  repositoryId: repositoryIdSchema,
  desiredState: z.enum(["run", "stop"]),
  updatedAt: epochMsSchema,
  events: z.array(runEventViewSchema).max(MAX_RUN_EVENTS),
  interactions: z.array(runInteractionViewSchema).max(MAX_RUN_INTERACTION_VIEWS),
}).strict().superRefine((value, context) => {
  if (new Set(value.events.map(({ id }) => id)).size !== value.events.length) {
    context.addIssue({ code: "custom", message: "run view event IDs must be unique", path: ["events"] });
  }
  const display = runDisplayBudgetAfterBatch({
    acceptedThroughSequence: value.events.length,
    existingEvents: value.events,
    events: [],
  });
  if (display.kind !== "accepted") {
    context.addIssue({
      code: "custom",
      message: "run view events violate sequence or display transcript laws",
      path: ["events"],
    });
  }
  const interactionIds = new Set<string>();
  value.interactions.forEach((interaction, index) => {
    if (interaction.runId !== value.id) {
      context.addIssue({
        code: "custom",
        message: "run interaction must belong to the enclosing run",
        path: ["interactions", index, "runId"],
      });
    }
    if (interactionIds.has(interaction.request.id)) {
      context.addIssue({
        code: "custom",
        message: "run interaction request IDs must be unique",
        path: ["interactions", index, "request", "id"],
      });
    }
    interactionIds.add(interaction.request.id);
  });
});
export type TaskRunView = z.infer<typeof taskRunViewSchema>;

export const hraDispatchRoutes = {
  heartbeat: "/v1/runtime/heartbeat",
  claim: "/v1/dispatch/claim",
  events: (runId: string): string =>
    `/v1/dispatch/runs/${encodeURIComponent(dispatchIdSchema.parse(runId))}/events`,
  interactions: (runId: string): string =>
    `/v1/dispatch/runs/${encodeURIComponent(dispatchIdSchema.parse(runId))}/interactions/sync`,
} as const;
