import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { siteStylexTestFilter } from "./register-site-stylex-test-transform";

test("site test compilation admits its shared native menu without opening app or core source", () => {
  const root = resolve(import.meta.dirname, "..");
  for (const name of [
    "site/template.ts", "site/marketing.tsx", "site/presentation.stylex.ts",
    "app/src/components/appearance-menu.tsx", "app/src/components/appearance-menu.stylex.ts",
  ]) expect(siteStylexTestFilter.test(resolve(root, name))).toBe(true);
  for (const name of [
    "app/src/components/appearance.tsx", "app/src/appearance.ts", "app/src/main.tsx",
    "app/src/components/appearance-menu.test.tsx", "app/src/components/appearance-menu-extra.tsx",
    "app/fixtures/browser/main.tsx", "src/cloud/client.ts", "src/storage/paths.ts",
    "site/template.css", "site-unrelated/template.ts", "scripts/build-site.ts",
  ]) expect(siteStylexTestFilter.test(resolve(root, name))).toBe(false);
});
