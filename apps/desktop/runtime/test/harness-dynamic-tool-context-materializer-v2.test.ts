import { describe, expect, test } from "bun:test";

import {
  HarnessDynamicToolContextMaterializerV2,
  HarnessDynamicToolContextMaterializerV2Error,
  deriveHarnessDynamicToolContextMaterializationIds,
  digestHarnessDynamicToolCompletedPrefixV2,
  type HarnessDynamicToolContextSnapshotPortV2,
  type HarnessDynamicToolProgramAdmissionIntentPortV2,
} from "../src/harness/dynamic-tool-context-materializer-v2";
import {
  COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
  packCompletedPrefixContainerV2,
  parseCompletedPrefixContainerV2,
} from "../src/harness/completed-prefix-container-v2";
import type {
  HarnessContextOperationRangeReaderV2,
  HarnessContextOperationValuePortV2,
  HarnessContextOperationValueRecordV2,
} from "../src/harness/context-value-ports-v2";
import type {
  HarnessDynamicToolContextMaterializationInputV2,
} from "../src/harness/dynamic-tool-stable-caller-v2";
import {
  contextSnapshotRecordV2Schema,
  type ContextSnapshotRecordV2,
} from "../src/harness/context-snapshot-authority-v2";
import {
  HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES,
  HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES,
  HARNESS_MAX_HEAP_UTF8_BYTES,
} from "../src/harness/domain";
import type {
  ProgramAdmissionIntentRecordV2,
} from "../src/harness/program-admission-intent-v2";

const createdAt = "2030-01-01T00:00:00.000Z";
const expiresAt = "2030-01-02T00:00:00.000Z";
const laterExpiry = "2030-01-03T00:00:00.000Z";
const runId = "rlmrun_dynamic_materializer001";
const epochId = "hepoch_dynamic_materializer01";
const actorId = "hactor_dynamic_materializer01";
const turnId = "hturn_dynamic_materializer001";
const completedThroughTurnId = "hturn_dynamic_materializer000";
const currentInputValueId = "ctxval_dynamic_materializer_input01";
const programDigest = "a".repeat(64);
const admissionDigest = "b".repeat(64);
const coverageWitnessDigest = "c".repeat(64);
const quotaLimitBytes = HARNESS_MAX_HEAP_UTF8_BYTES;

type PutInput = Parameters<HarnessContextOperationValuePortV2["putExact"]>[0];
type OpenInput = Parameters<HarnessContextOperationValuePortV2["openExact"]>[0];
type RangeOpenInput = Parameters<
  HarnessContextOperationValuePortV2["withExactRangeReader"]
>[0];
type ActorResultRangeOpenInput = Parameters<
  HarnessContextOperationValuePortV2["withExactActorResultRangeReader"]
>[0];

interface StoredValue {
  readonly publication: PutInput | null;
  readonly plaintext: string;
  readonly value: HarnessContextOperationValueRecordV2;
}

class Values implements HarnessContextOperationValuePortV2 {
  readonly records = new Map<string, StoredValue>();
  readonly puts: PutInput[] = [];
  readonly opens: OpenInput[] = [];
  readonly rangeOpens: RangeOpenInput[] = [];
  readonly rangeReads: Array<Readonly<{
    valueId: string;
    startByte: number;
    endByteExclusive: number;
  }>> = [];

  seedCurrent(
    input: HarnessDynamicToolContextMaterializationInputV2,
  ): void {
    this.records.set(input.currentInputValueId, {
      publication: null,
      plaintext: input.currentInput,
      value: metadata({
        epochId: input.epochId,
        ownerActorId: input.actorId,
        sourceTurnId: input.currentInputProvenance.sourceTurnId,
        valueId: input.currentInputValueId,
        kind: "text",
        purpose: input.currentInputProvenance.purpose,
        plaintext: input.currentInput,
      }),
    });
  }

  openExact(input: OpenInput) {
    this.opens.push(input);
    if (input.purpose === "completedPrefix") {
      return Promise.reject(new Error("completed prefixes require range reads"));
    }
    const stored = this.records.get(input.valueId);
    if (
      stored === undefined ||
      stored.value.epochId !== input.epochId ||
      stored.value.ownerActorId !== input.ownerActorId ||
      stored.value.sourceTurnId !== input.sourceTurnId ||
      stored.value.kind !== input.kind ||
      stored.value.purpose !== input.purpose
    ) return Promise.reject(new Error("exact value is unavailable"));
    return Promise.resolve({
      plaintext: stored.plaintext,
      value: stored.value,
    });
  }

  putExact(input: PutInput) {
    this.puts.push(input);
    const existing = this.records.get(input.valueId);
    if (existing !== undefined) {
      if (
        existing.publication === null ||
        exactJson(existing.publication) !== exactJson(input)
      ) return Promise.reject(new Error("immutable publication conflicts"));
      return Promise.resolve({ value: existing.value });
    }
    const value = metadata({
      epochId: input.epochId,
      ownerActorId: input.ownerActorId,
      sourceTurnId: input.sourceTurnId,
      valueId: input.valueId,
      kind: input.kind,
      purpose: input.purpose,
      plaintext: input.plaintext,
      quotaLimitBytes: input.quotaLimitBytes,
    });
    this.records.set(input.valueId, {
      publication: Object.freeze({ ...input }),
      plaintext: input.plaintext,
      value,
    });
    return Promise.resolve({ value });
  }

  async withExactRangeReader<Result>(
    input: RangeOpenInput,
    operation: (reader: HarnessContextOperationRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result> {
    this.rangeOpens.push(input);
    const stored = this.records.get(input.valueId);
    if (
      stored === undefined ||
      stored.value.epochId !== input.epochId ||
      stored.value.ownerActorId !== input.ownerActorId ||
      stored.value.sourceTurnId !== input.sourceTurnId ||
      stored.value.kind !== "selection" ||
      stored.value.purpose !== "completedPrefix"
    ) throw new Error("exact ranged value is unavailable");
    const plaintext = Buffer.from(stored.plaintext, "utf8");
    let open = true;
    try {
      const reader: HarnessContextOperationRangeReaderV2 = Object.freeze({
        value: stored.value,
        readRange: (range: Readonly<{
          startByte: number;
          endByteExclusive: number;
        }>) => {
          if (
            !open || !Number.isSafeInteger(range.startByte) ||
            !Number.isSafeInteger(range.endByteExclusive) ||
            range.startByte < 0 ||
            range.endByteExclusive < range.startByte ||
            range.endByteExclusive > plaintext.byteLength
          ) throw new Error("invalid exact range");
          this.rangeReads.push(Object.freeze({
            valueId: input.valueId,
            ...range,
          }));
          return Promise.resolve(Uint8Array.from(plaintext.subarray(
            range.startByte,
            range.endByteExclusive,
          )));
        },
      });
      return await operation(reader);
    } finally {
      open = false;
      plaintext.fill(0);
    }
  }

  withExactActorResultRangeReader<Result>(
    inputValue: ActorResultRangeOpenInput,
    operation: (reader: HarnessContextOperationRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result> {
    void inputValue;
    void operation;
    return Promise.reject(new Error("actor results are outside this fixture"));
  }

  listActive() {
    return Promise.resolve([]);
  }
}

class Snapshots implements HarnessDynamicToolContextSnapshotPortV2 {
  readonly records = new Map<string, ContextSnapshotRecordV2>();
  readonly creates: ContextSnapshotRecordV2[] = [];
  loseCreateResponseOnce = false;
  failCreateWithoutRecord = false;

  read(snapshotId: string): ContextSnapshotRecordV2 | null {
    return this.records.get(snapshotId) ?? null;
  }

  create(inputValue: ContextSnapshotRecordV2): ContextSnapshotRecordV2 {
    const input = contextSnapshotRecordV2Schema.parse(inputValue);
    this.creates.push(input);
    if (this.failCreateWithoutRecord) {
      throw new Error("snapshot write outcome is unavailable");
    }
    const existing = this.records.get(input.id);
    if (existing !== undefined) {
      if (exactJson(existing) !== exactJson(input)) {
        throw new Error("immutable snapshot conflicts");
      }
      return existing;
    }
    this.records.set(input.id, input);
    if (this.loseCreateResponseOnce) {
      this.loseCreateResponseOnce = false;
      throw new Error("snapshot response was lost");
    }
    return input;
  }
}

class Admissions implements HarnessDynamicToolProgramAdmissionIntentPortV2 {
  readonly records = new Map<string, ProgramAdmissionIntentRecordV2>();
  readonly prepares: Array<Parameters<
    HarnessDynamicToolProgramAdmissionIntentPortV2["prepare"]
  >[0]> = [];

  prepare(inputValue: Parameters<
    HarnessDynamicToolProgramAdmissionIntentPortV2["prepare"]
  >[0]): ProgramAdmissionIntentRecordV2 {
    const input = Object.freeze({ ...inputValue });
    this.prepares.push(input);
    const existing = this.records.get(input.runId);
    if (existing !== undefined) {
      const immutable = {
        runId: existing.runId,
        epochId: existing.epochId,
        actorId: existing.actorId,
        turnId: existing.turnId,
        completedPrefixValueId: existing.completedPrefixValueId,
        completedPrefixContentDigest: existing.completedPrefixContentDigest,
        completedPrefixSnapshotId: existing.completedPrefixSnapshotId,
        completedThroughTurnId: existing.completedThroughTurnId,
        currentUserInputValueId: existing.currentUserInputValueId,
        programDigest: existing.programDigest,
        stableAdmissionIdentityDigest: existing.stableAdmissionIdentityDigest,
        coverageWitnessDigest: existing.coverageWitnessDigest,
        expiresAt: existing.expiresAt,
      };
      if (exactJson(immutable) !== exactJson(input)) {
        throw new Error("immutable admission intent conflicts");
      }
      return existing;
    }
    const prepared: ProgramAdmissionIntentRecordV2 = Object.freeze({
      ...input,
      state: "prepared",
      recoveryReason: null,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      materializedAt: null,
      admittedAt: null,
      abandonedAt: null,
    });
    this.records.set(input.runId, prepared);
    return prepared;
  }

  markMaterialized(input: Readonly<{
    runId: string;
    expectedRevision: number;
  }>): ProgramAdmissionIntentRecordV2 {
    const current = this.records.get(input.runId);
    if (current === undefined) throw new Error("intent missing");
    if (current.state === "materialized" || current.state === "admitted") {
      return current;
    }
    if (current.state !== "prepared" ||
        current.revision !== input.expectedRevision) {
      throw new Error("intent transition conflicts");
    }
    const materialized: ProgramAdmissionIntentRecordV2 = Object.freeze({
      ...current,
      state: "materialized",
      revision: current.revision + 1,
      updatedAt: createdAt,
      materializedAt: createdAt,
    });
    this.records.set(input.runId, materialized);
    return materialized;
  }
}

function input(
  overrides: Partial<HarnessDynamicToolContextMaterializationInputV2> = {},
): HarnessDynamicToolContextMaterializationInputV2 {
  return {
    runId,
    epochId,
    actorId,
    turnId,
    currentInputValueId,
    currentInputProvenance: {
      valueId: currentInputValueId,
      purpose: "currentInput",
      sourceTurnId: null,
    },
    completedThroughTurnId: null,
    expiresAt,
    programDigest,
    stableAdmissionIdentityDigest: admissionDigest,
    coverageWitnessDigest,
    completedPrefix: [
      { ordinal: 0, itemClass: "userMessage", text: "Earlier\0question" },
      { ordinal: 2, itemClass: "assistantMessage", text: "Earlier answer" },
    ],
    currentInput: "Current input remains separately encrypted.",
    ...overrides,
  };
}

function fixture(inputValue = input()) {
  const values = new Values();
  const snapshots = new Snapshots();
  const admissions = new Admissions();
  values.seedCurrent(inputValue);
  return {
    values,
    snapshots,
    admissions,
    materializer: new HarnessDynamicToolContextMaterializerV2({
      admissions,
      values,
      snapshots,
      now: () => new Date(createdAt),
    }),
  };
}

function ids(inputValue = input()) {
  const prefix = packCompletedPrefixContainerV2({
    coverageWitnessDigest: inputValue.coverageWitnessDigest,
    completedThroughTurnId: inputValue.completedThroughTurnId,
    items: inputValue.completedPrefix,
  });
  return deriveHarnessDynamicToolContextMaterializationIds({
    epochId: inputValue.epochId,
    actorId: inputValue.actorId,
    completedThroughTurnId: inputValue.completedThroughTurnId,
    expiresAt: inputValue.expiresAt,
    coverageWitnessDigest: inputValue.coverageWitnessDigest,
    prefixContentDigest:
      digestHarnessDynamicToolCompletedPrefixV2(prefix.plaintext),
  });
}

function metadata(inputValue: Readonly<{
  epochId: string;
  ownerActorId: string;
  sourceTurnId: string | null;
  valueId: string;
  kind: HarnessContextOperationValueRecordV2["kind"];
  purpose: HarnessContextOperationValueRecordV2["purpose"];
  plaintext: string;
  quotaLimitBytes?: number;
}>): HarnessContextOperationValueRecordV2 {
  return Object.freeze({
    epochId: inputValue.epochId,
    ownerActorId: inputValue.ownerActorId,
    sourceTurnId: inputValue.sourceTurnId,
    valueId: inputValue.valueId,
    kind: inputValue.kind,
    purpose: inputValue.purpose,
    nameDigest: null,
    utf8Bytes: Buffer.byteLength(inputValue.plaintext, "utf8"),
    quotaLimitBytes: inputValue.quotaLimitBytes ?? quotaLimitBytes,
  });
}

async function expectMaterializerError(
  operation: Promise<unknown>,
  code: HarnessDynamicToolContextMaterializerV2Error["code"],
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HarnessDynamicToolContextMaterializerV2Error);
  expect(caught).toMatchObject({ code });
}

describe("HarnessDynamicToolContextMaterializerV2", () => {
  test("publishes one indexed prefix with NUL and a null stable anchor", async () => {
    const inputValue = input();
    const value = fixture(inputValue);
    const expectedIds = ids(inputValue);
    const expectedPrefix = packCompletedPrefixContainerV2({
      coverageWitnessDigest,
      completedThroughTurnId: null,
      items: inputValue.completedPrefix,
    });
    const result = await value.materializer.materialize(inputValue);

    expect(result).toEqual({
      completedPrefixSnapshotId: expectedIds.completedPrefixSnapshotId,
      currentUserInputValueId: currentInputValueId,
      coverageWitnessDigest,
    });
    expect(value.values.puts).toHaveLength(1);
    expect(value.values.puts[0]).toEqual({
      operationId: expectedIds.operationId,
      epochId,
      ownerActorId: actorId,
      sourceTurnId: null,
      valueId: expectedIds.completedPrefixValueId,
      kind: "selection",
      purpose: "completedPrefix",
      plaintext: expectedPrefix.plaintext,
      quotaLimitBytes,
      name: null,
    });
    expect(parseCompletedPrefixContainerV2(
      value.values.puts[0]!.plaintext,
    )).toEqual({
      index: expectedPrefix.index,
      items: inputValue.completedPrefix,
    });
    expect(value.values.puts.some(({ valueId }) =>
      valueId === currentInputValueId
    )).toBe(false);
    expect(value.values.opens[0]).toEqual({
      epochId,
      ownerActorId: actorId,
      sourceTurnId: null,
      valueId: currentInputValueId,
      kind: "text",
      purpose: "currentInput",
    });
    expect(value.values.opens).toHaveLength(1);
    expect(value.values.rangeOpens).toEqual([{
      epochId,
      ownerActorId: actorId,
      sourceTurnId: null,
      valueId: expectedIds.completedPrefixValueId,
      kind: "selection",
      purpose: "completedPrefix",
    }]);
    expect(value.values.rangeReads).toEqual([
      {
        valueId: expectedIds.completedPrefixValueId,
        startByte: 0,
        endByteExclusive: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
      },
      {
        valueId: expectedIds.completedPrefixValueId,
        startByte: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
        endByteExclusive: expectedPrefix.index.payloadOffset,
      },
      {
        valueId: expectedIds.completedPrefixValueId,
        startByte: expectedPrefix.index.payloadOffset,
        endByteExclusive: expectedPrefix.index.totalUtf8Bytes,
      },
    ]);
    expect(value.snapshots.creates).toEqual([{
      id: expectedIds.completedPrefixSnapshotId,
      epochId,
      actorId,
      completedThroughTurnId: null,
      coverageWitnessDigest,
      valueId: expectedIds.completedPrefixValueId,
      createdAt,
      expiresAt,
    }]);
  });

  test("replays exact storage and reconciles a lost snapshot response", async () => {
    const inputValue = input();
    const value = fixture(inputValue);
    value.snapshots.loseCreateResponseOnce = true;
    const first = await value.materializer.materialize(inputValue);
    const second = await value.materializer.materialize(inputValue);
    expect(second).toEqual(first);
    expect(value.values.puts).toHaveLength(1);
    expect(value.snapshots.creates).toHaveLength(1);
    expect(value.values.opens.filter(({ purpose }) =>
      purpose === "currentInput"
    )).toHaveLength(2);
    expect(value.values.rangeOpens).toHaveLength(2);
  });

  test("a terminal admission intent causes zero context writes", async () => {
    for (const terminal of ["abandoned", "recoveryRequired"] as const) {
      const inputValue = input();
      const value = fixture(inputValue);
      const expectedIds = ids(inputValue);
      const prefix = packCompletedPrefixContainerV2({
        coverageWitnessDigest: inputValue.coverageWitnessDigest,
        completedThroughTurnId: inputValue.completedThroughTurnId,
        items: inputValue.completedPrefix,
      });
      const prepared = value.admissions.prepare({
        runId: inputValue.runId,
        epochId: inputValue.epochId,
        actorId: inputValue.actorId,
        turnId: inputValue.turnId,
        completedPrefixValueId: expectedIds.completedPrefixValueId,
        completedPrefixContentDigest:
          digestHarnessDynamicToolCompletedPrefixV2(prefix.plaintext),
        completedPrefixSnapshotId: expectedIds.completedPrefixSnapshotId,
        completedThroughTurnId: inputValue.completedThroughTurnId,
        currentUserInputValueId: inputValue.currentInputValueId,
        programDigest: inputValue.programDigest,
        stableAdmissionIdentityDigest:
          inputValue.stableAdmissionIdentityDigest,
        coverageWitnessDigest: inputValue.coverageWitnessDigest,
        expiresAt: inputValue.expiresAt,
      });
      value.admissions.records.set(inputValue.runId, Object.freeze({
        ...prepared,
        state: terminal,
        recoveryReason: terminal === "recoveryRequired"
          ? "materialization_conflict"
          : null,
        revision: 2,
        abandonedAt: terminal === "abandoned" ? createdAt : null,
      }));

      await expectMaterializerError(
        value.materializer.materialize(inputValue),
        "conflict",
      );
      expect(value.values.opens).toHaveLength(1);
      expect(value.values.rangeOpens).toHaveLength(0);
      expect(value.values.puts).toHaveLength(0);
      expect(value.snapshots.creates).toHaveLength(0);
    }
  });

  test("deduplicates one completed prefix across distinct exact run admissions", async () => {
    const firstInput = input();
    const secondInput = input({
      runId: "rlmrun_dynamic_materializer002",
      programDigest: "d".repeat(64),
      stableAdmissionIdentityDigest: "e".repeat(64),
    });
    const value = fixture(firstInput);
    value.values.seedCurrent(secondInput);

    const first = await value.materializer.materialize(firstInput);
    const second = await value.materializer.materialize(secondInput);

    expect(first).toEqual(second);
    expect(ids(firstInput)).toEqual(ids(secondInput));
    expect(value.values.puts).toHaveLength(1);
    expect(value.snapshots.creates).toHaveLength(1);
    expect([...value.admissions.records.values()].map((record) =>
      [record.runId, record.state]
    )).toEqual([
      [firstInput.runId, "materialized"],
      [secondInput.runId, "materialized"],
    ]);
  });

  test("fails closed when a selected completed-prefix payload range changes", async () => {
    const inputValue = input();
    const value = fixture(inputValue);
    await value.materializer.materialize(inputValue);
    const prefixId = ids(inputValue).completedPrefixValueId;
    const stored = value.values.records.get(prefixId)!;
    const changedPlaintext = stored.plaintext.replace(
      "Earlier\0question",
      "Zarlier\0question",
    );
    expect(changedPlaintext).not.toBe(stored.plaintext);
    expect(Buffer.byteLength(changedPlaintext, "utf8"))
      .toBe(stored.value.utf8Bytes);
    value.values.records.set(prefixId, {
      ...stored,
      plaintext: changedPlaintext,
    });

    await expectMaterializerError(
      value.materializer.materialize(inputValue),
      "conflict",
    );
    expect(value.values.rangeOpens).toHaveLength(2);
    expect(value.values.puts).toHaveLength(1);
  });

  test("opens nested actor-task provenance without republishing it", async () => {
    const inputValue = input({
      currentInputProvenance: {
        valueId: currentInputValueId,
        purpose: "actorTask",
        sourceTurnId: turnId,
      },
      completedThroughTurnId,
    });
    const value = fixture(inputValue);
    const result = await value.materializer.materialize(inputValue);
    expect(result.currentUserInputValueId).toBe(currentInputValueId);
    expect(value.values.opens[0]).toMatchObject({
      valueId: currentInputValueId,
      sourceTurnId: turnId,
      purpose: "actorTask",
    });
    expect(value.values.puts).toHaveLength(1);
    expect(value.values.puts[0]?.sourceTurnId).toBe(completedThroughTurnId);
    expect(value.snapshots.creates[0]?.completedThroughTurnId)
      .toBe(completedThroughTurnId);
  });

  test("rejects changed current plaintext and changed immutable witness", async () => {
    const inputValue = input();
    const wrongCurrent = fixture(inputValue);
    wrongCurrent.values.records.set(currentInputValueId, {
      publication: null,
      plaintext: "Different current input",
      value: metadata({
        epochId,
        ownerActorId: actorId,
        sourceTurnId: null,
        valueId: currentInputValueId,
        kind: "text",
        purpose: "currentInput",
        plaintext: "Different current input",
      }),
    });
    await expectMaterializerError(
      wrongCurrent.materializer.materialize(inputValue),
      "conflict",
    );
    expect(wrongCurrent.values.puts).toHaveLength(0);

    const changedWitness = fixture(inputValue);
    await changedWitness.materializer.materialize(inputValue);
    await expectMaterializerError(
      changedWitness.materializer.materialize(input({
        coverageWitnessDigest: "d".repeat(64),
      })),
      "conflict",
    );
    expect(changedWitness.snapshots.records).toHaveLength(1);
  });

  test("binds expiry across a partial publication and rejects a changed replay", async () => {
    const inputValue = input();
    const value = fixture(inputValue);
    value.snapshots.failCreateWithoutRecord = true;
    await expectMaterializerError(
      value.materializer.materialize(inputValue),
      "conflict",
    );
    expect(value.values.puts).toHaveLength(1);
    value.snapshots.failCreateWithoutRecord = false;

    const changed = input({ expiresAt: laterExpiry });
    expect(ids(changed).completedPrefixValueId)
      .toBe(ids(inputValue).completedPrefixValueId);
    expect(ids(changed).completedPrefixSnapshotId)
      .toBe(ids(inputValue).completedPrefixSnapshotId);
    expect(ids(changed).operationId).not.toBe(ids(inputValue).operationId);
    await expectMaterializerError(
      value.materializer.materialize(changed),
      "conflict",
    );
    expect(value.snapshots.creates).toHaveLength(1);
  });

  test("reports explicit capacity overflow and rejects noncanonical order", async () => {
    const oversized = input({
      completedPrefix: Array.from({ length: 17 }, (_, ordinal) => ({
        ordinal,
        itemClass: "userMessage" as const,
        text: "x".repeat(HARNESS_MAX_COMPLETED_PREFIX_ITEM_UTF8_BYTES),
      })),
    });
    expect(oversized.completedPrefix.reduce(
      (total, item) => total + Buffer.byteLength(item.text, "utf8"),
      0,
    )).toBeGreaterThan(HARNESS_MAX_COMPLETED_PREFIX_SOURCE_UTF8_BYTES);
    const capacity = fixture(oversized);
    await expectMaterializerError(
      capacity.materializer.materialize(oversized),
      "capacity_exceeded",
    );
    expect(capacity.values.puts).toHaveLength(0);
    expect(capacity.snapshots.creates).toHaveLength(0);

    const outOfOrder = input({
      completedPrefix: [
        { ordinal: 2, itemClass: "userMessage", text: "two" },
        { ordinal: 2, itemClass: "assistantMessage", text: "duplicate" },
      ],
    });
    const order = fixture(outOfOrder);
    await expectMaterializerError(
      order.materializer.materialize(outOfOrder),
      "invalid_input",
    );
    expect(order.values.opens).toHaveLength(0);

    const malformedText = input({
      completedPrefix: [{
        ordinal: 0,
        itemClass: "userMessage",
        text: "\ud800",
      }],
    });
    const surrogate = fixture(malformedText);
    await expectMaterializerError(
      surrogate.materializer.materialize(malformedText),
      "invalid_input",
    );
    expect(surrogate.values.opens).toHaveLength(0);
  });
});

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}
