import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTEXT_VALUE_CHUNK_BYTES,
  CONTEXT_VALUE_MAX_BYTES,
  COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES,
  COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS,
  ContextValueQuotaExceededError,
  EncryptedContextValueError,
  EncryptedContextValueStore,
  type ContextValueRangeReader,
  type ContextValueMetadataPort,
  type ContextValuePrepareInput,
  type ContextValueRecord,
} from "../src/harness/context-value-store";
import type { HarnessContextKeyProvider } from "../src/harness/key-custody";
import {
  HarnessImmutableObjectStore,
  HarnessObjectStoreError,
  type HarnessObjectPublication,
  type HarnessObjectStorePort,
} from "../src/harness/object-store";
import { prepareHarnessStorageLayout } from "../src/harness/storage-layout";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })
  ));
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

function immutable(value: ContextValueRecord | ContextValuePrepareInput): string {
  return JSON.stringify({
    version: value.version,
    operationId: value.operationId,
    epochId: value.epochId,
    ownerActorId: value.ownerActorId,
    sourceTurnId: value.sourceTurnId,
    valueId: value.valueId,
    kind: value.kind,
    purpose: value.purpose,
    schemaVersion: value.schemaVersion,
    nameDigest: value.nameDigest,
    utf8Bytes: value.utf8Bytes,
    contentDigest: value.contentDigest,
    chunkSize: value.chunkSize,
    chunkCount: value.chunkCount,
    chunks: value.chunks,
    manifestDigest: value.manifestDigest,
    manifestByteLength: value.manifestByteLength,
    quotaLimitBytes: value.quotaLimitBytes,
  });
}

class MemoryContextValueMetadata implements ContextValueMetadataPort {
  readonly operations = new Map<string, ContextValueRecord>();
  readonly values = new Map<string, ContextValueRecord>();
  readonly quota = new Map<string, number>();
  throwAfterEffectTransition = false;
  throwAfterActivation = false;

  prepareContextValue(input: ContextValuePrepareInput): Promise<unknown> {
    const replay = this.operations.get(input.operationId);
    if (replay !== undefined) {
      if (immutable(replay) !== immutable(input)) {
        return Promise.reject(new Error("immutable operation conflict"));
      }
      return Promise.resolve(clone(replay));
    }
    for (const value of this.operations.values()) {
      if (
        value.epochId === input.epochId &&
        value.valueId === input.valueId
      ) return Promise.reject(new Error("immutable value conflict"));
    }
    const next = this.used(input.epochId) + input.utf8Bytes;
    if (next > input.quotaLimitBytes) {
      return Promise.reject(new ContextValueQuotaExceededError());
    }
    this.quota.set(input.epochId, next);
    const record: ContextValueRecord = {
      ...clone(input),
      state: "prepared",
      recoveryReason: null,
      revision: 1,
    };
    this.operations.set(input.operationId, record);
    return Promise.resolve(clone(record));
  }

  markContextValueEffectStarted(input: {
    readonly operationId: string;
    readonly expectedRevision: number;
  }): Promise<unknown> {
    const record = this.require(input.operationId, input.expectedRevision, "prepared");
    const next = this.transition(record, "effectStarted", null);
    if (this.throwAfterEffectTransition) {
      this.throwAfterEffectTransition = false;
      return Promise.reject(new Error("lost effect-start response"));
    }
    return Promise.resolve(clone(next));
  }

  markContextValueReplayRequired(input: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly expectedState: "effectStarted";
  }): Promise<unknown> {
    return Promise.resolve(clone(this.transition(
      this.require(input.operationId, input.expectedRevision, input.expectedState),
      "replayRequired",
      null,
    )));
  }

  activateContextValue(input: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly expectedState: "effectStarted" | "replayRequired";
    readonly manifestDigest: string;
  }): Promise<unknown> {
    const record = this.require(
      input.operationId,
      input.expectedRevision,
      input.expectedState,
    );
    if (record.manifestDigest !== input.manifestDigest) {
      return Promise.reject(new Error("manifest conflict"));
    }
    const next = this.transition(record, "active", null);
    this.values.set(this.key(next), next);
    if (this.throwAfterActivation) {
      this.throwAfterActivation = false;
      return Promise.reject(new Error("lost activation response"));
    }
    return Promise.resolve(clone(next));
  }

  markContextValueRecoveryRequired(input: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly expectedState: "prepared" | "effectStarted" | "replayRequired" | "active";
    readonly reason: ContextValueRecord["recoveryReason"] & string;
  }): Promise<unknown> {
    const record = this.require(
      input.operationId,
      input.expectedRevision,
      input.expectedState,
    );
    const next = this.transition(record, "recoveryRequired", input.reason);
    this.values.delete(this.key(next));
    return Promise.resolve(clone(next));
  }

  readContextValueOperation(operationId: string): Promise<unknown> {
    return Promise.resolve(clone(this.operations.get(operationId) ?? null));
  }

  readActiveContextValue(input: {
    readonly epochId: string;
    readonly ownerActorId: string;
    readonly sourceTurnId: string | null;
    readonly valueId: string;
  }): Promise<unknown> {
    return Promise.resolve(clone(
      this.values.get(this.key(input)) ?? null,
    ));
  }

  listActiveContextValues(input: {
    readonly epochId: string;
    readonly afterValueId: string | null;
    readonly limit: number;
  }): Promise<unknown> {
    return Promise.resolve([...this.values.values()]
      .filter((value) =>
        value.epochId === input.epochId &&
        (input.afterValueId === null || value.valueId > input.afterValueId)
      )
      .sort((left, right) => left.valueId.localeCompare(right.valueId))
      .slice(0, input.limit)
      .map(clone));
  }

  listRecoverableContextValues(input: {
    readonly afterOperationId: string | null;
    readonly limit: number;
  }): Promise<unknown> {
    return Promise.resolve([...this.operations.values()]
      .filter((value) =>
        value.state !== "active" &&
        (input.afterOperationId === null ||
          value.operationId > input.afterOperationId)
      )
      .sort((left, right) => left.operationId.localeCompare(right.operationId))
      .slice(0, input.limit)
      .map(clone));
  }

  used(epochId: string): number {
    return this.quota.get(epochId) ?? 0;
  }

  private require(
    operationId: string,
    revision: number,
    state: ContextValueRecord["state"],
  ): ContextValueRecord {
    const record = this.operations.get(operationId);
    if (
      record === undefined || record.revision !== revision ||
      record.state !== state
    ) throw new Error("stale metadata transition");
    return record;
  }

  private transition(
    record: ContextValueRecord,
    state: ContextValueRecord["state"],
    recoveryReason: ContextValueRecord["recoveryReason"],
  ): ContextValueRecord {
    const next: ContextValueRecord = {
      ...record,
      state,
      recoveryReason,
      revision: record.revision + 1,
    };
    this.operations.set(record.operationId, next);
    return next;
  }

  private key(value: Pick<ContextValueRecord,
    "epochId" | "ownerActorId" | "sourceTurnId" | "valueId"
  >): string {
    return `${value.epochId}\u0000${value.ownerActorId}\u0000${
      value.sourceTurnId ?? ""
    }\u0000${value.valueId}`;
  }
}

const fixedKeys: HarnessContextKeyProvider = {
  async withContextKey<T>(
    _scope: unknown,
    operation: (key: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    const key = new Uint8Array(32).fill(0x71);
    try {
      return await operation(key);
    } finally {
      key.fill(0);
    }
  },
};

class FailAtPublicationStore implements Pick<HarnessObjectStorePort, "publish" | "read"> {
  readonly delegate: Pick<HarnessObjectStorePort, "publish" | "read">;
  readonly failAt: number;
  calls = 0;
  failed = false;

  constructor(
    delegate: Pick<HarnessObjectStorePort, "publish" | "read">,
    failAt: number,
  ) {
    this.delegate = delegate;
    this.failAt = failAt;
  }

  publish(value: unknown): HarnessObjectPublication {
    this.calls += 1;
    if (!this.failed && this.calls === this.failAt) {
      this.failed = true;
      throw new HarnessObjectStoreError("publish_failed");
    }
    return this.delegate.publish(value);
  }

  read(digest: unknown): Uint8Array {
    return this.delegate.read(digest);
  }
}

interface Fixture {
  readonly metadata: MemoryContextValueMetadata;
  readonly objects: HarnessImmutableObjectStore;
  readonly store: EncryptedContextValueStore;
  readonly objectRoot: string;
}

async function fixture(
  wrap?: (
    objectStore: HarnessImmutableObjectStore,
  ) => Pick<HarnessObjectStorePort, "publish" | "read">,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "oprte-context-values-v2-"));
  roots.push(root);
  const support = join(root, "OPRTE");
  await mkdir(support, { mode: 0o700 });
  const controlPlane = join(support, "control-plane.sqlite");
  await writeFile(controlPlane, "sqlite fixture", { mode: 0o600 });
  const layout = prepareHarnessStorageLayout(controlPlane);
  const objects = new HarnessImmutableObjectStore({
    directory: layout.contextValues,
  });
  const metadata = new MemoryContextValueMetadata();
  const store = new EncryptedContextValueStore({
    keys: fixedKeys,
    metadata,
    objects: wrap?.(objects) ?? objects,
  });
  return { metadata, objects, store, objectRoot: layout.contextValues };
}

const epochId = "hepoch_contextvalue001";
const ownerActorId = "hactor_contextvalue001";
const sourceTurnId = null;

const address = (valueId: string) => ({
  epochId,
  ownerActorId,
  sourceTurnId,
  valueId,
});

function command(input: {
  readonly operation?: string;
  readonly value?: string;
  readonly plaintext?: string;
  readonly quota?: number;
  readonly kind?: "text" | "json" | "selection" | "agentResult";
  readonly purpose?: "heap" | "completedPrefix";
}) {
  return {
    version: 2 as const,
    operationId: input.operation ?? "contextop_primary001",
    epochId,
    ownerActorId,
    sourceTurnId,
    valueId: input.value ?? "ctxval_primary001",
    kind: input.kind ?? "text" as const,
    purpose: input.purpose ?? "heap" as const,
    schemaVersion: 1 as const,
    plaintext: input.plaintext ?? "context value",
    quotaLimitBytes: input.quota ?? 1024 * 1024,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("encrypted chunked context values", () => {
  test("accepts the empty and exact 1 MiB boundaries and rejects byte 1,048,577", async () => {
    const empty = await fixture();
    const emptyValue = await empty.store.put(command({ plaintext: "" }));
    expect(emptyValue.value).toMatchObject({
      utf8Bytes: 0,
      chunkCount: 1,
      chunks: [{ ordinal: 0, plaintextBytes: 0 }],
    });
    expect((await empty.store.get(address(emptyValue.value.valueId))).plaintext)
      .toBe("");

    const maximum = await fixture();
    const plaintext = "m".repeat(CONTEXT_VALUE_MAX_BYTES);
    const maximumValue = await maximum.store.put(command({ plaintext }));
    expect(maximumValue.value).toMatchObject({
      utf8Bytes: CONTEXT_VALUE_MAX_BYTES,
      chunkCount: 16,
    });
    expect(maximumValue.value.chunks.every(({ plaintextBytes }) =>
      plaintextBytes === CONTEXT_VALUE_CHUNK_BYTES
    )).toBeTrue();
    expect((await maximum.store.get(address(maximumValue.value.valueId))).plaintext)
      .toBe(plaintext);

    const oversized = await fixture();
    expect(await rejection(oversized.store.put(command({
      plaintext: "o".repeat(CONTEXT_VALUE_MAX_BYTES + 1),
      quota: CONTEXT_VALUE_MAX_BYTES + 1,
    })))).toMatchObject({ code: "invalid_command" });
    expect(oversized.metadata.operations.size).toBe(0);
    expect(await readdir(oversized.objectRoot)).toEqual([]);
  });

  test("admits 18 MiB only for indexed completed-prefix selections", async () => {
    const maximum = await fixture();
    const plaintext = "p".repeat(COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES);
    const result = await maximum.store.put(command({
      operation: "contextop_completedprefix_max01",
      value: "ctxval_completedprefix_max01",
      kind: "selection",
      purpose: "completedPrefix",
      plaintext,
      quota: 64 * 1024 * 1024,
    }));
    expect(result.value).toMatchObject({
      utf8Bytes: COMPLETED_PREFIX_CONTEXT_VALUE_MAX_BYTES,
      chunkCount: COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS,
      kind: "selection",
      purpose: "completedPrefix",
    });
    expect((await maximum.store.get(address(result.value.valueId))).plaintext)
      .toBe(plaintext);

    const wrongKind = await fixture();
    expect(await rejection(wrongKind.store.put(command({
      operation: "contextop_completedprefix_kind01",
      value: "ctxval_completedprefix_kind01",
      purpose: "completedPrefix",
      plaintext: "indexed",
      quota: 64 * 1024 * 1024,
    })))).toMatchObject({ code: "invalid_command" });
    expect(wrongKind.metadata.operations.size).toBe(0);

    const oversized = await fixture();
    expect(await rejection(oversized.store.put(command({
      operation: "contextop_completedprefix_over01",
      value: "ctxval_completedprefix_over01",
      kind: "selection",
      purpose: "completedPrefix",
      plaintext: `${plaintext}x`,
      quota: 64 * 1024 * 1024,
    })))).toMatchObject({ code: "invalid_command" });
    expect(oversized.metadata.operations.size).toBe(0);
  }, 20_000);

  test("publishes 64 KiB chunks, then an encrypted manifest, and exposes only active values", async () => {
    const value = "x".repeat(CONTEXT_VALUE_CHUNK_BYTES * 2 + 17);
    const subject = await fixture();
    const result = await subject.store.put(command({ plaintext: value }));
    expect(result.value).toMatchObject({
      state: "active",
      chunkCount: 3,
      utf8Bytes: value.length,
      purpose: "heap",
    });
    expect(result.value.chunks.map(({ plaintextBytes }) => plaintextBytes)).toEqual([
      CONTEXT_VALUE_CHUNK_BYTES,
      CONTEXT_VALUE_CHUNK_BYTES,
      17,
    ]);
    expect(await readdir(subject.objectRoot)).toHaveLength(4);
    for (const objectName of await readdir(subject.objectRoot)) {
      const object = new TextDecoder().decode(subject.objects.read(objectName));
      expect(object).not.toContain(value.slice(0, 128));
    }
    expect(await subject.store.get(address(result.value.valueId)))
      .toMatchObject({ plaintext: value });
    expect(await subject.store.list({ epochId, limit: 8 })).toEqual([
      result.value,
    ]);
  });

  test("round-trips leading BOM, NUL, and emoji bytes with stable replay identity", async () => {
    const subject = await fixture();
    const plaintext = "\uFEFFalpha\0🙂omega";
    const utf8Bytes = Buffer.byteLength(plaintext, "utf8");
    const input = command({
      operation: "contextop_unicodebytes01",
      value: "ctxval_unicodebytes01",
      kind: "selection",
      plaintext,
    });

    const first = await subject.store.put(input);
    expect(first).toMatchObject({
      publication: "created",
      value: {
        state: "active",
        utf8Bytes,
        chunks: [{ ordinal: 0, plaintextBytes: utf8Bytes }],
      },
    });
    expect(subject.metadata.used(epochId)).toBe(utf8Bytes);
    expect(await subject.store.get(address(input.valueId))).toMatchObject({
      plaintext,
      value: {
        contentDigest: first.value.contentDigest,
        utf8Bytes,
      },
    });

    const immutableIdentity = immutable(first.value);
    const replay = await subject.store.put(input);
    expect(replay).toMatchObject({
      publication: "existing",
      value: { contentDigest: first.value.contentDigest },
    });
    expect(immutable(replay.value)).toBe(immutableIdentity);
    expect(subject.metadata.used(epochId)).toBe(utf8Bytes);
  });

  test("authenticates one manifest and only the chunks intersecting a range", async () => {
    const reads: string[] = [];
    const subject = await fixture((objects) => ({
      publish: (value) => objects.publish(value),
      read: (digestValue) => {
        if (typeof digestValue === "string") reads.push(digestValue);
        return objects.read(digestValue);
      },
    }));
    const plaintext = "r".repeat(CONTEXT_VALUE_CHUNK_BYTES * 3 + 31);
    const result = await subject.store.put(command({ plaintext }));
    reads.length = 0;
    const escapedReaders: ContextValueRangeReader[] = [];
    const selected = await subject.store.withRangeReader(
      address(result.value.valueId),
      async (reader) => {
        escapedReaders.push(reader);
        expect(reader.value).toEqual(result.value);
        return await reader.readRange({
          startByte: CONTEXT_VALUE_CHUNK_BYTES + 7,
          endByteExclusive: CONTEXT_VALUE_CHUNK_BYTES + 19,
        });
      },
    );
    expect(Buffer.from(selected).toString("utf8")).toBe("r".repeat(12));
    expect(reads).toEqual([
      result.value.manifestDigest,
      result.value.chunks[1]!.objectDigest,
    ]);
    const escaped = escapedReaders[0];
    if (escaped === undefined) throw new Error("range reader was not captured");
    expect(await rejection(escaped.readRange({
      startByte: 0,
      endByteExclusive: 1,
    }))).toMatchObject({ code: "invalid_command" });
  });

  test("constructs byte-identical ciphertext and object identities on exact replay", async () => {
    const left = await fixture();
    const right = await fixture();
    const input = command({
      plaintext: "deterministic replay ".repeat(8_000),
    });
    const first = await left.store.put(input);
    const second = await right.store.put(input);
    expect(immutable(first.value)).toBe(immutable(second.value));
    const leftNames = (await readdir(left.objectRoot)).sort();
    const rightNames = (await readdir(right.objectRoot)).sort();
    expect(leftNames).toEqual(rightNames);
    for (const digest of leftNames) {
      expect(left.objects.read(digest)).toEqual(right.objects.read(digest));
    }
    expect(await left.store.put(input)).toMatchObject({
      publication: "existing",
      value: { state: "active" },
    });
  });

  test("keeps a partial effect invisible and quota-reserved until exact replay fills missing objects", async () => {
    const holder: { failing?: FailAtPublicationStore } = {};
    const subject = await fixture((objects) => {
      holder.failing = new FailAtPublicationStore(objects, 2);
      return holder.failing;
    });
    const input = command({
      plaintext: "p".repeat(CONTEXT_VALUE_CHUNK_BYTES + 41),
    });
    expect(await rejection(subject.store.put(input))).toMatchObject({
      code: "replay_required",
    });
    expect(await subject.metadata.readContextValueOperation(input.operationId))
      .toMatchObject({ state: "replayRequired", chunkCount: 2 });
    expect(await subject.metadata.readActiveContextValue(address(input.valueId)))
      .toBeNull();
    expect(await subject.store.scanRecovery({ limit: 8 })).toMatchObject([
      { operationId: input.operationId, state: "replayRequired" },
    ]);
    expect(subject.metadata.used(epochId)).toBe(input.plaintext.length);
    expect(await readdir(subject.objectRoot)).toHaveLength(1);

    const replayed = await subject.store.put(input);
    expect(replayed).toMatchObject({
      publication: "mixed",
      value: { state: "active" },
    });
    expect(holder.failing?.failed).toBeTrue();
    expect(await readdir(subject.objectRoot)).toHaveLength(3);
    expect(subject.metadata.used(epochId)).toBe(input.plaintext.length);
  });

  test("recovers bounded metadata response gaps without blind object replacement", async () => {
    const beforeObjects = await fixture();
    beforeObjects.metadata.throwAfterEffectTransition = true;
    const first = command({
      operation: "contextop_effectgap01",
      value: "ctxval_effectgap01",
    });
    expect(await rejection(beforeObjects.store.put(first))).toMatchObject({
      code: "metadata_ambiguous",
    });
    expect(await beforeObjects.store.recover(first.operationId)).toMatchObject({
      state: "replayRequired",
      value: { state: "replayRequired" },
    });
    expect(await beforeObjects.store.put(first)).toMatchObject({
      value: { state: "active" },
    });

    const afterObjects = await fixture();
    afterObjects.metadata.throwAfterActivation = true;
    const second = command({
      operation: "contextop_activegap01",
      value: "ctxval_activegap01",
    });
    expect(await rejection(afterObjects.store.put(second))).toMatchObject({
      code: "metadata_ambiguous",
    });
    expect(await afterObjects.store.recover(second.operationId)).toMatchObject({
      state: "active",
      value: { state: "active" },
    });
  });

  test("rejects an immutable operation conflict before performing any filesystem effect", async () => {
    const subject = await fixture();
    const first = command({ plaintext: "first immutable input" });
    await subject.store.put(first);
    const objectsBefore = (await readdir(subject.objectRoot)).sort();
    const conflict = { ...first, plaintext: "different immutable input" };
    expect(await rejection(subject.store.put(conflict))).toMatchObject({
      code: "metadata_ambiguous",
    });
    expect((await readdir(subject.objectRoot)).sort()).toEqual(objectsBefore);
    expect(await subject.store.get(address(first.valueId)))
      .toMatchObject({ plaintext: first.plaintext });
  });

  test("fails closed and keeps quota charged after active ciphertext tampering", async () => {
    const subject = await fixture();
    const input = command({ plaintext: "tamper-evident encrypted content" });
    const stored = await subject.store.put(input);
    const firstChunk = stored.value.chunks[0];
    if (firstChunk === undefined) throw new Error("first chunk is missing");
    const target = join(subject.objectRoot, firstChunk.objectDigest);
    await chmod(target, 0o600);
    await writeFile(target, "tampered ciphertext", { mode: 0o600 });
    expect(await rejection(subject.store.get(address(input.valueId))))
      .toMatchObject({ code: "recovery_required" });
    expect(await subject.metadata.readContextValueOperation(input.operationId))
      .toMatchObject({
        state: "recoveryRequired",
        recoveryReason: "immutable_object_conflict",
      });
    expect(subject.metadata.used(epochId)).toBe(input.plaintext.length);
    expect(await subject.metadata.readActiveContextValue(address(input.valueId)))
      .toBeNull();
  });

  test("classifies a missing active object as recovery, never as a fresh publication", async () => {
    const subject = await fixture();
    const input = command({
      operation: "contextop_missing001",
      value: "ctxval_missing001",
      plaintext: "active bytes cannot disappear",
    });
    const stored = await subject.store.put(input);
    subject.objects.remove(stored.value.manifestDigest);
    expect(await rejection(subject.store.put(input))).toMatchObject({
      code: "recovery_required",
    });
    expect(await subject.metadata.readContextValueOperation(input.operationId))
      .toMatchObject({
        state: "recoveryRequired",
        recoveryReason: "object_missing_after_activation",
      });
    expect(subject.metadata.used(epochId)).toBe(input.plaintext.length);
  });

  test("reserves quota atomically and never rearms or releases failed publications", async () => {
    const subject = await fixture();
    const reservedBytes = 600 * 1024;
    const outcomes = await Promise.allSettled([
      subject.store.put(command({
        operation: "contextop_quota00001",
        value: "ctxval_quota00001",
        plaintext: "1".repeat(reservedBytes),
        quota: 1024 * 1024,
      })),
      subject.store.put(command({
        operation: "contextop_quota00002",
        value: "ctxval_quota00002",
        plaintext: "a".repeat(reservedBytes),
        quota: 1024 * 1024,
      })),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find(({ status }) => status === "rejected");
    expect(failure?.status === "rejected" ? failure.reason : null)
      .toBeInstanceOf(ContextValueQuotaExceededError);
    expect(subject.metadata.used(epochId)).toBe(reservedBytes);
    const accepted = outcomes.find(({ status }) => status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("missing accepted value");
    expect(await subject.store.put({
      ...command({
        operation: accepted.value.value.operationId,
        value: accepted.value.value.valueId,
        plaintext: "changed".repeat(90_000),
        quota: 1024 * 1024,
      }),
    }).catch((error: unknown) => error)).toBeInstanceOf(EncryptedContextValueError);
    expect(subject.metadata.used(epochId)).toBe(reservedBytes);
  });

  test("rejects malformed commands and JSON before metadata or filesystem effects", async () => {
    const subject = await fixture();
    expect(await rejection(subject.store.put({
      ...command({}),
      extra: true,
    }))).toMatchObject({ code: "invalid_command" });
    expect(await rejection(subject.store.put(command({
      operation: "contextop_badjson001",
      value: "ctxval_badjson001",
      plaintext: "{bad json}",
      kind: "json",
    })))).toMatchObject({ code: "invalid_command" });
    expect(subject.metadata.operations.size).toBe(0);
    expect(await readdir(subject.objectRoot)).toEqual([]);
  });
});
