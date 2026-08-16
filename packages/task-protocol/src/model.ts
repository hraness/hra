import {
  agentIdSchema,
  epochMsSchema,
  positiveGenerationSchema,
  taskCommentIdSchema,
  taskLabelSchema,
  taskReferenceIdSchema,
  taskReferenceKindSchema,
} from "@hraness/agent-tasks-domain/model";
import { z } from "@hra-internal/schema";

import { requestIdSchema, uuidV7Schema } from "./tokens";

export * from "@hraness/agent-tasks-domain/model";

export const API_VERSION = "v1" as const;
export const DEFAULT_CLAIM_LEASE_MS = 15 * 60 * 1_000;
export const CLAIM_RENEWAL_THRESHOLD_MS = 5 * 60 * 1_000;
export const AGENT_SESSION_IDLE_MS = 20 * 60 * 1_000;
export const AGENT_SESSION_HEARTBEAT_MS = 5 * 60 * 1_000;
export const MIN_AGENT_CREDENTIAL_LIFETIME_MS = 60 * 60 * 1_000;
export const DEFAULT_AGENT_CREDENTIAL_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
export const MAX_AGENT_CREDENTIAL_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;
export const IDEMPOTENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const IDEMPOTENCY_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export const agentScopeValues = [
  "tasks:read",
  "tasks:create",
  "tasks:edit",
  "tasks:assign",
  "tasks:claim",
  "tasks:submit",
  "tasks:review",
  "dependencies:write",
  "comments:write",
  "dispatch:execute",
  "runtime:heartbeat",
  "runs:report",
] as const;
export const agentScopeSchema = z.enum(agentScopeValues);
export type AgentScope = z.infer<typeof agentScopeSchema>;

export const agentPresetValues = ["worker", "planner", "reviewer", "observer", "dispatcher"] as const;
export const agentPresetSchema = z.enum(agentPresetValues);
export type AgentPreset = z.infer<typeof agentPresetSchema>;

export const agentPresetScopes = {
  worker: [
    "tasks:read",
    "tasks:create",
    "tasks:edit",
    "dependencies:write",
    "tasks:claim",
    "tasks:submit",
    "comments:write",
  ],
  planner: [
    "tasks:read",
    "tasks:create",
    "tasks:edit",
    "dependencies:write",
    "tasks:assign",
    "comments:write",
  ],
  reviewer: ["tasks:read", "tasks:review", "comments:write"],
  observer: ["tasks:read"],
  dispatcher: [
    "tasks:read",
    "tasks:claim",
    "tasks:submit",
    "comments:write",
    "dispatch:execute",
    "runtime:heartbeat",
    "runs:report",
  ],
} as const satisfies Record<AgentPreset, readonly AgentScope[]>;

export const organizationRoleValues = ["owner", "admin", "member"] as const;
export const organizationRoleSchema = z.enum(organizationRoleValues);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const workspaceRoleValues = ["planner", "reviewer", "viewer"] as const;
export const workspaceRoleSchema = z.enum(workspaceRoleValues);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const agentStatusValues = ["active", "disabled"] as const;
export const agentStatusSchema = z.enum(agentStatusValues);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const credentialStatusValues = ["active", "revoked"] as const;
export const credentialStatusSchema = z.enum(credentialStatusValues);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

export const sessionStatusValues = ["active", "expired", "revoked"] as const;
export const sessionStatusSchema = z.enum(sessionStatusValues);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const securityEventTypeValues = [
  "agent.enrollment_created",
  "agent.enrollment_redeemed",
  "agent.credential_created",
  "agent.credential_revoked",
  "agent.session_started",
  "agent.session_expired",
  "agent.disabled",
] as const;
export const securityEventTypeSchema = z.enum(securityEventTypeValues);
export type SecurityEventType = z.infer<typeof securityEventTypeSchema>;

export const phaseOneSecurityEventByTransition = {
  redeemEnrollment: "agent.enrollment_redeemed",
  startSession: "agent.session_started",
} as const satisfies Record<string, SecurityEventType>;

export const workosUserIdSchema = z.string()
  .regex(/^user_[A-Za-z0-9]+$/u, "invalid WorkOS user ID");
export const workosOrganizationIdSchema = z.string()
  .regex(/^org_[A-Za-z0-9]+$/u, "invalid WorkOS organization ID");
export const workosMembershipIdSchema = z.string()
  .regex(/^om_[A-Za-z0-9]+$/u, "invalid WorkOS organization membership ID");

function hasOnlyAllowedOwnedTextControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint <= 31 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
        codePoint === 127)
    ) return false;
  }
  return true;
}

function boundedName(maximumBytes: number) {
  return z.string().transform((value) => value.trim()).pipe(
    z.string().min(1)
      .refine(hasOnlyAllowedOwnedTextControls, "name contains a disallowed control character")
      .refine(
        (value) => new TextEncoder().encode(value).length <= maximumBytes,
        `name exceeds ${maximumBytes} UTF-8 bytes`,
      ),
  );
}

export const organizationNameSchema = boundedName(160);
export const agentNameSchema = boundedName(120);

/**
 * Provider locators and event command correlation are cloud wire concerns.
 *
 * Local authority uses stable public IDs and operation receipts from the leaf
 * domain; these permissive locators remain here only for existing Convex data.
 */
export const workspaceIdSchema = z.string().min(1).max(128);
export const organizationIdSchema = z.string().min(1).max(128);
export const taskIdSchema = z.string().min(1).max(128);

export const actorKindValues = ["human", "agent", "system"] as const;
export const actorKindSchema = z.enum(actorKindValues);
export type ActorKind = z.infer<typeof actorKindSchema>;

export const humanActorSchema = z.object({
  kind: z.literal("human"),
  userId: z.string().min(1),
}).strict();
export const agentActorSchema = z.object({
  kind: z.literal("agent"),
  agentId: agentIdSchema,
}).strict();
export const systemJobKindSchema = z.enum([
  "claim_expiry",
  "defer_wake",
  "repair",
  "reconciliation",
]);
export const systemActorSchema = z.object({
  kind: z.literal("system"),
  jobKind: systemJobKindSchema,
}).strict();
export const eventActorSchema = z.discriminatedUnion("kind", [
  humanActorSchema,
  agentActorSchema,
  systemActorSchema,
]);
export type EventActor = z.infer<typeof eventActorSchema>;

export const eventCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("client"),
    idempotencyKey: uuidV7Schema,
    requestId: requestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("system"),
    jobKind: systemJobKindSchema,
  }).strict(),
]);
export type EventCommand = z.infer<typeof eventCommandSchema>;

export const taskUpdatedFieldValues = [
  "title",
  "description",
  "type",
  "priority",
  "blockers",
  "currentClaim.leaseUntil",
] as const;
export const taskUpdatedFieldSchema = z.enum(taskUpdatedFieldValues);

const taskEventBaseSchema = z.object({
  id: z.string().min(1).max(128),
  organizationId: organizationIdSchema,
  workspaceId: workspaceIdSchema,
  taskId: taskIdSchema,
  taskRevision: positiveGenerationSchema,
  schemaVersion: z.literal(1),
  actor: eventActorSchema,
  command: eventCommandSchema,
  createdAt: epochMsSchema,
}).strict();
const noEventPayloadSchema = z.object({}).strict();
const claimEventPayloadSchema = z.object({
  agentId: agentIdSchema,
  fence: positiveGenerationSchema,
  leaseUntil: epochMsSchema,
}).strict();

export const taskEventSchema = z.discriminatedUnion("type", [
  taskEventBaseSchema.extend({
    type: z.literal("task.created"),
    payload: z.object({ availableAt: epochMsSchema }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.deferred"),
    payload: z.object({ availableAt: epochMsSchema }).strict(),
  }),
  taskEventBaseSchema.extend({ type: z.literal("task.became_ready"), payload: noEventPayloadSchema }),
  taskEventBaseSchema.extend({ type: z.literal("task.claimed"), payload: claimEventPayloadSchema }),
  taskEventBaseSchema.extend({
    type: z.literal("task.claim_renewed"),
    payload: z.object({
      fence: positiveGenerationSchema,
      leaseGeneration: positiveGenerationSchema,
      leaseUntil: epochMsSchema,
    }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.claim_released"),
    payload: z.object({ fence: positiveGenerationSchema }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.claim_expired"),
    payload: z.object({ fence: positiveGenerationSchema }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.reclaimed"),
    payload: claimEventPayloadSchema.extend({ previousAgentId: agentIdSchema }),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.submitted"),
    payload: z.object({ submissionId: z.string().min(1).max(128) }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.accepted"),
    payload: z.object({ submissionId: z.string().min(1).max(128) }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.rejected"),
    payload: z.object({
      submissionId: z.string().min(1).max(128),
      reason: z.string().min(1).max(1_000),
    }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.updated"),
    payload: z.object({
      fields: z.array(taskUpdatedFieldSchema).min(1).max(taskUpdatedFieldValues.length)
        .refine((fields) => new Set(fields).size === fields.length, "updated fields must be unique"),
    }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.cancelled"),
    payload: z.object({ reason: z.string().min(1).max(1_000) }).strict(),
  }),
  taskEventBaseSchema.extend({ type: z.literal("task.reopened"), payload: noEventPayloadSchema }),
  taskEventBaseSchema.extend({
    type: z.literal("task.assigned"),
    payload: z.object({ assigneeAgentId: agentIdSchema.nullable() }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.parent_set"),
    payload: z.object({ parentTaskId: taskIdSchema }).strict(),
  }),
  taskEventBaseSchema.extend({ type: z.literal("task.parent_cleared"), payload: noEventPayloadSchema }),
  taskEventBaseSchema.extend({
    type: z.literal("task.label_added"),
    payload: z.object({ label: taskLabelSchema }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.label_removed"),
    payload: z.object({ label: taskLabelSchema }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.comment_added"),
    payload: z.object({ commentId: taskCommentIdSchema }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.reference_added"),
    payload: z.object({
      referenceId: taskReferenceIdSchema,
      kind: taskReferenceKindSchema,
    }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("task.reference_removed"),
    payload: z.object({
      referenceId: taskReferenceIdSchema,
      kind: taskReferenceKindSchema,
    }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("dependency.added"),
    payload: z.object({ blockerTaskId: taskIdSchema, blockedTaskId: taskIdSchema }).strict(),
  }),
  taskEventBaseSchema.extend({
    type: z.literal("dependency.removed"),
    payload: z.object({ blockerTaskId: taskIdSchema, blockedTaskId: taskIdSchema }).strict(),
  }),
]).refine(
  (event) => new TextEncoder().encode(JSON.stringify(event.payload)).length <= 16 * 1_024,
  "event payload exceeds 16 KiB",
).superRefine((event, context) => {
  if ((event.actor.kind === "system") !== (event.command.kind === "system")) {
    context.addIssue({
      code: "custom",
      message: "system events require a system command and client events require a human or agent actor",
      path: ["command", "kind"],
    });
  }
  if (
    event.actor.kind === "system" &&
    event.command.kind === "system" &&
    event.actor.jobKind !== event.command.jobKind
  ) {
    context.addIssue({
      code: "custom",
      message: "system actor and command job kinds must agree",
      path: ["command", "jobKind"],
    });
  }
});
export type TaskEvent = z.infer<typeof taskEventSchema>;
