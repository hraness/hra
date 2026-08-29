import { randomUUID } from "node:crypto";

import { z } from "zod";

import { isUuidV7 } from "../cloud/contracts";
import { publicProviderIdentifierSchema } from "../public-provider-identifier";
import { presetSchema } from "./presets";
import { workReadSuccessWireBytes } from "./terminal-json";
import {
  attemptIdSchema,
  positiveRevisionSchema,
  profileIdSchema,
  projectIdSchema,
  queueIdSchema,
  sessionIdSchema,
  MESSAGE_MAX_BYTES,
  unixMillisecondsSchema,
  utf8Bytes,
} from "./values";

export const WORK_PROTOCOL = "hra-work-local-v1" as const;
export const WORK_PROTOCOL_VERSION = 1 as const;

export const WORK_PLAN_TASK_LIMIT = 256;
export const WORK_ACTIVE_LIMIT = 1_024;
export const WORK_RETAINED_LIMIT = 8_192;
export const WORK_TOMBSTONE_LIMIT = 65_536;
export const WORK_TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
export const WORK_TOMBSTONE_MAX_BYTES = 64 * 1024 * 1024;
export const WORK_MEMBER_LIMIT = 256;
export const WORK_ROUTE_LIMIT = 64;
export const WORK_HISTORY_EVENT_LIMIT = 65_536;
export const WORK_HISTORY_RECOVERY_RESERVE = 1_024;
export const WORK_OPERATION_BATCH_LIMIT = 32;
export const WORK_TASK_DEPENDENCY_LIMIT = 16;
export const WORK_TASK_DEPTH_LIMIT = 8;
export const WORK_CRITERIA_LIMIT = 16;
export const WORK_CRITERIA_MAX_BYTES = 32 * 1024;
export const WORK_EVIDENCE_LIMIT = 16;
export const WORK_INLINE_RESULT_MAX_BYTES = 64 * 1024;
export const WORK_ARTIFACT_PATH_MAX_BYTES = 1_024;
export const WORK_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const WORK_OPERATION_MAX_BYTES = 2 * 1024 * 1024;
export const WORK_PROTOCOL_REQUEST_MAX_BYTES = WORK_OPERATION_MAX_BYTES + 4 * 1024;
export const WORK_PREPARED_EFFECT_MAX_BYTES = 2 * 1024 * 1024;
export const WORK_WORKER_BRIEF_MAX_BYTES = MESSAGE_MAX_BYTES;
export const WORK_DEPENDENCY_PREVIEW_MAX_BYTES = 256;
export const WORK_SIGNAL_MAX_BYTES = 16 * 1024;
export const WORK_EVENT_MAX_BYTES = 64 * 1024;
export const WORK_EVENT_PAGE_LIMIT = 200;
export const WORK_POLL_ITEM_LIMIT = 50;
export const WORK_READ_HISTORY_LIMIT = 16;
export const WORK_POLL_MAX_BYTES = 256 * 1024;
export const WORK_EVENT_PAGE_MAX_BYTES = 512 * 1024;
export const WORK_EVENT_STREAM_LINE_MAX_BYTES = 512 * 1024;
export const WORK_STREAM_FAILURE_MAX_BYTES = 64 * 1024;
export const WORK_SNAPSHOT_MAX_BYTES = 512 * 1024;
export const WORK_TASK_DETAIL_MAX_BYTES = 512 * 1024;
export const WORK_TASK_HISTORY_PAGE_MAX_BYTES = 512 * 1024;
export const WORK_TASK_HISTORY_ITEM_LIMIT = 50;
export const WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT = 20;
export const WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT = WORK_HISTORY_EVENT_LIMIT
  + WORK_OPERATION_BATCH_LIMIT;
export const WORK_TASK_HISTORY_MEMBERSHIP_LIMIT = WORK_HISTORY_EVENT_LIMIT
  + WORK_PLAN_TASK_LIMIT * WORK_OPERATION_BATCH_LIMIT;
export const WORK_TASK_HISTORY_VERSION_LIMIT = WORK_HISTORY_EVENT_LIMIT * 3
  + WORK_PLAN_TASK_LIMIT;
export const WORK_EFFECT_RESOLUTION_LIMIT = WORK_HISTORY_EVENT_LIMIT * 2;
export const WORK_EVENT_CURSOR_MAX_BYTES = 2_048;
export const WORK_WAIT_MAX_MS = 30_000;
export const WORK_WAITER_LIMIT = 256;
export const WORK_LEASE_MIN_MS = 5_000;
export const WORK_LEASE_MAX_MS = 5 * 60_000;
export const WORK_JSON_DEPTH_LIMIT = 8;
export const WORK_JSON_NODE_LIMIT = 4_096;
export const WORK_JSON_KEY_MAX_BYTES = 256;

const objectiveMaxBytes = 8 * 1024;
const instructionsMaxBytes = 16 * 1024;
const criterionMaxBytes = 2 * 1024;
const summaryMaxBytes = 8 * 1024;
const clientRefMaxBytes = 128;
const cursorSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revisionSchema = positiveRevisionSchema.max(Number.MAX_SAFE_INTEGER);
const fenceSchema = positiveRevisionSchema.max(Number.MAX_SAFE_INTEGER);
const streamEpochSchema = z.string().uuid();
const idempotencyKeySchema = z.string().refine(isUuidV7, {
  message: "Idempotency key must be a canonical UUIDv7.",
});
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const workCapabilitySchema = z.string()
  .regex(/^hrac1_[A-Za-z0-9_-]{43}$/u)
  .refine((value) => {
    const encoded = value.slice("hrac1_".length);
    const decoded = Buffer.from(encoded, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === encoded;
  }, "Work capabilities must contain one canonical base64url 256-bit value.");
export type WorkCapability = z.infer<typeof workCapabilitySchema>;
const gitCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const artifactPathSchema = z.string()
  .min(1)
  .refine((value) => utf8Bytes(value) <= WORK_ARTIFACT_PATH_MAX_BYTES, {
    message: `Artifact paths must be at most ${WORK_ARTIFACT_PATH_MAX_BYTES} UTF-8 bytes.`,
  })
  .refine((value) => {
    if (value.startsWith("/") || value.includes("\\") || /\p{Cc}/u.test(value)) return false;
    const segments = value.split("/");
    return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
  }, "Artifact paths must be canonical workspace-relative POSIX paths.");
const boundedUtf8Text = (name: string, maximumBytes: number) => z.string()
  .min(1, `${name} must not be empty.`)
  .refine((value) => utf8Bytes(value) <= maximumBytes, {
    message: `${name} must be at most ${maximumBytes} UTF-8 bytes.`,
  });

const workIdPattern = /^work_[0-9a-f]{32}$/u;
const workTaskIdPattern = /^task_[0-9a-f]{32}$/u;
const workAttemptIdPattern = /^watt_[0-9a-f]{32}$/u;
const workSubmissionIdPattern = /^sub_[0-9a-f]{32}$/u;
const workReviewIdPattern = /^review_[0-9a-f]{32}$/u;
const workSignalIdPattern = /^sig_[0-9a-f]{32}$/u;

export const workIdSchema = z.string().regex(workIdPattern);
export const workTaskIdSchema = z.string().regex(workTaskIdPattern);
export const workAttemptIdSchema = z.string().regex(workAttemptIdPattern);
export const workSubmissionIdSchema = z.string().regex(workSubmissionIdPattern);
export const workReviewIdSchema = z.string().regex(workReviewIdPattern);
export const workSignalIdSchema = z.string().regex(workSignalIdPattern);

export type WorkId = z.infer<typeof workIdSchema>;
export type WorkTaskId = z.infer<typeof workTaskIdSchema>;
export type WorkAttemptId = z.infer<typeof workAttemptIdSchema>;
export type WorkSubmissionId = z.infer<typeof workSubmissionIdSchema>;
export type WorkReviewId = z.infer<typeof workReviewIdSchema>;
export type WorkSignalId = z.infer<typeof workSignalIdSchema>;

const createWorkPrefixedId = <Prefix extends string>(prefix: Prefix): `${Prefix}_${string}` =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;

export const createWorkId = (): WorkId => workIdSchema.parse(createWorkPrefixedId("work"));
export const createWorkTaskId = (): WorkTaskId =>
  workTaskIdSchema.parse(createWorkPrefixedId("task"));
export const createWorkAttemptId = (): WorkAttemptId =>
  workAttemptIdSchema.parse(createWorkPrefixedId("watt"));
export const createWorkSubmissionId = (): WorkSubmissionId =>
  workSubmissionIdSchema.parse(createWorkPrefixedId("sub"));
export const createWorkReviewId = (): WorkReviewId =>
  workReviewIdSchema.parse(createWorkPrefixedId("review"));
export const createWorkSignalId = (): WorkSignalId =>
  workSignalIdSchema.parse(createWorkPrefixedId("sig"));

export const workClientRefSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => utf8Bytes(value) <= clientRefMaxBytes, {
    message: `Client reference must be at most ${clientRefMaxBytes} UTF-8 bytes.`,
  });
export type WorkClientRef = z.infer<typeof workClientRefSchema>;

export const workRouteSchema = z.object({
  accountId: profileIdSchema,
  projectId: projectIdSchema,
}).strict();
export type WorkRoute = z.infer<typeof workRouteSchema>;

export const workExecutionRouteSchema = z.object({
  accountId: profileIdSchema,
  projectId: projectIdSchema,
  preset: presetSchema,
  fast: z.boolean(),
}).strict();
export type WorkExecutionRoute = z.infer<typeof workExecutionRouteSchema>;

export const workExecutionRoutesSchema = z.array(workExecutionRouteSchema)
  .min(1)
  .max(WORK_ROUTE_LIMIT)
  .refine(hasNoDuplicateJsonValues, "Declared execution routes must be unique.");

export type WorkJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly WorkJsonValue[]
  | { readonly [key: string]: WorkJsonValue };

type JsonCandidate = Readonly<{
  value: unknown;
  depth: number;
}>;

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Validate an inline result without recursing on the JavaScript stack. */
const validateBoundedWorkJsonValue = (root: unknown): root is WorkJsonValue => {
  const seen = new WeakSet<object>();
  const stack: JsonCandidate[] = [{ value: root, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const candidate = stack.pop();
    if (candidate === undefined) return false;
    nodes += 1;
    if (nodes > WORK_JSON_NODE_LIMIT) return false;

    const { value, depth } = candidate;
    if (
      value === null
      || typeof value === "string"
      || typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);

    const containerDepth = depth + 1;
    if (containerDepth > WORK_JSON_DEPTH_LIMIT) return false;
    if (Array.isArray(value)) {
      if (value.length > WORK_JSON_NODE_LIMIT) return false;
      const arrayKeys = Reflect.ownKeys(value);
      if (
        arrayKeys.length !== value.length + 1
        || arrayKeys.some((key) => {
          if (key === "length") return false;
          return typeof key !== "string"
            || !Number.isSafeInteger(Number(key))
            || Number(key) < 0
            || Number(key) >= value.length
            || String(Number(key)) !== key;
        })
      ) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined
          || !("value" in descriptor)
          || !descriptor.enumerable
        ) {
          return false;
        }
        stack.push({ value: descriptor.value, depth: containerDepth });
      }
      continue;
    }
    if (!isPlainRecord(value)) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || !descriptor.enumerable
      ) {
        return false;
      }
      nodes += 1;
      if (nodes > WORK_JSON_NODE_LIMIT || utf8Bytes(key) > WORK_JSON_KEY_MAX_BYTES) {
        return false;
      }
      stack.push({ value: descriptor.value, depth: containerDepth });
    }
  }

  try {
    const encoded = JSON.stringify(root);
    return utf8Bytes(encoded) <= WORK_INLINE_RESULT_MAX_BYTES;
  } catch {
    return false;
  }
};

export const isBoundedWorkJsonValue = (root: unknown): root is WorkJsonValue => {
  try {
    return validateBoundedWorkJsonValue(root);
  } catch {
    return false;
  }
};

export const workJsonValueSchema = z.custom<WorkJsonValue>(isBoundedWorkJsonValue, {
  message: "JSON result exceeds its depth, node, key, type, cycle, or UTF-8 byte bound.",
});

export const workResultKindSchema = z.enum(["text", "json"]);
export type WorkResultKind = z.infer<typeof workResultKindSchema>;

export const workResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: boundedUtf8Text("Text result", WORK_INLINE_RESULT_MAX_BYTES),
  }).strict(),
  z.object({
    kind: z.literal("json"),
    value: workJsonValueSchema,
  }).strict(),
]);
export type WorkResult = z.infer<typeof workResultSchema>;

export const workEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    sessionId: sessionIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("turn"),
    sessionId: sessionIdSchema,
    turnId: publicProviderIdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("artifact"),
    projectId: projectIdSchema,
    path: artifactPathSchema,
    bytes: z.number().int().nonnegative().max(WORK_ARTIFACT_MAX_BYTES),
    sha256: sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal("git_commit"),
    projectId: projectIdSchema,
    commit: gitCommitSchema,
  }).strict(),
]);
export type WorkEvidence = z.infer<typeof workEvidenceSchema>;

function hasNoDuplicateJsonValues(values: readonly unknown[]): boolean {
  const keys = values.map((value) => JSON.stringify(value));
  return new Set(keys).size === keys.length;
}

export const workEvidenceListSchema = z.array(workEvidenceSchema)
  .max(WORK_EVIDENCE_LIMIT)
  .refine(hasNoDuplicateJsonValues, "Evidence references must be unique.");

export const workResultContractSchema = z.object({
  kind: workResultKindSchema,
  minEvidence: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  requiredReviews: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
}).strict();
export type WorkResultContract = z.infer<typeof workResultContractSchema>;

const objectiveSchema = boundedUtf8Text("Objective", objectiveMaxBytes);
const instructionsSchema = boundedUtf8Text("Instructions", instructionsMaxBytes);
const criterionSchema = boundedUtf8Text("Criterion", criterionMaxBytes);
const summarySchema = boundedUtf8Text("Summary", summaryMaxBytes);
const signalBodySchema = boundedUtf8Text("Signal body", WORK_SIGNAL_MAX_BYTES);

export const workTaskSpecSchema = z.object({
  clientRef: workClientRefSchema,
  parentRef: workClientRefSchema.optional(),
  parentTaskId: workTaskIdSchema.optional(),
  dependsOnRefs: z.array(workClientRefSchema)
    .max(WORK_TASK_DEPENDENCY_LIMIT),
  dependsOnTaskIds: z.array(workTaskIdSchema)
    .max(WORK_TASK_DEPENDENCY_LIMIT),
  objective: objectiveSchema,
  instructions: instructionsSchema,
  criteria: z.array(criterionSchema).max(WORK_CRITERIA_LIMIT),
  route: workRouteSchema,
  preset: presetSchema,
  fast: z.boolean(),
  priority: z.number().int().min(-100).max(100),
  notBefore: unixMillisecondsSchema.optional(),
  claimBy: unixMillisecondsSchema.optional(),
  deadline: unixMillisecondsSchema.optional(),
  maxAttempts: z.number().int().min(1).max(WORK_OPERATION_BATCH_LIMIT),
  requiredReviews: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  resultKind: workResultKindSchema,
  minEvidence: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
}).strict().superRefine((task, context) => {
  if (utf8Bytes(JSON.stringify(task.criteria)) > WORK_CRITERIA_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["criteria"],
      message: `Serialized criteria must be at most ${WORK_CRITERIA_MAX_BYTES} UTF-8 bytes.`,
    });
  }
  if (task.parentRef !== undefined && task.parentTaskId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["parentRef"],
      message: "A task may identify its parent by client reference or task ID, not both.",
    });
  }
  if (task.parentRef === task.clientRef) {
    context.addIssue({
      code: "custom",
      path: ["parentRef"],
      message: "A task cannot be its own parent.",
    });
  }
  if (task.dependsOnRefs.includes(task.clientRef)) {
    context.addIssue({
      code: "custom",
      path: ["dependsOnRefs"],
      message: "A task cannot depend on itself.",
    });
  }
  if (
    task.dependsOnRefs.length + task.dependsOnTaskIds.length
      > WORK_TASK_DEPENDENCY_LIMIT
  ) {
    context.addIssue({
      code: "custom",
      path: ["dependsOnRefs"],
      message: `A task may have at most ${WORK_TASK_DEPENDENCY_LIMIT} dependencies in total.`,
    });
  }
  if (new Set(task.dependsOnRefs).size !== task.dependsOnRefs.length) {
    context.addIssue({
      code: "custom",
      path: ["dependsOnRefs"],
      message: "Dependency client references must be unique.",
    });
  }
  if (new Set(task.dependsOnTaskIds).size !== task.dependsOnTaskIds.length) {
    context.addIssue({
      code: "custom",
      path: ["dependsOnTaskIds"],
      message: "Dependency task IDs must be unique.",
    });
  }
  if (new Set(task.criteria).size !== task.criteria.length) {
    context.addIssue({
      code: "custom",
      path: ["criteria"],
      message: "Acceptance criteria must be unique.",
    });
  }
  if (
    task.notBefore !== undefined
    && task.claimBy !== undefined
    && task.claimBy <= task.notBefore
  ) {
    context.addIssue({
      code: "custom",
      path: ["claimBy"],
      message: "A task claim-by time must be later than its not-before time.",
    });
  }
  if (
    task.notBefore !== undefined
    && task.deadline !== undefined
    && task.deadline <= task.notBefore
  ) {
    context.addIssue({
      code: "custom",
      path: ["deadline"],
      message: "A task deadline must be later than its not-before time.",
    });
  }
  if (
    task.claimBy !== undefined
    && task.deadline !== undefined
    && task.deadline < task.claimBy
  ) {
    context.addIssue({
      code: "custom",
      path: ["deadline"],
      message: "A task deadline cannot precede its claim-by time.",
    });
  }
});
export type WorkTaskSpec = z.infer<typeof workTaskSpecSchema>;

const addTaskBatchGraphIssues = (
  tasks: readonly WorkTaskSpec[],
  context: z.RefinementCtx,
  requireAllReferences: boolean,
): void => {
  const tasksByRef = new Map<WorkClientRef, { task: WorkTaskSpec; index: number }>();
  for (const [index, task] of tasks.entries()) {
    if (tasksByRef.has(task.clientRef)) {
      context.addIssue({
        code: "custom",
        path: [index, "clientRef"],
        message: "Task client references must be unique within one atomic batch.",
      });
    } else {
      tasksByRef.set(task.clientRef, { task, index });
    }
  }

  const localEdges = new Map<WorkClientRef, readonly WorkClientRef[]>();
  for (const [index, task] of tasks.entries()) {
    const references = [
      ...(task.parentRef === undefined ? [] : [task.parentRef]),
      ...task.dependsOnRefs,
    ];
    for (const reference of references) {
      if (requireAllReferences && !tasksByRef.has(reference)) {
        context.addIssue({
          code: "custom",
          path: [index, task.parentRef === reference ? "parentRef" : "dependsOnRefs"],
          message: "Client references in a new work plan must resolve inside its atomic batch.",
        });
      }
    }
    localEdges.set(
      task.clientRef,
      references.filter((reference) => tasksByRef.has(reference)),
    );
  }

  const visiting = new Set<WorkClientRef>();
  const depths = new Map<WorkClientRef, number>();
  let cycleReported = false;
  const depthOf = (reference: WorkClientRef): number => {
    const known = depths.get(reference);
    if (known !== undefined) return known;
    if (visiting.has(reference)) {
      if (!cycleReported) {
        context.addIssue({
          code: "custom",
          message: "Task parent and dependency references must form an acyclic graph.",
        });
        cycleReported = true;
      }
      return WORK_TASK_DEPTH_LIMIT + 1;
    }
    visiting.add(reference);
    let depth = 1;
    for (const dependency of localEdges.get(reference) ?? []) {
      depth = Math.max(depth, depthOf(dependency) + 1);
    }
    visiting.delete(reference);
    depths.set(reference, depth);
    return depth;
  };

  for (const [reference, entry] of tasksByRef.entries()) {
    if (depthOf(reference) > WORK_TASK_DEPTH_LIMIT) {
      context.addIssue({
        code: "custom",
        path: [entry.index, "dependsOnRefs"],
        message: `Task graphs may be at most ${WORK_TASK_DEPTH_LIMIT} levels deep.`,
      });
    }
  }
};

export const workTaskBatchSchema = z.array(workTaskSpecSchema)
  .min(1)
  .max(WORK_OPERATION_BATCH_LIMIT)
  .superRefine((tasks, context) => addTaskBatchGraphIssues(tasks, context, false));

const workCreateTaskBatchSchema = z.array(workTaskSpecSchema)
  .min(1)
  .max(WORK_OPERATION_BATCH_LIMIT)
  .superRefine((tasks, context) => addTaskBatchGraphIssues(tasks, context, true));

export const workAttemptReportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("checkpoint"),
    summary: summarySchema,
    evidence: workEvidenceListSchema,
  }).strict(),
  z.object({
    kind: z.literal("submit"),
    summary: summarySchema,
    result: workResultSchema,
    evidence: workEvidenceListSchema,
  }).strict(),
  z.object({
    kind: z.literal("blocked"),
    summary: summarySchema,
    retryAt: unixMillisecondsSchema.optional(),
    evidence: workEvidenceListSchema,
  }).strict(),
  z.object({
    kind: z.literal("failed"),
    summary: summarySchema,
    retryable: z.boolean(),
    evidence: workEvidenceListSchema,
  }).strict(),
  z.object({
    kind: z.literal("unknown"),
    summary: summarySchema,
    evidence: workEvidenceListSchema,
  }).strict(),
]);
export type WorkAttemptReport = z.infer<typeof workAttemptReportSchema>;

export const workSubmissionReviewInputSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("accept"),
    summary: summarySchema,
    evidence: workEvidenceListSchema,
  }).strict(),
  z.object({
    decision: z.literal("revise"),
    feedback: summarySchema,
    evidence: workEvidenceListSchema,
  }).strict(),
  z.object({
    decision: z.literal("reject"),
    summary: summarySchema,
    evidence: workEvidenceListSchema,
  }).strict(),
]);
export type WorkSubmissionReviewInput = z.infer<typeof workSubmissionReviewInputSchema>;

export const workAttemptReconcileOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    summary: summarySchema,
    result: workResultSchema,
    evidence: workEvidenceListSchema,
  }).strict(),
  z.object({
    kind: z.literal("failed"),
    summary: summarySchema,
    evidence: workEvidenceListSchema,
  }).strict(),
  z.object({
    kind: z.literal("no_effect"),
    summary: summarySchema,
    evidence: workEvidenceListSchema,
  }).strict(),
  z.object({
    kind: z.literal("still_unknown"),
    summary: summarySchema,
    evidence: workEvidenceListSchema,
  }).strict(),
]);
export type WorkAttemptReconcileOutcome = z.infer<
  typeof workAttemptReconcileOutcomeSchema
>;

const operationBaseShape = {
  idempotencyKey: idempotencyKeySchema,
};
const expectedWorkRevisionShape = {
  expectedWorkRevision: revisionSchema,
} as const;
const attemptAuthorityShape = {
  expectedAttemptRevision: revisionSchema,
  fence: fenceSchema,
  actorSessionId: sessionIdSchema,
  attemptCapability: workCapabilitySchema,
} as const;
const terminalWorkShape = {
  workId: workIdSchema,
  expectedWorkRevision: revisionSchema,
  actorSessionId: sessionIdSchema,
  coordinatorCapability: workCapabilitySchema,
  summary: summarySchema,
  evidence: workEvidenceListSchema,
} as const;

export const workCreateOperationSchema = z.object({
  ...operationBaseShape,
  kind: z.literal("work.create"),
  clientRef: workClientRefSchema,
  coordinatorSessionId: sessionIdSchema,
  objective: objectiveSchema,
  routes: workExecutionRoutesSchema,
  tasks: workCreateTaskBatchSchema,
}).strict().superRefine((operation, context) => {
  const routes = new Set(operation.routes.map((route) => JSON.stringify(route)));
  for (const [index, task] of operation.tasks.entries()) {
    const route = {
      ...task.route,
      preset: task.preset,
      fast: task.fast,
    };
    if (!routes.has(JSON.stringify(route))) {
      context.addIssue({
        code: "custom",
        path: ["tasks", index, "route"],
        message: "Every initial task must use one immutable declared execution route.",
      });
    }
  }
});

export const taskAddBatchOperationSchema = z.object({
  ...operationBaseShape,
  ...expectedWorkRevisionShape,
  kind: z.literal("task.addBatch"),
  workId: workIdSchema,
  coordinatorSessionId: sessionIdSchema,
  coordinatorCapability: workCapabilitySchema,
  tasks: workTaskBatchSchema,
}).strict();

export const workJoinOperationSchema = z.object({
  ...operationBaseShape,
  kind: z.literal("work.join"),
  workId: workIdSchema,
  coordinatorSessionId: sessionIdSchema,
  coordinatorCapability: workCapabilitySchema,
  actorSessionId: sessionIdSchema,
}).strict();

export const taskClaimOperationSchema = z.object({
  ...operationBaseShape,
  kind: z.literal("task.claim"),
  workId: workIdSchema,
  taskId: workTaskIdSchema,
  expectedTaskRevision: revisionSchema,
  actorSessionId: sessionIdSchema,
  actorCapability: workCapabilitySchema,
  leaseMs: z.number().int().min(WORK_LEASE_MIN_MS).max(WORK_LEASE_MAX_MS),
}).strict();

export const taskClaimNextOperationSchema = z.object({
  ...operationBaseShape,
  kind: z.literal("task.claimNext"),
  workId: workIdSchema,
  actorSessionId: sessionIdSchema,
  actorCapability: workCapabilitySchema,
  route: workRouteSchema,
  leaseMs: z.number().int().min(WORK_LEASE_MIN_MS).max(WORK_LEASE_MAX_MS),
}).strict();

export const workTaskClaimRequestSchema = z.object({
  taskId: workTaskIdSchema,
  expectedTaskRevision: revisionSchema,
  actorSessionId: sessionIdSchema,
  actorCapability: workCapabilitySchema,
  leaseMs: z.number().int().min(WORK_LEASE_MIN_MS).max(WORK_LEASE_MAX_MS),
}).strict();

export const taskClaimBatchOperationSchema = z.object({
  ...operationBaseShape,
  kind: z.literal("task.claimBatch"),
  workId: workIdSchema,
  claims: z.array(workTaskClaimRequestSchema)
    .min(1)
    .max(WORK_OPERATION_BATCH_LIMIT),
}).strict().superRefine((operation, context) => {
  const taskIds = operation.claims.map((claim) => claim.taskId);
  const actors = operation.claims.map((claim) => claim.actorSessionId);
  if (new Set(taskIds).size !== taskIds.length) {
    context.addIssue({
      code: "custom",
      path: ["claims"],
      message: "An atomic claim batch cannot repeat a task.",
    });
  }
  if (new Set(actors).size !== actors.length) {
    context.addIssue({
      code: "custom",
      path: ["claims"],
      message: "An atomic claim batch cannot assign two tasks to one session.",
    });
  }
});

export const attemptRenewOperationSchema = z.object({
  ...operationBaseShape,
  ...attemptAuthorityShape,
  kind: z.literal("attempt.renew"),
  workId: workIdSchema,
  attemptId: workAttemptIdSchema,
  leaseMs: z.number().int().min(WORK_LEASE_MIN_MS).max(WORK_LEASE_MAX_MS),
}).strict();

export const attemptReleaseOperationSchema = z.object({
  ...operationBaseShape,
  ...attemptAuthorityShape,
  kind: z.literal("attempt.release"),
  workId: workIdSchema,
  attemptId: workAttemptIdSchema,
  reason: summarySchema,
}).strict();

export const attemptDispatchOperationSchema = z.object({
  ...operationBaseShape,
  ...attemptAuthorityShape,
  kind: z.literal("attempt.dispatch"),
  workId: workIdSchema,
  attemptId: workAttemptIdSchema,
  targetSessionId: sessionIdSchema,
  mode: z.literal("send"),
}).strict();

export const attemptReportOperationSchema = z.object({
  ...operationBaseShape,
  ...attemptAuthorityShape,
  kind: z.literal("attempt.report"),
  workId: workIdSchema,
  attemptId: workAttemptIdSchema,
  report: workAttemptReportSchema,
}).strict();

export const submissionReviewOperationSchema = z.object({
  ...operationBaseShape,
  kind: z.literal("submission.review"),
  workId: workIdSchema,
  submissionId: workSubmissionIdSchema,
  expectedSubmissionRevision: revisionSchema,
  expectedContentDigest: sha256Schema,
  reviewerSessionId: sessionIdSchema,
  reviewerCapability: workCapabilitySchema,
  review: workSubmissionReviewInputSchema,
}).strict();

export const signalSendOperationSchema = z.object({
  ...operationBaseShape,
  kind: z.literal("signal.send"),
  workId: workIdSchema,
  senderSessionId: sessionIdSchema,
  senderCapability: workCapabilitySchema,
  targetSessionId: sessionIdSchema,
  taskId: workTaskIdSchema.optional(),
  replyToSignalId: workSignalIdSchema.optional(),
  mode: z.enum(["queue", "steer"]),
  body: signalBodySchema,
}).strict();

export const signalAckOperationSchema = z.object({
  ...operationBaseShape,
  kind: z.literal("signal.ack"),
  workId: workIdSchema,
  signalId: workSignalIdSchema,
  expectedSignalRevision: revisionSchema,
  actorSessionId: sessionIdSchema,
  actorCapability: workCapabilitySchema,
}).strict();

export const workCompleteOperationSchema = z.object({
  ...operationBaseShape,
  ...terminalWorkShape,
  kind: z.literal("work.complete"),
  result: workResultSchema.optional(),
}).strict();

export const workFailOperationSchema = z.object({
  ...operationBaseShape,
  ...terminalWorkShape,
  kind: z.literal("work.fail"),
}).strict();

export const workCancelOperationSchema = z.object({
  ...operationBaseShape,
  ...terminalWorkShape,
  kind: z.literal("work.cancel"),
}).strict();

export const workReleaseOperationSchema = z.object({
  ...operationBaseShape,
  ...expectedWorkRevisionShape,
  kind: z.literal("work.release"),
  workId: workIdSchema,
  actorSessionId: sessionIdSchema,
  coordinatorCapability: workCapabilitySchema,
  acknowledgeDataLoss: z.literal(true),
}).strict();

export const attemptReconcileOperationSchema = z.object({
  ...operationBaseShape,
  ...attemptAuthorityShape,
  kind: z.literal("attempt.reconcile"),
  workId: workIdSchema,
  attemptId: workAttemptIdSchema,
  outcome: workAttemptReconcileOutcomeSchema,
}).strict();

export const workOperationSchema = z.discriminatedUnion("kind", [
  workCreateOperationSchema,
  taskAddBatchOperationSchema,
  workJoinOperationSchema,
  taskClaimOperationSchema,
  taskClaimNextOperationSchema,
  taskClaimBatchOperationSchema,
  attemptRenewOperationSchema,
  attemptReleaseOperationSchema,
  attemptDispatchOperationSchema,
  attemptReportOperationSchema,
  submissionReviewOperationSchema,
  signalSendOperationSchema,
  signalAckOperationSchema,
  workCompleteOperationSchema,
  workFailOperationSchema,
  workCancelOperationSchema,
  workReleaseOperationSchema,
  attemptReconcileOperationSchema,
]).superRefine((operation, context) => {
  if (utf8Bytes(JSON.stringify(operation)) > WORK_OPERATION_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `A work operation must be at most ${WORK_OPERATION_MAX_BYTES} serialized UTF-8 bytes.`,
    });
  }
});
export type WorkOperation = z.infer<typeof workOperationSchema>;

export const workStatusSchema = z.enum([
  "open",
  "cancel_pending",
  "fail_pending",
  "completed",
  "failed",
  "cancelled",
]);
export const workTaskStatusSchema = z.enum([
  "waiting",
  "ready",
  "claimed",
  "dispatched",
  "submitted",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export const workAttemptStatusSchema = z.enum([
  "claimed",
  "dispatching",
  "active",
  "submitted",
  "blocked",
  "failed",
  "unknown",
  "released",
  "expired",
  "reconciled",
]);
export const workSubmissionStatusSchema = z.enum([
  "pending_review",
  "accepted",
  "revision_requested",
  "rejected",
]);
export const workSignalDeliveryStateSchema = z.enum([
  "pending",
  "accepted",
  "unknown",
  "failed",
]);

export type WorkStatus = z.infer<typeof workStatusSchema>;
export type WorkTaskStatus = z.infer<typeof workTaskStatusSchema>;
export type WorkAttemptStatus = z.infer<typeof workAttemptStatusSchema>;
export type WorkSubmissionStatus = z.infer<typeof workSubmissionStatusSchema>;
export type WorkSignalDeliveryState = z.infer<typeof workSignalDeliveryStateSchema>;

const nestedReceiptBaseShape = {
  mutationAttemptId: attemptIdSchema,
  accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
} as const;

export const workNestedEffectReceiptSchema = z.discriminatedUnion("kind", [
  z.object({
    ...nestedReceiptBaseShape,
    kind: z.literal("turn_started"),
    turnId: publicProviderIdentifierSchema,
    runtimeProfileDigest: sha256Schema,
  }).strict(),
  z.object({
    ...nestedReceiptBaseShape,
    kind: z.literal("queue_created"),
    queueId: queueIdSchema,
  }).strict(),
  z.object({
    ...nestedReceiptBaseShape,
    kind: z.literal("turn_steered"),
    turnId: publicProviderIdentifierSchema,
  }).strict(),
]);
export type WorkNestedEffectReceipt = z.infer<typeof workNestedEffectReceiptSchema>;

export const workRecordSchema = z.object({
  id: workIdSchema,
  clientRef: workClientRefSchema,
  coordinatorSessionId: sessionIdSchema,
  objective: objectiveSchema,
  status: workStatusSchema,
  revision: revisionSchema,
  taskCount: z.number().int().min(1).max(WORK_PLAN_TASK_LIMIT),
  waitingTaskCount: z.number().int().min(0).max(WORK_PLAN_TASK_LIMIT),
  readyTaskCount: z.number().int().min(0).max(WORK_PLAN_TASK_LIMIT),
  activeTaskCount: z.number().int().min(0).max(WORK_PLAN_TASK_LIMIT),
  completedTaskCount: z.number().int().min(0).max(WORK_PLAN_TASK_LIMIT),
  failedTaskCount: z.number().int().min(0).max(WORK_PLAN_TASK_LIMIT),
  cancelledTaskCount: z.number().int().min(0).max(WORK_PLAN_TASK_LIMIT),
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
  terminalAt: unixMillisecondsSchema.nullable(),
}).strict().superRefine((work, context) => {
  const classifiedTasks = work.waitingTaskCount
    + work.readyTaskCount
    + work.activeTaskCount
    + work.completedTaskCount
    + work.failedTaskCount
    + work.cancelledTaskCount;
  if (classifiedTasks !== work.taskCount) {
    context.addIssue({
      code: "custom",
      message: "Work task counters must exactly partition the plan.",
    });
  }
  const shouldBeTerminal = !["open", "cancel_pending", "fail_pending"].includes(work.status);
  if (shouldBeTerminal !== (work.terminalAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["terminalAt"],
      message: "Only an open work item may omit its terminal timestamp.",
    });
  }
  if (work.updatedAt < work.createdAt) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "Work update time cannot precede creation.",
    });
  }
});
export type WorkRecord = z.infer<typeof workRecordSchema>;

export const workTaskSummarySchema = z.object({
  id: workTaskIdSchema,
  clientRef: workClientRefSchema,
  status: workTaskStatusSchema,
  revision: revisionSchema,
  route: workRouteSchema,
  preset: presetSchema,
  fast: z.boolean(),
  priority: z.number().int().min(-100).max(100),
  depth: z.number().int().min(1).max(WORK_TASK_DEPTH_LIMIT),
  attemptCount: z.number().int().min(0).max(WORK_OPERATION_BATCH_LIMIT),
  activeAttemptId: workAttemptIdSchema.nullable(),
  latestSubmissionId: workSubmissionIdSchema.nullable(),
}).strict();
export type WorkTaskSummary = z.infer<typeof workTaskSummarySchema>;

export const workAttemptRecordSchema = z.object({
  id: workAttemptIdSchema,
  taskId: workTaskIdSchema,
  actorSessionId: sessionIdSchema,
  accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: workAttemptStatusSchema,
  revision: revisionSchema,
  fence: fenceSchema,
  leaseExpiresAt: unixMillisecondsSchema.nullable(),
  targetSessionId: sessionIdSchema.nullable(),
  dispatchMode: z.literal("send").nullable(),
  dispatchReceipt: workNestedEffectReceiptSchema.nullable(),
  submissionId: workSubmissionIdSchema.nullable(),
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
}).strict().superRefine((attempt, context) => {
  if ((attempt.targetSessionId === null) !== (attempt.dispatchMode === null)) {
    context.addIssue({
      code: "custom",
      path: ["dispatchMode"],
      message: "A dispatch mode and target session must be recorded together.",
    });
  }
  if (
    attempt.targetSessionId !== null
    && attempt.targetSessionId !== attempt.actorSessionId
  ) {
    context.addIssue({
      code: "custom",
      path: ["targetSessionId"],
      message: "An attempt may only dispatch to its exact owning actor session.",
    });
  }
  if (
    attempt.dispatchReceipt !== null
    && (
      attempt.dispatchReceipt.accountGeneration !== attempt.accountGeneration
      || attempt.dispatchReceipt.kind !== "turn_started"
      || attempt.dispatchMode === null
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["dispatchReceipt"],
      message: "A dispatch receipt must bind the attempt's mode and account generation.",
    });
  }
  if (attempt.updatedAt < attempt.createdAt) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "Attempt update time cannot precede creation.",
    });
  }
});
export type WorkAttemptRecord = z.infer<typeof workAttemptRecordSchema>;

export const workAttemptReportRecordSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  taskId: workTaskIdSchema,
  attemptId: workAttemptIdSchema,
  reportKind: z.enum(["checkpoint", "submit", "blocked", "failed", "unknown"]),
  report: workAttemptReportSchema,
  reportDigest: sha256Schema,
  createdAt: unixMillisecondsSchema,
}).strict().superRefine((record, context) => {
  if (record.reportKind !== record.report.kind) {
    context.addIssue({
      code: "custom",
      path: ["reportKind"],
      message: "An attempt-report record must advertise its exact report kind.",
    });
  }
});
export type WorkAttemptReportRecord = z.infer<typeof workAttemptReportRecordSchema>;

export const workSubmissionRecordSchema = z.object({
  id: workSubmissionIdSchema,
  taskId: workTaskIdSchema,
  attemptId: workAttemptIdSchema,
  status: workSubmissionStatusSchema,
  revision: revisionSchema,
  summary: summarySchema,
  result: workResultSchema,
  evidence: workEvidenceListSchema,
  contentDigest: sha256Schema,
  requiredReviews: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  acceptedReviews: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
}).strict().superRefine((submission, context) => {
  if (submission.acceptedReviews > submission.requiredReviews) {
    context.addIssue({
      code: "custom",
      path: ["acceptedReviews"],
      message: "Accepted reviews cannot exceed required reviews.",
    });
  }
  if (submission.updatedAt < submission.createdAt) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "Submission update time cannot precede creation.",
    });
  }
});
export type WorkSubmissionRecord = z.infer<typeof workSubmissionRecordSchema>;

export const workReviewRecordSchema = z.object({
  id: workReviewIdSchema,
  submissionId: workSubmissionIdSchema,
  reviewerSessionId: sessionIdSchema,
  decision: z.enum(["accept", "revise", "reject"]),
  summary: summarySchema,
  evidence: workEvidenceListSchema,
  createdAt: unixMillisecondsSchema,
}).strict();
export type WorkReviewRecord = z.infer<typeof workReviewRecordSchema>;

export const workSignalRecordSchema = z.object({
  id: workSignalIdSchema,
  senderSessionId: sessionIdSchema,
  targetSessionId: sessionIdSchema,
  accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  taskId: workTaskIdSchema.nullable(),
  replyToSignalId: workSignalIdSchema.nullable(),
  mode: z.enum(["queue", "steer"]),
  deliveryState: workSignalDeliveryStateSchema,
  deliveryReceipt: workNestedEffectReceiptSchema.nullable(),
  body: signalBodySchema,
  revision: revisionSchema,
  createdAt: unixMillisecondsSchema,
  acknowledgedAt: unixMillisecondsSchema.nullable(),
}).strict().superRefine((signal, context) => {
  if ((signal.deliveryState === "accepted") !== (signal.deliveryReceipt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["deliveryReceipt"],
      message: "Only an accepted signal delivery may carry its exact provider receipt.",
    });
  }
  if (
    signal.deliveryReceipt !== null
    && (
      signal.deliveryReceipt.accountGeneration !== signal.accountGeneration
      || (signal.mode === "queue" && signal.deliveryReceipt.kind !== "queue_created")
      || (signal.mode === "steer" && signal.deliveryReceipt.kind !== "turn_steered")
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["deliveryReceipt"],
      message: "A signal receipt must bind the delivery mode and account generation.",
    });
  }
  if (signal.acknowledgedAt !== null && signal.acknowledgedAt < signal.createdAt) {
    context.addIssue({
      code: "custom",
      path: ["acknowledgedAt"],
      message: "Signal acknowledgement cannot precede creation.",
    });
  }
});
export type WorkSignalRecord = z.infer<typeof workSignalRecordSchema>;

export const workTaskDetailSchema = z.object({
  version: z.literal(1),
  workId: workIdSchema,
  task: workTaskSummarySchema,
  spec: workTaskSpecSchema,
  parentTaskId: workTaskIdSchema.nullable(),
  dependencyTaskIds: z.array(workTaskIdSchema).max(WORK_TASK_DEPENDENCY_LIMIT),
  unmetDependencyTaskIds: z.array(workTaskIdSchema).max(WORK_TASK_DEPENDENCY_LIMIT),
  activeAttempt: workAttemptRecordSchema.nullable(),
  latestAttempt: workAttemptRecordSchema.nullable(),
  latestAttemptReport: workAttemptReportRecordSchema.nullable(),
  latestSubmission: workSubmissionRecordSchema.nullable(),
  latestSubmissionReviews: z.array(workReviewRecordSchema).max(WORK_EVIDENCE_LIMIT),
  omittedLatestSubmissionReviews: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recentSignals: z.array(workSignalRecordSchema).max(WORK_READ_HISTORY_LIMIT),
  omittedSignals: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
}).strict().superRefine((detail, context) => {
  if (workReadSuccessWireBytes("work.task", detail) > WORK_TASK_DETAIL_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `A work task detail must be at most ${WORK_TASK_DETAIL_MAX_BYTES} serialized UTF-8 bytes.`,
    });
  }
  if (detail.task.clientRef !== detail.spec.clientRef) {
    context.addIssue({
      code: "custom",
      path: ["spec", "clientRef"],
      message: "Task summary and specification must carry the same client reference.",
    });
  }
  if (detail.task.activeAttemptId !== detail.activeAttempt?.id && !(
    detail.task.activeAttemptId === null && detail.activeAttempt === null
  )) {
    context.addIssue({
      code: "custom",
      path: ["activeAttempt"],
      message: "Task detail must bind the advertised active attempt.",
    });
  }
  if (
    detail.latestAttempt !== null
    && detail.latestAttempt.taskId !== detail.task.id
  ) {
    context.addIssue({
      code: "custom",
      path: ["latestAttempt", "taskId"],
      message: "The latest attempt must belong to the projected task.",
    });
  }
  if (detail.activeAttempt !== null && detail.latestAttempt?.id !== detail.activeAttempt.id) {
    context.addIssue({
      code: "custom",
      path: ["latestAttempt"],
      message: "An active attempt must also be the task's latest attempt.",
    });
  }
  if (detail.latestAttempt === null && detail.latestAttemptReport !== null) {
    context.addIssue({
      code: "custom",
      path: ["latestAttemptReport"],
      message: "A task without attempt lineage cannot expose an attempt report.",
    });
  }
  if (
    detail.latestAttemptReport !== null
    && detail.latestAttemptReport.taskId !== detail.task.id
  ) {
    context.addIssue({
      code: "custom",
      path: ["latestAttemptReport", "taskId"],
      message: "The latest attempt report must belong to the projected task lineage.",
    });
  }
  if (
    detail.latestSubmission !== null
    && detail.latestSubmission.taskId !== detail.task.id
  ) {
    context.addIssue({
      code: "custom",
      path: ["latestSubmission", "taskId"],
      message: "The latest submission must belong to the projected task.",
    });
  }
  if (
    detail.task.latestSubmissionId !== detail.latestSubmission?.id
    && !(detail.task.latestSubmissionId === null && detail.latestSubmission === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["latestSubmission"],
      message: "Task detail must bind the advertised latest submission.",
    });
  }
  const dependencies = new Set(detail.dependencyTaskIds);
  if (detail.unmetDependencyTaskIds.some((taskId) => !dependencies.has(taskId))) {
    context.addIssue({
      code: "custom",
      path: ["unmetDependencyTaskIds"],
      message: "Every unmet dependency must be a declared dependency.",
    });
  }
  if (detail.updatedAt < detail.createdAt) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "Task update time cannot precede creation.",
    });
  }
  if (
    detail.latestSubmission === null
      ? detail.latestSubmissionReviews.length > 0
        || detail.omittedLatestSubmissionReviews > 0
      : detail.latestSubmissionReviews.some(
        (review) => review.submissionId !== detail.latestSubmission?.id,
      )
  ) {
    context.addIssue({
      code: "custom",
      path: ["latestSubmissionReviews"],
      message: "Every projected review must belong to the latest submission.",
    });
  }
  if (
    detail.latestSubmissionReviews.length + detail.omittedLatestSubmissionReviews
    > WORK_EVIDENCE_LIMIT
  ) {
    context.addIssue({
      code: "custom",
      path: ["omittedLatestSubmissionReviews"],
      message: "Visible and omitted latest-submission reviews must remain bounded.",
    });
  }
  const reviewIds = detail.latestSubmissionReviews.map((review) => review.id);
  const reviewers = detail.latestSubmissionReviews.map((review) => review.reviewerSessionId);
  if (
    new Set(reviewIds).size !== reviewIds.length
    || new Set(reviewers).size !== reviewers.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["latestSubmissionReviews"],
      message: "Latest-submission reviews must have unique IDs and reviewer sessions.",
    });
  }
  for (let index = 1; index < detail.latestSubmissionReviews.length; index += 1) {
    const prior = detail.latestSubmissionReviews[index - 1];
    const current = detail.latestSubmissionReviews[index];
    if (
      prior !== undefined
      && current !== undefined
      && (
        current.createdAt < prior.createdAt
        || (current.createdAt === prior.createdAt && current.id <= prior.id)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["latestSubmissionReviews", index],
        message: "Latest-submission reviews must be ordered by creation time and ID.",
      });
    }
  }
  const signalIds = detail.recentSignals.map((signal) => signal.id);
  if (
    new Set(signalIds).size !== signalIds.length
    || detail.recentSignals.some((signal) => signal.taskId !== detail.task.id)
  ) {
    context.addIssue({
      code: "custom",
      path: ["recentSignals"],
      message: "Recent task signals must be unique and belong to the projected task.",
    });
  }
  for (let index = 1; index < detail.recentSignals.length; index += 1) {
    const prior = detail.recentSignals[index - 1];
    const current = detail.recentSignals[index];
    if (
      prior !== undefined
      && current !== undefined
      && (
        current.createdAt > prior.createdAt
        || (current.createdAt === prior.createdAt && current.id >= prior.id)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["recentSignals", index],
        message: "Recent task signals must be ordered newest first by creation time and ID.",
      });
    }
  }
});
export type WorkTaskDetail = z.infer<typeof workTaskDetailSchema>;

const isCanonicalBase64Url = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  if (remainder === 2) return /[AQgw]$/u.test(value);
  if (remainder === 3) return /[AEIMQUYcgkosw048]$/u.test(value);
  return true;
};

export const workEventCursorWireSchema = z.string()
  .max(WORK_EVENT_CURSOR_MAX_BYTES)
  .refine((value) => {
    const match = /^hra1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(value);
    return match !== null
      && isCanonicalBase64Url(match[1] ?? "")
      && isCanonicalBase64Url(match[2] ?? "");
  }, "Must be one canonical HRA cursor envelope.");

export const workEventCursorPayloadSchema = z.object({
  version: z.literal(1),
  type: z.literal("work"),
  workId: workIdSchema,
  streamEpoch: streamEpochSchema,
  sequence: cursorSequenceSchema,
}).strict();
export type WorkEventCursorPayload = z.infer<typeof workEventCursorPayloadSchema>;

export const workActionOffsetsSchema = z.object({
  readyTasks: cursorSequenceSchema,
  ownedAttempts: cursorSequenceSchema,
  recoveryAttempts: cursorSequenceSchema,
  reviewableSubmissions: cursorSequenceSchema,
  signals: cursorSequenceSchema,
  preparedEffects: cursorSequenceSchema,
}).strict();
export type WorkActionOffsets = z.infer<typeof workActionOffsetsSchema>;

export const workActionCursorPayloadSchema = z.object({
  version: z.literal(1),
  type: z.literal("work_actions"),
  workId: workIdSchema,
  streamEpoch: streamEpochSchema,
  sequence: cursorSequenceSchema,
  projectionAt: unixMillisecondsSchema.max(Number.MAX_SAFE_INTEGER),
  actorSessionId: sessionIdSchema.nullable(),
  offsets: workActionOffsetsSchema,
}).strict();
export type WorkActionCursorPayload = z.infer<typeof workActionCursorPayloadSchema>;

const workTaskHistoryItemCountSchema = z.number().int().nonnegative()
  .max(WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT);

export const workTaskHistoryCursorPayloadSchema = z.object({
  version: z.literal(1),
  type: z.literal("work_task_history"),
  workId: workIdSchema,
  taskId: workTaskIdSchema,
  streamEpoch: streamEpochSchema,
  sequence: cursorSequenceSchema,
  projectionAt: unixMillisecondsSchema.max(Number.MAX_SAFE_INTEGER),
  highWaterOrdinal: cursorSequenceSchema,
  taskRevision: revisionSchema,
  offset: workTaskHistoryItemCountSchema,
}).strict();
export type WorkTaskHistoryCursorPayload = z.infer<typeof workTaskHistoryCursorPayloadSchema>;

export const workTaskHistoryCountsSchema = z.object({
  attempts: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
  attemptReports: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
  submissions: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
  reviews: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
  signals: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
}).strict();
export type WorkTaskHistoryCounts = z.infer<typeof workTaskHistoryCountsSchema>;

export const workTaskHistoryItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attempt"), value: workAttemptRecordSchema }).strict(),
  z.object({
    kind: z.literal("attempt_report"),
    value: workAttemptReportRecordSchema,
  }).strict(),
  z.object({ kind: z.literal("submission"), value: workSubmissionRecordSchema }).strict(),
  z.object({
    kind: z.literal("review"),
    taskId: workTaskIdSchema,
    value: workReviewRecordSchema,
  }).strict(),
  z.object({ kind: z.literal("signal"), value: workSignalRecordSchema }).strict(),
]);
export type WorkTaskHistoryItem = z.infer<typeof workTaskHistoryItemSchema>;

export const workTaskHistoryPageSchema = z.object({
  version: z.literal(1),
  kind: z.literal("history"),
  workId: workIdSchema,
  taskId: workTaskIdSchema,
  taskRevision: revisionSchema,
  projectionAt: unixMillisecondsSchema.max(Number.MAX_SAFE_INTEGER),
  requestedCursor: workEventCursorWireSchema.nullable(),
  observedThroughCursor: workEventCursorWireSchema,
  offset: workTaskHistoryItemCountSchema,
  totalItems: workTaskHistoryItemCountSchema,
  counts: workTaskHistoryCountsSchema,
  items: z.array(workTaskHistoryItemSchema).max(WORK_TASK_HISTORY_ITEM_LIMIT),
  remainingItems: workTaskHistoryItemCountSchema,
  remainingCounts: workTaskHistoryCountsSchema,
  nextCursor: workEventCursorWireSchema.nullable(),
}).strict().superRefine((page, context) => {
  if (workReadSuccessWireBytes("work.task", page) > WORK_TASK_HISTORY_PAGE_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `A work task history page must be at most ${WORK_TASK_HISTORY_PAGE_MAX_BYTES} serialized UTF-8 bytes.`,
    });
  }
  const totalCount = Object.values(page.counts).reduce((sum, count) => sum + count, 0);
  const remainingCount = Object.values(page.remainingCounts)
    .reduce((sum, count) => sum + count, 0);
  if (totalCount !== page.totalItems) {
    context.addIssue({ code: "custom", path: ["counts"], message: "History counts must sum to totalItems." });
  }
  if (remainingCount !== page.remainingItems) {
    context.addIssue({
      code: "custom",
      path: ["remainingCounts"],
      message: "Remaining history counts must sum to remainingItems.",
    });
  }
  if (page.offset + page.items.length + page.remainingItems !== page.totalItems) {
    context.addIssue({
      code: "custom",
      path: ["offset"],
      message: "History offset, returned items, and remaining items must exactly partition totalItems.",
    });
  }
  if ((page.remainingItems > 0) !== (page.nextCursor !== null)) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "History continuation must exist exactly while items remain.",
    });
  }
  if (page.remainingItems > 0 && page.items.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "A nonterminal history page must return at least one item.",
    });
  }
  if (page.nextCursor !== null && page.nextCursor === page.requestedCursor) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "A task-history continuation must advance beyond the requested cursor.",
    });
  }
  if ((page.offset === 0) !== (page.requestedCursor === null)) {
    context.addIssue({
      code: "custom",
      path: ["requestedCursor"],
      message: "Only the first history page may omit its requested cursor.",
    });
  }
  const returnedByKind: WorkTaskHistoryCounts = {
    attempts: 0,
    attemptReports: 0,
    submissions: 0,
    reviews: 0,
    signals: 0,
  };
  for (const [index, item] of page.items.entries()) {
    if (item.kind === "attempt") returnedByKind.attempts += 1;
    else if (item.kind === "attempt_report") returnedByKind.attemptReports += 1;
    else if (item.kind === "submission") returnedByKind.submissions += 1;
    else if (item.kind === "review") returnedByKind.reviews += 1;
    else returnedByKind.signals += 1;
    if (
      (item.kind === "attempt" && item.value.taskId !== page.taskId)
      || (item.kind === "attempt_report" && item.value.taskId !== page.taskId)
      || (item.kind === "submission" && item.value.taskId !== page.taskId)
      || (item.kind === "review" && item.taskId !== page.taskId)
      || (item.kind === "signal" && item.value.taskId !== page.taskId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["items", index],
        message: "Every task-bound history record must belong to the page task.",
      });
    }
  }
  const countKeys = Object.keys(page.counts) as Array<keyof WorkTaskHistoryCounts>;
  const alreadyReturned = countKeys.reduce((sum, key) => {
    const prior = page.counts[key] - page.remainingCounts[key] - returnedByKind[key];
    if (prior < 0) {
      context.addIssue({
        code: "custom",
        path: ["remainingCounts", key],
        message: "Remaining counts cannot exceed the total after returned items.",
      });
    }
    return sum + Math.max(0, prior);
  }, 0);
  if (alreadyReturned !== page.offset) {
    context.addIssue({
      code: "custom",
      path: ["offset"],
      message: "Per-kind history counts must account for the exact prior offset.",
    });
  }
});
export type WorkTaskHistoryPage = z.infer<typeof workTaskHistoryPageSchema>;

export const workEventBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("work.created"),
    coordinatorSessionId: sessionIdSchema,
    routeCount: z.number().int().min(1).max(WORK_ROUTE_LIMIT),
    routesDigest: sha256Schema,
    taskIds: z.array(workTaskIdSchema).min(1).max(WORK_OPERATION_BATCH_LIMIT),
  }).strict(),
  z.object({
    type: z.literal("task.batch_added"),
    taskIds: z.array(workTaskIdSchema).min(1).max(WORK_OPERATION_BATCH_LIMIT),
  }).strict(),
  z.object({
    type: z.literal("work.joined"),
    coordinatorSessionId: sessionIdSchema,
    actorSessionId: sessionIdSchema,
  }).strict(),
  z.object({
    type: z.literal("task.state_changed"),
    taskId: workTaskIdSchema,
    from: workTaskStatusSchema,
    to: workTaskStatusSchema,
  }).strict(),
  z.object({
    type: z.literal("task.failed"),
    taskId: workTaskIdSchema,
    reason: z.enum([
      "claim_window_elapsed",
      "completion_deadline_elapsed",
      "attempts_exhausted",
    ]),
  }).strict(),
  z.object({
    type: z.literal("task.claimed"),
    taskId: workTaskIdSchema,
    attemptId: workAttemptIdSchema,
    actorSessionId: sessionIdSchema,
    fence: fenceSchema,
    leaseExpiresAt: unixMillisecondsSchema,
  }).strict(),
  z.object({
    type: z.literal("task.claim_next_empty"),
    actorSessionId: sessionIdSchema,
    route: workRouteSchema,
  }).strict(),
  z.object({
    type: z.literal("attempt.renewed"),
    attemptId: workAttemptIdSchema,
    fence: fenceSchema,
    leaseExpiresAt: unixMillisecondsSchema,
  }).strict(),
  z.object({
    type: z.literal("attempt.released"),
    attemptId: workAttemptIdSchema,
    summaryDigest: sha256Schema,
  }).strict(),
  z.object({
    type: z.literal("attempt.expired"),
    attemptId: workAttemptIdSchema,
    fence: fenceSchema,
  }).strict(),
  z.object({
    type: z.literal("attempt.recovery_required"),
    attemptId: workAttemptIdSchema,
    fence: fenceSchema,
    reason: z.enum([
      "lease_expired_after_dispatch",
      "effect_unknown",
      "custodian_restart",
    ]),
  }).strict(),
  z.object({
    type: z.literal("attempt.dispatch_requested"),
    attemptId: workAttemptIdSchema,
    targetSessionId: sessionIdSchema,
    mode: z.literal("send"),
  }).strict(),
  z.object({
    type: z.literal("attempt.dispatch_started"),
    attemptId: workAttemptIdSchema,
  }).strict(),
  z.object({
    type: z.literal("attempt.dispatch_finalized"),
    attemptId: workAttemptIdSchema,
    outcome: z.enum(["accepted", "failed", "unknown"]),
  }).strict(),
  z.object({
    type: z.literal("attempt.reported"),
    attemptId: workAttemptIdSchema,
    reportKind: z.enum(["checkpoint", "submit", "blocked", "failed", "unknown"]),
    submissionId: workSubmissionIdSchema.nullable(),
    reportDigest: sha256Schema,
    evidenceCount: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  }).strict(),
  z.object({
    type: z.literal("submission.reviewed"),
    submissionId: workSubmissionIdSchema,
    reviewId: workReviewIdSchema,
    reviewerSessionId: sessionIdSchema,
    decision: z.enum(["accept", "revise", "reject"]),
    reviewDigest: sha256Schema,
    evidenceCount: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  }).strict(),
  z.object({
    type: z.literal("signal.delivery_requested"),
    signalId: workSignalIdSchema,
    senderSessionId: sessionIdSchema,
    targetSessionId: sessionIdSchema,
    taskId: workTaskIdSchema.nullable(),
    replyToSignalId: workSignalIdSchema.nullable(),
    mode: z.enum(["queue", "steer"]),
    bodyDigest: sha256Schema,
  }).strict(),
  z.object({
    type: z.literal("signal.delivery_started"),
    signalId: workSignalIdSchema,
  }).strict(),
  z.object({
    type: z.literal("signal.acknowledged"),
    signalId: workSignalIdSchema,
    actorSessionId: sessionIdSchema,
  }).strict(),
  z.object({
    type: z.literal("signal.delivery_updated"),
    signalId: workSignalIdSchema,
    outcome: z.enum(["accepted", "failed", "unknown"]),
  }).strict(),
  z.object({
    type: z.literal("work.completed"),
    requestDigest: sha256Schema,
    evidenceCount: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
    resultKind: workResultKindSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("work.failed"),
    requestDigest: sha256Schema,
    evidenceCount: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  }).strict(),
  z.object({
    type: z.literal("work.failure_requested"),
    requestDigest: sha256Schema,
    evidenceCount: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  }).strict(),
  z.object({
    type: z.literal("work.cancellation_requested"),
    requestDigest: sha256Schema,
    evidenceCount: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  }).strict(),
  z.object({
    type: z.literal("work.cancelled"),
    requestDigest: sha256Schema,
    evidenceCount: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  }).strict(),
  z.object({
    type: z.literal("attempt.reconciled"),
    attemptId: workAttemptIdSchema,
    outcome: z.enum(["completed", "failed", "no_effect", "still_unknown"]),
    submissionId: workSubmissionIdSchema.nullable(),
    outcomeDigest: sha256Schema,
    evidenceCount: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  }).strict(),
]);
export type WorkEventBody = z.infer<typeof workEventBodySchema>;

export const workEventSchema = z.object({
  version: z.literal(1),
  workId: workIdSchema,
  streamEpoch: streamEpochSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  occurredAt: unixMillisecondsSchema,
  actorSessionId: sessionIdSchema.nullable(),
  body: workEventBodySchema,
}).strict().superRefine((event, context) => {
  if (utf8Bytes(JSON.stringify(event)) > WORK_EVENT_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: "A work event exceeds its serialized UTF-8 byte bound.",
    });
  }
});
export type WorkEvent = z.infer<typeof workEventSchema>;

export const workEventGapReasonSchema = z.enum([
  "retention_count",
  "retention_age",
  "retention_bytes",
  "stream_reset",
]);

export const workEventPageSchema = z.object({
  version: z.literal(1),
  workId: workIdSchema,
  streamEpoch: streamEpochSchema,
  requestedCursor: workEventCursorWireSchema.nullable(),
  retentionFloorCursor: workEventCursorWireSchema,
  observedThroughCursor: workEventCursorWireSchema,
  nextCursor: workEventCursorWireSchema,
  gap: z.object({
    reason: workEventGapReasonSchema,
    requestedSequence: cursorSequenceSchema.nullable(),
    retainedFromSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict().nullable(),
  events: z.array(workEventSchema).max(WORK_EVENT_PAGE_LIMIT),
}).strict().superRefine((page, context) => {
  if (workReadSuccessWireBytes("work.events", page) > WORK_EVENT_PAGE_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["events"],
      message: "A work event page exceeds its terminal-safe wire byte bound.",
    });
  }

  let priorSequence: number | null = null;
  for (const [index, event] of page.events.entries()) {
    if (event.workId !== page.workId) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "workId"],
        message: "Every event must bind the page work item.",
      });
    }
    if (event.streamEpoch !== page.streamEpoch) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "streamEpoch"],
        message: "Every event must bind the page stream epoch.",
      });
    }
    if (priorSequence !== null && event.sequence !== priorSequence + 1) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "sequence"],
        message: "Event sequences must be exactly contiguous within a page.",
      });
    }
    priorSequence = event.sequence;
  }

  if (
    page.gap !== null
    && page.events.length > 0
    && page.events[0]?.sequence !== page.gap.retainedFromSequence
  ) {
    context.addIssue({
      code: "custom",
      path: ["events", 0, "sequence"],
      message: "The first retained event must start at the gap retention floor.",
    });
  }
  if (
    (page.events.length > 0 || page.gap !== null)
    && page.nextCursor === page.requestedCursor
  ) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "A nonempty or gap page must advance its checkpoint.",
    });
  }
  if (
    page.events.length === 0
    && page.gap === null
    && page.requestedCursor !== null
    && page.nextCursor !== page.requestedCursor
  ) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "An empty page without a gap cannot advance its checkpoint.",
    });
  }
});
export type WorkEventPage = z.infer<typeof workEventPageSchema>;

export const workTerminalProjectionSchema = z.object({
  kind: z.enum(["work.complete", "work.fail", "work.cancel"]),
  state: z.enum(["requested", "settled"]),
  actorSessionId: sessionIdSchema,
  summary: summarySchema,
  result: workResultSchema.nullable(),
  evidence: workEvidenceListSchema,
  requestDigest: sha256Schema,
  requestedAt: unixMillisecondsSchema,
  settledAt: unixMillisecondsSchema.nullable(),
}).strict().superRefine((terminal, context) => {
  if ((terminal.state === "settled") !== (terminal.settledAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["settledAt"],
      message: "A terminal projection must expose settlement time exactly when settled.",
    });
  }
  if (terminal.kind === "work.complete" && terminal.state !== "settled") {
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "Work completion has no pending state.",
    });
  }
  if (terminal.kind !== "work.complete" && terminal.result !== null) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "Only completed work may expose an aggregate result.",
    });
  }
  if (terminal.settledAt !== null && terminal.settledAt < terminal.requestedAt) {
    context.addIssue({
      code: "custom",
      path: ["settledAt"],
      message: "Terminal settlement cannot precede its request.",
    });
  }
});
export type WorkTerminalProjection = z.infer<typeof workTerminalProjectionSchema>;

export const workReleaseTombstoneSchema = z.object({
  version: z.literal(1),
  workId: workIdSchema,
  clientRefDigest: sha256Schema,
  coordinatorSessionId: sessionIdSchema,
  terminalKind: z.enum(["work.complete", "work.fail", "work.cancel"]),
  terminalRequestDigest: sha256Schema,
  releaseRequestDigest: sha256Schema,
  finalRevision: revisionSchema,
  finalHeadHash: sha256Schema,
  discardedRecordCounts: z.object({
    routes: z.number().int().nonnegative().max(WORK_ROUTE_LIMIT),
    members: z.number().int().nonnegative().max(WORK_MEMBER_LIMIT),
    tasks: z.number().int().nonnegative().max(WORK_PLAN_TASK_LIMIT),
    dependencies: z.number().int().nonnegative().max(WORK_PLAN_TASK_LIMIT * WORK_TASK_DEPENDENCY_LIMIT),
    attempts: z.number().int().nonnegative().max(WORK_PLAN_TASK_LIMIT * WORK_OPERATION_BATCH_LIMIT),
    reports: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
    submissions: z.number().int().nonnegative().max(WORK_PLAN_TASK_LIMIT * WORK_OPERATION_BATCH_LIMIT),
    reviews: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
    signals: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
    receipts: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT * 3),
    events: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
    intents: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
    effects: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
    unresolvedSignalEffects: z.number().int().nonnegative().max(WORK_HISTORY_EVENT_LIMIT),
    effectResolutions: z.number().int().nonnegative().max(WORK_EFFECT_RESOLUTION_LIMIT),
    historyIndex: z.number().int().nonnegative().max(WORK_TASK_HISTORY_MEMBERSHIP_LIMIT),
    historyVersions: z.number().int().nonnegative().max(WORK_TASK_HISTORY_VERSION_LIMIT),
  }).strict(),
  discardedRecordsDigest: sha256Schema,
  releasedAt: unixMillisecondsSchema,
  retentionUpperBoundAt: unixMillisecondsSchema,
  priorOperationReplayGuaranteesEnded: z.literal(true),
  releaseReplayPolicy: z.literal("retained_tombstone_only"),
}).strict().superRefine((tombstone, context) => {
  if (tombstone.retentionUpperBoundAt < tombstone.releasedAt) {
    context.addIssue({
      code: "custom",
      path: ["retentionUpperBoundAt"],
      message: "A release replay horizon cannot precede the release.",
    });
  }
});
export type WorkReleaseTombstone = z.infer<typeof workReleaseTombstoneSchema>;

export const workSnapshotSchema = z.object({
  version: z.literal(1),
  work: workRecordSchema,
  routes: workExecutionRoutesSchema,
  cursor: workEventCursorWireSchema,
  tasks: z.array(workTaskSummarySchema).max(WORK_PLAN_TASK_LIMIT),
  joinedSessionIds: z.array(sessionIdSchema).max(WORK_MEMBER_LIMIT),
  recentSignals: z.array(workSignalRecordSchema).max(WORK_READ_HISTORY_LIMIT),
  omittedSignals: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  terminal: workTerminalProjectionSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  if (workReadSuccessWireBytes("work.snapshot", snapshot) > WORK_SNAPSHOT_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `A work snapshot must be at most ${WORK_SNAPSHOT_MAX_BYTES} serialized UTF-8 bytes.`,
    });
  }
  if (!snapshot.joinedSessionIds.includes(snapshot.work.coordinatorSessionId)) {
    context.addIssue({
      code: "custom",
      path: ["joinedSessionIds"],
      message: "The work coordinator must remain a joined participant.",
    });
  }
  if (snapshot.tasks.length !== snapshot.work.taskCount) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "A work snapshot must contain the complete task plan.",
    });
  }
  if (new Set(snapshot.tasks.map((task) => task.id)).size !== snapshot.tasks.length) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "A work snapshot cannot repeat task IDs.",
    });
  }
  if (new Set(snapshot.joinedSessionIds).size !== snapshot.joinedSessionIds.length) {
    context.addIssue({
      code: "custom",
      path: ["joinedSessionIds"],
      message: "A work snapshot cannot repeat joined sessions.",
    });
  }
  const signalIds = snapshot.recentSignals.map((signal) => signal.id);
  if (
    new Set(signalIds).size !== signalIds.length
    || snapshot.recentSignals.some((signal) => signal.taskId !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["recentSignals"],
      message: "Recent work signals must be unique and scoped to the work item.",
    });
  }
  for (let index = 1; index < snapshot.recentSignals.length; index += 1) {
    const prior = snapshot.recentSignals[index - 1];
    const current = snapshot.recentSignals[index];
    if (
      prior !== undefined
      && current !== undefined
      && (
        current.createdAt > prior.createdAt
        || (current.createdAt === prior.createdAt && current.id >= prior.id)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["recentSignals", index],
        message: "Recent work signals must be ordered newest first by creation time and ID.",
      });
    }
  }
  const expectedTerminal = snapshot.work.status === "completed"
    ? { kind: "work.complete", state: "settled" }
    : snapshot.work.status === "failed"
      ? { kind: "work.fail", state: "settled" }
      : snapshot.work.status === "cancelled"
        ? { kind: "work.cancel", state: "settled" }
        : snapshot.work.status === "fail_pending"
          ? { kind: "work.fail", state: "requested" }
          : snapshot.work.status === "cancel_pending"
            ? { kind: "work.cancel", state: "requested" }
            : null;
  if (
    expectedTerminal === null
      ? snapshot.terminal !== null
      : snapshot.terminal === null
        || snapshot.terminal.kind !== expectedTerminal.kind
        || snapshot.terminal.state !== expectedTerminal.state
  ) {
    context.addIssue({
      code: "custom",
      path: ["terminal"],
      message: "The terminal projection must match the exact work lifecycle state.",
    });
  }
});
export type WorkSnapshot = z.infer<typeof workSnapshotSchema>;

export const workPreparedEffectStateSchema = z.enum([
  "prepared",
  "effect_started",
  "accepted",
  "failed",
  "unknown",
]);

export const workPreparedEffectStatusSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dispatch"),
    idempotencyKey: idempotencyKeySchema,
    subjectId: workAttemptIdSchema,
    targetSessionId: sessionIdSchema,
    instructionDigest: sha256Schema,
    state: workPreparedEffectStateSchema,
  }).strict(),
  z.object({
    kind: z.literal("signal"),
    idempotencyKey: idempotencyKeySchema,
    subjectId: workSignalIdSchema,
    targetSessionId: sessionIdSchema,
    instructionDigest: sha256Schema,
    state: workPreparedEffectStateSchema,
  }).strict(),
]);
export type WorkPreparedEffectStatus = z.infer<typeof workPreparedEffectStatusSchema>;

export const workReviewableSubmissionSchema = z.object({
  id: workSubmissionIdSchema,
  taskId: workTaskIdSchema,
  attemptId: workAttemptIdSchema,
  status: z.literal("pending_review"),
  revision: revisionSchema,
  contentDigest: sha256Schema,
  requiredReviews: z.number().int().min(1).max(WORK_EVIDENCE_LIMIT),
  acceptedReviews: z.number().int().min(0).max(WORK_EVIDENCE_LIMIT),
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
}).strict().superRefine((submission, context) => {
  if (submission.acceptedReviews >= submission.requiredReviews) {
    context.addIssue({
      code: "custom",
      path: ["acceptedReviews"],
      message: "A reviewable submission must still need at least one independent acceptance.",
    });
  }
  if (submission.updatedAt < submission.createdAt) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "Submission update time cannot precede creation.",
    });
  }
});
export type WorkReviewableSubmission = z.infer<typeof workReviewableSubmissionSchema>;

const omittedWorkPollCountsSchema = z.object({
  readyTasks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ownedAttempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recoveryAttempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reviewableSubmissions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  signals: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  preparedEffects: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const workPollRequestSchema = z.object({
  workId: workIdSchema,
  actorSessionId: sessionIdSchema.nullable(),
  cursor: workEventCursorWireSchema.nullable(),
  actionCursor: workEventCursorWireSchema.nullable(),
  waitMs: z.number().int().min(0).max(WORK_WAIT_MAX_MS),
  limit: z.number().int().min(1).max(WORK_POLL_ITEM_LIMIT),
}).strict().superRefine((request, context) => {
  if (request.actionCursor !== null && request.waitMs !== 0) {
    context.addIssue({
      code: "custom",
      path: ["waitMs"],
      message: "A continued work action page cannot long-poll; waitMs must be zero.",
    });
  }
});
export type WorkPollRequest = z.infer<typeof workPollRequestSchema>;

export const workPollSchema = z.object({
  version: z.literal(1),
  workId: workIdSchema,
  actorSessionId: sessionIdSchema.nullable(),
  workRevision: revisionSchema,
  status: workStatusSchema,
  nextWakeAt: unixMillisecondsSchema.nullable(),
  requestedActionCursor: workEventCursorWireSchema.nullable(),
  nextActionCursor: workEventCursorWireSchema.nullable(),
  readyTasks: z.array(workTaskSummarySchema).max(WORK_POLL_ITEM_LIMIT),
  ownedAttempts: z.array(workAttemptRecordSchema).max(WORK_POLL_ITEM_LIMIT),
  recoveryAttempts: z.array(workAttemptRecordSchema).max(WORK_POLL_ITEM_LIMIT),
  reviewableSubmissions: z.array(workReviewableSubmissionSchema).max(WORK_POLL_ITEM_LIMIT),
  signals: z.array(workSignalRecordSchema).max(WORK_POLL_ITEM_LIMIT),
  preparedEffects: z.array(workPreparedEffectStatusSchema).max(WORK_POLL_ITEM_LIMIT),
  omitted: omittedWorkPollCountsSchema,
  eventPage: workEventPageSchema,
}).strict().superRefine((poll, context) => {
  if (workReadSuccessWireBytes("work.poll", poll) > WORK_POLL_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `A work poll must be at most ${WORK_POLL_MAX_BYTES} serialized UTF-8 bytes.`,
    });
  }
  if (poll.eventPage.workId !== poll.workId) {
    context.addIssue({
      code: "custom",
      path: ["eventPage", "workId"],
      message: "A poll event page must bind the polled work item.",
    });
  }
  const omittedActions = Object.values(poll.omitted).some((count) => count > 0);
  if (omittedActions !== (poll.nextActionCursor !== null)) {
    context.addIssue({
      code: "custom",
      path: ["nextActionCursor"],
      message: "A poll must expose an action continuation exactly while action items remain omitted.",
    });
  }
  if (
    poll.actorSessionId === null
    && (
      poll.ownedAttempts.length > 0
      || poll.reviewableSubmissions.length > 0
      || poll.signals.length > 0
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "An unbound monitor poll cannot expose actor-owned attempts, review work, or signals.",
    });
  }
  if (
    poll.actorSessionId === null
    && (
      poll.omitted.ownedAttempts > 0
      || poll.omitted.reviewableSubmissions > 0
      || poll.omitted.signals > 0
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["omitted"],
      message: "An unbound monitor poll cannot omit actor-owned items it is forbidden to expose.",
    });
  }
  for (const [index, attempt] of poll.ownedAttempts.entries()) {
    if (
      poll.actorSessionId !== null
      && attempt.actorSessionId !== poll.actorSessionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownedAttempts", index, "actorSessionId"],
        message: "A poll may only expose attempts owned by its exact actor session.",
      });
    }
  }
  for (const [index, attempt] of poll.recoveryAttempts.entries()) {
    if (attempt.status !== "unknown") {
      context.addIssue({
        code: "custom",
        path: ["recoveryAttempts", index, "status"],
        message: "A recovery projection may contain only unknown attempts.",
      });
    }
  }
  for (const [index, signal] of poll.signals.entries()) {
    if (
      poll.actorSessionId !== null
      && signal.targetSessionId !== poll.actorSessionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["signals", index, "targetSessionId"],
        message: "A poll may only expose signals addressed to its exact actor session.",
      });
    }
  }
  for (const [index, effect] of poll.preparedEffects.entries()) {
    if (
      poll.actorSessionId !== null
      && effect.targetSessionId !== poll.actorSessionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["preparedEffects", index, "targetSessionId"],
        message: "An actor poll may only expose effects addressed to its exact session.",
      });
    }
  }
});
export type WorkPoll = z.infer<typeof workPollSchema>;

export const workPreparedDispatchInstructionSchema = z.object({
  kind: z.literal("dispatch"),
  workId: workIdSchema,
  nestedMutationKey: idempotencyKeySchema,
  taskId: workTaskIdSchema,
  attemptId: workAttemptIdSchema,
  attemptCapability: workCapabilitySchema,
  fence: fenceSchema,
  accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  targetSessionId: sessionIdSchema,
  mode: z.literal("send"),
  spec: workTaskSpecSchema,
  dependencies: z.array(z.object({
    taskId: workTaskIdSchema,
    clientRef: workClientRefSchema,
    submissionId: workSubmissionIdSchema,
    summary: summarySchema,
    contentDigest: sha256Schema,
  }).strict()).max(WORK_TASK_DEPENDENCY_LIMIT),
}).strict().superRefine((effect, context) => {
  if (utf8Bytes(JSON.stringify(effect)) > WORK_PREPARED_EFFECT_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `A prepared dispatch must be at most ${WORK_PREPARED_EFFECT_MAX_BYTES} serialized UTF-8 bytes.`,
    });
  }
});
export type WorkPreparedDispatchInstruction = z.infer<
  typeof workPreparedDispatchInstructionSchema
>;

export const workPreparedSignalInstructionSchema = z.object({
  kind: z.literal("signal"),
  workId: workIdSchema,
  nestedMutationKey: idempotencyKeySchema,
  signalId: workSignalIdSchema,
  targetMemberCapability: workCapabilitySchema,
  targetSessionId: sessionIdSchema,
  accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(["queue", "steer"]),
  body: signalBodySchema,
}).strict().superRefine((effect, context) => {
  if (utf8Bytes(JSON.stringify(effect)) > WORK_PREPARED_EFFECT_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `A prepared signal must be at most ${WORK_PREPARED_EFFECT_MAX_BYTES} serialized UTF-8 bytes.`,
    });
  }
});
export type WorkPreparedSignalInstruction = z.infer<
  typeof workPreparedSignalInstructionSchema
>;

export const workPreparedEffectSchema = z.discriminatedUnion("kind", [
  workPreparedDispatchInstructionSchema,
  workPreparedSignalInstructionSchema,
]);
export type WorkPreparedEffect = z.infer<typeof workPreparedEffectSchema>;

const workMutationResultShape = {
  workId: workIdSchema,
  workRevision: revisionSchema,
} as const;

const workCreateResultSchema = z.object({
  kind: z.literal("work.create"),
  ...workMutationResultShape,
  work: workRecordSchema,
  coordinatorCapability: workCapabilitySchema,
  memberCapability: workCapabilitySchema,
  routes: workExecutionRoutesSchema,
  tasks: z.array(workTaskSummarySchema).min(1).max(WORK_OPERATION_BATCH_LIMIT),
}).strict().superRefine((result, context) => {
  if (result.workId !== result.work.id || result.workRevision !== result.work.revision) {
    context.addIssue({
      code: "custom",
      message: "A create result must bind its work identity and revision.",
    });
  }
});

const taskAddBatchResultSchema = z.object({
  kind: z.literal("task.addBatch"),
  ...workMutationResultShape,
  tasks: z.array(workTaskSummarySchema).min(1).max(WORK_OPERATION_BATCH_LIMIT),
}).strict();

const workJoinResultSchema = z.object({
  kind: z.literal("work.join"),
  ...workMutationResultShape,
  actorSessionId: sessionIdSchema,
  memberCapability: workCapabilitySchema,
}).strict();

const taskClaimResultSchema = z.object({
  kind: z.literal("task.claim"),
  ...workMutationResultShape,
  task: workTaskSummarySchema,
  attempt: workAttemptRecordSchema,
  attemptCapability: workCapabilitySchema,
}).strict();

const taskClaimNextResultSchema = z.object({
  kind: z.literal("task.claimNext"),
  ...workMutationResultShape,
  task: workTaskSummarySchema.nullable(),
  attempt: workAttemptRecordSchema.nullable(),
  attemptCapability: workCapabilitySchema.nullable(),
}).strict().superRefine((result, context) => {
  if (
    (result.task === null) !== (result.attempt === null)
    || (result.task === null) !== (result.attemptCapability === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "A next-task claim must return a task and attempt together, or neither.",
    });
  }
});

const taskClaimBatchResultSchema = z.object({
  kind: z.literal("task.claimBatch"),
  ...workMutationResultShape,
  claims: z.array(z.object({
    task: workTaskSummarySchema,
    attempt: workAttemptRecordSchema,
    attemptCapability: workCapabilitySchema,
  }).strict()).min(1).max(WORK_OPERATION_BATCH_LIMIT),
}).strict().superRefine((result, context) => {
  const taskIds = result.claims.map((claim) => claim.task.id);
  const attemptIds = result.claims.map((claim) => claim.attempt.id);
  const actors = result.claims.map((claim) => claim.attempt.actorSessionId);
  if (
    new Set(taskIds).size !== taskIds.length
    || new Set(attemptIds).size !== attemptIds.length
    || new Set(actors).size !== actors.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["claims"],
      message: "An atomic claim result must contain unique tasks, attempts, and actors.",
    });
  }
  for (const [index, claim] of result.claims.entries()) {
    if (claim.attempt.taskId !== claim.task.id) {
      context.addIssue({
        code: "custom",
        path: ["claims", index, "attempt", "taskId"],
        message: "Every atomic claim attempt must bind its returned task.",
      });
    }
  }
});

const attemptRenewResultSchema = z.object({
  kind: z.literal("attempt.renew"),
  ...workMutationResultShape,
  attempt: workAttemptRecordSchema,
}).strict();

const attemptReleaseResultSchema = z.object({
  kind: z.literal("attempt.release"),
  ...workMutationResultShape,
  attempt: workAttemptRecordSchema,
}).strict();

const attemptDispatchResultSchema = z.object({
  kind: z.literal("attempt.dispatch"),
  ...workMutationResultShape,
  attempt: workAttemptRecordSchema,
  effect: workPreparedEffectStatusSchema,
}).strict();

const attemptReportResultSchema = z.object({
  kind: z.literal("attempt.report"),
  ...workMutationResultShape,
  attempt: workAttemptRecordSchema,
  submission: workSubmissionRecordSchema.nullable(),
}).strict();

const submissionReviewResultSchema = z.object({
  kind: z.literal("submission.review"),
  ...workMutationResultShape,
  submission: workSubmissionRecordSchema,
  review: workReviewRecordSchema,
}).strict();

const signalSendResultSchema = z.object({
  kind: z.literal("signal.send"),
  ...workMutationResultShape,
  signal: workSignalRecordSchema,
  effect: workPreparedEffectStatusSchema,
}).strict();

const signalAckResultSchema = z.object({
  kind: z.literal("signal.ack"),
  ...workMutationResultShape,
  signal: workSignalRecordSchema,
}).strict();

const terminalWorkResultSchema = (kind: "work.complete" | "work.fail" | "work.cancel") =>
  z.object({
    kind: z.literal(kind),
    ...workMutationResultShape,
    work: workRecordSchema,
  }).strict().superRefine((result, context) => {
    if (result.workId !== result.work.id || result.workRevision !== result.work.revision) {
      context.addIssue({
        code: "custom",
        message: "A terminal result must bind its work identity and revision.",
      });
    }
  });

const attemptReconcileResultSchema = z.object({
  kind: z.literal("attempt.reconcile"),
  ...workMutationResultShape,
  attempt: workAttemptRecordSchema,
  submission: workSubmissionRecordSchema.nullable(),
}).strict();

const workReleaseResultSchema = z.object({
  kind: z.literal("work.release"),
  ...workMutationResultShape,
  tombstone: workReleaseTombstoneSchema,
}).strict().superRefine((result, context) => {
  if (
    result.workId !== result.tombstone.workId
    || result.workRevision !== result.tombstone.finalRevision
  ) {
    context.addIssue({
      code: "custom",
      message: "A release result must bind its tombstoned work identity and final revision.",
    });
  }
});

export const workOperationResultSchema = z.discriminatedUnion("kind", [
  workCreateResultSchema,
  taskAddBatchResultSchema,
  workJoinResultSchema,
  taskClaimResultSchema,
  taskClaimNextResultSchema,
  taskClaimBatchResultSchema,
  attemptRenewResultSchema,
  attemptReleaseResultSchema,
  attemptDispatchResultSchema,
  attemptReportResultSchema,
  submissionReviewResultSchema,
  signalSendResultSchema,
  signalAckResultSchema,
  terminalWorkResultSchema("work.complete"),
  terminalWorkResultSchema("work.fail"),
  terminalWorkResultSchema("work.cancel"),
  workReleaseResultSchema,
  attemptReconcileResultSchema,
]);
export type WorkOperationResult = z.infer<typeof workOperationResultSchema>;
export const workApplyResultSchema = workOperationResultSchema;
export type WorkApplyResult = WorkOperationResult;

export const workProtocolRequestSchema = z.object({
  protocol: z.literal(WORK_PROTOCOL),
  version: z.literal(WORK_PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  operation: workOperationSchema,
}).strict().superRefine((request, context) => {
  if (utf8Bytes(JSON.stringify(request)) > WORK_PROTOCOL_REQUEST_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `A work protocol request must be at most ${WORK_PROTOCOL_REQUEST_MAX_BYTES} serialized UTF-8 bytes.`,
    });
  }
});
export type WorkProtocolRequest = z.infer<typeof workProtocolRequestSchema>;

export const workProtocolErrorCodeSchema = z.enum([
  "invalid_request",
  "not_found",
  "conflict",
  "fence_mismatch",
  "lease_expired",
  "not_owner",
  "route_mismatch",
  "invalid_state",
  "limit_exceeded",
  "effect_unknown",
  "internal",
]);

const workEntityIdSchema = z.union([
  workIdSchema,
  workTaskIdSchema,
  workAttemptIdSchema,
  workSubmissionIdSchema,
  workReviewIdSchema,
  workSignalIdSchema,
  sessionIdSchema,
]);

export const workProtocolErrorSchema = z.object({
  code: workProtocolErrorCodeSchema,
  message: boundedUtf8Text("Protocol error message", 2_048),
  retryable: z.boolean(),
  entityId: workEntityIdSchema.optional(),
  expectedRevision: revisionSchema.optional(),
  actualRevision: revisionSchema.optional(),
  retryAfterMs: z.number().int().min(0).max(WORK_LEASE_MAX_MS).optional(),
}).strict().superRefine((error, context) => {
  const hasExpected = error.expectedRevision !== undefined;
  const hasActual = error.actualRevision !== undefined;
  if (hasExpected !== hasActual) {
    context.addIssue({
      code: "custom",
      path: ["actualRevision"],
      message: "Revision conflicts must expose expected and actual revisions together.",
    });
  }
  if ((hasExpected || hasActual) && error.code !== "conflict") {
    context.addIssue({
      code: "custom",
      path: ["code"],
      message: "Only a conflict error may expose revision details.",
    });
  }
});
export type WorkProtocolError = z.infer<typeof workProtocolErrorSchema>;

export const workProtocolResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    protocol: z.literal(WORK_PROTOCOL),
    version: z.literal(WORK_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    result: workOperationResultSchema,
  }).strict(),
  z.object({
    protocol: z.literal(WORK_PROTOCOL),
    version: z.literal(WORK_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    ok: z.literal(false),
    error: workProtocolErrorSchema,
  }).strict(),
]);
export type WorkProtocolResponse = z.infer<typeof workProtocolResponseSchema>;

export const WORK_OPERATION_KINDS = [
  "work.create",
  "task.addBatch",
  "work.join",
  "task.claim",
  "task.claimNext",
  "task.claimBatch",
  "attempt.renew",
  "attempt.release",
  "attempt.dispatch",
  "attempt.report",
  "submission.review",
  "signal.send",
  "signal.ack",
  "work.complete",
  "work.fail",
  "work.cancel",
  "work.release",
  "attempt.reconcile",
] as const;

export const workOperationKindSchema = z.enum(WORK_OPERATION_KINDS);
export type WorkOperationKind = z.infer<typeof workOperationKindSchema>;

const workProtocolFieldNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/u);
const workProtocolShapeVariantSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]*$/u),
  required: z.array(workProtocolFieldNameSchema).min(1).max(16),
  optional: z.array(workProtocolFieldNameSchema).max(8),
}).strict();
const workOperationContractSchema = z.object({
  kind: workOperationKindSchema,
  required: z.array(workProtocolFieldNameSchema).min(2).max(20),
  optional: z.array(workProtocolFieldNameSchema).max(8),
  result: z.array(workProtocolFieldNameSchema).min(3).max(16),
}).strict().superRefine((contract, context) => {
  if (new Set(contract.required).size !== contract.required.length) {
    context.addIssue({ code: "custom", path: ["required"], message: "Required fields must be unique." });
  }
  if (new Set(contract.optional).size !== contract.optional.length) {
    context.addIssue({ code: "custom", path: ["optional"], message: "Optional fields must be unique." });
  }
  if (contract.optional.some((field) => contract.required.includes(field))) {
    context.addIssue({ code: "custom", path: ["optional"], message: "Optional and required fields must be disjoint." });
  }
});

const workOperationContractsSchema = z.array(workOperationContractSchema)
  .length(WORK_OPERATION_KINDS.length)
  .superRefine((contracts, context) => {
    const kinds = new Set(contracts.map((contract) => contract.kind));
    if (
      kinds.size !== WORK_OPERATION_KINDS.length
      || WORK_OPERATION_KINDS.some((kind) => !kinds.has(kind))
    ) {
      context.addIssue({ code: "custom", message: "Operation contracts must cover every operation exactly once." });
    }
  });

const mutationResultFields = ["kind", "workId", "workRevision"] as const;
export const WORK_OPERATION_CONTRACTS = workOperationContractsSchema.parse([
  { kind: "work.create", required: ["kind", "idempotencyKey", "clientRef", "coordinatorSessionId", "objective", "routes", "tasks"], optional: [], result: [...mutationResultFields, "work", "routes", "tasks", "coordinatorCapability", "memberCapability"] },
  { kind: "task.addBatch", required: ["kind", "idempotencyKey", "workId", "expectedWorkRevision", "coordinatorSessionId", "coordinatorCapability", "tasks"], optional: [], result: [...mutationResultFields, "tasks"] },
  { kind: "work.join", required: ["kind", "idempotencyKey", "workId", "coordinatorSessionId", "coordinatorCapability", "actorSessionId"], optional: [], result: [...mutationResultFields, "actorSessionId", "memberCapability"] },
  { kind: "task.claim", required: ["kind", "idempotencyKey", "workId", "taskId", "expectedTaskRevision", "actorSessionId", "actorCapability", "leaseMs"], optional: [], result: [...mutationResultFields, "task", "attempt", "attemptCapability"] },
  { kind: "task.claimNext", required: ["kind", "idempotencyKey", "workId", "actorSessionId", "actorCapability", "route", "leaseMs"], optional: [], result: [...mutationResultFields, "task", "attempt", "attemptCapability"] },
  { kind: "task.claimBatch", required: ["kind", "idempotencyKey", "workId", "claims"], optional: [], result: [...mutationResultFields, "claims"] },
  { kind: "attempt.renew", required: ["kind", "idempotencyKey", "workId", "attemptId", "expectedAttemptRevision", "fence", "actorSessionId", "attemptCapability", "leaseMs"], optional: [], result: [...mutationResultFields, "attempt"] },
  { kind: "attempt.release", required: ["kind", "idempotencyKey", "workId", "attemptId", "expectedAttemptRevision", "fence", "actorSessionId", "attemptCapability", "reason"], optional: [], result: [...mutationResultFields, "attempt"] },
  { kind: "attempt.dispatch", required: ["kind", "idempotencyKey", "workId", "attemptId", "expectedAttemptRevision", "fence", "actorSessionId", "attemptCapability", "targetSessionId", "mode"], optional: [], result: [...mutationResultFields, "attempt", "effect"] },
  { kind: "attempt.report", required: ["kind", "idempotencyKey", "workId", "attemptId", "expectedAttemptRevision", "fence", "actorSessionId", "attemptCapability", "report"], optional: [], result: [...mutationResultFields, "attempt", "submission"] },
  { kind: "submission.review", required: ["kind", "idempotencyKey", "workId", "submissionId", "expectedSubmissionRevision", "expectedContentDigest", "reviewerSessionId", "reviewerCapability", "review"], optional: [], result: [...mutationResultFields, "submission", "review"] },
  { kind: "signal.send", required: ["kind", "idempotencyKey", "workId", "senderSessionId", "senderCapability", "targetSessionId", "mode", "body"], optional: ["taskId", "replyToSignalId"], result: [...mutationResultFields, "signal", "effect"] },
  { kind: "signal.ack", required: ["kind", "idempotencyKey", "workId", "signalId", "expectedSignalRevision", "actorSessionId", "actorCapability"], optional: [], result: [...mutationResultFields, "signal"] },
  { kind: "work.complete", required: ["kind", "idempotencyKey", "workId", "expectedWorkRevision", "actorSessionId", "coordinatorCapability", "summary", "evidence"], optional: ["result"], result: [...mutationResultFields, "work"] },
  { kind: "work.fail", required: ["kind", "idempotencyKey", "workId", "expectedWorkRevision", "actorSessionId", "coordinatorCapability", "summary", "evidence"], optional: [], result: [...mutationResultFields, "work"] },
  { kind: "work.cancel", required: ["kind", "idempotencyKey", "workId", "expectedWorkRevision", "actorSessionId", "coordinatorCapability", "summary", "evidence"], optional: [], result: [...mutationResultFields, "work"] },
  { kind: "work.release", required: ["kind", "idempotencyKey", "workId", "expectedWorkRevision", "actorSessionId", "coordinatorCapability", "acknowledgeDataLoss"], optional: [], result: [...mutationResultFields, "tombstone"] },
  { kind: "attempt.reconcile", required: ["kind", "idempotencyKey", "workId", "attemptId", "expectedAttemptRevision", "fence", "actorSessionId", "attemptCapability", "outcome"], optional: [], result: [...mutationResultFields, "attempt", "submission"] },
]);

const WORK_PROTOCOL_SHAPES = {
  request: {
    required: ["protocol", "version", "requestId", "operation"],
    optional: [],
  },
  executionRoute: {
    required: ["accountId", "projectId", "preset", "fast"],
    optional: [],
  },
  task: {
    required: ["clientRef", "dependsOnRefs", "dependsOnTaskIds", "objective", "instructions", "criteria", "route", "preset", "fast", "priority", "maxAttempts", "requiredReviews", "resultKind", "minEvidence"],
    optional: ["parentRef", "parentTaskId", "notBefore", "claimBy", "deadline"],
  },
  claim: {
    required: ["taskId", "expectedTaskRevision", "actorSessionId", "actorCapability", "leaseMs"],
    optional: [],
  },
  evidence: [
    { kind: "session", required: ["kind", "sessionId"], optional: [] },
    { kind: "turn", required: ["kind", "sessionId", "turnId"], optional: [] },
    { kind: "artifact", required: ["kind", "projectId", "path", "bytes", "sha256"], optional: [] },
    { kind: "git_commit", required: ["kind", "projectId", "commit"], optional: [] },
  ],
  report: [
    { kind: "checkpoint", required: ["kind", "summary", "evidence"], optional: [] },
    { kind: "submit", required: ["kind", "summary", "result", "evidence"], optional: [] },
    { kind: "blocked", required: ["kind", "summary", "evidence"], optional: ["retryAt"] },
    { kind: "failed", required: ["kind", "summary", "retryable", "evidence"], optional: [] },
    { kind: "unknown", required: ["kind", "summary", "evidence"], optional: [] },
  ],
  review: [
    { kind: "accept", required: ["decision", "summary", "evidence"], optional: [] },
    { kind: "revise", required: ["decision", "feedback", "evidence"], optional: [] },
    { kind: "reject", required: ["decision", "summary", "evidence"], optional: [] },
  ],
  result: [
    { kind: "text", required: ["kind", "text"], optional: [] },
    { kind: "json", required: ["kind", "value"], optional: [] },
  ],
};

export const workProtocolDescriptionSchema = z.object({
  protocol: z.literal(WORK_PROTOCOL),
  version: z.literal(WORK_PROTOCOL_VERSION),
  wire: z.object({
    applyArgv: z.tuple([
      z.literal("hra"),
      z.literal("work"),
      z.literal("apply"),
      z.literal("--input-stdin"),
    ]),
    input: z.literal("versioned_json_request"),
    output: z.literal("versioned_json_response"),
    streaming: z.literal("jsonl"),
  }).strict(),
  valueSyntax: z.object({
    idempotencyKey: z.literal("canonical_uuidv7"),
    capability: z.literal("hrac1_base64url_256bit"),
    entityId: z.literal("typed_prefix_plus_32_lower_hex"),
    revision: z.literal("positive_safe_integer"),
    fence: z.literal("positive_safe_integer"),
    time: z.literal("unix_milliseconds"),
    digest: z.literal("lower_hex_sha256"),
  }).strict(),
  shapes: z.object({
    request: workProtocolShapeVariantSchema.omit({ kind: true }),
    executionRoute: workProtocolShapeVariantSchema.omit({ kind: true }),
    task: workProtocolShapeVariantSchema.omit({ kind: true }),
    claim: workProtocolShapeVariantSchema.omit({ kind: true }),
    evidence: z.array(workProtocolShapeVariantSchema).length(4),
    report: z.array(workProtocolShapeVariantSchema).length(5),
    review: z.array(workProtocolShapeVariantSchema).length(3),
    result: z.array(workProtocolShapeVariantSchema).length(2),
  }).strict(),
  authority: z.object({
    actorIdentity: z.literal("session_capability"),
    routeIdentity: z.literal("account_project_preset_fast"),
    mutationConcurrency: z.literal("entity_revision"),
    attemptAuthority: z.literal("capability_lease_fence"),
    effectOrder: z.literal("request_atomic_begin_effect_provider"),
  }).strict(),
  retention: z.object({
    releaseTombstones: z.object({
      replay: z.literal("while_retained_only"),
      bounds: z.literal("count_age_bytes"),
      evictionOrder: z.literal("expired_then_oldest_release_time_work_id"),
    }).strict(),
  }).strict(),
  capabilities: z.object({
    atomicPlanCreate: z.literal(true),
    atomicTaskBatchAppend: z.literal(true),
    exactTaskClaim: z.literal(true),
    routeBoundNextClaim: z.literal(true),
    atomicAttemptBatchClaim: z.literal(true),
    parallelEntityMutations: z.literal(true),
    renewableLeases: z.literal(true),
    sendOnlyAttemptDispatch: z.literal(true),
    durableSignalQueue: z.literal(true),
    activeSignalSteering: z.literal(true),
    evidenceBoundSubmissions: z.literal(true),
    verifiedEvidenceReferences: z.literal(true),
    adversarialReview: z.literal(true),
    unknownEffectReconciliation: z.literal(true),
    requestBeforeEffectFencing: z.literal(true),
    capabilityScopedMutations: z.literal(true),
    separateClaimAndCompletionCutoffs: z.literal(true),
    opaqueCursorPolling: z.literal(true),
    actionCursorPagination: z.literal(true),
    explicitHistoryRelease: z.literal(true),
  }).strict(),
  limits: z.object({
    activeWorks: z.literal(WORK_ACTIVE_LIMIT),
    retainedWorks: z.literal(WORK_RETAINED_LIMIT),
    releaseTombstones: z.literal(WORK_TOMBSTONE_LIMIT),
    releaseTombstoneBytes: z.literal(WORK_TOMBSTONE_MAX_BYTES),
    releaseTombstoneMaxAgeMs: z.literal(WORK_TOMBSTONE_MAX_AGE_MS),
    planTasks: z.literal(WORK_PLAN_TASK_LIMIT),
    membersPerWork: z.literal(WORK_MEMBER_LIMIT),
    routesPerWork: z.literal(WORK_ROUTE_LIMIT),
    historyEventsPerWork: z.literal(WORK_HISTORY_EVENT_LIMIT),
    historyRecoveryReservePerWork: z.literal(WORK_HISTORY_RECOVERY_RESERVE),
    effectResolutionsPerWork: z.literal(WORK_EFFECT_RESOLUTION_LIMIT),
    operationTasks: z.literal(WORK_OPERATION_BATCH_LIMIT),
    taskDependencies: z.literal(WORK_TASK_DEPENDENCY_LIMIT),
    taskDepth: z.literal(WORK_TASK_DEPTH_LIMIT),
    criteria: z.literal(WORK_CRITERIA_LIMIT),
    criteriaBytes: z.literal(WORK_CRITERIA_MAX_BYTES),
    evidence: z.literal(WORK_EVIDENCE_LIMIT),
    inlineResultBytes: z.literal(WORK_INLINE_RESULT_MAX_BYTES),
    artifactPathBytes: z.literal(WORK_ARTIFACT_PATH_MAX_BYTES),
    artifactBytes: z.literal(WORK_ARTIFACT_MAX_BYTES),
    operationBytes: z.literal(WORK_OPERATION_MAX_BYTES),
    protocolRequestBytes: z.literal(WORK_PROTOCOL_REQUEST_MAX_BYTES),
    preparedEffectBytes: z.literal(WORK_PREPARED_EFFECT_MAX_BYTES),
    workerBriefBytes: z.literal(WORK_WORKER_BRIEF_MAX_BYTES),
    dependencyPreviewBytes: z.literal(WORK_DEPENDENCY_PREVIEW_MAX_BYTES),
    signalBytes: z.literal(WORK_SIGNAL_MAX_BYTES),
    jsonDepth: z.literal(WORK_JSON_DEPTH_LIMIT),
    jsonNodes: z.literal(WORK_JSON_NODE_LIMIT),
    eventPageEvents: z.literal(WORK_EVENT_PAGE_LIMIT),
    pollItems: z.literal(WORK_POLL_ITEM_LIMIT),
    readHistoryItems: z.literal(WORK_READ_HISTORY_LIMIT),
    snapshotBytes: z.literal(WORK_SNAPSHOT_MAX_BYTES),
    taskDetailBytes: z.literal(WORK_TASK_DETAIL_MAX_BYTES),
    taskHistoryItems: z.literal(WORK_TASK_HISTORY_ITEM_LIMIT),
    taskHistoryPageBytes: z.literal(WORK_TASK_HISTORY_PAGE_MAX_BYTES),
    taskHistoryMembershipPerWork: z.literal(WORK_TASK_HISTORY_MEMBERSHIP_LIMIT),
    taskHistoryVersionsPerWork: z.literal(WORK_TASK_HISTORY_VERSION_LIMIT),
    pollBytes: z.literal(WORK_POLL_MAX_BYTES),
    eventPageBytes: z.literal(WORK_EVENT_PAGE_MAX_BYTES),
    eventStreamLineBytes: z.literal(WORK_EVENT_STREAM_LINE_MAX_BYTES),
    streamFailureBytes: z.literal(WORK_STREAM_FAILURE_MAX_BYTES),
    waitMs: z.literal(WORK_WAIT_MAX_MS),
    concurrentWaiters: z.literal(WORK_WAITER_LIMIT),
    leaseMinMs: z.literal(WORK_LEASE_MIN_MS),
    leaseMaxMs: z.literal(WORK_LEASE_MAX_MS),
  }).strict(),
  operations: z.array(workOperationKindSchema).length(WORK_OPERATION_KINDS.length),
  contracts: workOperationContractsSchema,
}).strict().superRefine((description, context) => {
  const advertised = new Set(description.operations);
  if (
    advertised.size !== WORK_OPERATION_KINDS.length
    || WORK_OPERATION_KINDS.some((kind) => !advertised.has(kind))
  ) {
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "Protocol descriptions must advertise every operation exactly once.",
    });
  }
  if (description.contracts.some((contract, index) => contract.kind !== description.operations[index])) {
    context.addIssue({
      code: "custom",
      path: ["contracts"],
      message: "Operation contracts must follow the advertised operation order.",
    });
  }
});
export type WorkProtocolDescription = z.infer<typeof workProtocolDescriptionSchema>;

export const WORK_PROTOCOL_DESCRIPTION: WorkProtocolDescription = {
  protocol: WORK_PROTOCOL,
  version: WORK_PROTOCOL_VERSION,
  wire: {
    applyArgv: ["hra", "work", "apply", "--input-stdin"],
    input: "versioned_json_request",
    output: "versioned_json_response",
    streaming: "jsonl",
  },
  valueSyntax: {
    idempotencyKey: "canonical_uuidv7",
    capability: "hrac1_base64url_256bit",
    entityId: "typed_prefix_plus_32_lower_hex",
    revision: "positive_safe_integer",
    fence: "positive_safe_integer",
    time: "unix_milliseconds",
    digest: "lower_hex_sha256",
  },
  shapes: WORK_PROTOCOL_SHAPES,
  authority: {
    actorIdentity: "session_capability",
    routeIdentity: "account_project_preset_fast",
    mutationConcurrency: "entity_revision",
    attemptAuthority: "capability_lease_fence",
    effectOrder: "request_atomic_begin_effect_provider",
  },
  retention: {
    releaseTombstones: {
      replay: "while_retained_only",
      bounds: "count_age_bytes",
      evictionOrder: "expired_then_oldest_release_time_work_id",
    },
  },
  capabilities: {
    atomicPlanCreate: true,
    atomicTaskBatchAppend: true,
    exactTaskClaim: true,
    routeBoundNextClaim: true,
    atomicAttemptBatchClaim: true,
    parallelEntityMutations: true,
    renewableLeases: true,
    sendOnlyAttemptDispatch: true,
    durableSignalQueue: true,
    activeSignalSteering: true,
    evidenceBoundSubmissions: true,
    verifiedEvidenceReferences: true,
    adversarialReview: true,
    unknownEffectReconciliation: true,
    requestBeforeEffectFencing: true,
    capabilityScopedMutations: true,
    separateClaimAndCompletionCutoffs: true,
    opaqueCursorPolling: true,
    actionCursorPagination: true,
    explicitHistoryRelease: true,
  },
  limits: {
    activeWorks: WORK_ACTIVE_LIMIT,
    retainedWorks: WORK_RETAINED_LIMIT,
    releaseTombstones: WORK_TOMBSTONE_LIMIT,
    releaseTombstoneBytes: WORK_TOMBSTONE_MAX_BYTES,
    releaseTombstoneMaxAgeMs: WORK_TOMBSTONE_MAX_AGE_MS,
    planTasks: WORK_PLAN_TASK_LIMIT,
    membersPerWork: WORK_MEMBER_LIMIT,
    routesPerWork: WORK_ROUTE_LIMIT,
    historyEventsPerWork: WORK_HISTORY_EVENT_LIMIT,
    historyRecoveryReservePerWork: WORK_HISTORY_RECOVERY_RESERVE,
    effectResolutionsPerWork: WORK_EFFECT_RESOLUTION_LIMIT,
    operationTasks: WORK_OPERATION_BATCH_LIMIT,
    taskDependencies: WORK_TASK_DEPENDENCY_LIMIT,
    taskDepth: WORK_TASK_DEPTH_LIMIT,
    criteria: WORK_CRITERIA_LIMIT,
    criteriaBytes: WORK_CRITERIA_MAX_BYTES,
    evidence: WORK_EVIDENCE_LIMIT,
    inlineResultBytes: WORK_INLINE_RESULT_MAX_BYTES,
    artifactPathBytes: WORK_ARTIFACT_PATH_MAX_BYTES,
    artifactBytes: WORK_ARTIFACT_MAX_BYTES,
    operationBytes: WORK_OPERATION_MAX_BYTES,
    protocolRequestBytes: WORK_PROTOCOL_REQUEST_MAX_BYTES,
    preparedEffectBytes: WORK_PREPARED_EFFECT_MAX_BYTES,
    workerBriefBytes: WORK_WORKER_BRIEF_MAX_BYTES,
    dependencyPreviewBytes: WORK_DEPENDENCY_PREVIEW_MAX_BYTES,
    signalBytes: WORK_SIGNAL_MAX_BYTES,
    jsonDepth: WORK_JSON_DEPTH_LIMIT,
    jsonNodes: WORK_JSON_NODE_LIMIT,
    eventPageEvents: WORK_EVENT_PAGE_LIMIT,
    pollItems: WORK_POLL_ITEM_LIMIT,
    readHistoryItems: WORK_READ_HISTORY_LIMIT,
    snapshotBytes: WORK_SNAPSHOT_MAX_BYTES,
    taskDetailBytes: WORK_TASK_DETAIL_MAX_BYTES,
    taskHistoryItems: WORK_TASK_HISTORY_ITEM_LIMIT,
    taskHistoryPageBytes: WORK_TASK_HISTORY_PAGE_MAX_BYTES,
    taskHistoryMembershipPerWork: WORK_TASK_HISTORY_MEMBERSHIP_LIMIT,
    taskHistoryVersionsPerWork: WORK_TASK_HISTORY_VERSION_LIMIT,
    pollBytes: WORK_POLL_MAX_BYTES,
    eventPageBytes: WORK_EVENT_PAGE_MAX_BYTES,
    eventStreamLineBytes: WORK_EVENT_STREAM_LINE_MAX_BYTES,
    streamFailureBytes: WORK_STREAM_FAILURE_MAX_BYTES,
    waitMs: WORK_WAIT_MAX_MS,
    concurrentWaiters: WORK_WAITER_LIMIT,
    leaseMinMs: WORK_LEASE_MIN_MS,
    leaseMaxMs: WORK_LEASE_MAX_MS,
  },
  operations: [...WORK_OPERATION_KINDS],
  contracts: WORK_OPERATION_CONTRACTS,
};
