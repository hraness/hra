import type { Database } from "bun:sqlite";
import {
  MAX_NONTERMINAL_RUN_EVENTS,
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
  MAX_RUN_REASONING_SUMMARY_EVENTS,
  runDisplayTextSchema,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { createHash } from "node:crypto";

import {
  canTransitionDispatch,
  dispatchStageSchema,
  publicRunEvent,
  publicRunEventKindSchema,
  publicRunTextEventKindSchema,
  type DispatchStage,
  type PublicRunEventKind,
  type PublicRunStatusEventKind,
  type PublicRunTextEventKind,
} from "../dispatch/model";
import type { WorkspaceLaneIdentity } from "../workspaces/workspace-broker";

const dispatchRowSchema = z.object({
  run_id: z.string(),
  task_id: z.string(),
  task_key: z.string().nullable(),
  claim_id: z.string(),
  claim_fence: z.number().int().positive(),
  input_review_revision: z.number().int().positive(),
  runtime_public_id: z.string(),
  runtime_boot_id: z.string(),
  repository_public_id: z.string(),
  execution_mode: z.enum(["managed_worktree", "legacy_unbound"]),
  account_profile_id: z.string().nullable(),
  lane_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  turn_id: z.string().nullable(),
  stage: dispatchStageSchema,
  base_sha: z.string().nullable(),
  branch_name: z.string().nullable(),
  last_event_sequence: z.number().int().nonnegative(),
  failure_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

const outboxRowSchema = z.object({
  run_id: z.string(),
  sequence: z.number().int().positive(),
  event_id: z.string(),
  event_kind: publicRunEventKindSchema,
  public_summary: z.string(),
  payload_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  created_at: z.string(),
}).strict();

const displayDraftRowSchema = z.object({
  run_id: z.string(),
  event_kind: publicRunTextEventKindSchema,
  display_text: runDisplayTextSchema,
  display_bytes: z.number().int().min(1).max(MAX_RUN_DISPLAY_TEXT_UTF8_BYTES),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

const workspaceLaneRowSchema = z.object({
  lane_id: z.string(),
  canonical_repository_path: z.string(),
  canonical_git_common_dir: z.string(),
  canonical_checkout_path: z.string(),
  base_sha: z.string(),
  branch_name: z.string(),
  recovery_manifest_path: z.string(),
}).strict();

export interface DispatchReservation {
  readonly runId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly claimId: string;
  readonly claimFence: number;
  readonly inputReviewRevision: number;
  readonly runtimePublicId: string;
  readonly runtimeBootId: string;
  readonly repositoryPublicId: string;
}

export interface DispatchBinding extends DispatchReservation {
  readonly executionMode: "managed_worktree" | "legacy_unbound";
  readonly accountProfileId: string | null;
  readonly laneId: string | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly stage: DispatchStage;
  readonly baseSha: string | null;
  readonly branchName: string | null;
  readonly lastEventSequence: number;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PendingDispatchEvent {
  readonly runId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly kind: PublicRunEventKind;
  readonly summary: string;
  readonly displayText?: string;
  readonly createdAt: string;
}

export interface LocalRepositoryBinding {
  readonly repositoryPublicId: string;
  readonly projectId: string;
  readonly canonicalRepositoryPath: string;
  readonly canonicalGitCommonDir: string;
}

export class DispatchReservationConflict extends Error {
  constructor() {
    super("Dispatch run was already reserved with another claim or runtime tuple");
    this.name = "DispatchReservationConflict";
  }
}

export class DispatchTransitionConflict extends Error {
  constructor(from: DispatchStage, to: DispatchStage) {
    super(`Dispatch cannot transition from ${from} to ${to}`);
    this.name = "DispatchTransitionConflict";
  }
}

export class WorkspaceLaneIdentityConflict extends Error {
  constructor() {
    super("Managed-worktree identity conflicts with durable local state");
    this.name = "WorkspaceLaneIdentityConflict";
  }
}

export class DispatchStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  bindRepository(input: {
    readonly repositoryPublicId: string;
    readonly projectId: string;
    readonly canonicalRepositoryPath: string;
    readonly canonicalGitCommonDir: string;
    readonly now?: Date;
  }): void {
    const now = (input.now ?? new Date()).toISOString();
    this.#database.query(`
      INSERT INTO repository_bindings (
        repository_public_id, project_id, canonical_repository_path,
        canonical_git_common_dir, enabled, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
      ON CONFLICT(repository_public_id) DO UPDATE SET
        project_id = excluded.project_id,
        canonical_repository_path = excluded.canonical_repository_path,
        canonical_git_common_dir = excluded.canonical_git_common_dir,
        enabled = 1,
        updated_at = excluded.updated_at
    `).run(
      input.repositoryPublicId,
      input.projectId,
      input.canonicalRepositoryPath,
      input.canonicalGitCommonDir,
      now,
    );
  }

  repositoryBinding(repositoryPublicId: string): LocalRepositoryBinding | null {
    const value: unknown = this.#database.query(`
      SELECT repository_public_id, project_id, canonical_repository_path,
        canonical_git_common_dir
      FROM repository_bindings
      WHERE repository_public_id = ?1 AND enabled = 1
    `).get(repositoryPublicId);
    const parsed = z.object({
      repository_public_id: z.string(),
      project_id: z.string(),
      canonical_repository_path: z.string(),
      canonical_git_common_dir: z.string(),
    }).strict().nullable().parse(value);
    return parsed === null
      ? null
      : {
          repositoryPublicId: parsed.repository_public_id,
          projectId: parsed.project_id,
          canonicalRepositoryPath: parsed.canonical_repository_path,
          canonicalGitCommonDir: parsed.canonical_git_common_dir,
        };
  }

  bindWorkspaceLane(input: WorkspaceLaneIdentity): WorkspaceLaneIdentity {
    if (input.laneId !== input.runId) throw new WorkspaceLaneIdentityConflict();
    return this.#database.transaction(() => {
      const values: unknown[] = this.#database.query(`
        SELECT workspace_leases.lane_id, projects.canonical_repository_path,
          projects.canonical_git_common_dir, workspace_leases.canonical_checkout_path,
          workspace_leases.base_sha, workspace_leases.branch_name,
          workspace_leases.recovery_manifest_path
        FROM workspace_leases
        JOIN projects ON projects.project_id = workspace_leases.project_id
        WHERE workspace_leases.lane_id = ?1
          OR workspace_leases.canonical_checkout_path = ?2
        ORDER BY workspace_leases.lane_id
      `).all(input.laneId, input.canonicalCheckoutPath);
      if (values.length > 1) throw new WorkspaceLaneIdentityConflict();
      const existing = values[0];
      if (existing !== undefined) return fromWorkspaceLaneRow(workspaceLaneRowSchema.parse(existing));

      const projectValue: unknown = this.#database.query(`
        SELECT project_id FROM projects
        WHERE canonical_repository_path = ?1 AND canonical_git_common_dir = ?2
      `).get(input.canonicalRepositoryPath, input.canonicalGitCommonDir);
      const project = z.object({ project_id: z.string() }).strict().nullable().parse(projectValue);
      if (project === null) throw new WorkspaceLaneIdentityConflict();
      const now = new Date().toISOString();
      this.#database.query(`
        INSERT INTO workspace_leases (
          lane_id, project_id, canonical_checkout_path, mode, status, base_sha,
          branch_name, retention, recovery_manifest_path, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'managed_dispatch', 'provisioning', ?4, ?5,
          'preserve', ?6, ?7, ?7)
      `).run(
        input.laneId,
        project.project_id,
        input.canonicalCheckoutPath,
        input.baseSha,
        input.branchName,
        input.recoveryManifestPath,
        now,
      );
      const created = this.#workspaceLane(input.laneId);
      if (created === null) throw new Error("Managed-worktree identity was not persisted");
      return created;
    })();
  }

  authorizeWorkspaceLaneRecovery(
    input: WorkspaceLaneIdentity,
  ): WorkspaceLaneIdentity | null {
    if (input.laneId !== input.runId) return null;
    const value: unknown = this.#database.query(`
      SELECT workspace_leases.lane_id, projects.canonical_repository_path,
        projects.canonical_git_common_dir, workspace_leases.canonical_checkout_path,
        workspace_leases.base_sha, workspace_leases.branch_name,
        workspace_leases.recovery_manifest_path
      FROM workspace_leases
      JOIN projects ON projects.project_id = workspace_leases.project_id
      WHERE workspace_leases.lane_id = ?1
        AND workspace_leases.mode = 'managed_dispatch'
        AND workspace_leases.status IN ('provisioning', 'ready')
        AND workspace_leases.quarantine_reason IS NULL
        AND workspace_leases.quarantined_at IS NULL
    `).get(input.laneId);
    return value === null
      ? null
      : fromWorkspaceLaneRow(workspaceLaneRowSchema.parse(value));
  }

  markWorkspaceLaneReady(input: WorkspaceLaneIdentity): void {
    const observed = this.bindWorkspaceLane(input);
    if (!sameWorkspaceLaneIdentity(observed, input)) throw new WorkspaceLaneIdentityConflict();
    const result = this.#database.query(`
      UPDATE workspace_leases SET status = 'ready', updated_at = ?2
      WHERE lane_id = ?1 AND status IN ('provisioning', 'ready')
    `).run(input.laneId, new Date().toISOString());
    if (result.changes !== 1) throw new WorkspaceLaneIdentityConflict();
  }

  reserve(input: DispatchReservation & { readonly now?: Date }): DispatchBinding {
    return this.#database.transaction(() => {
      const existing = this.read(input.runId);
      if (existing !== null) {
        if (!sameReservation(existing, input)) throw new DispatchReservationConflict();
        return existing;
      }
      const now = (input.now ?? new Date()).toISOString();
      this.#database.query(`
        INSERT INTO dispatch_bindings (
          run_id, task_id, task_key, claim_id, claim_fence, input_review_revision,
          runtime_public_id, runtime_boot_id, repository_public_id, execution_mode,
          stage, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'managed_worktree',
          'reserved', ?10, ?10
        )
      `).run(
        input.runId,
        input.taskId,
        input.taskKey,
        input.claimId,
        input.claimFence,
        input.inputReviewRevision,
        input.runtimePublicId,
        input.runtimeBootId,
        input.repositoryPublicId,
        now,
      );
      const reserved = this.read(input.runId);
      if (reserved === null) throw new Error("Dispatch reservation was not persisted");
      return reserved;
    })();
  }

  read(runId: string): DispatchBinding | null {
    const row: unknown = this.#database.query(`
      SELECT run_id, task_id, claim_id, claim_fence, input_review_revision, runtime_public_id,
        task_key, runtime_boot_id, repository_public_id, execution_mode,
        account_profile_id, lane_id, thread_id, turn_id, stage, base_sha,
        branch_name, last_event_sequence, failure_code, created_at, updated_at
      FROM dispatch_bindings WHERE run_id = ?1
    `).get(runId);
    return row === null ? null : fromDispatchRow(dispatchRowSchema.parse(row));
  }

  readByTurn(input: {
    readonly accountProfileId: string;
    readonly threadId: string;
    readonly turnId: string;
  }): DispatchBinding | null {
    const value: unknown = this.#database.query(`
      SELECT run_id FROM dispatch_bindings
      WHERE account_profile_id = ?1 AND thread_id = ?2 AND turn_id = ?3
    `).get(input.accountProfileId, input.threadId, input.turnId);
    const row = z.object({ run_id: z.string() }).strict().nullable().parse(value);
    return row === null ? null : this.read(row.run_id);
  }

  readTurnStartingByThread(input: {
    readonly accountProfileId: string;
    readonly threadId: string;
  }): DispatchBinding | null {
    const values: unknown[] = this.#database.query(`
      SELECT run_id FROM dispatch_bindings
      WHERE account_profile_id = ?1 AND thread_id = ?2 AND stage = 'turn_starting'
      ORDER BY updated_at DESC
      LIMIT 2
    `).all(input.accountProfileId, input.threadId);
    const rows = z.array(z.object({ run_id: z.string() }).strict()).max(2).parse(values);
    if (rows.length !== 1) return null;
    const row = rows[0];
    return row === undefined ? null : this.read(row.run_id);
  }

  dispatchCapacityReservations(): readonly Readonly<{
    accountProfileId: string;
    repositoryPublicId: string;
    runId: string;
  }>[] {
    const values: unknown[] = this.#database.query(`
      SELECT run_id, account_profile_id, repository_public_id
      FROM dispatch_bindings AS binding
      WHERE account_profile_id IS NOT NULL AND capacity_released_at IS NULL AND (
        stage IN (
          'worktree_ready', 'thread_starting', 'thread_ready',
          'turn_starting', 'running', 'waiting', 'ambiguous'
        ) OR (
          stage IN ('completed', 'failed', 'cancelled', 'lease_lost') AND EXISTS (
            SELECT 1 FROM dispatch_outbox AS outbox
            WHERE outbox.run_id = binding.run_id AND outbox.acknowledged_at IS NULL
          )
        )
      )
      ORDER BY created_at, run_id
    `).all();
    return z.array(z.object({
      run_id: z.string(),
      account_profile_id: z.string(),
      repository_public_id: z.string(),
    }).strict()).parse(values).map((row) => ({
      accountProfileId: row.account_profile_id,
      repositoryPublicId: row.repository_public_id,
      runId: row.run_id,
    }));
  }

  releaseDispatchCapacity(runId: string, now = new Date()): void {
    this.#database.query(`
      UPDATE dispatch_bindings
      SET capacity_released_at = ?2, updated_at = ?2
      WHERE run_id = ?1 AND capacity_released_at IS NULL
    `).run(runId, now.toISOString());
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
    readonly now?: Date;
  }): DispatchBinding {
    return this.#database.transaction(() => {
      const current = this.read(input.runId);
      if (current === null) throw new Error("Dispatch run is not reserved");
      if (!canTransitionDispatch(current.stage, input.to)) {
        throw new DispatchTransitionConflict(current.stage, input.to);
      }
      this.#database.query(`
        UPDATE dispatch_bindings SET
          stage = ?2,
          account_profile_id = COALESCE(?3, account_profile_id),
          lane_id = COALESCE(?4, lane_id),
          thread_id = COALESCE(?5, thread_id),
          turn_id = COALESCE(?6, turn_id),
          base_sha = COALESCE(?7, base_sha),
          branch_name = COALESCE(?8, branch_name),
          failure_code = COALESCE(?9, failure_code),
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
        (input.now ?? new Date()).toISOString(),
        current.stage,
      );
      const updated = this.read(input.runId);
      if (updated === null) throw new Error("Dispatch run disappeared during transition");
      return updated;
    })();
  }

  appendPublicEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunStatusEventKind;
    readonly now?: Date;
  }): PendingDispatchEvent {
    return this.#database.transaction(() => {
      this.#materializeDisplayDraft(input.runId);
      const semantic = publicRunEvent(input.kind);
      return this.#appendImmutableEvent({
        runId: input.runId,
        eventId: input.eventId,
        kind: semantic.kind,
        summary: semantic.summary,
        now: input.now ?? new Date(),
      });
    })();
  }

  /**
   * Durably coalesces an allowlisted provider delta. The draft is materialized
   * into an immutable sequence entry by the runner or before any later status
   * event, preserving order across crashes without producing one cloud event
   * per token.
   */
  appendDisplayDelta(input: {
    readonly runId: string;
    readonly kind: PublicRunTextEventKind;
    readonly displayText: string;
    readonly now?: Date;
  }): number {
    if (input.displayText.length === 0) return 0;
    const pieces = splitDisplayText(input.displayText);
    return this.#database.transaction(() => {
      let acceptedBytes = 0;
      for (const piece of pieces) {
        if (!this.#appendDisplayPiece(input.runId, input.kind, piece, input.now ?? new Date())) {
          break;
        }
        acceptedBytes += utf8Bytes(piece);
      }
      return acceptedBytes;
    })();
  }

  materializeDisplayDraft(runId: string): PendingDispatchEvent | null {
    return this.#database.transaction(() => this.#materializeDisplayDraft(runId))();
  }

  displayEventCount(runId: string): number {
    const value: unknown = this.#database.query(`
      SELECT COUNT(*) AS count FROM dispatch_outbox
      WHERE run_id = ?1 AND event_kind IN (
        'codex.reasoning_summary.delta',
        'codex.assistant_message.delta',
        'codex.tool_activity.started',
        'codex.tool_activity.completed'
      )
    `).get(runId);
    return z.object({ count: z.number().int().nonnegative() }).strict().parse(value).count;
  }

  reasoningSummaryEventCount(runId: string): number {
    return this.#eventKindCount(runId, ["codex.reasoning_summary.delta"]);
  }

  toolActivityEventCount(runId: string): number {
    return this.#eventKindCount(runId, [
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
    ]);
  }

  hasOpenToolActivity(runId: string): boolean {
    const value: unknown = this.#database.query(`
      SELECT event_kind FROM dispatch_outbox
      WHERE run_id = ?1 AND event_kind IN (
        'codex.tool_activity.started',
        'codex.tool_activity.completed'
      )
      ORDER BY sequence DESC
      LIMIT 1
    `).get(runId);
    const row = z.object({
      event_kind: z.enum([
        "codex.tool_activity.started",
        "codex.tool_activity.completed",
      ]),
    }).strict().nullable().parse(value);
    return row?.event_kind === "codex.tool_activity.started";
  }

  pendingEvents(limit = 25): readonly PendingDispatchEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new Error("Dispatch outbox batch limit must be between 1 and 25");
    }
    const values: unknown[] = this.#database.query(`
      SELECT run_id, sequence, event_id, event_kind, public_summary,
        payload_digest, created_at
      FROM dispatch_outbox
      WHERE acknowledged_at IS NULL
      ORDER BY created_at, run_id, sequence
      LIMIT ?1
    `).all(limit);
    return values.map((value) => fromOutboxRow(outboxRowSchema.parse(value)));
  }

  pendingEventsForRun(runId: string, limit = 25): readonly PendingDispatchEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new Error("Dispatch outbox batch limit must be between 1 and 25");
    }
    const values: unknown[] = this.#database.query(`
      SELECT run_id, sequence, event_id, event_kind, public_summary,
        payload_digest, created_at
      FROM dispatch_outbox
      WHERE run_id = ?1 AND acknowledged_at IS NULL
      ORDER BY sequence
      LIMIT ?2
    `).all(runId, limit);
    return values.map((value) => fromOutboxRow(outboxRowSchema.parse(value)));
  }

  latestPublicEvent(runId: string): PendingDispatchEvent | null {
    const value: unknown = this.#database.query(`
      SELECT run_id, sequence, event_id, event_kind, public_summary,
        payload_digest, created_at
      FROM dispatch_outbox
      WHERE run_id = ?1
      ORDER BY sequence DESC
      LIMIT 1
    `).get(runId);
    return value === null ? null : fromOutboxRow(outboxRowSchema.parse(value));
  }

  isAcknowledged(runId: string, throughSequence: number): boolean {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) {
      throw new Error("Dispatch acknowledgment sequence must be positive");
    }
    const pending: unknown = this.#database.query(`
      SELECT sequence FROM dispatch_outbox
      WHERE run_id = ?1 AND sequence <= ?2 AND acknowledged_at IS NULL
      ORDER BY sequence
      LIMIT 1
    `).get(runId, throughSequence);
    return pending === null;
  }

  acknowledge(runId: string, throughSequence: number, now = new Date()): number {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) {
      throw new Error("Dispatch acknowledgment sequence must be positive");
    }
    return this.#database.query(`
      UPDATE dispatch_outbox SET acknowledged_at = ?3
      WHERE run_id = ?1 AND sequence <= ?2 AND acknowledged_at IS NULL
    `).run(runId, throughSequence, now.toISOString()).changes;
  }

  #appendDisplayPiece(
    runId: string,
    kind: PublicRunTextEventKind,
    piece: string,
    now: Date,
  ): boolean {
    const validatedPiece = runDisplayTextSchema.parse(piece);
    const value: unknown = this.#database.query(`
      SELECT run_id, event_kind, display_text, display_bytes, created_at, updated_at
      FROM dispatch_display_drafts WHERE run_id = ?1
    `).get(runId);
    const draft = value === null ? null : displayDraftRowSchema.parse(value);
    if (draft !== null && draft.event_kind === kind) {
      const combined = `${draft.display_text}${validatedPiece}`;
      const parsed = runDisplayTextSchema.safeParse(combined);
      if (parsed.success) {
        const updatedAt = now.toISOString();
        this.#database.query(`
          UPDATE dispatch_display_drafts
          SET display_text = ?2, display_bytes = ?3, updated_at = ?4
          WHERE run_id = ?1
        `).run(runId, parsed.data, utf8Bytes(parsed.data), updatedAt);
        return true;
      }
    }
    if (draft !== null) this.#materializeDisplayDraft(runId);
    const binding = this.read(runId);
    if (
      binding === null ||
      binding.lastEventSequence >= MAX_NONTERMINAL_RUN_EVENTS ||
      this.displayEventCount(runId) >= MAX_RUN_DISPLAY_EVENTS ||
      (
        kind === "codex.reasoning_summary.delta" &&
        this.reasoningSummaryEventCount(runId) >= MAX_RUN_REASONING_SUMMARY_EVENTS
      )
    ) {
      return false;
    }
    const timestamp = now.toISOString();
    this.#database.query(`
      INSERT INTO dispatch_display_drafts (
        run_id, event_kind, display_text, display_bytes, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    `).run(runId, kind, validatedPiece, utf8Bytes(validatedPiece), timestamp);
    return true;
  }

  #materializeDisplayDraft(runId: string): PendingDispatchEvent | null {
    const value: unknown = this.#database.query(`
      SELECT run_id, event_kind, display_text, display_bytes, created_at, updated_at
      FROM dispatch_display_drafts WHERE run_id = ?1
    `).get(runId);
    if (value === null) return null;
    const draft = displayDraftRowSchema.parse(value);
    const binding = this.read(runId);
    if (
      binding === null ||
      binding.lastEventSequence >= MAX_NONTERMINAL_RUN_EVENTS ||
      this.displayEventCount(runId) >= MAX_RUN_DISPLAY_EVENTS ||
      (
        draft.event_kind === "codex.reasoning_summary.delta" &&
        this.reasoningSummaryEventCount(runId) >= MAX_RUN_REASONING_SUMMARY_EVENTS
      )
    ) {
      this.#database.query("DELETE FROM dispatch_display_drafts WHERE run_id = ?1").run(runId);
      return null;
    }
    const nextSequence = binding.lastEventSequence + 1;
    const event = this.#appendImmutableEvent({
      runId,
      eventId: displayEventId(runId, nextSequence, draft.event_kind, draft.display_text),
      kind: draft.event_kind,
      summary: draft.display_text,
      now: new Date(draft.created_at),
    });
    this.#database.query("DELETE FROM dispatch_display_drafts WHERE run_id = ?1").run(runId);
    return event;
  }

  #appendImmutableEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunEventKind;
    readonly summary: string;
    readonly now: Date;
  }): PendingDispatchEvent {
    const digest = eventDigest(input.eventId, input.kind, input.summary);
    const replayValue: unknown = this.#database.query(`
      SELECT run_id, sequence, event_id, event_kind, public_summary,
        payload_digest, created_at
      FROM dispatch_outbox WHERE event_id = ?1
    `).get(input.eventId);
    if (replayValue !== null) {
      const replay = outboxRowSchema.parse(replayValue);
      if (replay.run_id !== input.runId || replay.payload_digest !== digest) {
        throw new DispatchReservationConflict();
      }
      return fromOutboxRow(replay);
    }
    const binding = this.read(input.runId);
    if (binding === null) throw new Error("Dispatch run is not reserved");
    const sequence = binding.lastEventSequence + 1;
    const createdAt = input.now.toISOString();
    this.#database.query(`
      INSERT INTO dispatch_outbox (
        run_id, sequence, event_id, event_kind, public_summary,
        payload_digest, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run(
      input.runId,
      sequence,
      input.eventId,
      input.kind,
      input.summary,
      digest,
      createdAt,
    );
    const updated = this.#database.query(`
      UPDATE dispatch_bindings
      SET last_event_sequence = ?2, updated_at = ?3
      WHERE run_id = ?1 AND last_event_sequence = ?4
    `).run(input.runId, sequence, createdAt, binding.lastEventSequence);
    if (updated.changes !== 1) throw new Error("Dispatch event sequence changed concurrently");
    return {
      runId: input.runId,
      sequence,
      eventId: input.eventId,
      kind: input.kind,
      summary: input.summary,
      ...(publicRunTextEventKindSchema.safeParse(input.kind).success
        ? { displayText: runDisplayTextSchema.parse(input.summary) }
        : {}),
      createdAt,
    };
  }

  #eventKindCount(runId: string, kinds: readonly PublicRunEventKind[]): number {
    if (kinds.length === 0) return 0;
    const values: unknown[] = this.#database.query(`
      SELECT event_kind FROM dispatch_outbox WHERE run_id = ?1
    `).all(runId);
    const allowed = new Set(kinds);
    return z.array(z.object({ event_kind: publicRunEventKindSchema }).strict()).parse(values)
      .reduce((count, row) => count + (allowed.has(row.event_kind) ? 1 : 0), 0);
  }

  #workspaceLane(laneId: string): WorkspaceLaneIdentity | null {
    const value: unknown = this.#database.query(`
      SELECT workspace_leases.lane_id, projects.canonical_repository_path,
        projects.canonical_git_common_dir, workspace_leases.canonical_checkout_path,
        workspace_leases.base_sha, workspace_leases.branch_name,
        workspace_leases.recovery_manifest_path
      FROM workspace_leases
      JOIN projects ON projects.project_id = workspace_leases.project_id
      WHERE workspace_leases.lane_id = ?1
    `).get(laneId);
    return value === null ? null : fromWorkspaceLaneRow(workspaceLaneRowSchema.parse(value));
  }
}

function sameReservation(
  binding: DispatchBinding,
  reservation: DispatchReservation,
): boolean {
  return binding.runId === reservation.runId &&
    binding.taskId === reservation.taskId &&
    binding.taskKey === reservation.taskKey &&
    binding.claimId === reservation.claimId &&
    binding.claimFence === reservation.claimFence &&
    binding.inputReviewRevision === reservation.inputReviewRevision &&
    binding.runtimePublicId === reservation.runtimePublicId &&
    binding.runtimeBootId === reservation.runtimeBootId &&
    binding.repositoryPublicId === reservation.repositoryPublicId;
}

function fromDispatchRow(row: z.infer<typeof dispatchRowSchema>): DispatchBinding {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    taskKey: row.task_key ?? "",
    claimId: row.claim_id,
    claimFence: row.claim_fence,
    inputReviewRevision: row.input_review_revision,
    runtimePublicId: row.runtime_public_id,
    runtimeBootId: row.runtime_boot_id,
    repositoryPublicId: row.repository_public_id,
    executionMode: row.execution_mode,
    accountProfileId: row.account_profile_id,
    laneId: row.lane_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    stage: row.stage,
    baseSha: row.base_sha,
    branchName: row.branch_name,
    lastEventSequence: row.last_event_sequence,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromOutboxRow(row: z.infer<typeof outboxRowSchema>): PendingDispatchEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    eventId: row.event_id,
    kind: row.event_kind,
    summary: row.public_summary,
    ...(publicRunTextEventKindSchema.safeParse(row.event_kind).success
      ? { displayText: runDisplayTextSchema.parse(row.public_summary) }
      : {}),
    createdAt: row.created_at,
  };
}

function fromWorkspaceLaneRow(
  row: z.infer<typeof workspaceLaneRowSchema>,
): WorkspaceLaneIdentity {
  return {
    runId: row.lane_id,
    laneId: row.lane_id,
    canonicalRepositoryPath: row.canonical_repository_path,
    canonicalGitCommonDir: row.canonical_git_common_dir,
    canonicalCheckoutPath: row.canonical_checkout_path,
    baseSha: row.base_sha,
    branchName: row.branch_name,
    recoveryManifestPath: row.recovery_manifest_path,
  };
}

function sameWorkspaceLaneIdentity(
  observed: WorkspaceLaneIdentity,
  expected: WorkspaceLaneIdentity,
): boolean {
  return observed.runId === expected.runId &&
    observed.laneId === expected.laneId &&
    observed.canonicalRepositoryPath === expected.canonicalRepositoryPath &&
    observed.canonicalGitCommonDir === expected.canonicalGitCommonDir &&
    observed.canonicalCheckoutPath === expected.canonicalCheckoutPath &&
    observed.baseSha === expected.baseSha &&
    observed.branchName === expected.branchName &&
    observed.recoveryManifestPath === expected.recoveryManifestPath;
}

function eventDigest(eventId: string, kind: PublicRunEventKind, summary: string): string {
  return createHash("sha256").update(JSON.stringify({ eventId, kind, summary })).digest("hex");
}

function displayEventId(
  runId: string,
  sequence: number,
  kind: PublicRunTextEventKind,
  displayText: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ domain: "kitchen-display-v1", runId, sequence, kind, displayText }))
    .digest("hex");
  return `display_${digest.slice(0, 48)}`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function splitDisplayText(value: string): readonly string[] {
  const pieces: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const characterBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (bytes + characterBytes > MAX_RUN_DISPLAY_TEXT_UTF8_BYTES && current.length > 0) {
      pieces.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}
