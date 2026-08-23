import { requireAuthAuthority } from "./authority";
import { query } from "./server";

export const current = query({
  args: {},
  handler: async (ctx) => {
    const auth = await requireAuthAuthority(ctx);
    const [bindings, activeDevices] = await Promise.all([
      ctx.db
        .query("deviceSessions")
        .withIndex("by_auth_session", (builder) =>
          builder.eq("authSessionId", auth.authSessionId))
        .take(2),
      ctx.db
        .query("devices")
        .withIndex("by_user_and_status", (builder) =>
          builder.eq("userId", auth.userId).eq("status", "active"))
        .take(1),
    ]);
    if (bindings.length > 1) throw new Error("Cloud authority is not current.");
    const binding = bindings[0];
    if (binding === undefined) {
      return {
        authEpoch: auth.subject.authEpoch,
        device: null,
        hasActiveDevices: activeDevices.length !== 0,
        userPublicId: String(auth.userId),
      };
    }
    const device = await ctx.db.get(binding.deviceId);
    if (device?.userId !== auth.userId) {
      throw new Error("Cloud authority is not current.");
    }
    return {
      authEpoch: auth.subject.authEpoch,
      device: {
        credentialGeneration: device.credentialGeneration ?? 1,
        keyVersion: device.keyVersion,
        publicId: device.publicId,
        revision: device.revision,
        status: device.status,
      },
      hasActiveDevices: activeDevices.length !== 0,
      userPublicId: String(auth.userId),
    };
  },
});
