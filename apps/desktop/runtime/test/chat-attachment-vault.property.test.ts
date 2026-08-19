import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";
import {
  CHAT_ATTACHMENT_MAX_DISPLAY_NAME_UTF8_BYTES,
} from "../src/attachments/contracts";
import {
  internalSuffix,
  normalizeMediaType,
  parseChunkOrdinal,
  sanitizeDisplayName,
  strictBase64Chunk,
} from "../src/attachments/validation";

test("display basenames are bounded, path-free, and idempotent", () => {
  assertProperty(
    fc.property(fc.string({ maxLength: 400 }), (candidate) => {
      const sanitized = sanitizeDisplayName(candidate);
      expect(Buffer.byteLength(sanitized, "utf8"))
        .toBeLessThanOrEqual(CHAT_ATTACHMENT_MAX_DISPLAY_NAME_UTF8_BYTES);
      expect(Buffer.byteLength(sanitized, "utf8")).toBeGreaterThan(0);
      expect(sanitized).not.toMatch(new RegExp(
        String.raw`[/\\\u0000-\u001f\u007f-\u009f]`,
        "u",
      ));
      expect(sanitizeDisplayName(sanitized)).toBe(sanitized);
      expect(internalSuffix("file", sanitized)).toMatch(/^[a-z0-9]{1,16}$/u);
      expect(internalSuffix("image", sanitized)).toBe("png");
    }),
    { numRuns: 250 },
  );
});

test("strict canonical base64 round-trips arbitrary bounded chunks", () => {
  assertProperty(
    fc.property(
      fc.uint8Array({ minLength: 1, maxLength: 4_096 }),
      (bytes) => {
        const encoded = Buffer.from(bytes).toString("base64");
        expect(strictBase64Chunk(encoded)).toEqual(Buffer.from(bytes));
        expect(() => strictBase64Chunk(`${encoded}\n`)).toThrow();
      },
    ),
    { numRuns: 100 },
  );
});

test("media types and chunk ordinals always collapse into the closed boundary", () => {
  assertProperty(
    fc.property(fc.string({ maxLength: 300 }), (candidate) => {
      const mediaType = normalizeMediaType(candidate);
      expect(Buffer.byteLength(mediaType, "utf8")).toBeLessThanOrEqual(127);
      expect(mediaType).toMatch(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u);
    }),
    { numRuns: 200 },
  );
  for (let ordinal = 0; ordinal < 48; ordinal += 1) {
    expect(parseChunkOrdinal(ordinal)).toBe(ordinal);
  }
  for (const rejected of [-1, 48, 49, Number.MAX_SAFE_INTEGER, 1.5]) {
    expect(() => parseChunkOrdinal(rejected)).toThrow();
  }
});
