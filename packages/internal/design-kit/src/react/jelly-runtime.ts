"use client";

import type { ThemeMode } from "../../vendor/jelly-ui/jelly.js";

interface JellyThemeRuntime {
  setThemeMode(mode?: ThemeMode): void;
}

type JellyRuntimeLoader = () => Promise<JellyThemeRuntime>;

/** Cache successful loads while allowing a transient chunk/CSP failure to retry. */
export function createRetryableJellyRuntimeLoader(
  loader: JellyRuntimeLoader,
): JellyRuntimeLoader {
  let runtime: Promise<JellyThemeRuntime> | undefined;

  return () => {
    runtime ??= loader().catch((error: unknown) => {
      runtime = undefined;
      throw error;
    });
    return runtime;
  };
}

const loadBrowserJellyRuntime = createRetryableJellyRuntimeLoader(
  () => import("../../vendor/jelly-ui/jelly.js"),
);
let themeRequest = 0;

function loadJellyRuntime(): Promise<JellyThemeRuntime> | null {
  if (typeof window === "undefined") return null;
  return loadBrowserJellyRuntime();
}

/** Register the pinned Jelly custom elements once, and only in a browser. */
export async function ensureJellyRuntime(): Promise<void> {
  try {
    await loadJellyRuntime();
  } catch {
    // CSS keeps every control usable through its :not(:defined) fallback.
  }
}

/** Use Jelly's public theme API so every upgraded canvas receives its repaint event. */
export function applyJellyThemeMode(runtime: JellyThemeRuntime, mode: ThemeMode): void {
  runtime.setThemeMode(mode);
}

/**
 * Apply the root mode immediately, then notify all upgraded Jelly canvases once
 * the browser-only runtime is ready. The newest request wins across async load.
 */
export async function setJellyThemeMode(mode: ThemeMode): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") return false;

  const request = ++themeRequest;
  if (mode === "auto") document.documentElement.removeAttribute("data-jelly-mode");
  else document.documentElement.setAttribute("data-jelly-mode", mode);

  let runtime: JellyThemeRuntime | null;
  try {
    runtime = await loadJellyRuntime();
  } catch {
    return false;
  }
  if (runtime === null || request !== themeRequest) return false;

  applyJellyThemeMode(runtime, mode);
  return true;
}
