import type { Database } from "bun:sqlite";
import { taskDomain } from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { createHash, randomUUID } from "node:crypto";

export const localDueWorkKindSchema = z.enum([
  "defer_wake",
  "queued_run",
  "claim_expiry",
  "run_recovery",
  "interaction_expiry",
  "repair",
]);
const bootRecoveryLimit = 32;
export type LocalDueWorkKind = z.infer<typeof localDueWorkKindSchema>;

const dueWorkRowSchema = z.object({
  due_work_id: z.string().min(1).max(128),
  workspace_id: taskDomain.workspacePublicIdSchema,
  work_kind: localDueWorkKindSchema,
  entity_id: z.string().min(1).max(256),
  due_at: taskDomain.epochMsSchema,
  not_before_at: taskDomain.epochMsSchema,
  expected_revision: taskDomain.positiveGenerationSchema.nullable(),
  expected_fence: taskDomain.positiveGenerationSchema.nullable(),
  state: z.enum(["pending", "claimed", "done", "cancelled"]),
  claimed_boot_generation: taskDomain.positiveGenerationSchema.nullable(),
  claimed_at: taskDomain.epochMsSchema.nullable(),
  attempt_count: z.number().int().nonnegative().safe(),
  work_generation: z.number().int().nonnegative().safe(),
  last_error_code: z.string().nullable(),
}).strict().refine(
  (row) => row.not_before_at >= row.due_at,
  "due-work retry time cannot precede its authority deadline",
);

const bootStateSchema = z.object({
  installation_id: taskDomain.runnerInstallationIdSchema,
  boot_generation: taskDomain.positiveGenerationSchema,
  boot_id: taskDomain.runnerBootIdSchema,
  started_at: taskDomain.epochMsSchema,
}).strict();

const queuedIntentRowSchema = z.object({
  workspace_id: taskDomain.workspacePublicIdSchema,
  run_id: taskDomain.dispatchIdSchema,
  task_id: taskDomain.taskPublicIdSchema,
  repository_id: taskDomain.repositoryIdSchema,
  state: z.enum(["queued", "claimed", "started", "terminal", "abandoned"]),
  fence: taskDomain.positiveGenerationSchema,
  claimed_boot_generation: taskDomain.positiveGenerationSchema.nullable(),
  available_at: taskDomain.epochMsSchema,
}).strict();

export interface LocalDueWork {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: LocalDueWorkKind;
  readonly entityId: string;
  readonly dueAt: number;
  readonly expectedRevision: number | null;
  readonly expectedFence: number | null;
  readonly attempt: number;
  readonly workGeneration: number;
  readonly claimedBootGeneration: number;
}

export interface LocalQueuedRunIntentClaim {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly fence: number;
  readonly bootGeneration: number;
}

export interface LocalQueuedRunRecoveryPage {
  readonly requeuedClaims: number;
  readonly scheduledRecoveries: number;
  readonly hasMore: boolean;
}

export class LocalBootFenceConflict extends Error {
  constructor() {
    super("Local runtime boot or durable fence is stale");
    this.name = "LocalBootFenceConflict";
  }
}

/**
 * Local execution must advance its fence on every gateway process start even
 * when the cloud runner deliberately reuses an unacknowledged heartbeat boot.
 */
export function createLocalRuntimeBootId(
  createUuid: () => string = randomUUID,
): string {
  return taskDomain.runnerBootIdSchema.parse(
    `boot_${createUuid().replaceAll("-", "").toLowerCase()}`,
  );
}

export class LocalDueWorkStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  beginBoot(inputValue: unknown): number {
    const input = z.object({
      installationId: taskDomain.runnerInstallationIdSchema,
      bootId: taskDomain.runnerBootIdSchema,
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    return this.#database.transaction(() => {
      const installation: unknown = this.#database.query(`
        SELECT installation_id FROM local_installations WHERE installation_id = ?1
      `).get(input.installationId);
      if (installation === null) throw new Error("Local installation is not registered");
      const current = this.currentBoot();
      if (current?.boot_id === input.bootId) return current.boot_generation;
      const generation = (current?.boot_generation ?? 0) + 1;
      if (current !== null) {
        this.#database.query(`
          UPDATE local_runtime_boot_history
          SET stopped_at = ?2, stop_reason = 'replaced'
          WHERE boot_generation = ?1 AND stopped_at IS NULL
        `).run(current.boot_generation, input.now);
      }
      this.#database.query(`
        INSERT INTO local_runtime_boot_history (
          boot_generation, boot_id, started_at
        ) VALUES (?1, ?2, ?3)
      `).run(generation, input.bootId, input.now);
      this.#database.query(`
        INSERT INTO local_runtime_boot_state (
          singleton, installation_id, boot_generation, boot_id, started_at, updated_at
        ) VALUES (1, ?1, ?2, ?3, ?4, ?4)
        ON CONFLICT(singleton) DO UPDATE SET
          installation_id = excluded.installation_id,
          boot_generation = excluded.boot_generation,
          boot_id = excluded.boot_id,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at
      `).run(input.installationId, generation, input.bootId, input.now);
      this.resetClaimsFromPreviousBoot(generation, input.now);
      this.recoverQueuedRunIntentsPage(
        generation,
        input.now,
        bootRecoveryLimit,
      );
      return generation;
    })();
  }

  currentBoot(): z.infer<typeof bootStateSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT installation_id, boot_generation, boot_id, started_at
      FROM local_runtime_boot_state WHERE singleton = 1
    `).get();
    return bootStateSchema.nullable().parse(value);
  }

  closeBoot(inputValue: unknown): void {
    const input = z.object({
      bootGeneration: taskDomain.positiveGenerationSchema,
      reason: z.enum(["clean", "recovered", "replaced"]).default("clean"),
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    this.#assertBoot(input.bootGeneration);
    const result = this.#database.query(`
      UPDATE local_runtime_boot_history
      SET stopped_at = ?2, stop_reason = ?3
      WHERE boot_generation = ?1 AND stopped_at IS NULL
    `).run(input.bootGeneration, input.now, input.reason);
    if (result.changes !== 1) throw new LocalBootFenceConflict();
  }

  enqueue(inputValue: unknown): void {
    const input = z.object({
      workspaceId: taskDomain.workspacePublicIdSchema,
      kind: localDueWorkKindSchema,
      entityId: z.string().min(1).max(256),
      dueAt: taskDomain.epochMsSchema,
      expectedRevision: taskDomain.positiveGenerationSchema.optional(),
      expectedFence: taskDomain.positiveGenerationSchema.optional(),
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    this.#database.query(`
      INSERT INTO local_due_work (
        due_work_id, workspace_id, work_kind, entity_id, due_at, not_before_at,
        expected_revision, expected_fence, state, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, 'pending', ?8, ?8)
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
      dueWorkId(input.workspaceId, input.kind, input.entityId),
      input.workspaceId,
      input.kind,
      input.entityId,
      input.dueAt,
      input.expectedRevision ?? null,
      input.expectedFence ?? null,
      input.now,
    );
  }

  claimDue(inputValue: unknown): readonly LocalDueWork[] {
    const input = z.object({
      bootGeneration: taskDomain.positiveGenerationSchema,
      now: taskDomain.epochMsSchema,
      limit: z.number().int().min(1).max(100),
      abandonedClaimAfterMs: z.number().int().min(1).max(60 * 60 * 1_000)
        .default(60_000),
    }).strict().parse(inputValue);
    this.#assertBoot(input.bootGeneration);
    return this.#database.transaction(() => {
      this.resetExpiredClaims(
        input.bootGeneration,
        input.now - input.abandonedClaimAfterMs,
        input.now,
      );
      this.recoverQueuedRunIntentsPage(
        input.bootGeneration,
        input.now,
        input.limit,
      );
      const values: unknown[] = this.#database.query(`
        SELECT due_work_id, workspace_id, work_kind, entity_id, due_at,
          not_before_at,
          expected_revision, expected_fence, state, claimed_boot_generation,
          claimed_at, attempt_count, work_generation, last_error_code
        FROM local_due_work
        WHERE state = 'pending' AND not_before_at <= ?1
        ORDER BY
          CASE work_kind WHEN 'run_recovery' THEN 0 ELSE 1 END,
          not_before_at,
          due_work_id
        LIMIT ?2
      `).all(input.now, input.limit);
      const rows = values.map((value) => dueWorkRowSchema.parse(value));
      const claimed: LocalDueWork[] = [];
      for (const row of rows) {
        const result = this.#database.query(`
          UPDATE local_due_work
          SET state = 'claimed', claimed_boot_generation = ?2, claimed_at = ?3,
            attempt_count = attempt_count + 1,
            work_generation = work_generation + 1, updated_at = ?3
          WHERE due_work_id = ?1 AND state = 'pending' AND not_before_at <= ?3
            AND work_generation = ?4
        `).run(
          row.due_work_id,
          input.bootGeneration,
          input.now,
          row.work_generation,
        );
        if (result.changes !== 1) continue;
        claimed.push({
          id: row.due_work_id,
          workspaceId: row.workspace_id,
          kind: row.work_kind,
          entityId: row.entity_id,
          dueAt: row.due_at,
          expectedRevision: row.expected_revision,
          expectedFence: row.expected_fence,
          attempt: row.attempt_count + 1,
          workGeneration: row.work_generation + 1,
          claimedBootGeneration: input.bootGeneration,
        });
      }
      return claimed;
    })();
  }

  complete(inputValue: unknown): boolean {
    const input = this.#settlementInput(inputValue);
    this.#assertBoot(input.bootGeneration);
    const result = this.#database.query(`
      UPDATE local_due_work
      SET state = 'done', claimed_boot_generation = NULL, claimed_at = NULL,
        updated_at = ?3
      WHERE due_work_id = ?1 AND state = 'claimed'
        AND claimed_boot_generation = ?2
        AND work_generation = ?4
    `).run(
      input.id,
      input.bootGeneration,
      input.now,
      input.workGeneration,
    );
    return this.#settlementResult(result.changes, input);
  }

  retry(inputValue: unknown): boolean {
    const input = z.object({
      id: z.string().min(1).max(128),
      bootGeneration: taskDomain.positiveGenerationSchema,
      workGeneration: z.number().int().positive().safe(),
      nextDueAt: taskDomain.epochMsSchema,
      errorCode: z.string().min(1).max(128),
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    this.#assertBoot(input.bootGeneration);
    const result = this.#database.query(`
      UPDATE local_due_work
      SET state = 'pending', not_before_at = ?3, claimed_boot_generation = NULL,
        claimed_at = NULL, last_error_code = ?4, updated_at = ?5
      WHERE due_work_id = ?1 AND state = 'claimed'
        AND claimed_boot_generation = ?2
        AND work_generation = ?6
    `).run(
      input.id,
      input.bootGeneration,
      input.nextDueAt,
      input.errorCode,
      input.now,
      input.workGeneration,
    );
    return this.#settlementResult(result.changes, input);
  }

  release(inputValue: unknown): boolean {
    const input = this.#settlementInput(inputValue);
    this.#assertBoot(input.bootGeneration);
    const result = this.#database.query(`
      UPDATE local_due_work
      SET state = 'pending', claimed_boot_generation = NULL,
        claimed_at = NULL, updated_at = ?3
      WHERE due_work_id = ?1 AND state = 'claimed'
        AND claimed_boot_generation = ?2
        AND work_generation = ?4
    `).run(
      input.id,
      input.bootGeneration,
      input.now,
      input.workGeneration,
    );
    return this.#settlementResult(result.changes, input);
  }

  cancel(inputValue: unknown): boolean {
    const input = this.#settlementInput(inputValue);
    this.#assertBoot(input.bootGeneration);
    const result = this.#database.query(`
      UPDATE local_due_work
      SET state = 'cancelled', claimed_boot_generation = NULL,
        claimed_at = NULL, updated_at = ?3
      WHERE due_work_id = ?1 AND state = 'claimed'
        AND claimed_boot_generation = ?2
        AND work_generation = ?4
    `).run(
      input.id,
      input.bootGeneration,
      input.now,
      input.workGeneration,
    );
    return this.#settlementResult(result.changes, input);
  }

  resetClaimsFromPreviousBoot(bootGenerationValue: number, nowValue = Date.now()): number {
    const bootGeneration = taskDomain.positiveGenerationSchema.parse(bootGenerationValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const result = this.#database.query(`
      UPDATE local_due_work
      SET state = 'pending', claimed_boot_generation = NULL, claimed_at = NULL,
        work_generation = work_generation + 1, updated_at = ?2
      WHERE state = 'claimed'
        AND claimed_boot_generation <> ?1
    `).run(bootGeneration, now);
    return result.changes;
  }

  resetExpiredClaims(
    bootGenerationValue: number,
    claimedBeforeValue: number,
    nowValue = Date.now(),
  ): number {
    const bootGeneration = taskDomain.positiveGenerationSchema.parse(bootGenerationValue);
    const claimedBefore = taskDomain.epochMsSchema.parse(Math.max(0, claimedBeforeValue));
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const result = this.#database.query(`
      UPDATE local_due_work
      SET state = 'pending', claimed_boot_generation = NULL, claimed_at = NULL,
        work_generation = work_generation + 1, updated_at = ?3
      WHERE state = 'claimed' AND claimed_boot_generation = ?1
        AND claimed_at <= ?2
    `).run(bootGeneration, claimedBefore, now);
    return result.changes;
  }

  claimQueuedRunIntent(inputValue: unknown): LocalQueuedRunIntentClaim | null {
    const input = z.object({
      workspaceId: taskDomain.workspacePublicIdSchema,
      runId: taskDomain.dispatchIdSchema,
      bootGeneration: taskDomain.positiveGenerationSchema,
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    this.#assertBoot(input.bootGeneration);
    return this.#database.transaction(() => {
      const value: unknown = this.#database.query(`
        SELECT workspace_id, run_id, task_id, repository_id, state, fence,
          claimed_boot_generation, available_at
        FROM local_queued_run_intents
        WHERE workspace_id = ?1 AND run_id = ?2
      `).get(input.workspaceId, input.runId);
      const intent = queuedIntentRowSchema.nullable().parse(value);
      if (intent === null || intent.state !== "queued" || intent.available_at > input.now) {
        return null;
      }
      const result = this.#database.query(`
        UPDATE local_queued_run_intents
        SET state = 'claimed', claimed_boot_generation = ?3, updated_at = ?4
        WHERE workspace_id = ?1 AND run_id = ?2 AND state = 'queued'
      `).run(
        input.workspaceId,
        input.runId,
        input.bootGeneration,
        input.now,
      );
      if (result.changes !== 1) return null;
      this.#database.query(`
        INSERT INTO local_fences (
          workspace_id, entity_kind, entity_id, fence, boot_generation, updated_at
        ) VALUES (?1, 'run_intent', ?2, ?3, ?4, ?5)
        ON CONFLICT(workspace_id, entity_kind, entity_id) DO UPDATE SET
          fence = excluded.fence,
          boot_generation = excluded.boot_generation,
          updated_at = excluded.updated_at
      `).run(
        intent.workspace_id,
        intent.run_id,
        intent.fence,
        input.bootGeneration,
        input.now,
      );
      return {
        workspaceId: intent.workspace_id,
        runId: intent.run_id,
        taskId: intent.task_id,
        repositoryId: intent.repository_id,
        fence: intent.fence,
        bootGeneration: input.bootGeneration,
      };
    })();
  }

  markQueuedRunIntentStarted(inputValue: unknown): void {
    const input = z.object({
      workspaceId: taskDomain.workspacePublicIdSchema,
      runId: taskDomain.dispatchIdSchema,
      bootGeneration: taskDomain.positiveGenerationSchema,
      fence: taskDomain.positiveGenerationSchema,
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    this.#assertBoot(input.bootGeneration);
    this.#assertFence(
      input.workspaceId,
      "run_intent",
      input.runId,
      input.fence,
      input.bootGeneration,
    );
    const result = this.#database.query(`
      UPDATE local_queued_run_intents
      SET state = 'started', updated_at = ?5
      WHERE workspace_id = ?1 AND run_id = ?2 AND state = 'claimed'
        AND claimed_boot_generation = ?3 AND fence = ?4
    `).run(
      input.workspaceId,
      input.runId,
      input.bootGeneration,
      input.fence,
      input.now,
    );
    if (result.changes !== 1) throw new LocalBootFenceConflict();
  }

  finishQueuedRunIntent(inputValue: unknown): void {
    const input = z.object({
      workspaceId: taskDomain.workspacePublicIdSchema,
      runId: taskDomain.dispatchIdSchema,
      bootGeneration: taskDomain.positiveGenerationSchema,
      fence: taskDomain.positiveGenerationSchema,
      outcome: z.enum(["terminal", "abandoned"]),
      now: taskDomain.epochMsSchema,
    }).strict().parse(inputValue);
    this.#assertBoot(input.bootGeneration);
    this.#assertFence(
      input.workspaceId,
      "run_intent",
      input.runId,
      input.fence,
      input.bootGeneration,
    );
    const result = this.#database.query(`
      UPDATE local_queued_run_intents
      SET state = ?5, updated_at = ?6
      WHERE workspace_id = ?1 AND run_id = ?2
        AND claimed_boot_generation = ?3 AND fence = ?4
        AND state IN ('claimed', 'started')
    `).run(
      input.workspaceId,
      input.runId,
      input.bootGeneration,
      input.fence,
      input.outcome,
      input.now,
    );
    if (result.changes !== 1) throw new LocalBootFenceConflict();
  }

  recoverQueuedRunIntents(
    bootGenerationValue: number,
    nowValue = Date.now(),
    limitValue = 100,
  ): number {
    const page = this.recoverQueuedRunIntentsPage(
      bootGenerationValue,
      nowValue,
      limitValue,
    );
    return page.requeuedClaims + page.scheduledRecoveries;
  }

  recoverQueuedRunIntentsPage(
    bootGenerationValue: number,
    nowValue = Date.now(),
    limitValue = 100,
  ): LocalQueuedRunRecoveryPage {
    const bootGeneration = taskDomain.positiveGenerationSchema.parse(bootGenerationValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const limit = z.number().int().min(1).max(100).parse(limitValue);
    const values: unknown[] = this.#database.query(`
      SELECT workspace_id, run_id, task_id, state, fence
      FROM local_queued_run_intents
      WHERE claimed_boot_generation <> ?1
        AND (
          state = 'claimed'
          OR (
            state = 'started'
            AND NOT EXISTS (
              SELECT 1 FROM local_due_work
              WHERE local_due_work.workspace_id =
                  local_queued_run_intents.workspace_id
                AND local_due_work.work_kind = 'run_recovery'
                AND local_due_work.entity_id = local_queued_run_intents.run_id
                AND local_due_work.state IN ('pending', 'claimed')
            )
          )
        )
      ORDER BY updated_at, workspace_id, run_id
      LIMIT ?2
    `).all(bootGeneration, limit);
    const rows = values.map((value) =>
      z.object({
        workspace_id: taskDomain.workspacePublicIdSchema,
        run_id: taskDomain.dispatchIdSchema,
        task_id: taskDomain.taskPublicIdSchema,
        state: z.enum(["claimed", "started"]),
        fence: taskDomain.positiveGenerationSchema,
      }).strict().parse(value));
    let requeuedClaims = 0;
    let scheduledRecoveries = 0;
    for (const row of rows) {
      if (row.state === "claimed") {
        const result = this.#database.query(`
          UPDATE local_queued_run_intents
          SET state = 'queued', fence = fence + 1,
            claimed_boot_generation = NULL, updated_at = ?3
          WHERE workspace_id = ?1 AND run_id = ?2 AND state = 'claimed'
        `).run(row.workspace_id, row.run_id, now);
        requeuedClaims += result.changes;
      } else {
        this.enqueue({
          workspaceId: row.workspace_id,
          kind: "run_recovery",
          entityId: row.run_id,
          dueAt: now,
          expectedFence: row.fence,
          now,
        });
        scheduledRecoveries += 1;
      }
    }
    const moreValue: unknown = this.#database.query(`
      SELECT count(*) AS count
      FROM local_queued_run_intents
      WHERE claimed_boot_generation <> ?1
        AND (
          state = 'claimed'
          OR (
            state = 'started'
            AND NOT EXISTS (
              SELECT 1 FROM local_due_work
              WHERE local_due_work.workspace_id =
                  local_queued_run_intents.workspace_id
                AND local_due_work.work_kind = 'run_recovery'
                AND local_due_work.entity_id = local_queued_run_intents.run_id
                AND local_due_work.state IN ('pending', 'claimed')
            )
          )
        )
    `).get(bootGeneration);
    const more = z.object({ count: z.number().int().nonnegative() })
      .strict().parse(moreValue);
    return {
      requeuedClaims,
      scheduledRecoveries,
      hasMore: more.count > 0,
    };
  }

  #settlementInput(value: unknown) {
    return z.object({
      id: z.string().min(1).max(128),
      bootGeneration: taskDomain.positiveGenerationSchema,
      workGeneration: z.number().int().positive().safe(),
      now: taskDomain.epochMsSchema,
    }).strict().parse(value);
  }

  #settlementResult(
    changes: number,
    input: Readonly<{ id: string; workGeneration: number }>,
  ): boolean {
    if (changes === 1) return true;
    const value: unknown = this.#database.query(`
      SELECT state, work_generation
      FROM local_due_work
      WHERE due_work_id = ?1
    `).get(input.id);
    const row = z.object({
      state: z.enum(["pending", "claimed", "done", "cancelled"]),
      work_generation: z.number().int().nonnegative().safe(),
    }).strict().nullable().parse(value);
    if (
      row !== null &&
      (
        row.work_generation > input.workGeneration ||
        (
          row.work_generation === input.workGeneration &&
          (row.state === "done" || row.state === "cancelled")
        )
      )
    ) {
      return false;
    }
    throw new LocalBootFenceConflict();
  }

  #assertBoot(bootGeneration: number): void {
    const current = this.currentBoot();
    if (current === null || current.boot_generation !== bootGeneration) {
      throw new LocalBootFenceConflict();
    }
  }

  #assertFence(
    workspaceId: string,
    entityKind: string,
    entityId: string,
    fence: number,
    bootGeneration: number,
  ): void {
    const value: unknown = this.#database.query(`
      SELECT fence, boot_generation FROM local_fences
      WHERE workspace_id = ?1 AND entity_kind = ?2 AND entity_id = ?3
    `).get(workspaceId, entityKind, entityId);
    const row = z.object({
      fence: taskDomain.positiveGenerationSchema,
      boot_generation: taskDomain.positiveGenerationSchema,
    }).strict().nullable().parse(value);
    if (
      row === null ||
      row.fence !== fence ||
      row.boot_generation !== bootGeneration
    ) {
      throw new LocalBootFenceConflict();
    }
  }
}

function dueWorkId(workspaceId: string, kind: string, entityId: string): string {
  return `due_${createHash("sha256")
    .update(`${workspaceId}\u0000${kind}\u0000${entityId}`)
    .digest("hex")
    .slice(0, 32)}`;
}
