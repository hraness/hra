import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  actorEpochSchema,
  actorSchema,
  type Actor,
  type ActorEpoch,
} from "./actor-domain";
import {
  deriveManagedActorLaneId,
  deriveReadOnlySnapshotId,
  type ActorWorkspaceBrokerPort,
} from "./actor-workspace-adapter";
import type { PersistentActorWorkspacePort } from "./persistent-actors";
import {
  actorWorkspaceBindingIdSchema,
  type HarnessSQLiteAuthorityV2,
} from "./sqlite-authority-v2";
import {
  WorkspaceLaneQuarantinedError,
  type ReadOnlySnapshotIdentity,
  type ReadOnlySnapshotIdentityStore,
  type WorkspaceLaneIdentity,
  type WorkspaceLaneIdentityStore,
} from "../workspaces/workspace-broker";

const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const absolutePathSchema = z.string().min(1).max(4_096).startsWith("/");
const laneIdSchema = z.string().min(8).max(128)
  .regex(/^[a-z0-9][a-z0-9_-]+$/u);
const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "workspace timestamps must use canonical UTC milliseconds",
);

const projectRowSchema = z.object({
  project_id: z.string().min(1).max(128),
  canonical_repository_path: absolutePathSchema,
  canonical_git_common_dir: absolutePathSchema,
}).strict();

const laneRowSchema = z.object({
  lane_id: laneIdSchema,
  project_id: z.string().min(1).max(128),
  canonical_repository_path: absolutePathSchema,
  canonical_git_common_dir: absolutePathSchema,
  canonical_checkout_path: absolutePathSchema,
  mode: z.enum(["managed_worktree", "harness_read_only_snapshot"]),
  status: z.enum(["provisioning", "ready", "quarantined"]),
  base_sha: commitSchema,
  branch_name: z.string().min(1).max(512).nullable(),
  recovery_manifest_path: absolutePathSchema,
  quarantine_reason: z.string().min(1).max(96).nullable(),
  quarantined_at: timestampSchema.nullable(),
}).strict();

export class HarnessActorWorkspaceRuntimeV2Error extends Error {
  readonly code: "authority_conflict" | "corrupt_state" | "workspace_quarantined";

  constructor(
    code: HarnessActorWorkspaceRuntimeV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessActorWorkspaceRuntimeV2Error";
    this.code = code;
  }
}

/**
 * Persists WorkspaceBroker identities in the existing control plane. The
 * broker owns filesystem verification; this store owns exact SQLite identity
 * and never replaces or resets a quarantined lane.
 */
export class HarnessActorWorkspaceIdentityStoreV2
  implements WorkspaceLaneIdentityStore, ReadOnlySnapshotIdentityStore {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  bindWorkspaceLane(input: WorkspaceLaneIdentity): WorkspaceLaneIdentity {
    if (input.runId !== input.laneId) conflict("managed actor lane identity drifted");
    return this.#bind(input, "managed_worktree", input.branchName) as WorkspaceLaneIdentity;
  }

  authorizeWorkspaceLaneRecovery(
    input: WorkspaceLaneIdentity,
  ): WorkspaceLaneIdentity | null {
    if (input.runId !== input.laneId) return null;
    const lane = this.#readLane(input.laneId);
    if (
      lane === null || lane.mode !== "managed_worktree" ||
      lane.branch_name === null || lane.status === "quarantined" ||
      lane.quarantine_reason !== null || lane.quarantined_at !== null
    ) return null;
    return identityFromLane(lane) as WorkspaceLaneIdentity;
  }

  markWorkspaceLaneReady(input: WorkspaceLaneIdentity): void {
    const observed = this.bindWorkspaceLane(input);
    if (!sameManaged(observed, input)) conflict("managed actor lane identity drifted");
    this.#markReady(input.laneId);
  }

  bindReadOnlySnapshot(input: ReadOnlySnapshotIdentity): ReadOnlySnapshotIdentity {
    if (input.runId !== input.laneId) conflict("read-only actor lane identity drifted");
    return this.#bind(input, "harness_read_only_snapshot", null);
  }

  markReadOnlySnapshotReady(input: ReadOnlySnapshotIdentity): void {
    const observed = this.bindReadOnlySnapshot(input);
    if (!sameReadOnly(observed, input)) conflict("read-only actor lane identity drifted");
    this.#markReady(input.laneId);
  }

  markQuarantined(laneIdValue: string, reasonValue: string): void {
    const laneId = laneIdSchema.parse(laneIdValue);
    const reason = z.string().min(1).max(96).parse(reasonValue);
    const at = timestampSchema.parse(this.#now().toISOString());
    const current = this.#readLane(laneId);
    if (current === null) return;
    if (current.status === "quarantined") {
      if (current.quarantine_reason !== reason) {
        conflict("workspace lane already has different quarantine evidence");
      }
      return;
    }
    const changed = this.#database.query(`
      UPDATE workspace_leases SET status = 'quarantined',
        quarantine_reason = ?2, quarantined_at = ?3, updated_at = ?3
      WHERE lane_id = ?1 AND status IN ('provisioning', 'ready')
        AND quarantine_reason IS NULL AND quarantined_at IS NULL
    `).run(laneId, reason, at);
    if (changed.changes !== 1) conflict("workspace quarantine raced another authority");
  }

  #bind(
    inputValue: WorkspaceLaneIdentity | ReadOnlySnapshotIdentity,
    mode: "managed_worktree" | "harness_read_only_snapshot",
    branchName: string | null,
  ): WorkspaceLaneIdentity | ReadOnlySnapshotIdentity {
    const input = parseIdentity(inputValue);
    return this.#database.transaction(() => {
      const rows: unknown[] = this.#database.query(`
        SELECT workspace_leases.lane_id, workspace_leases.project_id,
          projects.canonical_repository_path, projects.canonical_git_common_dir,
          workspace_leases.canonical_checkout_path, workspace_leases.mode,
          workspace_leases.status, workspace_leases.base_sha,
          workspace_leases.branch_name, workspace_leases.recovery_manifest_path,
          workspace_leases.quarantine_reason, workspace_leases.quarantined_at
        FROM workspace_leases
        JOIN projects USING (project_id)
        WHERE workspace_leases.lane_id = ?1
          OR workspace_leases.canonical_checkout_path = ?2
        ORDER BY workspace_leases.lane_id
      `).all(input.laneId, input.canonicalCheckoutPath);
      if (rows.length > 1) conflict("workspace lane collides with another checkout");
      const existing = rows[0];
      if (existing !== undefined) {
        const lane = laneRowSchema.parse(existing);
        const projected = identityFromLane(lane);
        const exact = mode === "managed_worktree"
          ? branchName !== null && sameManaged(projected as WorkspaceLaneIdentity, {
              ...input,
              branchName,
            })
          : sameReadOnly(projected, input);
        if (!exact || lane.mode !== mode || lane.status === "quarantined") {
          conflict("workspace lane identity conflicts with durable state");
        }
        return projected;
      }
      const projectValue: unknown = this.#database.query(`
        SELECT project_id, canonical_repository_path, canonical_git_common_dir
        FROM projects WHERE canonical_repository_path = ?1
          AND canonical_git_common_dir = ?2
      `).get(input.canonicalRepositoryPath, input.canonicalGitCommonDir);
      const project = projectRowSchema.safeParse(projectValue);
      if (!project.success) conflict("workspace project identity is unavailable");
      const at = timestampSchema.parse(this.#now().toISOString());
      try {
        this.#database.query(`
          INSERT INTO workspace_leases (
            lane_id, project_id, account_profile_id,
            canonical_checkout_path, mode, status, base_sha, branch_name,
            retention, dirty_hint, recovery_manifest_path,
            quarantine_reason, quarantined_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, NULL, ?3, ?4, 'provisioning', ?5, ?6,
            'preserve', 0, ?7, NULL, NULL, ?8, ?8
          )
        `).run(
          input.laneId,
          project.data.project_id,
          input.canonicalCheckoutPath,
          mode,
          input.baseSha,
          branchName,
          input.recoveryManifestPath,
          at,
        );
      } catch (cause: unknown) {
        throw new HarnessActorWorkspaceRuntimeV2Error(
          "authority_conflict",
          "workspace lane identity could not be persisted",
          cause,
        );
      }
      const created = this.#readLane(input.laneId);
      if (created === null) corrupt("persisted workspace lane disappeared");
      return identityFromLane(created);
    })();
  }

  #markReady(laneId: string): void {
    const current = this.#readLane(laneId);
    if (current === null) corrupt("workspace lane disappeared before readiness");
    if (current.status === "ready") return;
    if (current.status !== "provisioning") {
      conflict("quarantined workspace lanes cannot become ready");
    }
    const at = timestampSchema.parse(this.#now().toISOString());
    const changed = this.#database.query(`
      UPDATE workspace_leases SET status = 'ready', updated_at = ?2
      WHERE lane_id = ?1 AND status = 'provisioning'
        AND quarantine_reason IS NULL AND quarantined_at IS NULL
    `).run(laneId, at);
    if (changed.changes !== 1) conflict("workspace readiness raced another authority");
  }

  #readLane(laneId: string): z.infer<typeof laneRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT workspace_leases.lane_id, workspace_leases.project_id,
        projects.canonical_repository_path, projects.canonical_git_common_dir,
        workspace_leases.canonical_checkout_path, workspace_leases.mode,
        workspace_leases.status, workspace_leases.base_sha,
        workspace_leases.branch_name, workspace_leases.recovery_manifest_path,
        workspace_leases.quarantine_reason, workspace_leases.quarantined_at
      FROM workspace_leases JOIN projects USING (project_id)
      WHERE workspace_leases.lane_id = ?1
    `).get(laneId);
    if (value === null) return null;
    try {
      return laneRowSchema.parse(value);
    } catch (cause: unknown) {
      throw new HarnessActorWorkspaceRuntimeV2Error(
        "corrupt_state",
        "stored actor workspace lane is invalid",
        cause,
      );
    }
  }
}

/** Actor coordinator workspace port with exact source/lane verification. */
export class PersistentActorWorkspaceRuntimeV2
  implements PersistentActorWorkspacePort {
  readonly #database: Database;
  readonly #authority: HarnessSQLiteAuthorityV2;
  readonly #broker: ActorWorkspaceBrokerPort;
  readonly #identities: HarnessActorWorkspaceIdentityStoreV2;

  constructor(input: Readonly<{
    database: Database;
    authority: HarnessSQLiteAuthorityV2;
    broker: ActorWorkspaceBrokerPort;
    identities: HarnessActorWorkspaceIdentityStoreV2;
  }>) {
    this.#database = input.database;
    this.#authority = input.authority;
    this.#broker = input.broker;
    this.#identities = input.identities;
  }

  async acquire(inputValue: Readonly<{
    epoch: ActorEpoch;
    actor: Actor;
    bindingId: string;
  }>): Promise<Readonly<{
    laneId: string;
    authority: "readOnlySnapshot" | "managedWrite";
  }>> {
    const epoch = actorEpochSchema.parse(inputValue.epoch);
    let actor = actorSchema.parse(inputValue.actor);
    const bindingId = actorWorkspaceBindingIdSchema.parse(inputValue.bindingId);
    const currentEpoch = this.#authority.readActorEpoch(epoch.id);
    const currentActor = this.#authority.readActor(actor.id);
    if (
      currentEpoch === null || currentActor === null ||
      canonicalJson(currentEpoch) !== canonicalJson(epoch) ||
      canonicalJson(currentActor) !== canonicalJson(actor) ||
      actor.epochId !== epoch.id || actor.state !== "active"
    ) conflict("actor workspace request is stale or incoherent");
    const project = this.#project(epoch.projectId);
    const laneId = actor.budget.laneAuthority === "readOnlySnapshot"
      ? deriveReadOnlySnapshotId(epoch.projectId, epoch.sourceSha)
      : deriveManagedActorLaneId(actor.id, epoch.sourceSha);
    try {
      const workspace = actor.budget.laneAuthority === "readOnlySnapshot"
        ? await this.#broker.provisionReadOnlySnapshot({
            snapshotId: laneId,
            repositoryPath: project.canonical_repository_path,
            sourceSha: epoch.sourceSha,
          })
        : await this.#broker.provision({
            runId: laneId,
            repositoryPath: project.canonical_repository_path,
            baseSha: epoch.sourceSha,
          });
      if (workspace.laneId !== laneId || workspace.baseSha !== epoch.sourceSha) {
        conflict("workspace broker returned a different actor lane");
      }
      const binding = this.#authority.bindActorWorkspace({
        bindingId,
        actorId: actor.id,
        laneId,
        authority: actor.budget.laneAuthority,
      });
      if (
        binding.actorId !== actor.id || binding.laneId !== laneId ||
        binding.authority !== actor.budget.laneAuthority ||
        binding.state !== "active"
      ) conflict("actor workspace binding changed during admission");
      return Object.freeze({ laneId, authority: actor.budget.laneAuthority });
    } catch (cause: unknown) {
      if (!(cause instanceof WorkspaceLaneQuarantinedError)) throw cause;
      this.#identities.markQuarantined(laneId, cause.reason);
      actor = this.#authority.readActor(actor.id) ?? actor;
      if (actor.state === "active") {
        actor = this.#authority.requestActorStop({
          actorId: actor.id,
          expectedRevision: actor.revision,
        });
      }
      if (actor.state === "stopRequested") {
        this.#authority.settleActorStop({
          actorId: actor.id,
          expectedRevision: actor.revision,
          nextState: "quarantined",
        });
      }
      throw new HarnessActorWorkspaceRuntimeV2Error(
        "workspace_quarantined",
        "actor workspace is quarantined for inspection",
        cause,
      );
    }
  }

  #project(projectId: string): z.infer<typeof projectRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT project_id, canonical_repository_path, canonical_git_common_dir
      FROM projects WHERE project_id = ?1
    `).get(projectId);
    try {
      return projectRowSchema.parse(value);
    } catch (cause: unknown) {
      throw new HarnessActorWorkspaceRuntimeV2Error(
        "corrupt_state",
        "actor workspace project is unavailable",
        cause,
      );
    }
  }
}

function parseIdentity(
  value: WorkspaceLaneIdentity | ReadOnlySnapshotIdentity,
): Readonly<{
  baseSha: string;
  canonicalCheckoutPath: string;
  canonicalGitCommonDir: string;
  canonicalRepositoryPath: string;
  laneId: string;
  recoveryManifestPath: string;
  runId: string;
}> {
  return z.object({
    baseSha: commitSchema,
    canonicalCheckoutPath: absolutePathSchema,
    canonicalGitCommonDir: absolutePathSchema,
    canonicalRepositoryPath: absolutePathSchema,
    laneId: laneIdSchema,
    recoveryManifestPath: absolutePathSchema,
    runId: laneIdSchema,
  }).strict().parse({
    baseSha: value.baseSha,
    canonicalCheckoutPath: value.canonicalCheckoutPath,
    canonicalGitCommonDir: value.canonicalGitCommonDir,
    canonicalRepositoryPath: value.canonicalRepositoryPath,
    laneId: value.laneId,
    recoveryManifestPath: value.recoveryManifestPath,
    runId: value.runId,
  });
}

function identityFromLane(
  lane: z.infer<typeof laneRowSchema>,
): WorkspaceLaneIdentity | ReadOnlySnapshotIdentity {
  const base = {
    baseSha: lane.base_sha,
    canonicalCheckoutPath: lane.canonical_checkout_path,
    canonicalGitCommonDir: lane.canonical_git_common_dir,
    canonicalRepositoryPath: lane.canonical_repository_path,
    laneId: lane.lane_id,
    recoveryManifestPath: lane.recovery_manifest_path,
    runId: lane.lane_id,
  };
  return lane.mode === "managed_worktree"
    ? { ...base, branchName: lane.branch_name ?? corrupt("managed lane lost its branch") }
    : base;
}

function sameManaged(
  left: WorkspaceLaneIdentity,
  right: WorkspaceLaneIdentity,
): boolean {
  return sameBase(left, right) && left.branchName === right.branchName;
}

function sameReadOnly(
  left: ReadOnlySnapshotIdentity,
  right: ReadOnlySnapshotIdentity,
): boolean {
  return sameBase(left, right);
}

function sameBase(
  left: ReadOnlySnapshotIdentity,
  right: ReadOnlySnapshotIdentity,
): boolean {
  return left.baseSha === right.baseSha &&
    left.canonicalCheckoutPath === right.canonicalCheckoutPath &&
    left.canonicalGitCommonDir === right.canonicalGitCommonDir &&
    left.canonicalRepositoryPath === right.canonicalRepositoryPath &&
    left.laneId === right.laneId &&
    left.recoveryManifestPath === right.recoveryManifestPath &&
    left.runId === right.runId;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function conflict(message: string): never {
  throw new HarnessActorWorkspaceRuntimeV2Error("authority_conflict", message);
}

function corrupt(message: string): never {
  throw new HarnessActorWorkspaceRuntimeV2Error("corrupt_state", message);
}
