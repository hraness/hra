import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type {
  ClaimedDispatch,
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
} from "@hraness/agent-tasks-protocol";

import type { DispatchExecutionResult } from "../src/dispatch/coordinator";
import { DispatchRevocationCoordinator } from "../src/dispatch/revocation";
import type { DispatchBinding, PendingDispatchEvent } from "../src/state/dispatch-store";
import { applyMigrations } from "../src/state/database";
import {
  DispatchRunnerInstallationStore,
} from "../src/state/dispatch-runner-installation";
import {
  DispatchLeaseRegistry,
  HRADispatchRunner,
  boundedJitterMilliseconds,
  wireDispatchEventId,
  type DispatchCapabilityPort,
  type DispatchCapabilitySnapshot,
  type DispatchRunnerScheduler,
  type DispatchSlotDisposition,
  type LocalDispatchSlot,
} from "../src/dispatch/runner";

const locator = "0".repeat(26);
const repositoryId = `repo_${locator}`;
const requestId = `req_${locator}`;
const candidate = { taskKey: "OPS-0000001", repositoryId, queuedAt: 1_000 } as const;
const heartbeatResponse: RunnerHeartbeatResponse = {
  serverTime: 1_000,
  leaseUntil: 46_000,
  desiredState: "active",
  candidates: [candidate],
  runLeases: [],
  stopRunIds: [],
  releaseRunIds: [],
};
const claim: ClaimedDispatch = {
  runId: "run_primary0001",
  taskId: "task_primary0001",
  taskKey: candidate.taskKey,
  taskTitle: "Implement dispatch",
  taskDescription: "Implement the accepted task.",
  repositoryId,
  baseRef: "main",
  claimId: "claim_primary001",
  claimFence: 3,
  inputReviewRevision: 2,
  leaseGeneration: 1,
  leaseUntil: 91_000,
};
const slot: LocalDispatchSlot = {
  accountProfileId: "account_primary1",
  repositoryId,
  repositoryPath: "/private/repository",
  reservationId: "slot_primary0001",
};

class MutableClock {
  value = 1_000;
  now(): number { return this.value; }
}

function capabilityPort(
  dispositions: DispatchSlotDisposition[],
  releasedRuns: string[] = [],
  retainedRunIds: readonly string[] = [],
): DispatchCapabilityPort {
  const snapshot: DispatchCapabilitySnapshot = {
    reportedState: "ready",
    capacity: 1,
    activeRuns: 0,
    retainedRunIds,
    repositoryIds: [repositoryId],
  };
  return {
    snapshot: () => Promise.resolve(snapshot),
    acquire: () => Promise.resolve(slot),
    settle: (_slot, disposition) => {
      dispositions.push(disposition);
      return Promise.resolve();
    },
    releaseRun: (runId) => { releasedRuns.push(runId); },
  };
}

function binding(): DispatchBinding {
  return {
    runId: claim.runId,
    taskId: claim.taskId,
    taskKey: claim.taskKey,
    claimId: claim.claimId,
    claimFence: claim.claimFence,
    inputReviewRevision: claim.inputReviewRevision,
    runtimePublicId: "runner_primary0001",
    runtimeBootId: "boot_primary0001",
    repositoryPublicId: repositoryId,
    executionMode: "managed_worktree",
    accountProfileId: slot.accountProfileId,
    laneId: null,
    threadId: null,
    turnId: null,
    stage: "running",
    baseSha: "a".repeat(40),
    branchName: "codex/lane",
    lastEventSequence: 1,
    failureCode: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
}

describe("dispatch runner supervision", () => {
  test("fence authority requires the exact boot and claim tuple and expires locally", async () => {
    const clock = new MutableClock();
    const registry = new DispatchLeaseRegistry({
      clock,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    });
    registry.observeHeartbeat(heartbeatResponse, 1_000, true);
    expect(registry.registerClaim(claim)).toBe("new");
    const tuple = {
      runId: claim.runId,
      claimId: claim.claimId,
      claimFence: claim.claimFence,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    };
    expect(await registry.assertCurrent(tuple)).toBeTrue();
    expect(await registry.assertCurrent({ ...tuple, claimFence: 4 })).toBeFalse();
    clock.value = 46_000;
    expect(await registry.assertCurrent(tuple)).toBeFalse();
  });

  test("tracks each cloud run deadline without extending a bounded publication window", async () => {
    const clock = new MutableClock();
    const registry = new DispatchLeaseRegistry({
      clock,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    });
    registry.observeHeartbeat(heartbeatResponse, 1_000, true);
    expect(registry.registerClaim(claim)).toBe("new");
    clock.value = 2_000;
    registry.observeHeartbeat({
      ...heartbeatResponse,
      serverTime: 2_000,
      leaseUntil: 47_000,
      runLeases: [{ runId: claim.runId, leaseUntil: 5_000 }],
    }, 2_000, true);
    const tuple = {
      runId: claim.runId,
      claimId: claim.claimId,
      claimFence: claim.claimFence,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    };
    clock.value = 4_999;
    expect(await registry.assertCurrent(tuple)).toBeTrue();
    clock.value = 5_000;
    expect(await registry.assertCurrent(tuple)).toBeFalse();
  });

  test("never resurrects an expired claim when the local clock rolls backward", async () => {
    const clock = new MutableClock();
    clock.value = 1_002;
    const registry = new DispatchLeaseRegistry({
      clock,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    });
    registry.observeHeartbeat({
      ...heartbeatResponse,
      serverTime: 1_000,
      leaseUntil: 1_002,
    }, 1_000, true);
    registry.registerClaim({ ...claim, leaseUntil: 1_001 });
    expect(await registry.assertCurrent({
      runId: claim.runId,
      claimId: claim.claimId,
      claimFence: claim.claimFence,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    })).toBeFalse();

    clock.value = 1_000;
    expect(await registry.assertCurrent({
      runId: claim.runId,
      claimId: claim.claimId,
      claimFence: claim.claimFence,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    })).toBeFalse();
  });

  test("retries an indeterminate heartbeat generation and advances only after success", async () => {
    const sequences: number[] = [];
    const results = [
      { ok: false as const, error: { kind: "network" as const } },
      { ok: true as const, data: heartbeatResponse, requestId },
      { ok: true as const, data: heartbeatResponse, requestId },
    ];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: (request: RunnerHeartbeatRequest) => {
          sequences.push(request.sequence);
          return Promise.resolve(results.shift() ?? { ok: false as const, error: { kind: "network" as const } });
        },
        claim: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.reject(new Error("not reached")) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: { revoke: () => Promise.resolve() },
    });
    expect(await runner.heartbeatOnce()).toBe("retry");
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(sequences).toEqual([1, 1, 2]);
  });

  test("replays the exact indeterminate heartbeat before publishing changed local state", async () => {
    const requests: RunnerHeartbeatRequest[] = [];
    const mutableSnapshot: DispatchCapabilitySnapshot = {
      reportedState: "ready",
      capacity: 1,
      activeRuns: 0,
      retainedRunIds: [],
      repositoryIds: [repositoryId],
    };
    const results = [
      { ok: false as const, error: { kind: "network" as const } },
      { ok: true as const, data: heartbeatResponse, requestId },
      { ok: true as const, data: heartbeatResponse, requestId },
    ];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: (request) => {
          requests.push(request);
          return Promise.resolve(results.shift() ?? { ok: false as const, error: { kind: "network" as const } });
        },
        claim: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: {
        snapshot: () => Promise.resolve({ ...mutableSnapshot }),
        acquire: () => Promise.resolve(null),
        settle: () => Promise.resolve(),
        releaseRun: () => null,
      },
      executor: { execute: () => Promise.reject(new Error("not reached")) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: { revoke: () => Promise.resolve() },
    });

    expect(await runner.heartbeatOnce()).toBe("retry");
    Object.assign(mutableSnapshot, {
      reportedState: "busy",
      activeRuns: 1,
      retainedRunIds: ["run_recovered0001"],
    });
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(requests[1]).toEqual(requests[0]);
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(requests[2]).toMatchObject({
      sequence: 2,
      activeRuns: 1,
      retainedRunIds: ["run_recovered0001"],
    });
  });

  test("replays an accepted first heartbeat after restart before pairing", async () => {
    const database = new Database(":memory:", { strict: true });
    const requests: RunnerHeartbeatRequest[] = [];
    let acceptedByServer: RunnerHeartbeatRequest | null = null;
    let loseResponse = true;
    const pairing = { state: "pairing" as "pairing" | "paired" };
    try {
      applyMigrations(database);
      const firstStore = new DispatchRunnerInstallationStore(database);
      const firstBoot = firstStore.startBoot();
      const heartbeat = (
        request: RunnerHeartbeatRequest,
      ): Promise<
        | Readonly<{ ok: false; error: { kind: "network" } }>
        | Readonly<{
          ok: true;
          data: RunnerHeartbeatResponse;
          requestId: string;
        }>
      > => {
        requests.push(structuredClone(request));
        if (
          acceptedByServer !== null &&
          acceptedByServer.bootGeneration === request.bootGeneration &&
          acceptedByServer.sequence === request.sequence &&
          JSON.stringify(acceptedByServer) !== JSON.stringify(request)
        ) {
          throw new Error("same heartbeat clock changed fingerprint");
        }
        acceptedByServer = request;
        if (loseResponse) {
          loseResponse = false;
          return Promise.resolve({ ok: false, error: { kind: "network" } });
        }
        return Promise.resolve({
          ok: true,
          data: {
            ...heartbeatResponse,
            candidates: [],
          },
          requestId,
        });
      };
      const inertPorts = {
        executor: {
          execute: () => Promise.reject(new Error("not reached")),
        },
        outbox: {
          read: () => null,
          pendingEvents: () => [],
          pendingEventsForRun: () => [],
          isAcknowledged: () => true,
          acknowledge: () => 0,
        },
        revocations: { revoke: () => Promise.resolve() },
      };
      const firstRunner = new HRADispatchRunner({
        identity: {
          runnerId: firstBoot.runnerId,
          installationId: firstBoot.installationId,
          bootId: firstBoot.bootId,
          bootGeneration: firstBoot.bootGeneration,
          clientVersion: "0.1.0",
        },
        cloud: {
          heartbeat,
          claim: () => Promise.resolve({
            ok: false,
            error: { kind: "network" },
          }),
          appendEvents: () => Promise.resolve({
            ok: false,
            error: { kind: "network" },
          }),
        },
        capabilities: capabilityPort([]),
        heartbeatJournal: firstStore,
        ...inertPorts,
        initialHeartbeatSequence: firstBoot.initialHeartbeatSequence,
      });
      expect(await firstRunner.heartbeatOnce()).toBe("retry");
      expect(pairing.state).toBe("pairing");

      const restartedStore = new DispatchRunnerInstallationStore(database);
      const restartedBoot = restartedStore.startBoot();
      expect(restartedBoot).toEqual(firstBoot);
      let changedSnapshotReads = 0;
      const restartedRunner = new HRADispatchRunner({
        identity: {
          runnerId: restartedBoot.runnerId,
          installationId: restartedBoot.installationId,
          bootId: restartedBoot.bootId,
          bootGeneration: restartedBoot.bootGeneration,
          clientVersion: "0.1.0",
        },
        cloud: {
          heartbeat,
          claim: () => Promise.resolve({
            ok: false,
            error: { kind: "network" },
          }),
          appendEvents: () => Promise.resolve({
            ok: false,
            error: { kind: "network" },
          }),
        },
        capabilities: {
          snapshot: () => {
            changedSnapshotReads += 1;
            return Promise.resolve({
              reportedState: "degraded" as const,
              blockReason: "capacity_full" as const,
              capacity: 0,
              activeRuns: 0,
              retainedRunIds: [],
              repositoryIds: [],
            });
          },
          acquire: () => Promise.resolve(null),
          settle: () => Promise.resolve(),
          releaseRun: () => null,
        },
        heartbeatJournal: restartedStore,
        ...inertPorts,
        initialHeartbeatSequence: restartedBoot.initialHeartbeatSequence,
        onHeartbeatAccepted: (input) => {
          restartedStore.acknowledgeHeartbeat(input);
          pairing.state = "paired";
        },
      });

      expect(await restartedRunner.heartbeatOnce()).toBe("ok");
      expect(changedSnapshotReads).toBe(0);
      expect(requests[1]).toEqual(requests[0]);
      expect(pairing.state).toBe("paired");

      expect(await restartedRunner.heartbeatOnce()).toBe("ok");
      expect(changedSnapshotReads).toBe(1);
      expect(requests[2]).toMatchObject({
        sequence: 2,
        reportedState: "degraded",
        blockReason: "capacity_full",
        capacity: 0,
        repositoryIds: [],
      });
    } finally {
      database.close();
    }
  });

  test("treats an existing singleton connection as contention without advancing authority", async () => {
    const sequences: number[] = [];
    const accepted: number[] = [];
    const statuses: string[] = [];
    const results = [
      {
        ok: false as const,
        error: {
          kind: "remote" as const,
          code: "RUNNER_ALREADY_CONNECTED" as const,
          requestId,
          retryAfterMs: 1_000,
        },
      },
      { ok: true as const, data: heartbeatResponse, requestId },
    ];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: (request: RunnerHeartbeatRequest) => {
          sequences.push(request.sequence);
          return Promise.resolve(results.shift() ?? { ok: false as const, error: { kind: "network" as const } });
        },
        claim: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.reject(new Error("not reached")) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: { revoke: () => Promise.resolve() },
      onHeartbeatAccepted: ({ sequence }) => { accepted.push(sequence); },
      onRunnerStatus: (status) => { statuses.push(status); },
    });

    expect(await runner.heartbeatOnce()).toBe("retry");
    expect(sequences).toEqual([1]);
    expect(accepted).toEqual([]);
    expect(statuses).toEqual(["contended"]);
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(sequences).toEqual([1, 1]);
    expect(accepted).toEqual([1]);
    expect(statuses).toEqual(["contended", "connected"]);
  });

  test("moves a previously connected runner out of connected on fatal rejection", async () => {
    const statuses: string[] = [];
    const results = [
      { ok: true as const, data: heartbeatResponse, requestId },
      {
        ok: false as const,
        error: {
          kind: "remote" as const,
          code: "AUTHENTICATION_FAILED" as const,
          requestId,
        },
      },
    ];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve(results.shift() ?? {
          ok: false as const,
          error: {
            kind: "remote" as const,
            code: "AUTHENTICATION_FAILED" as const,
            requestId,
          },
        }),
        claim: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.reject(new Error("not reached")) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: { revoke: () => Promise.resolve() },
      onRunnerStatus: (status) => { statuses.push(status); },
    });

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.heartbeatOnce()).toBe("halted");
    expect(statuses).toEqual(["connected", "unavailable"]);
  });

  test("halts before applying a heartbeat response from a different request snapshot", async () => {
    const diagnostics: string[] = [];
    const revocations: string[] = [];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve({
          ok: true,
          data: {
            ...heartbeatResponse,
            candidates: [],
            releaseRunIds: ["run_finished0001"],
          },
          requestId,
        }),
        claim: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.reject(new Error("not reached")) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: {
        revoke: (runId) => {
          revocations.push(runId);
          return Promise.resolve();
        },
      },
      onDiagnostic: ({ code }) => { diagnostics.push(code); },
    });

    expect(await runner.heartbeatOnce()).toBe("halted");
    expect(revocations).toEqual([]);
    expect(diagnostics).toContain("capability_invalid");
  });

  test("releases an ambiguous local reservation only after cloud terminal proof", async () => {
    const releasedRuns: string[] = [];
    const capabilities = capabilityPort([], releasedRuns, [claim.runId]);
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve({
          ok: true,
          data: { ...heartbeatResponse, candidates: [], releaseRunIds: [claim.runId] },
          requestId,
        }),
        claim: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities,
      executor: { execute: () => Promise.reject(new Error("not reached")) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: {
        revoke: (runId) => {
          capabilities.releaseRun(runId);
          return Promise.resolve();
        },
      },
    });

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(releasedRuns).toEqual([claim.runId]);
  });

  test("routes every retained cloud-terminal proof through local stop reconciliation", async () => {
    const revocations: Array<{ runId: string; reason: string }> = [];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve({
          ok: true,
          data: { ...heartbeatResponse, candidates: [], releaseRunIds: [claim.runId] },
          requestId,
        }),
        claim: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort([], [], [claim.runId]),
      executor: { execute: () => Promise.reject(new Error("not reached")) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: {
        revoke: (runId, reason) => {
          revocations.push({ runId, reason });
          return Promise.resolve();
        },
      },
    });

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(revocations).toEqual([
      { runId: claim.runId, reason: "cloud_terminal" },
      { runId: claim.runId, reason: "cloud_terminal" },
    ]);
  });

  test("aborts an in-flight local execution before reconciling cloud terminality", async () => {
    let heartbeatCount = 0;
    let executionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    let executionAborted = false;
    const dispositions: DispatchSlotDisposition[] = [];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => {
          heartbeatCount += 1;
          return Promise.resolve({
            ok: true as const,
            data: heartbeatCount === 1
              ? heartbeatResponse
              : { ...heartbeatResponse, candidates: [], releaseRunIds: [claim.runId] },
            requestId,
          });
        },
        claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort(dispositions),
      executor: {
        execute: (_assignment, signal) => new Promise<DispatchExecutionResult>((resolve) => {
          const finish = (): void => {
            executionAborted = true;
            resolve({
              kind: "lease_lost",
              binding: { ...binding(), stage: "lease_lost", lastEventSequence: 0 },
            });
          };
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted === true) finish();
          executionStarted?.();
        }),
      },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: { revoke: () => Promise.resolve() },
    });

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await started;
    expect(executionAborted).toBeFalse();
    expect(await runner.heartbeatOnce()).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();
    expect(executionAborted).toBeTrue();
    expect(dispositions).toEqual([{ kind: "lease_lost", runId: claim.runId }]);
  });

  test("claims within capacity, maps only local capability data, and launches once", async () => {
    const assignments: string[] = [];
    const dispositions: DispatchSlotDisposition[] = [];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve({ ok: true, data: heartbeatResponse, requestId }),
        claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort(dispositions),
      executor: {
        execute(assignment): Promise<DispatchExecutionResult> {
          assignments.push(`${assignment.accountProfileId}:${assignment.repositoryPath}:${assignment.initialPrompt}`);
          return Promise.resolve({ kind: "running", binding: binding() });
        },
      },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: { revoke: () => Promise.resolve() },
    });
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();
    expect(assignments).toEqual([
      "account_primary1:/private/repository:Task key: OPS-0000001\nTask title: Implement dispatch\n\nTask description:\nImplement the accepted task.\n\nWorking instructions:\nMake repository changes only in the current managed worktree. Use other explicitly admitted workspace roots only when the task requires them. Implement the task, run relevant checks, and leave the managed worktree ready for human review.",
    ]);
    expect(dispositions).toEqual([{ kind: "running", runId: claim.runId }]);
  });

  test("replays a durable display outbox with protocol IDs and acknowledges exact text", async () => {
    const pending: PendingDispatchEvent[] = [{
      runId: claim.runId,
      sequence: 1,
      eventId: `${claim.runId}:1`,
      kind: "codex.reasoning_summary.delta",
      summary: "Checking the lease.",
      displayText: "Checking the lease.",
      createdAt: "2026-07-20T12:00:00.000Z",
    }];
    const sent: unknown[] = [];
    const acknowledged: number[] = [];
    const terminalAcknowledgements: string[] = [];
    const terminalBinding = { ...binding(), lastEventSequence: 1, stage: "completed" as const };
    const unrelatedOldestEvent: PendingDispatchEvent = {
      eventId: "run_unrelated0001:1",
      sequence: 1,
      runId: "run_unrelated0001",
      kind: "codex.running",
      summary: "An unrelated older event",
      createdAt: "2026-07-20T11:00:00.000Z",
    };
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve({ ok: true, data: heartbeatResponse, requestId }),
        claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
        appendEvents: (_runId, request) => {
          sent.push(request);
          return Promise.resolve({ ok: true, data: { acceptedThroughSequence: 1, serverTime: 2_000 }, requestId });
        },
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.resolve({ kind: "running", binding: binding() }) },
      outbox: {
        read: () => terminalBinding,
        pendingEvents: () => [unrelatedOldestEvent, ...pending],
        pendingEventsForRun: () => acknowledged.length === 0 ? pending : [],
        isAcknowledged: () => acknowledged.length > 0,
        acknowledge: (_runId, through) => { acknowledged.push(through); return 1; },
      },
      revocations: { revoke: () => Promise.resolve() },
      onRunTerminalAcknowledged: (runId) => { terminalAcknowledgements.push(runId); },
    });
    await runner.heartbeatOnce();
    await runner.pullOnce();
    await Promise.resolve();
    await runner.pullOnce();
    expect(sent).toEqual([expect.objectContaining({
      events: [{
        id: wireDispatchEventId(`${claim.runId}:1`),
        sequence: 1,
        kind: "codex.reasoning_summary.delta",
        displayText: "Checking the lease.",
      }],
    })]);
    expect(acknowledged).toEqual([1]);
    expect(terminalAcknowledgements).toEqual([claim.runId]);
  });

  test("publishes a coordinator terminal before releasing its local slot and lease", async () => {
    const order: string[] = [];
    const terminalBinding = { ...binding(), lastEventSequence: 1, stage: "failed" as const };
    const event: PendingDispatchEvent = {
      runId: claim.runId,
      sequence: 1,
      eventId: `${claim.runId}:9`,
      kind: "run.failed",
      summary: "Run needs attention",
      createdAt: "2026-07-20T12:00:00.000Z",
    };
    let acknowledged = false;
    let finishSettlement: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      finishSettlement = resolve;
    });
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve({ ok: true, data: heartbeatResponse, requestId }),
        claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
        appendEvents: () => {
          order.push("cloud.append");
          return Promise.resolve({
            ok: true,
            data: { acceptedThroughSequence: 1, serverTime: 2_000 },
            requestId,
          });
        },
      },
      capabilities: {
        snapshot: () => Promise.resolve({
          reportedState: "ready",
          capacity: 1,
          activeRuns: 0,
          retainedRunIds: [],
          repositoryIds: [repositoryId],
        }),
        acquire: () => Promise.resolve(slot),
        settle: (_slot, disposition) => {
          order.push(`slot.${disposition.kind}`);
          finishSettlement?.();
          return Promise.resolve();
        },
        releaseRun: () => undefined,
      },
      executor: {
        execute: () => Promise.resolve({ kind: "terminal", binding: terminalBinding }),
      },
      outbox: {
        read: () => terminalBinding,
        pendingEvents: () => acknowledged ? [] : [event],
        pendingEventsForRun: () => acknowledged ? [] : [event],
        isAcknowledged: () => acknowledged,
        acknowledge: () => {
          order.push("outbox.acknowledge");
          acknowledged = true;
          return 1;
        },
      },
      revocations: { revoke: () => Promise.resolve() },
      onRunTerminalAcknowledged: () => {
        order.push("terminal.acknowledged");
      },
    });

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await settled;
    expect(order).toEqual([
      "cloud.append",
      "outbox.acknowledge",
      "terminal.acknowledged",
      "slot.terminal",
    ]);
  });

  test("rejects an outbox acknowledgment beyond the exact transmitted batch", async () => {
    const pending: PendingDispatchEvent[] = [{
      runId: claim.runId,
      sequence: 1,
      eventId: `${claim.runId}:1`,
      kind: "codex.running",
      summary: "Codex is working",
      createdAt: "2026-07-20T12:00:00.000Z",
    }];
    const acknowledged: number[] = [];
    const diagnostics: string[] = [];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve({ ok: true, data: heartbeatResponse, requestId }),
        claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
        appendEvents: () => Promise.resolve({
          ok: true,
          data: { acceptedThroughSequence: 2, serverTime: 2_000 },
          requestId,
        }),
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.resolve({ kind: "running", binding: binding() }) },
      outbox: {
        read: () => binding(),
        pendingEvents: () => pending,
        pendingEventsForRun: () => pending,
        isAcknowledged: () => false,
        acknowledge: (_runId, through) => { acknowledged.push(through); return 1; },
      },
      revocations: { revoke: () => Promise.resolve() },
      onDiagnostic: ({ code }) => { diagnostics.push(code); },
    });

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();
    expect(await runner.pullOnce()).toBe("halted");
    expect(acknowledged).toEqual([]);
    expect(diagnostics).toContain("outbox_corrupt");
    expect(await runner.heartbeatOnce()).toBe("halted");
  });

  test("revokes and retains an execution whose coordinator throws instead of renewing it forever", async () => {
    const dispositions: DispatchSlotDisposition[] = [];
    const revocations: Array<{ runId: string; reason: string }> = [];
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve({ ok: true, data: heartbeatResponse, requestId }),
        claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort(dispositions),
      executor: { execute: () => Promise.reject(new Error("coordinator fault")) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: {
        revoke: (runId, reason) => {
          revocations.push({ runId, reason });
          return Promise.resolve();
        },
      },
    });

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(revocations).toEqual([{ runId: claim.runId, reason: "runner_invalid" }]);
    expect(dispositions).toEqual([{ kind: "ambiguous", runId: claim.runId }]);
    expect(await runner.fence.assertCurrent({
      runId: claim.runId,
      claimId: claim.claimId,
      claimFence: claim.claimFence,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    })).toBeFalse();
  });

  test("awaits delayed fatal revocation before reporting a halted supervisor", async () => {
    let heartbeatCount = 0;
    let finishRevocation: (() => void) | undefined;
    let revocationStarted = false;
    let runSettled = false;
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => {
          heartbeatCount += 1;
          return heartbeatCount === 1
            ? Promise.resolve({ ok: true as const, data: heartbeatResponse, requestId })
            : Promise.resolve({
                ok: false as const,
                error: {
                  kind: "remote" as const,
                  code: "AUTHENTICATION_FAILED" as const,
                  requestId,
                },
              });
        },
        claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.resolve({ kind: "running", binding: binding() }) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: {
        revoke: () => {
          revocationStarted = true;
          return new Promise<void>((resolve) => { finishRevocation = resolve; });
        },
      },
    });
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();

    const supervised = runner.run().finally(() => { runSettled = true; });
    for (let index = 0; index < 8 && !revocationStarted; index += 1) await Promise.resolve();
    expect(revocationStarted).toBeTrue();
    expect(runSettled).toBeFalse();
    finishRevocation?.();
    expect(await supervised).toEqual({ kind: "halted", reason: "authentication" });
    expect(runSettled).toBeTrue();
  });

  test("does not deadlock when a stop-event flush discovers a stale fence", async () => {
    let heartbeatCount = 0;
    const event: PendingDispatchEvent = {
      runId: claim.runId,
      sequence: 1,
      eventId: `${claim.runId}:7`,
      kind: "run.cancelled",
      summary: "Run cancelled",
      createdAt: "2026-07-20T12:00:00.000Z",
    };
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => {
          heartbeatCount += 1;
          return Promise.resolve({
            ok: true as const,
            data: heartbeatCount === 1
              ? heartbeatResponse
              : { ...heartbeatResponse, candidates: [], stopRunIds: [claim.runId] },
            requestId,
          });
        },
        claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
        appendEvents: () => Promise.resolve({
          ok: false,
          error: { kind: "remote", code: "CLAIM_STALE", requestId },
        }),
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.resolve({ kind: "running", binding: binding() }) },
      outbox: {
        read: () => binding(),
        pendingEvents: () => [event],
        pendingEventsForRun: () => [event],
        isAcknowledged: () => false,
        acknowledge: () => 0,
      },
      revocations: { revoke: () => Promise.resolve() },
    });

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();
    expect(await runner.heartbeatOnce()).toBe("ok");
  });

  test("retains lease authority and retries when local stop reconciliation rejects", async () => {
    const heartbeatRequests: RunnerHeartbeatRequest[] = [];
    const diagnostics: string[] = [];
    let revocationAttempts = 0;
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: (request) => {
          heartbeatRequests.push(request);
          const ownsRun = request.currentRunIds.includes(claim.runId);
          return Promise.resolve({
            ok: true as const,
            data: ownsRun
              ? {
                  ...heartbeatResponse,
                  candidates: [],
                  runLeases: [{ runId: claim.runId, leaseUntil: claim.leaseUntil }],
                  stopRunIds: [claim.runId],
                }
              : heartbeatResponse,
            requestId,
          });
        },
        claim: () => Promise.resolve({ ok: true as const, data: { run: claim }, requestId }),
        appendEvents: () => Promise.resolve({ ok: false as const, error: { kind: "network" as const } }),
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.resolve({ kind: "running", binding: binding() }) },
      outbox: {
        read: (runId) => runId === claim.runId ? binding() : null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: {
        revoke: () => {
          revocationAttempts += 1;
          return revocationAttempts === 1
            ? Promise.reject(new Error("local stop unavailable"))
            : Promise.resolve();
        },
      },
      onDiagnostic: ({ code }) => { diagnostics.push(code); },
    });
    const tuple = {
      runId: claim.runId,
      claimId: claim.claimId,
      claimFence: claim.claimFence,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    } as const;

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(revocationAttempts).toBe(1);
    expect(diagnostics).toEqual(["revocation_failed"]);
    expect(heartbeatRequests[1]?.currentRunIds).toEqual([claim.runId]);
    expect(await runner.fence.assertCurrent(tuple)).toBeTrue();

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(revocationAttempts).toBe(2);
    expect(heartbeatRequests[2]?.currentRunIds).toEqual([claim.runId]);
    expect(await runner.fence.assertCurrent(tuple)).toBeFalse();
  });

  test("replays a transient stop publication before releasing capacity or authority", async () => {
    let heartbeatCount = 0;
    let appendAttempts = 0;
    let acknowledgedThrough = 1;
    let durableBinding: DispatchBinding = {
      ...binding(),
      threadId: "thread_primary0001",
      turnId: "turn_primary0001",
    };
    const pending: PendingDispatchEvent[] = [];
    const dispositions: DispatchSlotDisposition[] = [];
    const releasedRuns: string[] = [];
    const capabilities = capabilityPort(dispositions, releasedRuns);
    const revocations = new DispatchRevocationCoordinator({
      capabilities,
      sessions: {
        interruptGatewayThread: () => Promise.resolve("interrupted"),
      },
      store: {
        read: (runId) => runId === claim.runId ? durableBinding : null,
        transition: (input) => {
          durableBinding = {
            ...durableBinding,
            stage: input.to,
            failureCode: input.failureCode ?? durableBinding.failureCode,
          };
          return durableBinding;
        },
        appendPublicEvent: (input) => {
          const sequence = durableBinding.lastEventSequence + 1;
          const event: PendingDispatchEvent = {
            runId: input.runId,
            sequence,
            eventId: input.eventId,
            kind: input.kind,
            summary: "Run cancelled",
            createdAt: "2026-07-20T12:00:00.000Z",
          };
          durableBinding = { ...durableBinding, lastEventSequence: sequence };
          pending.push(event);
          return event;
        },
      },
    });
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => {
          heartbeatCount += 1;
          return Promise.resolve({
            ok: true as const,
            data: heartbeatCount === 1
              ? heartbeatResponse
              : {
                  ...heartbeatResponse,
                  candidates: [],
                  runLeases: [{ runId: claim.runId, leaseUntil: claim.leaseUntil }],
                  stopRunIds: [claim.runId],
                },
            requestId,
          });
        },
        claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
        appendEvents: (_runId, request) => {
          appendAttempts += 1;
          if (appendAttempts === 1) {
            return Promise.resolve({ ok: false as const, error: { kind: "network" as const } });
          }
          const last = request.events.at(-1);
          if (last === undefined) throw new Error("Expected a cancellation event");
          return Promise.resolve({
            ok: true as const,
            data: { acceptedThroughSequence: last.sequence, serverTime: 2_000 },
            requestId,
          });
        },
      },
      capabilities,
      executor: { execute: () => Promise.resolve({ kind: "running", binding: durableBinding }) },
      outbox: {
        read: (runId) => runId === claim.runId ? durableBinding : null,
        pendingEvents: () => pending.filter(({ sequence }) => sequence > acknowledgedThrough),
        pendingEventsForRun: (runId) => runId === claim.runId
          ? pending.filter(({ sequence }) => sequence > acknowledgedThrough)
          : [],
        isAcknowledged: (_runId, through) => acknowledgedThrough >= through,
        acknowledge: (_runId, through) => {
          const previous = acknowledgedThrough;
          acknowledgedThrough = through;
          return through > previous ? 1 : 0;
        },
      },
      revocations,
      onRunTerminalAcknowledged: (runId) => {
        capabilities.releaseRun(runId);
      },
    });
    const tuple = {
      runId: claim.runId,
      claimId: claim.claimId,
      claimFence: claim.claimFence,
      runtimePublicId: "runner_primary0001",
      runtimeBootId: "boot_primary0001",
    } as const;

    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(durableBinding.stage).toBe("cancelled");
    expect(pending.map(({ kind }) => kind)).toEqual(["run.cancelled"]);
    expect(appendAttempts).toBe(1);
    expect(acknowledgedThrough).toBe(1);
    expect(releasedRuns).toEqual([]);
    expect(await runner.fence.assertCurrent(tuple)).toBeTrue();

    expect(await runner.pullOnce()).toBe("ok");
    expect(appendAttempts).toBe(2);
    expect(acknowledgedThrough).toBe(2);
    expect(releasedRuns).toEqual([claim.runId]);
    expect(await runner.fence.assertCurrent(tuple)).toBeFalse();
  });

  test("an already-aborted supervisor signal exits without entering either loop", async () => {
    let heartbeats = 0;
    const controller = new AbortController();
    controller.abort();
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => {
          heartbeats += 1;
          return Promise.resolve({ ok: true, data: heartbeatResponse, requestId });
        },
        claim: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
        appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort([]),
      executor: { execute: () => Promise.reject(new Error("not reached")) },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: { revoke: () => Promise.resolve() },
    });

    expect(await runner.run(controller.signal)).toEqual({ kind: "stopped" });
    expect(heartbeats).toBe(0);
  });

  test("cancels the losing shutdown grace sleep when executions settle", async () => {
    let executionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    let settleExecution:
      | ((result: DispatchExecutionResult) => void)
      | undefined;
    let graceStarted: (() => void) | undefined;
    const graceWasStarted = new Promise<void>((resolve) => {
      graceStarted = resolve;
    });
    let graceCancelled = false;
    const scheduler: DispatchRunnerScheduler = {
      sleep: (_milliseconds, signal) =>
        new Promise<void>((resolve) => {
          graceStarted?.();
          const finish = (): void => {
            graceCancelled = true;
            resolve();
          };
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted === true) finish();
        }),
    };
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: "runner_primary0001",
        installationId: "install_primary001",
        bootId: "boot_primary0001",
        bootGeneration: 1,
        clientVersion: "0.1.0",
      },
      cloud: {
        heartbeat: () => Promise.resolve({
          ok: true,
          data: heartbeatResponse,
          requestId,
        }),
        claim: () => Promise.resolve({
          ok: true,
          data: { run: claim },
          requestId,
        }),
        appendEvents: () =>
          Promise.resolve({ ok: false, error: { kind: "network" } }),
      },
      capabilities: capabilityPort([]),
      executor: {
        execute: () => {
          executionStarted?.();
          return new Promise<DispatchExecutionResult>((resolve) => {
            settleExecution = resolve;
          });
        },
      },
      outbox: {
        read: () => null,
        pendingEvents: () => [],
        pendingEventsForRun: () => [],
        isAcknowledged: () => true,
        acknowledge: () => 0,
      },
      revocations: { revoke: () => Promise.resolve() },
      scheduler,
      shutdownGraceMs: 1_000,
    });
    expect(await runner.heartbeatOnce()).toBe("ok");
    expect(await runner.pullOnce()).toBe("ok");
    await started;

    const controller = new AbortController();
    controller.abort();
    const stopped = runner.run(controller.signal);
    await graceWasStarted;
    if (settleExecution === undefined) {
      throw new Error("Execution settlement hook was not installed");
    }
    settleExecution({ kind: "running", binding: binding() });
    expect(await stopped).toEqual({ kind: "stopped" });
    expect(graceCancelled).toBeTrue();
  });

  test("terminates only the interaction-faulted run without halting the runner", async () => {
    for (const terminalReason of [
      "interaction_limit",
      "interaction_resolution_ambiguous",
      "invalid_interaction_response",
    ] as const) {
      const revoked: Array<{ runId: string; reason: string }> = [];
      const runner = new HRADispatchRunner({
        identity: {
          runnerId: "runner_primary0001",
          installationId: "install_primary001",
          bootId: "boot_primary0001",
          bootGeneration: 1,
          clientVersion: "0.1.0",
        },
        cloud: {
          heartbeat: () => Promise.resolve({ ok: true, data: heartbeatResponse, requestId }),
          claim: () => Promise.resolve({ ok: true, data: { run: claim }, requestId }),
          appendEvents: () => Promise.resolve({ ok: false, error: { kind: "network" } }),
        },
        capabilities: capabilityPort([]),
        executor: { execute: () => Promise.resolve({ kind: "running", binding: binding() }) },
        outbox: {
          read: () => null,
          pendingEvents: () => [],
          pendingEventsForRun: () => [],
          isAcknowledged: () => true,
          acknowledge: () => 0,
        },
        interactions: {
          syncOnce: (runIds) => Promise.resolve(runIds.includes(claim.runId)
            ? { kind: "run_terminal", runId: claim.runId, reason: terminalReason }
            : "ok"),
        },
        revocations: {
          revoke: (runId, reason) => {
            revoked.push({ runId, reason });
            return Promise.resolve();
          },
        },
      });

      expect(await runner.heartbeatOnce()).toBe("ok");
      expect(await runner.pullOnce()).toBe("ok");
      await Promise.resolve();
      await Promise.resolve();
      expect(await runner.pullOnce()).toBe("retry");
      expect(revoked).toEqual([{ runId: claim.runId, reason: terminalReason }]);
      expect(await runner.heartbeatOnce()).toBe("ok");
    }
  });

  test("jitter is deterministic and remains inside its configured bound", () => {
    expect(boundedJitterMilliseconds(2_000, 0.25, 0)).toBe(1_500);
    expect(boundedJitterMilliseconds(2_000, 0.25, 0.5)).toBe(2_000);
    expect(boundedJitterMilliseconds(2_000, 0.25, 1)).toBe(2_500);
  });
});
