import { describe, expect, test } from "bun:test";

import {
  parseBoundedJsonBody,
  readBoundedUtf8Body,
  readBoundedUtf8Bytes,
} from "./boundedJsonBody";

function streamedRequest(
  chunks: readonly Uint8Array[],
  options: Readonly<{
    contentLength?: string;
    contentEncoding?: string;
    onCancel?: () => void;
    remainOpen?: boolean;
    signal?: AbortSignal;
  }> = {},
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      options.onCancel?.();
    },
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        if (options.remainOpen !== true) controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
  });
  return new Request("https://example.test/body", {
    body,
    headers: {
      ...(options.contentLength === undefined
        ? {}
        : { "content-length": options.contentLength }),
      ...(options.contentEncoding === undefined
        ? {}
        : { "content-encoding": options.contentEncoding }),
    },
    method: "POST",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

describe("bounded JSON request parsing", () => {
  test("accepts an exact-limit body without a declared length", async () => {
    const encoded = new TextEncoder().encode('{"v":"123456"}');
    expect(await parseBoundedJsonBody(streamedRequest([encoded]), encoded.byteLength))
      .toEqual({ v: "123456" });
  });

  test("decodes valid UTF-8 split across stream chunks", async () => {
    const encoded = new TextEncoder().encode('{"v":"🧑‍🍳"}');
    expect(
      await parseBoundedJsonBody(
        streamedRequest([
          encoded.subarray(0, 8),
          encoded.subarray(8, 10),
          encoded.subarray(10),
        ]),
        encoded.byteLength,
      ),
    ).toEqual({ v: "🧑‍🍳" });
  });

  test("returns exact bounded UTF-8 without normalizing signed bytes", async () => {
    const body = '{\n  "event": "exact" \n}\n';
    const encoded = new TextEncoder().encode(body);
    expect(
      await readBoundedUtf8Body(
        streamedRequest([encoded], {
          contentLength: String(encoded.byteLength),
        }),
        encoded.byteLength,
      ),
    ).toBe(body);
  });

  test("preserves a leading UTF-8 BOM at both exact-byte and text boundaries", async () => {
    const encoded = Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d);
    expect(
      await readBoundedUtf8Bytes(
        streamedRequest([encoded], {
          contentLength: String(encoded.byteLength),
        }),
        encoded.byteLength,
      ),
    ).toEqual(encoded);
    expect(
      await readBoundedUtf8Body(
        streamedRequest([encoded], {
          contentLength: String(encoded.byteLength),
        }),
        encoded.byteLength,
      ),
    ).toBe("\uFEFF{}");
  });

  test("rejects and cancels a stream as soon as it exceeds the limit", async () => {
    let cancelled = false;
    const request = streamedRequest(
      [
        new TextEncoder().encode('{"v":"'),
        new TextEncoder().encode('too large"}'),
      ],
      {
        onCancel: () => {
          cancelled = true;
        },
        remainOpen: true,
      },
    );

    expect(await parseBoundedJsonBody(request, 8)).toBeNull();
    expect(cancelled).toBeTrue();
  });

  test("rejects malformed, oversized, and mismatched content lengths", async () => {
    const body = new TextEncoder().encode("{}");
    for (const contentLength of ["+2", "02", "2, 2", "9007199254740992"]) {
      expect(
        await parseBoundedJsonBody(
          streamedRequest([body], { contentLength }),
          16,
        ),
      ).toBeNull();
    }
    expect(
      await parseBoundedJsonBody(
        streamedRequest([body], { contentLength: "17" }),
        16,
      ),
    ).toBeNull();
    expect(
      await parseBoundedJsonBody(
        streamedRequest([body], { contentLength: "1" }),
        16,
      ),
    ).toBeNull();
    expect(
      await parseBoundedJsonBody(
        streamedRequest([body], { contentLength: "3" }),
        16,
      ),
    ).toBeNull();
  });

  test("rejects invalid UTF-8, malformed JSON, and read failures", async () => {
    expect(
      await parseBoundedJsonBody(
        streamedRequest([Uint8Array.of(0xc3, 0x28)]),
        16,
      ),
    ).toBeNull();
    expect(
      await parseBoundedJsonBody(
        streamedRequest([new TextEncoder().encode("{")]),
        16,
      ),
    ).toBeNull();

    const failed = new Request("https://example.test/body", {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("transport failed"));
        },
      }),
      method: "POST",
    });
    expect(await parseBoundedJsonBody(failed, 16)).toBeNull();
  });

  test("rejects encoded bodies before decompression can bypass the byte cap", async () => {
    let cancelled = false;
    expect(
      await parseBoundedJsonBody(
        streamedRequest([new TextEncoder().encode("{}")], {
          contentEncoding: "gzip",
          onCancel: () => {
            cancelled = true;
          },
        }),
        16,
      ),
    ).toBeNull();
    expect(cancelled).toBeTrue();
  });

  test("cancels a body that stops making progress", async () => {
    let cancelled = false;
    const request = new Request("https://example.test/body", {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      method: "POST",
    });
    expect(
      await parseBoundedJsonBody(request, 16, { readTimeoutMs: 5 }),
    ).toBeNull();
    expect(cancelled).toBeTrue();
  });

  test("cancels a stalled body promptly when its client disconnects", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const request = new Request("https://example.test/body", {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      method: "POST",
      signal: controller.signal,
    });
    const startedAt = performance.now();
    const parsed = parseBoundedJsonBody(
      request,
      16,
      { readTimeoutMs: 1_000 },
    );
    setTimeout(() => controller.abort(), 5);

    expect(await parsed).toBeNull();
    expect(cancelled).toBeTrue();
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test("enforces the monotonic deadline against ready one-byte chunks", async () => {
    let cancelled = false;
    let pulls = 0;
    const request = new Request("https://example.test/body", {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        pull(streamController) {
          pulls += 1;
          streamController.enqueue(Uint8Array.of(0x20));
        },
      }),
      method: "POST",
    });
    const startedAt = performance.now();

    expect(
      await readBoundedUtf8Body(
        request,
        512 * 1_024,
        { readTimeoutMs: 1 },
      ),
    ).toBeNull();
    expect(cancelled).toBeTrue();
    expect(pulls).toBeLessThanOrEqual(4_097);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test("rejects a zero-byte chunk instead of spinning without progress", async () => {
    let cancelled = false;
    let pulls = 0;
    const request = new Request("https://example.test/body", {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        pull(streamController) {
          pulls += 1;
          streamController.enqueue(new Uint8Array());
        },
      }),
      method: "POST",
    });

    expect(await readBoundedUtf8Body(request, 16)).toBeNull();
    expect(cancelled).toBeTrue();
    expect(pulls).toBeLessThanOrEqual(2);
  });

  test("keeps the read deadline bounded when transport cancellation never settles", async () => {
    let cancellationStarted = false;
    const request = new Request("https://example.test/body", {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancellationStarted = true;
          return new Promise<void>(() => undefined);
        },
      }),
      method: "POST",
    });
    const startedAt = performance.now();
    expect(
      await parseBoundedJsonBody(request, 16, { readTimeoutMs: 5 }),
    ).toBeNull();
    expect(cancellationStarted).toBeTrue();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("keeps an early header rejection bounded when stream cancellation hangs", async () => {
    let cancellationStarted = false;
    const request = new Request("https://example.test/body", {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancellationStarted = true;
          return new Promise<void>(() => undefined);
        },
      }),
      headers: { "content-encoding": "gzip" },
      method: "POST",
    });
    const startedAt = performance.now();
    expect(await parseBoundedJsonBody(request, 16)).toBeNull();
    expect(cancellationStarted).toBeTrue();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("rejects invalid programmer limits", async () => {
    const request = streamedRequest([new TextEncoder().encode("{}")]);
    expect(parseBoundedJsonBody(request, -1)).rejects.toThrow(RangeError);
    expect(
      parseBoundedJsonBody(request, 16, { readTimeoutMs: -1 }),
    ).rejects.toThrow(RangeError);
    expect(
      parseBoundedJsonBody(request, 16, { readTimeoutMs: 0 }),
    ).rejects.toThrow(RangeError);
    expect(
      parseBoundedJsonBody(request, 16, { readTimeoutMs: 60_001 }),
    ).rejects.toThrow(RangeError);
  });
});
