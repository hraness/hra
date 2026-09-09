import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { getDesignPaletteTheme } from "@hraness/design-kit";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const exactGitCommitPattern = /^[0-9a-f]{40}$/u;
const packageVersionPattern = /^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

function appearanceBootstrapPlugin(): Plugin {
  let source: string | undefined;
  const bundle = (): string => source ??= execFileSync("bun", [
    fileURLToPath(new URL("../scripts/build-appearance.ts", import.meta.url)),
  ], { encoding: "utf8", maxBuffer: 2_000_000 });
  return {
    name: "hra-appearance-bootstrap",
    configureServer(server) {
      server.middlewares.use("/assets/appearance.js", (_request, response) => {
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(bundle());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "assets/appearance.js", source: bundle() });
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const theme = getDesignPaletteTheme("catppuccin", "dark");
        return {
          html: html.replace("<html ", `<html class="${theme.className}" `),
          tags: [{ tag: "script", attrs: { src: "/assets/appearance.js" }, injectTo: "head-prepend" }],
        };
      },
    },
  };
}

function resolveAppSourceCommit(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (environment.VERCEL === "1") {
    const commit = environment.VERCEL_GIT_COMMIT_SHA;
    if (commit === undefined || !exactGitCommitPattern.test(commit)) {
      throw new Error("A Vercel app build requires an exact source commit marker.");
    }
    return commit;
  }
  const commit = environment.VERCEL_GIT_COMMIT_SHA
    ?? environment.HRA_RELEASE_COMMIT;
  if (commit === undefined) return "local";
  if (!exactGitCommitPattern.test(commit)) {
    throw new Error("An app build source commit must be a lowercase 40-character Git SHA.");
  }
  return commit;
}

function readAppVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof manifest !== "object"
    || manifest === null
    || Array.isArray(manifest)
    || !("version" in manifest)
    || typeof manifest.version !== "string"
    || !packageVersionPattern.test(manifest.version)
  ) throw new Error("The HRA app package version is invalid.");
  return manifest.version;
}

function appSourceMarkerPlugin(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Plugin {
  const source = `${JSON.stringify({
    generation: 1,
    product: "HRA App",
    repository: {
      id: 1_343_008_607,
      path: "hraness/hra",
    },
    schemaVersion: 1,
    source: {
      commit: resolveAppSourceCommit(environment),
    },
    version: readAppVersion(),
  }, null, 2)}\n`;
  return {
    apply: "build",
    generateBundle() {
      this.emitFile({
        fileName: ".well-known/hra-app.json",
        source,
        type: "asset",
      });
    },
    name: "hra-app-source-marker",
  };
}

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
  plugins: [react(), tailwindcss(), appearanceBootstrapPlugin(), appSourceMarkerPlugin()],
  root: appRoot,
  server: { host: "127.0.0.1", port: 5183, strictPort: true },
});
