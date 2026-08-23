import { describe, expect, test } from "bun:test";

import { parseAuthSignInResult } from "./authSession";

describe("Convex Auth result parser", () => {
  test("keeps request and rejection content-neutral", () => {
    expect(parseAuthSignInResult({ tokens: null }))
      .toEqual({ kind: "code_requested_or_rejected" });
  });

  test("accepts only the exact bounded token envelope", () => {
    const token = "a".repeat(64);
    const refreshToken = "b".repeat(64);
    expect(parseAuthSignInResult({ tokens: { refreshToken, token } }))
      .toEqual({ kind: "authenticated", refreshToken, token });
    expect(parseAuthSignInResult({ tokens: { refreshToken, token }, user: "smuggled" }))
      .toBeNull();
    expect(parseAuthSignInResult({ tokens: { refreshToken: "short", token } }))
      .toBeNull();
  });
});
