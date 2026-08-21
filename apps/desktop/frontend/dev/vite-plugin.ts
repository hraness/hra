import type { Plugin } from "vite";

export const HRA_PRODUCTION_ENTRY_PATH = "/src/main.tsx" as const;
export const HRA_DEVELOPMENT_ENTRY_PATH = "/dev/main.dev.tsx" as const;

function normalizedModuleSource(source: string): string {
  const path = source.split(/[?#]/u, 1)[0] ?? source;
  return path.startsWith("./") ? path.slice(1) : path;
}

export function rewriteHraDevelopmentEntry(html: string): string {
  const sources = [...html.matchAll(/\bsrc\s*=\s*(["'])([^"']+)\1/gu)];
  const productionEntries = sources.filter((match) => (
    normalizedModuleSource(match[2] ?? "") === HRA_PRODUCTION_ENTRY_PATH
  ));
  const developmentEntries = sources.filter((match) => (
    normalizedModuleSource(match[2] ?? "") === HRA_DEVELOPMENT_ENTRY_PATH
  ));
  if (productionEntries.length === 0 && developmentEntries.length === 1) return html;
  if (productionEntries.length !== 1 || developmentEntries.length !== 0) {
    throw new Error("Desktop HTML must contain exactly one production renderer entry.");
  }
  const productionEntry = productionEntries[0];
  const productionSource = productionEntry?.[2];
  if (productionEntry === undefined || productionSource === undefined) {
    throw new Error("Desktop HTML production renderer entry could not be read.");
  }
  const suffixIndex = productionSource.search(/[?#]/u);
  const suffix = suffixIndex === -1 ? "" : productionSource.slice(suffixIndex);
  return html.replace(
    productionEntry[0],
    productionEntry[0].replace(
      productionSource,
      `${HRA_DEVELOPMENT_ENTRY_PATH}${suffix}`,
    ),
  );
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
