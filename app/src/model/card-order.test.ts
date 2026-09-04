import { describe, expect, test } from "bun:test";

import {
  canNudge,
  cardOrderReducer,
  maximumOrderedCards,
  maximumOrderedIdCharacters,
  moveToIndex,
  normaliseCardOrder,
  parseCardOrder,
  readCardOrder,
  writeCardOrder,
  type CardOrderStorage,
} from "./card-order";

function memoryStorage(initial: string | null = null): CardOrderStorage & {
  value: () => string | null;
} {
  let held = initial;
  return {
    read: () => held,
    remove: () => { held = null; },
    value: () => held,
    write: (next: string) => { held = next; },
  };
}

/** Every browser refusal looks like this: the call throws, it does not return. */
function throwingStorage(): CardOrderStorage {
  return {
    read: () => { throw new Error("storage is not available"); },
    remove: () => { throw new Error("storage is not available"); },
    write: () => { throw new Error("storage is not available"); },
  };
}

describe("normaliseCardOrder", () => {
  test("keeps a plain list of ids", () => {
    expect(normaliseCardOrder(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("reads anything that is not an array as no order", () => {
    expect(normaliseCardOrder(null)).toEqual([]);
    expect(normaliseCardOrder("a,b")).toEqual([]);
    expect(normaliseCardOrder({ 0: "a" })).toEqual([]);
    expect(normaliseCardOrder(undefined)).toEqual([]);
  });

  test("drops entries that are not plausible public ids", () => {
    expect(normaliseCardOrder(["a", 7, null, "", { id: "b" }, "c"])).toEqual(["a", "c"]);
    expect(normaliseCardOrder(["a".repeat(maximumOrderedIdCharacters + 1), "b"])).toEqual(["b"]);
  });

  test("de-duplicates, keeping the first position", () => {
    expect(normaliseCardOrder(["a", "b", "a"])).toEqual(["a", "b"]);
  });

  test("bounds the list", () => {
    const many = Array.from({ length: maximumOrderedCards + 40 }, (_, index) => `s${String(index)}`);
    expect(normaliseCardOrder(many).length).toBe(maximumOrderedCards);
  });
});

describe("parseCardOrder", () => {
  test("parses stored text", () => {
    expect(parseCardOrder('["a","b"]')).toEqual(["a", "b"]);
  });

  test("reads malformed or absent text as no order", () => {
    expect(parseCardOrder(null)).toEqual([]);
    expect(parseCardOrder("not json")).toEqual([]);
    expect(parseCardOrder("{}")).toEqual([]);
  });
});

describe("storage fallback", () => {
  test("reads back what was written", () => {
    const storage = memoryStorage();
    writeCardOrder(storage, ["a", "b"]);
    expect(readCardOrder(storage)).toEqual(["a", "b"]);
  });

  test("an empty order removes the key rather than storing an empty list", () => {
    const storage = memoryStorage('["a"]');
    writeCardOrder(storage, []);
    expect(storage.value()).toBe(null);
    expect(readCardOrder(storage)).toEqual([]);
  });

  test("a storage that throws on read reads as no order", () => {
    expect(readCardOrder(throwingStorage())).toEqual([]);
  });

  test("a storage that throws on write is not an error the reader sees", () => {
    expect(() => { writeCardOrder(throwingStorage(), ["a"]); }).not.toThrow();
  });

  test("a storage that throws on remove is not an error either", () => {
    expect(() => { writeCardOrder(throwingStorage(), []); }).not.toThrow();
  });

  test("a storage that returns nothing reads as no order", () => {
    expect(readCardOrder(memoryStorage())).toEqual([]);
  });

  test("a write is bounded even when the caller is not", () => {
    const storage = memoryStorage();
    writeCardOrder(
      storage,
      Array.from({ length: maximumOrderedCards + 5 }, (_, index) => `s${String(index)}`),
    );
    expect(readCardOrder(storage).length).toBe(maximumOrderedCards);
  });
});

describe("moveToIndex", () => {
  test("steps right past the card it displaces", () => {
    expect(moveToIndex(["a", "b", "c"], "b", 2)).toEqual(["a", "c", "b"]);
  });

  test("steps left into the slot the card ahead held", () => {
    expect(moveToIndex(["a", "b", "c"], "c", 1)).toEqual(["a", "c", "b"]);
  });

  test("clamps at both ends", () => {
    expect(moveToIndex(["a", "b", "c"], "a", -3)).toEqual(["a", "b", "c"]);
    expect(moveToIndex(["a", "b", "c"], "c", 9)).toEqual(["a", "b", "c"]);
  });

  test("leaves an unknown id alone", () => {
    expect(moveToIndex(["a", "b"], "z", 0)).toEqual(["a", "b"]);
  });
});

describe("cardOrderReducer", () => {
  const displayed = ["a", "b", "c", "d"];

  test("the first drag seeds the arrangement from what the reader sees", () => {
    expect(cardOrderReducer([], {
      activePublicId: "d",
      displayed,
      overPublicId: "b",
      type: "move",
    })).toEqual(["a", "d", "b", "c"]);
  });

  test("a drop on the card itself changes nothing", () => {
    const order = ["a", "b"];
    expect(cardOrderReducer(order, {
      activePublicId: "a",
      displayed,
      overPublicId: "a",
      type: "move",
    })).toBe(order);
  });

  test("a drop on a card that is not displayed changes nothing", () => {
    const order = ["a", "b"];
    expect(cardOrderReducer(order, {
      activePublicId: "a",
      displayed,
      overPublicId: "gone",
      type: "move",
    })).toBe(order);
  });

  test("ids the page does not carry keep their arrangement behind it", () => {
    expect(cardOrderReducer(["offpage", "a", "b"], {
      activePublicId: "b",
      displayed: ["a", "b"],
      overPublicId: "a",
      type: "move",
    })).toEqual(["b", "a", "offpage"]);
  });

  test("nudge left and nudge right are one step each", () => {
    const left = cardOrderReducer([], {
      direction: "left",
      displayed,
      publicId: "c",
      type: "nudge",
    });
    expect(left).toEqual(["a", "c", "b", "d"]);
    expect(cardOrderReducer(left, {
      direction: "right",
      displayed: left,
      publicId: "c",
      type: "nudge",
    })).toEqual(["a", "b", "c", "d"]);
  });

  test("a nudge off either end changes nothing", () => {
    const order = ["a", "b"];
    expect(cardOrderReducer(order, {
      direction: "left",
      displayed,
      publicId: "a",
      type: "nudge",
    })).toBe(order);
    expect(cardOrderReducer(order, {
      direction: "right",
      displayed,
      publicId: "d",
      type: "nudge",
    })).toBe(order);
  });

  test("a nudge of a card that is not displayed changes nothing", () => {
    const order = ["a"];
    expect(cardOrderReducer(order, {
      direction: "left",
      displayed,
      publicId: "gone",
      type: "nudge",
    })).toBe(order);
  });

  test("clear forgets the arrangement", () => {
    expect(cardOrderReducer(["a", "b"], { type: "clear" })).toEqual([]);
  });

  test("restore normalises what it is handed", () => {
    expect(cardOrderReducer([], { order: ["a", "a", "b"], type: "restore" }))
      .toEqual(["a", "b"]);
  });

  test("the arrangement stays bounded across repeated moves", () => {
    const page = Array.from({ length: 10 }, (_, index) => `p${String(index)}`);
    const stale = Array.from({ length: maximumOrderedCards }, (_, index) => `s${String(index)}`);
    const next = cardOrderReducer(stale, {
      activePublicId: "p9",
      displayed: page,
      overPublicId: "p0",
      type: "move",
    });
    expect(next.length).toBe(maximumOrderedCards);
    expect(next.slice(0, 2)).toEqual(["p9", "p0"]);
  });

  test("leaves the input arrays untouched", () => {
    const order = ["a", "b"];
    const page = ["a", "b", "c"];
    cardOrderReducer(order, {
      activePublicId: "c",
      displayed: page,
      overPublicId: "a",
      type: "move",
    });
    expect(order).toEqual(["a", "b"]);
    expect(page).toEqual(["a", "b", "c"]);
  });
});

describe("canNudge", () => {
  test("reports the ends of the displayed sequence", () => {
    expect(canNudge(["a", "b"], "a", "left")).toBe(false);
    expect(canNudge(["a", "b"], "a", "right")).toBe(true);
    expect(canNudge(["a", "b"], "b", "left")).toBe(true);
    expect(canNudge(["a", "b"], "b", "right")).toBe(false);
  });

  test("an id that is not displayed cannot move", () => {
    expect(canNudge(["a"], "z", "left")).toBe(false);
    expect(canNudge(["a"], "z", "right")).toBe(false);
  });
});
