import { describe, it, expect } from "vitest";
import { checkThresholds, loadThresholdRules } from "../thresholds";
import { BenchmarkConfig } from "../types";

const defaultConfig: BenchmarkConfig = {
  runs: 10,
  warmupRuns: 2,
  concurrency: 1,
  timeoutMs: 5000,
  datasetSize: 100,
  percentiles: [50, 90, 99],
  varianceThreshold: 0.15,
  memoryThresholdMb: 512,
  cpuThresholdPercent: 80,
  artifactDir: ".benchmarks",
  trendWindow: 10,
};

describe("checkThresholds", () => {
  it("passes when all metrics are within bounds", () => {
    const violations = checkThresholds(
      { variance: 0.05, meanMs: 100, p99: 200, peakMemoryMb: 100, peakCpuPercent: 30, failureRate: 0 },
      loadThresholdRules(defaultConfig),
    );
    expect(violations).toHaveLength(0);
  });

  it("detects variance warning", () => {
    const violations = checkThresholds(
      { variance: 0.3, meanMs: 100, p99: 200, peakMemoryMb: 100, peakCpuPercent: 30, failureRate: 0 },
      loadThresholdRules(defaultConfig),
    );
    expect(violations.some((v) => v.metric === "variance" && v.severity === "warn")).toBe(true);
  });

  it("detects memory threshold failure", () => {
    const violations = checkThresholds(
      { variance: 0.05, meanMs: 100, p99: 200, peakMemoryMb: 600, peakCpuPercent: 30, failureRate: 0 },
      loadThresholdRules(defaultConfig),
    );
    expect(violations.some((v) => v.metric === "peakMemoryMb" && v.severity === "fail")).toBe(true);
  });

  it("detects cpu threshold warning", () => {
    const violations = checkThresholds(
      { variance: 0.05, meanMs: 100, p99: 200, peakMemoryMb: 100, peakCpuPercent: 95, failureRate: 0 },
      loadThresholdRules(defaultConfig),
    );
    expect(violations.some((v) => v.metric === "peakCpuPercent" && v.severity === "warn")).toBe(true);
  });

  it("returns multiple violations when several thresholds breached", () => {
    const violations = checkThresholds(
      { variance: 0.2, meanMs: 100, p99: 200, peakMemoryMb: 600, peakCpuPercent: 95, failureRate: 0 },
      loadThresholdRules(defaultConfig),
    );
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe("loadThresholdRules", () => {
  it("returns default rules from config", () => {
    const rules = loadThresholdRules(defaultConfig);
    expect(rules.length).toBeGreaterThanOrEqual(3);
    expect(rules.find((r) => r.metric === "peakMemoryMb")?.threshold).toBe(512);
  });
});