import { z } from "zod";

import {
  MESSAGE_MAX_BYTES,
  boundedText,
  positiveRevisionSchema,
  queueIdSchema,
  sessionIdSchema,
  sessionTaskIdSchema,
  unixMillisecondsSchema,
  type SessionId,
  type SessionTaskId,
} from "./values";

export const SESSION_TASK_MIN_INTERVAL_MINUTES = 15;
export const SESSION_TASK_MAX_INTERVAL_MINUTES = 10_080;
export const SESSION_TASK_LIMIT = 32;
export const SESSION_TASK_NAME_MAX_BYTES = 160;
export const SESSION_CONVERSATION_AUTOMATION_CAPABILITY =
  "hra.automation_update.v1" as const;

export const sessionTaskNameSchema = boundedText(
  "Scheduled task name",
  SESSION_TASK_NAME_MAX_BYTES,
);
export const sessionTaskPromptSchema = boundedText(
  "Scheduled task prompt",
  MESSAGE_MAX_BYTES,
);
export const sessionTaskIntervalMinutesSchema = z.number().int().safe().min(
  SESSION_TASK_MIN_INTERVAL_MINUTES,
).max(SESSION_TASK_MAX_INTERVAL_MINUTES);
export const sessionTaskStatusSchema = z.enum(["active", "paused"]);
export const sessionTaskScheduleSchema = z.object({
  kind: z.literal("interval_minutes"),
  minutes: sessionTaskIntervalMinutesSchema,
}).strict();

const sessionTaskSummaryBaseSchema = z.object({
  scope: z.literal("conversation"),
  id: sessionTaskIdSchema,
  sessionId: sessionIdSchema,
  name: sessionTaskNameSchema,
  status: sessionTaskStatusSchema,
  schedule: sessionTaskScheduleSchema,
  revision: positiveRevisionSchema,
  nextDueAt: unixMillisecondsSchema.nullable(),
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
}).strict();

const assertScheduleState = (
  value: Readonly<{ status: "active" | "paused"; nextDueAt: number | null }>,
  context: z.RefinementCtx,
): void => {
  if (value.status === "active" && value.nextDueAt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An active scheduled task must have a next due time.",
      path: ["nextDueAt"],
    });
  }
  if (value.status === "paused" && value.nextDueAt !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A paused scheduled task must not have a next due time.",
      path: ["nextDueAt"],
    });
  }
};

export const sessionTaskSummarySchema = sessionTaskSummaryBaseSchema.superRefine(
  assertScheduleState,
);
export const sessionTaskRecordSchema = sessionTaskSummaryBaseSchema.extend({
  prompt: sessionTaskPromptSchema,
}).superRefine(assertScheduleState);
export const sessionTaskPatchSchema = z.object({
  name: sessionTaskNameSchema.optional(),
  prompt: sessionTaskPromptSchema.optional(),
  minutes: sessionTaskIntervalMinutesSchema.optional(),
  status: sessionTaskStatusSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "A scheduled task edit must contain at least one field.",
});

export const sessionTaskListSchema = z.object({
  scope: z.literal("conversation"),
  sessionId: sessionIdSchema,
  tasks: z.array(sessionTaskSummarySchema).max(SESSION_TASK_LIMIT),
}).strict();

export const sessionTaskDeleteResultSchema = z.object({
  scope: z.literal("conversation"),
  sessionId: sessionIdSchema,
  taskId: sessionTaskIdSchema,
  deleted: z.literal(true),
  revision: positiveRevisionSchema,
  deletedAt: unixMillisecondsSchema,
}).strict();

export const sessionTaskOccurrenceSchema = z.object({
  sessionId: sessionIdSchema,
  taskId: sessionTaskIdSchema,
  taskRevision: positiveRevisionSchema,
  scheduledFor: unixMillisecondsSchema,
  coalescedIntervals: z.number().int().safe().nonnegative(),
  queueId: queueIdSchema,
  createdAt: unixMillisecondsSchema,
}).strict();

export type SessionTaskStatus = z.infer<typeof sessionTaskStatusSchema>;
export type SessionTaskSchedule = z.infer<typeof sessionTaskScheduleSchema>;
export type SessionTaskSummary = z.infer<typeof sessionTaskSummarySchema>;
export type SessionTaskRecord = z.infer<typeof sessionTaskRecordSchema>;
export type SessionTaskPatch = z.infer<typeof sessionTaskPatchSchema>;
export type SessionTaskList = z.infer<typeof sessionTaskListSchema>;
export type SessionTaskDeleteResult = z.infer<typeof sessionTaskDeleteResultSchema>;
export type SessionTaskOccurrence = z.infer<typeof sessionTaskOccurrenceSchema>;

export const summarizeSessionTask = (
  task: SessionTaskRecord,
): SessionTaskSummary => sessionTaskSummarySchema.parse({
  scope: task.scope,
  id: task.id,
  sessionId: task.sessionId,
  name: task.name,
  status: task.status,
  schedule: task.schedule,
  revision: task.revision,
  nextDueAt: task.nextDueAt,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

export type SessionTaskAuthority = Readonly<{
  sessionId: SessionId;
  taskId: SessionTaskId;
}>;
