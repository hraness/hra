import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { RunInteractionRequest } from "@hraness/agent-tasks-protocol";

import {
  DispatchInteractionConflict,
  DispatchInteractionStore,
} from "../src/state/dispatch-interaction-store";
import { DispatchStore } from "../src/state/dispatch-store";
import { applyMigrations } from "../src/state/database";

function preparedDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES ('project_primary', '/fixture/repo', '/fixture/repo/.git',
      'Fixture', '2026-07-20T12:00:00.000Z', '2026-07-20T12:00:00.000Z')
  `).run();
  const dispatch = new DispatchStore(database);
  dispatch.bindRepository({
    repositoryPublicId: "repo_primary0001",
    projectId: "project_primary",
    canonicalRepositoryPath: "/fixture/repo",
    canonicalGitCommonDir: "/fixture/repo/.git",
  });
  dispatch.reserve({
    runId: "run_primary0001",
    taskId: "task_primary0001",
    taskKey: "OPS-7K2M4Q9",
    claimId: "claim_primary001",
    claimFence: 7,
    inputReviewRevision: 3,
    runtimePublicId: "runner_primary0001",
    runtimeBootId: "boot_primary0001",
    repositoryPublicId: "repo_primary0001",
  });
  return database;
}

const request: Extract<RunInteractionRequest, { kind: "user_input" }> = {
  id: "interaction_primary001",
  kind: "user_input",
  createdAt: 100,
  expiresAt: 200,
  reply: {
    version: 1,
    algorithm: "P256-HKDF-SHA256-A256GCM",
    keyId: `hitlkey_${"a".repeat(32)}`,
    publicKey: "B".repeat(87),
    runnerId: "runner_primary0001",
    bootId: "boot_primary0001",
    bootGeneration: 1,
    claimId: "claim_primary001",
    claimFence: 7,
    requestDigest: `sha256_${"b".repeat(64)}`,
  },
  questions: [{
    id: "question_primary001",
    header: "Direction",
    prompt: "Which direction should continue?",
    allowOther: false,
    options: [{ id: "option_primary0001", label: "Focused" }],
  }],
};

describe("durable dispatch interaction store", () => {
  test("replays exact bounded requests and persists no provider mapping or answer", () => {
    const database = preparedDatabase();
    try {
      const store = new DispatchInteractionStore(database);
      store.upsert("run_primary0001", request, 150);
      store.upsert("run_primary0001", request, 151);
      expect(store.syncBatch("run_primary0001")).toEqual({
        upserts: [request],
        settlements: [],
      });
      expect(() => store.upsert("run_primary0001", {
        ...request,
        questions: [{
          id: "question_primary001",
          header: "Direction",
          prompt: "Changed prompt",
          allowOther: false,
          options: [{ id: "option_primary0001", label: "Focused" }],
        }],
      }, 151)).toThrow(DispatchInteractionConflict);

      store.markPublished([request.id], 160);
      store.settle(request.id, 2, "applied", undefined, 175);
      expect(store.syncBatch("run_primary0001")).toEqual({
        upserts: [],
        settlements: [{
          interactionId: request.id,
          responseRevision: 2,
          outcome: "applied",
        }],
      });
      const serialized = JSON.stringify(database.query(`
        SELECT request_json, state, response_revision FROM dispatch_interactions
      `).all());
      expect(serialized).not.toContain("provider");
      expect(serialized).not.toContain("answer");
      expect(store.acknowledgeSettlements([request.id])).toBe(1);
      expect(store.pendingRunIds()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("records an expired settlement without ever accepting response content", () => {
    const database = preparedDatabase();
    try {
      const store = new DispatchInteractionStore(database);
      store.upsert("run_primary0001", {
        id: "interaction_file000001",
        kind: "file_change_approval",
        scope: "once",
        createdAt: 100,
        expiresAt: 200,
        reply: request.reply,
      }, 150);
      store.settle(
        "interaction_file000001",
        undefined,
        "expired",
        "local_deadline",
        201,
      );
      expect(store.syncBatch("run_primary0001")).toEqual({
        upserts: [{
          id: "interaction_file000001",
          kind: "file_change_approval",
          scope: "once",
          createdAt: 100,
          expiresAt: 200,
          reply: request.reply,
        }],
        settlements: [],
      });
      store.markPublished(["interaction_file000001"], 202);
      expect(store.syncBatch("run_primary0001")).toEqual({
        upserts: [],
        settlements: [{
          interactionId: "interaction_file000001",
          outcome: "expired",
          reason: "local_deadline",
        }],
      });
    } finally {
      database.close();
    }
  });

  test("removes every retained row when its run is terminally released", () => {
    const database = preparedDatabase();
    try {
      const store = new DispatchInteractionStore(database);
      store.upsert("run_primary0001", request, 150);
      expect(store.pendingRunIds()).toEqual(["run_primary0001"]);
      expect(store.deleteRun("run_primary0001")).toBe(1);
      expect(store.deleteRun("run_primary0001")).toBe(0);
      expect(store.pendingRunIds()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("publishes bounded pages and rotates durably across active runs", () => {
    const database = preparedDatabase();
    try {
      const dispatch = new DispatchStore(database);
      dispatch.reserve({
        runId: "run_secondary001",
        taskId: "task_secondary001",
        taskKey: "OPS-8K2M4Q9",
        claimId: "claim_secondary01",
        claimFence: 8,
        inputReviewRevision: 1,
        runtimePublicId: "runner_primary0001",
        runtimeBootId: "boot_primary0001",
        repositoryPublicId: "repo_primary0001",
      });
      const store = new DispatchInteractionStore(database);
      for (const [runId, token] of [
        ["run_primary0001", "primary"],
        ["run_secondary001", "secondary"],
      ] as const) {
        for (let index = 0; index < 10; index += 1) {
          store.upsert(runId, {
            id: `interaction_${token}${index.toString().padStart(3, "0")}`,
            kind: "file_change_approval",
            scope: "once",
            createdAt: 100 + index,
            expiresAt: 200 + index,
            reply: request.reply,
          }, 150 + index);
        }
      }

      expect(store.nextRunId(["run_primary0001", "run_secondary001"]))
        .toBe("run_primary0001");
      expect(store.nextRunId(["run_primary0001", "run_secondary001"]))
        .toBe("run_secondary001");
      const restarted = new DispatchInteractionStore(database);
      expect(restarted.nextRunId(["run_primary0001", "run_secondary001"]))
        .toBe("run_primary0001");

      const firstPage = store.syncBatch("run_primary0001").upserts;
      expect(firstPage).toHaveLength(8);
      store.markPublished(firstPage.map(({ id }) => id), 500);
      const secondPage = store.syncBatch("run_primary0001").upserts;
      expect(secondPage).toHaveLength(2);
      expect(new Set([...firstPage, ...secondPage].map(({ id }) => id)).size).toBe(10);
      store.markPublished(secondPage.map(({ id }) => id), 501);
      expect(store.syncBatch("run_primary0001").upserts).toEqual([]);
    } finally {
      database.close();
    }
  });
});
