import { describe, expect, test } from "bun:test";

import type { LocalCommand } from "../domain/contracts";
import {
  WORK_EVENT_PAGE_MAX_BYTES,
  WORK_PROTOCOL,
  WORK_PROTOCOL_VERSION,
  type WorkEventPage,
  type WorkOperationResult,
  type WorkPoll,
  type WorkSnapshot,
  type WorkTaskDetail,
  type WorkTaskHistoryPage,
} from "../domain/work";
import { workReadSuccessWireDocument } from "../domain/terminal-json";
import { describeWorkProtocol } from "../domain/work-protocol";
import {
  InvalidCommandResponseError,
  renderSuccess,
  type Output,
} from "./render";

const workId = `work_${"1".repeat(32)}` as const;
const otherWorkId = `work_${"9".repeat(32)}` as const;
const taskId = `task_${"2".repeat(32)}` as const;
const otherTaskId = `task_${"8".repeat(32)}` as const;
const actorSessionId = `sess_${"3".repeat(32)}` as const;
const accountId = `acct_${"4".repeat(32)}` as const;
const projectId = `proj_${"5".repeat(32)}` as const;
const streamEpoch = "018f1f64-6c17-7d35-8f8e-b24a1d3a5222";
const idempotencyKey = "018f1f64-6c17-7d35-8f8e-b24a1d3a5211";
const capability = `hrac1_${"A".repeat(43)}`;
const cursor = `hra1.${Buffer.from("work-render-cursor").toString("base64url")}.${"A".repeat(43)}`;

const capture = (): { output: Output; stdout: string[]; stderr: string[] } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      writeStdout: (value) => { stdout.push(value); },
      writeStderr: (value) => { stderr.push(value); },
    },
  };
};

const taskSpec = {
  clientRef: "task-1",
  dependsOnRefs: [],
  dependsOnTaskIds: [],
  objective: "Complete the task",
  instructions: "Make the smallest verified change.",
  criteria: ["Tests pass"],
  route: { accountId, projectId },
  preset: "low" as const,
  fast: false,
  priority: 0,
  maxAttempts: 3,
  requiredReviews: 1,
  resultKind: "text" as const,
  minEvidence: 1,
};

const taskSummary = {
  id: taskId,
  clientRef: taskSpec.clientRef,
  status: "waiting" as const,
  revision: 1,
  route: taskSpec.route,
  preset: taskSpec.preset,
  fast: taskSpec.fast,
  priority: 0,
  depth: 1,
  attemptCount: 0,
  activeAttemptId: null,
  latestSubmissionId: null,
};

const workRecord = {
  id: workId,
  clientRef: "plan",
  coordinatorSessionId: actorSessionId,
  objective: "Complete the plan",
  status: "open" as const,
  revision: 1,
  taskCount: 1,
  waitingTaskCount: 1,
  readyTaskCount: 0,
  activeTaskCount: 0,
  completedTaskCount: 0,
  failedTaskCount: 0,
  cancelledTaskCount: 0,
  createdAt: 1,
  updatedAt: 1,
  terminalAt: null,
};

const eventPage: WorkEventPage = {
  version: 1,
  workId,
  streamEpoch,
  requestedCursor: null,
  retentionFloorCursor: cursor,
  observedThroughCursor: cursor,
  nextCursor: cursor,
  gap: null,
  events: [],
};

const snapshot: WorkSnapshot = {
  version: 1,
  work: workRecord,
  routes: [{ accountId, projectId, preset: "low", fast: false }],
  cursor,
  tasks: [taskSummary],
  joinedSessionIds: [actorSessionId],
  recentSignals: [],
  omittedSignals: 0,
  terminal: null,
};

const taskDetail: WorkTaskDetail = {
  version: 1,
  workId,
  task: taskSummary,
  spec: taskSpec,
  parentTaskId: null,
  dependencyTaskIds: [],
  unmetDependencyTaskIds: [],
  activeAttempt: null,
  latestAttempt: null,
  latestAttemptReport: null,
  latestSubmission: null,
  latestSubmissionReviews: [],
  omittedLatestSubmissionReviews: 0,
  recentSignals: [],
  omittedSignals: 0,
  createdAt: 1,
  updatedAt: 1,
};

const taskHistory: WorkTaskHistoryPage = {
  version: 1,
  kind: "history",
  workId,
  taskId,
  taskRevision: 1,
  projectionAt: 1,
  requestedCursor: null,
  observedThroughCursor: cursor,
  offset: 0,
  totalItems: 0,
  counts: { attempts: 0, attemptReports: 0, submissions: 0, reviews: 0, signals: 0 },
  items: [],
  remainingItems: 0,
  remainingCounts: { attempts: 0, attemptReports: 0, submissions: 0, reviews: 0, signals: 0 },
  nextCursor: null,
};

const poll: WorkPoll = {
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
  preparedEffects: [],
  omitted: {
    readyTasks: 0,
    ownedAttempts: 0,
    recoveryAttempts: 0,
    reviewableSubmissions: 0,
    signals: 0,
    preparedEffects: 0,
  },
  eventPage,
};

const applyCommand = {
  kind: "work.apply",
  requestId: idempotencyKey,
  operation: {
    kind: "work.join",
    idempotencyKey,
    workId,
    coordinatorSessionId: actorSessionId,
    coordinatorCapability: capability,
    actorSessionId,
  },
} as const satisfies Extract<LocalCommand, { kind: "work.apply" }>;

const applyResult: WorkOperationResult = {
  kind: "work.join",
  workId,
  workRevision: 2,
  actorSessionId,
  memberCapability: capability,
};

const cases = [
  {
    command: { kind: "work.protocol", query: { kind: "index" } } as const,
    data: describeWorkProtocol({ kind: "index" }),
  },
  { command: applyCommand, data: applyResult },
  {
    command: { kind: "work.snapshot", work: workId } as const,
    data: snapshot,
  },
  {
    command: { kind: "work.task", task: taskId } as const,
    data: taskDetail,
  },
  {
    command: { kind: "work.task", task: taskId, historyLimit: 20 } as const,
    data: taskHistory,
  },
  {
    command: {
      kind: "work.poll",
      work: workId,
      limit: 20,
      waitMs: 0,
    } as const,
    data: poll,
  },
  {
    command: {
      kind: "work.events",
      work: workId,
      limit: 200,
      waitMs: 0,
    } as const,
    data: eventPage,
  },
] satisfies readonly Readonly<{ command: LocalCommand; data: unknown }>[];

describe("agent-first work CLI renderer contract", () => {
  test("renders every non-streaming work result as one versioned compact JSON value", () => {
    for (const fixture of cases) {
      const target = capture();
      renderSuccess(fixture.command, fixture.data, true, target.output);
      expect(target.stderr).toEqual([]);
      expect(target.stdout).toHaveLength(1);
      expect(target.stdout[0]?.endsWith("\n")).toBe(true);
      expect(target.stdout[0]?.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(target.stdout[0] ?? "")).toEqual(
        fixture.command.kind === "work.apply"
          ? {
              protocol: WORK_PROTOCOL,
              version: WORK_PROTOCOL_VERSION,
              requestId: fixture.command.requestId,
              ok: true,
              result: fixture.data,
            }
          : {
              ok: true,
              version: 1,
              command: fixture.command.kind,
              data: fixture.data,
            },
      );
    }
  });

  test("validates the complete response before writing any malformed daemon data", () => {
    const secret = "PRIVATE-WORK-RESPONSE-SENTINEL";
    const malformed = [
      {
        command: { kind: "work.protocol", query: { kind: "index" } } as const,
        data: { ...describeWorkProtocol({ kind: "index" }), rawProviderPayload: secret },
      },
      {
        command: { kind: "work.protocol", query: { kind: "index" } } as const,
        data: describeWorkProtocol({ kind: "operation", operation: "work.release" }),
      },
      {
        command: applyCommand,
        data: { ...applyResult, rawProviderPayload: secret },
      },
      {
        command: { kind: "work.snapshot", work: workId } as const,
        data: { ...snapshot, rawProviderPayload: secret },
      },
      {
        command: { kind: "work.task", task: taskId } as const,
        data: { ...taskDetail, rawProviderPayload: secret },
      },
      {
        command: { kind: "work.task", task: taskId } as const,
        data: {
          ...taskDetail,
          recentSignals: [{
            id: `sig_${"7".repeat(32)}`,
            senderSessionId: actorSessionId,
            targetSessionId: actorSessionId,
            accountGeneration: 1,
            taskId,
            replyToSignalId: null,
            mode: "queue",
            deliveryState: "pending",
            deliveryReceipt: null,
            body: secret,
            revision: 1,
            createdAt: 2,
            acknowledgedAt: 1,
          }],
        },
      },
      {
        command: { kind: "work.task", task: taskId, historyLimit: 20 } as const,
        data: { ...taskHistory, rawProviderPayload: secret },
      },
      {
        command: {
          kind: "work.poll",
          work: workId,
          limit: 20,
          waitMs: 0,
        } as const,
        data: { ...poll, rawProviderPayload: secret },
      },
      {
        command: {
          kind: "work.events",
          work: workId,
          limit: 200,
          waitMs: 0,
        } as const,
        data: { ...eventPage, rawProviderPayload: secret },
      },
    ] satisfies readonly Readonly<{ command: LocalCommand; data: unknown }>[];

    for (const fixture of malformed) {
      const target = capture();
      expect(() => renderSuccess(fixture.command, fixture.data, true, target.output))
        .toThrow(InvalidCommandResponseError);
      expect(target.stdout).toEqual([]);
      expect(target.stderr).toEqual([]);
      expect(JSON.stringify(target)).not.toContain(secret);
    }
  });

  test("rejects a valid history page that exceeds the command's requested item limit", () => {
    const items: WorkTaskHistoryPage["items"] = [1, 2].map((index) => ({
      kind: "signal" as const,
      value: {
        id: `sig_${String(index).padStart(32, "0")}`,
        senderSessionId: actorSessionId,
        targetSessionId: actorSessionId,
        accountGeneration: 1,
        taskId,
        replyToSignalId: null,
        mode: "queue" as const,
        deliveryState: "pending" as const,
        deliveryReceipt: null,
        body: `History signal ${String(index)}`,
        revision: 1,
        createdAt: index,
        acknowledgedAt: null,
      },
    }));
    const overLimit: WorkTaskHistoryPage = {
      ...taskHistory,
      totalItems: items.length,
      counts: { ...taskHistory.counts, signals: items.length },
      items,
    };
    const target = capture();
    expect(() => renderSuccess(
      { kind: "work.task", task: taskId, historyLimit: 1 },
      overLimit,
      true,
      target.output,
    )).toThrow(InvalidCommandResponseError);
    expect(target.stdout).toEqual([]);
    expect(target.stderr).toEqual([]);
  });

  test("fails closed when snapshot, task, poll, or event identity differs from the request", () => {
    const mismatches = [
      {
        command: applyCommand,
        data: { ...applyResult, workId: otherWorkId },
      },
      {
        command: applyCommand,
        data: {
          kind: "task.claimNext",
          workId,
          task: null,
          attempt: null,
        },
      },
      {
        command: { kind: "work.snapshot", work: otherWorkId } as const,
        data: snapshot,
      },
      {
        command: {
          kind: "work.snapshot",
          work: workId,
          actor: `sess_${"7".repeat(32)}`,
        } as const,
        data: snapshot,
      },
      {
        command: { kind: "work.task", task: otherTaskId } as const,
        data: taskDetail,
      },
      {
        command: { kind: "work.task", task: otherTaskId, historyLimit: 20 } as const,
        data: taskHistory,
      },
      {
        command: {
          kind: "work.task",
          task: taskId,
          historyLimit: 20,
          historyCursor: cursor,
        } as const,
        data: taskHistory,
      },
      {
        command: {
          kind: "work.poll",
          work: otherWorkId,
          limit: 20,
          waitMs: 0,
        } as const,
        data: poll,
      },
      {
        command: {
          kind: "work.poll",
          work: workId,
          actor: actorSessionId,
          limit: 20,
          waitMs: 0,
        } as const,
        data: poll,
      },
      {
        command: {
          kind: "work.poll",
          work: workId,
          actionCursor: cursor,
          limit: 20,
          waitMs: 0,
        } as const,
        data: poll,
      },
      {
        command: {
          kind: "work.events",
          work: otherWorkId,
          limit: 200,
          waitMs: 0,
        } as const,
        data: eventPage,
      },
      {
        command: {
          kind: "work.events",
          work: workId,
          cursor,
          limit: 200,
          waitMs: 0,
        } as const,
        data: eventPage,
      },
    ] satisfies readonly Readonly<{ command: LocalCommand; data: unknown }>[];

    for (const fixture of mismatches) {
      const target = capture();
      expect(() => renderSuccess(fixture.command, fixture.data, true, target.output))
        .toThrow(InvalidCommandResponseError);
      expect(target.stdout).toEqual([]);
      expect(target.stderr).toEqual([]);
    }
  });

  test("rejects terminal-safe wire expansion before writing any bounded work read", () => {
    const signals = Array.from({ length: 16 }, (_, index) => ({
      id: `sig_${(index + 1).toString(16).padStart(32, "0")}` as const,
      senderSessionId: actorSessionId,
      targetSessionId: actorSessionId,
      accountGeneration: 1,
      taskId,
      replyToSignalId: null,
      mode: "queue" as const,
      deliveryState: "pending" as const,
      deliveryReceipt: null,
      body: "\u0080".repeat(8_192),
      revision: 1,
      createdAt: 16 - index,
      acknowledgedAt: null,
    }));
    const hostileCases = [
      {
        command: { kind: "work.snapshot", work: workId } as const,
        data: {
          ...snapshot,
          recentSignals: signals.map((signal) => ({ ...signal, taskId: null })),
        },
      },
      {
        command: { kind: "work.task", task: taskId } as const,
        data: { ...taskDetail, recentSignals: signals },
      },
      {
        command: { kind: "work.task", task: taskId, historyLimit: 20 } as const,
        data: {
          ...taskHistory,
          totalItems: 16,
          counts: { ...taskHistory.counts, signals: 16 },
          items: signals.map((signal) => ({ kind: "signal" as const, value: signal })),
        },
      },
      {
        command: {
          kind: "work.poll",
          work: workId,
          actor: actorSessionId,
          limit: 20,
          waitMs: 0,
        } as const,
        data: { ...poll, actorSessionId, signals: signals.slice(0, 6) },
      },
    ];
    for (const testCase of hostileCases) {
      const target = capture();
      expect(() => renderSuccess(testCase.command, testCase.data, true, target.output))
        .toThrow(InvalidCommandResponseError);
      expect(target.stdout).toEqual([]);
      expect(target.stderr).toEqual([]);
    }

    const taskIds = Array.from(
      { length: 32 },
      (_, index) => `task_${index.toString(16).padStart(32, "0")}` as const,
    );
    const maximumEvents: WorkEventPage = {
      ...eventPage,
      events: Array.from({ length: 200 }, (_, index) => ({
        version: 1 as const,
        workId,
        streamEpoch,
        sequence: index + 1,
        occurredAt: index + 1,
        actorSessionId,
        body: { type: "task.batch_added" as const, taskIds },
      })),
    };
    expect(Buffer.byteLength(
      workReadSuccessWireDocument("work.events", maximumEvents),
      "utf8",
    )).toBeLessThanOrEqual(WORK_EVENT_PAGE_MAX_BYTES);
    const target = capture();
    renderSuccess({ kind: "work.events", work: workId, limit: 200, waitMs: 0 }, maximumEvents, true, target.output);
    expect(target.stdout).toHaveLength(1);
  });
});
