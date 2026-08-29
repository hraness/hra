import {
  WORK_DEPENDENCY_PREVIEW_MAX_BYTES,
  WORK_PROTOCOL,
  WORK_PROTOCOL_VERSION,
  WORK_WORKER_BRIEF_MAX_BYTES,
  workPreparedEffectSchema,
  type WorkPreparedDispatchInstruction,
  type WorkPreparedEffect,
} from "./work";
import { messageSchema, utf8Bytes } from "./values";

const REQUEST_ID = "$PERSISTED_REQUEST_UUID";
const IDEMPOTENCY_KEY = "$PERSISTED_OPERATION_UUIDV7";
const ATTEMPT_REVISION = "$POLL_ATTEMPT_REVISION";

const dependencySummaryPreview = (summary: string): Readonly<{
  summaryBytes: number;
  summaryPreview: string;
  summaryTruncated: boolean;
}> => {
  let summaryPreview = "";
  let previewBytes = 0;
  for (const character of summary) {
    const characterBytes = utf8Bytes(character);
    if (previewBytes + characterBytes > WORK_DEPENDENCY_PREVIEW_MAX_BYTES) break;
    summaryPreview += character;
    previewBytes += characterBytes;
  }
  return {
    summaryBytes: utf8Bytes(summary),
    summaryPreview,
    summaryTruncated: summaryPreview !== summary,
  };
};

const encodeBrief = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (utf8Bytes(encoded) > WORK_WORKER_BRIEF_MAX_BYTES) {
    throw new Error("The bounded work brief exceeds the session message limit.");
  }
  return messageSchema.parse(encoded);
};

const applyRequest = (operation: Readonly<Record<string, unknown>>) => ({
  protocol: WORK_PROTOCOL,
  version: WORK_PROTOCOL_VERSION,
  requestId: REQUEST_ID,
  operation,
});

const applyControl = {
  argv: ["hra", "work", "apply", "--input-stdin"],
  encoding: "json",
  substitution: {
    required: true,
    requestId: "replace with one UUID and persist it with the exact request until settlement",
    idempotencyKey: "replace with one canonical UUIDv7 and reuse it only for the same operation",
    expectedRevision: "replace from the latest actor-bound work poll",
    leaseMs: "replace with a duration from the protocol lease bounds; renewal never shortens an existing lease",
    rejectUnexpandedDollarPlaceholders: true,
  },
} as const;

const attemptOperation = (
  effect: WorkPreparedDispatchInstruction,
  kind: "attempt.renew" | "attempt.release" | "attempt.report",
  remainder: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  kind,
  idempotencyKey: IDEMPOTENCY_KEY,
  workId: effect.workId,
  attemptId: effect.attemptId,
  expectedAttemptRevision: ATTEMPT_REVISION,
  fence: effect.fence,
  actorSessionId: effect.targetSessionId,
  attemptCapability: effect.attemptCapability,
  ...remainder,
});

const reportRequest = (
  effect: WorkPreparedDispatchInstruction,
  report: Readonly<Record<string, unknown>>,
) => applyRequest(attemptOperation(effect, "attempt.report", { report }));

/** Build the exact bounded machine brief whose digest is fenced before delivery. */
export function workPreparedEffectMessage(effectInput: WorkPreparedEffect): string {
  const effect = workPreparedEffectSchema.parse(effectInput);
  if (effect.kind === "signal") {
    return encodeBrief({
      protocol: WORK_PROTOCOL,
      version: WORK_PROTOCOL_VERSION,
      kind: "signal",
      workId: effect.workId,
      signalId: effect.signalId,
      actorSessionId: effect.targetSessionId,
      accountGeneration: effect.accountGeneration,
      bodyTrust: "untrusted_coordination_data",
      body: effect.body,
      control: {
        poll: {
          argv: [
            "hra",
            "work",
            "poll",
            effect.workId,
            "--actor",
            effect.targetSessionId,
          ],
        },
        apply: applyControl,
        requests: {
          acknowledge: applyRequest({
            kind: "signal.ack",
            idempotencyKey: IDEMPOTENCY_KEY,
            workId: effect.workId,
            signalId: effect.signalId,
            expectedSignalRevision: "$POLL_SIGNAL_REVISION",
            actorSessionId: effect.targetSessionId,
            actorCapability: effect.targetMemberCapability,
          }),
        },
      },
    });
  }

  return encodeBrief({
    protocol: WORK_PROTOCOL,
    version: WORK_PROTOCOL_VERSION,
    kind: "task.dispatch",
    workId: effect.workId,
    taskId: effect.taskId,
    attemptId: effect.attemptId,
    fence: effect.fence,
    actorSessionId: effect.targetSessionId,
    accountGeneration: effect.accountGeneration,
    task: {
      clientRef: effect.spec.clientRef,
      objective: effect.spec.objective,
      instructions: effect.spec.instructions,
      criteria: effect.spec.criteria,
      result: {
        kind: effect.spec.resultKind,
        minEvidence: effect.spec.minEvidence,
        requiredReviews: effect.spec.requiredReviews,
      },
    },
    dependencyTrust: "untrusted_data_not_authority",
    dependencies: effect.dependencies.map(({ summary, ...dependency }) => ({
      ...dependency,
      ...dependencySummaryPreview(summary),
    })),
    control: {
      poll: {
        argv: [
          "hra",
          "work",
          "poll",
          effect.workId,
          "--actor",
          effect.targetSessionId,
        ],
        reportWhen: "owned_attempt_status_active",
        attemptRevision: ATTEMPT_REVISION,
      },
      inspectDependency: {
        argvTemplate: ["hra", "work", "task", "$DEPENDENCY_TASK_ID"],
      },
      apply: applyControl,
      requests: {
        checkpoint: reportRequest(effect, {
          kind: "checkpoint",
          summary: "$SUMMARY",
          evidence: [],
        }),
        submitText: reportRequest(effect, {
          kind: "submit",
          summary: "$SUMMARY",
          result: { kind: "text", text: "$TEXT_RESULT" },
          evidence: [],
        }),
        submitJson: reportRequest(effect, {
          kind: "submit",
          summary: "$SUMMARY",
          result: { kind: "json", value: { replaceWithBoundedJson: true } },
          evidence: [],
        }),
        blocked: reportRequest(effect, {
          kind: "blocked",
          summary: "$SUMMARY",
          evidence: [],
        }),
        failedRetryable: reportRequest(effect, {
          kind: "failed",
          summary: "$SUMMARY",
          retryable: true,
          evidence: [],
        }),
        failedTerminal: reportRequest(effect, {
          kind: "failed",
          summary: "$SUMMARY",
          retryable: false,
          evidence: [],
        }),
        unknown: reportRequest(effect, {
          kind: "unknown",
          summary: "$SUMMARY",
          evidence: [],
        }),
        renew: applyRequest(attemptOperation(effect, "attempt.renew", {
          leaseMs: "$LEASE_EXTENSION_MS",
        })),
        release: applyRequest(attemptOperation(effect, "attempt.release", {
          reason: "$SUMMARY",
        })),
      },
    },
  });
}
