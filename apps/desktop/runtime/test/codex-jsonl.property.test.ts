import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";
import { CodexJsonlDecoder } from "../src/codex";

const encoder = new TextEncoder();

test("arbitrary JSONL survives arbitrary repeated chunk widths", () => {
  assertProperty(
    fc.property(
      fc.array(fc.jsonValue(), { minLength: 1, maxLength: 24 }),
      fc.array(fc.integer({ min: 1, max: 32 }), { minLength: 1, maxLength: 12 }),
      (values, widths) => {
        const expected = values.map((value) => JSON.stringify(value));
        const bytes = encoder.encode(`${expected.join("\n")}\n`);
        const decoder = new CodexJsonlDecoder();
        const actual: string[] = [];
        let offset = 0;
        let chunkIndex = 0;
        while (offset < bytes.byteLength) {
          const width = widths[chunkIndex % widths.length];
          if (width === undefined) throw new Error("property generated an empty width list");
          const end = Math.min(offset + width, bytes.byteLength);
          actual.push(...decoder.push(bytes.subarray(offset, end)));
          offset = end;
          chunkIndex += 1;
        }
        actual.push(...decoder.finish());
        expect(actual).toEqual(expected);
      },
    ),
  );
});
