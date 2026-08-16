import js from "@eslint/js";
import tseslint from "typescript-eslint";

export const safetyRules = {
  "array-callback-return": "error",
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-template-curly-in-string": "error",
  "@typescript-eslint/consistent-type-assertions": [
    "error",
    { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
  ],
  "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/switch-exhaustiveness-check": "error",
};

const baseConfig = tseslint.config(
  { ignores: ["dist/**", ".next/**", "coverage/**", "**/*.generated.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: safetyRules,
  },
);

export { baseConfig };
export default baseConfig;
