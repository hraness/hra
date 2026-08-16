import { expect, test } from "bun:test";

import {
  MAX_SERIALIZED_SUBMISSION_CONTENT_BYTES,
  MAX_SERIALIZED_SUBMISSION_ENVELOPE_BYTES,
  MAX_TASK_HUMAN_INPUT_PREVIEW_UTF8_BYTES,
  absoluteHttpsUrlSchema,
  addTaskReferenceRequestSchema,
  assignTaskRequestSchema,
  blockedTaskViewSchema,
  createWorkspaceRepositoryRequestSchema,
  createTaskRequestSchema,
  errorExitCode,
  listTasksQuerySchema,
  readyTaskViewSchema,
  rejectTaskEnvelopeSchema,
  serializedSubmissionContentByteLength,
  submitTaskEnvelopeSchema,
  submitTaskRequestSchema,
  taskDependencyMutationRequestSchema,
  taskEventSchema,
  taskGraphQuerySchema,
  taskHumanInputViewSchema,
  taskReferenceInputSchema,
  taskReferenceResponseSchema,
  taskRouteParamsSchema,
  taskSubmissionViewSchema,
  taskctlApiOperations,
  taskctlApiRoutes,
  updateTaskRequestSchema,
} from "./index";

const KEY = "OPS-7K2M4Q9";
const OTHER_KEY = "OPS-0000001";
const TASK_ID = "tsk_00000000000000000000000000";
const REPOSITORY_ID = "repo_00000000000000000000000000";
const REFERENCE_ID = "ref_00000000000000000000000000";
const SUBMISSION_ID = "sub_00000000000000000000000000";

const openTask = {
  id: TASK_ID,
  key: KEY,
  title: "Build it",
  type: "task",
  priority: 2,
  status: "open",
  availableAt: 0,
  isReady: true,
  unresolvedBlockerCount: 0,
  cancelledBlockerCount: 0,
  revision: 1,
  reviewRevision: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

test("the complete task API route surface remains versioned and locator-safe", () => {
  expect(taskctlApiRoutes.task(KEY)).toBe(`/v1/tasks/${KEY}`);
  expect(taskctlApiRoutes.taskDependencyRemove(KEY)).toBe(`/v1/tasks/${KEY}/dependencies/remove`);
  expect(taskctlApiRoutes.taskReferenceRemove(KEY, REFERENCE_ID)).toBe(
    `/v1/tasks/${KEY}/references/${REFERENCE_ID}/remove`,
  );
  expect(taskctlApiRoutes.workspaceRepositoryRemove(REPOSITORY_ID)).toBe(
    `/v1/workspace/repositories/${REPOSITORY_ID}/remove`,
  );
  expect(taskctlApiOperations.submitTask).toMatchObject({
    method: "POST",
    authorization: "agent",
    session: true,
    idempotency: true,
  });
  expect(taskctlApiOperations.reviewQueue).toMatchObject({ method: "GET", idempotency: false });
  expect(taskctlApiOperations.claimTask.pathParamsSchema).toBe(taskRouteParamsSchema);
  expect(taskctlApiOperations.renewClaim.pathParamsSchema).toBe(taskRouteParamsSchema);
  expect(taskctlApiOperations.releaseClaim.pathParamsSchema).toBe(taskRouteParamsSchema);

  const agentTaskOperations = [
    "listTasks",
    "getTask",
    "blockedTasks",
    "updateTask",
    "assignTask",
    "deferTask",
    "listTaskLabels",
    "addTaskLabel",
    "removeTaskLabel",
    "listTaskComments",
    "addTaskComment",
    "listTaskEvents",
    "taskGraph",
    "listTaskDependencies",
    "addTaskDependency",
    "removeTaskDependency",
    "setTaskParent",
    "clearTaskParent",
    "listTaskReferences",
    "addTaskReference",
    "removeTaskReference",
    "reviewQueue",
    "acceptTask",
    "rejectTask",
  ] as const;
  for (const operation of agentTaskOperations) {
    expect(taskctlApiOperations[operation]).toMatchObject({ authorization: "agent", session: true });
  }
  for (const operation of [
    "cancelTask",
    "reopenTask",
    "listWorkspaceRepositories",
    "createWorkspaceRepository",
    "removeWorkspaceRepository",
  ] as const) {
    expect(taskctlApiOperations[operation]).toMatchObject({
      authorization: "human-workspace",
      session: false,
    });
  }
});

test("task inputs reject unknown fields and impossible empty mutations", () => {
  expect(
    createTaskRequestSchema.safeParse({
      title: "Build it",
      description: "Bounded markdown",
      labels: ["backend", "urgent"],
      parentKey: OTHER_KEY,
    }).success,
  ).toBeTrue();
  expect(
    createTaskRequestSchema.safeParse({ title: "Build it", credential: "secret" }).success,
  ).toBeFalse();
  expect(updateTaskRequestSchema.safeParse({ revision: 1 }).success).toBeFalse();
  expect(updateTaskRequestSchema.safeParse({ revision: 1, title: "Changed", unknown: true }).success).toBeFalse();
  expect(
    assignTaskRequestSchema.safeParse({
      revision: 2,
      assigneeAgentId: "agent-2",
      fence: 7,
    }).success,
  ).toBeTrue();
  expect(
    assignTaskRequestSchema.safeParse({
      revision: 2,
      assigneeAgentId: "agent-2",
      fence: 0,
    }).success,
  ).toBeFalse();
  expect(
    taskDependencyMutationRequestSchema.safeParse({
      revision: 2,
      blockerKey: OTHER_KEY,
      fence: 7,
    }).success,
  ).toBeTrue();
});

test("typed references and submission evidence are closed discriminated unions", () => {
  expect(
    taskReferenceInputSchema.safeParse({ kind: "commit", sha: "A".repeat(40) }).success,
  ).toBeTrue();
  expect(
    addTaskReferenceRequestSchema.safeParse({
      revision: 1,
      reference: { kind: "repository", repositoryId: REPOSITORY_ID },
    }).success,
  ).toBeTrue();
  expect(
    taskReferenceInputSchema.safeParse({
      kind: "pull_request",
      url: "https://example.com/pull/1",
      token: "must-not-cross-wire",
    }).success,
  ).toBeFalse();
  expect(
    submitTaskRequestSchema.safeParse({
      fence: 3,
      summary: "Tests pass",
      evidence: [
        { kind: "test", command: "bun test" },
        { kind: "commit", sha: "a".repeat(40), url: "https://example.com/commit/a" },
      ],
    }).success,
  ).toBeTrue();
  expect(
    submitTaskRequestSchema.safeParse({
      fence: 3,
      expectedReviewRevision: 2,
      dispatch: {
        runId: "run_primary0001",
        runnerId: "runner_primary0001",
        bootId: "boot_primary0001",
        claimId: "claim_primary001",
        claimFence: 3,
      },
      summary: "Tests pass",
      evidence: [{ kind: "note", text: "done" }],
    }).success,
  ).toBeTrue();
  expect(
    submitTaskRequestSchema.safeParse({
      fence: 3,
      expectedReviewRevision: 2,
      dispatch: {
        runId: "run_primary0001",
        runnerId: "runner_primary0001",
        bootId: "boot_primary0001",
        claimId: "claim_primary001",
        claimFence: 4,
      },
      summary: "Tests pass",
      evidence: [{ kind: "note", text: "done" }],
    }).success,
  ).toBeFalse();
  expect(
    submitTaskRequestSchema.safeParse({
      fence: 3,
      summary: "Tests pass",
      evidence: [{ kind: "note", text: "ok", refreshToken: "nope" }],
    }).success,
  ).toBeFalse();

  for (const url of [
    "https://user:password@example.com/path",
    "https://user@example.com/path",
    "https://:password@example.com/path",
  ]) {
    expect(absoluteHttpsUrlSchema.safeParse(url).success).toBeFalse();
    expect(
      taskReferenceInputSchema.safeParse({ kind: "pull_request", url }).success,
    ).toBeFalse();
    expect(
      createWorkspaceRepositoryRequestSchema.safeParse({
        workspaceId: "workspace-id",
        name: "Repository",
        provider: "github",
        url,
      }).success,
    ).toBeFalse();
    expect(
      submitTaskRequestSchema.safeParse({
        fence: 3,
        summary: "Tests pass",
        evidence: [{ kind: "pull_request", url }],
      }).success,
    ).toBeFalse();
  }

  expect(
    createWorkspaceRepositoryRequestSchema.parse({
      workspaceId: "workspace-id",
      name: "  Repository  ",
      provider: "github",
      url: "https://example.com/repository",
    }).name,
  ).toBe("Repository");
});

test("ready and blocked views enforce their derived semantics", () => {
  expect(readyTaskViewSchema.safeParse(openTask).success).toBeTrue();
  expect(readyTaskViewSchema.safeParse({ ...openTask, isReady: false }).success).toBeFalse();
  expect(
    readyTaskViewSchema.safeParse({ ...openTask, unresolvedBlockerCount: 1 }).success,
  ).toBeFalse();

  const blocked = {
    ...openTask,
    isReady: false,
    unresolvedBlockerCount: 1,
  };
  expect(blockedTaskViewSchema.safeParse({ task: blocked, needsAttention: false }).success).toBeTrue();
  expect(
    blockedTaskViewSchema.safeParse({ task: openTask, needsAttention: false }).success,
  ).toBeFalse();
  expect(
    blockedTaskViewSchema.safeParse({
      task: { ...blocked, unresolvedBlockerCount: 0, cancelledBlockerCount: 1 },
      needsAttention: false,
    }).success,
  ).toBeFalse();
});

test("task human-input summary is strict, bounded, and contains no authority", () => {
  const value = {
    pendingCount: 2,
    oldestRequestedAt: 1_721_390_400_000,
    expiresAt: 1_721_390_460_000,
    kind: "approval" as const,
    preview: "Allow this workspace change?",
  };
  expect(taskHumanInputViewSchema.parse(value)).toEqual(value);
  for (const invalid of [
    { ...value, pendingCount: 0 },
    { ...value, expiresAt: value.oldestRequestedAt },
    { ...value, kind: "secret" },
    { ...value, preview: " \n\t " },
    { ...value, preview: "x".repeat(MAX_TASK_HUMAN_INPUT_PREVIEW_UTF8_BYTES + 1) },
    { ...value, response: "plaintext", claimId: "claim_secret" },
  ]) {
    expect(taskHumanInputViewSchema.safeParse(invalid).success).toBeFalse();
  }
});

test("submission views make every terminal state and submitter identity explicit", () => {
  const base = {
    id: SUBMISSION_ID,
    taskKey: KEY,
    submittedBy: { kind: "agent", agentId: "agent-id" },
    reviewRevision: 2,
    summary: "Tests pass",
    evidence: [{ kind: "test", command: "bun test" }],
    submittedAt: 10,
  } as const;
  expect(taskSubmissionViewSchema.safeParse({ ...base, status: "pending" }).success).toBeTrue();
  expect(
    taskSubmissionViewSchema.safeParse({ ...base, status: "pending", reviewedAt: 11 }).success,
  ).toBeFalse();
  expect(
    taskSubmissionViewSchema.safeParse({ ...base, status: "accepted", reviewedAt: 11 }).success,
  ).toBeTrue();
  expect(
    taskSubmissionViewSchema.safeParse({ ...base, status: "accepted", reviewedAt: 9 }).success,
  ).toBeFalse();
  expect(
    taskSubmissionViewSchema.safeParse({
      ...base,
      status: "rejected",
      reviewedAt: 11,
      reviewReason: "More evidence needed",
    }).success,
  ).toBeTrue();
  expect(
    taskSubmissionViewSchema.safeParse({
      ...base,
      status: "cancelled",
      cancelledAt: 9,
      cancellationReason: "Task cancelled by planner",
    }).success,
  ).toBeFalse();
  expect(
    taskSubmissionViewSchema.safeParse({ ...base, status: "rejected", reviewedAt: 11 }).success,
  ).toBeFalse();
  expect(
    taskSubmissionViewSchema.safeParse({
      ...base,
      status: "cancelled",
      cancelledAt: 11,
      cancellationReason: "Task cancelled by planner",
    }).success,
  ).toBeTrue();
  expect(
    taskSubmissionViewSchema.safeParse({
      ...base,
      status: "pending",
      submittedBy: { kind: "human", userId: "user-id" },
    }).success,
  ).toBeFalse();
});

test("submission content and receipt envelopes stay under deliberate aggregate bounds", () => {
  const boundedEvidence = Array.from({ length: 49 }, () => ({
    kind: "note" as const,
    text: `x${"\n".repeat(4_095)}`,
  }));
  const oversizedEvidence = [...boundedEvidence, boundedEvidence[0]];
  const boundedRequest = { fence: 1, summary: "done\n\t", evidence: boundedEvidence };
  expect(serializedSubmissionContentByteLength(boundedRequest)).toBeLessThanOrEqual(
    MAX_SERIALIZED_SUBMISSION_CONTENT_BYTES,
  );
  expect(submitTaskRequestSchema.safeParse(boundedRequest).success).toBeTrue();
  expect(serializedSubmissionContentByteLength({ summary: "done", evidence: oversizedEvidence })).toBeGreaterThan(
    MAX_SERIALIZED_SUBMISSION_CONTENT_BYTES,
  );
  expect(
    submitTaskRequestSchema.safeParse({ fence: 1, summary: "done", evidence: oversizedEvidence }).success,
  ).toBeFalse();
  expect(
    submitTaskRequestSchema.safeParse({
      fence: 1,
      summary: "done",
      evidence: [{ kind: "note", text: "unsafe\u0000control" }],
    }).success,
  ).toBeFalse();

  const envelope = {
    ok: true,
    data: {
      task: { ...openTask, status: "in_review", isReady: false, revision: 2, reviewRevision: 2 },
      submission: {
        id: SUBMISSION_ID,
        taskKey: KEY,
        submittedBy: { kind: "agent", agentId: "agent-id" },
        reviewRevision: 2,
        summary: boundedRequest.summary,
        evidence: boundedEvidence,
        status: "pending",
        submittedAt: 10,
      },
    },
    requestId: "req_00000000000000000000000000",
  };
  expect(submitTaskEnvelopeSchema.safeParse(envelope).success).toBeTrue();
  expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThanOrEqual(
    MAX_SERIALIZED_SUBMISSION_ENVELOPE_BYTES,
  );

  const rejectedEnvelope = {
    ok: true,
    data: {
      task: { ...openTask, isReady: false, revision: 3, reviewRevision: 2 },
      submission: {
        ...envelope.data.submission,
        status: "rejected",
        reviewedAt: 20,
        reviewReason: `x${"\n".repeat(16_383)}`,
      },
    },
    requestId: envelope.requestId,
  };
  expect(rejectTaskEnvelopeSchema.safeParse(rejectedEnvelope).success).toBeTrue();
  expect(new TextEncoder().encode(JSON.stringify(rejectedEnvelope)).byteLength).toBeLessThanOrEqual(
    MAX_SERIALIZED_SUBMISSION_ENVELOPE_BYTES,
  );
});

test("reference additions return the revised task and task.updated fields are closed", () => {
  const reference = {
    id: REFERENCE_ID,
    kind: "url",
    label: "Build",
    url: "https://example.com/build",
    createdAt: 2,
  } as const;
  expect(
    taskReferenceResponseSchema.safeParse({ reference, task: { ...openTask, revision: 2 } }).success,
  ).toBeTrue();
  expect(taskReferenceResponseSchema.safeParse({ reference }).success).toBeFalse();

  const event = {
    id: "event-id",
    organizationId: "organization-id",
    workspaceId: "workspace-id",
    taskId: "task-id",
    taskRevision: 2,
    schemaVersion: 1,
    actor: { kind: "system", jobKind: "repair" },
    command: { kind: "system", jobKind: "repair" },
    createdAt: 2,
    type: "task.updated",
  } as const;
  expect(taskEventSchema.safeParse({ ...event, payload: { fields: ["blockers"] } }).success).toBeTrue();
  expect(taskEventSchema.safeParse({ ...event, payload: { fields: ["unknown"] } }).success).toBeFalse();
  expect(
    taskEventSchema.safeParse({ ...event, payload: { fields: ["title", "title"] } }).success,
  ).toBeFalse();
});

test("task queries parse URL strings with bounded graph and pagination limits", () => {
  expect(
    listTasksQuerySchema.parse({ status: "open", priority: "2", limit: "100" }),
  ).toMatchObject({ status: "open", priority: 2, limit: 100 });
  expect(taskGraphQuerySchema.safeParse({ depth: "100", limit: "500" }).success).toBeTrue();
  expect(taskGraphQuerySchema.safeParse({ depth: "101", limit: "500" }).success).toBeFalse();
  expect(taskGraphQuerySchema.safeParse({ depth: "1", limit: "501" }).success).toBeFalse();
  expect(errorExitCode.GRAPH_VALIDATION_LIMIT).toBe(4);
  expect(errorExitCode.SELF_REVIEW_DENIED).toBe(3);
});
