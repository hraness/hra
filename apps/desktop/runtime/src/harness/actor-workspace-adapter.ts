import { createHash } from "node:crypto";
import { z } from "@hra-internal/schema";

import {
  actorIdSchema,
  actorLaneAuthoritySchema,
} from "./actor-domain";
import {
  WorkspaceLaneQuarantinedError,
  type ManagedWorkspace,
  type ReadOnlyWorkspace,
} from "../workspaces/workspace-broker";

const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const projectIdSchema = z.string().min(1).max(128);
const absolutePathSchema = z.string().min(1).max(4096).startsWith("/");

const actorWorkspaceRequestSchema = z.object({
  actorId: actorIdSchema,
  projectId: projectIdSchema,
  repositoryPath: absolutePathSchema,
  sourceSha: commitSchema,
  authority: actorLaneAuthoritySchema,
  actorState: z.enum(["active", "stopRequested", "stopped", "quarantined"]),
}).strict();

const actorWorkspaceBindingSchema = z.object({
  actorId: actorIdSchema,
  laneId: z.string().min(8).max(128).regex(/^[a-z0-9][a-z0-9_-]+$/u),
  authority: actorLaneAuthoritySchema,
  state: z.literal("active"),
  revision: z.number().int().positive().safe(),
}).strict();

export type ActorWorkspaceRequest = z.infer<typeof actorWorkspaceRequestSchema>;
export type ActorWorkspaceBinding = z.infer<typeof actorWorkspaceBindingSchema>;

export interface ActorWorkspaceAuthorityPort {
  resolve(actorId: string): Promise<unknown>;
  bind(input: Readonly<{
    actorId: string;
    laneId: string;
    authority: "readOnlySnapshot" | "managedWrite";
  }>): Promise<unknown>;
  quarantine(input: Readonly<{
    actorId: string;
    laneId: string;
    reason: string;
  }>): Promise<void>;
}

export interface ActorWorkspaceBrokerPort {
  provision(input: Readonly<{
    runId: string;
    repositoryPath: string;
    baseSha: string;
  }>): Promise<ManagedWorkspace>;
  provisionReadOnlySnapshot(input: Readonly<{
    snapshotId: string;
    repositoryPath: string;
    sourceSha: string;
  }>): Promise<ReadOnlyWorkspace>;
}

export type ActorWorkspaceLease = Readonly<{
  actorId: string;
  authority: "readOnlySnapshot" | "managedWrite";
  binding: ActorWorkspaceBinding;
  checkoutPath: string;
  sourceSha: string;
}>;

export class ActorWorkspaceAdapterError extends Error {
  readonly code: "actor_inactive" | "authority_conflict" | "workspace_quarantined";

  constructor(code: ActorWorkspaceAdapterError["code"], cause?: unknown) {
    super({
      actor_inactive: "Only an active actor may acquire a workspace.",
      authority_conflict: "The persisted actor workspace binding conflicts.",
      workspace_quarantined: "The actor workspace is quarantined for inspection.",
    }[code], cause === undefined ? undefined : { cause });
    this.name = "ActorWorkspaceAdapterError";
    this.code = code;
  }
}

/**
 * Binds logical actors to product-owned worktrees without ever returning the
 * mutable parent checkout. Read-only actors share one detached snapshot per
 * project/source SHA. Managed-write actors receive one actor-specific lane.
 */
export class ActorWorkspaceAdapter {
  readonly #authority: ActorWorkspaceAuthorityPort;
  readonly #broker: ActorWorkspaceBrokerPort;
  readonly #provisioning = new Map<
    string,
    Promise<ManagedWorkspace | ReadOnlyWorkspace>
  >();

  constructor(input: Readonly<{
    authority: ActorWorkspaceAuthorityPort;
    broker: ActorWorkspaceBrokerPort;
  }>) {
    this.#authority = input.authority;
    this.#broker = input.broker;
  }

  async acquire(actorIdValue: unknown): Promise<ActorWorkspaceLease> {
    const actorId = actorIdSchema.parse(actorIdValue);
    const request = actorWorkspaceRequestSchema.parse(
      await this.#authority.resolve(actorId),
    );
    if (request.actorId !== actorId || request.actorState !== "active") {
      throw new ActorWorkspaceAdapterError("actor_inactive");
    }
    const laneId = request.authority === "readOnlySnapshot"
      ? deriveReadOnlySnapshotId(request.projectId, request.sourceSha)
      : deriveManagedActorLaneId(request.actorId, request.sourceSha);
    try {
      const workspace = await this.#provision(laneId, request);
      if (workspace.laneId !== laneId || workspace.baseSha !== request.sourceSha) {
        throw new ActorWorkspaceAdapterError("authority_conflict");
      }
      const binding = actorWorkspaceBindingSchema.parse(
        await this.#authority.bind({
          actorId,
          laneId,
          authority: request.authority,
        }),
      );
      if (
        binding.actorId !== actorId || binding.laneId !== laneId ||
        binding.authority !== request.authority
      ) {
        throw new ActorWorkspaceAdapterError("authority_conflict");
      }
      return Object.freeze({
        actorId,
        authority: request.authority,
        binding,
        checkoutPath: workspace.checkoutPath,
        sourceSha: request.sourceSha,
      });
    } catch (error: unknown) {
      if (!(error instanceof WorkspaceLaneQuarantinedError)) throw error;
      await this.#authority.quarantine({
        actorId,
        laneId,
        reason: error.reason,
      });
      throw new ActorWorkspaceAdapterError("workspace_quarantined", error);
    }
  }

  async #provision(
    laneId: string,
    request: ActorWorkspaceRequest,
  ): Promise<ManagedWorkspace | ReadOnlyWorkspace> {
    const current = this.#provisioning.get(laneId);
    if (current !== undefined) return await current;
    const task = request.authority === "readOnlySnapshot"
      ? this.#broker.provisionReadOnlySnapshot({
          snapshotId: laneId,
          repositoryPath: request.repositoryPath,
          sourceSha: request.sourceSha,
        })
      : this.#broker.provision({
          runId: laneId,
          repositoryPath: request.repositoryPath,
          baseSha: request.sourceSha,
        });
    this.#provisioning.set(laneId, task);
    try {
      return await task;
    } finally {
      if (this.#provisioning.get(laneId) === task) {
        this.#provisioning.delete(laneId);
      }
    }
  }
}

export function deriveReadOnlySnapshotId(
  projectIdValue: unknown,
  sourceShaValue: unknown,
): string {
  const projectId = projectIdSchema.parse(projectIdValue);
  const sourceSha = commitSchema.parse(sourceShaValue);
  return `hsnapshot_${digest("read-only", projectId, sourceSha).slice(0, 40)}`;
}

export function deriveManagedActorLaneId(
  actorIdValue: unknown,
  sourceShaValue: unknown,
): string {
  const actorId = actorIdSchema.parse(actorIdValue);
  const sourceSha = commitSchema.parse(sourceShaValue);
  return `hmanaged_${digest("managed", actorId, sourceSha).slice(0, 40)}`;
}

function digest(...parts: readonly string[]): string {
  const hasher = createHash("sha256");
  for (const part of parts) {
    hasher.update(String(Buffer.byteLength(part, "utf8")), "utf8");
    hasher.update(":", "utf8");
    hasher.update(part, "utf8");
  }
  return hasher.digest("hex");
}
