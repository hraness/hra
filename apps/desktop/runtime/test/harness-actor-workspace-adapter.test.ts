import { describe, expect, test } from "bun:test";

import {
  ActorWorkspaceAdapter,
  deriveManagedActorLaneId,
  deriveReadOnlySnapshotId,
  type ActorWorkspaceAdapterError,
  type ActorWorkspaceAuthorityPort,
  type ActorWorkspaceBinding,
  type ActorWorkspaceRequest,
} from "../src/harness/actor-workspace-adapter";
import {
  WorkspaceLaneQuarantinedError,
  type ManagedWorkspace,
  type ReadOnlyWorkspace,
} from "../src/workspaces/workspace-broker";

const sourceSha = "a".repeat(40);

class Authority implements ActorWorkspaceAuthorityPort {
  readonly requests = new Map<string, ActorWorkspaceRequest>();
  readonly bindings = new Map<string, ActorWorkspaceBinding>();
  readonly quarantines: unknown[] = [];

  resolve(actorId: string): Promise<unknown> {
    return Promise.resolve(this.requests.get(actorId) ?? null);
  }

  bind(input: Readonly<{
    actorId: string;
    laneId: string;
    authority: "readOnlySnapshot" | "managedWrite";
  }>): Promise<unknown> {
    const current = this.bindings.get(input.actorId);
    if (current !== undefined) return Promise.resolve(current);
    const binding = {
      ...input,
      state: "active" as const,
      revision: 1,
    };
    this.bindings.set(input.actorId, binding);
    return Promise.resolve(binding);
  }

  quarantine(input: Readonly<{
    actorId: string;
    laneId: string;
    reason: string;
  }>): Promise<void> {
    this.quarantines.push(input);
    return Promise.resolve();
  }
}

class Broker {
  readonly managed: unknown[] = [];
  readonly snapshots: unknown[] = [];
  quarantine = false;

  provision(input: Readonly<{
    runId: string;
    repositoryPath: string;
    baseSha: string;
  }>): Promise<ManagedWorkspace> {
    this.managed.push(input);
    return Promise.resolve({
      baseSha: input.baseSha,
      branchName: `codex/oprte-${input.runId}`,
      canonicalGitCommonDir: "/repo/.git",
      checkoutPath: `/support/${input.runId}`,
      laneId: input.runId,
      recovered: false,
    });
  }

  provisionReadOnlySnapshot(input: Readonly<{
    snapshotId: string;
    repositoryPath: string;
    sourceSha: string;
  }>): Promise<ReadOnlyWorkspace> {
    this.snapshots.push(input);
    if (this.quarantine) {
      return Promise.reject(new WorkspaceLaneQuarantinedError("dirty_checkout"));
    }
    return Promise.resolve({
      baseSha: input.sourceSha,
      canonicalGitCommonDir: "/repo/.git",
      checkoutPath: `/support/${input.snapshotId}`,
      laneId: input.snapshotId,
      recovered: false,
    });
  }
}

function request(
  actorId: string,
  authority: "readOnlySnapshot" | "managedWrite",
): ActorWorkspaceRequest {
  return {
    actorId,
    projectId: "project_example",
    repositoryPath: "/repo",
    sourceSha,
    authority,
    actorState: "active",
  };
}

describe("recursive actor workspace adapter", () => {
  test("shares one deterministic detached snapshot across read-only actors", async () => {
    const authority = new Authority();
    const broker = new Broker();
    const first = "hactor_workspacefirst1";
    const second = "hactor_workspacesecond";
    authority.requests.set(first, request(first, "readOnlySnapshot"));
    authority.requests.set(second, request(second, "readOnlySnapshot"));
    const adapter = new ActorWorkspaceAdapter({ authority, broker });

    const [left, right] = await Promise.all([
      adapter.acquire(first),
      adapter.acquire(second),
    ]);

    expect(left.binding.laneId).toBe(right.binding.laneId);
    expect(left.binding.laneId).toBe(
      deriveReadOnlySnapshotId("project_example", sourceSha),
    );
    expect(broker.managed).toHaveLength(0);
    expect(broker.snapshots).toHaveLength(1);
    expect(left.checkoutPath).not.toBe("/repo");
  });

  test("gives every managed actor a distinct stable lane", async () => {
    const authority = new Authority();
    const broker = new Broker();
    const actorId = "hactor_workspacemanage1";
    authority.requests.set(actorId, request(actorId, "managedWrite"));
    const adapter = new ActorWorkspaceAdapter({ authority, broker });

    const first = await adapter.acquire(actorId);
    const replay = await adapter.acquire(actorId);

    expect(first.binding.laneId).toBe(
      deriveManagedActorLaneId(actorId, sourceSha),
    );
    expect(replay.binding).toEqual(first.binding);
    expect(broker.managed).toHaveLength(2);
    expect(broker.snapshots).toHaveLength(0);
  });

  test("durably quarantines drift and never falls back to the parent checkout", () => {
    const authority = new Authority();
    const broker = new Broker();
    broker.quarantine = true;
    const actorId = "hactor_workspacequarantine";
    authority.requests.set(actorId, request(actorId, "readOnlySnapshot"));
    const adapter = new ActorWorkspaceAdapter({ authority, broker });

    expect(adapter.acquire(actorId)).rejects.toMatchObject({
      code: "workspace_quarantined",
    } satisfies Partial<ActorWorkspaceAdapterError>);
    expect(authority.quarantines).toEqual([{
      actorId,
      laneId: deriveReadOnlySnapshotId("project_example", sourceSha),
      reason: "dirty_checkout",
    }]);
    expect(authority.bindings.size).toBe(0);
  });

  test("rejects stopped actors before asking Git for a workspace", () => {
    const authority = new Authority();
    const broker = new Broker();
    const actorId = "hactor_workspacestopped1";
    authority.requests.set(actorId, {
      ...request(actorId, "readOnlySnapshot"),
      actorState: "stopped",
    });
    const adapter = new ActorWorkspaceAdapter({ authority, broker });

    expect(adapter.acquire(actorId)).rejects.toMatchObject({
      code: "actor_inactive",
    } satisfies Partial<ActorWorkspaceAdapterError>);
    expect(broker.snapshots).toHaveLength(0);
    expect(broker.managed).toHaveLength(0);
  });
});
