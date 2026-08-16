import { describe, expect, test } from "bun:test";
import { z } from "@hra-internal/schema";

import {
  StrictHumanHttpClient,
  normalizeApiOrigin,
  readBoundedJsonResponse,
} from "./strict-http";

const successSchema = z.object({ value: z.string() }).strict();
const failureSchema = z.object({ code: z.string() }).strict();

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

describe("strict human HTTP transport", () => {
  test("parses typed same-origin success and failure envelopes", async () => {
    const responses = [
      Response.json({ value: "ready" }),
      Response.json({ code: "CONFLICT" }, { status: 409 }),
    ];
    const captured: { readonly url: string; readonly init?: RequestInit }[] = [];
    const client = new StrictHumanHttpClient({
      apiUrl: "https://hra.example.com",
      fetch: (input, init) => {
        captured.push({
          url: inputUrl(input),
          ...(init === undefined ? {} : { init }),
        });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return Promise.resolve(response);
      },
    });

    const success = await client.request({
      method: "POST",
      path: "/v1/workspaces",
      query: { cursor: "next/page" },
      bearerToken: "access-token-that-is-long-enough",
      body: {
        kind: "json",
        value: { value: "request" },
        schema: successSchema,
      },
      successSchema,
      failureSchema,
    });
    const failure = await client.request({
      method: "GET",
      path: "/v1/workspaces/workspace-1",
      successSchema,
      failureSchema,
    });

    expect(success).toEqual({ ok: true, status: 200, data: { value: "ready" } });
    expect(failure).toEqual({
      ok: false,
      kind: "http",
      status: 409,
      data: { code: "CONFLICT" },
    });
    expect(captured[0]?.url).toBe(
      "https://hra.example.com/v1/workspaces?cursor=next%2Fpage",
    );
    expect(captured[0]?.init?.redirect).toBe("error");
    expect(
      new Headers(captured[0]?.init?.headers).get("Authorization"),
    ).toBe("Bearer access-token-that-is-long-enough");
  });

  test("rejects redirects without following them or exposing Location", async () => {
    let calls = 0;
    const client = new StrictHumanHttpClient({
      apiUrl: "https://hra.example.com",
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { Location: "https://attacker.example/collect" },
          }),
        );
      },
    });

    const result = await client.request({
      method: "GET",
      path: "/v1/workspaces",
      successSchema,
      failureSchema,
      bearerToken: "refresh-token-that-must-not-leak",
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "transport",
      error: { reason: "redirect" },
    });
    expect(JSON.stringify(result)).not.toContain("attacker.example");
    expect(JSON.stringify(result)).not.toContain("refresh-token");
    expect(calls).toBe(1);
  });

  test("rejects cross-origin paths before invoking fetch", async () => {
    let calls = 0;
    const client = new StrictHumanHttpClient({
      apiUrl: "https://hra.example.com",
      fetch: () => {
        calls += 1;
        return Promise.resolve(Response.json({ value: "unexpected" }));
      },
    });

    const result = await client.request({
      method: "GET",
      path: "//attacker.example/collect",
      successSchema,
      failureSchema,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "transport",
      error: { reason: "invalid_request" },
    });
    expect(calls).toBe(0);
  });

  test("rejects oversized request bodies and invalid headers before fetch", async () => {
    let calls = 0;
    const client = new StrictHumanHttpClient({
      apiUrl: "https://hra.example.com",
      maxRequestBytes: 32,
      fetch: () => {
        calls += 1;
        return Promise.resolve(Response.json({ value: "unexpected" }));
      },
    });
    const oversized = await client.request({
      method: "POST",
      path: "/v1/workspaces",
      body: {
        kind: "form",
        value: new URLSearchParams({ value: "x".repeat(64) }),
      },
      successSchema,
      failureSchema,
    });
    const invalidHeader = await client.request({
      method: "GET",
      path: "/v1/workspaces",
      headers: { "x-invalid\nheader": "value" },
      successSchema,
      failureSchema,
    });

    expect(oversized).toMatchObject({
      ok: false,
      kind: "transport",
      error: { reason: "invalid_request" },
    });
    expect(invalidHeader).toMatchObject({
      ok: false,
      kind: "transport",
      error: { reason: "invalid_request" },
    });
    expect(calls).toBe(0);
  });

  test("rejects declared and streamed oversized responses", async () => {
    const declared = await readBoundedJsonResponse(
      new Response("{}", {
        headers: {
          "Content-Length": "4097",
          "Content-Type": "application/json",
        },
      }),
      { maxBytes: 4_096, requireJsonContentType: true },
    );
    const streamed = await readBoundedJsonResponse(
      new Response(JSON.stringify({ value: "x".repeat(4_096) }), {
        headers: { "Content-Type": "application/json" },
      }),
      { maxBytes: 1_024, requireJsonContentType: true },
    );

    expect(declared).toEqual({ ok: false, reason: "oversized_response" });
    expect(streamed).toEqual({ ok: false, reason: "oversized_response" });
  });

  test("rejects invalid JSON and non-JSON media types", async () => {
    const invalid = await readBoundedJsonResponse(
      new Response("{not-json", {
        headers: { "Content-Type": "application/json" },
      }),
      { maxBytes: 1_024, requireJsonContentType: true },
    );
    const wrongType = await readBoundedJsonResponse(
      new Response("{}", { headers: { "Content-Type": "text/plain" } }),
      { maxBytes: 1_024, requireJsonContentType: true },
    );

    expect(invalid).toEqual({ ok: false, reason: "invalid_response" });
    expect(wrongType).toEqual({ ok: false, reason: "invalid_response" });
  });

  test("bounds a fetch that ignores abort", async () => {
    const client = new StrictHumanHttpClient({
      apiUrl: "https://hra.example.com",
      requestTimeoutMs: 1,
      fetch: () => new Promise<Response>(() => undefined),
    });

    const result = await client.request({
      method: "GET",
      path: "/v1/workspaces",
      successSchema,
      failureSchema,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "transport",
      error: { reason: "timeout" },
    });
  });

  test("normalizes only safe HTTPS or exact loopback HTTP origins", () => {
    expect(normalizeApiOrigin("https://hra.example.com")).toBe(
      "https://hra.example.com",
    );
    expect(normalizeApiOrigin("http://127.0.0.1:3211")).toBe(
      "http://127.0.0.1:3211",
    );
    expect(normalizeApiOrigin("http://127.0.0.2:3211")).toBeNull();
    expect(normalizeApiOrigin("https://user:secret@example.com")).toBeNull();
    expect(normalizeApiOrigin("https://example.com/?token=secret")).toBeNull();
  });
});
