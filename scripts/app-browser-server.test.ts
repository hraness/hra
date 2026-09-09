import { expect, test } from "bun:test";
import { browserAssetResponse, browserServerCloser } from "./app-browser-server.ts";
import { assetContentType, assetPath } from "./app-browser.ts";

const files = new Map([
  ["index.html", Buffer.from("<!doctype html><h1>Fixture</h1>")],
  ["preview/index.html", Buffer.from("<!doctype html><h1>Preview</h1>")],
  ["stylex.css", Buffer.from(".x{color:red}")],
  ["fonts/geist-mono/GeistMono[wght].woff2", Buffer.from("font fixture")],
]);
const options = { files, csp: "default-src 'none'; script-src 'self'", previewCsp: "default-src 'none'; script-src 'none'", assetPath, contentType: assetContentType };

test("Node HTTP projection preserves bytes, method policy, no-store and per-surface CSP", () => {
  const home = browserAssetResponse({ ...options, method: "GET", url: "/" });
  expect(home.status).toBe(200); expect(home.body).toEqual(files.get("index.html"));
  expect(home.headers).toEqual({ "Cache-Control": "no-store", "Content-Security-Policy": options.csp,
    "Content-Type": "text/html; charset=utf-8", "Cross-Origin-Opener-Policy": "same-origin", "X-Content-Type-Options": "nosniff" });
  const head = browserAssetResponse({ ...options, method: "HEAD", url: "/" });
  expect(head.body).toBeUndefined(); expect(head.headers).toEqual(home.headers);
  expect(browserAssetResponse({ ...options, method: "GET", url: "/preview/" }).headers["Content-Security-Policy"]).toBe(options.previewCsp);
  expect(browserAssetResponse({ ...options, method: "POST", url: "/" }).status).toBe(405);
  expect(browserAssetResponse({ ...options, method: "GET", url: "/missing" }).status).toBe(404);
  expect(browserAssetResponse({ ...options, method: "GET", url: "/fonts/geist-mono/GeistMono%5Bwght%5D.woff2" }).body)
    .toEqual(files.get("fonts/geist-mono/GeistMono[wght].woff2"));
});

test("Node HTTP projection rejects non-origin targets and never serves receipts or graph inputs", () => {
  for (const url of [undefined, "http://outside.invalid/", "//outside.invalid/", `/${"a".repeat(8192)}`]) {
    expect(browserAssetResponse({ ...options, method: "GET", url }).status).toBe(400);
  }
  for (const url of ["/receipt.json", "/driver.mjs", "/source.ts", "/fonts/private.otf", "/%2e%2e/source.ts"]) {
    expect(browserAssetResponse({ ...options, method: "GET", url }).status).toBe(404);
  }
});

test("concurrent server stop callers both await the same positive listener and connection closure", async () => {
  let finish: () => void = () => { throw new Error("Missing close resolver"); };
  const closed = new Promise<void>((done) => { finish = done; });
  let calls = 0, listening = true, connections = 1;
  const stop = browserServerCloser({
    close: () => { calls += 1; return closed; },
    terminateConnections: () => { connections = 0; },
    listening: () => listening, connections: () => connections,
  });
  const first = stop(), second = stop();
  expect(first).toBe(second); expect(calls).toBe(1);
  let settled = false; const observed = first.then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  listening = false; finish(); await Promise.all([observed, second]);
  expect(settled).toBe(true);
});

test("failed server closure is sticky and cannot fabricate a successful retry", async () => {
  const failure = new Error("fixture close failed"); let calls = 0;
  const stop = browserServerCloser({ close: () => { calls += 1; return Promise.reject(failure); },
    terminateConnections: () => {}, listening: () => false, connections: () => 0 });
  await expect(stop()).rejects.toBe(failure); await expect(stop()).rejects.toBe(failure); expect(calls).toBe(1);
  const surviving = browserServerCloser({ close: () => Promise.resolve(), terminateConnections: () => {}, listening: () => true, connections: () => 0 });
  await expect(surviving()).rejects.toThrow("listener survived");
});
