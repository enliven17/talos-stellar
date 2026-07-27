import { describe, it, expect } from "vitest";
import { checkThresholds, loadThresholdRules, evaluateThresholds } from "../thresholds";
import { BenchmarkConfig, MetricSample } from "../types";

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

describe("regression gate — intentional threshold breach", () => {
  it("fails when peakMemoryMb exceeds config threshold", () => {
    const strictConfig: BenchmarkConfig = { ...defaultConfig, memoryThresholdMb: 1 };
    const { passed, violations } = evaluateThresholds([], {
      variance: 0.01,
      meanMs: 1,
      p99: 1,
      peakMemoryMb: 500,
      peakCpuPercent: 1,
      failureRate: 0,
    }, strictConfig);
    expect(passed).toBe(false);
    expect(violations.some((v) => v.metric === "peakMemoryMb" && v.severity === "fail")).toBe(true);
  });

  it("fails when variance exceeds config threshold", () => {
    const strictConfig: BenchmarkConfig = { ...defaultConfig, varianceThreshold: 0.01 };
    const { passed, violations } = evaluateThresholds([], {
      variance: 0.5,
      meanMs: 1,
      p99: 1,
      peakMemoryMb: 1,
      peakCpuPercent: 1,
      failureRate: 0,
    }, strictConfig);
    expect(violations.some((v) => v.metric === "variance" && v.severity === "warn")).toBe(true);
  });

  it("fails when peakCpuPercent exceeds config threshold", () => {
    const strictConfig: BenchmarkConfig = { ...defaultConfig, cpuThresholdPercent: 5 };
    const { passed, violations } = evaluateThresholds([], {
      variance: 0.01,
      meanMs: 1,
      p99: 1,
      peakMemoryMb: 1,
      peakCpuPercent: 50,
      failureRate: 0,
    }, strictConfig);
    expect(violations.some((v) => v.metric === "peakCpuPercent" && v.severity === "warn")).toBe(true);
  });

  it("breaches via env threshold rules and causes a fail", () => {
    process.env.BENCHMARK_THRESHOLD_RULES = JSON.stringify([
      { metric: "meanDurationMs", threshold: 0.5, severity: "fail", comparator: "gt" },
    ]);
    try {
      const { violations } = evaluateThresholds([], {
        variance: 0.01,
        meanMs: 100,
        p99: 1,
        peakMemoryMb: 1,
        peakCpuPercent: 1,
        failureRate: 0,
      }, defaultConfig);
      expect(violations.some((v) => v.metric === "meanDurationMs" && v.severity === "fail")).toBe(true);
    } finally {
      delete process.env.BENCHMARK_THRESHOLD_RULES;
    }
  });

  it("passes when all metrics are within bounds", () => {
    const { passed, violations } = evaluateThresholds([], {
      variance: 0.01,
      meanMs: 1,
      p99: 1,
      peakMemoryMb: 1,
      peakCpuPercent: 1,
      failureRate: 0,
    }, defaultConfig);
    expect(passed).toBe(true);
    expect(violations).toHaveLength(0);
  });
});