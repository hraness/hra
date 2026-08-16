import { expect, test } from "bun:test";
import { z } from "@hra-internal/schema";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import {
  createIndexedDatabase,
  createZodIndexedDbCodec,
  defineIndexedDbStore,
} from "./indexed-db";
import { MemoryIndexedDbFactory } from "./indexed-db-test";

const valueSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  count: z.number().int(),
});

const stores = {
  left: defineIndexedDbStore(
    createZodIndexedDbCodec(valueSchema),
  ),
  right: defineIndexedDbStore(
    createZodIndexedDbCodec(valueSchema),
  ),
};

function propertyDatabase(
  factory: MemoryIndexedDbFactory,
  name: string,
) {
  return createIndexedDatabase({
    name,
    version: 1,
    stores,
    migrations: [
      {
        toVersion: 1,
        migrate(context) {
          context.createStore("left");
          context.createStore("right");
        },
      },
    ],
    resolveIndexedDb: () => factory,
  });
}

const valueArbitrary = fc.record({
  id: fc.string(),
  label: fc.string(),
  count: fc.integer(),
});

test("property: valid values survive committed IndexedDB round trips", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.string(),
    valueArbitrary,
    async (key, value) => {
      const factory = new MemoryIndexedDbFactory();
      factory.seed("round-trip-property", 1, {
        left: [],
        right: [],
      });
      const database = propertyDatabase(
        factory,
        "round-trip-property",
      );

      const written = await database.transaction(
        ["left"],
        "readwrite",
        transaction => transaction.store("left").put(value, key),
      );
      expect(written).toEqual({ ok: true, value: key });
      const loaded = await database.transaction(
        ["left"],
        "readonly",
        transaction => transaction.store("left").get(key),
      );
      expect(loaded).toEqual({ ok: true, value });
    },
  ));
});

test("property: a multi-store write commits all values or preserves all prior values", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    valueArbitrary,
    valueArbitrary,
    valueArbitrary,
    valueArbitrary,
    fc.boolean(),
    async (
      initialLeft,
      initialRight,
      nextLeft,
      nextRight,
      shouldAbort,
    ) => {
      const factory = new MemoryIndexedDbFactory();
      factory.seed("atomicity-property", 1, {
        left: [["value", initialLeft]],
        right: [["value", initialRight]],
      });
      const database = propertyDatabase(
        factory,
        "atomicity-property",
      );

      const result = await database.transaction(
        ["left", "right"],
        "readwrite",
        async transaction => {
          await transaction.store("left").put(nextLeft, "value");
          await transaction.store("right").put(nextRight, "value");
          if (shouldAbort) transaction.abort("property rollback");
          return "committed";
        },
      );

      if (shouldAbort) {
        expect(result).toMatchObject({
          ok: false,
          error: { kind: "aborted", stage: "callback" },
        });
        expect(
          factory.rawValue("atomicity-property", "left", "value"),
        ).toEqual(initialLeft);
        expect(
          factory.rawValue("atomicity-property", "right", "value"),
        ).toEqual(initialRight);
      } else {
        expect(result).toEqual({ ok: true, value: "committed" });
        expect(
          factory.rawValue("atomicity-property", "left", "value"),
        ).toEqual(nextLeft);
        expect(
          factory.rawValue("atomicity-property", "right", "value"),
        ).toEqual(nextRight);
      }
    },
  ));
});

test("property: reads are total over arbitrary structured-cloneable stored values", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.jsonValue(),
    async (storedValue) => {
      const factory = new MemoryIndexedDbFactory();
      factory.seed("totality-property", 1, {
        left: [["arbitrary", storedValue]],
        right: [],
      });
      const database = propertyDatabase(
        factory,
        "totality-property",
      );

      const result = await database.transaction(
        ["left"],
        "readonly",
        transaction => transaction.store("left").get("arbitrary"),
      );
      if (result.ok) {
        expect(valueSchema.safeParse(result.value).success).toBe(true);
      } else {
        expect(result.error).toMatchObject({
          kind: "corruption",
          store: "left",
          operation: "get",
        });
      }
    },
  ));
});
