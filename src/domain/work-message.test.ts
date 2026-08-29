import { describe, expect, test } from "bun:test";

import { messageSchema, utf8Bytes } from "./values";
import {
  WORK_DEPENDENCY_PREVIEW_MAX_BYTES,
  WORK_PROTOCOL,
  WORK_PROTOCOL_VERSION,
  WORK_TASK_DEPENDENCY_LIMIT,
  WORK_WORKER_BRIEF_MAX_BYTES,
  workPreparedEffectSchema,
  workProtocolRequestSchema,
  type WorkPreparedDispatchInstruction,
} from "./work";
import { workPreparedEffectMessage } from "./work-message";

const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;
const capability = `hrac1_${Buffer.alloc(32, 7).toString("base64url")}`;
const idempotencyKey = "018f1f64-6c17-7d35-8f8e-b24a1d3a5211";

const maximalDispatch = (): WorkPreparedDispatchInstruction =>
  workPreparedEffectSchema.parse({
    kind: "dispatch",
    workId: id("work", "1"),
    nestedMutationKey: idempotencyKey,
    taskId: id("task", "2"),
    attemptId: id("watt", "3"),
    attemptCapability: capability,
    fence: 9,
    accountGeneration: 4,
    targetSessionId: id("sess", "4"),
    mode: "send",
    spec: {
      clientRef: "maximal-task",
      dependsOnRefs: [],
      dependsOnTaskIds: Array.from(
        { length: WORK_TASK_DEPENDENCY_LIMIT },
        (_, index) => `task_${index.toString(16).padStart(32, "0")}`,
      ),
      objective: "\0".repeat(8 * 1024),
      instructions: "\0".repeat(16 * 1024),
      criteria: Array.from(
        { length: 16 },
        (_, index) => `${index.toString(16)}${"\0".repeat(299)}`,
      ),
      route: { accountId: id("acct", "5"), projectId: id("proj", "6") },
      preset: "high",
      fast: false,
      priority: 100,
      maxAttempts: 32,
      requiredReviews: 16,
      resultKind: "json",
      minEvidence: 16,
    },
    dependencies: Array.from({ length: WORK_TASK_DEPENDENCY_LIMIT }, (_, index) => ({
      taskId: `task_${index.toString(16).padStart(32, "0")}`,
      clientRef: `dependency-${index}`,
      submissionId: `sub_${index.toString(16).padStart(32, "0")}`,
      summary: "\0".repeat(8 * 1024),
      contentDigest: index.toString(16).padStart(64, "0"),
    })),
  }) as WorkPreparedDispatchInstruction;

describe("work machine briefs", () => {
  test("keeps the worst bounded dispatch inside the exact session message limit", () => {
    const message = workPreparedEffectMessage(maximalDispatch());
    expect(messageSchema.parse(message)).toBe(message);
    expect(utf8Bytes(message)).toBeLessThanOrEqual(WORK_WORKER_BRIEF_MAX_BYTES);

    const parsed = JSON.parse(message) as {
      dependencies: Array<{
        summaryBytes: number;
        summaryPreview: string;
        summaryTruncated: boolean;
      }>;
    };
    expect(parsed.dependencies).toHaveLength(WORK_TASK_DEPENDENCY_LIMIT);
    for (const dependency of parsed.dependencies) {
      expect(utf8Bytes(dependency.summaryPreview))
        .toBeLessThanOrEqual(WORK_DEPENDENCY_PREVIEW_MAX_BYTES);
      expect(dependency.summaryBytes).toBe(8 * 1024);
      expect(dependency.summaryTruncated).toBe(true);
    }
  });

  test("emits full versioned request templates with separate request and operation keys", () => {
    const message = workPreparedEffectMessage(maximalDispatch());
    const parsed = JSON.parse(message) as {
      control: {
        requests: Record<string, {
          protocol: string;
          version: number;
          requestId: string;
          operation: Record<string, unknown>;
        }>;
      };
    };
    expect(Object.keys(parsed.control.requests)).toEqual([
      "checkpoint",
      "submitText",
      "submitJson",
      "blocked",
      "failedRetryable",
      "failedTerminal",
      "unknown",
      "renew",
      "release",
    ]);
    for (const request of Object.values(parsed.control.requests)) {
      expect(request.protocol).toBe(WORK_PROTOCOL);
      expect(request.version).toBe(WORK_PROTOCOL_VERSION);
      expect(request.requestId).toBe("$PERSISTED_REQUEST_UUID");
      expect(request.operation.idempotencyKey).toBe("$PERSISTED_OPERATION_UUIDV7");
    }

    const checkpoint = structuredClone(parsed.control.requests.checkpoint);
    if (checkpoint === undefined) throw new Error("Missing checkpoint template.");
    checkpoint.requestId = crypto.randomUUID();
    checkpoint.operation.idempotencyKey = idempotencyKey;
    checkpoint.operation.expectedAttemptRevision = 7;
    const report = checkpoint.operation.report as Record<string, unknown>;
    report.summary = "durable checkpoint";
    expect(workProtocolRequestSchema.parse(checkpoint).operation.kind).toBe("attempt.report");
  });
});
