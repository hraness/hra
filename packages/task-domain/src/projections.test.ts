import { describe, expect, test } from "bun:test";

import {
  MAX_PORTABLE_PROJECTION_PAGE_SIZE,
  portableInvalidationSchema,
  portableRunProjectionSchema,
  portableTaskChangeKindValues,
  portableTaskChangeRecordSchema,
  taskDetailProjectionSchema,
  taskListPageSchema,
  taskWorkspaceDetailCollectionValues,
  taskWorkspaceRecoveryKindValues,
  taskWorkspaceViewValues,
  workspaceSelectionSchema,
} from "./index";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const TASK_ID = `tsk_${LOCATOR}`;
const RUN_ID = "run_primary0001";
const TASK_CHANGE_PROJECTIONS = [{
  projection: "task_list" as const,
  views: [...taskWorkspaceViewValues],
}, {
  projection: "task_detail" as const,
}] as const;
const TASK_CHANGE_PROJECTIONS_WITH_SUMMARY = [{
  projection: "workspace_summary" as const,
}, ...TASK_CHANGE_PROJECTIONS] as const;
const task = {
  id: TASK_ID,
  key: "KIT-123ABCD",
  title: "Make soup",
  type: "task" as const,
  priority: 2,
  availableAt: 1,
  isReady: true,
  unresolvedBlockerCount: 0,
  cancelledBlockerCount: 0,
  revision: 1,
  reviewRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  status: "open" as const,
};

describe("portable bounded projections", () => {
  test("freezes the shared workspace view, collection, and recovery seams", () => {
    expect(taskWorkspaceViewValues).toEqual([
      "all",
      "ready",
      "blocked",
      "deferred",
      "attention",
      "assigned",
      "review",
    ]);
    expect(taskWorkspaceDetailCollectionValues).toEqual([
      "blockers",
      "children",
      "comments",
      "dependents",
      "events",
      "references",
      "runs",
    ]);
    expect(taskWorkspaceRecoveryKindValues).toEqual([
      "access_revoked",
      "task_cancelled",
      "submission_rejected",
      "claim_expired",
      "cancelled_blocker",
    ]);
    expect(portableTaskChangeKindValues).toEqual([
      "run.admitted",
      "run.display_changed",
      "run.event_appended",
      "run.interaction_changed",
      "run.phase_changed",
      "task.submitted",
    ]);
  });

  test("binds workspace selection to one provider-neutral authority", () => {
    const selection = {
      workspace: {
        id: WORKSPACE_ID,
        name: "HRA",
        slug: "hra",
        keyPrefix: "KIT",
        revision: 1,
        authority: {
          kind: "local" as const,
          localWorkspaceId: WORKSPACE_ID,
          ownerInstallationId: "install_0123456789abcdef0123456789abcdef",
        },
        counts: {
          all: { capped: false, value: 1 },
          ready: { capped: false, value: 1 },
          blocked: { capped: false, value: 0 },
          deferred: { capped: false, value: 0 },
          attention: { capped: false, value: 0 },
          assigned: { capped: false, value: 0 },
          review: { capped: false, value: 0 },
        },
      },
      selectedTaskId: TASK_ID,
      view: "ready" as const,
    };
    expect(workspaceSelectionSchema.parse(selection)).toEqual(selection);
    expect(workspaceSelectionSchema.safeParse({
      ...selection,
      workspace: {
        ...selection.workspace,
        authority: {
          ...selection.workspace.authority,
          localWorkspaceId: "wsp_1123456789ABCDEFGHJKMNPQRS",
        },
      },
    }).success).toBeFalse();
  });

  test("enforces page, cursor, and public-ID bounds", () => {
    const page = {
      workspaceId: WORKSPACE_ID,
      view: "ready" as const,
      projectionRevision: 1,
      items: [{ humanInput: null, run: null, task }],
      cursor: null,
      hasMore: false,
    };
    expect(taskListPageSchema.parse(page)).toEqual(page);
    expect(taskListPageSchema.safeParse({ ...page, cursor: "next" }).success).toBeFalse();
    expect(taskListPageSchema.safeParse({
      ...page,
      items: Array.from(
        { length: MAX_PORTABLE_PROJECTION_PAGE_SIZE + 1 },
        () => ({ humanInput: null, run: null, task }),
      ),
    }).success).toBeFalse();
    expect(taskListPageSchema.safeParse({
      ...page,
      items: [{ humanInput: null, run: null, task: { ...task, id: "convex_document_id" } }],
    }).success).toBeFalse();
    expect(taskListPageSchema.safeParse({
      ...page,
      items: [{
        humanInput: null,
        run: {
          latestDisplay: {
            kind: "codex.assistant_message.delta",
            observedAt: 1,
          },
          phase: "running",
          updatedAt: 1,
        },
        task,
      }],
    }).success).toBeFalse();
  });

  test("keeps detail and invalidation records bounded and secret-free", () => {
    const detail = {
      workspaceId: WORKSPACE_ID,
      projectionRevision: 1,
      task,
      description: "Use vegetables.",
      labels: ["hra"],
      parent: null,
      blockers: [],
      dependents: [],
      children: [],
      comments: [],
      events: [],
      references: [{
        id: `ref_${LOCATOR}`,
        createdAt: 1,
        kind: "url" as const,
        label: "Recipe",
        url: "https://example.com/recipe",
      }],
      runs: [{
        id: "run_primary0001",
        taskKey: task.key,
        phase: "failed" as const,
        repositoryId: `repo_${LOCATOR}`,
        desiredState: "run" as const,
        updatedAt: 2,
        events: [{
          id: "event_primary0001",
          sequence: 1,
          kind: "run.failed" as const,
          observedAt: 2,
        }],
        interactions: [],
      }],
      submission: null,
      recoveries: [],
      truncatedCollections: [],
    };
    expect(taskDetailProjectionSchema.parse(detail)).toEqual(detail);
    expect(taskDetailProjectionSchema.safeParse({
      ...detail,
      runs: [{ ...detail.runs[0], taskKey: "KIT-7654321" }],
    }).success).toBeFalse();
    expect(taskDetailProjectionSchema.safeParse({
      ...detail,
      runs: [{
        ...detail.runs[0],
        interactions: [{
          runId: "run_foreign0001",
          request: {
            id: "interaction_primary0001",
            createdAt: 1,
            expiresAt: 2,
            kind: "file_change_approval",
            scope: "once",
          },
          state: "pending",
        }],
      }],
    }).success).toBeFalse();
    for (const forbidden of [
      { accessToken: "secret" },
      { localPath: "/Users/person/project" },
      { claimLease: { fence: 1 } },
      { interactionAnswers: ["yes"] },
      { transcript: "private" },
    ]) {
      expect(taskDetailProjectionSchema.safeParse({ ...detail, ...forbidden }).success).toBeFalse();
    }

    const invalidation = {
      workspaceId: WORKSPACE_ID,
      projectionRevision: 2,
      scope: "task_change" as const,
      taskId: TASK_ID,
      runId: RUN_ID,
      changeKind: "run.display_changed" as const,
      affectedProjections: TASK_CHANGE_PROJECTIONS,
    };
    expect(portableTaskChangeRecordSchema.safeParse(invalidation).success).toBeTrue();
    expect(portableInvalidationSchema.safeParse(invalidation).success).toBeTrue();
    expect(portableInvalidationSchema.safeParse({
      ...invalidation,
      transcript: "private",
    }).success).toBeFalse();
    expect(portableTaskChangeRecordSchema.safeParse({
      ...invalidation,
      affectedProjections: [
        invalidation.affectedProjections[0],
        invalidation.affectedProjections[0],
      ],
    }).success).toBeFalse();
    expect(portableTaskChangeRecordSchema.safeParse({
      ...invalidation,
      affectedProjections: [{
        projection: "task_list",
        views: ["all", "all"],
      }],
    }).success).toBeFalse();
  });

  test("makes each task-change projection contract exact", () => {
    const base = {
      workspaceId: WORKSPACE_ID,
      projectionRevision: 2,
      scope: "task_change" as const,
      taskId: TASK_ID,
      runId: RUN_ID,
    };
    for (const changeKind of ["run.admitted", "task.submitted"] as const) {
      expect(portableTaskChangeRecordSchema.safeParse({
        ...base,
        changeKind,
        affectedProjections: TASK_CHANGE_PROJECTIONS_WITH_SUMMARY,
      }).success).toBeTrue();
      expect(portableTaskChangeRecordSchema.safeParse({
        ...base,
        changeKind,
        affectedProjections: TASK_CHANGE_PROJECTIONS,
      }).success).toBeFalse();
    }
    for (const changeKind of [
      "run.display_changed",
      "run.interaction_changed",
      "run.phase_changed",
    ] as const) {
      expect(portableTaskChangeRecordSchema.safeParse({
        ...base,
        changeKind,
        affectedProjections: TASK_CHANGE_PROJECTIONS,
      }).success).toBeTrue();
      expect(portableTaskChangeRecordSchema.safeParse({
        ...base,
        changeKind,
        affectedProjections: TASK_CHANGE_PROJECTIONS_WITH_SUMMARY,
      }).success).toBeFalse();
    }
    for (const affectedProjections of [
      TASK_CHANGE_PROJECTIONS,
      TASK_CHANGE_PROJECTIONS_WITH_SUMMARY,
    ]) {
      expect(portableTaskChangeRecordSchema.safeParse({
        ...base,
        changeKind: "run.event_appended",
        affectedProjections,
      }).success).toBeTrue();
    }

    for (const affectedProjections of [
      [TASK_CHANGE_PROJECTIONS[0]],
      [TASK_CHANGE_PROJECTIONS[1]],
      [{
        projection: "task_list",
        views: taskWorkspaceViewValues.slice(0, -1),
      }, TASK_CHANGE_PROJECTIONS[1]],
      [{
        projection: "task_list",
        views: [...taskWorkspaceViewValues].reverse(),
      }, TASK_CHANGE_PROJECTIONS[1]],
    ]) {
      expect(portableTaskChangeRecordSchema.safeParse({
        ...base,
        changeKind: "run.phase_changed",
        affectedProjections,
      }).success).toBeFalse();
    }
  });

  test("enumerates every task view affected by a portable run change", () => {
    const record = portableTaskChangeRecordSchema.parse({
      workspaceId: WORKSPACE_ID,
      projectionRevision: 2,
      scope: "task_change",
      taskId: TASK_ID,
      runId: RUN_ID,
      changeKind: "run.event_appended",
      affectedProjections: TASK_CHANGE_PROJECTIONS,
    });
    const affectedList = record.affectedProjections.find(
      ({ projection }) => projection === "task_list",
    );

    expect(affectedList).toEqual({
      projection: "task_list",
      views: [...taskWorkspaceViewValues],
    });
  });

  test("applies contiguous event, unique ID, display, and interaction laws to shared runs", () => {
    const run = {
      id: "run_primary0001",
      taskKey: task.key,
      phase: "running" as const,
      repositoryId: `repo_${LOCATOR}`,
      desiredState: "run" as const,
      updatedAt: 2,
      events: [{
        id: "event_primary0001",
        sequence: 1,
        kind: "codex.running" as const,
        observedAt: 2,
      }, {
        id: "event_primary0002",
        sequence: 2,
        kind: "codex.assistant_message.delta" as const,
        displayText: "Working",
        observedAt: 3,
      }],
      interactions: [{
        runId: "run_primary0001",
        request: {
          id: "interaction_primary0001",
          createdAt: 2,
          expiresAt: 3,
          kind: "user_input" as const,
          questions: [{
            id: "question_primary0001",
            header: "Choice",
            prompt: "Continue?",
            allowOther: false,
            options: [{ id: "option_primary0001", label: "Yes" }],
          }],
        },
        state: "pending" as const,
      }],
    };
    expect(portableRunProjectionSchema.parse(run)).toEqual(run);
    const [firstEvent, secondEvent] = run.events;
    const interaction = run.interactions[0];
    const question = interaction?.request.kind === "user_input"
      ? interaction.request.questions[0]
      : undefined;
    const option = question?.options[0];
    if (
      firstEvent === undefined ||
      secondEvent === undefined ||
      interaction === undefined ||
      question === undefined ||
      option === undefined
    ) {
      throw new Error("run projection fixture must remain complete");
    }
    expect(portableRunProjectionSchema.safeParse({
      ...run,
      events: [firstEvent, { ...secondEvent, id: firstEvent.id }],
    }).success).toBeFalse();
    expect(portableRunProjectionSchema.safeParse({
      ...run,
      events: [firstEvent, { ...secondEvent, sequence: 3 }],
    }).success).toBeFalse();
    expect(portableRunProjectionSchema.safeParse({
      ...run,
      interactions: [{
        ...interaction,
        request: {
          ...interaction.request,
          questions: [
            question,
            question,
          ],
        },
      }],
    }).success).toBeFalse();
    expect(portableRunProjectionSchema.safeParse({
      ...run,
      interactions: [{
        ...interaction,
        request: {
          ...interaction.request,
          questions: [{
            ...question,
            options: [
              option,
              option,
            ],
          }],
        },
      }],
    }).success).toBeFalse();
    expect(portableRunProjectionSchema.safeParse({
      ...run,
      interactions: [{
        ...interaction,
        state: "answered",
      }],
    }).success).toBeFalse();
    expect(portableRunProjectionSchema.safeParse({
      ...run,
      interactions: [{
        ...interaction,
        state: "pending",
        responseRevision: 1,
        respondedAt: 3,
      }],
    }).success).toBeFalse();
    expect(portableRunProjectionSchema.safeParse({
      ...run,
      interactions: [{
        ...interaction,
        state: "resolved",
        responseRevision: 1,
        respondedAt: 4,
        resolvedAt: 3,
      }],
    }).success).toBeFalse();
  });
});
