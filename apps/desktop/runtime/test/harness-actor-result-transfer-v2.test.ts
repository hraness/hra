import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { fc, propertyParameters } from "@hra-internal/test";

import {
  ActorResultTransferV2,
  ActorResultTransferV2Error,
  type ActorResultTransferAuthorityV2Port,
  type ActorResultTransferValuePortV2,
} from "../src/harness/actor-result-transfer-v2";
import type {
  HarnessContextOperationRangeReaderV2,
  HarnessContextOperationValueRecordV2,
} from "../src/harness/context-value-ports-v2";

const epochId = "hepoch_result_transfer01";
const callerActorId = "hactor_result_caller01";
const callerTurnId = "hturn_result_caller001";
const childActorId = "hactor_result_child001";
const childTurnId = "hturn_result_child0001";
const sourceValueId = "ctxval_result_source0001";
const receiptId = "receipt_result_transfer_0001";
const quotaLimitBytes = 16 * 1024 * 1024;
const now = "2030-01-01T00:00:00.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;

const budget = Object.freeze({
  maxDepth: 3,
  maxActiveDescendants: 8,
  maxDurableDescendants: 50,
  tokenBudget: 100_000,
  byteBudget: quotaLimitBytes,
  deadline,
  laneAuthority: "managedWrite" as const,
});

function actor(
  id: string,
  parentActorId: string | null,
  depth: number,
) {
  return {
    id,
    epochId,
    parentActorId,
    depth,
    title: parentActorId === null ? "Root" : "Child",
    state: "active" as const,
    budget,
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 2,
    nextResultOrdinal: 2,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    stoppedAt: null,
  };
}

function turn(
  id: string,
  actorId: string,
  state: "running" | "succeeded",
) {
  return {
    id,
    epochId,
    actorId,
    ordinal: 1,
    idempotencyKey: `idempotency_${id}`,
    inputValueId: `ctxval_input_${id}`,
    state,
    desiredState: "run" as const,
    revision: state === "running" ? 2 : 3,
    createdAt: now,
    startedAt: now,
    settledAt: state === "succeeded" ? now : null,
    outcomeCode: state === "succeeded" ? "completed" : null,
  };
}

function result(
  actorId: string,
  turnId: string,
  valueId: string,
) {
  return {
    id: `hresult_${turnId}`,
    epochId,
    actorId,
    turnId,
    terminalAttemptId: `hattempt_${turnId}`,
    outcome: "succeeded" as const,
    valueId,
    actorResultOrdinal: 1,
    rootCompletionSequence: 1,
    createdAt: now,
  };
}

class MemoryAuthority implements ActorResultTransferAuthorityV2Port {
  epochValue: unknown = {
    id: epochId,
    projectId: "project-result-transfer",
    sourceSha: "a".repeat(40),
    rootActorId: callerActorId,
    budget,
    tokenReserved: 0,
    byteReserved: 0,
    nextRootCompletionSequence: 2,
    state: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    stoppedAt: null,
  };
  readonly actors = new Map<string, unknown>();
  readonly turns = new Map<string, unknown>();
  readonly results = new Map<string, unknown>();

  constructor() {
    this.actors.set(callerActorId, actor(callerActorId, null, 0));
    this.actors.set(childActorId, actor(childActorId, callerActorId, 1));
    this.turns.set(callerTurnId, turn(callerTurnId, callerActorId, "running"));
    this.turns.set(childTurnId, turn(childTurnId, childActorId, "succeeded"));
    this.results.set(
      childTurnId,
      result(childActorId, childTurnId, sourceValueId),
    );
  }

  readActorEpoch(id: string): unknown {
    return id === epochId ? this.epochValue : null;
  }

  readActor(id: string): unknown {
    return this.actors.get(id) ?? null;
  }

  readActorTurn(id: string): unknown {
    return this.turns.get(id) ?? null;
  }

  readActorResultForTurn(id: string): unknown {
    return this.results.get(id) ?? null;
  }
}

interface SourceValue {
  readonly metadata: HarnessContextOperationValueRecordV2;
  readonly bytes: Uint8Array;
}

class MemoryValues implements ActorResultTransferValuePortV2 {
  readonly sources = new Map<string, SourceValue>();
  readonly writes = new Map<string, Readonly<Record<string, unknown>>>();
  readonly targetPlaintext = new Map<string, string>();
  lastIssuedBytes: Uint8Array | null = null;

  seed(valueId: string, actorId: string, turnId: string, bytes: Uint8Array): void {
    this.sources.set(valueId, {
      metadata: {
        epochId,
        ownerActorId: actorId,
        sourceTurnId: turnId,
        valueId,
        kind: "agentResult",
        purpose: "agentResult",
        nameDigest: null,
        utf8Bytes: bytes.byteLength,
        quotaLimitBytes,
      },
      bytes: Uint8Array.from(bytes),
    });
  }

  async withExactActorResultRangeReader<Result>(
    input: Readonly<{
      epochId: string;
      ownerActorId: string;
      sourceTurnId: string;
      valueId: string;
      kind: "agentResult";
      purpose: "agentResult";
    }>,
    operation: (reader: HarnessContextOperationRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result> {
    const source = this.sources.get(input.valueId);
    if (source === undefined ||
        input.epochId !== source.metadata.epochId ||
        input.ownerActorId !== source.metadata.ownerActorId ||
        input.sourceTurnId !== source.metadata.sourceTurnId) {
      throw new Error("source identity conflict");
    }
    return await operation({
      value: source.metadata,
      readRange: ({ startByte, endByteExclusive }) => {
        const bytes = source.bytes.slice(startByte, endByteExclusive);
        this.lastIssuedBytes = bytes;
        return Promise.resolve(bytes);
      },
    });
  }

  putExact(input: Readonly<{
    operationId: string;
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
    valueId: string;
    kind: "text" | "json" | "selection" | "agentResult";
    purpose: "heap" | "completedPrefix" | "currentInput" | "agentResult" |
      "proposal" | "actorTask" | "programSource" | "programResult";
    plaintext: string;
    quotaLimitBytes: number;
    name?: string | null;
  }>): Promise<Readonly<{ value: HarnessContextOperationValueRecordV2 }>> {
    const canonical = JSON.stringify(input);
    const existing = this.writes.get(input.operationId);
    if (existing !== undefined && JSON.stringify(existing) !== canonical) {
      return Promise.reject(new Error("immutable transfer conflict"));
    }
    this.writes.set(input.operationId, structuredClone(input));
    this.targetPlaintext.set(input.valueId, input.plaintext);
    return Promise.resolve({
      value: {
        epochId: input.epochId,
        ownerActorId: input.ownerActorId,
        sourceTurnId: input.sourceTurnId,
        valueId: input.valueId,
        kind: input.kind,
        purpose: input.purpose,
        nameDigest: input.name === null || input.name === undefined
          ? null
          : sha256(input.name),
        utf8Bytes: Buffer.byteLength(input.plaintext, "utf8"),
        quotaLimitBytes: input.quotaLimitBytes,
      },
    });
  }
}

function fixture(bytes = new TextEncoder().encode("finished")) {
  const authority = new MemoryAuthority();
  const values = new MemoryValues();
  values.seed(sourceValueId, childActorId, childTurnId, bytes);
  const transfer = new ActorResultTransferV2({ authority, values });
  return { authority, values, transfer };
}

function input(overrides: Partial<Parameters<
  ActorResultTransferV2["transfer"]
>[0]> = {}) {
  return {
    epochId,
    callerActorId,
    callerTurnId,
    sourceActorId: childActorId,
    sourceTurnId: childTurnId,
    sourceValueId,
    receiptId,
    quotaLimitBytes,
    ...overrides,
  };
}

describe("actor result transfer v2", () => {
  test("copies once into caller custody, replays exactly, and zeroes read bytes", async () => {
    const { transfer, values } = fixture();
    const first = await transfer.transfer(input());
    const second = await transfer.transfer(input());

    expect(second).toEqual(first);
    expect(first.valueId).not.toBe(sourceValueId);
    expect(first).toEqual({
      valueId: first.valueId,
      kind: "text",
      utf8Bytes: 8,
    });
    expect(values.writes.size).toBe(1);
    expect(values.targetPlaintext.get(first.valueId)).toBe("finished");
    expect([...values.lastIssuedBytes ?? []].every((byte) => byte === 0))
      .toBeTrue();
  });

  test("transfers after the successful origin turn settles and after restart", async () => {
    const { authority, values } = fixture();
    authority.turns.set(
      callerTurnId,
      turn(callerTurnId, callerActorId, "succeeded"),
    );
    const beforeRestart = new ActorResultTransferV2({ authority, values });
    const first = await beforeRestart.transfer(input());
    const restarted = new ActorResultTransferV2({ authority, values });
    expect(await restarted.transfer(input())).toEqual(first);
    expect(values.targetPlaintext.get(first.valueId)).toBe("finished");
    expect([...values.writes.values()][0]?.sourceTurnId).toBe(callerTurnId);
  });

  test("fails closed for unsuccessful origins and revoked caller authority", async () => {
    for (const state of [
      "failed",
      "cancelled",
      "quotaRejected",
      "ambiguous",
    ] as const) {
      const value = fixture();
      value.authority.turns.set(callerTurnId, {
        ...turn(callerTurnId, callerActorId, "succeeded"),
        state,
        outcomeCode: `origin_${state.toLowerCase()}`,
      });
      await expectTransferError(
        value.transfer.transfer(input()),
        "unauthorized",
      );
      expect(value.values.writes.size).toBe(0);
    }

    const stopped = fixture();
    stopped.authority.turns.set(callerTurnId, {
      ...turn(callerTurnId, callerActorId, "running"),
      desiredState: "stop",
    });
    await expectTransferError(
      stopped.transfer.transfer(input()),
      "unauthorized",
    );

    const inactive = fixture();
    inactive.authority.actors.set(callerActorId, {
      ...actor(callerActorId, null, 0),
      state: "stopRequested",
    });
    await expectTransferError(
      inactive.transfer.transfer(input()),
      "unauthorized",
    );

    const quarantined = fixture();
    quarantined.authority.epochValue = {
      ...(quarantined.authority.epochValue as Record<string, unknown>),
      state: "quarantined",
      stoppedAt: now,
    };
    await expectTransferError(
      quarantined.transfer.transfer(input()),
      "unauthorized",
    );

    const expired = fixture();
    const expiredTransfer = new ActorResultTransferV2({
      authority: expired.authority,
      values: expired.values,
      now: () => Date.parse(deadline),
    });
    await expectTransferError(
      expiredTransfer.transfer(input()),
      "unauthorized",
    );
  });

  test("binds the receipt slot to the exact child identity even for equal bytes", async () => {
    const { authority, transfer, values } = fixture();
    await transfer.transfer(input());
    const otherActorId = "hactor_result_child002";
    const otherTurnId = "hturn_result_child0002";
    const otherValueId = "ctxval_result_source0002";
    authority.actors.set(
      otherActorId,
      actor(otherActorId, callerActorId, 1),
    );
    authority.turns.set(
      otherTurnId,
      turn(otherTurnId, otherActorId, "succeeded"),
    );
    authority.results.set(
      otherTurnId,
      result(otherActorId, otherTurnId, otherValueId),
    );
    values.seed(
      otherValueId,
      otherActorId,
      otherTurnId,
      new TextEncoder().encode("finished"),
    );

    expect(transfer.transfer(input({
      sourceActorId: otherActorId,
      sourceTurnId: otherTurnId,
      sourceValueId: otherValueId,
    }))).rejects.toMatchObject({ code: "conflict" });
    expect(values.writes.size).toBe(1);
  });

  test("rejects sibling, nonterminal, oversized, and mismatched-result evidence", () => {
    const sibling = fixture();
    sibling.authority.actors.set(
      childActorId,
      actor(childActorId, "hactor_someone_else01", 1),
    );
    expect(sibling.transfer.transfer(input()))
      .rejects.toMatchObject({ code: "unauthorized" });

    const nonterminal = fixture();
    nonterminal.authority.turns.set(
      childTurnId,
      turn(childTurnId, childActorId, "running"),
    );
    expect(nonterminal.transfer.transfer(input()))
      .rejects.toMatchObject({ code: "not_ready" });

    const mismatch = fixture();
    mismatch.authority.results.set(
      childTurnId,
      result(childActorId, childTurnId, "ctxval_result_other0001"),
    );
    expect(mismatch.transfer.transfer(input()))
      .rejects.toMatchObject({ code: "conflict" });

    const oversized = fixture();
    const source = oversized.values.sources.get(sourceValueId)!;
    oversized.values.sources.set(sourceValueId, {
      ...source,
      metadata: { ...source.metadata, utf8Bytes: 1024 * 1024 + 1 },
    });
    expect(oversized.transfer.transfer(input({
      quotaLimitBytes: 1024 * 1024,
    }))).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  test("preserves empty, BOM, and emoji text and rejects NUL or malformed UTF-8", async () => {
    for (const text of ["", "\uFEFFheading", "🧭🌴"]) {
      const { transfer, values } = fixture(new TextEncoder().encode(text));
      const transferred = await transfer.transfer(input());
      expect(values.targetPlaintext.get(transferred.valueId)).toBe(text);
    }

    for (const bytes of [
      Uint8Array.of(0),
      Uint8Array.of(0xed, 0xa0, 0x80),
      Uint8Array.of(0xf0, 0x28, 0x8c, 0x28),
    ]) {
      const { transfer, values } = fixture(bytes);
      expect(transfer.transfer(input())).rejects.toBeInstanceOf(
        ActorResultTransferV2Error,
      );
      expect(values.writes.size).toBe(0);
      expect([...values.lastIssuedBytes ?? []].every((byte) => byte === 0))
        .toBeTrue();
    }
  });

  test("round-trips every bounded well-formed NUL-free string", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ maxLength: 128 }).filter((value) =>
        isWellFormedUtf16(value) && !value.includes("\0")
      ),
      async (text) => {
        const { transfer, values } = fixture(new TextEncoder().encode(text));
        const transferred = await transfer.transfer(input());
        expect(values.targetPlaintext.get(transferred.valueId)).toBe(text);
        expect(transferred.utf8Bytes).toBe(Buffer.byteLength(text, "utf8"));
      },
    ), propertyParameters);
  }, PROPERTY_TIMEOUT);
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function expectTransferError(
  operation: Promise<unknown>,
  code: ActorResultTransferV2Error["code"],
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
