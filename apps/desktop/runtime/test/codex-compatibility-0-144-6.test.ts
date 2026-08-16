import { describe, expect, test } from "bun:test";

import {
  CODEX_0_144_6_REMOTE_ERROR_MAX_MESSAGE_LENGTH,
  classifyCodex01446RemoteError,
} from "../src/codex";

const signature = "401 Unauthorized token_invalidated";

function messageAtLength(length: number): string {
  if (length < signature.length) throw new Error("fixture length is too small");
  return `${signature}${" ".repeat(length - signature.length)}`;
}

describe("Codex 0.144.6 compatibility", () => {
  test("classifies only the exact bounded invalid-session signature", () => {
    expect(classifyCodex01446RemoteError({
      code: -32_603,
      message: messageAtLength(CODEX_0_144_6_REMOTE_ERROR_MAX_MESSAGE_LENGTH),
    })).toBe("authentication_invalid");
  });

  test("rejects near matches in code, status, token, type, and length", () => {
    const fixtures = [
      { code: -32_602, message: signature },
      { code: -32_603, message: "403 Forbidden token_invalidated" },
      { code: -32_603, message: "401 Unauthorized token_invalid" },
      { code: "-32603", message: signature },
      {
        code: -32_603,
        message: messageAtLength(CODEX_0_144_6_REMOTE_ERROR_MAX_MESSAGE_LENGTH + 1),
      },
      { code: -32_603, message: { status: 401, token: "token_invalidated" } },
    ] as const;

    for (const fixture of fixtures) {
      expect(classifyCodex01446RemoteError(fixture)).toBe("other");
    }
  });
});
