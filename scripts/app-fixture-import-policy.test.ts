import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

// Exercise the effective repository policy. Disable only type-aware rules for
// these synthetic snippets; the real restriction rule still parses each import.
const eslint = new ESLint({
  cwd: resolve(import.meta.dirname, ".."),
  overrideConfig: [tseslint.configs.disableTypeChecked],
});
const restriction = "@typescript-eslint/no-restricted-imports";

async function restrictedImports(filePath: string, specifier: string, typeOnly = false): Promise<readonly string[]> {
  const source = typeOnly
    ? `import type { Value } from ${JSON.stringify(specifier)}; export type FixtureValue = Value;`
    : `import ${JSON.stringify(specifier)};`;
  const [result] = await eslint.lintText(source, { filePath });
  if (result === undefined) throw new Error("Missing fixture import-policy result.");
  expect(result.messages.filter((message) => message.fatal)).toEqual([]);
  return result.messages.filter((message) => message.ruleId === restriction).map((message) => message.message);
}

describe("browser fixture source import boundary", () => {
  test("retained build and browser evidence is ignored without excluding authored source", async () => {
    for (const path of ["tmp/build-app/input.ts", "tmp/app-browser-fixture/main.js", "tmp/site-stylex-fixture/renderer.js", "tmp/transport-fixture/driver.mjs"]) {
      expect(await eslint.isPathIgnored(path)).toBe(true);
    }
    for (const path of ["scripts/app-browser.ts", "scripts/build-site-stylex.ts", "site/foundation.ts", "app/fixtures/browser/main.tsx", "app/fixtures/product/main.tsx"]) {
      expect(await eslint.isPathIgnored(path)).toBe(false);
    }
  });
  for (const filePath of [
    "app/fixtures/browser/io.ts", "app/fixtures/browser/main.tsx",
    "app/fixtures/product/io.ts", "app/fixtures/product/main.tsx",
    "app/fixtures/product/fixtures.ts", "app/fixtures/product/definition.test.ts",
  ]) {
    test(`${filePath} admits only canonical app-source imports`, async () => {
      for (const specifier of [
        "../../src/model/session-model", "../../src/custody/custody-context",
        "../../src/data/wire", "../../src/auth/sign-in-screen.tsx",
        "../../src/screens/settings-screen", "../../src/components/ui/input",
        "../../src/components/ui/primitives.stylex.ts", "../../src/oompa/contracts",
        "../../src/index.css",
      ]) expect(await restrictedImports(filePath, specifier)).toEqual([]);
      expect(await restrictedImports(filePath, "../../src/data/wire", true)).toEqual([]);
    });

    test(`${filePath} rejects direct core imports and source-path escapes`, async () => {
      for (const specifier of [
        "../../../src/storage/paths", "../../../src/cloud/device-commands",
        "../../../src/daemon/ports", "../../../src/domain/session",
        "../../../src/cloud/contracts", "../../src/../../src/storage/paths",
        "../../src/data/../../../src/storage/paths", "../../src/../src/storage/paths",
        "../../src//storage/paths", "/src/storage/paths", "src/storage/paths",
      ]) expect(await restrictedImports(filePath, specifier)).toHaveLength(1);
      expect(await restrictedImports(filePath, "../../../src/storage/paths", true)).toHaveLength(1);
    });
  }

  test("the exception does not change other app or fixture-file restrictions", async () => {
    for (const filePath of ["app/fixtures/browser/config.ts", "app/fixtures/product/config.ts", "app/fixtures/product/definition.ts", "app/src/screens/settings-screen.tsx"]) {
      expect(await restrictedImports(filePath, "../../src/data/wire")).toHaveLength(1);
      expect(await restrictedImports(filePath, "../../../src/storage/paths")).toHaveLength(1);
    }
    expect(await restrictedImports("app/src/oompa/contracts.ts", "../../../src/cloud/contracts")).toEqual([]);
  });
});
