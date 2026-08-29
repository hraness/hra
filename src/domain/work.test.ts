import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import {
  WORK_ACTIVE_LIMIT,
  WORK_CRITERIA_LIMIT,
  WORK_EFFECT_RESOLUTION_LIMIT,
  WORK_EVENT_PAGE_LIMIT,
  WORK_EVENT_PAGE_MAX_BYTES,
  WORK_EVIDENCE_LIMIT,
  WORK_INLINE_RESULT_MAX_BYTES,
  WORK_HISTORY_EVENT_LIMIT,
  WORK_HISTORY_RECOVERY_RESERVE,
  WORK_JSON_DEPTH_LIMIT,
  WORK_JSON_NODE_LIMIT,
  WORK_LEASE_MAX_MS,
  WORK_LEASE_MIN_MS,
  WORK_MEMBER_LIMIT,
  WORK_OPERATION_BATCH_LIMIT,
  WORK_OPERATION_CONTRACTS,
  WORK_PLAN_TASK_LIMIT,
  WORK_PROTOCOL_DESCRIPTION,
  WORK_RETAINED_LIMIT,
  WORK_SIGNAL_MAX_BYTES,
  WORK_TASK_DETAIL_MAX_BYTES,
  WORK_TASK_HISTORY_MEMBERSHIP_LIMIT,
  WORK_TASK_HISTORY_ITEM_LIMIT,
  WORK_TASK_DEPENDENCY_LIMIT,
  WORK_TASK_DEPTH_LIMIT,
  WORK_TOMBSTONE_LIMIT,
  WORK_TOMBSTONE_MAX_AGE_MS,
  WORK_TOMBSTONE_MAX_BYTES,
  WORK_WAIT_MAX_MS,
  createWorkAttemptId,
  createWorkId,
  createWorkReviewId,
  createWorkSignalId,
  createWorkSubmissionId,
  createWorkTaskId,
  isBoundedWorkJsonValue,
  workAttemptIdSchema,
  workCapabilitySchema,
  workEventCursorPayloadSchema,
  workEventCursorWireSchema,
  workEventPageSchema,
  workEvidenceListSchema,
  workIdSchema,
  workJsonValueSchema,
  workOperationSchema,
  workOperationKindSchema,
  workPollSchema,
  workPollRequestSchema,
  workPreparedEffectStatusSchema,
  workProtocolDescriptionSchema,
  workProtocolRequestSchema,
  workProtocolResponseSchema,
  workReleaseTombstoneSchema,
  workResultSchema,
  workReviewIdSchema,
  workSignalIdSchema,
  workSignalRecordSchema,
  workSnapshotSchema,
  workSubmissionIdSchema,
  workTaskBatchSchema,
  workTaskIdSchema,
  workTaskDetailSchema,
  workTaskHistoryCursorPayloadSchema,
  workTaskHistoryPageSchema,
  workTaskSpecSchema,
  type WorkEvent,
  type WorkTaskSpec,
} from "./work";

const hexId = (prefix: string, index = 0): string =>
  `${prefix}_${index.toString(16).padStart(32, "0")}`;

const workId = hexId("work", 1);
const taskId = hexId("task", 1);
const attemptId = hexId("watt", 1);
const submissionId = hexId("sub", 1);
const reviewId = hexId("review", 1);
const signalId = hexId("sig", 1);
const accountId = hexId("acct", 1);
const projectId = hexId("proj", 1);
const actorSessionId = hexId("sess", 1);
const targetSessionId = hexId("sess", 2);
const idempotencyKey = "018f1f64-6c17-7d35-8f8e-b24a1d3a5211";
const streamEpoch = "018f1f64-6c17-7d35-8f8e-b24a1d3a5222";
const cursor0 = `hra1.AA.${"A".repeat(43)}`;
const cursor1 = `hra1.AQ.${"A".repeat(43)}`;
const capability = `hrac1_${"A".repeat(43)}`;

const taskSpec = (
  clientRef = "task-1",
  overrides: Partial<WorkTaskSpec> = {},
): WorkTaskSpec => ({
  clientRef,
  dependsOnRefs: [],
  dependsOnTaskIds: [],
  objective: `Complete ${clientRef}`,
  instructions: "Make the smallest verified change.",
  criteria: ["Tests pass"],
  route: { accountId, projectId },
  preset: "low",
  fast: false,
  priority: 0,
  maxAttempts: 3,
  requiredReviews: 1,
  resultKind: "text",
  minEvidence: 1,
  ...overrides,
});

const taskSummary = (index: number) => ({
  id: hexId("task", index + 1),
  clientRef: `task-${index + 1}`,
  status: "waiting" as const,
  revision: 1,
  route: { accountId, projectId },
  preset: "low" as const,
  fast: false,
  priority: 0,
  depth: 1,
  attemptCount: 0,
  activeAttemptId: null,
  latestSubmissionId: null,
});

const minimalEvent = (sequence: number): WorkEvent => ({
  version: 1,
  workId,
  streamEpoch,
  sequence,
  occurredAt: sequence,
  actorSessionId: null,
  body: {
    type: "task.state_changed",
    taskId,
    from: "waiting",
    to: "ready",
  },
});

const eventPage = (events: readonly WorkEvent[]) => ({
  version: 1 as const,
  workId,
  streamEpoch,
  requestedCursor: cursor0,
  retentionFloorCursor: cursor0,
  observedThroughCursor: events.length === 0 ? cursor0 : cursor1,
  nextCursor: events.length === 0 ? cursor0 : cursor1,
  gap: null,
  events,
});

describe("work identifiers", () => {
  test("uses closed prefixes and exactly 32 lowercase hexadecimal digits", () => {
    const generated = [
      [createWorkId(), workIdSchema],
      [createWorkTaskId(), workTaskIdSchema],
      [createWorkAttemptId(), workAttemptIdSchema],
      [createWorkSubmissionId(), workSubmissionIdSchema],
      [createWorkReviewId(), workReviewIdSchema],
      [createWorkSignalId(), workSignalIdSchema],
    ] as const;

    for (const [value, schema] of generated) expect(schema.safeParse(value).success).toBe(true);
    expect(workIdSchema.safeParse(`work_${"A".repeat(32)}`).success).toBe(false);
    expect(workTaskIdSchema.safeParse(`task_${"a".repeat(31)}`).success).toBe(false);
    expect(workAttemptIdSchema.safeParse(`attempt_${"a".repeat(32)}`).success).toBe(false);
  });

  test("accepts only canonical opaque 256-bit work capabilities", () => {
    expect(workCapabilitySchema.safeParse(capability).success).toBe(true);
    expect(workCapabilitySchema.safeParse(`hrac1_${"A".repeat(42)}`).success).toBe(false);
    expect(workCapabilitySchema.safeParse(`hrac1_${"A".repeat(42)}B`).success).toBe(false);
    expect(workCapabilitySchema.safeParse(`other1_${"A".repeat(43)}`).success).toBe(false);
  });
});

describe("task plans", () => {
  test("requires the exact account/project route and rejects unknown fields", () => {
    expect(workTaskSpecSchema.safeParse(taskSpec()).success).toBe(true);
    const withoutRoute: Record<string, unknown> = { ...taskSpec() };
    delete withoutRoute.route;
    expect(workTaskSpecSchema.safeParse(withoutRoute).success).toBe(false);
    expect(workTaskSpecSchema.safeParse({ ...taskSpec(), accountId }).success).toBe(false);
    expect(workTaskSpecSchema.safeParse({
      ...taskSpec(),
      route: { accountId, projectId, label: "ambiguous" },
    }).success).toBe(false);
  });

  test("requires dependency and criteria arrays on the strict agent wire", () => {
    for (const field of ["dependsOnRefs", "dependsOnTaskIds", "criteria"] as const) {
      const candidate: Record<string, unknown> = { ...taskSpec(), [field]: undefined };
      expect(workTaskSpecSchema.safeParse(candidate).success).toBe(false);
    }
  });

  test("keeps claim admission and completion deadlines distinct and ordered", () => {
    expect(workTaskSpecSchema.safeParse(taskSpec("timed", {
      notBefore: 100,
      claimBy: 200,
      deadline: 300,
    })).success).toBe(true);
    expect(workTaskSpecSchema.safeParse(taskSpec("claim-before-start", {
      notBefore: 200,
      claimBy: 200,
    })).success).toBe(false);
    expect(workTaskSpecSchema.safeParse(taskSpec("deadline-before-claim", {
      claimBy: 300,
      deadline: 299,
    })).success).toBe(false);
  });

  test("enforces atomic batch and complete-plan bounds", () => {
    const maximumBatch = Array.from(
      { length: WORK_OPERATION_BATCH_LIMIT },
      (_, index) => taskSpec(`task-${index}`),
    );
    expect(workTaskBatchSchema.safeParse(maximumBatch).success).toBe(true);
    expect(workTaskBatchSchema.safeParse([
      ...maximumBatch,
      taskSpec("one-too-many"),
    ]).success).toBe(false);

    const maximumPlan = Array.from({ length: WORK_PLAN_TASK_LIMIT }, (_, index) =>
      taskSummary(index));
    const snapshot = {
      version: 1,
      work: {
        id: workId,
        clientRef: "plan",
        coordinatorSessionId: actorSessionId,
        objective: "Complete the plan",
        status: "open",
        revision: 1,
        taskCount: WORK_PLAN_TASK_LIMIT,
        waitingTaskCount: WORK_PLAN_TASK_LIMIT,
        readyTaskCount: 0,
        activeTaskCount: 0,
        completedTaskCount: 0,
        failedTaskCount: 0,
        cancelledTaskCount: 0,
        createdAt: 1,
        updatedAt: 1,
        terminalAt: null,
      },
      routes: [{ accountId, projectId, preset: "low", fast: false }],
      cursor: cursor0,
      tasks: maximumPlan,
      joinedSessionIds: [actorSessionId],
      recentSignals: [],
      omittedSignals: 0,
      terminal: null,
    };
    expect(workSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(workSnapshotSchema.safeParse({
      ...snapshot,
      work: { ...snapshot.work, taskCount: WORK_PLAN_TASK_LIMIT + 1 },
      tasks: [...maximumPlan, taskSummary(WORK_PLAN_TASK_LIMIT)],
    }).success).toBe(false);
  });

  test("bounds combined dependencies and prevents duplicate or self references", () => {
    const references = Array.from(
      { length: WORK_TASK_DEPENDENCY_LIMIT },
      (_, index) => `ref-${index}`,
    );
    const identifiers = Array.from(
      { length: WORK_TASK_DEPENDENCY_LIMIT },
      (_, index) => hexId("task", index + 20),
    );
    expect(workTaskSpecSchema.safeParse(taskSpec("subject", {
      dependsOnRefs: references.slice(0, 8),
      dependsOnTaskIds: identifiers.slice(0, 8),
    })).success).toBe(true);
    expect(workTaskSpecSchema.safeParse(taskSpec("subject", {
      dependsOnRefs: references.slice(0, 9),
      dependsOnTaskIds: identifiers.slice(0, 8),
    })).success).toBe(false);
    expect(workTaskSpecSchema.safeParse(taskSpec("subject", {
      dependsOnRefs: ["subject"],
    })).success).toBe(false);
    expect(workTaskSpecSchema.safeParse(taskSpec("subject", {
      dependsOnTaskIds: [taskId, taskId],
    })).success).toBe(false);
  });

  test("accepts depth eight and rejects depth nine and cycles on atomic create", () => {
    const chain = (length: number) => Array.from({ length }, (_, index) => taskSpec(
      `node-${index}`,
      index === 0 ? {} : { dependsOnRefs: [`node-${index - 1}`] },
    ));
    const operation = (tasks: readonly WorkTaskSpec[]) => ({
      kind: "work.create",
      idempotencyKey,
      clientRef: "plan",
      coordinatorSessionId: actorSessionId,
      objective: "Execute a bounded DAG",
      routes: [{ accountId, projectId, preset: "low", fast: false }],
      tasks,
    });
    expect(workOperationSchema.safeParse(operation(chain(WORK_TASK_DEPTH_LIMIT))).success)
      .toBe(true);
    expect(workOperationSchema.safeParse(operation(chain(WORK_TASK_DEPTH_LIMIT + 1))).success)
      .toBe(false);
    expect(workOperationSchema.safeParse(operation([
      taskSpec("a", { dependsOnRefs: ["b"] }),
      taskSpec("b", { dependsOnRefs: ["a"] }),
    ])).success).toBe(false);
  });
});

describe("durable work read projections", () => {
  const attempt = {
    id: attemptId,
    taskId,
    actorSessionId,
    accountGeneration: 1,
    status: "submitted" as const,
    revision: 1,
    fence: 1,
    leaseExpiresAt: null,
    targetSessionId: actorSessionId,
    dispatchMode: "send" as const,
    dispatchReceipt: {
      kind: "turn_started" as const,
      mutationAttemptId: hexId("attempt", 1),
      accountGeneration: 1,
      turnId: `opaque_v2_${"a".repeat(64)}`,
      runtimeProfileDigest: "b".repeat(64),
    },
    submissionId,
    createdAt: 1,
    updatedAt: 2,
  };
  const submission = {
    id: submissionId,
    taskId,
    attemptId,
    status: "pending_review" as const,
    revision: 1,
    summary: "Ready for review",
    result: { kind: "text" as const, text: "done" },
    evidence: [],
    contentDigest: "c".repeat(64),
    requiredReviews: 1,
    acceptedReviews: 0,
    createdAt: 2,
    updatedAt: 2,
  };
  const detail = {
    version: 1 as const,
    workId,
    task: {
      ...taskSummary(0),
      status: "submitted" as const,
      attemptCount: 1,
      activeAttemptId: attemptId,
      latestSubmissionId: submissionId,
    },
    spec: taskSpec(),
    parentTaskId: null,
    dependencyTaskIds: [],
    unmetDependencyTaskIds: [],
    activeAttempt: attempt,
    latestAttempt: attempt,
    latestAttemptReport: {
      idempotencyKey,
      taskId,
      attemptId,
      reportKind: "submit" as const,
      report: {
        kind: "submit" as const,
        summary: "Ready for review",
        result: { kind: "text" as const, text: "done" },
        evidence: [],
      },
      reportDigest: "d".repeat(64),
      createdAt: 2,
    },
    latestSubmission: submission,
    latestSubmissionReviews: [],
    omittedLatestSubmissionReviews: 0,
    recentSignals: [],
    omittedSignals: 0,
    createdAt: 1,
    updatedAt: 2,
  };

  test("cross-binds attempts, reports, and submissions to the exact task lineage", () => {
    expect(workTaskDetailSchema.safeParse(detail).success).toBe(true);
    expect(workTaskDetailSchema.safeParse({
      ...detail,
      latestAttemptReport: { ...detail.latestAttemptReport, taskId: hexId("task", 2) },
    }).success).toBe(false);
    expect(workTaskDetailSchema.safeParse({
      ...detail,
      latestSubmission: { ...submission, taskId: hexId("task", 2) },
    }).success).toBe(false);
    expect(workTaskDetailSchema.safeParse({
      ...detail,
      task: { ...detail.task, latestSubmissionId: hexId("sub", 2) },
    }).success).toBe(false);
  });

  test("keeps omission metadata bound to real latest-submission history", () => {
    expect(workTaskDetailSchema.safeParse({
      ...detail,
      task: { ...detail.task, latestSubmissionId: null },
      latestSubmission: null,
      latestSubmissionReviews: [],
      omittedLatestSubmissionReviews: 1,
    }).success).toBe(false);
    expect(workTaskDetailSchema.safeParse({
      ...detail,
      omittedLatestSubmissionReviews: WORK_EVIDENCE_LIMIT + 1,
    }).success).toBe(false);
  });

  test("fails closed when valid core task lineage exceeds the whole-detail byte cap", () => {
    const escapedResult = { kind: "text" as const, text: "\0".repeat(WORK_INLINE_RESULT_MAX_BYTES) };
    const oversized = {
      ...detail,
      latestAttemptReport: {
        ...detail.latestAttemptReport,
        report: { ...detail.latestAttemptReport.report, result: escapedResult },
      },
      latestSubmission: { ...submission, result: escapedResult },
    };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength)
      .toBeGreaterThan(WORK_TASK_DETAIL_MAX_BYTES);
    expect(workTaskDetailSchema.safeParse(oversized).success).toBe(false);
  });

  test("cross-binds and byte-bounds one standalone task-history page", () => {
    const review = {
      id: reviewId,
      submissionId,
      reviewerSessionId: targetSessionId,
      decision: "revise" as const,
      summary: "Revise this submission.",
      evidence: [],
      createdAt: 3,
    };
    const page = {
      version: 1 as const,
      kind: "history" as const,
      workId,
      taskId,
      taskRevision: 1,
      projectionAt: 3,
      requestedCursor: null,
      observedThroughCursor: cursor0,
      offset: 0,
      totalItems: 1,
      counts: { attempts: 0, attemptReports: 0, submissions: 0, reviews: 1, signals: 0 },
      items: [{ kind: "review" as const, taskId, value: review }],
      remainingItems: 0,
      remainingCounts: { attempts: 0, attemptReports: 0, submissions: 0, reviews: 0, signals: 0 },
      nextCursor: null,
    };
    expect(workTaskHistoryPageSchema.safeParse(page).success).toBe(true);
    expect(workTaskHistoryPageSchema.safeParse({
      ...page,
      items: [{ ...page.items[0], taskId: hexId("task", 2) }],
    }).success).toBe(false);
    expect(workTaskHistoryPageSchema.safeParse({
      ...page,
      totalItems: 1,
      counts: { attempts: 0, attemptReports: 0, submissions: 0, reviews: 1, signals: 0 },
      items: [],
      remainingItems: 1,
      remainingCounts: { attempts: 0, attemptReports: 0, submissions: 0, reviews: 1, signals: 0 },
      nextCursor: cursor1,
    }).success).toBe(false);
    expect(workTaskHistoryPageSchema.safeParse({
      ...page,
      requestedCursor: cursor0,
      offset: 1,
      totalItems: 3,
      counts: { attempts: 0, attemptReports: 0, submissions: 0, reviews: 3, signals: 0 },
      remainingItems: 1,
      remainingCounts: { attempts: 0, attemptReports: 0, submissions: 0, reviews: 1, signals: 0 },
      nextCursor: cursor0,
    }).success).toBe(false);

    const escapedResult = { kind: "text" as const, text: "\0".repeat(WORK_INLINE_RESULT_MAX_BYTES) };
    const oversizedPage = {
      ...page,
      totalItems: 2,
      counts: { attempts: 0, attemptReports: 1, submissions: 1, reviews: 0, signals: 0 },
      items: [
        {
          kind: "attempt_report" as const,
          value: {
            ...detail.latestAttemptReport,
            report: { ...detail.latestAttemptReport.report, result: escapedResult },
            createdAt: 2,
          },
        },
        {
          kind: "submission" as const,
          value: { ...submission, result: escapedResult, createdAt: 2, updatedAt: 2 },
        },
      ],
    };
    expect(workTaskHistoryPageSchema.safeParse(oversizedPage).success).toBe(false);
  });

  test("keeps provider delivery and recipient acknowledgement orthogonal", () => {
    const accepted = {
      id: signalId,
      senderSessionId: actorSessionId,
      targetSessionId,
      accountGeneration: 1,
      taskId: null,
      replyToSignalId: null,
      mode: "queue" as const,
      deliveryState: "accepted" as const,
      deliveryReceipt: {
        kind: "queue_created" as const,
        mutationAttemptId: hexId("attempt", 2),
        accountGeneration: 1,
        queueId: hexId("queue", 1),
      },
      body: "Review this result.",
      revision: 2,
      createdAt: 1,
      acknowledgedAt: null,
    };
    expect(workSignalRecordSchema.safeParse(accepted).success).toBe(true);
    expect(workSignalRecordSchema.safeParse({
      ...accepted,
      deliveryState: "pending",
    }).success).toBe(false);
    expect(workSignalRecordSchema.safeParse({
      ...accepted,
      deliveryReceipt: null,
    }).success).toBe(false);
    expect(workSignalRecordSchema.safeParse({
      ...accepted,
      acknowledgedAt: 2,
    }).success).toBe(true);
    expect(workSignalRecordSchema.safeParse({
      ...accepted,
      acknowledgedAt: 0,
    }).success).toBe(false);
  });
});

describe("bounded results and evidence", () => {
  test("enforces the exact 64 KiB inline text boundary by UTF-8 bytes", () => {
    const atLimit = "é".repeat(WORK_INLINE_RESULT_MAX_BYTES / 2);
    expect(workResultSchema.safeParse({ kind: "text", text: atLimit }).success).toBe(true);
    expect(workResultSchema.safeParse({ kind: "text", text: `${atLimit}é` }).success).toBe(false);
  });

  test("validates recursive JSON depth, node count, serialized bytes, types, and cycles", () => {
    let depthValue: unknown = "leaf";
    for (let depth = 0; depth < WORK_JSON_DEPTH_LIMIT; depth += 1) depthValue = [depthValue];
    expect(workJsonValueSchema.safeParse(depthValue).success).toBe(true);
    depthValue = [depthValue];
    expect(workJsonValueSchema.safeParse(depthValue).success).toBe(false);

    expect(isBoundedWorkJsonValue(Array.from({ length: WORK_JSON_NODE_LIMIT - 1 }, () => 0)))
      .toBe(true);
    expect(isBoundedWorkJsonValue(Array.from({ length: WORK_JSON_NODE_LIMIT }, () => 0)))
      .toBe(false);
    expect(workJsonValueSchema.safeParse("a".repeat(WORK_INLINE_RESULT_MAX_BYTES - 2)).success)
      .toBe(true);
    expect(workJsonValueSchema.safeParse("a".repeat(WORK_INLINE_RESULT_MAX_BYTES - 1)).success)
      .toBe(false);
    expect(workJsonValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(workJsonValueSchema.safeParse(new Date()).success).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(workJsonValueSchema.safeParse(cyclic).success).toBe(false);
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "unsafe", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute");
      },
    });
    expect(() => isBoundedWorkJsonValue(accessor)).not.toThrow();
    expect(isBoundedWorkJsonValue(accessor)).toBe(false);
    const throwingProxy = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("hostile proxy");
      },
    });
    expect(() => isBoundedWorkJsonValue(throwingProxy)).not.toThrow();
    expect(isBoundedWorkJsonValue(throwingProxy)).toBe(false);
    const decoratedArray: unknown[] & { extra?: unknown } = [];
    decoratedArray.extra = true;
    expect(isBoundedWorkJsonValue(decoratedArray)).toBe(false);
  });

  test("keeps evidence closed, unique, and bounded", () => {
    const evidence = Array.from({ length: WORK_EVIDENCE_LIMIT }, (_, index) => ({
      kind: "artifact" as const,
      projectId,
      path: `artifacts/result-${index}.json`,
      bytes: index,
      sha256: index.toString(16).padStart(64, "0"),
    }));
    expect(workEvidenceListSchema.safeParse(evidence).success).toBe(true);
    expect(workEvidenceListSchema.safeParse([...evidence, {
      kind: "artifact",
      projectId,
      path: "artifacts/overflow.json",
      bytes: 1,
      sha256: "f".repeat(64),
    }]).success).toBe(false);
    expect(workEvidenceListSchema.safeParse([evidence[0], evidence[0]]).success).toBe(false);
    expect(workEvidenceListSchema.safeParse([{ kind: "url", url: "https://example.com" }]).success)
      .toBe(false);
    for (const path of ["../secret", "/absolute", "dir\\file", "dir//file", "./file"]) {
      expect(workEvidenceListSchema.safeParse([{ ...evidence[0], path }]).success).toBe(false);
    }
  });
});

describe("agent-first operation documents", () => {
  const expectedRevision = 1;
  const fence = 1;
  const evidence = [{
    kind: "artifact" as const,
    projectId,
    path: "artifacts/result.json",
    bytes: 1,
    sha256: "a".repeat(64),
  }];
  const common = { idempotencyKey, workId };

  const operations = [
    {
      kind: "work.create",
      idempotencyKey,
      clientRef: "plan",
      coordinatorSessionId: actorSessionId,
      objective: "Complete the work",
      routes: [{ accountId, projectId, preset: "low", fast: false }],
      tasks: [taskSpec()],
    },
    {
      ...common,
      kind: "task.addBatch",
      expectedWorkRevision: expectedRevision,
      coordinatorSessionId: actorSessionId,
      coordinatorCapability: capability,
      tasks: [taskSpec("task-2")],
    },
    {
      ...common,
      kind: "work.join",
      coordinatorSessionId: actorSessionId,
      coordinatorCapability: capability,
      actorSessionId,
    },
    {
      ...common,
      kind: "task.claim",
      taskId,
      expectedTaskRevision: expectedRevision,
      actorSessionId,
      actorCapability: capability,
      leaseMs: WORK_LEASE_MIN_MS,
    },
    {
      ...common,
      kind: "task.claimNext",
      actorSessionId,
      actorCapability: capability,
      route: { accountId, projectId },
      leaseMs: WORK_LEASE_MAX_MS,
    },
    {
      ...common,
      kind: "task.claimBatch",
      claims: [
        {
          taskId,
          expectedTaskRevision: expectedRevision,
          actorSessionId,
          actorCapability: capability,
          leaseMs: WORK_LEASE_MIN_MS,
        },
        {
          taskId: hexId("task", 2),
          expectedTaskRevision: expectedRevision,
          actorSessionId: targetSessionId,
          actorCapability: capability,
          leaseMs: WORK_LEASE_MAX_MS,
        },
      ],
    },
    {
      ...common,
      kind: "attempt.renew",
      attemptId,
      expectedAttemptRevision: expectedRevision,
      fence,
      actorSessionId,
      attemptCapability: capability,
      leaseMs: WORK_LEASE_MIN_MS,
    },
    {
      ...common,
      kind: "attempt.release",
      attemptId,
      expectedAttemptRevision: expectedRevision,
      fence,
      actorSessionId,
      attemptCapability: capability,
      reason: "Yield capacity",
    },
    {
      ...common,
      kind: "attempt.dispatch",
      attemptId,
      expectedAttemptRevision: expectedRevision,
      fence,
      actorSessionId,
      attemptCapability: capability,
      targetSessionId: actorSessionId,
      mode: "send",
    },
    {
      ...common,
      kind: "attempt.report",
      attemptId,
      expectedAttemptRevision: expectedRevision,
      fence,
      actorSessionId,
      attemptCapability: capability,
      report: { kind: "checkpoint", summary: "Tests are running", evidence },
    },
    {
      ...common,
      kind: "submission.review",
      submissionId,
      expectedSubmissionRevision: expectedRevision,
      expectedContentDigest: "b".repeat(64),
      reviewerSessionId: actorSessionId,
      reviewerCapability: capability,
      review: { decision: "accept", summary: "Verified", evidence },
    },
    {
      ...common,
      kind: "signal.send",
      senderSessionId: actorSessionId,
      senderCapability: capability,
      targetSessionId,
      mode: "queue",
      body: "Check the failing test",
    },
    {
      ...common,
      kind: "signal.ack",
      signalId,
      expectedSignalRevision: expectedRevision,
      actorSessionId: targetSessionId,
      actorCapability: capability,
    },
    {
      ...common,
      kind: "work.complete",
      expectedWorkRevision: expectedRevision,
      actorSessionId,
      coordinatorCapability: capability,
      summary: "All tasks accepted",
      evidence,
    },
    {
      ...common,
      kind: "work.fail",
      expectedWorkRevision: expectedRevision,
      actorSessionId,
      coordinatorCapability: capability,
      summary: "The plan is not viable",
      evidence,
    },
    {
      ...common,
      kind: "work.cancel",
      expectedWorkRevision: expectedRevision,
      actorSessionId,
      coordinatorCapability: capability,
      summary: "Superseded",
      evidence,
    },
    {
      ...common,
      kind: "work.release",
      expectedWorkRevision: expectedRevision,
      actorSessionId,
      coordinatorCapability: capability,
      acknowledgeDataLoss: true,
    },
    {
      ...common,
      kind: "attempt.reconcile",
      attemptId,
      expectedAttemptRevision: expectedRevision,
      fence,
      actorSessionId,
      attemptCapability: capability,
      outcome: { kind: "still_unknown", summary: "Provider status unavailable", evidence },
    },
  ] as const;

  test("accepts every closed operation and advertises the same complete set", () => {
    for (const operation of operations) {
      expect(workOperationSchema.safeParse(operation).success).toBe(true);
    }
    expect(new Set(operations.map((operation) => operation.kind)))
      .toEqual(new Set(workOperationKindSchema.options));
    expect(workProtocolDescriptionSchema.parse(WORK_PROTOCOL_DESCRIPTION).operations)
      .toEqual(workOperationKindSchema.options);
    expect(WORK_PROTOCOL_DESCRIPTION.contracts.map((contract) => contract.kind))
      .toEqual(workOperationKindSchema.options);
    expect(WORK_OPERATION_CONTRACTS).toEqual(WORK_PROTOCOL_DESCRIPTION.contracts);
    expect(workProtocolRequestSchema.safeParse({
      protocol: "hra-work-local-v1",
      version: 1,
      requestId: streamEpoch,
      operation: operations[0],
    }).success).toBe(true);
  });

  test("requires in-document idempotency, entity revisions, and exact attempt authority", () => {
    const join = operations.find((operation) => operation.kind === "work.join");
    const claim = operations.find((operation) => operation.kind === "task.claim");
    const renew = operations.find((operation) => operation.kind === "attempt.renew");
    expect(join).toBeDefined();
    expect(claim).toBeDefined();
    expect(renew).toBeDefined();
    if (join === undefined || claim === undefined || renew === undefined) {
      throw new Error("Fixture missing");
    }
    const joinWithoutKey: Record<string, unknown> = { ...join };
    const claimWithoutRevision: Record<string, unknown> = { ...claim };
    const renewWithoutRevision: Record<string, unknown> = { ...renew };
    const renewWithoutFence: Record<string, unknown> = { ...renew };
    const renewWithoutActor: Record<string, unknown> = { ...renew };
    delete joinWithoutKey.idempotencyKey;
    delete claimWithoutRevision.expectedTaskRevision;
    delete renewWithoutRevision.expectedAttemptRevision;
    delete renewWithoutFence.fence;
    delete renewWithoutActor.actorSessionId;
    expect(workOperationSchema.safeParse(joinWithoutKey).success).toBe(false);
    expect(workOperationSchema.safeParse(claimWithoutRevision).success).toBe(false);
    expect(workOperationSchema.safeParse(renewWithoutRevision).success).toBe(false);
    expect(workOperationSchema.safeParse(renewWithoutFence).success).toBe(false);
    expect(workOperationSchema.safeParse(renewWithoutActor).success).toBe(false);
    expect(workOperationSchema.safeParse({ ...join, idempotencyKey, extra: true }).success)
      .toBe(false);
  });

  test("binds actors to exact HRA session IDs", () => {
    const join = operations.find((operation) => operation.kind === "work.join");
    expect(join).toBeDefined();
    expect(workOperationSchema.safeParse({ ...join, actorSessionId: "worker-one" }).success)
      .toBe(false);
    expect(workOperationSchema.safeParse({ ...join, actorSessionId }).success).toBe(true);
  });

  test("keeps atomic fanout claims bounded with unique tasks and actors", () => {
    const batch = operations.find((operation) => operation.kind === "task.claimBatch");
    expect(batch).toBeDefined();
    if (batch === undefined) throw new Error("Fixture missing");
    expect(workOperationSchema.safeParse(batch).success).toBe(true);
    expect(workOperationSchema.safeParse({
      ...batch,
      claims: [batch.claims[0], batch.claims[0]],
    }).success).toBe(false);
    expect(workOperationSchema.safeParse({
      ...batch,
      claims: [
        batch.claims[0],
        { ...batch.claims[1], actorSessionId: batch.claims[0].actorSessionId },
      ],
    }).success).toBe(false);
  });

  test("advertises finite per-work participant and history capacity", () => {
    const protocol = workProtocolDescriptionSchema.parse(WORK_PROTOCOL_DESCRIPTION);
    expect(protocol.limits.activeWorks).toBe(WORK_ACTIVE_LIMIT);
    expect(protocol.limits.retainedWorks).toBe(WORK_RETAINED_LIMIT);
    expect(protocol.limits.membersPerWork).toBe(WORK_MEMBER_LIMIT);
    expect(protocol.limits.historyEventsPerWork).toBe(WORK_HISTORY_EVENT_LIMIT);
    expect(protocol.limits.historyRecoveryReservePerWork).toBe(WORK_HISTORY_RECOVERY_RESERVE);
    expect(protocol.limits.effectResolutionsPerWork).toBe(WORK_EFFECT_RESOLUTION_LIMIT);
    expect(protocol.limits.releaseTombstones).toBe(WORK_TOMBSTONE_LIMIT);
    expect(protocol.limits.releaseTombstoneBytes).toBe(WORK_TOMBSTONE_MAX_BYTES);
    expect(protocol.limits.releaseTombstoneMaxAgeMs).toBe(WORK_TOMBSTONE_MAX_AGE_MS);
    expect(protocol.limits.taskHistoryMembershipPerWork)
      .toBe(WORK_TASK_HISTORY_MEMBERSHIP_LIMIT);
    expect(protocol.retention.releaseTombstones).toEqual({
      replay: "while_retained_only",
      bounds: "count_age_bytes",
      evictionOrder: "expired_then_oldest_release_time_work_id",
    });

    const tombstone = {
      version: 1 as const,
      workId,
      clientRefDigest: "a".repeat(64),
      coordinatorSessionId: actorSessionId,
      terminalKind: "work.complete" as const,
      terminalRequestDigest: "b".repeat(64),
      releaseRequestDigest: "c".repeat(64),
      finalRevision: 1,
      finalHeadHash: "d".repeat(64),
      discardedRecordCounts: {
        routes: 0,
        members: 0,
        tasks: 0,
        dependencies: 0,
        attempts: 0,
        reports: 0,
        submissions: 0,
        reviews: 0,
        signals: 0,
        receipts: 0,
        events: 0,
        intents: 0,
        effects: 0,
        unresolvedSignalEffects: 0,
        effectResolutions: WORK_EFFECT_RESOLUTION_LIMIT,
        historyIndex: WORK_TASK_HISTORY_MEMBERSHIP_LIMIT,
        historyVersions: 0,
      },
      discardedRecordsDigest: "e".repeat(64),
      releasedAt: 1,
      retentionUpperBoundAt: 2,
      priorOperationReplayGuaranteesEnded: true as const,
      releaseReplayPolicy: "retained_tombstone_only" as const,
    };
    expect(workReleaseTombstoneSchema.safeParse(tombstone).success).toBe(true);
    expect(workReleaseTombstoneSchema.safeParse({
      ...tombstone,
      discardedRecordCounts: {
        ...tombstone.discardedRecordCounts,
        historyIndex: WORK_TASK_HISTORY_MEMBERSHIP_LIMIT + 1,
      },
    }).success).toBe(false);
    expect(workReleaseTombstoneSchema.safeParse({
      ...tombstone,
      discardedRecordCounts: {
        ...tombstone.discardedRecordCounts,
        effectResolutions: WORK_EFFECT_RESOLUTION_LIMIT + 1,
      },
    }).success).toBe(false);
  });

  test("enforces lease, signal, criteria, and wait boundaries", () => {
    const renew = operations.find((operation) => operation.kind === "attempt.renew");
    const signal = operations.find((operation) => operation.kind === "signal.send");
    expect(renew).toBeDefined();
    expect(signal).toBeDefined();
    expect(workOperationSchema.safeParse({ ...renew, leaseMs: WORK_LEASE_MIN_MS - 1 }).success)
      .toBe(false);
    expect(workOperationSchema.safeParse({ ...renew, leaseMs: WORK_LEASE_MAX_MS + 1 }).success)
      .toBe(false);

    const signalAtLimit = "é".repeat(WORK_SIGNAL_MAX_BYTES / 2);
    expect(workOperationSchema.safeParse({ ...signal, body: signalAtLimit }).success).toBe(true);
    expect(workOperationSchema.safeParse({ ...signal, body: `${signalAtLimit}é` }).success)
      .toBe(false);

    const criteria = Array.from({ length: WORK_CRITERIA_LIMIT }, (_, index) => `criterion-${index}`);
    expect(workTaskSpecSchema.safeParse(taskSpec("criteria", { criteria })).success).toBe(true);
    expect(workTaskSpecSchema.safeParse(taskSpec("criteria", {
      criteria: [...criteria, "one-too-many"],
    })).success).toBe(false);
    expect(workTaskSpecSchema.safeParse(taskSpec("criteria-bytes", {
      criteria: Array.from({ length: WORK_CRITERIA_LIMIT }, () => "x".repeat(2 * 1024)),
    })).success).toBe(false);

    const poll = {
      workId,
      actorSessionId: null,
      cursor: null,
      actionCursor: null,
      waitMs: WORK_WAIT_MAX_MS,
      limit: 1,
    };
    expect(workPollRequestSchema.safeParse(poll).success).toBe(true);
    expect(workPollRequestSchema.safeParse({ ...poll, waitMs: WORK_WAIT_MAX_MS + 1 }).success)
      .toBe(false);
  });
});

describe("cursor, event, and poll contracts", () => {
  test("uses an opaque wire cursor and a typed internal work cursor payload", () => {
    expect(workEventCursorWireSchema.safeParse(cursor0).success).toBe(true);
    expect(workEventCursorWireSchema.safeParse("work:1").success).toBe(false);
    const payload = {
      version: 1,
      type: "work",
      workId,
      streamEpoch,
      sequence: 0,
    };
    expect(workEventCursorPayloadSchema.safeParse(payload).success).toBe(true);
    expect(workEventCursorPayloadSchema.safeParse({ ...payload, type: "session" }).success)
      .toBe(false);
    expect(workEventCursorPayloadSchema.safeParse({ ...payload, rawSequence: 0 }).success)
      .toBe(false);

    const historyPayload = {
      version: 1 as const,
      type: "work_task_history" as const,
      workId,
      taskId,
      streamEpoch,
      sequence: 1,
      projectionAt: 1,
      highWaterOrdinal: 1,
      taskRevision: 1,
      offset: WORK_HISTORY_EVENT_LIMIT + WORK_OPERATION_BATCH_LIMIT,
    };
    expect(workTaskHistoryCursorPayloadSchema.safeParse(historyPayload).success).toBe(true);
    expect(workTaskHistoryCursorPayloadSchema.safeParse({
      ...historyPayload,
      offset: historyPayload.offset + 1,
    }).success).toBe(false);
    expect(WORK_TASK_HISTORY_ITEM_LIMIT).toBe(50);
  });

  test("accepts 200 contiguous events and rejects 201, mixed epochs, and gaps", () => {
    const maximumPage = Array.from(
      { length: WORK_EVENT_PAGE_LIMIT },
      (_, index) => minimalEvent(index + 1),
    );
    expect(workEventPageSchema.safeParse(eventPage(maximumPage)).success).toBe(true);
    expect(workEventPageSchema.safeParse(eventPage([
      ...maximumPage,
      minimalEvent(WORK_EVENT_PAGE_LIMIT + 1),
    ])).success).toBe(false);
    expect(workEventPageSchema.safeParse(eventPage([
      minimalEvent(1),
      { ...minimalEvent(2), streamEpoch: "018f1f64-6c17-7d35-8f8e-b24a1d3a5333" },
    ])).success).toBe(false);
    expect(workEventPageSchema.safeParse(eventPage([
      minimalEvent(1),
      minimalEvent(3),
    ])).success).toBe(false);
  });

  test("enforces the 512 KiB serialized event-page budget", () => {
    const largeEvents = [{
      ...minimalEvent(1),
      body: {
        type: "future.invalid_event_variant",
        padding: "x".repeat(WORK_EVENT_PAGE_MAX_BYTES),
      },
    }] as unknown as WorkEvent[];
    const eventBytes = largeEvents.reduce(
      (total, event) => total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    expect(eventBytes).toBeGreaterThan(WORK_EVENT_PAGE_MAX_BYTES);
    expect(workEventPageSchema.safeParse(eventPage(largeEvents)).success).toBe(false);
  });

  test("keeps prepared effect recovery bounded and content-free in polls", () => {
    const status = {
      kind: "dispatch",
      idempotencyKey,
      subjectId: attemptId,
      targetSessionId: actorSessionId,
      instructionDigest: "a".repeat(64),
      state: "unknown",
    };
    expect(workPreparedEffectStatusSchema.safeParse(status).success).toBe(true);
    expect(workPreparedEffectStatusSchema.safeParse({
      ...status,
      body: "must not leak",
    }).success).toBe(false);

    const poll = {
      version: 1,
      workId,
      actorSessionId: null,
      workRevision: 1,
      status: "open",
      nextWakeAt: null,
      requestedActionCursor: null,
      nextActionCursor: null,
      readyTasks: [],
      ownedAttempts: [],
      recoveryAttempts: [],
      reviewableSubmissions: [],
      signals: [],
      preparedEffects: [status],
      omitted: {
        readyTasks: 0,
        ownedAttempts: 0,
        recoveryAttempts: 0,
        reviewableSubmissions: 0,
        signals: 0,
        preparedEffects: 0,
      },
      eventPage: eventPage([]),
    };
    expect(workPollSchema.safeParse(poll).success).toBe(true);
    expect(workPollSchema.safeParse({
      ...poll,
      signals: [{ targetSessionId }],
    }).success).toBe(false);
  });
});

describe("schema totality", () => {
  test("never throws while parsing arbitrary JSON candidates", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(typeof workOperationSchema.safeParse(value).success).toBe("boolean");
      expect(typeof workProtocolResponseSchema.safeParse(value).success).toBe("boolean");
      expect(typeof workEventPageSchema.safeParse(value).success).toBe("boolean");
      expect(typeof workSnapshotSchema.safeParse(value).success).toBe("boolean");
      expect(typeof workJsonValueSchema.safeParse(value).success).toBe("boolean");
    }), { numRuns: 500 });
  });

  test("accepts bounded fast-check JSON values exactly when the independent predicate does", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(workJsonValueSchema.safeParse(value).success).toBe(isBoundedWorkJsonValue(value));
    }), { numRuns: 500 });
  });
});
