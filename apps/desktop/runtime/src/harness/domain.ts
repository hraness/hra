import { z } from "@hra-internal/schema";

export const HARNESS_MAX_RECURSION_DEPTH = 3;
export const HARNESS_MAX_ACTIVE_DESCENDANTS = 8;
export const HARNESS_MAX_DURABLE_DESCENDANTS = 50;
export const HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES = 1024 * 1024;
export const HARNESS_MAX_COMPLETED_PREFIX_ITEMS = 16_384;
export const HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES = 1024 * 1024;
export const HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES = 16 * 1024 * 1024;
export const HARNESS_MAX_COMPLETED_PREFIX_CONTAINER_UTF8_BYTES = 18 * 1024 * 1024;
export const HARNESS_DEFAULT_HEAP_UTF8_BYTES = 16 * 1024 * 1024;
export const HARNESS_MAX_HEAP_UTF8_BYTES = 64 * 1024 * 1024;
export const HARNESS_MAX_MESSAGE_UTF8_BYTES = 128 * 1024;
export const HARNESS_MAX_PROGRAM_BRANCHES = 8;
export const HARNESS_MAX_PROGRAM_ITERATIONS = 32;

const canonicalTimestampSchema = z.string()
  .length(24)
  .datetime()
  .refine((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value;
  });

const opaqueId = (prefix: string) => z.string()
  .min(prefix.length + 9)
  .max(96)
  .regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u"));

export const contextSnapshotIdSchema = opaqueId("ctxsnap");
export const contextValueIdSchema = opaqueId("ctxval");
export const programRunIdSchema = opaqueId("rlmrun");
export const programOperationIdSchema = opaqueId("rlmop");
export const ownedThreadIdSchema = opaqueId("thread");

export const recursiveBudgetSchema = z.object({
  depthRemaining: z.number().int().min(0).max(HARNESS_MAX_RECURSION_DEPTH),
  activeDescendantLimit: z.number().int().min(1).max(HARNESS_MAX_ACTIVE_DESCENDANTS),
  durableDescendantLimit: z.number().int().min(1).max(HARNESS_MAX_DURABLE_DESCENDANTS),
  tokenBudget: z.number().int().positive().safe(),
  deadline: canonicalTimestampSchema,
  heapByteLimit: z.number().int().positive().max(HARNESS_MAX_HEAP_UTF8_BYTES),
  contextValueByteLimit: z.number().int().positive().max(HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES),
  messageByteLimit: z.number().int().positive().max(HARNESS_MAX_MESSAGE_UTF8_BYTES),
  laneAuthority: z.enum(["readOnly", "managedWrite"]),
}).strict().superRefine((budget, context) => {
  if (budget.activeDescendantLimit > budget.durableDescendantLimit) {
    context.addIssue({
      code: "custom",
      message: "active descendant capacity cannot exceed durable capacity",
      path: ["activeDescendantLimit"],
    });
  }
  if (budget.contextValueByteLimit > budget.heapByteLimit) {
    context.addIssue({
      code: "custom",
      message: "one context value cannot exceed the heap",
      path: ["contextValueByteLimit"],
    });
  }
});

export type RecursiveBudget = z.infer<typeof recursiveBudgetSchema>;
