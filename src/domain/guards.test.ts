import { describe, expect, test } from "bun:test";

import { snapshotForeignJson } from "./guards";

describe("foreign JSON snapshots", () => {
  test("bounds property names and preserves prototype-shaped keys as own data", () => {
    expect(snapshotForeignJson({ ["k".repeat(350_001)]: null })).toEqual({ ok: false });
    const snapshot = snapshotForeignJson(Object.fromEntries([["__proto__", "safe"]]));
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok || typeof snapshot.value !== "object" || snapshot.value === null) return;
    expect(Object.getPrototypeOf(snapshot.value)).toBeNull();
    expect(Object.hasOwn(snapshot.value, "__proto__")).toBe(true);
    expect((snapshot.value as Record<string, unknown>).__proto__).toBe("safe");
  });
});
