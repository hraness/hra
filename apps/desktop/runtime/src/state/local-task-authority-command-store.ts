import type { Database } from "bun:sqlite";
import {
  portableSystemCommandSchema,
  taskDomain,
  type PortableSystemCommand,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { isDeepStrictEqual } from "node:util";

import {
  LocalOperationConflict,
} from "./local-task-store";
import type { LocalTaskStore } from "./local-task-store";

const dueWorkKindSchema = z.enum([
  "defer_wake",
  "queued_run",
  "claim_expiry",
  "run_recovery",
  "interaction_expiry",
  "repair",
]);

const dueWorkSchema = z.object({
  id: z.string().min(1).max(128),
  workspaceId: taskDomain.workspacePublicIdSchema,
  kind: dueWorkKindSchema,
  entityId: z.string().min(1).max(256),
  dueAt: taskDomain.epochMsSchema,
  expectedRevision: taskDomain.positiveGenerationSchema.nullable(),
  expectedFence: taskDomain.positiveGenerationSchema.nullable(),
  attempt: z.number().int().nonnegative().safe(),
  workGeneration: z.number().int().positive().safe(),
  claimedBootGeneration: taskDomain.positiveGenerationSchema,
}).strict();

const currentAuthoritySchema = z.object({
  kind: z.literal("current"),
  bootGeneration: taskDomain.positiveGenerationSchema,
  deadlineCheckedAt: taskDomain.epochMsSchema,
  revision: taskDomain.positiveGenerationSchema.nullable(),
  fence: taskDomain.positiveGenerationSchema.nullable(),
}).strict();

const dueWorkRowSchema = z.object({
  due_work_id: z.string().min(1).max(128),
  workspace_id: taskDomain.workspacePublicIdSchema,
  work_kind: dueWorkKindSchema,
  entity_id: z.string().min(1).max(256),
  due_at: taskDomain.epochMsSchema,
  expected_revision: taskDomain.positiveGenerationSchema.nullable(),
  expected_fence: taskDomain.positiveGenerationSchema.nullable(),
  state: z.enum(["pending", "claimed", "done", "cancelled"]),
  claimed_boot_generation: taskDomain.positiveGenerationSchema.nullable(),
  work_generation: z.number().int().nonnegative().safe(),
}).strict();

const workspaceRowSchema = z.object({
  revision: taskDomain.revisionSchema,
  authority_kind: z.enum(["local", "promoting", "cloud"]),
  tombstoned_at: taskDomain.epochMsSchema.nullable(),
}).strict();

const taskRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  status: taskDomain.taskStatusSchema,
  available_at: taskDomain.epochMsSchema,
  revision: taskDomain.revisionSchema,
}).strict();

const runPhaseSchema = taskDomain.runPhaseSchema;

const bootRowSchema = z.object({
  boot_generation: taskDomain.positiveGenerationSchema,
}).strict();

export type LocalTaskAuthorityDueWork = z.infer<typeof dueWorkSchema>;
export type LocalTaskAuthorityCurrent = z.infer<typeof currentAuthoritySchema>;
export interface LocalTaskAuthorityStale {
  readonly kind: "stale";
  readonly reason: "boot" | "deadline" | "revision" | "fence" | "missing";
}

export type LocalTaskAuthorityPreparation =
  | Readonly<{
      kind: "current";
      authority: LocalTaskAuthorityCurrent;
      command: PortableSystemCommand | null;
    }>
  | Readonly<{
      kind: "stale";
      authority: LocalTaskAuthorityStale;
    }>;

export type LocalTaskAuthorityCommandOutcome =
  | Readonly<{
      kind: "committed";
      authority: LocalTaskAuthorityCurrent;
    }>
  | Readonly<{
      kind: "obsolete";
      authority: LocalTaskAuthorityStale;
    }>
  | Readonly<{
      kind: "retry";
      authority: LocalTaskAuthorityCurrent;
      errorCode: string;
    }>;

export interface LocalTaskAuthorityCommandStoreOptions {
  readonly database: Database;
  readonly tasks: LocalTaskStore;
  readonly onCommitted?: ((input: Readonly<{
    workspaceId: string;
    projectionRevision: number;
  }>) => void) | undefined;
}

class AtomicDueWorkSettlementError extends Error {}

/**
 * Revalidates due-work authority against SQLite and executes portable system
 * commands with their projection, events, receipt, and due-row settlement in
 * one outer transaction. Its public shape intentionally satisfies the task
 * scheduler's structural port without importing the scheduler into state.
 */
export class LocalTaskAuthorityCommandStore {
  readonly #database: Database;
  readonly #tasks: LocalTaskStore;
  readonly #onCommitted: NonNullable<
    LocalTaskAuthorityCommandStoreOptions["onCommitted"]
  >;

  constructor(options: LocalTaskAuthorityCommandStoreOptions) {
    this.#database = options.database;
    this.#tasks = options.tasks;
    this.#onCommitted = options.onCommitted ?? (() => undefined);
  }

  prepareDueWork(inputValue: Readonly<{
    work: LocalTaskAuthorityDueWork;
    bootGeneration: number;
    now: number;
    operationId: string;
  }>): LocalTaskAuthorityPreparation {
    const input = z.object({
      work: dueWorkSchema,
      bootGeneration: taskDomain.positiveGenerationSchema,
      now: taskDomain.epochMsSchema,
      operationId: taskDomain.operationIdSchema,
    }).strict().parse(inputValue);
    return this.#prepareDueWork(input);
  }

  executeSystemCommand(inputValue: Readonly<{
    work: LocalTaskAuthorityDueWork;
    command: PortableSystemCommand;
    authority: LocalTaskAuthorityCurrent;
    now: number;
  }>): LocalTaskAuthorityCommandOutcome {
    const input = z.object({
      work: dueWorkSchema,
      command: portableSystemCommandSchema,
      authority: currentAuthoritySchema,
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    let notification: Readonly<{
      workspaceId: string;
      projectionRevision: number;
    }> | null = null;
    let outcome: LocalTaskAuthorityCommandOutcome;
    try {
      outcome = this.#database.transaction((): LocalTaskAuthorityCommandOutcome => {
        const prepared = this.#prepareDueWork({
          work: input.work,
          bootGeneration: input.authority.bootGeneration,
          now: input.now,
          operationId: input.command.operationId,
        });
        if (prepared.kind === "stale") {
          return { kind: "obsolete", authority: prepared.authority };
        }
        if (
          prepared.command === null ||
          !isDeepStrictEqual(prepared.authority, input.authority) ||
          !isDeepStrictEqual(prepared.command, input.command)
        ) {
          return {
            kind: "retry",
            authority: prepared.authority,
            errorCode: "authority_command_mismatch",
          };
        }
        const priorReceipt = this.#database.query(`
          SELECT 1 AS present FROM local_operation_receipts
          WHERE operation_id = ?1
        `).get(input.command.operationId);
        let receipt;
        try {
          receipt = this.#tasks.execute(input.command, undefined, input.now);
        } catch (error: unknown) {
          if (error instanceof LocalOperationConflict) {
            return {
              kind: "retry",
              authority: prepared.authority,
              errorCode: "operation_conflict",
            };
          }
          throw error;
        }
        if (receipt.outcome === "rejected") {
          const reason = staleReasonForReceipt(receipt.code);
          return reason === null
            ? {
                kind: "retry",
                authority: prepared.authority,
                errorCode: "system_command_rejected",
              }
            : { kind: "obsolete", authority: stale(reason) };
        }
        const settled = this.#database.query(`
          UPDATE local_due_work
          SET state = 'done', claimed_boot_generation = NULL,
            claimed_at = NULL, updated_at = ?10
          WHERE due_work_id = ?1
            AND workspace_id = ?2
            AND work_kind = ?3
            AND entity_id = ?4
            AND due_at = ?5
            AND expected_revision IS ?6
            AND expected_fence IS ?7
            AND work_generation = ?11
            AND (
              (
                state = 'claimed'
                AND claimed_boot_generation = ?8
                AND claimed_at IS NOT NULL
              )
              OR (
                state = 'done'
                AND claimed_boot_generation IS NULL
                AND claimed_at IS NULL
              )
            )
            AND ?9 >= due_at
        `).run(
          input.work.id,
          input.work.workspaceId,
          input.work.kind,
          input.work.entityId,
          input.work.dueAt,
          input.work.expectedRevision,
          input.work.expectedFence,
          input.authority.bootGeneration,
          input.now,
          input.now,
          input.work.workGeneration,
        );
        if (settled.changes !== 1) throw new AtomicDueWorkSettlementError();
        if (priorReceipt === null) {
          notification = {
            workspaceId: receipt.workspaceId,
            projectionRevision: receipt.workspaceRevision,
          };
        }
        return { kind: "committed", authority: prepared.authority };
      })();
    } catch (error: unknown) {
      if (!(error instanceof AtomicDueWorkSettlementError)) throw error;
      return {
        kind: "retry",
        authority: input.authority,
        errorCode: "atomic_settlement_conflict",
      };
    }
    if (notification !== null) {
      try {
        this.#onCommitted(notification);
      } catch {
        // Projection invalidation is a post-commit hint and cannot undo authority.
      }
    }
    return outcome;
  }

  #prepareDueWork(input: Readonly<{
    work: LocalTaskAuthorityDueWork;
    bootGeneration: number;
    now: number;
    operationId: string;
  }>): LocalTaskAuthorityPreparation {
    const rowValue: unknown = this.#database.query(`
      SELECT due_work_id, workspace_id, work_kind, entity_id, due_at,
        expected_revision, expected_fence, state, claimed_boot_generation,
        work_generation
      FROM local_due_work
      WHERE due_work_id = ?1
    `).get(input.work.id);
    const row = dueWorkRowSchema.nullable().parse(rowValue);
    if (row === null) return stalePreparation("missing");
    if (
      row.workspace_id !== input.work.workspaceId ||
      row.work_kind !== input.work.kind ||
      row.entity_id !== input.work.entityId
    ) {
      return stalePreparation("missing");
    }
    if (row.due_at !== input.work.dueAt) {
      return stalePreparation("deadline");
    }
    if (row.expected_revision !== input.work.expectedRevision) {
      return stalePreparation("revision");
    }
    if (row.expected_fence !== input.work.expectedFence) {
      return stalePreparation("fence");
    }
    if (row.work_generation !== input.work.workGeneration) {
      return stalePreparation("boot");
    }
    const bootValue: unknown = this.#database.query(`
      SELECT boot_generation FROM local_runtime_boot_state WHERE singleton = 1
    `).get();
    const boot = bootRowSchema.nullable().parse(bootValue);
    if (
      boot?.boot_generation !== input.bootGeneration ||
      input.work.claimedBootGeneration !== input.bootGeneration ||
      row.claimed_boot_generation !== input.bootGeneration
    ) {
      return stalePreparation("boot");
    }
    if (row.state !== "claimed") return stalePreparation("missing");
    if (row.due_at > input.now) return stalePreparation("deadline");

    const workspaceValue: unknown = this.#database.query(`
      SELECT revision, authority_kind, tombstoned_at
      FROM local_workspaces WHERE workspace_id = ?1
    `).get(input.work.workspaceId);
    const workspace = workspaceRowSchema.nullable().parse(workspaceValue);
    if (
      workspace === null ||
      workspace.authority_kind !== "local" ||
      workspace.tombstoned_at !== null
    ) {
      return stalePreparation("missing");
    }
    const authority = currentAuthoritySchema.parse({
      kind: "current",
      bootGeneration: input.bootGeneration,
      deadlineCheckedAt: input.now,
      revision: input.work.expectedRevision,
      fence: input.work.expectedFence,
    });

    switch (input.work.kind) {
      case "defer_wake":
        return this.#prepareDeferred(input, authority);
      case "queued_run":
        return this.#prepareQueuedRun(input, authority);
      case "claim_expiry":
        return this.#prepareClaimExpiry(input, authority);
      case "run_recovery":
        return this.#prepareRunRecovery(input, authority);
      case "interaction_expiry":
        return this.#prepareInteractionExpiry(input, authority);
      case "repair":
        if (
          input.work.expectedFence !== null ||
          input.work.expectedRevision === null ||
          workspace.revision !== input.work.expectedRevision
        ) {
          return stalePreparation(
            input.work.expectedFence !== null ? "fence" : "revision",
          );
        }
        return currentPreparation(
          authority,
          portableSystemCommandSchema.parse({
            kind: "workspace.repair",
            operationId: input.operationId,
            workspaceId: input.work.workspaceId,
            expectedWorkspaceRevision: workspace.revision,
          }),
        );
    }
  }

  #prepareDeferred(
    input: Readonly<{
      work: LocalTaskAuthorityDueWork;
      now: number;
      operationId: string;
    }>,
    authority: LocalTaskAuthorityCurrent,
  ): LocalTaskAuthorityPreparation {
    if (input.work.expectedFence !== null) {
      return stalePreparation("fence");
    }
    const value: unknown = this.#database.query(`
      SELECT task_id, status, available_at, revision
      FROM local_tasks WHERE workspace_id = ?1 AND task_id = ?2
    `).get(input.work.workspaceId, input.work.entityId);
    const task = taskRowSchema.nullable().parse(value);
    if (task === null || task.status !== "open") {
      return stalePreparation("missing");
    }
    if (
      input.work.expectedRevision === null ||
      task.revision !== input.work.expectedRevision
    ) {
      return stalePreparation("revision");
    }
    if (task.available_at !== input.work.dueAt || task.available_at > input.now) {
      return stalePreparation("deadline");
    }
    return currentPreparation(
      authority,
      portableSystemCommandSchema.parse({
        kind: "defer.wake",
        operationId: input.operationId,
        workspaceId: input.work.workspaceId,
        taskId: task.task_id,
        expectedTaskRevision: task.revision,
        scheduledFor: task.available_at,
      }),
    );
  }

  #prepareQueuedRun(
    input: Readonly<{
      work: LocalTaskAuthorityDueWork;
      now: number;
    }>,
    authority: LocalTaskAuthorityCurrent,
  ): LocalTaskAuthorityPreparation {
    if (input.work.expectedFence !== null) {
      return stalePreparation("fence");
    }
    const value: unknown = this.#database.query(`
      SELECT local_task_runs.phase, local_queued_run_intents.state,
        local_queued_run_intents.available_at, local_tasks.revision
      FROM local_task_runs
      JOIN local_queued_run_intents
        ON local_queued_run_intents.workspace_id = local_task_runs.workspace_id
        AND local_queued_run_intents.run_id = local_task_runs.run_id
      JOIN local_tasks
        ON local_tasks.workspace_id = local_task_runs.workspace_id
        AND local_tasks.task_id = local_task_runs.task_id
      WHERE local_task_runs.workspace_id = ?1 AND local_task_runs.run_id = ?2
    `).get(input.work.workspaceId, input.work.entityId);
    const row = z.object({
      phase: runPhaseSchema,
      state: z.enum(["queued", "claimed", "started", "terminal", "abandoned"]),
      available_at: taskDomain.epochMsSchema,
      revision: taskDomain.revisionSchema,
    }).strict().nullable().parse(value);
    if (row === null || row.phase !== "queued" || row.state !== "queued") {
      return stalePreparation("missing");
    }
    if (
      input.work.expectedRevision === null ||
      row.revision !== input.work.expectedRevision
    ) {
      return stalePreparation("revision");
    }
    if (row.available_at !== input.work.dueAt || row.available_at > input.now) {
      return stalePreparation("deadline");
    }
    return currentPreparation(authority, null);
  }

  #prepareClaimExpiry(
    input: Readonly<{
      work: LocalTaskAuthorityDueWork;
      now: number;
      operationId: string;
    }>,
    authority: LocalTaskAuthorityCurrent,
  ): LocalTaskAuthorityPreparation {
    const value: unknown = this.#database.query(`
      SELECT local_task_claims.claim_id, local_task_claims.task_id,
        local_task_claims.fence, local_task_claims.lease_generation,
        local_task_claims.lease_until, local_task_claims.state
      FROM local_task_claims
      JOIN local_tasks
        ON local_tasks.workspace_id = local_task_claims.workspace_id
        AND local_tasks.task_id = local_task_claims.task_id
      WHERE local_task_claims.workspace_id = ?1
        AND local_task_claims.claim_id = ?2
    `).get(input.work.workspaceId, input.work.entityId);
    const row = z.object({
      claim_id: z.string().min(1).max(128),
      task_id: taskDomain.taskPublicIdSchema,
      fence: taskDomain.positiveGenerationSchema,
      lease_generation: taskDomain.positiveGenerationSchema,
      lease_until: taskDomain.epochMsSchema,
      state: z.enum(["active", "released", "expired", "submitted", "replaced"]),
    }).strict().nullable().parse(value);
    if (row === null || row.state !== "active") {
      return stalePreparation("missing");
    }
    if (input.work.expectedFence === null || row.fence !== input.work.expectedFence) {
      return stalePreparation("fence");
    }
    if (
      input.work.expectedRevision === null ||
      row.lease_generation !== input.work.expectedRevision
    ) {
      return stalePreparation("revision");
    }
    if (row.lease_until !== input.work.dueAt || row.lease_until > input.now) {
      return stalePreparation("deadline");
    }
    return currentPreparation(
      authority,
      portableSystemCommandSchema.parse({
        kind: "claim.expire",
        operationId: input.operationId,
        workspaceId: input.work.workspaceId,
        taskId: row.task_id,
        claimId: row.claim_id,
        fence: row.fence,
        leaseGeneration: row.lease_generation,
        expectedDeadline: row.lease_until,
      }),
    );
  }

  #prepareRunRecovery(
    input: Readonly<{
      work: LocalTaskAuthorityDueWork;
      bootGeneration: number;
      operationId: string;
    }>,
    authority: LocalTaskAuthorityCurrent,
  ): LocalTaskAuthorityPreparation {
    const value: unknown = this.#database.query(`
      SELECT local_task_runs.phase, local_task_runs.boot_generation,
        local_queued_run_intents.state, local_queued_run_intents.fence,
        local_queued_run_intents.claimed_boot_generation, local_tasks.revision
      FROM local_task_runs
      JOIN local_queued_run_intents
        ON local_queued_run_intents.workspace_id = local_task_runs.workspace_id
        AND local_queued_run_intents.run_id = local_task_runs.run_id
      JOIN local_tasks
        ON local_tasks.workspace_id = local_task_runs.workspace_id
        AND local_tasks.task_id = local_task_runs.task_id
      WHERE local_task_runs.workspace_id = ?1 AND local_task_runs.run_id = ?2
    `).get(input.work.workspaceId, input.work.entityId);
    const row = z.object({
      phase: runPhaseSchema,
      boot_generation: taskDomain.positiveGenerationSchema.nullable(),
      state: z.enum(["queued", "claimed", "started", "terminal", "abandoned"]),
      fence: taskDomain.positiveGenerationSchema,
      claimed_boot_generation: taskDomain.positiveGenerationSchema.nullable(),
      revision: taskDomain.revisionSchema,
    }).strict().nullable().parse(value);
    if (
      row === null ||
      taskDomain.isTerminalRunPhase(row.phase) ||
      row.state !== "started"
    ) {
      return stalePreparation("missing");
    }
    if (
      row.claimed_boot_generation === null ||
      row.claimed_boot_generation === input.bootGeneration ||
      row.boot_generation === input.bootGeneration
    ) {
      return stalePreparation("boot");
    }
    if (input.work.expectedFence === null || row.fence !== input.work.expectedFence) {
      return stalePreparation("fence");
    }
    if (
      input.work.expectedRevision !== null &&
      row.revision !== input.work.expectedRevision
    ) {
      return stalePreparation("revision");
    }
    return currentPreparation(
      authority,
      portableSystemCommandSchema.parse({
        kind: "run.reconcile",
        operationId: input.operationId,
        workspaceId: input.work.workspaceId,
        runId: input.work.entityId,
        bootGeneration: input.bootGeneration,
      }),
    );
  }

  #prepareInteractionExpiry(
    input: Readonly<{
      work: LocalTaskAuthorityDueWork;
      now: number;
      operationId: string;
    }>,
    authority: LocalTaskAuthorityCurrent,
  ): LocalTaskAuthorityPreparation {
    if (input.work.expectedFence !== null) {
      return stalePreparation("fence");
    }
    const value: unknown = this.#database.query(`
      SELECT local_run_interactions.run_id, local_run_interactions.request_json,
        local_run_interactions.state, local_tasks.revision
      FROM local_run_interactions
      JOIN local_task_runs
        ON local_task_runs.workspace_id = local_run_interactions.workspace_id
        AND local_task_runs.run_id = local_run_interactions.run_id
      JOIN local_tasks
        ON local_tasks.workspace_id = local_task_runs.workspace_id
        AND local_tasks.task_id = local_task_runs.task_id
      WHERE local_run_interactions.workspace_id = ?1
        AND local_run_interactions.interaction_id = ?2
    `).get(input.work.workspaceId, input.work.entityId);
    const row = z.object({
      run_id: taskDomain.dispatchIdSchema,
      request_json: z.string(),
      state: z.enum(["pending", "answered", "resolved", "expired"]),
      revision: taskDomain.revisionSchema,
    }).strict().nullable().parse(value);
    if (row === null || row.state !== "pending") {
      return stalePreparation("missing");
    }
    if (
      input.work.expectedRevision !== null &&
      row.revision !== input.work.expectedRevision
    ) {
      return stalePreparation("revision");
    }
    const request = taskDomain.portableRunInteractionRequestSchema.parse(
      JSON.parse(row.request_json) as unknown,
    );
    if (request.id !== input.work.entityId) {
      return stalePreparation("missing");
    }
    if (request.expiresAt !== input.work.dueAt || request.expiresAt > input.now) {
      return stalePreparation("deadline");
    }
    return currentPreparation(
      authority,
      portableSystemCommandSchema.parse({
        kind: "interaction.expire",
        operationId: input.operationId,
        workspaceId: input.work.workspaceId,
        runId: row.run_id,
        interactionId: input.work.entityId,
        expectedDeadline: request.expiresAt,
      }),
    );
  }
}

function stale(reason: LocalTaskAuthorityStale["reason"]): LocalTaskAuthorityStale {
  return { kind: "stale", reason };
}

function stalePreparation(
  reason: LocalTaskAuthorityStale["reason"],
): LocalTaskAuthorityPreparation {
  return { kind: "stale", authority: stale(reason) };
}

function currentPreparation(
  authority: LocalTaskAuthorityCurrent,
  command: PortableSystemCommand | null,
): LocalTaskAuthorityPreparation {
  return { kind: "current", authority, command };
}

function staleReasonForReceipt(
  code: "authority_mismatch" | "revision_conflict" | "invalid_state"
    | "graph_cycle" | "graph_limit" | "not_found" | "terminal" | "capacity_full"
    | "operation_conflict",
): LocalTaskAuthorityStale["reason"] | null {
  switch (code) {
    case "authority_mismatch":
    case "not_found":
    case "invalid_state":
    case "terminal":
      return "missing";
    case "revision_conflict":
      return "revision";
    case "graph_cycle":
    case "graph_limit":
    case "capacity_full":
    case "operation_conflict":
      return null;
  }
}
