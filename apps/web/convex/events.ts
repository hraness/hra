import type { Infer } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type {
  eventCommandValidator,
  persistedEventActorValidator,
  publicMetadataValidator,
  securityEventTypeValidator,
  taskEventTypeValidator,
} from "./model";
import { randomPublicId } from "./domain";
import { advanceWorkspaceProjectionById } from "./hraProjection";

type EventActor = Infer<typeof persistedEventActorValidator>;
type EventCommand = Infer<typeof eventCommandValidator>;
type PublicMetadata = Infer<typeof publicMetadataValidator>;
type TaskEventType = Infer<typeof taskEventTypeValidator>;
type SecurityEventType = Infer<typeof securityEventTypeValidator>;

export async function appendTaskEvent(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    workspaceId: Id<"workspaces">;
    taskId: Id<"tasks">;
    taskPublicId: string;
    taskRevision: number;
    type: TaskEventType;
    actor: EventActor;
    command: EventCommand;
    payload?: PublicMetadata;
    now: number;
  },
) {
  const eventId = await ctx.db.insert("taskEvents", {
    publicId: randomPublicId("evt"),
    organizationId: args.organizationId,
    workspaceId: args.workspaceId,
    taskId: args.taskId,
    taskPublicId: args.taskPublicId,
    taskRevision: args.taskRevision,
    type: args.type,
    schemaVersion: 1,
    actor: args.actor,
    command: args.command,
    payload: args.payload ?? {},
    createdAt: args.now,
  });
  await advanceWorkspaceProjectionById(ctx, args.workspaceId, args.now);
  return eventId;
}

export async function appendSecurityEvent(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    workspaceId: Id<"workspaces">;
    agentId?: Id<"agents">;
    type: SecurityEventType;
    actor: EventActor;
    command: EventCommand;
    payload?: PublicMetadata;
    now: number;
  },
) {
  const eventId = await ctx.db.insert("securityEvents", {
    organizationId: args.organizationId,
    workspaceId: args.workspaceId,
    ...(args.agentId === undefined ? {} : { agentId: args.agentId }),
    type: args.type,
    schemaVersion: 1,
    actor: args.actor,
    command: args.command,
    payload: args.payload ?? {},
    createdAt: args.now,
  });
  await advanceWorkspaceProjectionById(ctx, args.workspaceId, args.now);
  return eventId;
}
