import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadBunNativeLicenseInventory,
  renderBunNativeLicenseNotices,
  serializeBunNativeLicenseInventory,
  verifyBunNativeLicenseInventory,
} from "../bun-native-licenses";

describe("Bun native dependency licenses", () => {
  test("covers every pinned native source and lol-html Cargo package", async () => {
    const inventory = await loadBunNativeLicenseInventory();
    expect(inventory.componentCount).toBe(22);
    expect(inventory.components).toHaveLength(22);
    expect(inventory.cargoPackageCount).toBe(43);
    expect(inventory.cargoPackages).toHaveLength(43);
    expect(inventory.documents).toHaveLength(80);
    expect(inventory.bun.completeSourceArchiveSha256).toBe(
      "3c349132dee8226d33ec169062064e66cc292a1bcb05ccb19fed84f435eac529",
    );
    expect(inventory.components.every((entry) => entry.documentSha256s.length > 0)).toBe(true);
    expect(inventory.cargoPackages.every((entry) => entry.documentSha256s.length > 0)).toBe(true);
    expect(inventory.components.map((entry) => entry.identity)).toContain(
      "TinyCC@12882eee073cfe5c7621bcfadf679e1372d4537b",
    );
    expect(inventory.components.map((entry) => entry.identity)).toContain(
      "Bun WebKit@5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    );
    const selectors = inventory.cargoPackages.find((entry) => entry.identity === "selectors-0.33.0");
    expect(selectors?.documentSha256s).toEqual([
      "66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172",
    ]);
  });

  test("keeps the checked JSON and notice rendering canonical", async () => {
    const inventory = await loadBunNativeLicenseInventory();
    const [json, notices] = await Promise.all([
      readFile(join(import.meta.dir, "../BUN-DEPENDENCY-LICENSES.json"), "utf8"),
      readFile(join(import.meta.dir, "../BUN-DEPENDENCY-LICENSES.txt"), "utf8"),
    ]);
    expect(json).toBe(serializeBunNativeLicenseInventory(inventory));
    expect(notices).toBe(renderBunNativeLicenseNotices(inventory));
    expect(createHash("sha256").update(json).digest("hex")).toBe(
      "507345b2eac69d57d8298c0db01a6e6cab40c5f864cfbc0d25f36a09bb13e578",
    );
    expect(createHash("sha256").update(notices).digest("hex")).toBe(
      "2040901aab37516e398fb21fa90646920700a9db66926b6ce7a72228699cd589",
    );
  });

  test("rejects document tampering", async () => {
    const value = JSON.parse(
      await readFile(join(import.meta.dir, "../BUN-DEPENDENCY-LICENSES.json"), "utf8"),
    ) as { documents: Array<{ text: string }> };
    value.documents[0]!.text += "tampered";
    expect(() => verifyBunNativeLicenseInventory(value)).toThrow("document hash differs");
  });
});
