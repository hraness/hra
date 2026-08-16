import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

import { safetyRules } from "./index.mjs";

const nextConfig = defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    files: ["**/*.{ts,tsx}"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: safetyRules,
  },
  globalIgnores([".next/**", "out/**", "build/**", ".tmp/**", "next-env.d.ts"]),
]);

export default nextConfig;
