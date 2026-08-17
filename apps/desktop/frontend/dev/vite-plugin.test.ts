import { expect, test } from "bun:test";

import {
  HRA_DEVELOPMENT_ENTRY_PATH,
  hraDevEntryPlugin,
  rewriteHraDevelopmentEntry,
} from "./vite-plugin";

test("the serve-only plugin swaps exactly one renderer entry", () => {
  const source = '<main></main><script type="module" src="/src/main.tsx"></script>';
  expect(rewriteHraDevelopmentEntry(source)).toContain(
    `src="${HRA_DEVELOPMENT_ENTRY_PATH}"`,
  );
  expect(() => rewriteHraDevelopmentEntry("<main></main>")).toThrow(
    "exactly one production renderer entry",
  );
  expect(hraDevEntryPlugin().apply).toBe("serve");
});

test("the production renderer entry has no development graph edge", async () => {
  const productionEntry = await Bun.file(new URL("../src/main.tsx", import.meta.url)).text();
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(productionEntry).not.toMatch(/frontend\/dev|\.\.\/dev|\/dev\//u);
  expect(html).toContain('src="/src/main.tsx"');
  expect(html).not.toContain(HRA_DEVELOPMENT_ENTRY_PATH);
});
