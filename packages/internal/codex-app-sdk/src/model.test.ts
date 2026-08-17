import { describe, expect, test } from "bun:test";

import {
  compareSourceCoordinates,
  createSourceCoordinate,
  isSourceCoordinateCurrent,
} from "./coordinates";
import {
  defineOperation,
  defineOperationRegistry,
  type OperationInput,
  type OperationOutput,
  type OperationSemantics,
} from "./operations";

describe("source coordinates", () => {
  test("orders facts within one source by generation, sequence, and index", () => {
    const floor = createSourceCoordinate({
      sourceId: "source-a",
      generation: 2,
      sequence: 4,
      index: 1,
    });
    const next = createSourceCoordinate({
      sourceId: "source-a",
      generation: 2,
      sequence: 4,
      index: 2,
    });

    expect(compareSourceCoordinates(floor, next)).toBe("before");
    expect(compareSourceCoordinates(next, floor)).toBe("after");
    expect(isSourceCoordinateCurrent(next, floor)).toBe(true);
    expect(
      compareSourceCoordinates(
        floor,
        createSourceCoordinate({ ...floor, sourceId: "source-b" }),
      ),
    ).toBe("different-source");
  });

  test("rejects malformed source coordinates", () => {
    expect(() =>
      createSourceCoordinate({
        sourceId: " source",
        generation: 1,
        sequence: 0,
        index: 0,
      }),
    ).toThrow();
    expect(() =>
      createSourceCoordinate({
        sourceId: "source",
        generation: -1,
        sequence: 0,
        index: 0,
      }),
    ).toThrow();
  });
});

describe("operation registry", () => {
  test("derives names while preserving input and output types", () => {
    type Input = Readonly<{ threadId: string; text: string }>;
    type Output = Readonly<{ turnId: string }>;
    const registry = defineOperationRegistry({
      sendMessage: defineOperation<Input, Output>({
        effect: "non-idempotent-mutation",
        lostResponse: "ambiguous",
        timeoutMs: 30_000,
        concurrency: "per-thread",
        reconciliation: {
          kind: "automatic",
          strategy: "client-message-id",
        },
      }),
      listThreads: defineOperation<void, readonly string[]>({
        effect: "read",
        lostResponse: "safe-to-retry",
        timeoutMs: 15_000,
        concurrency: "parallel",
        reconciliation: "not-required",
      }),
    });
    const input: OperationInput<typeof registry.sendMessage> = {
      threadId: "thread-1",
      text: "hello",
    };
    const output: OperationOutput<typeof registry.sendMessage> = {
      turnId: "turn-1",
    };

    expect(input.text).toBe("hello");
    expect(output.turnId).toBe("turn-1");
    expect(registry.sendMessage.name).toBe("sendMessage");
    expect(registry.sendMessage.semantics.timeoutMs).toBe(30_000);
    expect(registry.sendMessage.semantics.concurrency).toBe("per-thread");
    expect(registry.sendMessage.semantics.lostResponse).toBe("ambiguous");
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.sendMessage)).toBe(true);
    if (
      registry.sendMessage.semantics.effect ===
      "non-idempotent-mutation"
    ) {
      expect(
        Object.isFrozen(registry.sendMessage.semantics.reconciliation),
      ).toBe(true);
      expect(
        registry.sendMessage.semantics.reconciliation.strategy,
      ).toBe("client-message-id");
    }
  });

  test("fails closed for contradictory JavaScript input", () => {
    const invalid = {
      effect: "non-idempotent-mutation",
      lostResponse: "safe-to-retry",
      timeoutMs: 30_000,
      concurrency: "parallel",
      reconciliation: "not-required",
    } as unknown as OperationSemantics;

    expect(() => defineOperation<never, never>(invalid)).toThrow(
      "non-idempotent operations",
    );
  });

  test("rejects timeouts outside the portable operation bound", () => {
    const invalid = {
      effect: "read",
      lostResponse: "safe-to-retry",
      timeoutMs: 0,
      concurrency: "parallel",
      reconciliation: "not-required",
    } as unknown as OperationSemantics;

    expect(() => defineOperation<never, never>(invalid)).toThrow(
      "operation timeout",
    );
  });
});
