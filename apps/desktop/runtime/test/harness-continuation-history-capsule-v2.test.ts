import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import {
  assertAsyncProperty,
  fc,
  propertyParameters,
} from "@hra-internal/test";

import {
  HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEMS,
  HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEM_UTF8_BYTES,
  HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_UTF8_BYTES,
  HarnessContextValuePortsV2,
  type HarnessActorContinuationHistoryItemV2,
  type HarnessContextValueQuotaPortV2,
  type HarnessEncryptedContextStoreV2Port,
} from "../src/harness/context-value-ports-v2";
import { parseCompletedPrefixContainerV2 } from
  "../src/harness/completed-prefix-container-v2";

const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;
const epochId = "hepoch_history_capsule_fixture";
const actorId = "hactor_history_capsule_fixture";
const actorTurnId = "hturn_history_capsule_fixture";
const sourceAttemptId = "hattempt_history_capsule_source";
const quotaLimitBytes = 64 * 1024 * 1024;

interface PutCommand {
  readonly version: 2;
  readonly operationId: string;
  readonly epochId: string;
  readonly ownerActorId: string;
  readonly sourceTurnId: string | null;
  readonly valueId: string;
  readonly kind: "text" | "json" | "selection" | "agentResult";
  readonly purpose:
    | "heap"
    | "completedPrefix"
    | "currentInput"
    | "agentResult"
    | "proposal"
    | "actorTask"
    | "programSource"
    | "programResult";
  readonly schemaVersion: 1;
  readonly nameDigest: string | null;
  readonly plaintext: string;
  readonly quotaLimitBytes: number;
}

interface StoredRecord extends Omit<PutCommand, "plaintext"> {
  utf8Bytes: number;
  contentDigest: string;
  state: "active";
}

class CapsuleMemoryStore implements HarnessEncryptedContextStoreV2Port {
  readonly commands: PutCommand[] = [];
  readonly putAttempts: PutCommand[] = [];
  readonly records = new Map<string, StoredRecord>();
  readonly plaintext = new Map<string, string>();

  put(inputValue: unknown): Promise<unknown> {
    const input = inputValue as PutCommand;
    this.putAttempts.push(input);
    const previous = this.records.get(input.valueId);
    if (previous !== undefined) {
      const priorCommand = this.commands.find(({ valueId }) =>
        valueId === input.valueId
      );
      if (priorCommand === undefined || !samePut(priorCommand, input)) {
        return Promise.reject(new Error("immutable conflict"));
      }
      return Promise.resolve({ publication: "existing", value: previous });
    }
    const record: StoredRecord = {
      version: 2,
      operationId: input.operationId,
      epochId: input.epochId,
      ownerActorId: input.ownerActorId,
      sourceTurnId: input.sourceTurnId,
      valueId: input.valueId,
      kind: input.kind,
      purpose: input.purpose,
      schemaVersion: 1,
      nameDigest: input.nameDigest,
      quotaLimitBytes: input.quotaLimitBytes,
      utf8Bytes: Buffer.byteLength(input.plaintext, "utf8"),
      contentDigest: sha256(input.plaintext),
      state: "active",
    };
    this.commands.push(input);
    this.records.set(input.valueId, record);
    this.plaintext.set(input.valueId, input.plaintext);
    return Promise.resolve({ publication: "created", value: record });
  }

  get(inputValue: unknown): Promise<unknown> {
    const input = inputValue as Readonly<{
      epochId: string;
      ownerActorId: string;
      sourceTurnId: string | null;
      valueId: string;
    }>;
    const record = this.records.get(input.valueId);
    const plaintext = this.plaintext.get(input.valueId);
    if (
      record === undefined || plaintext === undefined ||
      record.epochId !== input.epochId ||
      record.ownerActorId !== input.ownerActorId ||
      record.sourceTurnId !== input.sourceTurnId
    ) return Promise.reject(new Error("missing"));
    return Promise.resolve({ plaintext, value: record });
  }

  list(inputValue: unknown): Promise<unknown> {
    const input = inputValue as Readonly<{
      epochId: string;
      afterValueId: string | null;
      limit: number;
    }>;
    return Promise.resolve([...this.records.values()]
      .filter((record) => record.epochId === input.epochId &&
        (input.afterValueId === null || record.valueId > input.afterValueId))
      .toSorted((left, right) => left.valueId.localeCompare(right.valueId))
      .slice(0, input.limit));
  }

  async withRangeReader<Result>(
    inputValue: unknown,
    operation: (reader: Readonly<{
      value: unknown;
      readRange(input: unknown): Promise<Uint8Array>;
    }>) => Promise<Result> | Result,
  ): Promise<Result> {
    const input = inputValue as Readonly<{ valueId: string }>;
    const record = this.records.get(input.valueId);
    const plaintext = this.plaintext.get(input.valueId);
    if (record === undefined || plaintext === undefined) throw new Error("missing");
    const bytes = Buffer.from(plaintext, "utf8");
    try {
      return await operation(Object.freeze({
        value: record,
        readRange: (rangeValue: unknown) => {
          const range = rangeValue as Readonly<{
            startByte: number;
            endByteExclusive: number;
          }>;
          return Promise.resolve(Uint8Array.from(bytes.subarray(
            range.startByte,
            range.endByteExclusive,
          )));
        },
      }));
    } finally {
      bytes.fill(0);
    }
  }
}

function fixture(
  items: readonly HarnessActorContinuationHistoryItemV2[],
  overrides: Readonly<Partial<{
    epochId: string;
    actorId: string;
    actorTurnId: string;
    sourceAttemptId: string;
  }>> = {},
) {
  return {
    epochId,
    actorId,
    actorTurnId,
    sourceAttemptId,
    historyDigest: historyDigest(items),
    items,
    ...overrides,
  } as const;
}

function ports(store: CapsuleMemoryStore) {
  const quotaCalls: Array<Readonly<{ epochId: string; ownerActorId: string }>> = [];
  const quotas: HarnessContextValueQuotaPortV2 = {
    resolveQuotaLimit: (input) => {
      quotaCalls.push(input);
      return Promise.resolve(quotaLimitBytes);
    },
  };
  return {
    ports: new HarnessContextValuePortsV2(store, null, quotas),
    quotaCalls,
  };
}

describe("encrypted actor continuation-history capsules", () => {
  test("publishes idempotently and reopens exact history after restart", async () => {
    const store = new CapsuleMemoryStore();
    const firstProcess = ports(store);
    const items = Object.freeze([
      Object.freeze({ role: "user" as const, text: "Inspect λ exactly." }),
      Object.freeze({ role: "assistant" as const, text: "Verified 🙂" }),
    ]);

    const first = await firstProcess.ports.putActorContinuationHistoryCapsule(
      fixture(items),
    );
    const replay = await firstProcess.ports.putActorContinuationHistoryCapsule(
      fixture(items),
    );
    const restarted = ports(store);
    const opened = await restarted.ports.readActorContinuationHistoryCapsule({
      handle: first,
    });

    expect(replay).toEqual(first);
    expect(opened).toMatchObject({
      handle: first,
      historyDigest: historyDigest(items),
      itemCount: items.length,
      historyUtf8Bytes: Buffer.byteLength(items[0]!.text + items[1]!.text, "utf8"),
      items,
    });
    expect(Object.isFrozen(first)).toBeTrue();
    expect(Object.isFrozen(opened.items)).toBeTrue();
    expect(store.commands).toHaveLength(1);
    expect(firstProcess.quotaCalls).toEqual([
      { epochId, ownerActorId: actorId },
      { epochId, ownerActorId: actorId },
    ]);
    const command = store.commands[0]!;
    const packed = parseCompletedPrefixContainerV2(command.plaintext);
    expect(command).toMatchObject({
      epochId,
      ownerActorId: actorId,
      sourceTurnId: actorTurnId,
      kind: "selection",
      purpose: "completedPrefix",
      quotaLimitBytes,
    });
    expect(packed.index).toMatchObject({
      coverageWitnessDigest: historyDigest(items),
      completedThroughTurnId: actorTurnId,
      sourceUtf8Bytes: Buffer.byteLength(items[0]!.text + items[1]!.text, "utf8"),
    });
    expect(packed.items.map(({ ordinal, itemClass, text }) => ({
      ordinal,
      itemClass,
      text,
    }))).toEqual([
      { ordinal: 0, itemClass: "userMessage", text: items[0]!.text },
      { ordinal: 1, itemClass: "assistantMessage", text: items[1]!.text },
    ]);
  });

  test("derives immutable identities only from OPRTE lineage", async () => {
    const store = new CapsuleMemoryStore();
    const runtime = ports(store).ports;
    const firstItems = [{ role: "user" as const, text: "First history" }];
    const secondItems = [{ role: "assistant" as const, text: "Different text" }];
    const first = await runtime.putActorContinuationHistoryCapsule(
      fixture(firstItems),
    );

    expect(await rejection(runtime.putActorContinuationHistoryCapsule(
      fixture(secondItems),
    ))).toBeInstanceOf(Error);
    expect(store.putAttempts).toHaveLength(2);
    expect(store.putAttempts[1]).toMatchObject({
      operationId: store.putAttempts[0]!.operationId,
      valueId: store.putAttempts[0]!.valueId,
    });

    const alternate = await runtime.putActorContinuationHistoryCapsule(fixture(
      firstItems,
      { sourceAttemptId: "hattempt_history_capsule_other" },
    ));
    expect(alternate.valueId).not.toBe(first.valueId);
    expect(store.commands[1]!.operationId).not.toBe(store.commands[0]!.operationId);

    const beforeInvalid = store.putAttempts.length;
    const providerBearingInput = {
      ...fixture(firstItems),
      accountProfileId: "account_must_not_cross_boundary",
    };
    expect(await rejection(runtime.putActorContinuationHistoryCapsule(
      providerBearingInput,
    ))).toBeInstanceOf(Error);
    expect(store.putAttempts).toHaveLength(beforeInvalid);
    const durableMetadata = JSON.stringify({
      handle: first,
      record: store.records.get(first.valueId),
    });
    expect(durableMetadata).not.toMatch(
      /accountProfile|processGeneration|providerThread|providerTurn|clientUserMessage/u,
    );
  });

  test("fails closed on ciphertext, metadata, handle, and canonical-form drift", async () => {
    const items = [{ role: "user" as const, text: "alpha" }];

    const ciphertextStore = new CapsuleMemoryStore();
    const ciphertextRuntime = ports(ciphertextStore).ports;
    const ciphertextHandle = await ciphertextRuntime
      .putActorContinuationHistoryCapsule(fixture(items));
    ciphertextStore.plaintext.set(
      ciphertextHandle.valueId,
      ciphertextStore.plaintext.get(ciphertextHandle.valueId)!.replace("alpha", "omega"),
    );
    expect(await rejection(ciphertextRuntime.readActorContinuationHistoryCapsule({
      handle: ciphertextHandle,
    }))).toMatchObject({ code: "corrupt_store" });

    const coordinatedStore = new CapsuleMemoryStore();
    const coordinatedRuntime = ports(coordinatedStore).ports;
    const coordinatedHandle = await coordinatedRuntime
      .putActorContinuationHistoryCapsule(fixture(items));
    const changed = coordinatedStore.plaintext
      .get(coordinatedHandle.valueId)!.replace("alpha", "omega");
    coordinatedStore.plaintext.set(coordinatedHandle.valueId, changed);
    coordinatedStore.records.get(coordinatedHandle.valueId)!.contentDigest =
      sha256(changed);
    expect(await rejection(coordinatedRuntime.readActorContinuationHistoryCapsule({
      handle: coordinatedHandle,
    }))).toMatchObject({ code: "identity_conflict" });

    expect(await rejection(coordinatedRuntime.readActorContinuationHistoryCapsule({
      handle: {
        ...coordinatedHandle,
        sourceAttemptId: "hattempt_history_capsule_other",
      },
    }))).toMatchObject({ code: "identity_conflict" });
    const noncanonicalHandleInput = {
      handle: { ...coordinatedHandle, itemCount: 2 },
    };
    expect(await rejection(coordinatedRuntime.readActorContinuationHistoryCapsule(
      noncanonicalHandleInput,
    ))).toBeInstanceOf(Error);
  });

  test("accepts the exact byte maximum and rejects every adjacent overflow", async () => {
    const maximumItem = "x".repeat(
      HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEM_UTF8_BYTES,
    );
    const maximumItems = Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: maximumItem,
    }));
    const store = new CapsuleMemoryStore();
    const runtime = ports(store).ports;
    const handle = await runtime.putActorContinuationHistoryCapsule(
      fixture(maximumItems),
    );
    const maximum = await runtime.readActorContinuationHistoryCapsule({ handle });
    expect(maximum.historyUtf8Bytes).toBe(
      HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_UTF8_BYTES,
    );
    expect(maximum.items).toHaveLength(16);

    const maximumCount = Array.from({
      length: HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEMS,
    }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: "x",
    }));
    const maximumCountHandle = await runtime.putActorContinuationHistoryCapsule(
      fixture(maximumCount, {
        sourceAttemptId: "hattempt_history_capsule_max_count",
      }),
    );
    expect((await runtime.readActorContinuationHistoryCapsule({
      handle: maximumCountHandle,
    })).itemCount).toBe(HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEMS);

    const overTotal = [...maximumItems, {
      role: "user" as const,
      text: "y",
    }];
    expect(await rejection(runtime.putActorContinuationHistoryCapsule(
      fixture(overTotal),
    ))).toBeInstanceOf(Error);
    expect(await rejection(runtime.putActorContinuationHistoryCapsule(fixture([{
      role: "user",
      text: `${maximumItem}y`,
    }])))).toBeInstanceOf(Error);
    const tooMany = Array.from({
      length: HARNESS_ACTOR_CONTINUATION_HISTORY_MAX_ITEMS + 1,
    }, () => ({ role: "user" as const, text: "x" }));
    expect(await rejection(runtime.putActorContinuationHistoryCapsule(
      fixture(tooMany),
    ))).toBeInstanceOf(Error);
    for (const text of ["", "nul\0text", "unpaired\ud800surrogate"]) {
      expect(await rejection(runtime.putActorContinuationHistoryCapsule(fixture([{
        role: "user",
        text,
      }])))).toBeInstanceOf(Error);
    }
  }, 30_000);

  test("arbitrary bounded ordered histories replay and restart exactly", async () => {
    const text = fc.array(fc.oneof(
      fc.string({ minLength: 1, maxLength: 24 }),
      fc.constant("🙂"),
      fc.constant("λ\n"),
    ), { minLength: 1, maxLength: 8 })
      .map((parts) => parts.join(""))
      .filter((value) => !value.includes("\0"));
    await assertAsyncProperty(fc.asyncProperty(
      fc.array(fc.record({
        assistant: fc.boolean(),
        text,
      }), { minLength: 1, maxLength: 32 }),
      async (source) => {
        const items = source.map(({ assistant, text: itemText }) => ({
          role: assistant ? "assistant" as const : "user" as const,
          text: itemText,
        }));
        const store = new CapsuleMemoryStore();
        const first = ports(store).ports;
        const handle = await first.putActorContinuationHistoryCapsule(
          fixture(items),
        );
        expect(await first.putActorContinuationHistoryCapsule(fixture(items)))
          .toEqual(handle);
        const opened = await ports(store).ports
          .readActorContinuationHistoryCapsule({ handle });
        expect(opened.items).toEqual(items);
        expect(opened.itemCount).toBe(items.length);
        expect(opened.historyDigest).toBe(historyDigest(items));
        expect(opened.historyUtf8Bytes).toBe(items.reduce(
          (sum, item) => sum + Buffer.byteLength(item.text, "utf8"),
          0,
        ));
        expect(store.commands).toHaveLength(1);
      },
    ));
  }, PROPERTY_TIMEOUT);
});

function historyDigest(
  items: readonly Readonly<{ role: "user" | "assistant"; text: string }>[],
): string {
  const hash = createHash("sha256");
  hash.update("oprte.harness.actor-continuation-history.v1\0", "utf8");
  for (const item of items) {
    const bytes = Buffer.from(item.text, "utf8");
    try {
      hash.update(item.role, "utf8").update("\0", "utf8")
        .update(String(bytes.byteLength), "utf8").update(":", "utf8")
        .update(bytes).update("\0", "utf8");
    } finally {
      bytes.fill(0);
    }
  }
  return hash.digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function samePut(left: PutCommand, right: PutCommand): boolean {
  return left.version === right.version &&
    left.operationId === right.operationId &&
    left.epochId === right.epochId &&
    left.ownerActorId === right.ownerActorId &&
    left.sourceTurnId === right.sourceTurnId &&
    left.valueId === right.valueId &&
    left.kind === right.kind &&
    left.purpose === right.purpose &&
    left.schemaVersion === right.schemaVersion &&
    left.nameDigest === right.nameDigest &&
    left.plaintext === right.plaintext &&
    left.quotaLimitBytes === right.quotaLimitBytes;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("expected promise to reject");
}
