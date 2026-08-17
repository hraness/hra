import { expect, test } from "bun:test";

import {
  confirmed,
  createAttemptId,
  type CodexAppClient,
  type CodexIntent,
} from "./client";
import {
  defineOperation,
  defineOperationRegistry,
  type ReconciliationOperationName,
} from "./operations";
import type {
  MutationAttemptDefinition,
  MutationAttemptSettlement,
} from "./persistence";

const operations = defineOperationRegistry({
  alpha: defineOperation<Readonly<{ alpha: string }>, void>({
    effect: "read",
    lostResponse: "safe-to-retry",
    timeoutMs: 1_000,
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  beta: defineOperation<Readonly<{ beta: number }>, void>({
    effect: "read",
    lostResponse: "safe-to-retry",
    timeoutMs: 1_000,
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  gamma: defineOperation<
    Readonly<{ gamma: boolean }>,
    Readonly<{ gammaResult: string }>
  >({
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    timeoutMs: 1_000,
    concurrency: "global",
    reconciliation: {
      kind: "manual",
      strategy: "operator-review",
    },
  }),
  delta: defineOperation<Readonly<{ delta: string }>, void>({
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    timeoutMs: 1_000,
    concurrency: "global",
    reconciliation: {
      kind: "unsupported",
      strategy: "provider-has-no-lookup",
    },
  }),
});

type Intent = CodexIntent<typeof operations, "alpha" | "beta">;
type AttemptDefinitions =
  | MutationAttemptDefinition<
      "alpha",
      Readonly<{ alphaId: string }>,
      Readonly<{ alphaResult: string }>
    >
  | MutationAttemptDefinition<
      "beta",
      Readonly<{ betaId: string }>,
      Readonly<{ betaResult: number }>
    >;

function acceptIntent(intent: Intent): Intent {
  return intent;
}

function acceptSettlement(
  settlement: MutationAttemptSettlement<AttemptDefinitions>,
): MutationAttemptSettlement<AttemptDefinitions> {
  return settlement;
}

function acceptReconciliationOperation(
  operation: ReconciliationOperationName<typeof operations>,
): string {
  return operation;
}

function verifyClientReconciliationTypes(
  client: CodexAppClient<Readonly<Record<never, never>>, typeof operations>,
): void {
  const attemptId = createAttemptId("attempt-reconcile-types");
  void client.reconcile({ operation: "gamma", attemptId });

  // @ts-expect-error Reads cannot require reconciliation.
  void client.reconcile({ operation: "alpha", attemptId });

  // @ts-expect-error Unsupported reconciliation has no callable driver path.
  void client.reconcile({ operation: "delta", attemptId });
}

test("keeps each operation name correlated with its input", () => {
  const attemptId = createAttemptId("attempt-type-correlation");
  acceptIntent({ type: "alpha", attemptId, input: { alpha: "a" } });
  acceptIntent({ type: "beta", attemptId, input: { beta: 1 } });

  // @ts-expect-error A union name must not decouple an operation from its input.
  acceptIntent({ type: "alpha", attemptId, input: { beta: 1 } });

  expect(String(attemptId)).toBe("attempt-type-correlation");
  expect(Object.keys(operations)).toEqual([
    "alpha",
    "beta",
    "gamma",
    "delta",
  ]);
});

test("exposes reconciliation only for operations with a callable strategy", () => {
  expect(acceptReconciliationOperation("gamma")).toBe("gamma");

  // @ts-expect-error A read cannot enter the reconciliation operation set.
  acceptReconciliationOperation("alpha");

  // @ts-expect-error Unsupported reconciliation is deliberately not callable.
  acceptReconciliationOperation("delta");

  expect(typeof verifyClientReconciliationTypes).toBe("function");
});

test("keeps journal operations correlated with resolution values", () => {
  const attemptId = createAttemptId("attempt-settlement-correlation");
  acceptSettlement({
    operation: "alpha",
    attemptId,
    expectedRevision: 2,
    outcome: confirmed(attemptId, { alphaResult: "done" }),
    settledAtMs: 3,
  });

  // @ts-expect-error An alpha settlement cannot store beta's resolution.
  acceptSettlement({
    operation: "alpha",
    attemptId,
    expectedRevision: 2,
    outcome: confirmed(attemptId, { betaResult: 1 }),
    settledAtMs: 3,
  });

  expect(String(attemptId)).toBe("attempt-settlement-correlation");
});
