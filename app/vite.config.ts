import type { StylexGenerationHandleV1 } from "@hraness/ui/stylex-build";
import { stylexVite } from "@hraness/ui/stylex-build/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type InlineConfig } from "vite";

// The app publication driver owns `.well-known/hra-app.json`; Vite emits only
// the closed compiled graph.

/** Only the generation driver may configure a production app graph. */
export function appProductionConfig(
  rootDirectory: string,
  generation: StylexGenerationHandleV1,
): InlineConfig {
  return {
    // The public adapter owns input, outDir, assetsInlineLimit: 0, publicDir,
    // cssCodeSplit: false, emptyOutDir: false and sourcemap: false. Overriding
    // those here would bypass its complete graph/output receipt contract.
    build: { target: "es2022" },
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    envFile: false,
    mode: "production",
    plugins: [stylexVite({ generation, graphId: "client", rootDirectory }), react()],
    root: rootDirectory,
  };
}

/** A fresh compiled graph with React diagnostics, never Vite serve or HMR. */
export function appDevelopmentConfig(
  rootDirectory: string,
  generation: StylexGenerationHandleV1,
): InlineConfig {
  return {
    build: { minify: false, target: "es2022" },
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    envFile: false,
    logLevel: "info",
    mode: "development",
    plugins: [stylexVite({ generation, graphId: "client", rootDirectory }), react()],
    root: rootDirectory,
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
