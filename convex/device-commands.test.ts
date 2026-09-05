import { describe, expect, jest, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { expectPromiseToReject } from "../src/cloud/testAssertions";
import { deviceCommandLoginResultLifetimeMs } from "../src/cloud/payloads";
import {
  adjustCommandQuotaForPatch,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  reserveQuotaForStoredIdentity,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
type Authority = Readonly<{ bootGeneration: number; bootId: string; fence: number }>;

const register = makeFunctionReference<"mutation", Args, unknown>("devices:register");
const approve = makeFunctionReference<"mutation", Args, unknown>("devices:approve");
const revoke = makeFunctionReference<"mutation", Args, unknown>("devices:revoke");
const enqueue = makeFunctionReference<"mutation", Args, unknown>("deviceCommands:enqueue");
const acknowledge = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:acknowledgeReceipt",
);
const prepare = makeFunctionReference<"mutation", Args, unknown>("deviceCommands:prepare");
const markEffectStarted = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:markEffectStarted",
);
const settle = makeFunctionReference<"mutation", Args, unknown>("deviceCommands:settle");
const recoverEffectStarted = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:recoverEffectStarted",
);
const confirmRevokedTerminal = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:confirmRevokedTerminal",
);
const confirmTerminalRecovery = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:confirmTerminalRecovery",
);
const cancelPending = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:cancelPending",
);
const consumeResult = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:consumeResult",
);
const expireLoginResult = makeFunctionReference<"mutation", Args, unknown>(
  "maintenance:expireDeviceCommandLoginResult",
);
const getCommand = makeFunctionReference<"query", Args, unknown>("deviceCommands:get");
const listPending = makeFunctionReference<"query", Args, unknown>(
  "deviceCommands:listPendingForTarget",
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
const resultEnvelope = { ...envelope, ciphertext: "R".repeat(48) };
const publicKey = JSON.stringify({ crv: "P-256", kty: "EC", x: "A".repeat(43), y: "B".repeat(43) });
const wrappedKeyEnvelope = {
  algorithm: "P256-HKDF-SHA256+A256GCM" as const,
  ciphertext: "C".repeat(64),
  ephemeralPublicKey: publicKey,
  keyVersion: 1,
  nonce: "D".repeat(16),
};
const daemonAuthority: Authority = { bootGeneration: 1, bootId: "boot_00000001", fence: 1 };
const laterAuthority: Authority = { bootGeneration: 2, bootId: "boot_00000002", fence: 1 };
const latestAuthority: Authority = { bootGeneration: 3, bootId: "boot_00000003", fence: 1 };

function uuidV7(now: number, suffix: string): string {
  const timestamp = now.toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`;
}

type Runtime = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

async function deviceCommandWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "device-commands@example.com",
      emailVerificationTime: now,
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    await ctx.db.insert("authSubjects", {
      authEpoch: 1,
      createdAt: now,
      emailDigest: "a".repeat(64),
      status: "active",
      updatedAt: now,
      userId,
    });
    const daemonAuthSessionId = await ctx.db.insert("authSessions", {
      expirationTime: now + 3_600_000,
      userId,
    });
    const browserAuthSessionId = await ctx.db.insert("authSessions", {
      expirationTime: now + 3_600_000,
      userId,
    });
    return { browserAuthSessionId, daemonAuthSessionId, userId };
  });
  const asSession = (authSessionId: string): Runtime => testRuntime.withIdentity({
    issuer: "https://test.example",
    subject: `${ids.userId}|${authSessionId}`,
    tokenIdentifier: `test|${authSessionId}`,
  });
  const daemon = asSession(ids.daemonAuthSessionId);
  const browser = asSession(ids.browserAuthSessionId);
  await daemon.mutation(register, {
    bootstrapKeyEnvelope: wrappedKeyEnvelope,
    encryptedLabel: envelope,
    idempotencyKey: uuidV7(now, "01"),
    keyVersion: 1,
    publicId: "device_daemon01",
    requestDigest: "a".repeat(64),
    signingPublicKey: publicKey,
    wrappingPublicKey: publicKey,
  });
  await browser.mutation(register, {
    deviceClass: "browser",
    encryptedLabel: envelope,
    idempotencyKey: uuidV7(now, "02"),
    keyVersion: 1,
    publicId: "device_browser1",
    requestDigest: "b".repeat(64),
    signingPublicKey: publicKey,
    wrappingPublicKey: publicKey,
  });
  await daemon.mutation(approve, {
    expectedRevision: 1,
    idempotencyKey: uuidV7(now, "03"),
    keyEnvelope: wrappedKeyEnvelope,
    requestDigest: "c".repeat(64),
    targetPublicId: "device_browser1",
  });
  let ordinal = 16;
  const enqueueFrom = async (
    runtime: Runtime,
    overrides: Args = {},
  ): Promise<Readonly<{ publicId: string }>> => {
    ordinal += 1;
    const suffix = ordinal.toString(16).padStart(2, "0");
    const publicId = uuidV7(now, `a${suffix}`);
    const response = await runtime.mutation(enqueue, {
      deadline: Date.now() + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: uuidV7(now, `b${suffix}`),
      kind: "usage_refresh",
      payload: envelope,
      publicId,
      requestDigest: suffix.padEnd(64, "d"),
      ...overrides,
    }) as Readonly<{ publicId: string }>;
    return response;
  };
  return { browser, daemon, enqueueFrom, ids, now, testRuntime, uuid: (s: string) => uuidV7(now, s) };
}

async function expectTerminalCleanup(
  world: Awaited<ReturnType<typeof deviceCommandWorld>>,
  commandPublicId: string,
  state: "applied" | "failed" | "ambiguous" | "cancelled" | "expired",
): Promise<void> {
  const receipt = await world.testRuntime.run(async (ctx) => {
    const row = (await ctx.db.query("deviceCommands").collect())
      .find((entry) => entry.publicId === commandPublicId);
    return row === undefined
      ? null
      : {
          requesterAcknowledgedAt: row.requesterAcknowledgedAt,
          state: row.state,
          terminalCleanupAfter: row.terminalCleanupAfter,
        };
  });
  if (
    typeof receipt?.requesterAcknowledgedAt !== "number"
    || typeof receipt.terminalCleanupAfter !== "number"
  ) throw new Error(`missing terminal device-command cleanup custody: ${JSON.stringify(receipt)}`);
  expect(receipt.state).toBe(state);
  expect(receipt.terminalCleanupAfter).toBeGreaterThan(receipt.requesterAcknowledgedAt);
}

describe("device commands", () => {
  test("runs the full lifecycle from a browser device to a daemon target", async () => {
    const world = await deviceCommandWorld();
    const enqueued = await world.browser.mutation(enqueue, {
      deadline: Date.now() + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: world.uuid("11"),
      kind: "session_start",
      payload: envelope,
      publicId: world.uuid("21"),
      requestDigest: "1".repeat(64),
    });
    expect(enqueued).toMatchObject({
      publicId: world.uuid("21"),
      replay: false,
      state: "pending",
      targetDevicePublicId: "device_daemon01",
    });

    const pending = await world.daemon.query(listPending, { limit: 10 }) as readonly unknown[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "session_start", state: "pending" });

    expect(await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("21"),
      localPhase: "prepared_no_effect",
    })).toMatchObject({ replay: false, state: "prepared" });
    // A second prepare under the same boot authority is a replay, not a second claim.
    expect(await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("21"),
      localPhase: "prepared_no_effect",
    })).toMatchObject({ replay: true, state: "prepared" });
    expect(await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("21"),
    })).toMatchObject({ replay: false, state: "effect_started" });
    expect(await world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("21"),
      result: resultEnvelope,
      resultCode: "APPLIED",
      resultDigest: "e".repeat(64),
      state: "applied",
    })).toMatchObject({ replay: false, state: "applied" });

    const settled = await world.browser.query(getCommand, {
      commandPublicId: world.uuid("21"),
    }) as Readonly<{ result?: unknown; resultCode: string; state: string }>;
    expect(settled).toMatchObject({ resultCode: "APPLIED", state: "applied" });
    expect(settled.result).toEqual(resultEnvelope);
    await expectTerminalCleanup(world, world.uuid("21"), "applied");
  });

  test("a browser device is never a device command target", async () => {
    const world = await deviceCommandWorld();
    await expectPromiseToReject(
      world.daemon.mutation(enqueue, {
        deadline: Date.now() + 60_000,
        expectedTargetDevicePublicId: "device_browser1",
        idempotencyKey: world.uuid("12"),
        kind: "usage_refresh",
        payload: envelope,
        publicId: world.uuid("22"),
        requestDigest: "2".repeat(64),
      }),
      "DEVICE_COMMAND_TARGET_NOT_EXECUTOR",
    );
  });

  test("a browser device cannot execute the lifecycle it enqueued", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, { publicId: world.uuid("23") });
    await expectPromiseToReject(
      world.browser.mutation(prepare, {
        authority: daemonAuthority,
        commandPublicId: world.uuid("23"),
        localPhase: "prepared_no_effect",
      }),
      "BROWSER_DEVICE_CANNOT_EXECUTE",
    );
  });

  test("replays an identical enqueue and refuses a conflicting digest", async () => {
    const world = await deviceCommandWorld();
    const request = {
      deadline: Date.now() + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: world.uuid("13"),
      kind: "usage_refresh",
      payload: envelope,
      publicId: world.uuid("24"),
      requestDigest: "3".repeat(64),
    };
    expect(await world.browser.mutation(enqueue, request)).toMatchObject({ replay: false });
    expect(await world.browser.mutation(enqueue, request)).toMatchObject({ replay: true });
    await expectPromiseToReject(
      world.browser.mutation(enqueue, { ...request, requestDigest: "4".repeat(64) }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  test("atomically acknowledges a new enqueue while every replay stays byte-stable", async () => {
    const world = await deviceCommandWorld();
    const request = {
      deadline: Date.now() + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: world.uuid("1a"),
      kind: "usage_refresh",
      payload: envelope,
      publicId: world.uuid("4a"),
      requestDigest: "a".repeat(64),
    };
    expect(await world.browser.mutation(enqueue, request)).toMatchObject({ replay: false });
    const inserted = await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      return rows.find((entry) => entry.publicId === request.publicId) ?? null;
    });
    expect(typeof inserted?.requesterAcknowledgedAt).toBe("number");
    expect(inserted?.terminalCleanupAfter).toBeUndefined();

    expect(await world.browser.mutation(enqueue, request)).toMatchObject({ replay: true });
    expect(await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      const row = rows.find((entry) => entry.publicId === request.publicId);
      return {
        acknowledgedAt: row?.requesterAcknowledgedAt,
        matchingRows: rows.filter((entry) => entry.publicId === request.publicId).length,
      };
    })).toEqual({
      acknowledgedAt: inserted?.requesterAcknowledgedAt,
      matchingRows: 1,
    });

    // A pre-upgrade row may lack acknowledgement. Replaying it must remain a
    // read-only response: adding metadata here could fail at the hard byte
    // ceiling and misreport a known committed row as an enqueue abort.
    await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      const row = rows.find((entry) => entry.publicId === request.publicId);
      if (row === undefined) throw new Error("missing command fixture");
      const patch = { requesterAcknowledgedAt: undefined };
      await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
      await ctx.db.patch(row._id, patch);
    });
    const legacyBeforeReplay = await world.testRuntime.run(async (ctx) => {
      const row = (await ctx.db.query("deviceCommands").collect())
        .find((entry) => entry.publicId === request.publicId);
      if (row === undefined) throw new Error("missing legacy command fixture");
      return row;
    });
    expect(await world.browser.mutation(enqueue, request)).toMatchObject({ replay: true });
    const legacyAfterReplay = await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      return rows.find((entry) => entry.publicId === request.publicId) ?? null;
    });
    expect(legacyAfterReplay).toEqual(legacyBeforeReplay);
    expect(legacyAfterReplay?.requesterAcknowledgedAt).toBeUndefined();
  });

  test("quarantines an effect that may have begun as ambiguous under a later boot", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, {
      kind: "session_start",
      publicId: world.uuid("25"),
    });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("25"),
      localPhase: "prepared_no_effect",
    });
    await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("25"),
    });

    // The daemon crashed here. A later boot may only close it as ambiguous.
    await expectPromiseToReject(world.daemon.mutation(recoverEffectStarted, {
      commandPublicId: world.uuid("25"),
      recoveryAuthority: laterAuthority,
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      resultDigest: "f".repeat(64),
      staleAuthority: daemonAuthority,
      state: "failed",
    }));
    // And the stale authority itself cannot settle it as applied under a new boot.
    await expectPromiseToReject(world.daemon.mutation(settle, {
      authority: laterAuthority,
      commandPublicId: world.uuid("25"),
      resultCode: "APPLIED",
      resultDigest: "f".repeat(64),
      state: "applied",
    }));

    expect(await world.daemon.mutation(recoverEffectStarted, {
      commandPublicId: world.uuid("25"),
      recoveryAuthority: laterAuthority,
      resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
      resultDigest: "f".repeat(64),
      staleAuthority: daemonAuthority,
      state: "ambiguous",
    })).toMatchObject({ replay: false, state: "ambiguous" });
    expect(await world.browser.query(getCommand, { commandPublicId: world.uuid("25") }))
      .toMatchObject({ resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED", state: "ambiguous" });
    await expectTerminalCleanup(world, world.uuid("25"), "ambiguous");
  });

  test("an earlier boot can never take a prepared command from a later one", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, { publicId: world.uuid("26") });
    await world.daemon.mutation(prepare, {
      authority: laterAuthority,
      commandPublicId: world.uuid("26"),
      localPhase: "prepared_no_effect",
    });
    await expectPromiseToReject(world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("26"),
      localPhase: "prepared_no_effect",
    }));
    // A strictly later authority may rebind, because nothing has started.
    expect(await world.daemon.mutation(prepare, {
      authority: { bootGeneration: 3, bootId: "boot_00000003", fence: 1 },
      commandPublicId: world.uuid("26"),
      localPhase: "prepared_no_effect",
    })).toMatchObject({ rebound: true, state: "prepared" });
  });

  test("a later boot fails a pending command when local prepared evidence proves no effect", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, { publicId: world.uuid("39") });

    expect(await world.daemon.mutation(recoverEffectStarted, {
      commandPublicId: world.uuid("39"),
      localPhase: "prepared_no_effect",
      recoveryAuthority: laterAuthority,
      resultCode: "LOCAL_AUTHORITY_CHANGED_BEFORE_EFFECT",
      resultDigest: "9".repeat(64),
      staleAuthority: daemonAuthority,
      state: "failed",
    })).toMatchObject({ replay: false, state: "failed" });
    expect(await world.daemon.mutation(recoverEffectStarted, {
      commandPublicId: world.uuid("39"),
      localPhase: "prepared_no_effect",
      recoveryAuthority: laterAuthority,
      resultCode: "LOCAL_AUTHORITY_CHANGED_BEFORE_EFFECT",
      resultDigest: "9".repeat(64),
      staleAuthority: daemonAuthority,
      state: "failed",
    })).toMatchObject({ replay: true, state: "failed" });
    await expectTerminalCleanup(world, world.uuid("39"), "failed");
  });

  for (const localPhase of ["prepared_no_effect", "effect_started"] as const) {
    test(`replays an exact ${localPhase} recovery through a second daemon restart`, async () => {
      const world = await deviceCommandWorld();
      const commandPublicId = world.uuid(localPhase === "prepared_no_effect" ? "3a" : "3b");
      const state = localPhase === "prepared_no_effect" ? "failed" as const : "ambiguous" as const;
      const resultCode = localPhase === "prepared_no_effect"
        ? "LOCAL_AUTHORITY_CHANGED_BEFORE_EFFECT"
        : "LOCAL_EFFECT_RECOVERY_REQUIRED";
      const resultDigest = (localPhase === "prepared_no_effect" ? "a" : "b").repeat(64);
      await world.enqueueFrom(world.browser, { publicId: commandPublicId });
      await world.daemon.mutation(prepare, {
        authority: daemonAuthority,
        commandPublicId,
        localPhase: "prepared_no_effect",
      });
      if (localPhase === "effect_started") {
        await world.daemon.mutation(markEffectStarted, {
          authority: daemonAuthority,
          commandPublicId,
        });
      }
      expect(await world.daemon.mutation(recoverEffectStarted, {
        commandPublicId,
        localPhase,
        recoveryAuthority: laterAuthority,
        resultCode,
        resultDigest,
        staleAuthority: daemonAuthority,
        state,
      })).toMatchObject({ replay: false, state });

      // Boot 2 committed the terminal recovery but lost its response. Boot 3
      // still owns boot 1's local journal and may prove, but never rewrite, the
      // exact intervening recovery terminal.
      expect(await world.daemon.mutation(recoverEffectStarted, {
        commandPublicId,
        localPhase,
        recoveryAuthority: latestAuthority,
        resultCode,
        resultDigest,
        staleAuthority: daemonAuthority,
        state,
      })).toMatchObject({ replay: true, state });
      await expectPromiseToReject(world.daemon.mutation(recoverEffectStarted, {
        commandPublicId,
        localPhase,
        recoveryAuthority: daemonAuthority,
        resultCode,
        resultDigest,
        staleAuthority: daemonAuthority,
        state,
      }));
      expect(await world.browser.query(getCommand, { commandPublicId })).toMatchObject({
        boundAuthority: laterAuthority,
        resultCode,
        state,
      });
      await expectTerminalCleanup(world, commandPublicId, state);
    });
  }

  test("expires a command whose deadline passed before the daemon claimed it", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, {
      deadline: Date.now() + 5,
      publicId: world.uuid("27"),
    });
    await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      const row = rows.find((entry) => entry.publicId === world.uuid("27"));
      if (row === undefined) throw new Error("missing command fixture");
      await ctx.db.patch(row._id, { deadline: Date.now() - 1 });
    });
    expect(await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("27"),
      localPhase: "prepared_no_effect",
    })).toMatchObject({ state: "expired" });
    await expectTerminalCleanup(world, world.uuid("27"), "expired");
    expect(await world.daemon.mutation(confirmTerminalRecovery, {
      commandPublicId: world.uuid("27"),
      localPhase: "prepared_no_effect",
      staleAuthority: daemonAuthority,
    })).toEqual({
      publicId: world.uuid("27"),
      replay: true,
      state: "expired",
    });
  });

  test("an acknowledged prepared command gains cleanup when it expires before effect", async () => {
    const world = await deviceCommandWorld();
    const commandPublicId = world.uuid("47");
    await world.enqueueFrom(world.browser, { publicId: commandPublicId });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId,
      localPhase: "prepared_no_effect",
    });
    await world.testRuntime.run(async (ctx) => {
      const row = (await ctx.db.query("deviceCommands").collect())
        .find((entry) => entry.publicId === commandPublicId);
      if (row === undefined) throw new Error("missing prepared command fixture");
      await ctx.db.patch(row._id, { deadline: Date.now() - 1 });
    });
    expect(await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId,
    })).toMatchObject({ state: "expired" });
    await expectTerminalCleanup(world, commandPublicId, "expired");
  });

  test("releases a single-use result exactly once, to the requester only", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, {
      kind: "account_login_start",
      publicId: world.uuid("28"),
    });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      localPhase: "prepared_no_effect",
    });
    await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
    });
    // An applied login cannot omit the ciphertext even if it carries the
    // single-use marker: otherwise a crash could publish success with no
    // handoff for the requester to consume.
    await expectPromiseToReject(world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      resultCode: "APPLIED",
      resultDigest: "a".repeat(64),
      singleUseResult: true,
      state: "applied",
    }));
    // A login handoff that is not marked single use is refused outright.
    await expectPromiseToReject(world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      result: resultEnvelope,
      resultCode: "APPLIED",
      resultDigest: "a".repeat(64),
      state: "applied",
    }));
    // A ciphertext-bearing handoff is never valid evidence for a failed or
    // ambiguous login terminal.
    await expectPromiseToReject(world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      result: resultEnvelope,
      resultCode: "FAILED",
      resultDigest: "a".repeat(64),
      singleUseResult: true,
      state: "failed",
    }));
    await world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      result: resultEnvelope,
      resultCode: "APPLIED",
      resultDigest: "a".repeat(64),
      singleUseResult: true,
      state: "applied",
    });
    // A v4 terminal journal did not retain ciphertext. Its result-less replay
    // is accepted only because the hosted row already owns the exact relay.
    expect(await world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      resultCode: "APPLIED",
      resultDigest: "a".repeat(64),
      state: "applied",
    })).toMatchObject({ replay: true, state: "applied" });

    // An ordinary read never carries the ciphertext.
    const beforeRead = await world.browser.query(getCommand, {
      commandPublicId: world.uuid("28"),
    }) as Readonly<{ result?: unknown; resultConsumed: boolean; resultSingleUse: boolean }>;
    expect(beforeRead.result).toBeUndefined();
    expect(beforeRead).toMatchObject({ resultConsumed: false, resultSingleUse: true });

    expect(await world.browser.mutation(consumeResult, { commandPublicId: world.uuid("28") }))
      .toMatchObject({
        expiresAt: expect.any(Number),
        result: resultEnvelope,
        status: "released",
      });
    expect(await world.browser.mutation(consumeResult, { commandPublicId: world.uuid("28") }))
      .toMatchObject({ status: "spent" });
    expect(await world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("28"),
      resultCode: "APPLIED",
      resultDigest: "a".repeat(64),
      state: "applied",
    })).toMatchObject({ replay: true, state: "applied" });
    // The target device is not the requester and may never exchange the relay.
    await expectPromiseToReject(
      world.daemon.mutation(consumeResult, { commandPublicId: world.uuid("28") }),
    );
    expect(await world.browser.query(getCommand, { commandPublicId: world.uuid("28") }))
      .toMatchObject({ resultConsumed: true, resultSingleUse: true });
  });

  test("erases an expired login handoff without releasing its ciphertext", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, {
      kind: "account_login_start",
      publicId: world.uuid("38"),
    });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("38"),
      localPhase: "prepared_no_effect",
    });
    await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("38"),
    });
    await world.daemon.mutation(settle, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("38"),
      result: resultEnvelope,
      resultCode: "APPLIED",
      resultDigest: "e".repeat(64),
      singleUseResult: true,
      state: "applied",
    });
    await world.testRuntime.run(async (ctx) => {
      const row = (await ctx.db
        .query("deviceCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", world.uuid("38")))
        .unique());
      if (row === null) throw new Error("missing device command fixture");
      await ctx.db.patch(row._id, {
        resultExpiresAt: Date.now() - 1,
      });
    });

    expect(await world.browser.mutation(consumeResult, { commandPublicId: world.uuid("38") }))
      .toMatchObject({ status: "expired" });
    expect(await world.browser.mutation(consumeResult, { commandPublicId: world.uuid("38") }))
      .toMatchObject({ status: "spent" });
    expect(await world.browser.query(getCommand, { commandPublicId: world.uuid("38") }))
      .toMatchObject({ resultConsumed: true, resultSingleUse: true });
  });

  test("scheduled expiry erases an unattended login handoff exactly once", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, {
      kind: "account_login_start",
      publicId: world.uuid("39"),
    });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("39"),
      localPhase: "prepared_no_effect",
    });
    await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("39"),
    });

    const accounting = async () => await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands")
        .withIndex("by_user", (builder) => builder.eq("userId", world.ids.userId))
        .collect();
      const row = rows.find((candidate) => candidate.publicId === world.uuid("39"));
      const commandQuota = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", world.ids.userId)
          .eq("category", "command"))
        .unique();
      const service = await ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .unique();
      if (row === undefined || commandQuota === null || service === null) {
        throw new Error("missing login-result accounting fixture");
      }
      const chargedRows = rows.map((document) => Object.fromEntries(
        Object.entries(document).filter(([key]) => key !== "_creationTime" && key !== "_id"),
      ) as Readonly<Record<string, Value>>);
      return {
        commandBytes: commandQuota.logicalBytes,
        expectedCommandBytes: chargedRows.reduce(
          (total, document) => total + logicalDocumentBytes(document),
          0,
        ),
        result: row.result,
        resultConsumedAt: row.resultConsumedAt,
        resultExpiresAt: row.resultExpiresAt,
        rowBytes: logicalDocumentBytes(chargedRows.find(
          (document) => document.publicId === world.uuid("39"),
        ) ?? {}),
        serviceUserBytes: service.userLogicalBytes,
      };
    });

    jest.useFakeTimers();
    try {
      const settledAt = Date.now();
      await world.daemon.mutation(settle, {
        authority: daemonAuthority,
        commandPublicId: world.uuid("39"),
        result: resultEnvelope,
        resultCode: "APPLIED",
        resultDigest: "f".repeat(64),
        singleUseResult: true,
        state: "applied",
      });
      const before = await accounting();
      expect(before.result).toEqual(resultEnvelope);
      expect(before.resultConsumedAt).toBeUndefined();
      expect(before.resultExpiresAt).toBe(settledAt + deviceCommandLoginResultLifetimeMs);
      expect(before.commandBytes).toBe(before.expectedCommandBytes);

      // A stale job for the right row but a different deadline has no authority.
      expect(await world.testRuntime.mutation(expireLoginResult, {
        commandPublicId: world.uuid("39"),
        resultExpiresAt: (before.resultExpiresAt as number) + 1,
      })).toEqual({ status: "retired" });
      expect((await accounting()).result).toEqual(resultEnvelope);

      await world.testRuntime.finishAllScheduledFunctions(() => { jest.runAllTimers(); }, 10);
      const erased = await accounting();
      expect(erased.result).toBeUndefined();
      expect(erased.resultConsumedAt).toBeNumber();
      expect(erased.resultExpiresAt).toBeUndefined();
      expect(erased.commandBytes).toBe(erased.expectedCommandBytes);
      const releasedBytes = before.rowBytes - erased.rowBytes;
      expect(releasedBytes).toBeGreaterThan(0);
      expect(before.commandBytes - erased.commandBytes).toBe(releasedBytes);
      expect(before.serviceUserBytes - erased.serviceUserBytes).toBe(releasedBytes);

      expect(await world.browser.mutation(consumeResult, { commandPublicId: world.uuid("39") }))
        .toEqual({ publicId: world.uuid("39"), status: "spent" });
      expect(await world.daemon.mutation(settle, {
        authority: daemonAuthority,
        commandPublicId: world.uuid("39"),
        result: resultEnvelope,
        resultCode: "APPLIED",
        resultDigest: "f".repeat(64),
        singleUseResult: true,
        state: "applied",
      })).toMatchObject({ replay: true, state: "applied" });
      expect(await world.testRuntime.mutation(expireLoginResult, {
        commandPublicId: world.uuid("39"),
        resultExpiresAt: before.resultExpiresAt as number,
      })).toEqual({ status: "retired" });
      const stable = await accounting();
      expect(stable.commandBytes).toBe(erased.commandBytes);
      expect(stable.serviceUserBytes).toBe(erased.serviceUserBytes);
    } finally {
      jest.useRealTimers();
    }
  });

  test("only the requester replays acknowledgement or cancels", async () => {
    const world = await deviceCommandWorld();
    await world.browser.mutation(enqueue, {
      deadline: Date.now() + 60_000,
      expectedTargetDevicePublicId: "device_daemon01",
      idempotencyKey: world.uuid("14"),
      kind: "usage_refresh",
      payload: envelope,
      publicId: world.uuid("29"),
      requestDigest: "5".repeat(64),
    });
    await expectPromiseToReject(world.daemon.mutation(cancelPending, {
      commandPublicId: world.uuid("29"),
    }));
    await expectPromiseToReject(world.daemon.mutation(acknowledge, {
      commandPublicId: world.uuid("29"),
      idempotencyKey: world.uuid("14"),
      requestDigest: "5".repeat(64),
    }));
    expect(await world.browser.mutation(acknowledge, {
      commandPublicId: world.uuid("29"),
      idempotencyKey: world.uuid("14"),
      requestDigest: "5".repeat(64),
    })).toMatchObject({ replay: true });
    expect(await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      const row = rows.find((entry) => entry.publicId === world.uuid("29"));
      return row === undefined
        ? null
        : {
            requesterAcknowledgedAt: row.requesterAcknowledgedAt,
            terminalCleanupAfter: row.terminalCleanupAfter,
          };
    })).toEqual({
      requesterAcknowledgedAt: expect.any(Number),
      terminalCleanupAfter: undefined,
    });
    expect(await world.browser.mutation(cancelPending, { commandPublicId: world.uuid("29") }))
      .toMatchObject({ replay: false, state: "cancelled" });
    const terminalReceipt = await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      const row = rows.find((entry) => entry.publicId === world.uuid("29"));
      return row === undefined
        ? null
        : {
            requesterAcknowledgedAt: row.requesterAcknowledgedAt,
            terminalCleanupAfter: row.terminalCleanupAfter,
          };
    });
    if (
      typeof terminalReceipt?.terminalCleanupAfter !== "number"
      || typeof terminalReceipt.requesterAcknowledgedAt !== "number"
    ) throw new Error(
      `invalid terminal receipt cleanup: ${typeof terminalReceipt?.terminalCleanupAfter}/${typeof terminalReceipt?.requesterAcknowledgedAt} ${JSON.stringify(terminalReceipt)}`,
    );
    expect(terminalReceipt.terminalCleanupAfter)
      .toBeGreaterThan(terminalReceipt.requesterAcknowledgedAt);
    expect(await world.daemon.mutation(confirmTerminalRecovery, {
      commandPublicId: world.uuid("29"),
      localPhase: "prepared_no_effect",
      staleAuthority: daemonAuthority,
    })).toEqual({
      publicId: world.uuid("29"),
      replay: true,
      state: "cancelled",
    });
    await expectPromiseToReject(
      world.browser.mutation(confirmTerminalRecovery, {
        commandPublicId: world.uuid("29"),
        localPhase: "prepared_no_effect",
        staleAuthority: daemonAuthority,
      }),
      "BROWSER_DEVICE_CANNOT_EXECUTE",
    );
  });

  test("device revocation drains device commands the revoked device owns", async () => {
    const world = await deviceCommandWorld();
    await world.enqueueFrom(world.browser, { publicId: world.uuid("2a") });
    await world.enqueueFrom(world.browser, {
      kind: "session_start",
      publicId: world.uuid("2b"),
    });
    await world.daemon.mutation(prepare, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("2b"),
      localPhase: "prepared_no_effect",
    });
    await world.daemon.mutation(markEffectStarted, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("2b"),
    });
    await world.daemon.mutation(revoke, {
      expectedRevision: 2,
      idempotencyKey: world.uuid("15"),
      requestDigest: "6".repeat(64),
      targetPublicId: "device_browser1",
    });
    const drain = makeFunctionReference<"mutation", Args, unknown>("deviceRevocation:drain");
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await world.testRuntime.mutation(drain, { limit: 200 });
    }
    const states = await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("deviceCommands").collect();
      return Object.fromEntries(rows.map((row) => [row.publicId, {
        requesterAcknowledgedAt: row.requesterAcknowledgedAt,
        state: row.state,
        terminalCleanupAfter: row.terminalCleanupAfter,
      }]));
    });
    expect(states[world.uuid("2a")]).toMatchObject({
      requesterAcknowledgedAt: expect.any(Number),
      state: "cancelled",
      terminalCleanupAfter: expect.any(Number),
    });
    // An effect that may have begun is quarantined, never cancelled.
    expect(states[world.uuid("2b")]).toMatchObject({
      requesterAcknowledgedAt: expect.any(Number),
      state: "ambiguous",
      terminalCleanupAfter: expect.any(Number),
    });
    expect(await world.daemon.mutation(confirmRevokedTerminal, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("2b"),
    })).toEqual({
      publicId: world.uuid("2b"),
      replay: true,
      state: "ambiguous",
    });
    expect(await world.daemon.mutation(confirmTerminalRecovery, {
      commandPublicId: world.uuid("2b"),
      localPhase: "effect_started",
      staleAuthority: daemonAuthority,
    })).toEqual({
      publicId: world.uuid("2b"),
      replay: true,
      state: "ambiguous",
    });
    await expectPromiseToReject(world.daemon.mutation(confirmTerminalRecovery, {
      commandPublicId: world.uuid("2b"),
      localPhase: "prepared_no_effect",
      staleAuthority: daemonAuthority,
    }));
    await expectPromiseToReject(world.daemon.mutation(confirmTerminalRecovery, {
      commandPublicId: world.uuid("2b"),
      localPhase: "effect_started",
      staleAuthority: laterAuthority,
    }));
    await expectPromiseToReject(world.daemon.mutation(confirmRevokedTerminal, {
      authority: laterAuthority,
      commandPublicId: world.uuid("2b"),
    }));
    await expectPromiseToReject(world.daemon.mutation(confirmRevokedTerminal, {
      authority: daemonAuthority,
      commandPublicId: world.uuid("2a"),
    }));
  });
});
