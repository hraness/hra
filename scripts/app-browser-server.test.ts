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

test("product examples alone receive their exact opaque-frame CSP and public CORS without credentials", () => {
  const productPreviewCsp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";
  const productFiles = new Map([...files,
    ["examples/app/index.html", Buffer.from("<!doctype html><h1>Fictional example</h1>")],
    ["examples/app/stylex.css", Buffer.from(".compiled{display:flex}")],
    ["examples/app/graphs/client/assets/main-123.js", Buffer.from("export{};")],
    ["examples/app/graphs/client/assets/foundation-456.css", Buffer.from(":root{color-scheme:dark}")],
  ]);
  const inputs = { ...options, files: productFiles, productPreviewCsp };
  for (const url of ["/examples/app/?view=overview", "/examples/app/index.html?view=question", "/examples/app/stylex.css", "/examples/app/graphs/client/assets/main-123.js", "/examples/app/graphs/client/assets/foundation-456.css"]) {
    const response = browserAssetResponse({ ...inputs, method: "GET", url });
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "Content-Security-Policy": productPreviewCsp, "Access-Control-Allow-Origin": "*",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
    });
    expect(Object.hasOwn(response.headers, "Access-Control-Allow-Credentials")).toBe(false);
    expect(Object.hasOwn(response.headers, "X-Frame-Options")).toBe(false);
    expect(Object.hasOwn(response.headers, "Cross-Origin-Opener-Policy")).toBe(false);
    const head = browserAssetResponse({ ...inputs, method: "HEAD", url });
    expect(head.headers).toEqual(response.headers);
    expect(head.body).toBeUndefined();
  }
  for (const url of ["/", "/preview/", "/stylex.css"]) {
    const response = browserAssetResponse({ ...inputs, method: "GET", url });
    expect(Object.hasOwn(response.headers, "Access-Control-Allow-Origin")).toBe(false);
    expect(response.headers["Content-Security-Policy"]).toBe(url === "/preview/" ? options.previewCsp : options.csp);
  }
  expect(browserAssetResponse({ ...options, files: productFiles, method: "GET", url: "/examples/app/index.html" }).status).toBe(404);
  expect(browserAssetResponse({ ...inputs, method: "OPTIONS", url: "/examples/app/index.html" }).status).toBe(405);
});

test("product example serving refuses unregistered metadata and source even if present in the supplied map", () => {
  for (const key of ["examples/app/stylex-complete.json", "examples/app/graphs/client/receipt.json", "examples/app/source.ts", "examples/app/graphs/client/assets/input.ts", "examples/app/private/index.html"]) {
    const response = browserAssetResponse({ ...options, files: new Map([...files, [key, Buffer.from("private")]]), productPreviewCsp: options.csp, method: "GET", url: `/${key}` });
    expect(response.status).toBe(404);
    expect(response.body).toBeUndefined();
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
