import {
  confirmed,
  createAttemptId,
  createMutationFingerprint,
} from "@hra-internal/codex-app-sdk";
import type { ConvexReactClient } from "convex/react";
import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  HOSTED_TASK_MUTATION_SOURCE_ID,
  HostedMutationJournalError,
  createConvexHostedMutationAttemptJournal,
  hostedMutationFingerprint,
} from "./hosted-mutation-attempt-journal";

const WORKSPACE_ID = "wsp_00000000000000000000000001";
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

function operationId(index: number): string {
  return `op_${String(index).padStart(26, "0")}`;
}

function taskId(index: number): string {
  return `tsk_${String(index).padStart(26, "0")}`;
}

function idempotencyKey(index: number): string {
  return `018f0f7d-8b4c-7000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}

function clientFingerprint(character = "A"): string {
  return `sha256_${character.repeat(43)}`;
}

function opaqueFingerprint(character = "A"): string {
  return `hmac_sha256_${character.repeat(43)}`;
}

const PREPARE_PROOF = opaqueFingerprint("P");

function preparedRecord(index: number) {
  return {
    attemptId: operationId(index),
    fingerprint: opaqueFingerprint(index % 2 === 0 ? "A" : "B"),
    fingerprintKeyVersion: "test-v1",
    operation: "task.comment_add" as const,
    sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
    preparedAtMs: NOW + index,
    workspaceId: WORKSPACE_ID,
    recovery: {
      idempotencyKey: idempotencyKey(index),
      hraOperationId: operationId(index),
      suppliedTaskId: taskId(index + 1_000),
      targetTaskId: taskId(1),
    },
    state: "prepared" as const,
    revision: 1,
  };
}

function effectStartedRecord(index: number) {
  return {
    ...preparedRecord(index),
    state: "effect-started" as const,
    revision: 2,
    effectStartedAtMs: NOW + index + 1,
  };
}

function settledRecord(index: number) {
  return {
    ...effectStartedRecord(index),
    state: "settled" as const,
    revision: 3,
    settledAtMs: NOW + index + 2,
    outcome: {
      status: "confirmed" as const,
      attemptId: operationId(index),
      value: {
        kind: "committed" as const,
        commandKind: "task.comment_add",
      },
    },
  };
}

function success<Data>(data: Data) {
  return {
    ok: true as const,
    data,
    requestId: "req_00000000000000000000000001",
  };
}

class FakeConvexJournalClient {
  readonly mutationCalls: Array<Readonly<{
    args: unknown;
    reference: unknown;
  }>> = [];
  readonly queryCalls: Array<Readonly<{
    args: unknown;
    reference: unknown;
  }>> = [];
  readonly mutationResults: unknown[] = [];
  readonly queryResults: unknown[] = [];

  mutation(reference: unknown, args: unknown): Promise<unknown> {
    this.mutationCalls.push({ args, reference });
    const value = this.mutationResults.shift();
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }

  query(reference: unknown, args: unknown): Promise<unknown> {
    this.queryCalls.push({ args, reference });
    const value = this.queryResults.shift();
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }
}

function journal(client: FakeConvexJournalClient) {
  return createConvexHostedMutationAttemptJournal({
    client: client as unknown as ConvexReactClient,
    workspaceId: WORKSPACE_ID,
  });
}

async function expectInvalidProjection(
  promise: Promise<unknown>,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected an invalid projection error.");
  } catch (error) {
    expect(error).toBeInstanceOf(HostedMutationJournalError);
    expect(error).toMatchObject({ code: "INVALID_PROJECTION" });
  }
}

describe("hosted mutation attempt journal", () => {
  test("hashes semantic intents deterministically without retaining raw text", async () => {
    const intent = {
      kind: "task.comment_add" as const,
      taskId: taskId(1),
      body: "private answer that must never be journaled",
    };
    const first = await hostedMutationFingerprint({ intent });
    const second = await hostedMutationFingerprint({
      intent: { ...intent },
    });
    const changed = await hostedMutationFingerprint({
      intent: { ...intent, body: "a genuinely different comment" },
    });

    expect(first).toBe(second);
    expect(first).not.toBe(changed);
    expect(first).toMatch(/^sha256_[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain(intent.body);
  });

  test("ignores refreshed top-level fences but preserves changed semantic input", async () => {
    const original = await hostedMutationFingerprint({
      intent: {
        kind: "task.update",
        taskId: taskId(1),
        expectedTaskRevision: 4,
        patch: { title: "Keep this semantic edit" },
      },
    });
    const refreshed = await hostedMutationFingerprint({
      intent: {
        kind: "task.update",
        taskId: taskId(1),
        expectedTaskRevision: 9,
        patch: { title: "Keep this semantic edit" },
      },
    });
    const changed = await hostedMutationFingerprint({
      intent: {
        kind: "task.update",
        taskId: taskId(1),
        expectedTaskRevision: 9,
        patch: { title: "Apply a different edit" },
      },
    });
    const originalReview = await hostedMutationFingerprint({
      intent: {
        kind: "review.accept",
        taskId: taskId(1),
        submissionId: "sub_00000000000000000000000001",
        expectedReviewRevision: 2,
      },
    });
    const refreshedReview = await hostedMutationFingerprint({
      intent: {
        kind: "review.accept",
        taskId: taskId(1),
        submissionId: "sub_00000000000000000000000001",
        expectedReviewRevision: 7,
      },
    });

    expect(refreshed).toBe(original);
    expect(changed).not.toBe(original);
    expect(refreshedReview).toBe(originalReview);
  });

  test("prepares only bounded recovery metadata before effect", async () => {
    const client = new FakeConvexJournalClient();
    const record = preparedRecord(1);
    const semanticFingerprint = clientFingerprint("C");
    client.mutationResults.push(success({
      fingerprint: record.fingerprint,
      fingerprintKeyVersion: record.fingerprintKeyVersion,
      prepareProof: PREPARE_PROOF,
    }));
    client.mutationResults.push(success({
      status: "created",
      record,
    }));
    const attempts = journal(client);
    const resolved = await attempts.resolveFingerprint(
      createMutationFingerprint(semanticFingerprint),
    );
    expect(String(resolved)).toBe(record.fingerprint);

    expect(await attempts.prepare({
      attemptId: createAttemptId(record.attemptId),
      fingerprint: createMutationFingerprint(record.fingerprint),
      operation: record.operation,
      sourceId: record.sourceId,
      preparedAtMs: record.preparedAtMs,
      recovery: record.recovery,
    })).toMatchObject({
      status: "created",
      record: { state: "prepared", recovery: record.recovery },
    });
    expect(client.mutationCalls).toHaveLength(2);
    expect(client.mutationCalls[1]?.args).toEqual({
      workspaceId: WORKSPACE_ID,
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      operation: "task.comment_add",
      fingerprint: record.fingerprint,
      fingerprintKeyVersion: record.fingerprintKeyVersion,
      prepareProof: PREPARE_PROOF,
      idempotencyKey: record.recovery.idempotencyKey,
      hraOperationId: record.recovery.hraOperationId,
      suppliedTaskId: record.recovery.suppliedTaskId,
      targetTaskId: record.recovery.targetTaskId,
    });
    expect(JSON.stringify(client.mutationCalls[1]?.args)).not.toContain(
      "private answer",
    );
  });

  test("returns collisions distinctly and rejects inexact server records", async () => {
    const client = new FakeConvexJournalClient();
    const record = preparedRecord(1);
    client.mutationResults.push(success({
      fingerprint: record.fingerprint,
      fingerprintKeyVersion: record.fingerprintKeyVersion,
      prepareProof: PREPARE_PROOF,
    }));
    client.mutationResults.push(
      success({ status: "collision", current: record }),
      success({
        status: "created",
        record: { ...record, intentPayload: { body: "must not cross" } },
      }),
    );
    const attempts = journal(client);
    await attempts.resolveFingerprint(
      createMutationFingerprint(clientFingerprint("C")),
    );
    const draft = {
      attemptId: createAttemptId(record.attemptId),
      fingerprint: createMutationFingerprint(record.fingerprint),
      operation: record.operation,
      sourceId: record.sourceId,
      preparedAtMs: record.preparedAtMs,
      recovery: record.recovery,
    };

    expect(await attempts.prepare(draft)).toMatchObject({
      status: "collision",
      current: { attemptId: record.attemptId },
    });
    try {
      await attempts.prepare(draft);
      throw new Error("Expected an invalid projection error.");
    } catch (error) {
      expect(error).toBeInstanceOf(HostedMutationJournalError);
      expect(error).toMatchObject({ code: "INVALID_PROJECTION" });
    }
  });

  test("rejects an unrelated collision record", async () => {
    const client = new FakeConvexJournalClient();
    const record = preparedRecord(1);
    const unrelated = {
      ...preparedRecord(2),
      fingerprint: opaqueFingerprint("D"),
    };
    client.mutationResults.push(success({
      fingerprint: record.fingerprint,
      fingerprintKeyVersion: record.fingerprintKeyVersion,
      prepareProof: PREPARE_PROOF,
    }));
    client.mutationResults.push(
      success({ status: "collision", current: unrelated }),
    );
    const attempts = journal(client);
    const fingerprint = await attempts.resolveFingerprint(
      createMutationFingerprint(clientFingerprint("C")),
    );

    await expectInvalidProjection(attempts.prepare({
      attemptId: createAttemptId(record.attemptId),
      fingerprint,
      operation: record.operation,
      sourceId: record.sourceId,
      preparedAtMs: record.preparedAtMs,
      recovery: record.recovery,
    }));
  });

  test("paginates every Convex query at fifty records or fewer", async () => {
    const client = new FakeConvexJournalClient();
    const records = Array.from(
      { length: 120 },
      (_, index) => preparedRecord(index + 1),
    );
    client.queryResults.push(
      success({
        attempts: records.slice(0, 50),
        nextCursor: {
          preparedAtMs: records[49]?.preparedAtMs,
          attemptId: records[49]?.attemptId,
        },
        hasMore: true,
      }),
      success({
        attempts: records.slice(50, 100),
        nextCursor: {
          preparedAtMs: records[99]?.preparedAtMs,
          attemptId: records[99]?.attemptId,
        },
        hasMore: true,
      }),
      success({
        attempts: records.slice(100),
        nextCursor: {
          preparedAtMs: records[119]?.preparedAtMs,
          attemptId: records[119]?.attemptId,
        },
        hasMore: true,
      }),
    );

    const page = await journal(client).listOpen({
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      after: null,
      limit: 120,
    });
    expect(page).toMatchObject({
      attempts: { length: 120 },
      hasMore: true,
      nextCursor: {
        attemptId: records[119]?.attemptId,
      },
    });
    expect(client.queryCalls.map(({ args }) => args)).toEqual([
      expect.objectContaining({ limit: 50, after: null }),
      expect.objectContaining({ limit: 50 }),
      expect.objectContaining({ limit: 20 }),
    ]);
    for (const call of client.queryCalls) {
      expect(call.args).toMatchObject({
        sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
        workspaceId: WORKSPACE_ID,
      });
      expect((call.args as { limit: number }).limit).toBeLessThanOrEqual(50);
    }
  });

  test("marks before settling and sends no outcome message or intent payload", async () => {
    const client = new FakeConvexJournalClient();
    const started = effectStartedRecord(1);
    const settled = settledRecord(1);
    client.mutationResults.push(
      success({ status: "applied", record: started }),
      success({ status: "applied", record: settled }),
    );
    const attempts = journal(client);

    expect(await attempts.markEffectStarted(
      createAttemptId(started.attemptId),
      1,
      started.effectStartedAtMs,
    )).toMatchObject({
      status: "applied",
      record: { state: "effect-started" },
    });
    expect(await attempts.settle({
      operation: "task.comment_add",
      attemptId: createAttemptId(settled.attemptId),
      expectedRevision: 2,
      outcome: confirmed(createAttemptId(settled.attemptId), {
        kind: "committed",
        commandKind: "task.comment_add",
      }),
      settledAtMs: settled.settledAtMs,
    })).toMatchObject({
      status: "applied",
      record: { state: "settled" },
    });
    expect(client.mutationCalls[1]?.args).toEqual({
      workspaceId: WORKSPACE_ID,
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      attemptId: settled.attemptId,
      expectedRevision: 2,
      operation: "task.comment_add",
      settlement: {
        kind: "confirmed",
        commandKind: "task.comment_add",
      },
    });
  });

  test("maps authenticated domain failures without trusting unparsed data", async () => {
    const client = new FakeConvexJournalClient();
    client.queryResults.push({
      ok: false,
      error: {
        code: "AUTHENTICATION_FAILED",
        message: "Sign in.",
        requestId: "req_00000000000000000000000002",
        details: {},
      },
    });
    try {
      await journal(client).get(createAttemptId(operationId(1)));
      throw new Error("Expected authentication failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(HostedMutationJournalError);
      expect(error).toMatchObject({
        code: "AUTHENTICATION_FAILED",
        reference: "req_00000000000000000000000002",
      });
    }
  });

  test("preserves the resolved fingerprint identity across adapter reload", async () => {
    const record = preparedRecord(1);
    const semanticFingerprint = createMutationFingerprint(
      clientFingerprint("C"),
    );
    const firstClient = new FakeConvexJournalClient();
    firstClient.mutationResults.push(success({
      fingerprint: record.fingerprint,
      fingerprintKeyVersion: record.fingerprintKeyVersion,
      prepareProof: PREPARE_PROOF,
    }));
    firstClient.mutationResults.push(success({
      status: "created",
      record,
    }));
    const first = journal(firstClient);
    const firstResolved = await first.resolveFingerprint(
      semanticFingerprint,
    );
    const draft = {
      attemptId: createAttemptId(record.attemptId),
      fingerprint: firstResolved,
      operation: record.operation,
      sourceId: record.sourceId,
      preparedAtMs: record.preparedAtMs,
      recovery: record.recovery,
    };
    expect(await first.prepare(draft)).toMatchObject({
      status: "created",
      record: { fingerprint: firstResolved },
    });

    const secondClient = new FakeConvexJournalClient();
    secondClient.mutationResults.push(success({
      fingerprint: record.fingerprint,
      fingerprintKeyVersion: record.fingerprintKeyVersion,
      prepareProof: PREPARE_PROOF,
    }));
    secondClient.queryResults.push(
      success({
        attempts: [record],
        nextCursor: null,
        hasMore: false,
      }),
    );
    const second = journal(secondClient);
    const secondResolved = await second.resolveFingerprint(
      semanticFingerprint,
    );
    expect(secondResolved).toBe(firstResolved);
    expect(await second.listOpen({
      sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
      after: null,
      limit: 50,
    })).toMatchObject({
      attempts: [{ fingerprint: firstResolved }],
      hasMore: false,
    });
  });

  test("rejects forged scope, identity, revision, and timestamp relations", async () => {
    const forgedRecords = [
      {
        ...preparedRecord(1),
        sourceId: "oprte.web.task-workspace.v2",
      },
      {
        ...preparedRecord(1),
        workspaceId: "wsp_00000000000000000000000002",
      },
      {
        ...preparedRecord(2),
        attemptId: operationId(1),
      },
      {
        ...effectStartedRecord(1),
        effectStartedAtMs: NOW,
      },
      {
        ...settledRecord(1),
        outcome: {
          ...settledRecord(1).outcome,
          attemptId: operationId(2),
        },
      },
    ];
    for (const record of forgedRecords) {
      const client = new FakeConvexJournalClient();
      client.queryResults.push(success(record));
      await expectInvalidProjection(
        journal(client).get(createAttemptId(operationId(1))),
      );
    }
  });

  test("rejects transition responses that violate compare-and-set revision laws", async () => {
    const client = new FakeConvexJournalClient();
    const started = effectStartedRecord(1);
    const settled = settledRecord(1);
    client.mutationResults.push(
      success({
        status: "applied",
        record: { ...settled, revision: 3 },
      }),
      success({
        status: "invalid-transition",
        current: { ...started, revision: 2 },
      }),
    );
    const attempts = journal(client);
    const outcome = confirmed(createAttemptId(settled.attemptId), {
      kind: "committed" as const,
      commandKind: "task.comment_add" as const,
    });

    await expectInvalidProjection(attempts.settle({
      operation: "task.comment_add",
      attemptId: createAttemptId(settled.attemptId),
      expectedRevision: 1,
      outcome,
      settledAtMs: settled.settledAtMs,
    }));
    await expectInvalidProjection(attempts.settle({
      operation: "task.comment_add",
      attemptId: createAttemptId(settled.attemptId),
      expectedRevision: 1,
      outcome,
      settledAtMs: settled.settledAtMs,
    }));
  });

  test("rejects non-progressing and contradictory Convex pages", async () => {
    const record = preparedRecord(1);
    const malformedPages = [
      {
        attempts: [],
        nextCursor: {
          preparedAtMs: record.preparedAtMs,
          attemptId: record.attemptId,
        },
        hasMore: true,
      },
      {
        attempts: [record],
        nextCursor: {
          preparedAtMs: record.preparedAtMs,
          attemptId: operationId(2),
        },
        hasMore: true,
      },
      {
        attempts: [preparedRecord(2), preparedRecord(1)],
        nextCursor: null,
        hasMore: false,
      },
      {
        attempts: [record],
        nextCursor: {
          preparedAtMs: record.preparedAtMs,
          attemptId: record.attemptId,
        },
        hasMore: false,
      },
    ];
    for (const page of malformedPages) {
      const client = new FakeConvexJournalClient();
      client.queryResults.push(success(page));
      await expectInvalidProjection(journal(client).listOpen({
        sourceId: HOSTED_TASK_MUTATION_SOURCE_ID,
        after: null,
        limit: 50,
      }));
    }
  });
});
