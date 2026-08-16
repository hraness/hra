import { describe, expect, test } from "bun:test";
import type { RunInteractionResponse } from "@hraness/agent-tasks-protocol";

import {
  agentTasksCreateRequest,
} from "./scenarios";
import {
  createAgentTasksDirectSession,
  type AgentTasksDirectSession,
} from "./runtime";
import {
  agentTasksReviewTask,
} from "./world";

function openSession(id: string): AgentTasksDirectSession {
  const created = createAgentTasksDirectSession({
    kind: "scenario",
    scenario: id,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("Agent Tasks deterministic workspace adapter", () => {
  test("applies one exact rejection and retains immutable recovery evidence", async () => {
    const session = openSession("tasks-review-rejected");
    const { harness } = session;
    const result = await harness.actions.rejectSubmission({
      reason: "Evidence does not prove sibling credential isolation.",
      reviewRevision: 4,
      submissionId: "sub_01J3ABCDEFGHJKMNPQRSTVWXYZ",
      taskKey: agentTasksReviewTask.key,
    });
    expect(result).toEqual({ ok: true, requestId: "req_review_rejected" });
    const detail = session.store.getSnapshot().world.details.find(
      ({ task }) => task.key === agentTasksReviewTask.key,
    );
    expect(detail).toMatchObject({
      recoveries: expect.arrayContaining([{ kind: "submission_rejected" }]),
      submission: {
        reviewReason: "Evidence does not prove sibling credential isolation.",
        status: "rejected",
      },
      task: { isReady: true, status: "open" },
    });
    expect(harness.getSnapshot()).toMatchObject({
      remainingScripts: { commands: 0, pages: 0 },
      requests: 1,
      violations: 0,
    });
    expect(() => harness.assertScriptsDrained()).not.toThrow();
    session.dispose();
  });

  test("returns an intentional stale-review conflict without mutating the submission", async () => {
    const session = openSession("tasks-review-conflict");
    const { harness } = session;
    const result = await harness.actions.acceptSubmission({
      reviewRevision: 4,
      submissionId: "sub_01J3ABCDEFGHJKMNPQRSTVWXYZ",
      taskKey: agentTasksReviewTask.key,
    });
    expect(result).toEqual({
      error: { code: "TASK_STATE_CONFLICT", reference: "req_stale_review" },
      ok: false,
    });
    expect(harness.getProps().read).toMatchObject({
      kind: "ready",
      selection: { detail: { submission: { status: "pending" } }, kind: "ready" },
    });
    expect(harness.getSnapshot()).toMatchObject({
      remainingScripts: { commands: 0 },
      violations: 0,
    });
    expect(() => harness.assertScriptsDrained()).not.toThrow();
    session.dispose();
  });

  test("creates and selects one task through the real action port", async () => {
    const session = openSession("tasks-create-success");
    const { harness } = session;
    const result = await harness.actions.createTask(agentTasksCreateRequest);
    expect(result).toEqual({ ok: true, requestId: "req_task_created" });
    const world = session.store.getSnapshot().world;
    expect(world.selectedTaskKey).toBe("AT-9XZ2KMN");
    expect(world.views.all).toMatchObject({
      kind: "ready",
      tasks: [expect.objectContaining({ key: "AT-9XZ2KMN", status: "open" })],
    });
    expect(world.views.ready).toMatchObject({
      kind: "ready",
      tasks: [expect.objectContaining({ key: "AT-9XZ2KMN", isReady: true })],
    });
    expect(() => harness.assertScriptsDrained()).not.toThrow();
    session.dispose();
  });

  test("cancels one queued run through the exact Stop action", async () => {
    const session = openSession("runner-queued-cancel");
    const { harness } = session;
    const result = await harness.actions.requestRunStop({ runId: "run_direct_primary0001" });
    expect(result).toEqual({ ok: true, requestId: "req_queued_cancelled" });
    expect(harness.getProps().read).toMatchObject({
      kind: "ready",
      selection: {
        detail: {
          runs: [expect.objectContaining({
            desiredState: "stop",
            id: "run_direct_primary0001",
            phase: "cancelled",
          })],
        },
        kind: "ready",
      },
    });
    expect(() => harness.assertScriptsDrained()).not.toThrow();
    session.dispose();
  });

  const hitlResponseExamples: readonly {
    readonly id: string;
    readonly requestId: string;
    readonly response: RunInteractionResponse;
  }[] = [
    {
      id: "runner-waiting-approval",
      response: { kind: "file_change_approval", decision: "approve_once" },
      requestId: "req_direct_approval",
    },
    {
      id: "runner-waiting-question",
      response: {
        kind: "user_input",
        answers: [{
          questionId: "question_directgate01",
          selectedOptionIds: ["option_directfullgate01"],
        }],
      },
      requestId: "req_direct_question",
    },
  ];

  for (const example of hitlResponseExamples) {
    test(`consumes the exact ${example.id} HITL response and settles activity`, async () => {
      const session = openSession(example.id);
    const { harness } = session;
      const read = harness.getProps().read;
      if (read.kind !== "ready" || read.selection.kind !== "ready") {
        throw new Error("The HITL scenario must select one ready task detail.");
      }
      const run = read.selection.detail.runs[0];
      const interaction = run?.interactions[0];
      if (run === undefined || interaction === undefined) {
        throw new Error("The HITL scenario must contain one run interaction.");
      }
      const result = await harness.actions.respondToRunInteraction({
        interactionId: interaction.request.id,
        request: interaction.request,
        response: example.response,
        runId: run.id,
      });
      expect(result).toEqual({ ok: true, requestId: example.requestId });
      expect(harness.getProps().read).toMatchObject({
        kind: "ready",
        selection: {
          detail: { runs: [{ interactions: [{ state: "answered" }] }] },
          kind: "ready",
        },
      });
      expect(harness.getSnapshot()).toMatchObject({
        remainingScripts: { interactions: 0 },
        requests: 1,
        violations: 0,
      });
      const activity = session.store.getSnapshot().activity;
      expect(activity.active).toBe(0);
      expect(activity.started).toBe(activity.settled);
      expect(() => harness.assertScriptsDrained()).not.toThrow();
      session.dispose();
    });
  }

  test("keeps an exact HITL script pending when a different valid response arrives", async () => {
    const session = openSession("runner-waiting-approval");
    const { harness } = session;
    const read = harness.getProps().read;
    if (read.kind !== "ready" || read.selection.kind !== "ready") {
      throw new Error("The HITL scenario must select one ready task detail.");
    }
    const run = read.selection.detail.runs[0];
    const interaction = run?.interactions[0];
    if (run === undefined || interaction === undefined) {
      throw new Error("The HITL scenario must contain one run interaction.");
    }

    const result = await harness.actions.respondToRunInteraction({
      interactionId: interaction.request.id,
      request: interaction.request,
      response: { kind: "file_change_approval", decision: "decline" },
      runId: run.id,
    });

    expect(result).toEqual({ error: { code: "DIRECT_SCRIPT_MISMATCH" }, ok: false });
    expect(harness.getProps().read).toMatchObject({
      kind: "ready",
      selection: {
        detail: { runs: [{ interactions: [{ state: "pending" }] }] },
        kind: "ready",
      },
    });
    expect(harness.getSnapshot()).toMatchObject({
      remainingScripts: { interactions: 1 },
      requests: 1,
      violations: 1,
    });
    const activity = session.store.getSnapshot().activity;
    expect(activity.active).toBe(0);
    expect(activity.started).toBe(activity.settled);
    expect(() => harness.assertScriptsDrained()).toThrow("1 HITL scripts remain");
    session.dispose();
  });

  for (const scenario of [
    { id: "runner-failed-retry", sourcePhase: "failed" },
    { id: "runner-cancelled-retry", sourcePhase: "cancelled" },
  ] as const) {
    test(`retries a ${scenario.sourcePhase} run by appending a new queued attempt`, async () => {
      const session = openSession(scenario.id);
    const { harness } = session;
      const result = await harness.actions.retryRun({
        runId: "run_direct_primary0001",
        taskRevision: 10,
      });
      expect(result.ok).toBe(true);
      const read = harness.getProps().read;
      expect(read).toMatchObject({
        kind: "ready",
        selection: {
          detail: {
            runs: [
              expect.objectContaining({ id: "run_direct_retry0000001", phase: "queued" }),
              expect.objectContaining({ id: "run_direct_primary0001", phase: scenario.sourcePhase }),
            ],
          },
          kind: "ready",
        },
      });
      expect(() => harness.assertScriptsDrained()).not.toThrow();
      session.dispose();
    });
  }

  test("resolves an ambiguous run only after an exact human confirmation", async () => {
    const session = openSession("runner-ambiguous-resolve");
    const { harness } = session;
    const result = await harness.actions.abandonAmbiguousRun({
      reason: "confirmed_cancelled",
      runId: "run_direct_primary0001",
      taskRevision: 10,
    });
    expect(result).toEqual({ ok: true, requestId: "req_ambiguity_resolved" });
    const world = session.store.getSnapshot().world;
    const detail = world.details.find(({ task }) => task.key === agentTasksReviewTask.key);
    expect(detail).toMatchObject({
      runs: [expect.objectContaining({ desiredState: "stop", phase: "cancelled" })],
      task: { isReady: true, revision: 11, status: "open" },
    });
    expect(
      detail !== undefined && "currentClaim" in detail.task
        ? detail.task.currentClaim
        : undefined,
    ).toBeUndefined();
    expect(world.views.ready).toMatchObject({
      kind: "ready",
      tasks: [expect.objectContaining({ key: agentTasksReviewTask.key })],
    });
    expect(() => harness.assertScriptsDrained()).not.toThrow();
    session.dispose();
  });

  test("consumes an exact page only in its named queue", () => {
    const session = openSession("tasks-pagination-scope");
    const { harness } = session;
    const readyBefore = structuredClone(session.store.getSnapshot().world.views.ready);
    harness.actions.loadMore("page:all:1", "all");
    const world = session.store.getSnapshot().world;
    expect(world.views.all).toMatchObject({ cursor: null, kind: "ready" });
    if (world.views.all.kind !== "ready") throw new Error("The all queue must be ready.");
    expect(world.views.all.tasks.map(({ key }) => key)).toEqual([
      "AT-12AB3CD",
      "AT-45EF6GH",
      "AT-78JK9MN",
    ]);
    expect(world.views.ready).toEqual(readyBefore);
    expect(() => harness.assertScriptsDrained()).not.toThrow();
    session.dispose();
  });

  test("keeps unexpected commands visible as violations without consuming scripts", async () => {
    const session = openSession("tasks-review-conflict");
    const { harness } = session;
    await harness.actions.acceptSubmission({
      reviewRevision: 5,
      submissionId: "sub_01J3ABCDEFGHJKMNPQRSTVWXYZ",
      taskKey: agentTasksReviewTask.key,
    });
    expect(harness.getSnapshot()).toMatchObject({
      remainingScripts: { commands: 1 },
      violations: 2,
    });
    expect(() => harness.assertScriptsDrained()).toThrow("did not drain cleanly");
    session.dispose();
  });
});
