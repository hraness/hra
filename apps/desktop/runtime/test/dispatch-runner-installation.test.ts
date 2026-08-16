import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { RunnerHeartbeatRequest } from "@hraness/agent-tasks-protocol";

import { applyMigrations } from "../src/state/database";
import {
  DispatchRunnerInstallationStore,
  scopedDispatchRunnerId,
  type DispatchIdentityRandom,
} from "../src/state/dispatch-runner-installation";

function random(values: readonly number[]): DispatchIdentityRandom {
  let index = 0;
  return {
    bytes(length) {
      const value = values[index];
      index += 1;
      if (value === undefined) throw new Error("identity random fixture exhausted");
      return new Uint8Array(length).fill(value);
    },
  };
}

function heartbeat(
  boot: ReturnType<DispatchRunnerInstallationStore["startBoot"]>,
  overrides: Partial<RunnerHeartbeatRequest> = {},
): RunnerHeartbeatRequest {
  return {
    runnerId: boot.runnerId,
    installationId: boot.installationId,
    bootId: boot.bootId,
    bootGeneration: boot.bootGeneration,
    sequence: boot.initialHeartbeatSequence,
    protocolVersion: 1,
    clientVersion: "0.1.0",
    reportedState: "ready",
    capacity: 1,
    activeRuns: 0,
    currentRunIds: [],
    retainedRunIds: [],
    repositoryIds: [],
    ...overrides,
  };
}

describe("dispatch runner installation identity", () => {
  test("derives stable authority-scoped runner IDs without changing installation identity", () => {
    const installationId = `install_${"01".repeat(24)}`;
    const first = scopedDispatchRunnerId(
      installationId,
      "promotion:promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(first).toBe(scopedDispatchRunnerId(
      installationId,
      "promotion:promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ));
    expect(first).not.toBe(scopedDispatchRunnerId(
      installationId,
      "promotion:promotion_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    ));
    expect(first).toMatch(/^runner_[a-f0-9]{48}$/u);
  });

  test("reuses an unacknowledged first boot and advances only after cloud authority", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      applyMigrations(database);
      const store = new DispatchRunnerInstallationStore(database);
      const first = store.startBoot({ random: random([1, 2, 3]) });
      const uncertainRestart = store.startBoot({ random: random([]) });
      expect(uncertainRestart).toEqual(first);

      store.acknowledgeHeartbeat({
        bootId: first.bootId,
        bootGeneration: first.bootGeneration,
        sequence: first.initialHeartbeatSequence,
      });
      const restarted = store.startBoot({ random: random([4]) });
      expect(restarted).toMatchObject({
        runnerId: first.runnerId,
        installationId: first.installationId,
        bootGeneration: 2,
        initialHeartbeatSequence: 1,
      });
      expect(restarted.bootId).not.toBe(first.bootId);
    } finally {
      database.close();
    }
  });

  test("rejects stale or skipped heartbeat acknowledgments", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      applyMigrations(database);
      const store = new DispatchRunnerInstallationStore(database);
      const boot = store.startBoot({ random: random([5, 6, 7]) });
      expect(() => store.acknowledgeHeartbeat({
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
        sequence: 2,
      })).toThrow("does not match");
      store.acknowledgeHeartbeat({
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
        sequence: 1,
      });
      expect(() => store.acknowledgeHeartbeat({
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
        sequence: 3,
      })).toThrow("does not match");
    } finally {
      database.close();
    }
  });

  test("persists one exact pending heartbeat until its acknowledgment", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      applyMigrations(database);
      const store = new DispatchRunnerInstallationStore(database);
      const boot = store.startBoot({ random: random([8, 9, 10]) });
      const prepared = heartbeat(boot);
      expect(store.prepareHeartbeat(prepared)).toEqual(prepared);
      expect(store.prepareHeartbeat(prepared)).toEqual(prepared);
      expect(() =>
        store.prepareHeartbeat({
          ...prepared,
          reportedState: "busy",
        })
      ).toThrow("conflicts with the durable pending request");

      const restarted = new DispatchRunnerInstallationStore(database);
      expect(restarted.startBoot({ random: random([]) })).toEqual(boot);
      expect(restarted.pendingHeartbeat({
        runnerId: boot.runnerId,
        installationId: boot.installationId,
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
        sequence: boot.initialHeartbeatSequence,
      })).toEqual(prepared);

      restarted.acknowledgeHeartbeat({
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
        sequence: boot.initialHeartbeatSequence,
      });
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count
        FROM dispatch_runner_pending_heartbeats
      `).get()?.count).toBe(0);
    } finally {
      database.close();
    }
  });
});
