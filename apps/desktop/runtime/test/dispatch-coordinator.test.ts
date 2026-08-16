import { describe, expect, test } from "bun:test";

import {
  DispatchCoordinator,
  type CodexDispatchLauncher,
  type DispatchAssignment,
  type DispatchCoordinatorStore,
  type DispatchWorkspacePort,
} from "../src/dispatch/coordinator";
import {
  canTransitionDispatch,
  publicRunEvent,
  type DispatchStage,
  type PublicRunEventKind,
} from "../src/dispatch/model";
import type { DispatchBinding, DispatchReservation } from "../src/state/dispatch-store";

const assignment: DispatchAssignment = {
  runId: "run_primary0001",
  taskId: "task_primary0001",
  taskKey: "OPS-7K2M4Q9",
  claimId: "claim_primary001",
  claimFence: 3,
  inputReviewRevision: 2,
  runtimePublicId: "runtime_primary1",
  runtimeBootId: "boot_primary0001",
  repositoryPublicId: "repo_primary0001",
  accountProfileId: "acct_primary0001",
  baseRef: "main",
  initialPrompt: "Implement the accepted task.",
  repositoryPath: "/private/repository",
  title: "Accepted task",
};

class MemoryStore implements DispatchCoordinatorStore {
  binding: DispatchBinding | null = null;
  readonly events: { eventId: string; kind: PublicRunEventKind }[] = [];

  reserve(input: DispatchReservation): DispatchBinding {
    this.binding ??= {
      ...input,
      accountProfileId: null,
      laneId: null,
      threadId: null,
      turnId: null,
      stage: "reserved",
      executionMode: "managed_worktree",
      baseSha: null,
      branchName: null,
      lastEventSequence: 0,
      failureCode: null,
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
    };
    return this.binding;
  }

  read(): DispatchBinding | null {
    return this.binding;
  }

  transition(input: {
    runId: string;
    to: DispatchStage;
    accountProfileId?: string;
    baseSha?: string;
    branchName?: string;
    failureCode?: string;
    laneId?: string;
    threadId?: string;
    turnId?: string;
  }): DispatchBinding {
    if (this.binding === null || !canTransitionDispatch(this.binding.stage, input.to)) {
      throw new Error("invalid transition");
    }
    this.binding = {
      ...this.binding,
      stage: input.to,
      accountProfileId: input.accountProfileId ?? this.binding.accountProfileId,
      baseSha: input.baseSha ?? this.binding.baseSha,
      branchName: input.branchName ?? this.binding.branchName,
      failureCode: input.failureCode ?? this.binding.failureCode,
      laneId: input.laneId ?? this.binding.laneId,
      threadId: input.threadId ?? this.binding.threadId,
      turnId: input.turnId ?? this.binding.turnId,
    };
    return this.binding;
  }

  appendPublicEvent(input: {
    runId: string;
    eventId: string;
    kind: PublicRunEventKind;
  }): { readonly sequence: number } {
    if (!this.events.some(({ eventId }) => eventId === input.eventId)) {
      this.events.push({ eventId: input.eventId, kind: publicRunEvent(input.kind).kind });
    }
    if (this.binding === null) throw new Error("missing binding");
    this.binding = { ...this.binding, lastEventSequence: this.events.length };
    return { sequence: this.events.length };
  }
}

function publicationBarrier(callLog: string[]) {
  return {
    acknowledgeThrough(_runId: string, throughSequence: number) {
      callLog.push(`ack:${String(throughSequence)}`);
      return Promise.resolve(true);
    },
  };
}

function workspacePort(callLog: string[]): DispatchWorkspacePort {
  return {
    resolveBase() {
      callLog.push("resolve-base");
      return Promise.resolve("a".repeat(40));
    },
    provision() {
      callLog.push("provision");
      return Promise.resolve({
        baseSha: "a".repeat(40),
        branchName: "codex/oprte-run_primary0001",
        canonicalGitCommonDir: "/private/repository/.git",
        checkoutPath: "/private/lanes/run_primary0001",
        laneId: "run_primary0001",
        recovered: callLog.filter((entry) => entry === "provision").length > 1,
      });
    },
  };
}

function launcher(callLog: string[], firstThreadAmbiguous = false): CodexDispatchLauncher {
  let threadCalls = 0;
  return {
    ensureThread() {
      callLog.push("ensure-thread");
      threadCalls += 1;
      return Promise.resolve(firstThreadAmbiguous && threadCalls === 1
        ? { kind: "ambiguous" }
        : { kind: "ready", value: { threadId: "thread_primary01" } });
    },
    ensureInitialTurn(input) {
      callLog.push(`ensure-turn:${input.clientUserMessageId}`);
      return Promise.resolve({ kind: "ready", value: { turnId: "turn_primary0001" } });
    },
  };
}

const lifecycleEvents = [
  ["1", "run.queued"],
  ["2", "worktree.preparing"],
  ["3", "worktree.ready"],
  ["4", "codex.starting"],
  ["5", "codex.running"],
] as const satisfies readonly (readonly [string, PublicRunEventKind])[];

function persistedStore(
  stage: "worktree_ready" | "thread_starting" | "thread_ready" | "turn_starting" | "running",
  committedEventCount: number,
): MemoryStore {
  const store = new MemoryStore();
  const hasThread = stage === "thread_ready" || stage === "turn_starting" || stage === "running";
  store.binding = {
    ...assignment,
    accountProfileId: assignment.accountProfileId,
    laneId: assignment.runId,
    threadId: hasThread ? "thread_primary01" : null,
    turnId: stage === "running" ? "turn_primary0001" : null,
    stage,
    executionMode: "managed_worktree",
    baseSha: "a".repeat(40),
    branchName: "codex/oprte-run_primary0001",
    lastEventSequence: committedEventCount,
    failureCode: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
  for (const [ordinal, kind] of lifecycleEvents.slice(0, committedEventCount)) {
    store.events.push({ eventId: `${assignment.runId}:${ordinal}`, kind });
  }
  return store;
}

describe("dispatch coordinator recovery", () => {
  test("quarantines a legacy reservation crash window before any Git side effect", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    store.binding = {
      ...store.reserve(assignment),
      executionMode: "legacy_unbound",
    };
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: workspacePort(calls),
      launcher: launcher(calls),
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: publicationBarrier(calls),
    });

    expect(await coordinator.execute(assignment)).toMatchObject({
      kind: "ambiguous",
      binding: {
        executionMode: "legacy_unbound",
        failureCode: "retired_development_source_binding",
        stage: "ambiguous",
      },
    });
    expect(calls).toEqual([]);
    expect(store.events.map(({ kind }) => kind)).toEqual(["run.lease_lost"]);
  });

  test("blocks a persisted retired source binding without creating a managed lane", async () => {
    const calls: string[] = [];
    const store = persistedStore("worktree_ready", 3);
    if (store.binding === null) throw new Error("fixture binding missing");
    store.binding = {
      ...store.binding,
      branchName: null,
      executionMode: "legacy_unbound",
      laneId: null,
    };
    let threadCalls = 0;
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: {
        resolveBase: () => Promise.reject(new Error("must not resolve a persisted base")),
        provision() {
          calls.push("unexpected-provision");
          return Promise.reject(new Error("must not convert a retired binding"));
        },
      },
      launcher: {
        ensureThread: () => {
          threadCalls += 1;
          return Promise.reject(new Error("must not start a retired binding"));
        },
        ensureInitialTurn: () => Promise.reject(
          new Error("must not start a retired binding"),
        ),
      },
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: publicationBarrier(calls),
    });

    expect(await coordinator.execute(assignment)).toMatchObject({
      kind: "ambiguous",
      binding: {
        failureCode: "retired_development_source_binding",
        stage: "ambiguous",
      },
    });
    expect(calls).toEqual([]);
    expect(threadCalls).toBe(0);
  });

  test("recovers persisted managed identity through its exact lane", async () => {
    const calls: string[] = [];
    const store = persistedStore("thread_ready", 4);
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: {
        resolveBase: () => Promise.reject(new Error("must not resolve a persisted base")),
        provision(input) {
          calls.push("provision");
          return Promise.resolve({
            baseSha: input.baseSha,
            branchName: "codex/oprte-run_primary0001",
            canonicalGitCommonDir: "/private/repository/.git",
            checkoutPath: "/private/lanes/run_primary0001",
            laneId: "run_primary0001",
            recovered: true,
          });
        },
      },
      launcher: launcher(calls),
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: publicationBarrier(calls),
    });

    expect(await coordinator.execute(assignment)).toMatchObject({
      kind: "running",
      binding: { stage: "running" },
    });
    expect(calls[0]).toBe("provision");
  });

  test("replays a migrated reserved lane from its durable managed base", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    store.binding = {
      ...store.reserve(assignment),
      accountProfileId: assignment.accountProfileId,
      baseSha: "a".repeat(40),
      branchName: "codex/oprte-run_primary0001",
      laneId: assignment.runId,
    };
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: workspacePort(calls),
      launcher: launcher(calls),
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: publicationBarrier(calls),
    });

    expect(await coordinator.execute(assignment)).toMatchObject({
      kind: "running",
      binding: { executionMode: "managed_worktree", stage: "running" },
    });
    expect(calls).not.toContain("resolve-base");
    expect(calls.filter((entry) => entry === "provision")).toHaveLength(2);
  });

  test("provisions and launches one fenced run with only semantic public events", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: workspacePort(calls),
      launcher: launcher(calls),
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: publicationBarrier(calls),
    });
    const result = await coordinator.execute(assignment);
    expect(result).toMatchObject({ kind: "running", binding: { stage: "running" } });
    expect(store.binding?.threadId).toBe("thread_primary01");
    expect(store.binding?.turnId).toBe("turn_primary0001");
    expect(calls).toEqual([
      "ack:2",
      "resolve-base",
      "provision",
      "provision",
      "ack:4",
      "ensure-thread",
      "ensure-turn:message_5f51d0fdb72c469c12024c8764d03bcae19320396a8ed85f",
    ]);
    expect(store.events.map(({ kind }) => kind)).toEqual([
      "run.queued",
      "worktree.preparing",
      "worktree.ready",
      "codex.starting",
      "codex.running",
    ]);
    expect(JSON.stringify(store.events)).not.toContain(assignment.initialPrompt);
    expect(JSON.stringify(store.events)).not.toContain(assignment.repositoryPath);
  });

  test("quarantines an ambiguous thread start instead of provisioning or launching again", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: workspacePort(calls),
      launcher: launcher(calls, true),
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: publicationBarrier(calls),
    });
    expect(await coordinator.execute(assignment)).toMatchObject({
      kind: "ambiguous",
      binding: { lastEventSequence: 5 },
    });
    expect(store.binding?.stage).toBe("ambiguous");
    expect(await coordinator.execute(assignment)).toMatchObject({ kind: "ambiguous" });
    expect(calls.filter((entry) => entry === "resolve-base")).toHaveLength(1);
    expect(calls.filter((entry) => entry === "ensure-thread")).toHaveLength(1);
    expect(store.events.map(({ kind }) => kind)).toEqual([
      "run.queued",
      "worktree.preparing",
      "worktree.ready",
      "codex.starting",
      "run.lease_lost",
    ]);
  });

  test("never mutates Git or Codex after a stale cloud fence", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: workspacePort(calls),
      launcher: launcher(calls),
      fence: { assertCurrent: () => Promise.resolve(false) },
      publication: publicationBarrier(calls),
    });
    expect(await coordinator.execute(assignment)).toMatchObject({ kind: "lease_lost" });
    expect(calls).toEqual([]);
    expect(store.events.map(({ kind }) => kind)).toEqual(["run.lease_lost"]);
  });

  test("never mutates Git or Codex until the cloud acknowledges the public phase", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: workspacePort(calls),
      launcher: launcher(calls),
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: {
        acknowledgeThrough(_runId, throughSequence) {
          calls.push(`rejected-ack:${String(throughSequence)}`);
          return Promise.resolve(false);
        },
      },
    });

    expect(await coordinator.execute(assignment)).toMatchObject({ kind: "lease_lost" });
    expect(calls).toEqual(["rejected-ack:2"]);
    expect(calls).not.toContain("resolve-base");
    expect(calls).not.toContain("provision");
    expect(calls).not.toContain("ensure-thread");
    expect(store.events.map(({ kind }) => kind)).toEqual([
      "run.queued",
      "worktree.preparing",
      "run.lease_lost",
    ]);
  });

  test("never starts Codex when the post-worktree publication barrier is unavailable", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    let acknowledgements = 0;
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: workspacePort(calls),
      launcher: launcher(calls),
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: {
        acknowledgeThrough(_runId, throughSequence) {
          acknowledgements += 1;
          calls.push(`${acknowledgements === 1 ? "ack" : "rejected-ack"}:${String(throughSequence)}`);
          return Promise.resolve(acknowledgements === 1);
        },
      },
    });

    expect(await coordinator.execute(assignment)).toMatchObject({ kind: "lease_lost" });
    expect(calls).toEqual([
      "ack:2",
      "resolve-base",
      "provision",
      "provision",
      "rejected-ack:4",
    ]);
    expect(calls).not.toContain("ensure-thread");
    expect(store.events.map(({ kind }) => kind)).toEqual([
      "run.queued",
      "worktree.preparing",
      "worktree.ready",
      "codex.starting",
      "run.lease_lost",
    ]);
  });

  test.each([
    [3, ["ack:2", "resolve-base", "provision"]],
    [5, ["ack:2", "resolve-base", "provision", "provision"]],
    [7, ["ack:2", "resolve-base", "provision", "provision", "ack:4", "ensure-thread"]],
    [10, [
      "ack:2",
      "resolve-base",
      "provision",
      "provision",
      "ack:4",
      "ensure-thread",
      "ensure-turn:message_5f51d0fdb72c469c12024c8764d03bcae19320396a8ed85f",
    ]],
  ] as const)("fails closed when fence check %i rejects after a local boundary", async (
    rejectedCheck,
    expectedCalls,
  ) => {
    const calls: string[] = [];
    const store = new MemoryStore();
    let checks = 0;
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: workspacePort(calls),
      launcher: launcher(calls),
      fence: {
        assertCurrent: () => {
          checks += 1;
          return Promise.resolve(checks !== rejectedCheck);
        },
      },
      publication: publicationBarrier(calls),
    });

    expect(await coordinator.execute(assignment)).toMatchObject({
      kind: "lease_lost",
      binding: { stage: "lease_lost" },
    });
    expect(calls).toEqual([...expectedCalls]);
    expect(calls.filter((entry) => entry === "ensure-thread")).toHaveLength(
      rejectedCheck >= 7 ? 1 : 0,
    );
    expect(calls.filter((entry) => entry.startsWith("ensure-turn:"))).toHaveLength(
      rejectedCheck >= 10 ? 1 : 0,
    );
  });

  test.each([
    ["worktree_ready", 2],
    ["thread_starting", 3],
    ["thread_ready", 4],
    ["turn_starting", 4],
    ["running", 4],
  ] as const)("repairs a crash after persisting %s without duplicating its side effects", async (
    stage,
    committedEventCount,
  ) => {
    const calls: string[] = [];
    const store = persistedStore(stage, committedEventCount);
    const coordinator = new DispatchCoordinator({
      store,
      workspaces: workspacePort(calls),
      launcher: launcher(calls),
      fence: { assertCurrent: () => Promise.resolve(true) },
      publication: publicationBarrier(calls),
    });

    expect(await coordinator.execute(assignment)).toMatchObject({
      kind: "running",
      binding: { stage: "running", threadId: "thread_primary01", turnId: "turn_primary0001" },
    });
    expect(store.events).toEqual(lifecycleEvents.map(([ordinal, kind]) => ({
      eventId: `${assignment.runId}:${ordinal}`,
      kind,
    })));
    expect(calls.filter((entry) => entry === "ensure-thread")).toHaveLength(
      stage === "running" ? 0 : 1,
    );
    expect(calls.filter((entry) => entry.startsWith("ensure-turn:"))).toHaveLength(
      stage === "running" ? 0 : 1,
    );
  });
});
