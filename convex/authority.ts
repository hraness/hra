import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import type { GenericId as Id } from "convex/values";

import type { MutationCtx, QueryCtx } from "./server";

const authorizationRejectedMessage = "Cloud authority is not current.";

type ReadCtx = Pick<QueryCtx, "auth" | "db"> | Pick<MutationCtx, "auth" | "db">;

export function rejectAuthority(): never {
  throw new Error(authorizationRejectedMessage);
}

export async function requireAuthAuthority(ctx: ReadCtx) {
  const [authSessionId, userId] = await Promise.all([
    getAuthSessionId(ctx),
    getAuthUserId(ctx),
  ]);
  if (authSessionId === null || userId === null) rejectAuthority();
  const [session, user] = await Promise.all([
    ctx.db.get(authSessionId),
    ctx.db.get(userId),
  ]);
  if (
    session?.userId !== userId
    || user?._id !== userId
    || session.expirationTime <= Date.now()
  ) rejectAuthority();
  const subjects = await ctx.db
    .query("authSubjects")
    .withIndex("by_user", (query) => query.eq("userId", userId))
    .take(2);
  const subject = subjects[0];
  if (
    subjects.length !== 1
    || subject?.status !== "active"
    || subject.userId !== userId
  ) rejectAuthority();
  return { authSessionId, subject, user, userId };
}

export async function requireDeviceAuthority(ctx: ReadCtx) {
  const auth = await requireAuthAuthority(ctx);
  const bindings = await ctx.db
    .query("deviceSessions")
    .withIndex("by_auth_session", (query) =>
      query.eq("authSessionId", auth.authSessionId))
    .take(2);
  const binding = bindings[0];
  if (bindings.length !== 1) rejectAuthority();
  if (binding === undefined) rejectAuthority();
  if (
    binding.revokedAt !== undefined
    || binding.userId !== auth.userId
    || binding.authEpoch !== auth.subject.authEpoch
  ) rejectAuthority();
  const device = await ctx.db.get(binding.deviceId);
  if (
    device?.userId !== auth.userId
    || device.authEpoch !== auth.subject.authEpoch
    || device.status !== "active"
    || device.revokedAt !== undefined
  ) rejectAuthority();
  return { ...auth, binding, device, deviceId: device._id };
}

export type DeviceClass = "daemon" | "browser";

// Every device row written before browser enrollment carries no class. Absence
// is `daemon`, so legacy rows keep full daemon authority without a migration.
export function deviceClassOf(
  device: Readonly<{ deviceClass?: DeviceClass }>,
): DeviceClass {
  return device.deviceClass ?? "daemon";
}

// A browser device is a key holder for the projection only. It may read, report
// presence, and enqueue commands; it may never administer devices and never
// perform a write the daemon owns as execution custodian.
export async function requireDaemonDevice(
  ctx: ReadCtx,
  duty: "administer" | "execute" = "execute",
) {
  const authority = await requireDeviceAuthority(ctx);
  if (deviceClassOf(authority.device) !== "daemon") {
    throw new Error(duty === "administer"
      ? "BROWSER_DEVICE_CANNOT_ADMINISTER"
      : "BROWSER_DEVICE_CANNOT_EXECUTE");
  }
  return authority;
}

export async function requireRegisteredDeviceAuthority(ctx: ReadCtx) {
  const auth = await requireAuthAuthority(ctx);
  const bindings = await ctx.db
    .query("deviceSessions")
    .withIndex("by_auth_session", (query) =>
      query.eq("authSessionId", auth.authSessionId))
    .take(2);
  const binding = bindings[0];
  if (bindings.length !== 1 || binding === undefined) rejectAuthority();
  if (
    binding.revokedAt !== undefined
    || binding.userId !== auth.userId
    || binding.authEpoch !== auth.subject.authEpoch
  ) rejectAuthority();
  const device = await ctx.db.get(binding.deviceId);
  if (
    device?.userId !== auth.userId
    || device.authEpoch !== auth.subject.authEpoch
    || (device.status !== "pending" && device.status !== "active")
    || device.revokedAt !== undefined
  ) rejectAuthority();
  return { ...auth, binding, device, deviceId: device._id };
}

export async function requireOwnedSession(
  ctx: ReadCtx,
  userId: Id<"users">,
  sessionId: Id<"sessionHeads">,
) {
  const session = await ctx.db.get(sessionId);
  if (session?.userId !== userId) rejectAuthority();
  return session;
}

export async function requireOwnedDevice(
  ctx: ReadCtx,
  userId: Id<"users">,
  deviceId: Id<"devices">,
) {
  const device = await ctx.db.get(deviceId);
  if (device?.userId !== userId) rejectAuthority();
  return device;
}
