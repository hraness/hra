import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";

import type { WorkspaceSetupAttentionObservation } from
  "../observation/attention-projector";
import type { WorkspaceLaneIdentity } from
  "../workspaces/workspace-broker";
import { workspaceSetupRejectionDigest } from
  "../workspaces/workspace-setup-recipe";

const timestampSchema = z.string().datetime({ offset: false, precision: 3 });
const laneIdSchema = z.string().min(8).max(128)
  .regex(/^[a-z0-9][a-z0-9_-]+$/u);
const requestIdSchema = z.string().regex(/^wssetup_[a-f0-9]{32}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const pathSchema = z.string().min(1).max(4_096)
  .refine((value) => !value.includes("\0"));
const executorInstanceIdSchema = z.string().min(16).max(128)
  .refine((value) => !value.includes("\0"));
const setupStateSchema = z.enum([
  "approval_required",
  "rejected",
  "prepared",
  "effect_started",
  "succeeded",
  "failed",
  "ambiguous",
]);
const failureCodeSchema = z.enum([
  "clean_replacement_required",
  "invalid_recipe",
  "runtime_unavailable",
  "exit_nonzero",
  "timeout",
  "output_limit",
  "containment_failed",
  "transcript_unavailable",
]);
const preEffectFailureCodeSchema = z.enum([
  "invalid_recipe",
  "runtime_unavailable",
]);
const transcriptSchema = z.string().max(262_144).refine(
  (value) => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 262_144,
);

const requestRowSchema = z.object({
  request_id: requestIdSchema,
  lane_id: laneIdSchema,
  project_id: z.string().min(1).max(128),
  base_sha: commitSchema,
  recipe_digest: digestSchema,
  executor_digest: digestSchema,
  pane_workspace_revision_origin: z.number().int().positive().safe(),
  state: setupStateSchema,
  setup_revision: z.number().int().positive().safe(),
  approval_binding_digest: digestSchema.nullable(),
  executor_instance_id: executorInstanceIdSchema.nullable(),
  failure_code: failureCodeSchema.nullable(),
  transcript: z.string().nullable(),
  transcript_bytes: z.number().int().nonnegative().max(262_144).nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  approved_at: timestampSchema.nullable(),
  effect_started_at: timestampSchema.nullable(),
  completed_at: timestampSchema.nullable(),
}).strict();

const bindingRowSchema = z.object({
  pane_id: z.string().min(1).max(128),
  project_id: z.string().min(1).max(128),
  expected_lane_id: laneIdSchema,
  workspace_lease_id: laneIdSchema,
  base_sha: commitSchema,
  canonical_repository_path: pathSchema,
  canonical_git_common_dir: pathSchema,
  canonical_checkout_path: pathSchema,
  branch_name: z.string().min(1).max(255),
  recovery_manifest_path: pathSchema,
  state: z.literal("provisioning"),
  lease_status: z.literal("provisioning"),
  workspace_state: z.literal("preparing"),
  workspace_revision: z.number().int().positive().safe(),
}).strict();

const legacyReadyBindingRowSchema = bindingRowSchema.extend({
  state: z.literal("ready"),
  lease_status: z.literal("ready"),
  workspace_state: z.literal("ready"),
}).strict();

const headRowSchema = requestRowSchema.extend({
  pane_id: z.string().min(1).max(128),
  canonical_checkout_path: pathSchema,
}).strict();

export type WorkspaceSetupState = z.infer<typeof setupStateSchema>;
export type WorkspaceSetupFailureCode = z.infer<typeof failureCodeSchema>;
export type WorkspaceSetupPreEffectFailureCode = z.infer<
  typeof preEffectFailureCodeSchema
>;

export type WorkspaceSetupRequest = Readonly<{
  requestId: string;
  laneId: string;
  projectId: string;
  paneId: string;
  baseSha: string;
  recipeDigest: string;
  executorDigest: string;
  state: WorkspaceSetupState;
  setupRevision: number;
  failureCode: WorkspaceSetupFailureCode | null;
  canonicalCheckoutPath: string;
}>;

export type WorkspaceSetupClaim = Readonly<{
  disposition: "claimed" | "in_progress" | "terminal";
  request: WorkspaceSetupRequest;
}>;

export type WorkspaceSetupApproval = Readonly<{
  changed: boolean;
  paneId: string;
  requestId: string;
  recipeDigest: string;
  setupRevision: number;
}>;

export class WorkspaceSetupStoreError extends Error {
  readonly code:
    | "conflict"
    | "corrupt_state"
    | "not_found"
    | "stale_revision"
    | "invalid_state";

  constructor(code: WorkspaceSetupStoreError["code"], message: string) {
    super(message);
    this.name = "WorkspaceSetupStoreError";
    this.code = code;
  }
}

/**
 * Content-free SQLite authority for repository-authored setup. Child output is
 * retained only as a bounded local diagnostic and never enters a projection.
 */
export class WorkspaceSetupStore {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  requestApproval(input: Readonly<{
    identity: WorkspaceLaneIdentity;
    recipeDigest: string;
    executorDigest: string;
  }>): WorkspaceSetupRequest {
    const identity = parseIdentity(input.identity);
    const recipeDigest = digestSchema.parse(input.recipeDigest);
    const executorDigest = digestSchema.parse(input.executorDigest);
    return this.#database.transaction(() => {
      const binding = this.#requireBinding(identity);
      const current = this.#headForLane(identity.laneId);
      const cleanReplacement = authoritativeCleanReplacement(current, identity);
      if (cleanReplacement !== null) {
        return projectRequest(cleanReplacement);
      }
      const successful = authoritativeSuccess(current, identity, recipeDigest);
      if (successful !== null) {
        return projectRequest(successful);
      }
      const exactRequestId = workspaceSetupRequestId({
        laneId: identity.laneId,
        baseSha: identity.baseSha,
        recipeDigest,
        executorDigest,
      });
      const exact = this.#request(exactRequestId);
      if (current !== null && current.request_id === exactRequestId) {
        return projectRequest(current);
      }
      if (exact !== null) {
        assertRequestIdentity(exact, binding, identity, recipeDigest, executorDigest);
        conflict("A historical workspace setup request cannot become authoritative again.");
      }
      if (current !== null && !isTerminal(current.state)) {
        conflict("Another workspace setup request still owns this lane.");
      }
      const at = timestampSchema.parse(this.#now().toISOString());
      if (exact === null) {
        this.#database.query(`
          INSERT INTO workspace_setup_requests (
            request_id, lane_id, project_id, base_sha, recipe_digest,
            executor_digest, pane_workspace_revision_origin,
            state, setup_revision, approval_binding_digest,
            executor_instance_id, failure_code, transcript, transcript_bytes,
            created_at, updated_at, approved_at, effect_started_at, completed_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'approval_required', 1,
            NULL, NULL, NULL, NULL, NULL, ?8, ?8, NULL, NULL, NULL
          )
        `).run(
          exactRequestId,
          identity.laneId,
          binding.project_id,
          identity.baseSha,
          recipeDigest,
          executorDigest,
          binding.workspace_revision,
          at,
        );
      }
      if (current === null) {
        this.#database.query(`
          INSERT INTO workspace_setup_lane_heads (lane_id, request_id, updated_at)
          VALUES (?1, ?2, ?3)
        `).run(identity.laneId, exactRequestId, at);
      } else {
        const changed = this.#database.query(`
          UPDATE workspace_setup_lane_heads
          SET request_id = ?2, updated_at = ?3
          WHERE lane_id = ?1 AND request_id = ?4
        `).run(identity.laneId, exactRequestId, at, current.request_id);
        if (changed.changes !== 1) conflict("Workspace setup head replacement raced.");
      }
      this.#touchPane(binding.pane_id, at);
      const created = this.#headForLane(identity.laneId);
      if (created === null || created.request_id !== exactRequestId) {
        corrupt("Workspace setup head disappeared after insertion.");
      }
      return projectRequest(created);
    })();
  }

  /** Records a setup rejection before approval or child-effect authority exists. */
  recordPreEffectFailure(input: Readonly<{
    identity: WorkspaceLaneIdentity;
    recipeDigest: string;
    executorDigest: string;
    failureCode: WorkspaceSetupPreEffectFailureCode;
  }>): WorkspaceSetupRequest {
    const identity = parseIdentity(input.identity);
    const recipeDigest = digestSchema.parse(input.recipeDigest);
    const executorDigest = digestSchema.parse(input.executorDigest);
    const failureCode = preEffectFailureCodeSchema.parse(input.failureCode);
    return this.#database.transaction(() => {
      const binding = this.#requireBinding(identity);
      const current = this.#headForLane(identity.laneId);
      const cleanReplacement = authoritativeCleanReplacement(current, identity);
      if (cleanReplacement !== null) {
        return projectRequest(cleanReplacement);
      }
      const successful = authoritativeSuccess(current, identity, recipeDigest);
      if (successful !== null) {
        return projectRequest(successful);
      }
      const requestId = workspaceSetupRequestId({
        laneId: identity.laneId,
        baseSha: identity.baseSha,
        recipeDigest,
        executorDigest,
      });
      if (current !== null && current.request_id === requestId) {
        if (current.state !== "rejected" || current.failure_code !== failureCode) {
          conflict("Workspace setup rejection identity changed.");
        }
        return projectRequest(current);
      }
      const historical = this.#request(requestId);
      if (historical !== null) {
        assertRequestIdentity(
          historical,
          binding,
          identity,
          recipeDigest,
          executorDigest,
        );
        conflict("A historical workspace setup rejection cannot become authoritative again.");
      }
      if (current !== null && !isTerminal(current.state)) {
        conflict("Another workspace setup request still owns this lane.");
      }
      const at = timestampSchema.parse(this.#now().toISOString());
      this.#database.query(`
        INSERT INTO workspace_setup_requests (
          request_id, lane_id, project_id, base_sha, recipe_digest,
          executor_digest, pane_workspace_revision_origin,
          state, setup_revision, approval_binding_digest,
          executor_instance_id, failure_code, transcript, transcript_bytes,
          created_at, updated_at, approved_at, effect_started_at, completed_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'rejected', 1,
          NULL, NULL, ?8, NULL, NULL, ?9, ?9, NULL, NULL, ?9
        )
      `).run(
        requestId,
        identity.laneId,
        binding.project_id,
        identity.baseSha,
        recipeDigest,
        executorDigest,
        binding.workspace_revision,
        failureCode,
        at,
      );
      if (current === null) {
        this.#database.query(`
          INSERT INTO workspace_setup_lane_heads (lane_id, request_id, updated_at)
          VALUES (?1, ?2, ?3)
        `).run(identity.laneId, requestId, at);
      } else {
        const changed = this.#database.query(`
          UPDATE workspace_setup_lane_heads
          SET request_id = ?2, updated_at = ?3
          WHERE lane_id = ?1 AND request_id = ?4
        `).run(identity.laneId, requestId, at, current.request_id);
        if (changed.changes !== 1) conflict("Workspace setup head replacement raced.");
      }
      this.#touchPane(binding.pane_id, at);
      const rejected = this.#headForLane(identity.laneId);
      if (rejected === null || rejected.request_id !== requestId) {
        corrupt("Workspace setup rejection disappeared after insertion.");
      }
      return projectRequest(rejected);
    })();
  }

  /**
   * Fences an already-ready managed lane created before setup authority
   * existed. The caller must first prove that its immutable base has a setup
   * recipe. Recipe-free legacy lanes never enter this state.
   */
  requireCleanReplacementForLegacyReadyLane(input: Readonly<{
    identity: WorkspaceLaneIdentity;
    recipeDigest: string;
    executorDigest: string;
  }>): WorkspaceSetupRequest | null {
    const identity = parseIdentity(input.identity);
    const recipeDigest = digestSchema.parse(input.recipeDigest);
    const executorDigest = digestSchema.parse(input.executorDigest);
    return this.#database.transaction(() => {
      const current = this.#headForLane(identity.laneId);
      const existing = authoritativeCleanReplacement(current, identity);
      if (existing !== null) return projectRequest(existing);
      if (current !== null) return null;

      const binding = this.#legacyReadyBinding(identity);
      if (binding === null) return null;
      const requestId = workspaceSetupRequestId({
        laneId: identity.laneId,
        baseSha: identity.baseSha,
        recipeDigest,
        executorDigest,
      });
      if (this.#request(requestId) !== null) {
        corrupt("Legacy workspace setup fence collided with historical authority.");
      }
      const at = timestampSchema.parse(this.#now().toISOString());
      this.#database.query(`
        INSERT INTO workspace_setup_requests (
          request_id, lane_id, project_id, base_sha, recipe_digest,
          executor_digest, pane_workspace_revision_origin,
          state, setup_revision, approval_binding_digest,
          executor_instance_id, failure_code, transcript, transcript_bytes,
          created_at, updated_at, approved_at, effect_started_at, completed_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'rejected', 1,
          NULL, NULL, 'clean_replacement_required', NULL, NULL,
          ?8, ?8, NULL, NULL, ?8
        )
      `).run(
        requestId,
        identity.laneId,
        binding.project_id,
        identity.baseSha,
        recipeDigest,
        executorDigest,
        binding.workspace_revision,
        at,
      );
      this.#database.query(`
        INSERT INTO workspace_setup_lane_heads (lane_id, request_id, updated_at)
        VALUES (?1, ?2, ?3)
      `).run(identity.laneId, requestId, at);
      const lease = this.#database.query(`
        UPDATE workspace_leases
        SET status = 'quarantined', quarantine_reason = 'provision_interrupted',
          quarantined_at = ?2, updated_at = ?2
        WHERE lane_id = ?1 AND status = 'ready'
          AND quarantine_reason IS NULL AND quarantined_at IS NULL
      `).run(identity.laneId, at);
      const durable = this.#database.query(`
        UPDATE chat_pane_workspace_bindings
        SET state = 'quarantined', recovery_reason = 'provision_interrupted',
          revision = revision + 1, updated_at = ?2
        WHERE expected_lane_id = ?1 AND workspace_lease_id = ?1
          AND state = 'ready' AND recovery_reason IS NULL
      `).run(identity.laneId, at);
      const pane = this.#database.query(`
        UPDATE chat_panes
        SET workspace_state = 'recovery_required',
          workspace_recovery_reason = 'provision_interrupted',
          workspace_revision = workspace_revision + 1,
          revision = revision + 1, updated_at = ?2
        WHERE pane_id = ?1 AND workspace_mode = 'managed_worktree'
          AND workspace_state = 'ready'
          AND workspace_recovery_reason IS NULL AND archived_at IS NULL
      `).run(binding.pane_id, at);
      if (lease.changes !== 1 || durable.changes !== 1 || pane.changes !== 1) {
        conflict("Legacy workspace setup replacement fence raced.");
      }
      const fenced = this.#headForLane(identity.laneId);
      if (fenced === null || fenced.request_id !== requestId) {
        corrupt("Legacy workspace setup replacement fence disappeared.");
      }
      return projectRequest(fenced);
    })();
  }

  /**
   * Removes the one pre-effect diagnostic that a later immutable Git proof has
   * disproved. No other rejected setup, historical row, or pane clock is
   * mutable through this reconciliation.
   */
  reconcileProvenAbsentAfterGitReadFailure(input: Readonly<{
    identity: WorkspaceLaneIdentity;
    executorDigest: string;
  }>): boolean {
    const identity = parseIdentity(input.identity);
    const executorDigest = digestSchema.parse(input.executorDigest);
    const rejectionDigest = workspaceSetupRejectionDigest(
      identity.baseSha,
      "git_read_failed",
    );
    return this.#database.transaction(() => {
      const binding = this.#requireBinding(identity);
      const current = this.#headForLane(identity.laneId);
      if (current === null) return false;
      const expectedRequestId = workspaceSetupRequestId({
        laneId: identity.laneId,
        baseSha: identity.baseSha,
        recipeDigest: rejectionDigest,
        executorDigest,
      });
      if (
        current.request_id !== expectedRequestId ||
        current.project_id !== binding.project_id ||
        current.base_sha !== identity.baseSha ||
        current.recipe_digest !== rejectionDigest ||
        current.executor_digest !== executorDigest ||
        current.state !== "rejected" || current.setup_revision !== 1 ||
        current.failure_code !== "runtime_unavailable" ||
        current.approval_binding_digest !== null ||
        current.executor_instance_id !== null || current.transcript !== null ||
        current.transcript_bytes !== null || current.approved_at !== null ||
        current.effect_started_at !== null || current.completed_at === null ||
        current.created_at !== current.updated_at ||
        current.updated_at !== current.completed_at ||
        current.pane_workspace_revision_origin + current.setup_revision !==
          binding.workspace_revision
      ) return false;
      const removedHead = this.#database.query(`
        DELETE FROM workspace_setup_lane_heads
        WHERE lane_id = ?1 AND request_id = ?2
      `).run(identity.laneId, current.request_id);
      if (removedHead.changes !== 1) {
        conflict("Workspace setup absence reconciliation raced.");
      }
      const removedRequest = this.#database.query(`
        DELETE FROM workspace_setup_requests
        WHERE request_id = ?1 AND lane_id = ?2 AND project_id = ?3
          AND base_sha = ?4 AND recipe_digest = ?5 AND executor_digest = ?6
          AND state = 'rejected' AND setup_revision = 1
          AND failure_code = 'runtime_unavailable'
          AND approval_binding_digest IS NULL
          AND executor_instance_id IS NULL
          AND transcript IS NULL AND transcript_bytes IS NULL
          AND approved_at IS NULL AND effect_started_at IS NULL
          AND completed_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM workspace_setup_lane_heads AS head
            WHERE head.request_id = workspace_setup_requests.request_id
          )
      `).run(
        current.request_id,
        identity.laneId,
        binding.project_id,
        identity.baseSha,
        rejectionDigest,
        executorDigest,
      );
      if (removedRequest.changes !== 1) {
        conflict("Workspace setup absence evidence changed during reconciliation.");
      }
      return true;
    })();
  }

  approve(input: Readonly<{
    requestId: string;
    recipeDigest: string;
    expectedSetupRevision: number;
  }>): WorkspaceSetupApproval {
    const requestId = requestIdSchema.parse(input.requestId);
    const recipeDigest = digestSchema.parse(input.recipeDigest);
    const expected = z.number().int().positive().safe().parse(
      input.expectedSetupRevision,
    );
    if (expected !== 1) stale("Workspace setup approval revision is stale.");
    return this.#database.transaction(() => {
      const current = this.#requireHeadRequest(requestId);
      if (current.recipe_digest !== recipeDigest) {
        conflict("Workspace setup approval identity changed.");
      }
      const approvalBinding = approvalBindingDigest(current);
      if (current.state !== "approval_required") {
        if (
          current.setup_revision > expected &&
          current.approval_binding_digest === approvalBinding
        ) {
          return approvalProjection(current, false);
        }
        invalidState("Workspace setup is no longer awaiting this approval.");
      }
      if (current.setup_revision !== expected) {
        stale("Workspace setup approval revision is stale.");
      }
      const at = timestampSchema.parse(this.#now().toISOString());
      const changed = this.#database.query(`
        UPDATE workspace_setup_requests
        SET state = 'prepared', setup_revision = 2,
          approval_binding_digest = ?2, approved_at = ?3, updated_at = ?3
        WHERE request_id = ?1 AND state = 'approval_required'
          AND setup_revision = 1
          AND setup_revision = ?4 AND recipe_digest = ?5
          AND approval_binding_digest IS NULL
      `).run(requestId, approvalBinding, at, expected, recipeDigest);
      if (changed.changes !== 1) stale("Workspace setup approval raced.");
      this.#touchPane(current.pane_id, at);
      return approvalProjection(this.#requireHeadRequest(requestId), true);
    })();
  }

  claimEffect(input: Readonly<{
    requestId: string;
    executorInstanceId: string;
  }>): WorkspaceSetupClaim {
    const requestId = requestIdSchema.parse(input.requestId);
    const executorInstanceId = executorInstanceIdSchema.parse(
      input.executorInstanceId,
    );
    return this.#database.transaction((): WorkspaceSetupClaim => {
      const current = this.#requireHeadRequest(requestId);
      if (current.state === "prepared") {
        const approvalBinding = approvalBindingDigest(current);
        if (current.approval_binding_digest !== approvalBinding) {
          corrupt("Workspace setup approval binding is corrupt.");
        }
        const at = timestampSchema.parse(this.#now().toISOString());
        const changed = this.#database.query(`
          UPDATE workspace_setup_requests
          SET state = 'effect_started', setup_revision = 3,
            executor_instance_id = ?2, effect_started_at = ?3, updated_at = ?3
          WHERE request_id = ?1 AND state = 'prepared' AND setup_revision = 2
            AND executor_instance_id IS NULL
            AND approval_binding_digest = ?4
        `).run(requestId, executorInstanceId, at, approvalBinding);
        if (changed.changes !== 1) conflict("Workspace setup effect claim raced.");
        this.#touchPane(current.pane_id, at);
        return {
          disposition: "claimed",
          request: projectRequest(this.#requireHeadRequest(requestId)),
        };
      }
      if (current.state === "effect_started") {
        if (current.executor_instance_id === executorInstanceId) {
          return { disposition: "in_progress", request: projectRequest(current) };
        }
        const at = timestampSchema.parse(this.#now().toISOString());
        const changed = this.#database.query(`
          UPDATE workspace_setup_requests
          SET state = 'ambiguous', setup_revision = 4,
            completed_at = ?2, updated_at = ?2
          WHERE request_id = ?1 AND state = 'effect_started'
            AND setup_revision = 3
            AND executor_instance_id = ?3
        `).run(requestId, at, current.executor_instance_id);
        if (changed.changes !== 1) conflict("Workspace setup recovery raced.");
        this.#touchPane(current.pane_id, at);
        return {
          disposition: "terminal",
          request: projectRequest(this.#requireHeadRequest(requestId)),
        };
      }
      return { disposition: "terminal", request: projectRequest(current) };
    })();
  }

  settleSucceeded(input: Readonly<{
    requestId: string;
    executorInstanceId: string;
    transcript: string;
  }>): WorkspaceSetupRequest {
    return this.#settle({ ...input, state: "succeeded", failureCode: null });
  }

  settleFailed(input: Readonly<{
    requestId: string;
    executorInstanceId: string;
    failureCode: WorkspaceSetupFailureCode;
    transcript: string;
  }>): WorkspaceSetupRequest {
    return this.#settle({ ...input, state: "failed" });
  }

  markEffectAmbiguous(input: Readonly<{
    requestId: string;
    executorInstanceId: string;
  }>): boolean {
    const requestId = requestIdSchema.parse(input.requestId);
    const executorInstanceId = executorInstanceIdSchema.parse(
      input.executorInstanceId,
    );
    return this.#database.transaction(() => {
      const current = this.#requireHeadRequest(requestId);
      if (current.state !== "effect_started") return false;
      if (current.executor_instance_id !== executorInstanceId) return false;
      const at = timestampSchema.parse(this.#now().toISOString());
      const changed = this.#database.query(`
        UPDATE workspace_setup_requests
        SET state = 'ambiguous', setup_revision = 4,
          completed_at = ?3, updated_at = ?3
        WHERE request_id = ?1 AND state = 'effect_started'
          AND setup_revision = 3
          AND executor_instance_id = ?2
      `).run(requestId, executorInstanceId, at);
      if (changed.changes === 1) this.#touchPane(current.pane_id, at);
      return changed.changes === 1;
    })();
  }

  recoverInterruptedEffects(executorInstanceIdValue: string): number {
    const executorInstanceId = executorInstanceIdSchema.parse(
      executorInstanceIdValue,
    );
    return this.#database.transaction(() => {
      const values: unknown[] = this.#database.query(`
        SELECT request.request_id
        FROM workspace_setup_requests AS request
        JOIN workspace_setup_lane_heads AS head
          ON head.lane_id = request.lane_id
         AND head.request_id = request.request_id
        JOIN workspace_leases AS lease
          ON lease.lane_id = request.lane_id
         AND lease.project_id = request.project_id
        WHERE request.state = 'effect_started'
          AND request.executor_instance_id != ?1
        ORDER BY request.request_id
      `).all(executorInstanceId);
      const allEffectCount = z.object({ count: z.number().int().nonnegative() })
        .strict().parse(this.#database.query(`
          SELECT COUNT(*) AS count FROM workspace_setup_requests
          WHERE state = 'effect_started'
        `).get()).count;
      if (allEffectCount !== values.length) {
        corrupt("An effect-started workspace setup is not its lane head.");
      }
      let recovered = 0;
      for (const value of values) {
        const requestId = z.object({ request_id: requestIdSchema }).strict()
          .parse(value).request_id;
        const current = this.#requireHeadRequest(requestId);
        const priorExecutor = current.executor_instance_id;
        if (priorExecutor === null) corrupt("Workspace setup effect has no executor.");
        const at = timestampSchema.parse(this.#now().toISOString());
        const changed = this.#database.query(`
          UPDATE workspace_setup_requests
          SET state = 'ambiguous', setup_revision = 4,
            completed_at = ?3, updated_at = ?3
          WHERE request_id = ?1 AND state = 'effect_started'
            AND setup_revision = 3
            AND executor_instance_id = ?2
        `).run(requestId, priorExecutor, at);
        if (changed.changes !== 1) conflict("Workspace setup recovery raced.");
        this.#touchPane(current.pane_id, at);
        recovered += 1;
      }
      return recovered;
    })();
  }

  headForLane(laneIdValue: string): WorkspaceSetupRequest | null {
    const laneId = laneIdSchema.parse(laneIdValue);
    const row = this.#headForLane(laneId);
    return row === null ? null : projectRequest(row);
  }

  allAttention(): readonly WorkspaceSetupAttentionObservation[] {
    const values: unknown[] = this.#database.query(`
      SELECT request.request_id, request.recipe_digest,
        request.setup_revision, request.state, request.failure_code,
        binding.pane_id
      FROM workspace_setup_lane_heads AS head
      JOIN workspace_setup_requests AS request
        ON request.request_id = head.request_id
       AND request.lane_id = head.lane_id
      JOIN workspace_leases AS lease
        ON lease.lane_id = request.lane_id
       AND lease.project_id = request.project_id
      JOIN chat_pane_workspace_bindings AS binding
        ON binding.expected_lane_id = head.lane_id
       AND binding.workspace_lease_id = head.lane_id
       AND binding.project_id = request.project_id
       AND binding.state != 'preserved'
      JOIN chat_panes AS pane ON pane.pane_id = binding.pane_id
      WHERE request.state IN (
          'approval_required', 'rejected', 'failed', 'ambiguous'
        )
        AND pane.archived_at IS NULL
      ORDER BY request.request_id
    `).all();
    const schema = z.object({
      request_id: requestIdSchema,
      recipe_digest: digestSchema,
      setup_revision: z.number().int().positive().safe(),
      state: z.enum([
        "approval_required",
        "rejected",
        "failed",
        "ambiguous",
      ]),
      failure_code: failureCodeSchema.nullable(),
      pane_id: z.string().min(1).max(128),
    }).strict();
    return values.map((value): WorkspaceSetupAttentionObservation => {
      const row = schema.parse(value);
      const identity = {
        paneId: row.pane_id,
        setupRequestId: row.request_id,
        recipeDigest: row.recipe_digest,
        setupRevision: row.setup_revision,
      };
      if (row.state === "approval_required") {
        return { ...identity, state: "approvalRequired" };
      }
      if (row.state === "ambiguous") return { ...identity, state: "ambiguous" };
      if (row.failure_code === null) {
        corrupt("Failed workspace setup is missing its outcome.");
      }
      return { ...identity, state: "failed", outcome: row.failure_code };
    });
  }

  readLocalDiagnostic(requestIdValue: string): string | null {
    const requestId = requestIdSchema.parse(requestIdValue);
    const value: unknown = this.#database.query(`
      SELECT transcript FROM workspace_setup_requests WHERE request_id = ?1
    `).get(requestId);
    if (value === null) notFound("Workspace setup request does not exist.");
    return z.object({ transcript: z.string().nullable() }).strict()
      .parse(value).transcript;
  }

  hasUnsettledWork(): boolean {
    const value: unknown = this.#database.query(`
      SELECT EXISTS(
        SELECT 1
        FROM workspace_setup_requests AS request
        JOIN workspace_setup_lane_heads AS head
          ON head.request_id = request.request_id
         AND head.lane_id = request.lane_id
        JOIN workspace_leases AS lease
          ON lease.lane_id = request.lane_id
         AND lease.project_id = request.project_id
        WHERE request.state != 'succeeded'
          AND EXISTS (
            SELECT 1 FROM chat_pane_workspace_bindings AS binding
            WHERE binding.expected_lane_id = request.lane_id
              AND binding.workspace_lease_id = request.lane_id
              AND binding.project_id = request.project_id
              AND binding.state != 'preserved'
          )
      ) AS present
    `).get();
    return z.object({ present: z.union([z.literal(0), z.literal(1)]) })
      .strict().parse(value).present === 1;
  }

  #settle(input: Readonly<{
    requestId: string;
    executorInstanceId: string;
    state: "succeeded" | "failed";
    failureCode: WorkspaceSetupFailureCode | null;
    transcript: string;
  }>): WorkspaceSetupRequest {
    const requestId = requestIdSchema.parse(input.requestId);
    const executorInstanceId = executorInstanceIdSchema.parse(
      input.executorInstanceId,
    );
    const transcript = transcriptSchema.parse(input.transcript);
    const failureCode = input.failureCode === null
      ? null
      : failureCodeSchema.parse(input.failureCode);
    if ((input.state === "succeeded") !== (failureCode === null)) {
      throw new Error("Workspace setup settlement outcome is inconsistent.");
    }
    return this.#database.transaction(() => {
      const current = this.#requireHeadRequest(requestId);
      if (
        current.state !== "effect_started" ||
        current.executor_instance_id !== executorInstanceId
      ) invalidState("Workspace setup effect is no longer settleable.");
      const at = timestampSchema.parse(this.#now().toISOString());
      const transcriptBytes = Buffer.byteLength(transcript, "utf8");
      const changed = this.#database.query(`
        UPDATE workspace_setup_requests
        SET state = ?3, setup_revision = 4,
          failure_code = ?4, transcript = ?5, transcript_bytes = ?6,
          completed_at = ?7, updated_at = ?7
        WHERE request_id = ?1 AND state = 'effect_started'
          AND setup_revision = 3
          AND executor_instance_id = ?2
      `).run(
        requestId,
        executorInstanceId,
        input.state,
        failureCode,
        transcript,
        transcriptBytes,
        at,
      );
      if (changed.changes !== 1) conflict("Workspace setup settlement raced.");
      this.#touchPane(current.pane_id, at);
      return projectRequest(this.#requireHeadRequest(requestId));
    })();
  }

  #legacyReadyBinding(
    identity: WorkspaceLaneIdentity,
  ): z.infer<typeof legacyReadyBindingRowSchema> | null {
    const values: unknown[] = this.#database.query(`
      SELECT binding.pane_id, binding.project_id,
        binding.expected_lane_id, binding.workspace_lease_id,
        binding.base_sha, binding.canonical_repository_path,
        binding.canonical_git_common_dir, binding.canonical_checkout_path,
        binding.branch_name, binding.recovery_manifest_path,
        binding.state, lease.status AS lease_status,
        pane.workspace_state, pane.workspace_revision
      FROM chat_pane_workspace_bindings AS binding
      JOIN workspace_leases AS lease
        ON lease.lane_id = binding.workspace_lease_id
       AND lease.project_id = binding.project_id
      JOIN chat_panes AS pane ON pane.pane_id = binding.pane_id
      WHERE binding.expected_lane_id = ?1
        AND binding.workspace_lease_id = ?1
        AND binding.state = 'ready' AND lease.status = 'ready'
        AND pane.workspace_mode = 'managed_worktree'
        AND pane.workspace_state = 'ready'
        AND pane.archived_at IS NULL
      ORDER BY binding.binding_id
      LIMIT 2
    `).all(identity.laneId);
    if (values.length > 1) {
      corrupt("Legacy workspace setup lane has multiple active bindings.");
    }
    const value = values[0];
    if (value === undefined) return null;
    const binding = legacyReadyBindingRowSchema.parse(value);
    assertBindingIdentity(binding, identity);
    return binding;
  }

  #requireBinding(identity: WorkspaceLaneIdentity): z.infer<typeof bindingRowSchema> {
    const values: unknown[] = this.#database.query(`
      SELECT binding.pane_id, binding.project_id,
        binding.expected_lane_id, binding.workspace_lease_id,
        binding.base_sha, binding.canonical_repository_path,
        binding.canonical_git_common_dir, binding.canonical_checkout_path,
        binding.branch_name, binding.recovery_manifest_path,
        binding.state, lease.status AS lease_status,
        pane.workspace_state, pane.workspace_revision
      FROM chat_pane_workspace_bindings AS binding
      JOIN workspace_leases AS lease
        ON lease.lane_id = binding.workspace_lease_id
       AND lease.project_id = binding.project_id
      JOIN chat_panes AS pane ON pane.pane_id = binding.pane_id
      WHERE binding.expected_lane_id = ?1
        AND binding.workspace_lease_id = ?1
        AND binding.state != 'preserved'
        AND pane.archived_at IS NULL
      ORDER BY binding.binding_id
      LIMIT 2
    `).all(identity.laneId);
    if (values.length !== 1) {
      if (values.length === 0) {
        conflict("Workspace setup has no active lane binding.");
      }
      corrupt("Workspace setup lane has multiple active bindings.");
    }
    const binding = bindingRowSchema.parse(values[0]);
    assertBindingIdentity(binding, identity);
    return binding;
  }

  #headForLane(laneId: string): z.infer<typeof headRowSchema> | null {
    const values: unknown[] = this.#database.query(`
      SELECT request.request_id, request.lane_id, request.project_id,
        request.base_sha, request.recipe_digest, request.executor_digest,
        request.pane_workspace_revision_origin,
        request.state, request.setup_revision,
        request.approval_binding_digest, request.executor_instance_id,
        request.failure_code, request.transcript, request.transcript_bytes,
        request.created_at, request.updated_at, request.approved_at,
        request.effect_started_at, request.completed_at,
        binding.pane_id, binding.canonical_checkout_path
      FROM workspace_setup_lane_heads AS head
      JOIN workspace_setup_requests AS request
        ON request.request_id = head.request_id
       AND request.lane_id = head.lane_id
      JOIN workspace_leases AS lease
        ON lease.lane_id = request.lane_id
       AND lease.project_id = request.project_id
      JOIN chat_pane_workspace_bindings AS binding
        ON binding.expected_lane_id = head.lane_id
       AND binding.workspace_lease_id = head.lane_id
       AND binding.project_id = request.project_id
       AND binding.state != 'preserved'
      WHERE head.lane_id = ?1
      ORDER BY binding.binding_id
      LIMIT 2
    `).all(laneId);
    if (values.length > 1) corrupt("Workspace setup head has ambiguous pane authority.");
    const value = values[0];
    return value === undefined ? null : parseHeadRow(value);
  }

  #requireHeadRequest(requestId: string): z.infer<typeof headRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT request.request_id, request.lane_id, request.project_id,
        request.base_sha, request.recipe_digest, request.executor_digest,
        request.pane_workspace_revision_origin,
        request.state, request.setup_revision,
        request.approval_binding_digest, request.executor_instance_id,
        request.failure_code, request.transcript, request.transcript_bytes,
        request.created_at, request.updated_at, request.approved_at,
        request.effect_started_at, request.completed_at,
        binding.pane_id, binding.canonical_checkout_path
      FROM workspace_setup_requests AS request
      JOIN workspace_setup_lane_heads AS head
        ON head.request_id = request.request_id
       AND head.lane_id = request.lane_id
      JOIN workspace_leases AS lease
        ON lease.lane_id = request.lane_id
       AND lease.project_id = request.project_id
      JOIN chat_pane_workspace_bindings AS binding
        ON binding.expected_lane_id = request.lane_id
       AND binding.workspace_lease_id = request.lane_id
       AND binding.project_id = request.project_id
       AND binding.state != 'preserved'
      WHERE request.request_id = ?1
    `).get(requestId);
    if (value === null) notFound("Workspace setup request is not the active lane head.");
    return parseHeadRow(value);
  }

  #request(requestId: string): z.infer<typeof requestRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT request_id, lane_id, project_id, base_sha, recipe_digest,
        executor_digest, pane_workspace_revision_origin,
        state, setup_revision, approval_binding_digest,
        executor_instance_id, failure_code, transcript, transcript_bytes,
        created_at, updated_at, approved_at, effect_started_at, completed_at
      FROM workspace_setup_requests WHERE request_id = ?1
    `).get(requestId);
    return value === null ? null : parseRequestRow(value);
  }

  #touchPane(paneId: string, at: string): void {
    const changed = this.#database.query(`
      UPDATE chat_panes
      SET revision = revision + 1,
        workspace_revision = workspace_revision + 1,
        updated_at = ?2
      WHERE pane_id = ?1 AND archived_at IS NULL
        AND workspace_mode = 'managed_worktree'
        AND workspace_state = 'preparing'
        AND EXISTS (
          SELECT 1
          FROM workspace_setup_lane_heads AS head
          JOIN workspace_setup_requests AS request
            ON request.request_id = head.request_id
           AND request.lane_id = head.lane_id
          JOIN workspace_leases AS lease
            ON lease.lane_id = request.lane_id
           AND lease.project_id = request.project_id
          JOIN chat_pane_workspace_bindings AS binding
            ON binding.expected_lane_id = request.lane_id
           AND binding.workspace_lease_id = request.lane_id
           AND binding.project_id = request.project_id
           AND binding.state != 'preserved'
          WHERE binding.pane_id = chat_panes.pane_id
            AND request.pane_workspace_revision_origin
              + request.setup_revision = chat_panes.workspace_revision + 1
        )
    `).run(paneId, at);
    if (changed.changes !== 1) {
      conflict("Workspace setup pane projection changed before settlement.");
    }
  }
}

function parseIdentity(value: WorkspaceLaneIdentity): WorkspaceLaneIdentity {
  const parsed = {
    runId: laneIdSchema.parse(value.runId),
    laneId: laneIdSchema.parse(value.laneId),
    baseSha: commitSchema.parse(value.baseSha),
    branchName: z.string().min(1).max(255).parse(value.branchName),
    canonicalRepositoryPath: pathSchema.parse(value.canonicalRepositoryPath),
    canonicalGitCommonDir: pathSchema.parse(value.canonicalGitCommonDir),
    canonicalCheckoutPath: pathSchema.parse(value.canonicalCheckoutPath),
    recoveryManifestPath: pathSchema.parse(value.recoveryManifestPath),
  };
  if (
    parsed.runId !== parsed.laneId ||
    parsed.branchName !== `codex/oprte-${parsed.laneId}`
  ) conflict("Workspace setup identity is not lane-derived.");
  return parsed;
}

function parseRequestRow(value: unknown): z.infer<typeof requestRowSchema> {
  const row = requestRowSchema.parse(value);
  if (row.setup_revision !== setupRevisionForState(row.state)) {
    corrupt("Workspace setup state revision is corrupt.");
  }
  if (
    row.state !== "approval_required" &&
    row.state !== "rejected" &&
    row.approval_binding_digest !== approvalBindingDigest(row)
  ) corrupt("Workspace setup approval binding is corrupt.");
  if (
    row.transcript !== null &&
    Buffer.byteLength(row.transcript, "utf8") !== row.transcript_bytes
  ) corrupt("Workspace setup transcript byte count is corrupt.");
  return row;
}

function parseHeadRow(value: unknown): z.infer<typeof headRowSchema> {
  const row = headRowSchema.parse(value);
  parseRequestRow({
    request_id: row.request_id,
    lane_id: row.lane_id,
    project_id: row.project_id,
    base_sha: row.base_sha,
    recipe_digest: row.recipe_digest,
    executor_digest: row.executor_digest,
    pane_workspace_revision_origin: row.pane_workspace_revision_origin,
    state: row.state,
    setup_revision: row.setup_revision,
    approval_binding_digest: row.approval_binding_digest,
    executor_instance_id: row.executor_instance_id,
    failure_code: row.failure_code,
    transcript: row.transcript,
    transcript_bytes: row.transcript_bytes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at,
    effect_started_at: row.effect_started_at,
    completed_at: row.completed_at,
  });
  return row;
}

function projectRequest(row: z.infer<typeof headRowSchema>): WorkspaceSetupRequest {
  return Object.freeze({
    requestId: row.request_id,
    laneId: row.lane_id,
    projectId: row.project_id,
    paneId: row.pane_id,
    baseSha: row.base_sha,
    recipeDigest: row.recipe_digest,
    executorDigest: row.executor_digest,
    state: row.state,
    setupRevision: row.setup_revision,
    failureCode: row.failure_code,
    canonicalCheckoutPath: row.canonical_checkout_path,
  });
}

function workspaceSetupRequestId(input: Readonly<{
  laneId: string;
  baseSha: string;
  recipeDigest: string;
  executorDigest: string;
}>): string {
  return `wssetup_${createHash("sha256")
    .update("hra.workspace-setup-request.v1\0", "utf8")
    .update(input.laneId, "utf8")
    .update("\0", "utf8")
    .update(input.baseSha, "utf8")
    .update("\0", "utf8")
    .update(input.recipeDigest, "utf8")
    .update("\0", "utf8")
    .update(input.executorDigest, "utf8")
    .digest("hex").slice(0, 32)}`;
}

function approvalBindingDigest(row: z.infer<typeof requestRowSchema>): string {
  return createHash("sha256")
    .update("hra.workspace-setup-approval.v1\0", "utf8")
    .update(row.request_id, "utf8")
    .update("\0", "utf8")
    .update(row.lane_id, "utf8")
    .update("\0", "utf8")
    .update(row.project_id, "utf8")
    .update("\0", "utf8")
    .update(row.base_sha, "utf8")
    .update("\0", "utf8")
    .update(row.recipe_digest, "utf8")
    .update("\0", "utf8")
    .update(row.executor_digest, "utf8")
    .update("\0", "utf8")
    .update(String(row.pane_workspace_revision_origin), "utf8")
    .digest("hex");
}

function approvalProjection(
  row: z.infer<typeof headRowSchema>,
  changed: boolean,
): WorkspaceSetupApproval {
  return Object.freeze({
    changed,
    paneId: row.pane_id,
    requestId: row.request_id,
    recipeDigest: row.recipe_digest,
    setupRevision: row.setup_revision,
  });
}

function assertRequestIdentity(
  row: z.infer<typeof requestRowSchema>,
  binding: z.infer<typeof bindingRowSchema>,
  identity: WorkspaceLaneIdentity,
  recipeDigest: string,
  executorDigest: string,
): void {
  if (
    row.lane_id !== identity.laneId ||
    row.project_id !== binding.project_id ||
    row.base_sha !== identity.baseSha ||
    row.recipe_digest !== recipeDigest ||
    row.executor_digest !== executorDigest
  ) corrupt("Workspace setup request ID collided with different authority.");
}

function assertBindingIdentity(
  binding: Pick<z.infer<typeof bindingRowSchema>,
    | "base_sha"
    | "branch_name"
    | "canonical_checkout_path"
    | "canonical_git_common_dir"
    | "canonical_repository_path"
    | "expected_lane_id"
    | "recovery_manifest_path"
    | "workspace_lease_id"
  >,
  identity: WorkspaceLaneIdentity,
): void {
  if (
    binding.base_sha !== identity.baseSha ||
    binding.expected_lane_id !== identity.laneId ||
    binding.workspace_lease_id !== identity.laneId ||
    binding.canonical_repository_path !== identity.canonicalRepositoryPath ||
    binding.canonical_git_common_dir !== identity.canonicalGitCommonDir ||
    binding.canonical_checkout_path !== identity.canonicalCheckoutPath ||
    binding.branch_name !== identity.branchName ||
    binding.recovery_manifest_path !== identity.recoveryManifestPath
  ) conflict("Workspace setup lane identity changed.");
}

function isTerminal(state: WorkspaceSetupState): boolean {
  return state === "rejected" || state === "succeeded" || state === "failed" ||
    state === "ambiguous";
}

function authoritativeSuccess(
  current: z.infer<typeof headRowSchema> | null,
  identity: WorkspaceLaneIdentity,
  recipeDigest: string,
): z.infer<typeof headRowSchema> | null {
  return current !== null &&
    current.state === "succeeded" &&
    current.lane_id === identity.laneId &&
    current.base_sha === identity.baseSha &&
    current.recipe_digest === recipeDigest
    ? current
    : null;
}

function authoritativeCleanReplacement(
  current: z.infer<typeof headRowSchema> | null,
  identity: WorkspaceLaneIdentity,
): z.infer<typeof headRowSchema> | null {
  return current !== null &&
    current.state === "rejected" &&
    current.failure_code === "clean_replacement_required" &&
    current.lane_id === identity.laneId &&
    current.base_sha === identity.baseSha
    ? current
    : null;
}

function setupRevisionForState(state: WorkspaceSetupState): number {
  switch (state) {
    case "approval_required":
    case "rejected":
      return 1;
    case "prepared":
      return 2;
    case "effect_started":
      return 3;
    case "succeeded":
    case "failed":
    case "ambiguous":
      return 4;
  }
}

function conflict(message: string): never {
  throw new WorkspaceSetupStoreError("conflict", message);
}

function corrupt(message: string): never {
  throw new WorkspaceSetupStoreError("corrupt_state", message);
}

function notFound(message: string): never {
  throw new WorkspaceSetupStoreError("not_found", message);
}

function stale(message: string): never {
  throw new WorkspaceSetupStoreError("stale_revision", message);
}

function invalidState(message: string): never {
  throw new WorkspaceSetupStoreError("invalid_state", message);
}
