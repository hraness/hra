import { expect, test } from "bun:test";
import { assertAsyncProperty, assertProperty, fc, propertyParameters } from "@hra-internal/test";

import {
  CONTEXT_VALUE_CHUNK_BYTES,
  COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS,
  EncryptedContextValueStore,
  contextValueRecordNonce,
  type ContextValueMetadataPort,
  type ContextValuePrepareInput,
  type ContextValueRecord,
} from "../src/harness/context-value-store";
import type { HarnessContextKeyProvider } from "../src/harness/key-custody";
import {
  HarnessObjectStoreError,
  harnessObjectDigest,
  type HarnessObjectPublication,
} from "../src/harness/object-store";

const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;
const epochId = "hepoch_propertyvalue001";
const ownerActorId = "hactor_propertyvalue001";
const sourceTurnId = null;

const keys: HarnessContextKeyProvider = {
  async withContextKey<T>(
    _scope: unknown,
    operation: (key: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    const key = new Uint8Array(32).fill(0x42);
    try {
      return await operation(key);
    } finally {
      key.fill(0);
    }
  },
};

class MemoryObjects {
  readonly values = new Map<string, Uint8Array>();
  failAt: number | null = null;
  calls = 0;
  failed = false;

  publish(value: unknown): HarnessObjectPublication {
    this.calls += 1;
    if (!this.failed && this.failAt === this.calls) {
      this.failed = true;
      throw new HarnessObjectStoreError("publish_failed");
    }
    if (!(value instanceof Uint8Array) || value.byteLength < 1) {
      throw new HarnessObjectStoreError("invalid_object");
    }
    const digest = harnessObjectDigest(value);
    const existing = this.values.get(digest);
    if (existing !== undefined) {
      if (!equal(existing, value)) throw new HarnessObjectStoreError("object_tampered");
      return { digest, byteLength: existing.byteLength, state: "existing" };
    }
    this.values.set(digest, Uint8Array.from(value));
    return { digest, byteLength: value.byteLength, state: "created" };
  }

  read(digestValue: unknown): Uint8Array {
    if (typeof digestValue !== "string") {
      throw new HarnessObjectStoreError("invalid_digest");
    }
    const value = this.values.get(digestValue);
    if (value === undefined) throw new HarnessObjectStoreError("object_missing");
    return Uint8Array.from(value);
  }
}

class SingleValueMetadata implements ContextValueMetadataPort {
  record: ContextValueRecord | null = null;

  prepareContextValue(input: ContextValuePrepareInput): Promise<unknown> {
    if (this.record === null) {
      this.record = {
        ...structuredClone(input),
        state: "prepared",
        recoveryReason: null,
        revision: 1,
      };
    } else if (stableIdentity(this.record) !== stableIdentity(input)) {
      return Promise.reject(new Error("immutable conflict"));
    }
    return Promise.resolve(structuredClone(this.record));
  }

  markContextValueEffectStarted(input: {
    operationId: string;
    expectedRevision: number;
  }): Promise<unknown> {
    return Promise.resolve(this.move(input, "prepared", "effectStarted", null));
  }

  markContextValueReplayRequired(input: {
    operationId: string;
    expectedRevision: number;
    expectedState: "effectStarted";
  }): Promise<unknown> {
    return Promise.resolve(this.move(
      input,
      input.expectedState,
      "replayRequired",
      null,
    ));
  }

  activateContextValue(input: {
    operationId: string;
    expectedRevision: number;
    expectedState: "effectStarted" | "replayRequired";
    manifestDigest: string;
  }): Promise<unknown> {
    if (this.record?.manifestDigest !== input.manifestDigest) {
      return Promise.reject(new Error("manifest conflict"));
    }
    return Promise.resolve(this.move(input, input.expectedState, "active", null));
  }

  markContextValueRecoveryRequired(input: {
    operationId: string;
    expectedRevision: number;
    expectedState: "prepared" | "effectStarted" | "replayRequired" | "active";
    reason: NonNullable<ContextValueRecord["recoveryReason"]>;
  }): Promise<unknown> {
    return Promise.resolve(this.move(
      input,
      input.expectedState,
      "recoveryRequired",
      input.reason,
    ));
  }

  readContextValueOperation(operationId: string): Promise<unknown> {
    void operationId;
    return Promise.resolve(structuredClone(this.record));
  }

  readActiveContextValue(input: {
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string | null;
    valueId: string;
  }): Promise<unknown> {
    const record = this.record;
    return Promise.resolve(record?.state === "active" &&
        record.epochId === input.epochId &&
        record.ownerActorId === input.ownerActorId &&
        record.sourceTurnId === input.sourceTurnId &&
        record.valueId === input.valueId
      ? structuredClone(record)
      : null);
  }

  listActiveContextValues(): Promise<unknown> {
    return Promise.resolve(this.record?.state === "active"
      ? [structuredClone(this.record)]
      : []);
  }

  listRecoverableContextValues(): Promise<unknown> {
    return Promise.resolve(this.record !== null && this.record.state !== "active"
      ? [structuredClone(this.record)]
      : []);
  }

  private move(
    input: { operationId: string; expectedRevision: number },
    from: ContextValueRecord["state"],
    to: ContextValueRecord["state"],
    reason: ContextValueRecord["recoveryReason"],
  ): ContextValueRecord {
    const record = this.record;
    if (
      record === null || record.operationId !== input.operationId ||
      record.revision !== input.expectedRevision || record.state !== from
    ) throw new Error("stale transition");
    this.record = {
      ...record,
      state: to,
      recoveryReason: reason,
      revision: record.revision + 1,
    };
    return structuredClone(this.record);
  }
}

function stableIdentity(value: ContextValueRecord | ContextValuePrepareInput): string {
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

function subject(failAt: number | null = null): {
  readonly store: EncryptedContextValueStore;
  readonly metadata: SingleValueMetadata;
  readonly objects: MemoryObjects;
} {
  const objects = new MemoryObjects();
  objects.failAt = failAt;
  const metadata = new SingleValueMetadata();
  return {
    objects,
    metadata,
    store: new EncryptedContextValueStore({ keys, metadata, objects }),
  };
}

function command(plaintext: string) {
  return {
    version: 2 as const,
    operationId: "contextop_property001",
    epochId,
    ownerActorId,
    sourceTurnId,
    valueId: "ctxval_property001",
    kind: "text" as const,
    purpose: "heap" as const,
    schemaVersion: 1 as const,
    plaintext,
    quotaLimitBytes: 1024 * 1024,
  };
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

test("manifest and every permitted chunk ordinal occupy disjoint nonce domains", () => {
  const encoded = [
    Buffer.from(contextValueRecordNonce("manifest", null)).toString("hex"),
    ...Array.from({ length: COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS }, (_, ordinal) =>
      Buffer.from(contextValueRecordNonce("chunk", ordinal)).toString("hex")
    ),
  ];
  expect(new Set(encoded).size).toBe(encoded.length);
  expect(encoded.every((value) => value.length === 24)).toBeTrue();
  assertProperty(fc.property(
    fc.integer({ min: 0, max: COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS - 1 }),
    fc.integer({ min: 0, max: COMPLETED_PREFIX_CONTEXT_VALUE_MAX_CHUNKS - 1 }),
    (left, right) => {
      expect(equal(
        contextValueRecordNonce("chunk", left),
        contextValueRecordNonce("chunk", right),
      )).toBe(left === right);
    },
  ), { numRuns: 200 });
});

test("arbitrary UTF-8 values deterministically round-trip to the same ciphertext set", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.uint8Array({ minLength: 0, maxLength: 96 * 1024 }),
    async (source) => {
      const plaintext = Buffer.from(source).toString("base64url");
      const left = subject();
      const right = subject();
      const first = await left.store.put(command(plaintext));
      const second = await right.store.put(command(plaintext));
      expect(stableIdentity(first.value)).toBe(stableIdentity(second.value));
      expect([...left.objects.values.keys()].sort())
        .toEqual([...right.objects.values.keys()].sort());
      for (const [digest, bytes] of left.objects.values) {
        const expected = right.objects.values.get(digest);
        if (expected === undefined) throw new Error("deterministic object is missing");
        expect(bytes).toEqual(expected);
      }
      expect((await left.store.get({
        epochId,
        ownerActorId,
        sourceTurnId,
        valueId: first.value.valueId,
      })).plaintext).toBe(plaintext);
    },
  ), {
    interruptAfterTimeLimit: propertyParameters.interruptAfterTimeLimit,
    numRuns: 80,
  });
}, PROPERTY_TIMEOUT);

test("every chunk/manifest crash prefix converges by replay without changing identity", async () => {
  const plaintext = "r".repeat(CONTEXT_VALUE_CHUNK_BYTES * 3 + 7);
  for (let failAt = 1; failAt <= 5; failAt += 1) {
    const value = subject(failAt);
    await value.store.put(command(plaintext)).then(
      () => { throw new Error("injected crash did not fire"); },
      (error: unknown) => expect(error).toMatchObject({ code: "replay_required" }),
    );
    const before = value.metadata.record;
    expect(before).toMatchObject({ state: "replayRequired" });
    const replay = await value.store.put(command(plaintext));
    expect(replay.value).toMatchObject({ state: "active", chunkCount: 4 });
    expect(stableIdentity(replay.value)).toBe(stableIdentity(
      before as ContextValueRecord,
    ));
    expect(value.objects.values.size).toBe(5);
  }
});
