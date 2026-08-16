import { describe, expect, test } from "bun:test";

import {
  taskWorkspaceClientIntentKindValues,
  taskWorkspaceClientIntentSchema,
  taskWorkspaceDetailSchema,
  normalizeTaskWorkspaceSemanticValue,
  taskWorkspaceInteractionResponseSemanticKey,
  taskWorkspaceMutationSemanticKey,
  taskWorkspaceMutationFenceFieldValues,
  taskWorkspaceProjectionBundleSchema,
  type TaskWorkspaceClientIntent,
} from "./index";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const OTHER_LOCATOR = "1123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const OTHER_WORKSPACE_ID = `wsp_${OTHER_LOCATOR}`;
const TASK_ID = `tsk_${LOCATOR}`;
const OTHER_TASK_ID = `tsk_${OTHER_LOCATOR}`;
const REPOSITORY_ID = `repo_${LOCATOR}`;
const REFERENCE_ID = `ref_${LOCATOR}`;
const SUBMISSION_ID = `sub_${LOCATOR}`;
const RUN_ID = "run_primary0001";
const INTERACTION_ID = "interaction_primary0001";

const task = {
  id: TASK_ID,
  key: "OPR-123ABCD",
  title: "Design the task client",
  type: "feature" as const,
  priority: 1,
  availableAt: 1,
  isReady: true,
  unresolvedBlockerCount: 0,
  cancelledBlockerCount: 0,
  revision: 4,
  reviewRevision: 2,
  createdAt: 1,
  updatedAt: 4,
  status: "open" as const,
};

const otherTask = {
  ...task,
  id: OTHER_TASK_ID,
  key: "OPR-223ABCD",
  title: "Prove projection laws",
};

const detail = {
  workspaceId: WORKSPACE_ID,
  projectionRevision: 7,
  task,
  description: "Keep the boundary portable.",
  labels: ["architecture"],
  parent: null,
  blockers: [],
  dependents: [],
  children: [],
  comments: [],
  events: [],
  references: [],
  runs: [],
  submission: null,
  recoveries: [],
  truncatedCollections: [],
};

const firstPage = {
  workspaceId: WORKSPACE_ID,
  view: "all" as const,
  projectionRevision: 7,
  items: [{ humanInput: null, run: null, task }],
  cursor: "continuation",
  hasMore: true,
};

const selectedBundle = {
  workspaceId: WORKSPACE_ID,
  view: "all" as const,
  selectedTaskId: TASK_ID,
  continuationRevision: 7,
  projectionRevision: 7,
  firstPage,
  detail,
};

const intents = [
  { kind: "view.select", view: "assigned" },
  { kind: "task.select", taskId: TASK_ID },
  { kind: "page.load_more" },
  {
    kind: "task.create",
    title: "Create a task",
    description: "Then dispatch it.",
    type: "task",
    priority: 2,
    availableAt: 1,
    labels: ["client"],
    parentKey: otherTask.key,
    repositoryId: REPOSITORY_ID,
  },
  {
    kind: "task.update",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    patch: { title: "Updated task" },
  },
  {
    kind: "task.cancel",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    reason: "No longer needed",
  },
  { kind: "task.reopen", taskId: TASK_ID, expectedTaskRevision: 4 },
  {
    kind: "task.assign",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    assigneeAgentId: "agent_primary",
  },
  {
    kind: "task.defer",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    availableAt: 2,
  },
  {
    kind: "task.parent_set",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    parentKey: otherTask.key,
  },
  { kind: "task.parent_clear", taskId: TASK_ID, expectedTaskRevision: 4 },
  {
    kind: "task.label_add",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    label: "client",
  },
  {
    kind: "task.label_remove",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    label: "client",
  },
  { kind: "task.comment_add", taskId: TASK_ID, body: "Looks good." },
  {
    kind: "task.reference_add",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    reference: { kind: "repository", repositoryId: REPOSITORY_ID },
  },
  {
    kind: "task.reference_remove",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    referenceId: REFERENCE_ID,
  },
  {
    kind: "dependency.add",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    blockerKey: otherTask.key,
  },
  {
    kind: "dependency.remove",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    blockerKey: otherTask.key,
  },
  {
    kind: "review.accept",
    taskId: TASK_ID,
    submissionId: SUBMISSION_ID,
    expectedReviewRevision: 2,
  },
  {
    kind: "review.reject",
    taskId: TASK_ID,
    submissionId: SUBMISSION_ID,
    expectedReviewRevision: 2,
    reason: "Tests are incomplete",
  },
  { kind: "dispatch.stop", runId: RUN_ID },
  {
    kind: "dispatch.retry",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    sourceRunId: RUN_ID,
  },
  {
    kind: "dispatch.resolve_ambiguity",
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    sourceRunId: RUN_ID,
    reason: "confirmed_cancelled",
  },
  {
    kind: "interaction.respond",
    runId: RUN_ID,
    interactionId: INTERACTION_ID,
    response: { kind: "file_change_approval", decision: "approve_once" },
  },
] as const satisfies readonly TaskWorkspaceClientIntent[];

describe("task workspace client intents", () => {
  test("owns one cross-adapter semantic retry fence vocabulary", () => {
    expect(taskWorkspaceMutationFenceFieldValues).toEqual([
      "expectedReviewRevision",
      "expectedTaskRevision",
      "expectedWorkspaceRevision",
      "revision",
      "reviewRevision",
      "taskRevision",
    ]);
    expect(Object.isFrozen(taskWorkspaceMutationFenceFieldValues)).toBeTrue();
  });

  test("derives one shared semantic key across refreshed fences", () => {
    const update = intents.find(({ kind }) => kind === "task.update");
    if (update?.kind !== "task.update") throw new Error("update fixture missing");
    expect(taskWorkspaceMutationSemanticKey({
      ...update,
      expectedTaskRevision: update.expectedTaskRevision + 1,
    })).toEqual(taskWorkspaceMutationSemanticKey(update));
    expect(taskWorkspaceMutationSemanticKey({
      ...update,
      patch: { title: "A different edit" },
    })).not.toEqual(taskWorkspaceMutationSemanticKey(update));
    const creation = intents.find(({ kind }) => kind === "task.create");
    if (creation?.kind !== "task.create") {
      throw new Error("creation fixture missing");
    }
    expect(taskWorkspaceMutationSemanticKey({
      ...creation,
      labels: ["zeta", "alpha"],
    })).toEqual(taskWorkspaceMutationSemanticKey({
      ...creation,
      labels: ["alpha", "zeta"],
    }));
  });

  test("normalizes richer trusted-runtime set fields without dropping data", () => {
    const command = {
      generatedTaskId: OTHER_TASK_ID,
      kind: "task.create_and_run",
      labels: ["zeta", "alpha"],
      operationId: "op_runtime0001",
      request: { providerOwned: true },
      title: "Create and run",
    } as const;
    expect(normalizeTaskWorkspaceSemanticValue(command)).toEqual({
      ...command,
      labels: ["alpha", "zeta"],
    });

    const response = {
      ciphertext: "retained",
      interactionId: INTERACTION_ID,
      kind: "interaction.respond",
      response: {
        answers: [
          {
            otherText: "second",
            questionId: "question_zeta0001",
            selectedOptionIds: ["option_zeta00001", "option_alpha0001"],
          },
          {
            questionId: "question_alpha001",
            selectedOptionIds: ["option_beta00001", "option_alpha0001"],
          },
        ],
        kind: "user_input",
      },
      runId: RUN_ID,
    } as const;
    expect(normalizeTaskWorkspaceSemanticValue(response)).toEqual({
      ...response,
      response: {
        answers: [
          {
            questionId: "question_alpha001",
            selectedOptionIds: ["option_alpha0001", "option_beta00001"],
          },
          {
            otherText: "second",
            questionId: "question_zeta0001",
            selectedOptionIds: ["option_alpha0001", "option_zeta00001"],
          },
        ],
        kind: "user_input",
      },
    });
  });

  test("binds encrypted interaction retries to the one-shot target", () => {
    const response = intents.find(({ kind }) => kind === "interaction.respond");
    if (response?.kind !== "interaction.respond") {
      throw new Error("interaction response fixture missing");
    }
    const key = taskWorkspaceMutationSemanticKey(response);
    expect(key).toEqual({
      kind: "interaction.respond",
      interactionId: INTERACTION_ID,
      runId: RUN_ID,
    });
    expect(taskWorkspaceMutationSemanticKey({
      ...response,
      response: { kind: "file_change_approval", decision: "decline" },
    })).toEqual(key);
    expect(taskWorkspaceMutationSemanticKey({
      kind: "interaction.respond",
      interactionId: INTERACTION_ID,
      runId: RUN_ID,
    })).toEqual(key);
    expect(taskWorkspaceInteractionResponseSemanticKey({
      kind: "interaction.respond",
      interactionId: INTERACTION_ID,
      runId: RUN_ID,
    })).toEqual({
      kind: "interaction.respond",
      interactionId: INTERACTION_ID,
      runId: RUN_ID,
    });
    expect(() => {
      Reflect.apply(
        taskWorkspaceMutationSemanticKey,
        undefined,
        [{
          kind: "interaction.respond",
          interactionId: INTERACTION_ID,
          runId: RUN_ID,
          ciphertext: "must-not-enter-identity",
        }],
      );
    }).toThrow();
    expect(() => taskWorkspaceMutationSemanticKey({
      kind: "page.load_more",
    })).toThrow("navigation has no mutation semantic key");
  });

  test("parses exactly one positive example for every closed intent kind", () => {
    expect(intents.map(({ kind }) => kind)).toEqual([
      ...taskWorkspaceClientIntentKindValues,
    ]);
    for (const intent of intents) {
      expect(taskWorkspaceClientIntentSchema.parse(intent)).toEqual(intent);
      expect(taskWorkspaceClientIntentSchema.safeParse({
        ...intent,
        providerDocumentId: "private",
      }).success).toBeFalse();
    }
  });

  test("uses public IDs and entity-specific optimistic revisions", () => {
    const update = intents.find(({ kind }) => kind === "task.update");
    if (update?.kind !== "task.update") throw new Error("update fixture missing");
    expect(taskWorkspaceClientIntentSchema.safeParse({
      ...update,
      taskId: "OPR-123ABCD",
    }).success).toBeFalse();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      ...update,
      revision: update.expectedTaskRevision,
    }).success).toBeFalse();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      ...update,
      expectedTaskRevision: 0,
    }).success).toBeFalse();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      ...update,
      expectedWorkspaceRevision: 7,
    }).success).toBeFalse();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      kind: "page.load_more",
      cursor: "caller-controlled",
      expectedProjectionRevision: 7,
      view: "all",
    }).success).toBeFalse();
    const dependency = intents.find(({ kind }) => kind === "dependency.add");
    if (dependency?.kind !== "dependency.add") {
      throw new Error("dependency fixture missing");
    }
    expect(taskWorkspaceClientIntentSchema.safeParse({
      ...dependency,
      blockerTaskId: OTHER_TASK_ID,
      expectedBlockerRevision: 3,
    }).success).toBeFalse();
  });

  test("keeps task creation and interaction inputs internally coherent", () => {
    const creation = intents.find(({ kind }) => kind === "task.create");
    const response = intents.find(({ kind }) => kind === "interaction.respond");
    if (creation?.kind !== "task.create" || response?.kind !== "interaction.respond") {
      throw new Error("coherence fixtures missing");
    }
    const { availableAt, ...creationWithoutSchedule } = creation;
    void availableAt;
    expect(taskWorkspaceClientIntentSchema.safeParse(
      creationWithoutSchedule,
    ).success).toBeTrue();
    for (const invalid of [
      { ...creation, labels: ["same", "same"] },
      { ...creation, parentKey: "not-a-task-key" },
      { ...creation, operationId: `op_${LOCATOR}` },
      { ...creation, taskId: TASK_ID },
      { ...creation, expectedWorkspaceRevision: 7 },
      {
        ...response,
        response: { kind: "file_change_approval", decision: "unexpected" },
      },
      {
        ...response,
        request: {
          id: INTERACTION_ID,
          createdAt: 1,
          expiresAt: 2,
          kind: "file_change_approval",
          scope: "once",
        },
      },
    ]) {
      expect(taskWorkspaceClientIntentSchema.safeParse(invalid).success).toBeFalse();
    }
    expect(taskWorkspaceClientIntentSchema.safeParse({
      kind: "task.update",
      taskId: TASK_ID,
      expectedTaskRevision: 4,
      patch: {},
    }).success).toBeFalse();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      kind: "task.parent_set",
      taskId: TASK_ID,
      expectedTaskRevision: 4,
      parentKey: "not-a-task-key",
    }).success).toBeFalse();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      kind: "dependency.add",
      taskId: TASK_ID,
      expectedTaskRevision: 4,
      blockerKey: "not-a-task-key",
    }).success).toBeFalse();
  });

  test("defines assigned without a filter as any assigned task", () => {
    expect(taskWorkspaceClientIntentSchema.safeParse({
      kind: "view.select",
      view: "assigned",
    }).success).toBeTrue();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      kind: "view.select",
      view: "assigned",
      assignedAgentId: "agent_primary",
    }).success).toBeTrue();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      kind: "view.select",
      view: "all",
      assignedAgentId: "agent_primary",
    }).success).toBeFalse();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      kind: "task.select",
      taskId: null,
    }).success).toBeTrue();
    expect(taskWorkspaceClientIntentSchema.safeParse({
      kind: "task.select",
      taskId: "OPR-123ABCD",
    }).success).toBeFalse();
  });
});

describe("task workspace projection bundles", () => {
  test("accepts one coherent atomic bundle and its metadata-free detail leaf", () => {
    expect(taskWorkspaceProjectionBundleSchema.parse(selectedBundle)).toEqual(
      selectedBundle,
    );
    const { projectionRevision, workspaceId, ...detailLeaf } = detail;
    void projectionRevision;
    void workspaceId;
    expect(taskWorkspaceDetailSchema.parse(detailLeaf)).toEqual(detailLeaf);
  });

  test("accepts assigned as any task or as an explicit agent filter", () => {
    const anyAssigned = {
      ...selectedBundle,
      view: "assigned" as const,
      firstPage: { ...firstPage, view: "assigned" as const },
    };
    expect(taskWorkspaceProjectionBundleSchema.safeParse(anyAssigned).success).toBeTrue();
    expect(taskWorkspaceProjectionBundleSchema.safeParse({
      ...anyAssigned,
      assignedAgentId: "agent_primary",
      firstPage: { ...anyAssigned.firstPage, assignedAgentId: "agent_primary" },
    }).success).toBeTrue();
    expect(taskWorkspaceProjectionBundleSchema.safeParse({
      ...selectedBundle,
      assignedAgentId: "agent_primary",
    }).success).toBeFalse();
  });

  test("rejects every cross-projection disagreement and duplicate task ID", () => {
    for (const invalid of [
      {
        ...selectedBundle,
        firstPage: { ...firstPage, workspaceId: OTHER_WORKSPACE_ID },
      },
      {
        ...selectedBundle,
        firstPage: { ...firstPage, view: "ready" },
      },
      {
        ...selectedBundle,
        firstPage: { ...firstPage, projectionRevision: 8 },
      },
      { ...selectedBundle, continuationRevision: 0 },
      { ...selectedBundle, continuationRevision: 8 },
      { ...selectedBundle, selectedTaskId: null },
      { ...selectedBundle, detail: null },
      {
        ...selectedBundle,
        detail: { ...detail, workspaceId: OTHER_WORKSPACE_ID },
      },
      {
        ...selectedBundle,
        detail: { ...detail, projectionRevision: 8 },
      },
      {
        ...selectedBundle,
        detail: { ...detail, task: otherTask },
      },
      {
        ...selectedBundle,
        firstPage: {
          ...firstPage,
          items: [
            firstPage.items[0],
            { ...firstPage.items[0], task: { ...task } },
          ],
        },
      },
    ]) {
      expect(taskWorkspaceProjectionBundleSchema.safeParse(invalid).success).toBeFalse();
    }
  });

  test("requires no detail when no public task is selected", () => {
    expect(taskWorkspaceProjectionBundleSchema.safeParse({
      ...selectedBundle,
      selectedTaskId: null,
      detail: null,
    }).success).toBeTrue();
  });
});
