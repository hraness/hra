import { describe, expect, test } from "bun:test";
import { JsonLineDecoder, ProtocolViolation, parseProtocolLine } from "./jsonl";

describe("JsonLineDecoder", () => {
  test("decodes JSONL across every byte boundary, including multibyte text", () => {
    const text = '{"method":"one","params":{"text":"example 🌴"}}\r\n{"id":1,"result":true}\n';
    const encoded = new TextEncoder().encode(text);

    for (let split = 0; split <= encoded.length; split += 1) {
      const decoder = new JsonLineDecoder();
      const lines = [
        ...decoder.push(encoded.slice(0, split)),
        ...decoder.push(encoded.slice(split)),
        ...decoder.finish(),
      ];
      expect(lines).toEqual([
        '{"method":"one","params":{"text":"example 🌴"}}',
        '{"id":1,"result":true}',
      ]);
    }
  });

  test("accepts a final line without a newline and ignores blank lines", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push(new TextEncoder().encode("\n  \n{\"id\":2,\"result\":null}"))).toEqual([]);
    expect(decoder.finish()).toEqual(['{"id":2,"result":null}']);
  });
});

describe("parseProtocolLine", () => {
  test("accepts request, notification, success, and error envelopes", () => {
    expect(parseProtocolLine('{"id":1,"method":"initialize","params":{}}')).toMatchObject({
      id: 1,
      method: "initialize",
    });
    expect(parseProtocolLine('{"method":"initialized"}')).toEqual({ method: "initialized" });
    expect(parseProtocolLine('{"id":1,"result":{}}')).toEqual({ id: 1, result: {} });
    expect(parseProtocolLine('{"id":"x","error":{"code":-1,"message":"no"}}')).toMatchObject({
      id: "x",
    });
  });

  test("rejects malformed and ambiguous envelopes", () => {
    expect(() => parseProtocolLine("[]")).toThrow(ProtocolViolation);
    expect(() => parseProtocolLine('{"id":1}')).toThrow("exactly one");
    expect(() => parseProtocolLine('{"id":1,"result":{},"error":{}}')).toThrow("exactly one");
    expect(() => parseProtocolLine('{"method":"x","result":{}}')).toThrow("cannot also be a response");
    expect(() => parseProtocolLine("{oops")).toThrow("malformed JSON");
  });
});
