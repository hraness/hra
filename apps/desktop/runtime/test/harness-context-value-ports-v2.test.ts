import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  HarnessContextValuePortsV2,
  type HarnessContextValueNameDigestPortV2,
  type HarnessContextValueQuotaPortV2,
  type HarnessEncryptedContextStoreV2Port,
} from "../src/harness/context-value-ports-v2";
import { packCompletedPrefixContainerV2 } from
  "../src/harness/completed-prefix-container-v2";
import type { RlmRuntimeValueIdentity } from "../src/harness/rlm-runtime-v2";

const epochId = "hepoch_value_ports_fixture";
const callerActorId = "hactor_value_ports_caller";
const targetActorId = "hactor_value_ports_target";
const callerTurnId = "hturn_value_ports_caller01";
const targetTurnId = "hturn_value_ports_target01";
const sourceValueId = "ctxval_value_ports_source01";
const quotaLimitBytes = 16 * 1024 * 1024;
const digestA = "a".repeat(64);

interface StoredRecord {
  version: 2;
  operationId: string;
  epochId: string;
  ownerActorId: string;
  sourceTurnId: string | null;
  valueId: string;
  kind: "text" | "json" | "selection" | "agentResult";
  purpose:
    | "heap"
    | "completedPrefix"
    | "currentInput"
    | "agentResult"
    | "proposal"
    | "actorTask"
    | "programSource"
    | "programResult";
  schemaVersion: 1;
  nameDigest: string | null;
  utf8Bytes: number;
  contentDigest: string;
  quotaLimitBytes: number;
  state: "active";
}

interface PutCommand extends Omit<StoredRecord,
  "utf8Bytes" | "contentDigest" | "state"
> {
  plaintext: string;
}

class MemoryStore implements HarnessEncryptedContextStoreV2Port {
  readonly commands: PutCommand[] = [];
  readonly records = new Map<string, StoredRecord>();
  readonly plaintext = new Map<string, string>();
  corruptListOrder = false;
  corruptRangeLength = false;

  async seed(input: PutCommand): Promise<void> {
    await this.put(input);
  }

  put(inputValue: unknown): Promise<unknown> {
    const input = structuredClone(inputValue) as PutCommand;
    const previous = this.records.get(input.valueId);
    if (previous !== undefined) {
      const previousPlaintext = this.plaintext.get(input.valueId)!;
      if (canonical({ ...previous, plaintext: previousPlaintext }) !==
          canonical({
            ...input,
            utf8Bytes: Buffer.byteLength(input.plaintext, "utf8"),
            contentDigest: digest(input.plaintext),
            state: "active",
          })) return Promise.reject(new Error("immutable conflict"));
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
      utf8Bytes: Buffer.byteLength(input.plaintext, "utf8"),
      contentDigest: digest(input.plaintext),
      quotaLimitBytes: input.quotaLimitBytes,
      state: "active",
    };
    this.commands.push(input);
    this.records.set(record.valueId, record);
    this.plaintext.set(record.valueId, input.plaintext);
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
    if (record === undefined || record.epochId !== input.epochId ||
        record.ownerActorId !== input.ownerActorId ||
        record.sourceTurnId !== input.sourceTurnId) {
      return Promise.reject(new Error("missing"));
    }
    return Promise.resolve({
      plaintext: this.plaintext.get(record.valueId),
      value: record,
    });
  }

  list(inputValue: unknown): Promise<unknown> {
    const input = inputValue as Readonly<{
      epochId: string;
      afterValueId: string | null;
      limit: number;
    }>;
    const values = [...this.records.values()]
      .filter((value) => value.epochId === input.epochId &&
        (input.afterValueId === null || value.valueId > input.afterValueId))
      .sort((left, right) => left.valueId.localeCompare(right.valueId))
      .slice(0, input.limit);
    return Promise.resolve(this.corruptListOrder ? values.toReversed() : values);
  }

  async withRangeReader<Result>(
    inputValue: unknown,
    operation: (reader: Readonly<{
      value: unknown;
      readRange(input: unknown): Promise<Uint8Array>;
    }>) => Promise<Result> | Result,
  ): Promise<Result> {
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
    ) throw new Error("missing");
    const bytes = Buffer.from(plaintext, "utf8");
    return await operation(Object.freeze({
      value: record,
      readRange: (rangeValue: unknown) => {
        const range = rangeValue as Readonly<{
          startByte: number;
          endByteExclusive: number;
        }>;
        const selected = Uint8Array.from(bytes.subarray(
          range.startByte,
          range.endByteExclusive,
        ));
        return Promise.resolve(this.corruptRangeLength
          ? Uint8Array.from([...selected, 0])
          : selected);
      },
    }));
  }
}

async function seed(
  store: MemoryStore,
  input: Partial<PutCommand> & Pick<PutCommand, "valueId" | "plaintext">,
): Promise<void> {
  const { valueId, plaintext, ...overrides } = input;
  await store.seed({
    version: 2,
    operationId: `contextop_${digest(valueId)}`,
    epochId,
    ownerActorId: callerActorId,
    sourceTurnId: callerTurnId,
    valueId,
    kind: "text",
    purpose: "currentInput",
    schemaVersion: 1,
    nameDigest: null,
    quotaLimitBytes,
    plaintext,
    ...overrides,
  });
}

describe("v2 encrypted context-value production ports", () => {
  test("copies one exact caller value into a provider-neutral actor task", async () => {
    const store = new MemoryStore();
    await seed(store, { valueId: sourceValueId, plaintext: "Inspect the exact tree." });
    const ports = new HarnessContextValuePortsV2(store);

    const first = await ports.prepareActorInput({
      epochId,
      callerActorId,
      targetActorId,
      turnId: targetTurnId,
      sourceValueId,
    });
    const replay = await ports.prepareActorInput({
      epochId,
      callerActorId,
      targetActorId,
      turnId: targetTurnId,
      sourceValueId,
    });

    expect(replay).toEqual(first);
    const valueId = (first as { valueId: string }).valueId;
    expect(await ports.readInput({ epochId, actorId: targetActorId, turnId: targetTurnId,
      valueId })).toBe("Inspect the exact tree.");
    expect(store.records.get(valueId)).toMatchObject({
      ownerActorId: targetActorId,
      sourceTurnId: targetTurnId,
      kind: "text",
      purpose: "actorTask",
    });
    expect(JSON.stringify(store.commands)).not.toMatch(/provider|generation|threadId/u);
  });

  test("publishes an exact actor result and renderer opens only that result kind", async () => {
    const store = new MemoryStore();
    await seed(store, {
      valueId: "ctxval_value_ports_target_input",
      ownerActorId: targetActorId,
      sourceTurnId: targetTurnId,
      purpose: "actorTask",
      plaintext: "Work",
    });
    const ports = new HarnessContextValuePortsV2(store);
    const resultValueId = await ports.putResult({
      operationId: `actorresult_${"b".repeat(64)}`,
      epochId,
      actorId: targetActorId,
      turnId: targetTurnId,
      plaintext: "Finished with evidence.",
    }) as string;

    expect(await ports.assertResultAvailable({
      epochId,
      actorId: targetActorId,
      turnId: targetTurnId,
      valueId: resultValueId,
    })).toBeUndefined();
    expect(await ports.readActorResponse({
      epochId,
      actorId: targetActorId,
      turnId: targetTurnId,
      valueId: resultValueId,
    })).toBe("Finished with evidence.");
    store.records.get(resultValueId)!.purpose = "actorTask";
    expect(await rejection(ports.readActorResponse({ epochId, actorId: targetActorId,
      turnId: targetTurnId, valueId: resultValueId }))).toMatchObject({
        code: "identity_conflict",
      });
  });

  test("round trips canonical proposal JSON through its exact source turn", async () => {
    const store = new MemoryStore();
    const ports = new HarnessContextValuePortsV2(store);
    const valueId = "ctxval_value_ports_proposal";
    const plaintext = "{\"instruction\":\"Prefer exact slices\"}";

    await ports.put({
      operationId: `proposalbody_${"c".repeat(64)}`,
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId,
      kind: "json",
      purpose: "proposal",
      plaintext,
      quotaLimitBytes,
    });
    expect(await ports.get({ epochId, ownerActorId: callerActorId, valueId }))
      .toEqual({ plaintext });
    expect(await ports.get({
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId,
    })).toEqual({ plaintext });

    store.records.get(valueId)!.sourceTurnId = null;
    expect(await rejection(ports.get({ epochId, ownerActorId: callerActorId, valueId })))
      .toMatchObject({ code: "identity_conflict" });
  });

  test("seals RLM JSON with exact public identity and content digests", async () => {
    const store = new MemoryStore();
    const quotas: HarnessContextValueQuotaPortV2 = {
      resolveQuotaLimit: () => Promise.resolve(quotaLimitBytes),
    };
    const ports = new HarnessContextValuePortsV2(store, null, quotas);
    const identity: RlmRuntimeValueIdentity = {
      version: 2,
      role: "programSource",
      epochId,
      actorId: callerActorId,
      turnId: callerTurnId,
      runId: "rlmrun_value_ports_fixture",
      programDigest: digestA,
      receiptId: null,
      nodePath: null,
      operation: null,
      requestDigest: null,
    };
    const identityDigest = digest(canonical({
      domain: "oprte.rlm.encrypted-value-identity.v2",
      ...identity,
    }));
    const value = { steps: [], version: 2 };
    const contentDigest = digest(canonical(value));
    const sealed = await ports.sealJson({
      operationId: `rlmvalue_${"d".repeat(64)}`,
      identity,
      identityDigest,
      contentDigest,
      value,
    }) as { valueId: string };

    expect(await ports.openJson({
      valueId: sealed.valueId,
      expectedIdentity: identity,
      expectedIdentityDigest: identityDigest,
      expectedContentDigest: contentDigest,
    })).toEqual({ valueId: sealed.valueId, identityDigest, contentDigest, value });
    expect(await rejection(ports.openJson({
      valueId: sealed.valueId,
      expectedIdentity: { ...identity, programDigest: "e".repeat(64) },
      expectedIdentityDigest: identityDigest,
      expectedContentDigest: contentDigest,
    }))).toMatchObject({ code: "identity_conflict" });
  });

  test("generic operations delegate named heap identity and list only one actor", async () => {
    const store = new MemoryStore();
    await seed(store, { valueId: sourceValueId, plaintext: "Input" });
    const names: HarnessContextValueNameDigestPortV2 = {
      digestName: ({ epochId: epoch, ownerActorId, name }) => Promise.resolve(
        digest(`keyed\0${epoch}\0${ownerActorId}\0${name}`),
      ),
    };
    const ports = new HarnessContextValuePortsV2(store, names);
    const valueId = "ctxval_value_ports_named_heap";
    const written = await ports.putExact({
      operationId: `heapvalue_${"f".repeat(64)}`,
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId,
      kind: "json",
      purpose: "heap",
      plaintext: "{\"answer\":42}",
      quotaLimitBytes,
      name: "answer",
    });

    expect(written.value.nameDigest).toBe(
      digest(`keyed\0${epochId}\0${callerActorId}\0answer`),
    );
    expect(await ports.openExact({ epochId, ownerActorId: callerActorId,
      sourceTurnId: callerTurnId, valueId, kind: "json", purpose: "heap" }))
      .toMatchObject({ plaintext: "{\"answer\":42}" });
    const listed = await ports.listActive({
      epochId,
      ownerActorId: callerActorId,
      limit: 8,
    });
    expect(listed.map((item) => item.valueId)).toContain(valueId);
    expect(listed.every((item) => item.ownerActorId === callerActorId)).toBeTrue();

    const selectionValueId = "ctxval_value_ports_heap_selection";
    const selectionPlaintext = "alpha\0🙂omega";
    const selection = await ports.putExact({
      operationId: `heapvalue_${"8".repeat(64)}`,
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId: selectionValueId,
      kind: "selection",
      purpose: "heap",
      plaintext: selectionPlaintext,
      quotaLimitBytes,
    });
    expect(selection.value).toMatchObject({
      utf8Bytes: Buffer.byteLength(selectionPlaintext, "utf8"),
      quotaLimitBytes,
    });
    expect(store.records.get(selectionValueId)).toMatchObject({
      contentDigest: digest(selectionPlaintext),
      utf8Bytes: Buffer.byteLength(selectionPlaintext, "utf8"),
      quotaLimitBytes,
    });
    expect(await ports.openExact({
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId: selectionValueId,
      kind: "selection",
      purpose: "heap",
    })).toMatchObject({ plaintext: selectionPlaintext });
    expect(await ports.putExact({
      operationId: `heapvalue_${"8".repeat(64)}`,
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId: selectionValueId,
      kind: "selection",
      purpose: "heap",
      plaintext: selectionPlaintext,
      quotaLimitBytes,
    })).toEqual(selection);
    expect(store.commands.filter(({ valueId: storedValueId }) =>
      storedValueId === selectionValueId
    )).toHaveLength(1);
    expect(await rejection(ports.putExact({
      operationId: `heapvalue_${"8".repeat(64)}`,
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId: selectionValueId,
      kind: "selection",
      purpose: "heap",
      plaintext: selectionPlaintext.replace("\0", ""),
      quotaLimitBytes,
    }))).toBeInstanceOf(Error);
  });

  test("keeps NUL confined to heap selections and rejects malformed text identities", async () => {
    const store = new MemoryStore();
    let nameDigestCalls = 0;
    const names: HarnessContextValueNameDigestPortV2 = {
      digestName: ({ name }) => {
        nameDigestCalls += 1;
        return Promise.resolve(digest(name));
      },
    };
    const ports = new HarnessContextValuePortsV2(store, names);
    const base = {
      operationId: `heapvalue_${"7".repeat(64)}`,
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId: "ctxval_value_ports_invalid_text",
      kind: "selection" as const,
      purpose: "heap" as const,
      plaintext: "safe",
      quotaLimitBytes,
    };

    expect(await rejection(ports.putExact({
      ...base,
      plaintext: "unpaired\ud800surrogate",
    }))).toBeInstanceOf(Error);
    expect(await rejection(ports.putExact({
      ...base,
      kind: "text",
      plaintext: "ordinary\0heap text",
    }))).toBeInstanceOf(Error);
    expect(await rejection(ports.putExact({
      ...base,
      name: "bad\0name",
    }))).toBeInstanceOf(Error);
    expect(await rejection(ports.putExact({
      ...base,
      operationId: `${base.operationId}\0`,
    }))).toBeInstanceOf(Error);
    expect(await rejection(ports.putExact({
      ...base,
      valueId: `${base.valueId}\0`,
    }))).toBeInstanceOf(Error);
    expect(await rejection(ports.putExact({
      ...base,
      quotaLimitBytes: 1024 * 1024 + 1,
    }))).toBeInstanceOf(Error);
    expect(await rejection(ports.putExact({
      ...base,
      plaintext: "x".repeat(1024 * 1024 + 1),
    }))).toBeInstanceOf(Error);
    expect(nameDigestCalls).toBe(0);
    expect(store.commands).toEqual([]);
  });

  test("range-opens only indexed completed prefixes and forbids eager open", async () => {
    const store = new MemoryStore();
    const packed = packCompletedPrefixContainerV2({
      coverageWitnessDigest: digestA,
      completedThroughTurnId: callerTurnId,
      items: [{ ordinal: 0, itemClass: "userMessage", text: "alpha\0🙂" }],
    });
    const valueId = "ctxval_value_ports_completed_prefix";
    const ports = new HarnessContextValuePortsV2(store);
    await ports.putExact({
      operationId: `contextop_${digest(valueId)}`,
      epochId,
      ownerActorId: callerActorId,
      valueId,
      sourceTurnId: callerTurnId,
      kind: "selection",
      purpose: "completedPrefix",
      quotaLimitBytes: 64 * 1024 * 1024,
      plaintext: packed.plaintext,
    });
    expect(await rejection(ports.openExact({
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId,
      kind: "selection",
      purpose: "completedPrefix",
    }))).toMatchObject({ code: "identity_conflict" });
    const selected = await ports.withExactRangeReader({
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId,
      kind: "selection",
      purpose: "completedPrefix",
    }, async (reader) => {
      expect(reader.value).toMatchObject({
        kind: "selection",
        purpose: "completedPrefix",
        utf8Bytes: packed.index.totalUtf8Bytes,
      });
      return await reader.readRange({
        startByte: packed.index.payloadOffset,
        endByteExclusive: packed.index.totalUtf8Bytes,
      });
    });
    expect(Buffer.from(selected).toString("utf8")).toBe("alpha\0🙂");

    store.corruptRangeLength = true;
    expect(await rejection(ports.withExactRangeReader({
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId,
      kind: "selection",
      purpose: "completedPrefix",
    }, async (reader) => await reader.readRange({
      startByte: 0,
      endByteExclusive: 1,
    })))).toMatchObject({ code: "corrupt_store" });
  });

  test("fails closed on malformed ordering and on unkeyed named writes", async () => {
    const store = new MemoryStore();
    await seed(store, { valueId: "ctxval_value_ports_order_a", plaintext: "A" });
    await seed(store, { valueId: "ctxval_value_ports_order_b", plaintext: "B" });
    store.corruptListOrder = true;
    const ports = new HarnessContextValuePortsV2(store);
    expect(await rejection(ports.listActive({
      epochId,
      ownerActorId: callerActorId,
      limit: 8,
    }))).toMatchObject({ code: "corrupt_store" });

    store.corruptListOrder = false;
    expect(await rejection(ports.putExact({
      operationId: `heapvalue_${"9".repeat(64)}`,
      epochId,
      ownerActorId: callerActorId,
      sourceTurnId: callerTurnId,
      valueId: "ctxval_value_ports_unkeyed",
      kind: "text",
      purpose: "heap",
      plaintext: "secret",
      quotaLimitBytes,
      name: "secret",
    }))).toMatchObject({ code: "identity_conflict" });
  });
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected promise to reject");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}
