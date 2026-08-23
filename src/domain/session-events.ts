import { z } from "zod";

import { profileIdSchema, sessionIdSchema, unixMillisecondsSchema } from "./values";

export const SESSION_EVENT_PAGE_LIMIT = 200;
export const SESSION_EVENT_PAGE_BYTES = 512 * 1024;
export const SESSION_EVENT_MAX_BYTES = 64 * 1024;
export const SESSION_EVENT_WAIT_MAX_MS = 30_000;
export const SESSION_EVENT_RETAIN_COUNT = 50_000;
export const SESSION_EVENT_RETAIN_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const SESSION_EVENT_RETAIN_BYTES = 64 * 1024 * 1024;

const boundedText = (maximum: number) => z.string().max(maximum);
const providerIdentifierSchema = z.string().min(1).max(512);
const eventSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const streamEpochSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const sessionEventCursorPayloadSchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  streamEpoch: streamEpochSchema,
  sequence: eventSequenceSchema,
}).strict();

export type SessionEventCursorPayload = z.infer<typeof sessionEventCursorPayloadSchema>;

export const sessionEventGapReasonSchema = z.enum([
  "provider_disconnect",
  "provider_restart",
  "stream_restored",
  "retention_count",
  "retention_age",
  "retention_bytes",
  "protocol_incompatible",
]);

export type SessionEventGapReason = z.infer<typeof sessionEventGapReasonSchema>;

const safePathSummarySchema = z.object({
  path: boundedText(1_024),
  kind: z.enum(["created", "modified", "deleted", "renamed", "unknown"]),
}).strict();

const planStepSchema = z.object({
  text: boundedText(1_024),
  status: z.enum(["pending", "in_progress", "completed"]),
}).strict();

export const sessionEventBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connection"),
    state: z.enum(["connected", "resubscribed", "disconnected"]),
    reason: boundedText(1_024).optional(),
  }).strict(),
  z.object({
    type: z.literal("gap"),
    reason: sessionEventGapReasonSchema,
    fromSequence: eventSequenceSchema,
    throughSequence: eventSequenceSchema,
  }).strict(),
  z.object({
    type: z.literal("session_status"),
    status: z.enum(["active", "idle", "terminal", "system_error", "not_loaded"]),
    activeTurnId: providerIdentifierSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("turn_started"),
    turnId: providerIdentifierSchema,
  }).strict(),
  z.object({
    type: z.literal("turn_completed"),
    turnId: providerIdentifierSchema,
    status: z.enum(["completed", "interrupted", "failed"]),
    errorCode: boundedText(256).optional(),
  }).strict(),
  z.object({
    type: z.literal("item_started"),
    turnId: providerIdentifierSchema,
    itemId: providerIdentifierSchema,
    itemKind: boundedText(128),
  }).strict(),
  z.object({
    type: z.literal("item_completed"),
    turnId: providerIdentifierSchema,
    itemId: providerIdentifierSchema,
    itemKind: boundedText(128),
    status: boundedText(128).optional(),
  }).strict(),
  z.object({
    type: z.literal("assistant_delta"),
    turnId: providerIdentifierSchema,
    itemId: providerIdentifierSchema,
    text: boundedText(32_768),
  }).strict(),
  z.object({
    type: z.literal("reasoning_summary_delta"),
    turnId: providerIdentifierSchema,
    itemId: providerIdentifierSchema,
    summaryPart: z.number().int().nonnegative().max(10_000).optional(),
    text: boundedText(32_768),
  }).strict(),
  z.object({
    type: z.literal("tool_progress"),
    turnId: providerIdentifierSchema,
    itemId: providerIdentifierSchema,
    toolKind: boundedText(128),
    status: boundedText(128).optional(),
    outputBytesObserved: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    server: boundedText(256).optional(),
    tool: boundedText(256).optional(),
  }).strict(),
  z.object({
    type: z.literal("file_change"),
    turnId: providerIdentifierSchema,
    itemId: providerIdentifierSchema,
    status: boundedText(128),
    paths: z.array(safePathSummarySchema).max(100),
    omittedPaths: z.number().int().nonnegative().max(1_000_000),
  }).strict(),
  z.object({
    type: z.literal("plan_updated"),
    turnId: providerIdentifierSchema,
    steps: z.array(planStepSchema).max(100),
    explanation: boundedText(4_096).optional(),
  }).strict(),
  z.object({
    type: z.literal("diff_updated"),
    turnId: providerIdentifierSchema,
    changedFiles: z.number().int().nonnegative().max(1_000_000),
    patchBytesObserved: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    type: z.literal("token_usage"),
    turnId: providerIdentifierSchema.nullable(),
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    cachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    reasoningOutputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    modelContextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  }).strict(),
  z.object({
    type: z.literal("interaction_requested"),
    interactionId: z.string().uuid(),
    interactionKind: z.enum([
      "command_approval",
      "file_change_approval",
      "permission_approval",
      "user_input",
      "mcp_elicitation",
    ]),
    revision: z.number().int().positive(),
    blocking: z.boolean(),
    summary: boundedText(2_048),
  }).strict(),
  z.object({
    type: z.literal("interaction_state"),
    interactionId: z.string().uuid(),
    state: z.enum([
      "pending",
      "response_prepared",
      "response_written",
      "resolved",
      "declined",
      "canceled",
      "expired",
      "resolution_unknown",
    ]),
    revision: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal("warning"),
    code: boundedText(256),
    message: boundedText(2_048),
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: boundedText(256),
    message: boundedText(2_048),
    terminal: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("protocol_incompatible"),
    method: boundedText(512),
    payloadDigest: digestSchema,
  }).strict(),
]);

export type SessionEventBody = z.infer<typeof sessionEventBodySchema>;

export const sessionEventSchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  streamEpoch: streamEpochSchema,
  sequence: eventSequenceSchema,
  recordedAt: unixMillisecondsSchema,
  accountId: profileIdSchema,
  providerGeneration: z.number().int().nonnegative(),
  providerConnectionId: z.string().uuid().nullable(),
  body: sessionEventBodySchema,
}).strict();

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEventPageSchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  requestedCursor: z.string().max(2_048).nullable(),
  retentionFloorCursor: z.string().min(1).max(2_048),
  observedThroughCursor: z.string().min(1).max(2_048),
  nextCursor: z.string().min(1).max(2_048),
  gap: z.object({
    reason: sessionEventGapReasonSchema,
    requestedSequence: eventSequenceSchema.nullable(),
    retainedFromSequence: eventSequenceSchema,
  }).strict().nullable(),
  events: z.array(sessionEventSchema).max(SESSION_EVENT_PAGE_LIMIT),
}).strict();

export type SessionEventPage = z.infer<typeof sessionEventPageSchema>;
