import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";

import {
  chatPaneIdSchema,
  type ChatPaneProjection,
} from "../../../contracts/runtime";
import type {
  ChatPaneId,
  ChatRepository,
  ChatWorkspacePort,
} from "../chat/types";
import {
  WorkspaceCapacityError,
  WorkspaceLaneQuarantinedError,
  type WorkspaceBroker,
  type WorkspaceLaneIdentity,
  type WorkspaceLaneIdentityStore,
} from "../workspaces/workspace-broker";
import { GitExecutionError } from "../workspaces/git-runner";
import { ChatPaneStore, ChatPaneStoreError } from "./chat-pane-store";

const timestampSchema = z.string().datetime({ offset: false, precision: 3 });
const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const pathSchema = z.string().min(1).max(4_096).refine(
  (value) => !value.includes("\0"),
  "workspace path contains NUL",
);
const bindingIdSchema = z.string().regex(/^chatws_[a-f0-9]{32}$/u);
const laneIdSchema = z.string().regex(/^chat_[a-f0-9]{32}$/u);
const bindingStateSchema = z.enum([
  "provisioning",
  "ready",
  "preserved",
  "quarantined",
  "recovery_required",
]);
const recoveryReasonSchema = z.enum([
  "capacity_unavailable",
  "insufficient_disk",
  "base_mismatch",
  "binding_mismatch",
  "branch_without_lane",
  "checkout_mismatch",
  "dirty_checkout",
  "invalid_manifest",
  "manifest_missing",
  "path_escape",
  "repository_mismatch",
  "provision_interrupted",
  "lane_missing",
  "unknown",
]);

const activeBindingRowSchema = z.object({
  binding_id: bindingIdSchema,
  pane_id: chatPaneIdSchema,
  repository_id: z.string().min(1).max(128),
  project_id: z.string().min(1).max(128),
  expected_lane_id: laneIdSchema,
  workspace_lease_id: laneIdSchema,
  base_sha: commitSchema,
  branch_name: z.string().min(1).max(255),
  canonical_repository_path: pathSchema,
  canonical_git_common_dir: pathSchema,
  canonical_checkout_path: pathSchema,
  recovery_manifest_path: pathSchema,
  state: bindingStateSchema,
  revision: z.number().int().positive().safe(),
  recovery_reason: recoveryReasonSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

type ActiveBindingRow = z.infer<typeof activeBindingRowSchema>;
type WorkspaceRecoveryReason = z.infer<typeof recoveryReasonSchema>;

const paneWorkspaceRowSchema = z.object({
  pane_id: chatPaneIdSchema,
  repository_id: z.string().min(1).max(128),
  interaction_mode: z.enum(["chat", "harnessObserver"]),
  workspace_mode: z.enum(["legacy_unbound", "managed_worktree"]),
  workspace_state: z.enum([
    "preparing",
    "waiting_capacity",
    "ready",
    "preserved",
    "recovery_required",
  ]),
  archived_at: timestampSchema.nullable(),
}).strict();

const repositoryIdentitySchema = z.object({
  repository_id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  canonical_repository_path: pathSchema,
  canonical_git_common_dir: pathSchema,
  tombstoned_at: z.number().int().nonnegative().safe().nullable(),
}).strict();

const leaseIdentitySchema = z.object({
  lane_id: laneIdSchema,
  project_id: z.string().min(1).max(128),
  canonical_checkout_path: pathSchema,
  mode: z.literal("chat_managed_worktree"),
  status: z.enum(["provisioning", "ready", "quarantined", "preserved"]),
  base_sha: commitSchema,
  branch_name: z.string().min(1).max(255),
  recovery_manifest_path: pathSchema,
}).strict();

export class ChatWorkspaceAuthorityError extends Error {
  readonly code: "conflict" | "corrupt_state";

  constructor(code: ChatWorkspaceAuthorityError["code"], message: string) {
    super(message);
    this.name = "ChatWorkspaceAuthorityError";
    this.code = code;
  }
}

/**
 * Durable pane-to-lane authority. Filesystem adoption belongs to
 * WorkspaceBroker; this store accepts only its exact identity callbacks and
 * never derives authority from a checkout discovered on disk.
 */
export class ChatWorkspaceStore implements WorkspaceLaneIdentityStore {
  readonly #database: Database;
  readonly #panes: ChatPaneStore;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#database = database;
    this.#panes = new ChatPaneStore(database);
    this.#now = options.now ?? (() => new Date());
  }

  activeBinding(paneIdValue: ChatPaneId): ActiveBindingRow | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const values: unknown[] = this.#database.query(`
      SELECT binding_id, pane_id, repository_id, project_id,
        expected_lane_id, workspace_lease_id, base_sha, branch_name,
        canonical_repository_path, canonical_git_common_dir,
        canonical_checkout_path, recovery_manifest_path, state, revision,
        recovery_reason, created_at, updated_at
      FROM chat_pane_workspace_bindings
      WHERE pane_id = ?1 AND state != 'preserved'
      ORDER BY created_at, binding_id
      LIMIT 2
    `).all(paneId);
    if (values.length > 1) corrupt("A pane has multiple active workspace bindings.");
    const value = values[0];
    return value === undefined ? null : activeBindingRowSchema.parse(value);
  }

  /**
   * The active lane is stable for its full lifetime. A preserved lane consumes
   * its generation permanently, so selecting another project (including a
   * later return to the same project) can never collide with retained work.
   */
  expectedLaneId(paneIdValue: ChatPaneId): string {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const active = this.activeBinding(paneId);
    if (active !== null) return active.expected_lane_id;
    const countValue: unknown = this.#database.query(`
      SELECT COUNT(*) AS count
      FROM chat_pane_workspace_bindings
      WHERE pane_id = ?1
    `).get(paneId);
    const parsed = z.object({
      count: z.number().int().nonnegative().max(1_000_000),
    }).strict().parse(countValue);
    return chatWorkspaceLaneId(paneId, parsed.count + 1);
  }

  authorizeWorkspaceLaneRecovery(
    inputValue: WorkspaceLaneIdentity,
  ): WorkspaceLaneIdentity | null {
    const input = parseIdentity(inputValue);
    const pane = this.#paneForLane(input.runId);
    const binding = this.activeBinding(pane.pane_id);
    // A legitimate interrupted provision always persisted this binding before
    // the manifest or Git worktree could be created. Filesystem state without
    // it is an orphan and must remain untouched for explicit recovery.
    return binding === null ? null : identityFromBinding(binding);
  }

  bindWorkspaceLane(inputValue: WorkspaceLaneIdentity): WorkspaceLaneIdentity {
    const input = parseIdentity(inputValue);
    const pane = this.#paneForLane(input.runId);
    const expectedLaneId = this.expectedLaneId(pane.pane_id);
    if (
      input.runId !== expectedLaneId || input.laneId !== expectedLaneId ||
      input.branchName !== `codex/oprte-${expectedLaneId}`
    ) conflict("Managed chat workspace identity is not pane-derived.");

    return this.#database.transaction(() => {
      if (
        pane.interaction_mode !== "chat" || pane.archived_at !== null ||
        pane.workspace_mode !== "managed_worktree" ||
        pane.workspace_state === "preserved"
      ) conflict("The pane cannot authorize a managed workspace.");
      const repository = this.#repository(pane.repository_id);
      if (
        repository.tombstoned_at !== null ||
        repository.canonical_repository_path !== input.canonicalRepositoryPath ||
        repository.canonical_git_common_dir !== input.canonicalGitCommonDir
      ) conflict("The repository identity changed before workspace admission.");

      const projectId = projectIdFor(input.canonicalRepositoryPath);
      this.#ensureProject(projectId, repository.name, input);
      const existing = this.activeBinding(pane.pane_id);
      if (existing !== null) {
        assertExactBinding(existing, input, projectId);
        if (existing.state !== "provisioning" && existing.state !== "ready") {
          conflict("The workspace needs an explicit retry before adoption.");
        }
        this.#assertLease(existing, input);
        return identityFromBinding(existing);
      }

      const collisionValues: unknown[] = this.#database.query(`
        SELECT lane_id, project_id, canonical_checkout_path, mode, status,
          base_sha, branch_name, recovery_manifest_path
        FROM workspace_leases
        WHERE lane_id = ?1 OR canonical_checkout_path = ?2
        ORDER BY lane_id
      `).all(input.laneId, input.canonicalCheckoutPath);
      if (collisionValues.length > 0) {
        conflict("The managed chat workspace collides with another durable lane.");
      }
      const at = timestampSchema.parse(this.#now().toISOString());
      try {
        this.#database.query(`
          INSERT INTO workspace_leases (
            lane_id, project_id, account_profile_id,
            canonical_checkout_path, mode, status, base_sha, branch_name,
            retention, dirty_hint, recovery_manifest_path,
            quarantine_reason, quarantined_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, NULL, ?3, 'chat_managed_worktree', 'provisioning', ?4, ?5,
            'preserve', 0, ?6, NULL, NULL, ?7, ?7
          )
        `).run(
          input.laneId,
          projectId,
          input.canonicalCheckoutPath,
          input.baseSha,
          input.branchName,
          input.recoveryManifestPath,
          at,
        );
        this.#database.query(`
          INSERT INTO chat_pane_workspace_bindings (
            binding_id, pane_id, repository_id, project_id,
            expected_lane_id, workspace_lease_id, base_sha, branch_name,
            canonical_repository_path, canonical_git_common_dir,
            canonical_checkout_path, recovery_manifest_path,
            state, revision, recovery_reason, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            'provisioning', 1, NULL, ?12, ?12
          )
        `).run(
          chatWorkspaceBindingId(input.laneId),
          pane.pane_id,
          repository.repository_id,
          projectId,
          input.laneId,
          input.baseSha,
          input.branchName,
          input.canonicalRepositoryPath,
          input.canonicalGitCommonDir,
          input.canonicalCheckoutPath,
          input.recoveryManifestPath,
          at,
        );
      } catch {
        conflict("The managed chat workspace identity could not be persisted.");
      }
      const created = this.activeBinding(pane.pane_id);
      if (created === null) corrupt("The persisted workspace binding disappeared.");
      return identityFromBinding(created);
    })();
  }

  markWorkspaceLaneReady(inputValue: WorkspaceLaneIdentity): void {
    const input = parseIdentity(inputValue);
    this.#database.transaction(() => {
      const observed = this.bindWorkspaceLane(input);
      if (!sameIdentity(observed, input)) conflict("Workspace readiness identity drifted.");
      const pane = this.#paneForLane(input.runId);
      const binding = this.activeBinding(pane.pane_id);
      if (binding === null) corrupt("Workspace binding disappeared before readiness.");
      if (binding.state === "ready") {
        this.#assertLease(binding, input);
        if (pane.workspace_state !== "ready") {
          const at = timestampSchema.parse(this.#now().toISOString());
          const changed = this.#database.query(`
            UPDATE chat_panes SET workspace_state = 'ready',
              workspace_recovery_reason = NULL,
              workspace_revision = workspace_revision + 1,
              revision = revision + 1, updated_at = ?2
            WHERE pane_id = ?1 AND workspace_mode = 'managed_worktree'
              AND workspace_state = 'preparing' AND archived_at IS NULL
          `).run(binding.pane_id, at);
          if (changed.changes !== 1) {
            conflict("Workspace projection readiness raced another authority.");
          }
        }
        return;
      }
      const at = timestampSchema.parse(this.#now().toISOString());
      const lease = this.#database.query(`
        UPDATE workspace_leases SET status = 'ready', updated_at = ?2
        WHERE lane_id = ?1 AND status = 'provisioning'
          AND quarantine_reason IS NULL AND quarantined_at IS NULL
      `).run(input.laneId, at);
      const durable = this.#database.query(`
        UPDATE chat_pane_workspace_bindings SET state = 'ready',
          recovery_reason = NULL, revision = revision + 1, updated_at = ?2
        WHERE binding_id = ?1 AND state = 'provisioning'
          AND recovery_reason IS NULL
      `).run(binding.binding_id, at);
      const projectedPane = this.#database.query(`
        UPDATE chat_panes SET workspace_state = 'ready',
          workspace_recovery_reason = NULL,
          workspace_revision = workspace_revision + 1,
          revision = revision + 1, updated_at = ?2
        WHERE pane_id = ?1 AND workspace_mode = 'managed_worktree'
          AND workspace_state = 'preparing' AND archived_at IS NULL
      `).run(binding.pane_id, at);
      if (
        lease.changes !== 1 || durable.changes !== 1 ||
        projectedPane.changes !== 1
      ) {
        conflict("Workspace readiness raced another authority.");
      }
    })();
  }

  beginProvisioning(paneIdValue: ChatPaneId): ChatPaneProjection {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    return this.#database.transaction(() => {
      const pane = this.#pane(paneId);
      if (
        pane.archived_at !== null || pane.interaction_mode !== "chat" ||
        pane.workspace_mode !== "managed_worktree"
      ) return this.#panes.require(paneId).projection;
      if (pane.workspace_state === "ready" || pane.workspace_state === "preparing") {
        return this.#panes.require(paneId).projection;
      }
      if (pane.workspace_state === "preserved") {
        conflict("A preserved workspace cannot return to the live grid.");
      }
      const at = timestampSchema.parse(this.#now().toISOString());
      const binding = this.activeBinding(paneId);
      if (binding !== null) {
        this.#database.query(`
          UPDATE workspace_leases SET status = 'provisioning',
            quarantine_reason = NULL, quarantined_at = NULL, updated_at = ?2
          WHERE lane_id = ?1 AND status = 'quarantined'
        `).run(binding.workspace_lease_id, at);
        this.#database.query(`
          UPDATE chat_pane_workspace_bindings SET state = 'provisioning',
            recovery_reason = NULL, revision = revision + 1, updated_at = ?2
          WHERE binding_id = ?1 AND state IN ('quarantined', 'recovery_required')
        `).run(binding.binding_id, at);
      }
      const changed = this.#database.query(`
        UPDATE chat_panes SET workspace_state = 'preparing',
          workspace_recovery_reason = NULL,
          workspace_revision = workspace_revision + 1,
          revision = revision + 1, updated_at = ?2
        WHERE pane_id = ?1 AND workspace_state IN (
          'waiting_capacity', 'recovery_required'
        ) AND archived_at IS NULL
      `).run(paneId, at);
      if (changed.changes !== 1) conflict("Workspace retry raced another authority.");
      return this.#panes.require(paneId).projection;
    })();
  }

  markWaiting(
    paneIdValue: ChatPaneId,
    reason: "capacity_unavailable" | "insufficient_disk",
  ): ChatPaneProjection {
    return this.#markUnavailable(paneIdValue, "waiting_capacity", reason);
  }

  markRecovery(
    paneIdValue: ChatPaneId,
    reason: WorkspaceRecoveryReason,
  ): ChatPaneProjection {
    return this.#markUnavailable(paneIdValue, "recovery_required", reason);
  }

  readyRepository(
    paneIdValue: ChatPaneId,
    repository: ChatRepository,
  ): ChatRepository | null {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const binding = this.activeBinding(paneId);
    if (binding === null || binding.state !== "ready") return null;
    const pane = this.#pane(paneId);
    if (
      pane.archived_at !== null || pane.repository_id !== repository.id ||
      pane.workspace_mode !== "managed_worktree" || pane.workspace_state !== "ready"
    ) return null;
    const registered = this.#repository(repository.id);
    if (
      registered.tombstoned_at !== null ||
      registered.canonical_repository_path !== repository.workingDirectory ||
      registered.canonical_repository_path !== binding.canonical_repository_path ||
      registered.canonical_git_common_dir !== binding.canonical_git_common_dir
    ) return null;
    this.#assertLease(binding, identityFromBinding(binding));
    return {
      id: repository.id,
      name: repository.name,
      workingDirectory: binding.canonical_checkout_path,
    };
  }

  #markUnavailable(
    paneIdValue: ChatPaneId,
    state: "waiting_capacity" | "recovery_required",
    reasonValue: WorkspaceRecoveryReason,
  ): ChatPaneProjection {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const reason = recoveryReasonSchema.parse(reasonValue);
    return this.#database.transaction(() => {
      const pane = this.#pane(paneId);
      if (
        pane.archived_at !== null || pane.interaction_mode !== "chat" ||
        pane.workspace_mode !== "managed_worktree" || pane.workspace_state === "preserved"
      ) conflict("The pane cannot enter workspace recovery.");
      const at = timestampSchema.parse(this.#now().toISOString());
      const binding = this.activeBinding(paneId);
      if (binding !== null) {
        this.#database.query(`
          UPDATE workspace_leases SET status = 'quarantined',
            quarantine_reason = ?2, quarantined_at = ?3, updated_at = ?3
          WHERE lane_id = ?1 AND status IN ('provisioning', 'ready', 'quarantined')
        `).run(binding.workspace_lease_id, reason, at);
        this.#database.query(`
          UPDATE chat_pane_workspace_bindings SET state = 'quarantined',
            recovery_reason = ?2, revision = revision + 1, updated_at = ?3
          WHERE binding_id = ?1 AND state IN (
            'provisioning', 'ready', 'quarantined', 'recovery_required'
          )
        `).run(binding.binding_id, reason, at);
      }
      if (
        pane.workspace_state === state &&
        this.#panes.require(paneId).projection.workspace?.recoveryKind ===
          projectionRecoveryKind(reason)
      ) return this.#panes.require(paneId).projection;
      const changed = this.#database.query(`
        UPDATE chat_panes SET workspace_state = ?2,
          workspace_recovery_reason = ?3,
          workspace_revision = workspace_revision + 1,
          revision = revision + 1, updated_at = ?4
        WHERE pane_id = ?1 AND archived_at IS NULL
          AND workspace_mode = 'managed_worktree'
          AND workspace_state != 'preserved'
      `).run(paneId, state, reason, at);
      if (changed.changes !== 1) conflict("Workspace recovery raced another authority.");
      return this.#panes.require(paneId).projection;
    })();
  }

  #pane(paneId: ChatPaneId): z.infer<typeof paneWorkspaceRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT pane_id, repository_id, interaction_mode, workspace_mode,
        workspace_state, archived_at
      FROM chat_panes WHERE pane_id = ?1
    `).get(paneId);
    if (value === null) throw new ChatPaneStoreError("not_found", "This chat pane no longer exists.");
    try {
      return paneWorkspaceRowSchema.parse(value);
    } catch {
      corrupt("Stored chat workspace state is invalid.");
    }
  }

  #paneForLane(laneIdValue: string): z.infer<typeof paneWorkspaceRowSchema> {
    const laneId = laneIdSchema.parse(laneIdValue);
    const values: unknown[] = this.#database.query(`
      SELECT pane_id, repository_id, interaction_mode, workspace_mode,
        workspace_state, archived_at
      FROM chat_panes
      WHERE archived_at IS NULL AND interaction_mode = 'chat'
        AND workspace_mode = 'managed_worktree'
      ORDER BY pane_id
      LIMIT 65
    `).all();
    const matches = values
      .map((value) => paneWorkspaceRowSchema.parse(value))
      .filter((pane) => this.expectedLaneId(pane.pane_id) === laneId);
    if (matches.length !== 1) {
      conflict("Managed chat workspace lane has no unique live pane authority.");
    }
    return matches[0] as z.infer<typeof paneWorkspaceRowSchema>;
  }

  #repository(repositoryId: string): z.infer<typeof repositoryIdentitySchema> {
    const value: unknown = this.#database.query(`
      SELECT repository_id, name, canonical_repository_path,
        canonical_git_common_dir, tombstoned_at
      FROM local_repositories WHERE repository_id = ?1
    `).get(repositoryId);
    if (value === null) conflict("The selected repository is unavailable.");
    try {
      return repositoryIdentitySchema.parse(value);
    } catch {
      corrupt("Stored repository identity is invalid.");
    }
  }

  #ensureProject(
    projectId: string,
    repositoryName: string,
    input: WorkspaceLaneIdentity,
  ): void {
    const at = timestampSchema.parse(this.#now().toISOString());
    try {
      this.#database.query(`
        INSERT INTO projects (
          project_id, canonical_repository_path, canonical_git_common_dir,
          display_name, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        ON CONFLICT(project_id) DO UPDATE SET
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
        WHERE projects.canonical_repository_path = excluded.canonical_repository_path
          AND projects.canonical_git_common_dir = excluded.canonical_git_common_dir
      `).run(
        projectId,
        input.canonicalRepositoryPath,
        input.canonicalGitCommonDir,
        repositoryName,
        at,
      );
    } catch {
      conflict("The canonical repository conflicts with another project.");
    }
    const exact: unknown = this.#database.query(`
      SELECT project_id FROM projects
      WHERE project_id = ?1 AND canonical_repository_path = ?2
        AND canonical_git_common_dir = ?3
    `).get(projectId, input.canonicalRepositoryPath, input.canonicalGitCommonDir);
    if (exact === null) conflict("The canonical project identity is unavailable.");
  }

  #assertLease(binding: ActiveBindingRow, input: WorkspaceLaneIdentity): void {
    const value: unknown = this.#database.query(`
      SELECT lane_id, project_id, canonical_checkout_path, mode, status,
        base_sha, branch_name, recovery_manifest_path
      FROM workspace_leases WHERE lane_id = ?1
    `).get(binding.workspace_lease_id);
    if (value === null) corrupt("The managed chat workspace lease disappeared.");
    const lease = leaseIdentitySchema.parse(value);
    if (
      lease.project_id !== binding.project_id ||
      lease.lane_id !== input.laneId ||
      lease.canonical_checkout_path !== input.canonicalCheckoutPath ||
      lease.base_sha !== input.baseSha || lease.branch_name !== input.branchName ||
      lease.recovery_manifest_path !== input.recoveryManifestPath ||
      (lease.status !== "provisioning" && lease.status !== "ready")
    ) conflict("The managed chat workspace lease identity drifted.");
  }
}

/** Coordinates exact broker recovery without ever returning the source checkout. */
export class ManagedChatWorkspaceService implements ChatWorkspacePort {
  readonly #broker: WorkspaceBroker;
  readonly #store: ChatWorkspaceStore;
  readonly #panes: ChatPaneStore;

  constructor(options: Readonly<{
    broker: WorkspaceBroker;
    store: ChatWorkspaceStore;
    panes: ChatPaneStore;
  }>) {
    this.#broker = options.broker;
    this.#store = options.store;
    this.#panes = options.panes;
  }

  async provision(
    paneIdValue: ChatPaneId,
    repository: ChatRepository,
  ): Promise<ChatPaneProjection> {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const current = this.#panes.require(paneId).projection;
    if (current.interactionMode !== "chat" || current.workspace === null) return current;
    if (current.workspace.mode === "legacyUnbound" || current.workspace.state === "preserved") {
      return current;
    }
    this.#store.beginProvisioning(paneId);
    try {
      const binding = this.#store.activeBinding(paneId);
      const laneId = this.#store.expectedLaneId(paneId);
      const baseSha = binding?.base_sha ?? await this.#broker.resolveBase(
        repository.workingDirectory,
        "HEAD",
      );
      const workspace = await this.#broker.provision({
        runId: laneId,
        repositoryPath: repository.workingDirectory,
        baseSha,
      });
      const ready = this.#store.readyRepository(paneId, repository);
      if (
        ready === null || ready.workingDirectory !== workspace.checkoutPath ||
        workspace.laneId !== laneId
      ) {
        throw new ChatWorkspaceAuthorityError(
          "conflict",
          "Workspace broker completion did not match durable pane authority.",
        );
      }
      return this.#panes.require(paneId).projection;
    } catch (error: unknown) {
      if (error instanceof WorkspaceCapacityError) {
        return this.#store.markWaiting(paneId, error.code);
      }
      if (
        error instanceof GitExecutionError &&
        error.reason === "capacity_unavailable"
      ) {
        return this.#store.markWaiting(paneId, "capacity_unavailable");
      }
      if (error instanceof WorkspaceLaneQuarantinedError) {
        return this.#store.markRecovery(paneId, error.reason);
      }
      return this.#store.markRecovery(paneId, "unknown");
    }
  }

  async resolve(
    paneIdValue: ChatPaneId,
    repository: ChatRepository,
  ): Promise<ChatRepository | null> {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    // Revalidate the exact manifest, Git common-dir, branch, and checkout on
    // every provider admission. A process-local cache cannot prove that a
    // writable filesystem identity remained intact between turns.
    const projected = await this.provision(paneId, repository);
    if (projected.workspace?.state !== "ready") return null;
    return this.#store.readyRepository(paneId, repository);
  }

  markRepositoryUnavailable(paneIdValue: ChatPaneId): ChatPaneProjection {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    // The public contract intentionally keeps filesystem details private. The
    // generic recovery kind is durable and retryable; logs and errors must not
    // project the missing local path into the renderer.
    return this.#store.markRecovery(paneId, "unknown");
  }

  release(paneIdValue: ChatPaneId): void {
    // Closing a pane preserves its worktree by policy; parsing still rejects a
    // malformed renderer identity at the boundary.
    chatPaneIdSchema.parse(paneIdValue);
  }
}

export function chatWorkspaceLaneId(
  paneIdValue: string,
  generationValue = 1,
): string {
  const paneId = chatPaneIdSchema.parse(paneIdValue);
  const generation = z.number().int().positive().max(1_000_001)
    .parse(generationValue);
  return laneIdSchema.parse(`chat_${digest(`${paneId}\0${generation}`)}`);
}

export function chatWorkspaceBindingId(laneIdValue: string): string {
  const laneId = laneIdSchema.parse(laneIdValue);
  return bindingIdSchema.parse(`chatws_${digest(laneId)}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function projectIdFor(path: string): string {
  return `proj_${createHash("sha256").update(path).digest("hex").slice(0, 24)}`;
}

function parseIdentity(input: WorkspaceLaneIdentity): WorkspaceLaneIdentity {
  return {
    baseSha: commitSchema.parse(input.baseSha),
    branchName: z.string().min(1).max(255).parse(input.branchName),
    canonicalCheckoutPath: pathSchema.parse(input.canonicalCheckoutPath),
    canonicalGitCommonDir: pathSchema.parse(input.canonicalGitCommonDir),
    canonicalRepositoryPath: pathSchema.parse(input.canonicalRepositoryPath),
    laneId: laneIdSchema.parse(input.laneId),
    recoveryManifestPath: pathSchema.parse(input.recoveryManifestPath),
    runId: laneIdSchema.parse(input.runId),
  };
}

function identityFromBinding(binding: ActiveBindingRow): WorkspaceLaneIdentity {
  return {
    baseSha: binding.base_sha,
    branchName: binding.branch_name,
    canonicalCheckoutPath: binding.canonical_checkout_path,
    canonicalGitCommonDir: binding.canonical_git_common_dir,
    canonicalRepositoryPath: binding.canonical_repository_path,
    laneId: binding.expected_lane_id,
    recoveryManifestPath: binding.recovery_manifest_path,
    runId: binding.expected_lane_id,
  };
}

function assertExactBinding(
  binding: ActiveBindingRow,
  input: WorkspaceLaneIdentity,
  projectId: string,
): void {
  if (
    binding.binding_id !== chatWorkspaceBindingId(binding.expected_lane_id) ||
    binding.repository_id.length === 0 || binding.project_id !== projectId ||
    !sameIdentity(identityFromBinding(binding), input)
  ) conflict("The pane workspace binding identity drifted.");
}

function sameIdentity(left: WorkspaceLaneIdentity, right: WorkspaceLaneIdentity): boolean {
  return left.baseSha === right.baseSha && left.branchName === right.branchName &&
    left.canonicalCheckoutPath === right.canonicalCheckoutPath &&
    left.canonicalGitCommonDir === right.canonicalGitCommonDir &&
    left.canonicalRepositoryPath === right.canonicalRepositoryPath &&
    left.laneId === right.laneId &&
    left.recoveryManifestPath === right.recoveryManifestPath &&
    left.runId === right.runId;
}

function projectionRecoveryKind(
  reason: WorkspaceRecoveryReason,
): NonNullable<ChatPaneProjection["workspace"]>["recoveryKind"] {
  const values = {
    capacity_unavailable: "capacityUnavailable",
    insufficient_disk: "insufficientDisk",
    base_mismatch: "baseMismatch",
    binding_mismatch: "bindingMismatch",
    branch_without_lane: "branchWithoutLane",
    checkout_mismatch: "checkoutMismatch",
    dirty_checkout: "dirtyCheckout",
    invalid_manifest: "invalidManifest",
    manifest_missing: "manifestMissing",
    path_escape: "pathEscape",
    repository_mismatch: "repositoryMismatch",
    provision_interrupted: "provisionInterrupted",
    lane_missing: "laneMissing",
    unknown: "unknown",
  } as const satisfies Record<
    WorkspaceRecoveryReason,
    NonNullable<ChatPaneProjection["workspace"]>["recoveryKind"]
  >;
  return values[reason];
}

function conflict(message: string): never {
  throw new ChatWorkspaceAuthorityError("conflict", message);
}

function corrupt(message: string): never {
  throw new ChatWorkspaceAuthorityError("corrupt_state", message);
}
