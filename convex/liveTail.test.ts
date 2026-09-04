import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { LIVE_TAIL_CHUNK_TTL_MS, LIVE_TAIL_ROW_CAP, LIVE_TAIL_ROW_CAP_TRIGGER } from "./lifecyclePolicy";
import {
  initializeUserQuotaAuthority,
  reserveQuotaForStoredIdentity,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type Authority = Readonly<{ bootGeneration: number; bootId: string; fence: number }>;

const register = makeFunctionReference<"mutation", Args, unknown>("devices:register");
const createSession = makeFunctionReference<"mutation", Args, unknown>("sessions:create");
const acquireLease = makeFunctionReference<"mutation", Args, unknown>("leases:acquire");
const appendChunk = makeFunctionReference<"mutation", Args, unknown>("sessions:appendChunk");
const getHead = makeFunctionReference<"query", Args, unknown>("sessions:getHead");
const cleanupExpired = makeFunctionReference<"mutation", Args, unknown>("maintenance:cleanupExpired");
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const envelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "B".repeat(16),
};
const publicKey = JSON.stringify({ crv: "P-256", kty: "EC", x: "A".repeat(43), y: "B".repeat(43) });
const wrappedKeyEnvelope = {
  algorithm: "P256-HKDF-SHA256+A256GCM" as const,
  ciphertext: "C".repeat(64),
  ephemeralPublicKey: publicKey,
  keyVersion: 1,
  nonce: "D".repeat(16),
};

function uuidV7(now: number, suffix: string): string {
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`;
}

const digestOf = (sequence: number): string => sequence.toString(16).padStart(64, "0");

async function liveWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "live@example.com", emailVerificationTime: Date.now() });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const authSessionId = await ctx.db.insert("authSessions", { expirationTime: Date.now() + 3_600_000, userId });
    await ctx.db.insert("authSubjects", {
      authEpoch: 1,
      createdAt: Date.now(),
      emailDigest: "a".repeat(64),
      status: "active",
      updatedAt: Date.now(),
      userId,
    });
    return { authSessionId, userId };
  });
  const runtime = testRuntime.withIdentity({
    issuer: "https://test.example",
    subject: `${ids.userId}|${ids.authSessionId}`,
    tokenIdentifier: `test|${ids.authSessionId}`,
  });
  const now = Date.now();
  await runtime.mutation(register, {
    bootstrapKeyEnvelope: wrappedKeyEnvelope,
    encryptedLabel: envelope,
    idempotencyKey: uuidV7(now, "01"),
    keyVersion: 1,
    publicId: "device_live0001",
    requestDigest: "a".repeat(64),
    signingPublicKey: publicKey,
    wrappingPublicKey: publicKey,
  });
  await runtime.mutation(createSession, {
    idempotencyKey: uuidV7(now, "02"),
    publicId: "session_live0001",
    requestDigest: "b".repeat(64),
  });
  const lease = await runtime.mutation(acquireLease, {
    bootGeneration: 1,
    bootId: "boot_live0001",
    leaseDurationMs: 60_000,
    sessionPublicId: "session_live0001",
  }) as Authority;
  const authority = { bootGeneration: lease.bootGeneration, bootId: lease.bootId, fence: lease.fence };
  const appendDetail = async (sequence: number, streamEpoch: number): Promise<void> => {
    await runtime.mutation(appendChunk, {
      authority,
      digest: digestOf(sequence),
      envelope,
      expectedHeadSequence: sequence - 1,
      expectedStreamEpoch: streamEpoch,
      ...(sequence === 1 ? {} : { expectedTailDigest: digestOf(sequence - 1), previousDigest: digestOf(sequence - 1) }),
      firstSequence: sequence,
      lastSequence: sequence,
      sessionPublicId: "session_live0001",
      stream: "detail",
    });
  };
  const liveCount = async (): Promise<number> => await testRuntime.run(async (ctx) => {
    const rows = await ctx.db.query("storageResourceUsageByUser").collect();
    return rows.find((row) => row.resource === "live_chunk")?.records ?? 0;
  });
  return { appendDetail, authority, ids, liveCount, runtime, testRuntime };
}

describe("live tail detail chunks", () => {
  test("detail appends expire, charge the live_chunk resource, and report the detail epoch on the head", async () => {
    const world = await liveWorld();
    await world.appendDetail(1, 0);
    await world.appendDetail(2, 0);
    const chunks = await world.testRuntime.run(async (ctx) => await ctx.db.query("sessionChunks").collect());
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.stream).toBe("detail");
      expect(chunk.expiresAt).toBeNumber();
      expect((chunk.expiresAt ?? 0) - chunk.createdAt).toBe(LIVE_TAIL_CHUNK_TTL_MS);
    }
    expect(await world.liveCount()).toBe(2);
    const head = await world.runtime.query(getHead, { publicId: "session_live0001" });
    expect(head).toMatchObject({ detailHeadSequence: 2, detailStreamEpoch: 0, detailTailDigest: digestOf(2) });
  });

  test("the sweeper removes expired detail chunks behind one detail epoch and releases quota", async () => {
    const world = await liveWorld();
    await world.appendDetail(1, 0);
    await world.appendDetail(2, 0);
    await world.appendDetail(3, 0);
    await world.testRuntime.run(async (ctx) => {
      const chunks = await ctx.db.query("sessionChunks").collect();
      for (const chunk of chunks) {
        if (chunk.firstSequence <= 2) await ctx.db.patch(chunk._id, { expiresAt: Date.now() - 1 });
      }
    });
    const counts = await world.testRuntime.mutation(cleanupExpired, { limit: 200 }) as Record<string, number>;
    expect(counts.liveTailChunks).toBe(2);
    const after = await world.testRuntime.run(async (ctx) => ({
      chunks: await ctx.db.query("sessionChunks").collect(),
      epochs: await ctx.db.query("sessionStreamEpochs").collect(),
      heads: await ctx.db.query("sessionHeads").collect(),
    }));
    expect(after.chunks.map((chunk) => chunk.firstSequence)).toEqual([3]);
    expect(after.epochs).toHaveLength(1);
    expect(after.epochs[0]).toMatchObject({
      boundaryHeadSequence: 2,
      boundaryTailDigest: digestOf(2),
      epoch: 1,
      reason: "live_tail_retention",
      stream: "detail",
    });
    expect(after.heads[0]?.detailStreamEpoch).toBe(1);
    expect(await world.liveCount()).toBe(1);
    const head = await world.runtime.query(getHead, { publicId: "session_live0001" });
    expect(head).toMatchObject({ detailHeadSequence: 3, detailStreamEpoch: 1 });
    await world.appendDetail(4, 1);
    await expect(world.appendDetail(5, 0)).rejects.toThrow();
  });

  test("the row cap prunes the oldest detail chunks once the trigger is exceeded", async () => {
    const world = await liveWorld();
    const total = LIVE_TAIL_ROW_CAP + LIVE_TAIL_ROW_CAP_TRIGGER + 1;
    let epoch = 0;
    for (let sequence = 1; sequence <= total; sequence += 1) {
      await world.appendDetail(sequence, epoch);
      if (sequence === total) {
        const head = await world.runtime.query(getHead, { publicId: "session_live0001" }) as { detailStreamEpoch: number };
        epoch = head.detailStreamEpoch;
      }
    }
    expect(epoch).toBe(1);
    const chunks = await world.testRuntime.run(async (ctx) => await ctx.db.query("sessionChunks").collect());
    expect(chunks).toHaveLength(LIVE_TAIL_ROW_CAP);
    expect(Math.min(...chunks.map((chunk) => chunk.firstSequence))).toBe(LIVE_TAIL_ROW_CAP_TRIGGER + 2);
    expect(await world.liveCount()).toBe(LIVE_TAIL_ROW_CAP);
  }, 120_000);
});
