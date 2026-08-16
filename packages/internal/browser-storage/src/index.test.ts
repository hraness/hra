import { describe, expect, test } from "bun:test";
import { z } from "@hra-internal/schema";

import {
  createLocalStorageRecord,
  type StorageLike,
  type StorageOperation,
} from "./index";

const recordSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().trim().min(1),
  count: z.number().int().nonnegative(),
});

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function recordFor(storage: StorageLike | null) {
  return createLocalStorageRecord({
    key: "hra:test",
    schema: recordSchema,
    resolveStorage: () => storage,
  });
}

describe("createLocalStorageRecord", () => {
  test("round-trips a canonical schema value and removes only its key", () => {
    const storage = new MemoryStorage();
    storage.setItem("other", "preserved");
    const record = recordFor(storage);

    expect(record.load()).toEqual({ ok: true, value: null });
    expect(record.save({ version: 1, name: "  Loop  ", count: 2 })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(record.load()).toEqual({
      ok: true,
      value: { version: 1, name: "Loop", count: 2 },
    });
    expect(record.remove()).toEqual({ ok: true, value: undefined });
    expect(record.load()).toEqual({ ok: true, value: null });
    expect(storage.getItem("other")).toBe("preserved");
  });

  test("distinguishes invalid JSON from schema-invalid records", () => {
    const storage = new MemoryStorage();
    const record = recordFor(storage);

    storage.setItem("hra:test", "{");
    expect(record.load()).toMatchObject({ ok: false, error: { kind: "invalid-json" } });

    storage.setItem("hra:test", JSON.stringify({ version: 2, name: "Loop", count: 1 }));
    expect(record.load()).toMatchObject({ ok: false, error: { kind: "invalid-record" } });
    expect(record.save({ version: 2, name: "Loop", count: 1 })).toMatchObject({
      ok: false,
      error: { kind: "invalid-record" },
    });
  });

  test("reports unavailable storage without throwing", () => {
    const record = recordFor(null);
    expect(record.load()).toEqual({ ok: false, error: { kind: "unavailable" } });
    expect(record.save({ version: 1, name: "Loop", count: 1 })).toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(record.remove()).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  test("reports resolver and storage access failures by operation", () => {
    const resolverFailure = createLocalStorageRecord({
      key: "hra:test",
      schema: recordSchema,
      resolveStorage: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(resolverFailure.load()).toMatchObject({
      ok: false,
      error: { kind: "access-failed", operation: "read", reason: "security" },
    });

    for (const operation of ["read", "write", "remove"] as const satisfies readonly StorageOperation[]) {
      const storage: StorageLike = {
        getItem: () => {
          if (operation === "read") throw new Error("read failed");
          return null;
        },
        setItem: () => {
          if (operation === "write") throw new DOMException("full", "QuotaExceededError");
        },
        removeItem: () => {
          if (operation === "remove") throw new Error("remove failed");
        },
      };
      const result = operation === "read"
        ? recordFor(storage).load()
        : operation === "write"
          ? recordFor(storage).save({ version: 1, name: "Loop", count: 1 })
          : recordFor(storage).remove();
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "access-failed",
          operation,
          reason: operation === "write" ? "quota" : "unknown",
        },
      });
    }
  });

  test("refuses schema outputs that cannot survive JSON serialization", () => {
    const storage = new MemoryStorage();
    const bigintRecord = createLocalStorageRecord({
      key: "hra:bigint",
      schema: z.bigint(),
      resolveStorage: () => storage,
    });

    expect(bigintRecord.save(1n)).toMatchObject({
      ok: false,
      error: { kind: "encode-failed" },
    });
    expect(storage.getItem("hra:bigint")).toBeNull();
  });

  test("turns throwing schema code into typed failures", () => {
    const storage = new MemoryStorage();
    storage.setItem("hra:throwing-read", JSON.stringify("Loop"));
    const throwingRead = createLocalStorageRecord({
      key: "hra:throwing-read",
      schema: z.string().transform(() => {
        throw new Error("transform failed");
      }),
      resolveStorage: () => storage,
    });

    expect(throwingRead.load()).toMatchObject({
      ok: false,
      error: { kind: "invalid-record", detail: "transform failed" },
    });
    expect(throwingRead.save("Loop")).toMatchObject({
      ok: false,
      error: { kind: "invalid-record", detail: "transform failed" },
    });

    let parseCount = 0;
    const throwingRoundTrip = createLocalStorageRecord({
      key: "hra:throwing-round-trip",
      schema: z.string().transform((value) => {
        parseCount += 1;
        if (parseCount === 2) throw new Error("round trip failed");
        return value;
      }),
      resolveStorage: () => storage,
    });
    expect(throwingRoundTrip.save("Loop")).toMatchObject({
      ok: false,
      error: { kind: "encode-failed", detail: "round trip failed" },
    });
    expect(storage.getItem("hra:throwing-round-trip")).toBeNull();
  });

  test("rejects schema transforms that change on every parse", () => {
    const storage = new MemoryStorage();
    const nonIdempotent = createLocalStorageRecord({
      key: "hra:non-idempotent",
      schema: z.string().transform(value => `${value}!`),
      resolveStorage: () => storage,
    });

    expect(nonIdempotent.save("Loop")).toMatchObject({
      ok: false,
      error: { kind: "encode-failed" },
    });
    expect(storage.getItem("hra:non-idempotent")).toBeNull();
  });
});
