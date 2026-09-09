import { designPaletteLabels, designPalettes, designThemes, parseDesignPalettePreference } from "@hraness/design-kit";
import { initDesignPalette } from "@hraness/design-kit/browser";

export const hraAppearanceStorageKey = "hraness-design-palette-v1";
const maximumPreferenceLength = 256;
type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

/** This adapter can persist only the bounded, non-sensitive appearance key. */
export function hraAppearanceStorage(storage: AppearanceStorage | null): AppearanceStorage | null {
  if (storage === null) return null;
  return {
    getItem(key) {
      if (key !== hraAppearanceStorageKey) return null;
      const value = storage.getItem(key);
      if (value === null || value.length > maximumPreferenceLength) return null;
      const preference = parseDesignPalettePreference(value);
      return preference === null ? null : JSON.stringify(preference);
    },
    setItem(key, value) {
      if (key !== hraAppearanceStorageKey || value.length > maximumPreferenceLength) return;
      const preference = parseDesignPalettePreference(value);
      if (preference !== null) storage.setItem(key, JSON.stringify(preference));
    },
  };
}

export function initializeHraAppearance(document: Document) {
  let storage: AppearanceStorage | null = null;
  try { storage = document.defaultView?.localStorage ?? null; } catch { /* Appearance remains available in memory. */ }
  return initDesignPalette({
    document,
    legacyStorageKey: null,
    storage: hraAppearanceStorage(storage),
    storageKey: hraAppearanceStorageKey,
  });
}

/** Native public-site controls share the app's controller without inline styles. */
export function bindHraAppearanceMenus(
  document: Document,
  controller: ReturnType<typeof initializeHraAppearance>,
): () => void {
  const view = document.defaultView;
  if (view === null) return () => undefined;
  const menus = [...document.querySelectorAll<HTMLDetailsElement>("details[data-hra-appearance]")];
  const update = (): void => {
    const { preference } = controller.getSnapshot();
    const modeLabel = preference.mode === "system" ? "System" : preference.mode === "dark" ? "Dark" : "Light";
    for (const menu of menus) {
      const palette = menu.querySelector<HTMLSelectElement>("select[data-hra-palette]");
      const mode = menu.querySelector<HTMLSelectElement>("select[data-hra-mode]");
      if (palette !== null) palette.value = preference.palette;
      if (mode !== null) mode.value = preference.mode;
      menu.querySelector("summary")?.setAttribute("aria-label", `Appearance: ${designPaletteLabels[preference.palette]}, ${modeLabel}`);
    }
  };
  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof view.HTMLSelectElement)) return;
    if (!menus.some((menu) => menu.contains(target))) return;
    const { preference } = controller.getSnapshot();
    const palette = designPalettes.find((value) => value === target.value);
    const mode = designThemes.find((value) => value === target.value);
    if (target.hasAttribute("data-hra-palette") && palette !== undefined) controller.setPreference({ ...preference, palette });
    if (target.hasAttribute("data-hra-mode") && mode !== undefined) controller.setPreference({ ...preference, mode });
  };
  const onPointerDown = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof view.Node)) return;
    for (const menu of menus) if (!menu.contains(target)) menu.open = false;
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    for (const menu of menus) {
      if (!menu.open) continue;
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  };
  update();
  const unsubscribe = controller.subscribe(update);
  document.addEventListener("change", onChange);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeyDown);
  return () => {
    unsubscribe();
    document.removeEventListener("change", onChange);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeyDown);
  };
}
