import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  actorEffectKey,
  actorBudgetSchema,
  actorEpochSchema,
  actorOperationReceiptId,
  actorResultSchema,
  actorSchema,
  actorTurnSchema,
  assertNextActorResult,
  deriveChildBudget,
  HARNESS_MIN_CONTEXT_BYTES,
  requestActorTurnStop,
  selectWaitAnyResult,
  transitionActor,
  transitionActorTurn,
} from "../src/harness/actor-domain";

const createdAt = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const deadline = "2030-01-02T00:00:00.000Z";

const budget = Object.freeze({
  maxDepth: 3,
  maxActiveDescendants: 8,
  maxDurableDescendants: 50,
  tokenBudget: 100_000,
  byteBudget: 16 * 1024 * 1024,
  deadline,
  laneAuthority: "managedWrite" as const,
});

const epoch = actorEpochSchema.parse({
  id: "hepoch_000000001",
  projectId: "project-1",
  sourceSha: "a".repeat(40),
  rootActorId: "hactor_000000001",
  budget,
  tokenReserved: 0,
  byteReserved: 0,
  nextRootCompletionSequence: 1,
  state: "active",
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  stoppedAt: null,
});

const actor = actorSchema.parse({
  id: epoch.rootActorId,
  epochId: epoch.id,
  parentActorId: null,
  depth: 0,
  title: "Root",
  state: "active",
  budget,
  tokenReserved: 0,
  byteReserved: 0,
  nextTurnOrdinal: 1,
  nextResultOrdinal: 1,
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  stoppedAt: null,
});

const turn = actorTurnSchema.parse({
  id: "hturn_000000001",
  epochId: epoch.id,
  actorId: actor.id,
  ordinal: 1,
  idempotencyKey: "turn-idempotency-0001", // gitleaks:allow - deterministic test vector
  inputValueId: "hvalue_000000001",
  state: "prepared",
  desiredState: "run",
  revision: 1,
  createdAt,
  startedAt: null,
  settledAt: null,
  outcomeCode: null,
});

describe("persistent recursive actor domain", () => {
  test("a child can only narrow every inherited authority dimension", () => {
    const child = deriveChildBudget(actor, {
      ...budget,
      tokenBudget: 50_000,
      byteBudget: 4 * 1024 * 1024,
      laneAuthority: "readOnlySnapshot",
    });
    expect(child.tokenBudget).toBe(50_000);
    expect(child.byteBudget).toBe(4 * 1024 * 1024);
    expect(child.laneAuthority).toBe("readOnlySnapshot");

    expect(() => deriveChildBudget(actor, {
      ...budget,
      tokenBudget: budget.tokenBudget + 1,
    })).toThrow("cannot widen");
    expect(() => deriveChildBudget({
      ...actor,
      budget: { ...budget, laneAuthority: "readOnlySnapshot" },
    }, budget)).toThrow("cannot widen");
  });

  test("completed turns do not terminalize their actor", () => {
    const starting = transitionActorTurn(turn, "starting", later);
    const running = transitionActorTurn(
      starting,
      "running",
      "2030-01-01T00:00:02.000Z",
    );
    const completed = transitionActorTurn(
      running,
      "succeeded",
      "2030-01-01T00:00:03.000Z",
      "completed",
    );
    expect(completed.state).toBe("succeeded");
    expect(actor.state).toBe("active");
    expect(transitionActor(actor, "stopRequested", later).state)
      .toBe("stopRequested");
  });

  test("stop intent is persistent and idempotent without inventing completion", () => {
    const requested = requestActorTurnStop(turn);
    expect(requested.desiredState).toBe("stop");
    expect(requestActorTurnStop(requested)).toEqual(requested);
    expect(requested.state).toBe("prepared");
  });

  test("result allocation proves lineage and both durable orderings", () => {
    const attempt = {
      id: "hattempt_000000001",
      turnId: turn.id,
      incarnationId: "hincarnation_000000001",
      ordinal: 1,
      accountProfileId: "profile_000000001",
      processGeneration: 9,
      clientUserMessageId: "client-message-00000001",
      state: "completed" as const,
      quotaProofDigest: null,
      createdAt,
      startedAt: later,
      settledAt: "2030-01-01T00:00:03.000Z",
    };
    const result = actorResultSchema.parse({
      id: "hresult_000000001",
      epochId: epoch.id,
      actorId: actor.id,
      turnId: turn.id,
      terminalAttemptId: attempt.id,
      outcome: "succeeded",
      valueId: "hvalue_result00001",
      actorResultOrdinal: 1,
      rootCompletionSequence: 1,
      createdAt: "2030-01-01T00:00:04.000Z",
    });
    expect(() => assertNextActorResult({
      actor,
      epoch,
      turn,
      attempt,
      result,
    })).not.toThrow();
    expect(() => assertNextActorResult({
      actor,
      epoch,
      turn,
      attempt,
      result: { ...result, rootCompletionSequence: 2 },
    })).toThrow("ordering");
  });

  test("thread-admission quota exhaustion settles without inventing a provider-turn attempt", () => {
    const result = actorResultSchema.parse({
      id: "hresult_000000009",
      epochId: epoch.id,
      actorId: actor.id,
      turnId: turn.id,
      terminalAttemptId: null,
      outcome: "quotaRejected",
      valueId: null,
      actorResultOrdinal: 1,
      rootCompletionSequence: 1,
      createdAt: later,
    });
    expect(() => assertNextActorResult({
      actor,
      epoch,
      turn,
      attempt: null,
      result,
    })).not.toThrow();
    expect(actorResultSchema.safeParse({
      ...result,
      outcome: "failed",
    }).success).toBeFalse();
    expect(actorResultSchema.safeParse({
      ...result,
      outcome: "succeeded",
      valueId: "hvalue_result00009",
    }).success).toBeFalse();
  });

  test("waitAny observes root completion order rather than input order", () => {
    const make = (id: string, actorId: string, sequence: number) =>
      actorResultSchema.parse({
        id,
        epochId: epoch.id,
        actorId,
        turnId: `hturn_${actorId.slice(7)}x`,
        terminalAttemptId: `hattempt_${actorId.slice(7)}x`,
        outcome: "failed",
        valueId: null,
        actorResultOrdinal: 1,
        rootCompletionSequence: sequence,
        createdAt,
      });
    const second = make("hresult_000000002", "hactor_000000002", 2);
    const first = make("hresult_000000003", "hactor_000000003", 1);
    expect(selectWaitAnyResult([second, first])?.id).toBe(first.id);
  });

  test("operation and effect identities exclude process generation", () => {
    const receipt = actorOperationReceiptId({
      runId: "hrun_000000001",
      immutableProgramDigest: "b".repeat(64),
      nodePath: [["step", 0], ["parallel", 2]],
    });
    expect(receipt).toBe(actorOperationReceiptId({
      runId: "hrun_000000001",
      immutableProgramDigest: "b".repeat(64),
      nodePath: [["step", 0], ["parallel", 2]],
    }));
    const effect = actorEffectKey({
      receiptId: receipt,
      operation: "agent.spawn",
      requestDigest: "c".repeat(64),
      effectSubtype: "actor.start",
    });
    expect(effect).toHaveLength(64);
    expect(effect).not.toBe(actorEffectKey({
      receiptId: receipt,
      operation: "agent.spawn",
      requestDigest: "d".repeat(64),
      effectSubtype: "actor.start",
    }));
  });
});

test("actor parsers are total for arbitrary foreign values", () => {
  assertProperty(fc.property(fc.anything(), (value) => {
    expect(() => actorEpochSchema.safeParse(value)).not.toThrow();
    expect(() => actorSchema.safeParse(value)).not.toThrow();
    expect(() => actorTurnSchema.safeParse(value)).not.toThrow();
    expect(() => actorResultSchema.safeParse(value)).not.toThrow();
  }));
});

test("derived child authority is monotone for every valid random request", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: budget.tokenBudget }),
    fc.integer({
      min: 1,
      max: budget.byteBudget / HARNESS_MIN_CONTEXT_BYTES,
    }),
    fc.integer({ min: 1, max: budget.maxActiveDescendants }),
    fc.integer({ min: 1, max: budget.maxDurableDescendants }),
    (tokens, byteMib, active, durable) => {
      const bytes = byteMib * HARNESS_MIN_CONTEXT_BYTES;
      const child = deriveChildBudget(actor, {
        ...budget,
        tokenBudget: tokens,
        byteBudget: bytes,
        maxActiveDescendants: active,
        maxDurableDescendants: durable,
      });
      expect(child.tokenBudget).toBeLessThanOrEqual(actor.budget.tokenBudget);
      expect(child.byteBudget).toBeLessThanOrEqual(actor.budget.byteBudget);
      expect(child.maxActiveDescendants)
        .toBeLessThanOrEqual(actor.budget.maxActiveDescendants);
      expect(child.maxDurableDescendants)
        .toBeLessThanOrEqual(actor.budget.maxDurableDescendants);
    },
  ));
});

test("rejects byte budgets that the encrypted context quota cannot represent", () => {
  for (const byteBudget of [
    1,
    HARNESS_MIN_CONTEXT_BYTES - 1,
    HARNESS_MIN_CONTEXT_BYTES + 1,
  ]) {
    expect(actorBudgetSchema.safeParse({ ...budget, byteBudget }).success)
      .toBeFalse();
  }
  expect(actorBudgetSchema.safeParse({
    ...budget,
    byteBudget: HARNESS_MIN_CONTEXT_BYTES,
  }).success).toBeTrue();
});
