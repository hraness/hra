import { afterEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  cutoverRequestDigestToken,
  normalizeCutoverMembership,
  normalizeCutoverOrganization,
  normalizeCutoverPromotionSession,
  normalizeCutoverUser,
  predecessorOnlyIdentityTables,
} from "./identityCutover";
import { authoritativeReceiptState } from "./hostedMutationAttempts";
import schema from "./schema";

const previousCutoverSetting = process.env.HRA_IDENTITY_CUTOVER_ENABLED;
const modules = {
  "./_generated/api.ts": async () => await import("./_generated/api"),
  "./_generated/server.ts": async () => await import("./_generated/server"),
  "./identityCutover.ts": async () => await import("./identityCutover"),
};
const predecessorCompatibilitySchema = defineSchema({
  identityWebhookReceipts: defineTable({ marker: v.string() }),
});
const cutoverCompatibilitySchema = defineSchema({
  users: defineTable({
    publicId: v.string(),
    workosUserId: v.optional(v.string()),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_workos_user_id", ["workosUserId"]),
  organizations: defineTable({
    publicId: v.string(),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
  organizationMemberships: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    status: v.union(
      v.literal("active"),
      v.literal("inactive"),
      v.literal("pending"),
      v.literal("removed"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
  workspaces: defineTable({
    organizationId: v.id("organizations"),
    publicId: v.string(),
    slug: v.string(),
    name: v.string(),
    taskKeyPrefix: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("disabled"),
      v.literal("staging"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
  workspaceMemberships: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    roles: v.array(v.union(
      v.literal("planner"),
      v.literal("reviewer"),
      v.literal("viewer"),
    )),
    status: v.union(v.literal("active"), v.literal("removed")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
  promotionSessions: defineTable({
    publicId: v.string(),
    organizationId: v.id("organizations"),
    organizationPublicId: v.string(),
    startedByUserId: v.id("users"),
    startedByWorkosUserId: v.optional(v.string()),
    startedByUserPublicId: v.optional(v.string()),
    authorizationMembershipId: v.id("organizationMemberships"),
    sourceWorkspacePublicId: v.string(),
    stagingWorkspaceId: v.id("workspaces"),
    stagingWorkspacePublicId: v.string(),
    manifestRoot: v.string(),
    manifestJson: v.string(),
    progressJson: v.string(),
    startIdempotencyKey: v.string(),
    startRequestDigest: v.string(),
    state: v.string(),
    decisionSequence: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
  suiteIdentityAliases: defineTable({
    environment: v.union(v.literal("development"), v.literal("production")),
    linkedAt: v.number(),
    localSubject: v.string(),
    state: v.union(v.literal("active"), v.literal("revoked")),
    suiteAccountId: v.string(),
    updatedAt: v.number(),
    userId: v.id("users"),
  }).index("by_local_subject", ["localSubject"]),
  suiteEntitlementProjections: defineTable({
    catalogRevision: v.string(),
    expiresAt: v.number(),
    features: v.array(v.string()),
    localSubject: v.string(),
    observedAt: v.number(),
    projectionRevision: v.number(),
    receiptDigest: v.string(),
    suiteAccountId: v.string(),
    updatedAt: v.number(),
    userId: v.id("users"),
  }).index("by_local_subject", ["localSubject"]),
  suiteIdentityLinkChallenges: defineTable({
    challengeId: v.string(),
    createdAt: v.number(),
    environment: v.union(v.literal("development"), v.literal("production")),
    expiresAt: v.number(),
    issuedAt: v.number(),
    keyVersion: v.string(),
    localSubject: v.string(),
    proofDigest: v.string(),
    state: v.union(v.literal("pending"), v.literal("consumed")),
    userId: v.id("users"),
  }),
  humanCommandReceipts: defineTable({
    principalKind: v.union(v.literal("account"), v.literal("organization")),
    principalId: v.string(),
    organizationId: v.optional(v.id("organizations")),
    operation: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.union(v.bytes(), v.string()),
    requestId: v.string(),
    responseJson: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_principal_operation_key", [
    "principalKind",
    "principalId",
    "organizationId",
    "operation",
    "idempotencyKey",
  ]),
  hostedMutationAttempts: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    workspacePublicId: v.string(),
    principalId: v.id("users"),
    sourceId: v.string(),
    operation: v.string(),
    fingerprint: v.string(),
    fingerprintKeyVersion: v.string(),
    idempotencyKey: v.string(),
    oprteOperationId: v.string(),
    suppliedTaskId: v.string(),
    targetTaskId: v.optional(v.string()),
    state: v.literal("effect-started"),
    open: v.literal(true),
    revision: v.literal(2),
    preparedAt: v.number(),
    orderKey: v.string(),
    effectStartedAt: v.number(),
    receiptId: v.optional(v.id("humanCommandReceipts")),
  }).index("by_receipt", ["receiptId"]),
});

afterEach(() => {
  if (previousCutoverSetting === undefined) delete process.env.HRA_IDENTITY_CUTOVER_ENABLED;
  else process.env.HRA_IDENTITY_CUTOVER_ENABLED = previousCutoverSetting;
});

describe("identity cutover normalization", () => {
  test("strips predecessor fields without changing stable identity or authority references", () => {
    const userId = "k1700000000000000000000000" as Id<"users">;
    const organizationId = "k2700000000000000000000000" as Id<"organizations">;
    const membershipId = "k3700000000000000000000000";
    const workspaceId = "k4700000000000000000000000";
    const vaultId = "k5700000000000000000000000";
    const scheduleId = "k6700000000000000000000000";
    const user = normalizeCutoverUser({
      _id: userId,
      _creationTime: 1,
      publicId: "user_existing_public_id_must_survive",
      workosUserId: "provider_user_to_strip",
      name: "Existing human",
      email: "existing@example.com",
      status: "active",
      createdAt: 10,
      updatedAt: 20,
    });
    const organization = normalizeCutoverOrganization({
      _id: organizationId,
      _creationTime: 2,
      publicId: "org_existing_public_id_must_survive",
      workosOrganizationId: "provider_org_to_strip",
      workosExternalId: "provider_external_to_strip",
      name: "Existing tenant",
      status: "active",
      createdAt: 11,
      updatedAt: 21,
    });
    const membership = normalizeCutoverMembership({
      _id: membershipId,
      _creationTime: 3,
      organizationId,
      userId,
      workosMembershipId: "provider_membership_to_strip",
      workosRoleSlugs: ["admin"],
      role: "owner",
      status: "active",
      createdAt: 12,
      updatedAt: 22,
    });
    const promotionSession = normalizeCutoverPromotionSession({
      _id: "promotion_session_id",
      _creationTime: 4,
      publicId: "promotion_public_id",
      startedByUserId: userId,
      startedByWorkosUserId: "provider_user_to_strip",
      manifestJson: "{\"stable\":true}",
    }, "user_existing_public_id_must_survive");
    const untouchedAuthorityRows = {
      vault: { _id: vaultId, organizationId, userId, generation: 7 },
      schedule: {
        _id: scheduleId,
        organizationId,
        workspaceId,
        userId,
        vaultId,
      },
    };

    expect(user).toEqual({
      publicId: "user_existing_public_id_must_survive",
      name: "Existing human",
      email: "existing@example.com",
      status: "active",
      createdAt: 10,
      updatedAt: 20,
    });
    expect(organization).toEqual({
      publicId: "org_existing_public_id_must_survive",
      name: "Existing tenant",
      status: "active",
      createdAt: 11,
      updatedAt: 21,
    });
    expect(membership).toEqual({
      organizationId,
      userId,
      role: "owner",
      status: "active",
      createdAt: 12,
      updatedAt: 22,
    });
    expect(promotionSession).toEqual({
      publicId: "promotion_public_id",
      startedByUserId: userId,
      startedByUserPublicId: "user_existing_public_id_must_survive",
      manifestJson: "{\"stable\":true}",
    });
    expect(untouchedAuthorityRows).toEqual({
      vault: { _id: vaultId, organizationId, userId, generation: 7 },
      schedule: {
        _id: scheduleId,
        organizationId,
        workspaceId,
        userId,
        vaultId,
      },
    });
  });

  test("fails closed by disabling incomplete provider tenants", () => {
    for (const status of ["provisioning", "failed", "disabled"] as const) {
      expect(normalizeCutoverOrganization({
        publicId: `org_${status}`,
        name: status,
        status,
        createdAt: 1,
        updatedAt: 2,
      })).toMatchObject({ status: "disabled" });
    }
  });

  test("enumerates every predecessor-only table for the staged purge", () => {
    expect(predecessorOnlyIdentityTables).toEqual([
      "workosMembershipRetirements",
      "identityWebhookReceipts",
      "identityReconciliationState",
      "identityReconciliationQuarantines",
      "accountProvisioningOperations",
    ]);
  });

  test("keeps exact document IDs and rejects writes unless the cutover gate is explicit", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {
        publicId: "user_existing_public_id_must_survive",
        name: "Existing human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const organizationId = await ctx.db.insert("organizations", {
        publicId: "org_existing_public_id_must_survive",
        name: "Existing tenant",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("organizationMemberships", {
        organizationId,
        userId,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { membershipId, organizationId, userId };
    });

    delete process.env.HRA_IDENTITY_CUTOVER_ENABLED;
    await expect(t.mutation(internal.identityCutover.replaceExactUser, {
      userId: seeded.userId,
      expectedPublicId: "user_existing_public_id_must_survive",
    })).rejects.toThrow("Identity cutover writes are disabled");

    process.env.HRA_IDENTITY_CUTOVER_ENABLED = "replace-exact-rows";
    await t.mutation(internal.identityCutover.replaceExactUser, {
      userId: seeded.userId,
      expectedPublicId: "user_existing_public_id_must_survive",
    });
    await t.mutation(internal.identityCutover.replaceExactOrganization, {
      organizationId: seeded.organizationId,
      expectedPublicId: "org_existing_public_id_must_survive",
    });
    await t.mutation(internal.identityCutover.replaceExactMembership, {
      membershipId: seeded.membershipId,
      expectedOrganizationId: seeded.organizationId,
      expectedUserId: seeded.userId,
    });
    expect(await t.run(async (ctx) => ({
      membership: await ctx.db.get(seeded.membershipId),
      organization: await ctx.db.get(seeded.organizationId),
      user: await ctx.db.get(seeded.userId),
    }))).toMatchObject({
      membership: { _id: seeded.membershipId, userId: seeded.userId },
      organization: {
        _id: seeded.organizationId,
        publicId: "org_existing_public_id_must_survive",
      },
      user: { _id: seeded.userId, publicId: "user_existing_public_id_must_survive" },
    });
  });

  test("migrates every predecessor subject in place while preserving authority and recovery manifests", async () => {
    const t = convexTest(cutoverCompatibilitySchema, modules);
    const now = Date.now();
    const oldSubject = "provider_user_subject";
    const newSubject = "user_01J3B9W4XQ1M6N8VKY7R2T5P0A";
    const digest = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        publicId: newSubject,
        workosUserId: oldSubject,
        name: "Existing human",
        status: "active",
        createdAt: now - 100,
        updatedAt: now - 100,
      });
      const organizationId = await ctx.db.insert("organizations", {
        publicId: "org_existing",
        name: "Existing tenant",
        status: "active",
        createdAt: now - 100,
        updatedAt: now - 100,
      });
      const membershipId = await ctx.db.insert("organizationMemberships", {
        organizationId,
        userId,
        role: "owner",
        status: "active",
        createdAt: now - 90,
        updatedAt: now - 90,
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        organizationId,
        publicId: "wsp_existing",
        slug: "existing",
        name: "Existing workspace",
        taskKeyPrefix: "EX",
        status: "staging",
        createdAt: now - 80,
        updatedAt: now - 80,
      });
      const workspaceMembershipId = await ctx.db.insert("workspaceMemberships", {
        organizationId,
        workspaceId,
        userId,
        roles: ["planner", "reviewer"],
        status: "active",
        createdAt: now - 70,
        updatedAt: now - 70,
      });
      const promotionSessionId = await ctx.db.insert("promotionSessions", {
        publicId: "promotion_existing",
        organizationId,
        organizationPublicId: "org_existing",
        startedByUserId: userId,
        startedByWorkosUserId: oldSubject,
        authorizationMembershipId: membershipId,
        sourceWorkspacePublicId: "wsp_source",
        stagingWorkspaceId: workspaceId,
        stagingWorkspacePublicId: "wsp_existing",
        manifestRoot: "manifest-root",
        manifestJson: "{\"stable\":true}",
        progressJson: "{\"cursor\":7}",
        startIdempotencyKey: "promotion-key",
        startRequestDigest: "promotion-digest",
        state: "receiving",
        decisionSequence: 3,
        createdAt: now - 60,
        updatedAt: now - 60,
      });
      const aliasId = await ctx.db.insert("suiteIdentityAliases", {
        environment: "production",
        linkedAt: now - 50,
        localSubject: oldSubject,
        state: "active",
        suiteAccountId: "suite_existing",
        updatedAt: now - 50,
        userId,
      });
      const projectionId = await ctx.db.insert("suiteEntitlementProjections", {
        catalogRevision: "suite-catalog-v2",
        expiresAt: now + 100_000,
        features: ["suite.paid"],
        localSubject: oldSubject,
        observedAt: now - 40,
        projectionRevision: 9,
        receiptDigest: "suite-receipt-digest",
        suiteAccountId: "suite_existing",
        updatedAt: now - 40,
        userId,
      });
      const pendingChallengeId = await ctx.db.insert("suiteIdentityLinkChallenges", {
        challengeId: "pending-challenge",
        createdAt: now - 30,
        environment: "production",
        expiresAt: now + 30_000,
        issuedAt: now - 30,
        keyVersion: "suite-key-v1",
        localSubject: oldSubject,
        proofDigest: "pending-proof",
        state: "pending",
        userId,
      });
      const consumedChallengeId = await ctx.db.insert("suiteIdentityLinkChallenges", {
        challengeId: "consumed-challenge",
        createdAt: now - 20,
        environment: "production",
        expiresAt: now + 30_000,
        issuedAt: now - 20,
        keyVersion: "suite-key-v1",
        localSubject: oldSubject,
        proofDigest: "consumed-proof",
        state: "consumed",
        userId,
      });
      const receiptId = await ctx.db.insert("humanCommandReceipts", {
        principalKind: "organization",
        principalId: oldSubject,
        organizationId,
        operation: "tasks.create",
        idempotencyKey: "receipt-key",
        requestDigest: digest,
        requestId: "request-existing",
        responseJson: "{\"taskId\":\"task_existing\"}",
        createdAt: now - 10,
        expiresAt: now + 60_000,
      });
      const attemptId = await ctx.db.insert("hostedMutationAttempts", {
        organizationId,
        workspaceId,
        workspacePublicId: "wsp_existing",
        principalId: userId,
        sourceId: "desktop-existing",
        operation: "task.create",
        fingerprint: "fingerprint-existing",
        fingerprintKeyVersion: "fingerprint-v1",
        idempotencyKey: "receipt-key",
        oprteOperationId: "operation-existing",
        suppliedTaskId: "task-existing",
        state: "effect-started",
        open: true,
        revision: 2,
        preparedAt: now - 12,
        orderKey: "0000000000000:existing",
        effectStartedAt: now - 11,
        receiptId,
      });
      const expiredReceiptId = await ctx.db.insert("humanCommandReceipts", {
        principalKind: "organization",
        principalId: oldSubject,
        organizationId,
        operation: "tasks.comments.add",
        idempotencyKey: "expired-recovery-key",
        requestDigest: "expired-recovery-digest",
        requestId: "request-expired-recovery",
        responseJson: "{\"commentId\":\"comment_existing\"}",
        createdAt: now - 80_000,
        expiresAt: now - 1,
      });
      const unlinkedAttemptId = await ctx.db.insert("hostedMutationAttempts", {
        organizationId,
        workspaceId,
        workspacePublicId: "wsp_existing",
        principalId: userId,
        sourceId: "desktop-expired-recovery",
        operation: "task.comment_add",
        fingerprint: "fingerprint-expired-recovery",
        fingerprintKeyVersion: "fingerprint-v1",
        idempotencyKey: "expired-recovery-key",
        oprteOperationId: "operation-expired-recovery",
        suppliedTaskId: "task-expired-recovery",
        state: "effect-started",
        open: true,
        revision: 2,
        preparedAt: now - 80_100,
        orderKey: "0000000000001:expired-recovery",
        effectStartedAt: now - 80_050,
      });
      return {
        aliasId,
        attemptId,
        consumedChallengeId,
        expiredReceiptId,
        membershipId,
        organizationId,
        pendingChallengeId,
        projectionId,
        promotionSessionId,
        receiptId,
        unlinkedAttemptId,
        userId,
        workspaceId,
        workspaceMembershipId,
      };
    });

    const authorityTables = [
      "workspaces",
      "workspaceMemberships",
      "promotionSessions",
      "suiteIdentityAliases",
      "suiteEntitlementProjections",
      "humanCommandReceipts",
      "hostedMutationAttempts",
    ] as const;
    const manifestsBefore = new Map<string, readonly string[]>();
    for (const table of authorityTables) {
      const page = await t.query(internal.identityCutover.authorityPage, { table });
      expect(page.isDone).toBe(true);
      manifestsBefore.set(table, page.bindings);
    }
    expect(JSON.parse(manifestsBefore.get("workspaces")![0]!)).toEqual({
      id: seeded.workspaceId,
      organizationId: seeded.organizationId,
      publicId: "wsp_existing",
      status: "staging",
    });
    expect(JSON.parse(manifestsBefore.get("workspaceMemberships")![0]!)).toEqual({
      id: seeded.workspaceMembershipId,
      organizationId: seeded.organizationId,
      workspaceId: seeded.workspaceId,
      userId: seeded.userId,
      roles: ["planner", "reviewer"],
      status: "active",
    });
    expect(manifestsBefore.get("promotionSessions")![0]).not.toContain(
      "{\"stable\":true}",
    );
    expect(manifestsBefore.get("humanCommandReceipts")![0]).not.toContain(
      "task_existing",
    );
    expect(JSON.parse(manifestsBefore.get("promotionSessions")![0]!))
      .toHaveProperty("documentDigest");
    expect(JSON.parse(manifestsBefore.get("humanCommandReceipts")![0]!))
      .toHaveProperty("documentDigest");

    for (const table of [
      "suiteIdentityAliases",
      "suiteEntitlementProjections",
      "suiteIdentityLinkChallenges",
    ] as const) {
      const page = await t.query(internal.identityCutover.subjectMismatchPage, {
        table,
        now,
      });
      expect(page.mismatches.length).toBe(1);
      expect(page.mismatches[0]).toMatchObject({
        table,
        currentSubject: oldSubject,
        expectedSubject: newSubject,
        userId: seeded.userId,
      });
    }
    const receiptMismatches = await t.query(
      internal.identityCutover.subjectMismatchPage,
      { table: "humanCommandReceipts", now },
    );
    expect(receiptMismatches.mismatches).toHaveLength(2);
    expect(receiptMismatches.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: seeded.receiptId,
        currentSubject: oldSubject,
        expectedSubject: newSubject,
        reason: "subject_changed",
      }),
      expect.objectContaining({
        documentId: seeded.expiredReceiptId,
        currentSubject: oldSubject,
        expectedSubject: newSubject,
        reason: "subject_changed",
      }),
    ]));
    const attemptMismatches = await t.query(
      internal.identityCutover.subjectMismatchPage,
      { table: "hostedMutationAttempts", now },
    );
    expect(attemptMismatches.mismatches).toHaveLength(2);
    expect(attemptMismatches.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: seeded.attemptId,
        currentSubject: oldSubject,
        expectedSubject: newSubject,
        reason: "subject_changed",
      }),
      expect.objectContaining({
        documentId: seeded.unlinkedAttemptId,
        currentSubject: oldSubject,
        expectedSubject: newSubject,
        receiptId: seeded.expiredReceiptId,
        reason: "unlinked_receipt",
      }),
    ]));
    expect((await t.query(internal.identityCutover.legacyShapePage, {
      table: "promotionSessions",
    })).documentIds).toEqual([seeded.promotionSessionId]);

    process.env.HRA_IDENTITY_CUTOVER_ENABLED = "replace-exact-rows";
    await t.mutation(internal.identityCutover.replaceExactPromotionSessionActor, {
      promotionSessionId: seeded.promotionSessionId,
      expectedPublicId: "promotion_existing",
      expectedOrganizationId: seeded.organizationId,
      expectedStartedByUserId: seeded.userId,
      expectedOldSubject: oldSubject,
      expectedNewSubject: newSubject,
      expectedAuthorizationMembershipId: seeded.membershipId,
      expectedStagingWorkspaceId: seeded.workspaceId,
    });
    await t.mutation(internal.identityCutover.replaceExactSuiteIdentityAliasSubject, {
      aliasId: seeded.aliasId,
      expectedUserId: seeded.userId,
      expectedOldSubject: oldSubject,
      expectedNewSubject: newSubject,
      expectedSuiteAccountId: "suite_existing",
    });
    await t.mutation(internal.identityCutover.replaceExactSuiteEntitlementSubject, {
      projectionId: seeded.projectionId,
      expectedUserId: seeded.userId,
      expectedOldSubject: oldSubject,
      expectedNewSubject: newSubject,
      expectedSuiteAccountId: "suite_existing",
      expectedReceiptDigest: "suite-receipt-digest",
      expectedProjectionRevision: 9,
    });
    await t.mutation(internal.identityCutover.purgeExactPendingSuiteIdentityChallenge, {
      challengeDocumentId: seeded.pendingChallengeId,
      expectedChallengeId: "pending-challenge",
      expectedUserId: seeded.userId,
      expectedOldSubject: oldSubject,
      expectedCreatedAt: now - 30,
      expectedExpiresAt: now + 30_000,
    });
    await expect(t.mutation(
      internal.identityCutover.purgeExactPendingSuiteIdentityChallenge,
      {
        challengeDocumentId: seeded.consumedChallengeId,
        expectedChallengeId: "consumed-challenge",
        expectedUserId: seeded.userId,
        expectedOldSubject: oldSubject,
        expectedCreatedAt: now - 20,
        expectedExpiresAt: now + 30_000,
      },
    )).rejects.toThrow("suite challenge binding changed");
    const attemptManifest = manifestsBefore.get("hostedMutationAttempts")!
      .map((binding) => JSON.parse(binding))
      .find((binding) => binding.id === seeded.unlinkedAttemptId)!;
    const expiredReceiptManifest = manifestsBefore.get("humanCommandReceipts")!
      .map((binding) => JSON.parse(binding))
      .find((binding) => binding.id === seeded.expiredReceiptId)!;
    const exactUnlinkedReceiptArgs = {
      attemptId: seeded.unlinkedAttemptId,
      receiptId: seeded.expiredReceiptId,
      expectedUserId: seeded.userId,
      expectedOldPrincipalId: oldSubject,
      expectedNewPrincipalId: newSubject,
      expectedOrganizationId: seeded.organizationId,
      expectedWorkspaceId: seeded.workspaceId,
      expectedWorkspacePublicId: "wsp_existing",
      expectedSourceId: "desktop-expired-recovery",
      expectedAttemptOperation: "task.comment_add",
      expectedFingerprint: "fingerprint-expired-recovery",
      expectedFingerprintKeyVersion: "fingerprint-v1",
      expectedIdempotencyKey: "expired-recovery-key",
      expectedReceiptOperation: "tasks.comments.add",
      expectedRequestDigest: "string:expired-recovery-digest",
      expectedRequestId: "request-expired-recovery",
      expectedReceiptExpiresAt: now - 1,
      expectedAttemptDocumentDigest: attemptManifest.documentDigest,
      expectedReceiptDocumentDigest: expiredReceiptManifest.documentDigest,
    };
    await expect(t.mutation(
      internal.identityCutover.linkExactHostedMutationReceipt,
      { ...exactUnlinkedReceiptArgs, expectedAttemptDocumentDigest: "wrong" },
    )).rejects.toThrow("hosted receipt binding changed");
    await t.mutation(
      internal.identityCutover.linkExactHostedMutationReceipt,
      exactUnlinkedReceiptArgs,
    );
    await expect(t.mutation(internal.identityCutover.replaceExactHumanReceiptPrincipal, {
      receiptId: seeded.receiptId,
      expectedUserId: seeded.userId,
      expectedOldPrincipalId: oldSubject,
      expectedNewPrincipalId: newSubject,
      expectedPrincipalKind: "organization",
      expectedOrganizationId: seeded.organizationId,
      expectedOperation: "tasks.create",
      expectedIdempotencyKey: "receipt-key",
      expectedRequestDigest: "bytes:00000000",
      expectedRequestId: "request-existing",
      expectedExpiresAt: now + 60_000,
    })).rejects.toThrow("receipt binding changed");
    await t.mutation(internal.identityCutover.replaceExactHumanReceiptPrincipal, {
      receiptId: seeded.receiptId,
      expectedUserId: seeded.userId,
      expectedOldPrincipalId: oldSubject,
      expectedNewPrincipalId: newSubject,
      expectedPrincipalKind: "organization",
      expectedOrganizationId: seeded.organizationId,
      expectedOperation: "tasks.create",
      expectedIdempotencyKey: "receipt-key",
      expectedRequestDigest: cutoverRequestDigestToken(digest),
      expectedRequestId: "request-existing",
      expectedExpiresAt: now + 60_000,
    });

    const after = await t.run(async (ctx) => ({
      alias: await ctx.db.get(seeded.aliasId),
      attempt: await ctx.db.get(seeded.attemptId),
      expiredReceipt: await ctx.db.get(seeded.expiredReceiptId),
      recoveredAttempt: await ctx.db.get(seeded.unlinkedAttemptId),
      consumedChallenge: await ctx.db.get(seeded.consumedChallengeId),
      pendingChallenge: await ctx.db.get(seeded.pendingChallengeId),
      projection: await ctx.db.get(seeded.projectionId),
      promotion: await ctx.db.get(seeded.promotionSessionId),
      receipt: await ctx.db.get(seeded.receiptId),
    }));
    expect(after).toMatchObject({
      alias: { _id: seeded.aliasId, localSubject: newSubject },
      attempt: {
        _id: seeded.attemptId,
        principalId: seeded.userId,
        receiptId: seeded.receiptId,
      },
      consumedChallenge: {
        _id: seeded.consumedChallengeId,
        localSubject: oldSubject,
        state: "consumed",
      },
      pendingChallenge: null,
      expiredReceipt: {
        _id: seeded.expiredReceiptId,
        principalId: newSubject,
        expiresAt: now - 1,
      },
      projection: { _id: seeded.projectionId, localSubject: newSubject },
      promotion: {
        _id: seeded.promotionSessionId,
        startedByUserId: seeded.userId,
        startedByUserPublicId: newSubject,
      },
      receipt: {
        _id: seeded.receiptId,
        principalId: newSubject,
        requestId: "request-existing",
      },
      recoveredAttempt: {
        _id: seeded.unlinkedAttemptId,
        principalId: seeded.userId,
        receiptId: seeded.expiredReceiptId,
        state: "effect-started",
      },
    });
    expect("startedByWorkosUserId" in after.promotion!).toBe(false);
    expect(cutoverRequestDigestToken(after.receipt!.requestDigest)).toBe(
      cutoverRequestDigestToken(digest),
    );
    expect(after.receipt!.responseJson).toBe(
      "{\"taskId\":\"task_existing\"}",
    );
    expect(after.receipt!.expiresAt).toBe(now + 60_000);
    const recoveryState = await t.run(async (ctx) => {
      const attempt = await ctx.db.get(seeded.unlinkedAttemptId);
      if (attempt === null) throw new Error("Missing recovered hosted attempt.");
      return await authoritativeReceiptState(ctx, attempt);
    });
    expect(recoveryState).toEqual({
      kind: "present",
      commandKind: "task.comment_add",
      receiptId: seeded.expiredReceiptId,
    });

    for (const table of authorityTables) {
      const page = await t.query(internal.identityCutover.authorityPage, { table });
      expect(page.bindings).toEqual([...manifestsBefore.get(table)!]);
    }
    for (const table of [
      "suiteIdentityAliases",
      "suiteEntitlementProjections",
      "suiteIdentityLinkChallenges",
      "humanCommandReceipts",
      "hostedMutationAttempts",
    ] as const) {
      expect((await t.query(internal.identityCutover.subjectMismatchPage, {
        table,
        now,
      })).mismatches).toEqual([]);
    }
    expect((await t.query(internal.identityCutover.legacyShapePage, {
      table: "promotionSessions",
    })).documentIds).toEqual([]);
  });

  test("links a retained current-subject receipt without requiring a subject rewrite", async () => {
    const t = convexTest(cutoverCompatibilitySchema, modules);
    const now = Date.now();
    const subject = "user_current_subject";
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        publicId: subject,
        name: "Current subject human",
        status: "active",
        createdAt: now - 100,
        updatedAt: now - 100,
      });
      const organizationId = await ctx.db.insert("organizations", {
        publicId: "org_current_subject",
        name: "Current subject tenant",
        status: "active",
        createdAt: now - 100,
        updatedAt: now - 100,
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        organizationId,
        publicId: "wsp_current_subject",
        slug: "current-subject",
        name: "Current subject workspace",
        taskKeyPrefix: "CS",
        status: "active",
        createdAt: now - 90,
        updatedAt: now - 90,
      });
      const receiptId = await ctx.db.insert("humanCommandReceipts", {
        principalKind: "organization",
        principalId: subject,
        organizationId,
        operation: "tasks.update",
        idempotencyKey: "current-subject-recovery-key",
        requestDigest: "current-subject-digest",
        requestId: "request-current-subject",
        responseJson: "{\"taskId\":\"task_current\"}",
        createdAt: now - 80_000,
        expiresAt: now - 1,
      });
      const attemptId = await ctx.db.insert("hostedMutationAttempts", {
        organizationId,
        workspaceId,
        workspacePublicId: "wsp_current_subject",
        principalId: userId,
        sourceId: "desktop-current-subject",
        operation: "task.update",
        fingerprint: "fingerprint-current-subject",
        fingerprintKeyVersion: "fingerprint-v1",
        idempotencyKey: "current-subject-recovery-key",
        oprteOperationId: "operation-current-subject",
        suppliedTaskId: "task-current-subject",
        state: "effect-started",
        open: true,
        revision: 2,
        preparedAt: now - 80_100,
        orderKey: "0000000000002:current-subject",
        effectStartedAt: now - 80_050,
      });
      return { attemptId, organizationId, receiptId, userId, workspaceId };
    });
    const receiptManifestBefore = await t.query(
      internal.identityCutover.authorityPage,
      { table: "humanCommandReceipts" },
    );
    const attemptManifestBefore = await t.query(
      internal.identityCutover.authorityPage,
      { table: "hostedMutationAttempts" },
    );
    const receiptBinding = JSON.parse(receiptManifestBefore.bindings[0]!);
    const attemptBinding = JSON.parse(attemptManifestBefore.bindings[0]!);
    expect((await t.query(internal.identityCutover.subjectMismatchPage, {
      table: "humanCommandReceipts",
      now,
    })).mismatches).toEqual([]);
    expect((await t.query(internal.identityCutover.subjectMismatchPage, {
      table: "hostedMutationAttempts",
      now,
    })).mismatches).toEqual([expect.objectContaining({
      documentId: seeded.attemptId,
      currentSubject: subject,
      expectedSubject: subject,
      receiptId: seeded.receiptId,
      reason: "unlinked_receipt",
    })]);

    process.env.HRA_IDENTITY_CUTOVER_ENABLED = "replace-exact-rows";
    await t.mutation(internal.identityCutover.linkExactHostedMutationReceipt, {
      attemptId: seeded.attemptId,
      receiptId: seeded.receiptId,
      expectedUserId: seeded.userId,
      expectedOldPrincipalId: subject,
      expectedNewPrincipalId: subject,
      expectedOrganizationId: seeded.organizationId,
      expectedWorkspaceId: seeded.workspaceId,
      expectedWorkspacePublicId: "wsp_current_subject",
      expectedSourceId: "desktop-current-subject",
      expectedAttemptOperation: "task.update",
      expectedFingerprint: "fingerprint-current-subject",
      expectedFingerprintKeyVersion: "fingerprint-v1",
      expectedIdempotencyKey: "current-subject-recovery-key",
      expectedReceiptOperation: "tasks.update",
      expectedRequestDigest: "string:current-subject-digest",
      expectedRequestId: "request-current-subject",
      expectedReceiptExpiresAt: now - 1,
      expectedAttemptDocumentDigest: attemptBinding.documentDigest,
      expectedReceiptDocumentDigest: receiptBinding.documentDigest,
    });

    expect((await t.query(internal.identityCutover.authorityPage, {
      table: "humanCommandReceipts",
    })).bindings).toEqual(receiptManifestBefore.bindings);
    expect((await t.query(internal.identityCutover.authorityPage, {
      table: "hostedMutationAttempts",
    })).bindings).toEqual(attemptManifestBefore.bindings);
    expect((await t.query(internal.identityCutover.subjectMismatchPage, {
      table: "hostedMutationAttempts",
      now,
    })).mismatches).toEqual([]);
    const recoveryState = await t.run(async (ctx) => {
      const attempt = await ctx.db.get(seeded.attemptId);
      if (attempt === null) throw new Error("Missing linked hosted attempt.");
      return await authoritativeReceiptState(ctx, attempt);
    });
    expect(recoveryState).toEqual({
      kind: "present",
      commandKind: "task.update",
      receiptId: seeded.receiptId,
    });
  });

  test("rejects a receipt subject shared by different predecessor and current users", async () => {
    const t = convexTest(cutoverCompatibilitySchema, modules);
    const now = Date.now();
    const collidingSubject = "user_cross_namespace_collision";
    const preservedSubject = "user_preserved_owner";
    const seeded = await t.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        publicId: preservedSubject,
        workosUserId: collidingSubject,
        name: "Preserved owner",
        status: "active",
        createdAt: now - 100,
        updatedAt: now - 100,
      });
      const collidingUserId = await ctx.db.insert("users", {
        publicId: collidingSubject,
        name: "Colliding current user",
        status: "active",
        createdAt: now - 90,
        updatedAt: now - 90,
      });
      const organizationId = await ctx.db.insert("organizations", {
        publicId: "org_cross_namespace",
        name: "Cross namespace tenant",
        status: "active",
        createdAt: now - 80,
        updatedAt: now - 80,
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        organizationId,
        publicId: "wsp_cross_namespace",
        slug: "cross-namespace",
        name: "Cross namespace workspace",
        taskKeyPrefix: "CN",
        status: "active",
        createdAt: now - 70,
        updatedAt: now - 70,
      });
      const regularReceiptId = await ctx.db.insert("humanCommandReceipts", {
        principalKind: "organization",
        principalId: collidingSubject,
        organizationId,
        operation: "tasks.update",
        idempotencyKey: "cross-namespace-regular",
        requestDigest: "cross-namespace-regular-digest",
        requestId: "request-cross-namespace-regular",
        responseJson: "{\"taskId\":\"task_regular\"}",
        createdAt: now - 60,
        expiresAt: now + 60_000,
      });
      const hostedReceiptId = await ctx.db.insert("humanCommandReceipts", {
        principalKind: "organization",
        principalId: collidingSubject,
        organizationId,
        operation: "tasks.comments.add",
        idempotencyKey: "cross-namespace-hosted",
        requestDigest: "cross-namespace-hosted-digest",
        requestId: "request-cross-namespace-hosted",
        responseJson: "{\"commentId\":\"comment_hosted\"}",
        createdAt: now - 50,
        expiresAt: now - 1,
      });
      const attemptId = await ctx.db.insert("hostedMutationAttempts", {
        organizationId,
        workspaceId,
        workspacePublicId: "wsp_cross_namespace",
        principalId: ownerUserId,
        sourceId: "desktop-cross-namespace",
        operation: "task.comment_add",
        fingerprint: "fingerprint-cross-namespace",
        fingerprintKeyVersion: "fingerprint-v1",
        idempotencyKey: "cross-namespace-hosted",
        oprteOperationId: "operation-cross-namespace",
        suppliedTaskId: "task-cross-namespace",
        state: "effect-started",
        open: true,
        revision: 2,
        preparedAt: now - 55,
        orderKey: "0000000000003:cross-namespace",
        effectStartedAt: now - 54,
      });
      return {
        attemptId,
        collidingUserId,
        hostedReceiptId,
        organizationId,
        ownerUserId,
        regularReceiptId,
        workspaceId,
      };
    });
    const receiptMismatches = await t.query(
      internal.identityCutover.subjectMismatchPage,
      { table: "humanCommandReceipts", now },
    );
    expect(receiptMismatches.mismatches).toHaveLength(2);
    for (const mismatch of receiptMismatches.mismatches) {
      expect(mismatch).toMatchObject({
        currentSubject: collidingSubject,
        userId: seeded.ownerUserId,
        expectedSubject: preservedSubject,
        reason: "subject_collision",
      });
    }
    expect((await t.query(internal.identityCutover.subjectMismatchPage, {
      table: "hostedMutationAttempts",
      now,
    })).mismatches).toEqual([expect.objectContaining({
      documentId: seeded.attemptId,
      currentSubject: collidingSubject,
      userId: seeded.ownerUserId,
      expectedSubject: preservedSubject,
      receiptId: seeded.hostedReceiptId,
      reason: "subject_collision",
    })]);
    const attemptBinding = JSON.parse((await t.query(
      internal.identityCutover.authorityPage,
      { table: "hostedMutationAttempts" },
    )).bindings[0]!);
    const hostedReceiptBinding = (await t.query(
      internal.identityCutover.authorityPage,
      { table: "humanCommandReceipts" },
    )).bindings.map((binding) => JSON.parse(binding))
      .find((binding) => binding.id === seeded.hostedReceiptId)!;

    process.env.HRA_IDENTITY_CUTOVER_ENABLED = "replace-exact-rows";
    await expect(t.mutation(
      internal.identityCutover.replaceExactHumanReceiptPrincipal,
      {
        receiptId: seeded.regularReceiptId,
        expectedUserId: seeded.ownerUserId,
        expectedOldPrincipalId: collidingSubject,
        expectedNewPrincipalId: preservedSubject,
        expectedPrincipalKind: "organization",
        expectedOrganizationId: seeded.organizationId,
        expectedOperation: "tasks.update",
        expectedIdempotencyKey: "cross-namespace-regular",
        expectedRequestDigest: "string:cross-namespace-regular-digest",
        expectedRequestId: "request-cross-namespace-regular",
        expectedExpiresAt: now + 60_000,
      },
    )).rejects.toThrow("receipt binding changed");
    await expect(t.mutation(
      internal.identityCutover.linkExactHostedMutationReceipt,
      {
        attemptId: seeded.attemptId,
        receiptId: seeded.hostedReceiptId,
        expectedUserId: seeded.ownerUserId,
        expectedOldPrincipalId: collidingSubject,
        expectedNewPrincipalId: preservedSubject,
        expectedOrganizationId: seeded.organizationId,
        expectedWorkspaceId: seeded.workspaceId,
        expectedWorkspacePublicId: "wsp_cross_namespace",
        expectedSourceId: "desktop-cross-namespace",
        expectedAttemptOperation: "task.comment_add",
        expectedFingerprint: "fingerprint-cross-namespace",
        expectedFingerprintKeyVersion: "fingerprint-v1",
        expectedIdempotencyKey: "cross-namespace-hosted",
        expectedReceiptOperation: "tasks.comments.add",
        expectedRequestDigest: "string:cross-namespace-hosted-digest",
        expectedRequestId: "request-cross-namespace-hosted",
        expectedReceiptExpiresAt: now - 1,
        expectedAttemptDocumentDigest: attemptBinding.documentDigest,
        expectedReceiptDocumentDigest: hostedReceiptBinding.documentDigest,
      },
    )).rejects.toThrow("hosted receipt binding changed");
    const unchanged = await t.run(async (ctx) => ({
      attempt: await ctx.db.get(seeded.attemptId),
      hostedReceipt: await ctx.db.get(seeded.hostedReceiptId),
      regularReceipt: await ctx.db.get(seeded.regularReceiptId),
    }));
    expect(unchanged).toMatchObject({
      attempt: { _id: seeded.attemptId },
      hostedReceipt: { principalId: collidingSubject },
      regularReceipt: { principalId: collidingSubject },
    });
    expect(unchanged.attempt).not.toHaveProperty("receiptId");
    expect(seeded.collidingUserId).not.toBe(seeded.ownerUserId);
  });

  test("fails closed on suite-subject and receipt-key collisions", async () => {
    const t = convexTest(cutoverCompatibilitySchema, modules);
    const now = Date.now();
    const oldSubject = "provider_collision_subject";
    const newSubject = "user_collision_public";
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        publicId: newSubject,
        workosUserId: oldSubject,
        name: "Collision human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const organizationId = await ctx.db.insert("organizations", {
        publicId: "org_collision",
        name: "Collision tenant",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const aliasId = await ctx.db.insert("suiteIdentityAliases", {
        environment: "production",
        linkedAt: now,
        localSubject: oldSubject,
        state: "active",
        suiteAccountId: "suite_collision",
        updatedAt: now,
        userId,
      });
      await ctx.db.insert("suiteIdentityAliases", {
        environment: "production",
        linkedAt: now,
        localSubject: newSubject,
        state: "revoked",
        suiteAccountId: "suite_conflict",
        updatedAt: now,
        userId,
      });
      const projectionId = await ctx.db.insert("suiteEntitlementProjections", {
        catalogRevision: "suite-catalog-v2",
        expiresAt: now + 10_000,
        features: ["suite.paid"],
        localSubject: oldSubject,
        observedAt: now,
        projectionRevision: 1,
        receiptDigest: "old-digest",
        suiteAccountId: "suite_collision",
        updatedAt: now,
        userId,
      });
      await ctx.db.insert("suiteEntitlementProjections", {
        catalogRevision: "suite-catalog-v2",
        expiresAt: now + 10_000,
        features: ["suite.paid"],
        localSubject: newSubject,
        observedAt: now,
        projectionRevision: 2,
        receiptDigest: "conflict-digest",
        suiteAccountId: "suite_conflict",
        updatedAt: now,
        userId,
      });
      const receiptId = await ctx.db.insert("humanCommandReceipts", {
        principalKind: "organization",
        principalId: oldSubject,
        organizationId,
        operation: "tasks.update",
        idempotencyKey: "collision-key",
        requestDigest: "old-request-digest",
        requestId: "old-request",
        responseJson: "{}",
        createdAt: now,
        expiresAt: now + 10_000,
      });
      await ctx.db.insert("humanCommandReceipts", {
        principalKind: "organization",
        principalId: newSubject,
        organizationId,
        operation: "tasks.update",
        idempotencyKey: "collision-key",
        requestDigest: "new-request-digest",
        requestId: "new-request",
        responseJson: "{}",
        createdAt: now,
        expiresAt: now + 10_000,
      });
      return { aliasId, organizationId, projectionId, receiptId, userId };
    });
    process.env.HRA_IDENTITY_CUTOVER_ENABLED = "replace-exact-rows";

    await expect(t.mutation(
      internal.identityCutover.replaceExactSuiteIdentityAliasSubject,
      {
        aliasId: seeded.aliasId,
        expectedUserId: seeded.userId,
        expectedOldSubject: oldSubject,
        expectedNewSubject: newSubject,
        expectedSuiteAccountId: "suite_collision",
      },
    )).rejects.toThrow("collided");
    await expect(t.mutation(
      internal.identityCutover.replaceExactSuiteEntitlementSubject,
      {
        projectionId: seeded.projectionId,
        expectedUserId: seeded.userId,
        expectedOldSubject: oldSubject,
        expectedNewSubject: newSubject,
        expectedSuiteAccountId: "suite_collision",
        expectedReceiptDigest: "old-digest",
        expectedProjectionRevision: 1,
      },
    )).rejects.toThrow("collided");
    await expect(t.mutation(
      internal.identityCutover.replaceExactHumanReceiptPrincipal,
      {
        receiptId: seeded.receiptId,
        expectedUserId: seeded.userId,
        expectedOldPrincipalId: oldSubject,
        expectedNewPrincipalId: newSubject,
        expectedPrincipalKind: "organization",
        expectedOrganizationId: seeded.organizationId,
        expectedOperation: "tasks.update",
        expectedIdempotencyKey: "collision-key",
        expectedRequestDigest: "string:old-request-digest",
        expectedRequestId: "old-request",
        expectedExpiresAt: now + 10_000,
      },
    )).rejects.toThrow("receipt principal collided");
    expect(await t.run(async (ctx) => ({
      alias: (await ctx.db.get(seeded.aliasId))!.localSubject,
      projection: (await ctx.db.get(seeded.projectionId))!.localSubject,
      receipt: (await ctx.db.get(seeded.receiptId))!.principalId,
    }))).toEqual({
      alias: oldSubject,
      projection: oldSubject,
      receipt: oldSubject,
    });
  });

  test("purges only one exact exported predecessor row behind its separate gate", async () => {
    const t = convexTest(predecessorCompatibilitySchema, modules);
    const rowId = await t.run(async (ctx) =>
      await ctx.db.insert("identityWebhookReceipts", { marker: "exported" })
    );
    const creationTime = await t.run(async (ctx) => (await ctx.db.get(rowId))!._creationTime);

    process.env.HRA_IDENTITY_CUTOVER_ENABLED = "replace-exact-rows";
    await expect(t.mutation(internal.identityCutover.purgeExactPredecessorRow, {
      table: "identityWebhookReceipts",
      documentId: rowId,
      expectedCreationTime: creationTime,
    })).rejects.toThrow("Identity cutover purge is disabled");

    process.env.HRA_IDENTITY_CUTOVER_ENABLED = "purge-exported-predecessor-rows";
    await expect(t.mutation(internal.identityCutover.purgeExactPredecessorRow, {
      table: "identityWebhookReceipts",
      documentId: rowId,
      expectedCreationTime: creationTime + 1,
    })).rejects.toThrow("Identity cutover purge binding changed");
    await t.mutation(internal.identityCutover.purgeExactPredecessorRow, {
      table: "identityWebhookReceipts",
      documentId: rowId,
      expectedCreationTime: creationTime,
    });
    expect(await t.run(async (ctx) => await ctx.db.get(rowId))).toBeNull();
  });
});
