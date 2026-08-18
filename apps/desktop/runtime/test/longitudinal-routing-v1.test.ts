import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateLongitudinalRoutingShadowComparison,
  HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM,
} from "../src/harness/longitudinal-routing-v1";
import { LongitudinalRoutingSQLiteAuthorityV1 } from
  "../src/harness/longitudinal-routing-sqlite-v1";
import { migrations } from "../src/state/migrations";

const migration = migrations.find(({ version }) => version === 44);
if (migration === undefined) throw new Error("migration 44 is missing");
const migrationSql = migration.sql;

function database(path = ":memory:"): Database {
  const value = new Database(path, { strict: true });
  value.exec("PRAGMA foreign_keys = ON");
  value.exec(`
    CREATE TABLE harness_program_runs (run_id TEXT PRIMARY KEY);
    CREATE TABLE harness_context_values (value_id TEXT PRIMARY KEY);
    CREATE TABLE harness_program_operation_receipts (
      receipt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES harness_program_runs(run_id),
      canonical_node_path TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('agent.status', 'agent.result')),
      request_digest TEXT NOT NULL,
      effect_key TEXT NOT NULL,
      replay_class TEXT NOT NULL,
      state TEXT NOT NULL,
      result_value_id TEXT REFERENCES harness_context_values(value_id),
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      UNIQUE (run_id, canonical_node_path)
    );
    CREATE TABLE chat_panes (pane_id TEXT PRIMARY KEY);
    CREATE TABLE harness_actor_epochs (
      epoch_id TEXT PRIMARY KEY,
      root_actor_id TEXT NOT NULL
    );
    CREATE TABLE harness_actors (
      actor_id TEXT PRIMARY KEY,
      epoch_id TEXT NOT NULL,
      dispatch_policy_version INTEGER NOT NULL,
      work_class TEXT NOT NULL
    );
    CREATE TABLE harness_actor_turns (
      turn_id TEXT PRIMARY KEY,
      epoch_id TEXT NOT NULL,
      actor_id TEXT NOT NULL
    );
    CREATE TABLE harness_actor_pane_bindings (
      binding_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      pane_id TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE harness_actor_incarnations (
      incarnation_id TEXT PRIMARY KEY,
      requested_model TEXT NOT NULL,
      requested_reasoning_effort TEXT NOT NULL
    );
    CREATE TABLE harness_actor_turn_attempts (
      attempt_id TEXT PRIMARY KEY,
      incarnation_id TEXT NOT NULL,
      requested_service_tier TEXT NOT NULL,
      realized_service_tier TEXT NOT NULL,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      started_at TEXT,
      settled_at TEXT,
      state TEXT NOT NULL
    );
    CREATE TABLE harness_actor_results (
      result_id TEXT PRIMARY KEY,
      epoch_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      terminal_attempt_id TEXT UNIQUE,
      outcome TEXT NOT NULL
    );
  `);
  value.exec(migrationSql);
  return value;
}

function seedResultBeforePaneBinding(value: Database): void {
  value.exec(`
    INSERT INTO chat_panes VALUES ('pane_longitudinal01');
    INSERT INTO harness_actor_epochs VALUES (
      'hepoch_longitudinal01', 'hactor_longitudinalroot01'
    );
    INSERT INTO harness_actors VALUES (
      'hactor_longitudinalroot01', 'hepoch_longitudinal01',
      1, 'standard'
    );
    INSERT INTO harness_actor_turns VALUES (
      'hturn_longitudinal01', 'hepoch_longitudinal01',
      'hactor_longitudinalroot01'
    );
    INSERT INTO harness_actor_incarnations VALUES (
      'hincarnation_longitudinal01', 'gpt-5.6-sol', 'max'
    );
    INSERT INTO harness_actor_turn_attempts VALUES (
      'hattempt_longitudinal01', 'hincarnation_longitudinal01',
      'fast', 'fast', 120, 80, 30, 10,
      '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:02.000Z',
      'completed'
    );
    INSERT INTO harness_actor_results VALUES (
      'hresult_longitudinal01', 'hepoch_longitudinal01',
      'hactor_longitudinalroot01', 'hattempt_longitudinal01', 'succeeded'
    );
  `);
}

describe("longitudinal routing shadow memory", () => {
  test("keeps minimum evidence, quality, and hysteresis as deterministic gates", () => {
    const base = {
      qualityEvaluatedResults: 8,
      qualityPassedResults: 8,
      uncachedInputObservedResults: 8,
    };
    expect(evaluateLongitudinalRoutingShadowComparison({
      control: {
        ...base,
        qualityEvaluatedResults: 7,
        qualityPassedResults: 7,
        uncachedInputObservedResults: 7,
        operationalResults:
          HRA_LONGITUDINAL_ROUTING_MIN_OPERATIONAL_RESULTS_PER_ARM - 1,
        uncachedInputTokens: 800,
      },
      candidate: {
        ...base,
        operationalResults: 8,
        uncachedInputTokens: 700,
      },
    }).state).toBe("collectingOperationalEvidence");
    expect(evaluateLongitudinalRoutingShadowComparison({
      control: {
        ...base,
        qualityEvaluatedResults: 0,
        qualityPassedResults: 0,
        operationalResults: 8,
        uncachedInputTokens: 800,
      },
      candidate: {
        ...base,
        qualityEvaluatedResults: 0,
        qualityPassedResults: 0,
        operationalResults: 8,
        uncachedInputTokens: 700,
      },
    }).state).toBe("qualityEvidenceRequired");
    expect(evaluateLongitudinalRoutingShadowComparison({
      control: { ...base, operationalResults: 8, uncachedInputTokens: 800 },
      candidate: { ...base, operationalResults: 8, uncachedInputTokens: 760 },
    })).toMatchObject({
      state: "shadowCandidate",
      mode: "shadow",
      policyAuthorization: "none",
      tokenSavingsBasisPoints: 500,
    });
  });

  test("materializes only after exact pane lineage and returns bounded ID-free facts", () => {
    const value = database();
    try {
      seedResultBeforePaneBinding(value);
      expect(value.query(`
        SELECT COUNT(*) AS count
        FROM harness_longitudinal_routing_observations
      `).get()).toEqual({ count: 0 });

      value.exec(`
        INSERT INTO harness_actor_pane_bindings VALUES (
          'hpanebinding_longitudinal01', 'hactor_longitudinalroot01',
          'pane_longitudinal01', 'attached'
        );
      `);
      expect(value.query(`
        SELECT routed_profile, realized_service_tier, operational_outcome
        FROM harness_longitudinal_routing_observations
      `).get()).toEqual({
        routed_profile: "solMax",
        realized_service_tier: "fast",
        operational_outcome: "succeeded",
      });

      const authority = new LongitudinalRoutingSQLiteAuthorityV1(value);
      const inspection = authority.inspectForCaller({
        epochId: "hepoch_longitudinal01",
        actorId: "hactor_longitudinalroot01",
        turnId: "hturn_longitudinal01",
      });
      expect(inspection).toMatchObject({
        kind: "available",
        mode: "shadow",
        policyAuthorization: "none",
        coverage: {
          outcomes: "recursiveActorOutcomesOnly",
          ordinaryRootTurnSpend: "excluded",
        },
        analysis: { freshness: "pending" },
        evidence: {
          results: 1,
          operationalOutcomes: { succeeded: 1 },
          quality: { state: "absent", evaluatedResults: 0 },
          tokens: {
            inputTokens: { observedResults: 1, total: 120 },
            cachedInputTokens: { observedResults: 1, total: 80 },
            uncachedInputTokens: { observedResults: 1, total: 40 },
            outputTokens: { observedResults: 1, total: 30 },
            reasoningOutputTokens: { observedResults: 1, total: 10 },
          },
          elapsed: { observedResults: 1, totalMilliseconds: 2_000 },
        },
        routes: [{
          workClass: "standard",
          requestedProfile: "solMax",
          requestedTier: "fast",
          realizedTier: "fast",
        }],
        shadow: {
          state: "collectingOperationalEvidence",
          recommendation: null,
        },
      });
      const serialized = JSON.stringify(inspection);
      for (const forbidden of [
        "hepoch_", "hactor_", "hturn_", "pane_", "account", "provider",
        "2030-01-01",
      ]) expect(serialized).not.toContain(forbidden);

      const [dirty] = authority.listDirtyPaneHeads({ limit: 1 });
      expect(dirty).toEqual({
        paneId: "pane_longitudinal01",
        observationRevision: 1,
      });
      expect(authority.acknowledgeAnalyzedPane({
        paneId: dirty!.paneId,
        expectedObservationRevision: dirty!.observationRevision,
        inspection,
      })).toBeTrue();
      expect(authority.inspectPane(dirty!.paneId)).toMatchObject({
        analysis: { freshness: "current" },
      });
      expect(value.query(`
        SELECT shadow_status, reason, policy_authorization,
          length(summary_digest) AS digest_length
        FROM harness_longitudinal_routing_analyses
      `).get()).toEqual({
        shadow_status: "collectingOperationalEvidence",
        reason: "insufficientOperationalEvidence",
        policy_authorization: "none",
        digest_length: 64,
      });
    } finally {
      value.close();
    }
  });

  test("keeps exact receipt identity and atomically refreshes late token rollups", () => {
    const value = database();
    try {
      seedResultBeforePaneBinding(value);
      value.exec(`
        INSERT INTO harness_actor_pane_bindings VALUES (
          'hpanebinding_longitudinal01', 'hactor_longitudinalroot01',
          'pane_longitudinal01', 'attached'
        );
        INSERT INTO harness_program_runs VALUES ('rlmrun_longitudinal01');
      `);
      const digest = "a".repeat(64);
      value.query(`
        INSERT INTO harness_program_operation_receipts (
          receipt_id, run_id, canonical_node_path, operation,
          request_digest, effect_key, replay_class, state,
          result_value_id, error_json, created_at, updated_at, settled_at,
          semantic_operation
        ) VALUES (
          'receipt_longitudinal01', 'rlmrun_longitudinal01', '[0]',
          'agent.status', ?1, ?1, 'pureRead', 'prepared',
          NULL, NULL, 'now', 'now', NULL, 'routing.inspect'
        )
      `).run(digest);
      expect(() => value.query(`
        INSERT INTO harness_program_operation_receipts (
          receipt_id, run_id, canonical_node_path, operation,
          request_digest, effect_key, replay_class, state,
          result_value_id, error_json, created_at, updated_at, settled_at,
          semantic_operation
        ) VALUES (
          'receipt_longitudinal02', 'rlmrun_longitudinal01', '[1]',
          'agent.result', ?1, ?1, 'pureRead', 'prepared',
          NULL, NULL, 'now', 'now', NULL, 'routing.inspect'
        )
      `).run(digest)).toThrow("invalid semantic operation compatibility pair");

      value.exec(`
        UPDATE harness_actor_turn_attempts
        SET cached_input_tokens = 90, reasoning_output_tokens = 12
        WHERE attempt_id = 'hattempt_longitudinal01'
      `);
      const inspection = new LongitudinalRoutingSQLiteAuthorityV1(value)
        .inspectPane("pane_longitudinal01");
      expect(inspection).toMatchObject({
        evidence: { tokens: {
          cachedInputTokens: { total: 90 },
          uncachedInputTokens: { total: 30 },
          reasoningOutputTokens: { total: 12 },
        } },
        analysis: { freshness: "pending" },
      });
      expect(value.query(`
        SELECT observation_revision, analyzed_revision
        FROM harness_longitudinal_routing_pane_heads
      `).get()).toEqual({ observation_revision: 2, analyzed_revision: 0 });
    } finally {
      value.close();
    }
  });

  test("keeps requested Fast fallback separate from direct Standard work", () => {
    const value = database();
    try {
      seedResultBeforePaneBinding(value);
      value.exec(`
        INSERT INTO harness_actor_pane_bindings VALUES (
          'hpanebinding_longitudinal01', 'hactor_longitudinalroot01',
          'pane_longitudinal01', 'attached'
        );
        INSERT INTO harness_actor_turns VALUES (
          'hturn_longitudinal02', 'hepoch_longitudinal01',
          'hactor_longitudinalroot01'
        );
        INSERT INTO harness_actor_incarnations VALUES (
          'hincarnation_longitudinal02', 'gpt-5.6-sol', 'max'
        );
        INSERT INTO harness_actor_turn_attempts VALUES (
          'hattempt_longitudinal02', 'hincarnation_longitudinal02',
          'standard', 'standard', 100, 60, 25, 8,
          '2030-01-01T00:00:03.000Z', '2030-01-01T00:00:04.000Z',
          'completed'
        );
        INSERT INTO harness_actor_results VALUES (
          'hresult_longitudinal02', 'hepoch_longitudinal01',
          'hactor_longitudinalroot01', 'hattempt_longitudinal02', 'succeeded'
        );
        INSERT INTO harness_actor_turns VALUES (
          'hturn_longitudinal03', 'hepoch_longitudinal01',
          'hactor_longitudinalroot01'
        );
        INSERT INTO harness_actor_incarnations VALUES (
          'hincarnation_longitudinal03', 'gpt-5.6-sol', 'max'
        );
        INSERT INTO harness_actor_turn_attempts VALUES (
          'hattempt_longitudinal03', 'hincarnation_longitudinal03',
          'fast', 'standard', 90, 50, 20, 7,
          '2030-01-01T00:00:05.000Z', '2030-01-01T00:00:06.000Z',
          'completed'
        );
        INSERT INTO harness_actor_results VALUES (
          'hresult_longitudinal03', 'hepoch_longitudinal01',
          'hactor_longitudinalroot01', 'hattempt_longitudinal03', 'succeeded'
        );
      `);

      const inspection = new LongitudinalRoutingSQLiteAuthorityV1(value)
        .inspectPane("pane_longitudinal01");
      expect(inspection).toMatchObject({
        routeArmCount: 3,
        reportedRouteArmCount: 3,
      });
      if (inspection.kind !== "available") {
        throw new Error("expected available routing inspection");
      }
      expect(inspection.routes.map((route) => ({
        requestedTier: route.requestedTier,
        realizedTier: route.realizedTier,
        results: route.results,
      }))).toEqual([
        { requestedTier: "fast", realizedTier: "fast", results: 1 },
        { requestedTier: "fast", realizedTier: "standard", results: 1 },
        { requestedTier: "standard", realizedTier: "standard", results: 1 },
      ]);
    } finally {
      value.close();
    }
  });

  test("keeps a newer dirty revision when an analyzer acknowledges stale evidence", () => {
    const value = database();
    try {
      seedResultBeforePaneBinding(value);
      value.exec(`
        INSERT INTO harness_actor_pane_bindings VALUES (
          'hpanebinding_longitudinal01', 'hactor_longitudinalroot01',
          'pane_longitudinal01', 'attached'
        );
      `);
      const authority = new LongitudinalRoutingSQLiteAuthorityV1(value);
      const staleHead = authority.listDirtyPaneHeads({ limit: 1 })[0]!;
      const staleInspection = authority.inspectPane(staleHead.paneId);

      value.exec(`
        UPDATE harness_actor_turn_attempts
        SET cached_input_tokens = 90
        WHERE attempt_id = 'hattempt_longitudinal01'
      `);

      expect(authority.acknowledgeAnalyzedPane({
        paneId: staleHead.paneId,
        expectedObservationRevision: staleHead.observationRevision,
        inspection: staleInspection,
      })).toBeFalse();
      expect(authority.listDirtyPaneHeads({ limit: 1 })).toEqual([{
        paneId: "pane_longitudinal01",
        observationRevision: 2,
      }]);
    } finally {
      value.close();
    }
  });

  test("recovers materialized state after reopen and uses bounded indexes", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-routing-memory-"));
    const path = join(root, "state.sqlite");
    let value = database(path);
    try {
      seedResultBeforePaneBinding(value);
      value.exec(`
        INSERT INTO harness_actor_pane_bindings VALUES (
          'hpanebinding_longitudinal01', 'hactor_longitudinalroot01',
          'pane_longitudinal01', 'attached'
        );
      `);
      value.close();
      value = new Database(path, { strict: true });
      value.exec("PRAGMA foreign_keys = ON");

      const authority = new LongitudinalRoutingSQLiteAuthorityV1(value);
      expect(authority.inspectPane("pane_longitudinal01")).toMatchObject({
        kind: "available",
        evidence: { results: 1 },
        analysis: { freshness: "pending" },
      });
      expect(authority.listDirtyPaneHeads({ limit: 1 })).toHaveLength(1);

      const dirtyPlan = value.query<{ detail: string }, []>(`
        EXPLAIN QUERY PLAN
        SELECT pane_id, observation_revision
        FROM harness_longitudinal_routing_pane_heads
        WHERE analyzed_revision < observation_revision
          AND pane_id > 'pane_cursor000000001'
        ORDER BY pane_id
        LIMIT 1
      `).all().map(({ detail }) => detail).join("\n");
      expect(dirtyPlan).toContain(
        "harness_longitudinal_routing_dirty_heads_idx",
      );

      const armPlan = value.query<{ detail: string }, [string]>(`
        EXPLAIN QUERY PLAN
        SELECT policy_version, work_class, routed_profile,
          realized_service_tier, result_count
        FROM harness_longitudinal_routing_arm_stats
        WHERE pane_id = ?1
      `).all("pane_longitudinal01")
        .map(({ detail }) => detail).join("\n");
      expect(armPlan).toContain(
        "sqlite_autoindex_harness_longitudinal_routing_arm_stats_1",
      );
    } finally {
      value.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reads dirty panes by a wrapping pane-id keyset", () => {
    const value = database();
    try {
      value.exec(`
        INSERT INTO chat_panes VALUES ('pane_keyset000000001');
        INSERT INTO chat_panes VALUES ('pane_keyset000000002');
        INSERT INTO chat_panes VALUES ('pane_keyset000000003');
        INSERT INTO harness_longitudinal_routing_pane_heads VALUES (
          'pane_keyset000000001', 2, 0, 0
        );
        INSERT INTO harness_longitudinal_routing_pane_heads VALUES (
          'pane_keyset000000002', 3, 1, 0
        );
        INSERT INTO harness_longitudinal_routing_pane_heads VALUES (
          'pane_keyset000000003', 4, 2, 0
        );
      `);
      const authority = new LongitudinalRoutingSQLiteAuthorityV1(value);
      expect(authority.listDirtyPaneHeads({
        limit: 1,
        afterPaneId: "pane_keyset000000001",
      })).toEqual([{
        paneId: "pane_keyset000000002",
        observationRevision: 3,
      }]);
      expect(authority.listDirtyPaneHeads({
        limit: 1,
        afterPaneId: "pane_keyset000000003",
      })).toEqual([{
        paneId: "pane_keyset000000001",
        observationRevision: 2,
      }]);
    } finally {
      value.close();
    }
  });
});
