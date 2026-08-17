import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  DevelopmentReloadAdmission,
  hasAuthoritativeDevelopmentReloadWork,
  hostDevelopmentReloadDecision,
  hostDevelopmentReloadPayloadSchema,
  parseRuntimeBridgeProfile,
} from "../src/development-reload";

const candidateId = "a".repeat(64);

function authorityFixture(): Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE chat_panes (
      pane_id TEXT,
      state TEXT,
      turn_status TEXT,
      workspace_state TEXT
    );
    CREATE TABLE local_task_runs (run_id TEXT, phase TEXT);
    CREATE TABLE dispatch_bindings (run_id TEXT, stage TEXT);
    CREATE TABLE local_promotion_sessions (promotion_id TEXT, state TEXT);
    CREATE TABLE session_sync_operation_journal (operation_id TEXT, state TEXT);
    CREATE TABLE local_renderer_mutation_attempts (attempt_id TEXT, state TEXT);
    CREATE TABLE operation_receipts (operation_id TEXT, state TEXT);
    CREATE TABLE human_organization_operations (operation_id TEXT, state TEXT);
    CREATE TABLE cloud_human_operation_receipts (operation_id TEXT, state TEXT);
    CREATE TABLE harness_actor_turns (turn_id TEXT, state TEXT);
    CREATE TABLE harness_actor_operations (operation_id TEXT, state TEXT);
    CREATE TABLE harness_actor_incarnations (incarnation_id TEXT, state TEXT);
    CREATE TABLE harness_actor_turn_attempts (attempt_id TEXT, state TEXT);
    CREATE TABLE harness_program_runs (run_id TEXT, state TEXT);
    CREATE TABLE harness_program_operation_receipts (receipt_id TEXT, state TEXT);
    CREATE TABLE harness_context_values (value_id TEXT, state TEXT);
    CREATE TABLE harness_actor_continuation_intents (intent_id TEXT, state TEXT);
  `);
  return database;
}

describe("development reload protocol", () => {
  test("accepts only the exact candidate-bound payload", () => {
    expect(hostDevelopmentReloadPayloadSchema.parse({
      version: 1,
      mode: "developmentReload",
      candidateId,
    })).toEqual({ version: 1, mode: "developmentReload", candidateId });
    expect(() => hostDevelopmentReloadPayloadSchema.parse({
      version: 1,
      mode: "developmentReload",
      candidateId: candidateId.toUpperCase(),
    })).toThrow();
    expect(() => hostDevelopmentReloadPayloadSchema.parse({
      version: 1,
      mode: "developmentReload",
      candidateId,
      forceIfRunning: true,
    })).toThrow();
  });

  test("echoes the candidate in a strict private decision", () => {
    const payload = hostDevelopmentReloadPayloadSchema.parse({
      version: 1,
      mode: "developmentReload",
      candidateId,
    });
    expect(hostDevelopmentReloadDecision(payload, "accepted")).toEqual({
      kind: "developmentReloadDecision",
      version: 1,
      status: "accepted",
      candidateId,
    });
  });

  test("recognizes only an explicit runtime bridge profile", () => {
    expect(parseRuntimeBridgeProfile({ HRA_RUNTIME_BRIDGE_PROFILE: "development" }))
      .toBe("development");
    expect(parseRuntimeBridgeProfile({ HRA_RUNTIME_BRIDGE_PROFILE: "automation" }))
      .toBe("automation");
    expect(parseRuntimeBridgeProfile({})).toBeNull();
  });
});

describe("development reload admission", () => {
  test("seals once only when every authoritative lane is idle", () => {
    const database = authorityFixture();
    const admission = new DevelopmentReloadAdmission();
    expect(admission.trySeal({
      gatewayReady: true,
      ordinaryRequestsInFlight: 0,
      database,
    })).toBe("accepted");
    expect(admission.sealed).toBe(true);
    expect(admission.trySeal({
      gatewayReady: true,
      ordinaryRequestsInFlight: 0,
      database,
    })).toBe("busy");
    database.close();
  });

  test("busy probes have no lasting admission effect", () => {
    const database = authorityFixture();
    database.exec(
      "INSERT INTO harness_actor_operations VALUES ('operation', 'effectStarted')",
    );
    const admission = new DevelopmentReloadAdmission();
    expect(admission.trySeal({
      gatewayReady: true,
      ordinaryRequestsInFlight: 0,
      database,
    })).toBe("busy");
    expect(admission.sealed).toBe(false);
    database.exec("DELETE FROM harness_actor_operations");
    expect(admission.trySeal({
      gatewayReady: true,
      ordinaryRequestsInFlight: 0,
      database,
    })).toBe("accepted");
    database.close();
  });

  test("every live task, actor, and effect family fails closed", () => {
    const fixtures = [
      ["chat_panes", "'pane', 'streaming', 'streaming', 'ready'"],
      ["chat_panes", "'workspace', 'ready', 'idle', 'preparing'"],
      ["chat_panes", "'capacity', 'ready', 'idle', 'waiting_capacity'"],
      ["local_task_runs", "'run', 'running'"],
      ["dispatch_bindings", "'dispatch', 'turn_starting'"],
      ["local_promotion_sessions", "'promotion', 'uploading'"],
      ["session_sync_operation_journal", "'sync', 'dispatched'"],
      ["local_renderer_mutation_attempts", "'attempt', 'prepared'"],
      ["operation_receipts", "'operation', 'started'"],
      ["human_organization_operations", "'human', 'started'"],
      ["cloud_human_operation_receipts", "'cloud', 'started'"],
      ["harness_actor_turns", "'turn', 'reconciling'"],
      ["harness_actor_operations", "'actor-operation', 'effectStarted'"],
      ["harness_actor_incarnations", "'incarnation', 'running'"],
      ["harness_actor_turn_attempts", "'turn-attempt', 'starting'"],
      ["harness_program_runs", "'program', 'running'"],
      ["harness_program_operation_receipts", "'receipt', 'replayRequired'"],
      ["harness_context_values", "'value', 'effectStarted'"],
      [
        "harness_actor_continuation_intents",
        "'continuation', 'continueDispatchEffectStarted'",
      ],
    ] as const;
    for (const [table, values] of fixtures) {
      const database = authorityFixture();
      database.exec(`INSERT INTO ${table} VALUES (${values})`);
      expect(hasAuthoritativeDevelopmentReloadWork(database)).toBe(true);
      database.close();
    }
  });

  test("terminal history and idle actors permit a clean generation", () => {
    const database = authorityFixture();
    database.exec(`
      INSERT INTO chat_panes VALUES ('pane', 'ready', 'completed', 'ready');
      INSERT INTO local_task_runs VALUES ('run', 'submitted');
      INSERT INTO dispatch_bindings VALUES ('dispatch', 'completed');
      INSERT INTO local_promotion_sessions VALUES ('promotion', 'activated');
      INSERT INTO session_sync_operation_journal VALUES ('sync', 'terminal');
      INSERT INTO harness_actor_operations VALUES ('operation', 'ambiguous');
      INSERT INTO harness_actor_incarnations VALUES ('incarnation', 'idle');
      INSERT INTO harness_program_runs VALUES ('program', 'suspended');
      INSERT INTO harness_actor_continuation_intents VALUES ('intent', 'ambiguous');
    `);
    expect(hasAuthoritativeDevelopmentReloadWork(database)).toBe(false);
    database.close();
  });
});
