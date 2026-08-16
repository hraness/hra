import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

const vendorRoot = new URL("../vendor/jelly-ui/", import.meta.url);

const expectedHashes = {
  LICENSE: "4a18cf475d350f854b5058493f8d7760cca29ce09f233eeb26ae52c740fcaace",
  "jelly.d.ts": "63e4455d79da343039606d644c4bda6d059855f9211cd496c3b5c91d8e9cce8f",
  "jelly.js": "c38e4e2222fcb9ecb820d5f31fd452774d07f599104c9db7ef71edcd1d38cdf9",
  "jelly.js.map": "880e5d883a58cefb6987a6e25b3580d7a1908cc3d49a440571b04e6d8163c97f",
} as const;

test("the vendored Jelly runtime matches the audited upstream artifacts", async () => {
  for (const [file, expected] of Object.entries(expectedHashes)) {
    const bytes = await Bun.file(new URL(file, vendorRoot)).arrayBuffer();
    const actual = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    expect(actual).toBe(expected);
  }

  const provenance = await Bun.file(new URL("UPSTREAM.md", vendorRoot)).text();
  expect(provenance).toContain("d898ec995f3cbe16e720c4857c13c0dceb489585");
  for (const digest of Object.values(expectedHashes)) expect(provenance).toContain(digest);
});

test("the browser bundle is vendored and never fetched from the mutable CDN", async () => {
  const loader = await Bun.file(new URL("./react/jelly-runtime.ts", import.meta.url)).text();
  expect(loader).toContain('import("../../vendor/jelly-ui/jelly.js")');
  expect(loader).not.toContain("https://jelly-ui.com");
});
