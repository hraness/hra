import { describe, expect, test } from "bun:test";

import { isAuthorityError, wipeBytes } from "./authority";

describe("isAuthorityError", () => {
  test("recognises the one message every Convex authority refusal uses", () => {
    expect(isAuthorityError(new Error("Cloud authority is not current."))).toBe(true);
  });

  test("recognises an unauthenticated call", () => {
    expect(isAuthorityError(new Error("Not authenticated"))).toBe(true);
    expect(isAuthorityError(new Error("InvalidAccessToken: token expired"))).toBe(true);
  });

  test("leaves an ordinary failure alone", () => {
    expect(isAuthorityError(new Error("Network request failed"))).toBe(false);
    expect(isAuthorityError(new Error("Compact projection chunk is too large."))).toBe(false);
  });

  test("handles a thrown value that is not an error", () => {
    expect(isAuthorityError("Cloud authority is not current.")).toBe(true);
    expect(isAuthorityError(undefined)).toBe(false);
  });
});

describe("wipeBytes", () => {
  test("overwrites key material in place", () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    wipeBytes(key);
    expect([...key]).toEqual([0, 0, 0, 0]);
  });

  test("tolerates an absent key", () => {
    expect(() => { wipeBytes(null); }).not.toThrow();
    expect(() => { wipeBytes(undefined); }).not.toThrow();
  });
});
