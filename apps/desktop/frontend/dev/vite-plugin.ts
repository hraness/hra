import type { Plugin } from "vite";

export const HRA_PRODUCTION_ENTRY_PATH = "/src/main.tsx" as const;
export const HRA_DEVELOPMENT_ENTRY_PATH = "/dev/main.dev.tsx" as const;

export function rewriteHraDevelopmentEntry(html: string): string {
  const marker = `src="${HRA_PRODUCTION_ENTRY_PATH}"`;
  const first = html.indexOf(marker);
  if (first === -1 || html.indexOf(marker, first + marker.length) !== -1) {
    throw new Error("Desktop HTML must contain exactly one production renderer entry.");
  }
  return html.replace(marker, `src="${HRA_DEVELOPMENT_ENTRY_PATH}"`);
}

/** Vite serve-only entry swap. The production Rollup graph remains rooted at src/main.tsx. */
export function hraDevEntryPlugin(): Plugin {
  return {
    name: "hra-malleable-development-entry",
    apply: "serve",
    enforce: "pre",
    transformIndexHtml: rewriteHraDevelopmentEntry,
  };
}
