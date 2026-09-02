import { describe, expect, test } from "bun:test";

import {
  countSecurityPrimitives,
  diffSecurityPrimitives,
  readSecurityPrimitiveTable,
  securityPrimitivePatterns,
} from "./check-security-primitives";

const repositoryRoot = new URL("..", import.meta.url).pathname;

describe("security primitive counts", () => {
  test("the reviewed table matches the tree", async () => {
    const expected = await readSecurityPrimitiveTable(repositoryRoot);
    const actual = await countSecurityPrimitives(repositoryRoot);
    expect(diffSecurityPrimitives(expected, actual)).toEqual([]);
  });

  test("the table covers every load-bearing primitive at least once", async () => {
    const actual = await countSecurityPrimitives(repositoryRoot);
    const seen = new Set(Object.values(actual).flatMap((counts) => Object.keys(counts)));
    for (const name of Object.keys(securityPrimitivePatterns)) expect(seen.has(name)).toBe(true);
  });

  test("a dropped primitive is reported by file and name", () => {
    const expected = { "src/example.ts": { fsync: 2, timingSafeEqual: 1 } };
    const actual = { "src/example.ts": { fsync: 1 } };
    expect(diffSecurityPrimitives(expected, actual)).toEqual([
      "src/example.ts: fsync expected 2, found 1",
      "src/example.ts: timingSafeEqual expected 1, found 0",
    ]);
  });
});
