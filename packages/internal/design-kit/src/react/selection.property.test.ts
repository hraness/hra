import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import { firstOwnedStringId, ownedStringIdForKey } from "./selection";

test("property: foreign keys never escape the supplied identifier set", () => {
  assertProperty(fc.property(
    fc.uniqueArray(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 24 }),
    fc.oneof(fc.string(), fc.integer()),
    (ids, key) => {
      const items = ids.map((id) => ({ id }));
      const result = ownedStringIdForKey(items, key);
      expect(result === null || ids.includes(result)).toBe(true);
    },
  ));
});

test("property: every supplied identifier round trips through a React Aria key", () => {
  assertProperty(fc.property(
    fc.uniqueArray(fc.string({ minLength: 1, maxLength: 24 }), {
      minLength: 1,
      maxLength: 24,
    }),
    fc.nat(),
    (ids, offset) => {
      const selected = ids[offset % ids.length];
      if (selected === undefined) throw new Error("The non-empty identifier set lost its selected item.");
      const items = ids.map((id) => ({ id }));
      expect(ownedStringIdForKey(items, selected)).toBe(selected);
      expect(firstOwnedStringId(items, [selected])).toBe(selected);
    },
  ));
});

test("an empty selection has no owned identifier", () => {
  expect(firstOwnedStringId([{ id: "personal" }], [])).toBeNull();
});
