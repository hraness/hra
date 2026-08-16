import { describe, expect, test } from "bun:test";
import { runInteractionRequestSchema } from "@hraness/agent-tasks-protocol";

import {
  decodeHRACursor,
  encodeHRACursor,
  hraPendingReplyAuthorityMatches,
  hraMutationResult,
} from "./hraHuman";

describe("HRA projection cursors", () => {
  test("round-trip the full tenant, viewer, workspace, head, and scope binding", () => {
    const cursor = encodeHRACursor({
      kind: "task_list",
      organizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      userId: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workspaceId: "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      projectionHead: 17,
      view: "assigned",
      assignedAgentId: "agt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      continuation: "convex-pagination-state",
    });

    expect(decodeHRACursor(cursor)).toEqual({
      kind: "task_list",
      organizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      userId: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workspaceId: "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      projectionHead: 17,
      view: "assigned",
      assignedAgentId: "agt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      continuation: "convex-pagination-state",
    });
  });

  test("reject malformed, truncated, and legacy repository cursor payloads", () => {
    const cursor = encodeHRACursor({
      kind: "repositories",
      organizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      userId: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workspaceId: "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      projectionHead: 9,
      continuation: "next",
    });

    expect(decodeHRACursor(`${cursor}!`)).toBeNull();
    expect(decodeHRACursor(cursor.slice(0, -4))).toBeNull();
    const legacy = `kitchen_cursor_v1_${Buffer.from(JSON.stringify({
      kind: "repositories",
      organizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      userId: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workspaceId: "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      projectionHead: 9,
      offset: 0,
    })).toString("base64url")}`;
    expect(decodeHRACursor(legacy)).toBeNull();
  });
});

describe("HRA mutation result boundary", () => {
  test("accepts a command/result pair with one authoritative projection head", () => {
    expect(hraMutationResult({
      operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workspaceId: "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      commandKind: "task.update",
      workspaceRevision: 4,
      projectionRevision: 4,
      result: {
        kind: "task_updated",
        taskId: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        taskRevision: 2,
      },
    })).toMatchObject({
      commandKind: "task.update",
      workspaceRevision: 4,
      projectionRevision: 4,
    });
  });

  test("rejects a result kind that cannot be produced by the command", () => {
    expect(() =>
      hraMutationResult({
        operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        workspaceId: "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        commandKind: "task.update",
        workspaceRevision: 4,
        projectionRevision: 4,
        result: {
          kind: "run_updated",
          runId: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          phase: "queued",
        },
      })).toThrow();
  });
});

describe("HRA pending reply authority", () => {
  test("requires every tenant, run, interaction, digest, lease, boot, and claim binding", () => {
    const requestDigest = `sha256_${"a".repeat(64)}`;
    const request = runInteractionRequestSchema.parse({
      id: "interaction_current001",
      kind: "file_change_approval",
      scope: "once",
      createdAt: 1_000,
      expiresAt: 61_000,
      reply: {
        version: 1,
        algorithm: "P256-HKDF-SHA256-A256GCM",
        keyId: `hitlkey_${"a".repeat(24)}`,
        publicKey: "A".repeat(87),
        runnerId: "runner_current001",
        bootId: "boot_current00001",
        bootGeneration: 3,
        claimId: "claim_current0001",
        claimFence: 7,
        requestDigest,
      },
    });
    const projection = {
      now: 2_000,
      authorization: {
        organizationId: "organization_current",
        workspaceId: "workspace_current",
      },
      requested: {
        runId: "run_current00001",
        interactionId: request.id,
        requestDigest,
      },
      dispatch: {
        id: "dispatch_private_current",
        organizationId: "organization_current",
        workspaceId: "workspace_current",
        publicId: "run_current00001",
        runnerId: "runner_private_current",
        runnerPublicId: request.reply.runnerId,
        bootId: request.reply.bootId,
        bootGeneration: request.reply.bootGeneration,
        claimId: request.reply.claimId,
        claimFence: request.reply.claimFence,
        leaseUntil: 20_000,
        desiredState: "run",
        phase: "waiting",
      },
      interaction: {
        organizationId: "organization_current",
        workspaceId: "workspace_current",
        dispatchId: "dispatch_private_current",
        publicId: request.id,
        runnerId: "runner_private_current",
        runnerPublicId: request.reply.runnerId,
        bootId: request.reply.bootId,
        bootGeneration: request.reply.bootGeneration,
        claimId: request.reply.claimId,
        claimFence: request.reply.claimFence,
        requestDigest,
        state: "pending",
        expiresAt: request.expiresAt,
      },
      runner: {
        id: "runner_private_current",
        organizationId: "organization_current",
        workspaceId: "workspace_current",
        publicId: request.reply.runnerId,
        bootId: request.reply.bootId,
        bootGeneration: request.reply.bootGeneration,
        leaseUntil: 20_000,
      },
      request,
    } satisfies Parameters<typeof hraPendingReplyAuthorityMatches>[0];

    expect(hraPendingReplyAuthorityMatches(projection)).toBeTrue();
    for (const mismatch of [
      {
        ...projection,
        interaction: {
          ...projection.interaction,
          workspaceId: "workspace_foreign",
        },
      },
      {
        ...projection,
        dispatch: { ...projection.dispatch, publicId: "run_stale000001" },
      },
      {
        ...projection,
        interaction: {
          ...projection.interaction,
          publicId: "interaction_stale001",
        },
      },
      {
        ...projection,
        interaction: {
          ...projection.interaction,
          requestDigest: `sha256_${"b".repeat(64)}`,
        },
      },
      {
        ...projection,
        interaction: { ...projection.interaction, state: "answered" },
      },
      {
        ...projection,
        runner: { ...projection.runner, bootGeneration: 4 },
      },
      {
        ...projection,
        interaction: { ...projection.interaction, claimFence: 8 },
      },
      {
        ...projection,
        now: projection.interaction.expiresAt,
      },
    ]) {
      expect(hraPendingReplyAuthorityMatches(mismatch)).toBeFalse();
    }
  });
});
