import { describe, expect, test } from "bun:test";

import {
  cancelled,
  confirmed,
  createAttemptId,
  rejected,
} from "../client";
import {
  reserveMonotonicGeneration,
} from "../lifecycle";
import {
  createMutationFingerprint,
  type MutationAttemptDefinition,
} from "../persistence";
import {
  attemptIdFixture,
  sourceCoordinateFixture,
} from "./fixtures";
import {
  createMemoryBindingStore,
  createMemoryChangeFeed,
  createMemoryGenerationStore,
  createMemoryMutationAttemptJournal,
  createMemoryProjectionCheckpointStore,
} from "./memory-persistence";

type MessageAttempt<Recovery, Resolution> = MutationAttemptDefinition<
  "message.send",
  Recovery,
  Resolution
>;

describe("memory binding and checkpoint stores", () => {
  test("uses revisions and tombstones to prevent stale ABA writes", async () => {
    const store = createMemoryBindingStore<Readonly<{ providerId: string }>>();
    const created = await store.set(
      "thread-1",
      { providerId: "provider-1" },
      null,
    );
    expect(created.status).toBe("applied");
    if (created.status !== "applied" || created.current === null) {
      throw new Error("binding was not created");
    }

    const deleted = await store.delete(
      "thread-1",
      created.current.revision,
    );
    expect(deleted).toEqual({
      status: "applied",
      current: { revision: 2, state: "deleted" },
    });
    expect(
      await store.set(
        "thread-1",
        { providerId: "stale-writer" },
        created.current.revision,
      ),
    ).toEqual({
      status: "conflict",
      current: { revision: 2, state: "deleted" },
    });
    expect(
      await store.set(
        "thread-1",
        { providerId: "provider-2" },
        2,
      ),
    ).toEqual({
      status: "applied",
      current: {
        revision: 3,
        state: "present",
        value: { providerId: "provider-2" },
      },
    });
  });

  test("stores an explicitly versioned projection envelope", async () => {
    const store = createMemoryProjectionCheckpointStore<
      Readonly<{ threadCount: number }>
    >();
    const checkpoint = {
      schema: { name: "thread-list", version: 2 },
      contentPolicy: "browser-safe-v1",
      source: sourceCoordinateFixture({ sequence: 8 }),
      createdAtMs: 100,
      projection: { threadCount: 3 },
    } as const;

    const result = await store.set("workspace-1", checkpoint, null);

    expect(result.status).toBe("applied");
    expect(await store.get("workspace-1")).toEqual({
      revision: 1,
      state: "present",
      value: checkpoint,
    });
  });

  test("distinguishes a present null value from a deleted slot", async () => {
    const store = createMemoryBindingStore<null>();
    expect(await store.set("nullable", null, null)).toEqual({
      status: "applied",
      current: { revision: 1, state: "present", value: null },
    });
    expect(await store.delete("nullable", 1)).toEqual({
      status: "applied",
      current: { revision: 2, state: "deleted" },
    });
  });
});

describe("memory mutation attempt journal", () => {
  test("requires prepare before effect and enforces terminal transitions", async () => {
    const journal = createMemoryMutationAttemptJournal<
      MessageAttempt<
        Readonly<{ threadId: string }>,
        Readonly<{ turnId: string }>
      >
    >();
    const attemptId = attemptIdFixture(1);
    const created = await journal.prepare({
      attemptId,
      fingerprint: createMutationFingerprint("sha256:attempt-1"),
      operation: "message.send",
      sourceId: "source-1",
      preparedAtMs: 10,
      recovery: { threadId: "thread-1" },
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      throw new Error("attempt was not created");
    }

    expect(
      (
        await journal.settle({
          operation: "message.send",
          attemptId,
          expectedRevision: created.record.revision,
          outcome: confirmed(attemptId, { turnId: "turn-1" }),
          settledAtMs: 11,
        })
      ).status,
    ).toBe("invalid-transition");

    const started = await journal.markEffectStarted(
      attemptId,
      created.record.revision,
      12,
    );
    expect(started.status).toBe("applied");
    if (started.status !== "applied") {
      throw new Error("effect boundary was not recorded");
    }

    const settled = await journal.settle({
      operation: "message.send",
      attemptId,
      expectedRevision: started.record.revision,
      outcome: cancelled(attemptId, "caller"),
      settledAtMs: 13,
    });
    expect(settled.status).toBe("applied");
    expect(
      (
        await journal.listOpen({
          sourceId: null,
          after: null,
          limit: 10,
        })
      ).attempts,
    ).toEqual([]);
    if (settled.status !== "applied") {
      throw new Error("attempt was not settled");
    }
    expect(
      (
        await journal.settle({
          operation: "message.send",
          attemptId,
          expectedRevision: settled.record.revision,
          outcome: confirmed(attemptId, { turnId: "turn-1" }),
          settledAtMs: 14,
        })
      ).status,
    ).toBe("invalid-transition");
  });

  test("allows a prepared attempt to settle only before effect", async () => {
    const journal = createMemoryMutationAttemptJournal<
      MessageAttempt<Readonly<{ fingerprint: string }>, never>
    >();
    const attemptId = attemptIdFixture(2);
    const created = await journal.prepare({
      attemptId,
      fingerprint: createMutationFingerprint("sha256:attempt-2"),
      operation: "message.send",
      sourceId: "source-1",
      preparedAtMs: 20,
      recovery: { fingerprint: "safe-fingerprint" },
    });
    if (created.status !== "created") {
      throw new Error("attempt was not created");
    }

    const noEffectOutcome = rejected(attemptId, {
      code: "validation_failed",
      message: "Input was rejected before provider invocation.",
      retryable: false,
    });
    expect(noEffectOutcome.error.metadata).toEqual({});
    const settled = await journal.settle({
      operation: "message.send",
      attemptId,
      expectedRevision: created.record.revision,
      outcome: noEffectOutcome,
      settledAtMs: 21,
    });

    expect(settled.status).toBe("applied");
    expect((await journal.get(attemptId))?.state).toBe("settled");
  });

  test("rejects timestamps that move a durable attempt backwards", async () => {
    const journal = createMemoryMutationAttemptJournal<
      MessageAttempt<Readonly<{ fingerprint: string }>, never>
    >();
    const attemptId = attemptIdFixture(3);
    const created = await journal.prepare({
      attemptId,
      fingerprint: createMutationFingerprint("sha256:attempt-3"),
      operation: "message.send",
      sourceId: "source-1",
      preparedAtMs: 30,
      recovery: { fingerprint: "safe-fingerprint" },
    });
    if (created.status !== "created") {
      throw new Error("attempt was not created");
    }

    expect(() =>
      journal.markEffectStarted(
        attemptId,
        created.record.revision,
        29,
      ),
    ).toThrow("cannot precede");
  });

  test("distinguishes an idempotent prepare replay from an ID collision", async () => {
    const journal = createMemoryMutationAttemptJournal<
      MessageAttempt<Readonly<{ threadId: string }>, never>
    >();
    const attemptId = attemptIdFixture(4);
    const draft = {
      attemptId,
      fingerprint: createMutationFingerprint("sha256:stable-request"),
      operation: "message.send",
      sourceId: "source-1",
      preparedAtMs: 40,
      recovery: { threadId: "thread-1" },
    } as const;

    const created = await journal.prepare(draft);
    expect(created.status).toBe("created");
    const replay = await journal.prepare(draft);
    expect(replay.status).toBe("existing");

    const collision = await journal.prepare({
      ...draft,
      fingerprint: createMutationFingerprint("sha256:different-request"),
    });
    expect(collision.status).toBe("collision");
    if (collision.status !== "collision") {
      throw new Error("attempt collision was not detected");
    }
    expect(collision.current.attemptId).toBe(attemptId);
    expect((await journal.get(attemptId))?.fingerprint).toBe(
      draft.fingerprint,
    );
  });

  test("rejects settlement under a different operation", async () => {
    type Definitions =
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
    const journal = createMemoryMutationAttemptJournal<Definitions>();
    const attemptId = attemptIdFixture(5);
    const prepared = await journal.prepare({
      attemptId,
      fingerprint: createMutationFingerprint("sha256:operation-alpha"),
      operation: "alpha",
      sourceId: "source-1",
      preparedAtMs: 45,
      recovery: { alphaId: "alpha-1" },
    });
    if (prepared.status !== "created") {
      throw new Error("attempt was not created");
    }
    const started = await journal.markEffectStarted(
      attemptId,
      prepared.record.revision,
      46,
    );
    if (started.status !== "applied") {
      throw new Error("effect boundary was not recorded");
    }

    const mismatched = await journal.settle({
      operation: "beta",
      attemptId,
      expectedRevision: started.record.revision,
      outcome: confirmed(attemptId, { betaResult: 1 }),
      settledAtMs: 47,
    });

    expect(mismatched.status).toBe("invalid-transition");
    expect((await journal.get(attemptId))?.state).toBe("effect-started");
  });

  test("pages every open attempt with a stable compound cursor", async () => {
    const journal = createMemoryMutationAttemptJournal<
      MessageAttempt<null, never>
    >();
    for (const index of [3, 1, 2]) {
      await journal.prepare({
        attemptId: attemptIdFixture(index),
        fingerprint: createMutationFingerprint(
          `sha256:page-${String(index)}`,
        ),
        operation: "message.send",
        sourceId: "source-page",
        preparedAtMs: 50,
        recovery: null,
      });
    }

    const first = await journal.listOpen({
      sourceId: "source-page",
      after: null,
      limit: 2,
    });
    expect(first.attempts.map(({ attemptId }) => attemptId)).toEqual([
      attemptIdFixture(1),
      attemptIdFixture(2),
    ]);
    expect(first.hasMore).toBeTrue();
    expect(first.nextCursor).toEqual({
      preparedAtMs: 50,
      attemptId: attemptIdFixture(2),
    });

    const second = await journal.listOpen({
      sourceId: "source-page",
      after: first.nextCursor,
      limit: 2,
    });
    expect(second.attempts.map(({ attemptId }) => attemptId)).toEqual([
      attemptIdFixture(3),
    ]);
    expect(second.hasMore).toBeFalse();
  });

  test("uses portable code-unit ordering for cursor ties", async () => {
    const journal = createMemoryMutationAttemptJournal<
      MessageAttempt<null, never>
    >();
    for (const attemptId of [
      createAttemptId("attempt-a"),
      createAttemptId("attempt-A"),
    ]) {
      await journal.prepare({
        attemptId,
        fingerprint: createMutationFingerprint(`sha256:${attemptId}`),
        operation: "message.send",
        sourceId: "source-order",
        preparedAtMs: 60,
        recovery: null,
      });
    }

    const page = await journal.listOpen({
      sourceId: "source-order",
      after: null,
      limit: 2,
    });

    expect(page.attempts.map(({ attemptId }) => attemptId)).toEqual([
      createAttemptId("attempt-A"),
      createAttemptId("attempt-a"),
    ]);
  });
});

describe("memory generation and change feed", () => {
  test("reserves a generation above durable and observed floors", async () => {
    const store = createMemoryGenerationStore();

    expect(await reserveMonotonicGeneration(store, "source-1", 4)).toBe(5);
    expect(await reserveMonotonicGeneration(store, "source-1", 2)).toBe(6);
    expect(await store.read("source-1")).toBe(6);
  });

  test("pages ordered changes and isolates invalidation listeners", async () => {
    const feed = createMemoryChangeFeed<string>();
    let notifications = 0;
    feed.subscribe(() => {
      throw new Error("expected listener failure");
    });
    const unsubscribe = feed.subscribe(() => {
      notifications += 1;
    });
    feed.append("one");
    feed.append("two");
    feed.append("three");
    unsubscribe();

    const first = await feed.read({ after: null, limit: 2 });
    expect(first).toEqual({
      entries: [
        { cursor: 1, change: "one" },
        { cursor: 2, change: "two" },
      ],
      nextCursor: 2,
      hasMore: true,
    });
    expect(await feed.read({ after: first.nextCursor, limit: 2 })).toEqual({
      entries: [{ cursor: 3, change: "three" }],
      nextCursor: 3,
      hasMore: false,
    });
    expect(notifications).toBe(3);
  });
});
