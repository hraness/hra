import type { StylexGenerationHandleV1 } from "@hraness/ui/stylex-build";
import { stylexVite } from "@hraness/ui/stylex-build/vite";
import react from "@vitejs/plugin-react";
import { relative } from "node:path";
import { defineConfig, type InlineConfig, type Plugin } from "vite";
import type { OompaAppearanceAsset } from "../scripts/build-appearance.ts";

// The app publication driver owns `.well-known/oompa-app.json`; Vite emits only
// the closed compiled graph.

function appearanceAssetPlugin(rootDirectory: string, appearance: OompaAppearanceAsset): Plugin {
  return {
    name: "oompa-appearance-asset",
    async buildStart() {
      await appearance.verifyInputs();
      this.emitFile({
        type: "asset",
        name: "appearance.js",
        originalFileName: relative(rootDirectory, appearance.sourcePath),
        source: appearance.source,
      });
    },
    async generateBundle() { await appearance.verifyInputs(); },
    async writeBundle() { await appearance.verifyInputs(); },
  };
}

/** Only the generation driver may configure a production app graph. */
export function appProductionConfig(
  rootDirectory: string,
  generation: StylexGenerationHandleV1,
  appearance: OompaAppearanceAsset,
): InlineConfig {
  return {
    // The public adapter owns root, input, outDir, assetsInlineLimit: 0, publicDir,
    // cssCodeSplit: false, emptyOutDir: false and sourcemap: false. Overriding
    // those here would bypass its complete graph/output receipt contract.
    build: { target: "es2022" },
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    envFile: false,
    mode: "production",
    plugins: [stylexVite({ generation, graphId: "client", rootDirectory }), appearanceAssetPlugin(rootDirectory, appearance), react()],
  };
}

/** A fresh compiled graph with React diagnostics, never Vite serve or HMR. */
export function appDevelopmentConfig(
  rootDirectory: string,
  generation: StylexGenerationHandleV1,
  appearance: OompaAppearanceAsset,
): InlineConfig {
  return {
    build: { minify: false, target: "es2022" },
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    envFile: false,
    logLevel: "info",
    mode: "development",
    plugins: [stylexVite({ generation, graphId: "client", rootDirectory }), appearanceAssetPlugin(rootDirectory, appearance), react()],
  };
}

// An untransformed serve path would silently lose every local recipe. The
// compiled development server imports appDevelopmentConfig for fresh one-shot
// graphs; the public adapter deliberately does not implement Vite HMR.
export default defineConfig(({ command }) => {
  if (command === "serve") {
    throw new Error("Use bun run dev:app. Vite serve/HMR is unsupported by the complete StyleX graph contract.");
  }
  throw new Error("Build the complete app generation with bun run build:app.");
});
