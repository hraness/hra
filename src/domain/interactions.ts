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

const requestedPermissionSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.unknown(),
}).strict();

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
    mode: z.enum(["form", "openai_form", "url"]),
    url: z.string().url().max(4_096).nullable(),
    mayContainSecrets: z.boolean(),
  }).strict(),
]);

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
  requestedAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
  terminalAt: unixMillisecondsSchema.nullable(),
}).strict();

export type InteractionRecord = z.infer<typeof interactionRecordSchema>;

export const interactionDecisionSchema = z.enum(["once", "session", "decline", "cancel"]);

export const interactionResolutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval_decision"),
    decision: interactionDecisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("permission_grant"),
    permissions: z.record(z.string().min(1).max(256), z.unknown()),
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
