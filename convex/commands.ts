import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

import {
  cloudLimits,
  isDigest,
  isOpaqueIdentifier,
  isSafePositiveInteger,
  isUuidV7,
  parseEncryptedEnvelope,
  type AuthorityTuple,
  type CommandState,
} from "../src/cloud/contracts";
import {
  authorityMatches,
  commandAuthorityTransitionDisposition,
  commandTransitionDisposition,
  type CommandAuthorityTransitionDisposition,
} from "../src/cloud/commands";
import {
  rejectAuthority,
  requireDaemonDevice,
  requireDeviceAuthority,
} from "./authority";
import { validateIdempotencyInput } from "./idempotency";
import { requireLiveExecutionLease } from "./leases";
import {
  adjustCommandQuotaForPatch,
  reserveNonterminalCommandQuotaForInsert,
  reserveQuotaForInsert,
} from "./quota";
import { mutation, query, type MutationCtx } from "./server";
import {
  authorityTuple,
  commandKind,
  commandPayloadCiphertextCharacters,
  encryptedEnvelope,
} from "./validators";

const maximumCommandLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
export const commandTerminalRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const resultCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

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

function rejectCommandAuthorityTransition(
  disposition: Extract<CommandAuthorityTransitionDisposition, { kind: "rejected" }>,
): never {
  if (disposition.reason === "invalid_transition") {
    throw new Error("COMMAND_TRANSITION_CONFLICT");
  }
  rejectAuthority();
}

async function commandByPublicId(
  ctx: Parameters<typeof requireDeviceAuthority>[0],
  publicId: string,
) {
  const matches = await ctx.db
    .query("sessionCommands")
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
    kind: commandKind,
    payload: encryptedEnvelope,
    publicId: v.string(),
    requestDigest: v.string(),
    sessionPublicId: v.string(),
  },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    const now = Date.now();
    if (
      !isUuidV7(args.publicId)
      || !isOpaqueIdentifier(args.expectedTargetDevicePublicId)
      || !isOpaqueIdentifier(args.sessionPublicId)
      || !isDigest(args.requestDigest)
      || parseEncryptedEnvelope(args.payload, commandPayloadCiphertextCharacters) === null
      || !Number.isFinite(args.deadline)
      || args.deadline > now + maximumCommandLifetimeMs
    ) rejectAuthority();
    validateIdempotencyInput(args.idempotencyKey, args.requestDigest, now);
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (
      sessions.length !== 1
      || session === undefined
    ) rejectAuthority();
    const existing = await ctx.db
      .query("sessionCommands")
      .withIndex("by_idempotency", (builder) => builder
        .eq("userId", authority.userId)
        .eq("sessionId", session._id)
        .eq("requestingDeviceId", authority.deviceId)
        .eq("kind", args.kind)
        .eq("idempotencyKey", args.idempotencyKey))
      .take(2);
    if (existing.length > 1) rejectAuthority();
    const replay = existing[0];
    if (replay !== undefined) {
      if (replay.requestDigest !== args.requestDigest) throw new Error("IDEMPOTENCY_CONFLICT");
      const targetDevice = await ctx.db.get(replay.targetDeviceId);
      if (
        targetDevice?.userId !== authority.userId
        || targetDevice.publicId !== args.expectedTargetDevicePublicId
      ) rejectAuthority();
      return {
        publicId: replay.publicId,
        replay: true,
        sessionPublicId: session.publicId,
        state: replay.state,
        targetDevicePublicId: targetDevice.publicId,
      };
    }
    if (
      args.deadline <= now
      || session.state === "orphaned"
      || session.state === "terminal"
    ) rejectAuthority();
    const executionDevice = await ctx.db.get(session.executionDeviceId);
    if (
      executionDevice?.userId !== authority.userId
      || executionDevice.publicId !== args.expectedTargetDevicePublicId
      || executionDevice.status !== "active"
    ) rejectAuthority();
    const duplicatePublicId = await commandByPublicId(ctx, args.publicId);
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
      sessionId: session._id,
      state: "pending",
      targetDeviceId: session.executionDeviceId,
      updatedAt: now,
      userId: authority.userId,
    } as const;
    await reserveNonterminalCommandQuotaForInsert(ctx, authority.userId, commandDocument);
    await ctx.db.insert("sessionCommands", commandDocument);
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
      sessionPublicId: session.publicId,
      state: "pending" as const,
      targetDevicePublicId: executionDevice.publicId,
    };
  },
});

function publicCommand(command: Readonly<{
  boundAuthority?: AuthorityTuple;
  createdAt: number;
  deadline: number;
  kind:
    | "send"
    | "queue"
    | "steer"
    | "stop"
    | "set_model"
    | "set_fast"
    | "resolve_interaction"
    | "send_or_steer"
    | "set_approval_mode"
    | "set_show_thinking"
    | "set_default_preset"
    | "archive_session"
    | "rename_session"
    | "set_gateway_key";
  payload: Parameters<typeof parseEncryptedEnvelope>[0];
  publicId: string;
  result?: Parameters<typeof parseEncryptedEnvelope>[0];
  resultCode?: string;
  state: CommandState;
  updatedAt: number;
}>, sessionPublicId: string) {
  return {
    ...(command.boundAuthority === undefined
      ? {}
      : { boundAuthority: command.boundAuthority }),
    createdAt: command.createdAt,
    deadline: command.deadline,
    kind: command.kind,
    payload: command.payload,
    publicId: command.publicId,
    sessionPublicId,
    ...(command.result === undefined ? {} : { result: command.result }),
    ...(command.resultCode === undefined ? {} : { resultCode: command.resultCode }),
    state: command.state,
    updatedAt: command.updatedAt,
  };
}

function publicCommandMetadata(command: Parameters<typeof publicCommand>[0], sessionPublicId: string) {
  return {
    ...(command.boundAuthority === undefined
      ? {}
      : { boundAuthority: command.boundAuthority }),
    createdAt: command.createdAt,
    deadline: command.deadline,
    kind: command.kind,
    publicId: command.publicId,
    sessionPublicId,
    ...(command.result === undefined ? {} : { result: command.result }),
    ...(command.resultCode === undefined ? {} : { resultCode: command.resultCode }),
    state: command.state,
    updatedAt: command.updatedAt,
  };
}

export const listForSession = query({
  args: { limit: v.number(), sessionPublicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.sessionPublicId)
      || !isSafePositiveInteger(args.limit)
      || args.limit > cloudLimits.pageSize
    ) rejectAuthority();
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (sessions.length !== 1 || session === undefined) rejectAuthority();
    const commands = await ctx.db
      .query("sessionCommands")
      .withIndex("by_session_and_created_at", (builder) =>
        builder.eq("sessionId", session._id))
      .order("desc")
      .take(args.limit);
    return commands.map((command) => publicCommand(command, session.publicId));
  },
});

// Recovery paths must resolve the exact durable command identity. A bounded
// newest-first page cannot prove absence once a session has more commands than
// the page limit.
export const get = query({
  args: { commandPublicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isUuidV7(args.commandPublicId)) rejectAuthority();
    const command = await commandByPublicId(ctx, args.commandPublicId);
    if (command === null) return null;
    if (
      command.userId !== authority.userId
      || (command.requestingDeviceId !== authority.deviceId
        && command.targetDeviceId !== authority.deviceId)
    ) rejectAuthority();
    const [session, targetDevice, requestingDevice] = await Promise.all([
      ctx.db.get(command.sessionId),
      ctx.db.get(command.targetDeviceId),
      ctx.db.get(command.requestingDeviceId),
    ]);
    if (
      session?.userId !== authority.userId
      || targetDevice?.userId !== authority.userId
      || requestingDevice?.userId !== authority.userId
    ) rejectAuthority();
    return {
      ...publicCommand(command, session.publicId),
      requestDigest: command.requestDigest,
      requestingDevicePublicId: requestingDevice.publicId,
      targetDevicePublicId: targetDevice.publicId,
    };
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
    const command = await commandByPublicId(ctx, args.commandPublicId);
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
    const terminal = ["applied", "failed", "ambiguous", "cancelled", "expired"]
      .includes(command.state);
    const commandPatch = {
      requesterAcknowledgedAt: now,
      ...(terminal ? { terminalCleanupAfter: now + commandTerminalRetentionMs } : {}),
    };
    await adjustCommandQuotaForPatch(ctx, authority.userId, command, commandPatch);
    await ctx.db.patch(command._id, commandPatch);
    return { acknowledgedAt: now, publicId: command.publicId, replay: false };
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
      .query("sessionCommands")
      .withIndex("by_target_state_and_created_at", (builder) => builder
        .eq("targetDeviceId", authority.deviceId)
        .eq("state", "pending"))
      .take(args.limit);
    return await Promise.all(commands.map(async (command) => {
      const session = await ctx.db.get(command.sessionId);
      if (session?.userId !== authority.userId) rejectAuthority();
      return publicCommand(command, session.publicId);
    }));
  },
});

export const listPendingForTargetPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > cloudLimits.pageSize
    ) rejectAuthority();
    const result = await ctx.db
      .query("sessionCommands")
      .withIndex("by_target_state_and_created_at", (builder) => builder
        .eq("targetDeviceId", authority.deviceId)
        .eq("state", "pending"))
      .paginate(args.paginationOpts);
    const page = await Promise.all(result.page.map(async (command) => {
      const session = await ctx.db.get(command.sessionId);
      if (session?.userId !== authority.userId) rejectAuthority();
      return publicCommand(command, session.publicId);
    }));
    return { ...result, page };
  },
});

// Daemon recovery cannot treat a missing local journal pointer as proof that
// no command crossed the server prepare boundary. Expose every target-owned
// nonterminal state through the same authoritative index and bounded Convex
// cursor so a restarted daemon can rebuild conservative recovery evidence.
export const listNonterminalForTargetPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > cloudLimits.pageSize
    ) rejectAuthority();
    const result = await ctx.db
      .query("sessionCommands")
      .withIndex("by_target_nonterminal_and_created_at", (builder) => builder
        .eq("targetDeviceId", authority.deviceId)
        .eq("nonterminal", true))
      .paginate(args.paginationOpts);
    const page = await Promise.all(result.page.map(async (command) => {
      const session = await ctx.db.get(command.sessionId);
      if (session?.userId !== authority.userId) rejectAuthority();
      return publicCommandMetadata(command, session.publicId);
    }));
    return { ...result, page };
  },
});

async function requireCommandExecutionAuthority(
  ctx: MutationCtx,
  commandPublicId: string,
  authorityTupleValue: AuthorityTuple,
) {
  const authority = await requireDaemonDevice(ctx);
  if (!isUuidV7(commandPublicId)) rejectAuthority();
  const command = await commandByPublicId(ctx, commandPublicId);
  if (
    command?.userId !== authority.userId
    || command.targetDeviceId !== authority.deviceId
  ) rejectAuthority();
  const session = await ctx.db.get(command.sessionId);
  if (
    session?.userId !== authority.userId
    || session.executionDeviceId !== authority.deviceId
  ) rejectAuthority();
  const lease = await requireLiveExecutionLease(ctx, {
    authority: authorityTupleValue,
    deviceId: authority.deviceId,
    sessionId: session._id,
    userId: authority.userId,
  });
  return { authority, command, lease, session };
}

export const prepare = mutation({
  args: {
    authority: authorityTuple,
    commandPublicId: v.string(),
    localPhase: v.literal("prepared_no_effect"),
  },
  handler: async (ctx, args) => {
    const current = await requireCommandExecutionAuthority(
      ctx,
      args.commandPublicId,
      args.authority,
    );
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
    const disposition = commandAuthorityTransitionDisposition({
      boundAuthority: current.command.boundAuthority === undefined
        ? null
        : storedAuthority(current.command.boundAuthority),
      leaseUntil: current.lease.leaseUntil,
      liveAuthority: storedAuthority(current.lease),
      next: "prepared",
      now,
      requestedAuthority: args.authority,
      state: current.command.state,
    });
    if (disposition.kind === "rejected") rejectCommandAuthorityTransition(disposition);
    if (disposition.kind === "replay") {
      return { publicId: current.command.publicId, replay: true, state: "prepared" as const };
    }
    if (disposition.kind === "rebound") {
      const commandPatch = {
        boundAuthority: disposition.boundAuthority,
        updatedAt: now,
      } as const;
      await adjustCommandQuotaForPatch(
        ctx,
        current.authority.userId,
        current.command,
        commandPatch,
      );
      await ctx.db.patch(current.command._id, commandPatch);
      return { publicId: current.command.publicId, rebound: true, state: "prepared" as const };
    }
    const commandPatch = {
      boundAuthority: disposition.boundAuthority,
      state: disposition.state,
      updatedAt: now,
    } as const;
    await adjustCommandQuotaForPatch(
      ctx,
      current.authority.userId,
      current.command,
      commandPatch,
    );
    await ctx.db.patch(current.command._id, commandPatch);
    return { publicId: current.command.publicId, replay: false, state: "prepared" as const };
  },
});

export const markEffectStarted = mutation({
  args: { authority: authorityTuple, commandPublicId: v.string() },
  handler: async (ctx, args) => {
    const current = await requireCommandExecutionAuthority(
      ctx,
      args.commandPublicId,
      args.authority,
    );
    const now = Date.now();
    const disposition = commandAuthorityTransitionDisposition({
      boundAuthority: current.command.boundAuthority === undefined
        ? null
        : storedAuthority(current.command.boundAuthority),
      leaseUntil: current.lease.leaseUntil,
      liveAuthority: storedAuthority(current.lease),
      next: "effect_started",
      now,
      requestedAuthority: args.authority,
      state: current.command.state,
    });
    if (disposition.kind === "rejected") rejectCommandAuthorityTransition(disposition);
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
      return { publicId: current.command.publicId, replay: true, state: "effect_started" as const };
    }
    const commandPatch = {
      state: disposition.state,
      updatedAt: now,
    } as const;
    await adjustCommandQuotaForPatch(
      ctx,
      current.authority.userId,
      current.command,
      commandPatch,
    );
    await ctx.db.patch(current.command._id, commandPatch);
    return { publicId: current.command.publicId, replay: false, state: "effect_started" as const };
  },
});

export const settle = mutation({
  args: {
    authority: authorityTuple,
    commandPublicId: v.string(),
    result: v.optional(encryptedEnvelope),
    resultCode: v.string(),
    resultDigest: v.string(),
    state: v.union(v.literal("applied"), v.literal("failed"), v.literal("ambiguous")),
  },
  handler: async (ctx, args) => {
    const target = await requireDeviceAuthority(ctx);
    const command = await commandByPublicId(ctx, args.commandPublicId);
    if (
      command?.userId !== target.userId
      || command.targetDeviceId !== target.deviceId
    ) rejectAuthority();
    const session = await ctx.db.get(command.sessionId);
    if (
      session?.userId !== target.userId
      || session.executionDeviceId !== target.deviceId
    ) rejectAuthority();
    if (
      !isDigest(args.resultDigest)
      || !resultCodePattern.test(args.resultCode)
      || (args.result !== undefined && parseEncryptedEnvelope(args.result) === null)
    ) rejectAuthority();
    const bound = command.boundAuthority;
    if (bound === undefined || !authorityMatches(storedAuthority(bound), args.authority)) {
      rejectAuthority();
    }
    if (command.state === args.state) {
      if (
        command.resultDigest !== args.resultDigest
        || command.resultCode !== args.resultCode
        || JSON.stringify(command.result) !== JSON.stringify(args.result)
      ) throw new Error("COMMAND_RESULT_CONFLICT");
      // A terminal receipt remains reconcilable after the old execution lease
      // expires. No provider effect is replayed on this path.
      return { publicId: command.publicId, replay: true, state: args.state };
    }
    const lease = await requireLiveExecutionLease(ctx, {
      authority: args.authority,
      deviceId: target.deviceId,
      sessionId: session._id,
      userId: target.userId,
    });
    const now = Date.now();
    const disposition = commandAuthorityTransitionDisposition({
      boundAuthority: storedAuthority(bound),
      leaseUntil: lease.leaseUntil,
      liveAuthority: storedAuthority(lease),
      next: args.state,
      now,
      requestedAuthority: args.authority,
      state: command.state,
    });
    if (disposition.kind === "rejected") rejectCommandAuthorityTransition(disposition);
    if (disposition.kind !== "applied") throw new Error("COMMAND_TRANSITION_CONFLICT");
    const commandPatch = {
      ...(args.result === undefined ? {} : { result: args.result }),
      nonterminal: false,
      resultCode: args.resultCode,
      resultDigest: args.resultDigest,
      state: disposition.state,
      ...terminalCleanupFields(command, now),
      updatedAt: now,
    };
    await adjustCommandQuotaForPatch(ctx, target.userId, command, commandPatch);
    await ctx.db.patch(command._id, commandPatch);
    const securityDocument = {
      actorDeviceId: target.deviceId,
      createdAt: now,
      entityId: command.publicId,
      event: "command_terminal",
      userId: target.userId,
    } as const;
    await reserveQuotaForInsert(ctx, target.userId, "security", securityDocument);
    await ctx.db.insert("securityEvents", securityDocument);
    return { publicId: command.publicId, replay: false, state: args.state };
  },
});

// A target may crash after durably recording that an effect could have begun.
// Once its old fence expires, a newer live fence can publish the already
// durable terminal receipt, or conservatively close an unknown effect as
// ambiguous, without replaying the provider effect. This is deliberately the
// only transition that may cross execution fences.
export const recoverEffectStarted = mutation({
  args: {
    commandPublicId: v.string(),
    recoveryAuthority: authorityTuple,
    resultCode: v.string(),
    resultDigest: v.string(),
    staleAuthority: authorityTuple,
    state: v.union(v.literal("applied"), v.literal("failed"), v.literal("ambiguous")),
  },
  handler: async (ctx, args) => {
    const target = await requireDeviceAuthority(ctx);
    const command = await commandByPublicId(ctx, args.commandPublicId);
    if (
      command?.userId !== target.userId
      || command.targetDeviceId !== target.deviceId
    ) rejectAuthority();
    const session = await ctx.db.get(command.sessionId);
    if (
      session?.userId !== target.userId
      || session.executionDeviceId !== target.deviceId
      || !isDigest(args.resultDigest)
      || !resultCodePattern.test(args.resultCode)
    ) rejectAuthority();
    const bound = command.boundAuthority;
    if (
      bound === undefined
      || !authorityMatches(storedAuthority(bound), args.staleAuthority)
    ) rejectAuthority();
    if (command.state === args.state) {
      if (
        command.resultDigest !== args.resultDigest
        || command.resultCode !== args.resultCode
      ) throw new Error("COMMAND_RESULT_CONFLICT");
      return { publicId: command.publicId, replay: true, state: args.state };
    }
    if (command.state !== "prepared" && command.state !== "effect_started") {
      throw new Error("COMMAND_TRANSITION_CONFLICT");
    }
    if (args.recoveryAuthority.fence <= args.staleAuthority.fence) rejectAuthority();
    await requireLiveExecutionLease(ctx, {
      authority: args.recoveryAuthority,
      deviceId: target.deviceId,
      sessionId: session._id,
      userId: target.userId,
    });
    const now = Date.now();
    const commandPatch = {
      nonterminal: false,
      resultCode: args.resultCode,
      resultDigest: args.resultDigest,
      state: args.state,
      ...terminalCleanupFields(command, now),
      updatedAt: now,
    } as const;
    await adjustCommandQuotaForPatch(ctx, target.userId, command, commandPatch);
    await ctx.db.patch(command._id, commandPatch);
    const securityDocument = {
      actorDeviceId: target.deviceId,
      createdAt: now,
      entityId: command.publicId,
      event: "command_terminal",
      userId: target.userId,
    } as const;
    await reserveQuotaForInsert(ctx, target.userId, "security", securityDocument);
    await ctx.db.insert("securityEvents", securityDocument);
    return { publicId: command.publicId, replay: false, state: args.state };
  },
});

export const cancelPending = mutation({
  args: { commandPublicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    const command = await commandByPublicId(ctx, args.commandPublicId);
    if (
      command?.userId !== authority.userId
      || command.requestingDeviceId !== authority.deviceId
    ) rejectAuthority();
    if (command.state === "cancelled") {
      return { publicId: command.publicId, replay: true, state: "cancelled" as const };
    }
    const transition = commandTransitionDisposition(command.state, "cancelled");
    if (transition.kind !== "applied" || command.state !== "pending") {
      throw new Error("COMMAND_TRANSITION_CONFLICT");
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
