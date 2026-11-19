import { defineConfig, globalIgnores } from "eslint/config";
import jsonParser from "./eslint-json-parser.mjs";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["**/*.json"],
    languageOptions: {
      parser: jsonParser,
    },
  },
  {
    files: ["**/*.mjs"],
    rules: {
      "no-undef": "error",
    },
  },
  {
    files: ["tests/**", "**/*.test.ts", "**/*.test.tsx", "**/__tests__/**", "scripts/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
