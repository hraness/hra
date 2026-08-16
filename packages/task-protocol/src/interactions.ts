import {
  MAX_PORTABLE_RUN_INTERACTION_OPTIONS,
  MAX_PORTABLE_RUN_INTERACTION_OTHER_TEXT_CODE_UNITS,
  MAX_PORTABLE_RUN_INTERACTION_QUESTIONS,
  MAX_PORTABLE_RUN_INTERACTION_TTL_MS,
  portableFileChangeApprovalRunInteractionRequestSchema,
  portableFileChangeApprovalRunInteractionResponseSchema,
  portableRunInteractionOptionSchema,
  portableRunInteractionQuestionSchema,
  portableRunInteractionRequestSchema,
  portableRunInteractionResponseSchema,
  runInteractionProjectionLifecycleValid,
  portableUserInputRunInteractionAnswerSchema,
  portableUserInputRunInteractionRequestSchema,
  portableUserInputRunInteractionResponseSchema,
  runInteractionIdSchema,
  validatePortableRunInteractionResponse,
  type PortableRunInteractionResponseValidation,
} from "@hraness/agent-tasks-domain";
import { z } from "@hra-internal/schema";

import { successEnvelopeSchema } from "./errors";
import {
  dispatchClaimIdSchema,
  dispatchIdSchema,
  runnerBootIdSchema,
  runnerIdSchema,
} from "./dispatch-identifiers";
import {
  MAX_TASK_HUMAN_INPUT_PENDING_COUNT,
  epochMsSchema,
  positiveGenerationSchema,
} from "./model";

export const MAX_RUN_INTERACTION_UPSERTS = 8;
export const MAX_RUN_INTERACTION_SETTLEMENTS = 8;
export const MAX_RUN_INTERACTION_RESPONSES = 8;
export const MAX_RUN_INTERACTION_QUESTIONS =
  MAX_PORTABLE_RUN_INTERACTION_QUESTIONS;
export const MAX_RUN_INTERACTION_OPTIONS =
  MAX_PORTABLE_RUN_INTERACTION_OPTIONS;
export const MAX_RUN_INTERACTION_VIEWS = MAX_TASK_HUMAN_INPUT_PENDING_COUNT;
export const MAX_RUN_INTERACTION_TTL_MS =
  MAX_PORTABLE_RUN_INTERACTION_TTL_MS;
export const MAX_RUN_INTERACTION_ID_CHARACTERS = 128;
export const MAX_RUN_INTERACTION_OTHER_TEXT_CODE_UNITS =
  MAX_PORTABLE_RUN_INTERACTION_OTHER_TEXT_CODE_UNITS;
export const RUN_INTERACTION_RESPONSE_LENGTH_BYTES = 4;

const MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT = 6;
const MAX_USER_INPUT_RESPONSE_JSON_FRAMING_BYTES = 36;
const MAX_USER_INPUT_ANSWER_JSON_FRAMING_BYTES = 78;
const RUN_INTERACTION_RESPONSE_PADDING_BLOCK_BYTES = 4 * 1_024;

/**
 * Exact upper bound for the UTF-8 JSON produced by every schema-valid response.
 *
 * The two framing constants cover the fixed JSON syntax for three answers and
 * eight selected option IDs. IDs are ASCII; arbitrary answer text can require
 * six JSON bytes per UTF-16 code unit for controls or lone surrogates.
 */
export const MAX_RUN_INTERACTION_RESPONSE_JSON_BYTES =
  MAX_USER_INPUT_RESPONSE_JSON_FRAMING_BYTES +
  MAX_RUN_INTERACTION_QUESTIONS * (
    MAX_USER_INPUT_ANSWER_JSON_FRAMING_BYTES +
    (MAX_RUN_INTERACTION_OPTIONS + 1) * MAX_RUN_INTERACTION_ID_CHARACTERS +
    MAX_RUN_INTERACTION_OTHER_TEXT_CODE_UNITS * MAX_JSON_ESCAPED_BYTES_PER_UTF16_CODE_UNIT
  );

export const RUN_INTERACTION_RESPONSE_PADDED_BYTES = Math.ceil(
  (RUN_INTERACTION_RESPONSE_LENGTH_BYTES + MAX_RUN_INTERACTION_RESPONSE_JSON_BYTES) /
    RUN_INTERACTION_RESPONSE_PADDING_BLOCK_BYTES,
) * RUN_INTERACTION_RESPONSE_PADDING_BLOCK_BYTES;
export const RUN_INTERACTION_SEALED_CIPHERTEXT_BYTES =
  RUN_INTERACTION_RESPONSE_PADDED_BYTES + 16;
export const RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS = Math.ceil(
  RUN_INTERACTION_SEALED_CIPHERTEXT_BYTES * 4 / 3,
);

export const MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_REQUEST_BYTES = 1_024 * 1_024;
export const MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_ENVELOPE_BYTES = 512 * 1_024;

export {
  MAX_RUN_INTERACTIONS_PER_RUN,
  runInteractionIdSchema,
  runInteractionOptionIdSchema,
  runInteractionQuestionIdSchema,
} from "@hraness/agent-tasks-domain";

export const runInteractionOptionSchema =
  portableRunInteractionOptionSchema;
export type RunInteractionOption = z.infer<typeof runInteractionOptionSchema>;

export const runInteractionQuestionSchema =
  portableRunInteractionQuestionSchema;
export type RunInteractionQuestion = z.infer<typeof runInteractionQuestionSchema>;

const runInteractionBaseShape = {
  id: runInteractionIdSchema,
  createdAt: epochMsSchema,
  expiresAt: epochMsSchema,
} as const;

export const runInteractionReplyKeyIdSchema = z
  .string()
  .min(24)
  .max(96)
  .regex(/^hitlkey_[a-f0-9]+$/u);
export const runInteractionRequestDigestSchema = z
  .string()
  .regex(/^sha256_[a-f0-9]{64}$/u);
export const runInteractionP256PublicKeySchema = z
  .string()
  .length(87)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const runInteractionReplyBindingSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("P256-HKDF-SHA256-A256GCM"),
  keyId: runInteractionReplyKeyIdSchema,
  publicKey: runInteractionP256PublicKeySchema,
  runnerId: runnerIdSchema,
  bootId: runnerBootIdSchema,
  bootGeneration: positiveGenerationSchema,
  claimId: dispatchClaimIdSchema,
  claimFence: positiveGenerationSchema,
  requestDigest: runInteractionRequestDigestSchema,
}).strict();
export type RunInteractionReplyBinding = z.infer<typeof runInteractionReplyBindingSchema>;

const interactionExpiryIssues = (
  request: Readonly<{ createdAt: number; expiresAt: number }>,
  context: z.RefinementCtx,
): void => {
  if (request.expiresAt <= request.createdAt) {
    context.addIssue({ code: "custom", message: "interaction expiry must follow creation", path: ["expiresAt"] });
  }
  if (request.expiresAt - request.createdAt > MAX_RUN_INTERACTION_TTL_MS) {
    context.addIssue({ code: "custom", message: "interaction lifetime exceeds the one-hour limit", path: ["expiresAt"] });
  }
};

const uniqueQuestionIssues = (
  request: Readonly<{ questions: readonly RunInteractionQuestion[] }>,
  context: z.RefinementCtx,
): void => {
  const questionIds = request.questions.map(({ id }) => id);
  if (new Set(questionIds).size !== questionIds.length) {
    context.addIssue({ code: "custom", message: "interaction question IDs must be unique", path: ["questions"] });
  }
};

export const userInputRunInteractionRequestPayloadSchema =
  portableUserInputRunInteractionRequestSchema;
export const fileChangeApprovalRunInteractionRequestPayloadSchema =
  portableFileChangeApprovalRunInteractionRequestSchema;
export const runInteractionRequestPayloadSchema =
  portableRunInteractionRequestSchema;
export type RunInteractionRequestPayload = z.infer<typeof runInteractionRequestPayloadSchema>;

export const userInputRunInteractionRequestSchema = z.object({
  ...runInteractionBaseShape,
  kind: z.literal("user_input"),
  questions: z.array(runInteractionQuestionSchema).min(1).max(MAX_RUN_INTERACTION_QUESTIONS),
  reply: runInteractionReplyBindingSchema,
}).strict().superRefine((request, context) => {
  interactionExpiryIssues(request, context);
  uniqueQuestionIssues(request, context);
});

export const fileChangeApprovalRunInteractionRequestSchema = z.object({
  ...runInteractionBaseShape,
  kind: z.literal("file_change_approval"),
  scope: z.literal("once"),
  reply: runInteractionReplyBindingSchema,
}).strict().superRefine(interactionExpiryIssues);

export const runInteractionRequestSchema = z.discriminatedUnion("kind", [
  userInputRunInteractionRequestSchema,
  fileChangeApprovalRunInteractionRequestSchema,
]);
export type RunInteractionRequest = z.infer<typeof runInteractionRequestSchema>;

export const userInputRunInteractionAnswerSchema =
  portableUserInputRunInteractionAnswerSchema;
export const userInputRunInteractionResponseSchema =
  portableUserInputRunInteractionResponseSchema;
export const fileChangeApprovalRunInteractionResponseSchema =
  portableFileChangeApprovalRunInteractionResponseSchema;
export const runInteractionResponseSchema =
  portableRunInteractionResponseSchema;
export type RunInteractionResponse = z.infer<typeof runInteractionResponseSchema>;

export const sealedRunInteractionResponseSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("P256-HKDF-SHA256-A256GCM"),
  keyId: runInteractionReplyKeyIdSchema,
  workspaceId: z.string().min(1).max(128),
  ephemeralPublicKey: runInteractionP256PublicKeySchema,
  nonce: z.string().length(16).regex(/^[A-Za-z0-9_-]+$/u),
  ciphertext: z
    .string()
    .length(RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS)
    .regex(/^[A-Za-z0-9_-]+$/u),
}).strict();
export type SealedRunInteractionResponse = z.infer<typeof sealedRunInteractionResponseSchema>;

export type RunInteractionResponseValidation =
  PortableRunInteractionResponseValidation;

/** Validates both the wire shape and the request-specific IDs without throwing. */
export const validateRunInteractionResponse = (
  request: RunInteractionRequest | RunInteractionRequestPayload,
  value: unknown,
): RunInteractionResponseValidation => {
  return validatePortableRunInteractionResponse(request, value);
};

export const runInteractionSettlementSchema = z.discriminatedUnion("outcome", [
  z.object({
    interactionId: runInteractionIdSchema,
    responseRevision: positiveGenerationSchema,
    outcome: z.literal("applied"),
  }).strict(),
  z.object({
    interactionId: runInteractionIdSchema,
    responseRevision: positiveGenerationSchema.optional(),
    outcome: z.literal("expired"),
    reason: z.enum(["local_deadline", "provider_expired", "cloud_expired"]),
  }).strict(),
]);
export type RunInteractionSettlement = z.infer<typeof runInteractionSettlementSchema>;

export const syncRunInteractionsRequestSchema = z.object({
  runnerId: runnerIdSchema,
  bootId: runnerBootIdSchema,
  bootGeneration: positiveGenerationSchema,
  claimId: dispatchClaimIdSchema,
  claimFence: positiveGenerationSchema,
  upserts: z.array(runInteractionRequestSchema).max(MAX_RUN_INTERACTION_UPSERTS),
  settlements: z.array(runInteractionSettlementSchema).max(MAX_RUN_INTERACTION_SETTLEMENTS),
}).strict().superRefine((request, context) => {
  const upsertIds = request.upserts.map(({ id }) => id);
  if (new Set(upsertIds).size !== upsertIds.length) {
    context.addIssue({ code: "custom", message: "interaction upsert IDs must be unique", path: ["upserts"] });
  }
  const settlementIds = request.settlements.map(({ interactionId }) => interactionId);
  if (new Set(settlementIds).size !== settlementIds.length) {
    context.addIssue({ code: "custom", message: "interaction settlement IDs must be unique", path: ["settlements"] });
  }
});
export type SyncRunInteractionsRequest = z.infer<typeof syncRunInteractionsRequestSchema>;

export const syncedRunInteractionResponseSchema = z.object({
  interactionId: runInteractionIdSchema,
  responseRevision: positiveGenerationSchema,
  sealedResponse: sealedRunInteractionResponseSchema,
}).strict();
export type SyncedRunInteractionResponse = z.infer<typeof syncedRunInteractionResponseSchema>;

export const expiredRunInteractionSchema = z.object({
  interactionId: runInteractionIdSchema,
  responseRevision: positiveGenerationSchema.optional(),
}).strict();
export type ExpiredRunInteraction = z.infer<typeof expiredRunInteractionSchema>;

export const syncRunInteractionsResponseSchema = z.object({
  serverTime: epochMsSchema,
  acceptedInteractionIds: z.array(runInteractionIdSchema).max(MAX_RUN_INTERACTION_UPSERTS),
  acceptedSettlementIds: z.array(runInteractionIdSchema).max(MAX_RUN_INTERACTION_SETTLEMENTS),
  responses: z.array(syncedRunInteractionResponseSchema).max(MAX_RUN_INTERACTION_RESPONSES),
  expiredInteractions: z.array(expiredRunInteractionSchema).max(MAX_RUN_INTERACTION_RESPONSES),
  hasMoreResponses: z.boolean(),
}).strict().superRefine((response, context) => {
  for (const [path, ids] of [
    ["acceptedInteractionIds", response.acceptedInteractionIds],
    ["acceptedSettlementIds", response.acceptedSettlementIds],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "accepted interaction IDs must be unique", path: [path] });
    }
  }
  const responseIds = response.responses.map(({ interactionId }) => interactionId);
  if (new Set(responseIds).size !== responseIds.length) {
    context.addIssue({ code: "custom", message: "synced interaction responses must be unique", path: ["responses"] });
  }
  const expiredIds = response.expiredInteractions.map(({ interactionId }) => interactionId);
  if (new Set(expiredIds).size !== expiredIds.length) {
    context.addIssue({ code: "custom", message: "expired interaction notices must be unique", path: ["expiredInteractions"] });
  }
  const expiredIdSet = new Set(expiredIds);
  if (responseIds.some((interactionId) => expiredIdSet.has(interactionId))) {
    context.addIssue({ code: "custom", message: "an interaction cannot be answered and expired", path: ["expiredInteractions"] });
  }
  const acceptedSettlementIds = new Set(response.acceptedSettlementIds);
  if (
    responseIds.some((interactionId) => acceptedSettlementIds.has(interactionId)) ||
    expiredIds.some((interactionId) => acceptedSettlementIds.has(interactionId))
  ) {
    context.addIssue({ code: "custom", message: "a settled interaction cannot remain deliverable", path: ["acceptedSettlementIds"] });
  }
  if (new Set(response.responses.map(({ sealedResponse }) => sealedResponse.workspaceId)).size > 1) {
    context.addIssue({ code: "custom", message: "interaction responses must share one workspace", path: ["responses"] });
  }
});
export const syncRunInteractionsEnvelopeSchema = successEnvelopeSchema(syncRunInteractionsResponseSchema);
export type SyncRunInteractionsResponse = z.infer<typeof syncRunInteractionsResponseSchema>;

export const runInteractionStateSchema = z.enum(["pending", "answered", "resolved", "expired"]);
export type RunInteractionState = z.infer<typeof runInteractionStateSchema>;

export const runInteractionViewSchema = z.object({
  runId: dispatchIdSchema,
  request: runInteractionRequestSchema,
  state: runInteractionStateSchema,
  responseRevision: positiveGenerationSchema.optional(),
  respondedAt: epochMsSchema.optional(),
  resolvedAt: epochMsSchema.optional(),
}).strict().refine(
  runInteractionProjectionLifecycleValid,
  "interaction projection lifecycle fields do not match its state",
);
export type RunInteractionView = z.infer<typeof runInteractionViewSchema>;
