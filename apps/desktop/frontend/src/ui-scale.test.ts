import { expect, test } from "bun:test";
import {
  defaultUiScale,
  createUiScalePreference,
  loadUiScale,
  moveUiScale,
  uiScaleCommandFromKey,
  legacyOprteUiScaleStorageKey,
  uiScaleSteps,
} from "./ui-scale";
import type { StorageLike } from "@hra-internal/browser-storage";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("versioned UI scale preference round-trips and defaults without clearing corrupt data", () => {
  const storage = new MemoryStorage();
  const preference = createUiScalePreference(() => storage);

  expect(loadUiScale(preference)).toBe(defaultUiScale);
  expect(preference.save({ version: 1, scale: 1.2 })).toEqual({ ok: true, value: undefined });
  expect(loadUiScale(preference)).toBe(1.2);

  expect(legacyOprteUiScaleStorageKey).toBe("oprte:ui-scale");
  storage.setItem(legacyOprteUiScaleStorageKey, "{");
  expect(loadUiScale(preference)).toBe(defaultUiScale);
  expect(storage.getItem(legacyOprteUiScaleStorageKey)).toBe("{");
});

test("UI scale movement is bounded and resettable", () => {
  const maximum = uiScaleSteps.at(-1) ?? defaultUiScale;
  expect(moveUiScale(1, "increase")).toBe(1.1);
  expect(moveUiScale(1, "decrease")).toBe(0.9);
  expect(moveUiScale(1.35, "reset")).toBe(1);
  expect(moveUiScale(uiScaleSteps[0], "decrease")).toBe(uiScaleSteps[0]);
  expect(moveUiScale(maximum, "increase")).toBe(maximum);
});

test("macOS text-size shortcuts support the main keyboard and keypad", () => {
  const event = {
    altKey: false,
    code: "Equal",
    ctrlKey: false,
    key: "+",
    metaKey: true,
  };
  expect(uiScaleCommandFromKey(event)).toBe("increase");
  expect(uiScaleCommandFromKey({ ...event, code: "Minus", key: "-" })).toBe("decrease");
  expect(uiScaleCommandFromKey({ ...event, code: "Digit0", key: "0" })).toBe("reset");
  expect(uiScaleCommandFromKey({ ...event, code: "NumpadAdd", key: "Add" })).toBe("increase");
  expect(uiScaleCommandFromKey({ ...event, metaKey: false })).toBeNull();
  expect(uiScaleCommandFromKey({ ...event, ctrlKey: true })).toBeNull();
  expect(uiScaleCommandFromKey({ ...event, altKey: true })).toBeNull();
});
