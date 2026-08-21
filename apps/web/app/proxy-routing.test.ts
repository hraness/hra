import { describe, expect, mock, test } from "bun:test";

import {
  AUTH_PROXY_MATCHER,
  PASSWORD_ONLY_AUTH_SHOULD_HANDLE_CODE,
  shouldApplyConfiguredAuthProxy,
} from "../proxy-policy";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

await mock.module("server-only", () => ({}));

describe("HRA proxy routing", () => {
  test("runs on every route", () => {
    expect(AUTH_PROXY_MATCHER).toEqual(["/:path*"]);
    expect(PASSWORD_ONLY_AUTH_SHOULD_HANDLE_CODE).toBeFalse();
    const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
    expect(proxy).toContain('matcher: ["/:path*"]');
    expect(proxy).not.toContain("matcher: AUTH_PROXY_MATCHER");
  });

  test("actual proxy routing never invokes Convex Auth for public paths", async () => {
    const { createHraProxy } = await import("../proxy");
    const previous = process.env.NEXT_PUBLIC_CONVEX_URL;
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://configured.convex.cloud";
    const invoked: string[] = [];
    const proxy = createHraProxy((request) => {
      invoked.push(request.nextUrl.pathname);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const event: Parameters<typeof proxy>[1] = Object.create(null);
    try {
      for (const path of [
        "/",
        "/download",
        "/alternatives/codex-app",
        "/_next/static/chunk.js",
      ]) {
        const response = await proxy(
          new NextRequest(`https://hra.test${path}?code=hostile`),
          event,
        );
        expect(response?.status).toBe(200);
      }
      expect(invoked).toEqual([]);
      await proxy(new NextRequest("https://hra.test/app"), event);
      expect(invoked).toEqual(["/app"]);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
      else process.env.NEXT_PUBLIC_CONVEX_URL = previous;
    }
  });

  test("mounts Convex Auth only below authenticated route layouts", () => {
    const rootLayout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
    const authenticatedLayout = readFileSync(
      new URL("./authenticated-layout.tsx", import.meta.url),
      "utf8",
    );
    expect(rootLayout).not.toContain("ConvexAuthNextjsServerProvider");
    expect(authenticatedLayout).toContain("ConvexAuthNextjsServerProvider");
    expect(authenticatedLayout).toContain("PASSWORD_ONLY_AUTH_SHOULD_HANDLE_CODE");
    for (const path of ["./app/layout.tsx", "./auth/layout.tsx", "./pair/layout.tsx"]) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8"), path)
        .toContain("AuthenticatedLayout");
    }
  });

  test("keeps exact public assets and pages outside configured auth", () => {
    for (const path of [
      "/",
      "/_next/image",
      "/_next/static/chunks/app.js",
      "/alternatives",
      "/alternatives/",
      "/alternatives/codex-app",
      "/apple-icon",
      "/apple-icon.png",
      "/download",
      "/download/",
      "/favicon.ico",
      "/icon",
      "/icon.png",
      "/opengraph-image",
      "/robots.txt",
      "/sitemap.xml",
    ]) {
      expect(shouldApplyConfiguredAuthProxy(path), path).toBeFalse();
    }
  });

  test("keeps every near miss and control-plane route behind configured auth", () => {
    for (const path of [
      "/app",
      "/auth/sign-in",
      "/alternative",
      "/alternatives/missing",
      "/alternatives/codex-app/private",
      "/design",
      "/download/private",
      "/downloader",
      "/artifacts/HRA.dmg",
    ]) {
      expect(shouldApplyConfiguredAuthProxy(path), path).toBeTrue();
    }
  });
});
