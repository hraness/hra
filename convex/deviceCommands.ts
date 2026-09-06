import { v } from "convex/values";
import { makeFunctionReference, paginationOptsValidator } from "convex/server";

import {
  cloudLimits,
  isDigest,
  isOpaqueIdentifier,
  isSafePositiveInteger,
  isUuidV7,
  parseEncryptedEnvelope,
  type AuthorityTuple,
  type CommandState,
  type DeviceCommandKind,
} from "../src/cloud/contracts";
import { commandTransitionDisposition } from "../src/cloud/commands";
import { deviceCommandLoginResultLifetimeMs } from "../src/cloud/payloads";
import {
  compareDeviceAuthority,
  deviceCommandAuthorityTransitionDisposition,
  deviceCommandRecoveryAdmitted,
  deviceCommandRecoveryReplayAdmitted,
  sameDeviceAuthority,
  type DeviceCommandAuthorityTransitionDisposition,
} from "../src/cloud/device-commands";
import {
  deviceClassOf,
  rejectAuthority,
  requireDaemonDevice,
  requireDeviceAuthority,
} from "./authority";
import { commandTerminalRetentionMs } from "./commands";
import { validateIdempotencyInput } from "./idempotency";
import {
  adjustCommandQuotaForPatch,
  reserveNonterminalCommandQuotaForInsert,
  reserveQuotaForInsert,
} from "./quota";
import { mutation, query, type MutationCtx } from "./server";
import {
  authorityTuple,
  deviceCommandKind,
  encryptedEnvelope,
} from "./validators";

/*
 * Device commands. A session command is addressed to the session's custodian
 * and fenced by that session's execution lease. A device command has no
 * session: the browser is asking a machine to do something before any session
 * exists (start one), or something that belongs to the machine rather than to a
 * session (refresh usage, relay an account login).
 *
 * The lifecycle is deliberately the same one: enqueue, acknowledge, prepare,
 * effect started, settle, expire, with the same closed state union and the same
 * "an effect that may have begun is quarantined as ambiguous" rule. Only the
 * authority differs: the fence is the target daemon's own boot authority rather
 * than a per-session lease.
 */

// A device command is a foreground request from a person looking at a browser.
// A day is far longer than anyone will wait, and it bounds how long a queued
// `session_start` can surprise an operator who left the tab open.
const maximumDeviceCommandLifetimeMs = 24 * 60 * 60 * 1_000;
const resultCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const terminalStates: readonly CommandState[] = [
  "applied",
  "failed",
  "ambiguous",
  "cancelled",
  "expired",
];

// Only `account_login_start` returns a handoff a second reader must never see.
const singleUseResultKinds: readonly DeviceCommandKind[] = ["account_login_start"];
const expireLoginResult = makeFunctionReference<
  "mutation",
  Readonly<{ commandPublicId: string; resultExpiresAt: number }>,
  unknown
>("maintenance:expireDeviceCommandLoginResult");

function terminalCleanupFields(
  command: Readonly<{ requesterAcknowledgedAt?: number }>,
  now: number,
): Readonly<{ terminalCleanupAfter?: number }> {
  return command.requesterAcknowledgedAt === undefined
    ? {}
    : { terminalCleanupAfter: now + commandTerminalRetentionMs };
}

function storedAuthority(value: Readonly<{
  bootGeneration: number;
  bootId: string;
  fence: number;
}>): AuthorityTuple {
  return {
    bootGeneration: value.bootGeneration,
    bootId: value.bootId,
    fence: value.fence,
  };
}

function rejectDeviceCommandTransition(
  disposition: Extract<DeviceCommandAuthorityTransitionDisposition, { kind: "rejected" }>,
): never {
  if (disposition.reason === "invalid_transition") {
    throw new Error("DEVICE_COMMAND_TRANSITION_CONFLICT");
  }
  rejectAuthority();
}

async function deviceCommandByPublicId(
  ctx: Parameters<typeof requireDeviceAuthority>[0],
  publicId: string,
) {
  const matches = await ctx.db
    .query("deviceCommands")
    .withIndex("by_public_id", (builder) => builder.eq("publicId", publicId))
    .take(2);
  if (matches.length > 1) rejectAuthority();
  return matches[0] ?? null;
}

export const enqueue = mutation({
  args: {
    deadline: v.number(),
    expectedTargetDevicePublicId: v.string(),
    idempotencyKey: v.string(),
    kind: deviceCommandKind,
    payload: encryptedEnvelope,
    publicId: v.string(),
    requestDigest: v.string(),
  },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    const now = Date.now();
    if (
      !isUuidV7(args.publicId)
      || !isOpaqueIdentifier(args.expectedTargetDevicePublicId)
      || !isDigest(args.requestDigest)
      || parseEncryptedEnvelope(args.payload) === null
      || !Number.isFinite(args.deadline)
      || args.deadline > now + maximumDeviceCommandLifetimeMs
    ) rejectAuthority();
    validateIdempotencyInput(args.idempotencyKey, args.requestDigest, now);
    const targets = await ctx.db
      .query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.expectedTargetDevicePublicId))
      .take(2);
    const target = targets[0];
    if (targets.length !== 1 || target === undefined) rejectAuthority();
    const existing = await ctx.db
      .query("deviceCommands")
      .withIndex("by_idempotency", (builder) => builder
        .eq("userId", authority.userId)
        .eq("targetDeviceId", target._id)
        .eq("requestingDeviceId", authority.deviceId)
        .eq("kind", args.kind)
        .eq("idempotencyKey", args.idempotencyKey))
      .take(2);
    if (existing.length > 1) rejectAuthority();
    const replay = existing[0];
    if (replay !== undefined) {
      if (replay.requestDigest !== args.requestDigest) throw new Error("IDEMPOTENCY_CONFLICT");
      return {
        publicId: replay.publicId,
        replay: true,
        state: replay.state,
        targetDevicePublicId: target.publicId,
      };
    }
    if (args.deadline <= now) rejectAuthority();
    // Only a daemon executes. A browser device is a key holder for the
    // projection; it can never be told to start a session.
    if (deviceClassOf(target) !== "daemon" || target.status !== "active") {
      throw new Error("DEVICE_COMMAND_TARGET_NOT_EXECUTOR");
    }
    const duplicatePublicId = await deviceCommandByPublicId(ctx, args.publicId);
    if (duplicatePublicId !== null) rejectAuthority();
    const commandDocument = {
      createdAt: now,
      deadline: args.deadline,
      idempotencyKey: args.idempotencyKey,
      kind: args.kind,
      nonterminal: true,
      payload: args.payload,
      publicId: args.publicId,
      requestDigest: args.requestDigest,
      requestingDeviceId: authority.deviceId,
      // The Convex sync client resolves only after this insert is committed and
      // visible to queries. Stamping acknowledgement here removes the
      // enqueue-success/tab-close gap that could otherwise retain a terminal
      // row forever when the browser never got to a second mutation.
      requesterAcknowledgedAt: now,
      state: "pending",
      targetDeviceId: target._id,
      updatedAt: now,
      userId: authority.userId,
    } as const;
    await reserveNonterminalCommandQuotaForInsert(ctx, authority.userId, commandDocument);
    await ctx.db.insert("deviceCommands", commandDocument);
    const securityDocument = {
      actorDeviceId: authority.deviceId,
      createdAt: now,
      entityId: args.publicId,
      event: "command_enqueued",
      userId: authority.userId,
    } as const;
    await reserveQuotaForInsert(ctx, authority.userId, "security", securityDocument);
    await ctx.db.insert("securityEvents", securityDocument);
    return {
      publicId: args.publicId,
      replay: false,
      state: "pending" as const,
      targetDevicePublicId: target.publicId,
    };
  },
});

function publicDeviceCommand(command: Readonly<{
  boundAuthority?: AuthorityTuple;
  createdAt: number;
  deadline: number;
  kind: DeviceCommandKind;
  payload: Parameters<typeof parseEncryptedEnvelope>[0];
  publicId: string;
  result?: Parameters<typeof parseEncryptedEnvelope>[0];
  resultCode?: string;
  resultConsumedAt?: number;
  resultSingleUse?: boolean;
  state: CommandState;
  updatedAt: number;
}>) {
  return {
    ...(command.boundAuthority === undefined
      ? {}
      : { boundAuthority: command.boundAuthority }),
    createdAt: command.createdAt,
    deadline: command.deadline,
    kind: command.kind,
    payload: command.payload,
    publicId: command.publicId,
    // A single-use result is never returned by an ordinary read. The requester
    // exchanges it once through `consumeResult`; every other reader sees only
    // that it exists and whether it is already spent.
    ...(command.resultSingleUse === true
      ? {
          resultConsumed: command.resultConsumedAt !== undefined,
          resultSingleUse: true,
        }
      : command.result === undefined ? {} : { result: command.result }),
    ...(command.resultCode === undefined ? {} : { resultCode: command.resultCode }),
    state: command.state,
    updatedAt: command.updatedAt,
  };
}

function publicDeviceCommandMetadata(command: Parameters<typeof publicDeviceCommand>[0]) {
  const projected: Record<string, unknown> = { ...publicDeviceCommand(command) };
  // Metadata reads never carry ciphertext: a listing is for scheduling and
  // status, and the payload is fetched by the exact command identity.
  delete projected.payload;
  return projected;
}

export const get = query({
  args: { commandPublicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isUuidV7(args.commandPublicId)) rejectAuthority();
    const command = await deviceCommandByPublicId(ctx, args.commandPublicId);
    if (command === null) return null;
    if (
      command.userId !== authority.userId
      || (command.requestingDeviceId !== authority.deviceId
        && command.targetDeviceId !== authority.deviceId)
    ) rejectAuthority();
    const [targetDevice, requestingDevice] = await Promise.all([
      ctx.db.get(command.targetDeviceId),
      ctx.db.get(command.requestingDeviceId),
    ]);
    if (
      targetDevice?.userId !== authority.userId
      || requestingDevice?.userId !== authority.userId
    ) rejectAuthority();
    return {
      ...publicDeviceCommand(command),
      requestDigest: command.requestDigest,
      requestingDevicePublicId: requestingDevice.publicId,
      targetDevicePublicId: targetDevice.publicId,
    };
  },
});

export const listForRequester = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isSafePositiveInteger(args.limit) || args.limit > cloudLimits.pageSize) {
      rejectAuthority();
    }
    const commands = await ctx.db
      .query("deviceCommands")
      .withIndex("by_requesting_device_and_nonterminal", (builder) =>
        builder.eq("requestingDeviceId", authority.deviceId))
      .order("desc")
      .take(args.limit);
    return commands.map((command) => publicDeviceCommandMetadata(command));
  },
});

export const listPendingForTarget = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isSafePositiveInteger(args.limit) || args.limit > cloudLimits.pageSize) {
      rejectAuthority();
    }
    const commands = await ctx.db
      .query("deviceCommands")
      .withIndex("by_target_state_and_created_at", (builder) => builder
        .eq("targetDeviceId", authority.deviceId)
        .eq("state", "pending"))
      .take(args.limit);
    return commands.map((command) => publicDeviceCommand(command));
  },
});

export const listNonterminalForTargetPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > cloudLimits.pageSize
    ) rejectAuthority();
    const result = await ctx.db
      .query("deviceCommands")
      .withIndex("by_target_nonterminal_and_created_at", (builder) => builder
        .eq("targetDeviceId", authority.deviceId)
        .eq("nonterminal", true))
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map((command) => publicDeviceCommandMetadata(command)) };
  },
});

export const acknowledgeReceipt = mutation({
  args: {
    commandPublicId: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
  },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isUuidV7(args.commandPublicId)
      || !isUuidV7(args.idempotencyKey)
      || !isDigest(args.requestDigest)
    ) rejectAuthority();
    const command = await deviceCommandByPublicId(ctx, args.commandPublicId);
    if (
      command?.userId !== authority.userId
      || command.requestingDeviceId !== authority.deviceId
      || command.idempotencyKey !== args.idempotencyKey
      || command.requestDigest !== args.requestDigest
    ) rejectAuthority();
    if (command.requesterAcknowledgedAt !== undefined) {
      return {
        acknowledgedAt: command.requesterAcknowledgedAt,
        publicId: command.publicId,
        replay: true,
      };
    }
    const now = Date.now();
    const commandPatch = {
      requesterAcknowledgedAt: now,
      ...(terminalStates.includes(command.state)
        ? { terminalCleanupAfter: now + commandTerminalRetentionMs }
        : {}),
    };
    await adjustCommandQuotaForPatch(ctx, authority.userId, command, commandPatch);
    await ctx.db.patch(command._id, commandPatch);
    return { acknowledgedAt: now, publicId: command.publicId, replay: false };
  },
});

/**
 * Exchanges a single-use result exactly once. Only the device that asked for it
 * may read it, the ciphertext is cleared in the same transaction, and a second
 * call reports `spent` rather than replaying the URL and one-time user code.
 */
export const consumeResult = mutation({
  args: { commandPublicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isUuidV7(args.commandPublicId)) rejectAuthority();
    const command = await deviceCommandByPublicId(ctx, args.commandPublicId);
    if (
      command?.userId !== authority.userId
      || command.requestingDeviceId !== authority.deviceId
    ) rejectAuthority();
    if (command.resultSingleUse !== true) throw new Error("DEVICE_COMMAND_RESULT_NOT_SINGLE_USE");
    if (command.resultConsumedAt !== undefined || command.result === undefined) {
      return { publicId: command.publicId, status: "spent" as const };
    }
    const now = Date.now();
    // Current rows carry a server-owned settlement deadline. The fallback keeps
    // already-settled rows from an older schema fail-closed on first exchange.
    const expiresAt = command.resultExpiresAt
      ?? command.updatedAt + deviceCommandLoginResultLifetimeMs;
    const commandPatch = {
      result: undefined,
      resultConsumedAt: now,
      resultExpiresAt: undefined,
      updatedAt: now,
    };
    await adjustCommandQuotaForPatch(ctx, authority.userId, command, commandPatch);
    await ctx.db.patch(command._id, commandPatch);
    if (now >= expiresAt) {
      return { publicId: command.publicId, status: "expired" as const };
    }
    return {
      expiresAt,
      publicId: command.publicId,
      result: command.result,
      status: "released" as const,
    };
  },
});

async function requireDeviceCommandExecutionAuthority(
  ctx: MutationCtx,
  commandPublicId: string,
) {
  const authority = await requireDaemonDevice(ctx);
  if (!isUuidV7(commandPublicId)) rejectAuthority();
  const command = await deviceCommandByPublicId(ctx, commandPublicId);
  if (
    command?.userId !== authority.userId
    || command.targetDeviceId !== authority.deviceId
  ) rejectAuthority();
  return { authority, command };
}

export const prepare = mutation({
  args: {
    authority: authorityTuple,
    commandPublicId: v.string(),
    localPhase: v.literal("prepared_no_effect"),
  },
  handler: async (ctx, args) => {
    const current = await requireDeviceCommandExecutionAuthority(ctx, args.commandPublicId);
    const now = Date.now();
    if (
      (current.command.state === "pending" || current.command.state === "prepared")
      && current.command.deadline <= now
    ) {
      const commandPatch = {
        nonterminal: false,
        state: "expired",
        ...terminalCleanupFields(current.command, now),
        updatedAt: now,
      } as const;
      await adjustCommandQuotaForPatch(
        ctx,
        current.authority.userId,
        current.command,
        commandPatch,
      );
      await ctx.db.patch(current.command._id, commandPatch);
      return { publicId: current.command.publicId, replay: false, state: "expired" as const };
    }
    const disposition = deviceCommandAuthorityTransitionDisposition({
      boundAuthority: current.command.boundAuthority === undefined
        ? null
        : storedAuthority(current.command.boundAuthority),
      next: "prepared",
      requestedAuthority: args.authority,
      state: current.command.state,
    });
    if (disposition.kind === "rejected") rejectDeviceCommandTransition(disposition);
    if (disposition.kind === "replay") {
      return { publicId: current.command.publicId, replay: true, state: "prepared" as const };
    }
    const commandPatch = {
      boundAuthority: disposition.boundAuthority,
      ...(disposition.kind === "rebound" ? {} : { state: disposition.state }),
      updatedAt: now,
    } as const;
    await adjustCommandQuotaForPatch(
      ctx,
      current.authority.userId,
      current.command,
      commandPatch,
    );
    await ctx.db.patch(current.command._id, commandPatch);
    return disposition.kind === "rebound"
      ? { publicId: current.command.publicId, rebound: true, state: "prepared" as const }
      : { publicId: current.command.publicId, replay: false, state: "prepared" as const };
  },
});

export const markEffectStarted = mutation({
  args: { authority: authorityTuple, commandPublicId: v.string() },
  handler: async (ctx, args) => {
    const current = await requireDeviceCommandExecutionAuthority(ctx, args.commandPublicId);
    const now = Date.now();
    const disposition = deviceCommandAuthorityTransitionDisposition({
      boundAuthority: current.command.boundAuthority === undefined
        ? null
        : storedAuthority(current.command.boundAuthority),
      next: "effect_started",
      requestedAuthority: args.authority,
      state: current.command.state,
    });
    if (disposition.kind === "rejected") rejectDeviceCommandTransition(disposition);
    if (current.command.state === "prepared" && current.command.deadline <= now) {
      const commandPatch = {
        nonterminal: false,
        state: "expired",
        ...terminalCleanupFields(current.command, now),
        updatedAt: now,
      } as const;
      await adjustCommandQuotaForPatch(
        ctx,
        current.authority.userId,
        current.command,
        commandPatch,
      );
      await ctx.db.patch(current.command._id, commandPatch);
      return { publicId: current.command.publicId, replay: false, state: "expired" as const };
    }
    if (disposition.kind === "replay") {
      return {
        publicId: current.command.publicId,
        replay: true,
        state: "effect_started" as const,
      };
    }
    const commandPatch = { state: disposition.state, updatedAt: now } as const;
    await adjustCommandQuotaForPatch(
      ctx,
      current.authority.userId,
      current.command,
      commandPatch,
    );
    await ctx.db.patch(current.command._id, commandPatch);
    return {
      publicId: current.command.publicId,
      replay: false,
      state: "effect_started" as const,
    };
  },
});

export const settle = mutation({
  args: {
    authority: authorityTuple,
    commandPublicId: v.string(),
    result: v.optional(encryptedEnvelope),
    resultCode: v.string(),
    resultDigest: v.string(),
    singleUseResult: v.optional(v.boolean()),
    state: v.union(v.literal("applied"), v.literal("failed"), v.literal("ambiguous")),
  },
  handler: async (ctx, args) => {
    const current = await requireDeviceCommandExecutionAuthority(ctx, args.commandPublicId);
    const command = current.command;
    // v4 daemons encrypted a login relay only while settling it, after their
    // local terminal journal write. An upgraded daemon may therefore replay
    // the old digest without ciphertext only when the hosted row already owns
    // the exact single-use result (or proves it was consumed). This exception
    // can never admit a new applied transition.
    const legacyAppliedLoginReplay = command.kind === "account_login_start"
      && command.state === "applied"
      && args.state === "applied"
      && args.result === undefined
      && args.singleUseResult === undefined
      && command.resultSingleUse === true
      && (command.result !== undefined || command.resultConsumedAt !== undefined);
    if (
      !isDigest(args.resultDigest)
      || !resultCodePattern.test(args.resultCode)
      || (args.result !== undefined
        && parseEncryptedEnvelope(args.result, cloudLimits.metadataCiphertextCharacters) === null)
      // Only an account-linking relay may be marked single use, and a relay
      // result must always be marked so it is never left readable twice.
      || (args.singleUseResult === true && !singleUseResultKinds.includes(command.kind))
      || args.singleUseResult === false
      || (args.singleUseResult === true && args.result === undefined)
      || (args.singleUseResult === true && args.state !== "applied")
      || (args.result !== undefined
        && singleUseResultKinds.includes(command.kind)
        && args.singleUseResult !== true)
      || (command.kind === "account_login_start"
        && args.state === "applied"
        && (args.result === undefined || args.singleUseResult !== true)
        && !legacyAppliedLoginReplay)
    ) rejectAuthority();
    const bound = command.boundAuthority;
    if (bound === undefined || !sameDeviceAuthority(storedAuthority(bound), args.authority)) {
      rejectAuthority();
    }
    if (command.state === args.state) {
      if (
        command.resultDigest !== args.resultDigest
        || command.resultCode !== args.resultCode
      ) throw new Error("DEVICE_COMMAND_RESULT_CONFLICT");
      // A released single-use result is deliberately not compared: it has been
      // erased, and re-presenting the same digest is the proof of sameness.
      if (
        command.resultConsumedAt === undefined
        && !legacyAppliedLoginReplay
        && JSON.stringify(command.result) !== JSON.stringify(args.result)
      ) throw new Error("DEVICE_COMMAND_RESULT_CONFLICT");
      return { publicId: command.publicId, replay: true, state: args.state };
    }
    const transition = commandTransitionDisposition(command.state, args.state);
    if (transition.kind !== "applied") throw new Error("DEVICE_COMMAND_TRANSITION_CONFLICT");
    const now = Date.now();
    const resultExpiresAt = args.singleUseResult === true
      ? now + deviceCommandLoginResultLifetimeMs
      : undefined;
    const commandPatch = {
      ...(args.result === undefined ? {} : { result: args.result }),
      ...(resultExpiresAt === undefined
        ? {}
        : {
            resultExpiresAt,
            resultSingleUse: true,
          }),
      nonterminal: false,
      resultCode: args.resultCode,
      resultDigest: args.resultDigest,
      state: args.state,
      ...terminalCleanupFields(command, now),
      updatedAt: now,
    };
    await adjustCommandQuotaForPatch(ctx, current.authority.userId, command, commandPatch);
    await ctx.db.patch(command._id, commandPatch);
    if (resultExpiresAt !== undefined) {
      await ctx.scheduler.runAt(resultExpiresAt, expireLoginResult, {
        commandPublicId: command.publicId,
        resultExpiresAt,
      });
    }
    const securityDocument = {
      actorDeviceId: current.authority.deviceId,
      createdAt: now,
      entityId: command.publicId,
      event: "command_terminal",
      userId: current.authority.userId,
    } as const;
    await reserveQuotaForInsert(ctx, current.authority.userId, "security", securityDocument);
    await ctx.db.insert("securityEvents", securityDocument);
    return { publicId: command.publicId, replay: false, state: args.state };
  },
});

/*
 * Requester revocation may win the race after the target daemon has durably
 * recorded its local terminal result but before that result is settled here.
 * Revocation deliberately owns the hosted terminal state in that race. This
 * read-only mutation lets the still-active target prove the exact result-less
 * revocation terminal under the authority it originally bound, so it can
 * retire only its local replay journal without overwriting hosted ambiguity.
 */
export const confirmRevokedTerminal = mutation({
  args: { authority: authorityTuple, commandPublicId: v.string() },
  handler: async (ctx, args) => {
    const current = await requireDeviceCommandExecutionAuthority(ctx, args.commandPublicId);
    const command = current.command;
    const requester = await ctx.db.get(command.requestingDeviceId);
    if (
      command.state !== "ambiguous"
      || command.nonterminal
      || command.boundAuthority === undefined
      || !sameDeviceAuthority(storedAuthority(command.boundAuthority), args.authority)
      || requester?.userId !== current.authority.userId
      || requester.status !== "revoked"
      // Every ordinary settle or recovery terminal carries result evidence.
      // Its complete absence is the durable signature of device revocation's
      // effect_started -> ambiguous transition.
      || command.result !== undefined
      || command.resultCode !== undefined
      || command.resultConsumedAt !== undefined
      || command.resultExpiresAt !== undefined
      || command.resultDigest !== undefined
      || command.resultSingleUse !== undefined
    ) throw new Error("DEVICE_COMMAND_REVOCATION_TERMINAL_CONFLICT");
    return { publicId: command.publicId, replay: true, state: "ambiguous" as const };
  },
});

/*
 * The local journal is written before each hosted phase transition. A
 * requester cancellation, hosted expiry, or requester revocation can therefore
 * terminalize the hosted row while the target still owns only `prepared` or
 * `effect_started` recovery evidence. The target may retire that evidence only
 * after this mutation proves the exact result-less terminal. It never changes
 * hosted state and never authorizes replay of the local effect.
 */
export const confirmTerminalRecovery = mutation({
  args: {
    commandPublicId: v.string(),
    localPhase: v.union(
      v.literal("prepared_no_effect"),
      v.literal("effect_started"),
    ),
    staleAuthority: authorityTuple,
  },
  handler: async (ctx, args) => {
    const current = await requireDeviceCommandExecutionAuthority(ctx, args.commandPublicId);
    const command = current.command;
    const requester = await ctx.db.get(command.requestingDeviceId);
    const bound = command.boundAuthority;
    const authorityMatches = bound === undefined
      ? args.localPhase === "prepared_no_effect"
      : sameDeviceAuthority(storedAuthority(bound), args.staleAuthority);
    const terminalMatches = command.state === "cancelled"
      || command.state === "expired"
      || (
        command.state === "ambiguous"
        && args.localPhase === "effect_started"
        && requester?.status === "revoked"
      );
    if (
      command.nonterminal
      || requester?.userId !== current.authority.userId
      || !authorityMatches
      || !terminalMatches
      || command.result !== undefined
      || command.resultCode !== undefined
      || command.resultConsumedAt !== undefined
      || command.resultExpiresAt !== undefined
      || command.resultDigest !== undefined
      || command.resultSingleUse !== undefined
    ) throw new Error("DEVICE_COMMAND_TERMINAL_RECOVERY_CONFLICT");
    return { publicId: command.publicId, replay: true, state: command.state };
  },
});

/*
 * A daemon may crash after durably recording that a `session_start` could have
 * begun. A later boot of the same device closes that record without replaying
 * the effect: it may publish `ambiguous` only, so a start that may or may not
 * have happened can never become a second start. This is the only device-command
 * transition permitted to cross execution fences.
 */
export const recoverEffectStarted = mutation({
  args: {
    commandPublicId: v.string(),
    localPhase: v.optional(v.union(
      v.literal("prepared_no_effect"),
      v.literal("effect_started"),
    )),
    recoveryAuthority: authorityTuple,
    resultCode: v.string(),
    resultDigest: v.string(),
    staleAuthority: authorityTuple,
    state: v.union(v.literal("failed"), v.literal("ambiguous")),
  },
  handler: async (ctx, args) => {
    const current = await requireDeviceCommandExecutionAuthority(ctx, args.commandPublicId);
    const command = current.command;
    if (!isDigest(args.resultDigest) || !resultCodePattern.test(args.resultCode)) {
      rejectAuthority();
    }
    const bound = command.boundAuthority;
    if (command.state === args.state) {
      if (
        bound === undefined
        || !deviceCommandRecoveryReplayAdmitted({
          boundAuthority: storedAuthority(bound),
          recoveryAuthority: args.recoveryAuthority,
          staleAuthority: args.staleAuthority,
        })
        || command.resultDigest !== args.resultDigest
        || command.resultCode !== args.resultCode
      ) throw new Error("DEVICE_COMMAND_RESULT_CONFLICT");
      return { publicId: command.publicId, replay: true, state: args.state };
    }
    const pendingWithoutAuthority = command.state === "pending" && bound === undefined;
    if (pendingWithoutAuthority) {
      const expectedState = args.localPhase === "prepared_no_effect" ? "failed" : "ambiguous";
      if (
        (args.localPhase !== "prepared_no_effect" && args.localPhase !== "effect_started")
        || args.state !== expectedState
        || compareDeviceAuthority(args.recoveryAuthority, args.staleAuthority) !== "after"
      ) rejectAuthority();
    } else if (
      bound === undefined
      || !sameDeviceAuthority(storedAuthority(bound), args.staleAuthority)
    ) rejectAuthority();
    if (command.state !== "prepared" && command.state !== "effect_started") {
      if (!pendingWithoutAuthority) throw new Error("DEVICE_COMMAND_TRANSITION_CONFLICT");
    }
    if (!pendingWithoutAuthority && !deviceCommandRecoveryAdmitted({
      recoveryAuthority: args.recoveryAuthority,
      staleAuthority: args.staleAuthority,
      state: command.state,
      terminalState: args.state,
    })) rejectAuthority();
    const now = Date.now();
    const commandPatch = {
      boundAuthority: args.recoveryAuthority,
      nonterminal: false,
      resultCode: args.resultCode,
      resultDigest: args.resultDigest,
      state: args.state,
      ...terminalCleanupFields(command, now),
      updatedAt: now,
    } as const;
    await adjustCommandQuotaForPatch(ctx, current.authority.userId, command, commandPatch);
    await ctx.db.patch(command._id, commandPatch);
    const securityDocument = {
      actorDeviceId: current.authority.deviceId,
      createdAt: now,
      entityId: command.publicId,
      event: "command_terminal",
      userId: current.authority.userId,
    } as const;
    await reserveQuotaForInsert(ctx, current.authority.userId, "security", securityDocument);
    await ctx.db.insert("securityEvents", securityDocument);
    return { publicId: command.publicId, replay: false, state: args.state };
  },
});

export const cancelPending = mutation({
  args: { commandPublicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isUuidV7(args.commandPublicId)) rejectAuthority();
    const command = await deviceCommandByPublicId(ctx, args.commandPublicId);
    if (
      command?.userId !== authority.userId
      || command.requestingDeviceId !== authority.deviceId
    ) rejectAuthority();
    if (command.state === "cancelled") {
      return { publicId: command.publicId, replay: true, state: "cancelled" as const };
    }
    const transition = commandTransitionDisposition(command.state, "cancelled");
    if (transition.kind !== "applied" || command.state !== "pending") {
      throw new Error("DEVICE_COMMAND_TRANSITION_CONFLICT");
    }
    const now = Date.now();
    const commandPatch = {
      nonterminal: false,
      state: "cancelled",
      ...terminalCleanupFields(command, now),
      updatedAt: now,
    } as const;
    await adjustCommandQuotaForPatch(ctx, authority.userId, command, commandPatch);
    await ctx.db.patch(command._id, commandPatch);
    return { publicId: command.publicId, replay: false, state: "cancelled" as const };
  },
});
