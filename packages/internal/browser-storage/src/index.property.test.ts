import { expect, test } from "bun:test";
import { z } from "@hra-internal/schema";
import { assertProperty, fc } from "@hra-internal/test";

import { createLocalStorageRecord, type StorageLike } from "./index";

const valueSchema = z.strictObject({
  version: z.literal(1),
  id: z.string(),
  count: z.number().int(),
});

function memoryStorage(initial: string | null = null): StorageLike {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
}

test("property: loading is total over arbitrary stored strings", () => {
  assertProperty(fc.property(fc.string(), (encoded) => {
    const record = createLocalStorageRecord({
      key: "hra:property",
      schema: valueSchema,
      resolveStorage: () => memoryStorage(encoded),
    });
    expect(() => record.load()).not.toThrow();
  }));
});

test("property: valid records survive a save and load round trip", () => {
  assertProperty(fc.property(
    fc.record({ id: fc.string(), count: fc.integer() }),
    ({ id, count }) => {
      const storage = memoryStorage();
      const record = createLocalStorageRecord({
        key: "hra:property",
        schema: valueSchema,
        resolveStorage: () => storage,
      });
      const value = { version: 1 as const, id, count };
      expect(record.save(value)).toEqual({ ok: true, value: undefined });
      expect(record.load()).toEqual({ ok: true, value });
    },
  ));
});
