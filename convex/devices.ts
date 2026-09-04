import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { makeFunctionReference, paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { GenericId as Id } from "convex/values";

import {
  cloudLimits,
  isBase64Url,
  isDigest,
  isOpaqueIdentifier,
  isSafePositiveInteger,
  parseEncryptedEnvelope,
  parseWrappedKeyEnvelope,
} from "../src/cloud/contracts";
import {
  parseDevicePublicKeyJson,
  verifyDeviceBind,
} from "../src/cloud/crypto";
import {
  deviceClassOf,
  rejectAuthority,
  requireAuthAuthority,
  requireDaemonDevice,
  requireDeviceAuthority,
  type DeviceClass,
} from "./authority";
import { requireAuthAdmissionsOpen } from "./admissionControl";
import {
  loadIdempotencyReceipt,
  storeIdempotencyReceipt,
} from "./idempotency";
import {
  adjustQuotaForPatch,
  reserveDeviceQuotaForInsert,
  reserveQuotaForInsert,
} from "./quota";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./server";
import { presenceForDevice } from "./presence";
import { deviceClass, encryptedEnvelope, wrappedKeyEnvelope } from "./validators";

const bindChallengeLifetimeMs = 5 * 60 * 1_000;

type DeviceSummary = Readonly<{
  deviceClass: DeviceClass;
  publicId: string;
  revision: number;
  status: "pending" | "active" | "revoked";
}>;

async function bindRegistrationToAuthSession(
  ctx: MutationCtx,
  auth: Awaited<ReturnType<typeof requireAuthAuthority>>,
  device: Readonly<{
    _id: Id<"devices">;
    authEpoch: number;
    publicId: string;
    status: "pending" | "active" | "revoked";
    userId: Id<"users">;
  }>,
): Promise<void> {
  if (
    device.userId !== auth.userId
    || device.authEpoch !== auth.subject.authEpoch
    || device.status === "revoked"
  ) rejectAuthority();
  const bindings = await ctx.db
    .query("deviceSessions")
    .withIndex("by_auth_session", (builder) =>
      builder.eq("authSessionId", auth.authSessionId))
    .take(2);
  if (bindings.length > 1) rejectAuthority();
  const binding = bindings[0];
  if (binding !== undefined) {
    if (
      binding.userId !== auth.userId
      || binding.deviceId !== device._id
      || binding.authEpoch !== auth.subject.authEpoch
      || binding.revokedAt !== undefined
    ) rejectAuthority();
    return;
  }
  const sessionDocument = {
    authEpoch: auth.subject.authEpoch,
    authSessionId: auth.authSessionId,
    boundAt: Date.now(),
    deviceId: device._id,
    userId: auth.userId,
  } as const;
  await reserveQuotaForInsert(ctx, auth.userId, "custody", sessionDocument);
  await ctx.db.insert("deviceSessions", sessionDocument);
}

// A receipt stored before browser enrollment carries no class, so an absent
// field decodes as `daemon` exactly as an absent device-row field does.
function parseDeviceSummary(value: unknown): DeviceSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !isOpaqueIdentifier(record.publicId)
    || !isSafePositiveInteger(record.revision)
    || (record.status !== "pending" && record.status !== "active" && record.status !== "revoked")
    || (record.deviceClass !== undefined
      && record.deviceClass !== "daemon"
      && record.deviceClass !== "browser")
  ) return null;
  return {
    deviceClass: record.deviceClass ?? "daemon",
    publicId: record.publicId,
    revision: record.revision,
    status: record.status,
  };
}

function summarizeDevice(device: Readonly<{
  deviceClass?: DeviceClass;
  publicId: string;
  revision: number;
  status: "pending" | "active" | "revoked";
}>): DeviceSummary {
  return {
    deviceClass: deviceClassOf(device),
    publicId: device.publicId,
    revision: device.revision,
    status: device.status,
  };
}

function publicDevice(device: Readonly<{
  activatedAt?: number;
  deviceClass?: DeviceClass;
  encryptedLabel: Parameters<typeof parseEncryptedEnvelope>[0];
  keyVersion: number;
  publicId: string;
  revision: number;
  signingPublicKey: string;
  status: "pending" | "active" | "revoked";
  updatedAt: number;
  userId: string;
  wrappingPublicKey: string;
}>, presence: Awaited<ReturnType<typeof presenceForDevice>>, now: number) {
  return {
    ...(device.activatedAt === undefined ? {} : { activatedAt: device.activatedAt }),
    deviceClass: deviceClassOf(device),
    encryptedLabel: device.encryptedLabel,
    keyVersion: device.keyVersion,
    lastSeenAt: presence?.observedAt ?? null,
    online: device.status !== "revoked" && presence !== null && presence.presenceUntil > now,
    publicId: device.publicId,
    revision: device.revision,
    signingPublicKey: device.signingPublicKey,
    status: device.status,
    userPublicId: device.userId,
    wrappingPublicKey: device.wrappingPublicKey,
  };
}

export const register = mutation({
  args: {
    bootstrapKeyEnvelope: v.optional(wrappedKeyEnvelope),
    deviceClass: v.optional(deviceClass),
    encryptedLabel: encryptedEnvelope,
    idempotencyKey: v.string(),
    keyVersion: v.number(),
    publicId: v.string(),
    requestDigest: v.string(),
    signingPublicKey: v.string(),
    wrappingPublicKey: v.string(),
  },
  handler: async (ctx, args): Promise<DeviceSummary> => {
    const auth = await requireAuthAuthority(ctx);
    const requestedClass: DeviceClass = args.deviceClass ?? "daemon";
    if (
      !isOpaqueIdentifier(args.publicId)
      || !isSafePositiveInteger(args.keyVersion)
      || parseDevicePublicKeyJson(args.signingPublicKey) === null
      || parseDevicePublicKeyJson(args.wrappingPublicKey) === null
      || parseEncryptedEnvelope(
        args.encryptedLabel,
        cloudLimits.deviceLabelCiphertextCharacters,
      ) === null
      || (args.bootstrapKeyEnvelope !== undefined
        && parseWrappedKeyEnvelope(args.bootstrapKeyEnvelope) === null)
    ) rejectAuthority();
    const scope = {
      operation: "device.register",
      // Registration can lose its response immediately before an auth-token
      // rotation. The durable client outbox must be able to replay the exact
      // request under a new session for the same authenticated user.
      scopeId: args.publicId,
      userId: auth.userId,
    } as const;
    const replay = await loadIdempotencyReceipt(
      ctx,
      scope,
      args.idempotencyKey,
      args.requestDigest,
    );
    if (replay !== null) {
      const parsed = parseDeviceSummary(replay);
      if (parsed === null) rejectAuthority();
      const matches = await ctx.db
        .query("devices")
        .withIndex("by_user_and_public_id", (builder) => builder
          .eq("userId", auth.userId)
          .eq("publicId", args.publicId))
        .take(2);
      const device = matches[0];
      if (
        matches.length !== 1
        || device === undefined
        || device.publicId !== parsed.publicId
        || deviceClassOf(device) !== parsed.deviceClass
        || deviceClassOf(device) !== requestedClass
        || device.keyVersion !== args.keyVersion
        || device.registrationIdempotencyKey !== args.idempotencyKey
        || device.registrationRequestDigest !== args.requestDigest
        || JSON.stringify(device.registrationBootstrapKeyEnvelope)
          !== JSON.stringify(args.bootstrapKeyEnvelope)
        || device.signingPublicKey !== args.signingPublicKey
        || device.wrappingPublicKey !== args.wrappingPublicKey
        || JSON.stringify(device.encryptedLabel) !== JSON.stringify(args.encryptedLabel)
      ) rejectAuthority();
      await bindRegistrationToAuthSession(ctx, auth, device);
      return summarizeDevice(device);
    }
    await requireAuthAdmissionsOpen(ctx);
    const existingBindings = await ctx.db
      .query("deviceSessions")
      .withIndex("by_auth_session", (builder) =>
        builder.eq("authSessionId", auth.authSessionId))
      .take(1);
    if (existingBindings.length !== 0) rejectAuthority();
    const duplicateIds = await ctx.db
      .query("devices")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.publicId))
      .take(1);
    if (duplicateIds.length !== 0) rejectAuthority();
    const active = await ctx.db
      .query("devices")
      .withIndex("by_user_and_status", (builder) =>
        builder.eq("userId", auth.userId).eq("status", "active"))
      .take(1);
    const status = active.length === 0 ? "active" as const : "pending" as const;
    // A browser device is never the first device and never generates the
    // account key: enrollment requires an existing active daemon device.
    if (requestedClass === "browser" && active.length === 0) {
      throw new Error("BROWSER_DEVICE_REQUIRES_ACTIVE_DEVICE");
    }
    if ((status === "active") !== (args.bootstrapKeyEnvelope !== undefined)) {
      rejectAuthority();
    }
    const now = Date.now();
    const deviceDocument = {
      ...(status === "active" ? { activatedAt: now } : {}),
      authEpoch: auth.subject.authEpoch,
      createdAt: now,
      credentialGeneration: 1,
      deviceClass: requestedClass,
      encryptedLabel: args.encryptedLabel,
      keyVersion: args.keyVersion,
      publicId: args.publicId,
      ...(args.bootstrapKeyEnvelope === undefined
        ? {}
        : { registrationBootstrapKeyEnvelope: args.bootstrapKeyEnvelope }),
      registrationIdempotencyKey: args.idempotencyKey,
      registrationRequestDigest: args.requestDigest,
      revision: 1,
      signingPublicKey: args.signingPublicKey,
      status,
      updatedAt: now,
      userId: auth.userId,
      wrappingPublicKey: args.wrappingPublicKey,
    } as const;
    await reserveDeviceQuotaForInsert(ctx, auth.userId, deviceDocument);
    const deviceId = await ctx.db.insert("devices", deviceDocument);
    const device = await ctx.db.get(deviceId);
    if (device === null) rejectAuthority();
    await bindRegistrationToAuthSession(ctx, auth, device);
    if (args.bootstrapKeyEnvelope !== undefined) {
      const envelopeDocument = {
        createdAt: now,
        deviceId,
        envelope: args.bootstrapKeyEnvelope,
        userId: auth.userId,
      } as const;
      await reserveQuotaForInsert(ctx, auth.userId, "custody", envelopeDocument);
      await ctx.db.insert("deviceKeyEnvelopes", envelopeDocument);
    }
    const securityDocument = {
      actorDeviceId: deviceId,
      createdAt: now,
      entityId: args.publicId,
      event: "device_registered",
      userId: auth.userId,
    } as const;
    await reserveQuotaForInsert(ctx, auth.userId, "security", securityDocument);
    await ctx.db.insert("securityEvents", securityDocument);
    const response = {
      deviceClass: requestedClass,
      publicId: args.publicId,
      revision: 1,
      status,
    };
    await storeIdempotencyReceipt(ctx, scope, {
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      response,
    });
    return response;
  },
});

// An outbox can outlive the seven-day idempotency receipt window after a lost
// response. This path never creates a device: it only proves that the exact
// original registration already exists, then restores the auth-session bind.
export const recoverRegistration = mutation({
  args: {
    bootstrapKeyEnvelope: v.optional(wrappedKeyEnvelope),
    deviceClass: v.optional(deviceClass),
    encryptedLabel: encryptedEnvelope,
    idempotencyKey: v.string(),
    keyVersion: v.number(),
    publicId: v.string(),
    requestDigest: v.string(),
    signingPublicKey: v.string(),
    wrappingPublicKey: v.string(),
  },
  handler: async (ctx, args): Promise<DeviceSummary | null> => {
    const auth = await requireAuthAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.publicId)
      || !isSafePositiveInteger(args.keyVersion)
      || !isDigest(args.requestDigest)
      || parseDevicePublicKeyJson(args.signingPublicKey) === null
      || parseDevicePublicKeyJson(args.wrappingPublicKey) === null
      || parseEncryptedEnvelope(
        args.encryptedLabel,
        cloudLimits.deviceLabelCiphertextCharacters,
      ) === null
      || (args.bootstrapKeyEnvelope !== undefined
        && parseWrappedKeyEnvelope(args.bootstrapKeyEnvelope) === null)
    ) rejectAuthority();
    const matches = await ctx.db
      .query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", auth.userId)
        .eq("publicId", args.publicId))
      .take(2);
    const device = matches[0];
    if (matches.length === 0) return null;
    if (
      matches.length !== 1
      || device === undefined
      || device.registrationIdempotencyKey !== args.idempotencyKey
      || device.registrationRequestDigest !== args.requestDigest
      || deviceClassOf(device) !== (args.deviceClass ?? "daemon")
      || device.keyVersion !== args.keyVersion
      || JSON.stringify(device.registrationBootstrapKeyEnvelope)
        !== JSON.stringify(args.bootstrapKeyEnvelope)
      || JSON.stringify(device.encryptedLabel) !== JSON.stringify(args.encryptedLabel)
      || device.signingPublicKey !== args.signingPublicKey
      || device.wrappingPublicKey !== args.wrappingPublicKey
    ) rejectAuthority();
    await bindRegistrationToAuthSession(ctx, auth, device);
    return summarizeDevice(device);
  },
});

export const currentRegistration = query({
  args: {},
  handler: async (ctx): Promise<DeviceSummary | null> => {
    const auth = await requireAuthAuthority(ctx);
    const bindings = await ctx.db
      .query("deviceSessions")
      .withIndex("by_auth_session", (builder) =>
        builder.eq("authSessionId", auth.authSessionId))
      .take(2);
    const binding = bindings[0];
    if (bindings.length === 0) return null;
    if (bindings.length !== 1 || binding?.userId !== auth.userId) {
      rejectAuthority();
    }
    const device = await ctx.db.get(binding.deviceId);
    if (device?.userId !== auth.userId) rejectAuthority();
    return summarizeDevice(device);
  },
});

export const get = query({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isOpaqueIdentifier(args.publicId)) rejectAuthority();
    const matches = await ctx.db
      .query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.publicId))
      .take(2);
    if (matches.length > 1) rejectAuthority();
    const device = matches[0];
    if (device === undefined) return null;
    const now = Date.now();
    return publicDevice(device, await presenceForDevice(ctx, device._id), now);
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const authority = await requireDeviceAuthority(ctx);
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_user_and_public_id", (builder) =>
        builder.eq("userId", authority.userId))
      .take(100);
    const [presence, now] = await Promise.all([
      Promise.all(devices.map(async (device) => await presenceForDevice(ctx, device._id))),
      Promise.resolve(Date.now()),
    ]);
    return devices.map((device, index) => publicDevice(device, presence[index] ?? null, now));
  },
});

export const listPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > cloudLimits.pageSize
    ) rejectAuthority();
    const result = await ctx.db
      .query("devices")
      .withIndex("by_user_and_public_id", (builder) =>
        builder.eq("userId", authority.userId))
      .paginate(args.paginationOpts);
    const now = Date.now();
    const presence = await Promise.all(result.page.map(
      async (device) => await presenceForDevice(ctx, device._id),
    ));
    return {
      ...result,
      page: result.page.map((device, index) =>
        publicDevice(device, presence[index] ?? null, now)),
      userPublicId: String(authority.userId),
    };
  },
});

export const approve = mutation({
  args: {
    expectedRevision: v.number(),
    idempotencyKey: v.string(),
    keyEnvelope: wrappedKeyEnvelope,
    requestDigest: v.string(),
    targetPublicId: v.string(),
  },
  handler: async (ctx, args): Promise<DeviceSummary> => {
    const authority = await requireDaemonDevice(ctx, "administer");
    if (
      !isOpaqueIdentifier(args.targetPublicId)
      || !isSafePositiveInteger(args.expectedRevision)
      || parseWrappedKeyEnvelope(args.keyEnvelope) === null
    ) rejectAuthority();
    const scope = {
      deviceId: authority.deviceId,
      operation: "device.approve",
      scopeId: args.targetPublicId,
      userId: authority.userId,
    } as const;
    const replay = await loadIdempotencyReceipt(
      ctx,
      scope,
      args.idempotencyKey,
      args.requestDigest,
    );
    if (replay !== null) {
      const parsed = parseDeviceSummary(replay);
      if (parsed === null) rejectAuthority();
      return parsed;
    }
    const targets = await ctx.db
      .query("devices")
      .withIndex("by_user_and_public_id", (builder) =>
        builder.eq("userId", authority.userId).eq("publicId", args.targetPublicId))
      .take(2);
    const target = targets[0];
    if (
      targets.length !== 1
      || target?.status !== "pending"
      || target.revision !== args.expectedRevision
      || target.authEpoch !== authority.subject.authEpoch
    ) rejectAuthority();
    const existingEnvelopes = await ctx.db
      .query("deviceKeyEnvelopes")
      .withIndex("by_device_and_version", (builder) => builder
        .eq("deviceId", target._id)
        .eq("envelope.keyVersion", args.keyEnvelope.keyVersion))
      .take(1);
    if (existingEnvelopes.length !== 0) rejectAuthority();
    const now = Date.now();
    const devicePatch = {
      activatedAt: now,
      revision: target.revision + 1,
      status: "active",
      updatedAt: now,
    } as const;
    await adjustQuotaForPatch(ctx, authority.userId, "device", target, devicePatch);
    await ctx.db.patch(target._id, devicePatch);
    const envelopeDocument = {
      createdAt: now,
      deviceId: target._id,
      envelope: args.keyEnvelope,
      userId: authority.userId,
    } as const;
    await reserveQuotaForInsert(ctx, authority.userId, "custody", envelopeDocument);
    await ctx.db.insert("deviceKeyEnvelopes", envelopeDocument);
    const securityDocument = {
      actorDeviceId: authority.deviceId,
      createdAt: now,
      entityId: target.publicId,
      event: "device_activated",
      userId: authority.userId,
    } as const;
    await reserveQuotaForInsert(ctx, authority.userId, "security", securityDocument);
    await ctx.db.insert("securityEvents", securityDocument);
    const response = {
      deviceClass: deviceClassOf(target),
      publicId: target.publicId,
      revision: target.revision + 1,
      status: "active" as const,
    };
    await storeIdempotencyReceipt(ctx, scope, {
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      response,
    });
    return response;
  },
});

export const beginBind = mutation({
  args: {
    challengeId: v.string(),
    devicePublicId: v.string(),
    nonce: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuthAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.challengeId)
      || !isOpaqueIdentifier(args.devicePublicId)
      || !isBase64Url(args.nonce, 32, 64)
    ) rejectAuthority();
    const targets = await ctx.db
      .query("devices")
      .withIndex("by_user_and_public_id", (builder) =>
        builder.eq("userId", auth.userId).eq("publicId", args.devicePublicId))
      .take(2);
    const target = targets[0];
    if (
      targets.length !== 1
      || target?.status !== "active"
      || target.authEpoch !== auth.subject.authEpoch
    ) rejectAuthority();
    const duplicate = await ctx.db
      .query("deviceBindChallenges")
      .withIndex("by_challenge", (builder) => builder.eq("challengeId", args.challengeId))
      .take(1);
    if (duplicate.length !== 0) rejectAuthority();
    const now = Date.now();
    const challengeDocument = {
      authSessionId: auth.authSessionId,
      challengeId: args.challengeId,
      createdAt: now,
      deviceId: target._id,
      expiresAt: now + bindChallengeLifetimeMs,
      nonce: args.nonce,
      userId: auth.userId,
    } as const;
    await reserveQuotaForInsert(ctx, auth.userId, "custody", challengeDocument);
    await ctx.db.insert("deviceBindChallenges", challengeDocument);
    return { challengeId: args.challengeId, devicePublicId: target.publicId, nonce: args.nonce };
  },
});

export const getBindMaterial = internalQuery({
  args: {
    authSessionId: v.id("authSessions"),
    challengeId: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const matches = await ctx.db
      .query("deviceBindChallenges")
      .withIndex("by_challenge", (builder) => builder.eq("challengeId", args.challengeId))
      .take(2);
    const challenge = matches[0];
    if (
      matches.length !== 1
      || challenge?.userId !== args.userId
      || challenge.authSessionId !== args.authSessionId
      || challenge.consumedAt !== undefined
      || challenge.expiresAt <= Date.now()
    ) rejectAuthority();
    const device = await ctx.db.get(challenge.deviceId);
    if (device?.userId !== args.userId || device.status !== "active") {
      rejectAuthority();
    }
    return {
      challengeId: challenge.challengeId,
      devicePublicId: device.publicId,
      nonce: challenge.nonce,
      signingPublicKey: device.signingPublicKey,
    };
  },
});

export const completeBind = internalMutation({
  args: {
    authSessionId: v.id("authSessions"),
    challengeId: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const [authSession, user] = await Promise.all([
      ctx.db.get(args.authSessionId),
      ctx.db.get(args.userId),
    ]);
    if (
      authSession?.userId !== args.userId
      || user?._id !== args.userId
      || authSession.expirationTime <= Date.now()
    ) rejectAuthority();
    const subjects = await ctx.db
      .query("authSubjects")
      .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
      .take(2);
    const subject = subjects[0];
    const challenges = await ctx.db
      .query("deviceBindChallenges")
      .withIndex("by_challenge", (builder) => builder.eq("challengeId", args.challengeId))
      .take(2);
    const challenge = challenges[0];
    if (
      subjects.length !== 1
      || subject?.status !== "active"
      || challenges.length !== 1
      || challenge?.userId !== args.userId
      || challenge.authSessionId !== args.authSessionId
      || challenge.consumedAt !== undefined
      || challenge.expiresAt <= Date.now()
    ) rejectAuthority();
    const device = await ctx.db.get(challenge.deviceId);
    if (
      device?.userId !== args.userId
      || device.status !== "active"
      || device.authEpoch !== subject.authEpoch
    ) rejectAuthority();
    const existing = await ctx.db
      .query("deviceSessions")
      .withIndex("by_auth_session", (builder) =>
        builder.eq("authSessionId", args.authSessionId))
      .take(1);
    if (existing.length !== 0) rejectAuthority();
    const now = Date.now();
    const challengePatch = { consumedAt: now } as const;
    await adjustQuotaForPatch(ctx, args.userId, "custody", challenge, challengePatch);
    await ctx.db.patch(challenge._id, challengePatch);
    const sessionDocument = {
      authEpoch: subject.authEpoch,
      authSessionId: args.authSessionId,
      boundAt: now,
      deviceId: device._id,
      userId: args.userId,
    } as const;
    await reserveQuotaForInsert(ctx, args.userId, "custody", sessionDocument);
    await ctx.db.insert("deviceSessions", sessionDocument);
    const securityDocument = {
      actorDeviceId: device._id,
      createdAt: now,
      entityId: device.publicId,
      event: "device_bound",
      userId: args.userId,
    } as const;
    await reserveQuotaForInsert(ctx, args.userId, "security", securityDocument);
    await ctx.db.insert("securityEvents", securityDocument);
    return summarizeDevice(device);
  },
});

type BindMaterial = Readonly<{
  challengeId: string;
  devicePublicId: string;
  nonce: string;
  signingPublicKey: string;
}>;

const getBindMaterialReference = makeFunctionReference<
  "query",
  Readonly<{
    authSessionId: Id<"authSessions">;
    challengeId: string;
    userId: Id<"users">;
  }>,
  BindMaterial
>("devices:getBindMaterial");
const completeBindReference = makeFunctionReference<
  "mutation",
  Readonly<{
    authSessionId: Id<"authSessions">;
    challengeId: string;
    userId: Id<"users">;
  }>,
  DeviceSummary
>("devices:completeBind");

export const finishBind = action({
  args: {
    challengeId: v.string(),
    signature: v.string(),
  },
  handler: async (ctx, args): Promise<DeviceSummary> => {
    const [authSessionId, userId] = await Promise.all([
      getAuthSessionId(ctx),
      getAuthUserId(ctx),
    ]);
    if (authSessionId === null || userId === null) rejectAuthority();
    const material = await ctx.runQuery(getBindMaterialReference, {
      authSessionId,
      challengeId: args.challengeId,
      userId,
    });
    if (!await verifyDeviceBind(
      material.signingPublicKey,
      {
        challengeId: material.challengeId,
        devicePublicId: material.devicePublicId,
        nonce: material.nonce,
      },
      args.signature,
    )) rejectAuthority();
    return await ctx.runMutation(completeBindReference, {
      authSessionId,
      challengeId: args.challengeId,
      userId,
    });
  },
});

export const revoke = mutation({
  args: {
    expectedRevision: v.number(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    targetPublicId: v.string(),
  },
  handler: async (ctx, args): Promise<DeviceSummary> => {
    const authority = await requireDaemonDevice(ctx, "administer");
    if (!isOpaqueIdentifier(args.targetPublicId) || !isSafePositiveInteger(args.expectedRevision)) {
      rejectAuthority();
    }
    const scope = {
      deviceId: authority.deviceId,
      operation: "device.revoke",
      scopeId: args.targetPublicId,
      userId: authority.userId,
    } as const;
    const replay = await loadIdempotencyReceipt(
      ctx,
      scope,
      args.idempotencyKey,
      args.requestDigest,
    );
    if (replay !== null) {
      const parsed = parseDeviceSummary(replay);
      if (parsed === null) rejectAuthority();
      const [jobs, targets] = await Promise.all([
        ctx.db.query("deviceRevocationJobs")
          .withIndex("by_public_id", (builder) =>
            builder.eq("publicId", args.idempotencyKey))
          .take(2),
        ctx.db.query("devices")
          .withIndex("by_user_and_public_id", (builder) => builder
            .eq("userId", authority.userId)
            .eq("publicId", parsed.publicId))
          .take(2),
      ]);
      if (
        jobs.length !== 1
        || jobs[0]?.userId !== authority.userId
        || targets.length !== 1
        || targets[0]?.status !== "revoked"
        || jobs[0].deviceId !== targets[0]._id
        || targets[0].revision !== parsed.revision
      ) rejectAuthority();
      return parsed;
    }
    const targets = await ctx.db
      .query("devices")
      .withIndex("by_user_and_public_id", (builder) =>
        builder.eq("userId", authority.userId).eq("publicId", args.targetPublicId))
      .take(2);
    const target = targets[0];
    if (
      targets.length !== 1
      || target === undefined
      || target._id === authority.deviceId
      || target.status === "revoked"
      || target.revision !== args.expectedRevision
    ) rejectAuthority();
    const credentialGeneration = target.credentialGeneration ?? 1;
    if (
      !isSafePositiveInteger(credentialGeneration)
      || credentialGeneration >= Number.MAX_SAFE_INTEGER
    ) rejectAuthority();
    const [deviceJobs, duplicateJobIds, presence] = await Promise.all([
      ctx.db.query("deviceRevocationJobs")
        .withIndex("by_device", (builder) => builder.eq("deviceId", target._id))
        .take(2),
      ctx.db.query("deviceRevocationJobs")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", args.idempotencyKey))
        .take(1),
      presenceForDevice(ctx, target._id),
    ]);
    if (deviceJobs.length !== 0 || duplicateJobIds.length !== 0) rejectAuthority();
    if (presence !== null && presence.userId !== authority.userId) rejectAuthority();
    const now = Date.now();
    const devicePatch = {
      credentialGeneration: credentialGeneration + 1,
      revision: target.revision + 1,
      revokedAt: now,
      status: "revoked",
      updatedAt: now,
    } as const;
    await adjustQuotaForPatch(ctx, authority.userId, "device", target, devicePatch);
    await ctx.db.patch(target._id, devicePatch);
    if (presence !== null) {
      const presencePatch = { presenceUntil: now } as const;
      await adjustQuotaForPatch(
        ctx,
        authority.userId,
        "device",
        presence,
        presencePatch,
      );
      await ctx.db.patch(presence._id, presencePatch);
    }
    const jobDocument = {
      category: "sessions",
      createdAt: now,
      deviceId: target._id,
      publicId: args.idempotencyKey,
      state: "pending",
      updatedAt: now,
      userId: authority.userId,
    } as const;
    await reserveQuotaForInsert(ctx, authority.userId, "job", jobDocument);
    await ctx.db.insert("deviceRevocationJobs", jobDocument);
    const securityDocument = {
      actorDeviceId: authority.deviceId,
      createdAt: now,
      entityId: target.publicId,
      event: "device_revoked",
      userId: authority.userId,
    } as const;
    await reserveQuotaForInsert(ctx, authority.userId, "security", securityDocument);
    await ctx.db.insert("securityEvents", securityDocument);
    const response = {
      deviceClass: deviceClassOf(target),
      publicId: target.publicId,
      revision: target.revision + 1,
      status: "revoked" as const,
    };
    await storeIdempotencyReceipt(ctx, scope, {
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      response,
    });
    return response;
  },
});

export const listKeyEnvelopes = query({
  args: {},
  handler: async (ctx) => {
    const authority = await requireDeviceAuthority(ctx);
    const envelopes = await ctx.db
      .query("deviceKeyEnvelopes")
      .withIndex("by_device_and_version", (builder) =>
        builder.eq("deviceId", authority.deviceId))
      .take(16);
    return envelopes.map((entry) => ({
      createdAt: entry.createdAt,
      envelope: entry.envelope,
    }));
  },
});
