import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";
import { convexTest } from "convex-test";

import schema from "./schema";
import { modules } from "./test.setup";
import {
  ACCOUNT_RESOURCE_QUOTAS,
  CATEGORY_QUOTAS,
  SERVICE_TOTAL_QUOTA,
  USER_RESOURCE_QUOTAS,
  USER_TOTAL_QUOTA,
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  adjustServiceQuotaForPatch,
  finalizeUserQuotaAuthorityForDelete,
  initializeAccountUsageQuotaAuthority,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  nextQuotaSnapshot,
  nextResourceRecords,
  releaseQuotaForDelete,
  releaseQuotaForStoredIdentity,
  releaseServiceQuotaForDelete,
  reserveAccountUsageSnapshotQuotaForInsert,
  reserveCodexAccountQuotaForInsert,
  reserveDeviceQuotaForInsert,
  reserveNonterminalCommandQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveServiceQuotaForInsert,
  reserveSessionChunkQuotaForInsert,
  reserveSessionHeadQuotaForInsert,
} from "./quota";
import type { QuotaCategory } from "./quota";

type Args = Readonly<Record<string, Value>>;
type PresenceResponse = Readonly<{ online: boolean; sequence: number | null }>;

const genesisHardAuthority = makeFunctionReference<
  "mutation",
  Record<string, never>,
  Readonly<{ enforcement: "hard" }>
>("quota:genesisHardAuthority");
const connect = makeFunctionReference<"mutation", Args, PresenceResponse>("presence:connect");
const heartbeat = makeFunctionReference<"mutation", Args, PresenceResponse>("presence:heartbeat");
const auditDirectTablePage = makeFunctionReference<"query", Args, Readonly<{
  continueCursor: string;
  isDone: boolean;
  logicalBytes: number;
  records: number;
}>>("quota:auditDirectTablePage");

const envelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "ciphertext",
  keyVersion: 1,
  nonce: "nonce",
};

async function quotaWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisHardAuthority, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "quota@example.com",
      emailVerificationTime: now,
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const authSession = {
      expirationTime: now + 3_600_000,
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
    await ctx.db.insert("authSubjects", subject);
    const device = {
      activatedAt: now,
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      encryptedLabel: envelope,
      keyVersion: 1,
      publicId: "device_quota_test",
      revision: 1,
      signingPublicKey: "fixture",
      status: "active",
      updatedAt: now,
      userId,
      wrappingPublicKey: "fixture",
    } as const;
    await reserveDeviceQuotaForInsert(ctx, userId, device);
    const deviceId = await ctx.db.insert("devices", device);
    const deviceSession = {
      authEpoch: 1,
      authSessionId,
      boundAt: now,
      deviceId,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "custody", deviceSession);
    await ctx.db.insert("deviceSessions", deviceSession);
    return { authSessionId, deviceId, userId };
  });
  return {
    ...ids,
    actor: testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${ids.userId}|${ids.authSessionId}`,
      tokenIdentifier: `test|${ids.authSessionId}`,
    }),
    testRuntime,
  };
}

type QuotaRuntime = Awaited<ReturnType<typeof quotaWorld>>["testRuntime"];

async function categoryUsageFor(
  testRuntime: QuotaRuntime,
  userId: Id<"users">,
  category: QuotaCategory,
) {
  return await testRuntime.run(async (ctx) => await ctx.db.query("storageUsageByUser")
    .withIndex("by_user_and_category", (builder) => builder
      .eq("userId", userId)
      .eq("category", category))
    .unique());
}

async function userResourceFor(
  testRuntime: QuotaRuntime,
  userId: Id<"users">,
  resource: keyof typeof USER_RESOURCE_QUOTAS,
) {
  return await testRuntime.run(async (ctx) =>
    await ctx.db.query("storageResourceUsageByUser")
      .withIndex("by_user_and_resource", (builder) => builder
        .eq("userId", userId)
        .eq("resource", resource))
      .unique());
}

describe("hosted quota authority", () => {
  test("uses Convex UTF-8 canonicalization and deterministic system overhead", () => {
    expect(logicalDocumentBytes({ text: "é🙂", userId: "u" })).toBe(86);
    expect(logicalDocumentBytes({ text: "é🙂", userId: "u", ignored: undefined })).toBe(86);
    expect(logicalDocumentBytes({
      _creationTime: 1,
      _id: "x".repeat(32),
      text: "é🙂",
      userId: "u",
    })).toBe(86);
  });

  test("accepts exact aggregate and resource boundaries and rejects the next unit", () => {
    const categoryLimit = CATEGORY_QUOTAS.device;
    const exact = nextQuotaSnapshot({
      category: {
        logicalBytes: categoryLimit.logicalBytes - 1,
        records: categoryLimit.records - 1,
      },
      service: { identities: 0, logicalBytes: 0, records: 0 },
      user: { logicalBytes: 0, records: 0 },
    }, { logicalBytes: 1, records: 1 }, "device", "hard");
    expect(exact.category).toEqual(categoryLimit);
    expect(() => nextQuotaSnapshot(exact, { logicalBytes: 0, records: 1 }, "device", "hard"))
      .toThrow("QUOTA_EXCEEDED");
    expect(() => nextQuotaSnapshot({
      category: { logicalBytes: 1, records: 1 },
      service: {
        identities: SERVICE_TOTAL_QUOTA.identities,
        logicalBytes: SERVICE_TOTAL_QUOTA.logicalBytes,
        records: SERVICE_TOTAL_QUOTA.records,
      },
      user: {
        logicalBytes: USER_TOTAL_QUOTA.logicalBytes,
        records: USER_TOTAL_QUOTA.records,
      },
    }, { logicalBytes: 1, records: 0 }, "chunk", "hard")).toThrow("QUOTA_EXCEEDED");
    for (const limit of Object.values(USER_RESOURCE_QUOTAS)) {
      expect(nextResourceRecords(limit - 1, 1, limit)).toBe(limit);
      expect(() => nextResourceRecords(limit, 1, limit)).toThrow("QUOTA_EXCEEDED");
      expect(() => nextResourceRecords(limit + 1, -1, limit))
        .toThrow("QUOTA_AUTHORITY_CORRUPT");
    }
    const accountLimit = ACCOUNT_RESOURCE_QUOTAS.usage_snapshot;
    expect(nextResourceRecords(accountLimit - 1, 1, accountLimit)).toBe(accountLimit);
    expect(() => nextResourceRecords(accountLimit, 1, accountLimit))
      .toThrow("QUOTA_EXCEEDED");
  });

  test("hard genesis requires a pristine deployment and is one-shot under races", async () => {
    const clean = convexTest(schema, modules);
    expect(await clean.mutation(genesisHardAuthority, {})).toEqual({ enforcement: "hard" });
    expect(await clean.run(async (ctx) => await ctx.db.query("storageUsageService").unique()))
      .toMatchObject({ enforcement: "hard", identities: 0, logicalBytes: 0, records: 0 });
    await expect(clean.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_ALREADY_EXISTS");

    const nonempty = convexTest(schema, modules);
    await nonempty.run(async (ctx) => await ctx.db.insert("users", {}));
    await expect(nonempty.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_NOT_EMPTY");

    const rateLimited = convexTest(schema, modules);
    await rateLimited.run(async (ctx) => await ctx.db.insert("authRateLimits", {
      attemptsLeft: 1,
      identifier: "genesis-rate-limit",
      lastAttemptTime: 1,
    }));
    await expect(rateLimited.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_NOT_EMPTY");

    const attempted = convexTest(schema, modules);
    await attempted.run(async (ctx) => await ctx.db.insert("authEmailAttemptEvents", {
      authEpoch: 1,
      createdAt: 1,
      emailDigest: "0".repeat(64),
      expiresAt: 2,
      kind: "send",
    }));
    await expect(attempted.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_NOT_EMPTY");

    const historicalShadow = convexTest(schema, modules);
    await historicalShadow.run(async (ctx) => await ctx.db.insert("storageUsageService", {
      enforcement: "shadow",
      identities: 0,
      key: "global",
      logicalBytes: 0,
      records: 0,
      serviceLogicalBytes: 0,
      serviceRecords: 0,
      updatedAt: Date.now(),
      userLogicalBytes: 0,
      userRecords: 0,
    }));
    await expect(historicalShadow.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_ALREADY_EXISTS");

    const racing = convexTest(schema, modules);
    const results = await Promise.allSettled([
      racing.mutation(genesisHardAuthority, {}),
      racing.mutation(genesisHardAuthority, {}),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await racing.run(async (ctx) => await ctx.db.query("storageUsageService").collect()))
      .toHaveLength(1);
  });

  test("persists the identity total and removes empty user authority exactly", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisHardAuthority, {});
    const userId = await runtime.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        email: "identity-ledger@example.com",
        emailVerificationTime: 1,
      });
      await initializeUserQuotaAuthority(ctx, id);
      const user = await ctx.db.get(id);
      if (user === null) throw new Error("missing identity fixture");
      await reserveQuotaForStoredIdentity(ctx, id, user);
      return id;
    });
    expect(await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique()))
      .toMatchObject({ identities: 1, userRecords: 1 });
    await runtime.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing identity fixture");
      await releaseQuotaForStoredIdentity(ctx, userId, user);
      await finalizeUserQuotaAuthorityForDelete(ctx, userId);
      await ctx.db.delete(userId);
    });
    expect(await runtime.run(async (ctx) => ({
      categories: await ctx.db.query("storageUsageByUser").collect(),
      resources: await ctx.db.query("storageResourceUsageByUser").collect(),
      service: await ctx.db.query("storageUsageService").unique(),
      user: await ctx.db.get(userId),
    }))).toMatchObject({
      categories: [],
      resources: [],
      service: {
        identities: 0,
        logicalBytes: 0,
        records: 0,
        userLogicalBytes: 0,
        userRecords: 0,
      },
      user: null,
    });
  });

  test("presence is category-charged but excluded from the device resource cap", async () => {
    const world = await quotaWorld();
    const beforeCategory = await categoryUsageFor(
      world.testRuntime,
      world.userId,
      "device",
    );
    const beforeResource = await userResourceFor(
      world.testRuntime,
      world.userId,
      "device",
    );
    const args = {
      connectionId: "quota_connection",
      credentialGeneration: 1,
      fingerprint: "1".repeat(64),
      sequence: 0,
    };
    await world.actor.mutation(connect, args);
    const presence = await world.testRuntime.run(async (ctx) =>
      (await ctx.db.query("devicePresence").collect())[0]);
    expect(await categoryUsageFor(world.testRuntime, world.userId, "device"))
      .toMatchObject({
        logicalBytes: (beforeCategory?.logicalBytes ?? 0)
          + logicalDocumentBytes(presence ?? {}),
        records: (beforeCategory?.records ?? 0) + 1,
      });
    expect(await userResourceFor(world.testRuntime, world.userId, "device"))
      .toEqual(beforeResource);
    await world.actor.mutation(connect, args);
    await world.actor.mutation(heartbeat, {
      ...args,
      fingerprint: "2".repeat(64),
      sequence: 1,
    });
    expect(await userResourceFor(world.testRuntime, world.userId, "device"))
      .toEqual(beforeResource);
  });

  test("serializes concurrent device admission at the exact resource boundary", async () => {
    const world = await quotaWorld();
    const insertDevice = async (index: number) => await world.testRuntime.run(async (ctx) => {
      const document = {
        authEpoch: 1,
        createdAt: index,
        credentialGeneration: 1,
        encryptedLabel: envelope,
        keyVersion: 1,
        publicId: `quota_device_${index.toString().padStart(2, "0")}`,
        revision: 1,
        signingPublicKey: "fixture",
        status: "pending" as const,
        updatedAt: index,
        userId: world.userId,
        wrappingPublicKey: "fixture",
      };
      await reserveDeviceQuotaForInsert(ctx, world.userId, document);
      return await ctx.db.insert("devices", document);
    });
    for (let index = 1; index < USER_RESOURCE_QUOTAS.device - 1; index += 1) {
      await insertDevice(index);
    }
    const results = await Promise.allSettled([insertDevice(16), insertDevice(17)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await userResourceFor(world.testRuntime, world.userId, "device"))
      .toMatchObject({ records: USER_RESOURCE_QUOTAS.device });
    expect(await world.testRuntime.run(async (ctx) => await ctx.db.query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", world.userId))
      .collect())).toHaveLength(USER_RESOURCE_QUOTAS.device);
  });

  test("session chunk resource accepts the exact 250,000th row atomically", async () => {
    const world = await quotaWorld();
    const sessionId = await world.testRuntime.run(async (ctx) => {
      const document = {
        compactHeadSequence: 0,
        createdAt: Date.now(),
        detailHeadSequence: 0,
        executionDeviceId: world.deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "quota_resource_session",
        state: "idle",
        updatedAt: Date.now(),
        userId: world.userId,
      } as const;
      await reserveSessionHeadQuotaForInsert(ctx, world.userId, document);
      const id = await ctx.db.insert("sessionHeads", document);
      const resource = await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (builder) => builder
          .eq("userId", world.userId)
          .eq("resource", "session_chunk"))
        .unique();
      if (resource === null) throw new Error("missing resource fixture");
      await ctx.db.patch(resource._id, { records: USER_RESOURCE_QUOTAS.session_chunk - 1 });
      return id;
    });
    const insertChunk = async (sequence: number) => await world.testRuntime.run(async (ctx) => {
      const document = {
        authority: { bootGeneration: 1, bootId: "quota_boot", fence: 1 },
        createdAt: Date.now(),
        digest: sequence.toString(16).padStart(64, "0"),
        envelope,
        firstSequence: sequence,
        lastSequence: sequence,
        sessionId,
        sourceDeviceId: world.deviceId,
        stream: "detail" as const,
        userId: world.userId,
      };
      await reserveSessionChunkQuotaForInsert(ctx, world.userId, document);
      await ctx.db.insert("sessionChunks", document);
    });
    await insertChunk(1);
    expect(await userResourceFor(world.testRuntime, world.userId, "session_chunk"))
      .toMatchObject({ records: USER_RESOURCE_QUOTAS.session_chunk });
    await expect(insertChunk(2)).rejects.toThrow("QUOTA_EXCEEDED");
    expect(await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("sessionChunks").collect())).toHaveLength(1);
    expect(await categoryUsageFor(world.testRuntime, world.userId, "chunk"))
      .toMatchObject({ records: 1 });
  });

  test("usage snapshot caps are isolated per Codex account", async () => {
    const world = await quotaWorld();
    const [accountA, accountB] = await world.testRuntime.run(async (ctx) => {
      const createAccount = async (publicId: string) => {
        const document = {
          createdAt: Date.now(),
          encryptedMetadata: envelope,
          matchKey: publicId.padEnd(64, "0"),
          publicId,
          updatedAt: Date.now(),
          userId: world.userId,
        };
        await reserveCodexAccountQuotaForInsert(ctx, world.userId, document);
        const accountId = await ctx.db.insert("codexAccounts", document);
        await initializeAccountUsageQuotaAuthority(ctx, world.userId, accountId);
        return accountId;
      };
      return [await createAccount("quota_account_a"), await createAccount("quota_account_b")];
    });
    await world.testRuntime.run(async (ctx) => {
      const usage = await ctx.db.query("storageResourceUsageByAccount")
        .withIndex("by_account_and_resource", (builder) => builder
          .eq("accountId", accountA)
          .eq("resource", "usage_snapshot"))
        .unique();
      if (usage === null) throw new Error("missing account resource fixture");
      await ctx.db.patch(usage._id, { records: ACCOUNT_RESOURCE_QUOTAS.usage_snapshot });
    });
    const insertSnapshot = async (accountId: Id<"codexAccounts">, revision: number) =>
      await world.testRuntime.run(async (ctx) => {
        const document = {
          accountId,
          createdAt: Date.now(),
          digest: revision.toString(16).padStart(64, "0"),
          envelope,
          observedAt: Date.now(),
          receivedAt: Date.now(),
          sourceDeviceId: world.deviceId,
          sourceDevicePublicId: "device_quota_test",
          sourceRevision: revision,
          userId: world.userId,
        };
        await reserveAccountUsageSnapshotQuotaForInsert(
          ctx,
          world.userId,
          accountId,
          document,
        );
        await ctx.db.insert("accountUsageSnapshots", document);
      });
    await expect(insertSnapshot(accountA, 1)).rejects.toThrow("QUOTA_EXCEEDED");
    await insertSnapshot(accountB, 1);
    const rows = await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("storageResourceUsageByAccount").collect());
    expect(rows.find((row) => row.accountId === accountA)?.records)
      .toBe(ACCOUNT_RESOURCE_QUOTAS.usage_snapshot);
    expect(rows.find((row) => row.accountId === accountB)?.records).toBe(1);
  });

  test("nonterminal command count releases once on the first terminal transition", async () => {
    const world = await quotaWorld();
    const commandId = await world.testRuntime.run(async (ctx) => {
      const session = {
        compactHeadSequence: 0,
        createdAt: Date.now(),
        detailHeadSequence: 0,
        executionDeviceId: world.deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "quota_command_session",
        state: "idle",
        updatedAt: Date.now(),
        userId: world.userId,
      } as const;
      await reserveSessionHeadQuotaForInsert(ctx, world.userId, session);
      const sessionId = await ctx.db.insert("sessionHeads", session);
      const document = {
        createdAt: Date.now(),
        deadline: Date.now() + 60_000,
        idempotencyKey: "0198f56e-7b00-7000-8000-000000000001",
        kind: "send" as const,
        nonterminal: true,
        payload: envelope,
        publicId: "0198f56e-7b00-7000-8000-000000000002",
        requestDigest: "b".repeat(64),
        requestingDeviceId: world.deviceId,
        sessionId,
        state: "pending" as const,
        targetDeviceId: world.deviceId,
        updatedAt: Date.now(),
        userId: world.userId,
      };
      await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, document);
      return await ctx.db.insert("sessionCommands", document);
    });
    expect(await userResourceFor(world.testRuntime, world.userId, "nonterminal_command"))
      .toMatchObject({ records: 1 });
    for (let replay = 0; replay < 2; replay += 1) {
      await world.testRuntime.run(async (ctx) => {
        const command = await ctx.db.get(commandId);
        if (command === null) throw new Error("missing command fixture");
        const patch = {
          nonterminal: false,
          state: "cancelled" as const,
          updatedAt: Date.now(),
        };
        await adjustCommandQuotaForPatch(ctx, world.userId, command, patch);
        await ctx.db.patch(commandId, patch);
      });
      expect(await userResourceFor(world.testRuntime, world.userId, "nonterminal_command"))
        .toMatchObject({ records: 0 });
    }
  });

  test("hard writes close on missing, duplicate, and corrupt resource authority", async () => {
    const missingService = convexTest(schema, modules);
    const userId = await missingService.run(async (ctx) => await ctx.db.insert("users", {}));
    await expect(missingService.run(async (ctx) =>
      await initializeUserQuotaAuthority(ctx, userId)))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const assertBroken = async (
      mutate: (runtime: QuotaRuntime, userId: Id<"users">) => Promise<void>,
    ) => {
      const world = await quotaWorld();
      await mutate(world.testRuntime, world.userId);
      await expect(world.testRuntime.run(async (ctx) =>
        await reserveSessionChunkQuotaForInsert(ctx, world.userId, {
          marker: "not_inserted",
          userId: world.userId,
        }))).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    };
    await assertBroken(async (runtime, id) => await runtime.run(async (ctx) => {
      const row = await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (builder) => builder
          .eq("userId", id)
          .eq("resource", "session_chunk"))
        .unique();
      if (row !== null) await ctx.db.delete(row._id);
    }));
    await assertBroken(async (runtime, id) => await runtime.run(async (ctx) => {
      await ctx.db.insert("storageResourceUsageByUser", {
        records: 0,
        resource: "session_chunk",
        updatedAt: Date.now(),
        userId: id,
      });
    }));
    await assertBroken(async (runtime, id) => await runtime.run(async (ctx) => {
      const row = await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (builder) => builder
          .eq("userId", id)
          .eq("resource", "session_chunk"))
        .unique();
      if (row === null) throw new Error("missing corrupt fixture");
      await ctx.db.patch(row._id, { records: -1 });
    }));
  });

  test("generic insert, patch, and delete preserve exact hard ledgers", async () => {
    const world = await quotaWorld();
    const eventId = await world.testRuntime.run(async (ctx) => {
      const document = {
        actorDeviceId: world.deviceId,
        createdAt: Date.now(),
        entityId: "quota_event",
        event: "command_enqueued" as const,
        userId: world.userId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "security", document);
      return await ctx.db.insert("securityEvents", document);
    });
    let stored = await world.testRuntime.run(async (ctx) => await ctx.db.get(eventId));
    expect(await categoryUsageFor(world.testRuntime, world.userId, "security"))
      .toMatchObject({ logicalBytes: logicalDocumentBytes(stored ?? {}), records: 1 });
    await world.testRuntime.run(async (ctx) => {
      if (stored === null) throw new Error("missing event fixture");
      const patch = { entityId: "quota_event_with_more_bytes" };
      await adjustQuotaForPatch(ctx, world.userId, "security", stored, patch);
      await ctx.db.patch(eventId, patch);
    });
    stored = await world.testRuntime.run(async (ctx) => await ctx.db.get(eventId));
    expect(await categoryUsageFor(world.testRuntime, world.userId, "security"))
      .toMatchObject({ logicalBytes: logicalDocumentBytes(stored ?? {}), records: 1 });
    await world.testRuntime.run(async (ctx) => {
      if (stored === null) throw new Error("missing event fixture");
      await releaseQuotaForDelete(ctx, world.userId, "security", stored);
      await ctx.db.delete(eventId);
    });
    expect(await categoryUsageFor(world.testRuntime, world.userId, "security"))
      .toMatchObject({ logicalBytes: 0, records: 0 });
  });

  test("service-owned quota preserves replay, partition, underflow, and ceiling laws", async () => {
    const missing = convexTest(schema, modules);
    await expect(missing.run(async (ctx) =>
      await reserveServiceQuotaForInsert(ctx, { marker: "missing" })))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const duplicate = convexTest(schema, modules);
    const serviceAuthority = {
      enforcement: "hard" as const,
      identities: 0,
      key: "global" as const,
      logicalBytes: 0,
      records: 0,
      serviceLogicalBytes: 0,
      serviceRecords: 0,
      updatedAt: 1,
      userLogicalBytes: 0,
      userRecords: 0,
    };
    await duplicate.run(async (ctx) => {
      await ctx.db.insert("storageUsageService", serviceAuthority);
      await ctx.db.insert("storageUsageService", serviceAuthority);
    });
    await expect(duplicate.run(async (ctx) =>
      await reserveServiceQuotaForInsert(ctx, { marker: "duplicate" })))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const corruptRuntime = convexTest(schema, modules);
    await corruptRuntime.mutation(genesisHardAuthority, {});
    await corruptRuntime.run(async (ctx) => {
      const service = await ctx.db.query("storageUsageService").unique();
      if (service === null) throw new Error("missing corrupt service fixture");
      await ctx.db.patch(service._id, { serviceRecords: 1 });
    });
    await expect(corruptRuntime.run(async (ctx) =>
      await reserveServiceQuotaForInsert(ctx, { marker: "corrupt" })))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisHardAuthority, {});
    const document = {
      completedAt: 1,
      expiresAt: 2,
      publicId: "service_receipt_quota",
      statusCapabilityDigest: "f".repeat(64),
    };
    const insertOnce = async () => await runtime.run(async (ctx) => {
      const existing = await ctx.db.query("accountDeletionReceipts")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", document.publicId))
        .unique();
      if (existing !== null) return existing._id;
      await reserveServiceQuotaForInsert(ctx, document);
      return await ctx.db.insert("accountDeletionReceipts", document);
    });
    const receiptId = await insertOnce();
    expect(await insertOnce()).toBe(receiptId);
    let stored = await runtime.run(async (ctx) => await ctx.db.get(receiptId));
    let chargedBytes = logicalDocumentBytes(stored ?? {});
    let charged = await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique());
    expect(charged).toMatchObject({
      logicalBytes: chargedBytes,
      records: 1,
      serviceLogicalBytes: chargedBytes,
      serviceRecords: 1,
      userLogicalBytes: 0,
      userRecords: 0,
    });
    await runtime.run(async (ctx) => {
      if (stored === null) throw new Error("missing service quota fixture");
      const patch = { publicId: "service_receipt_quota_with_more_bytes" };
      await adjustServiceQuotaForPatch(ctx, stored, patch);
      await ctx.db.patch(receiptId, patch);
    });
    stored = await runtime.run(async (ctx) => await ctx.db.get(receiptId));
    chargedBytes = logicalDocumentBytes(stored ?? {});
    charged = await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique());
    expect(charged).toMatchObject({
      logicalBytes: chargedBytes,
      records: 1,
      serviceLogicalBytes: chargedBytes,
      serviceRecords: 1,
    });
    await runtime.run(async (ctx) => {
      if (stored === null) throw new Error("missing service quota fixture");
      await adjustServiceQuotaForPatch(ctx, stored, {
        publicId: "service_receipt_quota_with_more_bytes",
      });
    });
    expect(await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique())).toMatchObject({
        identities: charged?.identities,
        logicalBytes: charged?.logicalBytes,
        records: charged?.records,
        serviceLogicalBytes: charged?.serviceLogicalBytes,
        serviceRecords: charged?.serviceRecords,
        userLogicalBytes: charged?.userLogicalBytes,
        userRecords: charged?.userRecords,
      });
    await runtime.run(async (ctx) => {
      if (stored === null) throw new Error("missing service quota fixture");
      await releaseServiceQuotaForDelete(ctx, stored);
      await ctx.db.delete(receiptId);
    });
    await expect(runtime.run(async (ctx) => {
      if (stored === null) throw new Error("missing service quota fixture");
      await releaseServiceQuotaForDelete(ctx, stored);
    })).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const limitRuntime = convexTest(schema, modules);
    await limitRuntime.mutation(genesisHardAuthority, {});
    const candidateBytes = logicalDocumentBytes(document);
    await limitRuntime.run(async (ctx) => {
      const service = await ctx.db.query("storageUsageService").unique();
      if (service === null) throw new Error("missing service limit fixture");
      const atBoundary = SERVICE_TOTAL_QUOTA.logicalBytes - candidateBytes;
      await ctx.db.patch(service._id, {
        logicalBytes: atBoundary,
        records: 1,
        serviceLogicalBytes: atBoundary,
        serviceRecords: 1,
      });
      await reserveServiceQuotaForInsert(ctx, document);
      await ctx.db.insert("accountDeletionReceipts", document);
    });
    expect(await limitRuntime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique()))
      .toMatchObject({ logicalBytes: SERVICE_TOTAL_QUOTA.logicalBytes });
    await expect(limitRuntime.run(async (ctx) => {
      await reserveServiceQuotaForInsert(ctx, {
        ...document,
        publicId: "service_receipt_over_limit",
      });
    })).rejects.toThrow("QUOTA_EXCEEDED");
  });

  test("shadow audit remains bounded and read-only", async () => {
    const world = await quotaWorld();
    await world.testRuntime.run(async (ctx) => {
      for (const entityId of ["audit_a", "audit_b", "audit_c"]) {
        await ctx.db.insert("securityEvents", {
          createdAt: 1,
          entityId,
          event: "command_enqueued",
          userId: world.userId,
        });
      }
    });
    const before = await categoryUsageFor(world.testRuntime, world.userId, "security");
    const first = await world.testRuntime.query(auditDirectTablePage, {
      paginationOpts: { cursor: null, numItems: 2 },
      table: "securityEvents",
      userId: world.userId,
    });
    const second = await world.testRuntime.query(auditDirectTablePage, {
      paginationOpts: { cursor: first.continueCursor, numItems: 2 },
      table: "securityEvents",
      userId: world.userId,
    });
    expect(first).toMatchObject({ isDone: false, records: 2 });
    expect(second).toMatchObject({ isDone: true, records: 1 });
    expect(await categoryUsageFor(world.testRuntime, world.userId, "security")).toEqual(before);
  });
});
