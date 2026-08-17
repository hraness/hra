import { describe, expect, test } from "bun:test";

import { confirmed } from "../client";
import {
  createMutationFingerprint,
  type MutationAttemptDefinition,
} from "../persistence";
import {
  attemptIdFixture,
  createDeterministicNumberSource,
} from "./fixtures";
import {
  createMemoryBindingStore,
  createMemoryGenerationStore,
  createMemoryMutationAttemptJournal,
} from "./memory-persistence";

describe("memory persistence properties", () => {
  test("only the exact current binding revision can commit", async () => {
    const numbers = createDeterministicNumberSource(0xca5);
    const store = createMemoryBindingStore<number>();
    let revision: number | null = null;
    let value: number | null = null;

    for (let run = 0; run < 500; run += 1) {
      const nextValue = numbers.nextInteger(0, 1_000_000);
      const staleRevision =
        revision === null ? 1 : revision + 1;
      const stale = await store.set("binding", nextValue, staleRevision);
      expect(stale.status).toBe("conflict");

      const applied = await store.set("binding", nextValue, revision);
      expect(applied.status).toBe("applied");
      if (applied.status !== "applied" || applied.current === null) {
        throw new Error("expected binding write to apply");
      }
      revision = applied.current.revision;
      value = nextValue;
      expect(await store.get("binding")).toEqual({
        revision,
        state: "present",
        value,
      });
    }
  });

  test("generation reservations are unique and above every caller floor", async () => {
    const numbers = createDeterministicNumberSource(0x6e);
    const store = createMemoryGenerationStore();
    const reserved = new Set<number>();

    for (let run = 0; run < 1_000; run += 1) {
      const floor = numbers.nextInteger(0, 10_000);
      const generation = await store.reserve("source", floor);
      expect(generation).toBeGreaterThan(floor);
      expect(reserved.has(generation)).toBe(false);
      reserved.add(generation);
    }
  });

  test("every recovered effect-started attempt is nonterminal and unique", async () => {
    const journal = createMemoryMutationAttemptJournal<
      MutationAttemptDefinition<
        "message.send",
        Readonly<{ fingerprint: string }>,
        Readonly<{ sequence: number }>
      >
    >();
    const attemptCount = 200;

    for (let index = 0; index < attemptCount; index += 1) {
      const attemptId = attemptIdFixture(index);
      const prepared = await journal.prepare({
        attemptId,
        fingerprint: createMutationFingerprint(
          `sha256:attempt-${String(index)}`,
        ),
        operation: "message.send",
        sourceId: index % 2 === 0 ? "source-even" : "source-odd",
        preparedAtMs: attemptCount - index,
        recovery: { fingerprint: `fingerprint-${String(index)}` },
      });
      if (prepared.status !== "created") {
        throw new Error("attempt IDs must be unique");
      }
      if (index % 3 === 0) {
        const started = await journal.markEffectStarted(
          attemptId,
          prepared.record.revision,
          attemptCount + index,
        );
        if (started.status !== "applied") {
          throw new Error("effect transition must apply");
        }
        if (index % 2 === 0) {
          const settled = await journal.settle({
            operation: "message.send",
            attemptId,
            expectedRevision: started.record.revision,
            outcome: confirmed(attemptId, { sequence: index }),
            settledAtMs: attemptCount * 2 + index,
          });
          expect(settled.status).toBe("applied");
        }
      }
    }

    const open = (
      await journal.listOpen({
        sourceId: null,
        after: null,
        limit: 1_000,
      })
    ).attempts;
    const identifiers = open.map((record) => record.attemptId);
    const states: readonly string[] = open.map((record) => record.state);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(states).not.toContain("settled");
    expect(
      open.every((record, index) => {
        const previous = open[index - 1];
        return (
          previous === undefined ||
          previous.preparedAtMs < record.preparedAtMs ||
          (
            previous.preparedAtMs === record.preparedAtMs &&
            previous.attemptId <= record.attemptId
          )
        );
      }),
    ).toBe(true);
  });
});
