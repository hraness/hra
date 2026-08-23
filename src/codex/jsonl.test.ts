import { describe, expect, test } from "bun:test";

import { CodexError } from "./errors.ts";
import { JsonLineDecoder } from "./jsonl.ts";

describe("JsonLineDecoder", () => {
  test("decodes fragmented UTF-8 JSON lines", () => {
    const decoder = new JsonLineDecoder({ maxLineBytes: 128 });
    const bytes = new TextEncoder().encode('{"value":"café"}\n{"value":2}\n');
    expect(decoder.push(bytes.subarray(0, 12))).toEqual([]);
    expect(decoder.push(bytes.subarray(12, 18))).toEqual([{ value: "café" }]);
    expect(decoder.push(bytes.subarray(18))).toEqual([{ value: 2 }]);
    expect(decoder.finish()).toEqual([]);
  });

  test("fails before retaining an unbounded line", () => {
    const decoder = new JsonLineDecoder({ maxLineBytes: 8, maxBufferedBytes: 16 });
    expect(() => decoder.push(new TextEncoder().encode("123456789"))).toThrow(CodexError);
  });

  test("never includes provider payload in a parse error", () => {
    const decoder = new JsonLineDecoder();
    const secret = "sentinel-provider-secret";
    try {
      decoder.push(new TextEncoder().encode(`{${secret}\n`));
      throw new Error("expected decoder failure");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
