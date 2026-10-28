import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config";
import { BenchmarkConfig } from "../types";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns default config when no overrides", () => {
    const config = loadConfig();
    expect(config.runs).toBe(100);
    expect(config.warmupRuns).toBe(10);
    expect(config.concurrency).toBe(1);
    expect(config.timeoutMs).toBe(30000);
    expect(config.varianceThreshold).toBe(0.15);
    expect(config.performanceBudgetMs).toBe(5000);
    expect(config.p99ThresholdMs).toBe(10000);
  });

  it("merges env variables", () => {
    process.env.BENCHMARK_RUNS = "50";
    process.env.BENCHMARK_MEMORY_THRESHOLD_MB = "256";
    process.env.BENCHMARK_PERFORMANCE_BUDGET_MS = "2500";
    const config = loadConfig();
    expect(config.runs).toBe(50);
    expect(config.memoryThresholdMb).toBe(256);
    expect(config.performanceBudgetMs).toBe(2500);
  });

  it("ignores malformed budget inputs and falls back to the default budget", () => {
    process.env.BENCHMARK_PERFORMANCE_BUDGET_MS = "NaN";
    process.env.BENCHMARK_P99_THRESHOLD_MS = "Infinity";

    const config = loadConfig();
    expect(config.performanceBudgetMs).toBe(5000);
    expect(config.p99ThresholdMs).toBe(10000);
  });

  it("overrides take precedence over env", () => {
    process.env.BENCHMARK_RUNS = "50";
    const config = loadConfig({ runs: 25 });
    expect(config.runs).toBe(25);
  });

  it("preserves defaults for unset values", () => {
    const config = loadConfig({ runs: 10 });
    expect(config.runs).toBe(10);
    expect(config.warmupRuns).toBe(10);
    expect(config.timeoutMs).toBe(30000);
  });
});