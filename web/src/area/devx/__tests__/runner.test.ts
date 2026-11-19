import { describe, it, expect } from "vitest";
import { runBenchmark, runSuite } from "../runner";
import { loadConfig } from "../config";
import { BenchmarkConfig } from "../types";

const quickConfig: BenchmarkConfig = {
  runs: 5,
  warmupRuns: 2,
  concurrency: 1,
  timeoutMs: 5000,
  datasetSize: 10,
  percentiles: [50, 90, 99],
  varianceThreshold: 0.5,
  memoryThresholdMb: 1024,
  cpuThresholdPercent: 99,
  artifactDir: ".benchmarks",
  trendWindow: 5,
};

describe("runBenchmark", () => {
  it("runs a simple synchronous benchmark", async () => {
    const result = await runBenchmark({
      label: "sync-test",
      fn: () => {
        let x = 0;
        for (let i = 0; i < 1000; i++) x += i;
      },
      config: quickConfig,
    });

    expect(result.label).toBe("sync-test");
    expect(result.samples.length).toBe(quickConfig.warmupRuns + quickConfig.runs);
    expect(result.meanMs).toBeGreaterThanOrEqual(0);
    expect(result.percentiles.p50).toBeGreaterThanOrEqual(0);
    expect(typeof result.passed).toBe("boolean");
  });

  it("runs an async benchmark", async () => {
    const result = await runBenchmark({
      label: "async-test",
      fn: async () => {
        await new Promise((r) => setTimeout(r, 1));
      },
      config: quickConfig,
    });

    expect(result.label).toBe("async-test");
    expect(result.meanMs).toBeGreaterThan(0);
  });

  it("handles benchmark failures gracefully", async () => {
    const result = await runBenchmark({
      label: "fail-test",
      fn: () => { throw new Error("benchmark error"); },
      config: quickConfig,
    });

    expect(result.label).toBe("fail-test");
    expect(result.passed).toBeDefined();
  });

  it("reports memory and cpu metrics", async () => {
    const result = await runBenchmark({
      label: "resource-test",
      fn: () => {
        const arr = new Array(1000).fill("x").join("");
        return arr.length;
      },
      config: quickConfig,
    });

    expect(result.meanMemoryMb).toBeGreaterThanOrEqual(0);
    expect(result.peakMemoryMb).toBeGreaterThanOrEqual(0);
    expect(result.meanCpuPercent).toBeGreaterThanOrEqual(0);
  });

  it("produces cold and warm sample separation", async () => {
    const result = await runBenchmark({
      label: "temp-test",
      fn: () => {},
      config: quickConfig,
    });

    expect(result.coldSamples.length).toBe(quickConfig.warmupRuns);
    expect(result.warmSamples.length).toBe(quickConfig.runs);
  });
});

describe("runSuite", () => {
  it("runs multiple benchmarks and returns summary", async () => {
    const run = await runSuite("test-suite", [
      { label: "bench-a", fn: () => {}, config: quickConfig },
      { label: "bench-b", fn: async () => { await new Promise((r) => setTimeout(r, 1)); }, config: quickConfig },
    ], quickConfig);

    expect(run.suite).toBe("test-suite");
    expect(run.results.length).toBe(2);
    expect(run.summary.total).toBe(2);
    expect(run.summary.passed + run.summary.failed).toBe(2);
    expect(run.id).toBeTruthy();
    expect(run.startedAt).toBeLessThan(run.completedAt);
  });
});