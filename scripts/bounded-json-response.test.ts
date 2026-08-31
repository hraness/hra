import { describe, expect, test } from "bun:test";

import { readBoundedJsonResponse } from "./bounded-json-response";

describe("bounded release JSON responses", () => {
  test("reads one UTF-8 JSON document within its declared and streamed bounds", async () => {
    const bytes = new TextEncoder().encode('{"state":"exact"}');
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 5));
        controller.enqueue(bytes.subarray(5));
        controller.close();
      },
    }), { headers: { "content-length": String(bytes.byteLength) } });
    expect(await readBoundedJsonResponse(response, "registry fixture", 64))
      .toEqual({ state: "exact" });
  });

  test("rejects declared overflow, chunked overflow, invalid UTF-8, and malformed JSON", async () => {
    await expect(readBoundedJsonResponse(new Response("{}", {
      headers: { "content-length": "65" },
    }), "registry fixture", 64)).rejects.toThrow("declared byte bound");
    await expect(readBoundedJsonResponse(new Response("x".repeat(65)),
      "registry fixture", 64)).rejects.toThrow("byte bound");
    await expect(readBoundedJsonResponse(new Response(Uint8Array.of(0xff)),
      "registry fixture", 64)).rejects.toThrow("malformed JSON");
    await expect(readBoundedJsonResponse(new Response("not-json"),
      "registry fixture", 64)).rejects.toThrow("malformed JSON");
  });
});
