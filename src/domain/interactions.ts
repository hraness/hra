import { z } from "zod";

import { profileIdSchema, sessionIdSchema, unixMillisecondsSchema } from "./values";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const providerIdentifierSchema = z.string().min(1).max(512);
const nullableProviderIdentifierSchema = providerIdentifierSchema.nullable();
const safeDisplayTextSchema = z.string().max(4_096);

export const providerRequestIdSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("number"), value: z.number().int().safe() }).strict(),
  z.object({ type: z.literal("string"), value: z.string().min(1).max(512) }).strict(),
]);

export type ProviderRequestId = z.infer<typeof providerRequestIdSchema>;

export const interactionKindSchema = z.enum([
  "command_approval",
  "file_change_approval",
  "permission_approval",
  "user_input",
  "mcp_elicitation",
]);

export type InteractionKind = z.infer<typeof interactionKindSchema>;

export const interactionStateSchema = z.enum([
  "pending",
  "response_prepared",
  "response_written",
  "resolved",
  "declined",
  "canceled",
  "expired",
  "resolution_unknown",
]);

export type InteractionState = z.infer<typeof interactionStateSchema>;

export const interactionIntendedTerminalStateSchema = z.enum([
  "resolved",
  "declined",
  "canceled",
  "expired",
]);

export type InteractionIntendedTerminalState = z.infer<
  typeof interactionIntendedTerminalStateSchema
>;

/** HRA never leaves an admitted provider callback pending longer than 30 minutes. */
export const INTERACTION_MAX_PENDING_MS = 30 * 60 * 1_000;

export const providerInteractionAuthoritySchema = z.object({
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  connectionId: z.string().uuid(),
  requestId: providerRequestIdSchema,
  method: z.string().min(1).max(512),
  requestDigest: digestSchema,
  threadId: nullableProviderIdentifierSchema,
  turnId: nullableProviderIdentifierSchema,
  itemId: nullableProviderIdentifierSchema,
  approvalId: nullableProviderIdentifierSchema,
}).strict();

export type ProviderInteractionAuthority = z.infer<typeof providerInteractionAuthoritySchema>;

const interactionOptionSchema = z.object({
  label: z.string().min(1).max(512),
  description: z.string().max(2_048),
}).strict();

const interactionQuestionSchema = z.object({
  id: providerIdentifierSchema,
  header: z.string().min(1).max(256),
  question: z.string().min(1).max(4_096),
  options: z.array(interactionOptionSchema).max(20).nullable(),
  allowsOther: z.boolean(),
  secret: z.boolean(),
}).strict();

const permissionNameSchema = z.string().min(1).max(256);

const requestedPermissionSchema = z.object({
  name: permissionNameSchema,
}).strict();

const permissionSelectionSchema = z.array(permissionNameSchema).min(1).max(100)
  .superRefine((names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        message: "Selected permission names must be unique.",
      });
    }
  });

const mcpFormFieldNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u);
const mcpFormChoiceSchema = z.string().max(128);

export const mcpFormFieldSchema = z.discriminatedUnion("type", [
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.literal("string"),
    required: z.boolean(),
    minLength: z.number().int().min(0).max(16_384),
    maxLength: z.number().int().min(0).max(16_384),
    format: z.enum(["email", "uri", "date", "date-time"]).nullable(),
  }).strict(),
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.enum(["number", "integer"]),
    required: z.boolean(),
    minimum: z.number().finite().nullable(),
    maximum: z.number().finite().nullable(),
  }).strict(),
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.literal("boolean"),
    required: z.boolean(),
  }).strict(),
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.literal("single_select"),
    required: z.boolean(),
    choices: z.array(mcpFormChoiceSchema).min(1).max(20),
  }).strict(),
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.literal("multi_select"),
    required: z.boolean(),
    choices: z.array(mcpFormChoiceSchema).min(1).max(20),
    minItems: z.number().int().min(0).max(20),
    maxItems: z.number().int().min(0).max(20),
  }).strict(),
]).superRefine((field, context) => {
  if (field.type === "string" && field.minLength > field.maxLength) {
    context.addIssue({
      code: "custom",
      message: "An MCP string field minimum cannot exceed its maximum.",
      path: ["minLength"],
    });
  }
  if (
    (field.type === "number" || field.type === "integer")
    && field.minimum !== null
    && field.maximum !== null
    && field.minimum > field.maximum
  ) {
    context.addIssue({
      code: "custom",
      message: "An MCP numeric field minimum cannot exceed its maximum.",
      path: ["minimum"],
    });
  }
  if (field.type === "multi_select" && field.minItems > field.maxItems) {
    context.addIssue({
      code: "custom",
      message: "An MCP multi-select minimum cannot exceed its maximum.",
      path: ["minItems"],
    });
  }
  if (
    (field.type === "single_select" || field.type === "multi_select")
    && new Set(field.choices).size !== field.choices.length
  ) {
    context.addIssue({
      code: "custom",
      message: "MCP form choices must be unique.",
      path: ["choices"],
    });
  }
});

export type McpFormField = z.infer<typeof mcpFormFieldSchema>;

export const interactionDisplaySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command_approval"),
    summary: safeDisplayTextSchema,
    reason: safeDisplayTextSchema.nullable(),
    commandClass: z.string().min(1).max(256),
    workingDirectory: z.string().max(1_024).nullable(),
    allowsSessionApproval: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("file_change_approval"),
    summary: safeDisplayTextSchema,
    reason: safeDisplayTextSchema.nullable(),
    grantRoot: z.string().max(1_024).nullable(),
    allowsSessionApproval: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("permission_approval"),
    summary: safeDisplayTextSchema,
    reason: safeDisplayTextSchema.nullable(),
    requested: z.array(requestedPermissionSchema).max(100),
    allowsSessionScope: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("user_input"),
    summary: safeDisplayTextSchema,
    blocking: z.boolean(),
    questions: z.array(interactionQuestionSchema).min(1).max(3),
  }).strict(),
  z.object({
    kind: z.literal("mcp_elicitation"),
    summary: safeDisplayTextSchema,
    serverName: z.string().min(1).max(256),
    mode: z.enum(["form", "openai_form"]),
    url: z.null(),
    mayContainSecrets: z.literal(true),
    fields: z.array(mcpFormFieldSchema).max(16).optional(),
  }).strict(),
]).superRefine((display, context) => {
  if (display.kind !== "mcp_elicitation" || display.fields === undefined) return;
  const names = display.fields.map((field) => field.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({
      code: "custom",
      message: "MCP form field names must be unique.",
      path: ["fields"],
    });
  }
});

export type InteractionDisplay = z.infer<typeof interactionDisplaySchema>;

export const interactionRecordSchema = z.object({
  version: z.literal(1),
  publicId: z.string().uuid(),
  sessionId: sessionIdSchema.nullable(),
  authority: providerInteractionAuthoritySchema,
  kind: interactionKindSchema,
  state: interactionStateSchema,
  revision: z.number().int().positive(),
  blocking: z.boolean(),
  display: interactionDisplaySchema,
  responseDigest: digestSchema.nullable(),
  intendedTerminalState: interactionIntendedTerminalStateSchema.nullable(),
  requestedAt: unixMillisecondsSchema,
  deadlineAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
  terminalAt: unixMillisecondsSchema.nullable(),
}).strict().superRefine((interaction, context) => {
  if (interaction.deadlineAt < interaction.requestedAt) {
    context.addIssue({
      code: "custom",
      message: "The interaction deadline cannot precede its request time.",
      path: ["deadlineAt"],
    });
  }
});

export type InteractionRecord = z.infer<typeof interactionRecordSchema>;

const publicInteractionDisplaySchema = interactionDisplaySchema;

export const publicInteractionSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  sessionId: sessionIdSchema.nullable(),
  kind: interactionKindSchema,
  state: interactionStateSchema,
  revision: z.number().int().positive(),
  blocking: z.boolean(),
  display: publicInteractionDisplaySchema,
  responseRecorded: z.boolean(),
  context: z.object({
    turnId: nullableProviderIdentifierSchema,
    itemId: nullableProviderIdentifierSchema,
  }).strict(),
  requestedAt: unixMillisecondsSchema,
  deadlineAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
  terminalAt: unixMillisecondsSchema.nullable(),
}).strict().superRefine((interaction, context) => {
  if (interaction.kind !== interaction.display.kind) {
    context.addIssue({
      code: "custom",
      message: "The public interaction kind must match its display kind.",
      path: ["display", "kind"],
    });
  }
});

export type PublicInteraction = z.infer<typeof publicInteractionSchema>;

export const interactionDecisionSchema = z.enum(["once", "session", "decline", "cancel"]);

export const interactionResolutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval_decision"),
    decision: interactionDecisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("permission_grant"),
    permissions: permissionSelectionSchema,
    scope: z.enum(["turn", "session"]).nullable(),
  }).strict(),
  z.object({
    kind: z.literal("user_answers"),
    answers: z.record(
      providerIdentifierSchema,
      z.object({ answers: z.array(z.string().max(16_384)).max(20) }).strict(),
    ),
  }).strict(),
  z.object({
    kind: z.literal("mcp_submission"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.unknown().optional(),
  }).strict(),
]);

export type InteractionResolution = z.infer<typeof interactionResolutionSchema>;

export const preparedInteractionResponseSchema = z.object({
  interactionId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  responseDigest: digestSchema,
  resolution: interactionResolutionSchema,
}).strict();

export type PreparedInteractionResponse = z.infer<typeof preparedInteractionResponseSchema>;
