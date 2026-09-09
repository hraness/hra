import { expect, test } from "bun:test";
import assert from "node:assert/strict";

async function assertDarkShell(source: string): Promise<void> {
  const roots: (string | null)[] = [];
  const schemes: (string | null)[] = [];
  await new HTMLRewriter()
    .on("html", { element(element) { roots.push(element.getAttribute("data-theme")); } })
    .on('meta[name="color-scheme"]', { element(element) { schemes.push(element.getAttribute("content")); } })
    .transform(new Response(source)).arrayBuffer();
  assert.deepEqual(roots, ["dark"], "HRA must explicitly select the public dark foundation");
  assert.deepEqual(schemes, ["dark"], "HRA must retain its fixed-dark scheme before styles load");
}

test("the app shell selects its fixed-dark appearance before and after foundation delivery", async () => {
  const source = await Bun.file(new URL("../index.html", import.meta.url)).text();
  await assertDarkShell(source);
});

test("appearance proof rejects absent or light theme and OS-dependent early schemes", async () => {
  const source = await Bun.file(new URL("../index.html", import.meta.url)).text();
  for (const changed of [
    source.replace(' data-theme="dark"', ""),
    source.replace('data-theme="dark"', 'data-theme="light"'),
    source.replace('name="color-scheme" content="dark"', 'name="color-scheme" content="dark light"'),
    source.replace('name="color-scheme" content="dark"', 'name="color-scheme" content="light"'),
  ]) await expect(assertDarkShell(changed)).rejects.toThrow();
});

test("the installed foundation exposes the selected explicit dark token boundary", async () => {
  const foundationUrl = new URL(import.meta.resolve("@hraness/ui/compiler-foundation.css"));
  const foundation = await Bun.file(foundationUrl).text();
  expect(foundation).toContain('@import "./tokens.css";');
  const tokens = await Bun.file(new URL("./tokens.css", foundationUrl)).text();
  // These are public selectors, not generated recipe/class-name snapshots.
  expect(tokens).toMatch(/:root\[data-theme="dark"\],\s*\[data-theme="dark"\],\s*\.dark\s*\{\s*color-scheme:\s*dark;/u);
  const appCss = await Bun.file(new URL("./index.css", import.meta.url)).text();
  expect(appCss).toMatch(/@layer base\s*\{\s*html\s*\{[^}]*color-scheme:\s*dark;/u);
});
