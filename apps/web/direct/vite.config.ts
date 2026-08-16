import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const directRoot = fileURLToPath(new URL(".", import.meta.url));
const productRoot = resolve(directRoot, "..");

export default defineConfig({
  root: directRoot,
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@\/(.*)$/u, replacement: `${productRoot}/$1` }],
  },
  build: {
    emptyOutDir: true,
    outDir: resolve(productRoot, "dist-direct"),
  },
  server: {
    hmr: false,
    host: "127.0.0.1",
    port: 5176,
    strictPort: true,
  },
});
