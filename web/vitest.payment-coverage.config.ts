import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

/**
 * Focused, fail-closed coverage gate for payment routes with passing route-level
 * tests. Keep this list explicit so route additions/removals require an
 * intentional test and coverage policy update.
 */
export default mergeConfig(baseConfig, defineConfig({
  test: {
    include: [
      "tests/buy-token.test.ts",
      "tests/buy-token-idempotency.test.ts",
      "tests/revenue-distribute-transaction.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: [
        "src/app/api/talos/**/buy-token/route.ts",
        "src/app/api/talos/**/revenue/distribute/route.ts",
      ],
      reporter: ["text"],
      thresholds: {
        perFile: true,
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
    },
  },
}));
