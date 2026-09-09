import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { productIoModules, productIoPlugin } from "./config";

const root = resolve(import.meta.dirname, "../../..");
const importer = resolve(root, "app/src/screens/session-screen.tsx");

async function resolveImport(source: string) {
  const hook = productIoPlugin(root).resolveId;
  if (typeof hook !== "function") throw new Error("Expected a synchronous product IO boundary.");
  return hook.call({} as never, source, importer, { attributes: {}, isEntry: false });
}

describe("product example IO-only graph boundary", () => {
  test("maps every owned relative and absolute IO entry to one fixture adapter", async () => {
    const adapter = resolve(root, "app/fixtures/product/io.ts");
    for (const path of productIoModules) expect(await resolveImport(resolve(root, path))).toBe(adapter);
    for (const source of ["../data/commands", "../custody/custody-context", "../routing/router", "@convex-dev/auth/react"]) {
      expect(await resolveImport(source)).toBe(adapter);
    }
  });

  test("rejects unowned account, transport, storage and registry IO", async () => {
    for (const source of [
      "convex", "convex/react", "convex/browser", "@convex-dev/auth/server",
      "../data/functions", "../data/compact-history", "../custody/keystore", "../auth/provider",
      resolve(root, "app/src/data/functions.ts"),
    ]) await expect(resolveImport(source)).rejects.toThrow();
  });

  test("leaves real screens, components, reducers, styles and browser-safe contracts untouched", async () => {
    for (const source of [
      "./grid-screen", "../components/interaction-panel", "../components/ui/button",
      "../model/session-model", "../model/settings-view", "./session-screen.stylex", "../hra/cloud", "react",
    ]) expect(await resolveImport(source)).toBeNull();
    expect(productIoModules.some((path) => /\/(?:screens|components|model)\//u.test(path))).toBe(false);
  });
});
