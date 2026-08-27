import { z } from "zod";

import { publicProviderIdentifierSchema } from "../public-provider-identifier";
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

export const interactionDecisionSchema = z.enum(["once", "session", "decline", "cancel"]);

export type InteractionDecision = z.infer<typeof interactionDecisionSchema>;

const availableInteractionDecisionsSchema = z.array(interactionDecisionSchema).min(1).max(4)
  .superRefine((decisions, context) => {
    if (new Set(decisions).size !== decisions.length) {
      context.addIssue({
        code: "custom",
        message: "Available interaction decisions must be unique.",
      });
    }
  });

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
    availableDecisions: availableInteractionDecisionsSchema,
  }).strict(),
  z.object({
    kind: z.literal("file_change_approval"),
    summary: safeDisplayTextSchema,
    reason: safeDisplayTextSchema.nullable(),
    grantRoot: z.string().max(1_024).nullable(),
    availableDecisions: availableInteractionDecisionsSchema,
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
    turnId: publicProviderIdentifierSchema.nullable(),
    itemId: publicProviderIdentifierSchema.nullable(),
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

export type ProtectedInteractionJson =
  | null
  | boolean
  | number
  | string
  | ProtectedInteractionJson[]
  | { readonly [key: string]: ProtectedInteractionJson };

/** Complete live approval authority plus its public binding must fit this document. */
export const PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES = 3 * 1024 * 1024;
export const PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES = 64 * 1024;

const isProtectedInteractionJson = (value: unknown): value is ProtectedInteractionJson => {
  const pending: Array<{ readonly depth: number; readonly value: unknown }> = [{ depth: 0, value }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || ++visited > 100_000 || current.depth > 64) return false;
    const entry = current.value;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") continue;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) return false;
      continue;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) pending.push({ depth: current.depth + 1, value: child });
      continue;
    }
    if (typeof entry !== "object") return false;
    const objectEntry = entry as Record<string, unknown>;
    const prototype: unknown = Object.getPrototypeOf(objectEntry);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const child of Object.values(objectEntry)) {
      pending.push({ depth: current.depth + 1, value: child });
    }
  }
  return true;
};

const protectedInteractionJsonSchema = z.custom<ProtectedInteractionJson>(
  isProtectedInteractionJson,
  "Expected bounded JSON interaction authority.",
);

export const liveInteractionApprovalAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command_approval"),
    command: z.string().min(1).max(1_000_000),
    reason: z.string().max(4_096).nullable(),
    availableDecisions: protectedInteractionJsonSchema,
    workingDirectory: z.string().max(16_384).nullable(),
    environmentId: z.string().min(1).max(512).nullable(),
    commandActions: protectedInteractionJsonSchema.nullable(),
    networkApprovalContext: protectedInteractionJsonSchema.nullable(),
    additionalPermissions: protectedInteractionJsonSchema.nullable(),
    proposedExecpolicyAmendment: protectedInteractionJsonSchema.nullable(),
    proposedNetworkPolicyAmendments: protectedInteractionJsonSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("permission_approval"),
    permissions: protectedInteractionJsonSchema,
    reason: z.string().max(4_096).nullable(),
    workingDirectory: z.string().min(1).max(16_384),
    environmentId: z.string().min(1).max(512).nullable(),
  }).strict(),
]);

export type LiveInteractionApprovalAuthority = z.infer<
  typeof liveInteractionApprovalAuthoritySchema
>;

const protectedInteractionBindingSchema = z.object({
  interactionId: z.string().uuid(),
  revision: z.number().int().positive(),
  kind: z.enum(["command_approval", "permission_approval"]),
  sessionId: sessionIdSchema.nullable(),
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  connectionId: z.string().uuid(),
}).strict();

export const protectedInteractionDetailDocumentSchema = z.object({
  type: z.literal("hra_protected_interaction_detail"),
  version: z.literal(1),
  binding: protectedInteractionBindingSchema,
  authority: liveInteractionApprovalAuthoritySchema,
}).strict().superRefine((document, context) => {
  if (document.binding.kind !== document.authority.kind) {
    context.addIssue({
      code: "custom",
      message: "The protected authority kind must match its interaction binding.",
      path: ["authority", "kind"],
    });
  }
});

export type ProtectedInteractionDetailDocument = z.infer<
  typeof protectedInteractionDetailDocumentSchema
>;

/** The newline is part of the protected document contract and every byte bound. */
export const encodeProtectedInteractionDetailDocument = (
  document: ProtectedInteractionDetailDocument,
): Uint8Array => new TextEncoder().encode(`${JSON.stringify(document)}\n`);

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
