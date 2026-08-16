import { describe, expect, test } from "bun:test";
import type { PortableSystemCommand } from "@hraness/agent-tasks-protocol";

import {
  createLocalTaskDueWorkHandlers,
  localDueWorkOperationId,
  type LocalTaskAuthorityCommandPort,
} from "../src/tasks/handler-adapter";
import type {
  LocalTaskDueWork,
  LocalTaskDueWorkCurrentAuthority,
  LocalTaskDueWorkHandlerContext,
  LocalTaskDueWorkKind,
} from "../src/tasks/reconciler";

const workspaceId = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const taskId = "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const runId = "run_handler_adapter";
const interactionId = "interaction_handler_adapter";

function work(kind: LocalTaskDueWorkKind): LocalTaskDueWork {
  return {
    id: `due-${kind}`,
    workspaceId,
    kind,
    entityId: kind === "defer_wake"
      ? taskId
      : kind === "run_recovery" || kind === "queued_run"
      ? runId
      : kind === "interaction_expiry"
      ? interactionId
      : kind === "claim_expiry"
      ? "claim_handler_adapter"
      : "workspace",
    dueAt: 100,
    expectedRevision: kind === "defer_wake" || kind === "repair"
      ? 3
      : kind === "claim_expiry"
      ? 1
      : null,
    expectedFence: kind === "claim_expiry" || kind === "run_recovery" ? 7 : null,
    attempt: 1,
    workGeneration: 1,
    claimedBootGeneration: 2,
  };
}

const context: LocalTaskDueWorkHandlerContext = {
  bootGeneration: 2,
  wakeReason: "startup",
  wallNow: 100,
};

function authority(value: LocalTaskDueWork): LocalTaskDueWorkCurrentAuthority {
  return {
    kind: "current",
    bootGeneration: context.bootGeneration,
    deadlineCheckedAt: context.wallNow,
    revision: value.expectedRevision,
    fence: value.expectedFence,
  };
}

function commandFor(
  value: LocalTaskDueWork,
  operationId: string,
): PortableSystemCommand {
  switch (value.kind) {
    case "defer_wake":
      return {
        kind: "defer.wake",
        operationId,
        workspaceId,
        taskId,
        expectedTaskRevision: 3,
        scheduledFor: value.dueAt,
      };
    case "claim_expiry":
      return {
        kind: "claim.expire",
        operationId,
        workspaceId,
        taskId,
        claimId: value.entityId,
        fence: 7,
        leaseGeneration: 1,
        expectedDeadline: value.dueAt,
      };
    case "run_recovery":
      return {
        kind: "run.reconcile",
        operationId,
        workspaceId,
        runId,
        bootGeneration: context.bootGeneration,
      };
    case "interaction_expiry":
      return {
        kind: "interaction.expire",
        operationId,
        workspaceId,
        runId,
        interactionId,
        expectedDeadline: value.dueAt,
      };
    case "repair":
      return {
        kind: "workspace.repair",
        operationId,
        workspaceId,
        expectedWorkspaceRevision: 3,
      };
    case "queued_run":
      throw new Error("Queued runs do not prepare system commands");
  }
}

function handlerFor(
  handlers: ReturnType<typeof createLocalTaskDueWorkHandlers>,
  kind: LocalTaskDueWorkKind,
) {
  switch (kind) {
    case "defer_wake":
      return handlers.deferWake;
    case "queued_run":
      return handlers.startQueuedRun;
    case "claim_expiry":
      return handlers.expireClaim;
    case "run_recovery":
      return handlers.recoverStartedRun;
    case "interaction_expiry":
      return handlers.expireInteraction;
    case "repair":
      return handlers.repair;
  }
}

describe("local task production handler adapter", () => {
  test("executes every Phase 3 system command through the revalidating port", async () => {
    const executedKinds: string[] = [];
    const operationIds: string[] = [];
    const port: LocalTaskAuthorityCommandPort = {
      prepareDueWork(input) {
        operationIds.push(input.operationId);
        return {
          kind: "current",
          authority: authority(input.work),
          command: commandFor(input.work, input.operationId),
        };
      },
      executeSystemCommand(input) {
        executedKinds.push(input.command.kind);
        return { kind: "committed", authority: input.authority };
      },
    };
    const handlers = createLocalTaskDueWorkHandlers({ authorityCommands: port });
    const cases = [
      ["defer_wake", "defer.wake"],
      ["claim_expiry", "claim.expire"],
      ["run_recovery", "run.reconcile"],
      ["interaction_expiry", "interaction.expire"],
      ["repair", "workspace.repair"],
    ] as const;

    for (const [kind] of cases) {
      expect(await handlerFor(handlers, kind)(work(kind), context))
        .toMatchObject({ outcome: "settled" });
    }

    expect(executedKinds).toEqual(cases.map(([, commandKind]) => commandKind));
    expect(operationIds.every((id) =>
      /^op_[0-9A-HJKMNP-TV-Z]{26}$/u.test(id))).toBeTrue();
  });

  test("keeps queued runs durable without calling any start or command path", async () => {
    let executions = 0;
    const port: LocalTaskAuthorityCommandPort = {
      prepareDueWork(input) {
        return {
          kind: "current",
          authority: authority(input.work),
          command: null,
        };
      },
      executeSystemCommand() {
        executions += 1;
        throw new Error("Queued work must not execute");
      },
    };
    const handlers = createLocalTaskDueWorkHandlers({
      authorityCommands: port,
      queuedRunRetryMs: 2_500,
    });

    expect(await handlers.startQueuedRun(work("queued_run"), context)).toEqual({
      outcome: "retry",
      authority: authority(work("queued_run")),
      errorCode: "executor_unavailable",
      retryAfterMs: 2_500,
    });
    expect(executions).toBe(0);
  });

  test("maps stale preparation and stale transactional revalidation to obsolete", async () => {
    const stale = { kind: "stale", reason: "fence" } as const;
    const preparationHandlers = createLocalTaskDueWorkHandlers({
      authorityCommands: {
        prepareDueWork: () => ({ kind: "stale", authority: stale }),
        executeSystemCommand: () => {
          throw new Error("Stale preparation must not execute");
        },
      },
    });
    expect(await preparationHandlers.expireClaim(work("claim_expiry"), context))
      .toEqual({ outcome: "obsolete", authority: stale });

    const executionHandlers = createLocalTaskDueWorkHandlers({
      authorityCommands: {
        prepareDueWork(input) {
          return {
            kind: "current",
            authority: authority(input.work),
            command: commandFor(input.work, input.operationId),
          };
        },
        executeSystemCommand: () => ({ kind: "obsolete", authority: stale }),
      },
    });
    expect(await executionHandlers.recoverStartedRun(work("run_recovery"), context))
      .toEqual({ outcome: "obsolete", authority: stale });
  });

  test("refuses a mismatched current authority before executing a side effect", async () => {
    let executions = 0;
    const handlers = createLocalTaskDueWorkHandlers({
      authorityCommands: {
        prepareDueWork(input) {
          return {
            kind: "current",
            authority: {
              ...authority(input.work),
              fence: (input.work.expectedFence ?? 0) + 1,
            },
            command: commandFor(input.work, input.operationId),
          };
        },
        executeSystemCommand() {
          executions += 1;
          throw new Error("Mismatched authority must not execute");
        },
      },
    });

    expect(await handlers.expireClaim(work("claim_expiry"), context)).toEqual({
      outcome: "obsolete",
      authority: { kind: "stale", reason: "fence" },
    });
    expect(executions).toBe(0);
  });

  test("rejects a mismatched claim lease generation before execution", () => {
    let executions = 0;
    const handlers = createLocalTaskDueWorkHandlers({
      authorityCommands: {
        prepareDueWork(input) {
          const command = commandFor(input.work, input.operationId);
          if (command.kind !== "claim.expire") {
            throw new Error("Expected a claim-expiry command");
          }
          return {
            kind: "current",
            authority: authority(input.work),
            command: { ...command, leaseGeneration: 2 },
          };
        },
        executeSystemCommand() {
          executions += 1;
          throw new Error("Mismatched lease generation must not execute");
        },
      },
    });

    expect(
      handlers.expireClaim(work("claim_expiry"), context),
    ).rejects.toThrow("System command did not match durable due work");
    expect(executions).toBe(0);
  });

  test("uses a stable operation ID per boot-fenced semantic work item", () => {
    const value = work("defer_wake");
    expect(localDueWorkOperationId(value, 2)).toBe(localDueWorkOperationId(value, 2));
    expect(localDueWorkOperationId(value, 2)).not.toBe(localDueWorkOperationId(value, 3));
    expect(localDueWorkOperationId(value, 2)).not.toBe(
      localDueWorkOperationId({ ...value, expectedRevision: 4 }, 2),
    );
  });
});
