import { expect, test } from "bun:test";

import {
  applyJellyThemeMode,
  createRetryableJellyRuntimeLoader,
} from "./jelly-runtime";

test("theme changes use Jelly's public API and emit the canvas repaint event", async () => {
  const events = new EventTarget();
  const modes: string[] = [];
  let repaintEvents = 0;
  events.addEventListener("jelly-theme-change", () => repaintEvents += 1);

  const runtime = {
    setThemeMode(mode = "auto") {
      modes.push(mode);
      events.dispatchEvent(new Event("jelly-theme-change"));
    },
  };

  applyJellyThemeMode(runtime, "dark");
  applyJellyThemeMode(runtime, "light");

  expect(modes).toEqual(["dark", "light"]);
  expect(repaintEvents).toBe(2);

  const vendor = await Bun.file(
    new URL("../../vendor/jelly-ui/jelly.js", import.meta.url),
  ).text();
  expect(vendor).toContain('new CustomEvent("jelly-theme-change")');
  expect(vendor).toContain("setThemeMode");
});

test("the gallery defers Jelly appearance synchronization to its host provider", async () => {
  const [gallery, theme] = await Promise.all([
    Bun.file(new URL("./design-gallery.tsx", import.meta.url)).text(),
    Bun.file(new URL("./theme.tsx", import.meta.url)).text(),
  ]);

  expect(gallery).not.toContain("setJellyThemeMode(");
  expect(gallery).not.toContain("useTheme()");
  expect(theme).toContain("void setJellyThemeMode(resolvedTheme);");
  expect(theme).toContain("<JellyThemeSync />");
});

test("a rejected Jelly runtime load can retry instead of poisoning the singleton", async () => {
  const runtime = { setThemeMode: () => undefined };
  let attempts = 0;
  const load = createRetryableJellyRuntimeLoader(() => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error("transient chunk failure"));
    return Promise.resolve(runtime);
  });

  let firstFailure: unknown;
  try {
    await load();
  } catch (error: unknown) {
    firstFailure = error;
  }
  expect(firstFailure).toBeInstanceOf(Error);
  if (!(firstFailure instanceof Error)) throw new Error("expected the first runtime load to fail");
  expect(firstFailure.message).toBe("transient chunk failure");
  expect(await load()).toBe(runtime);
  expect(await load()).toBe(runtime);
  expect(attempts).toBe(2);
});
