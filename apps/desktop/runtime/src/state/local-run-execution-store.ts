import type { Database } from "bun:sqlite";
import {
  MAX_NONTERMINAL_RUN_EVENTS,
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
  portableWorkspaceEventSchema,
  runDisplayTextSchema,
  taskDomain,
  type PortableRunInteractionRequest,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { createHash } from "node:crypto";

import {
  canTransitionDispatch,
  publicRunEvent,
  type DispatchStage,
  type PublicRunEventKind,
  type PublicRunTextEventKind,
} from "../dispatch/model";
import type {
  DispatchCoordinatorStore,
  DispatchFenceGuard,
  DispatchPublicationBarrier,
} from "../dispatch/coordinator";
import { renderTaskWorkflowPromptV1 } from "../dispatch/task-workflow-prompt-v1";
import type {
  DispatchBinding,
  DispatchReservation,
  PendingDispatchEvent,
} from "./dispatch-store";
import type {
  LocalTaskDueWork,
  LocalTaskDueWorkCurrentAuthority,
  LocalTaskDueWorkStaleAuthority,
} from "../tasks/reconciler";
import type {
  WorkspaceLaneIdentity,
  WorkspaceLaneIdentityStore,
} from "../workspaces/workspace-broker";

const defaultClaimLeaseMs = 60_000;

const admissionRowSchema = z.object({
  workspace_id: taskDomain.workspacePublicIdSchema,
  run_id: taskDomain.dispatchIdSchema,
  task_id: taskDomain.taskPublicIdSchema,
  repository_id: taskDomain.repositoryIdSchema,
  phase: taskDomain.runPhaseSchema,
  desired_state: z.enum(["run", "stop"]),
  intent_state: z.enum(["queued", "claimed", "started", "terminal", "abandoned"]),
  intent_fence: taskDomain.positiveGenerationSchema,
  claimed_boot_generation: taskDomain.positiveGenerationSchema.nullable(),
  available_at: taskDomain.epochMsSchema,
  task_key: taskDomain.taskKeySchema,
  title: taskDomain.taskTitleSchema,
  description: z.string(),
  task_status: taskDomain.taskStatusSchema,
  task_revision: taskDomain.revisionSchema,
  review_revision: taskDomain.revisionSchema,
  unresolved_blocker_count: z.number().int().nonnegative(),
  cancelled_blocker_count: z.number().int().nonnegative(),
  agent_id: taskDomain.agentIdSchema,
  executor_enabled: z.number().int().min(0).max(1),
  canonical_repository_path: z.string().min(1),
  canonical_git_common_dir: z.string().min(1),
  authority_kind: z.enum(["local", "promoting", "cloud"]),
}).strict();

const bindingRowSchema = z.object({
  workspace_id: taskDomain.workspacePublicIdSchema,
  run_id: taskDomain.dispatchIdSchema,
  task_id: taskDomain.taskPublicIdSchema,
  task_key: taskDomain.taskKeySchema,
  claim_id: taskDomain.dispatchClaimIdSchema,
  claim_fence: taskDomain.positiveGenerationSchema,
  input_review_revision: taskDomain.revisionSchema,
  runtime_public_id: taskDomain.runnerIdSchema,
  runtime_boot_id: taskDomain.runnerBootIdSchema,
  repository_id: taskDomain.repositoryIdSchema,
  execution_mode: z.enum(["managed_worktree", "legacy_unbound"]),
  account_profile_id: z.string().min(1),
  lane_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  turn_id: z.string().nullable(),
  stage: z.enum([
    "reserved",
    "worktree_ready",
    "thread_starting",
    "thread_ready",
    "turn_starting",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "lease_lost",
    "ambiguous",
  ]),
  base_sha: z.string().min(1),
  branch_name: z.string().nullable(),
  last_event_sequence: z.number().int().min(1).max(100),
  failure_code: z.string().nullable(),
  created_at: taskDomain.epochMsSchema,
  updated_at: taskDomain.epochMsSchema,
}).strict();

const eventRowSchema = z.object({
  workspace_id: taskDomain.workspacePublicIdSchema,
  run_id: taskDomain.dispatchIdSchema,
  sequence: taskDomain.positiveGenerationSchema,
  event_id: taskDomain.dispatchEventIdSchema,
  event_kind: taskDomain.publicRunEventKindSchema,
  display_text: z.string().nullable(),
  observed_at: taskDomain.epochMsSchema,
}).strict();

export interface LocalRunLaunchCandidate {
  readonly baseRef: "HEAD";
  readonly canonicalGitCommonDir: string;
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly runId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly title: string;
  readonly workspaceId: string;
}

export interface LocalRunAdmission {
  readonly assignment: Readonly<{
    accountProfileId: string;
    baseRef: string;
    claimFence: number;
    claimId: string;
    initialPrompt: string;
    inputReviewRevision: number;
    repositoryPath: string;
    repositoryPublicId: string;
    runId: string;
    runtimeBootId: string;
    runtimePublicId: string;
    taskId: string;
    taskKey: string;
    title: string;
  }>;
  readonly projectionRevision: number;
  readonly workspaceId: string;
}

export type LocalRunAdmissionResult =
  | Readonly<{ kind: "admitted"; admission: LocalRunAdmission }>
  | Readonly<{ kind: "obsolete"; authority: LocalTaskDueWorkStaleAuthority }>;

export type LocalRunTaskChange = Extract<
  taskDomain.PortableInvalidation,
  { readonly scope: "task_change" }
>;

function localRunTaskChange(input: Readonly<{
  affectsWorkspaceSummary?: boolean;
  changeKind: LocalRunTaskChange["changeKind"];
  projectionRevision: number;
  runId: string;
  taskId: string;
  workspaceId: string;
}>): LocalRunTaskChange {
  return taskDomain.portableTaskChangeRecordSchema.parse({
    workspaceId: input.workspaceId,
    projectionRevision: input.projectionRevision,
    scope: "task_change",
    taskId: input.taskId,
    runId: input.runId,
    changeKind: input.changeKind,
    affectedProjections: [
      ...(
        input.affectsWorkspaceSummary === true ||
        input.changeKind === "run.admitted" ||
        input.changeKind === "task.submitted"
        ? [{ projection: "workspace_summary" as const }]
        : []),
      {
        projection: "task_list",
        views: [...taskDomain.taskWorkspaceViewValues],
      },
      { projection: "task_detail" },
    ],
  });
}

export interface LocalRunExecutionStoreOptions {
  readonly database: Database;
  readonly onCapacityReleased?: (runId: string) => void;
  readonly onChanged?: (input: LocalRunTaskChange) => void;
}

export class LocalCompletionBlockedByInteractionError extends Error {
  constructor() {
    super("Local completion is blocked by an unsettled interaction");
    this.name = "LocalCompletionBlockedByInteractionError";
  }
}

export interface LocalInteractionAuthority {
  readonly agentId: string;
  readonly expectedTaskRevision: number;
  readonly expectedWorkspaceRevision: number;
  readonly installationId: string;
  readonly request: PortableRunInteractionRequest;
  readonly responseRevision: number | null;
  readonly runId: string;
  readonly state: "pending" | "answered" | "resolved" | "expired";
  readonly taskId: string;
  readonly workspaceId: string;
}

/**
 * SQLite authority for the private execution binding and the public local-run
 * projection. Every started intent is coupled atomically to a fenced claim,
 * an account/base reservation, and completion of its queued due-work row.
 */
export class LocalRunExecutionStore
  implements
    DispatchCoordinatorStore,
    DispatchFenceGuard,
    DispatchPublicationBarrier,
    WorkspaceLaneIdentityStore
{
  readonly #database: Database;
  readonly #onCapacityReleased: NonNullable<
    LocalRunExecutionStoreOptions["onCapacityReleased"]
  >;
  readonly #onChanged: NonNullable<LocalRunExecutionStoreOptions["onChanged"]>;

  constructor(options: LocalRunExecutionStoreOptions) {
    this.#database = options.database;
    this.#onCapacityReleased = options.onCapacityReleased ?? (() => undefined);
    this.#onChanged = options.onChanged ?? (() => undefined);
  }

  launchCandidate(
    workspaceId: string,
    runId: string,
  ): LocalRunLaunchCandidate | null {
    const value: unknown = this.#database.query(`
      SELECT local_task_runs.workspace_id, local_task_runs.run_id,
        local_task_runs.task_id, local_task_runs.repository_id,
        local_task_runs.phase, local_task_runs.desired_state,
        local_queued_run_intents.state AS intent_state,
        local_queued_run_intents.fence AS intent_fence,
        local_queued_run_intents.claimed_boot_generation,
        local_queued_run_intents.available_at,
        local_tasks.task_key, local_tasks.title,
        local_task_bodies.description,
        local_tasks.status AS task_status,
        local_tasks.revision AS task_revision,
        local_tasks.review_revision,
        local_tasks.unresolved_blocker_count,
        local_tasks.cancelled_blocker_count,
        local_builtin_executors.agent_id,
        local_builtin_executors.enabled AS executor_enabled,
        local_repositories.canonical_repository_path,
        local_repositories.canonical_git_common_dir,
        local_workspaces.authority_kind
      FROM local_task_runs
      JOIN local_queued_run_intents
        ON local_queued_run_intents.workspace_id = local_task_runs.workspace_id
        AND local_queued_run_intents.run_id = local_task_runs.run_id
      JOIN local_tasks
        ON local_tasks.workspace_id = local_task_runs.workspace_id
        AND local_tasks.task_id = local_task_runs.task_id
      JOIN local_task_bodies
        ON local_task_bodies.workspace_id = local_tasks.workspace_id
        AND local_task_bodies.task_id = local_tasks.task_id
      JOIN local_builtin_executors
        ON local_builtin_executors.workspace_id = local_task_runs.workspace_id
      JOIN local_repositories
        ON local_repositories.repository_id = local_task_runs.repository_id
      JOIN local_workspaces
        ON local_workspaces.workspace_id = local_task_runs.workspace_id
      WHERE local_task_runs.workspace_id = ?1 AND local_task_runs.run_id = ?2
        AND local_repositories.tombstoned_at IS NULL
    `).get(workspaceId, runId);
    if (value === null) return null;
    const row = admissionRowSchema.parse(value);
    if (
      row.authority_kind !== "local"
      || row.phase !== "queued"
      || row.desired_state !== "run"
      || row.intent_state !== "queued"
      || row.task_status !== "open"
      || row.executor_enabled !== 1
      || row.unresolved_blocker_count + row.cancelled_blocker_count !== 0
    ) return null;
    return {
      baseRef: "HEAD",
      canonicalGitCommonDir: row.canonical_git_common_dir,
      repositoryId: row.repository_id,
      repositoryPath: row.canonical_repository_path,
      runId: row.run_id,
      taskId: row.task_id,
      taskKey: row.task_key,
      title: row.title,
      workspaceId: row.workspace_id,
    };
  }

  admit(input: {
    readonly accountProfileId: string;
    readonly authority: LocalTaskDueWorkCurrentAuthority;
    readonly baseSha: string;
    readonly bootGeneration: number;
    readonly claimLeaseMs?: number;
    readonly now: number;
    readonly runtimeBootId: string;
    readonly runtimePublicId: string;
    readonly work: LocalTaskDueWork;
  }): LocalRunAdmissionResult {
    const claimLeaseMs = positiveInteger(
      input.claimLeaseMs ?? defaultClaimLeaseMs,
      "claim lease",
    );
    const outcome = this.#database.transaction(() => {
      const currentBoot = this.#currentBootGeneration();
      if (
        currentBoot !== input.bootGeneration
        || input.work.kind !== "queued_run"
        || input.work.claimedBootGeneration !== input.bootGeneration
        || input.authority.bootGeneration !== input.bootGeneration
      ) return obsolete("boot");
      const due = this.#database.query(`
        SELECT due_at, expected_revision, expected_fence, state,
          claimed_boot_generation, work_generation
        FROM local_due_work WHERE due_work_id = ?1
      `).get(input.work.id) as {
        due_at: number;
        expected_revision: number | null;
        expected_fence: number | null;
        state: string;
        claimed_boot_generation: number | null;
        work_generation: number;
      } | null;
      if (
        due === null
        || due.state !== "claimed"
        || due.claimed_boot_generation !== input.bootGeneration
        || due.work_generation !== input.work.workGeneration
      ) return obsolete("boot");
      if (
        due.due_at !== input.work.dueAt
        || input.authority.deadlineCheckedAt < input.work.dueAt
      ) return obsolete("deadline");
      if (
        due.expected_revision !== input.work.expectedRevision
        || input.authority.revision !== input.work.expectedRevision
      ) return obsolete("revision");
      if (
        due.expected_fence !== input.work.expectedFence
        || input.authority.fence !== input.work.expectedFence
      ) return obsolete("fence");

      const candidateValue = this.#candidateRow(
        input.work.workspaceId,
        input.work.entityId,
      );
      if (candidateValue === null) return obsolete("missing");
      const row = admissionRowSchema.parse(candidateValue);
      if (
        row.authority_kind !== "local"
        || row.phase !== "queued"
        || row.desired_state !== "run"
        || row.intent_state !== "queued"
        || row.available_at !== input.work.dueAt
        || row.available_at > input.now
        || row.task_status !== "open"
        || row.executor_enabled !== 1
        || row.unresolved_blocker_count + row.cancelled_blocker_count !== 0
      ) return obsolete("missing");
      if (row.task_revision !== input.work.expectedRevision) {
        return obsolete("revision");
      }
      const existing = this.read(row.run_id);
      if (existing !== null) return obsolete("missing");

      const claimId = opaqueId("claim", `local:${row.workspace_id}:${row.run_id}`);
      const leaseUntil = checkedAdd(input.now, claimLeaseMs);
      this.#database.query(`
        INSERT INTO local_task_claims (
          workspace_id, task_id, claim_id, agent_id, fence, lease_generation,
          lease_until, state, boot_generation, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'active', ?7, ?8, ?8)
      `).run(
        row.workspace_id,
        row.task_id,
        claimId,
        row.agent_id,
        row.intent_fence,
        leaseUntil,
        input.bootGeneration,
        input.now,
      );
      this.#database.query(`
        UPDATE local_tasks
        SET status = 'in_progress', assignee_agent_id = ?3,
          revision = revision + 1, updated_at = ?4
        WHERE workspace_id = ?1 AND task_id = ?2 AND status = 'open'
      `).run(row.workspace_id, row.task_id, row.agent_id, input.now);
      const started = this.#database.query(`
        UPDATE local_task_runs
        SET phase = 'leased', claim_id = ?3, fence = ?4,
          boot_generation = ?5, recovery_state = 'none',
          started_at = ?6, updated_at = ?6
        WHERE workspace_id = ?1 AND run_id = ?2 AND phase = 'queued'
          AND desired_state = 'run'
      `).run(
        row.workspace_id,
        row.run_id,
        claimId,
        row.intent_fence,
        input.bootGeneration,
        input.now,
      );
      if (started.changes !== 1) throw new Error("Queued run changed during admission");
      this.#database.query(`
        UPDATE local_queued_run_intents
        SET state = 'started', claimed_boot_generation = ?3, updated_at = ?4
        WHERE workspace_id = ?1 AND run_id = ?2 AND state = 'queued'
      `).run(row.workspace_id, row.run_id, input.bootGeneration, input.now);
      for (const [kind, entityId] of [
        ["run_intent", row.run_id],
        ["run", row.run_id],
        ["claim", claimId],
      ] as const) {
        this.#database.query(`
          INSERT INTO local_fences (
            workspace_id, entity_kind, entity_id, fence, boot_generation, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(workspace_id, entity_kind, entity_id) DO UPDATE SET
            fence = excluded.fence,
            boot_generation = excluded.boot_generation,
            updated_at = excluded.updated_at
        `).run(
          row.workspace_id,
          kind,
          entityId,
          row.intent_fence,
          input.bootGeneration,
          input.now,
        );
      }
      this.#database.query(`
        INSERT INTO local_run_execution_bindings (
          workspace_id, run_id, task_id, task_key, claim_id, claim_fence,
          input_review_revision, runtime_public_id, runtime_boot_id,
          repository_id, execution_mode, account_profile_id, stage, base_sha,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'managed_worktree', ?11,
          'reserved', ?12, ?13, ?13
        )
      `).run(
        row.workspace_id,
        row.run_id,
        row.task_id,
        row.task_key,
        claimId,
        row.intent_fence,
        row.review_revision,
        input.runtimePublicId,
        input.runtimeBootId,
        row.repository_id,
        input.accountProfileId,
        input.baseSha,
        input.now,
      );
      this.#upsertClaimExpiry({
        workspaceId: row.workspace_id,
        claimId,
        dueAt: leaseUntil,
        fence: row.intent_fence,
        leaseGeneration: 1,
        now: input.now,
      });
      const completed = this.#database.query(`
        UPDATE local_due_work
        SET state = 'done', claimed_boot_generation = NULL, claimed_at = NULL,
          last_error_code = NULL, updated_at = ?3
        WHERE due_work_id = ?1 AND state = 'claimed'
          AND claimed_boot_generation = ?2
          AND work_generation = ?4
      `).run(
        input.work.id,
        input.bootGeneration,
        input.now,
        input.work.workGeneration,
      );
      if (completed.changes !== 1) {
        throw new Error("Queued due work changed during admission");
      }
      const projectionRevision = this.#recordRunChanged(
        row.workspace_id,
        row.task_id,
        row.run_id,
        "leased",
        input.now,
        `admit:${row.run_id}:${String(row.intent_fence)}`,
      );
      const assignment = {
        accountProfileId: input.accountProfileId,
        baseRef: input.baseSha,
        claimFence: row.intent_fence,
        claimId,
        initialPrompt: renderTaskWorkflowPromptV1({
          taskKey: row.task_key,
          title: row.title,
          description: row.description,
        }),
        inputReviewRevision: row.review_revision,
        repositoryPath: row.canonical_repository_path,
        repositoryPublicId: row.repository_id,
        runId: row.run_id,
        runtimeBootId: input.runtimeBootId,
        runtimePublicId: input.runtimePublicId,
        taskId: row.task_id,
        taskKey: row.task_key,
        title: row.title,
      };
      return {
        kind: "admitted" as const,
        admission: {
          assignment,
          projectionRevision,
          workspaceId: row.workspace_id,
        },
      };
    })();
    if (outcome.kind === "admitted") {
      this.#onChanged(localRunTaskChange({
        changeKind: "run.admitted",
        projectionRevision: outcome.admission.projectionRevision,
        runId: outcome.admission.assignment.runId,
        taskId: outcome.admission.assignment.taskId,
        workspaceId: outcome.admission.workspaceId,
      }));
    }
    return outcome;
  }

  renewClaims(input: {
    readonly bootGeneration: number;
    readonly leaseMs?: number;
    readonly now: number;
  }): number {
    const leaseMs = positiveInteger(
      input.leaseMs ?? defaultClaimLeaseMs,
      "claim lease",
    );
    if (this.#currentBootGeneration() !== input.bootGeneration) return 0;
    const values = this.#database.query(`
      SELECT binding.workspace_id, binding.run_id, binding.claim_id,
        binding.claim_fence, claim.lease_generation
      FROM local_run_execution_bindings AS binding
      JOIN local_task_claims AS claim
        ON claim.workspace_id = binding.workspace_id
        AND claim.claim_id = binding.claim_id
      WHERE claim.state = 'active'
        AND binding.stage IN (
          'reserved', 'worktree_ready', 'thread_starting', 'thread_ready',
          'turn_starting', 'running', 'waiting'
        )
        AND binding.runtime_boot_id = (
          SELECT boot_id FROM local_runtime_boot_state WHERE singleton = 1
        )
    `).all() as readonly {
      workspace_id: string;
      run_id: string;
      claim_id: string;
      claim_fence: number;
      lease_generation: number;
    }[];
    let renewed = 0;
    for (const row of values) {
      const leaseUntil = checkedAdd(input.now, leaseMs);
      const nextGeneration = row.lease_generation + 1;
      this.#database.transaction(() => {
        const update = this.#database.query(`
          UPDATE local_task_claims
          SET lease_generation = ?4, lease_until = ?5, updated_at = ?6
          WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'active'
            AND fence = ?3
        `).run(
          row.workspace_id,
          row.claim_id,
          row.claim_fence,
          nextGeneration,
          leaseUntil,
          input.now,
        );
        if (update.changes !== 1) return;
        this.#upsertClaimExpiry({
          workspaceId: row.workspace_id,
          claimId: row.claim_id,
          dueAt: leaseUntil,
          fence: row.claim_fence,
          leaseGeneration: nextGeneration,
          now: input.now,
        });
        renewed += 1;
      })();
    }
    return renewed;
  }

  reserve(input: DispatchReservation): DispatchBinding {
    const existing = this.read(input.runId);
    if (existing === null || !sameReservation(existing, input)) {
      throw new Error("Local dispatch reservation is missing or conflicts");
    }
    return existing;
  }

  read(runId: string): DispatchBinding | null {
    const values: unknown[] = this.#database.query(`
      SELECT workspace_id, run_id, task_id, task_key, claim_id, claim_fence,
        input_review_revision, runtime_public_id, runtime_boot_id,
        repository_id, execution_mode, account_profile_id, lane_id, thread_id,
        turn_id, stage, base_sha, branch_name, last_event_sequence,
        failure_code, created_at, updated_at
      FROM local_run_execution_bindings WHERE run_id = ?1
      LIMIT 2
    `).all(runId);
    if (values.length > 1) throw new Error("Local run ID is not globally unique");
    const value = values[0];
    return value === undefined ? null : fromBinding(bindingRowSchema.parse(value));
  }

  readByTurn(input: {
    readonly accountProfileId: string;
    readonly threadId: string;
    readonly turnId: string;
  }): DispatchBinding | null {
    const value = this.#database.query(`
      SELECT run_id FROM local_run_execution_bindings
      WHERE account_profile_id = ?1 AND thread_id = ?2 AND turn_id = ?3
    `).get(
      input.accountProfileId,
      input.threadId,
      input.turnId,
    ) as { run_id: string } | null;
    return value === null ? null : this.read(value.run_id);
  }

  readTurnStartingByThread(input: {
    readonly accountProfileId: string;
    readonly threadId: string;
  }): DispatchBinding | null {
    const values = this.#database.query(`
      SELECT run_id FROM local_run_execution_bindings
      WHERE account_profile_id = ?1 AND thread_id = ?2 AND stage = 'turn_starting'
      ORDER BY updated_at DESC LIMIT 2
    `).all(input.accountProfileId, input.threadId) as readonly { run_id: string }[];
    return values.length === 1 && values[0] !== undefined
      ? this.read(values[0].run_id)
      : null;
  }

  requestInteraction(input: {
    readonly accountProfileId: string;
    readonly request: PortableRunInteractionRequest;
    readonly threadId: string;
    readonly turnId: string;
  }): DispatchBinding | null {
    const result = this.#database.transaction(() => {
      const binding = this.readByTurn(input);
      if (
        binding === null
        || (binding.stage !== "running" && binding.stage !== "waiting")
      ) return null;
      const run = this.#runState(binding.runId);
      const existing = this.#database.query(`
        SELECT workspace_id, run_id, request_json
        FROM local_run_interactions
        WHERE interaction_id = ?1
        ORDER BY workspace_id
        LIMIT 2
      `).all(input.request.id) as readonly {
        workspace_id: string;
        run_id: string;
        request_json: string;
      }[];
      if (existing.length > 1) {
        throw new Error("Local interaction ID is not globally unique");
      }
      const requestJson = JSON.stringify(input.request);
      const replay = existing[0];
      if (replay !== undefined) {
        if (
          replay.workspace_id !== run.workspaceId
          || replay.run_id !== run.runId
          || replay.request_json !== requestJson
        ) {
          throw new Error("Local interaction ID conflicts");
        }
        return { binding, changed: null };
      }
      const now = Date.now();
      this.#database.query(`
        INSERT INTO local_run_interactions (
          workspace_id, run_id, interaction_id, request_json, state,
          created_at, expires_at
        ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)
      `).run(
        run.workspaceId,
        run.runId,
        input.request.id,
        requestJson,
        input.request.createdAt,
        input.request.expiresAt,
      );
      const projectionRevision = this.#recordRunChanged(
        run.workspaceId,
        run.taskId,
        run.runId,
        run.phase,
        now,
        `interaction-request:${input.request.id}`,
      );
      return {
        binding,
        changed: localRunTaskChange({
          changeKind: "run.interaction_changed",
          projectionRevision,
          runId: run.runId,
          taskId: run.taskId,
          workspaceId: run.workspaceId,
        }),
      };
    })();
    if (result === null) return null;
    if (result.changed !== null) this.#onChanged(result.changed);
    return result.binding;
  }

  interactionAuthority(interactionId: string): LocalInteractionAuthority | null {
    const value: unknown = this.#database.query(`
      SELECT interaction.workspace_id, interaction.run_id,
        interaction.request_json, interaction.state,
        interaction.response_revision,
        run.task_id, task.revision AS task_revision,
        workspace.revision AS workspace_revision,
        workspace.owner_installation_id,
        claim.agent_id
      FROM local_run_interactions AS interaction
      JOIN local_task_runs AS run
        ON run.workspace_id = interaction.workspace_id
        AND run.run_id = interaction.run_id
      JOIN local_tasks AS task
        ON task.workspace_id = run.workspace_id AND task.task_id = run.task_id
      JOIN local_workspaces AS workspace
        ON workspace.workspace_id = interaction.workspace_id
      JOIN local_task_claims AS claim
        ON claim.workspace_id = run.workspace_id AND claim.claim_id = run.claim_id
      WHERE interaction.interaction_id = ?1
    `).get(interactionId);
    if (value === null) return null;
    const row = z.object({
      workspace_id: taskDomain.workspacePublicIdSchema,
      run_id: taskDomain.dispatchIdSchema,
      request_json: z.string(),
      state: z.enum(["pending", "answered", "resolved", "expired"]),
      response_revision: taskDomain.positiveGenerationSchema.nullable(),
      task_id: taskDomain.taskPublicIdSchema,
      task_revision: taskDomain.revisionSchema,
      workspace_revision: taskDomain.revisionSchema,
      owner_installation_id: taskDomain.runnerInstallationIdSchema,
      agent_id: taskDomain.agentIdSchema,
    }).strict().parse(value);
    return {
      agentId: row.agent_id,
      expectedTaskRevision: row.task_revision,
      expectedWorkspaceRevision: row.workspace_revision,
      installationId: row.owner_installation_id,
      request: taskDomain.portableRunInteractionRequestSchema.parse(
        JSON.parse(row.request_json) as unknown,
      ),
      responseRevision: row.response_revision,
      runId: row.run_id,
      state: row.state,
      taskId: row.task_id,
      workspaceId: row.workspace_id,
    };
  }

  expireInteraction(
    interactionId: string,
    now = Date.now(),
  ): LocalInteractionAuthority | null {
    const result = this.#database.transaction(() => {
      const authority = this.interactionAuthority(interactionId);
      if (authority === null || authority.state !== "pending") return null;
      const update = this.#database.query(`
        UPDATE local_run_interactions
        SET state = 'expired', resolved_at = ?2
        WHERE interaction_id = ?1 AND state = 'pending'
      `).run(interactionId, now);
      if (update.changes !== 1) return null;
      const run = this.#runState(authority.runId);
      const projectionRevision = this.#recordRunChanged(
        authority.workspaceId,
        authority.taskId,
        authority.runId,
        run.phase,
        now,
        `interaction-expire:${interactionId}`,
      );
      return {
        authority: { ...authority, state: "expired" as const },
        changed: localRunTaskChange({
          changeKind: "run.interaction_changed",
          projectionRevision,
          runId: authority.runId,
          taskId: authority.taskId,
          workspaceId: authority.workspaceId,
        }),
      };
    })();
    if (result === null) return null;
    this.#onChanged(result.changed);
    return result.authority;
  }

  answeredInteractionsNeedingRecovery(): readonly Readonly<{
    interactionId: string;
    runId: string;
  }>[] {
    const values = this.#database.query(`
      SELECT interaction.interaction_id, interaction.run_id
      FROM local_run_interactions AS interaction
      JOIN local_run_execution_bindings AS binding
        ON binding.workspace_id = interaction.workspace_id
        AND binding.run_id = interaction.run_id
      WHERE interaction.state = 'answered'
        AND binding.capacity_released_at IS NULL
      ORDER BY interaction.created_at, interaction.interaction_id
    `).all() as readonly {
      interaction_id: string;
      run_id: string;
    }[];
    return values.map((value) => ({
      interactionId: value.interaction_id,
      runId: value.run_id,
    }));
  }

  recoverAnsweredInteractionsOnRestart(): readonly string[] {
    const recovered: string[] = [];
    for (const interaction of this.answeredInteractionsNeedingRecovery()) {
      let binding = this.read(interaction.runId);
      if (binding === null) continue;
      if (binding.stage === "running" || binding.stage === "waiting") {
        binding = this.transition({
          runId: interaction.runId,
          to: "ambiguous",
          failureCode: "interaction_restart_ambiguity",
        });
      }
      const run = this.#runState(interaction.runId);
      if (
        (binding.stage === "ambiguous" || binding.stage === "lease_lost")
        && run.phase !== "ambiguous"
      ) {
        this.appendPublicEvent({
          runId: interaction.runId,
          eventId:
            `${interaction.runId}:interaction:${interaction.interactionId}:restart_ambiguous`,
          kind: "run.lease_lost",
        });
      }
      recovered.push(interaction.runId);
    }
    return [...new Set(recovered)].sort();
  }

  /**
   * Repairs a crash after durable terminal publication but before releasing
   * the process-wide account slot. Unsettled interactions on a proven local
   * terminal are expired in the same transaction as its durable release.
   * Explicitly ambiguous executions remain retained for human resolution.
   */
  reconcileRetainedTerminalCapacityOnRestart(
    now = Date.now(),
  ): readonly string[] {
    const released: string[] = [];
    for (const reservation of this.capacityReservations()) {
      try {
        this.reconcileTerminalStage(reservation.runId);
      } catch {
        // The event may have committed before its invalidation hint threw.
        // The durable phase proof below distinguishes that from a rollback.
      }
      const result = this.#database.transaction(() => {
        const binding = this.read(reservation.runId);
        if (binding === null) return null;
        const run = this.#runState(reservation.runId);
        const provenTerminal =
          (binding.stage === "completed" && run.phase === "submitted")
          || (binding.stage === "failed" && run.phase === "failed")
          || (binding.stage === "cancelled" && run.phase === "cancelled")
          || (binding.stage === "lease_lost" && run.phase === "ambiguous")
          || this.#hasHumanResolutionProof(reservation.runId);
        if (!provenTerminal) return null;
        const expired = this.#expireUnsettledInteractions(
          reservation.runId,
          now,
        );
        const changed = expired === 0
          ? null
          : localRunTaskChange({
              changeKind: "run.interaction_changed",
              projectionRevision: this.#recordRunChanged(
                run.workspaceId,
                run.taskId,
                run.runId,
                run.phase,
                now,
                `terminal-interaction-recovery:${run.runId}`,
              ),
              runId: run.runId,
              taskId: run.taskId,
              workspaceId: run.workspaceId,
            });
        if (!this.releaseCapacity(reservation.runId, now)) return null;
        return { changed };
      })();
      if (result === null) continue;
      if (result.changed !== null) {
        try {
          this.#onChanged(result.changed);
        } catch {
          // The projection revision is durable; invalidation is only a hint.
        }
      }
      released.push(reservation.runId);
    }
    return released.sort();
  }

  transition(input: {
    readonly runId: string;
    readonly to: DispatchStage;
    readonly accountProfileId?: string;
    readonly laneId?: string;
    readonly threadId?: string;
    readonly turnId?: string;
    readonly baseSha?: string;
    readonly branchName?: string;
    readonly failureCode?: string;
  }): DispatchBinding {
    const result = this.#database.transaction(() => {
      const current = this.read(input.runId);
      if (current === null) throw new Error("Local dispatch binding does not exist");
      if (!canTransitionDispatch(current.stage, input.to)) {
        throw new Error(`Local dispatch cannot transition ${current.stage} to ${input.to}`);
      }
      const now = Date.now();
      const update = this.#database.query(`
        UPDATE local_run_execution_bindings SET
          stage = ?2,
          account_profile_id = coalesce(?3, account_profile_id),
          lane_id = coalesce(?4, lane_id),
          thread_id = coalesce(?5, thread_id),
          turn_id = coalesce(?6, turn_id),
          base_sha = coalesce(?7, base_sha),
          branch_name = coalesce(?8, branch_name),
          failure_code = coalesce(?9, failure_code),
          updated_at = ?10
        WHERE run_id = ?1 AND stage = ?11
      `).run(
        input.runId,
        input.to,
        input.accountProfileId ?? null,
        input.laneId ?? null,
        input.threadId ?? null,
        input.turnId ?? null,
        input.baseSha ?? null,
        input.branchName ?? null,
        input.failureCode ?? null,
        now,
        current.stage,
      );
      if (update.changes !== 1) throw new Error("Local dispatch stage changed");
      let changed: LocalRunTaskChange | null = null;
      if (input.to === "cancelled") {
        const run = this.#runState(input.runId);
        const phaseUpdate = this.#database.query(`
          UPDATE local_task_runs
          SET phase = 'cancel_requested', desired_state = 'stop', updated_at = ?2
          WHERE run_id = ?1 AND phase IN (
            'leased', 'provisioning', 'starting', 'running', 'waiting'
          )
        `).run(input.runId, now);
        if (phaseUpdate.changes === 1) {
          changed = localRunTaskChange({
            changeKind: "run.phase_changed",
            projectionRevision: this.#recordRunChanged(
              run.workspaceId,
              run.taskId,
              run.runId,
              "cancel_requested",
              now,
              `cancel-requested:${run.runId}:${current.stage}`,
            ),
            runId: run.runId,
            taskId: run.taskId,
            workspaceId: run.workspaceId,
          });
        }
      }
      const updated = this.read(input.runId);
      if (updated === null) throw new Error("Local dispatch binding disappeared");
      return { binding: updated, changed };
    })();
    if (result.changed !== null) this.#onChanged(result.changed);
    return result.binding;
  }

  appendPublicEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunEventKind;
  }): PendingDispatchEvent {
    return this.#appendEvent(input);
  }

  #appendEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunEventKind;
    readonly displayText?: string;
  }): PendingDispatchEvent {
    const changed = this.#commitEvent(input);
    if (changed.changed !== null) this.#onChanged(changed.changed);
    return changed.event;
  }

  #commitEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunEventKind;
    readonly displayText?: string;
  }) {
    return this.#database.transaction(() => {
      const binding = this.read(input.runId);
      if (binding === null) throw new Error("Local dispatch binding does not exist");
      if (input.kind === "run.queued") {
        const first = this.#eventAt(binding.runId, 1);
        if (first?.kind === "run.queued") return { event: first, changed: null };
      }
      const eventId = dispatchEventId(input.eventId);
      const replay = this.#eventById(eventId);
      if (replay !== null) {
        if (replay.runId !== binding.runId || replay.kind !== input.kind) {
          throw new Error("Local dispatch event replay conflicts");
        }
        return { event: replay, changed: null };
      }
      if (binding.lastEventSequence >= 100) {
        throw new Error("Local run event sequence is exhausted");
      }
      const now = Date.now();
      const sequence = binding.lastEventSequence + 1;
      const semantic = publicRunEvent(input.kind);
      const displayText = input.displayText === undefined
        ? isTextKind(input.kind)
          ? semantic.summary
          : null
        : runDisplayTextSchema.parse(input.displayText);
      this.#database.query(`
        INSERT INTO local_run_public_events (
          workspace_id, run_id, sequence, event_id, event_kind,
          display_text, observed_at
        ) SELECT workspace_id, run_id, ?2, ?3, ?4, ?5, ?6
          FROM local_run_execution_bindings WHERE run_id = ?1
      `).run(
        input.runId,
        sequence,
        eventId,
        input.kind,
        displayText,
        now,
      );
      this.#database.query(`
        UPDATE local_run_execution_bindings
        SET last_event_sequence = ?2, updated_at = ?3
        WHERE run_id = ?1 AND last_event_sequence = ?4
      `).run(input.runId, sequence, now, binding.lastEventSequence);
      const run = this.#runState(input.runId);
      const nextPhase = taskDomain.nextRunPhase(
        run.phase,
        run.desiredState,
        input.kind,
      );
      if (nextPhase === null) {
        throw new Error(
          `Local run event ${input.kind} is invalid from ${run.phase}`,
        );
      }
      if (nextPhase !== null && nextPhase !== run.phase) {
        this.#database.query(`
          UPDATE local_task_runs
          SET phase = ?2,
            finished_at = CASE WHEN ?2 IN (
              'submitted', 'failed', 'cancelled', 'ambiguous'
            ) THEN ?3 ELSE finished_at END,
            recovery_state = CASE WHEN ?2 = 'ambiguous'
              THEN 'ambiguous' ELSE recovery_state END,
            updated_at = ?3
          WHERE run_id = ?1
        `).run(input.runId, nextPhase, now);
        if (
          nextPhase === "failed"
          || nextPhase === "cancelled"
          || nextPhase === "submitted"
        ) {
          this.#settleNonambiguousTerminal(binding, nextPhase, now);
        } else if (nextPhase === "ambiguous") {
          this.#database.query(`
            UPDATE local_queued_run_intents
            SET state = 'abandoned', updated_at = ?2
            WHERE run_id = ?1 AND state = 'started'
          `).run(input.runId, now);
          this.#database.query(`
            UPDATE local_due_work
            SET state = 'cancelled', claimed_boot_generation = NULL,
              claimed_at = NULL, updated_at = ?2
            WHERE work_kind = 'claim_expiry' AND entity_id = ?1
              AND state IN ('pending', 'claimed')
          `).run(binding.claimId, now);
        }
      }
      const publicPhase = nextPhase ?? run.phase;
      const projection = localRunTaskChange({
        affectsWorkspaceSummary:
          publicPhase === "failed" || publicPhase === "cancelled",
        changeKind: isTextKind(input.kind) && publicPhase === run.phase
          ? "run.display_changed"
          : "run.event_appended",
        projectionRevision: this.#recordRunChanged(
          run.workspaceId,
          run.taskId,
          run.runId,
          publicPhase,
          now,
          `event:${eventId}`,
        ),
        runId: run.runId,
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return {
        event: {
          runId: input.runId,
          sequence,
          eventId,
          kind: input.kind,
          summary: semantic.summary,
          ...(displayText === null
            ? {}
            : { displayText }
          ),
          createdAt: new Date(now).toISOString(),
        },
        changed: projection,
      };
    })();
  }

  latestPublicEvent(runId: string): PendingDispatchEvent | null {
    const value: unknown = this.#database.query(`
      SELECT workspace_id, run_id, sequence, event_id, event_kind,
        display_text, observed_at
      FROM local_run_public_events
      WHERE run_id = ?1 ORDER BY sequence DESC LIMIT 1
    `).get(runId);
    return value === null ? null : fromEvent(eventRowSchema.parse(value));
  }

  reconcileTerminalStage(runId: string): void {
    const binding = this.read(runId);
    if (binding === null) return;
    const run = this.#runState(runId);
    const expected = binding.stage === "failed"
      ? { phase: "failed" as const, kind: "run.failed" as const, ordinal: 9 }
      : binding.stage === "cancelled"
        ? { phase: "cancelled" as const, kind: "run.cancelled" as const, ordinal: 7 }
        : binding.stage === "lease_lost"
          ? { phase: "ambiguous" as const, kind: "run.lease_lost" as const, ordinal: 8 }
          : null;
    if (expected === null || run.phase === expected.phase) return;
    this.appendPublicEvent({
      runId,
      eventId: `${runId}:${String(expected.ordinal)}`,
      kind: expected.kind,
    });
  }

  /**
   * Publishes an interaction failure only after an exact provider stop has
   * been proved. Interaction expiry, binding failure, and the public terminal
   * event share one SQLite transaction, so callers can never release capacity
   * while an answered or pending interaction remains durable.
   */
  failAfterProvenInteractionStop(input: {
    readonly runId: string;
    readonly failureCode: string;
    readonly eventId: string;
    readonly now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    const result = this.#database.transaction(() => {
      const binding = this.read(input.runId);
      if (binding === null) return { committed: false, changed: null };
      const run = this.#runState(input.runId);
      if (binding.stage === "failed" && run.phase === "failed") {
        const expired = this.#expireUnsettledInteractions(input.runId, now);
        return {
          committed: true,
          changed: expired === 0
            ? null
            : localRunTaskChange({
                changeKind: "run.interaction_changed",
                projectionRevision: this.#recordRunChanged(
                  run.workspaceId,
                  run.taskId,
                  run.runId,
                  run.phase,
                  now,
                  `interaction-terminal-replay:${run.runId}`,
                ),
                runId: run.runId,
                taskId: run.taskId,
                workspaceId: run.workspaceId,
              }),
        };
      }
      if (!canTransitionDispatch(binding.stage, "failed")) {
        return { committed: false, changed: null };
      }
      this.#expireUnsettledInteractions(input.runId, now);
      this.transition({
        runId: input.runId,
        to: "failed",
        failureCode: input.failureCode,
      });
      const committed = this.#commitEvent({
        runId: input.runId,
        eventId: input.eventId,
        kind: "run.failed",
      });
      return { committed: true, changed: committed.changed };
    })();
    if (result.changed !== null) this.#onChanged(result.changed);
    return result.committed;
  }

  appendDisplayDelta(input: {
    readonly runId: string;
    readonly kind: PublicRunTextEventKind;
    readonly displayText: string;
  }): number {
    const displayText = boundedDisplayText(input.displayText);
    if (displayText === null) return 0;
    const binding = this.read(input.runId);
    if (
      binding === null
      || binding.lastEventSequence >= MAX_NONTERMINAL_RUN_EVENTS
      || this.displayEventCount(input.runId) >= MAX_RUN_DISPLAY_EVENTS
    ) return 0;
    const event = this.#appendEvent({
      runId: input.runId,
      eventId: `local-display:${input.runId}:${String(binding.lastEventSequence + 1)}:${input.kind}:${displayText}`,
      kind: input.kind,
      displayText,
    });
    if (event.displayText !== displayText) {
      throw new Error("Local display event was not persisted atomically");
    }
    return new TextEncoder().encode(displayText).byteLength;
  }

  materializeDisplayDraft(runId: string): PendingDispatchEvent | null {
    void runId;
    return null;
  }

  displayEventCount(runId: string): number {
    return this.#countEvents(runId, [
      "codex.reasoning_summary.delta",
      "codex.assistant_message.delta",
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
    ]);
  }

  toolActivityEventCount(runId: string): number {
    return this.#countEvents(runId, [
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
    ]);
  }

  hasOpenToolActivity(runId: string): boolean {
    const value = this.#database.query(`
      SELECT event_kind FROM local_run_public_events
      WHERE run_id = ?1 AND event_kind IN (
        'codex.tool_activity.started', 'codex.tool_activity.completed'
      )
      ORDER BY sequence DESC LIMIT 1
    `).get(runId) as { event_kind: string } | null;
    return value?.event_kind === "codex.tool_activity.started";
  }

  acknowledgeThrough(
    runId: string,
    throughSequence: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted === true) return Promise.resolve(false);
    const binding = this.read(runId);
    if (binding === null || binding.lastEventSequence < throughSequence) {
      return Promise.resolve(false);
    }
    return this.assertCurrent({
      claimFence: binding.claimFence,
      claimId: binding.claimId,
      runId: binding.runId,
      runtimeBootId: binding.runtimeBootId,
      runtimePublicId: binding.runtimePublicId,
    });
  }

  assertCurrent(input: {
    readonly claimFence: number;
    readonly claimId: string;
    readonly runId: string;
    readonly runtimeBootId: string;
    readonly runtimePublicId: string;
  }): Promise<boolean> {
    const value = this.#database.query(`
      SELECT 1 AS current
      FROM local_run_execution_bindings AS binding
      JOIN local_task_claims AS claim
        ON claim.workspace_id = binding.workspace_id
        AND claim.claim_id = binding.claim_id
      JOIN local_task_runs AS run
        ON run.workspace_id = binding.workspace_id
        AND run.run_id = binding.run_id
      JOIN local_runtime_boot_state AS boot ON boot.singleton = 1
      JOIN local_runtime_boot_history AS boot_history
        ON boot_history.boot_generation = boot.boot_generation
        AND boot_history.boot_id = boot.boot_id
      WHERE binding.run_id = ?1
        AND binding.claim_id = ?2
        AND binding.claim_fence = ?3
        AND binding.runtime_public_id = ?4
        AND binding.runtime_boot_id = ?5
        AND boot.boot_id = binding.runtime_boot_id
        AND claim.state = 'active'
        AND claim.fence = binding.claim_fence
        AND run.claim_id = binding.claim_id
        AND run.fence = binding.claim_fence
        AND run.boot_generation = boot.boot_generation
        AND boot_history.stopped_at IS NULL
    `).get(
      input.runId,
      input.claimId,
      input.claimFence,
      input.runtimePublicId,
      input.runtimeBootId,
    );
    return Promise.resolve(value !== null);
  }

  capacityReservations(): readonly Readonly<{
    accountProfileId: string;
    runId: string;
  }>[] {
    const values = this.#database.query(`
      SELECT account_profile_id, run_id
      FROM local_run_execution_bindings
      WHERE capacity_released_at IS NULL
      ORDER BY created_at, run_id
    `).all() as readonly {
      account_profile_id: string;
      run_id: string;
    }[];
    return values.map((value) => ({
      accountProfileId: value.account_profile_id,
      runId: value.run_id,
    }));
  }

  releaseCapacity(runId: string, now = Date.now()): boolean {
    const outcome = this.#database.transaction(() => {
      const value: unknown = this.#database.query(`
        SELECT binding.stage, binding.capacity_released_at, run.phase,
          run.recovery_state, claim.state AS claim_state,
          EXISTS (
            SELECT 1 FROM local_run_interactions AS interaction
            WHERE interaction.workspace_id = binding.workspace_id
              AND interaction.run_id = binding.run_id
              AND interaction.state IN ('pending', 'answered')
          ) AS has_unsettled_interaction
        FROM local_run_execution_bindings AS binding
        JOIN local_task_runs AS run
          ON run.workspace_id = binding.workspace_id
          AND run.run_id = binding.run_id
        JOIN local_task_claims AS claim
          ON claim.workspace_id = binding.workspace_id
          AND claim.claim_id = binding.claim_id
        WHERE binding.run_id = ?1
      `).get(runId);
      const row = z.object({
        stage: bindingRowSchema.shape.stage,
        capacity_released_at: taskDomain.epochMsSchema.nullable(),
        phase: taskDomain.runPhaseSchema,
        recovery_state: z.enum([
          "none",
          "pending",
          "reconciling",
          "ambiguous",
          "recovered",
          "abandoned",
        ]).nullable(),
        claim_state: z.enum([
          "active",
          "released",
          "expired",
          "submitted",
          "replaced",
        ]),
        has_unsettled_interaction: z.number().int().min(0).max(1),
      }).strict().nullable().parse(value);
      if (row === null || row.has_unsettled_interaction === 1) {
        return { changed: false, released: false };
      }
      const durableTerminal =
        (row.stage === "completed" && row.phase === "submitted")
        || (row.stage === "failed" && row.phase === "failed")
        || (row.stage === "cancelled" && row.phase === "cancelled")
        || (row.stage === "lease_lost" && row.phase === "ambiguous")
        || (
          (row.phase === "submitted"
            || row.phase === "failed"
            || row.phase === "cancelled")
          && row.recovery_state === "recovered"
          && row.claim_state === "released"
        );
      if (!durableTerminal) return { changed: false, released: false };
      if (row.capacity_released_at !== null) {
        return { changed: false, released: true };
      }
      const released = this.#database.query(`
        UPDATE local_run_execution_bindings
        SET capacity_released_at = ?2, updated_at = ?2
        WHERE run_id = ?1 AND capacity_released_at IS NULL
      `).run(runId, now);
      return {
        changed: released.changes === 1,
        released: released.changes === 1,
      };
    })();
    if (outcome.changed) this.#onCapacityReleased(runId);
    return outcome.released;
  }

  runIdsForTaskNeedingStop(
    workspaceId: string,
    taskId: string,
  ): readonly string[] {
    const values = this.#database.query(`
      SELECT binding.run_id
      FROM local_run_execution_bindings AS binding
      JOIN local_task_runs AS run
        ON run.workspace_id = binding.workspace_id
        AND run.run_id = binding.run_id
      WHERE binding.workspace_id = ?1 AND binding.task_id = ?2
        AND run.desired_state = 'stop'
        AND run.phase = 'cancel_requested'
        AND binding.stage IN (
          'reserved', 'worktree_ready', 'thread_starting', 'thread_ready',
          'turn_starting', 'running', 'waiting'
        )
      ORDER BY binding.created_at, binding.run_id
    `).all(workspaceId, taskId) as readonly { run_id: string }[];
    return values.map(({ run_id }) => run_id);
  }

  markHumanResolved(runId: string, now = Date.now()): boolean {
    const result = this.#database.transaction(() => {
      let changed: LocalRunTaskChange | null = null;
      if (this.#hasHumanResolutionProof(runId)) {
        const run = this.#runState(runId);
        const expired = this.#expireUnsettledInteractions(runId, now);
        if (expired > 0) {
          changed = localRunTaskChange({
            changeKind: "run.interaction_changed",
            projectionRevision: this.#recordRunChanged(
              run.workspaceId,
              run.taskId,
              run.runId,
              run.phase,
              now,
              `human-resolution:${run.runId}:${String(now)}`,
            ),
            runId: run.runId,
            taskId: run.taskId,
            workspaceId: run.workspaceId,
          });
        }
      }
      return {
        changed,
        released: this.releaseCapacity(runId, now),
      };
    })();
    if (result.changed !== null) this.#onChanged(result.changed);
    return result.released;
  }

  assertTerminalLifecycleReady(runId: string): void {
    const binding = this.read(runId);
    if (binding === null) throw new Error("Local dispatch binding does not exist");
    if (this.#hasUnsettledInteraction(runId)) {
      throw new LocalCompletionBlockedByInteractionError();
    }
  }

  submitCompleted(runId: string, now = Date.now()): DispatchBinding {
    const result = this.#database.transaction(() => {
      const binding = this.read(runId);
      if (binding === null) throw new Error("Local dispatch binding does not exist");
      if (binding.stage === "completed") {
        return { binding, capacityReleased: false, changed: null };
      }
      if (binding.stage !== "running" && binding.stage !== "waiting") {
        throw new Error("Local dispatch is not eligible for completion");
      }
      if (this.#hasUnsettledInteraction(runId)) {
        throw new LocalCompletionBlockedByInteractionError();
      }
      const value: unknown = this.#database.query(`
        SELECT binding.workspace_id, binding.task_id, binding.claim_id,
          binding.claim_fence, binding.input_review_revision,
          task.revision AS task_revision,
          task.review_revision, task.status AS task_status,
          task.unresolved_blocker_count, task.cancelled_blocker_count,
          claim.agent_id, claim.state AS claim_state, claim.fence AS claim_fence
        FROM local_run_execution_bindings AS binding
        JOIN local_tasks AS task
          ON task.workspace_id = binding.workspace_id
          AND task.task_id = binding.task_id
        JOIN local_task_claims AS claim
          ON claim.workspace_id = binding.workspace_id
          AND claim.claim_id = binding.claim_id
        WHERE binding.run_id = ?1
      `).get(runId);
      const row = z.object({
        workspace_id: taskDomain.workspacePublicIdSchema,
        task_id: taskDomain.taskPublicIdSchema,
        claim_id: taskDomain.dispatchClaimIdSchema,
        claim_fence: taskDomain.positiveGenerationSchema,
        input_review_revision: taskDomain.revisionSchema,
        task_revision: taskDomain.revisionSchema,
        review_revision: taskDomain.revisionSchema,
        task_status: taskDomain.taskStatusSchema,
        unresolved_blocker_count: z.number().int().nonnegative(),
        cancelled_blocker_count: z.number().int().nonnegative(),
        agent_id: taskDomain.agentIdSchema,
        claim_state: z.enum(["active", "released", "expired", "submitted", "replaced"]),
      }).strict().parse(value);
      if (
        row.task_status !== "in_progress"
        || row.review_revision !== row.input_review_revision
        || row.unresolved_blocker_count + row.cancelled_blocker_count !== 0
        || row.claim_state !== "active"
        || row.claim_fence !== binding.claimFence
      ) {
        throw new Error("Local completion input or claim changed");
      }
      const submissionId = publicId("sub", `local-completion:${runId}`);
      this.#database.query(`
        INSERT INTO local_task_submissions (
          workspace_id, task_id, submission_id, submitted_by_json,
          review_revision, summary, evidence_json, status, submitted_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)
      `).run(
        row.workspace_id,
        row.task_id,
        submissionId,
        JSON.stringify({
          kind: "agent",
          id: row.agent_id,
          name: "Local Codex",
          status: "active",
        }),
        row.review_revision,
        "Completed by Codex and ready for human review.",
        JSON.stringify([{
          kind: "note",
          text: "The Codex turn completed successfully.",
        }]),
        now,
      );
      this.#database.query(`
        UPDATE local_task_claims
        SET state = 'submitted', ended_at = ?3, updated_at = ?3
        WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'active'
      `).run(row.workspace_id, row.claim_id, now);
      this.#database.query(`
        UPDATE local_tasks
        SET status = 'in_review', revision = revision + 1, updated_at = ?3
        WHERE workspace_id = ?1 AND task_id = ?2 AND status = 'in_progress'
      `).run(row.workspace_id, row.task_id, now);
      this.#database.query(`
        UPDATE local_task_runs
        SET phase = 'submitted', finished_at = ?2, updated_at = ?2
        WHERE run_id = ?1
      `).run(runId, now);
      this.#database.query(`
        UPDATE local_queued_run_intents
        SET state = 'terminal', updated_at = ?2
        WHERE run_id = ?1 AND state = 'started'
      `).run(runId, now);
      this.#database.query(`
        UPDATE local_due_work
        SET state = 'cancelled', claimed_boot_generation = NULL,
          claimed_at = NULL, updated_at = ?2
        WHERE work_kind = 'claim_expiry' AND entity_id = ?1
          AND state IN ('pending', 'claimed')
      `).run(row.claim_id, now);

      const eventId = dispatchEventId(`${runId}:6`);
      const sequence = binding.lastEventSequence + 1;
      this.#database.query(`
        INSERT INTO local_run_public_events (
          workspace_id, run_id, sequence, event_id, event_kind, observed_at
        ) VALUES (?1, ?2, ?3, ?4, 'run.submitted', ?5)
      `).run(row.workspace_id, runId, sequence, eventId, now);
      this.#database.query(`
        UPDATE local_run_execution_bindings
        SET stage = 'completed', last_event_sequence = ?2,
          capacity_released_at = ?3, updated_at = ?3
        WHERE run_id = ?1 AND stage IN ('running', 'waiting')
      `).run(runId, sequence, now);
      const projectionRevision = this.#recordSubmitted(
        row.workspace_id,
        row.task_id,
        runId,
        row.task_revision + 1,
        row.agent_id,
        now,
      );
      const updated = this.read(runId);
      if (updated === null) throw new Error("Completed local binding disappeared");
      return {
        binding: updated,
        capacityReleased: true,
        changed: localRunTaskChange({
          changeKind: "task.submitted",
          projectionRevision,
          runId,
          taskId: row.task_id,
          workspaceId: row.workspace_id,
        }),
      };
    })();
    if (result.capacityReleased) this.#onCapacityReleased(runId);
    if (result.changed !== null) this.#onChanged(result.changed);
    return result.binding;
  }

  bindWorkspaceLane(input: WorkspaceLaneIdentity): WorkspaceLaneIdentity {
    return this.#database.transaction(() => {
      const binding = this.read(input.runId);
      if (binding === null) throw new Error("Local lane has no execution binding");
      const value = z.object({
        lane_id: z.string().nullable(),
        base_sha: z.string().min(1),
        branch_name: z.string().nullable(),
        canonical_checkout_path: z.string().nullable(),
        lane_git_common_dir: z.string().nullable(),
        recovery_manifest_path: z.string().nullable(),
        repository_path: z.string().min(1),
        repository_git_common_dir: z.string().min(1),
      }).strict().parse(this.#database.query(`
        SELECT binding.lane_id, binding.base_sha, binding.branch_name,
          binding.canonical_checkout_path,
          binding.canonical_git_common_dir AS lane_git_common_dir,
          binding.recovery_manifest_path,
          repository.canonical_repository_path AS repository_path,
          repository.canonical_git_common_dir AS repository_git_common_dir
        FROM local_run_execution_bindings AS binding
        JOIN local_repositories AS repository
          ON repository.repository_id = binding.repository_id
        WHERE binding.run_id = ?1 AND repository.tombstoned_at IS NULL
      `).get(input.runId));
      if (
        value.repository_path !== input.canonicalRepositoryPath
        || value.repository_git_common_dir !== input.canonicalGitCommonDir
      ) {
        throw new Error("Local repository identity conflicts");
      }
      const values = [
        [value.lane_id, input.laneId],
        [value.base_sha, input.baseSha],
        [value.branch_name, input.branchName],
        [value.canonical_checkout_path, input.canonicalCheckoutPath],
        [value.lane_git_common_dir, input.canonicalGitCommonDir],
        [value.recovery_manifest_path, input.recoveryManifestPath],
      ] as const;
      if (values.some(([existing, expected]) =>
        existing !== null && existing !== expected)) {
        throw new Error("Local managed-worktree identity conflicts");
      }
      this.#database.query(`
        UPDATE local_run_execution_bindings
        SET lane_id = ?2, branch_name = ?3, canonical_checkout_path = ?4,
          canonical_git_common_dir = ?5, recovery_manifest_path = ?6,
          updated_at = ?7
        WHERE run_id = ?1
      `).run(
        input.runId,
        input.laneId,
        input.branchName,
        input.canonicalCheckoutPath,
        input.canonicalGitCommonDir,
        input.recoveryManifestPath,
        Date.now(),
      );
      return input;
    })();
  }

  authorizeWorkspaceLaneRecovery(
    input: WorkspaceLaneIdentity,
  ): WorkspaceLaneIdentity | null {
    const value: unknown = this.#database.query(`
      SELECT binding.lane_id, binding.base_sha, binding.branch_name,
        binding.canonical_checkout_path,
        binding.canonical_git_common_dir AS lane_git_common_dir,
        binding.recovery_manifest_path,
        repository.canonical_repository_path AS repository_path,
        repository.canonical_git_common_dir AS repository_git_common_dir
      FROM local_run_execution_bindings AS binding
      JOIN local_repositories AS repository
        ON repository.repository_id = binding.repository_id
      WHERE binding.run_id = ?1 AND repository.tombstoned_at IS NULL
        AND binding.lane_id IS NOT NULL
        AND binding.branch_name IS NOT NULL
        AND binding.canonical_checkout_path IS NOT NULL
        AND binding.canonical_git_common_dir IS NOT NULL
        AND binding.recovery_manifest_path IS NOT NULL
    `).get(input.runId);
    const parsed = z.object({
      lane_id: z.string().min(1),
      base_sha: z.string().min(1),
      branch_name: z.string().min(1),
      canonical_checkout_path: z.string().min(1),
      lane_git_common_dir: z.string().min(1),
      recovery_manifest_path: z.string().min(1),
      repository_path: z.string().min(1),
      repository_git_common_dir: z.string().min(1),
    }).strict().nullable().parse(value);
    if (parsed === null) return null;
    return {
      baseSha: parsed.base_sha,
      branchName: parsed.branch_name,
      canonicalCheckoutPath: parsed.canonical_checkout_path,
      canonicalGitCommonDir: parsed.lane_git_common_dir,
      canonicalRepositoryPath: parsed.repository_path,
      laneId: parsed.lane_id,
      recoveryManifestPath: parsed.recovery_manifest_path,
      runId: input.runId,
    };
  }

  markWorkspaceLaneReady(input: WorkspaceLaneIdentity): void {
    this.bindWorkspaceLane(input);
  }

  #candidateRow(workspaceId: string, runId: string): unknown {
    return this.#database.query(`
      SELECT local_task_runs.workspace_id, local_task_runs.run_id,
        local_task_runs.task_id, local_task_runs.repository_id,
        local_task_runs.phase, local_task_runs.desired_state,
        local_queued_run_intents.state AS intent_state,
        local_queued_run_intents.fence AS intent_fence,
        local_queued_run_intents.claimed_boot_generation,
        local_queued_run_intents.available_at,
        local_tasks.task_key, local_tasks.title,
        local_task_bodies.description,
        local_tasks.status AS task_status,
        local_tasks.revision AS task_revision,
        local_tasks.review_revision,
        local_tasks.unresolved_blocker_count,
        local_tasks.cancelled_blocker_count,
        local_builtin_executors.agent_id,
        local_builtin_executors.enabled AS executor_enabled,
        local_repositories.canonical_repository_path,
        local_repositories.canonical_git_common_dir,
        local_workspaces.authority_kind
      FROM local_task_runs
      JOIN local_queued_run_intents
        ON local_queued_run_intents.workspace_id = local_task_runs.workspace_id
        AND local_queued_run_intents.run_id = local_task_runs.run_id
      JOIN local_tasks
        ON local_tasks.workspace_id = local_task_runs.workspace_id
        AND local_tasks.task_id = local_task_runs.task_id
      JOIN local_task_bodies
        ON local_task_bodies.workspace_id = local_tasks.workspace_id
        AND local_task_bodies.task_id = local_tasks.task_id
      JOIN local_builtin_executors
        ON local_builtin_executors.workspace_id = local_task_runs.workspace_id
      JOIN local_repositories
        ON local_repositories.repository_id = local_task_runs.repository_id
      JOIN local_workspaces
        ON local_workspaces.workspace_id = local_task_runs.workspace_id
      WHERE local_task_runs.workspace_id = ?1 AND local_task_runs.run_id = ?2
        AND local_repositories.tombstoned_at IS NULL
    `).get(workspaceId, runId);
  }

  #currentBootGeneration(): number | null {
    const value = this.#database.query(`
      SELECT boot_generation FROM local_runtime_boot_state WHERE singleton = 1
    `).get() as { boot_generation: number } | null;
    return value?.boot_generation ?? null;
  }

  #recordRunChanged(
    workspaceId: string,
    taskId: string,
    runId: string,
    phase: taskDomain.RunPhase,
    now: number,
    seed: string,
  ): number {
    const workspace = this.#database.query(`
      SELECT revision, event_sequence FROM local_workspaces
      WHERE workspace_id = ?1
    `).get(workspaceId) as {
      revision: number;
      event_sequence: number;
    } | null;
    if (workspace === null) throw new Error("Local workspace disappeared");
    const revision = workspace.revision + 1;
    const sequence = workspace.event_sequence + 1;
    const operationId = publicId("op", `local-execution:${seed}`);
    const event = portableWorkspaceEventSchema.parse({
      id: publicId("wevt", `${operationId}:${String(sequence)}`),
      workspaceId,
      sequence,
      workspaceRevision: revision,
      operationId,
      commandKind: "run.reconcile",
      actor: { kind: "system", jobKind: "run_recovery" },
      recordedAt: now,
      kind: "run.changed",
      taskId,
      runId,
      phase,
    });
    const update = this.#database.query(`
      UPDATE local_workspaces
      SET revision = ?2, event_sequence = ?3, updated_at = ?4
      WHERE workspace_id = ?1 AND revision = ?5 AND event_sequence = ?6
    `).run(
      workspaceId,
      revision,
      sequence,
      now,
      workspace.revision,
      workspace.event_sequence,
    );
    if (update.changes !== 1) throw new Error("Local workspace revision changed");
    this.#database.query(`
      INSERT INTO local_workspace_events (
        workspace_id, sequence, event_id, workspace_revision, operation_id,
        event_kind, task_id, event_json, recorded_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).run(
      workspaceId,
      sequence,
      event.id,
      revision,
      operationId,
      event.kind,
      taskId,
      JSON.stringify(event),
      now,
    );
    return revision;
  }

  #recordSubmitted(
    workspaceId: string,
    taskId: string,
    runId: string,
    taskRevision: number,
    agentId: string,
    now: number,
  ): number {
    const workspace = this.#database.query(`
      SELECT revision, event_sequence FROM local_workspaces
      WHERE workspace_id = ?1
    `).get(workspaceId) as {
      revision: number;
      event_sequence: number;
    } | null;
    if (workspace === null) throw new Error("Local workspace disappeared");
    const revision = workspace.revision + 1;
    const firstSequence = workspace.event_sequence + 1;
    const submissionOperationId =
      publicId("op", `local-completion:${runId}`);
    const runOperationId =
      publicId("op", `local-completion-run:${runId}`);
    const actor = {
      kind: "agent" as const,
      agentId,
    };
    const events = [
      portableWorkspaceEventSchema.parse({
        id: publicId(
          "wevt",
          `${submissionOperationId}:${String(firstSequence)}`,
        ),
        workspaceId,
        sequence: firstSequence,
        workspaceRevision: revision,
        operationId: submissionOperationId,
        commandKind: "task.submit",
        actor,
        recordedAt: now,
        kind: "task.changed",
        taskId,
        taskRevision,
        eventType: "task.submitted",
      }),
      portableWorkspaceEventSchema.parse({
        id: publicId(
          "wevt",
          `${runOperationId}:${String(firstSequence + 1)}`,
        ),
        workspaceId,
        sequence: firstSequence + 1,
        workspaceRevision: revision,
        operationId: runOperationId,
        commandKind: "run.reconcile",
        actor: { kind: "system", jobKind: "run_recovery" },
        recordedAt: now,
        kind: "run.changed",
        taskId,
        runId,
        phase: "submitted",
      }),
    ];
    const update = this.#database.query(`
      UPDATE local_workspaces
      SET revision = ?2, event_sequence = ?3, updated_at = ?4
      WHERE workspace_id = ?1 AND revision = ?5 AND event_sequence = ?6
    `).run(
      workspaceId,
      revision,
      firstSequence + 1,
      now,
      workspace.revision,
      workspace.event_sequence,
    );
    if (update.changes !== 1) throw new Error("Local workspace revision changed");
    for (const event of events) {
      this.#database.query(`
        INSERT INTO local_workspace_events (
          workspace_id, sequence, event_id, workspace_revision, operation_id,
          event_kind, task_id, event_json, recorded_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `).run(
        workspaceId,
        event.sequence,
        event.id,
        revision,
        event.operationId,
        event.kind,
        taskId,
        JSON.stringify(event),
        now,
      );
    }
    return revision;
  }

  #runState(runId: string): {
    readonly desiredState: "run" | "stop";
    readonly phase: taskDomain.RunPhase;
    readonly runId: string;
    readonly taskId: string;
    readonly workspaceId: string;
  } {
    const value: unknown = this.#database.query(`
      SELECT workspace_id, run_id, task_id, phase, desired_state
      FROM local_task_runs WHERE run_id = ?1
    `).get(runId);
    const row = z.object({
      workspace_id: taskDomain.workspacePublicIdSchema,
      run_id: taskDomain.dispatchIdSchema,
      task_id: taskDomain.taskPublicIdSchema,
      phase: taskDomain.runPhaseSchema,
      desired_state: z.enum(["run", "stop"]),
    }).strict().parse(value);
    return {
      desiredState: row.desired_state,
      phase: row.phase,
      runId: row.run_id,
      taskId: row.task_id,
      workspaceId: row.workspace_id,
    };
  }

  #hasUnsettledInteraction(runId: string): boolean {
    return this.#database.query(`
      SELECT 1 AS present
      FROM local_run_interactions
      WHERE run_id = ?1 AND state IN ('pending', 'answered')
      LIMIT 1
    `).get(runId) !== null;
  }

  #expireUnsettledInteractions(runId: string, now: number): number {
    return this.#database.query(`
      UPDATE local_run_interactions
      SET state = 'expired', resolved_at = ?2
      WHERE run_id = ?1 AND state IN ('pending', 'answered')
    `).run(runId, now).changes;
  }

  #hasHumanResolutionProof(runId: string): boolean {
    return this.#database.query(`
      SELECT 1 AS present
      FROM local_run_execution_bindings AS binding
      JOIN local_task_runs AS run
        ON run.workspace_id = binding.workspace_id
        AND run.run_id = binding.run_id
      JOIN local_task_claims AS claim
        ON claim.workspace_id = binding.workspace_id
        AND claim.claim_id = binding.claim_id
      WHERE binding.run_id = ?1
        AND run.phase IN ('submitted', 'failed', 'cancelled')
        AND run.recovery_state = 'recovered'
        AND claim.state = 'released'
      LIMIT 1
    `).get(runId) !== null;
  }

  #settleNonambiguousTerminal(
    binding: DispatchBinding,
    phase: "failed" | "cancelled" | "submitted",
    now: number,
  ): void {
    this.#database.query(`
      UPDATE local_queued_run_intents
      SET state = CASE WHEN ?2 = 'submitted' THEN 'terminal' ELSE 'abandoned' END,
        updated_at = ?3
      WHERE run_id = ?1 AND state = 'started'
    `).run(binding.runId, phase, now);
    this.#database.query(`
      UPDATE local_task_claims
      SET state = CASE WHEN ?2 = 'submitted' THEN 'submitted' ELSE 'released' END,
        ended_at = ?3, updated_at = ?3
      WHERE claim_id = ?1 AND state = 'active'
    `).run(binding.claimId, phase, now);
    if (phase !== "submitted") {
      this.#database.query(`
        UPDATE local_tasks
        SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'open' END,
          revision = revision + 1,
          assignee_agent_id = CASE WHEN status = 'cancelled'
            THEN assignee_agent_id ELSE NULL END,
          updated_at = ?3
        WHERE task_id = ?1 AND workspace_id = (
          SELECT workspace_id FROM local_run_execution_bindings WHERE run_id = ?2
        ) AND status IN ('in_progress', 'cancelled')
      `).run(binding.taskId, binding.runId, now);
    }
    this.#database.query(`
      UPDATE local_due_work SET state = 'cancelled', updated_at = ?2
      WHERE work_kind = 'claim_expiry' AND entity_id = ?1
        AND state IN ('pending', 'claimed')
    `).run(binding.claimId, now);
  }

  #upsertClaimExpiry(input: {
    readonly claimId: string;
    readonly dueAt: number;
    readonly fence: number;
    readonly leaseGeneration: number;
    readonly now: number;
    readonly workspaceId: string;
  }): void {
    this.#database.query(`
      INSERT INTO local_due_work (
        due_work_id, workspace_id, work_kind, entity_id, due_at, not_before_at,
        expected_revision, expected_fence, state, created_at, updated_at
      ) VALUES (?1, ?2, 'claim_expiry', ?3, ?4, ?4, ?5, ?6, 'pending', ?7, ?7)
      ON CONFLICT(workspace_id, work_kind, entity_id) DO UPDATE SET
        due_at = excluded.due_at,
        not_before_at = excluded.not_before_at,
        expected_revision = excluded.expected_revision,
        expected_fence = excluded.expected_fence,
        state = 'pending',
        claimed_boot_generation = NULL,
        claimed_at = NULL,
        attempt_count = 0,
        last_error_code = NULL,
        work_generation = work_generation + 1,
        updated_at = excluded.updated_at
    `).run(
      opaqueId("due", `${input.workspaceId}:claim_expiry:${input.claimId}`),
      input.workspaceId,
      input.claimId,
      input.dueAt,
      input.leaseGeneration,
      input.fence,
      input.now,
    );
  }

  #eventAt(runId: string, sequence: number): PendingDispatchEvent | null {
    const value: unknown = this.#database.query(`
      SELECT workspace_id, run_id, sequence, event_id, event_kind,
        display_text, observed_at
      FROM local_run_public_events WHERE run_id = ?1 AND sequence = ?2
    `).get(runId, sequence);
    return value === null ? null : fromEvent(eventRowSchema.parse(value));
  }

  #eventById(eventId: string): PendingDispatchEvent | null {
    const value: unknown = this.#database.query(`
      SELECT workspace_id, run_id, sequence, event_id, event_kind,
        display_text, observed_at
      FROM local_run_public_events WHERE event_id = ?1
    `).get(eventId);
    return value === null ? null : fromEvent(eventRowSchema.parse(value));
  }

  #countEvents(runId: string, kinds: readonly PublicRunEventKind[]): number {
    const values = this.#database.query(`
      SELECT event_kind FROM local_run_public_events WHERE run_id = ?1
    `).all(runId) as readonly { event_kind: string }[];
    const allowed = new Set(kinds);
    return values.reduce(
      (count, value) => count + (allowed.has(value.event_kind as PublicRunEventKind) ? 1 : 0),
      0,
    );
  }
}

function fromBinding(row: z.infer<typeof bindingRowSchema>): DispatchBinding {
  return {
    accountProfileId: row.account_profile_id,
    baseSha: row.base_sha,
    branchName: row.branch_name,
    claimFence: row.claim_fence,
    claimId: row.claim_id,
    createdAt: new Date(row.created_at).toISOString(),
    failureCode: row.failure_code,
    inputReviewRevision: row.input_review_revision,
    laneId: row.lane_id,
    lastEventSequence: row.last_event_sequence,
    repositoryPublicId: row.repository_id,
    executionMode: row.execution_mode,
    runId: row.run_id,
    runtimeBootId: row.runtime_boot_id,
    runtimePublicId: row.runtime_public_id,
    stage: row.stage,
    taskId: row.task_id,
    taskKey: row.task_key,
    threadId: row.thread_id,
    turnId: row.turn_id,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function fromEvent(row: z.infer<typeof eventRowSchema>): PendingDispatchEvent {
  const semantic = publicRunEvent(row.event_kind);
  return {
    runId: row.run_id,
    sequence: row.sequence,
    eventId: row.event_id,
    kind: row.event_kind,
    summary: semantic.summary,
    ...(row.display_text === null ? {} : { displayText: row.display_text }),
    createdAt: new Date(row.observed_at).toISOString(),
  };
}

function sameReservation(
  binding: DispatchBinding,
  reservation: DispatchReservation,
): boolean {
  return binding.runId === reservation.runId
    && binding.taskId === reservation.taskId
    && binding.taskKey === reservation.taskKey
    && binding.claimId === reservation.claimId
    && binding.claimFence === reservation.claimFence
    && binding.inputReviewRevision === reservation.inputReviewRevision
    && binding.runtimePublicId === reservation.runtimePublicId
    && binding.runtimeBootId === reservation.runtimeBootId
    && binding.repositoryPublicId === reservation.repositoryPublicId;
}

function obsolete(
  reason: LocalTaskDueWorkStaleAuthority["reason"],
): LocalRunAdmissionResult {
  return { kind: "obsolete", authority: { kind: "stale", reason } };
}

function dispatchEventId(seed: string): string {
  return opaqueId("event", `local-execution-event:${seed}`);
}

function opaqueId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function publicId(prefix: string, seed: string): string {
  let value = BigInt(`0x${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`);
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (crockford[Number(value & 31n)] ?? "0") + locator;
    value >>= 5n;
  }
  return `${prefix}_${locator}`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Local execution deadline exceeds the safe clock range");
  }
  return value;
}

function isTextKind(kind: PublicRunEventKind): kind is PublicRunTextEventKind {
  return kind === "codex.reasoning_summary.delta"
    || kind === "codex.assistant_message.delta";
}

function boundedDisplayText(value: string): string | null {
  if (value.length === 0) return null;
  if (runDisplayTextSchema.safeParse(value).success) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > MAX_RUN_DISPLAY_TEXT_UTF8_BYTES) break;
    result += character;
    bytes += size;
  }
  return runDisplayTextSchema.safeParse(result).success ? result : null;
}
