import { describe, it, expect } from "vitest";
import { buildTrendReport, formatTrendReport } from "../trend";
import { BenchmarkRun, BenchmarkResult } from "../types";
import * as fs from "fs";
import * as path from "path";

function makeResult(label: string, overrides?: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    label,
    samples: [],
    coldSamples: [],
    warmSamples: [],
    percentiles: { p50: 100, p75: 150, p90: 200, p95: 250, p99: 300 },
    coldPercentiles: { p50: 120, p75: 170, p90: 220, p95: 270, p99: 320 },
    warmPercentiles: { p50: 100, p75: 150, p90: 200, p95: 250, p99: 300 },
    meanMs: 150,
    medianMs: 140,
    stddevMs: 50,
    minMs: 50,
    maxMs: 300,
    meanMemoryMb: 64,
    peakMemoryMb: 128,
    meanCpuPercent: 25,
    peakCpuPercent: 50,
    variance: 0.1,
    passed: true,
    thresholdViolations: [],
    timestamp: Date.now(),
    durationMs: 1000,
    ...overrides,
  };
}

function makeRun(suite: string, results: BenchmarkResult[], id = "test-run"): BenchmarkRun {
  return {
    id,
    suite,
    config: {
      runs: 10, warmupRuns: 2, concurrency: 1, timeoutMs: 5000, datasetSize: 100,
      percentiles: [50, 75, 90, 95, 99], varianceThreshold: 0.15,
      memoryThresholdMb: 512, cpuThresholdPercent: 80,
      artifactDir: ".benchmarks", trendWindow: 5,
    },
    results,
    summary: { total: results.length, passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, totalDurationMs: 5000, meanDurationMs: 5000 / results.length },
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    ciRun: false,
    commitSha: null,
    branch: null,
  };
}

describe("buildTrendReport", () => {
  it("returns empty report when no artifacts exist", () => {
    const report = buildTrendReport("test-suite", "/tmp/nonexistent-benchmark-dir", 5);
    expect(report.suite).toBe("test-suite");
    expect(report.points).toHaveLength(0);
    expect(report.regression).toBe(false);
  });
});

describe("formatTrendReport", () => {
  it("formats empty report", () => {
    const report = { suite: "test", points: [], regression: false, regressions: [], window: 5 };
    const formatted = formatTrendReport(report);
    expect(formatted).toContain("test");
    expect(formatted).toContain("OK");
  });
});