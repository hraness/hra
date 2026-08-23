import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { expectPromiseToReject } from "../src/cloud/testAssertions";
import {
  initializeUserQuotaAuthority,
  reserveQuotaForStoredIdentity,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type PresenceResponse = Readonly<{
  connectionId: string | null;
  lastSeenAt: number | null;
  online: boolean;
  presenceUntil: number | null;
  sequence: number | null;
  serverNow: number;
}>;
const connect = makeFunctionReference<"mutation", Args, PresenceResponse>("presence:connect");
const heartbeat = makeFunctionReference<"mutation", Args, PresenceResponse>("presence:heartbeat");
const disconnect = makeFunctionReference<"mutation", Args, PresenceResponse>("presence:disconnect");
const current = makeFunctionReference<"query", Args, unknown>("presence:current");
const listDevices = makeFunctionReference<"query", Args, unknown>("devices:list");
const listHeads = makeFunctionReference<"query", Args, unknown>("sessions:listHeadsPage");
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const envelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "B".repeat(16),
};

async function presenceWorld(status: "pending" | "active" = "active") {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "presence@example.com", emailVerificationTime: now });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const authSessionId = await ctx.db.insert("authSessions", { expirationTime: now + 3_600_000, userId });
    await ctx.db.insert("authSubjects", { authEpoch: 1, createdAt: now, emailDigest: "a".repeat(64), status: "active", updatedAt: now, userId });
    const deviceId = await ctx.db.insert("devices", {
      ...(status === "active" ? { activatedAt: now } : {}),
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      encryptedLabel: envelope,
      keyVersion: 1,
      publicId: `device_presence_${status}`,
      revision: 1,
      signingPublicKey: "fixture",
      status,
      updatedAt: now,
      userId,
      wrappingPublicKey: "fixture",
    });
    await ctx.db.insert("deviceSessions", { authEpoch: 1, authSessionId, boundAt: now, deviceId, userId });
    return { authSessionId, deviceId, userId };
  });
  return {
    ids,
    runtime: testRuntime.withIdentity({ issuer: "https://test.example", subject: `${ids.userId}|${ids.authSessionId}`, tokenIdentifier: `test|${ids.authSessionId}` }),
    testRuntime,
  };
}

describe("device presence", () => {
  test("connects, advances exact sequence, replays without extension, and disconnects", async () => {
    const world = await presenceWorld();
    const connectionId = "presence_connection_1";
    const first = await world.runtime.mutation(connect, { connectionId, credentialGeneration: 1, fingerprint: "1".repeat(64), sequence: 0 });
    expect(first).toMatchObject({ online: true, sequence: 0 });
    expect(await world.runtime.query(listDevices, {})).toEqual([
      expect.objectContaining({ lastSeenAt: first.lastSeenAt, online: true }),
    ]);
    const replay = await world.runtime.mutation(connect, { connectionId, credentialGeneration: 1, fingerprint: "1".repeat(64), sequence: 0 });
    expect(replay).toMatchObject({
      connectionId: first.connectionId,
      lastSeenAt: first.lastSeenAt,
      online: true,
      presenceUntil: first.presenceUntil,
      sequence: 0,
    });
    expect(replay.serverNow).toBeGreaterThanOrEqual(first.serverNow);
    const advanced = await world.runtime.mutation(heartbeat, { connectionId, credentialGeneration: 1, fingerprint: "2".repeat(64), sequence: 1 });
    expect(advanced).toMatchObject({ online: true, sequence: 1 });
    const heartbeatReplay = await world.runtime.mutation(heartbeat, { connectionId, credentialGeneration: 1, fingerprint: "2".repeat(64), sequence: 1 });
    expect(heartbeatReplay).toMatchObject({
      connectionId: advanced.connectionId,
      lastSeenAt: advanced.lastSeenAt,
      online: true,
      presenceUntil: advanced.presenceUntil,
      sequence: 1,
    });
    expect(heartbeatReplay.serverNow).toBeGreaterThanOrEqual(advanced.serverNow);
    const ended = await world.runtime.mutation(disconnect, { connectionId, credentialGeneration: 1, fingerprint: "2".repeat(64), sequence: 1 });
    expect(ended).toMatchObject({ online: false, sequence: 1 });
    expect(await world.runtime.query(listDevices, {})).toEqual([
      expect.objectContaining({ lastSeenAt: ended.lastSeenAt, online: false }),
    ]);
  });

  test("rejects sequence gaps, changed replay, concurrent connections, and stale credential generations", async () => {
    const world = await presenceWorld();
    const base = { connectionId: "presence_connection_1", credentialGeneration: 1, fingerprint: "1".repeat(64), sequence: 0 };
    await world.runtime.mutation(connect, base);
    await expectPromiseToReject(world.runtime.mutation(heartbeat, { ...base, fingerprint: "2".repeat(64) }), "Cloud authority is not current");
    await expectPromiseToReject(world.runtime.mutation(heartbeat, { ...base, fingerprint: "3".repeat(64), sequence: 2 }), "Cloud authority is not current");
    await expectPromiseToReject(world.runtime.mutation(connect, { ...base, connectionId: "presence_connection_2", fingerprint: "4".repeat(64) }), "PRESENCE_CONNECTION_CONFLICT");
    await expectPromiseToReject(world.runtime.mutation(heartbeat, { ...base, credentialGeneration: 2, fingerprint: "5".repeat(64), sequence: 1 }), "Cloud authority is not current");
  });

  test("lets a pending device report only its own presence while data reads remain denied", async () => {
    const world = await presenceWorld("pending");
    await world.runtime.mutation(connect, { connectionId: "presence_pending_1", credentialGeneration: 1, fingerprint: "9".repeat(64), sequence: 0 });
    expect(await world.runtime.query(current, {})).toMatchObject({ online: true, sequence: 0 });
    await expectPromiseToReject(world.runtime.query(listHeads, { paginationOpts: { cursor: null, numItems: 1 } }), "Cloud authority is not current");
  });

  test("revocation and generation rotation fence an existing bearer connection", async () => {
    const world = await presenceWorld();
    const args = { connectionId: "presence_connection_1", credentialGeneration: 1, fingerprint: "1".repeat(64), sequence: 0 };
    await world.runtime.mutation(connect, args);
    await world.testRuntime.run(async (ctx) => { await ctx.db.patch(world.ids.deviceId, { credentialGeneration: 2, revision: 2 }); });
    await expectPromiseToReject(world.runtime.mutation(heartbeat, { ...args, fingerprint: "2".repeat(64), sequence: 1 }), "Cloud authority is not current");
    await world.testRuntime.run(async (ctx) => { await ctx.db.patch(world.ids.deviceId, { revokedAt: Date.now(), status: "revoked" }); });
    await expectPromiseToReject(world.runtime.query(current, {}), "Cloud authority is not current");
  });
});
