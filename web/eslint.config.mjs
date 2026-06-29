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
]);

export default eslintConfig;
