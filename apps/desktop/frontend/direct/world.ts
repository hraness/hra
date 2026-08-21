import { z } from "@hra-internal/schema";
import {
  operationReceiptSchema,
  portableTaskCommandSchema,
  portableInvalidationSchema,
  taskWorkspaceViewValues,
  taskDetailProjectionSchema,
  taskListPageSchema,
  taskViewSchema,
  type PortableTaskCommand,
  type PortableRunProjection,
  type PortableInvalidation,
  type TaskDetailProjection,
  type TaskListPage,
  type WorkspaceSummary,
} from "@hraness/agent-tasks-protocol";

import {
  chatMessageAttachmentIdSchema,
  chatPaneIdSchema,
  runtimeEventSchema,
  runtimeProtocolVersion,
  runtimeProjectAddResultSchema,
  runtimeSnapshotSchema,
  runtimeTaskRepositoryListSchema,
  runtimeTaskWorkspaceContextSchema,
  runtimeTaskWorkspaceSummariesSchema,
  type AccountSummary,
  type RuntimeSnapshot,
} from "../../contracts/runtime";

export const HRA_DIRECT_WORLD_VERSION = 4 as const;
export const HRA_DIRECT_TIME = Date.UTC(2026, 6, 19, 15, 0, 0);
export const HRA_DIRECT_TIMESTAMP = new Date(HRA_DIRECT_TIME).toISOString();
/**
 * Direct scenarios are replayable long after their authored timestamp. Active
 * leases and requests therefore use a fixed, schema-safe future deadline rather
 * than silently expiring against the verifier machine's wall clock.
 */
export const HRA_DIRECT_ACTIVE_DEADLINE = Date.UTC(2099, 0, 1);
export const HRA_DIRECT_ACTIVE_REQUEST_TIME =
  HRA_DIRECT_ACTIVE_DEADLINE - 60_000;
export const hraDirectTaskIds = {
  currentRun: "run_lane_one",
  currentTask: "tsk_00000000000000000000000001",
  repository: "repo_00000000000000000000000000",
  workspace: "wsp_00000000000000000000000000",
} as const;
export const hraDirectTaskStateIds = {
  currentRunDisplayRevision12: "two-running-display-12",
} as const;

export function fixtureCurrentRunTaskChange(
  projectionRevision: number,
): Extract<PortableInvalidation, { scope: "task_change" }> {
  const invalidation = portableInvalidationSchema.parse({
    workspaceId: hraDirectTaskIds.workspace,
    projectionRevision,
    scope: "task_change",
    taskId: hraDirectTaskIds.currentTask,
    runId: hraDirectTaskIds.currentRun,
    changeKind: "run.display_changed",
    affectedProjections: [{
      projection: "task_list",
      views: [...taskWorkspaceViewValues],
    }, {
      projection: "task_detail",
    }],
  });
  if (invalidation.scope !== "task_change") {
    throw new Error("Current-run fixture did not produce a task change");
  }
  return invalidation;
}

const delaySchema = z.number().safe().int().min(0).max(120_000);
const snapshotEncodingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("direct") }),
  z.strictObject({
    kind: z.literal("chunked"),
    chunkBytes: z.number().safe().int().min(32).max(64 * 1024),
  }),
]);
const eventScriptEntrySchema = z.strictObject({
  delayMs: delaySchema,
  event: runtimeEventSchema,
});
const directSurfaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("app") }),
  z.strictObject({
    kind: z.literal("compactChat"),
    paneId: chatPaneIdSchema,
    nowUnixMilliseconds: z.number().int().safe().nonnegative(),
    attachments: z.array(z.strictObject({
      id: chatMessageAttachmentIdSchema,
      name: z.string().min(1).max(240),
      mimeType: z.enum(["image/gif", "image/jpeg", "image/png", "image/webp"]),
      byteSize: z.number().int().safe().positive().max(32 * 1_024 * 1_024),
    })).max(8),
  }),
]);
const taskPageFixtureSchema = z.strictObject({
  page: taskListPageSchema,
  requestCursor: z.string().min(1).max(8_192).nullable(),
});
const taskProjectionPayloadSchema = z.strictObject({
  contexts: z.array(runtimeTaskWorkspaceContextSchema).max(64),
  details: z.array(taskDetailProjectionSchema).max(512),
  pages: z.array(taskPageFixtureSchema).max(512),
  repositories: z.array(runtimeTaskRepositoryListSchema).max(64),
  workspaces: runtimeTaskWorkspaceSummariesSchema,
});
export type HRADirectTaskProjectionState = z.infer<typeof taskProjectionPayloadSchema>;
const taskProjectionStateSchema = z.strictObject({
  id: z.string().min(1).max(96),
  /** JSON-safe Direct fixture storage; parsed against the strict projection schema on use. */
  projectionJson: z.string().min(2).max(512 * 1024),
});
const taskMutationTransitionSchema = z.strictObject({
  commandKind: z.string().min(1).max(96),
  /**
   * One exact portable command fixture. The operation ID is parsed for
   * protocol fidelity but excluded from transition selection so the rendered
   * client can supply its own idempotency key.
   */
  expectedCommandJson: z.string().min(2).max(32 * 1024),
  id: z.string().min(1).max(96),
  invalidation: portableInvalidationSchema,
  /** JSON-safe in the Direct definition; parsed into the strict protocol receipt on use. */
  receiptJson: z.string().min(2).max(32 * 1024),
  toStateId: z.string().min(1).max(96),
});

export const hraDirectWorldSchema = z.strictObject({
  version: z.literal(HRA_DIRECT_WORLD_VERSION),
  surface: directSurfaceSchema,
  gateway: z.strictObject({
    snapshots: z.array(runtimeSnapshotSchema).min(1).max(8),
    encoding: snapshotEncodingSchema,
    events: z.array(eventScriptEntrySchema).max(128),
  }),
  task: z.strictObject({
    initialStateId: z.string().min(1).max(96),
    mutationTransitions: z.array(taskMutationTransitionSchema).max(128),
    projectAdd: runtimeProjectAddResultSchema,
    states: z.array(taskProjectionStateSchema).min(1).max(32),
  }),
});

export type HRADirectWorld = z.infer<typeof hraDirectWorldSchema>;
export type HRADirectWorldInput = z.input<typeof hraDirectWorldSchema>;

export function parseHRADirectTaskProjectionState(
  serialized: string,
): HRADirectTaskProjectionState {
  try {
    return taskProjectionPayloadSchema.parse(JSON.parse(serialized) as unknown);
  } catch {
    throw new Error("task projection state JSON does not match the portable task projection schema.");
  }
}

export function parseHRADirectExpectedTaskCommand(
  serialized: string,
): PortableTaskCommand {
  try {
    return portableTaskCommandSchema.parse(JSON.parse(serialized) as unknown);
  } catch {
    throw new Error("task transition expected-command JSON is not a portable task command.");
  }
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function validateSnapshot(snapshot: RuntimeSnapshot, index: number): void {
  unique(snapshot.accounts.map(({ id }) => id), `snapshot ${index} account IDs`);
  unique(snapshot.retainedAccountLocalData.map(({ id }) => id), `snapshot ${index} retained-data IDs`);
  if (snapshot.accounts.filter(({ selected }) => selected).length > 1) {
    throw new Error(`snapshot ${index} cannot select more than one account.`);
  }
}

export function parseHRADirectWorld(input: unknown): HRADirectWorld {
  const world = hraDirectWorldSchema.parse(input);
  world.gateway.snapshots.forEach(validateSnapshot);
  unique(world.task.states.map(({ id }) => id), "task projection state IDs");
  unique(world.task.mutationTransitions.map(({ id }) => id), "task mutation transition IDs");
  const stateIds = new Set(world.task.states.map(({ id }) => id));
  const surface = world.surface;
  if (surface.kind === "compactChat") {
    unique(
      surface.attachments.map(({ id }) => id),
      "compact-chat attachment IDs",
    );
    if (!world.gateway.snapshots[0]?.chat.panes.some(
      ({ id }) => id === surface.paneId,
    )) {
      throw new Error("compact-chat surface pane must exist in the initial snapshot.");
    }
  }
  if (!stateIds.has(world.task.initialStateId)) {
    throw new Error("initial task state must be present in task states.");
  }
  for (const stateFixture of world.task.states) {
    const state = parseHRADirectTaskProjectionState(stateFixture.projectionJson);
    const workspaceIds = new Set(state.workspaces.map(({ id }) => id));
    unique(state.contexts.map(({ workspaceId }) => workspaceId), `task state ${stateFixture.id} context workspace IDs`);
    for (const context of state.contexts) {
      if (!workspaceIds.has(context.workspaceId)) {
        throw new Error(`task context workspace ${context.workspaceId} must be present in state ${stateFixture.id}.`);
      }
    }
    for (const repositories of state.repositories) {
      if (!workspaceIds.has(repositories.workspaceId)) {
        throw new Error(`task repository workspace ${repositories.workspaceId} must be present in state ${stateFixture.id}.`);
      }
    }
    unique(
      state.pages.map(({ page, requestCursor }) => `${page.workspaceId}:${page.view}:${requestCursor ?? "first"}`),
      `task state ${stateFixture.id} page requests`,
    );
    for (const { page } of state.pages) {
      if (!workspaceIds.has(page.workspaceId)) {
        throw new Error(`task list workspace ${page.workspaceId} must be present in state ${stateFixture.id}.`);
      }
    }
    unique(state.details.map(({ task }) => task.id), `task state ${stateFixture.id} detail task IDs`);
    unique(
      state.details.flatMap(({ task }) =>
        task.status === "in_progress" ? [task.currentClaim.id] : [],
      ),
      `task state ${stateFixture.id} claim IDs`,
    );
    unique(
      state.details.flatMap(({ runs }) => runs.map(({ id }) => id)),
      `task state ${stateFixture.id} run IDs`,
    );
    unique(
      state.details.flatMap(({ runs }) =>
        runs.flatMap(({ interactions }) =>
          interactions.map(({ request }) => request.id),
        ),
      ),
      `task state ${stateFixture.id} interaction IDs`,
    );
    for (const detail of state.details) {
      if (!workspaceIds.has(detail.workspaceId)) {
        throw new Error(`task detail workspace ${detail.workspaceId} must be present in state ${stateFixture.id}.`);
      }
    }
  }
  for (const transition of world.task.mutationTransitions) {
    if (!stateIds.has(transition.toStateId)) {
      throw new Error(`task transition ${transition.id} targets an unknown state.`);
    }
    let receipt: ReturnType<typeof operationReceiptSchema.parse>;
    try {
      receipt = operationReceiptSchema.parse(JSON.parse(transition.receiptJson) as unknown);
    } catch {
      throw new Error(`task transition ${transition.id} has an invalid receipt JSON payload.`);
    }
    if (transition.commandKind !== receipt.commandKind) {
      throw new Error(`task transition ${transition.id} command kind must match its receipt.`);
    }
    const expectedCommand = parseHRADirectExpectedTaskCommand(
      transition.expectedCommandJson,
    );
    if (transition.commandKind !== expectedCommand.kind) {
      throw new Error(`task transition ${transition.id} command kind must match its expected command.`);
    }
    if (
      expectedCommand.authority.workspaceId !== receipt.workspaceId ||
      expectedCommand.authority.workspaceId !== transition.invalidation.workspaceId
    ) {
      throw new Error(`task transition ${transition.id} must stay inside one workspace.`);
    }
  }
  const initialStateFixture = world.task.states.find(({ id }) => id === world.task.initialStateId);
  if (initialStateFixture === undefined) throw new Error("initial task state was not found.");
  const initialState = parseHRADirectTaskProjectionState(initialStateFixture.projectionJson);
  const projectAdd = world.task.projectAdd;
  if (projectAdd.status === "created" && !initialState.workspaces.some(
    ({ id }) => id === projectAdd.workspace.id,
  )) {
    throw new Error("created project-add workspace must be present in task workspaces.");
  }
  for (let index = 1; index < world.gateway.snapshots.length; index += 1) {
    const previous = world.gateway.snapshots[index - 1];
    const current = world.gateway.snapshots[index];
    if (previous === undefined || current === undefined) continue;
    if (current.lastSequence < previous.lastSequence) {
      throw new Error("scripted snapshots must not regress their event sequence.");
    }
  }
  for (let index = 1; index < world.gateway.events.length; index += 1) {
    const previous = world.gateway.events[index - 1];
    const current = world.gateway.events[index];
    if (previous === undefined || current === undefined) continue;
    if (current.event.sequence <= previous.event.sequence) {
      throw new Error("scripted event sequences must be strictly increasing.");
    }
  }
  return structuredClone(world);
}

export function emptySnapshot(
  runtime: RuntimeSnapshot["runtime"] = {
    state: "ready",
    generation: 1,
  },
  lastSequence = 0,
): RuntimeSnapshot {
  return runtimeSnapshotSchema.parse({
    revision: 1,
    lastSequence,
    runtime,
    runner: { state: "connected" },
    accounts: [],
    retainedAccountLocalData: [],
    humanAccount: { state: "signedOut", revision: 0 },
    execution: {
      folderAccess: {
        revision: 1,
        displayName: "Documents",
        availability: "ready",
      },
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
      computerUse: "required",
    },
    chat: { revision: 1, panes: [] },
  });
}

export function fixtureTaskView(options: {
  readonly id: string;
  readonly key: string;
  readonly revision: number;
  readonly status: TaskDetailProjection["task"]["status"];
  readonly title: string;
  readonly priority?: number;
  readonly reviewRevision?: number;
}): TaskDetailProjection["task"] {
  return taskViewSchema.parse({
    id: options.id,
    key: options.key,
    title: options.title,
    type: "task",
    priority: options.priority ?? 2,
    availableAt: HRA_DIRECT_TIME,
    isReady: options.status === "open",
    unresolvedBlockerCount: 0,
    cancelledBlockerCount: 0,
    revision: options.revision,
    reviewRevision: options.reviewRevision ?? options.revision,
    createdAt: HRA_DIRECT_TIME,
    updatedAt: HRA_DIRECT_TIME,
    status: options.status,
    ...(options.status === "in_progress" ? {
      currentClaim: {
        id: `claim_${options.id}`,
        agentId: "agent_local",
        fence: options.revision,
        leaseGeneration: options.revision,
        leaseUntil: HRA_DIRECT_ACTIVE_DEADLINE,
      },
    } : {}),
  });
}

export function fixtureTaskDetail(options: {
  readonly task: TaskDetailProjection["task"];
  readonly workspaceId?: string;
  readonly projectionRevision?: number;
  readonly runs?: readonly PortableRunProjection[];
  readonly submission?: TaskDetailProjection["submission"];
}): TaskDetailProjection {
  return taskDetailProjectionSchema.parse({
    workspaceId: options.workspaceId ?? hraDirectTaskIds.workspace,
    projectionRevision: options.projectionRevision ?? options.task.revision,
    task: options.task,
    description: "Deterministic local task fixture.",
    labels: [],
    parent: null,
    blockers: [],
    dependents: [],
    children: [],
    comments: [],
    events: [],
    references: [],
    runs: options.runs ?? [],
    submission: options.submission ?? null,
    recoveries: [],
    truncatedCollections: [],
  });
}

export function fixtureTaskPage(options: {
  readonly tasks: readonly TaskDetailProjection["task"][];
  readonly view?: TaskListPage["view"];
  readonly workspaceId?: string;
  readonly projectionRevision?: number;
  readonly runsByTaskKey?: Readonly<Record<string, {
    readonly phase: PortableRunProjection["phase"];
    readonly updatedAt?: number;
  }>>;
  readonly humanInputsByTaskKey?: Readonly<Record<string, {
    readonly expiresAt: number;
    readonly kind: "approval" | "user_input";
    readonly oldestRequestedAt: number;
    readonly pendingCount: number;
    readonly preview: string;
  }>>;
}): TaskListPage {
  const view = options.view ?? "all";
  const projectionRevision = options.projectionRevision ?? Math.max(
    1,
    ...options.tasks.map(({ revision }) => revision),
  );
  return taskListPageSchema.parse({
    workspaceId: options.workspaceId ?? hraDirectTaskIds.workspace,
    view,
    ...(view === "assigned" ? { assignedAgentId: "agent_local" } : {}),
    projectionRevision,
    items: options.tasks.map((task) => {
      const run = options.runsByTaskKey?.[task.key];
      const humanInput = options.humanInputsByTaskKey?.[task.key] ?? null;
      return {
        humanInput,
        run: run === undefined ? null : {
          latestDisplay: { kind: "codex.running", observedAt: run.updatedAt ?? HRA_DIRECT_TIME },
          phase: run.phase,
          updatedAt: run.updatedAt ?? HRA_DIRECT_TIME,
        },
        task,
      };
    }),
    cursor: null,
    hasMore: false,
  });
}

export function fixtureLocalWorkspace(revision: number): WorkspaceSummary {
  return {
    id: hraDirectTaskIds.workspace,
    name: "Local hra",
    slug: "local-hra",
    keyPrefix: "KIT",
    revision,
    authority: {
      kind: "local",
      localWorkspaceId: hraDirectTaskIds.workspace,
      ownerInstallationId: "install_local0001",
    },
    counts: {
      all: { capped: false, value: 0 },
      ready: { capped: false, value: 0 },
      blocked: { capped: false, value: 0 },
      deferred: { capped: false, value: 0 },
      attention: { capped: false, value: 0 },
      assigned: { capped: false, value: 0 },
      review: { capped: false, value: 0 },
    },
  };
}

type AccountOverrides = Partial<AccountSummary> & Pick<AccountSummary, "id" | "label">;

export function fixtureAccount(overrides: AccountOverrides): AccountSummary {
  return {
    id: overrides.id,
    revision: overrides.revision ?? 1,
    label: overrides.label,
    selected: overrides.selected ?? false,
    identityLabel: overrides.identityLabel ?? null,
    planLabel: overrides.planLabel ?? null,
    weeklyUsage: overrides.weeklyUsage ?? null,
    authState: overrides.authState ?? "signedOut",
    login: overrides.login ?? { state: "idle" },
    runtime: overrides.runtime ?? {
      state: "ready",
      generation: 1,
    },
  };
}

export function signedInAccount(options: {
  readonly id: string;
  readonly label: string;
  readonly identityLabel: string;
  readonly selected: boolean;
}): AccountSummary {
  return fixtureAccount({
    id: options.id,
    label: options.label,
    selected: options.selected,
    identityLabel: options.identityLabel,
    planLabel: "Pro",
    authState: "signedIn",
  });
}

export function createHRADirectWorld(
  overrides: Partial<HRADirectWorldInput> = {},
): HRADirectWorld {
  const base: HRADirectWorldInput = {
    version: HRA_DIRECT_WORLD_VERSION,
    surface: { kind: "app" },
    gateway: {
      snapshots: [emptySnapshot()],
      encoding: { kind: "chunked", chunkBytes: 257 },
      events: [],
    },
    task: {
      initialStateId: "empty",
      mutationTransitions: [],
      projectAdd: { version: runtimeProtocolVersion, status: "cancelled" },
      states: [{
        id: "empty",
        projectionJson: JSON.stringify({
          workspaces: [],
          contexts: [],
          repositories: [],
          pages: [],
          details: [],
        }),
      }],
    },
  };
  return parseHRADirectWorld({ ...base, ...overrides });
}
