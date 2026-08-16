import { describe, expect, test } from "bun:test";
import { uuidV7Schema, type IdempotencyKey, type SubmitTaskRequest, type TaskKey } from "@hraness/agent-tasks-protocol";

import {
  DispatchCompletionAdapter,
  deterministicSubmissionIdempotencyKey,
  type DispatchCompletionStore,
} from "../src/dispatch/completion-adapter";
import type { DispatchCloudResult } from "../src/dispatch/cloud-client";
import type { PublicRunEventKind, DispatchStage } from "../src/dispatch/model";
import type { SessionTurnLifecycle } from "../src/sessions/session-service";
import type { DispatchBinding } from "../src/state/dispatch-store";

const lifecycle = {
  accountProfileId: "acct_primary0001",
  threadId: "thread_primary0001",
  turnId: "turn_primary000001",
  status: "completed",
} as const satisfies SessionTurnLifecycle;

function initialBinding(): DispatchBinding {
  return {
    runId: "run_primary0001",
    taskId: "task_primary0001",
    taskKey: "OPS-7K2M4Q9",
    claimId: "claim_primary001",
    claimFence: 7,
    inputReviewRevision: 3,
    runtimePublicId: "runner_primary0001",
    runtimeBootId: "boot_primary0001",
    repositoryPublicId: "repo_primary0001",
    executionMode: "managed_worktree",
    accountProfileId: lifecycle.accountProfileId,
    laneId: null,
    threadId: lifecycle.threadId,
    turnId: lifecycle.turnId,
    stage: "running",
    baseSha: "a".repeat(40),
    branchName: "codex/oprte-run_primary0001",
    lastEventSequence: 5,
    failureCode: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
}

class MemoryCompletionStore implements DispatchCompletionStore {
  binding = initialBinding();
  readonly events: { readonly eventId: string; readonly kind: PublicRunEventKind }[] = [];

  readByTurn(event: { accountProfileId: string; threadId: string; turnId: string }): DispatchBinding | null {
    return event.accountProfileId === this.binding.accountProfileId &&
        event.threadId === this.binding.threadId &&
        event.turnId === this.binding.turnId
      ? this.binding
      : null;
  }

  readTurnStartingByThread(event: {
    accountProfileId: string;
    threadId: string;
  }): DispatchBinding | null {
    return event.accountProfileId === this.binding.accountProfileId &&
        event.threadId === this.binding.threadId &&
        this.binding.stage === "turn_starting"
      ? this.binding
      : null;
  }

  transition(input: { runId: string; to: DispatchStage; failureCode?: string }): DispatchBinding {
    if (input.runId !== this.binding.runId) throw new Error("unknown run");
    this.binding = {
      ...this.binding,
      stage: input.to,
      failureCode: input.failureCode ?? this.binding.failureCode,
    };
    return this.binding;
  }

  appendPublicEvent(input: {
    runId: string;
    eventId: string;
    kind: PublicRunEventKind;
  }): { readonly sequence: number } {
    if (!this.events.some(({ eventId }) => eventId === input.eventId)) {
      this.events.push({ eventId: input.eventId, kind: input.kind });
    }
    this.binding = { ...this.binding, lastEventSequence: this.events.length + 5 };
    return { sequence: this.binding.lastEventSequence };
  }

  hasOpenToolActivity(runId: string): boolean {
    if (runId !== this.binding.runId) return false;
    let open = false;
    for (const event of this.events) {
      if (event.kind === "codex.tool_activity.started") open = true;
      if (event.kind === "codex.tool_activity.completed") open = false;
    }
    return open;
  }

  toolActivityEventCount(runId: string): number {
    return runId === this.binding.runId
      ? this.events.filter(({ kind }) =>
        kind === "codex.tool_activity.started" || kind === "codex.tool_activity.completed"
      ).length
      : 0;
  }
}

const publication = {
  acknowledgeThrough: () => Promise.resolve(true),
};

interface SubmissionCall {
  readonly taskKey: TaskKey;
  readonly request: SubmitTaskRequest;
  readonly idempotencyKey: IdempotencyKey;
}

describe("dispatch completion adapter", () => {
  test("submits fixed semantic evidence before durably publishing run.submitted", async () => {
    const store = new MemoryCompletionStore();
    const calls: SubmissionCall[] = [];
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication,
      cloud: {
        submitTask(taskKey, request, idempotencyKey) {
          calls.push({ taskKey, request, idempotencyKey });
          return Promise.resolve({ ok: true, data: {}, requestId: "req_01K0M6Q7R8S9T0V1W2X3Y4Z5A6" });
        },
      },
    });

    adapter.observe(lifecycle);
    await adapter.settled();
    await adapter.reconcile(lifecycle);

    expect(store.binding.stage).toBe("completed");
    expect(store.events).toEqual([{
      eventId: "run_primary0001:6",
      kind: "run.submitted",
    }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      taskKey: "OPS-7K2M4Q9",
      idempotencyKey: deterministicSubmissionIdempotencyKey(initialBinding()),
      request: {
        fence: 7,
        expectedReviewRevision: 3,
        dispatch: {
          runId: "run_primary0001",
          runnerId: "runner_primary0001",
          bootId: "boot_primary0001",
          claimId: "claim_primary001",
          claimFence: 7,
        },
        summary: "Completed by Codex in HRA and ready for human review.",
        evidence: [{ kind: "note", text: "The managed Codex turn completed successfully." }],
      },
    });
    expect(uuidV7Schema.safeParse(calls[0]?.idempotencyKey).success).toBeTrue();
    expect(JSON.stringify(calls)).not.toContain("/private/");
    expect(JSON.stringify(calls)).not.toContain("provider");
    expect(JSON.stringify(calls)).not.toContain("transcript");
  });

  test.each([
    ["failed", "failed", "run.failed", "codex_turn_failed"],
    ["interrupted", "cancelled", "run.cancelled", null],
  ] as const)("maps a %s Codex turn to its semantic terminal", async (
    status,
    stage,
    kind,
    failureCode,
  ) => {
    const store = new MemoryCompletionStore();
    let submitted = false;
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication,
      cloud: {
        submitTask() {
          submitted = true;
          return Promise.resolve({ ok: true, data: {}, requestId: "req_01K0M6Q7R8S9T0V1W2X3Y4Z5A6" });
        },
      },
    });

    await adapter.reconcile({ ...lifecycle, status });

    expect(store.binding).toMatchObject({ stage, failureCode });
    expect(store.events.map((event) => event.kind)).toEqual([kind]);
    expect(submitted).toBeFalse();
  });

  test.each([
    ["failed", "run.failed"],
    ["interrupted", "run.cancelled"],
  ] as const)("closes an open tool span before an adversarially fast %s terminal", async (
    status,
    terminalKind,
  ) => {
    const store = new MemoryCompletionStore();
    store.appendPublicEvent({
      runId: store.binding.runId,
      eventId: "tool_activity_started",
      kind: "codex.tool_activity.started",
    });
    const acknowledgements: number[] = [];
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: {
        acknowledgeThrough(_runId, throughSequence) {
          acknowledgements.push(throughSequence);
          return Promise.resolve(true);
        },
      },
      cloud: {
        submitTask() {
          throw new Error("a failed or interrupted turn must not submit");
        },
      },
    });

    await adapter.reconcile({ ...lifecycle, status });

    expect(store.events.map(({ kind }) => kind)).toEqual([
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      terminalKind,
    ]);
    expect(store.hasOpenToolActivity(store.binding.runId)).toBeFalse();
    expect(acknowledgements).toEqual([8]);
  });

  test("closes an open tool span before an immediately resolved successful submission", async () => {
    const store = new MemoryCompletionStore();
    store.appendPublicEvent({
      runId: store.binding.runId,
      eventId: "tool_activity_started",
      kind: "codex.tool_activity.started",
    });
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication,
      cloud: {
        submitTask() {
          store.appendPublicEvent({
            runId: store.binding.runId,
            eventId: "late_tool_activity_started",
            kind: "codex.tool_activity.started",
          });
          return Promise.resolve({
            ok: true,
            data: {},
            requestId: "req_01K0M6Q7R8S9T0V1W2X3Y4Z5A6",
          });
        },
      },
    });

    await adapter.reconcile(lifecycle);

    expect(store.events.map(({ kind }) => kind)).toEqual([
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "run.submitted",
    ]);
    expect(store.hasOpenToolActivity(store.binding.runId)).toBeFalse();
  });

  test("does not submit or publish completion after its complete fence goes stale", async () => {
    const store = new MemoryCompletionStore();
    store.appendPublicEvent({
      runId: store.binding.runId,
      eventId: "tool_activity_started",
      kind: "codex.tool_activity.started",
    });
    let submitted = false;
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(false) },
      publication,
      cloud: {
        submitTask() {
          submitted = true;
          return Promise.resolve({ ok: true, data: {}, requestId: "req_01K0M6Q7R8S9T0V1W2X3Y4Z5A6" });
        },
      },
    });

    await adapter.reconcile(lifecycle);

    expect(store.binding.stage).toBe("lease_lost");
    expect(store.events.map((event) => event.kind)).toEqual([
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "run.lease_lost",
    ]);
    expect(store.hasOpenToolActivity(store.binding.runId)).toBeFalse();
    expect(submitted).toBeFalse();
  });

  test.each([
    ["CLAIM_STALE", "lease_lost", "run.lease_lost"],
    ["VALIDATION_ERROR", "failed", "run.failed"],
  ] as const)("closes an open tool span before a completed submission returns %s", async (
    code,
    stage,
    terminalKind,
  ) => {
    const store = new MemoryCompletionStore();
    store.appendPublicEvent({
      runId: store.binding.runId,
      eventId: "tool_activity_started",
      kind: "codex.tool_activity.started",
    });
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication,
      cloud: {
        submitTask() {
          store.appendPublicEvent({
            runId: store.binding.runId,
            eventId: "late_tool_activity_started",
            kind: "codex.tool_activity.started",
          });
          return Promise.resolve({
            ok: false,
            error: {
              kind: "remote",
              code,
              requestId: "req_01K0M6Q7R8S9T0V1W2X3Y4Z5A6",
            },
          });
        },
      },
    });

    await adapter.reconcile(lifecycle);

    expect(store.binding.stage).toBe(stage);
    expect(store.events.map(({ kind }) => kind)).toEqual([
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      terminalKind,
    ]);
    expect(store.hasOpenToolActivity(store.binding.runId)).toBeFalse();
  });

  test("replays an ambiguous submission with the same idempotency key", async () => {
    const store = new MemoryCompletionStore();
    store.appendPublicEvent({
      runId: store.binding.runId,
      eventId: "tool_activity_started",
      kind: "codex.tool_activity.started",
    });
    const calls: SubmissionCall[] = [];
    const outcomes: DispatchCloudResult<unknown>[] = [
      { ok: false, error: { kind: "network" } },
      { ok: true, data: {}, requestId: "req_01K0M6Q7R8S9T0V1W2X3Y4Z5A6" },
    ];
    const diagnostics: string[] = [];
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication,
      onDiagnostic: ({ code }) => diagnostics.push(code),
      cloud: {
        submitTask(taskKey, request, idempotencyKey) {
          calls.push({ taskKey, request, idempotencyKey });
          const outcome = outcomes.shift();
          if (outcome === undefined) throw new Error("unexpected submission");
          if (calls.length === 1) {
            store.appendPublicEvent({
              runId: store.binding.runId,
              eventId: "in_flight_tool_activity_started",
              kind: "codex.tool_activity.started",
            });
          }
          return Promise.resolve(outcome);
        },
      },
    });

    await adapter.reconcile(lifecycle);
    expect(store.binding.stage).toBe("running");
    expect(store.hasOpenToolActivity(store.binding.runId)).toBeFalse();
    expect(store.events.map(({ kind }) => kind)).toEqual([
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
    ]);
    // Model a provider activity callback that was already queued when the
    // terminal lifecycle arrived and only clears its fence after the first
    // retryable submission settles.
    store.appendPublicEvent({
      runId: store.binding.runId,
      eventId: "late_tool_activity_started",
      kind: "codex.tool_activity.started",
    });
    await adapter.reconcile(lifecycle);

    expect(store.binding.stage).toBe("completed");
    expect(store.events.map(({ kind }) => kind)).toEqual([
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "run.submitted",
    ]);
    expect(store.hasOpenToolActivity(store.binding.runId)).toBeFalse();
    expect(calls).toHaveLength(2);
    const idempotencyKey = calls[0]?.idempotencyKey;
    if (idempotencyKey === undefined) throw new Error("expected a submission replay");
    expect(calls.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      idempotencyKey,
      idempotencyKey,
    ]);
    expect(diagnostics).toEqual(["submission_unavailable"]);
  });

  test("waits for stop and retry when the semantic task input changed", async () => {
    const store = new MemoryCompletionStore();
    store.appendPublicEvent({
      runId: store.binding.runId,
      eventId: "tool_activity_started",
      kind: "codex.tool_activity.started",
    });
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication,
      cloud: {
        submitTask() {
          store.appendPublicEvent({
            runId: store.binding.runId,
            eventId: "late_tool_activity_started",
            kind: "codex.tool_activity.started",
          });
          return Promise.resolve({
            ok: false,
            error: {
              kind: "remote",
              code: "TASK_STATE_CONFLICT",
              requestId: "req_01K0M6Q7R8S9T0V1W2X3Y4Z5A6",
            },
          });
        },
      },
    });

    expect(await adapter.reconcile(lifecycle)).toBeTrue();
    expect(store.binding).toMatchObject({ stage: "waiting", failureCode: "input_changed" });
    expect(store.events.map(({ kind }) => kind)).toEqual([
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "codex.waiting_for_input",
    ]);
    expect(store.hasOpenToolActivity(store.binding.runId)).toBeFalse();
  });

  test("retains a terminal lifecycle until its durable public event is acknowledged", async () => {
    const store = new MemoryCompletionStore();
    store.appendPublicEvent({
      runId: store.binding.runId,
      eventId: "tool_activity_started",
      kind: "codex.tool_activity.started",
    });
    const acknowledgements: number[] = [];
    let submissions = 0;
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: {
        acknowledgeThrough(_runId, throughSequence) {
          acknowledgements.push(throughSequence);
          return Promise.resolve(acknowledgements.length > 1);
        },
      },
      cloud: {
        submitTask() {
          submissions += 1;
          return Promise.resolve({
            ok: true,
            data: {},
            requestId: "req_01K0M6Q7R8S9T0V1W2X3Y4Z5A6",
          });
        },
      },
    });

    adapter.observe(lifecycle);
    await adapter.settled();
    expect(store.binding.stage).toBe("completed");
    expect(submissions).toBe(1);
    adapter.retryPending();
    await adapter.settled();

    expect(acknowledgements).toEqual([8, 8]);
    expect(submissions).toBe(1);
    expect(store.events.map(({ kind }) => kind)).toEqual([
      "codex.tool_activity.started",
      "codex.tool_activity.completed",
      "run.submitted",
    ]);
    expect(store.hasOpenToolActivity(store.binding.runId)).toBeFalse();
  });

  test("retains a fast terminal lifecycle until turn ownership is durably bound", async () => {
    const store = new MemoryCompletionStore();
    store.binding = {
      ...store.binding,
      stage: "turn_starting",
      turnId: null,
    };
    let submissions = 0;
    const adapter = new DispatchCompletionAdapter({
      store,
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication,
      cloud: {
        submitTask() {
          submissions += 1;
          return Promise.resolve({
            ok: true,
            data: {},
            requestId: "req_01K0M6Q7R8S9T0V1W2X3Y4Z5A6",
          });
        },
      },
    });

    adapter.observe(lifecycle);
    await adapter.settled();
    expect(submissions).toBe(0);
    store.binding = { ...store.binding, stage: "running", turnId: lifecycle.turnId };
    adapter.retryPending();
    await adapter.settled();

    expect(submissions).toBe(1);
    expect(store.binding.stage).toBe("completed");
  });
});
