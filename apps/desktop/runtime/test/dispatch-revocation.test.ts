import { describe, expect, test } from "bun:test";

import type { DispatchBinding } from "../src/state/dispatch-store";
import {
  DispatchRevocationCoordinator,
  type DispatchRevocationStore,
} from "../src/dispatch/revocation";
import {
  canTransitionDispatch,
  type DispatchStage,
  type PublicRunEventKind,
} from "../src/dispatch/model";

const runId = "run_primary0001";

describe("DispatchRevocationCoordinator", () => {
  test("cancels a pre-thread stop and retains capacity until publication", async () => {
    const harness = createHarness("worktree_ready");

    await harness.revocations.revoke(runId, "stop_requested");

    expect(harness.store.read(runId)?.stage).toBe("cancelled");
    expect(harness.events).toEqual(["run.cancelled"]);
    expect(harness.released).toEqual([]);
    expect(harness.interrupts).toEqual([]);
  });

  test("interrupts a running Codex turn before reporting cancellation", async () => {
    const harness = createHarness("running", "thread_primary0001");

    await harness.revocations.revoke(runId, "stop_requested");

    expect(harness.store.read(runId)?.stage).toBe("cancelled");
    expect(harness.interrupts).toEqual(["thread_primary0001"]);
    expect(harness.events).toEqual(["run.cancelled"]);
    expect(harness.released).toEqual([]);
  });

  test("fails closed when a starting thread cannot be proven stopped", async () => {
    const harness = createHarness("thread_starting");

    await harness.revocations.revoke(runId, "stop_requested");

    expect(harness.store.read(runId)?.stage).toBe("ambiguous");
    expect(harness.events).toEqual(["run.lease_lost"]);
    expect(harness.released).toEqual([]);
  });

  test("records lease loss and retains capacity if interruption fails", async () => {
    const harness = createHarness("running", "thread_primary0001", true);

    await harness.revocations.revoke(runId, "lease_expired");

    expect(harness.store.read(runId)?.stage).toBe("lease_lost");
    expect(harness.events).toEqual(["run.lease_lost"]);
    expect(harness.released).toEqual([]);
  });

  test("fails and retains stopped interaction faults until publication", async () => {
    for (const reason of [
      "interaction_limit",
      "interaction_resolution_ambiguous",
      "invalid_interaction_response",
    ] as const) {
      const harness = createHarness("waiting", "thread_primary0001");

      await harness.revocations.revoke(runId, reason);

      expect(harness.store.read(runId)?.stage).toBe("failed");
      expect(harness.store.read(runId)?.failureCode).toBe(reason);
      expect(harness.events).toEqual(["run.failed"]);
      expect(harness.interrupts).toEqual(["thread_primary0001"]);
      expect(harness.released).toEqual([]);
    }
  });

  test("retains an ambiguous run when atomic interaction settlement fails", async () => {
    const events: PublicRunEventKind[] = [];
    const store = new MemoryStore(
      "waiting",
      "thread_primary0001",
      events,
      "settlement_failure",
    );
    const revocations = new DispatchRevocationCoordinator({
      store,
      capabilities: { releaseRun: () => undefined },
      sessions: {
        interruptGatewayThread: () => Promise.resolve("interrupted"),
      },
    });

    await revocations.revoke(runId, "interaction_resolution_ambiguous");

    expect(store.read(runId)).toMatchObject({
      stage: "ambiguous",
    });
    expect(events).toEqual(["run.lease_lost"]);
  });

  test("stops a cloud-terminal run without publishing a competing terminal event", async () => {
    const harness = createHarness("running", "thread_primary0001");

    await harness.revocations.revoke(runId, "cloud_terminal");

    expect(harness.store.read(runId)?.stage).toBe("lease_lost");
    expect(harness.interrupts).toEqual(["thread_primary0001"]);
    expect(harness.events).toEqual([]);
    expect(harness.released).toEqual([runId]);
  });

  test("retains and retries a cloud-terminal slot until local interruption is proved", async () => {
    let interruptFails = true;
    const events: PublicRunEventKind[] = [];
    const interrupts: string[] = [];
    const released: string[] = [];
    const store = new MemoryStore("running", "thread_primary0001", events);
    const revocations = new DispatchRevocationCoordinator({
      store,
      capabilities: { releaseRun: (releasedRunId) => released.push(releasedRunId) },
      sessions: {
        interruptGatewayThread(value) {
          interrupts.push(value);
          return interruptFails
            ? Promise.reject(new Error("unavailable"))
            : Promise.resolve("interrupted");
        },
      },
    });

    await revocations.revoke(runId, "cloud_terminal");
    expect(store.read(runId)?.stage).toBe("ambiguous");
    expect(released).toEqual([]);

    interruptFails = false;
    await revocations.revoke(runId, "cloud_terminal");
    expect(store.read(runId)?.stage).toBe("lease_lost");
    expect(interrupts).toEqual(["thread_primary0001", "thread_primary0001"]);
    expect(events).toEqual([]);
    expect(released).toEqual([runId]);
  });

  test("stops the isolated account runtime when restart lost the thread projection", async () => {
    const events: PublicRunEventKind[] = [];
    const released: string[] = [];
    const stoppedAccounts: string[] = [];
    const store = new MemoryStore("running", "thread_primary0001", events);
    const revocations = new DispatchRevocationCoordinator({
      store,
      capabilities: { releaseRun: (releasedRunId) => released.push(releasedRunId) },
      sessions: {
        interruptGatewayThread: () => Promise.reject(new Error("thread projection missing")),
        stopGatewayAccount: (accountProfileId) => {
          stoppedAccounts.push(accountProfileId);
          return Promise.resolve();
        },
      },
    });

    await revocations.revoke(runId, "cloud_terminal");

    expect(stoppedAccounts).toEqual(["acct_primary0001"]);
    expect(store.read(runId)?.stage).toBe("lease_lost");
    expect(events).toEqual([]);
    expect(released).toEqual([runId]);
  });
});

function createHarness(
  initialStage: DispatchStage,
  threadId: string | null = null,
  interruptFails = false,
): {
  readonly events: PublicRunEventKind[];
  readonly interrupts: string[];
  readonly released: string[];
  readonly revocations: DispatchRevocationCoordinator;
  readonly store: MemoryStore;
} {
  const events: PublicRunEventKind[] = [];
  const interrupts: string[] = [];
  const released: string[] = [];
  const store = new MemoryStore(initialStage, threadId, events);
  return {
    events,
    interrupts,
    released,
    store,
    revocations: new DispatchRevocationCoordinator({
      store,
      capabilities: { releaseRun: (releasedRunId) => released.push(releasedRunId) },
      sessions: {
        interruptGatewayThread(value) {
          interrupts.push(value);
          return interruptFails
            ? Promise.reject(new Error("unavailable"))
            : Promise.resolve("interrupted");
        },
      },
    }),
  };
}

class MemoryStore implements DispatchRevocationStore {
  #binding: DispatchBinding;
  readonly #events: PublicRunEventKind[];
  readonly #interactionSettlement: "commit" | "settlement_failure";

  constructor(
    stage: DispatchStage,
    threadId: string | null,
    events: PublicRunEventKind[],
    interactionSettlement: "commit" | "settlement_failure" = "commit",
  ) {
    this.#events = events;
    this.#interactionSettlement = interactionSettlement;
    this.#binding = {
      runId,
      taskId: "task_primary0001",
      taskKey: "OPS-7K2M4Q9",
      claimId: "claim_primary0001",
      claimFence: 1,
      inputReviewRevision: 2,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
      repositoryPublicId: "repo_primary0001",
      executionMode: "managed_worktree",
      accountProfileId: "acct_primary0001",
      laneId: null,
      threadId,
      turnId: threadId === null ? null : "turn_primary0001",
      stage,
      baseSha: null,
      branchName: null,
      lastEventSequence: 0,
      failureCode: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  read(candidateRunId: string): DispatchBinding | null {
    return candidateRunId === runId ? this.#binding : null;
  }

  transition(input: {
    readonly runId: string;
    readonly to: DispatchStage;
    readonly failureCode?: string;
  }): DispatchBinding {
    if (input.runId !== runId || !canTransitionDispatch(this.#binding.stage, input.to)) {
      throw new Error("invalid transition");
    }
    this.#binding = {
      ...this.#binding,
      stage: input.to,
      failureCode: input.failureCode ?? this.#binding.failureCode,
    };
    return this.#binding;
  }

  appendPublicEvent(input: {
    readonly runId: string;
    readonly eventId: string;
    readonly kind: PublicRunEventKind;
  }): unknown {
    if (input.runId !== runId) throw new Error("unknown run");
    this.#events.push(input.kind);
    return input;
  }

  failAfterProvenInteractionStop(input: {
    readonly runId: string;
    readonly failureCode: string;
    readonly eventId: string;
  }): boolean {
    if (this.#interactionSettlement === "settlement_failure") {
      throw new Error("interaction settlement failed");
    }
    this.transition({
      runId: input.runId,
      to: "failed",
      failureCode: input.failureCode,
    });
    this.appendPublicEvent({
      runId: input.runId,
      eventId: input.eventId,
      kind: "run.failed",
    });
    return true;
  }
}
