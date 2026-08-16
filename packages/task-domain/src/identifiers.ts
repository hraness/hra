import { z } from "@hra-internal/schema";

const CROCKFORD_LOCATOR = "[0-9A-HJKMNP-TV-Z]{26}";

const publicId = <Prefix extends string>(prefix: Prefix) =>
  z.string().regex(
    new RegExp(`^${prefix}_${CROCKFORD_LOCATOR}$`, "u"),
    `invalid ${prefix} public ID`,
  );

export const epochMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const generationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positiveGenerationSchema = generationSchema.min(1);
export const revisionSchema = positiveGenerationSchema;
export const workspaceEventSequenceSchema = positiveGenerationSchema;

export const agentIdSchema = z.string().min(1).max(128);

export const workspacePublicIdSchema = publicId("wsp");
export const taskPublicIdSchema = publicId("tsk");
export const repositoryIdSchema = publicId("repo");
export const taskReferenceIdSchema = publicId("ref");
export const taskCommentIdSchema = publicId("cmt");
export const taskSubmissionIdSchema = publicId("sub");
export const operationIdSchema = publicId("op");
export const operationReceiptIdSchema = publicId("receipt");
export const workspaceEventIdSchema = publicId("wevt");
export const promotionIdSchema = publicId("promotion");
export const promotionBatchIdSchema = publicId("batch");
export const importedRunSummaryIdSchema = publicId("irun");

const opaqueDispatchId = (prefix: string) => z
  .string()
  .min(12)
  .max(128)
  .regex(new RegExp(`^${prefix}_[a-z0-9_-]+$`, "u"));

export const runnerIdSchema = opaqueDispatchId("runner");
export const runnerInstallationIdSchema = opaqueDispatchId("install");
export const runnerBootIdSchema = opaqueDispatchId("boot");
export const dispatchIdSchema = opaqueDispatchId("run");
export const dispatchClaimIdSchema = opaqueDispatchId("claim");
export const dispatchEventIdSchema = opaqueDispatchId("event");
export const runInteractionIdSchema = opaqueDispatchId("interaction");
export const runInteractionQuestionIdSchema = opaqueDispatchId("question");
export const runInteractionOptionIdSchema = opaqueDispatchId("option");

export const taskKeyPrefixSchema = z
  .string()
  .min(2)
  .max(8)
  .regex(/^[A-Z][A-Z0-9]{1,7}$/u, "invalid task key prefix");

export const taskKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,7}-[0-9A-HJKMNP-TV-Z]{7}$/u, "invalid task key");

export type WorkspacePublicId = z.infer<typeof workspacePublicIdSchema>;
export type TaskPublicId = z.infer<typeof taskPublicIdSchema>;
export type RepositoryId = z.infer<typeof repositoryIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type OperationReceiptId = z.infer<typeof operationReceiptIdSchema>;
export type WorkspaceEventId = z.infer<typeof workspaceEventIdSchema>;
export type TaskKey = z.infer<typeof taskKeySchema>;
