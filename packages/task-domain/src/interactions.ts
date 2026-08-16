import { z } from "@hra-internal/schema";

import {
  epochMsSchema,
  positiveGenerationSchema,
  runInteractionIdSchema,
  runInteractionOptionIdSchema,
  runInteractionQuestionIdSchema,
} from "./identifiers";

export const MAX_PORTABLE_RUN_INTERACTION_QUESTIONS = 3;
export const MAX_PORTABLE_RUN_INTERACTION_OPTIONS = 8;
export const MAX_PORTABLE_RUN_INTERACTION_OTHER_TEXT_CODE_UNITS = 2_000;
export const MAX_PORTABLE_RUN_INTERACTION_TTL_MS = 60 * 60 * 1_000;

export const portableRunInteractionOptionSchema = z.object({
  id: runInteractionOptionIdSchema,
  label: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
}).strict();
export type PortableRunInteractionOption = z.infer<typeof portableRunInteractionOptionSchema>;

export const portableRunInteractionQuestionSchema = z.object({
  id: runInteractionQuestionIdSchema,
  header: z.string().min(1).max(64),
  prompt: z.string().min(1).max(1_024),
  allowOther: z.boolean(),
  options: z.array(portableRunInteractionOptionSchema).max(
    MAX_PORTABLE_RUN_INTERACTION_OPTIONS,
  ),
}).strict().superRefine((question, context) => {
  const optionIds = question.options.map(({ id }) => id);
  if (new Set(optionIds).size !== optionIds.length) {
    context.addIssue({
      code: "custom",
      message: "interaction option IDs must be unique",
      path: ["options"],
    });
  }
  if (question.options.length === 0 && !question.allowOther) {
    context.addIssue({
      code: "custom",
      message: "a free-form question must allow an other answer",
      path: ["allowOther"],
    });
  }
});
export type PortableRunInteractionQuestion = z.infer<
  typeof portableRunInteractionQuestionSchema
>;

const portableInteractionBase = {
  id: runInteractionIdSchema,
  createdAt: epochMsSchema,
  expiresAt: epochMsSchema,
} as const;

function interactionRequestIssues(
  request: Readonly<{ createdAt: number; expiresAt: number }>,
  context: z.RefinementCtx,
): void {
  if (request.expiresAt <= request.createdAt) {
    context.addIssue({
      code: "custom",
      message: "interaction expiry must follow creation",
      path: ["expiresAt"],
    });
  }
  if (
    request.expiresAt - request.createdAt >
      MAX_PORTABLE_RUN_INTERACTION_TTL_MS
  ) {
    context.addIssue({
      code: "custom",
      message: "interaction lifetime exceeds the one-hour limit",
      path: ["expiresAt"],
    });
  }
}

export const portableUserInputRunInteractionRequestSchema = z.object({
  ...portableInteractionBase,
  kind: z.literal("user_input"),
  questions: z.array(portableRunInteractionQuestionSchema)
    .min(1)
    .max(MAX_PORTABLE_RUN_INTERACTION_QUESTIONS),
}).strict().superRefine((request, context) => {
  interactionRequestIssues(request, context);
  const questionIds = request.questions.map(({ id }) => id);
  if (new Set(questionIds).size !== questionIds.length) {
    context.addIssue({
      code: "custom",
      message: "interaction question IDs must be unique",
      path: ["questions"],
    });
  }
});

export const portableFileChangeApprovalRunInteractionRequestSchema = z.object({
  ...portableInteractionBase,
  kind: z.literal("file_change_approval"),
  scope: z.literal("once"),
}).strict().superRefine(interactionRequestIssues);

export const portableRunInteractionRequestSchema = z.union([
  portableUserInputRunInteractionRequestSchema,
  portableFileChangeApprovalRunInteractionRequestSchema,
]);
export type PortableRunInteractionRequest = z.infer<
  typeof portableRunInteractionRequestSchema
>;

export const portableUserInputRunInteractionAnswerSchema = z.object({
  questionId: runInteractionQuestionIdSchema,
  selectedOptionIds: z.array(runInteractionOptionIdSchema).max(
    MAX_PORTABLE_RUN_INTERACTION_OPTIONS,
  ),
  otherText: z.string()
    .max(MAX_PORTABLE_RUN_INTERACTION_OTHER_TEXT_CODE_UNITS)
    .refine((value) => value.trim().length > 0, "other answer cannot be blank")
    .optional(),
}).strict().superRefine((answer, context) => {
  if (
    answer.selectedOptionIds.length === 0 &&
    answer.otherText === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "an interaction answer cannot be empty",
    });
  }
  if (
    new Set(answer.selectedOptionIds).size !==
      answer.selectedOptionIds.length
  ) {
    context.addIssue({
      code: "custom",
      message: "selected interaction options must be unique",
      path: ["selectedOptionIds"],
    });
  }
});

export const portableUserInputRunInteractionResponseSchema = z.object({
  kind: z.literal("user_input"),
  answers: z.array(portableUserInputRunInteractionAnswerSchema)
    .min(1)
    .max(MAX_PORTABLE_RUN_INTERACTION_QUESTIONS),
}).strict().superRefine((response, context) => {
  const questionIds = response.answers.map(({ questionId }) => questionId);
  if (new Set(questionIds).size !== questionIds.length) {
    context.addIssue({
      code: "custom",
      message: "interaction answers must address unique questions",
      path: ["answers"],
    });
  }
});

export const portableFileChangeApprovalRunInteractionResponseSchema = z.object({
  kind: z.literal("file_change_approval"),
  decision: z.enum(["approve_once", "decline", "cancel"]),
}).strict();

export const portableRunInteractionResponseSchema = z.discriminatedUnion("kind", [
  portableUserInputRunInteractionResponseSchema,
  portableFileChangeApprovalRunInteractionResponseSchema,
]);
export type PortableRunInteractionResponse = z.infer<
  typeof portableRunInteractionResponseSchema
>;

export type PortableRunInteractionResponseValidation =
  | { readonly success: true; readonly data: PortableRunInteractionResponse }
  | {
    readonly success: false;
    readonly reason:
      | "invalid_shape"
      | "kind_mismatch"
      | "question_mismatch"
      | "option_mismatch"
      | "other_not_allowed";
  };

/**
 * Validates both the portable response shape and every request-scoped ID.
 * Local and cloud authorities use this same law before accepting an answer.
 */
export function validatePortableRunInteractionResponse(
  request: PortableRunInteractionRequest,
  value: unknown,
): PortableRunInteractionResponseValidation {
  const parsed = portableRunInteractionResponseSchema.safeParse(value);
  if (!parsed.success) return { success: false, reason: "invalid_shape" };
  const response = parsed.data;
  if (response.kind !== request.kind) {
    return { success: false, reason: "kind_mismatch" };
  }
  if (request.kind === "file_change_approval") {
    return { success: true, data: response };
  }
  if (
    response.kind !== "user_input" ||
    response.answers.length !== request.questions.length
  ) {
    return { success: false, reason: "question_mismatch" };
  }
  const questionsById = new Map(
    request.questions.map((question) => [question.id, question] as const),
  );
  for (const answer of response.answers) {
    const question = questionsById.get(answer.questionId);
    if (question === undefined) {
      return { success: false, reason: "question_mismatch" };
    }
    const optionIds = new Set(question.options.map(({ id }) => id));
    if (answer.selectedOptionIds.some((id) => !optionIds.has(id))) {
      return { success: false, reason: "option_mismatch" };
    }
    if (answer.otherText !== undefined && !question.allowOther) {
      return { success: false, reason: "other_not_allowed" };
    }
  }
  return { success: true, data: response };
}

/**
 * A local settlement records only the state transition it performs. Expiry has
 * no response to apply, so carrying a response revision would be contradictory.
 */
export const portableRunInteractionSettlementSchema = z.discriminatedUnion("outcome", [
  z.object({
    interactionId: runInteractionIdSchema,
    responseRevision: positiveGenerationSchema,
    outcome: z.literal("applied"),
  }).strict(),
  z.object({
    interactionId: runInteractionIdSchema,
    outcome: z.literal("expired"),
    reason: z.enum(["local_deadline", "provider_expired"]),
  }).strict(),
]);
export type PortableRunInteractionSettlement = z.infer<
  typeof portableRunInteractionSettlementSchema
>;
