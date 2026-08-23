import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  generateEightDigitOtpFromEntropy,
  isCanonicalAuthEmail,
  isIdentityInviteCapability,
  parseAuthCredentials,
} from "./authCredentials";

const invite = `hra_invite_identity_v1_${"A".repeat(43)}`;

describe("verified-email credentials", () => {
  test("accepts only exact canonical email and eight digits", () => {
    expect(JSON.stringify(parseAuthCredentials({ email: "reader@example.com" })))
      .toBe(JSON.stringify({ email: "reader@example.com", kind: "request_code" }));
    expect(JSON.stringify(parseAuthCredentials({ email: "reader@example.com", invite })))
      .toBe(JSON.stringify({ email: "reader@example.com", invite, kind: "request_code" }));
    expect(JSON.stringify(parseAuthCredentials({ email: "reader@example.com", code: "01234567" })))
      .toBe(JSON.stringify({ code: "01234567", email: "reader@example.com", kind: "verify_code" }));
    for (const input of [
      { email: " Reader@example.com" },
      { email: "reader@example.com", code: "1234567" },
      { email: "reader@example.com", code: "12345678", extra: true },
      { email: "reader@example.com", code: "12345678", invite },
      { email: "reader@example.com", invite: `${invite}A` },
      { email: "reader@example.com", invite: `hra_invite_device_v1_${"A".repeat(43)}` },
      ["reader@example.com"],
      null,
    ]) expect(parseAuthCredentials(input)).toEqual({ kind: "rejected" });
  });

  test("does not invoke accessors or trust exotic prototypes", () => {
    let accessed = false;
    const accessor = {};
    Object.defineProperty(accessor, "email", {
      enumerable: true,
      get() {
        accessed = true;
        return "reader@example.com";
      },
    });
    expect(parseAuthCredentials(accessor)).toEqual({ kind: "rejected" });
    expect(accessed).toBe(false);
    expect(parseAuthCredentials(Object.create({ email: "reader@example.com" })))
      .toEqual({ kind: "rejected" });
  });

  test("is total for arbitrary foreign input", () => {
    fc.assert(fc.property(fc.anything(), (value) => {
      expect(() => parseAuthCredentials(value)).not.toThrow();
    }));
  });

  test("rejection sampling gives every decimal residue 25 unbiased bytes", () => {
    const counts = Array.from({ length: 10 }, () => 0);
    for (let byte = 0; byte < 250; byte += 1) {
      const code = generateEightDigitOtpFromEntropy(() => new Uint8Array(8).fill(byte));
      expect(code).toBe(String(byte % 10).repeat(8));
      const digit = Number(code[0]);
      if (Number.isSafeInteger(digit)) counts[digit] = (counts[digit] ?? 0) + 1;
    }
    expect(counts).toEqual(Array.from({ length: 10 }, () => 25));
  });

  test("canonical email predicate rejects normalization ambiguity", () => {
    fc.assert(fc.property(fc.string(), (value) => {
      if (isCanonicalAuthEmail(value)) {
        expect(String(value)).toBe(value.trim().toLowerCase());
        expect(value.split("@")).toHaveLength(2);
      }
    }));
  });

  test("identity admission capabilities have one exact versioned shape", () => {
    expect(isIdentityInviteCapability(invite)).toBe(true);
    fc.assert(fc.property(fc.anything(), (value) => {
      if (isIdentityInviteCapability(value)) {
        expect(value).toMatch(/^hra_invite_identity_v1_[A-Za-z0-9_-]{43}$/u);
      }
    }));
  });
});
