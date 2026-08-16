import { describe, expect, test } from "bun:test";
import {
  CodexJsonlDecoder,
  CodexJsonlError,
  MAX_CODEX_JSONL_LINE_BYTES,
} from "../src/codex";

const encoder = new TextEncoder();

describe("CodexJsonlDecoder", () => {
  test("decodes CRLF, final lines, and multibyte UTF-8 across every byte boundary", () => {
    const source = '{"message":"A🌿B"}\r\n\n{"final":true}';
    const bytes = encoder.encode(source);

    for (let boundary = 0; boundary <= bytes.byteLength; boundary += 1) {
      const decoder = new CodexJsonlDecoder();
      const lines = [
        ...decoder.push(bytes.subarray(0, boundary)),
        ...decoder.push(bytes.subarray(boundary)),
        ...decoder.finish(),
      ];
      expect(lines).toEqual(['{"message":"A🌿B"}', '{"final":true}']);
    }
  });

  test("latches invalid UTF-8 as a terminal decoder fault", () => {
    const decoder = new CodexJsonlDecoder();
    expect(() => decoder.push(Uint8Array.from([0xc3, 0x28, 0x0a])))
      .toThrow(CodexJsonlError);
    try {
      decoder.push(encoder.encode("{}\n"));
      throw new Error("expected the decoder fault to remain latched");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CodexJsonlError);
      if (!(error instanceof CodexJsonlError)) throw error;
      expect(error.reason).toBe("invalid_utf8");
    }
  });

  test("bounds both terminated and unterminated lines", () => {
    const terminated = new CodexJsonlDecoder(4);
    expect(() => terminated.push(encoder.encode("12345\n"))).toThrow("line_too_large");

    const final = new CodexJsonlDecoder(4);
    expect(() => final.push(encoder.encode("12345"))).toThrow("line_too_large");
  });

  test("enforces byte—not UTF-16 character—limits for multibyte text", () => {
    const exact = new CodexJsonlDecoder(4);
    expect(exact.push(encoder.encode("éé\n"))).toEqual(["éé"]);

    const over = new CodexJsonlDecoder(4);
    expect(() => over.push(encoder.encode("ééa\n"))).toThrow("line_too_large");
  });

  test("keeps the default transport ceiling above the semantic history circuit", () => {
    const decoder = new CodexJsonlDecoder();
    const compatibilityLine = "x".repeat(8 * 1_024 * 1_024 + 1);
    expect(decoder.push(encoder.encode(`${compatibilityLine}\n`))).toEqual([
      compatibilityLine,
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  test("rejects an over-limit chunk before retaining or decoding it", () => {
    const decoder = new CodexJsonlDecoder();
    expect(() => decoder.push(new Uint8Array(MAX_CODEX_JSONL_LINE_BYTES + 1)))
      .toThrow("line_too_large");
  });

  test("cannot be reused after finish", () => {
    const decoder = new CodexJsonlDecoder();
    expect(decoder.finish()).toEqual([]);
    expect(() => decoder.push(encoder.encode("{}\n"))).toThrow("decoder_finished");
  });
});
