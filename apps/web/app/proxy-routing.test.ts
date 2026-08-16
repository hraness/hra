import { describe, expect, test } from "bun:test";

import {
  config,
  shouldApplyConfiguredAuthProxy,
} from "../proxy";

describe("HRA proxy routing", () => {
  test("runs on every route", () => {
    expect(config.matcher).toEqual(["/:path*"]);
  });

  test("keeps exact public assets and pages outside configured auth", () => {
    for (const path of [
      "/",
      "/_next/image",
      "/_next/static/chunks/app.js",
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
      "/design",
      "/download/private",
      "/downloader",
      "/artifacts/HRA.dmg",
    ]) {
      expect(shouldApplyConfiguredAuthProxy(path), path).toBeTrue();
    }
  });
});
