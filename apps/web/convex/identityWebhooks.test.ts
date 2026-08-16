import { describe, expect, test } from "bun:test";

import { readWorkOSWebhookPayload } from "./identityWebhooks";

const maximumWebhookBodyBytes = 256 * 1_024;

describe("WorkOS webhook request boundary", () => {
  test("retains every signed UTF-8 byte including a leading BOM", async () => {
    const signed = Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d);
    const request = new Request("https://example.test/webhooks/workos", {
      body: signed,
      headers: { "content-length": String(signed.byteLength) },
      method: "POST",
    });

    expect(await readWorkOSWebhookPayload(request)).toEqual(signed);
  });

  test("rejects an oversized declared body before reading it", async () => {
    let cancelled = false;
    const request = new Request("https://example.test/webhooks/workos", {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      headers: {
        "content-length": String(maximumWebhookBodyBytes + 1),
      },
      method: "POST",
    });

    expect(await readWorkOSWebhookPayload(request)).toBeNull();
    expect(cancelled).toBeTrue();
  });

  test("rejects and cancels an oversized chunked body", async () => {
    let cancelled = false;
    const request = new Request("https://example.test/webhooks/workos", {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        start(controller) {
          controller.enqueue(
            new Uint8Array(maximumWebhookBodyBytes + 1).fill(0x20),
          );
        },
      }),
      method: "POST",
    });

    expect(await readWorkOSWebhookPayload(request)).toBeNull();
    expect(cancelled).toBeTrue();
  });

  test("cancels a stalled upload promptly when the client disconnects", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const request = new Request("https://example.test/webhooks/workos", {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      method: "POST",
      signal: controller.signal,
    });
    const startedAt = performance.now();
    const payload = readWorkOSWebhookPayload(request);
    setTimeout(() => controller.abort(), 5);

    expect(await payload).toBeNull();
    expect(cancelled).toBeTrue();
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});
