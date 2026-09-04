import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

// The app ships under the F1 Content Security Policy:
//   default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'
// so the bundle must never inline a script, a style element, or a data: asset.
// `assetsInlineLimit: 0` keeps every emitted asset a same-origin file, and
// `cssCodeSplit: false` keeps one same-origin stylesheet instead of runtime
// style injection.
export default defineConfig({
  build: {
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    emptyOutDir: true,
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
  // Vite derives production mode from an ambient `NODE_ENV`, so a build run
  // from a test runner or a CI job that exports `NODE_ENV=test` would otherwise
  // ship React's development build: larger, slower, and full of inline styles
  // and external documentation links that the CSP forbids. Pinning the define
  // makes `build:app` produce the same production bundle from any environment.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [react(), tailwindcss()],
  root: appRoot,
  server: { host: "127.0.0.1", port: 5183, strictPort: true },
});
