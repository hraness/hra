import { describe, expect, test } from "bun:test";
import { convexTest, type TestConvex } from "convex-test";

import { api, internal } from "./_generated/api";
import {
  hraOperationIdFromLegacyHostedMutationRecord,
  legacyHostedMutationOperationIdFields,
} from "./hostedMutationPersistence";
import schema from "./schema";

const WORKOS_CLIENT_ID = "client_receiptmaintenance";
const WORKOS_ORGANIZATION_ID = "org_receiptmaintenance";
const WORKOS_USER_ID = "user_receiptmaintenance";
const WORKSPACE_PUBLIC_ID = "wsp_00000000000000000000000901";

const modules = {
  "./_generated/api.ts": async () => await import("./_generated/api"),
  "./_generated/server.ts": async () => await import("./_generated/server"),
  "./hostedMutationAttempts.ts": async () =>
    await import("./hostedMutationAttempts"),
  "./receiptMaintenance.ts": async () => await import("./receiptMaintenance"),
};

async function receiptScope(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      publicId: "org_00000000000000000000000901",
      workosOrganizationId: WORKOS_ORGANIZATION_ID,
      name: "Receipt maintenance",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const principalId = await ctx.db.insert("users", {
      publicId: WORKOS_USER_ID,
      workosUserId: WORKOS_USER_ID,
      name: "Receipt owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      publicId: WORKSPACE_PUBLIC_ID,
      slug: "receipt-maintenance",
      name: "Receipt maintenance",
      taskKeyPrefix: "RM",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("organizationMemberships", {
      organizationId,
      userId: principalId,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, principalId, workspaceId };
  });
}

describe("receipt maintenance", () => {
  test("protects linked and legacy-unlinked receipts while blocking unsafe settlement", async () => {
    const t = convexTest(schema, modules);
    const scope = await receiptScope(t);
    const receipts = await t.run(async (ctx) => {
      const common = {
        principalKind: "organization" as const,
        principalId: WORKOS_USER_ID,
        organizationId: scope.organizationId,
        operation: "tasks.comments.add",
        requestDigest: "sha256_receipt_maintenance",
        responseJson: "{}",
        createdAt: 1,
        expiresAt: 1,
      };
      const linked = await ctx.db.insert("humanCommandReceipts", {
        ...common,
        idempotencyKey: "018f0f7d-8b4c-7000-8000-000000000901",
        requestId: "request_linked",
      });
      const unreferenced = await ctx.db.insert("humanCommandReceipts", {
        ...common,
        idempotencyKey: "018f0f7d-8b4c-7000-8000-000000000902",
        requestId: "request_unreferenced",
      });
      const legacyUnlinked = await ctx.db.insert("humanCommandReceipts", {
        ...common,
        idempotencyKey: "018f0f7d-8b4c-7000-8000-000000000904",
        requestId: "request_legacy_unlinked",
      });
      const agent = await ctx.db.insert("commandReceipts", {
        principalKind: "agent",
        principalId: "agent_receiptmaintenance",
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        operation: "tasks.claim",
        idempotencyKey: "018f0f7d-8b4c-7000-8000-000000000903",
        requestDigest: "sha256_agent_receipt",
        requestId: "request_agent",
        responseJson: "{}",
        createdAt: 1,
        expiresAt: 1,
      });
      await ctx.db.insert("hostedMutationAttempts", {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        workspacePublicId: "wsp_00000000000000000000000901",
        principalId: scope.principalId,
        sourceId: "oprte.web.task-workspace.v1",
        operation: "task.comment_add",
        fingerprint: `hmac_sha256_${"a".repeat(43)}`,
        fingerprintKeyVersion: "maintenance-v1",
        idempotencyKey: "018f0f7d-8b4c-7000-8000-000000000901",
        ...legacyHostedMutationOperationIdFields(
          "op_00000000000000000000000901",
        ),
        suppliedTaskId: "tsk_00000000000000000000000901",
        targetTaskId: "tsk_00000000000000000000000902",
        state: "effect-started",
        open: true,
        revision: 2,
        preparedAt: 1,
        orderKey: "0000000000000001:op_00000000000000000000000901",
        effectStartedAt: 2,
        receiptId: linked,
      });
      await ctx.db.insert("hostedMutationAttempts", {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        workspacePublicId: WORKSPACE_PUBLIC_ID,
        principalId: scope.principalId,
        sourceId: "oprte.web.task-workspace.v1",
        operation: "task.comment_add",
        fingerprint: `hmac_sha256_${"b".repeat(43)}`,
        fingerprintKeyVersion: "maintenance-v1",
        idempotencyKey: "018f0f7d-8b4c-7000-8000-000000000904",
        ...legacyHostedMutationOperationIdFields(
          "op_00000000000000000000000904",
        ),
        suppliedTaskId: "tsk_00000000000000000000000904",
        targetTaskId: "tsk_00000000000000000000000905",
        state: "effect-started",
        open: true,
        revision: 2,
        preparedAt: 1,
        orderKey: "0000000000000001:op_00000000000000000000000904",
        effectStartedAt: 2,
      });
      return { agent, legacyUnlinked, linked, unreferenced };
    });

    expect(await t.mutation(
      internal.receiptMaintenance.sweepExpiredHumanReceipts,
      {},
    )).toEqual({ deleted: 1, protected: 2, scheduled: false });
    expect(await t.mutation(
      internal.receiptMaintenance.sweepExpiredAgentReceipts,
      {},
    )).toEqual({ deleted: 1, protected: 0, scheduled: false });
    expect(await t.run(async (ctx) => ({
      agent: await ctx.db.get(receipts.agent),
      legacyUnlinked: await ctx.db.get(receipts.legacyUnlinked),
      linked: await ctx.db.get(receipts.linked),
      unreferenced: await ctx.db.get(receipts.unreferenced),
    }))).toMatchObject({
      agent: null,
      legacyUnlinked: { requestId: "request_legacy_unlinked" },
      linked: { requestId: "request_linked" },
      unreferenced: null,
    });

    const previousClientId = process.env.WORKOS_CLIENT_ID;
    process.env.WORKOS_CLIENT_ID = WORKOS_CLIENT_ID;
    try {
      const actor = t.withIdentity({
        issuer:
          `https://api.workos.com/user_management/${WORKOS_CLIENT_ID}`,
        org_id: WORKOS_ORGANIZATION_ID,
        sid: "session_receiptmaintenance",
        subject: WORKOS_USER_ID,
        tokenIdentifier: `${WORKOS_CLIENT_ID}|${WORKOS_USER_ID}`,
      });
      expect(await actor.mutation(api.hostedMutationAttempts.settle, {
        workspaceId: WORKSPACE_PUBLIC_ID,
        sourceId: "oprte.web.task-workspace.v1",
        attemptId: "op_00000000000000000000000904",
        expectedRevision: 2,
        operation: "task.comment_add",
        settlement: { kind: "cancelled", reason: "superseded" },
      })).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR" },
      });
    } finally {
      if (previousClientId === undefined) {
        delete process.env.WORKOS_CLIENT_ID;
      } else {
        process.env.WORKOS_CLIENT_ID = previousClientId;
      }
    }
    const retainedAttempt = await t.run(async (ctx) =>
      (await ctx.db.query("hostedMutationAttempts").collect())
        .find((record) =>
          hraOperationIdFromLegacyHostedMutationRecord(record) ===
            "op_00000000000000000000000904"
        )
    );
    expect(retainedAttempt).toMatchObject({
      state: "effect-started",
      open: true,
    });
    expect(retainedAttempt).not.toHaveProperty("receiptId");
  });

  test("schedules continuation after each bounded receipt page", async () => {
    const t = convexTest(schema, modules);
    const scope = await receiptScope(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 65; index += 1) {
        await ctx.db.insert("humanCommandReceipts", {
          principalKind: "organization",
          principalId: WORKOS_USER_ID,
          organizationId: scope.organizationId,
          operation: "tasks.comments.add",
          idempotencyKey:
            `018f0f7d-8b4c-7000-8000-${index.toString(16).padStart(12, "0")}`,
          requestDigest: `sha256_${String(index)}`,
          requestId: `request_${String(index)}`,
          responseJson: "{}",
          createdAt: 1,
          expiresAt: 1,
        });
      }
    });

    expect(await t.mutation(
      internal.receiptMaintenance.sweepExpiredHumanReceipts,
      {},
    )).toEqual({ deleted: 64, protected: 0, scheduled: true });
    expect(await t.run(async (ctx) => ({
      receipts: await ctx.db.query("humanCommandReceipts").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }))).toMatchObject({
      receipts: [expect.any(Object)],
      scheduled: [expect.any(Object)],
    });
  });
});
