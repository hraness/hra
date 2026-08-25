import { describe, expect, test } from "bun:test";

import { createBoundedAuthorityFetch } from "./bounded-authority-fetch";

describe("bounded authority transport", () => {
  test("returns at the deadline even when the transport ignores AbortSignal", async () => {
    let signal: AbortSignal | undefined;
    const hostileFetch = Object.assign((
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      signal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    }, { preconnect: () => undefined }) as typeof fetch;
    const startedAt = performance.now();
    await expect(createBoundedAuthorityFetch(
      hostileFetch,
      10,
      "authority_timeout",
    )("https://example.com")).rejects.toThrow("authority_timeout");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(signal?.aborted).toBeTrue();
  });

  test("settles once and consumes a late rejection after the deadline", async () => {
    let rejectLate: ((reason: unknown) => void) | undefined;
    const hostileFetch = Object.assign((): Promise<Response> =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      }), { preconnect: () => undefined }) as typeof fetch;
    const bounded = createBoundedAuthorityFetch(hostileFetch, 10, "authority_timeout");
    await expect(bounded("https://example.com")).rejects.toThrow("authority_timeout");
    rejectLate?.(new Error("late_transport_failure"));
    await Bun.sleep(0);
  });

  test("cancels a late response body after a signal-ignoring transport fulfills", async () => {
    let resolveLate: ((response: Response) => void) | undefined;
    let bodyCancelled = false;
    const hostileFetch = Object.assign((): Promise<Response> =>
      new Promise((resolve) => {
        resolveLate = resolve;
      }), { preconnect: () => undefined }) as typeof fetch;
    const bounded = createBoundedAuthorityFetch(hostileFetch, 10, "authority_timeout");
    await expect(bounded("https://example.com")).rejects.toThrow("authority_timeout");
    resolveLate?.(new Response(new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
      pull() {
        return new Promise(() => undefined);
      },
    })));
    await Bun.sleep(0);
    expect(bodyCancelled).toBeTrue();
  });

  test("cancels a returned body at the deadline even when nobody consumes it", async () => {
    let bodyCancelled = false;
    const bounded = createBoundedAuthorityFetch(Object.assign(
      (): Promise<Response> => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true;
        },
        pull() {
          return new Promise(() => undefined);
        },
      }))),
      { preconnect: () => undefined },
    ) as typeof fetch, 10, "authority_timeout");
    await bounded("https://example.com");
    await Bun.sleep(25);
    expect(bodyCancelled).toBeTrue();
  });

  test("keeps the hard deadline through a signal-ignoring response body", async () => {
    let bodyCancelled = false;
    let signal: AbortSignal | undefined;
    const hostileFetch = Object.assign((
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true;
        },
        pull() {
          return new Promise(() => undefined);
        },
      }), { status: 200 }));
    }, { preconnect: () => undefined }) as typeof fetch;
    const bounded = createBoundedAuthorityFetch(hostileFetch, 10, "authority_body_timeout");
    const startedAt = performance.now();
    await expect((await bounded("https://example.com")).json())
      .rejects.toThrow("authority_body_timeout");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(signal?.aborted).toBeTrue();
    expect(bodyCancelled).toBeTrue();
  });

  test("preserves headers and completes only after the bounded body is consumed", async () => {
    const source = new Response('{"ready":true}', {
      headers: { "content-type": "application/json", "x-authority": "exact" },
      status: 200,
    });
    Object.defineProperties(source, {
      redirected: { value: true },
      type: { value: "cors" },
      url: { value: "https://downloads.example.test/final" },
    });
    const bounded = createBoundedAuthorityFetch(Object.assign(
      (): Promise<Response> => Promise.resolve(source),
      { preconnect: () => undefined },
    ) as typeof fetch, 100, "authority_timeout");
    const response = await bounded("https://example.com");
    expect(response.headers.get("x-authority")).toBe("exact");
    expect(response.url).toBe("https://downloads.example.test/final");
    expect(response.redirected).toBe(true);
    expect(response.type).toBe("cors");
    expect(await response.json()).toEqual({ ready: true });
  });
});
