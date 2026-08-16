import { expect, test } from "bun:test";
import {
  MAX_SERIALIZED_SUBMISSION_CONTENT_BYTES,
  MAX_SERIALIZED_SUBMISSION_ENVELOPE_BYTES,
  MAX_SUBMISSION_EVIDENCE,
  serializedSubmissionContentByteLength,
  submitTaskResponseSchema,
} from "@hraness/agent-tasks-protocol";

import { MAX_COMMAND_RECEIPT_BYTES } from "./model";

const utf8 = new TextEncoder();

test("the largest accepted submission response fits the shared receipt ceiling", () => {
  const evidence = Array.from({ length: MAX_SUBMISSION_EVIDENCE }, (_, index) => ({
    kind: "note" as const,
    text: `${index}\n${"x".repeat(4_000)}`,
  }));
  let summary = "s".repeat(16 * 1_024);
  while (
    serializedSubmissionContentByteLength({ summary, evidence }) >
    MAX_SERIALIZED_SUBMISSION_CONTENT_BYTES
  ) {
    summary = summary.slice(0, -1_024);
  }
  const response = submitTaskResponseSchema.parse({
    task: {
      id: `tsk_${"0".repeat(26)}`,
      key: "OPS-0000000",
      title: "t".repeat(512),
      type: "task",
      priority: 4,
      status: "in_review",
      availableAt: 0,
      isReady: false,
      unresolvedBlockerCount: 0,
      cancelledBlockerCount: 0,
      revision: 1,
      reviewRevision: 1,
      createdAt: 0,
      updatedAt: 0,
    },
    submission: {
      id: `sub_${"0".repeat(26)}`,
      taskKey: "OPS-0000000",
      submittedBy: { kind: "agent", agentId: `agt_${"0".repeat(26)}` },
      reviewRevision: 1,
      summary,
      evidence,
      status: "pending",
      submittedAt: 0,
    },
  });
  const responseBytes = utf8.encode(JSON.stringify(response)).length;
  expect(MAX_COMMAND_RECEIPT_BYTES).toBe(MAX_SERIALIZED_SUBMISSION_ENVELOPE_BYTES);
  expect(responseBytes).toBeLessThanOrEqual(MAX_COMMAND_RECEIPT_BYTES);
});
