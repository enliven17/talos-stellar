import { MetricSample, ThresholdViolation, BenchmarkConfig } from "./types";

export interface ThresholdRule {
  metric: string;
  threshold: number;
  severity: "warn" | "fail";
  comparator: "gt" | "lt" | "gte" | "lte";
}

const DEFAULT_RULES: ThresholdRule[] = [
  { metric: "variance", threshold: 0.15, severity: "warn", comparator: "gt" },
  { metric: "meanDurationMs", threshold: 5000, severity: "fail", comparator: "gt" },
  { metric: "p99", threshold: 10000, severity: "fail", comparator: "gt" },
  { metric: "peakMemoryMb", threshold: 512, severity: "fail", comparator: "gt" },
  { metric: "peakCpuPercent", threshold: 80, severity: "warn", comparator: "gt" },
  { metric: "failureRate", threshold: 0.05, severity: "fail", comparator: "gt" },
];

export function loadThresholdRules(config: BenchmarkConfig): ThresholdRule[] {
  const rules: ThresholdRule[] = [
    { metric: "variance", threshold: config.varianceThreshold, severity: "warn", comparator: "gt" },
    { metric: "peakMemoryMb", threshold: config.memoryThresholdMb, severity: "fail", comparator: "gt" },
    { metric: "peakCpuPercent", threshold: config.cpuThresholdPercent, severity: "warn", comparator: "gt" },
  ];

  if (process.env.BENCHMARK_THRESHOLD_RULES) {
    try {
      const extra = JSON.parse(process.env.BENCHMARK_THRESHOLD_RULES) as ThresholdRule[];
      rules.push(...extra);
    } catch {
      // ignore invalid env override
    }
  }

  return rules;
}

export function checkThresholds(
  stats: {
    variance: number;
    meanMs: number;
    p99: number;
    peakMemoryMb: number;
    peakCpuPercent: number;
    failureRate: number;
  },
  rules: ThresholdRule[],
): ThresholdViolation[] {
  const violations: ThresholdViolation[] = [];

  const metricMap: Record<string, number> = {
    variance: stats.variance,
    meanDurationMs: stats.meanMs,
    p99: stats.p99,
    peakMemoryMb: stats.peakMemoryMb,
    peakCpuPercent: stats.peakCpuPercent,
    failureRate: stats.failureRate,
  };

  for (const rule of rules) {
    const actual = metricMap[rule.metric];
    if (actual === undefined) continue;

    let breached = false;
    switch (rule.comparator) {
      case "gt": breached = actual > rule.threshold; break;
      case "lt": breached = actual < rule.threshold; break;
      case "gte": breached = actual >= rule.threshold; break;
      case "lte": breached = actual <= rule.threshold; break;
    }

    if (breached) {
      violations.push({
        metric: rule.metric,
        actual,
        threshold: rule.threshold,
        severity: rule.severity,
      });
    }
  }

  return violations;
}

export function evaluateThresholds(
  samples: MetricSample[],
  stats: { variance: number; meanMs: number; p99: number; peakMemoryMb: number; peakCpuPercent: number; failureRate: number },
  config: BenchmarkConfig,
): { passed: boolean; violations: ThresholdViolation[] } {
  const rules = loadThresholdRules(config);
  const violations = checkThresholds(stats, rules);
  const hasFail = violations.some((v) => v.severity === "fail");
  return { passed: !hasFail, violations };
}