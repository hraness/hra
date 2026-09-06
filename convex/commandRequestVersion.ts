import type { GenericId as Id } from "convex/values";

import { rejectAuthority } from "./authority";
import type { MutationCtx } from "./server";

export type CommandRequestVersion = 2 | undefined;

/**
 * Admit a fresh command only when its wire contract exactly matches the
 * capability most recently published by the target daemon. A missing registry
 * is the legacy (unversioned) capability. Reading the row in this mutation also
 * makes a concurrent registry upgrade/downgrade conflict under Convex OCC.
 */
export async function requireTargetCommandRequestVersion(
  ctx: MutationCtx,
  input: Readonly<{
    requestCommitmentVersion: CommandRequestVersion;
    targetDeviceId: Id<"devices">;
    userId: Id<"users">;
  }>,
): Promise<void> {
  const matches = await ctx.db
    .query("deviceRegistries")
    .withIndex("by_device", (builder) => builder.eq("deviceId", input.targetDeviceId))
    .take(2);
  if (matches.length > 1) rejectAuthority();
  const registry = matches[0];
  if (registry !== undefined && registry.userId !== input.userId) rejectAuthority();
  if (registry?.commandRequestVersion !== input.requestCommitmentVersion) {
    throw new Error("COMMAND_REQUEST_VERSION_UNSUPPORTED");
  }
}

/** Bind an executable transition to the protocol marker stored on the row. */
export function requireCommandExecutorRequestVersion(
  stored: CommandRequestVersion,
  supplied: CommandRequestVersion,
): void {
  if (stored !== supplied) throw new Error("COMMAND_EXECUTOR_VERSION_UNSUPPORTED");
}
