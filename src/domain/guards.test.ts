import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertNever, hasExactKeys, isRecord } from "./guards";
import { createCloudUuidV7, isUuidV7 } from "./uuid-v7";
import {
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  redactAbsolutePaths,
} from "./text-safety";

describe("domain guards", () => {
  test("isRecord accepts plain and null-prototype objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null) as unknown)).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(new Date())).toBe(false);
    expect(isRecord(new Map())).toBe(false);
    expect(isRecord("record")).toBe(false);
  });

  test("hasExactKeys rejects missing, extra, and symbol keys", () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, [Symbol("s")]: 2 }, ["a"])).toBe(false);
  });

  test("assertNever throws on an unexpected closed-union value", () => {
    expect(() => assertNever("unexpected" as never)).toThrow("Unexpected closed-union value");
  });
});

describe("uuid v7", () => {
  test("created keys parse as UUIDv7 and embed the millisecond timestamp", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 48 - 1 }), (now) => {
        const key = createCloudUuidV7(now);
        expect(isUuidV7(key)).toBe(true);
        expect(Number.parseInt(key.replaceAll("-", "").slice(0, 12), 16)).toBe(now);
      }),
    );
  });

  test("rejects clocks outside the 48-bit range and non-v7 strings", () => {
    expect(() => createCloudUuidV7(-1)).toThrow("System clock");
    expect(() => createCloudUuidV7(2 ** 48)).toThrow("System clock");
    expect(() => createCloudUuidV7(1.5)).toThrow("System clock");
    expect(isUuidV7("0192a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b")).toBe(false);
    expect(isUuidV7(42)).toBe(false);
  });
});

describe("text safety", () => {
  test("detects and redacts absolute path tokens", () => {
    for (const value of [["", "Users", "someone", "state"].join("/"), "~/state", "C:\\state", "file:///state", "see //shared/x"]) {
      expect(containsAbsolutePath(value)).toBe(true);
      expect(containsAbsolutePath(redactAbsolutePaths(value))).toBe(false);
      expect(redactAbsolutePaths(value)).toContain("[local-path]");
    }
    expect(containsAbsolutePath("relative/path and a/b")).toBe(false);
    expect(redactAbsolutePaths("plain text")).toBe("plain text");
  });

  test("flags control scalars unless line feeds are allowed", () => {
    expect(containsUnsafeTerminalScalar("clean")).toBe(false);
    expect(containsUnsafeTerminalScalar("a\u001b[31mb")).toBe(true);
    expect(containsUnsafeTerminalScalar("a\nb")).toBe(true);
    expect(containsUnsafeTerminalScalar("a\nb", true)).toBe(false);
    expect(containsUnsafeTerminalScalar("a\u200bb", true)).toBe(true);
  });
});
