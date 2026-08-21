import { describe, expect, test } from "bun:test";

import {
  config,
  shouldApplyConfiguredAuthProxy,
} from "../proxy";

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text();
}

describe("HRA proxy routing", () => {
  test("runs on every route", () => {
    expect(config.matcher).toEqual(["/:path*"]);
  });

  test("does not import next.config into the edge proxy bundle", async () => {
    const proxy = await source("../proxy.ts");
    expect(proxy).toContain('from "./response-headers"');
    expect(proxy).not.toContain("next.config");
    expect(proxy).not.toContain("hra-icon-runtime");
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
      "/llms.txt",
      "/llms.txt/",
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
