import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@/": path.resolve(__dirname, "./src") + "/",
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
