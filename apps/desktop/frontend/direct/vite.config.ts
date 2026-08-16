import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend/direct",
  base: "./",
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: "../dist-direct",
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
});
