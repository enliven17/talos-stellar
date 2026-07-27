export interface BenchmarkConfig {
  runs: number;
  warmupRuns: number;
  concurrency: number;
  timeoutMs: number;
  datasetSize: number;
  percentiles: number[];
  varianceThreshold: number;
  memoryThresholdMb: number;
  cpuThresholdPercent: number;
  artifactDir: string;
  trendWindow: number;
}

export interface MetricSample {
  label: string;
  durationMs: number;
  memoryMb: number;
  cpuPercent: number;
  timestamp: number;
  warm: boolean;
}

export interface Percentiles {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  [key: string]: number;
}

export interface BenchmarkResult {
  label: string;
  samples: MetricSample[];
  coldSamples: MetricSample[];
  warmSamples: MetricSample[];
  percentiles: Percentiles;
  coldPercentiles: Percentiles;
  warmPercentiles: Percentiles;
  meanMs: number;
  medianMs: number;
  stddevMs: number;
  minMs: number;
  maxMs: number;
  meanMemoryMb: number;
  peakMemoryMb: number;
  meanCpuPercent: number;
  peakCpuPercent: number;
  variance: number;
  passed: boolean;
  thresholdViolations: ThresholdViolation[];
  timestamp: number;
  durationMs: number;
}

export interface ThresholdViolation {
  metric: string;
  actual: number;
  threshold: number;
  severity: "warn" | "fail";
}

export interface BenchmarkRun {
  id: string;
  suite: string;
  config: BenchmarkConfig;
  results: BenchmarkResult[];
  summary: BenchmarkSummary;
  startedAt: number;
  completedAt: number;
  ciRun: boolean;
  commitSha: string | null;
  branch: string | null;
}

export interface BenchmarkSummary {
  total: number;
  passed: number;
  failed: number;
  totalDurationMs: number;
  meanDurationMs: number;
}

export interface BenchmarkDataset {
  name: string;
  description: string;
  size: number;
  generate: () => unknown[];
}

export interface TrendPoint {
  timestamp: number;
  label: string;
  p50: number;
  p90: number;
  p99: number;
  meanMs: number;
  meanMemoryMb: number;
  passed: boolean;
}

export interface TrendReport {
  suite: string;
  points: TrendPoint[];
  regression: boolean;
  regressions: string[];
  window: number;
}

export type BenchmarkStatus = "running" | "completed" | "failed" | "cancelled";

export interface BenchmarkEvent {
  type: "start" | "sample" | "result" | "error" | "complete";
  timestamp: number;
  label?: string;
  sample?: MetricSample;
  result?: BenchmarkResult;
  error?: string;
  run?: BenchmarkRun;
}