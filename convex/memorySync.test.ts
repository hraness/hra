import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";
import { convexTest } from "convex-test";

import { cloudMutations, cloudQueries } from "../src/cloud/client";
import {
  canonicalMemorySyncLimits,
  parseCanonicalMemoryCreateResult,
  parseCanonicalMemoryHead,
  parseCanonicalMemoryPullPage,
  parseCanonicalMemorySpaceConfiguration,
  parseCanonicalMemorySpaceList,
  parseCanonicalMemoryWriteResult,
} from "../src/cloud/memory-sync-contracts";
import {
  ACCOUNT_DELETION_TABLE_STRATEGY,
} from "./accountDeletion";
import { DEVICE_REVOCATION_TABLE_STRATEGY } from "./deviceRevocation";
import { HOSTED_TABLE_LIFECYCLE } from "./lifecyclePolicy";
import { MAINTENANCE_RETENTION_STRATEGY } from "./maintenance";
import {
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  nextResourceRecords,
  reserveDeviceQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  USER_RESOURCE_QUOTAS,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type HeadResult = Readonly<{
  headToken: string;
  sequence: number;
}>;
type DrainResult = Readonly<{ kind: "advanced" | "complete" | "drained" | "idle" }>;
const createSpace = makeFunctionReference<"mutation", Args, unknown>("memorySync:create");
const listSpaces = makeFunctionReference<"query", Args, unknown>("memorySync:list");
const getSpace = makeFunctionReference<"query", Args, unknown>("memorySync:get");
const getHead = makeFunctionReference<"query", Args, HeadResult>("memorySync:head");
const push = makeFunctionReference<"mutation", Args, unknown>("memorySync:push");
const pull = makeFunctionReference<"query", Args, unknown>("memorySync:pull");
const requestDeletion = makeFunctionReference<"mutation", Args, unknown>(
  "accountDeletion:request",
);
const drainDeletion = makeFunctionReference<"mutation", Args, DrainResult>(
  "accountDeletion:drain",
);
const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);

const spaceId = `memory_${"A".repeat(32)}`;
const genesisToken = "0".repeat(64);
const headToken1 = "1".repeat(64);
const headToken2 = "2".repeat(64);
const headToken3 = "3".repeat(64);

function envelope(keyVersion = 1, fill = "A") {
  return {
    algorithm: "A256GCM" as const,
    ciphertext: fill.repeat(22),
    keyVersion,
    nonce: "B".repeat(16),
  };
}

function operation(
  sequence: number,
  priorToken: string,
  headToken: string,
  keyVersion = 1,
  adoptionProof: ReturnType<typeof envelope> | null = null,
) {
  return {
    adoptionProof,
    genesisToken,
    headToken,
    operation: envelope(keyVersion, sequence % 2 === 0 ? "C" : "A"),
    priorToken,
    sequence,
    terminalHeadProof: envelope(keyVersion, sequence % 2 === 0 ? "D" : "E"),
  };
}

async function memoryWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "memory@example.com",
      emailVerificationTime: now,
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing memory fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const subject = {
      authEpoch: 1,
      createdAt: now,
      emailDigest: "a".repeat(64),
      status: "active" as const,
      updatedAt: now,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "identity", subject);
    await ctx.db.insert("authSubjects", subject);

    const installDevice = async (deviceClass: "daemon" | "browser", suffix: string) => {
      const authSession = { expirationTime: now + 60 * 60 * 1_000, userId };
      await reserveQuotaForInsert(ctx, userId, "identity", authSession);
      const authSessionId = await ctx.db.insert("authSessions", authSession);
      const device = {
        activatedAt: now,
        authEpoch: 1,
        createdAt: now,
        credentialGeneration: 1,
        deviceClass,
        encryptedLabel: envelope(),
        keyVersion: 1,
        publicId: `device_memory_${suffix}`,
        revision: 1,
        signingPublicKey: "fixture",
        status: "active" as const,
        updatedAt: now,
        userId,
        wrappingPublicKey: "fixture",
      };
      await reserveDeviceQuotaForInsert(ctx, userId, device);
      const deviceId = await ctx.db.insert("devices", device);
      const binding = {
        authEpoch: 1,
        authSessionId,
        boundAt: now,
        deviceId,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "custody", binding);
      await ctx.db.insert("deviceSessions", binding);
      return { authSessionId, deviceId };
    };
    const daemon = await installDevice("daemon", "daemon");
    const browser = await installDevice("browser", "browser");
    return { browser, daemon, userId };
  });
  const actor = (sessionId: Id<"authSessions">) => testRuntime.withIdentity({
    issuer: "https://test.example",
    subject: `${ids.userId}|${sessionId}`,
    tokenIdentifier: `test|${sessionId}`,
  });
  return {
    browser: actor(ids.browser.authSessionId),
    daemon: actor(ids.daemon.authSessionId),
    ids,
    testRuntime,
  };
}

async function initializeSpace(world: Awaited<ReturnType<typeof memoryWorld>>) {
  const request = {
    bindingPolicy: "one_project_one_space" as const,
    encryptedDescriptor: envelope(1, "G"),
    genesisHeadProof: envelope(1, "F"),
    genesisToken,
    identityContract: 2 as const,
    keyVersion: 1,
    spaceId,
    wrappedSpaceKey: envelope(7, "H"),
  };
  const response = await world.daemon.mutation(createSpace, request);
  return { request, response };
}

describe("dark canonical memory sync", () => {
  test("creates and reads only owner-scoped opaque ciphertext under daemon authority", async () => {
    const world = await memoryWorld();
    const created = await initializeSpace(world);
    expect(parseCanonicalMemoryCreateResult(created.response)).not.toBeNull();
    expect(created.response).toMatchObject({
      bindingPolicy: "one_project_one_space",
      identityContract: 2,
      keyVersion: 1,
      replay: false,
      revision: 1,
      spaceId,
    });
    expect(await world.daemon.mutation(createSpace, created.request))
      .toMatchObject({ replay: true, revision: 1, spaceId });
    await expect(world.daemon.mutation(createSpace, {
      ...created.request,
      spaceId: "memory_space_001",
    })).rejects.toThrow("MEMORY_SYNC_INVALID");
    const listed = await world.daemon.query(listSpaces, { limit: 100 });
    expect(parseCanonicalMemorySpaceList(listed)).not.toBeNull();
    expect(listed).toEqual([
      expect.objectContaining({ identityContract: 2, revision: 1, spaceId }),
    ]);
    const configured = await world.daemon.query(getSpace, { spaceId });
    expect(parseCanonicalMemorySpaceConfiguration(configured)).not.toBeNull();
    expect(configured).toMatchObject({
      encryptedDescriptor: created.request.encryptedDescriptor,
      genesisToken,
      spaceId,
      wrappedSpaceKey: created.request.wrappedSpaceKey,
    });
    const emptyHead = await world.daemon.query(getHead, { spaceId });
    expect(parseCanonicalMemoryHead(emptyHead)).not.toBeNull();
    expect(emptyHead).toMatchObject({
      headToken: genesisToken,
      sequence: 0,
      spaceId,
      terminalHeadProof: created.request.genesisHeadProof,
    });

    const stored = await world.testRuntime.run(async (ctx) => ({
      operations: await ctx.db.query("memoryOperations").collect(),
      spaces: await ctx.db.query("memorySpaces").collect(),
    }));
    expect(stored.operations).toEqual([]);
    expect(stored.spaces).toHaveLength(1);
    expect(Object.keys(stored.spaces[0] ?? {}).sort()).toEqual([
      "_creationTime",
      "_id",
      "bindingPolicy",
      "createdAt",
      "encryptedDescriptor",
      "genesisHeadProof",
      "genesisToken",
      "identityContract",
      "keyVersion",
      "publicId",
      "revision",
      "updatedAt",
      "userId",
      "wrappedSpaceKey",
    ]);
    expect(JSON.stringify(stored)).not.toContain("hra:project:");
    expect(JSON.stringify(stored)).not.toContain("canonicalRealmId");

    await expect(world.browser.query(getHead, { spaceId }))
      .rejects.toThrow("BROWSER_DEVICE_CANNOT_EXECUTE");
    await expect(world.browser.query(pull, {
      afterHeadToken: genesisToken,
      afterSequence: 0,
      limit: 1,
      spaceId,
      terminalHeadToken: genesisToken,
      terminalSequence: 0,
    })).rejects.toThrow("BROWSER_DEVICE_CANNOT_EXECUTE");
  });

  test("accepts one extension, exact historical replay, and terminal-bounded pull", async () => {
    const world = await memoryWorld();
    await initializeSpace(world);
    const first = operation(1, genesisToken, headToken1, 1, envelope(1, "P"));
    const firstWrite = await world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 1,
      operations: [first],
      spaceId,
    });
    expect(parseCanonicalMemoryWriteResult(firstWrite)).not.toBeNull();
    expect(firstWrite).toMatchObject({
      acceptedHeadToken: headToken1,
      acceptedSequence: 1,
      replay: false,
    });
    const observedTerminal = await world.daemon.query(getHead, { spaceId });
    const second = operation(2, headToken1, headToken2);
    const secondWrite = await world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 1,
      operations: [second],
      spaceId,
    });
    expect(parseCanonicalMemoryWriteResult(secondWrite)).not.toBeNull();
    expect(secondWrite).toMatchObject({
      acceptedHeadToken: headToken2,
      acceptedSequence: 2,
      replay: false,
    });

    // A lost response may be reconciled after unrelated later progress. The
    // wholly historical submitted row is compared exactly, not against the
    // current head revision.
    const historicalReplay = await world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 1,
      operations: [first],
      spaceId,
    });
    expect(parseCanonicalMemoryWriteResult(historicalReplay)).not.toBeNull();
    expect(historicalReplay).toMatchObject({
      acceptedHeadToken: headToken1,
      acceptedSequence: 1,
      acceptedTerminalHeadProof: first.terminalHeadProof,
      replay: true,
    });
    await expect(world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 1,
      operations: [{ ...first, adoptionProof: envelope(1, "Q") }],
      spaceId,
    })).rejects.toThrow("MEMORY_SYNC_CONFLICT");

    const oldTerminalPage = await world.daemon.query(pull, {
      afterHeadToken: genesisToken,
      afterSequence: 0,
      limit: 1,
      spaceId,
      terminalHeadToken: observedTerminal.headToken,
      terminalSequence: observedTerminal.sequence,
    });
    expect(parseCanonicalMemoryPullPage(oldTerminalPage)).not.toBeNull();
    expect(oldTerminalPage).toEqual({
      done: true,
      operations: [first],
      spaceId,
      terminalHeadToken: headToken1,
      terminalSequence: 1,
    });
    const firstPage = await world.daemon.query(pull, {
      afterHeadToken: genesisToken,
      afterSequence: 0,
      limit: 1,
      spaceId,
      terminalHeadToken: headToken2,
      terminalSequence: 2,
    });
    expect(firstPage).toMatchObject({ done: false, operations: [first] });
    expect(await world.daemon.query(pull, {
      afterHeadToken: headToken1,
      afterSequence: 1,
      limit: 1,
      spaceId,
      terminalHeadToken: headToken2,
      terminalSequence: 2,
    })).toMatchObject({ done: true, operations: [second] });
    expect(await world.testRuntime.run(async (ctx) =>
      (await ctx.db.query("memoryOperations").collect()).length)).toBe(2);
  });

  test("rejects a legacy broad hosted id on both write and discovery boundaries", async () => {
    const world = await memoryWorld();
    const created = await initializeSpace(world);
    await expect(world.daemon.mutation(createSpace, {
      ...created.request,
      spaceId: "memory_space_legacy",
    })).rejects.toThrow("MEMORY_SYNC_INVALID");

    await world.testRuntime.run(async (ctx) => {
      const source = (await ctx.db.query("memorySpaces").collect())[0];
      if (source === undefined) throw new Error("missing source memory space");
      await ctx.db.insert("memorySpaces", {
        bindingPolicy: source.bindingPolicy,
        createdAt: source.createdAt,
        encryptedDescriptor: source.encryptedDescriptor,
        genesisHeadProof: source.genesisHeadProof,
        genesisToken: source.genesisToken,
        identityContract: source.identityContract,
        keyVersion: source.keyVersion,
        publicId: "memory_space_legacy",
        revision: source.revision,
        updatedAt: source.updatedAt + 1,
        userId: source.userId,
        wrappedSpaceKey: source.wrappedSpaceKey,
      });
    });
    await expect(world.daemon.query(listSpaces, { limit: 100 }))
      .rejects.toThrow("MEMORY_SYNC_STORAGE_CORRUPT");
  });

  test("fails closed for conflicts, gaps, mixed batches, stale authority, and missing spaces", async () => {
    const world = await memoryWorld();
    await initializeSpace(world);
    const first = operation(1, genesisToken, headToken1);
    await world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 1,
      operations: [first],
      spaceId,
    });
    const second = operation(2, headToken1, headToken2);
    await world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 1,
      operations: [second],
      spaceId,
    });

    await expect(world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 1,
      operations: [{ ...first, operation: envelope(1, "Z") }],
      spaceId,
    })).rejects.toThrow("MEMORY_SYNC_CONFLICT");
    await expect(world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 2,
      operations: [first, operation(3, headToken2, headToken3)],
      spaceId,
    })).rejects.toThrow("MEMORY_SYNC_INVALID");

    for (const request of [
      {
        expectedKeyVersion: 1,
        expectedRevision: 1,
        operations: [operation(4, headToken2, headToken3)],
        spaceId,
      },
      {
        expectedKeyVersion: 1,
        expectedRevision: 2,
        operations: [operation(3, headToken2, headToken3)],
        spaceId,
      },
      {
        expectedKeyVersion: 2,
        expectedRevision: 1,
        operations: [operation(3, headToken2, headToken3, 2)],
        spaceId,
      },
      {
        expectedKeyVersion: 1,
        expectedRevision: 1,
        operations: [operation(3, "4".repeat(64), headToken3)],
        spaceId,
      },
      {
        expectedKeyVersion: 1,
        expectedRevision: 1,
        operations: [operation(3, headToken2, headToken1)],
        spaceId,
      },
    ]) await expect(world.daemon.mutation(push, request))
      .rejects.toThrow("MEMORY_SYNC_CONFLICT");

    await expect(world.daemon.query(pull, {
      afterHeadToken: genesisToken,
      afterSequence: 0,
      limit: 1,
      spaceId,
      terminalHeadToken: "f".repeat(64),
      terminalSequence: 1,
    })).rejects.toThrow("MEMORY_SYNC_CONFLICT");
    await expect(world.daemon.query(getHead, { spaceId: `memory_${"M".repeat(32)}` }))
      .rejects.toThrow("MEMORY_SPACE_MISSING");
    expect(await world.testRuntime.run(async (ctx) =>
      (await ctx.db.query("memoryOperations").collect()).length)).toBe(2);
  });

  test("charges exact memory quota and erases immutable history only with the account", async () => {
    const world = await memoryWorld();
    await initializeSpace(world);
    const acceptedProof = {
      ...envelope(1, "P"),
      ciphertext: "P".repeat(canonicalMemorySyncLimits.adoptionProofCiphertextCharacters),
    };
    await world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 1,
      operations: [operation(1, genesisToken, headToken1, 1, acceptedProof)],
      spaceId,
    });
    const before = await world.testRuntime.run(async (ctx) => {
      const spaces = await ctx.db.query("memorySpaces").collect();
      const operations = await ctx.db.query("memoryOperations").collect();
      const quota = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", world.ids.userId)
          .eq("category", "memory"))
        .unique();
      const resource = await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (builder) => builder
          .eq("userId", world.ids.userId)
          .eq("resource", "memory_space"))
        .unique();
      return { operations, quota, resource, spaces };
    });
    expect(before.quota).toMatchObject({
      logicalBytes: [...before.spaces, ...before.operations]
        .reduce((total, row) => total + logicalDocumentBytes(row), 0),
      records: 2,
    });
    const storedOperation = before.operations[0];
    if (storedOperation === undefined) throw new Error("missing charged memory operation");
    expect(storedOperation.adoptionProof).toEqual(acceptedProof);
    expect(Object.keys(storedOperation).sort()).toEqual([
      "_creationTime",
      "_id",
      "adoptionProof",
      "baseRevision",
      "createdAt",
      "genesisToken",
      "headToken",
      "keyVersion",
      "memorySpaceId",
      "operation",
      "priorToken",
      "sequence",
      "sourceDeviceId",
      "terminalHeadProof",
      "userId",
    ]);
    expect(logicalDocumentBytes(storedOperation)).toBeGreaterThan(
      logicalDocumentBytes({ ...storedOperation, adoptionProof: null }),
    );
    expect(before.resource).toMatchObject({ records: 1 });
    await expect(world.daemon.mutation(push, {
      expectedKeyVersion: 1,
      expectedRevision: 1,
      operations: [operation(2, headToken1, headToken2, 1, {
        ...acceptedProof,
        ciphertext: `${acceptedProof.ciphertext}P`,
      })],
      spaceId,
    })).rejects.toThrow("MEMORY_SYNC_INVALID");

    await world.daemon.mutation(requestDeletion, {
      jobId: "delete_memory_history_AAAAAAAAAAAAAAAA",
      statusCapability: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE",
    });
    let complete = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await world.testRuntime.mutation(drainDeletion, { limit: 200 });
      if (result.kind === "complete") {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    expect(await world.testRuntime.run(async (ctx) => ({
      operations: (await ctx.db.query("memoryOperations").collect()).length,
      spaces: (await ctx.db.query("memorySpaces").collect()).length,
    }))).toEqual({ operations: 0, spaces: 0 });
  });

  test("keeps every hosted inventory and client capability closed over memory tables", () => {
    const schemaTables = Object.keys(HOSTED_TABLE_LIFECYCLE).sort();
    expect(Object.keys(ACCOUNT_DELETION_TABLE_STRATEGY).sort()).toEqual(schemaTables);
    expect(Object.keys(DEVICE_REVOCATION_TABLE_STRATEGY).sort()).toEqual(schemaTables);
    expect(Object.keys(MAINTENANCE_RETENTION_STRATEGY).sort()).toEqual(schemaTables);
    expect(ACCOUNT_DELETION_TABLE_STRATEGY.memoryOperations)
      .toBe("user_index_immutable_erasure");
    expect(DEVICE_REVOCATION_TABLE_STRATEGY.memoryOperations)
      .toBe("source_attribution_retained");
    expect(MAINTENANCE_RETENTION_STRATEGY.memorySpaces).toEqual([]);
    expect(MAINTENANCE_RETENTION_STRATEGY.memoryOperations).toEqual([]);
    expect(USER_RESOURCE_QUOTAS.memory_space).toBe(100);
    expect(nextResourceRecords(99, 1, USER_RESOURCE_QUOTAS.memory_space)).toBe(100);
    expect(() => nextResourceRecords(100, 1, USER_RESOURCE_QUOTAS.memory_space))
      .toThrow("QUOTA_EXCEEDED");
    expect(cloudQueries.filter((name) => name.startsWith("memorySync:"))).toEqual([
      "memorySync:list",
      "memorySync:get",
      "memorySync:head",
      "memorySync:pull",
    ]);
    expect(cloudMutations.filter((name) => name.startsWith("memorySync:"))).toEqual([
      "memorySync:create",
      "memorySync:push",
    ]);
  });
});
