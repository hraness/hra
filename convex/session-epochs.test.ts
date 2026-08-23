import { describe, expect, spyOn, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";
import fc from "fast-check";

import { expectPromiseToReject } from "../src/cloud/testAssertions";
import {
  initializeUserQuotaAuthority,
  reserveQuotaForStoredIdentity,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type Authority = Readonly<{
  bootGeneration: number;
  bootId: string;
  fence: number;
}>;

const register = makeFunctionReference<"mutation", Args, unknown>("devices:register");
const createSession = makeFunctionReference<"mutation", Args, unknown>("sessions:create");
const acquireLease = makeFunctionReference<"mutation", Args, unknown>("leases:acquire");
const appendChunk = makeFunctionReference<"mutation", Args, unknown>("sessions:appendChunk");
const beginCompactEpoch = makeFunctionReference<"mutation", Args, unknown>(
  "sessions:beginCompactEpoch",
);
const getHead = makeFunctionReference<"query", Args, unknown>("sessions:getHead");
const getChunks = makeFunctionReference<"query", Args, unknown>("sessions:getChunks");
const getLatestChunks = makeFunctionReference<"query", Args, unknown>(
  "sessions:getLatestChunks",
);
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const envelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "B".repeat(16),
};
const publicKey = JSON.stringify({
  crv: "P-256",
  kty: "EC",
  x: "A".repeat(43),
  y: "B".repeat(43),
});
const wrappedKeyEnvelope = {
  algorithm: "P256-HKDF-SHA256+A256GCM" as const,
  ciphertext: "C".repeat(64),
  ephemeralPublicKey: publicKey,
  keyVersion: 1,
  nonce: "D".repeat(16),
};
const firstDigest = "1".repeat(64);

function uuidV7(now: number, suffix: string): string {
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`;
}

async function authenticatedWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "epochs@example.com",
      emailVerificationTime: Date.now(),
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const authSessionId = await ctx.db.insert("authSessions", {
      expirationTime: Date.now() + 60 * 60 * 1_000,
      userId,
    });
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
  return {
    ids,
    runtime: testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${ids.userId}|${ids.authSessionId}`,
      tokenIdentifier: `test|${ids.authSessionId}`,
    }),
    testRuntime,
  };
}

async function sessionWorld(seedChunk = true) {
  const world = await authenticatedWorld();
  const now = Date.now();
  await world.runtime.mutation(register, {
    bootstrapKeyEnvelope: wrappedKeyEnvelope,
    encryptedLabel: envelope,
    idempotencyKey: uuidV7(now, "01"),
    keyVersion: 1,
    publicId: "device_epochs01",
    requestDigest: "a".repeat(64),
    signingPublicKey: publicKey,
    wrappingPublicKey: publicKey,
  });
  await world.runtime.mutation(createSession, {
    idempotencyKey: uuidV7(now, "02"),
    publicId: "session_epochs01",
    requestDigest: "b".repeat(64),
  });
  const lease = await world.runtime.mutation(acquireLease, {
    bootGeneration: 7,
    bootId: "boot_epochs01",
    leaseDurationMs: 60_000,
    sessionPublicId: "session_epochs01",
  }) as Authority;
  const authority = {
    bootGeneration: lease.bootGeneration,
    bootId: lease.bootId,
    fence: lease.fence,
  };
  if (seedChunk) {
    await world.runtime.mutation(appendChunk, {
      authority,
      digest: firstDigest,
      envelope,
      expectedHeadSequence: 0,
      expectedStreamEpoch: 0,
      firstSequence: 1,
      lastSequence: 1,
      sessionPublicId: "session_epochs01",
      stream: "compact",
    });
  }
  return { ...world, authority, now };
}

function epochRequest(
  now: number,
  authority: Authority,
  suffix = "10",
  overrides: Readonly<Record<string, Value>> = {},
) {
  return {
    authority,
    epochPublicId: uuidV7(now, `${suffix}1`),
    expectedCompactStreamEpoch: 0,
    expectedHeadSequence: 1,
    expectedTailDigest: firstDigest,
    idempotencyKey: uuidV7(now, `${suffix}2`),
    lineageCommitment: `lineage_commitment_${suffix}`,
    requestDigest: suffix.slice(-1).repeat(64),
    sessionPublicId: "session_epochs01",
    ...overrides,
  };
}

async function projectionState(testRuntime: Awaited<ReturnType<typeof authenticatedWorld>>["testRuntime"]) {
  return await testRuntime.run(async (ctx) => ({
    chunks: await ctx.db.query("sessionChunks").collect(),
    epochs: await ctx.db.query("sessionStreamEpochs").collect(),
    heads: await ctx.db.query("sessionHeads").collect(),
    receipts: (await ctx.db.query("idempotencyReceipts").collect())
      .filter((receipt) => receipt.operation === "session.compact_epoch"),
  }));
}

describe("compact projection stream epochs", () => {
  test("opens an immutable recovery lineage without rewriting legacy chunk bytes", async () => {
    const world = await sessionWorld();
    await world.testRuntime.run(async (ctx) => {
      const head = (await ctx.db.query("sessionHeads").collect())[0];
      const chunk = (await ctx.db.query("sessionChunks").collect())[0];
      if (
        head === undefined
        || chunk === undefined
        || head.compactTailDigest === undefined
      ) throw new Error("missing projection fixture");
      await ctx.db.replace(head._id, {
        compactHeadSequence: head.compactHeadSequence,
        compactTailDigest: head.compactTailDigest,
        createdAt: head.createdAt,
        detailHeadSequence: head.detailHeadSequence,
        executionDeviceId: head.executionDeviceId,
        metadataRevision: head.metadataRevision,
        projectionRevision: head.projectionRevision,
        publicId: head.publicId,
        state: head.state,
        updatedAt: head.updatedAt,
        userId: head.userId,
      });
      await ctx.db.replace(chunk._id, {
        authority: chunk.authority,
        createdAt: chunk.createdAt,
        digest: chunk.digest,
        envelope: chunk.envelope,
        firstSequence: chunk.firstSequence,
        lastSequence: chunk.lastSequence,
        sessionId: chunk.sessionId,
        sourceDeviceId: chunk.sourceDeviceId,
        stream: chunk.stream,
        userId: chunk.userId,
      });
    });
    expect(await world.runtime.query(getHead, { publicId: "session_epochs01" }))
      .toMatchObject({ compactHasRecoveryGap: false, compactStreamEpoch: 0 });
    const before = await projectionState(world.testRuntime);
    const request = epochRequest(world.now, world.authority);
    const opened = await world.runtime.mutation(beginCompactEpoch, request);
    expect(opened).toMatchObject({
      boundaryHeadSequence: 1,
      boundaryTailDigest: firstDigest,
      compactHasRecoveryGap: true,
      compactStreamEpoch: 1,
      projectionRevision: 2,
    });
    const after = await projectionState(world.testRuntime);
    expect(after.chunks).toEqual(before.chunks);
    expect(after.heads).toEqual(before.heads.map((head) => ({
      ...head,
      compactHasRecoveryGap: true,
      compactStreamEpoch: 1,
      projectionRevision: head.projectionRevision + 1,
    })));
    expect(after.epochs).toHaveLength(1);
    expect(after.epochs[0]).toMatchObject({
      authority: world.authority,
      boundaryHeadSequence: 1,
      boundaryTailDigest: firstDigest,
      epoch: 1,
      idempotencyKey: request.idempotencyKey,
      lineageCommitment: request.lineageCommitment,
      predecessorEpoch: 0,
      projectionRevision: 2,
      publicId: request.epochPublicId,
      reason: "projection_cache_recovery",
      requestDigest: request.requestDigest,
      stream: "compact",
    });
    const replayed = await world.runtime.mutation(beginCompactEpoch, request);
    expect(replayed).toEqual(opened);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(opened));
    expect((await projectionState(world.testRuntime)).epochs).toEqual(after.epochs);
    const replayBaseline = await projectionState(world.testRuntime);
    await expectPromiseToReject(world.runtime.mutation(beginCompactEpoch, {
      ...request,
      requestDigest: "f".repeat(64),
    }), "Cloud authority is not current");
    expect(await projectionState(world.testRuntime)).toEqual(replayBaseline);

    const secondDigest = "2".repeat(64);
    const secondAppend = {
      authority: world.authority,
      digest: secondDigest,
      envelope,
      expectedHeadSequence: 1,
      expectedStreamEpoch: 1,
      expectedTailDigest: firstDigest,
      firstSequence: 2,
      lastSequence: 2,
      previousDigest: firstDigest,
      sessionPublicId: "session_epochs01",
      stream: "compact",
    } as const;
    const appended = await world.runtime.mutation(appendChunk, secondAppend);
    expect(appended).toEqual({
      digest: secondDigest,
      headSequence: 2,
      replay: false,
      streamEpoch: 1,
    });
    expect(await world.runtime.mutation(appendChunk, secondAppend)).toEqual({
      ...(appended as Readonly<Record<string, Value>>),
      replay: true,
    });
    const appendBaseline = await projectionState(world.testRuntime);
    await expectPromiseToReject(world.runtime.mutation(appendChunk, {
      ...secondAppend,
      expectedStreamEpoch: 0,
    }), "SESSION_CHUNK_CONFLICT");
    await expectPromiseToReject(world.runtime.mutation(appendChunk, {
      ...secondAppend,
      digest: "3".repeat(64),
      expectedHeadSequence: 2,
      expectedStreamEpoch: 0,
      firstSequence: 3,
      lastSequence: 3,
      previousDigest: secondDigest,
      expectedTailDigest: secondDigest,
    }), "SESSION_HEAD_CONFLICT");
    expect(await projectionState(world.testRuntime)).toEqual(appendBaseline);
    const chunks = await world.runtime.query(getChunks, {
      afterSequence: 0,
      limit: 100,
      sessionPublicId: "session_epochs01",
      stream: "compact",
    }) as readonly Readonly<Record<string, Value>>[];
    expect(chunks.map((chunk) => [chunk.firstSequence, chunk.lastSequence, chunk.streamEpoch]))
      .toEqual([[1, 1, 0], [2, 2, 1]]);
    expect(chunks[0]?.envelope).toEqual(envelope);
    expect(chunks[0]?.digest).toBe(firstDigest);
    expect(await world.runtime.query(getLatestChunks, {
      limit: 100,
      sessionPublicId: "session_epochs01",
      stream: "compact",
    })).toEqual(chunks);
  });

  test("rejects stale epoch, head, tail, and daemon lease authority with zero mutation", async () => {
    const world = await sessionWorld();
    const baseline = await projectionState(world.testRuntime);
    const cases = [
      epochRequest(world.now, world.authority, "20", { expectedCompactStreamEpoch: 1 }),
      epochRequest(world.now, world.authority, "21", { expectedHeadSequence: 2 }),
      epochRequest(world.now, world.authority, "22", { expectedTailDigest: "2".repeat(64) }),
      epochRequest(world.now, { ...world.authority, bootGeneration: 8 }, "23"),
      epochRequest(world.now, { ...world.authority, bootId: "boot_stale001" }, "24"),
      epochRequest(world.now, { ...world.authority, fence: world.authority.fence + 1 }, "25"),
    ];
    for (const request of cases) {
      await expectPromiseToReject(
        world.runtime.mutation(beginCompactEpoch, request),
        request.authority === world.authority
          ? "SESSION_COMPACT_EPOCH_CONFLICT"
          : "Cloud authority is not current",
      );
      expect(await projectionState(world.testRuntime)).toEqual(baseline);
    }
  });

  test("reconciles immutable lineage beyond receipt retention and a newer fence", async () => {
    const world = await sessionWorld();
    const request = epochRequest(world.now, world.authority, "60");
    const committed = await world.runtime.mutation(beginCompactEpoch, request);
    const future = world.now + 8 * 24 * 60 * 60 * 1_000;
    await world.testRuntime.run(async (ctx) => {
      const receipts = (await ctx.db.query("idempotencyReceipts").collect())
        .filter((receipt) => receipt.operation === "session.compact_epoch");
      const receipt = receipts[0];
      if (receipts.length !== 1 || receipt === undefined) {
        throw new Error("missing compact epoch receipt fixture");
      }
      await ctx.db.delete(receipt._id);
      await ctx.db.patch(world.ids.authSessionId, { expirationTime: future + 60 * 60 * 1_000 });
    });
    const replayBaseline = await projectionState(world.testRuntime);
    const dateNow = spyOn(Date, "now").mockReturnValue(future);
    try {
      const expiredReplay = await world.runtime.mutation(beginCompactEpoch, request);
      expect(expiredReplay).toEqual(committed);
      expect(JSON.stringify(expiredReplay)).toBe(JSON.stringify(committed));
      expect(await projectionState(world.testRuntime)).toEqual(replayBaseline);

      const renewedLease = await world.runtime.mutation(acquireLease, {
        bootGeneration: world.authority.bootGeneration,
        bootId: world.authority.bootId,
        leaseDurationMs: 60_000,
        sessionPublicId: "session_epochs01",
      }) as Authority;
      const renewedAuthority = {
        bootGeneration: renewedLease.bootGeneration,
        bootId: renewedLease.bootId,
        fence: renewedLease.fence,
      };
      expect(renewedAuthority.fence).toBe(world.authority.fence + 1);
      const newerFenceReplay = await world.runtime.mutation(beginCompactEpoch, request);
      expect(newerFenceReplay).toEqual(committed);
      expect(JSON.stringify(newerFenceReplay)).toBe(JSON.stringify(committed));

      const mismatches = [
        { ...request, idempotencyKey: uuidV7(world.now, "60f") },
        { ...request, requestDigest: "f".repeat(64) },
        { ...request, lineageCommitment: "different_lineage_commitment" },
        { ...request, expectedCompactStreamEpoch: 1 },
        { ...request, expectedHeadSequence: 2 },
        { ...request, expectedTailDigest: "e".repeat(64) },
        { ...request, authority: renewedAuthority },
      ];
      for (const mismatch of mismatches) {
        await expectPromiseToReject(
          world.runtime.mutation(beginCompactEpoch, mismatch),
          "Cloud authority is not current",
        );
        expect(await projectionState(world.testRuntime)).toEqual(replayBaseline);
      }

      await expectPromiseToReject(world.runtime.mutation(
        beginCompactEpoch,
        epochRequest(world.now, renewedAuthority, "62"),
      ), "Invalid idempotency authority");
      expect(await projectionState(world.testRuntime)).toEqual(replayBaseline);

      const identities = await world.testRuntime.run(async (ctx) => {
        const otherDeviceAuthSessionId = await ctx.db.insert("authSessions", {
          expirationTime: future + 60 * 60 * 1_000,
          userId: world.ids.userId,
        });
        const otherDeviceId = await ctx.db.insert("devices", {
          activatedAt: future,
          authEpoch: 1,
          createdAt: future,
          encryptedLabel: envelope,
          keyVersion: 1,
          publicId: "device_epochs03",
          revision: 1,
          signingPublicKey: publicKey,
          status: "active",
          updatedAt: future,
          userId: world.ids.userId,
          wrappingPublicKey: publicKey,
        });
        await ctx.db.insert("deviceSessions", {
          authEpoch: 1,
          authSessionId: otherDeviceAuthSessionId,
          boundAt: future,
          deviceId: otherDeviceId,
          userId: world.ids.userId,
        });

        const otherUserId = await ctx.db.insert("users", {
          email: "other-epochs@example.com",
          emailVerificationTime: future,
        });
        const otherUserAuthSessionId = await ctx.db.insert("authSessions", {
          expirationTime: future + 60 * 60 * 1_000,
          userId: otherUserId,
        });
        await ctx.db.insert("authSubjects", {
          authEpoch: 1,
          createdAt: future,
          emailDigest: "c".repeat(64),
          status: "active",
          updatedAt: future,
          userId: otherUserId,
        });
        const otherUserDeviceId = await ctx.db.insert("devices", {
          activatedAt: future,
          authEpoch: 1,
          createdAt: future,
          encryptedLabel: envelope,
          keyVersion: 1,
          publicId: "device_epochs04",
          revision: 1,
          signingPublicKey: publicKey,
          status: "active",
          updatedAt: future,
          userId: otherUserId,
          wrappingPublicKey: publicKey,
        });
        await ctx.db.insert("deviceSessions", {
          authEpoch: 1,
          authSessionId: otherUserAuthSessionId,
          boundAt: future,
          deviceId: otherUserDeviceId,
          userId: otherUserId,
        });
        return { otherDeviceAuthSessionId, otherUserAuthSessionId, otherUserId };
      });
      const wrongDevice = world.testRuntime.withIdentity({
        issuer: "https://test.example",
        subject: `${world.ids.userId}|${identities.otherDeviceAuthSessionId}`,
        tokenIdentifier: `test|${identities.otherDeviceAuthSessionId}`,
      });
      const wrongUser = world.testRuntime.withIdentity({
        issuer: "https://test.example",
        subject: `${identities.otherUserId}|${identities.otherUserAuthSessionId}`,
        tokenIdentifier: `test|${identities.otherUserAuthSessionId}`,
      });
      for (const runtime of [wrongDevice, wrongUser]) {
        await expectPromiseToReject(
          runtime.mutation(beginCompactEpoch, request),
          "Cloud authority is not current",
        );
      }
      expect(await projectionState(world.testRuntime)).toEqual(replayBaseline);
    } finally {
      dateNow.mockRestore();
    }
  });

  test("rejects expired leases and a non-execution device without projection mutation", async () => {
    const expired = await sessionWorld();
    await expired.testRuntime.run(async (ctx) => {
      const lease = (await ctx.db.query("executionLeases").collect())[0];
      if (lease === undefined) throw new Error("missing lease fixture");
      await ctx.db.patch(lease._id, { leaseUntil: Date.now() - 1 });
    });
    const expiredBaseline = await projectionState(expired.testRuntime);
    await expectPromiseToReject(
      expired.runtime.mutation(beginCompactEpoch, epochRequest(expired.now, expired.authority, "30")),
      "Cloud authority is not current",
    );
    expect(await projectionState(expired.testRuntime)).toEqual(expiredBaseline);

    const displaced = await sessionWorld();
    await displaced.testRuntime.run(async (ctx) => {
      const head = (await ctx.db.query("sessionHeads").collect())[0];
      const device = (await ctx.db.query("devices").collect())[0];
      if (head === undefined || device === undefined) throw new Error("missing device fixture");
      const replacementId = await ctx.db.insert("devices", {
        authEpoch: device.authEpoch,
        createdAt: device.createdAt,
        encryptedLabel: device.encryptedLabel,
        keyVersion: device.keyVersion,
        publicId: "device_epochs02",
        revision: device.revision,
        signingPublicKey: device.signingPublicKey,
        status: "active",
        updatedAt: device.updatedAt,
        userId: device.userId,
        wrappingPublicKey: device.wrappingPublicKey,
      });
      await ctx.db.patch(head._id, { executionDeviceId: replacementId });
    });
    const displacedBaseline = await projectionState(displaced.testRuntime);
    await expectPromiseToReject(
      displaced.runtime.mutation(
        beginCompactEpoch,
        epochRequest(displaced.now, displaced.authority, "31"),
      ),
      "Cloud authority is not current",
    );
    expect(await projectionState(displaced.testRuntime)).toEqual(displacedBaseline);
  });

  test("serializes competing epoch opens to exactly one winner", async () => {
    const world = await sessionWorld();
    const results = await Promise.allSettled([
      world.runtime.mutation(
        beginCompactEpoch,
        epochRequest(world.now, world.authority, "40"),
      ),
      world.runtime.mutation(
        beginCompactEpoch,
        epochRequest(world.now, world.authority, "41"),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const state = await projectionState(world.testRuntime);
    expect(state.epochs).toHaveLength(1);
    expect(state.receipts).toHaveLength(1);
    expect(state.heads[0]).toMatchObject({
      compactHasRecoveryGap: true,
      compactHeadSequence: 1,
      compactStreamEpoch: 1,
      compactTailDigest: firstDigest,
      projectionRevision: 2,
    });
  });

  test("keeps sequence numbers globally monotonic across generated epoch boundaries", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 5 }),
      async (chunkLengths) => {
        const world = await sessionWorld();
        let epoch = 0;
        let head = 1;
        let tail = firstDigest;
        for (const [index, chunkLength] of chunkLengths.entries()) {
          const suffix = (index + 80).toString(16);
          await world.runtime.mutation(beginCompactEpoch, epochRequest(
            world.now,
            world.authority,
            suffix,
            {
              expectedCompactStreamEpoch: epoch,
              expectedHeadSequence: head,
              expectedTailDigest: tail,
            },
          ));
          epoch += 1;
          const digest = ((index + 2) % 16).toString(16).repeat(64);
          await world.runtime.mutation(appendChunk, {
            authority: world.authority,
            digest,
            envelope,
            expectedHeadSequence: head,
            expectedStreamEpoch: epoch,
            expectedTailDigest: tail,
            firstSequence: head + 1,
            lastSequence: head + chunkLength,
            previousDigest: tail,
            sessionPublicId: "session_epochs01",
            stream: "compact",
          });
          head += chunkLength;
          tail = digest;
        }
        const chunks = await world.runtime.query(getChunks, {
          afterSequence: 0,
          limit: 100,
          sessionPublicId: "session_epochs01",
          stream: "compact",
        }) as readonly Readonly<Record<string, Value>>[];
        expect(chunks).toHaveLength(chunkLengths.length + 1);
        for (const [index, chunk] of chunks.entries()) {
          expect(chunk.streamEpoch).toBe(index);
          if (index > 0) {
            expect(chunk.firstSequence).toBe((chunks[index - 1]?.lastSequence as number) + 1);
          }
        }
        expect(await world.runtime.query(getHead, { publicId: "session_epochs01" }))
          .toMatchObject({
            compactHasRecoveryGap: true,
            compactHeadSequence: head,
            compactStreamEpoch: epoch,
            compactTailDigest: tail,
          });
      },
    ), { numRuns: 8, seed: 0x5e5510 });
  });

  test("rejects zero-head, identifier bounds, and safe-integer overflow atomically", async () => {
    const empty = await sessionWorld(false);
    const emptyBaseline = await projectionState(empty.testRuntime);
    await expectPromiseToReject(empty.runtime.mutation(beginCompactEpoch, {
      authority: empty.authority,
      epochPublicId: uuidV7(empty.now, "901"),
      expectedCompactStreamEpoch: 0,
      expectedHeadSequence: 0,
      idempotencyKey: uuidV7(empty.now, "902"),
      lineageCommitment: "lineage_empty01",
      requestDigest: "9".repeat(64),
      sessionPublicId: "session_epochs01",
    }), "Cloud authority is not current");
    expect(await projectionState(empty.testRuntime)).toEqual(emptyBaseline);

    const bounded = await sessionWorld();
    const boundedBaseline = await projectionState(bounded.testRuntime);
    await expectPromiseToReject(bounded.runtime.mutation(
      beginCompactEpoch,
      epochRequest(bounded.now, bounded.authority, "91", {
        lineageCommitment: "x".repeat(97),
      }),
    ), "Cloud authority is not current");
    expect(await projectionState(bounded.testRuntime)).toEqual(boundedBaseline);

    await bounded.testRuntime.run(async (ctx) => {
      const head = (await ctx.db.query("sessionHeads").collect())[0];
      if (head === undefined) throw new Error("missing head fixture");
      await ctx.db.patch(head._id, { compactStreamEpoch: Number.MAX_SAFE_INTEGER });
    });
    const epochOverflowBaseline = await projectionState(bounded.testRuntime);
    await expectPromiseToReject(bounded.runtime.mutation(
      beginCompactEpoch,
      epochRequest(bounded.now, bounded.authority, "92", {
        expectedCompactStreamEpoch: Number.MAX_SAFE_INTEGER,
      }),
    ), "SESSION_COMPACT_EPOCH_CONFLICT");
    expect(await projectionState(bounded.testRuntime)).toEqual(epochOverflowBaseline);

    await bounded.testRuntime.run(async (ctx) => {
      const head = (await ctx.db.query("sessionHeads").collect())[0];
      if (head === undefined) throw new Error("missing head fixture");
      await ctx.db.patch(head._id, {
        compactStreamEpoch: 0,
        projectionRevision: Number.MAX_SAFE_INTEGER,
      });
    });
    const revisionOverflowBaseline = await projectionState(bounded.testRuntime);
    await expectPromiseToReject(bounded.runtime.mutation(
      beginCompactEpoch,
      epochRequest(bounded.now, bounded.authority, "93"),
    ), "SESSION_COMPACT_EPOCH_CONFLICT");
    expect(await projectionState(bounded.testRuntime)).toEqual(revisionOverflowBaseline);
  });
});
