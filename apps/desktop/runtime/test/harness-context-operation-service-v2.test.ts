import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  RlmV2ContextOperationService,
} from "../src/harness/context-operation-service-v2";
import {
  COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
  packCompletedPrefixContainerV2,
  planCompletedPrefixContainerRangesV2,
} from "../src/harness/completed-prefix-container-v2";
import type {
  HarnessContextOperationRangeReaderV2,
  HarnessContextOperationValuePortV2,
  HarnessContextValueNameDigestPortV2,
} from "../src/harness/context-value-ports-v2";
import type { RlmV2ActorBinding } from "../src/harness/rlm-operation-router-v2";

const now = "2030-01-01T00:00:00.000Z";
const priorTurnId = "hturn_context_previous01";
const binding: RlmV2ActorBinding = {
  epochId: "hepoch_context_service01",
  actorId: "hactor_context_service01",
  turnId: "hturn_context_service001",
  actorDepth: 0,
  completedPrefixSnapshotId: "ctxsnap_context_service01",
  currentUserInputValueId: "ctxval_context_current001",
  contextQuotaBytes: 16 * 1024 * 1024,
};

const items = [
  { ordinal: 1, itemClass: "userMessage" as const, text: "Inspect auth." },
  { ordinal: 2, itemClass: "assistantMessage" as const, text: "Auth uses tokens." },
  { ordinal: 3, itemClass: "userMessage" as const, text: "Inspect tests." },
  { ordinal: 4, itemClass: "userMessage" as const, text: "" },
  {
    ordinal: 7,
    itemClass: "assistantMessage" as const,
    text: "\uFEFFNUL\0🙂",
  },
];
const witness = digest("coverage");
type RangeOpenInput = Parameters<
  HarnessContextOperationValuePortV2["withExactRangeReader"]
>[0];

class Values implements HarnessContextOperationValuePortV2 {
  readonly puts: Parameters<HarnessContextOperationValuePortV2["putExact"]>[0][] = [];
  readonly opens: Parameters<HarnessContextOperationValuePortV2["openExact"]>[0][] = [];
  readonly rangeOpens: RangeOpenInput[] = [];
  readonly rangeReads: Array<Readonly<{
    startByte: number;
    endByteExclusive: number;
  }>> = [];
  readonly completedThroughTurnId: string | null;
  prefix: ReturnType<typeof packCompletedPrefixContainerV2>;
  rangeError: Error | null = null;
  rangeBytesOverride: ((
    range: Readonly<{ startByte: number; endByteExclusive: number }>,
    bytes: Uint8Array,
  ) => Uint8Array) | null = null;
  listOverride: (() => Promise<readonly ReturnType<typeof metadata>[]>) | null = null;

  constructor(completedThroughTurnId: string | null = priorTurnId) {
    this.completedThroughTurnId = completedThroughTurnId;
    this.prefix = packCompletedPrefixContainerV2({
      coverageWitnessDigest: witness,
      completedThroughTurnId,
      items,
    });
  }

  openExact(input: Parameters<HarnessContextOperationValuePortV2["openExact"]>[0]) {
    this.opens.push(input);
    if (input.purpose === "completedPrefix") {
      return Promise.reject(new Error("completed prefixes require range reads"));
    }
    const plaintext = input.valueId === "ctxval_context_named0001"
      ? "named value"
      : input.valueId === "ctxval_context_heap0002"
        ? "{\"two\":2}"
        : "{\"answer\":42}";
    return Promise.resolve(opened({
      valueId: input.valueId,
      sourceTurnId: input.sourceTurnId,
      purpose: "heap",
      kind: input.kind,
      nameDigest: input.valueId === "ctxval_context_named0001"
        ? namedDigest("audit.result")
        : null,
      plaintext,
    }));
  }

  putExact(input: Parameters<HarnessContextOperationValuePortV2["putExact"]>[0]) {
    this.puts.push(input);
    return Promise.resolve({
      value: metadata({
        valueId: input.valueId,
        sourceTurnId: input.sourceTurnId,
        purpose: input.purpose,
        kind: input.kind,
        nameDigest: input.name === null || input.name === undefined
          ? null
          : namedDigest(input.name),
        plaintext: input.plaintext,
      }),
    });
  }

  async withExactRangeReader<Result>(
    input: RangeOpenInput,
    operation: (reader: HarnessContextOperationRangeReaderV2) =>
      Promise<Result> | Result,
  ): Promise<Result> {
    this.rangeOpens.push(input);
    if (
      input.epochId !== binding.epochId ||
      input.ownerActorId !== binding.actorId ||
      input.sourceTurnId !== this.completedThroughTurnId ||
      input.valueId !== "ctxval_context_prefix001" ||
      input.kind !== "selection" ||
      input.purpose !== "completedPrefix"
    ) throw new Error("exact completed prefix is unavailable");
    const plaintext = Buffer.from(this.prefix.plaintext, "utf8");
    let open = true;
    try {
      const reader: HarnessContextOperationRangeReaderV2 = Object.freeze({
        value: metadata({
          valueId: input.valueId,
          sourceTurnId: input.sourceTurnId,
          purpose: "completedPrefix",
          kind: "selection",
          plaintext: this.prefix.plaintext,
        }),
        readRange: (range: Readonly<{
          startByte: number;
          endByteExclusive: number;
        }>) => {
          if (this.rangeError !== null) return Promise.reject(this.rangeError);
          if (
            !open || range.startByte < 0 ||
            range.endByteExclusive < range.startByte ||
            range.endByteExclusive > plaintext.byteLength
          ) return Promise.reject(new Error("invalid or escaped range read"));
          this.rangeReads.push(Object.freeze({ ...range }));
          const bytes = Uint8Array.from(plaintext.subarray(
            range.startByte,
            range.endByteExclusive,
          ));
          return Promise.resolve(this.rangeBytesOverride?.(range, bytes) ?? bytes);
        },
      });
      return await operation(reader);
    } finally {
      open = false;
      plaintext.fill(0);
    }
  }

  withExactActorResultRangeReader<Result>(): Promise<Result> {
    return Promise.reject(new Error("actor-result ranges are outside this fixture"));
  }

  setPrefixWitness(coverageWitnessDigest: string): void {
    this.prefix = packCompletedPrefixContainerV2({
      coverageWitnessDigest,
      completedThroughTurnId: this.completedThroughTurnId,
      items,
    });
  }

  listActive(input: Parameters<HarnessContextOperationValuePortV2["listActive"]>[0]) {
    if (this.listOverride !== null) return this.listOverride();
    return Promise.resolve([
      metadata({
        valueId: "ctxval_context_heap0001",
        sourceTurnId: priorTurnId,
        purpose: "heap",
        kind: "json",
        nameDigest: null,
        plaintext: "{\"answer\":42}",
      }),
      metadata({
        valueId: "ctxval_context_heap0002",
        sourceTurnId: binding.turnId,
        purpose: "heap",
        kind: "json",
        nameDigest: null,
        plaintext: "{\"two\":2}",
      }),
      metadata({
        valueId: binding.currentUserInputValueId!,
        sourceTurnId: binding.turnId,
        purpose: "currentInput",
        kind: "text",
        nameDigest: null,
        plaintext: "Current input stays separate.",
      }),
      metadata({
        valueId: "ctxval_context_named0001",
        sourceTurnId: priorTurnId,
        purpose: "heap",
        kind: "text",
        nameDigest: namedDigest("audit.result"),
        plaintext: "named value",
      }),
    ].filter(({ valueId }) =>
      (input.afterValueId === null || input.afterValueId === undefined ||
        valueId > input.afterValueId) && input.ownerActorId === binding.actorId
    ).toSorted((left, right) => left.valueId.localeCompare(right.valueId))
      .slice(0, input.limit));
  }
}

function fixture(completedThroughTurnId: string | null = priorTurnId) {
  const values = new Values(completedThroughTurnId);
  const names: HarnessContextValueNameDigestPortV2 = {
    digestName: ({ name }) => Promise.resolve(namedDigest(name)),
  };
  const service = new RlmV2ContextOperationService({
    now: () => new Date(now),
    snapshots: {
      read(snapshotId) {
        if (snapshotId !== binding.completedPrefixSnapshotId) return null;
        return {
          id: snapshotId,
          epochId: binding.epochId,
          actorId: binding.actorId,
          completedThroughTurnId,
          coverageWitnessDigest: witness,
          valueId: "ctxval_context_prefix001",
          createdAt: now,
          expiresAt: "2030-01-02T00:00:00.000Z",
        };
      },
    },
    names,
    values,
  });
  return { service, values };
}

function invoke(
  service: RlmV2ContextOperationService,
  operation: Parameters<RlmV2ContextOperationService["invoke"]>[0],
  argumentsValue: Parameters<RlmV2ContextOperationService["invoke"]>[1],
  signal = new AbortController().signal,
) {
  return service.invoke(operation, argumentsValue, {
    binding,
    receiptId: "pop_context_receipt0001",
    signal,
  });
}

describe("RLM v2 context operation service", () => {
  test("returns only exact admitted snapshot and separate current-input handles", async () => {
    const { service, values } = fixture();
    expect(await invoke(service, "context.snapshot", {})).toEqual({
      snapshotId: binding.completedPrefixSnapshotId,
      completedThroughTurnId: priorTurnId,
      coverageWitnessDigest: witness,
      currentInputValueId: binding.currentUserInputValueId,
    });
    expect(values.opens).toEqual([]);
    await expectRejected(invoke(service, "context.snapshot", {
      snapshotId: binding.completedPrefixSnapshotId,
    }));
  });

  test("searches and slices only the admitted completed-prefix witness", async () => {
    const { service, values } = fixture();
    expect(await invoke(service, "context.search", {
      query: "AUTH",
      limit: 1,
    })).toEqual({
      snapshotId: binding.completedPrefixSnapshotId,
      matches: items.slice(0, 1),
    });
    expect(values.opens).toEqual([]);
    expect(values.rangeReads).toEqual(prefixReads(
      values.prefix.index,
      [0],
    ));
    values.rangeReads.splice(0);
    expect(await invoke(service, "context.slice", {
      startOrdinal: 2,
      endOrdinal: 3,
    })).toEqual({
      snapshotId: binding.completedPrefixSnapshotId,
      items: items.slice(1, 3),
    });
    expect(values.rangeReads).toEqual(prefixReads(
      values.prefix.index,
      [1, 2],
    ));
    values.rangeReads.splice(0);
    expect(await invoke(service, "context.slice", {
      startOrdinal: 7,
      endOrdinal: 7,
    })).toEqual({
      snapshotId: binding.completedPrefixSnapshotId,
      items: items.slice(4),
    });
    expect((items[4]!.text)).toBe("\uFEFFNUL\0🙂");
    expect(values.rangeReads).toEqual(prefixReads(
      values.prefix.index,
      [4],
    ));

    values.setPrefixWitness(digest("wrong"));
    await expectRejected(
      invoke(service, "context.search", { query: "auth" }),
      /snapshot witness/i,
    );
    await expectRejected(invoke(service, "context.slice", {
      snapshotId: "ctxsnap_context_foreign01",
      startOrdinal: 0,
      endOrdinal: 1,
    }), /outside its admission/i);
  });

  test("keeps nonempty history when the stable completed-turn anchor is null", async () => {
    const { service, values } = fixture(null);
    expect(await invoke(service, "context.search", {
      query: "auth",
      limit: 1,
    })).toEqual({
      snapshotId: binding.completedPrefixSnapshotId,
      matches: items.slice(0, 1),
    });
    expect(values.rangeOpens[0]?.sourceTurnId).toBeNull();
    expect(values.rangeReads).toEqual(prefixReads(values.prefix.index, [0]));
  });

  test("materializes a canonical bounded selection under receipt identity", async () => {
    const { service, values } = fixture();
    const first = await invoke(service, "context.materialize", {
      ordinals: [3, 1],
      format: "json",
    });
    const firstReads = [...values.rangeReads];
    const replay = await invoke(service, "context.materialize", {
      ordinals: [3, 1],
      format: "json",
    });
    expect(replay).toEqual(first);
    expect(values.puts).toHaveLength(2);
    expect(values.puts[0]).toEqual(values.puts[1]);
    expect(values.puts[0]).toMatchObject({
      epochId: binding.epochId,
      ownerActorId: binding.actorId,
      sourceTurnId: binding.turnId,
      kind: "json",
      purpose: "heap",
      name: null,
      quotaLimitBytes: binding.contextQuotaBytes,
    });
    expect(values.puts[0]?.plaintext).toBe(
      "[{\"itemClass\":\"userMessage\",\"ordinal\":1,\"text\":\"Inspect auth.\"}," +
      "{\"itemClass\":\"userMessage\",\"ordinal\":3,\"text\":\"Inspect tests.\"}]",
    );
    expect(firstReads).toEqual(prefixReads(values.prefix.index, [0, 2]));
    expect(values.rangeReads).toEqual([...firstReads, ...firstReads]);
    await expectRejected(invoke(service, "context.materialize", {
      ordinals: [99],
    }), /unavailable/i);
  });

  test("preserves NUL, Unicode, and sparse selection across an empty item", async () => {
    const { service, values } = fixture();
    await service.invoke("context.materialize", {
      ordinals: [7, 3],
      format: "json",
    }, {
      binding,
      receiptId: "pop_context_receipt0002",
      signal: new AbortController().signal,
    });
    expect(values.puts).toHaveLength(1);
    expect(JSON.parse(values.puts[0]!.plaintext)).toEqual([items[2], items[4]]);
    expect(values.rangeReads).toEqual(prefixReads(values.prefix.index, [2, 4]));

    const empty = fixture();
    await empty.service.invoke("context.materialize", {
      ordinals: [4],
      format: "json",
    }, {
      binding,
      receiptId: "pop_context_receipt0003",
      signal: new AbortController().signal,
    });
    expect(JSON.parse(empty.values.puts[0]!.plaintext)).toEqual([items[3]]);
    expect(empty.values.rangeReads).toEqual(prefixReads(
      empty.values.prefix.index,
      [3],
    ));

    const text = fixture();
    await text.service.invoke("context.materialize", {
      ordinals: [7],
      format: "text",
    }, {
      binding,
      receiptId: "pop_context_receipt0004",
      signal: new AbortController().signal,
    });
    expect(text.values.puts[0]).toMatchObject({
      kind: "selection",
      plaintext: "\uFEFFNUL\0🙂",
    });
    expect(text.values.rangeReads).toEqual(prefixReads(
      text.values.prefix.index,
      [4],
    ));
  });

  test("surfaces authenticated range recovery without eager fallback", async () => {
    const { service, values } = fixture();
    const recovery = Object.assign(new Error("range evidence requires recovery"), {
      code: "recovery_required" as const,
    });
    values.rangeError = recovery;
    let caught: unknown;
    try {
      await invoke(service, "context.search", { query: "auth" });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBe(recovery);
    expect(values.rangeOpens).toHaveLength(1);
    expect(values.rangeReads).toEqual([]);
    expect(values.opens).toEqual([]);
  });

  test("rejects malformed UTF-8 returned by a ranged value port", async () => {
    const { service, values } = fixture();
    const item = values.prefix.index.items[4]!;
    const itemStart = values.prefix.index.payloadOffset + item.utf8Offset;
    values.rangeBytesOverride = (range, bytes) => {
      if (range.startByte !== itemStart) return bytes;
      bytes.fill(0xff);
      return bytes;
    };
    await expectRejected(invoke(service, "context.slice", {
      startOrdinal: 7,
      endOrdinal: 7,
    }), /valid UTF-8/u);
    expect(values.opens).toEqual([]);
  });

  test("puts, gets, and lists durable heap values without provider identity", async () => {
    const { service, values } = fixture();
    const put = await invoke(service, "heap.put", {
      name: "audit.result",
      format: "json",
      value: { z: 1, a: [true, null] },
    });
    expect((put as { valueId: string }).valueId).toMatch(/^ctxval_/u);
    expect(values.puts[0]).toMatchObject({
      name: "audit.result",
      plaintext: "{\"a\":[true,null],\"z\":1}",
    });
    expect(JSON.stringify(values.puts[0])).not.toMatch(
      /provider|account|generation/iu,
    );

    expect(await invoke(service, "heap.get", {
      valueId: "ctxval_context_heap0001",
    })).toMatchObject({ value: { answer: 42 } });
    expect(values.opens.at(-1)).toMatchObject({
      sourceTurnId: priorTurnId,
      kind: "json",
      purpose: "heap",
    });
    expect(await invoke(service, "heap.get", { name: "audit.result" }))
      .toMatchObject({ value: "named value" });
    expect(await invoke(service, "heap.list", {})).toHaveLength(3);
  });

  test("aborts before effects and rejects incoherent heap pages", async () => {
    const { service, values } = fixture();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expectRejected(invoke(service, "heap.put", {
      name: "never",
      value: "never",
      format: "text",
    }, controller.signal), /stop/u);
    expect(values.puts).toHaveLength(0);

    values.listOverride = () => Promise.resolve([
      metadata({
        valueId: "ctxval_context_heap0002",
        sourceTurnId: priorTurnId,
        purpose: "heap",
        kind: "text",
        nameDigest: null,
        plaintext: "two",
      }),
      metadata({
        valueId: "ctxval_context_heap0001",
        sourceTurnId: priorTurnId,
        purpose: "heap",
        kind: "text",
        nameDigest: null,
        plaintext: "one",
      }),
    ]);
    await expectRejected(invoke(service, "heap.list", {}), /order/i);
  });

  test("property: slice preserves strict source order and requested interval", async () => {
    const { service } = fixture();
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 4 }),
      fc.integer({ min: 0, max: 4 }),
      async (left, right) => {
        const startOrdinal = Math.min(left, right);
        const endOrdinal = Math.max(left, right);
        const result = await invoke(service, "context.slice", {
          startOrdinal,
          endOrdinal,
          limit: 64,
        }) as { items: typeof items };
        expect(result.items.map(({ ordinal }) => ordinal).toSorted((a, b) => a - b))
          .toEqual(result.items.map(({ ordinal }) => ordinal));
        expect(result.items.every(({ ordinal }) =>
          ordinal >= startOrdinal && ordinal <= endOrdinal
        )).toBe(true);
      },
    ), { numRuns: 100 });
  });
});

function prefixReads(
  index: typeof Values.prototype.prefix.index,
  itemIndexes: readonly number[],
): Array<Readonly<{
  startByte: number;
  endByteExclusive: number;
}>> {
  return [
    {
      startByte: 0,
      endByteExclusive: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
    },
    {
      startByte: COMPLETED_PREFIX_CONTAINER_V2_PRELUDE_BYTES,
      endByteExclusive: index.payloadOffset,
    },
    ...planCompletedPrefixContainerRangesV2(index, itemIndexes).map((range) => ({
      startByte: range.startByte,
      endByteExclusive: range.endByteExclusive,
    })),
  ];
}

function metadata(input: Readonly<{
  valueId: string;
  sourceTurnId: string | null;
  purpose:
    | "heap"
    | "completedPrefix"
    | "currentInput"
    | "agentResult"
    | "proposal"
    | "actorTask"
    | "programSource"
    | "programResult";
  kind: "text" | "json" | "selection" | "agentResult";
  nameDigest?: string | null;
  plaintext: string;
}>) {
  return {
    valueId: input.valueId,
    epochId: binding.epochId,
    ownerActorId: binding.actorId,
    sourceTurnId: input.sourceTurnId,
    kind: input.kind,
    purpose: input.purpose,
    nameDigest: input.nameDigest ?? null,
    utf8Bytes: Buffer.byteLength(input.plaintext, "utf8"),
    quotaLimitBytes: binding.contextQuotaBytes,
  };
}

function opened(input: Parameters<typeof metadata>[0]) {
  return { value: metadata(input), plaintext: input.plaintext };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function namedDigest(name: string): string {
  return digest(`keyed-name\0${binding.epochId}\0${binding.actorId}\0${name}`);
}

async function expectRejected(
  promise: Promise<unknown>,
  pattern: RegExp = /./u,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(pattern);
}
