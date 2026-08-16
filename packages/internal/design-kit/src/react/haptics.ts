"use client";

import { useCallback, useEffect } from "react";
import type { WebHaptics } from "web-haptics";

export type HapticFeedback = "error" | "press" | "selection" | "success" | "warning";
export type HapticFeedbackInput = "error" | "medium" | "selection" | "success" | "warning";

/**
 * Browser-only proof seam emitted after Web Haptics accepts and completes a
 * semantic trigger. Product behavior must never depend on this event.
 */
export const HAPTIC_FEEDBACK_EVENT_NAME = "hra:haptic-feedback";

export interface HapticFeedbackEventDetail {
  readonly feedback: HapticFeedback;
  readonly input: HapticFeedbackInput;
}

export interface HapticBrowserEnvironment {
  readonly document?: unknown;
  readonly navigator?: unknown;
  readonly window?: unknown;
}

type HapticEngine = Pick<WebHaptics, "cancel" | "destroy" | "trigger">;
type HapticEngineConstructor = new (
  options?: Readonly<{ debug?: boolean; showSwitch?: boolean }>,
) => HapticEngine;

export interface HapticModule {
  readonly WebHaptics: HapticEngineConstructor;
}

export interface HapticFeedbackController {
  readonly cancel: () => boolean;
  readonly dispose: () => void;
  readonly prepare: () => Promise<boolean>;
  readonly trigger: (feedback?: HapticFeedback) => Promise<boolean>;
}

/** The adapter is deliberately inert during SSR and other DOM-less runtimes. */
export function isHapticBrowserEnvironment(
  environment: HapticBrowserEnvironment = globalThis,
): boolean {
  return typeof environment.window === "object"
    && typeof environment.document === "object"
    && typeof environment.navigator === "object";
}

/** Maps product-neutral intent to WebHaptics' short semantic presets. */
export function hapticInputForFeedback(feedback: HapticFeedback): HapticFeedbackInput {
  switch (feedback) {
    case "error":
      return "error";
    case "press":
      return "medium";
    case "selection":
      return "selection";
    case "success":
      return "success";
    case "warning":
      return "warning";
  }
}

function hasCustomEventConstructor(
  candidate: unknown,
): candidate is Readonly<{ CustomEvent: typeof CustomEvent }> {
  return typeof candidate === "object"
    && candidate !== null
    && "CustomEvent" in candidate
    && typeof candidate.CustomEvent === "function";
}

function hasEventDispatcher(
  candidate: unknown,
): candidate is Readonly<{ dispatchEvent: (event: Event) => boolean }> {
  return typeof candidate === "object"
    && candidate !== null
    && "dispatchEvent" in candidate
    && typeof candidate.dispatchEvent === "function";
}

function dispatchHapticFeedbackEvent(
  environment: HapticBrowserEnvironment,
  detail: HapticFeedbackEventDetail,
): void {
  if (!hasCustomEventConstructor(environment.window)
    || !hasEventDispatcher(environment.document)) return;
  try {
    environment.document.dispatchEvent(
      new environment.window.CustomEvent<HapticFeedbackEventDetail>(
        HAPTIC_FEEDBACK_EVENT_NAME,
        { detail },
      ),
    );
  } catch {
    // The verification signal is observational and must not affect feedback.
  }
}

function cancelAndDestroy(candidate: HapticEngine): void {
  try {
    candidate.cancel();
  } catch {
    // Continue into destroy even if a browser backend rejects cancellation.
  }
  try {
    candidate.destroy();
  } catch {
    // Optional feedback must never make application teardown fail.
  }
}

/**
 * Isolated lifecycle controller. Passing the environment and loader keeps the
 * browser path deterministic in tests without installing or mutating globals.
 */
export function createHapticFeedbackController(
  environment: HapticBrowserEnvironment,
  loadModule: () => Promise<HapticModule>,
): HapticFeedbackController {
  let engine: HapticEngine | null = null;
  let enginePromise: Promise<HapticEngine | null> | null = null;
  let engineGeneration = 0;

  const loadEngine = async (): Promise<HapticEngine | null> => {
    if (!isHapticBrowserEnvironment(environment)) return null;
    if (engine !== null) return engine;
    if (enginePromise !== null) return enginePromise;

    const generation = engineGeneration;
    const pendingEngine = loadModule()
      .then(({ WebHaptics }) => {
        if (!isHapticBrowserEnvironment(environment)) return null;
        const candidate = new WebHaptics({ debug: false, showSwitch: false });
        if (generation !== engineGeneration) {
          cancelAndDestroy(candidate);
          return null;
        }
        engine = candidate;
        return candidate;
      })
      .catch(() => null);
    enginePromise = pendingEngine;
    void pendingEngine.finally(() => {
      if (enginePromise === pendingEngine) enginePromise = null;
    });

    return pendingEngine;
  };

  return {
    cancel() {
      if (engine === null) return false;
      try {
        engine.cancel();
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      engineGeneration += 1;
      const activeEngine = engine;
      engine = null;
      enginePromise = null;
      if (activeEngine !== null) cancelAndDestroy(activeEngine);
    },
    async prepare() {
      return await loadEngine() !== null;
    },
    async trigger(feedback: HapticFeedback = "press") {
      try {
        const activeEngine = await loadEngine();
        if (activeEngine === null) return false;
        const input = hapticInputForFeedback(feedback);
        await activeEngine.trigger(input);
        dispatchHapticFeedbackEvent(environment, { feedback, input });
        return true;
      } catch {
        return false;
      }
    },
  };
}

const browserHaptics = createHapticFeedbackController(globalThis, async () => {
  const { WebHaptics } = await import("web-haptics");
  return { WebHaptics };
});

/** Warms the browser-only engine so a later user gesture can trigger synchronously. */
export async function prepareHapticFeedback(): Promise<boolean> {
  return await browserHaptics.prepare();
}

/** Triggers semantic feedback and degrades to a no-op when unavailable or blocked. */
export async function triggerHapticFeedback(
  feedback: HapticFeedback = "press",
): Promise<boolean> {
  return await browserHaptics.trigger(feedback);
}

export function cancelHapticFeedback(): boolean {
  return browserHaptics.cancel();
}

export function disposeHapticFeedback(): void {
  browserHaptics.dispose();
}

/** Opt-in React adapter. Disabled callers do not preload the package. */
export function useHapticFeedback(enabled = true): (
  feedback?: HapticFeedback,
) => Promise<boolean> {
  useEffect(() => {
    if (enabled) void prepareHapticFeedback();
  }, [enabled]);

  return useCallback(
    async (feedback: HapticFeedback = "press") => enabled
      ? await triggerHapticFeedback(feedback)
      : false,
    [enabled],
  );
}
