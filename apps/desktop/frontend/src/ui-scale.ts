import { useCallback, useEffect, useReducer } from "react";
import {
  createLocalStorageRecord,
  type LocalStorageRecord,
  type StorageLike,
} from "@hra-internal/browser-storage";
import { z } from "@hra-internal/schema";
import { subscribeDetectedNativeUiScaleShortcuts } from "./runtime-bridge";

export const uiScaleSteps = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5] as const;
export type UiScale = (typeof uiScaleSteps)[number];
export type UiScaleCommand = "decrease" | "increase" | "reset";

export const defaultUiScale: UiScale = 1;
// Released preferences use this exact predecessor key. The first HRA bridge
// keeps it as the sole authority instead of creating competing UI settings.
export const legacyOprteUiScaleStorageKey = "oprte:ui-scale";

const uiScalePreferenceSchema = z.strictObject({
  version: z.literal(1),
  scale: z.union([
    z.literal(0.8),
    z.literal(0.9),
    z.literal(1),
    z.literal(1.1),
    z.literal(1.2),
    z.literal(1.35),
    z.literal(1.5),
  ]),
});
type UiScalePreference = z.output<typeof uiScalePreferenceSchema>;

interface UiScaleKeyEvent {
  readonly altKey: boolean;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
}

export function createUiScalePreference(
  resolveStorage?: () => StorageLike | null,
): LocalStorageRecord<UiScalePreference> {
  return createLocalStorageRecord({
    key: legacyOprteUiScaleStorageKey,
    schema: uiScalePreferenceSchema,
    ...(resolveStorage === undefined ? {} : { resolveStorage }),
  });
}

export function loadUiScale(
  preference: Pick<LocalStorageRecord<UiScalePreference>, "load">,
): UiScale {
  const loaded = preference.load();
  return loaded.ok && loaded.value !== null ? loaded.value.scale : defaultUiScale;
}

export function moveUiScale(current: UiScale, command: UiScaleCommand): UiScale {
  if (command === "reset") return defaultUiScale;
  const currentIndex = uiScaleSteps.indexOf(current);
  const offset = command === "increase" ? 1 : -1;
  const nextIndex = Math.min(uiScaleSteps.length - 1, Math.max(0, currentIndex + offset));
  return uiScaleSteps[nextIndex] ?? defaultUiScale;
}

export function uiScaleCommandFromKey(event: UiScaleKeyEvent): UiScaleCommand | null {
  if (!event.metaKey || event.altKey || event.ctrlKey) return null;
  if (event.key === "+" || event.key === "=" || event.code === "Equal" || event.code === "NumpadAdd") {
    return "increase";
  }
  if (event.key === "-" || event.key === "_" || event.code === "Minus" || event.code === "NumpadSubtract") {
    return "decrease";
  }
  if (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0") return "reset";
  return null;
}

function initialUiScale(): UiScale {
  return loadUiScale(createUiScalePreference());
}

interface UiScaleState {
  readonly revision: number;
  readonly scale: UiScale;
}

function reduceUiScale(state: UiScaleState, command: UiScaleCommand): UiScaleState {
  const scale = moveUiScale(state.scale, command);
  return scale === state.scale ? state : { revision: state.revision + 1, scale };
}

export function useUiScale() {
  const [state, dispatch] = useReducer(
    reduceUiScale,
    undefined,
    (): UiScaleState => ({ revision: 0, scale: initialUiScale() }),
  );

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", String(state.scale));
  }, [state.scale]);

  useEffect(() => {
    if (state.revision > 0) {
      createUiScalePreference().save({ version: 1, scale: state.scale });
    }
  }, [state.revision, state.scale]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = uiScaleCommandFromKey(event);
      if (command === null) return;
      event.preventDefault();
      dispatch(command);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => subscribeDetectedNativeUiScaleShortcuts(dispatch), []);

  const decrease = useCallback(() => dispatch("decrease"), []);
  const increase = useCallback(() => dispatch("increase"), []);
  const reset = useCallback(() => dispatch("reset"), []);

  return {
    canDecrease: state.scale !== uiScaleSteps[0],
    canIncrease: state.scale !== uiScaleSteps.at(-1),
    decrease,
    increase,
    label: `${Math.round(state.scale * 100)}%`,
    reset,
    scale: state.scale,
  } as const;
}
