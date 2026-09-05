import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import {
  ACCOUNT_DELETION_SCHEMA_GAPS,
  ACCOUNT_DELETION_TABLE_STRATEGY,
} from "./accountDeletion";
import { HOSTED_TABLE_LIFECYCLE } from "./lifecyclePolicy";
import {
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  reserveDeviceQuotaForInsert,
  reserveNonterminalCommandQuotaForInsert,
  reserveParentAttributedQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveServiceQuotaForInsert,
  reserveSessionChunkQuotaForInsert,
  reserveSessionHeadQuotaForInsert,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type DeletionStatus = Readonly<{
  category: string;
  createdAt: number;
  jobId: string;
  replay?: boolean;
  state: string;
  statusCapability?: string;
  updatedAt: number;
}>;
type DrainResult = Readonly<{
  category?: string;
  jobId?: string;
  kind: "advanced" | "complete" | "drained" | "idle";
  processed: number;
  state?: string;
}>;

const requestDeletion = makeFunctionReference<"mutation", Args, DeletionStatus>(
  "accountDeletion:request",
);
const deletionStatus = makeFunctionReference<"query", Args, DeletionStatus>(
  "accountDeletion:status",
);
const drainDeletion = makeFunctionReference<"mutation", Args, DrainResult>(
  "accountDeletion:drain",
);
const accountCurrent = makeFunctionReference<"query", Args, unknown>("account:current");
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const jobId = "delete_job_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const statusCapability = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE";

async function deletionWorld(email = "delete-me@example.com") {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email,
      emailVerificationTime: now,
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const authSession = {
      expirationTime: now + 60 * 60 * 1_000,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "identity", authSession);
    const authSessionId = await ctx.db.insert("authSessions", authSession);
    const subject = {
      authEpoch: 1,
      createdAt: now,
      emailDigest: "a".repeat(64),
      status: "active",
      updatedAt: now,
      userId,
    } as const;
    await reserveQuotaForInsert(ctx, userId, "identity", subject);
    const subjectId = await ctx.db.insert("authSubjects", subject);
    return { authSessionId, subjectId, userId };
  });
  return {
    ...ids,
    actor: testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${ids.userId}|${ids.authSessionId}`,
      tokenIdentifier: `test|${ids.authSessionId}`,
    }),
    request: { jobId, statusCapability },
    testRuntime,
  };
}

async function startDeletion(world: Awaited<ReturnType<typeof deletionWorld>>) {
  return await world.actor.mutation(requestDeletion, world.request);
}

async function drainToCompletion(
  world: Awaited<ReturnType<typeof deletionWorld>>,
  limit = 200,
) {
  const observations: DrainResult[] = [];
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const result = await world.testRuntime.mutation(drainDeletion, { limit });
    observations.push(result);
    if (result.kind === "complete") return observations;
  }
  throw new Error("account deletion did not complete within its bounded category count");
}

describe("status-first account deletion", () => {
  test("revokes the epoch in the request transaction and exact replay creates no second job", async () => {
    const world = await deletionWorld();
    const first = await startDeletion(world);
    expect(first).toMatchObject({
      category: "commands_and_leases",
      jobId,
      replay: false,
      state: "pending",
      statusCapability,
    });

    const afterFirst = await world.testRuntime.run(async (ctx) => ({
      jobs: await ctx.db.query("accountDeletionJobs").collect(),
      subject: await ctx.db.get(world.subjectId),
    }));
    expect(afterFirst.subject).toMatchObject({ authEpoch: 2, status: "disabled" });
    expect(afterFirst.jobs).toHaveLength(1);
    expect(afterFirst.jobs[0]?.statusCapabilityDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(afterFirst)).not.toContain(statusCapability);
    expect(JSON.stringify(afterFirst)).not.toContain("delete-me@example.com");

    // Simulate a client losing the first mutation response. Its durable outbox
    // retains the client-generated job ID and capability, so exact replay can
    // prove the original request without storing the capability server-side.
    const replay = await startDeletion(world);
    expect(replay).toMatchObject({ jobId, replay: true, state: "pending" });
    expect(replay).not.toHaveProperty("statusCapability");
    expect(await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("accountDeletionJobs").collect())).toHaveLength(1);
    expect(await world.testRuntime.run(async (ctx) =>
      await ctx.db.get(world.subjectId))).toEqual(afterFirst.subject);

    await expect(world.actor.mutation(requestDeletion, {
      jobId,
      statusCapability: "Z".repeat(43),
    })).rejects.toThrow("Account deletion status is unavailable.");
    await expect(world.actor.mutation(requestDeletion, {
      jobId: "delete_job_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      statusCapability,
    })).rejects.toThrow("Account deletion status is unavailable.");

    // Every ordinary cloud read reloads the disabled subject and fails even
    // though the auth-library session row still exists for deletion replay.
    await expect(world.actor.query(accountCurrent, {}))
      .rejects.toThrow("Cloud authority is not current.");
  });

  test("status is unauthenticated, capability-gated, and contains no identity data", async () => {
    const world = await deletionWorld();
    await startDeletion(world);
    const status = await world.testRuntime.query(deletionStatus, world.request);
    expect(status).toMatchObject({
      category: "commands_and_leases",
      jobId,
      state: "pending",
    });
    expect(Object.keys(status).sort()).toEqual([
      "category",
      "createdAt",
      "jobId",
      "state",
      "updatedAt",
    ]);
    expect(JSON.stringify(status)).not.toContain(statusCapability);
    expect(JSON.stringify(status)).not.toContain("delete-me@example.com");

    const wrongCapability = { jobId, statusCapability: "Z".repeat(43) };
    const unknownJob = {
      jobId: "delete_job_unknown0000000000000000000000",
      statusCapability: "Z".repeat(43),
    };
    await expect(world.testRuntime.query(deletionStatus, wrongCapability))
      .rejects.toThrow("Account deletion status is unavailable.");
    await expect(world.testRuntime.query(deletionStatus, unknownJob))
      .rejects.toThrow("Account deletion status is unavailable.");
  });

  test("drains more than 200 immutable records without skipping or resetting category progress", async () => {
    const world = await deletionWorld();
    await world.testRuntime.run(async (ctx) => {
      const device = {
        activatedAt: Date.now(),
        authEpoch: 1,
        createdAt: Date.now(),
        encryptedLabel: {
          algorithm: "A256GCM",
          ciphertext: "ciphertext",
          keyVersion: 1,
          nonce: "nonce",
        },
        keyVersion: 1,
        publicId: "device_delete_chunks",
        revision: 1,
        signingPublicKey: "signing",
        status: "active",
        updatedAt: Date.now(),
        userId: world.userId,
        wrappingPublicKey: "wrapping",
      } as const;
      await reserveDeviceQuotaForInsert(ctx, world.userId, device);
      const deviceId = await ctx.db.insert("devices", device);
      const session = {
        compactHeadSequence: 205,
        createdAt: Date.now(),
        detailHeadSequence: 205,
        executionDeviceId: deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "session_delete_chunks",
        state: "idle",
        updatedAt: Date.now(),
        userId: world.userId,
      } as const;
      await reserveSessionHeadQuotaForInsert(ctx, world.userId, session);
      const sessionId = await ctx.db.insert("sessionHeads", session);
      const notification = {
        allowedWindowEnd: Date.now() + 60_000,
        claimDeadline: Date.now() + 60_000,
        coalesceAfter: Date.now() - 1,
        consentLeaseUntil: Date.now() + 60_000,
        createdAt: Date.now(),
        executionAuthority: {
          bootGeneration: 1,
          bootId: "boot_delete_notification",
          fence: 1,
        },
        globalNotificationGeneration: 1,
        interactionDeadline: Date.now() + 60_000,
        interactionId: "interaction_delete_notification",
        interactionKind: "command_approval",
        interactionRevision: 1,
        localNotificationPolicyRevision: 1,
        nonterminal: true,
        reconciliationSequence: 1,
        remoteActions: ["decline"] as ("answer" | "decline")[],
        sessionId,
        sessionPublicId: session.publicId,
        sourceDeviceId: deviceId,
        state: "pending",
        updatedAt: Date.now(),
        userId: world.userId,
      } as const;
      await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, notification);
      const notificationId = await ctx.db.insert("attentionNotificationOutbox", notification);
      const startedAt = Date.now();
      const startedPatch = {
        delivery: {
          attemptCount: 1,
          body: { text: "HRA needs your attention", version: 1 as const },
          bodyDigest: "b".repeat(64),
          claimedAt: startedAt,
          deadline: startedAt + 60_000,
          effectStartedAt: startedAt,
          firstAttemptAt: startedAt,
          generation: 1,
          id: "delivery_delete_notification",
          idempotencyKey: "01912345-6789-7abc-8def-0123456789c1",
          lastAttemptAt: startedAt,
          leaderRowId: notificationId,
          recipientDigest: "c".repeat(64),
        },
        state: "effect_started" as const,
        updatedAt: startedAt,
      };
      await adjustCommandQuotaForPatch(
        ctx,
        world.userId,
        notification,
        startedPatch,
      );
      await ctx.db.patch(notificationId, startedPatch);
      for (let index = 0; index < 205; index += 1) {
        const chunk = {
          authority: { bootGeneration: 1, bootId: "boot_delete_chunks", fence: 1 },
          createdAt: Date.now(),
          digest: index.toString(16).padStart(64, "0"),
          envelope: {
            algorithm: "A256GCM",
            ciphertext: `chunk_${index}`,
            keyVersion: 1,
            nonce: "nonce",
          },
          firstSequence: index + 1,
          lastSequence: index + 1,
          sessionId,
          sourceDeviceId: deviceId,
          stream: "detail",
          userId: world.userId,
        } as const;
        await reserveSessionChunkQuotaForInsert(ctx, world.userId, chunk);
        await ctx.db.insert("sessionChunks", chunk);
      }
    });
    await startDeletion(world);

    expect(await world.testRuntime.mutation(drainDeletion, { limit: 200 }))
      .toMatchObject({ category: "commands_and_leases", kind: "drained", processed: 1 });
    expect(await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect())).toEqual([]);
    expect(await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (builder) => builder
          .eq("userId", world.userId)
          .eq("resource", "nonterminal_command"))
        .unique())).toMatchObject({ records: 0 });
    expect(await world.testRuntime.mutation(drainDeletion, { limit: 200 }))
      .toMatchObject({ category: "chunks_and_epochs", kind: "advanced", processed: 0 });
    expect(await world.testRuntime.mutation(drainDeletion, { limit: 200 }))
      .toMatchObject({ category: "chunks_and_epochs", kind: "drained", processed: 200 });
    expect(await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("sessionChunks")
        .withIndex("by_user", (builder) => builder.eq("userId", world.userId))
        .collect())).toHaveLength(5);

    expect(await world.testRuntime.mutation(drainDeletion, { limit: 200 }))
      .toMatchObject({ category: "chunks_and_epochs", kind: "drained", processed: 5 });
    expect(await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("sessionChunks")
        .withIndex("by_user", (builder) => builder.eq("userId", world.userId))
        .collect())).toHaveLength(0);
    expect(await world.testRuntime.mutation(drainDeletion, { limit: 200 }))
      .toMatchObject({ category: "session_heads", kind: "advanced", processed: 0 });
  });

  test("uses indexed parent traversal for more than 200 auth refresh tokens", async () => {
    const world = await deletionWorld();
    await world.testRuntime.run(async (ctx) => {
      for (let index = 0; index < 205; index += 1) {
        const token = {
          expirationTime: Date.now() + 60_000,
          sessionId: world.authSessionId,
        };
        await reserveParentAttributedQuotaForInsert(
          ctx,
          world.userId,
          "identity",
          token,
        );
        await ctx.db.insert("authRefreshTokens", token);
      }
    });
    await startDeletion(world);
    await world.testRuntime.run(async (ctx) => {
      const job = await ctx.db.query("accountDeletionJobs").first();
      if (job === null) throw new Error("deletion job missing");
      const patch = {
        category: "auth_tokens_and_verifiers" as const,
        state: "draining" as const,
      };
      await adjustQuotaForPatch(ctx, world.userId, "job", job, patch);
      await ctx.db.patch(job._id, patch);
    });

    expect(await world.testRuntime.mutation(drainDeletion, { limit: 200 }))
      .toMatchObject({
        category: "auth_tokens_and_verifiers",
        kind: "drained",
        processed: 200,
      });
    expect(await world.testRuntime.run(async (ctx) => ({
      session: await ctx.db.get(world.authSessionId),
      tokens: await ctx.db.query("authRefreshTokens")
        .withIndex("sessionId", (builder) =>
          builder.eq("sessionId", world.authSessionId))
        .collect(),
    }))).toMatchObject({ session: { _id: world.authSessionId }, tokens: { length: 5 } });

    expect(await world.testRuntime.mutation(drainDeletion, { limit: 200 }))
      .toMatchObject({
        category: "auth_tokens_and_verifiers",
        kind: "drained",
        processed: 6,
      });
    expect(await world.testRuntime.run(async (ctx) => ({
      session: await ctx.db.get(world.authSessionId),
      tokens: await ctx.db.query("authRefreshTokens")
        .withIndex("sessionId", (builder) =>
          builder.eq("sessionId", world.authSessionId))
        .collect(),
    }))).toEqual({ session: null, tokens: [] });
  });

  test("persists category progress across repeated worker calls and completes through a receipt", async () => {
    const world = await deletionWorld();
    await world.testRuntime.run(async (ctx) => {
      const attempt = {
        authEpoch: 1,
        createdAt: Date.now(),
        emailDigest: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
        kind: "send" as const,
      };
      await reserveServiceQuotaForInsert(ctx, attempt);
      await ctx.db.insert("authEmailAttemptEvents", attempt);
      const rateLimit = {
        attemptsLeft: 4,
        identifier: "delete-me@example.com",
        lastAttemptTime: Date.now(),
      };
      await reserveServiceQuotaForInsert(ctx, rateLimit);
      await ctx.db.insert("authRateLimits", rateLimit);
      for (let index = 0; index < 5; index += 1) {
        const receipt = {
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          idempotencyKey: `idempotency_${index}`,
          operation: "fixture",
          requestDigest: index.toString(16).padStart(64, "0"),
          responseJson: "{}",
          scopeId: "fixture",
          userId: world.userId,
        };
        await reserveQuotaForInsert(ctx, world.userId, "receipt", receipt);
        await ctx.db.insert("idempotencyReceipts", receipt);
      }
    });
    await startDeletion(world);
    await world.testRuntime.run(async (ctx) => {
      const job = await ctx.db.query("accountDeletionJobs").first();
      if (job === null) throw new Error("deletion job missing");
      const patch = { category: "receipts_and_events" as const, state: "draining" as const };
      await adjustQuotaForPatch(ctx, world.userId, "job", job, patch);
      await ctx.db.patch(job._id, patch);
    });

    expect(await world.testRuntime.mutation(drainDeletion, { limit: 2 }))
      .toMatchObject({ category: "receipts_and_events", kind: "drained", processed: 2 });
    const afterFirstBatch = await world.testRuntime.query(deletionStatus, world.request);
    expect(afterFirstBatch.category).toBe("receipts_and_events");
    expect(await world.testRuntime.mutation(drainDeletion, { limit: 2 }))
      .toMatchObject({ category: "receipts_and_events", kind: "drained", processed: 2 });
    expect(await world.testRuntime.mutation(drainDeletion, { limit: 2 }))
      .toMatchObject({ category: "receipts_and_events", kind: "drained", processed: 2 });
    expect(await world.testRuntime.mutation(drainDeletion, { limit: 2 }))
      .toMatchObject({ category: "auth_tokens_and_verifiers", kind: "advanced" });

    const observations = await drainToCompletion(world, 2);
    expect(observations.at(-1)).toMatchObject({ kind: "complete", state: "complete" });
    const complete = await world.testRuntime.query(deletionStatus, world.request);
    expect(complete).toMatchObject({ category: "complete", jobId, state: "complete" });
    expect(JSON.stringify(complete)).not.toContain(statusCapability);

    const final = await world.testRuntime.run(async (ctx) => {
      const receipt = await ctx.db.query("accountDeletionReceipts")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", jobId))
        .first();
      return {
        accountResourceRows: await ctx.db.query("storageResourceUsageByAccount")
          .withIndex("by_user", (builder) => builder.eq("userId", world.userId))
          .collect(),
        job: await ctx.db.query("accountDeletionJobs")
          .withIndex("by_public_id", (builder) => builder.eq("publicId", jobId))
          .first(),
        receipt,
        resourceRows: await ctx.db.query("storageResourceUsageByUser")
          .withIndex("by_user_and_resource", (builder) => builder.eq("userId", world.userId))
          .collect(),
        service: await ctx.db.query("storageUsageService")
          .withIndex("by_key", (builder) => builder.eq("key", "global"))
          .unique(),
        subject: await ctx.db.get(world.subjectId),
        usageRows: await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (builder) => builder.eq("userId", world.userId))
          .collect(),
        user: await ctx.db.get(world.userId),
      };
    });
    expect(final).toMatchObject({ job: null, subject: null, user: null });
    expect(final.receipt).toMatchObject({ publicId: jobId });
    expect(final.receipt?.statusCapabilityDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(final.usageRows).toEqual([]);
    expect(final.resourceRows).toEqual([]);
    expect(final.accountResourceRows).toEqual([]);
    expect(final.service).toMatchObject({
      identities: 0,
      logicalBytes: logicalDocumentBytes(final.receipt ?? {}),
      records: 1,
      serviceLogicalBytes: logicalDocumentBytes(final.receipt ?? {}),
      serviceRecords: 1,
      userLogicalBytes: 0,
      userRecords: 0,
    });
    expect(JSON.stringify(final)).not.toContain(statusCapability);
    expect(JSON.stringify(final)).not.toContain("delete-me@example.com");
  });

  test("declares a bounded strategy for every hosted table", () => {
    expect(Object.keys(ACCOUNT_DELETION_TABLE_STRATEGY).sort())
      .toEqual(Object.keys(HOSTED_TABLE_LIFECYCLE).sort());
    expect(ACCOUNT_DELETION_TABLE_STRATEGY.sessionChunks)
      .toBe("user_index_immutable_erasure");
    expect(ACCOUNT_DELETION_TABLE_STRATEGY.sessionStreamEpochs)
      .toBe("user_index_immutable_erasure");
    expect(ACCOUNT_DELETION_TABLE_STRATEGY.accountDeletionReceipts)
      .toBe("capability_receipt");
    expect(ACCOUNT_DELETION_TABLE_STRATEGY.attentionNotificationSafetyFaults)
      .toBe("user_index_service_quota");
    expect(ACCOUNT_DELETION_SCHEMA_GAPS).toEqual([]);
  });

  test("erases an invite bound to the deleted email digest but issued by another user", async () => {
    const world = await deletionWorld();
    const inviteId = await world.testRuntime.run(async (ctx) => {
      const issuer = await ctx.db.insert("users", {
        email: "issuer@example.com",
        emailVerificationTime: Date.now(),
      });
      await initializeUserQuotaAuthority(ctx, issuer);
      const issuerDocument = await ctx.db.get(issuer);
      if (issuerDocument === null) throw new Error("missing invite issuer");
      await reserveQuotaForStoredIdentity(ctx, issuer, issuerDocument);
      const invite = {
        boundEmailDigest: "a".repeat(64),
        capabilityDigest: "b".repeat(64),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        issuedByUserId: issuer,
        publicId: "invite_delete_bound_email",
        purpose: "identity",
        state: "bound_to_email",
        updatedAt: Date.now(),
      } as const;
      await reserveServiceQuotaForInsert(ctx, invite);
      return await ctx.db.insert("authInvites", invite);
    });
    await startDeletion(world);
    await world.testRuntime.run(async (ctx) => {
      const job = await ctx.db.query("accountDeletionJobs").first();
      if (job === null) throw new Error("deletion job missing");
      const patch = { category: "receipts_and_events" as const, state: "draining" as const };
      await adjustQuotaForPatch(ctx, world.userId, "job", job, patch);
      await ctx.db.patch(job._id, patch);
    });
    expect(await world.testRuntime.mutation(drainDeletion, { limit: 200 }))
      .toMatchObject({ kind: "drained", processed: 1 });
    expect(await world.testRuntime.run(async (ctx) => await ctx.db.get(inviteId))).toBeNull();
  });
});
